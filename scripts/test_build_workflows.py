import json
import unittest

from build_workflows import QDRANT_URL_PLACEHOLDER, WORKFLOWS_DIR, pasted, read_parts, rebuild_point
from schema import MODELS

NODE_ORDER = [
    "When Executed by Another Workflow", "Config", "Hash the point id", "Load the customer row",
    "Load all invoice rows", "Compute the view", "Upsert the point with inference",
]


class PastedTest(unittest.TestCase):
    def test_drops_only_the_module_exports_line(self):
        source = "function f() {}\n\nmodule.exports = { f };\n"
        self.assertEqual(pasted(source), "function f() {}\n\n")


class RebuildPointTest(unittest.TestCase):
    def setUp(self):
        self.workflow = rebuild_point(*read_parts())
        self.nodes = {n["name"]: n for n in self.workflow["nodes"]}

    def test_nodes_in_order_plus_one_sticky_note(self):
        steps = [n["name"] for n in self.workflow["nodes"] if n["type"] != "n8n-nodes-base.stickyNote"]
        self.assertEqual(steps, NODE_ORDER)
        notes = [n for n in self.workflow["nodes"] if n["type"] == "n8n-nodes-base.stickyNote"]
        self.assertEqual(len(notes), 1)
        self.assertEqual(len({n["id"] for n in self.workflow["nodes"]}), len(self.workflow["nodes"]))

    def test_nodes_are_chained_in_order(self):
        connections = self.workflow["connections"]
        for source, target in zip(NODE_ORDER, NODE_ORDER[1:]):
            self.assertEqual(connections[source], {"main": [[{"node": target, "type": "main", "index": 0}]]})
        self.assertNotIn(NODE_ORDER[-1], connections)

    def test_trigger_takes_exactly_the_two_ids(self):
        params = self.nodes["When Executed by Another Workflow"]["parameters"]
        self.assertEqual(params["inputSource"], "workflowInputs")
        self.assertEqual(params["workflowInputs"]["values"],
                         [{"name": "customer_id", "type": "string"}, {"name": "manager_id", "type": "string"}])
        self.assertEqual(self.workflow["pinData"]["When Executed by Another Workflow"],
                         [{"json": {"customer_id": "acme", "manager_id": "m_anna"}}])

    def test_data_table_reads_are_tenant_scoped_and_run_once(self):
        for name, table in (("Load the customer row", "customers"), ("Load all invoice rows", "invoices")):
            with self.subTest(name):
                node = self.nodes[name]
                params = node["parameters"]
                self.assertEqual(params["dataTableId"], {"__rl": True, "mode": "name", "value": table})
                self.assertEqual((params["operation"], params["matchType"], params["returnAll"]), ("get", "allConditions", True))
                keys = {c["keyName"]: c["keyValue"] for c in params["filters"]["conditions"]}
                self.assertEqual(keys, {
                    "customer_id": "={{ $('Config').first().json.customer_id }}",
                    "manager_id": "={{ $('Config').first().json.manager_id }}",
                })
                self.assertTrue(node["alwaysOutputData"])
                self.assertTrue(node["executeOnce"])

    def test_code_node_pastes_sources_and_glue(self):
        sources, glue = read_parts()
        js = self.nodes["Compute the view"]["parameters"]["jsCode"]
        self.assertIn(pasted(sources["ids"]), js)
        self.assertIn(pasted(sources["view"]), js)
        self.assertTrue(js.endswith(glue))
        self.assertNotRegex(js, r"(?m)^module\.exports")
        for model in MODELS.values():
            self.assertIn(model, js)

    def test_upsert_uses_the_named_credential_only(self):
        node = self.nodes["Upsert the point with inference"]
        self.assertEqual(node["parameters"]["method"], "PUT")
        self.assertTrue(node["parameters"]["url"].endswith("/points?wait=true"))
        self.assertEqual(node["credentials"], {"httpHeaderAuth": {"name": "Qdrant api-key"}})

    def test_only_the_placeholder_cluster_url(self):
        text = json.dumps(self.workflow)
        self.assertEqual(text.count("cloud.qdrant.io"), 1)
        self.assertIn(QDRANT_URL_PLACEHOLDER, text)

    def test_committed_file_matches_the_sources(self):
        committed = json.loads((WORKFLOWS_DIR / "03-rebuild-point.json").read_text())
        self.assertEqual(committed, self.workflow, "run python3 scripts/build_workflows.py")


if __name__ == "__main__":
    unittest.main()
