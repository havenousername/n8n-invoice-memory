"""Reference Qdrant request bodies. The n8n workflows rebuild these in expressions and must send the same JSON.

Run it to print every body with sample arguments: python3 scripts/bodies.py
"""

import json
import sys
from collections.abc import Mapping

from schema import MODELS

DECAY_SCALE_SECONDS = 30 * 24 * 3600


def upsert(manager: str, point_id: str, payload: dict, texts: Mapping[str, str]) -> dict:
    """PUT /collections/{c}/points: one point, three vectors embedded by Cloud Inference."""
    vector = {name: {"text": texts[name], "model": model} for name, model in MODELS.items()}
    return {"shard_key": manager, "points": [{"id": point_id, "payload": payload, "vector": vector}]}


def live_scroll(manager: str, overdue_gte: float | None = None, limit: int = 50) -> dict:
    """POST /collections/{c}/points/scroll: the manager's live cards, newest invoice first."""
    must = _live_filter(manager)["must"]
    if overdue_gte is not None:
        must.append({"nested": {"key": "invoices", "filter": {"must": [
            {"key": "status", "match": {"value": "overdue"}},
            {"key": "amount", "range": {"gte": overdue_gte}},
        ]}}})
    return _scroll(manager, {"must": must}, limit)


def removed_scroll(manager: str, limit: int = 50) -> dict:
    """POST /collections/{c}/points/scroll: the manager's soft-deleted customers."""
    return _scroll(manager, {"must": [_tenant(manager)], "must_not": [_no_deleted_at()]}, limit)


def customer_scroll(manager: str, customer: str) -> dict:
    """POST /collections/{c}/points/scroll: one customer's point, deleted or not."""
    must = [_tenant(manager), {"key": "customer_id", "match": {"value": customer}}]
    return {"shard_key": manager, "limit": 1, "with_payload": True, "filter": {"must": must}}


def hybrid_query(manager: str, text: str, now_iso: str, limit: int = 5) -> dict:
    """POST /collections/{c}/points/query: spec section 11, three vectors fused by RRF, then freshness decay."""
    prefetch = [
        {"query": {"nearest": {"text": text, "model": MODELS[name]}}, "using": name, "limit": 20,
         "filter": _live_filter(manager)}
        for name in ("bm25", "digest", "summary")
    ]
    decay = {"exp_decay": {
        "x": {"datetime_key": "last_invoice_at"},
        "target": {"datetime": now_iso},
        "scale": DECAY_SCALE_SECONDS,
        "midpoint": 0.5,
    }}
    return {
        "shard_key": manager,
        "prefetch": {"prefetch": prefetch, "query": {"rrf": {}}, "limit": 20},
        "query": {"formula": {"sum": ["$score", {"mult": [0.1, decay]}]}},
        "filter": _live_filter(manager),
        "limit": limit,
        "with_payload": ["customer_id", "invoices"],
    }


def purge(manager: str, customer: str, cutoff_iso: str) -> dict:
    """POST /collections/{c}/points/delete: one tenant's customer, only if soft-deleted before the cutoff."""
    return {"shard_key": manager, "filter": {"must": [
        _tenant(manager),
        {"key": "customer_id", "match": {"value": customer}},
        {"key": "deleted_at", "range": {"lt": cutoff_iso}},
    ]}}


def _tenant(manager: str) -> dict:
    return {"key": "manager_id", "match": {"value": manager}}


def _no_deleted_at() -> dict:
    return {"is_empty": {"key": "deleted_at"}}


def _live_filter(manager: str) -> dict:
    return {"must": [_tenant(manager), _no_deleted_at()]}


def _scroll(manager: str, filter_: dict, limit: int) -> dict:
    return {
        "shard_key": manager,
        "limit": limit,
        "with_payload": True,
        "order_by": {"key": "last_invoice_at", "direction": "desc"},
        "filter": filter_,
    }


def main() -> int:
    now = "2026-10-14T00:00:00Z"
    samples = {
        'upsert("m_anna", <id>, <payload>, <texts>)': upsert(
            "m_anna", "<uuid>", {"customer_id": "acme"}, {"summary": "<summary>", "digest": "<digest>", "bm25": "<text>"}
        ),
        'live_scroll("m_anna")': live_scroll("m_anna"),
        'live_scroll("m_anna", overdue_gte=10000)': live_scroll("m_anna", 10000),
        'removed_scroll("m_anna")': removed_scroll("m_anna"),
        'customer_scroll("m_anna", "acme")': customer_scroll("m_anna", "acme"),
        f'hybrid_query("m_anna", "servers", "{now}")': hybrid_query("m_anna", "servers", now),
        'purge("m_anna", "acme", "2026-09-14T00:00:00Z")': purge("m_anna", "acme", "2026-09-14T00:00:00Z"),
    }
    for label, body in samples.items():
        print(f"# {label}\n{json.dumps(body, indent=2)}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
