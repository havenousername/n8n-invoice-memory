import unittest

from env import Settings
from qdrant_api import connect
from transport import HttpError

SETTINGS = Settings(qdrant_url="https://q:6333", qdrant_api_key="secret")


class ConnectTest(unittest.TestCase):
    def test_prefixes_url_sends_api_key_and_returns_result(self):
        calls = []

        def fake_send(method, url, *, headers=None, body=None, timeout=30.0):
            calls.append((method, url, headers, body))
            return {"result": {"status": "green"}, "status": "ok", "time": 0.001}

        call = connect(SETTINGS, send=fake_send)
        self.assertEqual(call("PUT", "/collections/c", {"x": 1}), {"status": "green"})
        self.assertEqual(calls, [("PUT", "https://q:6333/collections/c", {"api-key": "secret"}, {"x": 1})])

    def test_http_error_propagates_unchanged(self):
        error = HttpError(404, {"status": {"error": "Not found"}}, "GET", "https://q:6333/collections/c")

        def failing_send(method, url, *, headers=None, body=None, timeout=30.0):
            raise error

        with self.assertRaises(HttpError) as caught:
            connect(SETTINGS, send=failing_send)("GET", "/collections/c")
        self.assertIs(caught.exception, error)


if __name__ == "__main__":
    unittest.main()
