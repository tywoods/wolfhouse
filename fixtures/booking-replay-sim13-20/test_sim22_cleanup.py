"""Sim22 cleanup manifest controls; not a fabricated historical E2E replay."""
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent

class Sim22CleanupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = json.loads((ROOT / "sim22_cases.json").read_text())["cases"]

    def test_all_five_masked_cases_are_accounted_for(self):
        self.assertEqual([row["id"] for row in self.cases], [
            "sim22-g1-lucia", "sim22-g2-french-group", "sim22-g3-becker",
            "sim22-g4-emma-unanswered", "sim22-g5-raj"])

    def test_becker_frozen_commercial_contract(self):
        row = self.cases[2]
        self.assertEqual(row["beds"], ["R4-B1", "R4-B2"])
        self.assertEqual((row["total_cents"], row["deposit_cents"]), (24000, 20000))

    def test_unanswered_emma_is_not_rewritten_as_success(self):
        row = self.cases[3]
        self.assertEqual(row["expected"], "eligibility_unsure_no_booking")
        self.assertNotIn("historical_booking", row)

    def test_raj_equality_is_one_full_payment_instruction(self):
        row = self.cases[4]
        self.assertEqual(row["total_cents"], row["deposit_cents"])
        self.assertEqual(row["expected"], "single_full_payment_line")

if __name__ == "__main__":
    unittest.main(verbosity=2)
