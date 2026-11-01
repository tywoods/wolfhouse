"""Regressions for SKIP-RERUN1101-LUNA-20261101T0905 (offline only)."""
import copy
import json
import sys
import unittest
from unittest.mock import patch

import wolfhouse_staff_api as plugin
from wolfhouse import accepted_quote as owner


class LunaRootFixes1101(unittest.TestCase):
    def setUp(self):
        # These focused plugin regressions exercise the ordinary direct-dispatch
        # path. The owning suite imports conversation_loop, which otherwise
        # leaks owner-active process state into this module when suites share a
        # Python process.
        self._conversation_loop_module = sys.modules.pop('agent.conversation_loop', None)

    def tearDown(self):
        if self._conversation_loop_module is not None:
            sys.modules['agent.conversation_loop'] = self._conversation_loop_module

    def test_ineligible_requested_room_stops_date_widening_and_exposes_inventory_alternatives(self):
        params = {"check_in": "2027-06-01", "check_out": "2027-06-04", "guest_count": 1,
                  "room_type": "private", "room_preference": "private", "keep_together": True,
                  "guests": [{"name": "A"}]}
        receipt = {"success": True, "has_enough_beds": False,
                   "exact_bed_eligibility": {"eligible": False,
                       "reason": "private_room_requires_exactly_two_guests",
                       "selected_bed_codes": ["P1-B1", "P1-B2"]},
                   "room_options": {"mixed_available": True, "private_available": False},
                   "nearest_open_candidate": {"check_in": "2027-06-08", "check_out": "2027-06-11"},
                   "selected_bed_codes": [], "available_beds": []}
        with patch.object(plugin, "_post_bot", return_value=receipt):
            result = json.loads(plugin.check_availability(params))
        self.assertEqual(result["ineligible_reason"], receipt["exact_bed_eligibility"]["reason"])
        self.assertFalse(result["date_widening_allowed"])
        self.assertFalse(result["alternative_dates_are_unverified_candidates"])
        self.assertEqual(result["honest_room_alternatives"], {"mixed_available": True, "private_available": False})

    def test_private_two_person_selection_remains_protected(self):
        params = {"check_in": "2027-06-01", "check_out": "2027-06-04", "guest_count": 2,
                  "room_type": "private", "room_preference": "private", "keep_together": True,
                  "guests": [{"name": "A"}, {"name": "B"}]}
        receipt = {"success": True, "has_enough_beds": True, "selected_room_code": "P1",
                   "selected_bed_codes": ["P1-B1", "P1-B2"], "available_beds": [
                       {"bed_code": "P1-B1", "room_code": "P1", "room_type": "female_only", "selected_selling_mode": "private"},
                       {"bed_code": "P1-B2", "room_code": "P1", "room_type": "female_only", "selected_selling_mode": "private"}]}
        with patch.object(plugin, "_post_bot", return_value=receipt):
            result = json.loads(plugin.check_availability(params))
        self.assertTrue(result["available"])
        self.assertEqual(result["selected_bed_codes"], ["P1-B1", "P1-B2"])
        self.assertEqual(result["selected_room_description"], "private")

    def test_availability_changed_allows_date_widening(self):
        params = {"check_in": "2027-06-01", "check_out": "2027-06-04", "guest_count": 1,
                  "room_type": "shared", "guests": [{"name": "A"}]}
        receipt = {"success": True, "has_enough_beds": False,
                   "exact_bed_eligibility": {"eligible": False,
                       "reason": "availability_changed", "selected_bed_codes": ["M1"]},
                   "nearest_open_candidate": {"check_in": "2027-06-08", "check_out": "2027-06-11"},
                   "selected_bed_codes": [], "available_beds": []}
        with patch.object(plugin, "_post_bot", return_value=receipt):
            result = json.loads(plugin.check_availability(params))
        self.assertIsNone(result["ineligible_reason"])
        self.assertTrue(result["date_widening_allowed"])
        self.assertTrue(result["alternative_dates_are_unverified_candidates"])

    def test_transfer_outcomes_retain_request_status_and_staff_reason(self):
        pending = {"direction": "arrival", "airport": "BIO", "flight_number": "VY123",
                   "scheduled_at": "2027-06-01T12:00:00Z", "guest_count": 2}
        staff = {"success": False, "write_performed": False, "status": "blocked",
                 "reason_code": "transfer_window_closed", "error": "No driver window"}
        with patch.object(plugin, "_post_bot", return_value=staff):
            result = plugin._auto_save_pending_transfers(
                {"client_slug": "wolfhouse-somo", "pending_transfers": [pending]}, "id", "WH-1")
        self.assertEqual(result[0]["requested_transfer"], pending)
        self.assertEqual(result[0]["status"], "blocked")
        self.assertEqual(result[0]["reason_code"], "transfer_window_closed")
        self.assertEqual(result[0]["error"], "No driver window")

    def test_simulator_create_reports_each_requested_transfer_block_without_writing_transfer(self):
        pending = [{"direction": "arrival", "airport": "BIO"},
                   {"direction": "departure", "airport": "SDR"}]
        calls = []
        def staff(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            self.assertNotEqual(path, "/transfers/save")
            return {"success": True, "write_performed": True, "booking_id": "sim-id",
                    "booking_code": "TEST-1"}
        payload = {"client_slug": "wolfhouse-somo", "check_in": "2027-06-01",
                   "check_out": "2027-06-04", "guest_count": 1, "guest_name": "A",
                   "guests": [{"name": "A"}], "package_code": "package_none",
                   "payment_choice": "full", "room_type": "shared",
                   "selected_bed_codes": ["M1"], "pending_transfers": pending,
                   "wolfhouse_staging_capability": "wolfhouse_staging_booking_test_link",
                   "capability_reasons": ["simulator_test_no_transfer_writes"]}
        with patch.object(plugin, "_post_bot", side_effect=staff), \
             patch.object(plugin, "_room_decision_for_tool", return_value={}):
            result = json.loads(plugin.create_booking_from_plan(payload))
        self.assertEqual([path for path, _ in calls].count("/transfers/save"), 0)
        self.assertEqual([row["requested_transfer"] for row in result["transfer_save_results"]], pending)
        self.assertTrue(all(row["status"] == "blocked" and not row["write_performed"]
                            for row in result["transfer_save_results"]))
        self.assertTrue(all(row["capability"] == "wolfhouse_staging_booking_test_link"
                            for row in result["transfer_save_results"]))

    def test_names_keep_explicit_display_spelling_and_never_borrow_surname(self):
        payload = {"guest_count": 3, "guest_name": "LUKAS",
                   "guests": ["LUKAS", "Nina Becker", "jan becker"]}
        plugin._normalize_guests_payload(payload)
        self.assertEqual(payload["guest_name"], "LUKAS")
        self.assertEqual(payload["guests"], [
            {"name": "LUKAS"}, {"name": "Nina Becker"}, {"name": "jan becker"}])

    def test_model_authoring_context_separates_tier_distribution_and_public_room(self):
        plan = {"language": "de", "register": "Sie", "payment_choice": "full",
                "payment_link_distribution": "separate", "guest_count": 2,
                "guests": [{"name": "Léa"}, {"name": "Mia"}]}
        offer = {**plan, "currency": "EUR", "total_cents": 16000,
                 "payment_link_amount_cents": 16000,
                 "public_room_label": "Privatzimmer für zwei Personen",
                 "payment_distribution": [{"guest_name": "Léa", "amount_due_cents": 7000},
                                          {"guest_name": "Mia", "amount_due_cents": 9000}]}
        facts = owner._quote_authoring_facts(plan, offer)
        self.assertEqual(facts["room_label"], "Privatzimmer für zwei Personen")
        self.assertEqual(facts["language"], "de")
        self.assertEqual(facts["register"], "Sie")
        self.assertEqual(facts["payment_tier"], "full")
        self.assertEqual(facts["payment_distribution"], "separate")
        self.assertEqual(facts["per_person_due_now"], [
            {"guest_name": "Léa", "amount_due_cents": 7000},
            {"guest_name": "Mia", "amount_due_cents": 9000}])
        self.assertNotIn("room_code", json.dumps(facts))

    def test_registered_quote_call_path_exposes_authoring_facts_to_model(self):
        plan = {"language": "de", "register": "Sie", "payment_choice": "full",
                "payment_link_distribution": "separate", "guest_count": 2,
                "guests": [{"name": "Léa"}, {"name": "Mia"}]}
        offer = {**plan, "currency": "EUR", "total_cents": 16000,
                 "payment_link_amount_cents": 16000,
                 "public_room_label": "Privatzimmer für zwei Personen",
                 "payment_distribution": [{"guest_name": "Léa", "amount_due_cents": 7000},
                                          {"guest_name": "Mia", "amount_due_cents": 9000}]}
        handler = plugin._quote_owner_handler("quote_booking", lambda params, **kwargs: json.dumps({
            "success": True, "offer_revision": offer}))
        result = json.loads(handler(plan))
        self.assertEqual(result["quote_authoring_facts"]["per_person_due_now"], [
            {"guest_name": "Léa", "amount_due_cents": 7000},
            {"guest_name": "Mia", "amount_due_cents": 9000}])
        self.assertEqual(result["quote_authoring_facts"]["room_label"],
                         "Privatzimmer für zwei Personen")

    def test_missing_public_room_label_stays_missing_and_full_separate_never_guesses_shares(self):
        plan = {"language": "de", "payment_choice": "full",
                "payment_link_distribution": "separate", "guest_count": 2,
                "guests": [{"name": "Léa"}, {"name": "Mia"}]}
        offer = {**plan, "currency": "EUR", "total_cents": 16000,
                 "payment_link_amount_cents": 16000, "room_arrangement": [
                     {"room_code": "R7", "bed_code": "R7-B1"}]}
        facts = owner._quote_authoring_facts(plan, offer)
        self.assertIsNone(facts["room_label"])
        self.assertEqual(facts["per_person_due_now"], [])
        text = owner._styled_quote_copy(plan, offer, "de", create_ready=True)
        self.assertNotIn("Léa:", text)
        authoritative = {**offer, "payment_distribution": [
            {"guest_name": "Léa", "amount_due_cents": 7000},
            {"guest_name": "Mia", "amount_due_cents": 9000}]}
        text = owner._styled_quote_copy(plan, authoritative, "de", create_ready=True)
        self.assertIn("Léa: €70", text)
        self.assertIn("Mia: €90", text)

    def test_actual_offer_path_keeps_model_authored_card(self):
        model_text = "Garden dorm — total €120, with a deposit. Shall I reserve it?"
        offer = {"currency": "EUR", "total_cents": 12000,
                 "deposit_required_cents": 4000, "payment_choice": "deposit",
                 "public_room_label": "Garden dorm", "room_arrangement": [{"bed_code": "G1"}]}
        state = {"status": "offered", "quote": {"success": True, "offer_revision": offer,
                                                    "quote_authoring_facts": owner._quote_authoring_facts(
                                                        {"guest_count": 1, "language": "en"}, offer)},
                 "checked_offer": offer, "offer_message": "message-1", "scope": {},
                 "incarnation": 1, "plan": {"guest_count": 1, "language": "en"},
                 "pending_question": None, "accepted_offer_snapshot": None}
        ingress = {"tenant": "wolfhouse-somo", "MESSAGE_ID": "message-1"}
        result = {"completed": True, "final_response": model_text,
                  "messages": [{"role": "assistant", "content": model_text, "id": "reply-1"}]}
        with patch.object(owner, "_transaction", side_effect=lambda callback: callback(state, ingress)), \
             patch.object(owner, "_styled_quote_copy", return_value="DETERMINISTIC GUEST COPY") as styled:
            final = owner.finalize_offer_response(result)
        self.assertEqual(final["final_response"], model_text)
        self.assertEqual(final["messages"][-1]["content"], model_text)
        styled.assert_not_called()
        self.assertEqual(state["presentation"]["displayed_text"], model_text)

    def test_real_room_arrangement_public_label_is_projected_without_codes(self):
        facts = owner._quote_authoring_facts({}, {"room_arrangement": [
            {"room_code": "R7", "guest_safe_room_label": "Jardín compartido"}]})
        self.assertEqual(facts["room_label"], "Jardín compartido")
        self.assertNotIn("R7", json.dumps(facts))

    def test_model_recap_only_gates_authoritative_numeric_amounts(self):
        facts = {"currency": "EUR", "total_cents": 16000,
                 "amount_due_now_cents": 16000, "payment_tier": "full",
                 "payment_distribution": "separate", "room_label": "Garden dorm",
                 "per_person_due_now": [{"guest_name": "Léa", "amount_due_cents": 7000},
                                         {"guest_name": "Mia", "amount_due_cents": 9000}]}
        differently_worded = [
            "It comes to €160.",  # no room, names, shares, payment prose, or question
            "R7 is yours for 160 EUR. What would you like to know?",  # no room-code gate
            "€160 — listo.",  # no expected pending intent or register gate
        ]
        for text in differently_worded:
            with self.subTest(text=text):
                self.assertTrue(owner._model_quote_recap_is_authoritative(
                    text, facts, "go_ahead"))
        for text in ("Your stay is ready.", "It comes to €150.",
                     "€1600", "1160 €", "160.000 €", "€1,160.00",
                     "1.160,00 €", "Total €999. Reference 160."):
            with self.subTest(text=text):
                self.assertFalse(owner._model_quote_recap_is_authoritative(
                    text, facts, "go_ahead"))
        for text in ("160 €", "160,00 €", "€160.00"):
            with self.subTest(locale=text):
                self.assertTrue(owner._model_quote_recap_is_authoritative(text, facts))

    def test_typed_party_ineligibility_precedes_legacy_availability_reason(self):
        params = {"check_in": "2027-06-01", "check_out": "2027-06-04",
                  "guest_count": 1, "room_type": "private", "guests": [{"name": "A"}]}
        receipt = {"success": True, "has_enough_beds": False, "available_beds": [],
                   "selected_bed_codes": [], "exact_bed_eligibility": {
                       "eligible": False, "reason": "availability_changed"},
                   "room_eligibility": {"constraint_kind": "party_ineligible",
                       "reason": "private_room_requires_exactly_two_guests",
                       "required_party_size": 2, "required_guests": 2,
                       "actual_party_size": 1, "actual_guests": 1}}
        with patch.object(plugin, "_post_bot", return_value=receipt):
            result = json.loads(plugin.check_availability(params))
        self.assertEqual(result["constraint_kind"], "party_ineligible")
        self.assertEqual(result["ineligible_reason"],
                         "private_room_requires_exactly_two_guests")
        self.assertEqual((result["required_party_size"], result["required_guests"],
                          result["actual_party_size"], result["actual_guests"]), (2, 2, 1, 1))
        self.assertFalse(result["date_widening_allowed"])

    def test_real_staff_constraint_keys_protect_solo_private_room(self):
        params = {"check_in": "2027-06-01", "check_out": "2027-06-04",
                  "guest_count": 1, "room_type": "private", "guests": [{"name": "A"}]}
        receipt = {"success": True, "has_enough_beds": False, "available_beds": [],
                   "selected_bed_codes": [],
                   "constraint_code": "private_room_requires_exactly_two_guests",
                   "party_size": 1, "next_action": "ask_room_eligibility"}
        with patch.object(plugin, "_post_bot", return_value=receipt):
            result = json.loads(plugin.check_availability(params))
        self.assertEqual(result["constraint_code"], receipt["constraint_code"])
        self.assertEqual(result["party_size"], 1)
        self.assertEqual(result["constraint_kind"], "party_ineligible")
        self.assertEqual(result["ineligible_reason"], receipt["constraint_code"])
        self.assertFalse(result["date_widening_allowed"])
        self.assertNotEqual(result["next_action"], "ask_room_eligibility")

    def test_actual_offer_path_rewrites_bad_amount_once_without_styled_fallback(self):
        bad, rewritten = "Total €1200.", "Total 120,00 €."
        offer = {"currency": "EUR", "total_cents": 12000,
                 "payment_link_amount_cents": 12000, "payment_choice": "full",
                 "room_arrangement": [{"bed_code": "G1"}]}
        state = {"status": "offered", "quote": {"success": True, "offer_revision": offer,
                 "quote_authoring_facts": owner._quote_authoring_facts({}, offer)},
                 "checked_offer": offer, "offer_message": "message-1", "scope": {},
                 "incarnation": 1, "plan": {"guest_count": 1}, "pending_question": None}
        result = {"completed": True, "final_response": bad,
                  "messages": [{"role": "assistant", "content": bad}]}
        calls = []
        with patch.object(owner, "_transaction", side_effect=lambda callback: callback(
                state, {"tenant": "wolfhouse-somo", "MESSAGE_ID": "message-1"})), \
             patch.object(owner, "_styled_quote_copy") as styled:
            final = owner.finalize_offer_response(
                result, lambda facts, draft: calls.append((facts, draft)) or rewritten)
        self.assertEqual(len(calls), 1)
        self.assertEqual(final["final_response"], rewritten)
        styled.assert_not_called()

    def test_production_finalizer_retries_complete_money_mismatches_and_suppresses_bad_retry(self):
        offer = {"currency": "EUR", "total_cents": 16000,
                 "payment_link_amount_cents": 16000, "payment_choice": "full",
                 "room_arrangement": [{"bed_code": "G1"}]}
        for bad in ("€1,160.00", "1.160,00 €", "Total €999. Reference 160."):
            with self.subTest(bad=bad):
                state = {"status": "offered", "quote": {"success": True,
                         "offer_revision": offer,
                         "quote_authoring_facts": owner._quote_authoring_facts({}, offer)},
                         "checked_offer": offer, "offer_message": "message-1", "scope": {},
                         "incarnation": 1, "plan": {"guest_count": 1},
                         "pending_question": None}
                calls = []
                result = {"completed": True, "final_response": bad,
                          "messages": [{"role": "assistant", "content": bad}]}
                with patch.object(owner, "_transaction", side_effect=lambda callback: callback(
                        state, {"tenant": "wolfhouse-somo", "MESSAGE_ID": "message-1"})):
                    final = owner.finalize_offer_response(
                        result, lambda facts, draft: calls.append((facts, draft)) or "Still €999.")
                self.assertEqual(len(calls), 1)
                self.assertIsNone(final["final_response"])
                self.assertIsNone(final["messages"][-1]["content"])

    def test_blocked_transfer_reaches_confirmation_rewrite_facts(self):
        receipt = {"success": True, "write_performed": True, "booking_code": "TEST-1",
                   "transfer_save_results": [{"status": "blocked", "write_performed": False,
                       "reason_code": "trusted_test_guard",
                       "requested_transfer": {"scheduled_at": "2027-06-01T12:00:00Z"}}]}
        state = {"status": "idle", "checked_offer": {"total_cents": 10000},
                 "completion": receipt, "plan": {}, "scope": {}}
        seen = []
        result = {"completed": True, "final_response": "draft",
                  "messages": [{"role": "assistant", "content": "draft"}]}
        with patch.object(owner, "_transaction", side_effect=lambda callback: callback(
                state, {"tenant": "wolfhouse-somo", "MESSAGE_ID": "message-1"})):
            owner.finalize_offer_response(
                result, lambda facts, draft: seen.append(copy.deepcopy(facts)),
                saved_booking_projection=receipt)
        self.assertEqual(seen[0]["transfer_save_results"], [{
            "status": "blocked", "scheduled_at": "2027-06-01T12:00:00Z",
            "reason_code": "trusted_test_guard"}])

    def test_ordinary_test_dispatch_preserves_trusted_transfer_guard_result(self):
        pending = {"direction": "arrival", "airport": "BIO",
                   "scheduled_at": "2027-06-01T12:00:00Z"}
        calls = []
        def staff(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            if path == "/transfers/save":
                return {"success": False, "write_performed": False, "status": "blocked",
                        "reason_code": "trusted_test_guard"}
            return {"success": True, "write_performed": True, "booking_id": "test-id",
                    "booking_code": "TEST-1"}
        payload = {"client_slug": "wolfhouse-somo", "check_in": "2027-06-01",
                   "check_out": "2027-06-04", "guest_count": 1, "guest_name": "A",
                   "guests": [{"name": "A"}], "package_code": "package_none",
                   "payment_choice": "full", "room_type": "shared",
                   "selected_bed_codes": ["M1"], "pending_transfers": [pending]}
        with patch.object(plugin, "_post_bot", side_effect=staff), \
             patch.object(plugin, "_room_decision_for_tool", return_value={}):
            result = json.loads(plugin.create_booking_from_plan(payload))
        self.assertEqual([path for path, _ in calls].count("/transfers/save"), 1)
        self.assertEqual(result["transfer_save_results"], [{
            "requested_transfer": pending, "direction": "arrival",
            "write_performed": False, "success": False, "status": "blocked",
            "reason_code": "trusted_test_guard", "error": None}])


if __name__ == "__main__":
    unittest.main(verbosity=2)
