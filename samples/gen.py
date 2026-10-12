"""Q8nten GmbH: the offices, their Q4 budgets, and the static documents the booth relies on.

Run: python3 samples/gen.py writes offices.json and manifest.json; node samples/render.mjs renders the PDFs.
The live stream of documents is written by the AI workers in n8n (00 Working day), not here.
"""

import json
import sys
from pathlib import Path

SAMPLES_DIR = Path(__file__).resolve().parent
CATEGORIES = ("people", "cloud", "gpu", "office", "travel")

# office_id: code, name, region, manager_id, manager_name, worker_id, worker_name, cost_center, budgets in CATEGORIES order
_OFFICES = (
    ("berlin", "ber", "Berlin", "Central", "m_anna", "Anna", "w_tom", "Tom", "CC-BER-01", (820000, 180000, 120000, 95000, 60000)),
    ("munich", "muc", "Munich", "Central", "m_anna", "Anna", "w_tom", "Tom", "CC-MUC-01", (760000, 140000, 210000, 90000, 50000)),
    ("vienna", "vie", "Vienna", "Central", "m_anna", "Anna", "w_lena", "Lena", "CC-VIE-01", (540000, 90000, 60000, 70000, 40000)),
    ("amsterdam", "ams", "Amsterdam", "West", "m_ben", "Ben", "w_jules", "Jules", "CC-AMS-01", (610000, 150000, 90000, 80000, 55000)),
    ("paris", "par", "Paris", "West", "m_ben", "Ben", "w_jules", "Jules", "CC-PAR-01", (700000, 120000, 140000, 110000, 70000)),
    ("london", "lon", "London", "West", "m_ben", "Ben", "w_mia", "Mia", "CC-LON-01", (880000, 200000, 160000, 130000, 90000)),
)

# file, office_id, doc_type, doc_key, version, date, counterparty, category, amount, description_de, description_en, role
_STATIC = (
    ("ber-po-1042-v1.pdf", "berlin", "cost", "PO-1042", 1, "2026-10-06", "Rechenwerk Systems GmbH", "gpu", 48000.00,
     "GPU-Server (4x) für den Inferenz-Launch, Anzahlung", "GPU servers (4x) for the inference launch, deposit", "booth"),
    ("ber-po-1042-v2.pdf", "berlin", "cost", "PO-1042", 2, "2026-10-13", "Rechenwerk Systems GmbH", "gpu", 132000.00,
     "GPU-Server (11x) für den Inferenz-Launch, Auftrag erweitert", "GPU servers (11x) for the inference launch, order expanded", "booth"),
    ("muc-po-2041-v1.pdf", "munich", "cost", "PO-2041", 1, "2026-10-08", "Hetzner Online GmbH", "cloud", 12300.00,
     "Dedizierte Server für die Staging-Umgebung, Oktober", "Dedicated servers for the staging environment, October", "booth"),
    ("ams-deal-3101-v1.pdf", "amsterdam", "deal", "DEAL-3101", 1, "2026-10-07", "Van Dijk Logistics B.V.", None, 240000.00,
     "Jahreslizenz Plattform, 120 Arbeitsplätze", "Annual platform license, 120 seats", "gate"),
    ("par-cn-4101-v1.pdf", "paris", "credit", "CN-4101", 1, "2026-10-09", "Atelier Cloud SAS", "cloud", 4800.00,
     "Gutschrift für den Ausfall im September", "Credit for the September outage", "gate"),
)
_DUPLICATES = (("ber-po-1042-v1-copy.pdf", "ber-po-1042-v1.pdf"),)


def offices() -> list[dict]:
    return [
        {"office_id": office_id, "code": code, "name": name, "region": region, "manager_id": manager_id,
         "manager_name": manager_name, "worker_id": worker_id, "worker_name": worker_name, "cost_center": cost_center,
         "budgets": dict(zip(CATEGORIES, budgets))}
        for office_id, code, name, region, manager_id, manager_name, worker_id, worker_name, cost_center, budgets in _OFFICES
    ]


def static_documents() -> list[dict]:
    by_office = {o["office_id"]: o for o in offices()}
    docs = []
    for file, office_id, doc_type, key, version, date, counterparty, category, amount, de, en, role in _STATIC:
        office = by_office[office_id]
        docs.append({
            "file": file, "office_id": office_id, "manager_id": office["manager_id"], "worker_id": office["worker_id"],
            "doc_type": doc_type, "doc_key": key, "version": version, "date": date, "counterparty": counterparty,
            "category": category, "amount": amount, "description_de": de, "description_en": en, "role": role,
            "duplicate_of": None,
        })
    by_file = {d["file"]: d for d in docs}
    for copy, original in _DUPLICATES:
        docs.append({**by_file[original], "file": copy, "duplicate_of": original})
    return docs


def main() -> int:
    (SAMPLES_DIR / "offices.json").write_text(json.dumps(offices(), indent=1, ensure_ascii=False) + "\n")
    (SAMPLES_DIR / "manifest.json").write_text(json.dumps(static_documents(), indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {len(offices())} offices and {len(static_documents())} static documents")
    return 0


if __name__ == "__main__":
    sys.exit(main())
