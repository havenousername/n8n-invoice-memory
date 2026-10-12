"""Synthetic invoices: HTML pages and samples/manifest.json. Fake companies only, no real debt.

Run: python3 samples/gen.py, then samples/print.sh prints the pages to PDF with headless Chrome.
"""

import dataclasses
import html
import json
import sys
from pathlib import Path
from types import MappingProxyType

SAMPLES_DIR = Path(__file__).resolve().parent
BOOTH_DATE = "2026-10-14"  # every printed status agrees with its due date on this day

# slug -> (worker_id, display name). w_tom and w_lena report to m_anna; w_jules and w_mia to m_ben.
CUSTOMERS = MappingProxyType({
    "acme": ("w_tom", "Acme GmbH"),
    "beta": ("w_tom", "Beta Logistics AG"),
    "gamma": ("w_lena", "Gamma Labs UG"),
    "delta": ("w_jules", "Delta Retail SE"),
    "eps": ("w_jules", "Epsilon Media GmbH"),
    "zeta": ("w_mia", "Zeta Energy KG"),
})


@dataclasses.dataclass(frozen=True)
class Invoice:
    file: str
    customer: str
    invoice_no: str
    date: str
    due_date: str
    amount: float
    status: str
    vendor: str
    items: str
    number_format: str  # "en" (4,250.00 EUR) or "de" (12.300,00 €)
    duplicate_of: str | None = None


_BETA_003 = Invoice("beta-003.pdf", "beta", "INV-9003", "2026-10-02", "2026-11-01", 640.00, "open",
                    "Office Depot", "office supplies, pallets", "en")

INVOICES = (
    Invoice("acme-001.pdf", "acme", "INV-4711", "2026-09-01", "2026-09-15", 12300.00, "overdue",
            "Hetzner Online GmbH", "Hetzner servers, rack 12, September", "de"),
    Invoice("acme-002.pdf", "acme", "INV-4730", "2026-09-20", "2026-10-20", 4250.00, "open",
            "Hetzner Online GmbH", "Hetzner servers, bandwidth overage", "en"),
    Invoice("acme-003.pdf", "acme", "INV-4750", "2026-10-01", "2026-10-31", 980.00, "open",
            "Jetbrains s.r.o.", "IDE licenses, 4 seats", "en"),
    Invoice("beta-001.pdf", "beta", "INV-9001", "2026-08-10", "2026-08-24", 18750.00, "overdue",
            "Deloitte GmbH", "consulting, warehouse audit", "de"),
    Invoice("beta-002.pdf", "beta", "INV-9002", "2026-09-12", "2026-10-26", 2100.00, "open",
            "Deloitte GmbH", "consulting, follow-up workshop", "en"),
    _BETA_003,
    dataclasses.replace(_BETA_003, file="beta-004.pdf", duplicate_of="beta-003.pdf"),
    Invoice("gamma-001.pdf", "gamma", "INV-2201", "2026-09-05", "2026-10-05", 1500.00, "paid",
            "Microsoft Ireland", "Office licenses, annual", "en"),
    Invoice("gamma-002.pdf", "gamma", "INV-2202", "2026-10-03", "2026-11-02", 3200.00, "open",
            "Microsoft Ireland", "Azure compute, September", "en"),
    Invoice("delta-001.pdf", "delta", "INV-5100", "2026-09-02", "2026-10-30", 7600.00, "open",
            "Hetzner Online GmbH", "Hetzner servers, store backend", "en"),
    Invoice("delta-002.pdf", "delta", "INV-5101", "2026-09-28", "2026-10-28", 1250.00, "open",
            "Shopify Inc.", "platform fees, September", "en"),
    Invoice("eps-001.pdf", "eps", "INV-3300", "2026-09-15", "2026-10-15", 9800.00, "open",
            "Adobe Systems", "Creative licenses, 10 seats", "en"),
    Invoice("eps-002.pdf", "eps", "INV-3301", "2026-10-04", "2026-11-03", 450.00, "open",
            "Canva Pty", "design subscription", "en"),
    Invoice("zeta-001.pdf", "zeta", "INV-7700", "2026-09-08", "2026-10-08", 5400.00, "paid",
            "Siemens AG", "turbine inspection, consulting", "en"),
)

_PAGE = """<!doctype html><html><head><meta charset="utf-8"><style>
body{{font-family:Helvetica,Arial,sans-serif;margin:48px;color:#111}} h1{{letter-spacing:.1em}}
table{{border-collapse:collapse;width:100%;margin-top:24px}}
td,th{{border-bottom:1px solid #ccc;padding:8px;text-align:left}} .total{{font-size:1.4em;margin-top:24px}}
.meta td{{border:0;padding:2px 8px 2px 0}}
</style></head><body>
<h1>{title}</h1>
<table class="meta"><tr><td>Invoice No: {invoice_no}</td></tr><tr><td>Date: {date}</td></tr>
<tr><td>Due date: {due_date}</td></tr><tr><td>From: {vendor}</td></tr><tr><td>To: {customer}</td></tr>
<tr><td>Status: {status}</td></tr></table>
<table><tr><th>Description</th><th>Qty</th><th>Amount</th></tr>
<tr><td>{items}</td><td>1</td><td>{amount}</td></tr></table>
<p class="total">Total: {amount}</p>
<p style="color:#888;font-size:.8em">Synthetic invoice for a demo. Not a real company, not a real debt.</p>
</body></html>
"""


def money(amount: float, number_format: str) -> str:
    english = f"{amount:,.2f}"
    if number_format == "de":
        return english.replace(",", "X").replace(".", ",").replace("X", ".") + " €"
    return english + " EUR"


def render_html(invoice: Invoice) -> str:
    fields = {
        "title": "RECHNUNG" if invoice.number_format == "de" else "INVOICE",
        "invoice_no": invoice.invoice_no,
        "date": invoice.date,
        "due_date": invoice.due_date,
        "vendor": invoice.vendor,
        "customer": CUSTOMERS[invoice.customer][1],
        "status": invoice.status,
        "items": invoice.items,
        "amount": money(invoice.amount, invoice.number_format),
    }
    return _PAGE.format(**{key: html.escape(value) for key, value in fields.items()})


def manifest_row(invoice: Invoice) -> dict:
    row = {
        "file": invoice.file,
        "worker_id": CUSTOMERS[invoice.customer][0],
        "customer": invoice.customer,
        "customer_name": CUSTOMERS[invoice.customer][1],
        "invoice_no": invoice.invoice_no,
        "expected_amount": invoice.amount,
        "status": invoice.status,
        "items": invoice.items,
        "format": invoice.number_format,
    }
    if invoice.duplicate_of:
        row["duplicate_of"] = invoice.duplicate_of
    return row


def build(invoices: tuple[Invoice, ...] = INVOICES) -> tuple[dict[str, str], list[dict]]:
    """HTML pages by file name (duplicates are copied as PDFs, not rendered) and the manifest rows."""
    pages = {i.file.removesuffix(".pdf") + ".html": render_html(i) for i in invoices if not i.duplicate_of}
    return pages, [manifest_row(i) for i in invoices]


def main() -> int:
    pages, manifest = build()
    html_dir = SAMPLES_DIR / "html"
    html_dir.mkdir(exist_ok=True)
    for name, page in pages.items():
        (html_dir / name).write_text(page)
    (SAMPLES_DIR / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {len(pages)} pages and {len(manifest)} manifest rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
