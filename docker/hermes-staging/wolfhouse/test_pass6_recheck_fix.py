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
    @staticmethod
    def _personal_payment_call(name, guest_id, paid, owed, *, confirmed=True):
        return {"name": "get_guest_payment_status", "result": {
            "success": True, "payment_confirmed": confirmed, "payment_scope": "guest",
            "booking_guest_id": guest_id, "guest_name": name,
            "amount_paid_cents": paid, "balance_due_cents": owed,
            "guest_safe_payment_summaries": {
                "en": f"{name} paid €{paid // 100}. {name} owes €{owed // 100}."
            },
        }}

    @staticmethod
    def _board_fact_call():
        # Real quote_booking result shape: inclusion is grounded by Staff's
        # included_items rather than by the model's payment-adjacent prose.
        return {"name": "quote_booking", "result": {
            "success": True, "quote_status": "ready",
            "included_items": [{"code": "surfboard", "included": True,
                "guest_safe_labels": {
                    "en": "Surfboard and boards included and available in your package",
                    "fr": "Planches de surf incluses et disponibles",
                }}],
        }}

    def test_group_payment_real_staff_route_flows_through_tool_and_guard(self):
        """The actual JS route contract must survive the Python tool and guard."""
        script = r'''
const {handleBotGuestPaymentStatus} = require('./scripts/lib/staff-bot-v2-routes');
const rows = [
  {booking_guest_id:'g1',guest_number:1,guest_name:'Jonas',deposit_amount_cents:10000,
   amount_paid_cents:10000,payment_status:'paid',guest_metadata:{subtotal_cents:10000},
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
        self.assertEqual([0, None, None],
                         [row["balance_due_cents"] for row in route["guest_payment_statuses"]])
        self.assertTrue(all(row["success"] is True
                            for row in route["guest_payment_statuses"]))

        with patch.object(staff, "_post_bot", return_value=route):
            tool_result = json.loads(staff.get_guest_payment_status({
                "booking_code": "WH-E2E", "payment_scope": "booking_guests"}))
        self.assertTrue(tool_result["success"])
        from wolfhouse import output_guard
        draft = ("Les planches de surf incluses sont disponibles. Jonas doit encore €20. "
                 "I have notified reception. staff_review_needed=true")
        text, event = output_guard.guard_reply(
            draft, guest_lang="fr",
            tool_calls=[{"name": "get_guest_payment_status", "result": tool_result},
                        self._board_fact_call()])
        self.assertEqual(
            "Jonas a payé €100. Jonas doit encore €0.\n\n"
            "Les planches de surf incluses sont disponibles.", text)
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
        }}, self._board_fact_call()]
        answer = "Oui — les planches incluses sont disponibles. Quelle taille préférez-vous ?"
        text, _ = output_guard.guard_reply(answer, guest_lang="fr", tool_calls=calls)
        self.assertIn("Jonas a payé €100. Jonas doit encore €20.", text)
        self.assertIn("Léa a payé €0. Léa doit encore €120.", text)
        self.assertIn("Oui — les planches incluses sont disponibles.", text)
        self.assertNotIn("Quelle taille", text)
        self.assertNotIn("Inconnu", text)

    def test_b1_final_reply_combines_all_current_personal_route_receipts(self):
        from wolfhouse import output_guard
        calls = [
            self._personal_payment_call("Jonas", "guest-1", 10000, 2000),
            self._personal_payment_call("Léa", "guest-3", 0, 27000),
        ]
        text, _ = output_guard.guard_reply(
            "Here are the current balances.", guest_lang="en", tool_calls=calls)
        self.assertEqual(
            "Jonas paid €100. Jonas owes €20.\n"
            "Léa paid €0. Léa owes €270.", text)

    def test_b1_unpaid_successful_personal_receipt_is_rendered_from_real_staff_shape(self):
        from wolfhouse import output_guard
        calls = [self._personal_payment_call(
            "Léa", "guest-3", 0, 27000, confirmed=False)]
        text, _ = output_guard.guard_reply(
            "Léa's row is current.", guest_lang="en", tool_calls=calls)
        self.assertEqual("Léa paid €0. Léa owes €270.", text)

    def test_i1_every_model_authored_balance_form_is_removed_from_final_reply(self):
        from wolfhouse import output_guard
        calls = [self._personal_payment_call("Jonas", "guest-1", 10000, 0)]
        cases = {
            "Jonas owes nothing": "Jonas owes nothing.",
            "Jonas has no outstanding balance": "Jonas has no outstanding balance.",
            "contradictory amount": "Jonas owes €20.",
        }
        for label, draft in cases.items():
            with self.subTest(label=label):
                text, _ = output_guard.guard_reply(draft, guest_lang="en", tool_calls=calls)
                self.assertEqual("Jonas paid €100. Jonas owes €0.", text)

    def test_i1_money_clause_is_removed_but_same_sentence_fact_is_retained(self):
        from wolfhouse import output_guard
        calls = [self._personal_payment_call("Jonas", "guest-1", 10000, 0),
                 self._board_fact_call()]
        cases = {
            "comma conjunction": (
                "Yes, the surfboard is included, and Jonas owes €0.",
                "Yes, the surfboard is included.",
            ),
            "semicolon": (
                "The surfboard is included; Jonas owes nothing.",
                "The surfboard is included.",
            ),
            "while": (
                "The surfboard is included, while Jonas owes nothing.",
                "The surfboard is included.",
            ),
            "whereas": (
                "Jonas has settled his bill, whereas the surfboard is included.",
                "The surfboard is included.",
            ),
        }
        for label, (draft, retained) in cases.items():
            with self.subTest(label=label):
                text, _ = output_guard.guard_reply(
                    draft, guest_lang="en", tool_calls=calls)
                self.assertEqual(
                    f"Jonas paid €100. Jonas owes €0.\n\n{retained}", text)

    def test_i1_receipt_is_only_source_for_balance_and_paid_status_meaning(self):
        from wolfhouse import output_guard
        calls = [self._personal_payment_call("Jonas", "guest-1", 10000, 2000)]
        drafts = [
            "Jonas has nothing left to settle.",
            "Jonas is fully settled.",
            "Jonas's account is all square.",
            "Everything due from Jonas has arrived.",
            "No further contribution is required from Jonas.",
            "We have received Jonas's full share.",
            "Jonas has settled his bill.",
            "Jonas's contribution is complete.",
            "Jonas finished what he needed to do.",
            "Jonas is done on his side.",
        ]
        for draft in drafts:
            with self.subTest(draft=draft):
                text, _ = output_guard.guard_reply(
                    draft, guest_lang="en", tool_calls=calls)
                self.assertEqual("Jonas paid €100. Jonas owes €20.", text)

    def test_i1_serialized_receipt_and_contextual_subjects_fail_closed(self):
        from wolfhouse import output_guard
        call = self._personal_payment_call("Jonas Smith", "guest-1", 10000, 2000)
        call["result"] = json.dumps(call["result"])
        for draft in ("Jonas is done on his side.", "He is done on his side."):
            with self.subTest(draft=draft):
                text, _ = output_guard.guard_reply(draft, guest_lang="en", tool_calls=[call])
                self.assertEqual("Jonas Smith paid €100. Jonas Smith owes €20.", text)

    def test_i1_grounded_guest_fact_survives_and_comma_list_is_not_corrupted(self):
        from wolfhouse import output_guard
        payment = self._personal_payment_call("Jonas Smith", "guest-1", 10000, 2000)
        facts = {"name": "get_booking", "result": {
            "success": True, "guest_name": "Jonas Smith", "arrival_date": "tomorrow",
            "included_meals": ["breakfast", "lunch", "dinner"],
        }}
        draft = "Jonas Smith arrives tomorrow. Breakfast, lunch, and dinner are included."
        text, _ = output_guard.guard_reply(draft, guest_lang="en", tool_calls=[payment, facts])
        self.assertEqual(
            "Jonas Smith paid €100. Jonas Smith owes €20.\n\n" + draft, text)

    def test_i1_semantic_balance_claim_is_removed_without_money_keyword(self):
        from wolfhouse import output_guard
        calls = [self._personal_payment_call("Jonas", "guest-1", 10000, 2000)]
        calls.append(self._board_fact_call())
        text, _ = output_guard.guard_reply(
            "Jonas's remaining amount is zero. The surfboard is included.",
            guest_lang="en", tool_calls=calls)
        self.assertEqual(
            "Jonas paid €100. Jonas owes €20.\n\nThe surfboard is included.", text)

    def test_i1_unpunctuated_conjunction_keeps_grounded_non_money_fact(self):
        from wolfhouse import output_guard
        calls = [self._personal_payment_call("Jonas", "guest-1", 10000, 2000),
                 self._board_fact_call()]
        text, _ = output_guard.guard_reply(
            "The surfboard is included and Jonas owes nothing.",
            guest_lang="en", tool_calls=calls)
        self.assertEqual(
            "Jonas paid €100. Jonas owes €20.\n\nThe surfboard is included.", text)

    def test_i1_internal_staff_review_colon_form_is_removed_from_final_reply(self):
        from wolfhouse import output_guard
        calls = [self._personal_payment_call("Jonas", "guest-1", 10000, 0)]
        calls.append(self._board_fact_call())
        text, _ = output_guard.guard_reply(
            "The surfboard is included. staff_review_needed: true",
            guest_lang="en", tool_calls=calls)
        self.assertEqual(
            "Jonas paid €100. Jonas owes €0.\n\nThe surfboard is included.", text)

    def test_i1_internal_key_is_removed_in_json_quoted_and_bare_forms(self):
        from wolfhouse import output_guard
        calls = [self._personal_payment_call("Jonas", "guest-1", 10000, 2000)]
        calls.append(self._board_fact_call())
        cases = [
            'The surfboard is included. {"staff_review_needed": true}',
            'The surfboard is included. "staff_review_needed"',
            "The surfboard is included. staff_review_needed",
        ]
        for draft in cases:
            with self.subTest(draft=draft):
                text, _ = output_guard.guard_reply(
                    draft, guest_lang="en", tool_calls=calls)
                self.assertEqual(
                    "Jonas paid €100. Jonas owes €20.\n\nThe surfboard is included.",
                    text)

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
        calls.append(self._board_fact_call())
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
        calls.append(self._board_fact_call())
        text, _ = output_guard.guard_reply(
            "Boards are available for your stay.", guest_lang="en", tool_calls=calls)
        self.assertEqual("Jonas paid €100. Jonas owes €20.\n\nBoards are available for your stay.", text)
        self.assertNotIn("STALE", text)

    def test_r2_probe_complete_reply_drops_unsafe_draft_but_keeps_board_answer(self):
        from wolfhouse import output_guard
        calls = [{"name": "get_guest_payment_status", "result": {
            "success": True, "payment_confirmed": True, "payment_scope": "guest",
            "booking_guest_id": "guest-1", "guest_name": "Jonas",
            "amount_paid_cents": 10000, "balance_due_cents": 0,
            "guest_safe_payment_summaries": {
                "en": "Jonas paid €100. Jonas owes €0."
            },
        }}]
        calls.append(self._board_fact_call())
        draft = ("Yes — the surfboard is included in your package. Jonas owes €20. "
                 "I have notified reception. staff_review_needed=true")
        text, _ = output_guard.guard_reply(draft, guest_lang="en", tool_calls=calls)
        self.assertEqual(
            "Jonas paid €100. Jonas owes €0.\n\n"
            "Yes — the surfboard is included in your package.", text)

    def test_r10_claim_grounding_requires_entity_predicate_and_value_from_one_fact(self):
        from wolfhouse import output_guard
        payment = self._personal_payment_call("Jonas Smith", "guest-1", 10000, 2000)
        booking = {"name": "get_booking", "result": {
            "success": True, "guest_name": "Jonas Smith",
            "arrival_date": "tomorrow", "booking_status": "confirmed",
        }}
        board = self._board_fact_call()
        cases = {
            "Jonas Smith has settled his bill.": "",
            "The surfboard is included because Jonas has settled his bill.":
                "The surfboard is included.",
            "Is the surfboard included because Jonas has settled his bill?":
                "Is the surfboard included?",
            "Since his account is clear, does Jonas Smith get the surfboard?": "",
        }
        for draft, retained in cases.items():
            with self.subTest(draft=draft):
                text, _ = output_guard.guard_reply(
                    draft, guest_lang="en", tool_calls=[payment, booking, board])
                receipt = "Jonas Smith paid €100. Jonas Smith owes €20."
                self.assertEqual(receipt + (f"\n\n{retained}" if retained else ""), text)

    def test_r10_grounded_package_inclusion_paraphrases_survive_real_quote_shape(self):
        from wolfhouse import output_guard
        payment = self._personal_payment_call("Jonas", "guest-1", 10000, 2000)
        cases = [
            "Your package covers the surfboard.",
            "The board comes with your package.",
            "A surfboard is included in the package.",
        ]
        for draft in cases:
            with self.subTest(draft=draft):
                text, _ = output_guard.guard_reply(
                    draft, guest_lang="en", tool_calls=[payment, self._board_fact_call()])
                self.assertEqual(
                    f"Jonas paid €100. Jonas owes €20.\n\n{draft}", text)
    def test_r11_atomic_staff_facts_require_entity_predicate_and_value_agreement(self):
        from wolfhouse import output_guard
        payment = self._personal_payment_call("Jonas", "guest-1", 10000, 2000)
        board = {"name": "quote_booking", "result": {
            "success": True, "included_items": [
                {"code": "surfboard", "included": True, "free": False}],
        }}
        cases = {
            "Your package covers the surfboard.": "Your package covers the surfboard.",
            "Because payment is complete, the surfboard is included.":
                "The surfboard is included.",
            "A fresh payment is required.": "",
            "Is a fresh payment required?": "",
            "The surfboard is free.": "",
            "The board is complimentary.": "",
        }
        receipt = "Jonas paid €100. Jonas owes €20."
        for draft, retained in cases.items():
            with self.subTest(draft=draft):
                text, _ = output_guard.guard_reply(
                    draft, guest_lang="en", tool_calls=[payment, board])
                self.assertEqual(receipt + (f"\n\n{retained}" if retained else ""), text)

    def test_r11_parent_and_siblings_cannot_form_a_synthetic_fact(self):
        from wolfhouse import output_guard
        payment = self._personal_payment_call("Jonas", "guest-1", 10000, 2000)
        facts = {"name": "quote_booking", "result": {
            "success": True,
            "included_items": [{"code": "breakfast", "included": True},
                               {"code": "surfboard", "included": False}],
        }}
        text, _ = output_guard.guard_reply(
            "The surfboard is included. Breakfast is included.",
            guest_lang="en", tool_calls=[payment, facts])
        self.assertEqual(
            "Jonas paid €100. Jonas owes €20.\n\nBreakfast is included.", text)

    def test_r12_full_entity_and_every_predicate_value_are_atomic(self):
        from wolfhouse import output_guard
        payment = self._personal_payment_call("Jonas", "guest-1", 10000, 2000)
        equipment = {"name": "quote_booking", "result": {
            "success": True, "included_items": [
                {"code": "surfboard", "included": True, "free": False,
                 "price_cents": 2000},
                {"code": "wetsuit_rental", "included": True, "free": True},
            ],
        }}
        receipt = "Jonas paid €100. Jonas owes €20."
        cases = {
            "The surfboard is included.": "The surfboard is included.",
            "Your package covers the surfboard.": "Your package covers the surfboard.",
            "Jonas paid €100. Jonas owes €20. The surfboard is included now that Jonas has sent his full share.":
                "The surfboard is included.",
            "Surfboard rental is complimentary.": "",
            "The included surfboard is complimentary.": "",
            "The surfboard isn't included.": "",
            "The wetsuit rental is complimentary.": "The wetsuit rental is complimentary.",
        }
        for draft, retained in cases.items():
            with self.subTest(draft=draft):
                text, _ = output_guard.guard_reply(
                    draft, guest_lang="en", tool_calls=[payment, equipment])
                self.assertEqual(receipt + (f"\n\n{retained}" if retained else ""), text)

    def test_r12_unseen_real_shape_paraphrases_do_not_cross_equipment_entities(self):
        from wolfhouse import output_guard
        payment = self._personal_payment_call("Jonas", "guest-1", 10000, 2000)
        facts = {"name": "quote_booking", "result": {
            "success": True, "included_items": [
                {"code": "surfboard", "included": False, "free": False,
                 "price_cents": 2000},
                {"code": "wetsuit_rental", "included": True, "free": True},
            ],
        }}
        cases = {
            "The board does not come with your package.":
                "The board does not come with your package.",
            "A complimentary wetsuit rental is included.":
                "A complimentary wetsuit rental is included.",
            "A complimentary surfboard is included.": "",
            "The wetsuit rental isn't included.": "",
        }
        receipt = "Jonas paid €100. Jonas owes €20."
        for draft, expected in cases.items():
            with self.subTest(draft=draft):
                text, _ = output_guard.guard_reply(
                    draft, guest_lang="en", tool_calls=[payment, facts])
                self.assertEqual(receipt + (f"\n\n{expected}" if expected else ""), text)

    def test_r13_every_subject_predicate_and_payment_claim_is_adjudicated(self):
        from wolfhouse import output_guard
        payment = self._personal_payment_call("Jonas", "guest-1", 10000, 2000)
        equipment = {"name": "quote_booking", "result": {
            "success": True, "included_items": [
                {"code": "surfboard", "included": True, "free": False,
                 "price_cents": 2000},
                {"code": "wetsuit_rental", "included": True, "free": True},
            ],
        }}
        receipt = "Jonas paid €100. Jonas owes €20."
        cases = {
            "Wetsuit rental is complimentary after we banked Jonas's full share.":
                "Wetsuit rental is complimentary.",
            "Wetsuit rental plus surfboard rental are complimentary.": "",
            "The included surfboard costs nothing.": "",
            "The wetsuit is free.": "The wetsuit is free.",
            "The included surfboard is not free.":
                "The included surfboard is not free.",
        }
        for draft, expected in cases.items():
            with self.subTest(draft=draft):
                text, _ = output_guard.guard_reply(
                    draft, guest_lang="en", tool_calls=[payment, equipment])
                self.assertEqual(receipt + (f"\n\n{expected}" if expected else ""), text)

    def test_r13_unseen_claim_shapes_remain_entity_local(self):
        from wolfhouse import output_guard
        payment = self._personal_payment_call("Jonas", "guest-1", 10000, 2000)
        equipment = {"name": "quote_booking", "result": {
            "success": True, "included_items": [
                {"code": "surfboard", "included": True, "free": False},
                {"code": "wetsuit_rental", "included": True, "free": True},
            ],
        }}
        receipt = "Jonas paid €100. Jonas owes €20."
        cases = {
            "Surfboard and wetsuit rental are free.": "",
            "The wetsuit costs nothing after Jonas cleared his obligation.":
                "The wetsuit costs nothing.",
            "The included wetsuit is not free.": "",
        }
        for draft, expected in cases.items():
            with self.subTest(draft=draft):
                text, _ = output_guard.guard_reply(
                    draft, guest_lang="en", tool_calls=[payment, equipment])
                self.assertEqual(receipt + (f"\n\n{expected}" if expected else ""), text)

    def test_r14_all_subjects_and_assertions_require_their_own_fact(self):
        from wolfhouse import output_guard
        payment = self._personal_payment_call("Jonas", "guest-1", 10000, 2000)
        equipment = {"name": "quote_booking", "result": {
            "success": True, "included_items": [
                {"code": "surfboard", "included": True, "free": False,
                 "price_cents": 2000},
                {"code": "wetsuit_rental", "included": True, "free": True},
            ],
        }}
        receipt = "Jonas paid €100. Jonas owes €20."
        cases = {
            "Wetsuit rental plus surfboard rental cost nothing.": "",
            "The wetsuit is free with Jonas's invoice now zeroed out.":
                "The wetsuit is free.",
            "The included surfboard comes at no charge.": "",
            "The wetsuit and surfboard each come at no charge.": "",
            "Surfboard rental costs zero; wetsuit rental is complimentary.":
                "Wetsuit rental is complimentary.",
        }
        for draft, expected in cases.items():
            with self.subTest(draft=draft):
                text, _ = output_guard.guard_reply(
                    draft, guest_lang="en", tool_calls=[payment, equipment])
                self.assertEqual(receipt + (f"\n\n{expected}" if expected else ""), text)

    def test_r15_structural_shared_claims_use_each_subjects_own_fact(self):
        from wolfhouse import output_guard
        payment = self._personal_payment_call("Jonas", "guest-1", 10000, 2000)
        equipment = {"name": "quote_booking", "result": {
            "success": True, "included_items": [
                {"code": "surfboard", "included": True, "free": False,
                 "price_cents": 2000},
                {"code": "wetsuit_rental", "included": True, "free": True},
            ],
        }}
        receipt = "Jonas paid €100. Jonas owes €20."
        cases = {
            "Wetsuit rental plus surfboard rental are both complimentary.": "",
            "The wetsuit comes at no charge.": "The wetsuit comes at no charge.",
            "The wetsuit does not come at no charge.": "",
            # Unseen members of the same connector/quantifier grammar.
            "Both the wetsuit and the surfboard are free.": "",
            "The wetsuit and wetsuit rental each cost nothing.":
                "The wetsuit and wetsuit rental each cost nothing.",
            "All the wetsuit plus wetsuit rental are complimentary.":
                "All the wetsuit plus wetsuit rental are complimentary.",
        }
        for draft, expected in cases.items():
            with self.subTest(draft=draft):
                text, _ = output_guard.guard_reply(
                    draft, guest_lang="en", tool_calls=[payment, equipment])
                self.assertEqual(receipt + (f"\n\n{expected}" if expected else ""), text)

    def test_r16_emits_only_fully_parsed_claims_with_complete_polarity(self):
        from wolfhouse import output_guard
        payment = self._personal_payment_call("Jonas", "guest-1", 10000, 2000)
        equipment = {"name": "quote_booking", "result": {
            "success": True, "included_items": [
                {"code": "surfboard", "included": True, "free": False,
                 "price_cents": 2000},
                {"code": "wetsuit_rental", "included": True, "free": True},
                {"code": "towel", "included": True, "free": True},
            ],
        }}
        receipt = "Jonas paid €100. Jonas owes €20."
        cases = {
            "The surfboard and wetsuit are included because Jonas has sent his full share.":
                "The surfboard and wetsuit are included.",
            "The surfboard and wetsuit are included with Jonas's invoice now zeroed out.":
                "The surfboard and wetsuit are included.",
            "Wetsuit rental, surfboard rental and towel are complimentary.": "",
            "Wetsuit rental along with surfboard rental is complimentary.": "",
            "The wetsuit is never free.": "",
            "Neither the wetsuit nor the surfboard is free.": "",
            # Positive controls prove complete multi-entity coverage is retained.
            "Wetsuit rental and towel are complimentary.":
                "Wetsuit rental and towel are complimentary.",
            "The surfboard is never free.": "The surfboard is never free.",
            # Unseen grammatical variants exercise the same structural boundary.
            "Wetsuit rental, towel and surfboard cost zero.": "",
            "Neither the surfboard nor the board is complimentary.":
                "Neither the surfboard nor the board is complimentary.",
        }
        for draft, expected in cases.items():
            with self.subTest(draft=draft):
                text, _ = output_guard.guard_reply(
                    draft, guest_lang="en", tool_calls=[payment, equipment])
                self.assertEqual(receipt + (f"\n\n{expected}" if expected else ""), text)

    def test_r17_coordination_coverage_and_assertion_scoped_polarity(self):
        from wolfhouse import output_guard
        payment = self._personal_payment_call("Jonas", "guest-1", 10000, 2000)
        equipment = {"name": "quote_booking", "result": {
            "success": True, "included_items": [
                {"code": "surfboard", "included": True, "free": False},
                {"code": "wetsuit_rental", "included": True, "free": True},
                {"code": "towel", "included": True, "free": True},
            ],
        }}
        receipt = "Jonas paid €100. Jonas owes €20."
        cases = {
            # Recognised coordination that is incomplete is rejected, never retried
            # by the permissive single-entity path.
            "Wetsuit rental plus kayak rental are complimentary.": "",
            "Wetsuit rental plus surfboard rental are complimentary.": "",
            "Wetsuit rental with kayak rental and towel are complimentary.": "",
            "Wetsuit rental together with paddleboard rental and towel are free.": "",
            # Every object/referent in an otherwise grounded assertion is covered.
            "The wetsuit includes complimentary kayak rental.": "",
            "The towel comes with a free poncho.": "",
            # 'not only' scopes focus, not assertion polarity.
            "The surfboard is not only complimentary, it's included.": "",
            "The wetsuit is not only complimentary, it's included.":
                "The wetsuit is not only complimentary, it's included.",
            # Positive controls: complete known referents and true negative polarity.
            "Wetsuit rental and towel are complimentary.":
                "Wetsuit rental and towel are complimentary.",
            "The surfboard is not complimentary.":
                "The surfboard is not complimentary.",
            "The wetsuit is not complimentary.": "",
        }
        for draft, expected in cases.items():
            with self.subTest(draft=draft):
                text, _ = output_guard.guard_reply(
                    draft, guest_lang="en", tool_calls=[payment, equipment])
                self.assertEqual(receipt + (f"\n\n{expected}" if expected else ""), text)


if __name__ == "__main__":
    unittest.main()
