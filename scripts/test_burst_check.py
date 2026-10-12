import copy
import unittest

from burst_check import burst_failures, points_by_office
from positions import cross_check_case

CASE = cross_check_case()
EXPECTED = CASE["expected"]


def point_for(office_id: str, want: dict) -> dict:
    """The payload a correct pipeline writes for this office after the burst."""
    lines = [{"category": c, "name": c, **line} for c, line in want["lines"].items()]
    documents = [{"doc_key": key, "version": doc["version"], "amount": doc["amount"], "status": "current", "kind": "document"}
                 for key, doc in want["current"].items()]
    documents.append({"doc_key": "PO-5000", "version": 1, "amount": 48000, "status": "superseded", "kind": "document"})
    return {
        "office_id": office_id, "stage": 2 if want["current"] else 0, "pending_count": 0,
        "summary_stage": 3 if want["current"] else 1, "lines": lines, "documents": documents,
        "committed": sum(l["committed"] for l in lines), "budget": sum(l["budget"] for l in lines),
        "booked": want["booked"], "deal_count": want["deal_count"],
        "superseded_count": want["superseded_count"], "duplicate_count": want["duplicate_count"],
    }


def good_points() -> dict:
    return {office_id: point_for(office_id, want) for office_id, want in EXPECTED.items()}


class BurstFailuresTest(unittest.TestCase):
    def test_points_that_match_the_issued_documents_pass(self):
        self.assertEqual(burst_failures(EXPECTED, good_points()), [])

    def test_wrong_committed_amount(self):
        points = good_points()
        next(l for l in points["berlin"]["lines"] if l["category"] == "gpu")["committed"] = 180000
        self.assertIn("berlin gpu committed: expected 132000, got 180000", burst_failures(EXPECTED, points))

    def test_missing_office(self):
        points = good_points()
        del points["paris"]
        self.assertEqual(burst_failures(EXPECTED, points), ["paris: no point"])

    def test_wrong_superseded_count(self):
        points = good_points()
        points["berlin"]["superseded_count"] = 0
        self.assertEqual(burst_failures(EXPECTED, points), ["berlin superseded_count: expected 1, got 0"])

    def test_stale_summary_or_unfinished_stage(self):
        points = good_points()
        points["berlin"]["summary_stage"] = 1
        points["paris"]["stage"] = 1
        self.assertEqual(burst_failures(EXPECTED, points),
                         ["berlin: summary_stage 1, expected a fresh summary (3)", "paris: stage 1, expected 2"])

    def test_extraction_mismatch_on_a_current_document(self):
        points = good_points()
        doc = next(d for d in points["paris"]["documents"] if d["doc_key"] == "PO-5002")
        doc["amount"] = 80.0
        self.assertEqual(burst_failures(EXPECTED, points), ["paris PO-5002 v1: amount 80.0, issued 80000"])

    def test_current_document_missing_or_at_another_version(self):
        points = good_points()
        points["berlin"]["documents"] = [d for d in points["berlin"]["documents"] if d["doc_key"] != "CN-7000"]
        next(d for d in points["berlin"]["documents"] if d["doc_key"] == "PO-5000" and d["status"] == "current")["version"] = 1
        self.assertEqual(burst_failures(EXPECTED, points),
                         ["berlin PO-5000: current version 1, issued version 2", "berlin CN-7000: not current on the point"])

    def test_an_untouched_office_needs_no_stage_or_summary(self):
        expected = copy.deepcopy(EXPECTED)
        expected["vienna"] = {**copy.deepcopy(EXPECTED["paris"]), "current": {}, "booked": 0, "deal_count": 0}
        for line in expected["vienna"]["lines"].values():
            line.update(committed=0, credited=0, remaining=line["budget"], over_by=0)
        points = good_points()
        points["vienna"] = point_for("vienna", expected["vienna"])
        self.assertEqual(burst_failures(expected, points), [])

    def test_cents_are_compared_with_tolerance(self):
        points = good_points()
        next(l for l in points["berlin"]["lines"] if l["category"] == "gpu")["committed"] = 132000.004
        self.assertEqual(burst_failures(EXPECTED, points), [])


class PointsByOfficeTest(unittest.TestCase):
    def test_keys_scrolled_points_by_office(self):
        scrolled = [{"id": "a", "payload": {"office_id": "berlin", "stage": 2}}, {"id": "b", "payload": {"office_id": "paris"}}]
        self.assertEqual(set(points_by_office(scrolled)), {"berlin", "paris"})


if __name__ == "__main__":
    unittest.main()
