import json
import socket
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from transport import HttpError, TransportError, send

# path -> (status, raw response body)
ROUTES = {
    "/ok": (200, b'{"result": 1}'),
    "/missing": (404, b'{"status": {"error": "Not found"}}'),
    "/empty": (200, b""),
    "/html": (200, b"<html>not json</html>"),
}


class Handler(BaseHTTPRequestHandler):
    def _respond(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        self.server.seen = {  # type: ignore[attr-defined]
            "method": self.command,
            "path": self.path,
            "headers": self.headers,  # case-insensitive lookup
            "body": self.rfile.read(length),
        }
        status, body = ROUTES[self.path]
        self.send_response(status)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_PUT = do_POST = _respond

    def log_message(self, *args) -> None:
        pass


class SendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_decodes_json_and_sends_json_body_with_headers(self):
        result = send("PUT", f"{self.base}/ok", headers={"api-key": "k"}, body={"a": [1, 2]})
        self.assertEqual(result, {"result": 1})
        seen = self.server.seen
        self.assertEqual(seen["method"], "PUT")
        self.assertEqual(json.loads(seen["body"]), {"a": [1, 2]})
        self.assertEqual(seen["headers"]["content-type"], "application/json")
        self.assertEqual(seen["headers"]["api-key"], "k")

    def test_error_status_raises_http_error_with_decoded_body(self):
        with self.assertRaises(HttpError) as caught:
            send("GET", f"{self.base}/missing")
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(caught.exception.body, {"status": {"error": "Not found"}})
        self.assertIn("GET", str(caught.exception))

    def test_empty_body_returns_none(self):
        self.assertIsNone(send("GET", f"{self.base}/empty"))

    def test_non_json_success_raises_transport_error(self):
        with self.assertRaises(TransportError):
            send("GET", f"{self.base}/html")

    def test_refused_connection_raises_transport_error(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            closed_port = probe.getsockname()[1]
        with self.assertRaises(TransportError):
            send("GET", f"http://127.0.0.1:{closed_port}/", timeout=2)


if __name__ == "__main__":
    unittest.main()
