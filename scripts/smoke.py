"""Smoke test: every reference request shape against a disposable collection.

Acceptance script: it creates invoice_memory_smoke_<time>_<pid> on the cluster in .env with the production
schema, runs six checks, and always deletes that collection. It never touches any other collection.
"""

import copy
import dataclasses
import os
import re
import sys
from datetime import datetime, timezone

import bodies
from positions import CATEGORIES
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
    """Anna's Berlin over plan, Anna's Vienna as a decoy just over, and the same Berlin under Ben within plan."""
    return [
        _fixture("m_anna", "11111111-1111-4111-8111-111111111111", "berlin", "Berlin", now_iso, "gpu", 120000, 136000,
                 "PO-1042", "Rechenwerk Systems GmbH", "GPU servers (11x) for the inference launch, order expanded"),
        _fixture("m_anna", "22222222-2222-4222-8222-222222222222", "vienna", "Vienna", now_iso, "travel", 40000, 40500,
                 "PO-3001", "Wiener Kongress GmbH", "Booth and travel for the Vienna AI summit"),
        _fixture("m_ben", "33333333-3333-4333-8333-333333333333", "berlin", "Berlin", now_iso, "gpu", 120000, 48000,
                 "PO-1042", "Rechenwerk Systems GmbH", "GPU servers (4x) for the inference launch, deposit"),
    ]


def within_plan(fixture: Fixture) -> Fixture:
    payload = copy.deepcopy(fixture.payload)
    for line in payload["lines"]:
        line["over_by"] = 0
    return dataclasses.replace(fixture, payload=payload)


def run_smoke(call: QdrantCall, collection: str, now_iso: str) -> list[str]:
    """Run the six checks in order; return their names, or raise SmokeFailure at the first that fails."""
    points = f"/collections/{collection}/points"
    anna, decoy, ben = fixture_points(now_iso)
    passed: list[str] = []

    def scroll(body: dict) -> list[dict]:
        return call("POST", f"{points}/scroll", body)["points"]

    def offices(found: list[dict]) -> set[str]:
        return {p["payload"]["office_id"] for p in found}

    def write(fixture: Fixture) -> None:
        call("PUT", f"{points}?wait=true", bodies.upsert(fixture.manager, fixture.point_id, fixture.payload, fixture.texts))

    def check(name: str, holds: bool, detail: object) -> None:
        if not holds:
            raise SmokeFailure(name, repr(detail))
        passed.append(name)

    ensure_collection(call, collection)
    leftovers = [f for f in (anna, decoy, ben) if scroll(bodies.office_scroll(f.manager, f.payload["office_id"]))]
    check("setup", not leftovers, leftovers)

    for fixture in (anna, decoy, ben):
        write(fixture)
    check("upsert", True, None)

    over = offices(scroll(bodies.office_list("m_anna", over_gt=1000)))
    check("over_plan", over == {"berlin"}, over)

    ben_points = scroll(bodies.office_list("m_ben"))
    check("tenant", [p["id"] for p in ben_points] == [ben.point_id], ben_points)

    lists = [r["points"] for r in call("POST", f"{points}/query/batch", bodies.ask_batch("m_anna", "PO-1042", now_iso))]
    hit_ids = {h["id"] for hits in lists for h in hits}
    check("ask_batch", len(lists) == 4 and bool(lists[0]) and lists[0][0]["id"] == anna.point_id
          and hit_ids <= {anna.point_id, decoy.point_id}, lists)

    write(within_plan(anna))
    after = scroll(bodies.office_list("m_anna"))
    check("replace", len(after) == 2 and not scroll(bodies.office_list("m_anna", over_gt=1000)), after)
    return passed


def _fixture(manager: str, point_id: str, office: str, name: str, now_iso: str, category: str, budget: float,
             committed: float, key: str, counterparty: str, description: str) -> Fixture:
    lines = [{"category": c, "budget": budget if c == category else 0, "committed": committed if c == category else 0,
              "over_by": max(0, committed - budget) if c == category else 0} for c in CATEGORIES]
    document = {"doc_key": key, "doc_type": "cost", "version": 1, "category": category, "amount": committed,
                "counterparty": counterparty, "description_en": description, "status": "current", "stage": 2,
                "received_at": now_iso}
    payload = {
        "office_id": office, "manager_id": manager, "name": name, "stage": 2, "pending_count": 0,
        "lines": lines, "documents": [document], "latest": document, "updated_at": now_iso,
    }
    texts = {
        "summary": f"{name}: {committed:.2f} EUR committed in {category}, {max(0, committed - budget):.2f} EUR over plan.",
        "digest": f"{key} v1 | 2026-10-06 | Commitment | {category} | {counterparty} | {committed:.2f} EUR | {description}",
        "bm25": f"BESTELLUNG Belegnummer: {key} Lieferant: {counterparty} Betrag: {committed:.2f} EUR\n{description}",
    }
    return Fixture(manager, point_id, payload, texts)


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
