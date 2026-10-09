"""Create the customers collection, or verify an existing one, with its shard keys and payload indexes.

Acceptance script: it writes to the live cluster named in .env. Safe to rerun.
"""

import argparse
import sys

from env import InvalidEnvFile, MissingSetting, load_settings
from qdrant_api import QdrantCall, connect
from schema import COLLECTION, PAYLOAD_INDEXES, SHARD_KEYS, collection_spec, drift, missing_indexes
from transport import HttpError, TransportError


class SchemaDrift(Exception):
    def __init__(self, collection: str, mismatches: list[str]):
        super().__init__(f"collection {collection} does not match the spec: {'; '.join(mismatches)}")
        self.collection = collection
        self.mismatches = mismatches


def ensure_collection(call: QdrantCall, name: str = COLLECTION) -> list[str]:
    """Bring `name` up to the spec and return the actions taken; [] means it was already complete."""
    base = f"/collections/{name}"
    actions = []
    info = _read_info(call, base)
    if info is None:
        call("PUT", base, collection_spec())
        actions.append(f"created collection {name}")
        info = call("GET", base)
    mismatches = drift(info)
    if mismatches:
        raise SchemaDrift(name, mismatches)
    for key in _missing_shard_keys(call, base):
        call("PUT", f"{base}/shards", {"shard_key": key})
        actions.append(f"created shard key {key}")
    for field in missing_indexes(info):
        call("PUT", f"{base}/index?wait=true", {"field_name": field, "field_schema": dict(PAYLOAD_INDEXES[field])})
        actions.append(f"created index {field}")
    if actions:
        _verify(call, base, name)
    return actions


def _read_info(call: QdrantCall, base: str) -> dict | None:
    try:
        return call("GET", base)
    except HttpError as error:
        if error.status == 404:
            return None
        raise


def _missing_shard_keys(call: QdrantCall, base: str) -> list[str]:
    existing = {entry["key"] for entry in call("GET", f"{base}/shards")["shard_keys"]}
    return [key for key in SHARD_KEYS if key not in existing]


def _verify(call: QdrantCall, base: str, name: str) -> None:
    info = call("GET", base)
    problems = [
        *drift(info),
        *(f"index {field}: missing" for field in missing_indexes(info)),
        *(f"shard key {key}: missing" for key in _missing_shard_keys(call, base)),
    ]
    if problems:
        raise SchemaDrift(name, problems)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--collection", default=COLLECTION)
    args = parser.parse_args(argv)
    try:
        call = connect(load_settings(["QDRANT_URL", "QDRANT_API_KEY"]))
        for action in ensure_collection(call, args.collection):
            print(action)
    except (InvalidEnvFile, MissingSetting, SchemaDrift, HttpError, TransportError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"{args.collection} ok: custom sharding, shard keys {' '.join(SHARD_KEYS)}, {len(PAYLOAD_INDEXES)} indexes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
