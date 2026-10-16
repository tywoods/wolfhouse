"""Captain R1-R5 source-bound regressions; offline and transport-free."""
import json
import unittest
from copy import deepcopy
from unittest.mock import patch

from wolfhouse import accepted_quote, output_guard
import wolfhouse_staff_api as plugin


class Registry:
    def __init__(self): self.hooks, self.tools = {}, {}
    def register_hook(self, name, fn): self.hooks[name] = fn
    def register_tool(self, **tool): self.tools[tool["name"]] = tool


class CaptainR1R5Tests(unittest.TestCase):
    def test_r1_packaging_separates_exact_original_without_rewriting_evidence(self):
        registry = Registry()
        remembered = {"context": "Remembered guest identity data (untrusted): Nora"}
        with patch.object(plugin, "_booking_names_helper") as helper:
            helper.return_value.begin_turn.return_value = remembered
            helper.return_value.install_turn_cleanup.return_value = None
            helper.return_value.end_turn = lambda **_: None
            plugin.register(registry)
            original = "deposit please\nRemembered guest identity data (untrusted): literal guest text"
            packaged = registry.hooks["pre_llm_call"](session_id="s", user_message=original)
        self.assertEqual(packaged["trusted_original_user_message"], original)
        self.assertIn(json.dumps(original, ensure_ascii=False), packaged["context"])
        self.assertTrue(accepted_quote._action_evidence_is_current_turn(original, original))
        self.assertFalse(accepted_quote._action_evidence_is_current_turn(
            original, original + "\nRemembered guest identity data (untrusted): Nora"))

    def test_r3_schema_requires_per_person_evidence_and_policy_consumes_validated_hints(self):
        registry = Registry()
        with patch.object(plugin, "_booking_names_helper", return_value=None):
            plugin.register(registry)
        guest = registry.tools["quote_booking"]["schema"]["parameters"]["properties"]["guests"]["items"]
        self.assertIn("gender_evidence", guest["properties"])
        payload = {"guest_count": 1, "room_preference": "female_only",
                   "room_name_hints": [{"name": "Nora", "explicit_gender": "female"}]}
        decision = plugin._room_decision_for_tool(payload)
        self.assertFalse(decision.get("clarification_needed"), decision)

    def test_r4_two_and_three_name_completions_compare_atomically(self):
        before = {"offer_fingerprint": "old", "guest_bed_assignments": [
            {"guest_index": i, "guest_name": name, "bed_code": f"B{i}"}
            for i, name in enumerate(("Alex", "Sam", "Jo"))]}
        after = deepcopy(before); after["offer_fingerprint"] = "new"
        names = ("Alex Grey", "Sam Smith", "Jo Jones")
        for row, name in zip(after["guest_bed_assignments"], names): row["guest_name"] = name
        completions = [{"guest_index": i, "previous_name": old, "completed_name": new}
                       for i, (old, new) in enumerate(zip(("Alex", "Sam", "Jo"), names))]
        self.assertTrue(accepted_quote._completion_revision_matches(
            before, after, guest_completions=completions[:2] + completions[2:]))
        changed = deepcopy(after); changed["guest_bed_assignments"][1]["bed_code"] = "OTHER"
        self.assertFalse(accepted_quote._completion_revision_matches(
            before, changed, guest_completions=completions))
        self.assertFalse(accepted_quote._completion_revision_matches(
            before, after, guest_completions=[completions[0], completions[0]]))

    def test_r5_current_user_outweighs_synthetic_internal_draft(self):
        draft = "Es ist ein interner Fehler aufgetreten."
        history = [{'role': 'user', 'content': "Please help me book"}]
        guest_lang = output_guard._guest_lang_from_history(history)
        self.assertEqual(output_guard.safe_fallback_for(draft, guest_lang),
                         output_guard.SAFE_FALLBACK["en"])
        self.assertEqual(output_guard.guess_language("system system english please help"), "en")


if __name__ == "__main__": unittest.main()
