"""Captain R1-R5 source-bound regressions; offline and transport-free."""
import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from gateway.session_context import clear_session_vars, set_session_vars
from hermes_state import SessionDB
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

    def test_r3_partial_female_roster_overrides_stale_male_group_guess(self):
        decision = plugin._room_decision_for_tool({
            "guest_count": 2,
            "group_gender": "male",
            "room_name_hints": [{"name": "Alex", "explicit_gender": "female"}],
        }, {"girls_room_available": True, "guys_room_available": True})
        self.assertEqual(decision["resolved_composition"], "unknown", decision)
        self.assertTrue(decision["clarification_needed"], decision)
        self.assertNotIn("male_only", decision["allowed_room_preferences"], decision)
        self.assertNotIn("female_only", decision["allowed_room_preferences"], decision)
        calls = []
        def staff(path, payload):
            calls.append((path, deepcopy(payload)))
            return {"success": False, "needs_clarification": True,
                    "guest_safe_next_action": "Synthetic boundary."}
        with patch.object(plugin, "_post_bot", side_effect=staff):
            json.loads(plugin.quote_booking.__wrapped__({
                "check_in": "2026-11-09", "check_out": "2026-11-12",
                "guest_count": 2, "room_type": "shared",
                "room_preference": "female_only", "package_code": "package_none",
                "group_gender": "male",
                "guests": [{"name": "Alex", "explicit_gender": "female"}],
            }, _owner_validated_guest_eligibility={0: "female"}))
        self.assertEqual("/availability-check", calls[0][0])
        self.assertNotIn("group_gender", calls[0][1])
        self.assertEqual(
            [{"name": "Alex", "explicit_gender": "female"}],
            calls[0][1]["room_name_hints"],
        )

    def test_r4_negated_room_questions_keep_predicate_through_real_finalizer(self):
        cases = {
            'Can everyone stay in a room that is not female-only?': {
                'es': '¿Pueden todas las personas alojarse en una habitación que no sea solo para mujeres?',
                'fr': "Tout le monde peut-il séjourner dans une chambre qui n'est pas réservée aux femmes ?",
                'de': 'Können alle Gäste in einem Zimmer übernachten, das nicht nur für Frauen ist?',
            },
            'Are any guests not comfortable staying in a female-only room?': {
                'es': '¿Hay algún huésped que no se sienta cómodo alojándose en una habitación solo para mujeres?',
                'fr': "Y a-t-il des personnes qui ne sont pas à l'aise dans une chambre réservée aux femmes ?",
                'de': 'Gibt es Gäste, die sich nicht wohl dabei fühlen, in einem Frauenzimmer zu übernachten?',
            },
        }
        for question, translations in cases.items():
            for language, expected in translations.items():
                for guest_count in (1, 2, 3):
                    with self.subTest(question=question, language=language,
                                      guest_count=guest_count):
                        state = {
                            'status': 'blocked',
                            'guest_language': language,
                            'plan': {'guest_count': guest_count, 'language': language},
                            'quote': {
                                'quote_status': 'needs_guest_clarification',
                                'guest_safe_next_action': question,
                                'offer_revision': None,
                            },
                            'offer_message': 'sim19-negation',
                        }
                        ingress = {'MESSAGE_ID': 'sim19-negation',
                                   'tenant': 'wolfhouse-somo'}
                        with patch.object(
                                accepted_quote, '_transaction',
                                side_effect=lambda operation: operation(state, ingress)):
                            shown = accepted_quote.finalize_offer_response({
                                'completed': True,
                                'final_response': 'draft',
                                'messages': [{'role': 'assistant', 'content': 'draft'}],
                            })
                        self.assertEqual(expected, shown['final_response'])
                        self.assertEqual(expected, shown['messages'][-1]['content'])

    def test_r4_registered_quote_persists_exact_question_meaning_for_all_party_sizes(self):
        cases = {
            'Are all four guests women?': {
                'en': 'Are all four guests women?',
                'es': '¿Son mujeres las cuatro huéspedes?',
                'fr': 'Les quatre personnes sont-elles des femmes ?',
                'de': 'Sind alle vier Gäste Frauen?',
            },
            'Can everyone stay in a room that is not female-only?': {
                'en': 'Can everyone stay in a room that is not female-only?',
                'es': '¿Pueden todas las personas alojarse en una habitación que no sea solo para mujeres?',
                'fr': "Tout le monde peut-il séjourner dans une chambre qui n'est pas réservée aux femmes ?",
                'de': 'Können alle Gäste in einem Zimmer übernachten, das nicht nur für Frauen ist?',
            },
            'Are any guests not comfortable staying in a female-only room?': {
                'en': 'Are any guests not comfortable staying in a female-only room?',
                'es': '¿Hay algún huésped que no se sienta cómodo alojándose en una habitación solo para mujeres?',
                'fr': "Y a-t-il des personnes qui ne sont pas à l'aise dans une chambre réservée aux femmes ?",
                'de': 'Gibt es Gäste, die sich nicht wohl dabei fühlen, in einem Frauenzimmer zu übernachten?',
            },
            'Can everyone stay in a room that is not male-only?': {
                'en': 'Can everyone stay in a room that is not male-only?',
                'es': '¿Pueden todas las personas alojarse en una habitación que no sea solo para hombres?',
                'fr': "Tout le monde peut-il séjourner dans une chambre qui n'est pas réservée aux hommes ?",
                'de': 'Können alle Gäste in einem Zimmer übernachten, das nicht nur für Männer ist?',
            },
            'Are any guests not comfortable staying in a male-only room?': {
                'en': 'Are any guests not comfortable staying in a male-only room?',
                'es': '¿Hay algún huésped que no se sienta cómodo alojándose en una habitación solo para hombres?',
                'fr': "Y a-t-il des personnes qui ne sont pas à l'aise dans une chambre réservée aux hommes ?",
                'de': 'Gibt es Gäste, die sich nicht wohl dabei fühlen, in einem Männerzimmer zu übernachten?',
            },
        }
        ingresses = {
            'en': 'Please check this room.',
            'es': 'Hola, quiero comprobar esta habitación.',
            'fr': 'Bonjour, je voudrais vérifier cette chambre.',
            'de': 'Hallo, ich möchte dieses Zimmer prüfen.',
        }
        with tempfile.TemporaryDirectory() as root, \
                patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}):
            db = SessionDB(Path(root) / 'state.db')
            try:
                for question, translations in cases.items():
                    for language, expected in translations.items():
                        for guest_count in (1, 2, 3, 4):
                            with self.subTest(question=question, language=language,
                                              guest_count=guest_count):
                                session_id = f'r2-r4-{len(question)}-{language}-{guest_count}'
                                db.create_session(session_id, source='whatsapp')
                                agent = SimpleNamespace(_session_db=db, session_id=session_id)
                                tokens = set_session_vars(
                                    platform='whatsapp', source='whatsapp', chat_id=session_id,
                                    user_id='france-wolfhouse-test', session_key=session_id,
                                    session_id=session_id, message_id=session_id + '-turn')
                                try:
                                    accepted_quote.observe_owner_turn(agent, ingresses[language])
                                    response = {
                                        'success': False,
                                        'needs_clarification': True,
                                        'selected_bed_codes': [],
                                        'guest_safe_next_action': question,
                                    }
                                    params = {
                                        'check_in': '2026-11-09',
                                        'check_out': '2026-11-12',
                                        'guest_count': guest_count,
                                        'room_type': 'shared',
                                        'room_preference': ('female_only' if 'female' in question
                                                            or 'women' in question else 'male_only'),
                                        'package_code': 'package_none',
                                        'language': language,
                                    }
                                    with patch.object(plugin, '_post_bot', return_value=response):
                                        tool_result = json.loads(plugin.quote_booking(params))
                                    self.assertEqual(question,
                                                     tool_result['guest_safe_next_action'])
                                    shown = accepted_quote.finalize_offer_response({
                                        'completed': True,
                                        'final_response': 'draft',
                                        'messages': [{'role': 'assistant', 'content': 'draft'}],
                                    })
                                    self.assertEqual(expected, shown['final_response'])
                                    self.assertEqual(expected, shown['messages'][-1]['content'])
                                finally:
                                    clear_session_vars(tokens)
                                    accepted_quote._current.set(None)
            finally:
                db.close()

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
