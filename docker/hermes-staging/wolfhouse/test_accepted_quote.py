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
        self.response['offer_revision']['payment_link_amount_cents'] = (
            self.response['offer_revision']['deposit_required_cents'])
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

    def test_direct_create_has_no_interpreter_veto(self):
        self.turn('direct-contextual-yes', 'oui')
        prepared = self.ledger.prepare_create({})
        self.assertTrue(prepared.revalidation)
        self.assertEqual(prepared['guests'], self.plan['guests'])
        self.ledger.record_quote(prepared, self.response)
        checked = self.ledger.prepare_create({})
        self.assertTrue(checked['require_offer_identity'])
        self.assertEqual(checked['accepted_offer'], self.response['offer_revision'])

    def model_waits(self, message, raw):
        from agent import conversation_loop
        from wolfhouse.offline_ingress_harness import gateway_ingress
        import wolfhouse_staff_api as plugin
        seen = []
        def model(agent, text, *args, **kwargs):
            seen.append(text)
            return {'completed': True, 'final_response': 'Please clarify the requested change.',
                    'messages': [{'role': 'assistant', 'content': 'Please clarify the requested change.'}]}
        with patch.object(conversation_loop, 'run_conversation', model), \
                patch.object(plugin, '_post_bot') as transport:
            gateway_ingress(self.agent, raw, message,
                            lambda text: conversation_loop.run_conversation(self.agent, text))
        self.assertTrue(any(raw in text for text in seen), seen)
        transport.assert_not_called()

    def test_refusal_and_deferral_revoke_accepted_authority(self):
        for index, text in enumerate(('No thanks', 'Not yet', 'Wait')):
            self.turn('offer-refusal-' + str(index), 'Quote this please')
            self.present()
            raw = 'I accept the quote'
            self.turn('accept-refusal-' + str(index), raw)
            self.interpret(raw)
            self.model_waits('refusal-' + str(index), text)

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
                self.assertEqual(self.ledger.prepare_create({})['guests'], self.plan['guests'])
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
                    self.interpret(completion, action='revise', material_changes=[])
                # Raw wording cannot silently replace the shown party.
                self.assertEqual(self.ledger.prepare_create({})['guests'], self.plan['guests'])

    def test_hostile_revision_cannot_be_reoffered_without_clarification(self):
        raw = 'My name is María change dates'
        self.turn('hostile-revision', raw)
        self.interpret(raw, action='revise', material_changes=[])
        self.turn('generic-reoffer', 'Quote this please')
        self.model_waits('hostile-model-clarifies', raw)

    def test_explicit_bounded_reprice_recovers_with_fresh_acceptance(self):
        self.accept()
        self.turn('bounded-reprice', 'Revise the quote')
        prepared = self.ledger.prepare_quote({})
        self.assertEqual(prepared['catalog_selections'], self.plan['catalog_selections'])
        self.ledger.record_quote(prepared, self.checked(prepared))
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        # Revalidation can retain the terms; semantic create selection is model-owned.
        self.assertTrue(self.ledger.prepare_create({})['confirm'])
        raw = 'I accept the revised quote'
        self.turn('bounded-reprice-accept', raw)
        self.interpret(raw)
        self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])

    def test_contact_revision_retains_omitted_commercial_selections(self):
        self.accept()
        self.turn('contact-only', 'Add my phone number')
        prepared = self.ledger.prepare_quote({'guest_phone': 'offline'})
        self.assertEqual(prepared['catalog_selections'], self.plan['catalog_selections'])
        revised = self.ledger.prepare_quote({'catalog_selections': []})
        self.assertEqual(revised['catalog_selections'], self.plan['catalog_selections'])
        self.assertEqual(revised['add_ons'], [])

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
        self.assertTrue(self.ledger.prepare_create({}).revalidation)
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
                                    '^quote_owner_presented_offer_required$'):
            self.ledger.prepare_create({})

    def test_g4_offered_checked_same_person_completion_advances_all_snapshots(self):
        """A surname completion is a recheck, not a new commercial offer."""
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='male_only'),
                dict(bed_code='M2', room_code='M', gender_strategy='male_only')]
        for choice in ('deposit', 'full', 'pay_on_arrival'):
            with self.subTest(choice=choice):
                self.agent.session_id = f'g4-offered-{choice}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'room_type': 'shared', 'room_preference': 'male_only',
                        'group_gender': 'male', 'payment_choice': choice,
                        'guests': [{'name': 'Mateo'}, {'name': 'Guest Two'}],
                        'room_name_hints': [
                            {'name': 'Mateo', 'explicit_gender': 'male'},
                            {'name': 'Guest Two', 'explicit_gender': 'male'}]}
                initial = FirstYesOwnerTests._checked_offer(
                    object.__new__(FirstYesOwnerTests), plan, beds)
                initial['offer_revision']['room_name_hints'] = deepcopy(
                    plan['room_name_hints'])
                if choice == 'pay_on_arrival':
                    initial['offer_revision']['payment_link_amount_cents'] = 0
                self.turn(f'g4-{choice}-offer', 'Quote this please')
                self.ledger.record_quote(plan, initial)
                shown = self.ledger.finalize_offer_response(
                    {'completed': True, 'final_response': 'draft', 'messages': []})
                original_text = shown['final_response']

                self.turn(f'g4-{choice}-surname', 'My full name is Mateo Ríos')
                completed_guests = deepcopy(plan['guests'])
                completed_guests[0]['name'] = 'Mateo Ríos'
                prepared = self.ledger.prepare_quote({'guests': completed_guests})
                self.assertEqual(prepared['payment_choice'], choice)
                self.assertEqual(prepared['room_name_hints'][0]['name'], 'Mateo Ríos')
                checked = FirstYesOwnerTests._checked_offer(
                    object.__new__(FirstYesOwnerTests), prepared, beds)
                checked['offer_revision']['room_name_hints'] = deepcopy(
                    prepared['room_name_hints'])
                if choice == 'pay_on_arrival':
                    checked['offer_revision']['payment_link_amount_cents'] = 0
                self.ledger.record_quote(prepared, checked)
                state = self.ledger._transaction(lambda value, _ingress: deepcopy(value))
                self.assertEqual(state['status'], 'offered')
                self.assertEqual(state['checked_offer'], checked['offer_revision'])
                self.assertEqual(state['presentation']['quote_revision'], checked['offer_revision'])
                self.assertEqual(state['presentation']['plan']['guests'][0]['name'], 'Mateo Ríos')
                self.assertEqual(state['presentation']['displayed_text'], original_text)
                self.assertEqual(state['presentation']['original_turn'], f'g4-{choice}-offer')
                create_probe = self.ledger.prepare_create({})
                self.assertTrue(create_probe.revalidation)
                self.assertNotIn('accepted_offer', create_probe)

    def test_g4_same_name_recheck_is_control_and_zero_arrival_has_no_zero_charge_copy(self):
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        plan = {**self.plan, 'payment_choice': 'pay_on_arrival',
                'guests': [{'name': 'Mateo Ríos'}, {'name': 'Guest Two'}]}
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
        response = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), plan, beds)
        response['offer_revision']['payment_link_amount_cents'] = 0
        self.turn('g4-same-name-offer', 'Quote this please')
        self.ledger.record_quote(plan, response)
        shown = self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft', 'messages': []})
        self.assertIn('Total: 200.00 EUR (deposit: 100.00 EUR).', shown['final_response'])
        self.assertIn('Due on arrival: 200.00 EUR.', shown['final_response'])
        self.assertNotIn('Payment on arrival: 0.00 EUR', shown['final_response'])
        self.turn('g4-same-name-control', 'Please check Mateo Ríos again')
        prepared = self.ledger.prepare_quote({'guests': deepcopy(plan['guests'])})
        checked = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), prepared, beds)
        checked['offer_revision']['payment_link_amount_cents'] = 0
        self.ledger.record_quote(prepared, checked)
        state = self.ledger._transaction(lambda value, _ingress: deepcopy(value))
        self.assertEqual(state['presentation']['quote_revision'], checked['offer_revision'])
        self.assertEqual(state['presentation']['original_turn'], 'g4-same-name-offer')

    def test_g4_payment_breakdown_uses_staff_amounts_for_each_payment_choice(self):
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
        expected_due = {'deposit': '100.00 EUR', 'pay_on_arrival': '200.00 EUR'}
        for choice in ('deposit', 'full', 'pay_on_arrival'):
            with self.subTest(choice=choice):
                self.agent.session_id = f'g4-breakdown-{choice}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'payment_choice': choice}
                response = FirstYesOwnerTests._checked_offer(
                    object.__new__(FirstYesOwnerTests), plan, beds)
                if choice == 'pay_on_arrival':
                    response['offer_revision']['payment_link_amount_cents'] = 0
                self.turn(f'g4-breakdown-{choice}-offer', 'Quote this please')
                self.ledger.record_quote(plan, response)
                shown = self.ledger.finalize_offer_response(
                    {'completed': True, 'final_response': 'draft', 'messages': []})
                text = shown['final_response']
                self.assertIn('Total: 200.00 EUR (deposit: 100.00 EUR).', text)
                if choice == 'full':
                    self.assertNotIn('Due on arrival:', text)
                else:
                    self.assertIn(f'Due on arrival: {expected_due[choice]}.', text)

    def test_g4_first_create_accepts_only_synced_same_person_room_hints(self):
        plan = {**self.plan, 'guests': [{'name': 'Mateo Ríos'}, {'name': 'Guest Two'}],
                'room_name_hints': [{'name': 'Mateo Ríos', 'explicit_gender': 'male'},
                                    {'name': 'Guest Two', 'explicit_gender': 'male'}]}
        response = self.checked(plan)
        response['offer_revision']['room_name_hints'] = deepcopy(plan['room_name_hints'])
        self.turn('g4-first-create-offer', 'Quote this please')
        self.ledger.record_quote(plan, response)
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        stale_hints = [{'name': 'Mateo', 'explicit_gender': 'male'},
                       {'name': 'Guest Two', 'explicit_gender': 'male'}]
        changed = deepcopy(stale_hints)
        changed[0]['explicit_gender'] = 'female'
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    '^accepted_quote_changed$'):
            self.ledger.prepare_create({'room_name_hints': changed})
        prepared = self.ledger.prepare_create({'room_name_hints': stale_hints})
        self.assertEqual(prepared['room_name_hints'], plan['room_name_hints'])

    def test_payment_incomplete_requote_keeps_checked_offer_provisional(self):
        self.agent.session_id = 'g4-provisional-requote'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        provisional_plan = {key: deepcopy(value) for key, value in self.plan.items()
                            if key != 'payment_choice'}
        response = self.checked({**provisional_plan, 'payment_choice': 'deposit'})
        response['payment_choice_needed'] = True
        self.turn('g4-provisional-offer', 'Quote this please')
        self.ledger.record_quote(provisional_plan, response)
        self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft', 'messages': []})
        prepared = self.ledger.prepare_quote({})
        self.ledger.record_quote(prepared, deepcopy(response))
        state = self.ledger._transaction(lambda value, _ingress: deepcopy(value))
        self.assertFalse(state['presentation']['create_ready'])
        self.assertIsNone(state.get('checked_offer'))

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

    def test_structured_interpreter_conditional_intent_is_diagnostic(self):
        self._present_checked_for_interpreter('conditional-owner',
                                              'Book it if the transfer is included')
        conditional = self.ledger.interpret_owner_turn({
            'action': 'accept', 'action_evidence': 'Book it if the transfer is included',
            'ambiguous': False, 'negated': False, 'conditional': True,
            'material_changes': [], 'completions': {},
        })
        self.assertFalse(conditional['accepted'])
        state = self.ledger._transaction(lambda stored, _ingress: deepcopy(stored))
        self.assertEqual(state['status'], 'offered')

    def test_structured_interpreter_rejects_material_change_and_fake_evidence(self):
        self._present_checked_for_interpreter('changed-owner',
                                              'Book it, but move us to next week')
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_intent_schema_invalid'):
            self.ledger.interpret_owner_turn({
                'action': 'accept', 'action_evidence': 'Book it, but move us to next week',
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [{
                    'field': 'check_in', 'value': '2026-11-08', 'evidence': 'next week'}],
                'completions': {},
            })
        self.assertEqual(
            self.ledger._transaction(lambda stored, _ingress: stored['status']), 'offered')

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
        self.assertEqual(
            self.ledger._transaction(lambda stored, _ingress: stored['status']), 'offered')

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
                        'exact_bed_eligibility': {
                            'eligible': True, 'selected_bed_codes': ['M1', 'M2'],
                            'guest_bed_assignments': [
                                {'guest_index': 0, 'guest_name': 'Mateo Ríos', 'bed_code': 'M1'},
                                {'guest_index': 1, 'guest_name': 'Guest Two', 'bed_code': 'M2'},
                            ]},
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

    def test_g5_exact_mismatch_clears_retry_but_valid_revalidation_restores_snapshot(self):
        """Reproduce SIM11 G5: exact-bed mismatch, not argument comparison."""
        import json
        import wolfhouse_staff_api as plugin
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        registry = Registry()
        plugin.register(registry)
        plan = {**self.plan, 'guests': [{'name': 'Holly'}, {'name': 'Jake'}],
                'guest_count': 2, 'selected_bed_codes': ['R6-B1', 'R6-B2'],
                'payment_choice': 'deposit'}
        beds = [dict(bed_code='R6-B1', room_code='R6', gender_strategy='mixed'),
                dict(bed_code='R6-B2', room_code='R6', gender_strategy='mixed')]
        preview = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), plan, beds)
        self.agent.session_id = 'sim11-g5-exact-mismatch'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('g5-offer', 'Quote this')
        self.ledger.record_quote(plan, preview)
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('g5-accept', 'I accept the deposit offer')
        calls = []
        mismatch = True
        def staff(path, payload):
            calls.append(path)
            if path == '/booking-preview':
                return deepcopy(preview)
            if path == '/availability-check':
                eligible = not mismatch
                return {'success': True, 'has_enough_beds': True,
                        'exact_bed_eligibility': {'eligible': eligible,
                            'reason': None if eligible else 'availability_changed',
                            'selected_bed_codes': list(payload['selected_bed_codes']),
                            'guest_bed_assignments': ([
                                {'guest_index': i, 'guest_name': payload['guests'][i]['name'],
                                 'bed_code': code}
                                for i, code in enumerate(payload['selected_bed_codes'])
                            ] if eligible else [])}}
            self.assertEqual(path, '/booking-create-from-plan')
            return {'success': True, 'write_performed': True, 'booking_code': 'G5-RECOVERED'}
        with patch.object(plugin, '_post_bot', side_effect=staff):
            first = json.loads(registry.tools['create_booking_from_plan']['handler'](plan))
            self.assertEqual(first['error'], 'accepted_bed_selection_revalidation_required')
            before_retry = len(calls)
            retry = json.loads(registry.tools['create_booking_from_plan']['handler'](plan))
            self.assertFalse(retry['success'])
            self.assertEqual(len(calls), before_retry, 'cleared readiness must not retry Staff create')
            mismatch = False
            revalidated = json.loads(registry.tools['quote_booking']['handler']({}))
            self.assertTrue(revalidated['success'])
            recovered = json.loads(registry.tools['create_booking_from_plan']['handler'](plan))
        self.assertTrue(recovered['success'], recovered)
        self.assertEqual(recovered['booking_code'], 'G5-RECOVERED')
        self.assertEqual(calls.count('/booking-create-from-plan'), 1)

    def test_acceptance_of_presented_priced_terms_survives_payment_completion_and_revalidation(self):
        self.agent.session_id = 'presented-incomplete-payment-owner'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = {**self.plan, 'room_type': 'shared', 'room_preference': 'male_only',
                'guests': [{'name': 'Mateo'}, {'name': 'Guest Two'}],
                'payment_choice': None}
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='male_only'),
                dict(bed_code='M2', room_code='M', gender_strategy='male_only')]
        preview = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), {**plan, 'payment_choice': 'deposit'}, beds)
        incomplete_revision: dict = deepcopy(preview.get('offer_revision'))  # type: ignore[assignment]
        incomplete_revision['payment_link_amount_cents'] = incomplete_revision['deposit_required_cents']
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
        self.assertIn('Payment options: deposit (100.00 EUR) or full payment.', shown['final_response'])
        raw = 'dale, book it — Mateo Ríos. send deposit link if needed'
        self.turn('incomplete-accept', raw)
        result = self.ledger.interpret_owner_turn({
            'action': 'accept', 'action_evidence': raw,
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [],
            'completions': {
                'guests': [{'guest_index': 0, 'name': 'Mateo Ríos',
                            'evidence': 'Mateo Ríos'}],
                'payment_choice': {
                    'value': 'deposit', 'evidence': 'send deposit link if needed'}},
        })
        self.assertTrue(result['accepted'])
        self.assertFalse(result['create_ready'])
        revalidation = self.ledger.prepare_quote({})
        self.assertEqual(revalidation['payment_choice'], 'deposit')
        response = FirstYesOwnerTests._checked_offer(object.__new__(FirstYesOwnerTests), revalidation, beds)
        response['offer_revision']['payment_link_amount_cents'] = (
            response['offer_revision']['deposit_required_cents'])
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
                                    'quote_owner_presented_offer_required'):
            self.ledger.prepare_create({})

    def test_export_g1_g4_provisional_male_alias_survives_checked_revalidation(self):
        """Replay export 3001/3004: create -> quote -> create internal refresh."""
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='male_only'),
                dict(bed_code='M2', room_code='M', gender_strategy='male_only')]
        for export_id, names in ((3001, ('Emre Yilmaz', 'Guest Two')),
                                 (3004, ('Mateo Ríos', 'Guest Two'))):
            with self.subTest(export_id=export_id):
                self.agent.session_id = f'export-{export_id}-owner'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'room_type': 'shared',
                        'room_preference': 'male_only', 'group_gender': 'male',
                        'gender_preference': 'male',
                        'guests': [{'name': name, 'explicit_gender': 'male'}
                                   for name in names],
                        'room_name_hints': [
                            {'name': name, 'explicit_gender': 'male'} for name in names]}
                plan.pop('payment_choice', None)
                plan.pop('catalog_selections', None)
                plan.pop('add_ons', None)
                quoted = FirstYesOwnerTests._checked_offer(
                    object.__new__(FirstYesOwnerTests),
                    {**plan, 'payment_choice': 'deposit'}, beds)
                quoted['payment_choice_needed'] = True
                self.turn(f'export-{export_id}-quote', 'Quote this booking')
                self.ledger.record_quote(plan, quoted)
                self.ledger.finalize_offer_response(
                    {'completed': True, 'final_response': 'draft'})

                raw = 'Book it with the deposit'
                self.turn(f'export-{export_id}-create-1', raw)
                accepted = self.interpret(raw, completions={'payment_choice': {
                    'value': 'deposit', 'evidence': 'deposit'}})
                self.assertFalse(accepted['create_ready'])
                revalidation = self.ledger.prepare_quote({})
                checked = FirstYesOwnerTests._checked_offer(
                    object.__new__(FirstYesOwnerTests), revalidation, beds)
                # Exported Staff completion canonicalizes the redundant request
                # preference to null while retaining male facts per occupant.
                checked['offer_revision']['gender_preference'] = None
                checked['offer_revision']['room_name_hints'] = deepcopy(
                    revalidation['room_name_hints'])
                checked['offer_revision']['offer_fingerprint'] = f'export-{export_id}-checked'
                before_refresh = self.ledger._transaction(
                    lambda owner, _ingress: deepcopy(owner))
                expected_plan = deepcopy(before_refresh['accepted_presentation']['plan'])
                expected_plan.update(deepcopy(before_refresh.get('completion_plan') or {}))
                self.assertTrue(self.ledger._completion_revision_matches(
                    before_refresh['accepted_presentation']['quote_revision'],
                    checked['offer_revision'], payment_choice='deposit',
                    person_plan=expected_plan),
                    (before_refresh['accepted_presentation']['quote_revision'],
                     checked['offer_revision'], expected_plan))
                self.ledger.record_quote(revalidation, checked)
                state = self.ledger._transaction(lambda owner, _ingress: deepcopy(owner))
                self.assertIsNotNone(state.get('presentation'), state)
                prepared = self.ledger.prepare_create({})
                self.assertEqual(prepared['accepted_offer'], checked['offer_revision'])
                self.assertEqual(prepared['selected_bed_codes'], ['M1', 'M2'])

        # The alias exception must not cover a contradictory person-bound fact.
        contradictory_plan = deepcopy(expected_plan)
        contradictory_plan['room_name_hints'][1]['explicit_gender'] = 'female'
        self.assertFalse(self.ledger._completion_revision_matches(
            before_refresh['accepted_presentation']['quote_revision'],
            checked['offer_revision'], payment_choice='deposit',
            person_plan=contradictory_plan))
        authority_erased = deepcopy(checked['offer_revision'])
        authority_erased['room_name_hints'] = []
        self.assertFalse(self.ledger._completion_revision_matches(
            before_refresh['accepted_presentation']['quote_revision'],
            authority_erased, payment_choice='deposit', person_plan=expected_plan))

    def test_sparse_request_plan_does_not_have_to_repeat_staff_person_hints(self):
        prior = {
            'gender_preference': 'male',
            'guests': [{'name': 'Emre'}, {'name': 'Guest Two'}],
            'room_name_hints': [
                {'name': 'Emre', 'explicit_gender': 'male'},
                {'name': 'Guest Two', 'explicit_gender': 'male'},
            ],
            'total_cents': 20000,
        }
        current = deepcopy(prior)
        current['gender_preference'] = None
        self.assertTrue(self.ledger._completion_revision_matches(
            prior, current, person_plan={'guests': deepcopy(prior['guests'])}))

    def test_request_plan_alias_uses_staff_canonical_person_facts(self):
        prior = {
            'gender_preference': None,
            'room_name_hints': [{'name': 'Emre', 'explicit_gender': 'male'}],
        }
        current = deepcopy(prior)
        self.assertTrue(self.ledger._request_plan_matches_canonical_people(
            {'gender_preference': 'male', 'guests': [{'name': 'Emre'}]},
            {'guests': [{'name': 'Emre'}]}, prior, current))

    def test_prepared_person_fact_cannot_contradict_staff_hints_when_alias_is_unchanged(self):
        for alias in ('male', None):
            with self.subTest(alias=alias):
                staff_revision = {
                    'gender_preference': alias,
                    'room_name_hints': [
                        {'name': 'Alex', 'explicit_gender': 'male'}],
                }
                self.assertFalse(self.ledger._completion_revision_matches(
                    staff_revision, deepcopy(staff_revision), person_plan={
                        'guests': [{'name': 'Alex', 'explicit_gender': 'female'}]}))

    def test_current_canonical_person_facts_are_checked_without_alias_change(self):
        for alias in ('male', None):
            with self.subTest(alias=alias):
                prior = {
                    'gender_preference': alias,
                    'guests': [{'name': 'Alex', 'explicit_gender': 'male'}],
                    'room_name_hints': [{'name': 'Alex', 'explicit_gender': 'male'}],
                }
                current = deepcopy(prior)
                current['guests'][0]['explicit_gender'] = 'female'
                self.assertFalse(self.ledger._completion_revision_matches(
                    prior, current, person_plan={
                        'guests': [{'name': 'Alex', 'explicit_gender': 'male'}]}))

    def test_canonical_person_gender_contradiction_is_not_a_redundant_alias(self):
        prior = {
            'gender_preference': 'male',
            'guests': [{'name': 'Alex', 'explicit_gender': 'male'}],
            'room_name_hints': [{'name': 'Alex', 'explicit_gender': 'male'}],
        }
        current = deepcopy(prior)
        current['gender_preference'] = None
        current['guests'][0]['explicit_gender'] = 'female'
        self.assertFalse(self.ledger._completion_revision_matches(prior, current))

    def test_registered_adapter_preserves_provisional_payment_then_revalidates_explicit_choices(self):
        import json
        import wolfhouse_staff_api as plugin
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
        for choice in ('deposit', 'full'):
            with self.subTest(choice=choice):
                self.agent.session_id = f'producer-choice-{choice}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                registry = Registry()
                plugin.register(registry)
                plan = {**self.plan, 'guests': [{'name': 'Mateo Ríos'},
                                                {'name': 'Guest Two'}]}
                for key in ('payment_choice', 'catalog_selections', 'add_ons'):
                    plan.pop(key, None)
                def staff(path, payload):
                    self.assertEqual(path, '/booking-preview')
                    calculated = payload.get('payment_choice') or 'deposit'
                    response = FirstYesOwnerTests._checked_offer(
                        object.__new__(FirstYesOwnerTests),
                        {**payload, 'payment_choice': calculated}, beds)
                    response['offer_revision']['payment_link_amount_cents'] = (
                        response['offer_revision']['total_cents'] if calculated == 'full'
                        else response['offer_revision']['deposit_required_cents'])
                    response['payment_choice_needed'] = not bool(payload.get('payment_choice'))
                    return response
                with patch.object(plugin, '_post_bot', side_effect=staff):
                    self.turn(f'producer-offer-{choice}', 'Quote this')
                    quoted = json.loads(registry.tools['quote_booking']['handler'](plan))
                    self.assertTrue(quoted['payment_choice_needed'])
                    self.assertEqual(quoted['offer_revision']['payment_choice'], 'deposit')
                    self.assertTrue(quoted['offer_revision']['offer_fingerprint'])
                    shown = self.ledger.finalize_offer_response(
                        {'completed': True, 'final_response': 'model draft', 'messages': []})
                    self.assertIn('Payment options: deposit (100.00 EUR) or full payment.', shown['final_response'])
                    raw = f'I choose {choice}'
                    self.turn(f'producer-accept-{choice}', raw)
                    interpreted = json.loads(registry.tools['interpret_booking_turn']['handler']({
                        'action': 'accept', 'action_evidence': raw,
                        'ambiguous': False, 'negated': False, 'conditional': False,
                        'material_changes': [], 'completions': {'payment_choice': {
                            'value': choice, 'evidence': choice}},
                    }))
                    self.assertFalse(interpreted['create_ready'])
                    revalidated = json.loads(registry.tools['quote_booking']['handler']({}))
                    self.assertEqual(revalidated['offer_revision']['payment_choice'], choice)
                    self.assertEqual(self.ledger.prepare_create({})['payment_choice'], choice)

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
        self.present(plan)
        self.turn('accepted-name-payment-change-consent', 'I accept the quote')
        self.turn('accepted-name-payment-change',
                  "My full name is Emre Kaya and I'll pay the deposit for 8 nights instead")
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    '^accepted_quote_changed$'):
            self.ledger.prepare_create({'check_out': '2026-11-09'})

    def test_combined_completion_rejects_staff_identity_mismatch(self):
        self.agent.session_id = 'combined-identity-mismatch-owner'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = {**self.plan, 'room_type': 'shared', 'room_preference': 'mixed',
                'guests': [{'name': 'Mateo'}, {'name': 'Guest Two'}],
                'payment_choice': None}
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        initial = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), {**plan, 'payment_choice': 'deposit'}, beds)
        initial['payment_choice_needed'] = True
        initial['offer_revision']['payment_link_amount_cents'] = (
            initial['offer_revision']['deposit_required_cents'])
        self.turn('combined-mismatch-offer', 'Quote this')
        self.ledger.record_quote(plan, initial)
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        raw = 'Book it for Mateo Ríos with the deposit'
        self.turn('combined-mismatch-accept', raw)
        self.ledger.interpret_owner_turn({
            'action': 'accept', 'action_evidence': raw,
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [], 'completions': {
                'guests': [{'guest_index': 0, 'name': 'Mateo Ríos', 'evidence': 'Mateo Ríos'}],
                'payment_choice': {'value': 'deposit', 'evidence': 'deposit'}},
        })
        revalidation = self.ledger.prepare_quote({})
        mismatched = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), revalidation, beds)
        mismatched['offer_revision']['guest_bed_assignments'][0]['guest_name'] = 'someone else'
        mismatched['offer_revision']['offer_fingerprint'] = 'identity-mismatch'
        self.ledger.record_quote(revalidation, mismatched)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_owner_presented_offer_required'):
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
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('accepted-conflicting-name',
                  "Lock it in — my full name is Alice Smith and I'll pay the deposit")
        # Omitted model roster must never be replaced from raw name-like wording.
        self.assertEqual(self.ledger.prepare_create({})['guests'], plan['guests'])

    def test_named_removal_authorizes_only_evidenced_material_field(self):
        raw = 'Remove the yoga'
        self.turn('remove-yoga', raw)
        result = self.ledger.interpret_owner_turn({
            'action': 'revise', 'action_evidence': raw,
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [{
                'field': 'catalog_selections', 'operation': 'remove',
                'item': {'service_code': 'yoga_class'}, 'evidence': 'yoga'}],
            'completions': {},
        })
        self.assertEqual(result['next_action'], 'requote_material_changes')
        self.assertEqual(self.ledger.prepare_quote({'catalog_selections': [],
                         'check_in': '2026-12-01'})['check_in'], '2026-12-01')
        revised = self.ledger.prepare_quote({'catalog_selections': []})
        self.assertEqual(revised['catalog_selections'], [])
        self.assertEqual(revised['check_in'], self.plan['check_in'])
        self.assertEqual(revised.get('add_ons'), [])
        self.turn('remove-yoga-new-turn', 'Actually, wait')
        self.assertEqual(self.ledger.prepare_quote({'catalog_selections': []})['add_ons'], [])

    def test_material_revision_is_bound_to_exact_interpreted_value(self):
        raw = 'Please move my check-in to 2026-11-02.'
        self.turn('move-date-exact', raw)
        result = self.ledger.interpret_owner_turn({
            'action': 'revise', 'action_evidence': raw,
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [{
                'field': 'check_in', 'value': '2026-11-02',
                'evidence': '2026-11-02'}],
            'completions': {},
        })
        self.assertEqual(result['next_action'], 'requote_material_changes')
        self.assertEqual(self.ledger.prepare_quote({'check_in': '2026-11-07'})['check_in'],
                         '2026-11-07')
        revised = self.ledger.prepare_quote({'check_in': '2026-11-02'})
        self.assertEqual(revised['check_in'], '2026-11-02')
        self.assertEqual(revised['check_out'], self.plan['check_out'])

    def test_material_revision_rejects_value_not_bound_to_evidence(self):
        raw = 'Move check-in to 2026-11-02.'
        self.turn('move-date-mismatch', raw)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_intent_schema_invalid'):
            self.ledger.interpret_owner_turn({
                'action': 'revise', 'action_evidence': raw,
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [{
                    'field': 'check_in', 'value': '2030-01-01',
                    'evidence': '2026-11-02'}],
                'completions': {},
            })

    def test_material_revision_rejects_reordered_scalar_tokens(self):
        raw = 'Date numbers are 02, 11, and 2026.'
        self.turn('reordered-date', raw)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_intent_schema_invalid'):
            self.ledger.interpret_owner_turn({
                'action': 'revise', 'action_evidence': raw,
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [{
                    'field': 'check_in', 'value': '2026-11-02',
                    'evidence': '02, 11, and 2026'}],
                'completions': {},
            })

    def test_catalog_revision_accepts_service_id_only_identity(self):
        raw = 'Add 1 service 42'
        self.turn('service-id-add', raw)
        self.ledger.interpret_owner_turn({
            'action': 'revise', 'action_evidence': raw,
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [{
                'field': 'catalog_selections', 'operation': 'add',
                'item': {'service_id': 42, 'quantity': 1},
                'evidence': '1 service 42'}],
            'completions': {},
        })
        expected = self.plan['catalog_selections'] + [{'service_id': 42, 'quantity': 1}]
        self.assertEqual(self.ledger.prepare_quote({'catalog_selections': expected})[
            'catalog_selections'], expected)

    def test_checked_per_guest_offer_rejects_non_deposit_amount(self):
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        plan = deepcopy(self.plan)
        plan['payment_choice'] = 'per_guest'
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
        response = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), plan, beds)
        response['offer_revision']['payment_link_amount_cents'] = (
            response['offer_revision']['total_cents'])
        self.assertIsNone(self.ledger._checked_plan(plan, response, 'wolfhouse-somo'))

    def test_material_revision_rejects_scalar_substring_collision(self):
        raw = 'Make it female.'
        self.turn('gender-substring', raw)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_intent_schema_invalid'):
            self.ledger.interpret_owner_turn({
                'action': 'revise', 'action_evidence': raw,
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [{
                    'field': 'group_gender', 'value': 'male',
                    'evidence': 'female'}],
                'completions': {},
            })

    def test_eligibility_rejects_name_substring_collision(self):
        raw = 'Alexandra is male.'
        self.turn('name-substring', raw)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_completion_evidence_invalid'):
            self.ledger.interpret_owner_turn({
                'action': 'accept', 'action_evidence': raw,
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [],
                'completions': {
                    'eligibility': {'guest_index': 0, 'value': 'male',
                                    'evidence': 'Alexandra is male'},
                },
            })

    def test_list_revision_rejects_unevidenced_quantity(self):
        raw = 'Add one yoga class'
        self.turn('add-yoga-mismatch', raw)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_intent_schema_invalid'):
            self.ledger.interpret_owner_turn({
                'action': 'revise', 'action_evidence': raw,
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [{
                    'field': 'add_ons', 'operation': 'add',
                    'item': {'code': 'yoga_class', 'quantity': 999},
                    'evidence': 'one yoga class'}],
                'completions': {},
            })

    def test_multiple_evidenced_list_revisions_apply_in_order(self):
        raw = 'Remove yoga and add 2 meals'
        self.turn('multi-list-change', raw)
        result = self.ledger.interpret_owner_turn({
            'action': 'revise', 'action_evidence': raw,
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [
                {'field': 'catalog_selections', 'operation': 'remove',
                 'item': {'service_code': 'yoga_class'}, 'evidence': 'yoga'},
                {'field': 'catalog_selections', 'operation': 'add',
                 'item': {'service_code': 'meal', 'quantity': 2},
                 'evidence': '2 meals'},
            ],
            'completions': {},
        })
        self.assertEqual(result['next_action'], 'requote_material_changes')
        revised = self.ledger.prepare_quote({
            'catalog_selections': [{'service_code': 'meal', 'quantity': 2}],
        })
        self.assertEqual(revised['catalog_selections'],
                         [{'service_code': 'meal', 'quantity': 2}])

    def test_two_additions_to_same_list_apply_atomically(self):
        raw = 'Add 2 meals and 1 surf lesson'
        self.turn('two-additions', raw)
        self.ledger.interpret_owner_turn({
            'action': 'revise', 'action_evidence': raw,
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [
                {'field': 'catalog_selections', 'operation': 'add',
                 'item': {'service_code': 'meal', 'quantity': 2}, 'evidence': '2 meals'},
                {'field': 'catalog_selections', 'operation': 'add',
                 'item': {'service_code': 'surf_lesson', 'quantity': 1},
                 'evidence': '1 surf lesson'},
            ], 'completions': {},
        })
        expected = self.plan['catalog_selections'] + [
            {'service_code': 'meal', 'quantity': 2},
            {'service_code': 'surf_lesson', 'quantity': 1},
        ]
        self.assertEqual(self.ledger.prepare_quote({'catalog_selections': expected})[
            'catalog_selections'], expected)

    def test_person_specific_guest_package_change_is_evidence_bound(self):
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        self.agent.session_id = 'guest-package-session'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = deepcopy(self.plan)
        plan['guest_packages'] = [
            {'guest_index': 0, 'package_code': 'malibu'},
            {'guest_index': 1, 'package_code': 'malibu'},
        ]
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
        response = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), plan, beds)
        response['offer_revision']['payment_link_amount_cents'] = (
            response['offer_revision']['deposit_required_cents'])
        response['offer_revision']['guest_packages'] = deepcopy(plan['guest_packages'])
        self.turn('guest-package-quote', 'Quote these packages')
        self.ledger.record_quote(plan, response)
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        raw = 'Change Alex from Malibu to Waimea'
        self.turn('guest-package-change', raw)
        self.ledger.interpret_owner_turn({
            'action': 'revise', 'action_evidence': raw,
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [
                {'field': 'guest_packages', 'operation': 'remove',
                 'item': {'guest_index': 0, 'package_code': 'malibu'},
                 'evidence': 'Alex from Malibu'},
                {'field': 'guest_packages', 'operation': 'add',
                 'item': {'guest_index': 0, 'package_code': 'waimea'},
                 'evidence': 'Alex from Malibu to Waimea'},
            ], 'completions': {},
        })
        expected = [
            {'guest_index': 1, 'package_code': 'malibu'},
            {'guest_index': 0, 'package_code': 'waimea'},
        ]
        self.assertEqual(self.ledger.prepare_quote({'guest_packages': expected})['guest_packages'], expected)

    def test_conflicting_duplicate_list_operations_fail_closed(self):
        raw = 'Remove yoga then add yoga'
        self.turn('conflicting-list-change', raw)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_intent_schema_invalid'):
            self.ledger.interpret_owner_turn({
                'action': 'revise', 'action_evidence': raw,
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [
                    {'field': 'catalog_selections', 'operation': 'remove',
                     'item': {'service_code': 'yoga_class'}, 'evidence': 'yoga'},
                    {'field': 'catalog_selections', 'operation': 'add',
                     'item': {'service_code': 'yoga_class'}, 'evidence': 'yoga'},
                ], 'completions': {},
            })

    def test_checked_deposit_offer_rejects_full_amount_link(self):
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        plan = {**self.plan, 'payment_choice': 'deposit'}
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
        response = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), plan, beds)
        self.turn('valid-deposit-offer', 'Quote deposit please')
        self.present(plan, response)
        self.turn('deposit-refresh', 'Proceed')
        prepared = self.ledger.prepare_create({})
        response['offer_revision']['payment_link_amount_cents'] = response['offer_revision']['total_cents']
        self.ledger.record_quote(prepared, response)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_owner_presented_offer_required'):
            self.ledger.prepare_create({})

    def test_named_eligibility_cannot_target_another_guest(self):
        raw = 'Guest Two is male'
        self.turn('wrong-person-eligibility', raw)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_completion_evidence_invalid'):
            self.ledger.interpret_owner_turn({
                'action': 'accept', 'action_evidence': raw,
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [], 'completions': {'eligibility': {
                    'guest_index': 0, 'value': 'male', 'evidence': raw}},
            })

    def test_registered_catalog_removal_syncs_staff_wire_projection(self):
        import json
        import subprocess
        import wolfhouse_staff_api as plugin
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kwargs): self.tools[kwargs['name']] = kwargs
            def register_hook(self, *args, **kwargs): pass
        calls = []
        self.agent.session_id = 'registered-catalog-wire-sync'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        def staff(path, body):
            self.assertEqual(path, '/booking-preview')
            calls.append(deepcopy(body))
            source = "const p=JSON.parse(process.argv[1]);const {buildCheckedWolfhousePreviewOffer:b}=require('./scripts/lib/luna-front-desk-accommodation-availability-service');const quote={success:true,total_cents:20000,deposit_required_cents:10000,payment_link_amount_cents:10000,currency:'EUR',package_code:p.package_code};console.log(JSON.stringify({...quote,payment_choice_needed:false,...b({...p,client_slug:'wolfhouse-somo',quote,availability:{...p,status:'checked',selected_bed_codes:['M1','M2']},room_rows:['M1','M2'].map(bed_code=>({bed_code,room_code:'M',gender_strategy:'mixed'}))})}));"
            return json.loads(subprocess.check_output(
                ['node', '-e', source, json.dumps(body)]))
        plan = deepcopy(self.plan)
        with patch.object(plugin, '_post_bot', side_effect=staff):
            registry = Registry(); plugin.register(registry)
            self.turn('wire-initial', 'Please quote this')
            first = json.loads(registry.tools['quote_booking']['handler'](plan))
            self.assertTrue(first['success'], first)
            self.ledger.finalize_offer_response(
                {'completed': True, 'final_response': 'draft', 'messages': []})
            raw = 'Remove the yoga and add 3 wetsuit rental'
            self.turn('wire-remove-yoga', raw)
            revised = json.loads(registry.tools['interpret_booking_turn']['handler']({
                'action': 'revise', 'action_evidence': raw,
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [{
                    'field': 'catalog_selections', 'operation': 'remove',
                    'item': {'service_code': 'yoga_class'},
                    'evidence': 'yoga'},
                {
                    'field': 'add_ons', 'operation': 'add',
                    'item': {'code': 'wetsuit_rental', 'quantity': 3},
                    'evidence': '3 wetsuit rental'},
                ],
                'completions': {},
            }))
            self.assertEqual(revised['next_action'], 'requote_material_changes', revised)
            result = json.loads(registry.tools['quote_booking']['handler']({
                'catalog_selections': [],
                'add_ons': [{'code': 'wetsuit_rental', 'quantity': 3}],
            }))
            self.assertTrue(result['success'])
            # A catalog-only removal must also clear its previously priced wire alias.
            removed = json.loads(registry.tools['quote_booking']['handler']({
                'catalog_selections': [{'service_code': 'yoga_class', 'quantity': 2}],
            }))
            self.assertTrue(removed['success'], removed)
            cleared = json.loads(registry.tools['quote_booking']['handler']({
                'catalog_selections': [],
            }))
            self.assertTrue(cleared['success'], cleared)
        self.assertEqual(calls[-1]['add_ons'],
                         [{'code': 'wetsuit_rental', 'quantity': 3}])
        self.assertEqual(calls[-1]['catalog_selections'], [])
        self.assertEqual(self.ledger._sync_catalog_projection(
            [{'code': 'yoga_class', 'quantity': 2},
             {'code': 'wetsuit_rental', 'quantity': 3}],
            [{'operation': 'remove', 'item': {'service_id': 'catalog-yoga'}}],
            [{'service_id': 'catalog-yoga', 'service_code': 'yoga_class'}]),
            [{'code': 'wetsuit_rental', 'quantity': 3}])

    def test_name_completion_cannot_transfer_or_reorder_eligibility(self):
        self.turn('wrong-person-name', 'Book it for Sam Smith')
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_completion_identity_changed'):
            self.ledger.interpret_owner_turn({
                'action': 'accept', 'action_evidence': 'Book it for Sam Smith',
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [],
                'completions': {'guests': [{
                    'guest_index': 0, 'name': 'Sam Smith', 'evidence': 'Sam Smith'}]},
            })
        self.turn('same-person-name', 'Book it for Alex Grey')
        accepted = self.ledger.interpret_owner_turn({
            'action': 'accept', 'action_evidence': 'Book it for Alex Grey',
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [],
            'completions': {'guests': [{
                'guest_index': 0, 'name': 'Alex Grey', 'evidence': 'Alex Grey'}]},
        })
        self.assertTrue(accepted['accepted'])
        reordered = self.ledger.prepare_quote({'guests': [
            {'name': 'Sam'}, {'name': 'Alex Grey'}]})
        eligibility = self.ledger.validated_guest_eligibility(reordered)
        self.assertNotIn(0, eligibility)
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({'guests': reordered['guests']})

    def test_name_completion_rejects_collision_with_other_guest(self):
        if self.tokens:
            clear_session_vars(self.tokens)
            self.tokens = None
        self.db.close()
        self.db = SessionDB(Path(self.temp.name) / 'collision.db')
        self.db.create_session('s1', source='whatsapp')
        self.agent._session_db = self.db
        self.ledger._current.set(None)
        plan = deepcopy(self.plan)
        plan['guests'] = [{'name': 'Alex'}, {'name': 'Alex Smith'}]
        self.response = self.checked(plan)
        self.turn('collision-initial', 'Quote this please')
        self.ledger.record_quote(plan, self.response)
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        raw = 'Book it for Alex Smith'
        self.turn('collision-completion', raw)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_completion_identity_changed'):
            self.ledger.interpret_owner_turn({
                'action': 'accept', 'action_evidence': raw,
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [],
                'completions': {'guests': [{
                    'guest_index': 0, 'name': 'Alex Smith',
                    'evidence': 'Alex Smith'}]},
            })

    def test_name_completion_rejects_duplicate_previous_name(self):
        if self.tokens:
            clear_session_vars(self.tokens)
            self.tokens = None
        self.db.close()
        self.db = SessionDB(Path(self.temp.name) / 'duplicate-previous.db')
        self.db.create_session('s1', source='whatsapp')
        self.agent._session_db = self.db
        self.ledger._current.set(None)
        plan = deepcopy(self.plan)
        plan['guests'] = [{'name': 'Alex'}, {'name': 'Alex'}]
        self.response = self.checked(plan)
        self.turn('duplicate-initial', 'Quote this please')
        self.ledger.record_quote(plan, self.response)
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        raw = 'Book it for Alex Grey'
        self.turn('duplicate-completion', raw)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_completion_identity_changed'):
            self.ledger.interpret_owner_turn({
                'action': 'accept', 'action_evidence': raw,
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [],
                'completions': {'guests': [{
                    'guest_index': 0, 'name': 'Alex Grey',
                    'evidence': 'Alex Grey'}]},
            })

    def test_sparse_second_guest_hint_matches_name_completion(self):
        prior = {
            'guest_bed_assignments': [
                {'guest_index': 0, 'guest_name': 'Alex Grey', 'bed_code': 'M1'},
                {'guest_index': 1, 'guest_name': 'Sam', 'bed_code': 'M2'},
            ],
            'room_name_hints': [{'name': 'Sam', 'explicit_gender': 'male'}],
            'total_cents': 20000,
        }
        current = deepcopy(prior)
        current['guest_bed_assignments'][1]['guest_name'] = 'Sam Lee'
        current['room_name_hints'][0]['name'] = 'Sam Lee'
        self.assertTrue(self.ledger._completion_revision_matches(
            prior, current, guest_index=1, guest_name='Sam Lee'))

    def test_registered_adapter_carries_validated_eligibility_to_recheck(self):
        import json
        import wolfhouse_staff_api as plugin
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kwargs): self.tools[kwargs['name']] = kwargs
            def register_hook(self, *args, **kwargs): pass
        calls = []
        self.agent.session_id = 'registered-eligibility-recheck'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
        def staff(path, body):
            self.assertEqual(path, '/booking-preview')
            calls.append(deepcopy(body))
            return FirstYesOwnerTests._checked_offer(
                object.__new__(FirstYesOwnerTests), body, beds)
        plan = deepcopy(self.plan)
        plan.pop('catalog_selections', None)
        plan['guests'] = [{'name': 'Alex Grey'},
                          {'name': 'Sam Lee', 'explicit_gender': 'male'}]
        plan['room_name_hints'] = [
            {'name': 'Alex Grey', 'explicit_gender': 'male'}]
        with patch.object(plugin, '_post_bot', side_effect=staff):
            registry = Registry(); plugin.register(registry)
            self.turn('eligibility-initial', 'Please quote this')
            first = json.loads(registry.tools['quote_booking']['handler'](plan))
            self.assertTrue(first['success'], first)
            expected_hint = [{'name': 'Sam Lee', 'explicit_gender': 'male'}]
            self.assertEqual(calls[0]['room_name_hints'], expected_hint)
            self.assertEqual(first['offer_revision']['room_name_hints'], expected_hint)
            self.ledger.finalize_offer_response(
                {'completed': True, 'final_response': 'draft', 'messages': []})
            raw = 'Yes, I am male'
            self.turn('eligibility-answer', raw)
            accepted = json.loads(registry.tools['interpret_booking_turn']['handler']({
                'action': 'accept', 'action_evidence': raw,
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [],
                'completions': {'eligibility': {
                    'guest_index': 0, 'value': 'male', 'evidence': 'I am male'}},
            }))
            self.assertTrue(accepted['accepted'])
            checked = json.loads(registry.tools['quote_booking']['handler']({}))
            self.assertTrue(checked['success'])
            self.ledger.prepare_create({})
            raw = 'Sam Lee is male'
            self.turn('eligibility-partner-answer', raw)
            accepted = json.loads(registry.tools['interpret_booking_turn']['handler']({
                'action': 'accept', 'action_evidence': raw,
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [],
                'completions': {'eligibility': {
                    'guest_index': 1, 'value': 'male', 'evidence': raw}},
            }))
            self.assertTrue(accepted['accepted'])
            checked = json.loads(registry.tools['quote_booking']['handler']({}))
            self.assertTrue(checked['success'])
        self.assertEqual(calls[-2]['guests'], [
            {'name': 'Alex Grey', 'explicit_gender': 'male'},
            {'name': 'Sam Lee', 'explicit_gender': 'male'},
        ])
        self.assertEqual(calls[-1]['guests'], [
            {'name': 'Alex Grey', 'explicit_gender': 'male'},
            {'name': 'Sam Lee', 'explicit_gender': 'male'},
        ])
        self.assertEqual(checked['offer_revision']['room_name_hints'], [
            {'name': 'Alex Grey', 'explicit_gender': 'male'},
            {'name': 'Sam Lee', 'explicit_gender': 'male'},
        ])
        self.ledger.prepare_create({})

    def test_registered_staged_name_and_payment_both_orders_revalidate_once(self):
        import json
        import wolfhouse_staff_api as plugin
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kwargs): self.tools[kwargs['name']] = kwargs
            def register_hook(self, *args, **kwargs): pass
        for order in ('name_first', 'payment_first'):
            with self.subTest(order=order):
                self.agent.session_id = f'staged-{order}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = deepcopy(self.plan)
                plan['guests'] = [{'name': 'Mateo'}, {'name': 'Guest Two'}]
                for key in ('payment_choice', 'catalog_selections', 'add_ons'):
                    plan.pop(key, None)
                beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                        dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
                def staff(path, body):
                    response = FirstYesOwnerTests._checked_offer(
                        object.__new__(FirstYesOwnerTests),
                        {**body, 'payment_choice': body.get('payment_choice') or 'deposit'}, beds)
                    response['offer_revision']['payment_link_amount_cents'] = 10000
                    response['payment_choice_needed'] = not bool(body.get('payment_choice'))
                    return response
                with patch.object(plugin, '_post_bot', side_effect=staff):
                    registry = Registry(); plugin.register(registry)
                    self.turn(f'{order}-quote', 'Quote this please')
                    first_quote = json.loads(registry.tools['quote_booking']['handler'](plan))
                    self.assertTrue(first_quote['payment_choice_needed'])
                    self.ledger.finalize_offer_response(
                        {'completed': True, 'final_response': 'draft', 'messages': []})
                    def interpret(message_id, raw, completions):
                        self.turn(message_id, raw)
                        return json.loads(registry.tools['interpret_booking_turn']['handler']({
                            'action': 'accept', 'action_evidence': raw,
                            'ambiguous': False, 'negated': False, 'conditional': False,
                            'material_changes': [], 'completions': completions,
                        }))
                    name = {'guests': [{'guest_index': 0, 'name': 'Mateo Ríos',
                                        'evidence': 'Mateo Ríos'}]}
                    payment = {'payment_choice': {'value': 'deposit', 'evidence': 'deposit'}}
                    steps = ((name, 'Book it for Mateo Ríos'), (payment, 'deposit'))
                    if order == 'payment_first':
                        steps = tuple(reversed(steps))
                    for index, (completion, raw) in enumerate(steps):
                        result = interpret(f'{order}-{index}', raw, completion)
                        self.assertTrue(result['accepted'])
                        self.assertFalse(result['create_ready'])
                    final_quote = json.loads(registry.tools['quote_booking']['handler'](
                        {'payment_choice': 'deposit'}))
                    self.assertTrue(final_quote['success'])
                    created = self.ledger.prepare_create({})
                    self.assertEqual(created['guests'][0]['name'], 'Mateo Ríos')
                    self.assertEqual(created['payment_choice'], 'deposit')

    def test_person_bound_eligibility_completion_reaches_authoritative_revalidation(self):
        import json
        import wolfhouse_staff_api as plugin
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        raw = 'Yes, I am male'
        self.turn('eligibility-recheck', raw)
        interpreted = json.loads(plugin.interpret_booking_turn({
            'action': 'accept', 'action_evidence': raw,
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [], 'completions': {'eligibility': {
                'guest_index': 0, 'value': 'male', 'evidence': 'I am male'}},
        }))
        self.assertTrue(interpreted['accepted'])
        self.assertFalse(interpreted['create_ready'])
        guests = deepcopy(self.plan['guests'])
        guests[0]['explicit_gender'] = 'male'
        prepared = self.ledger.prepare_quote({'guests': guests})
        self.assertEqual(prepared['guests'][0]['explicit_gender'], 'male')
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
        response = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), prepared, beds)
        response['offer_revision']['payment_link_amount_cents'] = (
            response['offer_revision']['deposit_required_cents'])
        self.ledger.record_quote(prepared, response)
        self.assertEqual(self.ledger.prepare_create({})['guests'][0]['explicit_gender'], 'male')

    def test_late_quote_response_cannot_overwrite_newer_intent(self):
        from contextvars import copy_context
        prepared = self.ledger.prepare_quote(self.plan)
        pending = copy_context()
        self.turn('newer-refusal', 'Not yet')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            pending.run(self.ledger.record_quote, prepared, {'success': True, 'total_cents': 1})
        self.model_waits('late-model-defers', 'Not yet')

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
                       material_changes=[])
        self.model_waits('neutral-after-delta', 'Please proceed')
        revised = self.ledger.prepare_quote({'check_in': '2026-12-01'})
        self.assertEqual(revised['check_in'], '2026-12-01')

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
        self.accept()
        self.model_waits('registered-refusal', 'No thanks')

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
        self.ledger._transaction(lambda state, ingress: state.pop('presentation', None))
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({'confirm': True})

    def test_ambiguous_yes_is_not_acceptance(self):
        self.model_waits('ambiguous-model', 'yes, but which room?')

    def test_empty_and_changed_picks_do_not_downgrade(self):
        self.accept()
        # Empty duplicate catalog projection does not remove the same canonical
        # service carried in add_ons; actual service changes remain material.
        self.ledger.prepare_create({'catalog_selections': []})
        for picks in ([{'service_code': 'drone', 'quantity': 2}], [{'service_code': 'yoga_class', 'quantity': 1}]):
            with self.subTest(picks=picks), self.assertRaises(self.ledger.QuoteBoundaryError):
                self.ledger.prepare_create({'catalog_selections': picks})
        self.assertEqual(self.ledger.prepare_quote({'catalog_selections': []})['add_ons'], [])
        self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])

    def test_revision_requires_fresh_quote_and_acceptance(self):
        self.accept()
        raw = 'Remove the yoga'
        self.turn('m3', raw)
        self.interpret(raw, action='revise', material_changes=[{
            'field': 'catalog_selections', 'operation': 'remove',
            'item': {'service_code': 'yoga_class'}, 'evidence': 'yoga'}])
        revised = self.ledger.prepare_quote({'catalog_selections': []})
        self.ledger.record_quote(revised, self.checked(revised))
        # A hidden materially changed quote is not the offer actually shown.
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'Updated quote'})
        self.model_waits('m4', 'Please explain the new total')

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
            self.model_waits(text, text)

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
                        'exact_bed_eligibility': {
                            'eligible': True, 'selected_bed_codes': ['M1', 'M2'],
                            'guest_bed_assignments': [
                                {'guest_index': 0, 'guest_name': 'Riley', 'bed_code': 'M1'},
                                {'guest_index': 1, 'guest_name': 'Morgan', 'bed_code': 'M2'},
                            ]},
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
                        'exact_bed_eligibility': {
                            'eligible': True, 'selected_bed_codes': ['M1', 'M2'],
                            'guest_bed_assignments': [
                                {'guest_index': 0, 'guest_name': 'Alex', 'bed_code': 'M1'},
                                {'guest_index': 1, 'guest_name': 'Sam', 'bed_code': 'M2'},
                            ]},
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
        second = self.ledger.prepare_create({'idempotency_key': 'model-second', 'quote_total_cents': 2})
        self.assertEqual(first['idempotency_key'], second['idempotency_key'])
        self.assertTrue(first['idempotency_key'].startswith('luna-owner-'))
        self.assertNotIn('total_cents', first)
        self.assertNotIn('quote_total_cents', second)

    def test_sim20_locale_is_rendering_metadata_not_offer_identity(self):
        for index, language in enumerate(('en', 'es', 'fr', 'de')):
            with self.subTest(language=language):
                self.agent.session_id = f'sim20-locale-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {key: deepcopy(value) for key, value in self.plan.items()
                        if key != 'language'}
                self.turn(f'sim20-offer-{index}', 'Quote this please')
                response = self.checked(plan)
                self.present(plan, response)
                self.turn(f'sim20-yes-{index}', 'yes')
                first = self.ledger.prepare_create({'language': language})
                self.assertTrue(first.revalidation)
                self.assertEqual(first['language'], language)
                self.ledger.record_quote(first, deepcopy(response))
                accepted = self.ledger.prepare_create({'language': language})
                changed_locale = self.ledger.prepare_create(
                    {'language': 'de' if language != 'de' else 'en'})
                self.assertEqual(accepted['idempotency_key'], changed_locale['idempotency_key'])
                self.assertEqual(changed_locale['language'], 'de' if language != 'de' else 'en')

    def test_sim20_new_mixed_group_fact_requires_equivalent_staff_revalidation(self):
        plan = {key: deepcopy(value) for key, value in self.plan.items()
                if key != 'group_gender'}
        self.turn('sim20-g2-offer', 'Quote this please')
        response = self.checked(plan)
        self.present(plan, response)
        self.turn('sim20-g2-yes', 'yes, our group is mixed')
        prepared = self.ledger.prepare_create({'group_gender': 'mixed'})
        self.assertTrue(prepared.revalidation)
        self.assertEqual(prepared['group_gender'], 'mixed')
        refreshed = self.checked(prepared)
        self.ledger.record_quote(prepared, refreshed)
        self.assertEqual(self.ledger.prepare_create({})['accepted_offer'],
                         refreshed['offer_revision'])

        self.agent.session_id = 'sim20-g2-conflict'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('sim20-g2-conflict-offer', 'Quote this please')
        self.present(plan, response)
        self.turn('sim20-g2-conflict-yes', 'yes, our group is mixed')
        contradictory = self.ledger.prepare_create({'group_gender': 'mixed'})
        changed = self.checked({**dict(contradictory), 'selected_bed_codes': ['F1', 'F2']},
                               [dict(bed_code='F1', room_code='F', gender_strategy='female_only'),
                                dict(bed_code='F2', room_code='F', gender_strategy='female_only')])
        self.ledger.record_quote(contradictory, changed)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    '^quote_owner_presented_offer_required$'):
            self.ledger.prepare_create({})

    def test_sim21_specific_room_preference_survives_generic_requote_and_change_is_disclosed(self):
        plan = {**deepcopy(self.plan), 'room_preference': 'room 1'}
        beds = [dict(bed_code='R9-B1', room_code='R9', gender_strategy='flexible')]
        response = self.checked(plan, beds)
        self.agent.session_id = 'sim21-room-preference'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('sim21-room-quote', 'Could I get room 1 again?')
        self.present(plan, response)
        self.turn('sim21-room-requote', 'Yes, book it')
        prepared = self.ledger.prepare_quote({'room_type': 'shared', 'room_preference': 'shared'})
        self.assertEqual(prepared['room_preference'], 'room 1')
        notice = self.ledger._requested_room_change_line(plan, response['offer_revision'], 'en')
        self.assertIn('Room 1 is not available', notice)
        self.assertIn('Room 9', notice)

    def test_sim21_deliberate_gendered_to_shared_change_is_not_overridden(self):
        plan = {**deepcopy(self.plan), 'room_preference': 'female_only'}
        response = self.checked(plan)
        self.agent.session_id = 'sim21-deliberate-room-change'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('sim21-gendered-quote', 'A women-only dorm, please.')
        self.present(plan, response)
        self.turn('sim21-shared-requote', 'Actually, a shared dorm is fine.')
        prepared = self.ledger.prepare_quote({'room_type': 'shared', 'room_preference': 'shared'})
        self.assertEqual(prepared['room_preference'], 'shared')

    def test_sim20_four_fact_material_contract_and_stable_operation_key(self):
        self.accept()
        carried = self.ledger.prepare_create({
            'language': 'fr', 'email': 'guest@example.invalid',
            'guests': [{'name': 'Alex Rivera'}, {'name': 'Sam Lee'}],
            'payment_choice': 'deposit',
        })
        self.assertTrue(carried.revalidation)
        refreshed = self.checked(carried)
        self.ledger.record_quote(carried, refreshed)
        first = self.ledger.prepare_create({})
        key = first['idempotency_key']
        second = self.ledger.prepare_create({'language': 'de', 'email': 'other@example.invalid'})
        self.assertEqual(second['idempotency_key'], key)
        self.assertEqual(second['language'], 'de')
        for change in (
                {'check_in': '2026-11-02'}, {'check_out': '2026-11-09'},
                {'guest_count': 3}, {'selected_bed_codes': ['M2', 'M1']},
                {'package_code': 'surf_week'},
                {'catalog_selections': [{'service_code': 'drone', 'quantity': 2}]}):
            with self.subTest(change=change), self.assertRaisesRegex(
                    self.ledger.QuoteBoundaryError, '^accepted_quote_changed$'):
                self.ledger.prepare_create(change)

    def test_jw1749_materially_new_presented_offer_mints_new_operation_key(self):
        changes = (
            {'check_in': '2026-12-01', 'check_out': '2026-12-08'},
            {'selected_bed_codes': ['M2', 'M1']},
            {'package_code': 'surf_week'},
        )
        for index, change in enumerate(changes):
            with self.subTest(change=change):
                self.agent.session_id = f'jw1749-new-operation-{index}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn(f'offer-{index}-a', 'Quote this please')
                self.present()
                self.turn(f'accept-{index}-a', 'yes')
                self.interpret('yes')
                old_key = self.ledger.prepare_create({})['idempotency_key']
                changed = {**deepcopy(self.plan), **change}
                self.turn(f'offer-{index}-b', 'Please quote the changed offer')
                self.present(changed, self.checked(changed))
                self.turn(f'accept-{index}-b', 'yes')
                self.interpret('yes')
                self.assertNotEqual(self.ledger.prepare_create({})['idempotency_key'], old_key)

        self.agent.session_id = 'jw1749-new-operation-price'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('price-offer-a', 'Quote this please')
        original = self.present()
        self.turn('price-accept-a', 'yes')
        self.interpret('yes')
        old_key = self.ledger.prepare_create({})['idempotency_key']
        repriced = deepcopy(original)
        for field in ('total_cents', 'deposit_required_cents', 'payment_link_amount_cents'):
            if field in repriced:
                repriced[field] = int(repriced[field]) + 1000
            if field in repriced['offer_revision']:
                repriced['offer_revision'][field] = int(repriced['offer_revision'][field]) + 1000
        self.turn('price-offer-b', 'Please quote the new price')
        self.present(self.plan, repriced)
        self.turn('price-accept-b', 'yes')
        self.interpret('yes')
        self.assertNotEqual(self.ledger.prepare_create({})['idempotency_key'], old_key)

    def test_jw1749_newer_checked_tool_truth_supersedes_stale_eligibility(self):
        import json
        eligibility = {'success': True, 'availability_status': 'eligibility_required',
                       'next_action': 'ask_room_eligibility',
                       'reply_draft': 'Are all guests women?'}
        checked = self.checked()
        rendered = self.ledger.finalize_offer_response({
            'completed': True, 'final_response': 'Current checked quote',
            'messages': [
                {'role': 'user', 'content': 'Please check'},
                {'role': 'tool', 'content': json.dumps(eligibility)},
                {'role': 'tool', 'content': json.dumps(checked)},
                {'role': 'assistant', 'content': 'Current checked quote'},
            ],
        })
        self.assertNotEqual(rendered['final_response'], 'Are all guests women?')
        self.assertNotIn('all guests women', rendered['final_response'].casefold())

    def test_sim20_missing_and_empty_optional_selections_are_equivalent(self):
        plan = deepcopy(self.plan)
        plan.pop('catalog_selections', None)
        plan.pop('add_ons', None)
        self.agent.session_id = 'sim20-empty-optional'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('empty-offer', 'Quote this please')
        self.present(plan, self.checked(plan))
        self.turn('empty-accept', 'yes')
        self.assertTrue(self.ledger.prepare_create(
            {'catalog_selections': [], 'add_ons': []}).revalidation)

    def test_sim20_eligibility_finalizer_cannot_claim_unavailability(self):
        import json
        receipt = {'success': True, 'availability_status': 'eligibility_required',
                   'available': False, 'unavailable': False,
                   'next_action': 'ask_room_eligibility',
                   'reply_draft': 'Would a mixed dorm work for you?'}
        rendered = self.ledger.finalize_offer_response({
            'completed': True, 'final_response': "The women's dorm is unavailable.",
            'messages': [
                {'role': 'user', 'content': 'Can I have a women-only dorm?'},
                {'role': 'tool', 'content': json.dumps(receipt)},
                {'role': 'assistant', 'content': "The women's dorm is unavailable."},
            ],
        })
        self.assertEqual(rendered['final_response'], 'Would a mixed dorm work for you?')
        self.assertNotIn('unavailable', rendered['messages'][-1]['content'])

    def test_sim21_successful_handoff_tells_guest_it_happened_without_retry_request(self):
        import json
        receipt = {'success': True, 'tool': 'flag_needs_human', 'needs_human': True,
                   'handoff_persisted': True}
        rendered = self.ledger.finalize_offer_response({
            'completed': True,
            'final_response': 'I could not verify that. Please ask again.',
            'messages': [
                {'role': 'user', 'content': 'Yes, please book.'},
                {'role': 'tool', 'content': json.dumps(receipt)},
                {'role': 'assistant', 'content': 'I could not verify that. Please ask again.'},
            ],
        })
        self.assertIn('handed this to the team', rendered['final_response'])
        self.assertNotIn('ask again', rendered['final_response'].casefold())

    def test_sim20_legacy_pending_and_completed_operation_keys_remain_compatible(self):
        import hashlib
        state = {
            'scope': {'tenant': 'wolfhouse-somo'}, 'incarnation': 7,
            'offer_message': 'offer', 'acceptance_message': 'yes',
            'plan': {'check_in': '2026-11-01'},
            'quote': {'success': True, 'total_cents': 20000},
        }
        encoded = self.ledger._encode({
            'scope': state['scope'], 'incarnation': state['incarnation'],
            'offer': state['offer_message'], 'acceptance': state['acceptance_message'],
            'plan': state['plan'], 'quote': state['quote'],
        })
        expected = 'luna-owner-' + hashlib.sha256(encoded.encode()).hexdigest()[:32]
        for marker in ({'dispatch_pending': True},
                       {'receipt': {'success': True, 'booking_id': 'legacy'}}):
            with self.subTest(marker=marker):
                self.assertEqual(self.ledger._owner_operation_key({**state, **marker}), expected)
        self.assertEqual(self.ledger._owner_operation_key(
            {**state, 'operation_key': 'luna-owner-persisted'}),
            'luna-owner-persisted')

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

    def test_sim19_incomplete_offer_shows_split_rooms_without_internal_codes(self):
        plan = {**self.plan, 'room_preference': 'male_only',
                'group_gender': 'male', 'payment_choice': None,
                'selected_bed_codes': ['R4-B1', 'R5-B1']}
        response = self.checked(plan, [
            dict(bed_code='R4-B1', room_code='R4', gender_strategy='male_only'),
            dict(bed_code='R5-B1', room_code='R5', gender_strategy='male_only')])
        response['payment_choice_needed'] = True
        response['offer_revision']['payment_choice'] = 'deposit'
        response['offer_revision']['payment_link_amount_cents'] = response['deposit_required_cents']
        self.turn('sim19-split', 'Please quote that')
        self.ledger.record_quote(plan, response)
        shown = self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'as proposed', 'messages': []})
        self.assertIn('two separate', shown['final_response'])
        self.assertNotIn('R4', shown['final_response'])
        self.assertNotIn('R5', shown['final_response'])
        self.assertNotIn('B1', shown['final_response'])
        self.assertNotIn('as proposed', shown['final_response'].lower())

    def test_sim19_incomplete_offer_uses_receipt_assignments_without_blank_names(self):
        self.agent.session_id = 'sim19-receipt-split'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = {key: deepcopy(value) for key, value in self.plan.items()
                if key != 'selected_bed_codes'}
        plan['payment_choice'] = None
        plan['guests'] = [{'name': ''}, {'name': ''}]
        response = self.checked(self.plan, [
            dict(bed_code='R4-B1', room_code='R4', gender_strategy='mixed'),
            dict(bed_code='R5-B1', room_code='R5', gender_strategy='mixed')])
        for assignment in response['offer_revision']['guest_bed_assignments']:
            assignment['guest_name'] = None
        response['payment_choice_needed'] = True
        self.turn('sim19-receipt-split', 'Please quote that')
        self.ledger.record_quote(plan, response)
        shown = self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'as proposed', 'messages': []})
        self.assertIn('two separate mixed rooms', shown['final_response'])
        self.assertNotIn(': beds', shown['final_response'])
        self.assertNotIn('R4', shown['final_response'])
        self.assertNotIn('R5', shown['final_response'])

    def test_sim19_valid_eligibility_question_is_not_replaced(self):
        self.turn('sim19-women-eligibility', "I'd like the women's dorm")
        question = 'Are both guests women?'
        self.ledger.record_quote(self.plan, {
            'success': False,
            'quote_status': 'needs_guest_clarification',
            'guest_safe_next_action': question,
            'offer_revision': None,
        })
        shown = self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft', 'messages': []})
        self.assertEqual(question, shown['final_response'])

    def test_sim19_spanish_eligibility_question_keeps_meaning_in_spanish(self):
        self.agent.session_id = 'sim19-spanish-eligibility'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('sim19-spanish-eligibility-turn',
                  'Hola, quiero reservar dos camas en la habitación femenina')
        self.ledger.record_quote(self.plan, {
            'success': False,
            'quote_status': 'needs_guest_clarification',
            'guest_safe_next_action': 'Are both guests women?',
            'offer_revision': None,
        })
        shown = self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft', 'messages': []})
        self.assertEqual('¿Son mujeres las dos huéspedes?', shown['final_response'])

    def test_sim19_multilingual_eligibility_questions_remain_supported(self):
        cases = (
            ('en', 'Are both guests girls?'),
            ('es', '¿Sois dos chicos?'),
            ('de', 'Seid ihr beide Jungs?'),
        )
        for language, question in cases:
            with self.subTest(language=language):
                self.agent.session_id = f'sim19-eligibility-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn(f'sim19-eligibility-{language}-turn', question)
                self.ledger.record_quote({**self.plan, 'language': language}, {
                    'success': False,
                    'quote_status': 'needs_guest_clarification',
                    'guest_safe_next_action': question,
                    'offer_revision': None,
                })
                shown = self.ledger.finalize_offer_response(
                    {'completed': True, 'final_response': 'draft', 'messages': []})
                self.assertEqual(question, shown['final_response'])

    def test_sim19_owner_adapter_keeps_explicit_unnamed_party_composition(self):
        import json
        import wolfhouse_staff_api as plugin

        cases = (
            ('explicit-unnamed', {'group_gender': 'male'}, 'male'),
            ('unknown-unnamed', {}, None),
            ('explicit-partial-roster', {'group_gender': 'male',
                                         'guests': [{'name': 'Alex'}]}, 'male-partial'),
            ('explicit-named', {'group_gender': 'male',
                                'guests': [{'name': 'Sam Example'},
                                           {'name': 'Dan Example'}]}, 'named'),
        )
        for suffix, extras, expected in cases:
            with self.subTest(case=suffix):
                self.agent.session_id = 'sim19-' + suffix
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn('sim19-' + suffix + '-turn',
                          'Wir sind zwei Jungs.' if extras else 'Two beds in the male dorm please.')
                calls = []
                def fake_post(path, payload):
                    calls.append((path, deepcopy(payload)))
                    return {'success': False, 'needs_clarification': True,
                            'selected_bed_codes': [],
                            'guest_safe_next_action': 'Synthetic boundary.'}
                params = {'check_in': '2026-11-09', 'check_out': '2026-11-12',
                          'guest_count': 2, 'room_type': 'shared',
                          'room_preference': 'male_only',
                          'package_code': 'package_none', **extras}
                with patch.object(plugin, '_post_bot', side_effect=fake_post):
                    json.loads(plugin.quote_booking(params))
                payload = calls[0][1]
                if expected == 'male':
                    self.assertEqual('male', payload.get('group_gender'))
                    self.assertNotIn('guests', payload)
                elif expected == 'male-partial':
                    self.assertEqual('male', payload.get('group_gender'))
                    self.assertEqual(['Alex'], [guest.get('name')
                                                for guest in payload.get('guests', [])])
                elif expected == 'named':
                    self.assertNotIn('group_gender', payload)
                    self.assertEqual(['male', 'male'],
                                     [guest.get('explicit_gender')
                                      for guest in payload.get('guests', [])])
                else:
                    self.assertNotIn('group_gender', payload)
                    self.assertNotIn('guests', payload)

    def test_sim19_deterministic_quote_and_refusal_are_spanish(self):
        self.agent.session_id = 'sim19-spanish'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        spanish_plan = {**self.plan, 'payment_choice': None}
        self.turn('sim19-es-quote', '¡Hola Luna! Soy Lucía, de Sevilla 🇪🇸 Busco 1 cama en el dormitorio mixto del lunes 9 al jueves 12 de noviembre de 2026 (3 noches). Soy mujer y viajo sola. ¿Cuánto cuesta?')
        response = deepcopy(self.response)
        response['payment_choice_needed'] = True
        self.ledger.record_quote(spanish_plan, response)
        shown = self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft', 'messages': []})
        self.assertIn('Total: 200.00 EUR.', shown['final_response'])
        self.assertIn('¿Qué opción de pago', shown['final_response'])

        self.agent.session_id = 'sim19-spanish-refusal'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('sim19-es-refusal', 'Quiero esa habitación')
        refusal = {'success': False, 'quote_status': 'needs_guest_clarification',
                   'guest_safe_next_action': '', 'offer_revision': None}
        self.ledger.record_quote(self.plan, refusal)
        blocked = self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft', 'messages': []})
        self.assertIn('No pude verificar', blocked['final_response'])

    def test_sim19_complete_incomplete_and_refusal_are_fully_localized(self):
        cases = {
            'en': ('Please book this room', 'Accommodation only', 'Payment options', 'Availability checked', 'I could not verify'),
            'es': ('Quiero reservar esta habitación', 'Solo alojamiento', 'Opciones de pago', 'Disponibilidad comprobada', 'No pude verificar'),
            'fr': ('Bonjour, je voudrais réserver cette chambre', 'Hébergement seul', 'Options de paiement', 'Disponibilité vérifiée', "Je n'ai pas encore pu vérifier"),
            'de': ('Hallo, ich möchte dieses Zimmer buchen', 'Nur Unterkunft', 'Zahlungsoptionen', 'Verfügbarkeit geprüft', 'Ich konnte noch kein geeignetes Bett'),
        }
        for language, expected in cases.items():
            raw, accommodation, options, availability, refusal_text = expected
            with self.subTest(language=language):
                plan = {**self.plan, 'language': language}
                self.agent.session_id = f'sim19-{language}-complete'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn(f'sim19-{language}-complete-turn', raw)
                self.ledger.record_quote(plan, self.checked(plan))
                text = self.ledger.finalize_offer_response({'completed': True, 'final_response': 'as proposed', 'messages': []})['final_response']
                self.assertIn(accommodation, text)
                self.assertIn(availability, text)
                self.assertIn('200.00 EUR', text)
                self.assertIn('100.00 EUR', text)
                self.assertNotIn('as proposed', text.casefold())
                self.assertNotRegex(text, r'\b(?:M|R\d+)(?:-B\d+)?\b')

                self.agent.session_id = f'sim19-{language}-incomplete'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn(f'sim19-{language}-incomplete-turn', 'English current turn')
                incomplete = self.checked(plan)
                incomplete['payment_choice_needed'] = True
                incomplete_plan = {**plan, 'payment_choice': None}
                self.ledger.record_quote(incomplete_plan, incomplete)
                text = self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft', 'messages': []})['final_response']
                self.assertIn(options, text)
                self.assertIn('200.00 EUR', text)
                self.assertNotIn('Payment options', text) if language != 'en' else self.assertIn('Payment options', text)

                self.agent.session_id = f'sim19-{language}-refusal'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn(f'sim19-{language}-refusal-turn', raw)
                self.ledger.record_quote(plan, {'success': False, 'quote_status': 'needs_guest_clarification',
                    'guest_safe_next_action': 'English Staff copy must not leak.', 'offer_revision': None})
                text = self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft', 'messages': []})['final_response']
                self.assertIn(refusal_text, text)
                self.assertNotIn('English Staff copy', text)

    def test_sim19_explicit_composition_and_numbered_gendered_room_instruction(self):
        soul = (Path(__file__).resolve().parents[1] / 'SOUL.md').read_text()
        self.assertIn('“zwei Jungs”', soul)
        self.assertIn('preserve it as `group_gender`', soul)
        self.assertIn("including a gendered or numbered room request", soul)
        self.assertIn('Never silently replace any of these with `mixed`', soul)
        self.assertIn('Names alone never supply these facts', soul)


if __name__ == '__main__':
    unittest.main()
