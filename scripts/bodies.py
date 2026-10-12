"""Reference Qdrant request bodies. The n8n workflows and the dashboard rebuild these and must send the same JSON.

  python3 scripts/bodies.py               print every body with sample arguments
  python3 scripts/bodies.py --json [PATH] write the dashboard's reference cases (default dashboard/lib/reference-bodies.json)
"""

import argparse
import json
import sys
from collections.abc import Mapping
from pathlib import Path

from schema import MODELS

DECAY_SCALE_SECONDS = 30 * 24 * 3600
LENSES = ("bm25", "digest", "summary")  # Keyword, Line, Meaning
ASK_PAYLOAD = ["office_id", "name", "documents", "summary_text", "summary_stage"]
REFERENCE_JSON = Path(__file__).resolve().parent.parent / "dashboard" / "lib" / "reference-bodies.json"


def upsert(manager: str, point_id: str, payload: dict, texts: Mapping[str, str]) -> dict:
    """PUT /collections/{c}/points: one point, three vectors embedded by Cloud Inference."""
    vector = {name: {"text": texts[name], "model": model} for name, model in MODELS.items()}
    return {"shard_key": manager, "points": [{"id": point_id, "payload": payload, "vector": vector}]}


def office_list(manager: str, over_gt: float | None = None, limit: int = 50) -> dict:
    """POST /collections/{c}/points/scroll: the manager's offices, most recently changed first."""
    return {
        "shard_key": manager,
        "limit": limit,
        "with_payload": True,
        "order_by": {"key": "updated_at", "direction": "desc"},
        "filter": _filter(manager, over_gt),
    }


def office_scroll(manager: str, office: str) -> dict:
    """POST /collections/{c}/points/scroll: one office's point."""
    must = [_tenant(manager), {"key": "office_id", "match": {"value": office}}]
    return {"shard_key": manager, "limit": 1, "with_payload": True, "filter": {"must": must}}


def ask_batch(manager: str, text: str, now_iso: str, limit: int = 5, over_gt: float | None = None) -> dict:
    """POST /collections/{c}/points/query/batch: Keyword, Line, Meaning alone, then the three fused by RRF with decay."""
    filter_ = _filter(manager, over_gt)
    singles = [
        {"shard_key": manager, "query": _nearest(text, name), "using": name, "filter": filter_, "limit": limit,
         "with_payload": ASK_PAYLOAD}
        for name in LENSES
    ]
    decay = {"exp_decay": {
        "x": {"datetime_key": "updated_at"},
        "target": {"datetime": now_iso},
        "scale": DECAY_SCALE_SECONDS,
        "midpoint": 0.5,
    }}
    fused = {
        "shard_key": manager,
        "prefetch": {
            "prefetch": [{"query": _nearest(text, name), "using": name, "limit": 20, "filter": filter_} for name in LENSES],
            "query": {"rrf": {}},
            "limit": 20,
        },
        "query": {"formula": {"sum": ["$score", {"mult": [0.1, decay]}]}},
        "filter": filter_,
        "limit": limit,
        "with_payload": ASK_PAYLOAD,
    }
    return {"searches": [*singles, fused]}


def reference_cases() -> dict:
    """The dashboard's bodies.ts must return these bodies for these arguments."""
    now = "2026-10-14T09:00:00Z"
    calls = {
        "office_list": [["m_anna", None, 50], ["m_anna", 1000, 50], ["m_ben", 0, 20]],
        "office_scroll": [["m_anna", "berlin"], ["m_ben", "london"]],
        "ask_batch": [["m_anna", "PO-1042", now, 5, None], ["m_ben", "which office overspends on travel?", now, 5, 2500]],
    }
    functions = {"office_list": office_list, "office_scroll": office_scroll, "ask_batch": ask_batch}
    return {name: [{"args": args, "body": functions[name](*args)} for args in arg_lists] for name, arg_lists in calls.items()}


def _tenant(manager: str) -> dict:
    return {"key": "manager_id", "match": {"value": manager}}


def _filter(manager: str, over_gt: float | None) -> dict:
    must = [_tenant(manager)]
    if over_gt is not None:
        must.append({"nested": {"key": "lines", "filter": {"must": [{"key": "over_by", "range": {"gt": over_gt}}]}}})
    return {"must": must}


def _nearest(text: str, vector: str) -> dict:
    return {"nearest": {"text": text, "model": MODELS[vector]}}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", nargs="?", const=str(REFERENCE_JSON), metavar="PATH", help="write the reference cases")
    args = parser.parse_args(argv)
    cases = reference_cases()
    if args.json:
        out = Path(args.json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(cases, indent=1) + "\n")
        print(f"wrote {out}")
        return 0
    for name, entries in cases.items():
        for entry in entries:
            print(f"# {name}{tuple(entry['args'])}\n{json.dumps(entry['body'], indent=2)}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
