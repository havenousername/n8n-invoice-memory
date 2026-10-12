"""Burst check: do the live office points say what the AI workers actually issued?

Acceptance script: it reads GET {N8N_BASE_URL}/webhook/issued (the ground truth 00 Working day logs) and every office
point in Qdrant, and compares them with scripts/positions.py's expectations: lines, totals, counts, a sharp stage, a
fresh summary, and each current document's amount against what was issued. Run it after 07's reset and one burst,
so the points hold only issued documents. Exit 0 and BURST OK when every check holds.

  python3 scripts/burst_check.py [--since ISO]
"""

import argparse
import json
import sys
from collections.abc import Iterable, Mapping
from pathlib import Path

import bodies
from env import InvalidEnvFile, MissingSetting, load_settings
from positions import expected_positions
from qdrant_api import connect
from schema import COLLECTION, SHARD_KEYS
from transport import HttpError, TransportError, send

DASHBOARD_HEADER = "X-Dashboard-Secret"
OFFICES_FILE = Path(__file__).resolve().parent.parent / "samples" / "offices.json"
_CENT = 0.005
_COUNTS = ("booked", "deal_count", "superseded_count", "duplicate_count")


def burst_failures(expected: Mapping[str, dict], points: Mapping[str, dict]) -> list[str]:
    """Every way the points differ from the expected positions; empty when the burst landed."""
    problems = []
    for office_id, want in expected.items():
        point = points.get(office_id)
        if point is None:
            problems.append(f"{office_id}: no point")
            continue
        lines = {line["category"]: line for line in point.get("lines", [])}
        for category, line in want["lines"].items():
            for key, value in line.items():
                got = lines.get(category, {}).get(key)
                if not _same(got, value):
                    problems.append(f"{office_id} {category} {key}: expected {_num(value)}, got {_num(got)}")
        for key, value in (("committed", sum(l["committed"] for l in want["lines"].values())),
                           ("budget", sum(l["budget"] for l in want["lines"].values())),
                           *((key, want[key]) for key in _COUNTS)):
            if not _same(point.get(key), value):
                problems.append(f"{office_id} {key}: expected {_num(value)}, got {_num(point.get(key))}")
        if want["current"]:
            problems += _stage_and_summary(office_id, point)
        problems += _documents(office_id, want["current"], point.get("documents", []))
    return problems


def points_by_office(scrolled: Iterable[Mapping]) -> dict[str, dict]:
    return {p["payload"]["office_id"]: p["payload"] for p in scrolled}


def _stage_and_summary(office_id: str, point: Mapping) -> list[str]:
    if point.get("stage") != 2:
        return [f"{office_id}: stage {point.get('stage')}, expected 2"]
    if point.get("summary_stage") != 3:
        return [f"{office_id}: summary_stage {point.get('summary_stage')}, expected a fresh summary (3)"]
    return []


def _documents(office_id: str, current: Mapping[str, dict], documents: list[Mapping]) -> list[str]:
    on_point = {d["doc_key"]: d for d in documents if d.get("status") == "current"}
    problems = []
    for key, issued in current.items():
        doc = on_point.get(key)
        if doc is None:
            problems.append(f"{office_id} {key}: not current on the point")
        elif doc.get("version") != issued["version"]:
            problems.append(f"{office_id} {key}: current version {doc.get('version')}, issued version {issued['version']}")
        elif not _same(doc.get("amount"), issued["amount"]):
            problems.append(f"{office_id} {key} v{issued['version']}: amount {doc.get('amount')}, issued {_num(issued['amount'])}")
    return problems


def _same(got: object, want: object) -> bool:
    if isinstance(want, (int, float)) and isinstance(got, (int, float)):
        return abs(got - want) < _CENT
    return got == want


def _num(value: object) -> object:
    return int(value) if isinstance(value, float) and value.is_integer() else value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--since", help="only issued rows at or after this ISO time")
    args = parser.parse_args(argv)
    try:
        settings = load_settings(["QDRANT_URL", "QDRANT_API_KEY", "N8N_BASE_URL", "N8N_DASHBOARD_SECRET"])
        rows = send("GET", f"{settings.n8n_base_url}/webhook/issued",
                    headers={DASHBOARD_HEADER: settings.n8n_dashboard_secret})
        call = connect(settings)
        scrolled = [p for manager in SHARD_KEYS
                    for p in call("POST", f"/collections/{COLLECTION}/points/scroll", bodies.office_list(manager))["points"]]
    except (InvalidEnvFile, MissingSetting, HttpError, TransportError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    issued = [r for r in rows if r.get("issued_id") and (not args.since or r["issued_at"] >= args.since)]
    expected = expected_positions(issued, json.loads(OFFICES_FILE.read_text()))
    problems = burst_failures(expected, points_by_office(scrolled))
    print(f"{len(issued)} issued documents, {len(scrolled)} office points")
    for problem in problems:
        print(problem)
    print("BURST FAILED" if problems else "BURST OK")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
