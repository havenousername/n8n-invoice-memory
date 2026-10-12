"""OpenRouter gate: can the pinned model read one German office document PDF and answer in bare JSON?

Acceptance script: it sends one synthetic sample from samples/ to OpenRouter. Real documents are refused.
"""

import argparse
import base64
import json
import sys
import time
from pathlib import Path

from env import InvalidEnvFile, MissingSetting, load_settings
from transport import HttpError, TransportError, send

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
SAMPLES_DIR = Path(__file__).resolve().parent.parent / "samples"
REQUIRED_FIELDS = (
    "doc_type", "doc_key", "version", "cost_center", "date", "counterparty", "category", "amount", "description_en",
)
# Task 7's vision node sends this exact prompt.
SYSTEM_PROMPT = (
    "You read one German business document of Q8nten GmbH, an event agency: a Bestellung (an order to a supplier), "
    "a Kundenauftrag (a sponsor or exhibitor order), or a Gutschrift (a supplier credit note). Return JSON only with "
    "these keys: doc_type (cost for Bestellung, deal for Kundenauftrag, credit for Gutschrift), doc_key (the "
    "Belegnummer, for example PO-1042), version (the integer after Version), cost_center (the Kostenstelle, for example "
    "CC-BER-01), date (Datum, written DD.MM.YYYY in the document, returned as YYYY-MM-DD), counterparty (the Lieferant "
    "or Kunde), category (people for Personal und Crew, cloud for Marketing und Werbung, gpu for Bühne und Technik, "
    "office for Veranstaltungsort, travel for Catering, none for a Kundenauftrag), amount (Betrag or Auftragswert as a "
    "number: German format uses dots for thousands and a comma for decimals, so 12.300,00 € is 12300), description_en "
    "(the Beschreibung translated to one English sentence)."
)


def document_schema() -> dict:
    """Strict JSON schema for the reply. json_object alone let the model wrap its JSON in a code fence."""
    properties = {
        "doc_type": {"type": "string", "enum": ["cost", "deal", "credit"]},
        "doc_key": {"type": "string", "description": "Belegnummer, for example PO-1042"},
        "version": {"type": "integer"},
        "cost_center": {"type": "string", "description": "Kostenstelle, for example CC-BER-01"},
        "date": {"type": "string", "description": "YYYY-MM-DD, converted from the German DD.MM.YYYY"},
        "counterparty": {"type": "string"},
        "category": {"type": "string", "enum": ["people", "cloud", "gpu", "office", "travel", "none"]},
        "amount": {"type": "number", "description": "EUR as a plain number, converted from German format"},
        "description_en": {"type": "string", "description": "the Beschreibung as one English sentence"},
    }
    return {"type": "object", "properties": properties, "required": list(REQUIRED_FIELDS), "additionalProperties": False}


class ExtractionError(Exception):
    pass


class NotSynthetic(ValueError):
    pass


def extraction_body(pdf: bytes, model: str, engine: str) -> dict:
    data_url = "data:application/pdf;base64," + base64.b64encode(pdf).decode()
    return {
        "model": model,
        "temperature": 0,
        "max_tokens": 400,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "office_document", "strict": True, "schema": document_schema()},
        },
        "plugins": [{"id": "file-parser", "pdf": {"engine": engine}}],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": "Extract the fields."},
                {"type": "file", "file": {"filename": "document.pdf", "file_data": data_url}},
            ]},
        ],
    }


def parse_reply(response: dict) -> dict:
    choices = response.get("choices") or []
    if not choices:
        raise ExtractionError(f"no choices in the response: {response.get('error') or response}")
    content = choices[0].get("message", {}).get("content")
    try:
        fields = json.loads(content)
    except (TypeError, json.JSONDecodeError):
        raise ExtractionError(f"content is not bare JSON: {content!r:.200}") from None
    if not isinstance(fields, dict):
        raise ExtractionError(f"content is JSON but not an object: {content!r:.200}")
    missing = sorted(field for field in REQUIRED_FIELDS if field not in fields)
    if missing:
        raise ExtractionError(f"missing fields: {', '.join(missing)}")
    return fields


def require_synthetic(path: Path, samples_dir: Path) -> Path:
    resolved = path.resolve()
    if resolved.suffix.lower() != ".pdf" or samples_dir.resolve() not in resolved.parents:
        raise NotSynthetic(f"{path} is not a PDF inside {samples_dir}; only synthetic samples may be sent")
    return resolved


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pdf", type=Path, help="a sample PDF, for example samples/muc-po-2041-v1.pdf")
    args = parser.parse_args(argv)
    try:
        settings = load_settings(["OPENROUTER_API_KEY", "OPENROUTER_MODEL"])
        pdf = require_synthetic(args.pdf, SAMPLES_DIR)
        body = extraction_body(pdf.read_bytes(), settings.openrouter_model, settings.pdf_engine)
        started = time.monotonic()
        response = send(
            "POST", OPENROUTER_URL,
            headers={"Authorization": f"Bearer {settings.openrouter_api_key}"}, body=body, timeout=35,
        )
        latency_ms = round((time.monotonic() - started) * 1000)
        fields = parse_reply(response)
    except (InvalidEnvFile, MissingSetting, NotSynthetic, HttpError, TransportError, ExtractionError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"model: {settings.openrouter_model} (engine {settings.pdf_engine})")
    print(f"fields: {json.dumps(fields, ensure_ascii=False)}")
    print(f"latency_ms: {latency_ms}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
