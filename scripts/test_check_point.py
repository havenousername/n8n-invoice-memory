import unittest

from check_point import failures, get_path, parse_expectation, show

PAYLOAD = {
    "stage": 1,
    "worker_id": "w_tom",
    "latest": {"id": "inv_1", "amount": 12.3},
    "invoices": [{"error": ""}, {"error": "timeout"}],
}


class GetPathTest(unittest.TestCase):
    def test_nested_dicts(self):
        self.assertEqual(get_path(PAYLOAD, "latest.amount"), 12.3)

    def test_list_index(self):
        self.assertEqual(get_path(PAYLOAD, "invoices.1.error"), "timeout")

    def test_missing_path_names_the_path(self):
        for path in ("latest.nope", "invoices.5.error", "stage.deeper"):
            with self.subTest(path), self.assertRaisesRegex(KeyError, path):
                get_path(PAYLOAD, path)


class ParseExpectationTest(unittest.TestCase):
    def test_values_parse_as_json_with_string_fallback(self):
        self.assertEqual(parse_expectation("stage=1"), ("stage", 1))
        self.assertEqual(parse_expectation("latest.amount=12.3"), ("latest.amount", 12.3))
        self.assertEqual(parse_expectation("worker_id=w_tom"), ("worker_id", "w_tom"))
        self.assertEqual(parse_expectation("latest=null"), ("latest", None))

    def test_splits_on_the_first_equals(self):
        self.assertEqual(parse_expectation("summary_text=a=b"), ("summary_text", "a=b"))

    def test_missing_equals_is_an_error(self):
        with self.assertRaises(ValueError):
            parse_expectation("stage")


class FailuresTest(unittest.TestCase):
    def test_all_hold(self):
        self.assertEqual(failures(PAYLOAD, {"stage": 1, "latest.amount": 12.3}, ["worker_id"], ["deleted_at"]), [])

    def test_wrong_value(self):
        self.assertEqual(failures(PAYLOAD, {"stage": 2}, [], []), ["stage: expected 2, got 1"])

    def test_missing_path_in_expectation(self):
        self.assertEqual(failures(PAYLOAD, {"latest.nope": 1}, [], []), ["latest.nope: expected 1, missing"])

    def test_present_and_absent(self):
        self.assertEqual(failures(PAYLOAD, {}, ["deleted_at"], ["worker_id"]),
                         ["deleted_at: expected present, missing", 'worker_id: expected absent, got "w_tom"'])


class ShowTest(unittest.TestCase):
    def test_prints_path_value_pairs_as_json(self):
        self.assertEqual(show(PAYLOAD, ["stage", "latest.amount", "worker_id", "nope"]),
                         'stage=1 latest.amount=12.3 worker_id="w_tom" nope=<missing>')


if __name__ == "__main__":
    unittest.main()
