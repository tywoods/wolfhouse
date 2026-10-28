"""Pass 5 owner lifecycle regressions using the installed conversation owner."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "plugins"
sys.path.insert(0, str(PLUGIN_DIR))

from wolfhouse import accepted_quote as ledger
from wolfhouse import pending_question
from wolfhouse import test_first_yes_owner as owner_fixtures


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
