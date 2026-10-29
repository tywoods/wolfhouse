"""Focused regressions for approved pass-6 B1/B1b/I1 findings."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "docker/hermes-staging"),
                str(ROOT / "docker/hermes-staging/plugins")]

from wolfhouse import accepted_quote as owner
import wolfhouse_staff_api as staff


class Pass6RecheckFixTests(unittest.TestCase):
    def test_b1_personal_payment_truth_says_paid_and_owed_in_every_language(self):
        receipt = {
            "success": True,
            "payment_status": "partial",
            "booking_code": "WH-B1",
            "booking_guest_id": "guest-1",
            "guest_name": "Jonas",
            "amount_paid_cents": 10000,
            "balance_due_cents": 2000,
        }
        with patch.object(staff, "_post_bot", return_value=receipt):
            result = json.loads(staff.get_guest_payment_status(
                {"booking_guest_id": "guest-1"}))
        summaries = result["guest_safe_payment_summaries"]
        self.assertEqual({"en", "es", "fr", "it", "de"}, set(summaries))
        paid_words = {"en": "paid", "es": "pagado", "fr": "payé",
                      "it": "pagato", "de": "bezahlt"}
        owed_words = {"en": "owes", "es": "debe", "fr": "doit",
                      "it": "deve", "de": "schuldet"}
        for language, text in summaries.items():
            with self.subTest(language=language):
                self.assertIn("Jonas", text)
                self.assertIn("€100", text)
                self.assertIn("€20", text)
                self.assertIn(paid_words[language], text.casefold())
                self.assertIn(owed_words[language], text.casefold())
        self.assertIn("Jonas' Anteil", summaries["de"])
        self.assertNotIn("Jonass Anteil", summaries["de"])
        receipts = [
            {**receipt, "booking_guest_id": "guest-1", "guest_number": 1},
            {**receipt, "booking_guest_id": "guest-2", "guest_number": 2,
             "guest_name": "Léa", "amount_paid_cents": 0, "balance_due_cents": 12000,
             "payment_status": "pending"},
        ]
        with patch.object(staff, "_post_bot", side_effect=receipts) as post:
            group = json.loads(staff.get_guest_payment_status(
                {"booking_code": "WH-B1", "guest_count": 2}))
        self.assertEqual([1, 2], [row["guest_number"] for row in group["guest_payment_statuses"]])
        self.assertEqual([10000, 0], [row["amount_paid_cents"] for row in group["guest_payment_statuses"]])
        self.assertEqual([2000, 12000], [row["balance_due_cents"] for row in group["guest_payment_statuses"]])
        self.assertEqual([1, 2], [call.args[1]["guest_number"] for call in post.call_args_list])

    def test_b1b_private_supplement_is_described_as_private_not_shared_beds(self):
        plan = {
            "check_in": "2026-11-16", "check_out": "2026-11-19",
            "guest_count": 2, "room_type": "shared", "room_preference": "mixed",
            "package_code": "package_none", "payment_choice": "deposit",
            "guests": [{"name": "Holly"}, {"name": "Jake"}],
        }
        offer = {
            **plan, "currency": "EUR", "total_cents": 30000,
            "deposit_required_cents": 20000, "payment_link_amount_cents": 20000,
            "included_items": [
                {"code": "accommodation_only", "nights": 3, "guest_count": 2,
                 "unit_cents": 4000, "total_cents": 24000},
                {"code": "room_supplement", "nights": 3,
                 "unit_cents": 2000, "total_cents": 6000},
            ],
            "room_arrangement": [
                {"bed_code": "P1-B1", "room_code": "P1", "room_type": "private",
                 "gender_strategy": "mixed"},
                {"bed_code": "P1-B2", "room_code": "P1", "room_type": "private",
                 "gender_strategy": "mixed"},
            ],
            "guest_bed_assignments": [
                {"guest_index": 0, "guest_name": "Holly", "bed_code": "P1-B1"},
                {"guest_index": 1, "guest_name": "Jake", "bed_code": "P1-B2"},
            ],
        }
        text = owner._styled_quote_copy(plan, offer, "en", create_ready=True)
        self.assertIn("Private room for Holly and Jake", text)
        self.assertNotIn("two beds in the same shared room", text.casefold())
        self.assertNotIn("two beds in the same mixed room", text.casefold())

    def test_i1_combined_payment_answer_and_board_question_must_answer_both(self):
        from wolfhouse import output_guard
        calls = [{"name": "get_guest_payment_status", "result": {
            "success": True, "payment_confirmed": True, "payment_scope": "guest",
            "booking_guest_id": "guest-1", "guest_name": "Jonas",
            "amount_paid_cents": 10000, "balance_due_cents": 2000,
            "guest_safe_payment_summaries": {
                "en": "Jonas paid €100. Jonas owes €20."
            },
        }}]
        text, findings = output_guard.guard_reply(
            "Yes — the surfboard is included in your package.",
            guest_lang="en", tool_calls=calls,
        )
        self.assertIn("Jonas paid €100. Jonas owes €20.", text)
        self.assertIn("the surfboard is included in your package", text)
        self.assertTrue(any(row["kind"] == "confirmed_guest_payment_receipt" for row in findings))


if __name__ == "__main__":
    unittest.main()
