import dataclasses
import unittest

from gen import BOOTH_DATE, CUSTOMERS, INVOICES, build, money, render_html

ANNA_WORKERS = {"w_tom", "w_lena"}


class ManifestTest(unittest.TestCase):
    def setUp(self):
        self.pages, self.manifest = build()

    def test_corpus_shape(self):
        self.assertEqual(len(self.manifest), 14)
        self.assertEqual(len({r["file"] for r in self.manifest}), 14)
        self.assertEqual(sum(1 for r in self.manifest if r["format"] == "de"), 2)
        self.assertEqual(len({r["customer"] for r in self.manifest}), 6)
        self.assertEqual({r["worker_id"] for r in self.manifest}, {"w_tom", "w_lena", "w_jules", "w_mia"})

    def test_one_byte_identical_duplicate(self):
        duplicates = [r for r in self.manifest if r.get("duplicate_of")]
        self.assertEqual([(r["file"], r["duplicate_of"]) for r in duplicates], [("beta-004.pdf", "beta-003.pdf")])
        original = next(r for r in self.manifest if r["file"] == "beta-003.pdf")
        strip = lambda r: {k: v for k, v in r.items() if k not in ("file", "duplicate_of")}
        self.assertEqual(strip(duplicates[0]), strip(original))

    def test_rows_carry_the_customer_display_name(self):
        names = {r["customer"]: r["customer_name"] for r in self.manifest}
        self.assertEqual(names["acme"], "Acme GmbH")
        self.assertEqual(names, {slug: name for slug, (_, name) in CUSTOMERS.items()})

    def test_file_names_start_with_the_customer_slug(self):
        for row in self.manifest:
            self.assertTrue(row["file"].startswith(row["customer"] + "-"), row["file"])

    def test_overdue_filter_hits_two_customers(self):
        hits = {r["customer"] for r in self.manifest if r["status"] == "overdue" and r["expected_amount"] >= 10000}
        self.assertEqual(hits, {"acme", "beta"})

    def test_search_terms_hit_known_customers_for_anna(self):
        expected = {"servers": {"acme"}, "consulting": {"beta"}, "licenses": {"acme", "gamma"}}
        for term, customers in expected.items():
            hits = {r["customer"] for r in self.manifest if r["worker_id"] in ANNA_WORKERS and term in r["items"]}
            self.assertEqual(hits, customers, term)

    def test_statuses_agree_with_due_dates_on_booth_day(self):
        for invoice in INVOICES:
            if invoice.status != "paid":
                self.assertEqual(invoice.status == "overdue", invoice.due_date < BOOTH_DATE, invoice.file)


class RenderTest(unittest.TestCase):
    def setUp(self):
        self.pages, _ = build()

    def test_one_page_per_original_invoice(self):
        self.assertEqual(len(self.pages), 13)
        self.assertNotIn("beta-004.html", self.pages)

    def test_page_carries_the_fields_the_readers_need(self):
        for invoice in INVOICES:
            if invoice.duplicate_of:
                continue
            page = self.pages[invoice.file.replace(".pdf", ".html")]
            self.assertIn(f"Invoice No: {invoice.invoice_no}", page)
            self.assertIn(f"Due date: {invoice.due_date}", page)
            self.assertIn(f"Total: {money(invoice.amount, invoice.number_format)}", page)
            self.assertIn(CUSTOMERS[invoice.customer][1], page)

    def test_german_pages_use_german_numbers(self):
        german = {i.file: self.pages[i.file.replace(".pdf", ".html")] for i in INVOICES if i.number_format == "de"}
        self.assertEqual(set(german), {"acme-001.pdf", "beta-001.pdf"})
        self.assertIn("Total: 12.300,00 €", german["acme-001.pdf"])
        self.assertIn("Total: 18.750,00 €", german["beta-001.pdf"])
        self.assertTrue(all("RECHNUNG" in page for page in german.values()))

    def test_text_is_escaped(self):
        hostile = dataclasses.replace(INVOICES[0], vendor="<script>x</script>")
        self.assertIn("&lt;script&gt;", render_html(hostile))
        self.assertNotIn("<script>", render_html(hostile))


class MoneyTest(unittest.TestCase):
    def test_formats(self):
        self.assertEqual(money(12300, "de"), "12.300,00 €")
        self.assertEqual(money(4250, "en"), "4,250.00 EUR")
        self.assertEqual(money(980, "en"), "980.00 EUR")


if __name__ == "__main__":
    unittest.main()
