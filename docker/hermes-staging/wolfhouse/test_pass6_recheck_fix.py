"""Focused regressions for approved pass-6 B1/B1b/I1 findings."""
import json
import subprocess
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
    def test_group_payment_real_staff_route_flows_through_tool_and_guard(self):
        """The actual JS route contract must survive the Python tool and guard."""
        script = r'''
const {handleBotGuestPaymentStatus} = require('./scripts/lib/staff-bot-v2-routes');
const rows = [
  {booking_guest_id:'g1',guest_number:1,guest_name:'Jonas',deposit_amount_cents:10000,
   amount_paid_cents:10000,payment_status:'partial',guest_metadata:{subtotal_cents:12000},
   booking_code:'WH-E2E',booking_id:'b1'},
  {booking_guest_id:'g2',guest_number:2,guest_name:'Null Share',deposit_amount_cents:0,
   amount_paid_cents:0,payment_status:'pending',guest_metadata:{subtotal_cents:null},
   booking_code:'WH-E2E',booking_id:'b1'},
  {booking_guest_id:'g3',guest_number:3,guest_name:'Missing Share',deposit_amount_cents:0,
   amount_paid_cents:0,payment_status:'pending',guest_metadata:{},
   booking_code:'WH-E2E',booking_id:'b1'}];
const res = {};
handleBotGuestPaymentStatus({},res,{},'test',{
 DEFAULT_CLIENT:'wolfhouse-somo',boundClientSlug:'wolfhouse-somo',
 readBody:async()=>JSON.stringify({booking_code:'WH-E2E',payment_scope:'booking_guests'}),
 send400:(_r,msg)=>{throw new Error(msg)},
 sendJSON:(_r,_status,body)=>body,
 withPgClient:async(fn)=>fn({query:async()=>({rows})})
}).then(body=>process.stdout.write(JSON.stringify(body)));
'''
        route = json.loads(subprocess.check_output(
            ["node", "-e", script], cwd=ROOT, text=True))
        self.assertEqual([2000, None, None],
                         [row["balance_due_cents"] for row in route["guest_payment_statuses"]])
        self.assertTrue(all(row["success"] is True
                            for row in route["guest_payment_statuses"]))

        with patch.object(staff, "_post_bot", return_value=route):
            tool_result = json.loads(staff.get_guest_payment_status({
                "booking_code": "WH-E2E", "payment_scope": "booking_guests"}))
        self.assertTrue(tool_result["success"])
        from wolfhouse import output_guard
        text, event = output_guard.guard_reply(
            "Les planches sont disponibles.", guest_lang="fr",
            tool_calls=[{"name": "get_guest_payment_status", "result": tool_result}])
        self.assertIn("Jonas a payé €100", text)
        self.assertIn("Les planches sont disponibles.", text)
        self.assertNotIn("Null Share", text)
        self.assertNotIn("Missing Share", text)
        self.assertIn("confirmed_guest_payment_receipt",
                      [item["kind"] for item in event])

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
        receipts = {"success": True, "payment_scope": "booking_guests",
          "guest_payment_statuses": [
            {**receipt, "booking_guest_id": "guest-1", "guest_number": 1},
            {**receipt, "booking_guest_id": "guest-3", "guest_number": 3,
             "guest_name": "Léa", "amount_paid_cents": 0, "balance_due_cents": 12000,
             "payment_status": "pending"}]}
        with patch.object(staff, "_post_bot", return_value=receipts) as post:
            group = json.loads(staff.get_guest_payment_status(
                {"booking_code": "WH-B1", "payment_scope": "booking_guests",
                 "guest_count": 1}))
        self.assertEqual([1, 3], [row["guest_number"] for row in group["guest_payment_statuses"]])
        self.assertEqual([10000, 0], [row["amount_paid_cents"] for row in group["guest_payment_statuses"]])
        self.assertEqual([2000, 12000], [row["balance_due_cents"] for row in group["guest_payment_statuses"]])
        post.assert_called_once()
        self.assertEqual("booking_guests", post.call_args.args[1]["payment_scope"])

    def test_group_receipt_keeps_every_complete_row_and_full_french_answer(self):
        from wolfhouse import output_guard
        calls = [{"name": "get_guest_payment_status", "result": {
            "success": True, "payment_scope": "booking_guests", "booking_code": "WH-B1",
            "guest_payment_statuses": [
                {"guest_number": 1, "guest_name": "Jonas", "amount_paid_cents": 10000,
                 "balance_due_cents": 2000, "guest_safe_payment_summaries": {
                     "fr": "Jonas a payé €100. Jonas doit encore €20."}},
                {"guest_number": 3, "guest_name": "Léa", "amount_paid_cents": 0,
                 "balance_due_cents": 12000, "guest_safe_payment_summaries": {
                     "fr": "Léa a payé €0. Léa doit encore €120."}},
                {"guest_number": 4, "guest_name": "Inconnu", "amount_paid_cents": 0,
                 "balance_due_cents": None, "guest_safe_payment_summaries": None},
            ],
        }}]
        answer = "Oui — les planches incluses sont disponibles. Quelle taille préférez-vous ?"
        text, _ = output_guard.guard_reply(answer, guest_lang="fr", tool_calls=calls)
        self.assertIn("Jonas a payé €100. Jonas doit encore €20.", text)
        self.assertIn("Léa a payé €0. Léa doit encore €120.", text)
        self.assertIn(answer, text)
        self.assertNotIn("Inconnu", text)

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
            "Yes — you can use the boards listed in your package.",
            guest_lang="en", tool_calls=calls,
        )
        self.assertIn("Jonas paid €100. Jonas owes €20.", text)
        self.assertIn("you can use the boards listed in your package", text)
        self.assertTrue(any(row["kind"] == "confirmed_guest_payment_receipt" for row in findings))

    def test_i1_same_turn_native_messages_use_new_receipt_and_keep_actual_reply(self):
        from wolfhouse import output_guard
        messages = [
            {"role": "tool", "tool_call_id": "old", "content": json.dumps({
                "success": True, "payment_confirmed": True, "payment_scope": "guest",
                "guest_safe_payment_summaries": {"en": "STALE RECEIPT"},
                "amount_paid_cents": 1, "balance_due_cents": 0})},
            {"role": "user", "content": "Did my payment arrive, and what about boards?"},
            {"role": "assistant", "tool_calls": [{"id": "new", "function": {
                "name": "get_guest_payment_status", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "new", "content": json.dumps({
                "success": True, "payment_confirmed": True, "payment_scope": "guest",
                "booking_guest_id": "g-new", "amount_paid_cents": 10000,
                "balance_due_cents": 2000,
                "guest_safe_payment_summaries": {"en": "Jonas paid €100. Jonas owes €20."}})},
        ]
        calls = output_guard._native_current_turn_tool_calls(messages)
        text, _ = output_guard.guard_reply(
            "Boards are available for your stay.", guest_lang="en", tool_calls=calls)
        self.assertEqual("Jonas paid €100. Jonas owes €20.\n\nBoards are available for your stay.", text)
        self.assertNotIn("STALE", text)


if __name__ == "__main__":
    unittest.main()
