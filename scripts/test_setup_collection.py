import copy
import unittest

from setup_collection import SchemaDrift, ensure_collection
from test_schema import compatible_info
from transport import HttpError

ALL_INDEXES = ["manager_id", "office_id", "stage", "updated_at", "latest.received_at",
               "lines[].category", "lines[].over_by", "documents[].doc_type"]


class FakeQdrant:
    """In-memory stand-in for a QdrantCall: collections, shard keys, payload indexes."""

    def __init__(self, ignore_sharding: bool = False, first_read_status: int | None = None):
        self.infos: dict[str, dict] = {}
        self.shard_keys: dict[str, list[str]] = {}
        self.calls: list[tuple[str, str, object]] = []
        self.ignore_sharding = ignore_sharding
        self.first_read_status = first_read_status

    def seed(self, name: str, info: dict, shard_keys: list[str]) -> None:
        self.infos[name] = copy.deepcopy(info)
        self.shard_keys[name] = list(shard_keys)

    def writes(self) -> list[tuple[str, str, object]]:
        return [c for c in self.calls if c[0] != "GET"]

    def __call__(self, method: str, path: str, body=None):
        self.calls.append((method, path, body))
        route = path.split("?")[0].split("/")[2:]  # ["name"] or ["name", "shards"] or ["name", "index"]
        name = route[0]
        if self.first_read_status is not None:
            status, self.first_read_status = self.first_read_status, None
            raise HttpError(status, {"status": {"error": "forbidden"}}, method, path)
        if method == "GET" and len(route) == 1:
            if name not in self.infos:
                raise HttpError(404, {"status": {"error": "Not found"}}, method, path)
            return copy.deepcopy(self.infos[name])
        if method == "PUT" and len(route) == 1:
            params = {"vectors": body["vectors"], "sparse_vectors": body["sparse_vectors"]}
            if not self.ignore_sharding:
                params["sharding_method"] = body["sharding_method"]
            self.seed(name, {"config": {"params": params}, "payload_schema": {}}, [])
            return True
        if method == "GET" and route[1] == "shards":
            return {"shard_keys": [{"key": k} for k in self.shard_keys[name]]}
        if method == "PUT" and route[1] == "shards":
            self.shard_keys[name].append(body["shard_key"])
            return True
        if method == "PUT" and route[1] == "index":
            field_schema = body["field_schema"]
            entry = {"data_type": field_schema["type"], "points": 0}
            if len(field_schema) > 1:
                entry["params"] = dict(field_schema)
            self.infos[name]["payload_schema"][body["field_name"]] = entry
            return {"operation_id": 1, "status": "completed"}
        raise AssertionError(f"unexpected call {method} {path}")


class EnsureCollectionTest(unittest.TestCase):
    def test_empty_cluster_gets_collection_shard_keys_and_indexes(self):
        qdrant = FakeQdrant()
        actions = ensure_collection(qdrant)
        self.assertEqual(
            actions,
            ["created collection offices", "created shard key m_anna", "created shard key m_ben"]
            + [f"created index {field}" for field in ALL_INDEXES],
        )
        self.assertIn(
            ("PUT", "/collections/offices/index?wait=true",
             {"field_name": "manager_id", "field_schema": {"type": "keyword", "is_tenant": True}}),
            qdrant.calls,
        )

    def test_second_run_only_reads(self):
        qdrant = FakeQdrant()
        ensure_collection(qdrant)
        qdrant.calls.clear()
        self.assertEqual(ensure_collection(qdrant), [])
        self.assertEqual(qdrant.writes(), [])

    def test_uses_the_given_collection_name(self):
        qdrant = FakeQdrant()
        actions = ensure_collection(qdrant, "invoice_memory_smoke_x")
        self.assertEqual(actions[0], "created collection invoice_memory_smoke_x")
        self.assertEqual(set(qdrant.infos), {"invoice_memory_smoke_x"})

    def test_creates_only_what_is_missing(self):
        info = compatible_info()
        del info["payload_schema"]["stage"]
        qdrant = FakeQdrant()
        qdrant.seed("offices", info, ["m_anna"])
        self.assertEqual(ensure_collection(qdrant), ["created shard key m_ben", "created index stage"])

    def test_drifted_collection_raises_before_any_write(self):
        info = compatible_info()
        info["config"]["params"]["vectors"]["summary"]["size"] = 768
        qdrant = FakeQdrant()
        qdrant.seed("offices", info, [])
        with self.assertRaises(SchemaDrift) as caught:
            ensure_collection(qdrant)
        self.assertTrue(any("summary" in m for m in caught.exception.mismatches))
        self.assertEqual(qdrant.writes(), [])

    def test_non_404_error_on_first_read_propagates(self):
        qdrant = FakeQdrant(first_read_status=403)
        with self.assertRaises(HttpError) as caught:
            ensure_collection(qdrant)
        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(qdrant.writes(), [])

    def test_read_back_catches_a_cluster_that_ignored_custom_sharding(self):
        with self.assertRaises(SchemaDrift) as caught:
            ensure_collection(FakeQdrant(ignore_sharding=True))
        self.assertTrue(any("sharding" in m for m in caught.exception.mismatches))


if __name__ == "__main__":
    unittest.main()
