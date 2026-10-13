import unittest

from gen import CATEGORIES, offices, static_documents

# Event budgets per line, in CATEGORIES order: crew, marketing, stage and AV, venue, catering.
BUDGETS = {
    "berlin": (160000, 90000, 120000, 220000, 180000),
    "munich": (120000, 70000, 150000, 160000, 140000),
    "vienna": (90000, 50000, 80000, 120000, 100000),
    "amsterdam": (110000, 80000, 100000, 150000, 130000),
    "paris": (130000, 100000, 140000, 200000, 160000),
    "london": (170000, 140000, 160000, 260000, 210000),
}
PEOPLE = {
    "berlin": ("ber", "DevSummit Berlin", "DACH", "m_anna", "Anna", "w_tom", "Tom", "CC-BER-01", "2026-11-10"),
    "munich": ("muc", "CloudTage München", "DACH", "m_anna", "Anna", "w_tom", "Tom", "CC-MUC-01", "2026-11-24"),
    "vienna": ("vie", "AI Forum Wien", "DACH", "m_anna", "Anna", "w_lena", "Lena", "CC-VIE-01", "2026-12-03"),
    "amsterdam": ("ams", "DataWeek Amsterdam", "International", "m_ben", "Ben", "w_jules", "Jules", "CC-AMS-01", "2026-11-17"),
    "paris": ("par", "Paris Tech Days", "International", "m_ben", "Ben", "w_jules", "Jules", "CC-PAR-01", "2026-12-08"),
    "london": ("lon", "FinTech Expo London", "International", "m_ben", "Ben", "w_mia", "Mia", "CC-LON-01", "2026-10-29"),
}


class OfficesTest(unittest.TestCase):
    def test_six_offices_with_their_people_and_budgets(self):
        by_id = {o["office_id"]: o for o in offices()}
        self.assertEqual(set(by_id), set(PEOPLE))
        for office_id, (code, name, region, manager_id, manager_name, worker_id, worker_name, cost_center, event_date) in PEOPLE.items():
            o = by_id[office_id]
            with self.subTest(office_id):
                self.assertEqual(
                    (o["code"], o["name"], o["region"], o["manager_id"], o["manager_name"], o["worker_id"], o["worker_name"], o["cost_center"], o["event_date"]),
                    (code, name, region, manager_id, manager_name, worker_id, worker_name, cost_center, event_date),
                )
                self.assertEqual(tuple(o["budgets"][c] for c in CATEGORIES), BUDGETS[office_id])

    def test_categories_in_order(self):
        self.assertEqual(CATEGORIES, ("people", "cloud", "gpu", "office", "travel"))


class StaticDocumentsTest(unittest.TestCase):
    def setUp(self):
        self.docs = {d["file"]: d for d in static_documents()}
        self.offices = {o["office_id"]: o for o in offices()}

    def test_the_six_files(self):
        self.assertEqual(set(self.docs), {
            "ber-po-1042-v1.pdf", "ber-po-1042-v1-copy.pdf", "ber-po-1042-v2.pdf",
            "muc-po-2041-v1.pdf", "ams-deal-3101-v1.pdf", "par-cn-4101-v1.pdf",
        })

    def test_roles(self):
        roles = {f: d["role"] for f, d in self.docs.items()}
        self.assertEqual({f for f, r in roles.items() if r == "gate"}, {"ams-deal-3101-v1.pdf", "par-cn-4101-v1.pdf"})
        self.assertEqual(set(roles.values()), {"booth", "gate"})

    def test_file_names_follow_the_convention(self):
        for file, d in self.docs.items():
            code = self.offices[d["office_id"]]["code"]
            stem = f"{code}-{d['doc_key'].lower()}-v{d['version']}"
            with self.subTest(file):
                self.assertIn(file, (stem + ".pdf", stem + "-copy.pdf"))

    def test_amendment_raises_berlin_gpu_past_its_budget(self):
        v1, v2 = self.docs["ber-po-1042-v1.pdf"], self.docs["ber-po-1042-v2.pdf"]
        self.assertEqual((v1["doc_key"], v1["version"], v2["doc_key"], v2["version"]), ("PO-1042", 1, "PO-1042", 2))
        self.assertGreater(v2["amount"], v1["amount"])
        self.assertGreater(v2["amount"], self.offices["berlin"]["budgets"]["gpu"])
        self.assertEqual(v2["category"], "gpu")
        self.assertEqual(v2["counterparty"], "Lichtwerk Veranstaltungstechnik GmbH")
        self.assertIn("LED walls", v2["description_en"])
        self.assertIn("sponsor keynote", v2["description_en"])

    def test_copy_is_a_duplicate_of_the_original(self):
        copy, original = self.docs["ber-po-1042-v1-copy.pdf"], self.docs["ber-po-1042-v1.pdf"]
        self.assertEqual(copy["duplicate_of"], "ber-po-1042-v1.pdf")
        strip = lambda d: {k: v for k, v in d.items() if k not in ("file", "duplicate_of")}
        self.assertEqual(strip(copy), strip(original))

    def test_munich_booth_document(self):
        d = self.docs["muc-po-2041-v1.pdf"]
        self.assertEqual((d["office_id"], d["doc_type"], d["counterparty"], d["category"], d["amount"]),
                         ("munich", "cost", "Isar Catering GmbH", "travel", 12300.0))

    def test_gate_documents_cover_a_deal_and_a_credit(self):
        deal, credit = self.docs["ams-deal-3101-v1.pdf"], self.docs["par-cn-4101-v1.pdf"]
        self.assertEqual((deal["doc_type"], deal["category"], deal["amount"]), ("deal", None, 60000.0))
        self.assertIn("sponsorship", deal["description_en"])
        self.assertEqual(credit["doc_type"], "credit")
        self.assertIn(credit["category"], CATEGORIES)

    def test_types_keys_amounts_and_tenancy(self):
        prefix = {"cost": "PO", "deal": "DEAL", "credit": "CN"}
        for file, d in self.docs.items():
            office = self.offices[d["office_id"]]
            with self.subTest(file):
                self.assertTrue(d["doc_key"].startswith(prefix[d["doc_type"]] + "-"))
                self.assertTrue(1000 <= d["amount"] < 1000000)
                self.assertEqual((d["manager_id"], d["worker_id"]), (office["manager_id"], office["worker_id"]))
                self.assertRegex(d["date"], r"^2026-10-\d\d$")
                self.assertTrue(d["description_de"] and d["description_en"])
                if d["doc_type"] != "deal":
                    self.assertIn(d["category"], CATEGORIES)


if __name__ == "__main__":
    unittest.main()
