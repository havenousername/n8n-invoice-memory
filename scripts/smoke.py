"""Smoke test: every reference request shape against a disposable collection.

Acceptance script: it creates invoice_memory_smoke_<time>_<pid> on the cluster in .env with the production
schema, runs eight checks, and always deletes that collection. It never touches any other collection.
"""

import copy
import dataclasses
import os
import re
import sys
from datetime import datetime, timedelta, timezone

import bodies
from env import InvalidEnvFile, MissingSetting, load_settings
from qdrant_api import QdrantCall, connect
from setup_collection import SchemaDrift, ensure_collection
from transport import HttpError, TransportError

SMOKE_PREFIX = "invoice_memory_smoke_"


@dataclasses.dataclass(frozen=True)
class Fixture:
    manager: str
    point_id: str
    payload: dict
    texts: dict


class SmokeFailure(Exception):
    def __init__(self, check: str, detail: str):
        super().__init__(f"{check}: {detail}")
        self.check = check
        self.detail = detail


def smoke_collection_name(now_iso: str, suffix: str) -> str:
    stamp = re.sub(r"\D", "", now_iso)[:14]
    return f"{SMOKE_PREFIX}{stamp}_{suffix}"


def drop_smoke_collection(call: QdrantCall, name: str) -> None:
    if not name.startswith(SMOKE_PREFIX):
        raise ValueError(f"refusing to delete {name!r}: only {SMOKE_PREFIX}* collections are disposable")
    call("DELETE", f"/collections/{name}")


def fixture_points(now_iso: str) -> list[Fixture]:
    """Anna's real match, Anna's decoy for the nested filter, and the same slug under Ben."""
    return [
        _fixture("m_anna", "11111111-1111-4111-8111-111111111111", "smoke", "Smoke GmbH", now_iso, [
            _invoice("INV-4711", 12300.00, "overdue", "Hetzner Online GmbH", "Hetzner servers, rack 12"),
        ]),
        _fixture("m_anna", "22222222-2222-4222-8222-222222222222", "decoy", "Decoy AG", now_iso, [
            _invoice("INV-5001", 500.00, "overdue", "Office Depot", "office chairs"),
            _invoice("INV-5002", 20000.00, "paid", "Deloitte GmbH", "consulting, annual audit"),
        ]),
        _fixture("m_ben", "33333333-3333-4333-8333-333333333333", "smoke", "Smoke GmbH", now_iso, [
            _invoice("INV-7001", 15000.00, "overdue", "Hetzner Online GmbH", "Hetzner servers, rack 40"),
        ]),
    ]


def with_deleted_at(fixture: Fixture, deleted_at: str | None) -> Fixture:
    payload = copy.deepcopy(fixture.payload)
    if deleted_at is None:
        payload.pop("deleted_at", None)
    else:
        payload["deleted_at"] = deleted_at
    return dataclasses.replace(fixture, payload=payload)


def run_smoke(call: QdrantCall, collection: str, now_iso: str) -> list[str]:
    """Run the eight checks in order; return their names, or raise SmokeFailure at the first that fails."""
    points = f"/collections/{collection}/points"
    anna, decoy, ben = fixture_points(now_iso)
    passed: list[str] = []

    def scroll(body: dict) -> list[dict]:
        return call("POST", f"{points}/scroll", body)["points"]

    def slugs(found: list[dict]) -> set[str]:
        return {p["payload"]["customer_id"] for p in found}

    def write(fixture: Fixture) -> None:
        call("PUT", f"{points}?wait=true", bodies.upsert(fixture.manager, fixture.point_id, fixture.payload, fixture.texts))

    def check(name: str, holds: bool, detail: object) -> None:
        if not holds:
            raise SmokeFailure(name, repr(detail))
        passed.append(name)

    ensure_collection(call, collection)
    leftovers = [f for f in (anna, decoy, ben) if scroll(bodies.customer_scroll(f.manager, f.payload["customer_id"]))]
    check("setup", not leftovers, leftovers)

    for fixture in (anna, decoy, ben):
        write(fixture)
    check("upsert", True, None)

    overdue = slugs(scroll(bodies.live_scroll("m_anna", 10000)))
    check("nested", overdue == {"smoke"}, overdue)

    ben_points = scroll(bodies.live_scroll("m_ben"))
    check("tenant", [p["id"] for p in ben_points] == [ben.point_id], ben_points)

    hits = call("POST", f"{points}/query", bodies.hybrid_query("m_anna", "servers", now_iso))["points"]
    check("hybrid", bool(hits) and hits[0]["id"] == anna.point_id
          and {h["id"] for h in hits} <= {anna.point_id, decoy.point_id}, hits)

    write(with_deleted_at(anna, _shift(now_iso, days=-40)))
    live, removed = slugs(scroll(bodies.live_scroll("m_anna"))), slugs(scroll(bodies.removed_scroll("m_anna")))
    check("soft_delete", "smoke" not in live and "smoke" in removed, (live, removed))

    write(anna)
    restored = scroll(bodies.customer_scroll("m_anna", "smoke"))
    check("restore", bool(restored) and "deleted_at" not in restored[0]["payload"]
          and "smoke" in slugs(scroll(bodies.live_scroll("m_anna"))), restored)

    write(with_deleted_at(anna, _shift(now_iso, days=-40)))
    call("POST", f"{points}/delete?wait=true", bodies.purge("m_anna", "smoke", _shift(now_iso, days=-30)))
    survivors = {
        "anna/smoke": bool(scroll(bodies.customer_scroll("m_anna", "smoke"))),
        "anna/decoy": bool(scroll(bodies.customer_scroll("m_anna", "decoy"))),
        "ben/smoke": bool(scroll(bodies.customer_scroll("m_ben", "smoke"))),
    }
    check("purge", survivors == {"anna/smoke": False, "anna/decoy": True, "ben/smoke": True}, survivors)
    return passed


def _fixture(manager: str, point_id: str, customer: str, name: str, now_iso: str, invoices: list[dict]) -> Fixture:
    payload = {
        "manager_id": manager, "worker_id": "w_smoke", "customer_id": customer, "name": name,
        "stage": 2, "pending_count": 0, "invoice_count": len(invoices),
        "last_invoice_at": now_iso, "updated_at": now_iso, "invoices": invoices,
    }
    digest = "\n".join(
        f"{i['invoice_no']} | {i['date']} | {i['amount']:.2f} EUR | due {i['due_date']} | {i['status']} | {i['items']}"
        for i in invoices
    )
    texts = {
        "summary": f"{len(invoices)} invoices for {name}",
        "digest": digest,
        "bm25": "\n".join(f"Invoice {i['invoice_no']} {i['vendor']} {i['items']} total {i['amount']:.2f}" for i in invoices),
    }
    return Fixture(manager, point_id, payload, texts)


def _invoice(invoice_no: str, amount: float, status: str, vendor: str, items: str) -> dict:
    return {"invoice_no": invoice_no, "date": "2026-09-01", "due_date": "2026-09-15", "amount": amount,
            "vendor": vendor, "status": status, "stage": 2, "error": "", "items": items}


def _shift(now_iso: str, days: int) -> str:
    moment = datetime.fromisoformat(now_iso) + timedelta(days=days)
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main() -> int:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    name = smoke_collection_name(now, str(os.getpid()))
    try:
        call = connect(load_settings(["QDRANT_URL", "QDRANT_API_KEY"]))
    except (InvalidEnvFile, MissingSetting) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"collection {name}")
    try:
        for check in run_smoke(call, name, now):
            print(f"ok {check}")
    except (SmokeFailure, SchemaDrift, HttpError, TransportError) as error:
        print(f"FAILED {error}", file=sys.stderr)
        return 1
    finally:
        _drop_quietly(call, name)
    print("SMOKE PASSED")
    return 0


def _drop_quietly(call: QdrantCall, name: str) -> None:
    try:
        drop_smoke_collection(call, name)
    except HttpError as error:
        if error.status != 404:  # 404: the run failed before creating it
            print(f"warning: could not delete {name}: {error}", file=sys.stderr)
    except TransportError as error:
        print(f"warning: could not delete {name}: {error}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
