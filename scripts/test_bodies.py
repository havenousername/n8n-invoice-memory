import unittest

from bodies import customer_scroll, hybrid_query, live_scroll, purge, removed_scroll, upsert

ANNA_LIVE = {"must": [{"key": "manager_id", "match": {"value": "m_anna"}}, {"is_empty": {"key": "deleted_at"}}]}

# Spec section 11, the printed exhibit, with its `with_payload` swapped for the dashboard's field list.
SECTION_11 = {
    "shard_key": "m_anna",
    "prefetch": {
        "prefetch": [
            {"query": {"nearest": {"text": "servers", "model": "qdrant/bm25"}},
             "using": "bm25", "limit": 20, "filter": ANNA_LIVE},
            {"query": {"nearest": {"text": "servers", "model": "answerdotai/answerai-colbert-small-v1"}},
             "using": "digest", "limit": 20, "filter": ANNA_LIVE},
            {"query": {"nearest": {"text": "servers", "model": "sentence-transformers/all-minilm-l6-v2"}},
             "using": "summary", "limit": 20, "filter": ANNA_LIVE},
        ],
        "query": {"rrf": {}},
        "limit": 20,
    },
    "query": {"formula": {"sum": ["$score", {"mult": [0.1,
        {"exp_decay": {"x": {"datetime_key": "last_invoice_at"},
                       "target": {"datetime": "2026-10-14T00:00:00Z"},
                       "scale": 2592000, "midpoint": 0.5}}]}]}},
    "filter": ANNA_LIVE,
    "limit": 5,
    "with_payload": ["customer_id", "invoices"],
}

TENANT = {"key": "manager_id", "match": {"value": "m_ben"}}


class HybridQueryTest(unittest.TestCase):
    def test_matches_the_spec_exhibit(self):
        self.assertEqual(hybrid_query("m_anna", "servers", "2026-10-14T00:00:00Z"), SECTION_11)


class TenantScopeTest(unittest.TestCase):
    def test_every_filtered_body_is_sharded_and_filtered_by_manager(self):
        bodies = {
            "live_scroll": live_scroll("m_ben", overdue_gte=5),
            "removed_scroll": removed_scroll("m_ben"),
            "customer_scroll": customer_scroll("m_ben", "acme"),
            "hybrid_query": hybrid_query("m_ben", "x", "2026-10-14T00:00:00Z"),
            "purge": purge("m_ben", "acme", "2026-09-14T00:00:00Z"),
        }
        for name, body in bodies.items():
            with self.subTest(name):
                self.assertEqual(body["shard_key"], "m_ben")
                self.assertIn(TENANT, body["filter"]["must"])
        for prefetch in bodies["hybrid_query"]["prefetch"]["prefetch"]:
            self.assertIn(TENANT, prefetch["filter"]["must"])


class ScrollTest(unittest.TestCase):
    def test_live_scroll_without_threshold_has_no_nested_condition(self):
        body = live_scroll("m_anna")
        self.assertEqual(body["filter"], ANNA_LIVE)
        self.assertEqual(body["order_by"], {"key": "last_invoice_at", "direction": "desc"})
        self.assertEqual(body["limit"], 50)

    def test_zero_is_a_real_threshold(self):
        nested = live_scroll("m_anna", overdue_gte=0)["filter"]["must"][-1]
        self.assertEqual(nested, {"nested": {"key": "invoices", "filter": {"must": [
            {"key": "status", "match": {"value": "overdue"}},
            {"key": "amount", "range": {"gte": 0}},
        ]}}})

    def test_removed_scroll_inverts_the_deleted_condition(self):
        body = removed_scroll("m_anna")
        self.assertEqual(body["filter"]["must"], [{"key": "manager_id", "match": {"value": "m_anna"}}])
        self.assertEqual(body["filter"]["must_not"], [{"is_empty": {"key": "deleted_at"}}])

    def test_customer_scroll_finds_one_point_with_full_payload(self):
        body = customer_scroll("m_anna", "acme")
        self.assertIn({"key": "customer_id", "match": {"value": "acme"}}, body["filter"]["must"])
        self.assertEqual((body["limit"], body["with_payload"]), (1, True))


class PurgeTest(unittest.TestCase):
    def test_deletes_only_this_tenants_expired_customer(self):
        self.assertEqual(purge("m_anna", "acme", "2026-09-14T00:00:00Z"), {
            "shard_key": "m_anna",
            "filter": {"must": [
                {"key": "manager_id", "match": {"value": "m_anna"}},
                {"key": "customer_id", "match": {"value": "acme"}},
                {"key": "deleted_at", "range": {"lt": "2026-09-14T00:00:00Z"}},
            ]},
        })


class UpsertTest(unittest.TestCase):
    def test_one_point_with_three_inference_vectors(self):
        texts = {"summary": "s", "digest": "d", "bm25": "b"}
        body = upsert("m_anna", "11111111-1111-4111-8111-111111111111", {"customer_id": "acme"}, texts)
        self.assertEqual(body["shard_key"], "m_anna")
        (point,) = body["points"]
        self.assertEqual(point["payload"], {"customer_id": "acme"})
        self.assertEqual(point["vector"], {
            "summary": {"text": "s", "model": "sentence-transformers/all-minilm-l6-v2"},
            "digest": {"text": "d", "model": "answerdotai/answerai-colbert-small-v1"},
            "bm25": {"text": "b", "model": "qdrant/bm25"},
        })


if __name__ == "__main__":
    unittest.main()
