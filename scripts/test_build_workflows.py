import base64
import json
import re
import unittest

from build_workflows import (
    DAY_SLOT_SECONDS, QDRANT_URL_PLACEHOLDER, REPO, WORKFLOW_FILES, WORKFLOWS_DIR, build_all, pasted, read_parts,
)
from openrouter_check import extraction_body
from schema import MODELS

PARTS = read_parts()
BUILT = build_all(PARTS)
STICKY = "n8n-nodes-base.stickyNote"
EXECUTE = "n8n-nodes-base.executeWorkflow"
WEBHOOK = "n8n-nodes-base.webhook"
REBUILD, PROCESS, SUMMARY, RECORD, RECONCILE = (
    "03 Rebuild office point", "02 Process", "02b Write the summary", "01b Record a document", "06 Reconcile")
# Per target, the nodes allowed to feed its Execute node: each outputs what the target's contract names.
FEEDERS = {
    REBUILD: {"Config", "Update the row: stage 1", "Update the row: stage 2", "Update the row: stage -1",
              "Save the narrative", "Append the duplicate row", "List the offices"},
    PROCESS: {"Append the document row"},
    SUMMARY: {"Show the sharp view"},
    RECORD: {"Name the file", "Issue the document"},
    RECONCILE: None,  # accepts any item
}
MANIFEST = json.loads((REPO / "samples" / "manifest.json").read_text())
OFFICES = json.loads((REPO / "samples" / "offices.json").read_text())
POOL = [row["file"] for row in MANIFEST if row["role"] == "booth"]


def nodes_of(workflow: dict) -> dict:
    return {n["name"]: n for n in workflow["nodes"]}


def steps_of(workflow: dict) -> list[str]:
    return [n["name"] for n in workflow["nodes"] if n["type"] != STICKY]


def edges_of(workflow: dict) -> set[tuple[str, int, str]]:
    return {
        (source, output, link["node"])
        for source, by_type in workflow["connections"].items()
        for output, links in enumerate(by_type["main"])
        for link in links
    }


def conditions_of(node: dict) -> dict:
    return {c["keyName"]: c["keyValue"] for c in node["parameters"]["filters"]["conditions"]}


def from_node(node: str, key: str) -> str:
    return f"={{{{ $('{node}').first().json.{key} }}}}"


def injected(node: dict, name: str):
    match = re.search(rf"^const {name} = (.*);$", node["parameters"]["jsCode"], flags=re.MULTILINE)
    return json.loads(match.group(1)) if match else None


def target_of(node: dict) -> str:
    return node["parameters"]["workflowId"]["cachedResultName"]


class PastedTest(unittest.TestCase):
    def test_drops_only_the_module_exports_line(self):
        self.assertEqual(pasted("function f() {}\n\nmodule.exports = { f };\n"), "function f() {}\n\n")


class EveryWorkflowTest(unittest.TestCase):
    def test_the_nine_workflows_are_built(self):
        self.assertEqual(set(BUILT), {
            "00-working-day.json", "01-ingest.json", "01b-record-a-document.json", "02-process.json", "02b-summary.json",
            "03-rebuild-office-point.json", "05-dashboard-writes.json", "06-reconcile.json", "07-maintenance.json"})
        self.assertEqual(set(BUILT), set(WORKFLOW_FILES))

    def test_canvas_limits_and_unique_names(self):
        for file, workflow in BUILT.items():
            with self.subTest(file):
                self.assertLessEqual(len(steps_of(workflow)), 15)
                self.assertLessEqual(sum(n["type"] == STICKY for n in workflow["nodes"]), 4)
                self.assertEqual(len({n["name"] for n in workflow["nodes"]}), len(workflow["nodes"]))
                self.assertEqual(len({n["id"] for n in workflow["nodes"]}), len(workflow["nodes"]))

    def test_connections_point_at_real_nodes_and_every_step_is_reached(self):
        for file, workflow in BUILT.items():
            names = set(nodes_of(workflow))
            targets = {target for _, _, target in edges_of(workflow)}
            for source, _, target in edges_of(workflow):
                with self.subTest(file=file, edge=(source, target)):
                    self.assertIn(source, names)
                    self.assertIn(target, names)
            triggers = {n["name"] for n in workflow["nodes"] if "Trigger" in n["type"] or n["type"] == WEBHOOK
                        or n["type"] == "n8n-nodes-base.executeWorkflowTrigger"}
            with self.subTest(file=file, check="reached"):
                self.assertEqual(set(steps_of(workflow)) - targets - triggers, set())

    def test_no_instance_ids_and_only_the_placeholder_cluster_url(self):
        for file, workflow in BUILT.items():
            with self.subTest(file):
                for node in workflow["nodes"]:
                    for credential in node.get("credentials", {}).values():
                        self.assertEqual(set(credential), {"name"})
                text = json.dumps(workflow)
                self.assertLessEqual(text.count("cloud.qdrant.io"), 1)
                if "cloud.qdrant.io" in text:
                    self.assertIn(QDRANT_URL_PLACEHOLDER, text)

    def test_sub_workflows_accept_the_callers_item_and_state_their_contract(self):
        for file in ("01b-record-a-document.json", "02-process.json", "02b-summary.json", "03-rebuild-office-point.json",
                     "06-reconcile.json"):
            with self.subTest(file):
                trigger = nodes_of(BUILT[file])["When Executed by Another Workflow"]
                self.assertEqual(trigger["parameters"], {"inputSource": "passthrough"})
                self.assertTrue(trigger["notes"] and trigger["notesInFlow"])

    def test_calls_carry_no_input_mapping_and_follow_a_node_that_carries_the_contract(self):
        for file, workflow in BUILT.items():
            feeds = {}
            for source, _, target in edges_of(workflow):
                feeds.setdefault(target, set()).add(source)
            for node in workflow["nodes"]:
                if node["type"] == EXECUTE:
                    with self.subTest(file=file, node=node["name"]):
                        self.assertNotIn("workflowInputs", node["parameters"])
                        self.assertEqual(node["parameters"]["workflowId"]["value"], "")
                        allowed = FEEDERS[target_of(node)]
                        if allowed is not None:
                            self.assertLessEqual(feeds[node["name"]], allowed)

    def test_every_webhook_requires_the_dashboard_secret(self):
        found = 0
        for file, workflow in BUILT.items():
            for node in workflow["nodes"]:
                if node["type"] == WEBHOOK:
                    found += 1
                    with self.subTest(file=file, node=node["name"]):
                        self.assertEqual(node["parameters"]["authentication"], "headerAuth")
                        self.assertEqual(node["credentials"], {"httpHeaderAuth": {"name": "Dashboard secret"}})
                        self.assertTrue(node["webhookId"])
        self.assertEqual(found, 5)

    def test_injected_offices_and_pool_equal_the_samples(self):
        for file, workflow in BUILT.items():
            for node in workflow["nodes"]:
                if node["type"] != "n8n-nodes-base.code":
                    continue
                with self.subTest(file=file, node=node["name"]):
                    offices = injected(node, "OFFICES")
                    if offices is not None:
                        self.assertEqual(offices, OFFICES)
                    pool = injected(node, "STATIC_DOCUMENTS")
                    if pool is not None:
                        self.assertEqual(list(pool), POOL)
                        for file_name, doc in pool.items():
                            self.assertEqual(base64.b64decode(doc["pdf_base64"]), (REPO / "samples" / file_name).read_bytes())

    def test_code_nodes_have_no_module_exports_statement(self):
        for file, workflow in BUILT.items():
            for node in workflow["nodes"]:
                if node["type"] == "n8n-nodes-base.code":
                    with self.subTest(file=file, node=node["name"]):
                        self.assertNotRegex(node["parameters"]["jsCode"], r"(?m)^module\.exports")

    def test_committed_files_match_the_sources(self):
        for file, workflow in BUILT.items():
            with self.subTest(file):
                committed = json.loads((WORKFLOWS_DIR / file).read_text())
                self.assertEqual(committed, workflow, "run python3 scripts/build_workflows.py")
        self.assertEqual({p.name for p in WORKFLOWS_DIR.glob("*.json")}, set(WORKFLOW_FILES), "stale workflow files")


class RebuildPointTest(unittest.TestCase):
    def setUp(self):
        self.workflow = BUILT["03-rebuild-office-point.json"]
        self.nodes = nodes_of(self.workflow)

    def test_nodes_are_chained_in_order(self):
        order = ["When Executed by Another Workflow", "Config", "Hash the point id", "Load the office row",
                 "Load all document rows", "Compute the view", "Upsert the point with inference", "Return what was rebuilt"]
        self.assertEqual(steps_of(self.workflow), order)
        self.assertEqual(edges_of(self.workflow), {(a, 0, b) for a, b in zip(order, order[1:])})

    def test_writes_the_offices_collection(self):
        values = {a["name"]: a["value"] for a in self.nodes["Config"]["parameters"]["assignments"]["assignments"]}
        self.assertEqual(values["COLLECTION"], "offices")
        self.assertEqual(self.nodes["Hash the point id"]["parameters"]["value"], "={{ $json.manager_id }}/{{ $json.office_id }}")

    def test_returns_the_ids_it_rebuilt(self):
        node = self.nodes["Return what was rebuilt"]
        values = {a["name"]: a["value"] for a in node["parameters"]["assignments"]["assignments"]}
        self.assertEqual(values, {
            "office_id": from_node("Config", "office_id"),
            "manager_id": from_node("Config", "manager_id"),
            "point_id": from_node("Compute the view", "body.points[0].id"),
        })

    def test_data_table_reads_are_tenant_scoped_and_run_once(self):
        for name, table in (("Load the office row", "offices"), ("Load all document rows", "documents")):
            with self.subTest(name):
                node = self.nodes[name]
                self.assertEqual(node["parameters"]["dataTableId"], {"__rl": True, "mode": "name", "value": table})
                self.assertEqual(conditions_of(node), {k: from_node("Config", k) for k in ("office_id", "manager_id")})
                self.assertTrue(node["alwaysOutputData"] and node["executeOnce"] and node["parameters"]["returnAll"])

    def test_code_node_pastes_offices_sources_and_glue(self):
        js = self.nodes["Compute the view"]["parameters"]["jsCode"]
        self.assertIn(pasted(PARTS.sources["ids"]) + pasted(PARTS.sources["office-view"]), js)
        self.assertTrue(js.endswith(PARTS.glue["compute-the-view"]))
        for model in MODELS.values():
            self.assertIn(model, js)

    def test_upsert_uses_the_named_credential(self):
        node = self.nodes["Upsert the point with inference"]
        self.assertTrue(node["parameters"]["url"].endswith("/points?wait=true"))
        self.assertEqual(node["credentials"], {"httpHeaderAuth": {"name": "Qdrant api-key"}})


class SummaryTest(unittest.TestCase):
    def setUp(self):
        self.workflow = BUILT["02b-summary.json"]
        self.nodes = nodes_of(self.workflow)

    def test_ten_nodes_in_a_chain(self):
        order = ["When Executed by Another Workflow", "Config", "Hash the point id", "Format the point id",
                 "Read the point", "Prepare the narrative snapshot", "Ask for three sentences",
                 "Keep only the narrative", "Save the narrative", "Rebuild the point"]
        self.assertEqual(steps_of(self.workflow), order)
        self.assertEqual(edges_of(self.workflow), {(a, 0, b) for a, b in zip(order, order[1:])})

    def test_summary_is_saved_on_this_tenants_office_row_only(self):
        node = self.nodes["Save the narrative"]
        self.assertEqual(node["parameters"]["dataTableId"]["value"], "offices")
        self.assertEqual((node["parameters"]["operation"], node["parameters"]["matchType"]), ("update", "allConditions"))
        self.assertEqual(conditions_of(node), {k: from_node("Config", k) for k in ("office_id", "manager_id")})
        self.assertEqual(set(node["parameters"]["columns"]["value"]), {"narrative", "narrative_at", "narrative_revision"})

    def test_rebuild_is_called_and_awaited(self):
        node = self.nodes["Rebuild the point"]
        self.assertEqual(target_of(node), REBUILD)
        self.assertTrue(node["parameters"]["options"]["waitForSubWorkflow"])


class ProcessTest(unittest.TestCase):
    def setUp(self):
        self.workflow = BUILT["02-process.json"]
        self.nodes = nodes_of(self.workflow)
        self.edges = edges_of(self.workflow)

    def test_happy_path_runs_through_every_stage(self):
        path = ["When Executed by Another Workflow", "Config", "Show the point as received", "Read the PDF from the row",
                "Prepare the vision request", "Pull the text out of the PDF", "Coarse read with regex",
                "Update the row: stage 1", "Show the rough view", "Ask the vision model to read the PDF",
                "Validate the fields", "Update the row: stage 2", "Show the sharp view", "Write the summary if ready"]
        self.assertEqual(len(steps_of(self.workflow)), 15)
        for a, b in zip(path, path[1:]):
            self.assertIn((a, 0, b), self.edges)

    def test_every_failure_lands_in_stage_minus_one_and_still_rebuilds(self):
        failing = ["Read the PDF from the row", "Prepare the vision request", "Pull the text out of the PDF",
                   "Ask the vision model to read the PDF", "Validate the fields"]
        for name in failing:
            with self.subTest(name):
                self.assertEqual(self.nodes[name]["onError"], "continueErrorOutput")
                self.assertIn((name, 1, "Update the row: stage -1"), self.edges)
        self.assertIn(("Update the row: stage -1", 0, "Show the sharp view"), self.edges)

    def test_document_updates_match_document_and_tenant(self):
        for name, stage in (("Update the row: stage 1", 1), ("Update the row: stage 2", 2), ("Update the row: stage -1", -1)):
            with self.subTest(name):
                node = self.nodes[name]
                self.assertEqual((node["parameters"]["operation"], node["parameters"]["dataTableId"]["value"]), ("update", "documents"))
                self.assertEqual(conditions_of(node), {k: from_node("Config", k) for k in ("document_id", "office_id", "manager_id")})
                self.assertEqual(node["parameters"]["columns"]["value"]["stage"], f"={{{{ {stage} }}}}")

    def test_vision_request_is_the_gate_tested_one_and_nothing_is_downloaded(self):
        self.assertEqual(injected(self.nodes["Prepare the vision request"], "VISION_REQUEST_TEMPLATE"), extraction_body(b"", "", ""))
        ask = self.nodes["Ask the vision model to read the PDF"]
        self.assertEqual(ask["credentials"], {"httpHeaderAuth": {"name": "OpenRouter bearer"}})
        self.assertTrue(ask["retryOnFail"])
        self.assertNotIn("raw.githubusercontent.com", json.dumps(self.workflow))
        self.assertEqual(injected(self.nodes["Validate the fields"], "OFFICES"), OFFICES)

    def test_sub_workflows(self):
        targets = {name: target_of(self.nodes[name])
                   for name in ("Show the point as received", "Show the rough view", "Show the sharp view", "Write the summary if ready")}
        self.assertEqual(targets, {"Show the point as received": REBUILD, "Show the rough view": REBUILD,
                                   "Show the sharp view": REBUILD, "Write the summary if ready": SUMMARY})


class RecordTest(unittest.TestCase):
    def setUp(self):
        self.workflow = BUILT["01b-record-a-document.json"]
        self.nodes = nodes_of(self.workflow)
        self.edges = edges_of(self.workflow)

    def test_both_inputs_meet_in_one_validation_before_the_hash(self):
        self.assertEqual(edges_of(self.workflow) & {(a, 0, b) for a, b in (
            ("When Executed by Another Workflow", "Validate the submission"), ("Validate the submission", "Hash the PDF"),
            ("Hash the PDF", "Seen this PDF before?"), ("Seen this PDF before?", "Build the rows"),
            ("Build the rows", "Is it a duplicate?"))}, {(a, 0, b) for a, b in (
            ("When Executed by Another Workflow", "Validate the submission"), ("Validate the submission", "Hash the PDF"),
            ("Hash the PDF", "Seen this PDF before?"), ("Seen this PDF before?", "Build the rows"),
            ("Build the rows", "Is it a duplicate?"))})
        self.assertEqual(self.nodes["Hash the PDF"]["parameters"]["value"], "={{ $json.pdf_base64 }}")

    def test_the_hash_is_checked_per_manager_and_office_against_documents_only(self):
        lookup = self.nodes["Seen this PDF before?"]
        self.assertEqual(conditions_of(lookup), {
            "pdf_hash": from_node("Hash the PDF", "pdf_hash"),
            "office_id": from_node("Validate the submission", "office_id"),
            "manager_id": from_node("Validate the submission", "manager_id"),
            "kind": "document",
        })
        self.assertTrue(lookup["alwaysOutputData"] and lookup["executeOnce"])

    def test_a_duplicate_is_recorded_and_rebuilt_but_never_processed(self):
        path = ["Append the duplicate row", "Rebuild the office", "Answer: duplicate"]
        self.assertIn(("Is it a duplicate?", 0, path[0]), self.edges)
        for a, b in zip(path, path[1:]):
            self.assertIn((a, 0, b), self.edges)
        self.assertEqual(target_of(self.nodes["Rebuild the office"]), REBUILD)

    def test_a_new_document_upserts_its_office_appends_its_row_and_processes_in_the_background(self):
        path = ["Upsert the office row", "Append the document row", "Process in the background", "Answer: received"]
        self.assertIn(("Is it a duplicate?", 1, path[0]), self.edges)
        for a, b in zip(path, path[1:]):
            self.assertIn((a, 0, b), self.edges)
        process = self.nodes["Process in the background"]
        self.assertEqual(target_of(process), PROCESS)
        self.assertFalse(process["parameters"]["options"]["waitForSubWorkflow"])
        office = self.nodes["Upsert the office row"]["parameters"]
        self.assertEqual(office["operation"], "upsert")
        self.assertEqual(set(office["columns"]["value"]), {"office_id", "manager_id", "name"})

    def test_rows_carry_every_documents_column_including_the_pdf(self):
        columns = {"document_id", "kind", "duplicate_of", "office_id", "manager_id", "worker_id", "pdf_hash", "filename",
                   "text", "stage", "regex_fields", "llm_fields", "error", "received_at", "pdf_base64"}
        for name in ("Append the duplicate row", "Append the document row"):
            with self.subTest(name):
                self.assertEqual(set(self.nodes[name]["parameters"]["columns"]["value"]), columns)

    def test_answers(self):
        for name, status in (("Answer: duplicate", "duplicate"), ("Answer: received", "received")):
            values = {a["name"]: a["value"] for a in self.nodes[name]["parameters"]["assignments"]["assignments"]}
            self.assertEqual(values["status"], status)
            self.assertTrue({"document_id", "filename", "office_id", "manager_id"} <= set(values))
        self.assertIn("duplicate_of", {a["name"] for a in self.nodes["Answer: duplicate"]["parameters"]["assignments"]["assignments"]})


class IngestTest(unittest.TestCase):
    def setUp(self):
        self.workflow = BUILT["01-ingest.json"]
        self.nodes = nodes_of(self.workflow)
        self.edges = edges_of(self.workflow)

    def test_form_offers_the_booth_pool_in_one_dropdown(self):
        (field,) = self.nodes["Pick a document"]["parameters"]["formFields"]["values"]
        self.assertEqual([o["option"] for o in field["fieldOptions"]["values"]], POOL)
        self.assertTrue(field["requiredField"])

    def test_form_hands_the_file_to_01b_and_shows_its_answer(self):
        order = ["Pick a document", "Name the file", "Record the document", "Is it a duplicate?"]
        for a, b in zip(order, order[1:]):
            self.assertIn((a, 0, b), self.edges)
        self.assertEqual(target_of(self.nodes["Record the document"]), RECORD)
        self.assertIn(("Is it a duplicate?", 0, "Say it is a duplicate"), self.edges)
        self.assertIn(("Is it a duplicate?", 1, "Say it was received"), self.edges)
        self.assertLessEqual(len(steps_of(self.workflow)), 6)


class DashboardWritesTest(unittest.TestCase):
    def setUp(self):
        self.workflow = BUILT["05-dashboard-writes.json"]
        self.nodes = nodes_of(self.workflow)
        self.edges = edges_of(self.workflow)

    def test_send_records_the_file_and_answers_with_its_json(self):
        self.assertEqual((self.nodes["Send a document"]["parameters"]["httpMethod"], self.nodes["Send a document"]["parameters"]["path"]),
                         ("POST", "send"))
        for a, b in (("Send a document", "Name the file"), ("Name the file", "Record the document"),
                     ("Record the document", "Answer with the result")):
            self.assertIn((a, 0, b), self.edges)
        self.assertEqual(self.nodes["Send a document"]["parameters"]["responseMode"], "responseNode")
        self.assertEqual(self.nodes["Answer with the result"]["parameters"]["respondWith"], "firstIncomingItem")

    def test_stop_sets_running_false(self):
        self.assertEqual(self.nodes["Stop the day"]["parameters"]["path"], "day/stop")
        switch = self.nodes["Set running to false"]["parameters"]
        self.assertEqual((switch["operation"], switch["dataTableId"]["value"]), ("upsert", "simulation"))
        self.assertEqual(switch["columns"]["value"], {"name": "day", "running": "={{ false }}"})
        self.assertIn(("Set running to false", 0, "Answer stopped"), self.edges)


class WorkingDayTest(unittest.TestCase):
    def setUp(self):
        self.workflow = BUILT["00-working-day.json"]
        self.nodes = nodes_of(self.workflow)
        self.edges = edges_of(self.workflow)

    def test_starts_at_once_and_sets_running(self):
        start = self.nodes["Start the day"]["parameters"]
        self.assertEqual((start["path"], start["responseMode"]), ("day/start", "onReceived"))
        for a, b in (("Start the day", "Config"), ("Config", "Set running to true"), ("Set running to true", "Plan the day"),
                     ("Plan the day", "Loop over slots")):
            self.assertIn((a, 0, b), self.edges)
        self.assertEqual(self.nodes["Set running to true"]["parameters"]["columns"]["value"]["running"], "={{ true }}")

    def test_each_slot_checks_running_first_and_a_stop_ends_in_reconcile(self):
        self.assertIn(("Loop over slots", 1, "Is the day still running?"), self.edges)
        self.assertIn(("Is the day still running?", 0, "Still running?"), self.edges)
        self.assertIn(("Still running?", 0, "Read the issued documents"), self.edges)
        self.assertIn(("Still running?", 1, "Reconcile the offices"), self.edges)
        self.assertIn(("Loop over slots", 0, "Reconcile the offices"), self.edges)
        self.assertEqual(conditions_of(self.nodes["Is the day still running?"]), {"name": "day"})
        reconcile = self.nodes["Reconcile the offices"]
        self.assertEqual(target_of(reconcile), RECONCILE)
        self.assertFalse(reconcile["parameters"]["options"]["waitForSubWorkflow"])

    def test_a_slot_issues_records_logs_and_waits(self):
        path = ["Read the issued documents", "Prepare the worker request", "Ask the worker model", "Issue the document",
                "Record the document", "Log it in issued", "Wait between documents", "Loop over slots"]
        for a, b in zip(path, path[1:]):
            self.assertIn((a, 0, b), self.edges)
        wait = self.nodes["Wait between documents"]["parameters"]
        self.assertEqual(wait, {"resume": "timeInterval", "amount": DAY_SLOT_SECONDS, "unit": "seconds"})
        self.assertEqual(self.nodes["Log it in issued"]["parameters"]["dataTableId"]["value"], "issued")
        self.assertEqual(self.nodes["Ask the worker model"]["credentials"], {"httpHeaderAuth": {"name": "OpenRouter bearer"}})

    def test_a_rejected_event_or_failed_call_skips_to_the_wait_without_stopping(self):
        for name in ("Ask the worker model", "Issue the document"):
            with self.subTest(name):
                self.assertEqual(self.nodes[name]["onError"], "continueErrorOutput")
                self.assertIn((name, 1, "Wait between documents"), self.edges)
        self.assertEqual(self.nodes["Record the document"]["onError"], "continueRegularOutput")

    def test_the_issued_log_gets_every_ground_truth_column(self):
        columns = self.nodes["Log it in issued"]["parameters"]["columns"]["value"]
        self.assertEqual(set(columns), {"issued_id", "office_id", "manager_id", "worker_id", "doc_type", "doc_key", "version",
                                        "date", "counterparty", "category", "amount", "description_de", "description_en",
                                        "resend_of", "filename", "issued_at"})
        self.assertEqual(columns["doc_key"], from_node("Issue the document", "issued.doc_key"))


class ReconcileTest(unittest.TestCase):
    def test_every_five_minutes_and_callable_rebuilding_each_office(self):
        workflow = BUILT["06-reconcile.json"]
        nodes, edges = nodes_of(workflow), edges_of(workflow)
        self.assertEqual(nodes["Every 5 minutes"]["parameters"]["rule"], {"interval": [{"field": "minutes", "minutesInterval": 5}]})
        self.assertIn(("Every 5 minutes", 0, "List the offices"), edges)
        self.assertIn(("When Executed by Another Workflow", 0, "List the offices"), edges)
        rebuild = nodes["Rebuild each office"]["parameters"]
        self.assertEqual((rebuild["workflowId"]["cachedResultName"], rebuild["mode"]), (REBUILD, "each"))
        self.assertIn(("List the offices", 0, "Rebuild each office"), edges)


class MaintenanceTest(unittest.TestCase):
    def setUp(self):
        self.workflow = BUILT["07-maintenance.json"]
        self.nodes = nodes_of(self.workflow)
        self.edges = edges_of(self.workflow)

    def test_reset_stops_the_day_clears_three_tables_answers_and_rebuilds_empty_offices(self):
        path = ["Reset", "Stop the day", "Clear the documents", "Clear the offices", "Clear the issued log", "Answer reset",
                "Rebuild the empty offices"]
        for a, b in zip(path, path[1:]):
            self.assertIn((a, 0, b), self.edges)
        for name, table in (("Clear the documents", "documents"), ("Clear the offices", "offices"), ("Clear the issued log", "issued")):
            node = self.nodes[name]
            self.assertEqual((node["parameters"]["resource"], node["parameters"]["operation"],
                              node["parameters"]["dataTableId"]["value"]), ("table", "clear", table))
            self.assertTrue(node["alwaysOutputData"])
        self.assertEqual(target_of(self.nodes["Rebuild the empty offices"]), RECONCILE)

    def test_issued_returns_every_issued_row(self):
        self.assertEqual((self.nodes["Issued"]["parameters"]["httpMethod"], self.nodes["Issued"]["parameters"]["path"]), ("GET", "issued"))
        read = self.nodes["Read the issued log"]
        self.assertEqual((read["parameters"]["dataTableId"]["value"], conditions_of(read), read["parameters"]["returnAll"]),
                         ("issued", {}, True))
        self.assertIn(("Read the issued log", 0, "Answer with the issued rows"), self.edges)
        self.assertEqual(self.nodes["Answer with the issued rows"]["parameters"]["respondWith"], "allIncomingItems")


if __name__ == "__main__":
    unittest.main()
