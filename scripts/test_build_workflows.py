import json
import unittest

from build_workflows import (
    QDRANT_URL_PLACEHOLDER, SAMPLES_BASE_URL, WORKERS, WORKFLOW_FILES, WORKFLOWS_DIR, build_all, pasted, read_parts,
)
from openrouter_check import extraction_body
from schema import MODELS

PARTS = read_parts()
BUILT = build_all(PARTS)
STICKY = "n8n-nodes-base.stickyNote"
EXECUTE = "n8n-nodes-base.executeWorkflow"
# Nodes whose output item carries customer_id and manager_id, so a sub-workflow can be called right after them.
IDS_PROVIDERS = {"Config", "Update the row: stage 1", "Update the row: stage 2", "Update the row: stage -1",
                 "Show the sharp view", "Save the narrative", "Append the invoice row"}


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


class PastedTest(unittest.TestCase):
    def test_drops_only_the_module_exports_line(self):
        self.assertEqual(pasted("function f() {}\n\nmodule.exports = { f };\n"), "function f() {}\n\n")


class EveryWorkflowTest(unittest.TestCase):
    def test_the_four_workflows_are_built(self):
        self.assertEqual(set(BUILT), {"01-ingest.json", "02-process.json", "02b-narrative.json", "03-rebuild-point.json"})
        self.assertEqual(set(BUILT), set(WORKFLOW_FILES))

    def test_canvas_limits_and_unique_names(self):
        for file, workflow in BUILT.items():
            with self.subTest(file):
                self.assertLessEqual(len(steps_of(workflow)), 15)
                self.assertLessEqual(sum(n["type"] == STICKY for n in workflow["nodes"]), 4)
                self.assertEqual(len({n["name"] for n in workflow["nodes"]}), len(workflow["nodes"]))
                self.assertEqual(len({n["id"] for n in workflow["nodes"]}), len(workflow["nodes"]))

    def test_connections_point_at_real_nodes(self):
        for file, workflow in BUILT.items():
            names = set(nodes_of(workflow))
            for source, _, target in edges_of(workflow):
                with self.subTest(file=file, edge=(source, target)):
                    self.assertIn(source, names)
                    self.assertIn(target, names)

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

    def test_sub_workflows_accept_the_callers_item_and_name_what_they_need(self):
        for file in ("02-process.json", "02b-narrative.json", "03-rebuild-point.json"):
            with self.subTest(file):
                trigger = nodes_of(BUILT[file])["When Executed by Another Workflow"]
                self.assertEqual(trigger["parameters"], {"inputSource": "passthrough"})
                self.assertIn("customer_id and manager_id", trigger["notes"])
                self.assertTrue(trigger["notesInFlow"])

    def test_calls_carry_no_input_mapping_for_the_editor_to_reset(self):
        for file, workflow in BUILT.items():
            feeds = {target: source for source, _, target in edges_of(workflow)}
            for node in workflow["nodes"]:
                if node["type"] == EXECUTE:
                    with self.subTest(file=file, node=node["name"]):
                        self.assertNotIn("workflowInputs", node["parameters"])
                        self.assertEqual(node["parameters"]["workflowId"]["value"], "")
                        self.assertIn(feeds[node["name"]], IDS_PROVIDERS)

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


class RebuildPointTest(unittest.TestCase):
    def setUp(self):
        self.workflow = BUILT["03-rebuild-point.json"]
        self.nodes = nodes_of(self.workflow)

    def test_nodes_are_chained_in_order(self):
        order = ["When Executed by Another Workflow", "Config", "Hash the point id", "Load the customer row",
                 "Load all invoice rows", "Compute the view", "Upsert the point with inference", "Return what was rebuilt"]
        self.assertEqual(steps_of(self.workflow), order)
        self.assertEqual(edges_of(self.workflow), {(a, 0, b) for a, b in zip(order, order[1:])})

    def test_pinned_input_for_manual_runs(self):
        self.assertEqual(self.workflow["pinData"]["When Executed by Another Workflow"],
                         [{"json": {"customer_id": "acme", "manager_id": "m_anna"}}])

    def test_returns_the_ids_it_rebuilt(self):
        node = self.nodes["Return what was rebuilt"]
        self.assertFalse(node["parameters"]["includeOtherFields"])
        values = {a["name"]: a["value"] for a in node["parameters"]["assignments"]["assignments"]}
        self.assertEqual(values, {
            "customer_id": from_node("Config", "customer_id"),
            "manager_id": from_node("Config", "manager_id"),
            "point_id": from_node("Compute the view", "body.points[0].id"),
        })

    def test_data_table_reads_are_tenant_scoped_and_run_once(self):
        for name, table in (("Load the customer row", "customers"), ("Load all invoice rows", "invoices")):
            with self.subTest(name):
                node = self.nodes[name]
                self.assertEqual(node["parameters"]["dataTableId"], {"__rl": True, "mode": "name", "value": table})
                self.assertEqual(node["parameters"]["matchType"], "allConditions")
                self.assertEqual(conditions_of(node), {k: from_node("Config", k) for k in ("customer_id", "manager_id")})
                self.assertTrue(node["alwaysOutputData"] and node["executeOnce"])

    def test_code_node_pastes_sources_and_glue(self):
        js = self.nodes["Compute the view"]["parameters"]["jsCode"]
        self.assertTrue(js.startswith(pasted(PARTS.sources["ids"]) + pasted(PARTS.sources["view"])))
        self.assertTrue(js.endswith(PARTS.glue["compute-the-view"]))
        for model in MODELS.values():
            self.assertIn(model, js)

    def test_upsert_uses_the_named_credential(self):
        node = self.nodes["Upsert the point with inference"]
        self.assertTrue(node["parameters"]["url"].endswith("/points?wait=true"))
        self.assertEqual(node["credentials"], {"httpHeaderAuth": {"name": "Qdrant api-key"}})


class NarrativeTest(unittest.TestCase):
    def setUp(self):
        self.workflow = BUILT["02b-narrative.json"]
        self.nodes = nodes_of(self.workflow)

    def test_ten_nodes_in_a_chain(self):
        order = ["When Executed by Another Workflow", "Config", "Hash the point id", "Format the point id",
                 "Read the point", "Prepare the narrative snapshot", "Ask for three sentences",
                 "Keep only the narrative", "Save the narrative", "Rebuild the point"]
        self.assertEqual(steps_of(self.workflow), order)
        self.assertEqual(edges_of(self.workflow), {(a, 0, b) for a, b in zip(order, order[1:])})

    def test_credentials(self):
        self.assertEqual(self.nodes["Read the point"]["credentials"], {"httpHeaderAuth": {"name": "Qdrant api-key"}})
        self.assertEqual(self.nodes["Ask for three sentences"]["credentials"], {"httpHeaderAuth": {"name": "OpenRouter bearer"}})

    def test_narrative_is_saved_for_this_tenant_only(self):
        node = self.nodes["Save the narrative"]
        self.assertEqual((node["parameters"]["operation"], node["parameters"]["matchType"]), ("update", "allConditions"))
        self.assertEqual(conditions_of(node), {k: from_node("Config", k) for k in ("customer_id", "manager_id")})
        self.assertEqual(set(node["parameters"]["columns"]["value"]), {"narrative", "narrative_at", "narrative_revision"})

    def test_rebuild_is_called_and_awaited(self):
        node = self.nodes["Rebuild the point"]
        self.assertEqual(node["parameters"]["workflowId"]["cachedResultName"], "03 Rebuild point")
        self.assertTrue(node["parameters"]["options"]["waitForSubWorkflow"])


class ProcessTest(unittest.TestCase):
    def setUp(self):
        self.workflow = BUILT["02-process.json"]
        self.nodes = nodes_of(self.workflow)
        self.edges = edges_of(self.workflow)

    def test_fifteen_nodes(self):
        self.assertEqual(len(steps_of(self.workflow)), 15)

    def test_happy_path_runs_through_every_stage(self):
        path = ["When Executed by Another Workflow", "Config", "Show the point as received", "Download the PDF for processing",
                "Prepare the vision request", "Pull the text out of the PDF", "Coarse read with regex",
                "Update the row: stage 1", "Show the coarse view", "Ask the vision model to read the PDF",
                "Validate the fields", "Update the row: stage 2", "Show the sharp view", "Write the narrative if ready"]
        for a, b in zip(path, path[1:]):
            self.assertIn((a, 0, b), self.edges)

    def test_every_failure_lands_in_stage_minus_one_and_still_rebuilds(self):
        failing = ["Download the PDF for processing", "Prepare the vision request", "Pull the text out of the PDF",
                   "Ask the vision model to read the PDF", "Validate the fields"]
        for name in failing:
            with self.subTest(name):
                self.assertEqual(self.nodes[name]["onError"], "continueErrorOutput")
                self.assertIn((name, 1, "Update the row: stage -1"), self.edges)
        self.assertIn(("Update the row: stage -1", 0, "Show the sharp view"), self.edges)

    def test_invoice_updates_match_invoice_and_tenant(self):
        for name, stage in (("Update the row: stage 1", 1), ("Update the row: stage 2", 2), ("Update the row: stage -1", -1)):
            with self.subTest(name):
                node = self.nodes[name]
                self.assertEqual(node["parameters"]["operation"], "update")
                self.assertEqual(conditions_of(node), {k: from_node("Config", k) for k in ("invoice_id", "customer_id", "manager_id")})
                self.assertEqual(node["parameters"]["columns"]["value"]["stage"], f"={{{{ {stage} }}}}")

    def test_vision_request_is_the_gate_tested_one(self):
        js = self.nodes["Prepare the vision request"]["parameters"]["jsCode"]
        template = extraction_body(b"", "", "")
        self.assertTrue(js.startswith(f"const VISION_REQUEST_TEMPLATE = {json.dumps(template)};\n"))
        ask = self.nodes["Ask the vision model to read the PDF"]
        self.assertEqual(ask["credentials"], {"httpHeaderAuth": {"name": "OpenRouter bearer"}})
        self.assertEqual(ask["parameters"]["jsonBody"], "={{ JSON.stringify($('Prepare the vision request').first().json.body) }}")
        self.assertTrue(ask["retryOnFail"])

    def test_sub_workflows(self):
        targets = {name: self.nodes[name]["parameters"]["workflowId"]["cachedResultName"]
                   for name in ("Show the point as received", "Show the coarse view", "Show the sharp view", "Write the narrative if ready")}
        self.assertEqual(set(targets.values()), {"03 Rebuild point", "02b Write the narrative"})
        self.assertEqual(targets["Write the narrative if ready"], "02b Write the narrative")

    def test_download_only_from_the_sample_base(self):
        url = self.nodes["Download the PDF for processing"]["parameters"]["url"]
        self.assertEqual(url, "={{ $('Config').first().json.SAMPLES_BASE_URL }}/"
                              "{{ encodeURIComponent($('Config').first().json.filename) }}")
        self.assertNotIn("sample_url", json.dumps(self.workflow))
        self.assertEqual(self.workflow["pinData"]["When Executed by Another Workflow"][0]["json"]["filename"], "acme-001.pdf")


class IngestTest(unittest.TestCase):
    def setUp(self):
        self.workflow = BUILT["01-ingest.json"]
        self.nodes = nodes_of(self.workflow)
        self.edges = edges_of(self.workflow)

    def test_form_offers_the_manifest_samples_and_the_workers(self):
        fields = self.nodes["Pick an invoice"]["parameters"]["formFields"]["values"]
        options = {f["fieldLabel"]: [o["option"] for o in f["fieldOptions"]["values"]] for f in fields}
        self.assertEqual(options["Invoice"], [r["file"] for r in PARTS.manifest])
        self.assertEqual(options["Worker"], [w["name"] for w in WORKERS.values()])
        self.assertTrue(all(f["requiredField"] for f in fields))

    def test_config_carries_the_allowlist_names_and_workers(self):
        values = {a["name"]: a["value"] for a in self.nodes["Config"]["parameters"]["assignments"]["assignments"]}
        self.assertEqual(values["SAMPLES_BASE_URL"], SAMPLES_BASE_URL)
        self.assertEqual(json.loads(values["SAMPLES"]), [r["file"] for r in PARTS.manifest])
        self.assertEqual(json.loads(values["CUSTOMER_NAMES"]), {r["customer"]: r["customer_name"] for r in PARTS.manifest})
        self.assertEqual(json.loads(values["WORKERS"]), WORKERS)

    def test_validation_comes_before_the_download(self):
        self.assertIn(("Config", 0, "Validate the submission"), self.edges)
        self.assertIn(("Validate the submission", 0, "Download the chosen sample"), self.edges)

    def test_duplicates_branch_to_their_own_ending(self):
        self.assertIn(("Is it a duplicate?", 0, "Say it is a duplicate"), self.edges)
        self.assertIn(("Is it a duplicate?", 1, "Load the existing customer"), self.edges)
        lookup = self.nodes["Seen this hash before?"]
        self.assertEqual(conditions_of(lookup), {
            "pdf_hash": from_node("Hash the PDF", "pdf_hash"),
            "customer_id": from_node("Validate the submission", "customer_id"),
            "manager_id": from_node("Validate the submission", "manager_id"),
        })

    def test_new_invoice_path(self):
        path = ["Load the existing customer", "Decide the rows", "Upsert the customer row", "Append the invoice row",
                "Process in the background", "Say it was received"]
        for a, b in zip(path, path[1:]):
            self.assertIn((a, 0, b), self.edges)

    def test_customer_upsert_writes_only_identity_columns(self):
        node = self.nodes["Upsert the customer row"]
        self.assertEqual(node["parameters"]["operation"], "upsert")
        self.assertEqual(set(node["parameters"]["columns"]["value"]), {"customer_id", "manager_id", "worker_id", "name"})

    def test_processing_runs_in_the_background(self):
        node = self.nodes["Process in the background"]
        self.assertEqual(node["parameters"]["workflowId"]["cachedResultName"], "02 Process")
        self.assertFalse(node["parameters"]["options"]["waitForSubWorkflow"])
        self.assertIn(("Append the invoice row", 0, "Process in the background"), self.edges)


if __name__ == "__main__":
    unittest.main()
