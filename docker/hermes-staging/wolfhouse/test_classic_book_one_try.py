"""SKIP-CLASSIC-BOOK-1TRY: model-facing contract for accepted Classic bookings."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOUL = (ROOT / "SOUL.md").read_text(encoding="utf-8")
PLUGIN = (ROOT / "plugins/wolfhouse_staff_api/__init__.py").read_text(encoding="utf-8")


class ClassicBookOneTryContractTests(unittest.TestCase):
    def test_name_completion_requotes_before_create_without_reasking_or_handoff(self):
        self.assertIn("Name-completion create order (hard)", SOUL)
        self.assertIn("Call `quote_booking` first", SOUL)
        self.assertIn("then `create_booking_from_plan` in that same turn", SOUL)
        self.assertIn("quote_owner_presented_offer_required", SOUL)
        self.assertIn("must not call flag_needs_human", SOUL)

    def test_empty_included_items_is_valid_when_no_extras_were_selected(self):
        self.assertIn("Empty included_items is valid for accommodation-only", SOUL)
        self.assertIn("must not call flag_needs_human", SOUL)
        self.assertIn("per_person", SOUL)

    def test_combined_payment_choice_and_side_question_answer_both(self):
        self.assertIn("Answer every guest question in the current message before advancing intake", SOUL)
        self.assertIn("including a payment choice", SOUL)
        self.assertIn("never silently drop it because the booking workflow advanced", SOUL)

    def test_owner_refusal_is_explicitly_non_escalating_to_the_model(self):
        self.assertIn("'do_not_escalate': True", PLUGIN)
        self.assertIn("'next_action': 'clarify_or_requote'", PLUGIN)


if __name__ == "__main__":
    unittest.main()
