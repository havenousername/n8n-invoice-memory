import copy
import unittest

from schema import COLLECTION, MODELS, PAYLOAD_INDEXES, collection_spec, drift, missing_indexes


def compatible_info() -> dict:
    """A GET /collections/{name} result for a collection built from the spec."""
    keyword = {"data_type": "keyword", "points": 0}
    return {
        "status": "green",
        "points_count": 0,
        "config": {
            "params": {
                "vectors": {
                    "summary": {"size": 384, "distance": "Cosine"},
                    "digest": {"size": 96, "distance": "Cosine", "multivector_config": {"comparator": "max_sim"}},
                },
                "sparse_vectors": {"bm25": {"modifier": "idf"}},
                "shard_number": 1,
                "sharding_method": "custom",
                "replication_factor": 1,
            }
        },
        "payload_schema": {
            "manager_id": {"data_type": "keyword", "params": {"type": "keyword", "is_tenant": True}, "points": 0},
            "office_id": dict(keyword),
            "stage": {"data_type": "integer", "points": 0},
            "updated_at": {"data_type": "datetime", "points": 0},
            "latest.received_at": {"data_type": "datetime", "points": 0},
            "lines[].category": dict(keyword),
            "lines[].over_by": {"data_type": "float", "points": 0},
            "documents[].doc_type": dict(keyword),
        },
    }


class CollectionSpecTest(unittest.TestCase):
    def test_vectors_sparse_and_sharding(self):
        spec = collection_spec()
        self.assertEqual(spec["vectors"]["summary"], {"size": 384, "distance": "Cosine"})
        self.assertEqual(
            spec["vectors"]["digest"],
            {"size": 96, "distance": "Cosine", "multivector_config": {"comparator": "max_sim"}},
        )
        self.assertEqual(spec["sparse_vectors"], {"bm25": {"modifier": "idf"}})
        self.assertEqual(spec["sharding_method"], "custom")

    def test_collection_name(self):
        self.assertEqual(COLLECTION, "offices")

    def test_spec_is_a_fresh_copy(self):
        collection_spec()["vectors"]["summary"]["size"] = 1
        self.assertEqual(collection_spec()["vectors"]["summary"]["size"], 384)

    def test_models_and_indexes(self):
        self.assertEqual(
            MODELS,
            {
                "summary": "sentence-transformers/all-minilm-l6-v2",
                "digest": "answerdotai/answerai-colbert-small-v1",
                "bm25": "qdrant/bm25",
            },
        )
        self.assertEqual(
            list(PAYLOAD_INDEXES),
            ["manager_id", "office_id", "stage", "updated_at", "latest.received_at",
             "lines[].category", "lines[].over_by", "documents[].doc_type"],
        )


class DriftTest(unittest.TestCase):
    def assert_one_mismatch(self, info: dict, *fragments: str) -> None:
        mismatches = drift(info)
        self.assertEqual(len(mismatches), 1, mismatches)
        for fragment in fragments:
            self.assertIn(fragment, mismatches[0])

    def test_compatible_collection_has_no_drift(self):
        self.assertEqual(drift(compatible_info()), [])

    def test_missing_index_is_not_drift(self):
        info = compatible_info()
        del info["payload_schema"]["stage"]
        self.assertEqual(drift(info), [])

    def test_wrong_vector_size(self):
        info = compatible_info()
        info["config"]["params"]["vectors"]["summary"]["size"] = 768
        self.assert_one_mismatch(info, "summary", "768", "384")

    def test_wrong_distance(self):
        info = compatible_info()
        info["config"]["params"]["vectors"]["digest"]["distance"] = "Dot"
        self.assert_one_mismatch(info, "digest", "Dot", "Cosine")

    def test_missing_multivector_comparator(self):
        info = compatible_info()
        del info["config"]["params"]["vectors"]["digest"]["multivector_config"]
        self.assert_one_mismatch(info, "digest", "max_sim")

    def test_missing_vector(self):
        info = compatible_info()
        del info["config"]["params"]["vectors"]["summary"]
        self.assert_one_mismatch(info, "summary", "missing")

    def test_missing_sparse_modifier(self):
        info = compatible_info()
        info["config"]["params"]["sparse_vectors"]["bm25"] = {}
        self.assert_one_mismatch(info, "bm25", "idf")

    def test_sharding_not_custom(self):
        info = compatible_info()
        del info["config"]["params"]["sharding_method"]
        self.assert_one_mismatch(info, "sharding", "custom")

    def test_index_with_wrong_type(self):
        info = compatible_info()
        info["payload_schema"]["lines[].over_by"]["data_type"] = "integer"
        self.assert_one_mismatch(info, "lines[].over_by", "integer", "float")

    def test_tenant_index_without_is_tenant(self):
        info = compatible_info()
        info["payload_schema"]["manager_id"] = {"data_type": "keyword", "points": 0}
        self.assert_one_mismatch(info, "manager_id", "is_tenant")

    def test_reports_every_mismatch(self):
        info = compatible_info()
        info["config"]["params"]["vectors"]["summary"]["size"] = 768
        info["config"]["params"]["sharding_method"] = "auto"
        self.assertEqual(len(drift(info)), 2)


class MissingIndexesTest(unittest.TestCase):
    def test_lists_absent_fields_in_declaration_order(self):
        info = compatible_info()
        del info["payload_schema"]["stage"]
        del info["payload_schema"]["office_id"]
        self.assertEqual(missing_indexes(info), ["office_id", "stage"])

    def test_empty_schema_misses_everything(self):
        info = copy.deepcopy(compatible_info())
        info["payload_schema"] = {}
        self.assertEqual(missing_indexes(info), list(PAYLOAD_INDEXES))


if __name__ == "__main__":
    unittest.main()
