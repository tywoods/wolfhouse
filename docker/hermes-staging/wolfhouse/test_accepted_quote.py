"""Offline owner-ledger tracer bullet; real Hermes SessionDB, no business writes."""
import tempfile
import unittest
from copy import deepcopy
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
from hermes_state import SessionDB
from gateway.session_context import set_session_vars, clear_session_vars


class AcceptedQuoteOwnerTests(unittest.TestCase):
    def test_real_owner_acceptance_survives_reopen_and_omitted_picks(self):
        from wolfhouse import accepted_quote
        with tempfile.TemporaryDirectory() as root:
            db = SessionDB(Path(root) / 'state.db')
            db.create_session('offline-owner', source='whatsapp')
            agent = SimpleNamespace(_session_db=db, session_id='offline-owner')
            tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='offline-chat',
                                      user_id='offline-guest', session_key='offline-key',
                                      session_id='offline-owner', message_id='offer-1')
            try:
                with patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}):
                    accepted_quote.observe_owner_turn(agent, 'Please quote this booking')
                    plan = {'check_in': '2026-11-01', 'check_out': '2026-11-08',
                        'guest_count': 2, 'package_code': 'package_none', 'group_gender': 'mixed',
                        'room_type': 'shared', 'room_preference': 'mixed',
                        'guests': [{'name': 'Alex'}, {'name': 'Sam'}], 'payment_choice': 'deposit',
                        'selected_bed_codes': ['M1', 'M2'],
                        'catalog_selections': [{'service_code': 'yoga_class', 'quantity': 2}]}
                    from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
                    beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                            dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
                    response = FirstYesOwnerTests._checked_offer(
                        object.__new__(FirstYesOwnerTests), plan, beds)
                    accepted_quote.record_quote(plan, response)
                    accepted_quote.finalize_offer_response(
                        {'completed': True, 'final_response': 'draft'})
                    clear_session_vars(tokens)
                    tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='offline-chat',
                        user_id='offline-guest', session_key='offline-key', session_id='offline-owner', message_id='accept-2')
                    raw = 'Yes, create the booking with the Yoga session included for both of us'
                    accepted_quote.observe_owner_turn(agent, raw)
                    accepted_quote.interpret_owner_turn({
                        'action': 'accept', 'action_evidence': raw, 'ambiguous': False,
                        'negated': False, 'conditional': False, 'material_changes': [],
                        'completions': {},
                    })
                    db.close()
                    db = SessionDB(Path(root) / 'state.db')
                    agent._session_db = db
                    clear_session_vars(tokens)
                    tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='offline-chat',
                        user_id='offline-guest', session_key='offline-key', session_id='offline-owner', message_id='proceed-3')
                    accepted_quote.observe_owner_turn(agent, 'Please proceed')
                    result = accepted_quote.prepare_create({'confirm': True})
                    self.assertEqual(result['catalog_selections'],
                                     [{'service_code': 'yoga_class', 'quantity': 2}])
                    self.assertEqual(result['check_in'], '2026-11-01')
            finally:
                clear_session_vars(tokens)
                db.close()


class OwnerHostileTests(unittest.TestCase):
    def setUp(self):
        from wolfhouse import accepted_quote
        self.ledger = accepted_quote
        self.temp = tempfile.TemporaryDirectory()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.db.create_session('s1', source='whatsapp')
        self.agent = SimpleNamespace(_session_db=self.db, session_id='s1')
        self.env = patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'})
        self.env.start()
        self.tokens = None
        self.plan = {'check_in': '2026-11-01', 'check_out': '2026-11-08', 'guest_count': 2,
                     'package_code': 'package_none', 'group_gender': 'mixed',
                     'room_type': 'shared', 'room_preference': 'mixed',
                     'guests': [{'name': 'Alex'}, {'name': 'Sam'}],
                     'payment_choice': 'deposit',
                     'selected_bed_codes': ['M1', 'M2'],
                     'catalog_selections': [{'service_code': 'yoga_class', 'quantity': 2}]}
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
        self.response = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), self.plan, beds)
        self.turn('m1', 'Quote this please')
        self.ledger.record_quote(self.plan, self.response)
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})

    def tearDown(self):
        if self.tokens:
            clear_session_vars(self.tokens)
        self.ledger._current.set(None)
        self.env.stop()
        self.db.close()
        self.temp.cleanup()

    def turn(self, message, raw, **changes):
        if self.tokens:
            clear_session_vars(self.tokens)
        scope = dict(platform='whatsapp', source='whatsapp', chat_id='chat1', user_id='guest1',
                     session_key='key1', session_id=self.agent.session_id, message_id=message)
        scope.update(changes)
        self.tokens = set_session_vars(**scope)
        return self.ledger.observe_owner_turn(self.agent, raw)

    def accept(self):
        raw = 'I accept the quote'
        self.turn('m2', raw)
        self.ledger.interpret_owner_turn({
            'action': 'accept', 'action_evidence': raw,
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [], 'completions': {},
        })

    def checked(self, plan=None, beds=None):
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        plan = plan or self.plan
        beds = beds or [dict(bed_code=code, room_code='M', gender_strategy='mixed')
                        for code in plan['selected_bed_codes']]
        return FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), plan, beds)

    def present(self, plan=None, response=None):
        plan = plan or self.plan
        response = response or self.checked(plan)
        self.ledger.record_quote(plan, response)
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        return response

    def interpret(self, raw, action='accept', material_changes=None, completions=None,
                  ambiguous=False, negated=False, conditional=False):
        return self.ledger.interpret_owner_turn({
            'action': action, 'action_evidence': raw, 'ambiguous': ambiguous,
            'negated': negated, 'conditional': conditional,
            'material_changes': material_changes or [], 'completions': completions or {},
        })

    def test_refusal_and_deferral_revoke_accepted_authority(self):
        for index, text in enumerate(('No thanks', 'Not yet', 'Wait')):
            self.turn('offer-refusal-' + str(index), 'Quote this please')
            self.present()
            raw = 'I accept the quote'
            self.turn('accept-refusal-' + str(index), raw)
            self.interpret(raw)
            self.turn('refusal-' + str(index), text)
            self.interpret(text, action='reject')
            with self.assertRaises(self.ledger.QuoteBoundaryError):
                self.ledger.prepare_create({})

    def test_unicode_contact_continuity_and_hostile_mixed_names(self):
        positives = ('MaríaJosé', 'JeanLuc', 'María José', 'Jean-Luc', "O'Connor", 'O’Connor', 'Mari\u0301a Jose\u0301')
        negatives = ('María and stop', 'María change dates', 'JeanLuc and book this',
                     'María 2', 'María; proceed', 'María and please proceed',
                     '-María', 'María--José', 'María  José', 'María\nJosé')
        for index, name in enumerate(positives + negatives):
            with self.subTest(name=name):
                # Independent pre/post-consent scenarios require real new owners.
                self.agent.session_id = 'unicode-before-' + str(index)
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn('offer-name-' + str(index), 'Quote this please')
                self.present()
                self.turn('name-before-' + str(index), 'My name is ' + name)
                with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                            '^quote_owner_acceptance_required$'):
                    self.ledger.prepare_create({})
                self.agent.session_id = 'unicode-after-' + str(index)
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn('reoffer-name-' + str(index), 'Quote this please')
                self.present()
                raw = 'I accept the quote'
                self.turn('accept-name-' + str(index), raw)
                self.interpret(raw)
                completion = 'My name is ' + name
                self.turn('name-after-' + str(index), completion)
                if name not in positives:
                    self.interpret(completion, action='revise', material_changes=['unknown'])
                if name in positives:
                    self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])
                else:
                    with self.assertRaises(self.ledger.QuoteBoundaryError):
                        self.ledger.prepare_create({})

    def test_hostile_revision_cannot_be_reoffered_without_clarification(self):
        raw = 'My name is María change dates'
        self.turn('hostile-revision', raw)
        self.interpret(raw, action='revise', material_changes=['check_in'])
        self.turn('generic-reoffer', 'Quote this please')
        # A neutral turn cannot turn the rejected changed request into acceptance.
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_explicit_bounded_reprice_recovers_with_fresh_acceptance(self):
        self.accept()
        self.turn('bounded-reprice', 'Revise the quote')
        prepared = self.ledger.prepare_quote({})
        self.assertEqual(prepared['catalog_selections'], self.plan['catalog_selections'])
        self.ledger.record_quote(prepared, self.checked(prepared))
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        # Structurally identical revalidation retains the existing acceptance.
        self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])

    def test_contact_revision_retains_omitted_commercial_selections(self):
        self.accept()
        self.turn('contact-only', 'Add my phone number')
        prepared = self.ledger.prepare_quote({'guest_phone': 'offline'})
        self.assertEqual(prepared['catalog_selections'], self.plan['catalog_selections'])
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_quote({'catalog_selections': []})

    def test_accepted_plain_quote_revalidation_has_no_revision_dependency(self):
        raw = 'I accept the quote'
        self.turn('accepted-plain-quote', raw)
        self.interpret(raw)
        self.assertTrue(self.ledger.prepare_create({})['confirm'])
        self.ledger.record_quote({}, self.checked())

    def test_installed_entrypoint_revalidates_completed_name_before_create(self):
        import json
        from agent import conversation_loop
        from wolfhouse.offline_ingress_harness import gateway_ingress
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        self.agent.session_id = 'accepted-name-entrypoint-owner'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = {**self.plan, 'room_type': 'shared', 'room_preference': 'mixed',
                'guests': [{'name': 'Emre'}, {'name': 'Guest Two'}],
                'payment_choice': 'deposit'}
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
        checked = lambda value: FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), value, beds)
        create_calls = []
        def model(agent, text, *args, **kwargs):
            if text == 'Please quote this':
                self.ledger.record_quote(plan, checked(plan))
            else:
                raw = "€ that works. lock it in please — Emre Yilmaz, I'll pay the deposit when you send the link"
                self.ledger.interpret_owner_turn({
                    'action': 'accept', 'action_evidence': "€ that works. lock it in please — Emre Yilmaz, I'll pay the deposit when you send the link",
                    'ambiguous': False, 'negated': False, 'conditional': False,
                    'material_changes': [],
                    'completions': {'guests': [{'guest_index': 0, 'name': 'Emre Yilmaz',
                                                'evidence': 'Emre Yilmaz'}]},
                })
                quote({})
                create(dict(self.ledger.prepare_create({})))
            return {'completed': True, 'final_response': 'offline model edge', 'messages': []}
        def quote(params):
            prepared = self.ledger.prepare_quote(params)
            response = checked(prepared)
            self.ledger.record_quote(prepared, response)
            return json.dumps(response)
        def create(params):
            create_calls.append(dict(params))
            return json.dumps({'success': False, 'write_performed': False})
        with patch.object(conversation_loop, 'run_conversation', model), \
                patch.object(self.ledger, '_registered_quote', None), \
                patch.object(self.ledger, '_registered_create', None), \
                patch.object(self.ledger, '_before_create', None):
            self.ledger.install_owner_hook(create_handler=create, quote_handler=quote)
            gateway_ingress(self.agent, 'Please quote this', 'entrypoint-q',
                            lambda text: conversation_loop.run_conversation(self.agent, text))
            gateway_ingress(self.agent,
                            "€ that works. lock it in please — Emre Yilmaz, I'll pay the deposit when you send the link",
                            'entrypoint-a',
                            lambda text: conversation_loop.run_conversation(self.agent, text))
        self.assertEqual(len(create_calls), 1)
        self.assertEqual(create_calls[0]['guests'][0]['name'], 'Emre Yilmaz')
        self.assertEqual(create_calls[0]['accepted_offer']['guest_bed_assignments'][0]['guest_name'],
                         'emre yilmaz')
        self.assertTrue(create_calls[0]['require_offer_identity'])

    def test_original_combined_turn_completes_first_name_and_accepts_offer(self):
        self.agent.session_id = 'accepted-name-payment-owner'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = {**self.plan, 'room_type': 'shared', 'room_preference': 'mixed',
                'guests': [{'name': 'Emre'}, {'name': 'Guest Two'}],
                'payment_choice': 'deposit'}
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        response = FirstYesOwnerTests._checked_offer(object.__new__(FirstYesOwnerTests), plan, beds)
        self.turn('accepted-name-payment-offer', 'Quote this please')
        self.ledger.record_quote(plan, response)
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        raw = "€ that works. lock it in please — Emre Yilmaz, I'll pay the deposit when you send the link"
        self.turn('accepted-name-payment-completion', raw)
        self.interpret(raw, completions={'guests': [{'guest_index': 0,
            'name': 'Emre Yilmaz', 'evidence': 'Emre Yilmaz'}]})
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    '^quote_owner_acceptance_required$'):
            self.ledger.prepare_create({})
        revalidation = self.ledger.prepare_quote({})
        revalidated_response = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), revalidation, beds)
        self.ledger.record_quote(revalidation, revalidated_response)
        prepared = self.ledger.prepare_create({})
        self.assertEqual(prepared['payment_choice'], 'deposit')
        self.assertEqual(prepared['guests'], [{'name': 'Emre Yilmaz'}, {'name': 'Guest Two'}])
        self.assertEqual(prepared['selected_bed_codes'], ['M1', 'M2'])
        self.assertEqual(prepared['accepted_offer'], revalidated_response['offer_revision'])
        second_revalidation = self.ledger.prepare_quote({})
        unchanged_response = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), second_revalidation, beds)
        self.ledger.record_quote(second_revalidation, unchanged_response)
        self.assertEqual(self.ledger.prepare_create({})['accepted_offer'],
                         unchanged_response['offer_revision'])
        changed_bed_revalidation = self.ledger.prepare_quote({})
        changed_beds = [dict(bed_code='M9', room_code='M', gender_strategy='mixed'), beds[1]]
        changed_response = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), changed_bed_revalidation, changed_beds)
        self.ledger.record_quote(changed_bed_revalidation, changed_response)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    '^quote_owner_acceptance_required$'):
            self.ledger.prepare_create({})

    def test_structured_current_turn_intent_accepts_presented_offer_without_phrase_gate(self):
        self.agent.session_id = 'structured-g4-owner'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = {**self.plan, 'room_type': 'shared', 'room_preference': 'male_only',
                'group_gender': 'male',
                'room_name_hints': [{'name': 'Mateo Ríos', 'explicit_gender': 'male'},
                                    {'name': 'Guest Two', 'explicit_gender': 'male'}],
                'guests': [{'name': 'Mateo Ríos'}, {'name': 'Guest Two'}],
                'payment_choice': 'deposit'}
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='male_only'),
                dict(bed_code='M2', room_code='M', gender_strategy='male_only')]
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        response = FirstYesOwnerTests._checked_offer(object.__new__(FirstYesOwnerTests), plan, beds)
        self.turn('structured-g4-offer', 'Quote this please')
        self.ledger.record_quote(plan, response)
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        raw = 'dale, book it — Mateo Ríos. send deposit link if needed'
        self.turn('structured-g4-accept', raw)
        self.ledger.interpret_owner_turn({
            'action': 'accept',
            'action_evidence': raw,
            'ambiguous': False,
            'negated': False,
            'conditional': False,
            'material_changes': [],
            'completions': {
                'guests': [{'guest_index': 0, 'name': 'Mateo Ríos',
                            'evidence': 'Mateo Ríos'}],
                'payment_choice': {'value': 'deposit',
                                   'evidence': 'send deposit link if needed'},
            },
        })
        prepared = self.ledger.prepare_create({})
        self.assertEqual(prepared['accepted_offer'], response['offer_revision'])
        self.assertEqual(prepared['payment_choice'], 'deposit')

    def _present_checked_for_interpreter(self, session_id, raw):
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        plan = {**self.plan, 'room_type': 'shared', 'room_preference': 'mixed',
                'guests': [{'name': 'Riley'}, {'name': 'Morgan'}],
                'payment_choice': 'deposit'}
        beds = [
            dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
            dict(bed_code='M2', room_code='M', gender_strategy='mixed'),
        ]
        self.agent.session_id = session_id
        self.db.create_session(session_id, source='whatsapp')
        self.turn('offer', 'Quote this please')
        response = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), plan, beds)
        self.ledger.record_quote(plan, response)
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('reply', raw)

    def test_structured_interpreter_accepts_spanish_paraphrase(self):
        self._present_checked_for_interpreter('spanish-paraphrase',
                                              'Sí, resérvalo por favor')
        result = self.ledger.interpret_owner_turn({
            'action': 'accept', 'action_evidence': 'Sí, resérvalo por favor',
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [], 'completions': {},
        })
        self.assertTrue(result['accepted'])
        repeated = self.ledger.interpret_owner_turn({
            'action': 'accept', 'action_evidence': 'Sí, resérvalo por favor',
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [], 'completions': {},
        })
        self.assertEqual(repeated, result)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_intent_already_adjudicated'):
            self.ledger.interpret_owner_turn({
                'action': 'reject', 'action_evidence': 'Sí, resérvalo por favor',
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [], 'completions': {},
            })
        self.ledger.prepare_create({})

    def test_structured_interpreter_conditional_intent_cannot_create(self):
        self._present_checked_for_interpreter('conditional-owner',
                                              'Book it if the transfer is included')
        conditional = self.ledger.interpret_owner_turn({
            'action': 'accept', 'action_evidence': 'Book it if the transfer is included',
            'ambiguous': False, 'negated': False, 'conditional': True,
            'material_changes': [], 'completions': {},
        })
        self.assertFalse(conditional['accepted'])
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_structured_interpreter_rejects_material_change_and_fake_evidence(self):
        self._present_checked_for_interpreter('changed-owner',
                                              'Book it, but move us to next week')
        changed = self.ledger.interpret_owner_turn({
            'action': 'accept', 'action_evidence': 'Book it, but move us to next week',
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': ['check_in'], 'completions': {},
        })
        self.assertFalse(changed['accepted'])
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

        self.turn('reply-2', 'Please reserve this')
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_intent_evidence_invalid'):
            self.ledger.interpret_owner_turn({
                'action': 'accept', 'action_evidence': 'book it',
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [], 'completions': {},
            })
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_intent_already_adjudicated'):
            self.ledger.interpret_owner_turn({
                'action': 'accept', 'action_evidence': 'Please reserve this',
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [], 'completions': {},
            })
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_structured_acceptance_survives_reopen_but_not_cross_owner(self):
        self._present_checked_for_interpreter('structured-restart', 'Perfecto, haz la reserva')
        accepted = {
            'action': 'accept', 'action_evidence': 'Perfecto, haz la reserva',
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [], 'completions': {},
        }
        self.assertTrue(self.ledger.interpret_owner_turn(accepted)['accepted'])
        self.db.close()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.agent._session_db = self.db
        self.turn('retry', 'Please proceed')
        self.assertTrue(self.ledger.prepare_create({})['require_offer_identity'])

        self.ledger.close_turn()
        self.agent.session_id = 'foreign-owner'
        self.db.create_session('foreign-owner', source='whatsapp')
        self.turn('foreign', 'Perfecto, haz la reserva', chat_id='foreign-chat',
                  user_id='foreign-user', session_key='foreign-key')
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_owner_presented_offer_required'):
            self.ledger.interpret_owner_turn(accepted)

    def test_registered_interpreter_to_create_chain_handles_original_g4_once(self):
        import json
        import wolfhouse_staff_api as plugin
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        registry = Registry()
        plugin.register(registry)
        intent_tool = registry.tools['interpret_booking_turn']
        intent_schema = intent_tool['schema']['parameters']
        self.assertFalse(intent_schema['additionalProperties'])
        self.assertEqual(intent_schema['required'], [
            'action', 'action_evidence', 'ambiguous', 'negated', 'conditional',
            'material_changes', 'completions'])
        completions_schema = intent_schema['properties']['completions']
        self.assertFalse(completions_schema['additionalProperties'])
        self.assertFalse(completions_schema['properties']['guests']['items']['additionalProperties'])
        self.assertFalse(completions_schema['properties']['payment_choice']['additionalProperties'])
        self.assertFalse(completions_schema['properties']['eligibility']['additionalProperties'])
        self.agent.session_id = 'registered-structured-g4-owner'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = {**self.plan, 'room_type': 'shared', 'room_preference': 'male_only',
                'group_gender': 'male',
                'room_name_hints': [{'name': 'Mateo Ríos', 'explicit_gender': 'male'},
                                    {'name': 'Guest Two', 'explicit_gender': 'male'}],
                'guests': [{'name': 'Mateo Ríos'}, {'name': 'Guest Two'}],
                'payment_choice': 'deposit'}
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='male_only'),
                dict(bed_code='M2', room_code='M', gender_strategy='male_only')]
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        response = FirstYesOwnerTests._checked_offer(object.__new__(FirstYesOwnerTests), plan, beds)
        self.turn('registered-g4-offer', 'Quote this please')
        self.ledger.record_quote(plan, response)
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        raw = 'dale, book it — Mateo Ríos. send deposit link if needed'
        self.turn('registered-g4-accept', raw)
        interpreted = json.loads(intent_tool['handler']({
            'action': 'accept', 'action_evidence': raw,
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [],
            'completions': {'guests': [{'guest_index': 0, 'name': 'Mateo Ríos',
                                        'evidence': 'Mateo Ríos'}],
                            'payment_choice': {'value': 'deposit',
                                               'evidence': 'send deposit link if needed'}},
        }))
        self.assertTrue(interpreted['accepted'])
        calls = []
        def api(path, body):
            calls.append((path, deepcopy(body)))
            if path == '/availability-check':
                return {'success': True, 'has_enough_beds': True,
                        'available_beds': [
                            {'bed_code': 'M1', 'room_type': 'male_only'},
                            {'bed_code': 'M2', 'room_type': 'male_only'},
                        ]}
            self.assertEqual(path, '/booking-create-from-plan')
            return {'success': True, 'write_performed': True, 'booking_code': 'G4-ONE'}
        with patch.object(plugin, '_post_bot', side_effect=api):
            created = json.loads(registry.tools['create_booking_from_plan']['handler']({
                'guests': plan['guests'], 'guest_count': 2, 'payment_choice': 'deposit'}))
        self.assertTrue(created['success'], {'created': created, 'calls': calls})
        self.assertEqual(created['booking_code'], 'G4-ONE')
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[-1][0], '/booking-create-from-plan')

    def test_acceptance_of_presented_priced_terms_survives_payment_completion_and_revalidation(self):
        self.agent.session_id = 'presented-incomplete-payment-owner'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = {**self.plan, 'room_type': 'shared', 'room_preference': 'male_only',
                'guests': [{'name': 'Mateo Ríos'}, {'name': 'Guest Two'}]}
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='male_only'),
                dict(bed_code='M2', room_code='M', gender_strategy='male_only')]
        preview = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), {**plan, 'payment_choice': 'deposit'}, beds)
        incomplete_revision: dict = deepcopy(preview.get('offer_revision'))  # type: ignore[assignment]
        incomplete_revision.pop('payment_choice')
        incomplete_revision.pop('offer_fingerprint')
        self.turn('incomplete-offer', 'Quote this please')
        self.ledger.record_quote(plan, {
            'success': True, 'total_cents': 20000, 'deposit_required_cents': 10000,
            'remaining_after_deposit_cents': 10000, 'currency': 'EUR',
            'payment_choice_needed': True, 'offer_revision': incomplete_revision,
            'availability': deepcopy(preview['availability']),
        })
        shown = self.ledger.finalize_offer_response({
            'completed': True,
            'final_response': 'Total: 200.00 EUR. Deposit: 100.00 EUR. Would you like deposit or full?',
            'messages': [{'role': 'assistant', 'id': 'reply-incomplete',
                          'content': 'Total: 200.00 EUR. Deposit: 100.00 EUR. Would you like deposit or full?'}],
        })
        self.assertNotIn('Would you like deposit or full?', shown['final_response'])
        self.assertIn('Payment options: deposit or full payment.', shown['final_response'])
        raw = 'dale, book it — Mateo Ríos. send deposit link if needed'
        self.turn('incomplete-accept', raw)
        result = self.ledger.interpret_owner_turn({
            'action': 'accept', 'action_evidence': raw,
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [],
            'completions': {'payment_choice': {
                'value': 'deposit', 'evidence': 'send deposit link if needed'}},
        })
        self.assertTrue(result['accepted'])
        self.assertFalse(result['create_ready'])
        revalidation = self.ledger.prepare_quote({})
        self.assertEqual(revalidation['payment_choice'], 'deposit')
        response = FirstYesOwnerTests._checked_offer(object.__new__(FirstYesOwnerTests), revalidation, beds)
        self.ledger.record_quote(revalidation, response)
        self.assertEqual(self.ledger.prepare_create({})['accepted_offer'], response['offer_revision'])

        tampered_plan = self.ledger.prepare_quote({})
        tampered = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), tampered_plan, beds)
        tampered_revision: dict = tampered['offer_revision']  # type: ignore[assignment]
        tampered_revision['payment_link_amount_cents'] += 1
        tampered_revision['offer_fingerprint'] = 'tampered-revision'
        self.ledger.record_quote(tampered_plan, tampered)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_owner_acceptance_required'):
            self.ledger.prepare_create({})

    def test_original_combined_turn_accepts_already_complete_matching_name(self):
        self.agent.session_id = 'accepted-known-full-name-owner'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = {**self.plan, 'room_type': 'shared', 'room_preference': 'mixed',
                'guests': [{'name': 'Emre Yilmaz'}, {'name': 'Guest Two'}],
                'payment_choice': 'deposit'}
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        response = FirstYesOwnerTests._checked_offer(object.__new__(FirstYesOwnerTests), plan, beds)
        self.turn('accepted-known-full-name-offer', 'Quote this please')
        self.ledger.record_quote(plan, response)
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        raw = "€ that works. lock it in please — Emre Yilmaz, I'll pay the deposit when you send the link"
        self.turn('accepted-known-full-name-completion', raw)
        self.interpret(raw)
        prepared = self.ledger.prepare_create({})
        self.assertEqual(prepared['guests'], plan['guests'])

    def test_accepted_quote_does_not_survive_name_payment_message_with_changed_terms(self):
        self.agent.session_id = 'accepted-name-payment-changed-owner'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = {**self.plan, 'payment_choice': 'deposit'}
        self.turn('accepted-name-payment-change-offer', 'Quote this please')
        self.ledger.record_quote(plan, {'success': True, 'total_cents': 77000})
        self.turn('accepted-name-payment-change-consent', 'I accept the quote')
        self.turn('accepted-name-payment-change',
                  "My full name is Emre Kaya and I'll pay the deposit for 8 nights instead")
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    '^quote_owner_acceptance_required$'):
            self.ledger.prepare_create({})

    def test_accepted_quote_does_not_survive_conflicting_name_completion(self):
        self.agent.session_id = 'accepted-conflicting-name-owner'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = {**self.plan, 'room_type': 'shared', 'room_preference': 'mixed',
                'guests': [{'name': 'Emre Kaya'}, {'name': 'Guest Two'}],
                'payment_choice': 'deposit'}
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        response = FirstYesOwnerTests._checked_offer(object.__new__(FirstYesOwnerTests), plan, beds)
        self.turn('accepted-conflicting-name-offer', 'Quote this please')
        self.ledger.record_quote(plan, response)
        self.turn('accepted-conflicting-name',
                  "Lock it in — my full name is Alice Smith and I'll pay the deposit")
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    '^quote_owner_acceptance_required$'):
            self.ledger.prepare_create({})

    def test_named_removal_cannot_change_dates_or_other_selections(self):
        self.turn('remove-yoga', 'Remove the yoga')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_quote({**self.plan, 'catalog_selections': [], 'check_in': '2026-12-01'})

    def test_late_quote_response_cannot_overwrite_newer_intent(self):
        from contextvars import copy_context
        prepared = self.ledger.prepare_quote(self.plan)
        pending = copy_context()
        self.turn('newer-refusal', 'Not yet')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            pending.run(self.ledger.record_quote, prepared, {'success': True, 'total_cents': 1})
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_prepared_dispatch_reset_barrier_has_zero_transport(self):
        self.accept()
        prepared = self.ledger.prepare_create({})
        self.db.end_session('s1', 'reset')
        calls = []
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.dispatch_create(prepared, lambda: calls.append('transport'))
        self.assertEqual(calls, [])

    def test_prepared_dispatch_revision_barrier_has_zero_transport(self):
        self.accept()
        prepared = self.ledger.prepare_create({})
        self.turn('dispatch-revision', 'Remove the yoga')
        calls = []
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.dispatch_create(prepared, lambda: calls.append('transport'))
        self.assertEqual(calls, [])

    def test_closed_shared_capability_blocks_copied_child_context(self):
        from contextvars import copy_context
        self.accept()
        prepared = self.ledger.prepare_create({})
        child = copy_context()
        self.ledger.close_turn()
        calls = []
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            child.run(self.ledger.prepare_create, {})
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            child.run(self.ledger.dispatch_create, prepared, lambda: calls.append('transport'))
        self.assertEqual(calls, [])

    def test_real_gateway_enrichment_is_not_raw_acceptance_authority(self):
        import json
        from gateway.run import _wrap_current_message_with_observed_context
        from run_agent import AIAgent
        from agent import conversation_loop
        import wolfhouse_staff_api as plugin
        real_agent = object.__new__(AIAgent)
        real_agent._session_db, real_agent.session_id = self.db, 's1'
        original = conversation_loop.run_conversation
        enriched = _wrap_current_message_with_observed_context(
            'Not yet', 'Earlier guest: I accept the quote')
        self.assertIn('I accept the quote', enriched)
        self.assertIn('Not yet', enriched)
        class Stopped(Exception): pass
        def preflight(agent, message, *args, **kwargs):
            self.assertEqual(message, enriched)
            result = json.loads(plugin.create_booking_from_plan({}))
            self.assertFalse(result['write_performed'])
            raise Stopped()
        try:
            self.ledger.install_owner_hook()
            with patch.object(plugin, '_post_bot') as transport, patch.object(
                    conversation_loop, 'build_turn_context', side_effect=preflight):
                with self.assertRaises(Stopped):
                    real_agent.run_conversation(enriched)
                transport.assert_not_called()
            self.assertIsNone(self.ledger._current.get())
        finally:
            conversation_loop.run_conversation = original

    def test_quote_cas_detects_newer_turn_in_independent_context(self):
        from contextvars import copy_context
        prepared = self.ledger.prepare_quote(self.plan)
        other = copy_context()
        def newer():
            # Independent task, not closing the older task's capability.
            self.ledger._current.set(None)
            set_session_vars(platform='whatsapp', source='whatsapp', chat_id='chat1',
                user_id='guest1', session_key='key1', session_id='s1', message_id='other-task')
            self.ledger.observe_owner_turn(self.agent, 'Not yet')
            self.ledger.close_turn()
        other.run(newer)
        self.assertFalse(prepared.capability.closed)
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.record_quote(prepared, {'success': True, 'total_cents': 1})

    def test_real_transport_boundary_rechecks_after_prepare_barrier(self):
        import json
        import wolfhouse_staff_api as plugin
        self.db.create_session('transport-barrier', source='whatsapp')
        self.agent.session_id = 'transport-barrier'
        self.turn('barrier-offer', 'Quote this please')
        plan = {**self.plan, 'group_gender': 'mixed',
            'selected_bed_codes': ['M1', 'M2']}
        self.present(plan, self.checked(plan))
        self.accept()
        original = self.ledger.prepare_create
        def reset_after_prepare(params):
            prepared = original(params)
            self.db.end_session('transport-barrier', 'reset')
            return prepared
        params = {'guest_name': 'Alex', 'guests': deepcopy(plan['guests']),
                  'guest_count': 2, 'payment_choice': 'deposit'}
        with patch.object(self.ledger, 'prepare_create', side_effect=reset_after_prepare), patch.object(
                plugin, '_post_bot') as transport:
            result = json.loads(plugin.create_booking_from_plan(params))
            self.assertFalse(result['write_performed'])
            self.assertEqual(result['error'], 'quote_owner_ended')
            transport.assert_not_called()

    def test_async_late_child_uses_shared_revocation_not_parent_clear(self):
        import asyncio
        self.accept()
        prepared = self.ledger.prepare_create({})
        calls = []
        async def exercise():
            ready, release = asyncio.Event(), asyncio.Event()
            async def child():
                ready.set()
                await release.wait()
                with self.assertRaises(self.ledger.QuoteBoundaryError):
                    self.ledger.dispatch_create(prepared, lambda: calls.append('transport'))
            task = asyncio.create_task(child())
            await ready.wait()
            self.ledger.close_turn()
            release.set()
            await task
        asyncio.run(exercise())
        self.assertEqual(calls, [])

    def test_unknown_commercial_revision_stays_unresolved_on_neutral_turn(self):
        self.accept()
        self.turn('unknown-delta', 'Add a Drone on another date')
        self.interpret('Add a Drone on another date', action='revise',
                       material_changes=['catalog_selections', 'check_in'])
        self.turn('neutral-after-delta', 'Please proceed')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_dispatch_first_holds_writer_fence_until_transport_finishes(self):
        from contextvars import copy_context
        from threading import Event, Thread
        self.accept()
        prepared = self.ledger.prepare_create({})
        context = copy_context()
        other_db = SessionDB(Path(self.temp.name) / 'state.db')
        entered, release, attempted, reset_done = Event(), Event(), Event(), Event()
        errors, calls = [], []
        def transport():
            entered.set()
            if not release.wait(5):
                raise AssertionError('test transport barrier timeout')
            calls.append('offline transport')
        def create():
            try:
                context.run(self.ledger.dispatch_create, prepared, transport)
            except BaseException as error:
                errors.append(error)
        def reset():
            attempted.set()
            try:
                other_db.end_session('s1', 'reset')
            except BaseException as error:
                errors.append(error)
            finally:
                reset_done.set()
        writer, resetter = Thread(target=create), Thread(target=reset)
        writer.start()
        try:
            self.assertTrue(entered.wait(5))
            resetter.start()
            self.assertTrue(attempted.wait(5))
            self.assertFalse(reset_done.wait(0.1), 'reset committed inside dispatch critical section')
        finally:
            release.set()
            writer.join(5)
            if resetter.ident is not None:
                resetter.join(5)
            other_db.close()
        self.assertFalse(writer.is_alive())
        self.assertFalse(resetter.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(calls, ['offline transport'])
        self.assertTrue(reset_done.is_set())
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.dispatch_create(prepared, lambda: calls.append('late transport'))
        self.assertEqual(calls, ['offline transport'])

    def test_refusal_registered_handler_has_zero_transport(self):
        import json
        import wolfhouse_staff_api as plugin
        self.accept()
        self.turn('registered-refusal', 'No thanks')
        self.interpret('No thanks', action='reject')
        with patch.object(plugin, '_post_bot') as transport:
            result = json.loads(plugin.create_booking_from_plan({}))
            self.assertEqual(result['error'], 'quote_owner_acceptance_required')
            self.assertFalse(result['write_performed'])
            transport.assert_not_called()

    def test_missing_raw_input_clears_owner_capability(self):
        self.accept()
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.turn('missing-raw', None)
        self.assertIsNone(self.ledger._current.get())
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_concurrent_tasks_do_not_share_acceptance_or_picks(self):
        import asyncio
        self.db.create_session('s2', source='whatsapp')
        other = SimpleNamespace(_session_db=self.db, session_id='s2')
        async def run():
            ready = asyncio.Event()
            finished = asyncio.Event()
            async def accepted():
                tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='chat1',
                    user_id='guest1', session_key='key1', session_id='s1', message_id='concurrent-accept')
                try:
                    raw = 'I accept the quote'
                    self.ledger.observe_owner_turn(self.agent, raw)
                    self.interpret(raw)
                    ready.set()
                    await finished.wait()
                    self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])
                finally:
                    self.ledger._current.set(None)
                    clear_session_vars(tokens)
            async def rejected():
                await ready.wait()
                tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='chat2',
                    user_id='guest2', session_key='key2', session_id='s2', message_id='concurrent-confirm')
                try:
                    self.ledger.observe_owner_turn(other, 'I accept the quote')
                    with self.assertRaises(self.ledger.QuoteBoundaryError):
                        self.ledger.prepare_create({'confirm': True})
                finally:
                    self.ledger._current.set(None)
                    clear_session_vars(tokens)
                    finished.set()
            await asyncio.gather(accepted(), rejected())
        asyncio.run(run())

    def test_reused_session_id_cannot_inherit_previous_incarnation(self):
        self.accept()
        self.db._execute_write(lambda conn: conn.execute('UPDATE sessions SET started_at=started_at+1 WHERE id=?', ('s1',)))
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.turn('new-incarnation', 'I accept the quote')
        self.assertIsNone(self.ledger._current.get())

    def test_model_confirm_is_not_acceptance(self):
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({'confirm': True})

    def test_ambiguous_yes_is_not_acceptance(self):
        self.turn('m2', 'yes')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_empty_and_changed_picks_do_not_downgrade(self):
        self.accept()
        for picks in ([], [{'service_code': 'drone', 'quantity': 2}], [{'service_code': 'yoga_class', 'quantity': 1}]):
            with self.subTest(picks=picks), self.assertRaises(self.ledger.QuoteBoundaryError):
                self.ledger.prepare_create({'catalog_selections': picks})
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_quote({'catalog_selections': []})
        self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])

    def test_revision_requires_fresh_quote_and_acceptance(self):
        self.accept()
        raw = 'Remove the yoga'
        self.turn('m3', raw)
        self.interpret(raw, action='revise', material_changes=['catalog_selections'])
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})
        # A neutral follow-up does not reinstate authority.
        self.turn('m4', 'Please proceed')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_replayed_acceptance_cannot_accept_new_offer(self):
        self.accept()
        self.turn('m3', 'Revise the quote')
        self.ledger.record_quote(self.plan, {'success': True, 'total_cents': 78000})
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.turn('m2', 'I accept the quote')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_replayed_accepted_turn_cannot_dispatch_again(self):
        self.accept()
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.turn('m2', 'I accept the quote')
        self.assertIsNone(self.ledger._current.get())
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_tenant_chat_and_session_isolation(self):
        self.accept()
        self.turn('foreign', 'I accept the quote', chat_id='chat2')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})
        with patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'other'}):
            self.turn('foreign2', 'I accept the quote')
            with self.assertRaises(self.ledger.QuoteBoundaryError):
                self.ledger.prepare_create({})
        self.db.create_session('s2', source='whatsapp')
        self.agent.session_id = 's2'
        self.turn('foreign3', 'I accept the quote')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_reset_revokes_even_active_turn(self):
        self.accept()
        self.db.end_session('s1', 'reset')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_changed_raw_acceptance_fails_closed(self):
        for text in ('Yes, create the booking without yoga', 'Yes, create the booking with the Drone session included for both of us',
                     'I accept the quote but change dates to 2026-12-01'):
            self.turn(text, text)
            with self.assertRaises(self.ledger.QuoteBoundaryError):
                self.ledger.prepare_create({})

    def test_refused_selection_cannot_be_erased_by_ambiguous_acceptance(self):
        # This is a FIRST refused offer, not an unauthorized Yoga -> Drone replacement.
        self.db.create_session('first-refused-offer', source='whatsapp')
        self.agent.session_id = 'first-refused-offer'
        self.turn('refused-offer', 'Please quote this')
        self.ledger.record_quote({**self.plan, 'catalog_selections': [{'service_code': 'drone', 'quantity': 2}]},
                                 {'success': False, 'error': 'catalog_selection_not_atomic'})
        self.turn('m2', 'Yes, create the booking with the Drone session included for both of us')
        restored = self.ledger.prepare_quote({'check_in': '2026-11-01'})
        self.assertEqual(restored['catalog_selections'], [{'service_code': 'drone', 'quantity': 2}])
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_installed_owner_loop_observes_before_model_body_and_cleans_up(self):
        import gateway.run  # Load the real runtime before the isolated fake loop module.
        import sys
        from types import ModuleType
        package = ModuleType('agent')
        loop = ModuleType('agent.conversation_loop')
        package.conversation_loop = loop
        def model_body(agent, raw):
            self.interpret(raw)
            self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])
            return 'offline'
        loop.run_conversation = model_body
        self.turn('m2', 'yes')
        with patch.dict(sys.modules, {'agent': package, 'agent.conversation_loop': loop}):
            self.ledger.install_owner_hook()
            # A fresh message id for the actual installed owner entrypoint.
            clear_session_vars(self.tokens)
            self.tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='chat1',
                user_id='guest1', session_key='key1', session_id='s1', message_id='m4')
            self.ledger._current.set(None)
            from wolfhouse.offline_ingress_harness import gateway_ingress
            self.assertEqual(gateway_ingress(self.agent, 'I accept the quote', 'm4',
                lambda text: loop.run_conversation(self.agent, text)), 'offline')
            self.assertIsNone(self.ledger._current.get())

    def test_real_aiagent_forwarder_install_observes_before_preflight(self):
        from run_agent import AIAgent
        from agent import conversation_loop
        import wolfhouse_staff_api as plugin
        class Registry:
            def register_tool(self, **kw): pass
            def register_hook(self, *args, **kw): pass
        original = conversation_loop.run_conversation
        class PreflightStopped(Exception): pass
        real_agent = object.__new__(AIAgent)
        real_agent._session_db = self.db
        real_agent.session_id = 's1'
        self.turn('m2', 'yes')
        clear_session_vars(self.tokens)
        self.tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='chat1',
            user_id='guest1', session_key='key1', session_id='s1', message_id='real-entry-m3')
        self.ledger._current.set(None)
        def preflight(agent, raw, *args, **kwargs):
            self.assertIs(agent, real_agent)
            self.assertEqual(raw, 'I accept the quote')
            self.interpret(raw)
            self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])
            raise PreflightStopped()
        try:
            plugin.register(Registry())
            installed = conversation_loop.run_conversation
            plugin.register(Registry())
            self.assertIs(installed, conversation_loop.run_conversation)
            with patch.object(conversation_loop, 'build_turn_context', side_effect=preflight) as probe:
                with self.assertRaises(PreflightStopped):
                    from wolfhouse.offline_ingress_harness import gateway_ingress
                    gateway_ingress(real_agent, 'I accept the quote', 'real-entry-m3', real_agent.run_conversation)
                self.assertEqual(probe.call_count, 1)
            self.assertIsNone(self.ledger._current.get())
        finally:
            conversation_loop.run_conversation = original

    def test_real_registered_owner_and_name_continuity_share_entrypoint(self):
        from run_agent import AIAgent
        from agent import conversation_loop
        from wolfhouse import booking_names
        import json
        import wolfhouse_staff_api as plugin
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        class PreflightStopped(Exception): pass
        original = conversation_loop.run_conversation
        real_agent = object.__new__(AIAgent)
        real_agent._session_db, real_agent.session_id = self.db, 'registered-entrypoint'
        self.agent.session_id = real_agent.session_id
        self.db.create_session(real_agent.session_id, source='whatsapp')
        registry = Registry()
        calls = []
        plan = {**self.plan, 'group_gender': 'mixed', 'selected_bed_codes': ['M1', 'M2'],
                'guest_name': 'Riley', 'guests': [{'name': 'Riley'}, {'name': 'Morgan'}]}
        def transport(path, body):
            calls.append((path, body))
            if path == '/booking-preview':
                return self.checked(plan)
            if path == '/availability-check':
                return {'success': True, 'has_enough_beds': True,
                        'available_beds': [
                            {'bed_code': 'M1', 'room_code': 'M', 'room_type': 'mixed'},
                            {'bed_code': 'M2', 'room_code': 'M', 'room_type': 'mixed'},
                        ]}
            self.assertEqual(path, '/booking-create-from-plan')
            self.assertEqual(body['guests'], plan['guests'])
            self.assertEqual(body['add_ons'], [{'code': 'yoga_class', 'quantity': 2}])
            return {'success': False, 'write_performed': False, 'error': 'offline_capture'}
        def preflight(agent, raw, *args, **kwargs):
            booking_names.begin_turn(session_id=real_agent.session_id,
                                     scope=plugin._booking_name_scope())
            name = 'quote_booking' if raw == 'Please quote this' else 'create_booking_from_plan'
            if name != 'quote_booking':
                self.interpret(raw)
            payload = plan if name == 'quote_booking' else {'payment_choice': 'deposit'}
            result = json.loads(registry.tools[name]['handler'](payload))
            if name == 'quote_booking':
                self.assertTrue(result['success'], result)
                self.ledger.finalize_offer_response(
                    {'completed': True, 'final_response': 'draft'})
            else:
                self.assertFalse(result['write_performed'])
                self.assertIn('offline_capture', result['blocked_reasons'])
            raise PreflightStopped()
        try:
            plugin.register(registry)
            with patch.object(plugin, '_post_bot', side_effect=transport), patch.object(conversation_loop, 'build_turn_context', side_effect=preflight):
                for message, raw in [('real-offer', 'Please quote this'), ('real-accept', 'I accept the quote')]:
                    clear_session_vars(self.tokens)
                    self.tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='chat1',
                        user_id='guest1', session_key='key1', session_id=real_agent.session_id,
                        message_id=message)
                    self.ledger._current.set(None)
                    from wolfhouse.offline_ingress_harness import gateway_ingress
                    with self.assertRaises(PreflightStopped):
                        gateway_ingress(real_agent, raw, message, real_agent.run_conversation)
                    self.assertIsNone(self.ledger._current.get())
                    if raw == 'Please quote this':
                        real_agent.session_id = 'registered-entrypoint-accepted'
                        self.agent.session_id = real_agent.session_id
                        self.db.create_session(real_agent.session_id, source='whatsapp')
                        self.turn('staff-authoritative-offer', 'Quote this please')
                        self.present(plan, self.checked(plan))
            self.assertEqual([p for p, _ in calls],
                             ['/booking-preview', '/availability-check',
                              '/booking-create-from-plan'])
        finally:
            conversation_loop.run_conversation = original

    def test_registered_create_restores_missing_picks_and_blocks_changed_picks(self):
        import json
        import wolfhouse_staff_api as plugin
        plan = {**self.plan, 'group_gender': 'mixed', 'selected_bed_codes': ['M1', 'M2']}
        self.present(plan, self.checked(plan))
        self.accept()
        calls = []
        def api(path, body):
            calls.append(path)
            if path == '/availability-check':
                return {'success': True, 'has_enough_beds': True,
                        'available_beds': [
                            {'bed_code': 'M1', 'room_code': 'M', 'room_type': 'mixed'},
                            {'bed_code': 'M2', 'room_code': 'M', 'room_type': 'mixed'},
                        ]}
            self.assertEqual(path, '/booking-create-from-plan')
            self.assertEqual(body['add_ons'], [{'code': 'yoga_class', 'quantity': 2}])
            self.assertNotIn('catalog_selections', body)
            self.assertEqual(body['check_in'], '2026-11-01')
            return {'success': True, 'write_performed': True, 'booking_code': 'OFFLINE-ONLY'}
        params = {'guest_name': 'Alex', 'guests': deepcopy(plan['guests']),
                  'guest_count': 2, 'payment_choice': 'deposit'}
        with patch.object(plugin, '_post_bot', side_effect=api):
            result = json.loads(plugin.create_booking_from_plan(params))
            self.assertTrue(result['write_performed'], result)
            changed = json.loads(plugin.create_booking_from_plan({**params, 'catalog_selections': []}))
            self.assertFalse(changed['write_performed'])
        self.assertEqual(calls, ['/availability-check', '/booking-create-from-plan'])

    def test_unbound_ambient_identity_and_corrupt_storage_fail_closed(self):
        self.accept()
        self.db._execute_write(lambda conn: conn.execute("UPDATE state_meta SET value='not-json' WHERE key LIKE 'wolfhouse.accepted_quote.%'"))
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})
        from contextvars import Context
        with patch.dict('os.environ', {'HERMES_SESSION_ID': 's1', 'HERMES_SESSION_CHAT_ID': 'chat1'}):
            with self.assertRaises(self.ledger.QuoteBoundaryError):
                Context().run(self.ledger.observe_owner_turn, self.agent, 'I accept the quote')

    def test_owner_idempotency_ignores_model_keys_and_totals(self):
        self.accept()
        first = self.ledger.prepare_create({'idempotency_key': 'model-first', 'total_cents': 1})
        self.turn('continue-idempotently', 'Please proceed')
        second = self.ledger.prepare_create({'idempotency_key': 'model-second', 'quote_total_cents': 2})
        self.assertEqual(first['idempotency_key'], second['idempotency_key'])
        self.assertTrue(first['idempotency_key'].startswith('luna-owner-'))
        self.assertNotIn('total_cents', first)
        self.assertNotIn('quote_total_cents', second)

    def test_structurally_corrupt_accepted_quote_fails_closed(self):
        import json
        self.accept()
        key, raw = self.db._conn.execute("SELECT key,value FROM state_meta WHERE key LIKE 'wolfhouse.accepted_quote.%'").fetchone()
        healthy = json.loads(raw)
        from copy import deepcopy
        for field, value in [('status', 'unknown'), ('seen', [True]), ('plan', []),
                             ('quote', {'success': True, 'total_cents': True}),
                             ('acceptance_message', 'not-observed')]:
            broken = deepcopy(healthy)
            broken[field] = value
            self.db._execute_write(lambda conn: conn.execute('UPDATE state_meta SET value=? WHERE key=?', (json.dumps(broken), key)))
            with self.subTest(field=field), self.assertRaises(self.ledger.QuoteBoundaryError):
                self.ledger.prepare_create({})

    def test_catalog_id_cannot_be_reinterpreted_as_atomic_code(self):
        import json
        import wolfhouse_staff_api as plugin
        selection = {'service_id': 'unverified-admin-id', 'service_code': 'yoga_class', 'quantity': 2}
        # Exercise the catalog boundary on a first offer, not a prohibited change.
        self.db.create_session('catalog-first', source='whatsapp')
        self.agent.session_id = 'catalog-first'
        self.turn('revision-for-id', 'Please quote this')
        with patch.object(plugin, '_post_bot') as transport:
            result = json.loads(plugin.quote_booking({**self.plan, 'catalog_selections': [selection]}))
            transport.assert_not_called()
        self.assertEqual(result['error'], 'catalog_selection_not_atomic')

    def test_registered_quote_records_real_offering_and_supported_yoga(self):
        import json
        import wolfhouse_staff_api as plugin
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
        registry = Registry()
        plugin.register(registry)
        def api(path, body):
            self.assertEqual(path, '/booking-preview')
            self.assertEqual(body['add_ons'], [{'code': 'yoga_class', 'quantity': 2}])
            self.assertNotIn('catalog_selections', body)
            return self.checked(self.plan)
        with patch.object(plugin, '_post_bot', side_effect=api):
            result = json.loads(registry.tools['quote_booking']['handler'](self.plan))
        self.assertTrue(result['success'])
        self.agent.session_id = 'registered-supported-yoga-accepted'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('registered-staff-authoritative-offer', 'Quote this please')
        self.present(self.plan, self.checked(self.plan))
        raw = 'I accept the quote'
        self.turn('m2', raw)
        self.interpret(raw)
        self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])


if __name__ == '__main__':
    unittest.main()
