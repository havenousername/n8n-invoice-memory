"""Assemble importable n8n workflow JSON from workflows/code (pure functions) and workflows/nodes (Code-node glue).

Run after changing either folder or the samples: python3 scripts/build_workflows.py
The output carries no instance ids. Data Tables and credentials are referenced by name, the cluster URL is a
placeholder to set in each Config node, and every Execute Sub-workflow node names its target in
`cachedResultName` so it can be selected after import. Sub-workflows accept the caller's item as is, and each call
site passes an item that already carries what the target's contract names, so there is no input mapping to rebind.
The offices (with their budgets) and the booth pool (with each PDF inlined) are injected into the Code nodes that
need them, so nothing reads a budget from a table or downloads a sample.
"""

import base64
import dataclasses
import json
import re
import sys
import uuid
from collections.abc import Mapping
from pathlib import Path
from types import MappingProxyType

from openrouter_check import extraction_body

REPO = Path(__file__).resolve().parent.parent
WORKFLOWS_DIR = REPO / "workflows"
QDRANT_URL_PLACEHOLDER = "https://REPLACE.cloud.qdrant.io:6333"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "anthropic/claude-haiku-5.5"
DAY_SLOT_SECONDS = 15
QDRANT_CREDENTIAL = MappingProxyType({"httpHeaderAuth": {"name": "Qdrant api-key"}})
OPENROUTER_CREDENTIAL = MappingProxyType({"httpHeaderAuth": {"name": "OpenRouter bearer"}})
DASHBOARD_CREDENTIAL = MappingProxyType({"httpHeaderAuth": {"name": "Dashboard secret"}})

_CODE_SOURCES = ("ids", "coarse", "validate", "office-view", "pdf", "worker")
_COLUMN_TYPES = MappingProxyType({
    "stage": "number", "version": "number", "amount": "number", "running": "boolean",
    "received_at": "dateTime", "narrative_at": "dateTime", "issued_at": "dateTime",
})
_DOCUMENT_COLUMNS = ("document_id", "kind", "duplicate_of", "office_id", "manager_id", "worker_id", "pdf_hash", "filename",
                     "text", "stage", "regex_fields", "llm_fields", "error", "received_at", "pdf_base64")
_ISSUED_COLUMNS = ("issued_id", "office_id", "manager_id", "worker_id", "doc_type", "doc_key", "version", "date",
                   "counterparty", "category", "amount", "description_de", "description_en", "resend_of", "filename",
                   "issued_at")
_ID_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://github.com/qdrant/n8n-invoice-memory")
_TRIGGER = "When Executed by Another Workflow"
DAY, INGEST, RECORD = "00 Working day", "01 Ingest", "01b Record a document"
PROCESS, SUMMARY, REBUILD = "02 Process", "02b Write the summary", "03 Rebuild office point"
WRITES, RECONCILE, MAINTENANCE = "05 Dashboard writes", "06 Reconcile", "07 Maintenance"


@dataclasses.dataclass(frozen=True)
class Parts:
    sources: Mapping[str, str]  # workflows/code/<name>.js
    glue: Mapping[str, str]  # workflows/nodes/<name>.js
    offices: tuple[dict, ...]  # samples/offices.json
    pool: Mapping[str, dict]  # the booth documents by file, each with its PDF as pdf_base64


def read_parts() -> Parts:
    manifest = json.loads((REPO / "samples" / "manifest.json").read_text())
    pool = {
        row["file"]: {
            "office_id": row["office_id"], "manager_id": row["manager_id"], "worker_id": row["worker_id"],
            "duplicate_of": row["duplicate_of"],
            "pdf_base64": base64.b64encode((REPO / "samples" / row["file"]).read_bytes()).decode(),
        }
        for row in manifest if row["role"] == "booth"
    }
    return Parts(
        sources={name: (WORKFLOWS_DIR / "code" / f"{name}.js").read_text() for name in _CODE_SOURCES},
        glue={path.stem: path.read_text() for path in sorted((WORKFLOWS_DIR / "nodes").glob("*.js"))},
        offices=tuple(json.loads((REPO / "samples" / "offices.json").read_text())),
        pool=pool,
    )


def pasted(source: str) -> str:
    """A pure-function source as a Code node needs it: no module.exports, since there is no require."""
    return re.sub(r"^module\.exports.*\n?", "", source, flags=re.MULTILINE)


def constant(name: str, value: object) -> str:
    """One injected constant, on one line, so tests can read it back."""
    return f"const {name} = {json.dumps(value, ensure_ascii=False)};\n"


def ref(node: str, path: str) -> str:
    """An n8n expression reading a field of another node's first item."""
    return f"={{{{ $('{node}').first().json.{path} }}}}"


class _Canvas:
    """Collects one workflow's nodes and links, laid out on a 220 x 200 grid."""

    def __init__(self, workflow: str):
        self.workflow = workflow
        self.nodes: list[dict] = []
        self.links: dict[str, list[list[dict]]] = {}

    def add(self, name: str, at: tuple[int, int], spec: tuple[str, float, dict], **extra) -> str:
        type_, version, parameters = spec
        node = {
            "id": _stable_id(self.workflow, name),
            "name": name,
            "type": type_,
            "typeVersion": version,
            "position": [at[0] * 220, at[1] * 200],
            "parameters": parameters,
            **extra,
        }
        if type_ in _WEBHOOK_TYPES:
            node["webhookId"] = _stable_id(self.workflow, f"{name}/webhook")
        self.nodes.append(node)
        return name

    def link(self, source: str, target: str, output: int = 0) -> None:
        outputs = self.links.setdefault(source, [])
        while len(outputs) <= output:
            outputs.append([])
        outputs[output].append({"node": target, "type": "main", "index": 0})

    def chain(self, *names: str) -> None:
        for source, target in zip(names, names[1:]):
            self.link(source, target)

    def note(self, name: str, position: tuple[int, int], content: str, width: int = 380, height: int = 140) -> None:
        self.nodes.append({
            "id": _stable_id(self.workflow, name), "name": name, "type": "n8n-nodes-base.stickyNote", "typeVersion": 1,
            "position": list(position), "parameters": {"content": content, "width": width, "height": height},
        })

    def build(self) -> dict:
        workflow = {"name": self.workflow, "nodes": self.nodes, "connections": {s: {"main": o} for s, o in self.links.items()}}
        workflow["settings"] = {"executionOrder": "v1"}
        return workflow


def rebuild_point(parts: Parts) -> dict:
    """03 Rebuild office point: the only writer to Qdrant. Inputs office_id and manager_id."""
    c = _Canvas(REBUILD)
    steps = [
        c.add(_TRIGGER, (0, 0), _trigger(), **_contract(
            "Expects office_id and manager_id on the incoming item. Returns them with the point id.")),
        c.add("Config", (1, 0), _config(REBUILD, QDRANT_URL=QDRANT_URL_PLACEHOLDER, COLLECTION="offices")),
        c.add("Hash the point id", (2, 0), _hash_text("={{ $json.manager_id }}/{{ $json.office_id }}", "idhash")),
        c.add("Load the office row", (3, 0), _rows("offices", _tenant_from("Config")), alwaysOutputData=True, executeOnce=True),
        c.add("Load all document rows", (4, 0), _rows("documents", _tenant_from("Config")), alwaysOutputData=True, executeOnce=True),
        c.add("Compute the view", (5, 0), _code(parts, "compute-the-view", "ids", "office-view", prefix=_offices(parts))),
        c.add("Upsert the point with inference", (6, 0), _http(
            "PUT", _qdrant_url("/points?wait=true"), "={{ JSON.stringify($json.body) }}"), credentials=dict(QDRANT_CREDENTIAL)),
        c.add("Return what was rebuilt", (7, 0), _set(REBUILD, "Return what was rebuilt", include_other=False,
                                                      office_id=ref("Config", "office_id"),
                                                      manager_id=ref("Config", "manager_id"),
                                                      point_id=ref("Compute the view", "body.points[0].id"))),
    ]
    c.chain(*steps)
    c.note("Sticky Note", (440, -220), "Source of truth is the documents table. This workflow is the only writer to "
                                       "Qdrant: one point per office, any stage, any retry, same point.")
    return c.build()


def summary(parts: Parts) -> dict:
    """02b Write the summary: three sentences for a sharp office, saved with the revision they describe."""
    c = _Canvas(SUMMARY)
    steps = [
        c.add(_TRIGGER, (0, 0), _trigger(), **_contract("Expects office_id and manager_id on the incoming item.")),
        c.add("Config", (1, 0), _config(SUMMARY, QDRANT_URL=QDRANT_URL_PLACEHOLDER, COLLECTION="offices",
                                        OPENROUTER_MODEL=DEFAULT_MODEL)),
        c.add("Hash the point id", (2, 0), _hash_text("={{ $json.manager_id }}/{{ $json.office_id }}", "idhash")),
        c.add("Format the point id", (3, 0), _code(parts, "format-the-point-id", "ids")),
        c.add("Read the point", (4, 0), _http("POST", _qdrant_url("/points"), "={{ JSON.stringify($json.body) }}"),
              credentials=dict(QDRANT_CREDENTIAL)),
        c.add("Prepare the narrative snapshot", (5, 0), _code(parts, "prepare-the-narrative-snapshot")),
        c.add("Ask for three sentences", (6, 0), _http("POST", OPENROUTER_URL, "={{ JSON.stringify($json.body) }}", timeout=20000),
              credentials=dict(OPENROUTER_CREDENTIAL), retryOnFail=True, maxTries=2, waitBetweenTries=2000),
        c.add("Keep only the narrative", (7, 0), _code(parts, "keep-only-the-narrative")),
        c.add("Save the narrative", (8, 0), _write("update", "offices", _tenant_from("Config"), {
            "narrative": ref("Keep only the narrative", "narrative"),
            "narrative_at": ref("Keep only the narrative", "at"),
            "narrative_revision": ref("Keep only the narrative", "revision"),
        })),
        c.add("Rebuild the point", (9, 0), _execute(REBUILD)),
    ]
    c.chain(*steps)
    c.note("Sticky Note", (1100, -220), "Summarizes only a sharp office: every document read, none pending, no fresh "
                                        "summary yet. Saved with the source_revision it describes; stale when rows change.")
    return c.build()


def process(parts: Parts) -> dict:
    """02 Process: received, then rough (regex), then sharp (vision), each stage ending in a rebuild."""
    c = _Canvas(PROCESS)
    document = {"document_id": ref("Config", "document_id"), **_tenant_from("Config")}
    vision_template = constant("VISION_REQUEST_TEMPLATE", extraction_body(b"", "", ""))
    failed = "Update the row: stage -1"
    happy = [
        c.add(_TRIGGER, (0, 0), _trigger(), **_contract(
            "Expects the document row 01b appended: document_id, office_id, manager_id, filename, and pdf_base64.")),
        c.add("Config", (1, 0), _config(PROCESS, OPENROUTER_MODEL=DEFAULT_MODEL, PDF_ENGINE="native")),
        c.add("Show the point as received", (2, 0), _execute(REBUILD)),
        c.add("Read the PDF from the row", (3, 0), _code(parts, "read-the-pdf-from-the-row"), onError="continueErrorOutput"),
        c.add("Prepare the vision request", (4, 0), _code(parts, "prepare-the-vision-request", prefix=vision_template),
              onError="continueErrorOutput"),
        c.add("Pull the text out of the PDF", (5, 0), ("n8n-nodes-base.extractFromFile", 1,
              {"operation": "pdf", "binaryPropertyName": "data", "options": {}}), onError="continueErrorOutput"),
        c.add("Coarse read with regex", (6, 0), _code(parts, "coarse-read-with-regex", "coarse")),
        c.add("Update the row: stage 1", (7, 0), _write("update", "documents", document, {
            "stage": "={{ 1 }}",
            "regex_fields": ref("Coarse read with regex", "regex_fields"),
            "text": ref("Coarse read with regex", "text"),
        })),
        c.add("Show the rough view", (8, 0), _execute(REBUILD)),
        c.add("Ask the vision model to read the PDF", (9, 0), _http(
            "POST", OPENROUTER_URL, "={{ JSON.stringify($('Prepare the vision request').first().json.body) }}", timeout=30000),
            credentials=dict(OPENROUTER_CREDENTIAL), retryOnFail=True, maxTries=2, waitBetweenTries=2000,
            onError="continueErrorOutput"),
        c.add("Validate the fields", (10, 0), _code(parts, "validate-the-fields", "validate", prefix=_offices(parts)),
              onError="continueErrorOutput"),
        c.add("Update the row: stage 2", (11, 0), _write("update", "documents", document, {
            "stage": "={{ 2 }}", "llm_fields": ref("Validate the fields", "llm_fields"), "error": "={{ '' }}",
        })),
        c.add("Show the sharp view", (12, 0), _execute(REBUILD)),
        c.add("Write the summary if ready", (13, 0), _execute(SUMMARY)),
    ]
    c.add(failed, (11, 1), _write("update", "documents", document, {
        "stage": "={{ -1 }}",
        "error": "={{ $json.error ? ($json.error.message || JSON.stringify($json.error)) : 'processing failed' }}",
    }))
    c.chain(*happy)
    for step in ("Read the PDF from the row", "Prepare the vision request", "Pull the text out of the PDF",
                 "Ask the vision model to read the PDF", "Validate the fields"):
        c.link(step, failed, output=1)
    c.link(failed, "Show the sharp view")
    c.note("Stages", (440, -240), "Stages left to right: received, rough (regex, wrong on German amounts on purpose), "
                                  "sharp (vision), summary. Each stage ends in 03 Rebuild office point.", width=460)
    c.note("Errors", (2200, 380), "Errors land in stage -1 and still rebuild. The office stays partly blurred and the "
                                  "demo continues.")
    return c.build()


def record(parts: Parts) -> dict:
    """01b Record a document: the one intake. Validates, deduplicates by hash per office, stores the PDF in the row."""
    c = _Canvas(RECORD)
    validated, rows = "Validate the submission", "Build the rows"
    head = [
        c.add(_TRIGGER, (0, 0), _trigger(), **_contract(
            "Expects either a static `file` from the booth pool, or a generated `filename`, `pdf_base64`, `office_id`, "
            "and `worker_id`. Answers status, document_id, duplicate_of, filename, office_id, manager_id.")),
        c.add(validated, (1, 0), _code(parts, "validate-the-submission", "ids",
                                       prefix=_offices(parts) + constant("STATIC_DOCUMENTS", dict(parts.pool)))),
        c.add("Hash the PDF", (2, 0), _hash_text("={{ $json.pdf_base64 }}", "pdf_hash")),
        c.add("Seen this PDF before?", (3, 0), _rows("documents", {
            "pdf_hash": ref("Hash the PDF", "pdf_hash"), **_tenant_from(validated), "kind": "document",
        }), alwaysOutputData=True, executeOnce=True),
        c.add(rows, (4, 0), _code(parts, "build-the-rows")),
        c.add("Is it a duplicate?", (5, 0), _if_true(RECORD, "={{ $json.duplicate }}")),
    ]
    row = {column: ref(rows, f"row.{column}") for column in _DOCUMENT_COLUMNS}
    tenant = {key: ref(rows, f"row.{key}") for key in ("office_id", "manager_id")}
    duplicate = [
        c.add("Append the duplicate row", (6, -1), _write("insert", "documents", None, row)),
        c.add("Rebuild the office", (7, -1), _execute(REBUILD)),
        c.add("Answer: duplicate", (8, -1), _set(RECORD, "Answer: duplicate", include_other=False, status="duplicate",
                                                 document_id=ref(rows, "row.document_id"),
                                                 duplicate_of=ref(rows, "row.duplicate_of"),
                                                 filename=ref(rows, "original_filename"), **tenant)),
    ]
    received = [
        c.add("Upsert the office row", (6, 1), _write("upsert", "offices", tenant, {
            **tenant, "name": ref(rows, "office.name")})),
        c.add("Append the document row", (7, 1), _write("insert", "documents", None, row)),
        c.add("Process in the background", (8, 1), _execute(PROCESS, wait=False)),
        c.add("Answer: received", (9, 1), _set(RECORD, "Answer: received", include_other=False, status="received",
                                               document_id=ref(rows, "row.document_id"),
                                               filename=ref(rows, "row.filename"), **tenant)),
    ]
    c.chain(*head)
    c.link("Is it a duplicate?", duplicate[0], output=0)
    c.link("Is it a duplicate?", received[0], output=1)
    c.chain(*duplicate)
    c.chain(*received)
    c.note("Intake", (0, -260), "One intake for every source: the Form, the console, and the AI working day. The PDF "
                                "lives in the row from here on, so nothing downloads it twice.", width=440)
    c.note("Duplicates", (1320, -420), "Same bytes in the same office: recorded as a duplicate, shown on the tape, never "
                                       "summed and never processed.")
    return c.build()


def ingest(parts: Parts) -> dict:
    """01 Ingest: the phone Form. Picks a booth document and hands it to 01b."""
    c = _Canvas(INGEST)
    steps = [
        c.add("Pick a document", (0, 0), _form_trigger(list(parts.pool))),
        c.add("Name the file", (1, 0), _set(INGEST, "Name the file", include_other=False, file="={{ $json.Document }}")),
        c.add("Record the document", (2, 0), _execute(RECORD)),
        c.add("Is it a duplicate?", (3, 0), _if_true(INGEST, "={{ $json.status === 'duplicate' }}")),
    ]
    c.chain(*steps)
    c.add("Say it is a duplicate", (4, -1), _form_ending(
        "Duplicate", "=That's {{ $('Record the document').first().json.filename }} again (same bytes). Recorded as a "
                     "duplicate, never summed."))
    c.add("Say it was received", (4, 1), _form_ending(
        "Received", "Watch the dashboard: rough in two seconds, sharp in thirty."))
    c.link("Is it a duplicate?", "Say it is a duplicate", output=0)
    c.link("Is it a duplicate?", "Say it was received", output=1)
    c.note("Form", (0, -240), "No file field on purpose: the pool is the booth documents, checked again by 01b. To "
                              "accept uploads, add a File field and pass filename, pdf_base64, office_id, and worker_id.")
    return c.build()


def dashboard_writes(parts: Parts) -> dict:
    """05 Dashboard writes: send a booth document and stop the day. Every webhook needs the dashboard's secret header."""
    c = _Canvas(WRITES)
    send = [
        c.add("Send a document", (0, 0), _webhook("POST", "send", "responseNode"), credentials=dict(DASHBOARD_CREDENTIAL)),
        c.add("Name the file", (1, 0), _set(WRITES, "Name the file", include_other=False, file="={{ $json.body.file }}")),
        c.add("Record the document", (2, 0), _execute(RECORD)),
        c.add("Answer with the result", (3, 0), _respond("firstIncomingItem")),
    ]
    stop = [
        c.add("Stop the day", (0, 2), _webhook("POST", "day/stop", "responseNode"), credentials=dict(DASHBOARD_CREDENTIAL)),
        c.add("Set running to false", (1, 2), _running(False)),
        c.add("Answer stopped", (2, 2), _respond("json", "={{ { running: false } }}")),
    ]
    c.chain(*send)
    c.chain(*stop)
    c.note("Sticky Note", (0, -240), "The dashboard never polls n8n: it reads Qdrant directly. These two webhooks are its "
                                     "only writes; POST /day/start belongs to 00 Working day.", width=440)
    return c.build()


def working_day(parts: Parts) -> dict:
    """00 Working day: AI workers file documents into 01b, one slot at a time, until the count or a stop."""
    c = _Canvas(DAY)
    issued = "Issue the document"
    setup = [
        c.add("Start the day", (0, 0), _webhook("POST", "day/start", "onReceived"), credentials=dict(DASHBOARD_CREDENTIAL)),
        c.add("Config", (1, 0), _set(DAY, "Config", include_other=False, count="={{ $json.body.count }}",
                                     OPENROUTER_MODEL=DEFAULT_MODEL)),
        c.add("Set running to true", (2, 0), _running(True)),
        c.add("Plan the day", (3, 0), _code(parts, "plan-the-day", "worker", prefix=_offices(parts))),
        c.add("Loop over slots", (4, 0), ("n8n-nodes-base.splitInBatches", 3, {"batchSize": 1, "options": {}})),
    ]
    slot = [
        c.add("Is the day still running?", (5, 1), _rows("simulation", {"name": "day"}), alwaysOutputData=True, executeOnce=True),
        c.add("Still running?", (6, 1), _if_true(DAY, "={{ $json.running === true }}")),
        c.add("Read the issued documents", (7, 1), _rows("issued", {}), alwaysOutputData=True, executeOnce=True),
        c.add("Prepare the worker request", (8, 1), _code(parts, "prepare-the-worker-request", "worker", prefix=_offices(parts))),
        c.add("Ask the worker model", (9, 1), _http("POST", OPENROUTER_URL, "={{ JSON.stringify($json.body) }}", timeout=30000),
              credentials=dict(OPENROUTER_CREDENTIAL), retryOnFail=True, maxTries=2, waitBetweenTries=2000,
              onError="continueErrorOutput"),
        c.add(issued, (10, 1), _code(parts, "issue-the-document", "worker", "pdf", prefix=_offices(parts)),
              onError="continueErrorOutput"),
        c.add("Record the document", (11, 1), _execute(RECORD), onError="continueRegularOutput"),
        c.add("Log it in issued", (12, 1), _write("insert", "issued", None, {
            column: ref(issued, f"issued.{column}") for column in _ISSUED_COLUMNS})),
        c.add("Wait between documents", (13, 1), ("n8n-nodes-base.wait", 1.1,
              {"resume": "timeInterval", "amount": DAY_SLOT_SECONDS, "unit": "seconds"})),
    ]
    c.add("Reconcile the offices", (5, -1), _execute(RECONCILE, wait=False))
    c.chain(*setup)
    c.link("Loop over slots", "Reconcile the offices", output=0)
    c.link("Loop over slots", slot[0], output=1)
    c.chain(*slot[:2])
    c.link("Still running?", slot[2], output=0)
    c.link("Still running?", "Reconcile the offices", output=1)
    c.chain(*slot[2:])
    c.link("Wait between documents", "Loop over slots")
    for step in ("Ask the worker model", issued):
        c.link(step, "Wait between documents", output=1)
    c.note("Workers", (660, -260), "The AI plays the event producers. Code decides each slot (supplier order, sponsor or "
                                   "exhibitor order, amendment, credit note, resend); the model writes the content; code "
                                   "checks every value, assigns keys and versions, and renders the PDF. In real life these "
                                   "documents come from suppliers, sponsors, and exhibitors.", width=520, height=170)
    c.note("Rejected", (2000, 420), "A rejected event (out of range, bad category, unknown key) is logged in the "
                                    "execution and skipped; the day goes on.")
    return c.build()


def reconcile(parts: Parts) -> dict:
    """06 Reconcile: rebuild all six office points from the tables, every 5 minutes and after each burst."""
    c = _Canvas(RECONCILE)
    c.add("Every 5 minutes", (0, 0), ("n8n-nodes-base.scheduleTrigger", 1.4,
                                     {"rule": {"interval": [{"field": "minutes", "minutesInterval": 5}]}}))
    c.add(_TRIGGER, (0, 1), _trigger(), **_contract("Accepts any item; rebuilds every office."))
    c.add("List the offices", (1, 0), _code(parts, "list-the-offices", prefix=_offices(parts)))
    c.add("Rebuild each office", (2, 0), _execute(REBUILD, mode="each"))
    c.link("Every 5 minutes", "List the offices")
    c.link(_TRIGGER, "List the offices")
    c.chain("List the offices", "Rebuild each office")
    c.note("Sticky Note", (0, -240), "Overlapping runs can write an office's view out of order. Rebuilding every office "
                                     "from the tables replaces such a view within five minutes.", width=440)
    return c.build()


def maintenance(parts: Parts) -> dict:
    """07 Maintenance: reset between rehearsals, and the issued log for the burst check."""
    c = _Canvas(MAINTENANCE)
    reset = [
        c.add("Reset", (0, 0), _webhook("POST", "reset", "responseNode"), credentials=dict(DASHBOARD_CREDENTIAL)),
        c.add("Stop the day", (1, 0), _running(False)),
        c.add("Clear the documents", (2, 0), _clear("documents"), alwaysOutputData=True),
        c.add("Clear the offices", (3, 0), _clear("offices"), alwaysOutputData=True),
        c.add("Clear the issued log", (4, 0), _clear("issued"), alwaysOutputData=True),
        c.add("Answer reset", (5, 0), _respond("json", "={{ { reset: true } }}")),
        c.add("Rebuild the empty offices", (6, 0), _execute(RECONCILE, wait=False)),
    ]
    log = [
        c.add("Issued", (0, 2), _webhook("GET", "issued", "responseNode"), credentials=dict(DASHBOARD_CREDENTIAL)),
        c.add("Read the issued log", (1, 2), _rows("issued", {}), alwaysOutputData=True, executeOnce=True),
        c.add("Answer with the issued rows", (2, 2), _respond("allIncomingItems")),
    ]
    c.chain(*reset)
    c.chain(*log)
    c.note("Sticky Note", (0, -240), "Reset empties the tables and rebuilds the six offices empty, so the dashboard shows "
                                     "a fresh morning. GET /issued is the ground truth for scripts/burst_check.py.", width=460)
    return c.build()


WORKFLOW_FILES = MappingProxyType({
    "00-working-day.json": working_day,
    "01-ingest.json": ingest,
    "01b-record-a-document.json": record,
    "02-process.json": process,
    "02b-summary.json": summary,
    "03-rebuild-office-point.json": rebuild_point,
    "05-dashboard-writes.json": dashboard_writes,
    "06-reconcile.json": reconcile,
    "07-maintenance.json": maintenance,
})


def build_all(parts: Parts) -> dict[str, dict]:
    return {file: build(parts) for file, build in WORKFLOW_FILES.items()}


# Node specs: (type, typeVersion, parameters). Parameter names checked against n8n's source.

def _trigger() -> tuple:
    """Accept all data. A declared-input trigger makes the caller carry an input mapping, and the editor resets that
    mapping to empty values when the target workflow is selected after import, so the ids arrived as null."""
    return ("n8n-nodes-base.executeWorkflowTrigger", 1.1, {"inputSource": "passthrough"})


def _contract(text: str) -> dict:
    """The sub-workflow's input contract, shown under its trigger on the canvas."""
    return {"notes": text, "notesInFlow": True}


def _config(workflow: str, **values: str) -> tuple:
    return _set(workflow, "Config", include_other=True, **values)


def _set(workflow: str, node: str, include_other: bool, **values: str) -> tuple:
    assignments = [
        {"id": str(uuid.uuid5(_ID_NAMESPACE, f"{workflow}/{node}/{name}")), "name": name, "value": value, "type": "string"}
        for name, value in values.items()
    ]
    return ("n8n-nodes-base.set", 3.4,
            {"assignments": {"assignments": assignments}, "includeOtherFields": include_other, "options": {}})


def _hash_text(value: str, into: str) -> tuple:
    return ("n8n-nodes-base.crypto", 2, {"action": "hash", "type": "SHA256", "value": value, "dataPropertyName": into, "encoding": "hex"})


def _hash_binary(into: str) -> tuple:
    return ("n8n-nodes-base.crypto", 2, {"action": "hash", "type": "SHA256", "binaryData": True, "binaryPropertyName": "data",
                                         "dataPropertyName": into, "encoding": "hex"})


def _code(parts: Parts, glue: str, *sources: str, prefix: str = "") -> tuple:
    js = prefix + "".join(pasted(parts.sources[name]) for name in sources) + parts.glue[glue]
    return ("n8n-nodes-base.code", 2, {"jsCode": js})


def _offices(parts: Parts) -> str:
    return constant("OFFICES", list(parts.offices))


def _tenant_from(node: str) -> dict:
    return {"office_id": ref(node, "office_id"), "manager_id": ref(node, "manager_id")}


def _conditions(match: Mapping[str, str]) -> dict:
    return {
        "matchType": "allConditions",
        "filters": {"conditions": [{"keyName": key, "condition": "eq", "keyValue": value} for key, value in match.items()]},
    }


def _table(name: str) -> dict:
    return {"__rl": True, "mode": "name", "value": name}


def _rows(table: str, match: Mapping[str, str]) -> tuple:
    """Every row of `table` matching all conditions; pair with executeOnce and alwaysOutputData."""
    return ("n8n-nodes-base.dataTable", 1.1, {
        "resource": "row", "operation": "get", "dataTableId": _table(table), **_conditions(match), "returnAll": True,
    })


def _write(operation: str, table: str, match: Mapping[str, str] | None, columns: Mapping[str, str]) -> tuple:
    """insert, update, or upsert. Only the mapped columns are written, so the saved summary survives."""
    schema = [{"id": column, "displayName": column, "required": False, "defaultMatch": False, "display": True,
               "type": _COLUMN_TYPES.get(column, "string"), "readOnly": False, "removed": False} for column in columns]
    parameters = {"resource": "row", "operation": operation, "dataTableId": _table(table)}
    if match is not None:
        parameters.update(_conditions(match))
    parameters["columns"] = {"mappingMode": "defineBelow", "value": dict(columns), "matchingColumns": [], "schema": schema,
                             "attemptToConvertTypes": False, "convertFieldsToString": False}
    parameters["options"] = {}
    return ("n8n-nodes-base.dataTable", 1.1, parameters)


def _clear(table: str) -> tuple:
    """Delete every row and keep the columns. Row deletion refuses an empty filter, so this is the table operation."""
    return ("n8n-nodes-base.dataTable", 1.1, {"resource": "table", "operation": "clear", "dataTableId": _table(table)})


def _running(value: bool) -> tuple:
    """The working day's switch: one `simulation` row named day."""
    return _write("upsert", "simulation", {"name": "day"}, {"name": "day", "running": f"={{{{ {str(value).lower()} }}}}"})


def _execute(target: str, wait: bool = True, mode: str = "once") -> tuple:
    """Call a sub-workflow; the target is selected once after import, by its name. `each` runs it once per item."""
    return ("n8n-nodes-base.executeWorkflow", 1.2, {
        "workflowId": {"__rl": True, "value": "", "mode": "list", "cachedResultName": target},
        "mode": mode,
        "options": {"waitForSubWorkflow": wait},
    })


def _webhook(method: str, path: str, response_mode: str) -> tuple:
    """A dashboard webhook: header auth with the Dashboard secret credential."""
    return ("n8n-nodes-base.webhook", 2.2, {"httpMethod": method, "path": path, "authentication": "headerAuth",
                                            "responseMode": response_mode, "options": {}})


def _respond(respond_with: str, body: str | None = None) -> tuple:
    parameters: dict = {"respondWith": respond_with}
    if body is not None:
        parameters["responseBody"] = body
    parameters["options"] = {}
    return ("n8n-nodes-base.respondToWebhook", 1.5, parameters)


def _qdrant_url(path: str) -> str:
    return ("={{ $('Config').first().json.QDRANT_URL }}/collections/{{ $('Config').first().json.COLLECTION }}" + path)


def _http(method: str, url: str, json_body: str | None = None, *, file_response: bool = False,
          timeout: int | None = None) -> tuple:
    parameters: dict = {"method": method, "url": url}
    if json_body is not None:
        parameters.update({"authentication": "genericCredentialType", "genericAuthType": "httpHeaderAuth",
                           "sendBody": True, "specifyBody": "json", "jsonBody": json_body})
    options: dict = {}
    if file_response:
        options["response"] = {"response": {"responseFormat": "file", "outputPropertyName": "data"}}
    if timeout:
        options["timeout"] = timeout
    parameters["options"] = options
    return ("n8n-nodes-base.httpRequest", 4.2, parameters)


def _form_trigger(files: list[str]) -> tuple:
    dropdown = {"fieldLabel": "Document", "fieldType": "dropdown", "requiredField": True,
                "fieldOptions": {"values": [{"option": file} for file in files]}}
    return ("n8n-nodes-base.formTrigger", 2.2, {
        "formTitle": "Send a document to Q8nten",
        "formDescription": "Synthetic documents of a fictional event agency. Pick one; the producer who files it is known.",
        "formFields": {"values": [dropdown]},
        "options": {},
    })


def _form_ending(title: str, message: str) -> tuple:
    return ("n8n-nodes-base.form", 1, {"operation": "completion", "completionTitle": title, "completionMessage": message,
                                       "options": {}})


def _if_true(workflow: str, expression: str) -> tuple:
    return ("n8n-nodes-base.if", 2.2, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
            "conditions": [{"id": _stable_id(workflow, "if/condition"), "leftValue": expression, "rightValue": "",
                            "operator": {"type": "boolean", "operation": "true", "singleValue": True}}],
            "combinator": "and",
        },
        "options": {},
    })


_WEBHOOK_TYPES = frozenset({"n8n-nodes-base.webhook", "n8n-nodes-base.formTrigger", "n8n-nodes-base.form",
                            "n8n-nodes-base.wait"})


def _stable_id(workflow: str, name: str) -> str:
    return str(uuid.uuid5(_ID_NAMESPACE, f"{workflow}/{name}"))


def main() -> int:
    for file, workflow in build_all(read_parts()).items():
        (WORKFLOWS_DIR / file).write_text(json.dumps(workflow, indent=2, ensure_ascii=False) + "\n")
        print(f"wrote workflows/{file}")
    for stale in sorted(set(p.name for p in WORKFLOWS_DIR.glob("*.json")) - set(WORKFLOW_FILES)):
        print(f"stale: workflows/{stale} is not built any more; delete it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
