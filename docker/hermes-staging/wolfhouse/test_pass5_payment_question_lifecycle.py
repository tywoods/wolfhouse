"""Pass 5 owner lifecycle regressions using the installed conversation owner."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "plugins"
sys.path.insert(0, str(PLUGIN_DIR))

from wolfhouse import accepted_quote as ledger
from wolfhouse import pending_question
from wolfhouse import test_first_yes_owner as owner_fixtures
import wolfhouse_staff_api as plugin


class Pass5PaymentQuestionLifecycleTests(unittest.TestCase):
    def owner_case(self):
        case = owner_fixtures.FirstYesOwnerTests(methodName="test_only_owner_final_question_authorizes_contextual_yes")
        case.setUp()
        self.addCleanup(case.tearDown)
        return case

    def test_clarify_combined_answers_replace_stale_shuttle_target(self):
        case = self.owner_case()
        ledger.record_quote(case.plan, case.response)
        ledger.finalize_offer_response({"completed": True, "final_response": "draft"})
        ledger._transaction(lambda state, _ingress: state.update(
            pending_question={"kind": "add_on"}))

        raw = "No shuttle, separate links, and full payment please."
        case.turn("combined-pass5", raw)
        result = ledger.interpret_owner_turn({
            "action": "clarify", "action_evidence": raw,
            "ambiguous": False, "negated": False, "conditional": False,
            "material_changes": [],
            "completions": {
                "shuttle_choice": {"value": "declined", "evidence": "No shuttle"},
                "payment_link_distribution": {"value": "separate", "evidence": "separate links"},
                "payment_choice": {"value": "full", "evidence": "full payment"},
            },
        })
        self.assertEqual(result["next_action"], "requote_material_changes")
        state = ledger._transaction(lambda owner, _ingress: deepcopy(owner))
        self.assertNotIn("pending_question", state)
        self.assertEqual(state["completion_plan"]["shuttle_choice"], "declined")
        self.assertEqual(state["completion_plan"]["pending_transfers"], [])
        self.assertEqual(state["completion_plan"]["payment_link_distribution"], "separate")
        self.assertIs(state["completion_plan"]["per_guest_payment_links"], True)
        self.assertEqual(state["completion_plan"]["payment_choice"], "full")
        retry = ledger.prepare_quote({})
        self.assertEqual(retry["payment_link_distribution"], "separate")
        self.assertIs(retry["per_guest_payment_links"], True)
        self.assertEqual(retry["shuttle_choice"], "declined")

    def test_split_completion_keeps_same_turn_name_expansion(self):
        case = self.owner_case()
        ledger.record_quote(case.plan, case.response)
        ledger.finalize_offer_response({"completed": True, "final_response": "draft"})
        raw = "Alex Rivera, and separate links please."
        case.turn("split-with-name", raw)
        result = ledger.interpret_owner_turn({
            "action": "clarify", "action_evidence": raw,
            "ambiguous": False, "negated": False, "conditional": False,
            "material_changes": [],
            "completions": {
                "guests": [{"guest_index": 0, "name": "Alex Rivera",
                            "evidence": "Alex Rivera"}],
                "payment_link_distribution": {"value": "separate",
                                              "evidence": "separate links"},
            },
        })
        state = ledger._transaction(lambda owner, _ingress: deepcopy(owner))
        self.assertEqual(result["next_action"], "requote_material_changes")
        self.assertEqual(state["completion_plan"]["guests"][0]["name"], "Alex Rivera")
        self.assertEqual(state["completion_plan"]["payment_link_distribution"], "separate")

    def test_split_completion_keeps_same_turn_date_revision(self):
        case = self.owner_case()
        ledger.record_quote(case.plan, case.response)
        ledger.finalize_offer_response({"completed": True, "final_response": "draft"})
        raw = "Change checkout to 2026-11-09 and use separate links."
        case.turn("split-with-date", raw)
        result = ledger.interpret_owner_turn({
            "action": "revise", "action_evidence": raw,
            "ambiguous": False, "negated": False, "conditional": False,
            "material_changes": [{"field": "check_out", "value": "2026-11-09",
                                  "evidence": "checkout to 2026-11-09"}],
            "completions": {
                "payment_link_distribution": {"value": "separate",
                                              "evidence": "separate links"},
            },
        })
        state = ledger._transaction(lambda owner, _ingress: deepcopy(owner))
        self.assertEqual(result["next_action"], "requote_material_changes")
        self.assertEqual(state["authorized_revision_changes"], [{
            "field": "check_out", "value": "2026-11-09",
            "evidence": "checkout to 2026-11-09"}])
        self.assertEqual(state["completion_plan"]["payment_link_distribution"], "separate")

    def test_conditional_split_completion_still_requires_clarification(self):
        case = self.owner_case()
        ledger.record_quote(case.plan, case.response)
        ledger.finalize_offer_response({"completed": True, "final_response": "draft"})
        raw = "If fees are waived, use separate links."
        case.turn("conditional-split", raw)
        result = ledger.interpret_owner_turn({
            "action": "clarify", "action_evidence": raw,
            "ambiguous": False, "negated": False, "conditional": True,
            "material_changes": [],
            "completions": {
                "payment_link_distribution": {"value": "separate",
                                              "evidence": "separate links"},
            },
        })
        state = ledger._transaction(lambda owner, _ingress: deepcopy(owner))
        self.assertEqual(result["next_action"], "clarify_condition")
        self.assertTrue(result["question_required"])
        self.assertEqual(state["completion_plan"]["payment_link_distribution"], "separate")

    def test_split_completion_validates_malformed_sibling_completion(self):
        case = self.owner_case()
        ledger.record_quote(case.plan, case.response)
        ledger.finalize_offer_response({"completed": True, "final_response": "draft"})
        raw = "Separate links; Alex Rivera."
        case.turn("split-malformed-sibling", raw)
        with self.assertRaisesRegex(ledger.QuoteBoundaryError, "quote_intent_schema_invalid"):
            ledger.interpret_owner_turn({
                "action": "clarify", "action_evidence": raw,
                "ambiguous": False, "negated": False, "conditional": False,
                "material_changes": [],
                "completions": {
                    "guests": "Alex Rivera",
                    "payment_link_distribution": {"value": "separate",
                                                  "evidence": "Separate links"},
                },
            })

    def test_combined_completion_applies_name_date_condition_and_distribution_atomically(self):
        case = self.owner_case()
        ledger.record_quote(case.plan, case.response)
        ledger.finalize_offer_response({"completed": True, "final_response": "draft"})
        raw = "If fees are waived, change checkout to 2026-11-09 for Alex Rivera and use separate links."
        case.turn("combined-atomic-adjudication", raw)
        result = ledger.interpret_owner_turn({
            "action": "revise", "action_evidence": raw,
            "ambiguous": False, "negated": False, "conditional": True,
            "material_changes": [{"field": "check_out", "value": "2026-11-09",
                                  "evidence": "checkout to 2026-11-09"}],
            "completions": {
                "guests": [{"guest_index": 0, "name": "Alex Rivera",
                            "evidence": "Alex Rivera"}],
                "payment_link_distribution": {"value": "separate",
                                              "evidence": "separate links"},
            },
        })
        state = ledger._transaction(lambda owner, _ingress: deepcopy(owner))
        self.assertEqual(result["next_action"], "clarify_condition")
        self.assertEqual(state["completion_plan"]["guests"][0]["name"], "Alex Rivera")
        self.assertEqual(state["completion_plan"]["payment_link_distribution"], "separate")
        self.assertEqual(state["authorized_revision_changes"][0]["value"], "2026-11-09")

    def test_unknown_distribution_stays_unknown_on_retry(self):
        self.owner_case()
        retry = ledger.prepare_quote({})
        self.assertNotIn("payment_link_distribution", retry)
        self.assertNotIn("per_guest_payment_links", retry)

    def test_shuttle_acceptance_does_not_fabricate_transfer_requests(self):
        state = {"pending_question": {"kind": "add_on"}, "plan": {}}
        bound = pending_question.bind_answer(state, "accept", "yes")
        self.assertEqual(bound["answer"], "accepted")
        self.assertEqual(state["plan"]["shuttle_choice"], "accepted")
        self.assertNotIn("pending_transfers", state["plan"])

    def test_fact_equivalent_refresh_replaces_stale_target_atomically(self):
        case = self.owner_case()
        ledger.record_quote(case.plan, case.response)
        ledger.finalize_offer_response({"completed": True, "final_response": "old shuttle question"})
        ledger._transaction(lambda state, _ingress: state.update(
            pending_question={"kind": "add_on"}))
        raw = "No shuttle, separate links, and full payment please."
        case.turn("atomic-refresh", raw)
        ledger.interpret_owner_turn({
            "action": "clarify", "action_evidence": raw,
            "ambiguous": False, "negated": False, "conditional": False,
            "material_changes": [],
            "completions": {
                "shuttle_choice": {"value": "declined", "evidence": "No shuttle"},
                "payment_link_distribution": {"value": "separate", "evidence": "separate links"},
                "payment_choice": {"value": "full", "evidence": "full payment"},
            },
        })
        prepared = ledger.prepare_quote({})
        beds = case.response["offer_revision"]["room_arrangement"]
        refreshed = case._checked_offer(prepared, beds)
        ledger.record_quote(prepared, refreshed)
        final = ledger.finalize_offer_response({"completed": True, "final_response": "model draft"})
        state = ledger._transaction(lambda owner, _ingress: deepcopy(owner))
        self.assertEqual(state["pending_question"], {"kind": "go_ahead"})
        self.assertNotEqual(final["final_response"], "model draft")
        self.assertIn(pending_question.go_ahead_question("en"), final["final_response"])
        self.assertEqual(state["presentation"]["displayed_text"], final["final_response"])
        self.assertEqual(state["presented_offer"], state["checked_offer"])

    def test_registered_create_separate_full_returns_staff_links(self):
        case = self.owner_case()
        plan = {**case.plan, "payment_choice": "full",
                "payment_link_distribution": "separate",
                "payment_distribution": "separate",
                "per_guest_payment_links": True,
                "shuttle_choice": "declined", "pending_transfers": []}
        beds = case.response["offer_revision"]["room_arrangement"]
        response = case._checked_offer(plan, beds)
        ledger.record_quote(plan, response)
        shown = ledger.finalize_offer_response({"completed": True, "final_response": "draft"})
        raw = "Yes, save this booking."
        case.turn("pass5-create-full-split", raw)
        case.interpret_accept(raw)

        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **tool): self.tools[tool["name"]] = tool
            def register_hook(self, *args, **kwargs): pass

        registry = Registry()
        plugin.register(registry)
        requests = []

        def staff(path, body):
            requests.append((path, deepcopy(body)))
            if path == "/contact-identity":
                return {"success": True, "identity_verified": True, "contact_name": "Alex"}
            if path == "/booking-preview":
                return response
            if path == "/availability-check":
                return case._exact_recheck(body, beds)
            if path == "/booking-create-from-plan":
                self.assertNotIn("payment_distribution", body)
                self.assertEqual(body["payment_link_distribution"], "separate")
                self.assertEqual(body["payment_choice"], "full")
                return {"success": True, "write_performed": True,
                        "booking_id": "pass5-booking", "booking_code": "PASS5",
                        "uses_per_guest_model": True,
                        "booking_guests": [
                            {"booking_guest_id": "g1", "guest_number": 1, "guest_name": "Alex"},
                            {"booking_guest_id": "g2", "guest_number": 2, "guest_name": "Sam"}]}
            if path.startswith("/booking-guests/") and path.endswith("/create-payment-link"):
                guest_id = path.split("/")[2]
                index = 1 if guest_id == "g1" else 2
                self.assertEqual(body["payment_target"], "full_share")
                return {"success": True, "booking_guest_id": guest_id,
                        "guest_number": index, "guest_name": "Alex" if index == 1 else "Sam",
                        "amount_due_cents": 10000, "currency": "EUR",
                        "payment_target": "full_share", "payment_id": f"pay-{index}",
                        "guest_payment_url": f"https://staff.test/pay/{index}"}
            if path == "/bookings/update-contact":
                return {"success": True, "email_saved": True, "email_sent": False}
            self.fail(f"unexpected Staff path {path}")

        from wolfhouse import booking_names
        token = booking_names._agent.set(case.agent)
        try:
            with patch.object(plugin, "_post_bot", side_effect=staff):
                booking_names.begin_turn(session_id=case.agent.session_id,
                                         scope=plugin._booking_name_scope())
                result = json.loads(registry.tools["create_booking_from_plan"]["handler"]({}))
        finally:
            booking_names.end_turn()
            booking_names._agent.reset(token)

        self.assertTrue(result["success"], result)
        links = result["guest_payment_links"]
        self.assertEqual([row["guest_name"] for row in links], ["Alex", "Sam"])
        self.assertEqual([row["amount_due_cents"] for row in links], [10000, 10000])
        self.assertEqual([row["payment_target"] for row in links], ["full_share", "full_share"])
        self.assertEqual(len([path for path, _ in requests
                              if path == "/booking-create-from-plan"]), 1)
        self.assertIn(pending_question.go_ahead_question("en"), shown["final_response"])

    def test_full_only_renderer_uses_single_localized_save_question(self):
        for language in ("en", "es", "it", "de", "fr"):
            with self.subTest(language=language):
                plan = {"check_in": "2026-11-01", "check_out": "2026-11-02",
                        "guest_count": 1, "room_type": "shared",
                        "package_code": "package_none", "language": language,
                        "payment_choice": "full"}
                offer = {**plan, "currency": "EUR", "total_cents": 10000,
                         "deposit_required_cents": 10000, "full_payment_only": True,
                         "room_arrangement": [{"bed_code": "M1", "room_code": "M"}]}
                text = ledger._styled_quote_copy(plan, offer, language, create_ready=False)
                save = pending_question.go_ahead_question(language)
                self.assertEqual(text.count(save), 1)
                self.assertNotIn("exact", text.casefold())
                self.assertNotIn("exacte", text.casefold())


if __name__ == "__main__":
    unittest.main()
