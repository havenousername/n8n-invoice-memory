"""The `customers` collection: one definition shared by setup, smoke, and the Edge gate."""

import copy
from types import MappingProxyType

COLLECTION = "customers"
SHARD_KEYS = ("m_anna", "m_ben")

MODELS = MappingProxyType({
    "summary": "sentence-transformers/all-minilm-l6-v2",
    "digest": "answerdotai/answerai-colbert-small-v1",
    "bm25": "qdrant/bm25",
})

_VECTORS = MappingProxyType({
    "summary": {"size": 384, "distance": "Cosine"},
    "digest": {"size": 96, "distance": "Cosine", "multivector_config": {"comparator": "max_sim"}},
})
_SPARSE_VECTORS = MappingProxyType({"bm25": {"modifier": "idf"}})

# field -> field_schema for PUT /collections/{name}/index, in creation order
PAYLOAD_INDEXES = MappingProxyType({
    "manager_id": {"type": "keyword", "is_tenant": True},
    "worker_id": {"type": "keyword"},
    "customer_id": {"type": "keyword"},
    "deleted_at": {"type": "datetime"},
    "last_invoice_at": {"type": "datetime"},
    "updated_at": {"type": "datetime"},
    "stage": {"type": "integer"},
    "invoices[].status": {"type": "keyword"},
    "invoices[].amount": {"type": "float"},
})


def collection_spec() -> dict:
    """Body for PUT /collections/{name}."""
    return {
        "vectors": copy.deepcopy(dict(_VECTORS)),
        "sparse_vectors": copy.deepcopy(dict(_SPARSE_VECTORS)),
        "sharding_method": "custom",
    }


def drift(info: dict) -> list[str]:
    """Mismatches between a GET /collections/{name} result and the spec. Missing indexes are not drift."""
    params = info.get("config", {}).get("params", {})
    return [
        *_vector_drift(params.get("vectors") or {}),
        *_sparse_drift(params.get("sparse_vectors") or {}),
        *_sharding_drift(params.get("sharding_method")),
        *_index_drift(info.get("payload_schema") or {}),
    ]


def missing_indexes(info: dict) -> list[str]:
    present = info.get("payload_schema") or {}
    return [field for field in PAYLOAD_INDEXES if field not in present]


def _vector_drift(actual_vectors: dict) -> list[str]:
    mismatches = []
    for name, expected in _VECTORS.items():
        actual = actual_vectors.get(name)
        if actual is None:
            mismatches.append(f"vector {name}: missing")
            continue
        for key in ("size", "distance"):
            if actual.get(key) != expected[key]:
                mismatches.append(f"vector {name}: {key} {actual.get(key)}, expected {expected[key]}")
        expected_comparator = (expected.get("multivector_config") or {}).get("comparator")
        actual_comparator = (actual.get("multivector_config") or {}).get("comparator")
        if actual_comparator != expected_comparator:
            mismatches.append(
                f"vector {name}: multivector comparator {actual_comparator}, expected {expected_comparator}"
            )
    return mismatches


def _sparse_drift(actual_sparse: dict) -> list[str]:
    mismatches = []
    for name, expected in _SPARSE_VECTORS.items():
        actual = actual_sparse.get(name)
        if actual is None:
            mismatches.append(f"sparse vector {name}: missing")
        elif actual.get("modifier") != expected["modifier"]:
            mismatches.append(f"sparse vector {name}: modifier {actual.get('modifier')}, expected {expected['modifier']}")
    return mismatches


def _sharding_drift(method: str | None) -> list[str]:
    return [] if method == "custom" else [f"sharding: {method or 'auto'}, expected custom"]


def _index_drift(payload_schema: dict) -> list[str]:
    mismatches = []
    for field, expected in PAYLOAD_INDEXES.items():
        actual = payload_schema.get(field)
        if actual is None:
            continue
        if actual.get("data_type") != expected["type"]:
            mismatches.append(f"index {field}: type {actual.get('data_type')}, expected {expected['type']}")
        elif expected.get("is_tenant") and not (actual.get("params") or {}).get("is_tenant"):
            mismatches.append(f"index {field}: is_tenant not set")
    return mismatches
