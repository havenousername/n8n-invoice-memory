import re
import unittest
import uuid

from smoke import drop_smoke_collection, fixture_points, smoke_collection_name, with_deleted_at

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

    def test_tenants_and_slugs(self):
        self.assertEqual(
            [(f.manager, f.payload["customer_id"]) for f in fixture_points(NOW)],
            [("m_anna", "smoke"), ("m_anna", "decoy"), ("m_ben", "smoke")],
        )

    def test_decoy_satisfies_each_condition_only_on_different_invoices(self):
        decoy = fixture_points(NOW)[1]
        invoices = decoy.payload["invoices"]
        self.assertTrue(any(i["status"] == "overdue" for i in invoices))
        self.assertTrue(any(i["amount"] >= 10000 for i in invoices))
        self.assertFalse(any(i["status"] == "overdue" and i["amount"] >= 10000 for i in invoices))

    def test_texts_cover_all_three_vectors(self):
        for fixture in fixture_points(NOW):
            self.assertEqual(set(fixture.texts), {"summary", "digest", "bm25"})
            self.assertTrue(all(fixture.texts.values()))

    def test_with_deleted_at_returns_a_copy(self):
        original = fixture_points(NOW)[0]
        deleted = with_deleted_at(original, "2026-08-30T10:00:00Z")
        self.assertEqual(deleted.payload["deleted_at"], "2026-08-30T10:00:00Z")
        self.assertNotIn("deleted_at", original.payload)


if __name__ == "__main__":
    unittest.main()
