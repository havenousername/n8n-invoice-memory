import unittest

from gen import CATEGORIES, offices, static_documents

BUDGETS = {
    "berlin": (820000, 180000, 120000, 95000, 60000),
    "munich": (760000, 140000, 210000, 90000, 50000),
    "vienna": (540000, 90000, 60000, 70000, 40000),
    "amsterdam": (610000, 150000, 90000, 80000, 55000),
    "paris": (700000, 120000, 140000, 110000, 70000),
    "london": (880000, 200000, 160000, 130000, 90000),
}
PEOPLE = {
    "berlin": ("ber", "Berlin", "Central", "m_anna", "Anna", "w_tom", "Tom", "CC-BER-01"),
    "munich": ("muc", "Munich", "Central", "m_anna", "Anna", "w_tom", "Tom", "CC-MUC-01"),
    "vienna": ("vie", "Vienna", "Central", "m_anna", "Anna", "w_lena", "Lena", "CC-VIE-01"),
    "amsterdam": ("ams", "Amsterdam", "West", "m_ben", "Ben", "w_jules", "Jules", "CC-AMS-01"),
    "paris": ("par", "Paris", "West", "m_ben", "Ben", "w_jules", "Jules", "CC-PAR-01"),
    "london": ("lon", "London", "West", "m_ben", "Ben", "w_mia", "Mia", "CC-LON-01"),
}


class OfficesTest(unittest.TestCase):
    def test_six_offices_with_their_people_and_budgets(self):
        by_id = {o["office_id"]: o for o in offices()}
        self.assertEqual(set(by_id), set(PEOPLE))
        for office_id, (code, name, region, manager_id, manager_name, worker_id, worker_name, cost_center) in PEOPLE.items():
            o = by_id[office_id]
            with self.subTest(office_id):
                self.assertEqual(
                    (o["code"], o["name"], o["region"], o["manager_id"], o["manager_name"], o["worker_id"], o["worker_name"], o["cost_center"]),
                    (code, name, region, manager_id, manager_name, worker_id, worker_name, cost_center),
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
        self.assertIn("GPU servers", v2["description_en"])
        self.assertIn("inference launch", v2["description_en"])

    def test_copy_is_a_duplicate_of_the_original(self):
        copy, original = self.docs["ber-po-1042-v1-copy.pdf"], self.docs["ber-po-1042-v1.pdf"]
        self.assertEqual(copy["duplicate_of"], "ber-po-1042-v1.pdf")
        strip = lambda d: {k: v for k, v in d.items() if k not in ("file", "duplicate_of")}
        self.assertEqual(strip(copy), strip(original))

    def test_munich_booth_document(self):
        d = self.docs["muc-po-2041-v1.pdf"]
        self.assertEqual((d["office_id"], d["doc_type"], d["counterparty"], d["category"], d["amount"]),
                         ("munich", "cost", "Hetzner Online GmbH", "cloud", 12300.0))

    def test_gate_documents_cover_a_deal_and_a_credit(self):
        deal, credit = self.docs["ams-deal-3101-v1.pdf"], self.docs["par-cn-4101-v1.pdf"]
        self.assertEqual((deal["doc_type"], deal["category"]), ("deal", None))
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
