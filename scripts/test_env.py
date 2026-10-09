import tempfile
import unittest
from pathlib import Path

from env import MissingSetting, load_settings, parse_dotenv

NOWHERE = Path("/nonexistent/.env")


class ParseDotenvTest(unittest.TestCase):
    def test_reads_pairs_and_skips_blanks_and_comments(self):
        text = "# comment\n\nQDRANT_URL=https://x\n  # indented comment\nQDRANT_API_KEY=k\n"
        self.assertEqual(parse_dotenv(text), {"QDRANT_URL": "https://x", "QDRANT_API_KEY": "k"})

    def test_strips_one_pair_of_matching_quotes(self):
        self.assertEqual(parse_dotenv("A=\"x y\"\nB='z'\nC=\"unbalanced'"), {"A": "x y", "B": "z", "C": "\"unbalanced'"})

    def test_keeps_equals_inside_value(self):
        self.assertEqual(parse_dotenv("KEY=a=b=c"), {"KEY": "a=b=c"})

    def test_line_without_equals_names_its_line_number(self):
        with self.assertRaisesRegex(ValueError, "line 2"):
            parse_dotenv("A=1\nnot a pair\n")


class LoadSettingsTest(unittest.TestCase):
    def _env_file(self, text: str) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / ".env"
        path.write_text(text)
        return path

    def test_environment_overrides_file(self):
        path = self._env_file("QDRANT_URL=https://file\nQDRANT_API_KEY=file-key\n")
        settings = load_settings(["QDRANT_URL"], env_file=path, environ={"QDRANT_URL": "https://env"})
        self.assertEqual(settings.qdrant_url, "https://env")
        self.assertEqual(settings.qdrant_api_key, "file-key")

    def test_missing_file_is_fine_when_environment_has_the_keys(self):
        settings = load_settings(["QDRANT_API_KEY"], env_file=NOWHERE, environ={"QDRANT_API_KEY": "k"})
        self.assertEqual(settings.qdrant_api_key, "k")

    def test_names_every_missing_or_empty_required_key(self):
        with self.assertRaises(MissingSetting) as caught:
            load_settings(["QDRANT_URL", "QDRANT_API_KEY", "N8N_BASE_URL"], env_file=NOWHERE, environ={"QDRANT_API_KEY": ""})
        self.assertEqual(caught.exception.keys, ("QDRANT_URL", "QDRANT_API_KEY", "N8N_BASE_URL"))
        self.assertIn("QDRANT_URL, QDRANT_API_KEY, N8N_BASE_URL", str(caught.exception))

    def test_urls_lose_trailing_slash(self):
        environ = {"QDRANT_URL": "https://q:6333/", "N8N_BASE_URL": "https://n8n/"}
        settings = load_settings([], env_file=NOWHERE, environ=environ)
        self.assertEqual(settings.qdrant_url, "https://q:6333")
        self.assertEqual(settings.n8n_base_url, "https://n8n")

    def test_pdf_engine_defaults_to_native(self):
        self.assertEqual(load_settings([], env_file=NOWHERE, environ={}).pdf_engine, "native")


if __name__ == "__main__":
    unittest.main()
