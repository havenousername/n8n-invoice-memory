import base64
import json
import tempfile
import unittest
from pathlib import Path

from openrouter_check import REQUIRED_FIELDS, ExtractionError, extraction_body, parse_reply, require_synthetic

PDF = b"%PDF-1.4 synthetic invoice"
GOOD = {
    "invoice_no": "INV-4711", "date": "2026-09-01", "due_date": "2026-09-15", "amount": 12300,
    "vendor": "Hetzner Online GmbH", "customer_name": "Acme GmbH", "status": "overdue",
    "line_items_summary": "Hetzner servers, rack 12",
}


def reply(content) -> dict:
    return {"choices": [{"message": {"role": "assistant", "content": content}}]}


class ExtractionBodyTest(unittest.TestCase):
    def setUp(self):
        self.body = extraction_body(PDF, "anthropic/claude-haiku-5.5", "native")

    def test_model_settings_and_json_mode(self):
        self.assertEqual(self.body["model"], "anthropic/claude-haiku-5.5")
        self.assertEqual(self.body["temperature"], 0)
        self.assertEqual(self.body["max_tokens"], 400)
        self.assertEqual(self.body["response_format"], {"type": "json_object"})
        self.assertEqual(self.body["plugins"], [{"id": "file-parser", "pdf": {"engine": "native"}}])

    def test_engine_is_passed_through(self):
        body = extraction_body(PDF, "m", "pdf-text")
        self.assertEqual(body["plugins"][0]["pdf"]["engine"], "pdf-text")

    def test_pdf_travels_as_a_base64_data_url(self):
        user = self.body["messages"][1]
        file_part = next(part for part in user["content"] if part["type"] == "file")
        prefix = "data:application/pdf;base64,"
        data_url = file_part["file"]["file_data"]
        self.assertTrue(data_url.startswith(prefix))
        self.assertEqual(base64.b64decode(data_url[len(prefix):]), PDF)

    def test_system_prompt_names_every_field(self):
        system = self.body["messages"][0]
        self.assertEqual(system["role"], "system")
        for field in REQUIRED_FIELDS:
            self.assertIn(field, system["content"])


class ParseReplyTest(unittest.TestCase):
    def test_returns_the_fields(self):
        self.assertEqual(parse_reply(reply(json.dumps(GOOD))), GOOD)

    def test_no_choices_is_an_error(self):
        with self.assertRaisesRegex(ExtractionError, "no choices"):
            parse_reply({"error": {"message": "model unavailable"}})

    def test_fenced_json_fails_like_n8n_json_parse_would(self):
        with self.assertRaisesRegex(ExtractionError, "not bare JSON"):
            parse_reply(reply("```json\n" + json.dumps(GOOD) + "\n```"))

    def test_empty_content_is_an_error(self):
        with self.assertRaisesRegex(ExtractionError, "not bare JSON"):
            parse_reply(reply(None))

    def test_json_that_is_not_an_object_is_an_error(self):
        with self.assertRaisesRegex(ExtractionError, "object"):
            parse_reply(reply("[1, 2]"))

    def test_names_every_missing_field(self):
        partial = {k: v for k, v in GOOD.items() if k not in ("vendor", "due_date")}
        with self.assertRaisesRegex(ExtractionError, "due_date, vendor"):
            parse_reply(reply(json.dumps(partial)))


class RequireSyntheticTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.samples = self.root / "samples"
        self.samples.mkdir()
        (self.samples / "acme-001.pdf").write_bytes(PDF)
        (self.root / "real-invoice.pdf").write_bytes(PDF)

    def test_accepts_a_sample(self):
        path = require_synthetic(self.samples / "acme-001.pdf", self.samples)
        self.assertEqual(path, (self.samples / "acme-001.pdf").resolve())

    def test_rejects_a_pdf_outside_samples(self):
        with self.assertRaises(ValueError):
            require_synthetic(self.root / "real-invoice.pdf", self.samples)

    def test_rejects_a_dotdot_escape(self):
        with self.assertRaises(ValueError):
            require_synthetic(self.samples / ".." / "real-invoice.pdf", self.samples)

    def test_rejects_a_symlink_that_points_outside(self):
        (self.samples / "link.pdf").symlink_to(self.root / "real-invoice.pdf")
        with self.assertRaises(ValueError):
            require_synthetic(self.samples / "link.pdf", self.samples)

    def test_rejects_a_non_pdf(self):
        (self.samples / "manifest.json").write_text("[]")
        with self.assertRaises(ValueError):
            require_synthetic(self.samples / "manifest.json", self.samples)


if __name__ == "__main__":
    unittest.main()
