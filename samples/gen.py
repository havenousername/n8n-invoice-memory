"""Q8nten GmbH, an event agency: its six events in production, their Q4 budgets, and the static booth documents.

Run: python3 samples/gen.py writes offices.json and manifest.json; node samples/render.mjs renders the PDFs.
The live stream of documents is written by the AI workers in n8n (00 Working day), not here.
"""

import json
import sys
from pathlib import Path

SAMPLES_DIR = Path(__file__).resolve().parent
CATEGORIES = ("people", "cloud", "gpu", "office", "travel")

# Internal ids stay office_id/code and the five category keys; what people see is the event and the budget line.
# Category keys -> lines: people = crew and staffing, cloud = marketing, gpu = stage and AV, office = venue,
# travel = catering (German labels in workflows/code/pdf.js).
# office_id: code, name, region, manager_id, manager_name, worker_id, worker_name, cost_center, event_date, budgets in CATEGORIES order
_OFFICES = (
    ("berlin", "ber", "DevSummit Berlin", "DACH", "m_anna", "Anna", "w_tom", "Tom", "CC-BER-01", "2026-11-10", (160000, 90000, 120000, 220000, 180000)),
    ("munich", "muc", "CloudTage München", "DACH", "m_anna", "Anna", "w_tom", "Tom", "CC-MUC-01", "2026-11-24", (120000, 70000, 150000, 160000, 140000)),
    ("vienna", "vie", "AI Forum Wien", "DACH", "m_anna", "Anna", "w_lena", "Lena", "CC-VIE-01", "2026-12-03", (90000, 50000, 80000, 120000, 100000)),
    ("amsterdam", "ams", "DataWeek Amsterdam", "International", "m_ben", "Ben", "w_jules", "Jules", "CC-AMS-01", "2026-11-17", (110000, 80000, 100000, 150000, 130000)),
    ("paris", "par", "Paris Tech Days", "International", "m_ben", "Ben", "w_jules", "Jules", "CC-PAR-01", "2026-12-08", (130000, 100000, 140000, 200000, 160000)),
    ("london", "lon", "FinTech Expo London", "International", "m_ben", "Ben", "w_mia", "Mia", "CC-LON-01", "2026-10-29", (170000, 140000, 160000, 260000, 210000)),
)

# file, office_id, doc_type, doc_key, version, date, counterparty, category, amount, description_de, description_en, role
_STATIC = (
    ("ber-po-1042-v1.pdf", "berlin", "cost", "PO-1042", 1, "2026-10-06", "Lichtwerk Veranstaltungstechnik GmbH", "gpu", 48000.00,
     "Bühne, Licht und Ton für die Hauptbühne, Anzahlung", "Main stage light and sound, deposit", "booth"),
    ("ber-po-1042-v2.pdf", "berlin", "cost", "PO-1042", 2, "2026-10-13", "Lichtwerk Veranstaltungstechnik GmbH", "gpu", 132000.00,
     "Hauptbühne erweitert: zwei LED-Wände und eine zweite Bühne für den Sponsor-Keynote-Track",
     "Main stage expanded: two LED walls and a second stage for the sponsor keynote track", "booth"),
    ("muc-po-2041-v1.pdf", "munich", "cost", "PO-2041", 1, "2026-10-08", "Isar Catering GmbH", "travel", 12300.00,
     "Catering für Konferenztag 1, 300 Gäste", "Catering for conference day 1, 300 guests", "booth"),
    ("ams-deal-3101-v1.pdf", "amsterdam", "deal", "DEAL-3101", 1, "2026-10-07", "Nordzee Data B.V.", None, 60000.00,
     "Gold-Sponsoring inklusive Keynote-Slot", "Gold sponsorship including a keynote slot", "gate"),
    ("par-cn-4101-v1.pdf", "paris", "credit", "CN-4101", 1, "2026-10-09", "Salle Lumière SAS", "office", 4800.00,
     "Gutschrift für den stornierten Breakout-Raum", "Credit for the cancelled breakout room", "gate"),
)
_DUPLICATES = (("ber-po-1042-v1-copy.pdf", "ber-po-1042-v1.pdf"),)


def offices() -> list[dict]:
    return [
        {"office_id": office_id, "code": code, "name": name, "region": region, "manager_id": manager_id,
         "manager_name": manager_name, "worker_id": worker_id, "worker_name": worker_name, "cost_center": cost_center,
         "event_date": event_date, "budgets": dict(zip(CATEGORIES, budgets))}
        for office_id, code, name, region, manager_id, manager_name, worker_id, worker_name, cost_center, event_date, budgets in _OFFICES
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
