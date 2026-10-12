"""Assemble importable n8n workflow JSON from workflows/code (pure functions) and workflows/nodes (Code-node glue).

Run after changing either folder or samples/manifest.json: python3 scripts/build_workflows.py
The output carries no instance ids. Data Tables and credentials are referenced by name, the cluster URL is a
placeholder to set in each Config node, and every Execute Sub-workflow node names its target in
`cachedResultName` so it can be selected again after import.
"""

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
SAMPLES_BASE_URL = "https://raw.githubusercontent.com/havenousername/n8n-invoice-memory/main/samples"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "anthropic/claude-haiku-5.5"
WORKERS = MappingProxyType({
    "w_tom": {"manager_id": "m_anna", "name": "Tom"},
    "w_lena": {"manager_id": "m_anna", "name": "Lena"},
    "w_jules": {"manager_id": "m_ben", "name": "Jules"},
    "w_mia": {"manager_id": "m_ben", "name": "Mia"},
})
QDRANT_CREDENTIAL = MappingProxyType({"httpHeaderAuth": {"name": "Qdrant api-key"}})
OPENROUTER_CREDENTIAL = MappingProxyType({"httpHeaderAuth": {"name": "OpenRouter bearer"}})

_CODE_SOURCES = ("ids", "coarse", "validate", "view", "cards", "match")
_COLUMN_TYPES = MappingProxyType({"stage": "number", "received_at": "dateTime", "deleted_at": "dateTime", "narrative_at": "dateTime"})
_ID_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "https://github.com/qdrant/n8n-invoice-memory")
_TRIGGER = "When Executed by Another Workflow"
REBUILD, PROCESS, NARRATIVE, INGEST = "03 Rebuild point", "02 Process", "02b Write the narrative", "01 Ingest"


@dataclasses.dataclass(frozen=True)
class Parts:
    sources: Mapping[str, str]  # workflows/code/<name>.js
    glue: Mapping[str, str]  # workflows/nodes/<name>.js
    manifest: tuple[dict, ...]  # samples/manifest.json


def read_parts() -> Parts:
    return Parts(
        sources={name: (WORKFLOWS_DIR / "code" / f"{name}.js").read_text() for name in _CODE_SOURCES},
        glue={path.stem: path.read_text() for path in sorted((WORKFLOWS_DIR / "nodes").glob("*.js"))},
        manifest=tuple(json.loads((REPO / "samples" / "manifest.json").read_text())),
    )


def pasted(source: str) -> str:
    """A pure-function source as a Code node needs it: no module.exports, since there is no require."""
    return re.sub(r"^module\.exports.*\n?", "", source, flags=re.MULTILINE)


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
        self.nodes.append({
            "id": _stable_id(self.workflow, name),
            "name": name,
            "type": type_,
            "typeVersion": version,
            "position": [at[0] * 220, at[1] * 200],
            "parameters": parameters,
            **extra,
        })
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

    def build(self, pin: Mapping[str, list] | None = None) -> dict:
        workflow = {"name": self.workflow, "nodes": self.nodes, "connections": {s: {"main": o} for s, o in self.links.items()}}
        if pin:
            workflow["pinData"] = dict(pin)
        workflow["settings"] = {"executionOrder": "v1"}
        return workflow


def rebuild_point(parts: Parts) -> dict:
    """03 Rebuild point: the only writer to Qdrant. Inputs customer_id and manager_id."""
    c = _Canvas(REBUILD)
    steps = [
        c.add(_TRIGGER, (0, 0), _trigger("customer_id", "manager_id")),
        c.add("Config", (1, 0), _config(REBUILD, QDRANT_URL=QDRANT_URL_PLACEHOLDER, COLLECTION="customers")),
        c.add("Hash the point id", (2, 0), _hash_text("={{ $json.manager_id }}/{{ $json.customer_id }}", "idhash")),
        c.add("Load the customer row", (3, 0), _rows("customers", _tenant_from("Config")), alwaysOutputData=True, executeOnce=True),
        c.add("Load all invoice rows", (4, 0), _rows("invoices", _tenant_from("Config")), alwaysOutputData=True, executeOnce=True),
        c.add("Compute the view", (5, 0), _code(parts, "compute-the-view", "ids", "view")),
        c.add("Upsert the point with inference", (6, 0), _http(
            "PUT", _qdrant_url("/points?wait=true"), "={{ JSON.stringify($json.body) }}"), credentials=dict(QDRANT_CREDENTIAL)),
    ]
    c.chain(*steps)
    c.note("Sticky Note", (440, -220), "Source of truth is the two Data Tables. This workflow is the only writer to Qdrant. "
                                       "Any stage, any retry, same point.")
    return c.build({_TRIGGER: [{"json": {"customer_id": "acme", "manager_id": "m_anna"}}]})


def narrative(parts: Parts) -> dict:
    """02b Write the narrative: three sentences for a sharp point, saved with the revision they describe."""
    c = _Canvas(NARRATIVE)
    steps = [
        c.add(_TRIGGER, (0, 0), _trigger("customer_id", "manager_id")),
        c.add("Config", (1, 0), _config(NARRATIVE, QDRANT_URL=QDRANT_URL_PLACEHOLDER, COLLECTION="customers",
                                        OPENROUTER_MODEL=DEFAULT_MODEL)),
        c.add("Hash the point id", (2, 0), _hash_text("={{ $json.manager_id }}/{{ $json.customer_id }}", "idhash")),
        c.add("Format the point id", (3, 0), _code(parts, "format-the-point-id", "ids")),
        c.add("Read the point", (4, 0), _http("POST", _qdrant_url("/points"), "={{ JSON.stringify($json.body) }}"),
              credentials=dict(QDRANT_CREDENTIAL)),
        c.add("Prepare the narrative snapshot", (5, 0), _code(parts, "prepare-the-narrative-snapshot")),
        c.add("Ask for three sentences", (6, 0), _http("POST", OPENROUTER_URL, "={{ JSON.stringify($json.body) }}", timeout=20000),
              credentials=dict(OPENROUTER_CREDENTIAL), retryOnFail=True, maxTries=2, waitBetweenTries=2000),
        c.add("Keep only the narrative", (7, 0), _code(parts, "keep-only-the-narrative")),
        c.add("Save the narrative", (8, 0), _write("update", "customers", _tenant_from("Config"), {
            "narrative": ref("Keep only the narrative", "narrative"),
            "narrative_at": ref("Keep only the narrative", "at"),
            "narrative_revision": ref("Keep only the narrative", "revision"),
        })),
        c.add("Rebuild the point", (9, 0), _execute(REBUILD, _tenant_from("Config"))),
    ]
    c.chain(*steps)
    c.note("Sticky Note", (1100, -220), "Narrates only a sharp point: every invoice read, none pending. The narrative is "
                                        "saved with the source_revision it describes and goes stale when the rows change.")
    return c.build({_TRIGGER: [{"json": {"customer_id": "acme", "manager_id": "m_anna"}}]})


def process(parts: Parts) -> dict:
    """02 Process: received, then coarse (regex), then sharp (vision), each stage ending in a rebuild."""
    c = _Canvas(PROCESS)
    tenant = _tenant_from("Config")
    invoice = {"invoice_id": ref("Config", "invoice_id"), **tenant}
    vision_template = f"const VISION_REQUEST_TEMPLATE = {json.dumps(extraction_body(b'', '', ''))};\n"
    sample_url = ("={{ $('Config').first().json.sample_url.startsWith($('Config').first().json.SAMPLES_BASE_URL + '/') "
                  "? $('Config').first().json.sample_url : 'https://sample-url-outside-SAMPLES_BASE_URL.invalid' }}")
    failed = "Update the row: stage -1"
    happy = [
        c.add(_TRIGGER, (0, 0), _trigger("invoice_id", "customer_id", "manager_id", "sample_url")),
        c.add("Config", (1, 0), _config(PROCESS, OPENROUTER_MODEL=DEFAULT_MODEL, PDF_ENGINE="native",
                                        SAMPLES_BASE_URL=SAMPLES_BASE_URL)),
        c.add("Show the point as received", (2, 0), _execute(REBUILD, tenant)),
        c.add("Download the PDF for processing", (3, 0), _http("GET", sample_url, file_response=True), onError="continueErrorOutput"),
        c.add("Prepare the vision request", (4, 0), _code(parts, "prepare-the-vision-request", prefix=vision_template),
              onError="continueErrorOutput"),
        c.add("Pull the text out of the PDF", (5, 0), ("n8n-nodes-base.extractFromFile", 1,
              {"operation": "pdf", "binaryPropertyName": "data", "options": {}}), onError="continueErrorOutput"),
        c.add("Coarse read with regex", (6, 0), _code(parts, "coarse-read-with-regex", "coarse")),
        c.add("Update the row: stage 1", (7, 0), _write("update", "invoices", invoice, {
            "stage": "={{ 1 }}",
            "regex_fields": ref("Coarse read with regex", "regex_fields"),
            "text": ref("Coarse read with regex", "text"),
        })),
        c.add("Show the coarse view", (8, 0), _execute(REBUILD, tenant)),
        c.add("Ask the vision model to read the PDF", (9, 0), _http(
            "POST", OPENROUTER_URL, "={{ JSON.stringify($('Prepare the vision request').first().json.body) }}", timeout=30000),
            credentials=dict(OPENROUTER_CREDENTIAL), retryOnFail=True, maxTries=2, waitBetweenTries=2000,
            onError="continueErrorOutput"),
        c.add("Validate the fields", (10, 0), _code(parts, "validate-the-fields", "validate"), onError="continueErrorOutput"),
        c.add("Update the row: stage 2", (11, 0), _write("update", "invoices", invoice, {
            "stage": "={{ 2 }}", "llm_fields": ref("Validate the fields", "llm_fields"), "error": "={{ '' }}",
        })),
        c.add("Show the sharp view", (12, 0), _execute(REBUILD, tenant)),
        c.add("Write the narrative if ready", (13, 0), _execute(NARRATIVE, tenant)),
    ]
    c.add(failed, (11, 1), _write("update", "invoices", invoice, {
        "stage": "={{ -1 }}",
        "error": "={{ $json.error ? ($json.error.message || JSON.stringify($json.error)) : 'processing failed' }}",
    }))
    c.chain(*happy)
    for step in ("Download the PDF for processing", "Prepare the vision request", "Pull the text out of the PDF",
                 "Ask the vision model to read the PDF", "Validate the fields"):
        c.link(step, failed, output=1)
    c.link(failed, "Show the sharp view")
    c.note("Stages", (440, -240), "Stages left to right: received, coarse (regex, wrong on German numbers on purpose), "
                                  "sharp (vision), narrative. Each stage ends in 03 Rebuild point.", width=460)
    c.note("Errors", (2200, 380), "Errors land in stage -1 and still rebuild. The card stays half-blurry and the demo "
                                  "continues.")
    pin = {"invoice_id": "inv_seed_a", "customer_id": "acme", "manager_id": "m_anna",
           "sample_url": f"{SAMPLES_BASE_URL}/acme-001.pdf"}
    return c.build({_TRIGGER: [{"json": pin}]})


def ingest(parts: Parts) -> dict:
    """01 Ingest: the public Form. Validates, deduplicates by hash, records the rows, and hands off to 02 Process."""
    c = _Canvas(INGEST)
    files = [row["file"] for row in parts.manifest]
    names = {row["customer"]: row["customer_name"] for row in parts.manifest}
    validated = "Validate the submission"
    head = [
        c.add("Pick an invoice", (0, 0), _form_trigger(files, [w["name"] for w in WORKERS.values()]),
              webhookId=_stable_id(INGEST, "Pick an invoice/webhook")),
        c.add("Config", (1, 0), _config(INGEST, SAMPLES_BASE_URL=SAMPLES_BASE_URL, SAMPLES=json.dumps(files),
                                        CUSTOMER_NAMES=json.dumps(names), WORKERS=json.dumps(dict(WORKERS)))),
        c.add(validated, (2, 0), _code(parts, "validate-the-submission", "ids")),
        c.add("Download the chosen sample", (3, 0), _http("GET", ref(validated, "sample_url"), file_response=True)),
        c.add("Hash the PDF", (4, 0), _hash_binary("pdf_hash")),
        c.add("Seen this hash before?", (5, 0), _rows("invoices", {
            "pdf_hash": ref("Hash the PDF", "pdf_hash"), **_tenant_from(validated),
        }), alwaysOutputData=True, executeOnce=True),
        c.add("Is it a duplicate?", (6, 0), _if_true(INGEST, "={{ !!$json.invoice_id }}")),
    ]
    c.add("Say it is a duplicate", (7, -1), _form_ending(
        "Duplicate", "=That's {{ $('Seen this hash before?').first().json.filename }} again (hash match). Nothing new was ingested."),
        webhookId=_stable_id(INGEST, "Say it is a duplicate/webhook"))
    customer = {key: ref("Decide the rows", f"customer.{key}") for key in ("customer_id", "manager_id", "worker_id", "name")}
    invoice_columns = ("invoice_id", "customer_id", "worker_id", "manager_id", "pdf_hash", "filename", "text", "stage",
                       "regex_fields", "llm_fields", "error", "received_at")
    tail = [
        c.add("Load the existing customer", (7, 1), _rows("customers", _tenant_from(validated)),
              alwaysOutputData=True, executeOnce=True),
        c.add("Decide the rows", (8, 1), _code(parts, "decide-the-rows")),
        c.add("Upsert the customer row", (9, 1), _write("upsert", "customers", {
            "customer_id": customer["customer_id"], "manager_id": customer["manager_id"]}, customer)),
        c.add("Append the invoice row", (10, 1), _write("insert", "invoices", None, {
            key: ref("Decide the rows", f"invoice.{key}") for key in invoice_columns})),
        c.add("Process in the background", (11, 1), _execute(PROCESS, {
            **{key: ref("Decide the rows", f"invoice.{key}") for key in ("invoice_id", "customer_id", "manager_id")},
            "sample_url": ref(validated, "sample_url"),
        }, wait=False)),
        c.add("Say it was received", (12, 1), _form_ending(
            "Received", "Watch the dashboard. Rough in two seconds, sharp in thirty."),
              webhookId=_stable_id(INGEST, "Say it was received/webhook")),
    ]
    c.chain(*head)
    c.link("Is it a duplicate?", "Say it is a duplicate", output=0)
    c.link("Is it a duplicate?", tail[0], output=1)
    c.chain(*tail)
    c.note("Form", (0, -240), "No file field on purpose: samples download from the public repo, and both dropdowns are "
                              "checked against the manifest and the worker list. To accept uploads, add a File field "
                              "and drop the download.")
    c.note("Storage", (660, 380), "Keeping the PDF? Add your storage node after the download. The PDF outlives a GDPR "
                                  "removal of the searchable record.")
    return c.build()


WORKFLOW_FILES = MappingProxyType({
    "01-ingest.json": ingest,
    "02-process.json": process,
    "02b-narrative.json": narrative,
    "03-rebuild-point.json": rebuild_point,
})


def build_all(parts: Parts) -> dict[str, dict]:
    return {file: build(parts) for file, build in WORKFLOW_FILES.items()}


# Node specs: (type, typeVersion, parameters). Parameter names checked against n8n's source.

def _trigger(*inputs: str) -> tuple:
    return ("n8n-nodes-base.executeWorkflowTrigger", 1.1, {
        "inputSource": "workflowInputs",
        "workflowInputs": {"values": [{"name": name, "type": "string"} for name in inputs]},
    })


def _config(workflow: str, **values: str) -> tuple:
    assignments = [
        {"id": str(uuid.uuid5(_ID_NAMESPACE, f"{workflow}/Config/{name}")), "name": name, "value": value, "type": "string"}
        for name, value in values.items()
    ]
    return ("n8n-nodes-base.set", 3.4, {"assignments": {"assignments": assignments}, "includeOtherFields": True, "options": {}})


def _hash_text(value: str, into: str) -> tuple:
    return ("n8n-nodes-base.crypto", 2, {"action": "hash", "type": "SHA256", "value": value, "dataPropertyName": into, "encoding": "hex"})


def _hash_binary(into: str) -> tuple:
    return ("n8n-nodes-base.crypto", 2, {"action": "hash", "type": "SHA256", "binaryData": True, "binaryPropertyName": "data",
                                         "dataPropertyName": into, "encoding": "hex"})


def _code(parts: Parts, glue: str, *sources: str, prefix: str = "") -> tuple:
    js = prefix + "".join(pasted(parts.sources[name]) for name in sources) + parts.glue[glue]
    return ("n8n-nodes-base.code", 2, {"jsCode": js})


def _tenant_from(node: str) -> dict:
    return {"customer_id": ref(node, "customer_id"), "manager_id": ref(node, "manager_id")}


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
    """insert, update, or upsert. Only the mapped columns are written, so narrative and deleted_at survive."""
    schema = [{"id": column, "displayName": column, "required": False, "defaultMatch": False, "display": True,
               "type": _COLUMN_TYPES.get(column, "string"), "readOnly": False, "removed": False} for column in columns]
    parameters = {"resource": "row", "operation": operation, "dataTableId": _table(table)}
    if match is not None:
        parameters.update(_conditions(match))
    parameters["columns"] = {"mappingMode": "defineBelow", "value": dict(columns), "matchingColumns": [], "schema": schema,
                             "attemptToConvertTypes": False, "convertFieldsToString": False}
    parameters["options"] = {}
    return ("n8n-nodes-base.dataTable", 1.1, parameters)


def _execute(target: str, inputs: Mapping[str, str], wait: bool = True) -> tuple:
    schema = [{"id": key, "displayName": key, "required": False, "defaultMatch": False, "display": True,
               "canBeUsedToMatch": True, "type": "string", "removed": False} for key in inputs]
    return ("n8n-nodes-base.executeWorkflow", 1.2, {
        "workflowId": {"__rl": True, "value": "", "mode": "list", "cachedResultName": target},
        "workflowInputs": {"mappingMode": "defineBelow", "value": dict(inputs), "matchingColumns": [], "schema": schema,
                           "attemptToConvertTypes": False, "convertFieldsToString": True},
        "options": {"waitForSubWorkflow": wait},
    })


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


def _form_trigger(files: list[str], workers: list[str]) -> tuple:
    def dropdown(label: str, options: list[str]) -> dict:
        return {"fieldLabel": label, "fieldType": "dropdown", "requiredField": True,
                "fieldOptions": {"values": [{"option": option} for option in options]}}

    return ("n8n-nodes-base.formTrigger", 2.2, {
        "formTitle": "Send an invoice",
        "formDescription": "Synthetic data only. Pick a sample invoice and the worker who received it.",
        "formFields": {"values": [dropdown("Invoice", files), dropdown("Worker", workers)]},
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


def _stable_id(workflow: str, name: str) -> str:
    return str(uuid.uuid5(_ID_NAMESPACE, f"{workflow}/{name}"))


def main() -> int:
    for file, workflow in build_all(read_parts()).items():
        (WORKFLOWS_DIR / file).write_text(json.dumps(workflow, indent=2, ensure_ascii=False) + "\n")
        print(f"wrote workflows/{file}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
