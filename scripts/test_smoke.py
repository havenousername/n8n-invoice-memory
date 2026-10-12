import re
import unittest
import uuid

from smoke import drop_smoke_collection, fixture_points, smoke_collection_name, within_plan

NOW = "2026-10-09T10:00:00Z"


class CollectionNameTest(unittest.TestCase):
    def test_name_has_prefix_timestamp_and_suffix(self):
        name = smoke_collection_name(NOW, "4242")
        self.assertEqual(name, "invoice_memory_smoke_20261009100000_4242")
        self.assertRegex(name, r"^invoice_memory_smoke_\d{14}_\w+$")


class DropGuardTest(unittest.TestCase):
    def test_refuses_production_and_unprefixed_names_without_calling_qdrant(self):
        calls = []
        for name in ("customers", "beir-quora", "smoke_customers"):
            with self.subTest(name), self.assertRaises(ValueError):
                drop_smoke_collection(lambda *args: calls.append(args), name)
        self.assertEqual(calls, [])

    def test_deletes_a_smoke_collection(self):
        calls = []
        drop_smoke_collection(lambda *args: calls.append(args), "invoice_memory_smoke_20261009100000_1")
        self.assertEqual(calls, [("DELETE", "/collections/invoice_memory_smoke_20261009100000_1")])


class FixtureTest(unittest.TestCase):
    def test_ids_are_distinct_fixed_uuids(self):
        ids = [f.point_id for f in fixture_points(NOW)]
        self.assertEqual(len(set(ids)), 3)
        self.assertEqual(ids, [f.point_id for f in fixture_points("2027-01-01T00:00:00Z")])
        for point_id in ids:
            self.assertEqual(str(uuid.UUID(point_id)), point_id)

    def test_tenants_and_offices(self):
        self.assertEqual(
            [(f.manager, f.payload["office_id"]) for f in fixture_points(NOW)],
            [("m_anna", "berlin"), ("m_anna", "vienna"), ("m_ben", "berlin")],
        )

    def test_only_annas_berlin_is_over_plan_by_more_than_1000(self):
        over = {(f.manager, f.payload["office_id"]): max(l["over_by"] for l in f.payload["lines"]) for f in fixture_points(NOW)}
        self.assertEqual(over[("m_anna", "berlin")], 16000)
        self.assertEqual(over[("m_anna", "vienna")], 500)
        self.assertEqual(over[("m_ben", "berlin")], 0)

    def test_both_berlins_mention_the_booth_order_so_a_leaking_tenant_filter_shows(self):
        mentions = [f.manager + "/" + f.payload["office_id"] for f in fixture_points(NOW) if "PO-1042" in f.texts["bm25"]]
        self.assertEqual(mentions, ["m_anna/berlin", "m_ben/berlin"])

    def test_texts_cover_all_three_vectors(self):
        for fixture in fixture_points(NOW):
            self.assertEqual(set(fixture.texts), {"summary", "digest", "bm25"})
            self.assertTrue(all(fixture.texts.values()))

    def test_within_plan_returns_a_copy_with_no_line_over(self):
        original = fixture_points(NOW)[0]
        replaced = within_plan(original)
        self.assertEqual(replaced.point_id, original.point_id)
        self.assertEqual([l["over_by"] for l in replaced.payload["lines"]], [0] * len(original.payload["lines"]))
        self.assertEqual(max(l["over_by"] for l in original.payload["lines"]), 16000)

if __name__ == "__main__":
    unittest.main()
