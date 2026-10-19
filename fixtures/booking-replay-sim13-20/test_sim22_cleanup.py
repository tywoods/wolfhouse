"""Sim22 cleanup manifest controls; not a fabricated historical E2E replay."""
import io
import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
REPO = ROOT.parents[1]
STAGING = REPO / "docker" / "hermes-staging"
sys.path[:0] = [str(STAGING), str(STAGING / "plugins")]

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

    def test_executable_registered_sim22_cleanup_journeys(self):
        """Run registered owner/plugin/render/SQL journeys; manifest is not the oracle."""
        from wolfhouse_staff_api.test_sim16_jonas_liam_fix import RegisteredBoundaryEvidence
        names = [
            "test_sim22_becker_captured_registered_sequence_reaches_create",
            "test_sim22_emma_structured_unsure_and_no_preserve_women_stock",
            "test_sim22_emma_yes_registered_quote_render_and_isolated_persistence",
            "test_sim22_complete_offer_equal_total_has_one_payment_line",
            "test_sim22_german_actual_male_preferred_label_is_localized",
        ]
        suite = unittest.TestSuite(RegisteredBoundaryEvidence(name) for name in names)
        stream = io.StringIO()
        result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
        self.assertTrue(result.wasSuccessful(), stream.getvalue())
        self.assertEqual(result.testsRun, len(names))

if __name__ == "__main__":
    unittest.main(verbosity=2)
