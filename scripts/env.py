"""Settings for the scripts: the repo's .env file, overridden by the real environment."""

import os
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

DEFAULT_ENV_FILE = Path(__file__).resolve().parent.parent / ".env"

# environment key -> Settings field
_FIELDS = {
    "QDRANT_URL": "qdrant_url",
    "QDRANT_API_KEY": "qdrant_api_key",
    "OPENROUTER_API_KEY": "openrouter_api_key",
    "OPENROUTER_MODEL": "openrouter_model",
    "PDF_ENGINE": "pdf_engine",
    "N8N_BASE_URL": "n8n_base_url",
    "N8N_DASHBOARD_SECRET": "n8n_dashboard_secret",
}
_URL_KEYS = ("QDRANT_URL", "N8N_BASE_URL")


@dataclass(frozen=True)
class Settings:
    qdrant_url: str = ""
    qdrant_api_key: str = ""
    openrouter_api_key: str = ""
    openrouter_model: str = ""
    pdf_engine: str = "native"
    n8n_base_url: str = ""
    n8n_dashboard_secret: str = ""


class MissingSetting(Exception):
    def __init__(self, keys: tuple[str, ...]):
        super().__init__(f"missing settings: {', '.join(keys)} (set them in .env or the environment)")
        self.keys = keys


class InvalidEnvFile(ValueError):
    pass


def parse_dotenv(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator:
            raise InvalidEnvFile(f".env line {number} has no '='")
        values[key.strip()] = _unquote(value.strip())
    return values


def load_settings(
    required: Iterable[str],
    env_file: Path = DEFAULT_ENV_FILE,
    environ: Mapping[str, str] = os.environ,
) -> Settings:
    required = tuple(required)
    unknown = [key for key in required if key not in _FIELDS]
    if unknown:
        raise KeyError(f"unknown settings requested: {', '.join(unknown)}")
    file_values = parse_dotenv(env_file.read_text()) if env_file.is_file() else {}
    merged = {**file_values, **{k: v for k, v in environ.items() if k in _FIELDS}}
    missing = tuple(key for key in required if not merged.get(key))
    if missing:
        raise MissingSetting(missing)
    for key in _URL_KEYS:
        if key in merged:
            merged[key] = merged[key].rstrip("/")
    # An empty value means unset, so the field keeps its default.
    return Settings(**{_FIELDS[k]: v for k, v in merged.items() if k in _FIELDS and v})


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value
