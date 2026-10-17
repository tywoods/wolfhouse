"""Captain R3 person-bound initial eligibility regressions (offline)."""
import inspect
import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from gateway.session_context import clear_session_vars, set_session_vars
from hermes_state import SessionDB
from wolfhouse import accepted_quote
import wolfhouse_staff_api as plugin


class Registry:
    def __init__(self):
        self.tools, self.hooks = {}, {}

    def register_tool(self, **tool):
        self.tools[tool['name']] = tool

    def register_hook(self, name, fn):
        self.hooks[name] = fn


class CaptainR3Tests(unittest.TestCase):
    def registered_quote(self, raw, guests):
        """Exercise plugin.register's handler and capture its Staff-bound body."""
        registry = Registry()
        with patch.object(accepted_quote, 'install_owner_hook'):
            plugin.register(registry)
        with tempfile.TemporaryDirectory() as home:
            db = SessionDB(Path(home) / 'state.db')
            db.create_session('captain-r3', source='whatsapp')
            owner = SimpleNamespace(_session_db=db, session_id='captain-r3',
                                    model='offline', platform='whatsapp',
                                    _user_id='captain-r3-user')
            tokens = set_session_vars(
                platform='whatsapp', source='whatsapp', chat_id='captain-r3-chat',
                user_id='captain-r3-user', session_key='captain-r3-key',
                session_id=owner.session_id, message_id='captain-r3-message')
            calls = []
            try:
                with patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}):
                    accepted_quote.observe_owner_turn(owner, raw)
                    params = {
                        'check_in': '2027-01-01', 'check_out': '2027-01-02',
                        'guest_count': len(guests), 'room_type': 'shared',
                        'room_preference': 'female_only',
                        'package_code': 'package_none', 'guests': guests}
                    with patch.object(plugin, '_post_bot', side_effect=lambda path, body: (
                            calls.append((path, body)) or self.receipt('female_only'))):
                        result = json.loads(registry.tools['quote_booking']['handler'](params))
                    return result, calls
            finally:
                accepted_quote.close_turn()
                clear_session_vars(tokens)
                db.close()

    def validated_state(self, state, guests):
        capability = object()
        prepared = accepted_quote.PreparedPlan({'guests': guests}, capability, state['epoch'])
        with patch.object(accepted_quote, '_current') as current, \
                patch.object(accepted_quote, '_transaction') as transaction:
            current.get.return_value = capability
            transaction.side_effect = lambda operation: operation(state, {})
            return accepted_quote.validated_guest_eligibility(prepared)

    def validated(self, raw, guests):
        capability = object()
        prepared = accepted_quote.PreparedPlan({'guests': guests}, capability, 0)
        state = {'epoch': 0, 'current_turn': {'raw': raw}}
        with patch.object(accepted_quote, '_current') as current, \
                patch.object(accepted_quote, '_transaction') as transaction:
            current.get.return_value = capability
            transaction.side_effect = lambda operation: operation(state, {})
            return accepted_quote.validated_guest_eligibility(prepared)

    def quote(self, params, allowed, receipt):
        calls = []
        def post(path, payload):
            calls.append((path, payload))
            return receipt
        with patch.object(plugin, '_post_bot', side_effect=post):
            result = json.loads(plugin.quote_booking.__wrapped__(
                params, _owner_validated_guest_eligibility=allowed))
        return result, calls

    @staticmethod
    def receipt(room_type):
        return {'success': True, 'quote_total_cents': 10000,
                'deposit_required_cents': 2000, 'balance_due_cents': 8000,
                'girls_room_available': room_type == 'female_only'}

    def test_fresh_solo_female_and_male_are_consistent(self):
        for value, noun, room in (('female', 'woman', 'female_only'),
                                  ('male', 'man', 'male_only')):
            raw = f"I'm a {noun}; {room} please"
            guests = [{'name': 'Alex', 'explicit_gender': value,
                       'gender_evidence': f"I'm a {noun}"}]
            allowed = self.validated(raw, guests)
            self.assertEqual(allowed, {0: value})
            result, calls = self.quote({
                'check_in': '2027-01-01', 'check_out': '2027-01-02',
                'guest_count': 1, 'package_code': 'package_none',
                'room_preference': room, 'guests': guests}, allowed,
                self.receipt(room))
            sent = calls[0][1]
            expected = [{'name': 'Alex', 'explicit_gender': value}]
            self.assertEqual(sent['guests'], expected)
            self.assertEqual(sent['room_name_hints'], expected)
            self.assertEqual(result['room_decision']['resolved_composition'], value)
            self.assertFalse(result['room_decision']['clarification_needed'])

    def test_explicit_all_women_group_is_person_bound(self):
        evidence = 'Ana and Bea are both women'
        guests = [{'name': name, 'explicit_gender': 'female',
                   'gender_evidence': evidence} for name in ('Ana', 'Bea')]
        allowed = self.validated(evidence + '; female-only please', guests)
        self.assertEqual(allowed, {0: 'female', 1: 'female'})
        result, calls = self.quote({
            'check_in': '2027-01-01', 'check_out': '2027-01-02',
            'guest_count': 2, 'package_code': 'package_none',
            'room_preference': 'female_only', 'guests': guests}, allowed,
            self.receipt('female_only'))
        expected = [{'name': name, 'explicit_gender': 'female'} for name in ('Ana', 'Bea')]
        self.assertEqual(calls[0][1]['room_name_hints'], expected)
        self.assertEqual(result['room_decision']['resolved_composition'], 'female')

    def test_unknown_name_room_and_arbitrary_group_fields_do_not_prove_person(self):
        # The model supplies meaning; a room preference/group field is not a
        # structured person fact. No raw-text parser may mint one here.
        guests = [{'name': 'Nora'}]
        self.assertEqual(self.validated('Nora wants the women room', guests), {})
        self.assertEqual(self.validated('Nora is coming', guests), {})
        result, calls = self.quote({
            'check_in': '2027-01-01', 'check_out': '2027-01-02',
            'guest_count': 1, 'package_code': 'package_none',
            'room_preference': 'female_only', 'guests': guests,
            'group_gender': 'female'}, {}, self.receipt('female_only'))
        self.assertNotIn('room_name_hints', calls[0][1])
        self.assertTrue(result['room_decision']['clarification_needed'])
        self.assertEqual(result['next_action'], 'ask_room_eligibility')
        self.assertFalse(result['staff_review_needed'])

    def test_other_person_and_negated_facts_never_authorize_slot_zero(self):
        for raw in ('Bea is a woman', 'Bea is not a woman'):
            with self.subTest(raw=raw):
                # Correct structured interpretation leaves Alex unknown.
                guests = [{'name': 'Alex'}]
                self.assertEqual(self.validated(raw, guests), {})
                _result, calls = self.quote({
                    'check_in': '2027-01-01', 'check_out': '2027-01-02',
                    'guest_count': 1, 'package_code': 'package_none',
                    'room_preference': 'female_only', 'guests': guests}, {},
                    self.receipt('female_only'))
                self.assertNotIn('room_name_hints', calls[0][1])

    def test_registered_adapter_preserves_indexed_model_facts_without_literal_evidence(self):
        for raw in ('oui', 'sí, somos dos', 'Please use the corrected roster'):
            with self.subTest(raw=raw):
                guests = [{'name': 'Alex', 'explicit_gender': 'male'},
                          {'name': 'Bea', 'explicit_gender': 'female'}]
                _result, calls = self.registered_quote(raw, guests)
                self.assertEqual(calls[0][0], '/booking-preview')
                self.assertEqual(calls[0][1]['guests'], guests)
                self.assertEqual(calls[0][1]['room_name_hints'], guests)
                self.assertEqual(calls[0][1]['room_preference'], 'female_only')

    def test_registered_adapter_does_not_infer_from_possessive_predicates(self):
        for raw, names in (("Alex is a woman's husband", ['Alex']),
                           ("I am a woman's husband", ['Alex']),
                           ("Alex and Bea are both women's sons", ['Alex', 'Bea'])):
            with self.subTest(raw=raw):
                guests = [{'name': name} for name in names]
                result, calls = self.registered_quote(raw, guests)
                self.assertEqual(calls[0][1]['guests'], guests)
                self.assertNotIn('room_name_hints', calls[0][1])
                self.assertTrue(result['room_decision']['clarification_needed'])

    def test_registered_adapter_keeps_only_the_person_bound_fact(self):
        raw = 'Bea is a woman; Alex has not supplied eligibility'
        guests = [{'name': 'Alex'}, {'name': 'Bea', 'explicit_gender': 'female'}]
        result, calls = self.registered_quote(raw, guests)
        self.assertEqual(calls[0][0], '/booking-preview')
        self.assertEqual(calls[0][1]['guests'], guests)
        self.assertEqual(calls[0][1]['room_name_hints'], [guests[1]])
        self.assertTrue(result['room_decision']['clarification_needed'])

    def test_registered_adapter_keeps_affirmative_and_room_controls(self):
        cases = (
            ('I am a woman', ['Alex'], True),
            ('Ana and Bea are both women', ['Ana', 'Bea'], True),
            ('Alex wants a female room', ['Alex'], False),
        )
        for raw, names, affirmative in cases:
            with self.subTest(raw=raw):
                guests = [{'name': name, **({'explicit_gender': 'female'}
                           if affirmative else {})} for name in names]
                _result, calls = self.registered_quote(raw, guests)
                sent = calls[0][1]
                self.assertEqual(sent['guests'], guests)
                self.assertEqual('room_name_hints' in sent, affirmative)

    def test_registered_availability_uses_canonical_guest_eligibility(self):
        registry = Registry()
        with patch.object(accepted_quote, 'install_owner_hook'), \
                patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}):
            plugin.register(registry)
        params = {
            'check_in': '2027-01-01', 'check_out': '2027-01-02',
            'guest_count': 1, 'room_type': 'shared',
            'room_preference': 'female_only',
            'guests': [{'name': 'Nora', 'explicit_gender': 'female'}],
        }
        staff_receipt = {
            'success': True, 'has_enough_beds': True,
            'girls_room_available': True,
            'room_options': {'girls_room_available': True,
                             'private_room_available': False},
            'selected_room_code': 'R5', 'selected_bed_codes': ['R5-B3'],
            'available_beds': [{'bed_code': 'R5-B3', 'room_code': 'R5',
                                'room_type': 'female_only',
                                'bed_label': 'R5-B3'}],
        }
        calls = []
        with patch.object(plugin, '_post_bot', side_effect=lambda path, body: (
                calls.append((path, deepcopy(body))) or deepcopy(staff_receipt))):
            result = json.loads(registry.tools['check_availability']['handler'](params))
        expected = [{'name': 'Nora', 'explicit_gender': 'female'}]
        self.assertEqual(calls[0][0], '/availability-check')
        self.assertEqual(calls[0][1]['guests'], expected)
        self.assertEqual(calls[0][1]['room_name_hints'], expected)
        self.assertTrue(result['available'], result)
        self.assertEqual(result['selected_bed_codes'], ['R5-B3'])
        self.assertTrue(result['girls_room_available'])
        self.assertTrue(result['room_options']['girls_room_available'])
        self.assertEqual(result['room_decision']['resolved_composition'], 'female')

    def test_staff_clarification_without_selection_is_not_reported_available(self):
        params = {
            'client_slug': 'wolfhouse-somo',
            'check_in': '2027-01-01', 'check_out': '2027-01-02',
            'guest_count': 2, 'room_type': 'shared',
            'room_preference': 'mixed',
            'guests': [{'name': 'Alex'}, {'name': 'Bea', 'explicit_gender': 'female'}],
        }
        receipt = {
            'success': True, 'has_enough_beds': True, 'needs_clarification': True,
            'selected_bed_codes': [],
            'available_beds': [
                {'bed_code': 'F1', 'room_code': 'F', 'room_type': 'female_only'},
                {'bed_code': 'F2', 'room_code': 'F', 'room_type': 'female_only'},
            ],
        }
        with patch.object(plugin, '_post_bot', return_value=receipt):
            result = json.loads(plugin.check_availability(params))
        self.assertFalse(result['available'], result)
        self.assertEqual(result['availability_status'], 'eligibility_required')

    def test_capture_schema_matches_validator_for_registered_payload(self):
        registry = Registry()
        with patch.object(accepted_quote, 'install_owner_hook'), \
                patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}):
            plugin.register(registry)
        capture = registry.tools['capture_booking_names']
        item = capture['schema']['parameters']['properties']['guests']['items']
        self.assertNotIn('gender_evidence', item['properties'])
        payload = {'guest_count': 1,
                   'guests': [{'name': 'Nora', 'explicit_gender': 'female'}]}
        with patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}):
            result = json.loads(capture['handler'](payload))
        self.assertNotEqual(result['status'], 'invalid_input')

    def test_current_indexed_correction_supersedes_stale_staff_hint(self):
        state = {'epoch': 2, 'checked_offer': {'room_name_hints': [
            {'name': 'Alex', 'explicit_gender': 'female'},
            {'name': 'Bea', 'explicit_gender': 'female'}]}}
        guests = [{'name': 'Alex', 'explicit_gender': 'male'}, {'name': 'Bea'}]
        allowed = self.validated_state(state, guests)
        self.assertEqual(allowed, {0: 'male', 1: 'female'})
        payload = {'guests': deepcopy(guests)}
        plugin._normalize_guests_payload(payload, {0: 'female', 1: 'female'})
        self.assertEqual(payload['guests'], [guests[0],
                         {'name': 'Bea', 'explicit_gender': 'female'}])
        # A reordered roster remaps old hints by exact identity, not old index.
        self.assertEqual(self.validated_state(state, [{'name': 'Bea'},
                         {'name': 'Alex', 'explicit_gender': 'male'}]),
                         {0: 'female', 1: 'male'})

    def test_provisional_quote_remains_authority_after_payment_selection(self):
        revision = {'room_name_hints': [
            {'name': 'Alex', 'explicit_gender': 'female'}]}
        state = {'epoch': 4, 'current_turn': {'raw': 'deposit'},
                 'checked_offer': None, 'quote': {'offer_revision': revision},
                 'completion_plan': {'payment_choice': 'deposit'},
                 'pending_payment_completion': 'deposit'}
        self.assertEqual(self.validated_state(state, [{'name': 'Alex'}]), {0: 'female'})

    def test_two_name_completion_keeps_both_person_bound_hints(self):
        state = {'epoch': 7, 'current_turn': {'raw': 'Alex Grey and Bea Green'},
                 'checked_offer': {'room_name_hints': [
                     {'name': 'Alex', 'explicit_gender': 'female'},
                     {'name': 'Bea', 'explicit_gender': 'female'}],
                     'guest_bed_assignments': [
                         {'guest_index': 0, 'guest_name': 'Alex'},
                         {'guest_index': 1, 'guest_name': 'Bea'}]},
                 'pending_name_completions': [
                     {'guest_index': 0, 'previous_name': 'Alex', 'completed_name': 'Alex Grey'},
                     {'guest_index': 1, 'previous_name': 'Bea', 'completed_name': 'Bea Green'}]}
        guests = [{'name': 'Alex Grey'}, {'name': 'Bea Green'}]
        self.assertEqual(self.validated_state(state, guests), {0: 'female', 1: 'female'})

    def test_first_to_full_name_preserves_slot_hint(self):
        allowed = self.validated('I am a woman, name Alex', [{
            'name': 'Alex', 'explicit_gender': 'female',
            'gender_evidence': 'I am a woman'}])
        result, calls = self.quote({
            'check_in': '2027-01-01', 'check_out': '2027-01-02',
            'guest_count': 1, 'package_code': 'package_none',
            'room_preference': 'female_only',
            'guests': [{'name': 'Alex Grey', 'explicit_gender': 'female'}]},
            allowed, self.receipt('female_only'))
        self.assertEqual(calls[0][1]['room_name_hints'],
                         [{'name': 'Alex Grey', 'explicit_gender': 'female'}])
        self.assertEqual(result['room_decision']['resolved_composition'], 'female')

    def test_same_term_owner_comparison_and_revision_guard_remain(self):
        before = {'offer_fingerprint': 'same', 'guest_bed_assignments': [
            {'guest_index': 0, 'guest_name': 'Alex', 'bed_code': 'F1'}],
            'room_name_hints': [{'name': 'Alex', 'explicit_gender': 'female'}]}
        self.assertTrue(accepted_quote._completion_revision_matches(before, before))
        self.assertNotIn('quote_revision_requires_owner',
                         inspect.getsource(accepted_quote.prepare_quote))
        self.assertIn('preserving omitted draft selections',
                      inspect.getsource(accepted_quote.prepare_quote))


class RegisteredRevalidationTests(unittest.TestCase):
    """Full registered acquisition -> presentation -> completion -> requote paths."""

    def run_path(self, guests, completion_raw, completions, *, provisional):
        from wolfhouse import booking_names
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        registry = Registry()
        with patch.object(accepted_quote, 'install_owner_hook'), \
                patch.object(booking_names, 'install_turn_cleanup'):
            plugin.register(registry)
        with tempfile.TemporaryDirectory() as home:
            db = SessionDB(Path(home) / 'state.db')
            db.create_session('registered-revalidation', source='whatsapp')
            owner = SimpleNamespace(_session_db=db, session_id='registered-revalidation',
                                    model='offline', platform='whatsapp',
                                    _user_id='captain-r3-user')
            tokens = None
            sent = []
            plan = {'check_in': '2027-01-01', 'check_out': '2027-01-02',
                    'guest_count': len(guests), 'room_type': 'shared',
                    'room_preference': 'female_only',
                    'package_code': 'package_none', 'guests': guests}
            if not provisional:
                plan['payment_choice'] = 'deposit'
            beds = [dict(bed_code=f'F{index + 1}', room_code='F',
                         gender_strategy='female_only')
                    for index in range(len(guests))]

            def turn(message_id, raw):
                nonlocal tokens
                if tokens:
                    clear_session_vars(tokens)
                tokens = set_session_vars(
                    platform='whatsapp', source='whatsapp', chat_id='captain-r3-chat',
                    user_id='captain-r3-user', session_key='captain-r3-key',
                    session_id=owner.session_id, message_id=message_id)
                accepted_quote.observe_owner_turn(owner, raw)

            def staff(path, payload):
                self.assertEqual(path, '/booking-preview')
                sent.append(deepcopy(payload))
                priced = {**payload,
                          'payment_choice': payload.get('payment_choice') or 'deposit'}
                response = FirstYesOwnerTests._checked_offer(
                    object.__new__(FirstYesOwnerTests), priced, beds)
                response['girls_room_available'] = True
                response['payment_choice_needed'] = not bool(payload.get('payment_choice'))
                return response

            try:
                with patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}), \
                        patch.object(plugin, '_post_bot', side_effect=staff):
                    turn('offer', ('I am a woman' if len(guests) == 1
                                   else 'Ana and Bea are both women'))
                    first = json.loads(registry.tools['quote_booking']['handler'](plan))
                    accepted_quote.finalize_offer_response(
                        {'completed': True, 'final_response': 'draft'})
                    turn('completion', completion_raw)
                    interpreted = json.loads(
                        registry.tools['interpret_booking_turn']['handler']({
                            'action': 'accept', 'action_evidence': completion_raw,
                            'ambiguous': False, 'negated': False, 'conditional': False,
                            'material_changes': [], 'completions': completions}))
                    second = json.loads(registry.tools['quote_booking']['handler']({}))
                return first, interpreted, second, sent
            finally:
                accepted_quote.close_turn()
                if tokens:
                    clear_session_vars(tokens)
                db.close()

    def test_provisional_payment_revalidation_keeps_registered_authority(self):
        first, interpreted, second, sent = self.run_path(
            [{'name': 'Alex', 'explicit_gender': 'female',
              'gender_evidence': 'I am a woman'}],
            'deposit please',
            {'payment_choice': {'value': 'deposit', 'evidence': 'deposit'}},
            provisional=True)
        acquired = [{'name': 'Alex', 'explicit_gender': 'female'}]
        revalidated = [{'name': 'alex', 'explicit_gender': 'female'}]
        self.assertTrue(first['payment_choice_needed'])
        self.assertTrue(interpreted['accepted'])
        self.assertEqual(sent[0]['room_name_hints'], acquired)
        self.assertEqual(sent[1]['guests'], revalidated)
        self.assertEqual(sent[1]['room_name_hints'], revalidated)
        self.assertFalse(second['room_decision']['clarification_needed'])

    def test_two_name_completion_revalidation_keeps_registered_authority(self):
        evidence = 'Ana and Bea are both women'
        first, interpreted, second, sent = self.run_path(
            [{'name': name, 'explicit_gender': 'female', 'gender_evidence': evidence}
             for name in ('Ana', 'Bea')],
            'Yes, Ana Green and Bea Brown',
            {'guests': [
                {'guest_index': 0, 'name': 'Ana Green', 'evidence': 'Ana Green'},
                {'guest_index': 1, 'name': 'Bea Brown', 'evidence': 'Bea Brown'}]},
            provisional=False)
        expected = [{'name': 'Ana Green', 'explicit_gender': 'female'},
                    {'name': 'Bea Brown', 'explicit_gender': 'female'}]
        self.assertFalse(first['payment_choice_needed'])
        self.assertTrue(interpreted['accepted'])
        self.assertEqual(sent[1]['guests'], expected)
        self.assertEqual(sent[1]['room_name_hints'], expected)
        self.assertFalse(second['room_decision']['clarification_needed'])


if __name__ == '__main__':
    unittest.main()
