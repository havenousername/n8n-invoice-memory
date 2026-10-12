import json
import unittest

from positions import CROSS_CHECK_FIXTURE, cross_check_case, expected_positions

OFFICES = [
    {"office_id": "berlin", "budgets": {"people": 820000, "cloud": 180000, "gpu": 120000, "office": 95000, "travel": 60000}},
    {"office_id": "paris", "budgets": {"people": 700000, "cloud": 120000, "gpu": 140000, "office": 110000, "travel": 70000}},
]


def issued(key, doc_type, amount, category=None, version=1, office="berlin", resend_of=None, at="2026-10-12T09:00:00Z"):
    return {"office_id": office, "doc_type": doc_type, "doc_key": key, "version": version, "category": category,
            "amount": amount, "resend_of": resend_of, "issued_at": at}


class ExpectedPositionsTest(unittest.TestCase):
    def test_every_office_appears_with_zeros(self):
        result = expected_positions([], OFFICES)
        self.assertEqual(set(result), {"berlin", "paris"})
        self.assertEqual(result["paris"]["lines"]["travel"],
                         {"budget": 70000, "committed": 0, "credited": 0, "remaining": 70000, "over_by": 0})
        self.assertEqual((result["paris"]["booked"], result["paris"]["deal_count"]), (0, 0))
        self.assertEqual(result["paris"]["current"], {})

    def test_costs_sum_per_category_and_over_plan(self):
        result = expected_positions([issued("PO-5002", "cost", 80000, "travel", office="paris")], OFFICES)
        self.assertEqual(result["paris"]["lines"]["travel"],
                         {"budget": 70000, "committed": 80000, "credited": 0, "remaining": -10000, "over_by": 10000})

    def test_the_highest_version_is_current(self):
        rows = [issued("PO-5000", "cost", 132000, "gpu", version=2), issued("PO-5000", "cost", 48000, "gpu", version=1)]
        result = expected_positions(rows, OFFICES)["berlin"]
        self.assertEqual(result["lines"]["gpu"]["committed"], 132000)
        self.assertEqual(result["superseded_count"], 1)
        self.assertEqual(result["current"], {"PO-5000": {"version": 2, "amount": 132000}})

    def test_credit_larger_than_committed_floors_at_zero(self):
        rows = [issued("PO-5001", "cost", 20000, "cloud"), issued("CN-7000", "credit", 25000, "cloud")]
        line = expected_positions(rows, OFFICES)["berlin"]["lines"]["cloud"]
        self.assertEqual(line, {"budget": 180000, "committed": 0, "credited": 25000, "remaining": 180000, "over_by": 0})

    def test_resends_are_duplicates_never_summed(self):
        rows = [issued("PO-5001", "cost", 20000, "cloud"), issued("PO-5001", "cost", 20000, "cloud", resend_of="ber-po-5001-v1.pdf")]
        result = expected_positions(rows, OFFICES)["berlin"]
        self.assertEqual(result["lines"]["cloud"]["committed"], 20000)
        self.assertEqual((result["duplicate_count"], result["superseded_count"]), (1, 0))

    def test_deals_are_booked(self):
        result = expected_positions([issued("DEAL-6000", "deal", 300000)], OFFICES)["berlin"]
        self.assertEqual((result["booked"], result["deal_count"]), (300000, 1))


class CrossCheckFixtureTest(unittest.TestCase):
    def test_committed_fixture_matches_the_rules(self):
        committed = json.loads(CROSS_CHECK_FIXTURE.read_text())
        self.assertEqual(committed, cross_check_case(), "run python3 scripts/positions.py --write-fixture")

    def test_fixture_covers_every_rule(self):
        case = cross_check_case()
        berlin = case["expected"]["berlin"]
        self.assertEqual(berlin["lines"]["gpu"]["over_by"], 12000)
        self.assertEqual(berlin["lines"]["cloud"]["committed"], 0)
        self.assertEqual((berlin["superseded_count"], berlin["duplicate_count"], berlin["deal_count"]), (1, 1, 1))
        self.assertEqual(case["expected"]["paris"]["lines"]["travel"]["over_by"], 10000)


if __name__ == "__main__":
    unittest.main()
