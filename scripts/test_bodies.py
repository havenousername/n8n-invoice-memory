import json
import tempfile
import unittest
from pathlib import Path

from bodies import ask_batch, main, office_list, office_scroll, reference_cases, upsert

NOW = "2026-10-14T00:00:00Z"
ANNA = {"must": [{"key": "manager_id", "match": {"value": "m_anna"}}]}
ASK_PAYLOAD = ["office_id", "name", "documents", "summary_text", "summary_stage"]

# Spec section 4, the fused search of the Ask request: three lenses as prefetches, RRF, then freshness decay.
FUSED = {
    "shard_key": "m_anna",
    "prefetch": {
        "prefetch": [
            {"query": {"nearest": {"text": "PO-1042", "model": "qdrant/bm25"}},
             "using": "bm25", "limit": 20, "filter": ANNA},
            {"query": {"nearest": {"text": "PO-1042", "model": "answerdotai/answerai-colbert-small-v1"}},
             "using": "digest", "limit": 20, "filter": ANNA},
            {"query": {"nearest": {"text": "PO-1042", "model": "sentence-transformers/all-minilm-l6-v2"}},
             "using": "summary", "limit": 20, "filter": ANNA},
        ],
        "query": {"rrf": {}},
        "limit": 20,
    },
    "query": {"formula": {"sum": ["$score", {"mult": [0.1,
        {"exp_decay": {"x": {"datetime_key": "updated_at"},
                       "target": {"datetime": NOW},
                       "scale": 2592000, "midpoint": 0.5}}]}]}},
    "filter": ANNA,
    "limit": 5,
    "with_payload": ASK_PAYLOAD,
}

TENANT = {"key": "manager_id", "match": {"value": "m_ben"}}
OVER = {"nested": {"key": "lines", "filter": {"must": [{"key": "over_by", "range": {"gt": 1000}}]}}}


class AskBatchTest(unittest.TestCase):
    def test_four_searches_keyword_line_meaning_fused(self):
        keyword, line, meaning, fused = ask_batch("m_anna", "PO-1042", NOW)["searches"]
        self.assertEqual(fused, FUSED)
        for search, using, model in ((keyword, "bm25", "qdrant/bm25"),
                                     (line, "digest", "answerdotai/answerai-colbert-small-v1"),
                                     (meaning, "summary", "sentence-transformers/all-minilm-l6-v2")):
            with self.subTest(using):
                self.assertEqual(search, {
                    "shard_key": "m_anna",
                    "query": {"nearest": {"text": "PO-1042", "model": model}},
                    "using": using, "filter": ANNA, "limit": 5, "with_payload": ASK_PAYLOAD,
                })

    def test_over_plan_threshold_narrows_every_search_and_prefetch(self):
        searches = ask_batch("m_anna", "travel", NOW, over_gt=1000)["searches"]
        for search in searches:
            self.assertIn(OVER, search["filter"]["must"])
        for prefetch in searches[3]["prefetch"]["prefetch"]:
            self.assertIn(OVER, prefetch["filter"]["must"])


class TenantScopeTest(unittest.TestCase):
    def test_every_filtered_body_is_sharded_and_filtered_by_manager(self):
        bodies = {
            "office_list": office_list("m_ben", over_gt=5),
            "office_scroll": office_scroll("m_ben", "berlin"),
            **{f"ask {i}": s for i, s in enumerate(ask_batch("m_ben", "x", NOW)["searches"])},
        }
        for name, body in bodies.items():
            with self.subTest(name):
                self.assertEqual(body["shard_key"], "m_ben")
                self.assertIn(TENANT, body["filter"]["must"])
        for prefetch in bodies["ask 3"]["prefetch"]["prefetch"]:
            self.assertIn(TENANT, prefetch["filter"]["must"])


class ScrollTest(unittest.TestCase):
    def test_office_list_newest_first_without_threshold(self):
        self.assertEqual(office_list("m_anna"), {
            "shard_key": "m_anna", "limit": 50, "with_payload": True,
            "order_by": {"key": "updated_at", "direction": "desc"}, "filter": ANNA,
        })

    def test_over_plan_is_a_nested_condition_on_lines(self):
        self.assertEqual(office_list("m_anna", over_gt=1000)["filter"]["must"][-1], OVER)

    def test_zero_is_a_real_threshold(self):
        self.assertEqual(len(office_list("m_anna", over_gt=0)["filter"]["must"]), 2)

    def test_office_scroll_finds_one_point_with_full_payload(self):
        body = office_scroll("m_anna", "berlin")
        self.assertIn({"key": "office_id", "match": {"value": "berlin"}}, body["filter"]["must"])
        self.assertEqual((body["limit"], body["with_payload"]), (1, True))


class UpsertTest(unittest.TestCase):
    def test_one_point_with_three_inference_vectors(self):
        texts = {"summary": "s", "digest": "d", "bm25": "b"}
        body = upsert("m_anna", "11111111-1111-4111-8111-111111111111", {"office_id": "berlin"}, texts)
        self.assertEqual(body["shard_key"], "m_anna")
        (point,) = body["points"]
        self.assertEqual(point["payload"], {"office_id": "berlin"})
        self.assertEqual(point["vector"], {
            "summary": {"text": "s", "model": "sentence-transformers/all-minilm-l6-v2"},
            "digest": {"text": "d", "model": "answerdotai/answerai-colbert-small-v1"},
            "bm25": {"text": "b", "model": "qdrant/bm25"},
        })


class ReferenceJsonTest(unittest.TestCase):
    def test_cases_cover_each_dashboard_body_with_its_arguments(self):
        cases = reference_cases()
        self.assertEqual(set(cases), {"office_list", "office_scroll", "ask_batch"})
        for name, fn in (("office_list", office_list), ("office_scroll", office_scroll), ("ask_batch", ask_batch)):
            for case in cases[name]:
                self.assertEqual(case["body"], fn(*case["args"]))
        self.assertIn(["m_anna", 1000, 50], [c["args"] for c in cases["office_list"]])

    def test_json_flag_writes_the_cases(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "lib" / "reference-bodies.json"
            self.assertEqual(main(["--json", str(out)]), 0)
            self.assertEqual(json.loads(out.read_text()), reference_cases())


if __name__ == "__main__":
    unittest.main()
