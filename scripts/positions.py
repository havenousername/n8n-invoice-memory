"""Expected office positions from ground truth: what each office point should say, given what was issued.

An independent oracle for the office view in workflows/code/office-view.js: the burst check compares live points with
it, and a shared fixture cross-checks both implementations on the same day.

  python3 scripts/positions.py --write-fixture   rewrite workflows/code/fixtures/positions-day.json
"""

import argparse
import json
import sys
from collections.abc import Iterable, Mapping
from pathlib import Path

CATEGORIES = ("people", "cloud", "gpu", "office", "travel")
CROSS_CHECK_FIXTURE = Path(__file__).resolve().parent.parent / "workflows" / "code" / "fixtures" / "positions-day.json"


def expected_positions(issued_rows: Iterable[Mapping], offices: Iterable[Mapping]) -> dict:
    """Per office: lines per category, deals, and counts. Highest version per key is current; resends are duplicates."""
    result = {}
    rows = list(issued_rows)
    for office in offices:
        mine = [r for r in rows if r["office_id"] == office["office_id"]]
        duplicates = [r for r in mine if r.get("resend_of")]
        current, superseded = _current_versions([r for r in mine if not r.get("resend_of")])
        costs = {c: 0.0 for c in CATEGORIES}
        credits = {c: 0.0 for c in CATEGORIES}
        booked, deals = 0.0, 0
        for r in current:
            if r["doc_type"] == "deal":
                booked += r["amount"]
                deals += 1
            elif r.get("category") in CATEGORIES:
                (costs if r["doc_type"] == "cost" else credits)[r["category"]] += r["amount"]
        lines = {}
        for category in CATEGORIES:
            budget = office["budgets"][category]
            committed = round(max(0.0, costs[category] - credits[category]), 2)
            lines[category] = {
                "budget": budget, "committed": committed, "credited": round(credits[category], 2),
                "remaining": round(budget - committed, 2), "over_by": round(max(0.0, committed - budget), 2),
            }
        result[office["office_id"]] = {
            "lines": lines, "booked": round(booked, 2), "deal_count": deals,
            "superseded_count": superseded, "duplicate_count": len(duplicates),
        }
    return result


def _current_versions(rows: list[Mapping]) -> tuple[list[Mapping], int]:
    best: dict[str, Mapping] = {}
    for r in rows:
        held = best.get(r["doc_key"])
        if held is None or (r["version"], r["issued_at"]) > (held["version"], held["issued_at"]):
            best[r["doc_key"]] = r
    return list(best.values()), len(rows) - len(best)


def cross_check_case() -> dict:
    """A small day covering every rule, shared with office-view.test.js."""
    def issued(key, doc_type, amount, category=None, version=1, office="berlin", resend_of=None, minute=0):
        return {"office_id": office, "doc_type": doc_type, "doc_key": key, "version": version, "category": category,
                "amount": amount, "resend_of": resend_of, "issued_at": f"2026-10-12T09:{minute:02d}:00Z"}

    rows = [
        issued("PO-5000", "cost", 48000, "gpu", minute=1),
        issued("PO-5001", "cost", 20000, "cloud", minute=2),
        issued("DEAL-6000", "deal", 300000, minute=3),
        issued("CN-7000", "credit", 25000, "cloud", minute=4),
        issued("PO-5001", "cost", 20000, "cloud", resend_of="ber-po-5001-v1.pdf", minute=5),
        issued("PO-5000", "cost", 132000, "gpu", version=2, minute=6),
        issued("PO-5002", "cost", 80000, "travel", office="paris", minute=7),
        issued("DEAL-6001", "deal", 50000, office="paris", minute=8),
    ]
    offices = [
        {"office_id": "berlin", "budgets": {"people": 820000, "cloud": 180000, "gpu": 120000, "office": 95000, "travel": 60000}},
        {"office_id": "paris", "budgets": {"people": 700000, "cloud": 120000, "gpu": 140000, "office": 110000, "travel": 70000}},
    ]
    return {"issued_rows": rows, "offices": offices, "expected": expected_positions(rows, offices)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--write-fixture", action="store_true", help="rewrite the cross-check fixture")
    args = parser.parse_args(argv)
    if not args.write_fixture:
        parser.print_help()
        return 0
    CROSS_CHECK_FIXTURE.write_text(json.dumps(cross_check_case(), indent=1) + "\n")
    print(f"wrote {CROSS_CHECK_FIXTURE.relative_to(CROSS_CHECK_FIXTURE.parents[3])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
