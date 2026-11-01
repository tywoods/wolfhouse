"""Offline owner-ledger tracer bullet; real Hermes SessionDB, no business writes."""
import hashlib
import json
import tempfile
import unittest
import sys
from copy import deepcopy
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'plugins'))

try:
    from hermes_state import SessionDB
    from gateway.session_context import set_session_vars, clear_session_vars
except ModuleNotFoundError as exc:
    if exc.name == 'hermes_state':
        raise unittest.SkipTest(
            'requires the pinned Hermes runtime supplied by the staging image') from exc
    raise


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

    def test_pending_question_binds_addon_and_quote_answers_in_supported_languages(self):
        """A bare answer belongs to the last rendered question, never a service word."""
        fixtures = {
            'en': ('No', 'Yes', 'No', 'Cancel this booking'),
            'es': ('No', 'Sí', 'No', 'Cancela esta reserva'),
            'it': ('No', 'Sì', 'No', 'Annulla questa prenotazione'),
        }
        for language, (addon_no, addon_yes, quote_no, cancel) in fixtures.items():
            plan = {**self.plan, 'language': language, 'package_code': 'package_surf_week'}
            plan.pop('payment_choice')
            package_response = self.checked({**plan, 'payment_choice': 'deposit'})
            package_response['payment_choice_needed'] = True
            with self.subTest(language=language, answer='addon-no'):
                self.agent.session_id = f'pending-addon-no-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn(f'{language}-addon-no-offer', 'Quote package')
                self.ledger.record_quote(plan, package_response)
                self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                self.turn(f'{language}-addon-no-answer', addon_no)
                result = self.interpret(addon_no, action='reject', negated=True)
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertEqual(state['add_on_decisions']['shuttle'], 'declined')
                self.assertEqual(state['pending_question']['kind'], 'go_ahead')
                self.assertEqual(result['next_action'], 'requote_material_changes')
            with self.subTest(language=language, answer='addon-yes'):
                self.agent.session_id = f'pending-addon-yes-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn(f'{language}-addon-yes-offer', 'Quote package')
                self.ledger.record_quote(plan, package_response)
                self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                self.turn(f'{language}-addon-yes-answer', addon_yes)
                result = self.interpret(addon_yes)
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertEqual(state['add_on_decisions']['shuttle'], 'accepted')
                self.assertEqual(result['next_action'], 'requote_material_changes')
            with self.subTest(language=language, answer='quote-decline'):
                self.agent.session_id = f'pending-quote-no-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn(f'{language}-quote-offer', 'Quote stay')
                self.ledger.record_quote({**self.plan, 'language': language}, self.checked(self.plan))
                self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                self.turn(f'{language}-quote-answer', quote_no)
                result = self.interpret(quote_no, action='reject', negated=True)
                self.assertEqual(result['next_action'], 'do_not_create')
            with self.subTest(language=language, answer='explicit-cancel'):
                self.agent.session_id = f'pending-cancel-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn(f'{language}-cancel-offer', 'Quote package')
                self.ledger.record_quote(plan, package_response)
                self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                self.turn(f'{language}-cancel-answer', cancel)
                result = self.interpret(cancel, action='reject', negated=True)
                self.assertEqual(result['next_action'], 'do_not_create')

    def test_pending_addon_target_beats_cancellation_word_guessing(self):
        """Cancellation wording names the pending add-on unless it names the booking."""
        fixtures = {
            'en': ('Cancel the shuttle', "Please don't book the shuttle"),
            'es': ('Cancela el traslado', 'No reserves el traslado'),
            'it': ('Annulla la navetta', 'Non prenotare la navetta'),
        }
        for language, replies in fixtures.items():
            for reply in replies:
                with self.subTest(language=language, reply=reply):
                    self.agent.session_id = f'answer-last-addon-cancel-{language}-{len(reply)}'
                    self.db.create_session(self.agent.session_id, source='whatsapp')
                    plan = {**self.plan, 'language': language,
                            'package_code': 'package_surf_week'}
                    plan.pop('payment_choice')
                    response = self.checked({**plan, 'payment_choice': 'deposit'})
                    response['payment_choice_needed'] = True
                    self.turn(f'answer-last-addon-cancel-offer-{language}-{len(reply)}',
                              'Quote package')
                    self.ledger.record_quote(plan, response)
                    self.ledger.finalize_offer_response(
                        {'completed': True, 'final_response': 'draft'})
                    self.turn(f'answer-last-addon-cancel-reply-{language}-{len(reply)}', reply)
                    result = self.interpret(reply, action='reject', negated=True)
                    state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                    self.assertEqual(result['next_action'], 'requote_material_changes')
                    self.assertEqual(state['add_on_decisions']['shuttle'], 'declined')
                    self.assertEqual(state['plan']['pending_transfers'], [])

        whole_booking_replies = {
            'en': (
                'Cancel the whole booking, including the shuttle',
                'Cancel the entire reservation, including breakfast',
            ),
            'es': (
                'Cancela toda la reserva, incluido el traslado',
                'Cancela toda la estancia, incluida la clase de surf',
            ),
            'it': ('Annulla tutta la prenotazione, inclusa la navetta',),
        }
        for language, replies in whole_booking_replies.items():
            for reply in replies:
                with self.subTest(language=language, whole_booking_reply=reply):
                    session_suffix = f'{language}-{len(reply)}'
                    self.agent.session_id = f'answer-last-addon-cancel-whole-{session_suffix}'
                    self.db.create_session(self.agent.session_id, source='whatsapp')
                    plan = {**self.plan, 'language': language,
                            'package_code': 'package_surf_week'}
                    plan.pop('payment_choice')
                    response = self.checked({**plan, 'payment_choice': 'deposit'})
                    response['payment_choice_needed'] = True
                    self.turn(f'answer-last-addon-cancel-whole-offer-{session_suffix}',
                              'Quote package')
                    self.ledger.record_quote(plan, response)
                    self.ledger.finalize_offer_response(
                        {'completed': True, 'final_response': 'draft'})
                    self.turn(f'answer-last-addon-cancel-whole-reply-{session_suffix}', reply)
                    result = self.interpret(reply, action='reject', negated=True)
                    state = self.ledger._transaction(
                        lambda current, _ingress: deepcopy(current))
                    self.assertEqual(result['next_action'], 'do_not_create')
                    self.assertNotIn('add_on_decisions', state)

    def test_pending_target_beats_interpreter_word_guessing_in_supported_languages(self):
        """Polarity answers bind to the asked target; explicit no-book commands do not."""
        fixtures = {
            'en': ('No thanks', "Please don't book this"),
            'es': ('No, gracias', 'No reserves esto'),
            'it': ('No, grazie', 'Non prenotare questo'),
        }
        for language, (payment_no, booking_no) in fixtures.items():
            with self.subTest(language=language, target='payment-choice'):
                self.agent.session_id = f'answer-last-payment-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'language': language}
                plan.pop('payment_choice')
                response = self.checked({**plan, 'payment_choice': 'deposit'})
                response['payment_choice_needed'] = True
                self.turn(f'answer-last-payment-offer-{language}', 'Quote stay')
                self.ledger.record_quote(plan, response)
                self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                self.turn(f'answer-last-payment-distribution-{language}', payment_no)
                first = self.interpret(payment_no, action='reject', negated=True)
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertEqual(first['next_action'], 'requote_material_changes')
                self.assertEqual(state['plan']['payment_distribution'], 'separate')
                self.assertNotIn('payment_choice', state['plan'])
                revised = self.ledger.prepare_quote({})
                revised_response = self.checked({**revised, 'payment_choice': 'deposit'})
                revised_response['payment_choice_needed'] = True
                self.ledger.record_quote(revised, revised_response)
                self.ledger.finalize_offer_response({'completed': True, 'final_response': 'updated'})
                self.turn(f'answer-last-payment-reply-{language}', payment_no)
                result = self.interpret(payment_no, action='reject', negated=True)
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertEqual(result['next_action'], 'revalidate_selected_terms')
                self.assertEqual(state['plan']['payment_choice'], 'full')

            with self.subTest(language=language, target='whole-booking'):
                self.agent.session_id = f'answer-last-booking-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'language': language, 'package_code': 'package_surf_week'}
                plan.pop('payment_choice')
                response = self.checked({**plan, 'payment_choice': 'deposit'})
                response['payment_choice_needed'] = True
                self.turn(f'answer-last-addon-offer-{language}', 'Quote package')
                self.ledger.record_quote(plan, response)
                self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                self.turn(f'answer-last-addon-reply-{language}', booking_no)
                result = self.interpret(booking_no, action='reject', negated=True)
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertEqual(result['next_action'], 'do_not_create')
                self.assertNotIn('add_on_decisions', state)

    def test_pending_payment_options_and_shuttle_requote_are_localized_and_durable(self):
        """Bare yes/no selects the options actually rendered, then re-quotes."""
        answers = {'en': ('No', 'Yes'), 'es': ('No', 'Sí'), 'it': ('No', 'Sì')}
        for language, (no, yes) in answers.items():
            with self.subTest(language=language, question='payment'):
                self.agent.session_id = f'pending-payment-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'language': language}
                plan.pop('payment_choice')
                response = self.checked({**plan, 'payment_choice': 'deposit'})
                response['payment_choice_needed'] = True
                self.turn(f'{language}-payment-offer', 'Quote stay')
                self.ledger.record_quote(plan, response)
                self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                expected = ['together', 'separate']
                self.assertEqual(state['pending_question'],
                                 {'kind': 'payment_choice', 'options': expected})
                self.turn(f'{language}-distribution-answer', no)
                distribution_result = self.interpret(no, action='reject', negated=True)
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertEqual(distribution_result['next_action'], 'requote_material_changes')
                self.assertEqual(state['pending_question'],
                                 {'kind': 'payment_choice', 'options': ['deposit', 'full']})
                self.assertEqual(state['plan']['payment_distribution'], 'separate')
                self.assertNotIn('payment_choice', state['plan'])
                revised = self.ledger.prepare_quote({})
                revised_response = self.checked({**revised, 'payment_choice': 'deposit'})
                revised_response['payment_choice_needed'] = True
                self.ledger.record_quote(revised, revised_response)
                self.ledger.finalize_offer_response({'completed': True, 'final_response': 'updated'})
                self.turn(f'{language}-payment-answer', no)
                result = self.interpret(no, action='reject', negated=True)
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertEqual(result['next_action'], 'revalidate_selected_terms')
                self.assertNotEqual(result['next_action'], 'do_not_create')
                self.assertEqual(state['plan']['payment_choice'], 'full')
                self.assertIsNone(state.get('checked_offer'))

            with self.subTest(language=language, question='shuttle-next-turn'):
                self.agent.session_id = f'pending-shuttle-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'language': language, 'package_code': 'package_surf_week'}
                plan.pop('payment_choice')
                response = self.checked({**plan, 'payment_choice': 'deposit'})
                response['payment_choice_needed'] = True
                self.turn(f'{language}-shuttle-offer', 'Quote package')
                self.ledger.record_quote(plan, response)
                self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                self.turn(f'{language}-shuttle-answer', yes)
                result = self.interpret(yes)
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertEqual(result['next_action'], 'requote_material_changes')
                self.assertNotIn('pending_transfers', state['plan'])
                self.assertEqual(state['add_on_decisions']['shuttle'], 'accepted')
                revised = self.ledger.prepare_quote({})
                self.assertNotIn('pending_transfers', revised)
                revised_response = self.checked({**dict(revised), 'payment_choice': 'deposit'})
                revised_response['payment_choice_needed'] = True
                self.ledger.record_quote(revised, revised_response)
                self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                self.turn(f'{language}-next-turn', no)
                next_result = self.interpret(no, action='reject', negated=True)
                self.assertNotEqual(next_result['next_action'], 'do_not_create')

    def test_uncertain_pending_answers_reopen_without_selecting_or_losing_the_rendered_question(self):
        """Conditional replies cannot bind the preceding localized choice."""
        fixtures = {
            'en': ('Yes, if the shuttle is free', 'Would you like to pay together'),
            'es': ('Sí, si el traslado es gratis', '¿Preferís pagar juntos'),
            'it': ('Sì, se la navetta è gratuita', 'Preferite pagare insieme'),
        }
        for language, (conditional, payment_question) in fixtures.items():
            with self.subTest(language=language, question='add-on'):
                self.agent.session_id = f'uncertain-addon-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'language': language, 'package_code': 'package_surf_week'}
                plan.pop('payment_choice')
                response = self.checked({**plan, 'payment_choice': 'deposit'})
                response['payment_choice_needed'] = True
                self.turn(f'uncertain-addon-offer-{language}', 'Quote package')
                self.ledger.record_quote(plan, response)
                shown = self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                self.assertEqual(shown['final_response'], 'draft')
                self.db.close()
                self.db = SessionDB(Path(self.temp.name) / 'state.db')
                self.agent._session_db = self.db
                self.turn(f'uncertain-addon-answer-{language}', conditional)
                result = self.interpret(conditional, conditional=True)
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertNotIn('add_on_decisions', state)
                self.assertNotIn('pending_transfers', state['plan'])
                self.assertEqual(state['pending_question']['kind'], 'add_on')
                self.assertEqual(result['question'], 'draft')

            with self.subTest(language=language, question='payment'):
                self.agent.session_id = f'uncertain-payment-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'language': language}
                plan.pop('payment_choice')
                response = self.checked({**plan, 'payment_choice': 'deposit'})
                response['payment_choice_needed'] = True
                self.turn(f'uncertain-payment-offer-{language}', 'Quote stay')
                self.ledger.record_quote(plan, response)
                shown = self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                self.assertEqual(shown['final_response'], 'draft')
                self.db.close()
                self.db = SessionDB(Path(self.temp.name) / 'state.db')
                self.agent._session_db = self.db
                self.turn(f'uncertain-payment-answer-{language}', conditional)
                result = self.interpret(conditional, conditional=True)
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertNotIn('payment_choice', state['plan'])
                self.assertEqual(state['pending_question']['kind'], 'payment_choice')
                self.assertEqual(result['question'], shown['final_response'].rsplit('\n\n', 1)[-1])

    def test_explicit_group_payment_choice_survives_book_it_follow_up(self):
        fixtures = {
            'en-option': ('separate', 'separate'),
            'en': ('separately', 'separate'),
            'es': ('por separado', 'separate'),
            'en-together': ('together', 'together'),
            'es-together': ('juntos', 'together'),
        }
        for label, (answer, expected) in fixtures.items():
            language = 'es' if label.startswith('es') else 'en'
            with self.subTest(language=language, answer=answer):
                self.agent.session_id = f'explicit-payment-{label}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'language': language}
                plan.pop('payment_choice')
                response = self.checked({**plan, 'payment_choice': 'deposit'})
                response['payment_choice_needed'] = True
                self.turn(f'explicit-payment-offer-{label}', 'Quote stay')
                self.ledger.record_quote(plan, response)
                self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                self.turn(f'explicit-payment-answer-{label}', answer)
                result = self.interpret(answer, action='revise')
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertEqual(result['next_action'], 'requote_material_changes')
                self.assertEqual(state['plan']['payment_distribution'], expected)
                self.assertNotIn('payment_choice', state['plan'])
                self.assertEqual(state['pending_question'],
                                 {'kind': 'payment_choice', 'options': ['deposit', 'full']})
                stage_two_plan = self.ledger.prepare_quote({})
                stage_two = self.checked({**stage_two_plan, 'payment_choice': 'deposit'})
                stage_two['payment_choice_needed'] = True
                self.ledger.record_quote(stage_two_plan, stage_two)
                self.ledger.finalize_offer_response({'completed': True, 'final_response': 'updated'})
                self.turn(f'explicit-payment-amount-{label}', 'deposit')
                amount_result = self.interpret('deposit', action='accept')
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertEqual(amount_result['next_action'], 'revalidate_selected_terms')
                self.assertEqual(state['plan']['payment_choice'], 'deposit')
                self.assertIsNone(state.get('pending_question'))
                self.assertEqual(state['plan']['payment_choice'], 'deposit')

    def test_conditional_negative_reopens_the_actual_localized_question(self):
        """"No, unless" is conditional—not a decline of the preceding prompt."""
        fixtures = {
            'en': 'No, unless the shuttle is free',
            'es': 'No, a menos que el traslado sea gratis',
            'it': 'No, a meno che la navetta sia gratuita',
        }
        for language, conditional in fixtures.items():
            for question_kind in ('add_on', 'payment_choice'):
                with self.subTest(language=language, question=question_kind):
                    self.agent.session_id = f'conditional-negative-{question_kind}-{language}'
                    self.db.create_session(self.agent.session_id, source='whatsapp')
                    plan = {**self.plan, 'language': language}
                    if question_kind == 'add_on':
                        plan['package_code'] = 'package_surf_week'
                    plan.pop('payment_choice')
                    response = self.checked({**plan, 'payment_choice': 'deposit'})
                    response['payment_choice_needed'] = True
                    self.turn(f'conditional-negative-offer-{question_kind}-{language}', 'Quote stay')
                    self.ledger.record_quote(plan, response)
                    shown = self.ledger.finalize_offer_response(
                        {'completed': True, 'final_response': 'draft'})
                    expected_question = shown['final_response'].rsplit('\n\n', 1)[-1]
                    self.db.close()
                    self.db = SessionDB(Path(self.temp.name) / 'state.db')
                    self.agent._session_db = self.db
                    self.turn(f'conditional-negative-answer-{question_kind}-{language}', conditional)
                    result = self.interpret(conditional, action='reject', negated=True, conditional=True)
                    state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                    self.assertEqual(result['next_action'], 'clarify_condition')
                    self.assertNotEqual(result['next_action'], 'do_not_create')
                    self.assertEqual(result['question'], expected_question)
                    self.assertEqual(state['pending_question']['kind'], question_kind)
                    self.assertNotIn('payment_choice', state['plan'])
                    self.assertNotIn('add_on_decisions', state)

    def test_full_name_final_question_replaces_payment_descriptor_after_reopen(self):
        """A final names prompt cannot retain hidden payment-choice bindings."""
        answers = {'en': 'Yes', 'es': 'Sí', 'it': 'Sì'}
        for language, answer in answers.items():
            with self.subTest(language=language):
                self.agent.session_id = f'full-names-pending-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'language': language, 'payment_choice': 'full'}
                response = self.checked(plan)
                response['offer_revision']['payment_choice'] = 'full'
                response['offer_revision']['guest_bed_assignments'][0]['guest_name'] = ''
                self.turn(f'full-names-offer-{language}', 'Quote stay')
                self.ledger.record_quote(plan, response)
                shown = self.ledger.finalize_offer_response(
                    {'completed': True, 'final_response': 'draft'})
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertEqual(state['pending_question'], {'kind': 'names'})
                self.assertEqual(state['presentation']['question_intent'], {'kind': 'names'})
                self.assertEqual(state['presentation']['payment_choices'], [])
                self.db.close()
                self.db = SessionDB(Path(self.temp.name) / 'state.db')
                self.agent._session_db = self.db
                self.turn(f'full-names-answer-{language}', answer)
                result = self.interpret(answer)
                self.assertEqual(result['next_action'], 'revalidate_selected_terms')
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertEqual(state['pending_question'], {'kind': 'names'})
                self.assertNotIn('payment_choice', state['plan'])

    def test_full_payment_only_final_question_persists_go_ahead_without_payment_options(self):
        for language in ('en', 'es', 'it'):
            with self.subTest(language=language):
                self.agent.session_id = f'full-only-pending-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'language': language, 'guest_count': 1,
                        'guests': [{'name': 'Alex'}], 'selected_bed_codes': ['M1'],
                        'payment_choice': None}
                response = self.checked({**plan, 'payment_choice': 'full'})
                response.update(full_payment_only=True, payment_choice_needed=False,
                                deposit_required_cents=response['total_cents'])
                response['offer_revision'].update(payment_choice='full', full_payment_only=True,
                                                  deposit_required_cents=response['total_cents'])
                self.turn(f'full-only-pending-offer-{language}', 'Quote one bed')
                self.ledger.record_quote(plan, response)
                shown = self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                self.assertEqual(shown['final_response'], 'draft')
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertEqual(state['pending_question'], {'kind': 'go_ahead'})

    def test_clear_save_answer_accepts_once_for_solo_and_split_groups_in_supported_languages(self):
        fixtures = {'en': 'Yes, save it.', 'es': 'Sí, guárdala.',
                    'de': 'Ja, bitte speichern.', 'it': 'Sì, salvala.',
                    'fr': 'Oui, réservez-la.'}
        for language, answer in fixtures.items():
            for count, separate, payment_choice in (
                    (1, False, 'deposit'), (1, False, 'full'),
                    (3, True, 'deposit'), (3, True, 'full')):
                with self.subTest(language=language, count=count, separate=separate,
                                  payment_choice=payment_choice):
                    session = f'one-save-{language}-{count}-{payment_choice}'
                    self.agent.session_id = session
                    self.db.create_session(session, source='whatsapp')
                    names = ['María José', 'José Ángel', 'Zoë'][:count]
                    plan = {
                        **self.plan, 'language': language, 'guest_count': count,
                        'guests': [{'name': name} for name in names],
                        'selected_bed_codes': [f'M{index + 1}' for index in range(count)],
                        'payment_choice': payment_choice,
                        'per_guest_payment_links': separate,
                        'payment_link_distribution': 'separate' if separate else 'together',
                    }
                    beds = [dict(bed_code=f'M{index + 1}', room_code='M',
                                 gender_strategy='mixed') for index in range(count)]
                    response = self.checked(plan, beds)
                    self.turn(f'offer-{language}-{count}', 'Quote this booking')
                    self.ledger.record_quote(plan, response)
                    shown = self.ledger.finalize_offer_response(
                        {'completed': True, 'final_response': 'draft'})
                    self.assertEqual(shown['final_response'], 'draft')
                    state = self.ledger._transaction(
                        lambda current, _ingress: deepcopy(current))
                    self.assertEqual(state['pending_question'], {'kind': 'go_ahead'})
                    self.turn(f'accept-{language}-{count}', answer)
                    accepted = self.ledger.interpret_owner_turn({
                        # Exercise the owner grammar independently of model action
                        # drift: the exact answer to the owned save question wins.
                        'action': 'clarify', 'action_evidence': answer,
                        'ambiguous': False, 'negated': False, 'conditional': False,
                        'material_changes': [], 'completions': {},
                    })
                    self.assertTrue(accepted['accepted'], accepted)
                    self.assertTrue(accepted['create_ready'], accepted)
                    self.assertEqual(accepted['next_action'], 'create_booking')
                    create = self.ledger.prepare_create({})
                    self.assertFalse(create.revalidation)
                    self.assertEqual(create['guest_count'], count)
                    self.assertEqual(create['guests'], plan['guests'])
                    self.assertEqual(create['selected_bed_codes'], plan['selected_bed_codes'])
                    self.assertEqual(create['payment_choice'], payment_choice)
                    self.assertEqual(create['payment_link_distribution'],
                                     'separate' if separate else 'together')
                    self.assertEqual(create.get('per_guest_payment_links', False), separate)
                    self.assertEqual(
                        [row['guest_name'] for row in create['accepted_offer']['guest_bed_assignments']],
                        [name.casefold() for name in names])

    def test_distribution_then_amount_keeps_one_presented_offer_until_single_refresh(self):
        for language, (distribution_text, amount_text) in {
                'en': ('Separately, please', 'Deposit'),
                'es': ('Por separado', 'Depósito'),
                'de': ('Getrennt', 'Anzahlung'),
                'it': ('Separatamente', 'Acconto'),
                'fr': ('Séparément', 'Acompte'),
        }.items():
            with self.subTest(language=language):
                self.agent.session_id = f'distribution-amount-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {
                    **self.plan, 'language': language, 'guest_count': 2,
                    'guests': [{'name': 'María José'}, {'name': 'José Ángel'}],
                    'selected_bed_codes': ['M1', 'M2'],
                }
                plan.pop('payment_choice', None)
                response = self.checked({**plan, 'payment_choice': 'deposit'}, [
                    {'bed_code': 'M1', 'room_code': 'M', 'gender_strategy': 'mixed'},
                    {'bed_code': 'M2', 'room_code': 'M', 'gender_strategy': 'mixed'},
                ])
                response['payment_choice_needed'] = True
                self.turn(f'distribution-offer-{language}', 'Quote this booking')
                self.ledger.record_quote(plan, response)
                self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                before = self.ledger._transaction(lambda state, _ingress: deepcopy(state))

                self.turn(f'distribution-answer-{language}', distribution_text)
                distribution = self.ledger.interpret_owner_turn({
                    'action': 'clarify', 'action_evidence': distribution_text,
                    'ambiguous': False, 'negated': False, 'conditional': False,
                    'material_changes': [], 'completions': {
                        'payment_link_distribution': {
                            'value': 'separate', 'evidence': distribution_text}},
                })
                after_distribution = self.ledger._transaction(
                    lambda state, _ingress: deepcopy(state))
                self.assertEqual(distribution['next_action'], 'ask_payment_choice')
                self.assertEqual(after_distribution['checked_offer'], before['checked_offer'])
                self.assertEqual(after_distribution.get('presented_offer'), before.get('presented_offer'))
                self.assertEqual(after_distribution['presentation'], before['presentation'])
                self.assertEqual(after_distribution['pending_question']['kind'], 'payment_choice')

                self.turn(f'amount-answer-{language}', amount_text)
                amount = self.ledger.interpret_owner_turn({
                    'action': 'clarify', 'action_evidence': amount_text,
                    'ambiguous': False, 'negated': False, 'conditional': False,
                    'material_changes': [], 'completions': {
                        'payment_choice': {'value': 'deposit', 'evidence': amount_text}},
                })
                self.assertEqual(amount['next_action'], 'requote_material_changes')
                revised = self.ledger.prepare_quote({})
                self.assertEqual(revised['payment_link_distribution'], 'separate')
                self.assertEqual(revised['payment_choice'], 'deposit')

    def test_live_payment_question_yes_with_accept_action_cannot_create(self):
        plan = {
            **self.plan, 'language': 'es', 'guest_count': 2,
            'guests': [{'name': 'Álex'}, {'name': 'Zoë'}],
            'selected_bed_codes': ['M1', 'M2'],
            'payment_choice': 'deposit',
        }
        response = self.checked(plan, [
            {'bed_code': 'M1', 'room_code': 'M', 'gender_strategy': 'mixed'},
            {'bed_code': 'M2', 'room_code': 'M', 'gender_strategy': 'mixed'},
        ])
        self.turn('non-save-payment-offer', 'Quote this booking')
        self.ledger.record_quote(plan, response)
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})

        def force_live_payment_question(state, _ingress):
            state['pending_question'] = {
                'kind': 'payment_choice', 'options': ['together', 'separate']}
            state['presentation']['question_kind'] = 'payment_choice'
            state['presentation']['create_ready'] = True
            state['presentation']['displayed_text'] = '¿Un enlace conjunto o enlaces separados?'
            state['presentation']['displayed_text_digest'] = hashlib.sha256(
                state['presentation']['displayed_text'].encode()).hexdigest()
        self.ledger._transaction(force_live_payment_question)
        self.turn('non-save-payment-answer', 'Sí')
        result = self.ledger.interpret_owner_turn({
            'action': 'accept', 'action_evidence': 'Sí',
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [], 'completions': {},
        })
        self.assertFalse(result['accepted'], result)
        self.assertEqual(result['next_action'], 'clarify_pending_question')
        state = self.ledger._transaction(lambda current, _ingress: deepcopy(current))
        self.assertNotEqual(state['status'], 'accepted')

    def test_direct_create_has_no_interpreter_veto(self):
        self.turn('direct-contextual-yes', 'oui')
        prepared = self.ledger.prepare_create({})
        self.assertTrue(prepared.revalidation)
        self.assertEqual(prepared['guests'], self.plan['guests'])
        self.ledger.record_quote(prepared, self.response)
        checked = self.ledger.prepare_create({})
        self.assertTrue(checked['require_offer_identity'])
        self.assertEqual(checked['accepted_offer'], self.response['offer_revision'])

    def test_per_guest_canonical_deposit_survives_revalidation_and_restatement(self):
        """Staff prices split deposits as deposit, without changing guest intent."""
        plan = deepcopy(self.plan)
        plan['payment_choice'] = 'per_guest'
        response = self.checked(plan)
        response['offer_revision'].update(
            payment_choice='deposit', per_guest_payment_links=True,
            payment_link_amount_cents=response['offer_revision']['deposit_required_cents'])
        self.turn('per-guest-offer', 'Quote separate deposit links')
        self.ledger.record_quote(plan, response)
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.assertEqual(
            self.ledger._transaction(lambda state, ingress: state['presentation']['plan']['payment_choice']),
            'per_guest')
        self.assertEqual(
            self.ledger._transaction(lambda state, ingress: state['presentation']['payment_choices']),
            ['per_guest'])

        self.turn('per-guest-create', 'Create it with separate deposit links')
        refresh = self.ledger.prepare_create({'payment_choice': 'per_guest'})
        self.assertTrue(refresh.revalidation)
        self.assertEqual(refresh['payment_choice'], 'per_guest')
        self.ledger.record_quote(refresh, response)

        created = self.ledger.prepare_create({'payment_choice': 'per_guest'})
        self.assertEqual(created['payment_choice'], 'per_guest')

    def test_missing_choice_split_completion_clears_revalidation_before_create(self):
        """A canonical deposit revision is the validated completion of split intent."""
        self.agent.session_id = 'missing-choice-split-completion'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = deepcopy(self.plan)
        plan['payment_choice'] = None
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
        preview = FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), {**plan, 'payment_choice': 'deposit'}, beds)
        initial = {
            'success': True, 'total_cents': 20000, 'deposit_required_cents': 10000,
            'remaining_after_deposit_cents': 10000, 'currency': 'EUR',
            'payment_choice_needed': True, 'offer_revision': deepcopy(preview['offer_revision']),
            'availability': deepcopy(preview['availability']),
        }
        self.turn('missing-choice-offer', 'Quote us')
        self.ledger.record_quote(plan, initial)
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        state = self.ledger._transaction(lambda owner, _ingress: deepcopy(owner))
        self.assertTrue(state['quote']['payment_choice_needed'], state)
        self.assertEqual(state['presentation']['payment_choices'],
                         ['deposit', 'per_guest', 'full'])

        raw = 'We will pay per_guest'
        self.turn('choose-split', raw)
        accepted = self.interpret(raw, completions={
            'payment_choice': {'value': 'per_guest', 'evidence': 'per_guest'}})
        self.assertTrue(accepted['accepted'])
        self.assertFalse(accepted['create_ready'])
        revalidation = self.ledger.prepare_quote({})
        self.assertEqual(revalidation['payment_choice'], 'per_guest')
        completed = self.checked(revalidation)
        completed['offer_revision'].update(
            payment_choice='deposit', per_guest_payment_links=True,
            payment_link_amount_cents=completed['offer_revision']['deposit_required_cents'])
        self.ledger.record_quote(revalidation, completed)

        state = self.ledger._transaction(lambda owner, _ingress: deepcopy(owner))
        self.assertNotIn('pending_payment_completion', state)
        self.assertFalse(self.ledger.prepare_create({}).revalidation)
        created = self.ledger.prepare_create({})
        self.assertEqual(created['payment_choice'], 'per_guest')
        self.assertEqual(created['accepted_offer'], completed['offer_revision'])

    def test_completion_normalizes_split_distribution_tuples_without_losing_amount_mapping(self):
        """Owner-stored split tuples and Staff dicts compare by person and cents."""
        prior = deepcopy(self.response['offer_revision'])
        prior.update(payment_choice='deposit', per_guest_payment_links=True,
                     payment_distribution=[
                         (0, 'alex', 10000, 'EUR'), (1, 'sam', 10000, 'EUR')])
        current = deepcopy(prior)
        current['payment_distribution'] = [
            {'guest_name': 'Alex', 'amount_due_cents': 10000, 'currency': 'EUR'},
            {'guest_name': 'Sam', 'amount_due_cents': 10000, 'currency': 'EUR'}]
        self.assertTrue(self.ledger._completion_revision_matches(
            prior, current, payment_choice='per_guest'))
        current['payment_distribution'][0]['amount_due_cents'] = 10001
        current['payment_distribution'][1]['amount_due_cents'] = 9999
        self.assertFalse(self.ledger._completion_revision_matches(
            prior, current, payment_choice='per_guest'))

    def test_completion_normalizes_payment_distribution_for_localized_split_and_names(self):
        """EN/ES split choice and an indexed surname completion preserve the offer."""
        for language in ('en', 'es'):
            for payment_choice, separate in (('deposit', False), ('per_guest', True)):
                with self.subTest(language=language, payment_choice=payment_choice):
                    prior = deepcopy(self.response['offer_revision'])
                    prior.update(payment_choice='deposit',
                                 per_guest_payment_links=separate,
                                 payment_distribution=[
                                     (0, 'alex', 10000, 'EUR'), (1, 'sam', 10000, 'EUR')])
                    current = deepcopy(prior)
                    current['payment_distribution'] = [
                        {'guest_name': 'Alex', 'amount_due_cents': 10000, 'currency': 'EUR'},
                        {'guest_name': 'Sam', 'amount_due_cents': 10000, 'currency': 'EUR'}]
                    self.assertTrue(self.ledger._completion_revision_matches(
                        prior, current, payment_choice=payment_choice))
                    current['payment_distribution'][0]['amount_due_cents'] = 10001
                    current['payment_distribution'][1]['amount_due_cents'] = 9999
                    self.assertFalse(self.ledger._completion_revision_matches(
                        prior, current, payment_choice=payment_choice))

                    # The same indexed guest may complete a surname; Staff updates
                    # that payer label but not the person, bed, or amount.
                    current = deepcopy(prior)
                    current['guest_bed_assignments'][0]['guest_name'] = 'Alex Smith'
                    current['payment_distribution'] = [
                        {'guest_name': 'Alex Smith', 'amount_due_cents': 10000, 'currency': 'EUR'},
                        {'guest_name': 'Sam', 'amount_due_cents': 10000, 'currency': 'EUR'}]
                    self.assertTrue(self.ledger._completion_revision_matches(
                        prior, current, payment_choice=payment_choice,
                        guest_completions=[{'guest_index': 0, 'completed_name': 'Alex Smith'}]))

    def test_split_distribution_change_requires_new_presentation_before_create(self):
        """Same-total per-person changes are material on both split refresh routes."""
        for route in ('newly-selected', 'explicit-refresh'):
            with self.subTest(route=route):
                self.agent.session_id = f'split-distribution-{route}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'payment_choice': 'per_guest'}
                response = self.checked(plan)
                response['offer_revision'].update(
                    payment_choice='deposit', per_guest_payment_links=True,
                    payment_distribution=[
                        {'guest_name': 'Alex', 'amount_due_cents': 20000, 'currency': 'EUR'},
                        {'guest_name': 'Sam', 'amount_due_cents': 20000, 'currency': 'EUR'},
                    ])
                response['offer_revision']['total_cents'] = 40000
                response['total_cents'] = 40000
                if route == 'newly-selected':
                    plan['payment_choice'] = None
                    response['payment_choice_needed'] = True
                self.turn(f'split-distribution-offer-{route}', 'Quote split deposits')
                self.ledger.record_quote(plan, response)
                self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                if route == 'newly-selected':
                    raw = 'per_guest'
                    self.turn(f'split-distribution-pick-{route}', raw)
                    self.interpret(raw, completions={
                        'payment_choice': {'value': 'per_guest', 'evidence': 'per_guest'}})
                    refresh = self.ledger.prepare_quote({})
                else:
                    self.turn(f'split-distribution-create-{route}', 'Create separate links')
                    refresh = self.ledger.prepare_create({'payment_choice': 'per_guest'})
                changed = deepcopy(response)
                changed['offer_revision']['payment_distribution'][0]['amount_due_cents'] = 20001
                changed['offer_revision']['payment_distribution'][1]['amount_due_cents'] = 19999
                self.ledger.record_quote(refresh, changed)
                state = self.ledger._transaction(lambda owner, _ingress: deepcopy(owner))
                self.assertNotEqual(state.get('accepted_offer'), changed['offer_revision'])
                with self.assertRaises(self.ledger.QuoteBoundaryError):
                    self.ledger.prepare_create({})

    def test_group_payment_finalizer_uses_split_choice_and_keeps_shuttle_before_payment(self):
        """The real Python finalizer owns group choice and package shuttle order."""
        for language, raw, expected in (
            ('en', 'Please quote for both of us',
             'Would you like to pay together (one person pays the deposit for everyone) or separately (each person gets their own deposit link)?'),
            ('es', 'Quiero reservar para los dos',
             '¿Preferís pagar juntos (una persona paga el depósito de todos) o por separado (cada uno recibe su propio enlace de depósito)?'),
        ):
            with self.subTest(language=language):
                self.agent.session_id = f'group-choice-finalizer-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'language': language}
                plan.pop('payment_choice')
                response = self.checked({**plan, 'payment_choice': 'deposit'})
                response['payment_choice_needed'] = True
                self.turn(f'group-choice-{language}', raw)
                self.ledger.record_quote(plan, response)
                shown = self.ledger.finalize_offer_response(
                    {'completed': True, 'final_response': 'model draft', 'messages': []})
                self.assertEqual(shown['final_response'], 'model draft')
                state = self.ledger._transaction(lambda value, _ingress: deepcopy(value))
                self.assertEqual(state['pending_question']['kind'], 'payment_choice')

        self.agent.session_id = 'package-shuttle-before-payment'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = {**self.plan, 'package_code': 'package_surf_week'}
        plan.pop('payment_choice')
        response = self.checked({**plan, 'payment_choice': 'deposit'})
        response['payment_choice_needed'] = True
        self.turn('package-shuttle', 'Quote the surf package')
        self.ledger.record_quote(plan, response)
        shown = self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'model draft', 'messages': []})
        self.assertEqual(shown['final_response'], 'model draft')
        state = self.ledger._transaction(lambda value, _ingress: deepcopy(value))
        self.assertEqual(state['pending_question']['kind'], 'add_on')

        for language, expected in (
            ('en', 'Would you like to pay together'),
            ('es', '¿Preferís pagar juntos'),
        ):
            with self.subTest(shuttle_resolved=language):
                resolved = {**plan, 'language': language, 'shuttle_needed': False}
                text = self.ledger._styled_quote_copy(
                    resolved, response['offer_revision'], language, create_ready=False)
                self.assertIn(expected, text)
                self.assertNotIn('airport shuttle', text)
                self.assertNotIn('traslado desde el aeropuerto', text)

        per_person = {**self.plan, 'package_code': 'package_none',
                      'guest_packages': [{'guest_index': 0, 'package_code': 'surf_week'}]}
        per_person.pop('payment_choice')
        per_person_response = self.checked({**per_person, 'payment_choice': 'deposit'})
        per_person_text = self.ledger._styled_quote_copy(
            per_person, per_person_response['offer_revision'], 'en', create_ready=False)
        self.assertIn('airport transfer', per_person_text)
        self.assertNotIn('Would you like to pay together', per_person_text)

    def test_finalizer_keeps_solo_and_full_only_exceptions(self):
        self.agent.session_id = 'solo-payment-finalizer'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        solo = {**self.plan, 'guest_count': 1, 'guests': [{'name': 'Alex'}],
                'selected_bed_codes': ['M1']}
        solo.pop('payment_choice')
        response = self.checked({**solo, 'payment_choice': 'deposit'})
        response['payment_choice_needed'] = True
        self.turn('solo-payment', 'Quote one bed')
        self.ledger.record_quote(solo, response)
        shown = self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'model draft', 'messages': []})
        self.assertEqual(shown['final_response'], 'model draft')
        self.assertEqual(self.ledger._transaction(
            lambda value, _ingress: value['pending_question']['kind']), 'payment_choice')

        self.agent.session_id = 'full-only-finalizer'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        full_only = {**solo, 'payment_choice': None}
        response = self.checked({**full_only, 'payment_choice': 'full'})
        response.update(full_payment_only=True, payment_choice_needed=False,
                        deposit_required_cents=response['total_cents'])
        response['offer_revision'].update(payment_choice='full',
                                          deposit_required_cents=response['total_cents'],
                                          payment_link_amount_cents=response['total_cents'],
                                          full_payment_only=True)
        self.turn('full-only', 'Quote one bed')
        self.ledger.record_quote(full_only, response)
        shown = self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'model draft', 'messages': []})
        self.assertEqual(shown['final_response'], 'model draft')
        self.assertEqual(self.ledger._transaction(
            lambda value, _ingress: value['pending_question']['kind']), 'go_ahead')

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

    def test_checked_internal_pricing_fields_never_reach_guest_presentation(self):
        plan = {**self.plan, 'payment_choice': 'pay_on_arrival'}
        response = self.checked(plan)
        response['offer_revision'].update(
            payment_link_amount_cents=0, staff_review_required=True,
            stay_deposit_rates={'short_stay_cents': 12500, 'long_stay_cents': 24500})
        self.turn('staff-pricing-transport', 'Please check this stay')
        self.ledger.record_quote(plan, response)
        before = self.ledger._transaction(lambda state, ingress: deepcopy(state['checked_offer']))
        text = self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft', 'messages': []})['final_response']
        self.assertEqual(text, 'draft')
        facts = self.ledger._transaction(
            lambda state, ingress: deepcopy(state['quote']['quote_authoring_facts']))
        self.assertEqual(facts['total_cents'], 20000)
        self.assertEqual(facts['amount_due_now_cents'], 0)
        for forbidden in ('€125', '€245', 'Staff Pricing', 'staff review', 'capped'):
            self.assertNotIn(forbidden, text)
        self.assertNotIn('Due on arrival:', text)
        after = self.ledger._transaction(lambda state, ingress: deepcopy(state['checked_offer']))
        self.assertEqual(before, after)

    def test_successful_create_then_extra_handoff_keeps_real_owner_receipt(self):
        self.accept()
        prepared = self.ledger.prepare_create({})
        receipt = {'success': True, 'booking_id': 'TEST-BOOKING',
                   'booking_code': 'TEST-RECEIPT', 'amount_due_cents': 10000,
                   'secure_payment_url': 'https://payments.invalid/test-receipt'}
        self.ledger.dispatch_create(prepared, lambda: deepcopy(receipt))
        handoff = {'tool': 'flag_needs_human', 'success': True,
                   'needs_human': True, 'handoff_persisted': True}
        confirmation = ('Alex and Sam — TEST-RECEIPT, 2026-11-01 to 2026-11-08, '
                        'shared beds M1 and M2, total €200, deposit €100, due now €100, '
                        'remaining balance €100, '
                        'https://payments.invalid/test-receipt. I handed it to the team.')
        result = {'completed': True, 'final_response': confirmation,
                  'messages': [{'role': 'user', 'content': 'Yes please'},
                      {'role': 'tool', 'content': json.dumps({**receipt, 'tool': 'create_booking_from_plan'})},
                      {'role': 'tool', 'content': json.dumps(handoff)},
                      {'role': 'assistant', 'content': confirmation}]}
        text = self.ledger.finalize_offer_response(result)['final_response']
        self.assertEqual(text, confirmation)
        self.turn('pure-handoff-next-turn', 'Can the team check the extra?')
        pure = self.ledger.finalize_offer_response({'completed': True, 'final_response': None,
            'messages': [{'role': 'user', 'content': 'Can the team check the extra?'},
                         {'role': 'tool', 'content': json.dumps(handoff)}]})['final_response']
        self.assertIsNone(pure)

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
        self.assertEqual(shown['final_response'], 'draft')
        facts = self.ledger._transaction(
            lambda state, ingress: deepcopy(state['quote']['quote_authoring_facts']))
        self.assertEqual((facts['total_cents'], facts['amount_due_now_cents']), (20000, 0))
        self.assertNotIn('Staff Pricing', shown['final_response'])
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
        expected_due = {'deposit': '€100', 'pay_on_arrival': '€200'}
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
                self.assertEqual(text, 'draft')
                facts = self.ledger._transaction(
                    lambda state, ingress: deepcopy(state['quote']['quote_authoring_facts']))
                expected = 20000 if choice == 'full' else 0 if choice == 'pay_on_arrival' else 10000
                self.assertEqual((facts['total_cents'], facts['amount_due_now_cents']),
                                 (20000, expected))

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

    def _present_three_guest_quote_with_two_anonymous_guests(self, session_id):
        self.agent.session_id = session_id
        self.db.create_session(session_id, source='whatsapp')
        anonymous_guests = [{'name': 'Aisha'}, {'name': ''}, {'name': ''}]
        plan = {
            **self.plan,
            'guest_count': 3,
            'guests': [{'name': 'Aisha'}, {'name': 'Guest Two'}, {'name': 'Guest Three'}],
            'selected_bed_codes': ['M1', 'M2', 'M3'],
        }
        beds = [dict(bed_code=code, room_code='M', gender_strategy='mixed')
                for code in plan['selected_bed_codes']]
        self.turn(f'{session_id}-offer', 'Quote this please')
        self.ledger.record_quote(plan, self.checked(plan, beds))
        self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.ledger._transaction(lambda state, _ingress: (
            state['plan'].update(guests=deepcopy(anonymous_guests)),
            state['presentation']['plan'].update(guests=deepcopy(anonymous_guests)),
        ))

    def test_conditional_accept_with_partial_name_completion_clarifies_condition(self):
        self._present_three_guest_quote_with_two_anonymous_guests('conditional-partial-name')
        raw = 'I accept if breakfast is included. I am Aisha Rahman.'
        self.turn('conditional-partial-name-accept', raw)
        result = self.interpret(
            raw,
            conditional=True,
            completions={'guests': [{
                'guest_index': 0, 'name': 'Aisha Rahman', 'evidence': 'Aisha Rahman'}]},
        )
        self.assertEqual(result['next_action'], 'clarify_condition')
        self.assertNotIn('name', result.get('question', '').casefold())

    def test_accept_with_checkout_change_and_partial_name_completion_requotes(self):
        self._present_three_guest_quote_with_two_anonymous_guests('checkout-change-partial-name')
        raw = 'I accept, but change checkout to 2026-11-09. I am Aisha Rahman.'
        self.turn('checkout-change-partial-name-accept', raw)
        result = self.interpret(
            raw,
            action='accept',
            material_changes=[{
                'field': 'check_out', 'value': '2026-11-09',
                'evidence': 'checkout to 2026-11-09'}],
            completions={'guests': [{
                'guest_index': 0, 'name': 'Aisha Rahman', 'evidence': 'Aisha Rahman'}]},
        )
        self.assertEqual(result['next_action'], 'requote_material_changes')
        self.assertFalse(result['question_required'])

    def test_unconditional_accept_with_partial_name_completion_requires_full_roster(self):
        self._present_three_guest_quote_with_two_anonymous_guests('accept-partial-name')
        raw = 'I accept. I am Aisha Rahman.'
        self.turn('accept-partial-name-accept', raw)
        with self.assertRaisesRegex(
                self.ledger.QuoteBoundaryError, 'quote_completion_identity_changed'):
            self.interpret(
                raw,
                action='accept',
                completions={'guests': [{
                    'guest_index': 0, 'name': 'Aisha Rahman', 'evidence': 'Aisha Rahman'}]},
            )

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
        rewrites = []
        invalid = self.ledger.finalize_offer_response({
            'completed': True, 'final_response': 'Total 201 EUR; due now 100 EUR.',
            'messages': [{'role': 'assistant', 'content': 'Total 201 EUR; due now 100 EUR.'}],
        }, rewrite_callback=lambda facts, draft: (
            rewrites.append((deepcopy(facts), draft)) or 'Still wrong: total 999 EUR; due now 100 EUR.'))
        self.assertEqual(len(rewrites), 1)
        self.assertIsNone(invalid['final_response'])
        self.assertIsNone(invalid['messages'][-1]['content'])
        rewrites.clear()
        shown = self.ledger.finalize_offer_response({
            'completed': True,
            'final_response': 'Total: 201.00 EUR. Deposit: 100.00 EUR. Would you like deposit or full?',
            'messages': [{'role': 'assistant', 'id': 'reply-incomplete',
                          'content': 'Total: 201.00 EUR. Deposit: 100.00 EUR. Would you like deposit or full?'}],
        }, rewrite_callback=lambda facts, draft: (
            rewrites.append((deepcopy(facts), draft)) or 'Natural recap: total 200 EUR; due now 100 EUR.'))
        self.assertEqual(len(rewrites), 1)
        self.assertEqual(shown['final_response'], 'Natural recap: total 200 EUR; due now 100 EUR.')
        self.assertEqual(self.ledger._transaction(
            lambda state, ingress: state['pending_question']['kind']), 'payment_choice')
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
                    self.assertEqual(shown['final_response'], 'model draft')
                    authoring = self.ledger._transaction(
                        lambda state, _ingress: deepcopy(state))
                    self.assertEqual(authoring['pending_question']['kind'],
                                     'payment_choice')
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

    def test_availability_preserves_evidenced_name_and_retires_stale_regrowth(self):
        self.agent.session_id = 'roster-authority-regression'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('roster-start', 'Emma Clarke and Liam Green need rooms.')
        initial = {**self.plan, 'guest_count': 2,
                   'guests': [{'name': 'Emma Clarke'}, {'name': 'Liam Green'}]}
        self.ledger._transaction(lambda state, ingress: state.update(
            plan=deepcopy(initial), completion_plan={}))

        # A stale/short availability name cannot replace owner identity.
        self.ledger.record_availability_context({**initial,
            'guests': [{'name': 'Emma'}, {'name': 'Liam'}]})
        current = self.ledger._transaction(lambda state, ingress: deepcopy(state))
        self.assertEqual([row['name'] for row in current['plan']['guests']],
                         ['Emma Clarke', 'Liam Green'])

        # Shrink retires slot 1. A stale roster on later growth cannot revive it.
        self.ledger.record_availability_context({**initial, 'guest_count': 1,
            'guests': [{'name': 'Emma'}]})
        self.ledger.record_availability_context({**initial, 'guest_count': 2,
            'guests': [{'name': 'Emma'}, {'name': 'Liam Green'}]})
        current = self.ledger._transaction(lambda state, ingress: deepcopy(state))
        self.assertEqual(current['plan']['guests'][0]['name'], 'Emma Clarke')
        self.assertNotIn('name', current['plan']['guests'][1])
        self.assertEqual(current['retired_guest_indices'], [1])

    def test_owner_completion_can_reassign_retired_roster_slot(self):
        self.agent.session_id = 'roster-retired-owner-reassign'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('roster-reassign', 'A new second guest is Nora Jones.')
        base = {**self.plan, 'guest_count': 2,
                'guests': [{'name': 'Emma Clarke'}, {}]}
        self.ledger._transaction(lambda state, ingress: state.update(
            plan=deepcopy(base), retired_guest_indices=[1],
            completion_plan={'guests': [{}, {'name': 'Nora Jones'}]}))
        self.ledger.record_availability_context({**base,
            'guests': [{'name': 'Emma'}, {'name': 'stale Liam'}]})
        current = self.ledger._transaction(lambda state, ingress: deepcopy(state))
        self.assertEqual(current['plan']['guests'][1]['name'], 'Nora Jones')
        self.assertEqual(current['retired_guest_indices'], [])

    def test_payment_completion_rejects_partial_booking_identity_mismatch(self):
        self.agent.session_id = 'payment-binding-regression'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('payment-binding', 'Send the payment link.')
        receipt = {'success': True, 'booking_id': 'booking-1',
                   'booking_code': 'WH-ONE', 'payment_id': 'payment-1'}
        self.ledger._transaction(lambda state, ingress: state.update(
            receipt=deepcopy(receipt), completion=deepcopy(receipt)))
        self.ledger.record_payment_completion({
            'success': True, 'tool': 'create_payment_link',
            'booking_id': 'booking-1', 'booking_code': 'WH-OTHER',
            'payment_id': 'payment-1', 'secure_payment_url': 'https://payments.invalid/wrong'})
        current = self.ledger._transaction(lambda state, ingress: deepcopy(state))
        self.assertNotIn('secure_payment_url', current['completion'])

    def test_person_payment_completion_binds_booking_and_guest_id(self):
        self.agent.session_id = 'person-payment-binding-regression'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('person-payment-binding', 'Send Emma her payment link.')
        receipt = {'success': True, 'booking_id': 'booking-1',
                   'booking_code': 'WH-ONE',
                   'booking_guests': [
                       {'booking_guest_id': 'guest-lucia', 'guest_name': 'Lucía'},
                       {'booking_guest_id': 'guest-emma', 'guest_name': 'Emma'}]}
        self.ledger._transaction(lambda state, ingress: state.update(
            receipt=deepcopy(receipt), completion=deepcopy(receipt)))
        self.ledger.record_payment_completion({
            'success': True, 'tool': 'create_guest_payment_link',
            'booking_id': 'booking-1', 'booking_code': 'WH-ONE',
            'booking_guest_id': 'guest-emma', 'guest_name': 'Emma',
            'amount_due_cents': 10000, 'currency': 'EUR',
            'secure_payment_url': 'https://payments.invalid/emma'})
        current = self.ledger._transaction(lambda state, ingress: deepcopy(state))
        links = current['completion']['guest_payment_links']
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0]['booking_guest_id'], 'guest-emma')
        self.assertEqual(links[0]['secure_payment_url'], 'https://payments.invalid/emma')

    def test_booking_confirmation_preserves_model_words_only_when_all_saved_facts_present(self):
        facts = {
            'reference': 'WH-1644', 'guest_names': ['Anna Smith'],
            'check_in': '2026-11-01', 'check_out': '2026-11-05',
            'room': ['M1'], 'total_cents': 50000, 'deposit_cents': 10000,
            'payment_links': ['https://pay.invalid/WH-1644'],
        }
        draft = ('Booked {ref} for {guest_names}, {check_in} to {check_out}, '
                 'room {room}, total {total}, deposit {deposit}.\n{payment_link}')
        self.assertTrue(self.ledger._confirmation_has_all_facts(draft, facts))
        filled = self.ledger._fill_confirmation_slots(draft, facts)
        self.assertIn('WH-1644', filled)
        self.assertIn('Anna Smith', filled)
        self.assertNotIn('{guest_names}', filled)
        self.assertFalse(self.ledger._confirmation_has_all_facts(
            draft.replace('{guest_names}', 'Gast'), facts))

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

    def test_cross_version_assignment_identity_ignores_derived_key_and_display_case(self):
        before = self.checked(self.plan)['offer_revision']
        after = deepcopy(before)
        row = after['guest_bed_assignments'][0]
        row['guest_name_key'] = row['guest_name'].casefold()
        row['guest_name'] = 'alex'
        self.assertTrue(self.ledger._completion_revision_matches(before, after))
        legacy = deepcopy(after)
        legacy['guest_bed_assignments'][0].pop('guest_name_key')
        self.assertTrue(self.ledger._completion_revision_matches(after, legacy))

        different = deepcopy(after)
        different['guest_bed_assignments'][0]['guest_name_key'] = 'bea'
        self.assertFalse(self.ledger._completion_revision_matches(before, different))
        moved = deepcopy(after)
        moved['guest_bed_assignments'][0]['bed_code'] = 'OTHER-BED'
        self.assertFalse(self.ledger._completion_revision_matches(before, moved))

    def test_checked_plan_preserves_display_and_person_bound_facts_across_versions(self):
        plan = {**self.plan, 'guests': [
            {'name': 'Inès', 'explicit_gender': 'female'}, {'name': 'Sam'}],
            'room_name_hints': [{'name': 'Inès', 'explicit_gender': 'female'}]}
        response = self.checked(self.plan)
        assignment = response['offer_revision']['guest_bed_assignments'][0]
        assignment['guest_name'] = 'inès'
        assignment['guest_name_key'] = 'inès'
        checked = self.ledger._checked_plan(plan, response, 'wolfhouse-somo')
        self.assertEqual(checked['guests'], plan['guests'])
        self.assertEqual(checked['room_name_hints'], plan['room_name_hints'])

        changed_person = deepcopy(response)
        changed_person['offer_revision']['guest_bed_assignments'][0].update(
            guest_name='Bea', guest_name_key='bea')
        self.assertIsNone(self.ledger._checked_plan(
            plan, changed_person, 'wolfhouse-somo'))

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
        self.assertEqual(rendered['final_response'], 'I could not verify that. Please ask again.')

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
        self.assertEqual(shown['final_response'], 'as proposed')
        facts = self.ledger._transaction(
            lambda state, ingress: deepcopy(state['quote']['quote_authoring_facts']))
        self.assertEqual(facts['total_cents'], response['total_cents'])
        self.assertNotIn('R4', shown['final_response'])
        self.assertNotIn('R5', shown['final_response'])
        self.assertNotIn('B1', shown['final_response'])

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
        self.assertEqual(shown['final_response'], 'as proposed')
        facts = self.ledger._transaction(
            lambda state, ingress: deepcopy(state['quote']['quote_authoring_facts']))
        self.assertEqual(facts['total_cents'], response['total_cents'])
        self.assertNotIn(': beds', shown['final_response'])
        self.assertNotIn('R4', shown['final_response'])
        self.assertNotIn('R5', shown['final_response'])

    def test_structured_eligibility_replaces_untrusted_producer_prose(self):
        self.turn('sim19-women-eligibility', "I'd like the women's dorm")
        question = 'Are both guests women?'
        self.ledger.record_quote(self.plan, {
            'success': False,
            'quote_status': 'needs_guest_clarification',
            'guest_safe_next_action': question,
            'room_eligibility': {'status': 'unsure', 'requested_room_preference': 'female_only',
                                 'affected_guest_indices': [0, 1],
                                 'reason_code': 'room_eligibility_unknown',
                                 'question_kind': 'confirm_room_eligibility'},
            'offer_revision': None,
        })
        shown = self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft', 'messages': []})
        self.assertEqual('Just to confirm, are Alex and Sam women?',
                         shown['final_response'])

    def test_sim19_spanish_eligibility_question_keeps_meaning_in_spanish(self):
        self.agent.session_id = 'sim19-spanish-eligibility'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('sim19-spanish-eligibility-turn',
                  'Hola, quiero reservar dos camas en la habitación femenina')
        self.ledger.record_quote(self.plan, {
            'success': False,
            'quote_status': 'needs_guest_clarification',
            'guest_safe_next_action': 'Are both guests women?',
            'room_eligibility': {'status': 'unsure', 'requested_room_preference': 'female_only',
                                 'affected_guest_indices': [0, 1],
                                 'reason_code': 'room_eligibility_unknown',
                                 'question_kind': 'confirm_room_eligibility'},
            'offer_revision': None,
        })
        shown = self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft', 'messages': []})
        self.assertEqual(
            'Solo para confirmar, ¿Alex y Sam son mujeres?',
            shown['final_response'])

    def test_sim19_multilingual_eligibility_questions_remain_supported(self):
        cases = (
            ('en', 'Are both guests girls?',
             'Just to confirm, are Alex and Sam men?'),
            ('es', '¿Sois dos chicos?',
             'Solo para confirmar, ¿Alex y Sam son hombres?'),
            ('de', 'Seid ihr beide Jungs?',
             'Nur zur Bestätigung: Sind Alex und Sam Männer?'),
        )
        for language, question, expected in cases:
            with self.subTest(language=language):
                self.agent.session_id = f'sim19-eligibility-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn(f'sim19-eligibility-{language}-turn', question)
                self.ledger.record_quote({**self.plan, 'language': language}, {
                    'success': False,
                    'quote_status': 'needs_guest_clarification',
                    'guest_safe_next_action': question,
                    'room_eligibility': {'status': 'unsure', 'requested_room_preference': 'male_only',
                                         'affected_guest_indices': [0, 1],
                                         'reason_code': 'room_eligibility_unknown',
                                         'question_kind': 'confirm_room_eligibility'},
                    'offer_revision': None,
                })
                shown = self.ledger.finalize_offer_response(
                    {'completed': True, 'final_response': 'draft', 'messages': []})
                self.assertEqual(expected, shown['final_response'])

    def test_same_turn_newer_unavailable_quote_wins_over_older_eligibility_receipt(self):
        guest_turns = {
            'en': 'Do you have those beds?',
            'es': '¿Tenéis esas camas?',
            'fr': 'Avez-vous ces lits ?',
            'de': 'Habt ihr diese Betten?',
        }
        for language, guest_turn in guest_turns.items():
            for status in ('unsure', 'no'):
                with self.subTest(language=language, status=status):
                    self.agent.session_id = f'same-turn-no-stock-{language}-{status}'
                    self.db.create_session(self.agent.session_id, source='whatsapp')
                    self.turn(f'same-turn-no-stock-{language}-{status}', guest_turn)
                    eligibility = {
                        'status': status,
                        'requested_room_preference': 'female_only',
                        'affected_guest_indices': [0, 1],
                        'reason_code': ('room_eligibility_unknown' if status == 'unsure'
                                        else 'room_eligibility_incompatible'),
                        'question_kind': 'confirm_room_eligibility',
                    }
                    unavailable = {
                        'success': False,
                        'unavailable': True,
                        'availability_status': 'unavailable',
                        'quote_status': 'needs_guest_clarification',
                        'room_eligibility': eligibility,
                        'offer_revision': None,
                    }
                    self.ledger.record_quote({**self.plan, 'language': language}, unavailable)
                    messages = [
                        {'role': 'user', 'content': guest_turn},
                        {'role': 'tool', 'content': json.dumps({
                            'success': False,
                            'availability_status': 'eligibility_required',
                            'next_action': 'ask_room_eligibility',
                            'room_eligibility': eligibility,
                        })},
                        {'role': 'tool', 'content': json.dumps(unavailable)},
                        {'role': 'assistant', 'content': 'draft'},
                    ]
                    shown = self.ledger.finalize_offer_response({
                        'completed': True,
                        'final_response': 'draft',
                        'messages': messages,
                    })
                    self.assertEqual('draft', shown['final_response'])
                    self.assertEqual('offer_unavailable', shown['response_intent']['kind'])
                    self.assertEqual('draft', shown['messages'][-1]['content'])

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
        self.assertEqual(shown['final_response'], 'draft')
        state = self.ledger._transaction(lambda value, ingress: deepcopy(value))
        self.assertEqual(state['pending_question']['kind'], 'payment_choice')
        self.assertEqual(state['quote']['quote_authoring_facts']['language'], 'es')

        self.agent.session_id = 'sim19-spanish-refusal'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('sim19-es-refusal', 'Quiero esa habitación')
        refusal = {'success': False, 'quote_status': 'needs_guest_clarification',
                   'guest_safe_next_action': '', 'offer_revision': None}
        self.ledger.record_quote(self.plan, refusal)
        blocked = self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft', 'messages': []})
        self.assertEqual('draft', blocked['final_response'])
        self.assertEqual('offer_unavailable', blocked['response_intent']['kind'])

    def test_sim19_complete_incomplete_and_refusal_are_fully_localized(self):
        cases = {
            'en': ('Please book this room', 'Accommodation only', 'Would you like to pay together', 'Availability checked', 'I could not verify'),
            'es': ('Quiero reservar esta habitación', 'Solo alojamiento', '¿Preferís pagar juntos', 'Disponibilidad comprobada', 'confirmar disponibilidad'),
            'fr': ('Bonjour, je voudrais réserver cette chambre', 'Hébergement seul', 'Souhaitez-vous payer ensemble', 'Disponibilité vérifiée', 'confirmer de place'),
            'de': ('Hallo, ich möchte dieses Zimmer buchen', 'Nur Unterkunft', 'Möchtet ihr zusammen bezahlen', 'Verfügbarkeit geprüft', 'Ich konnte noch kein geeignetes Bett'),
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
                self.assertNotIn('package_none', text)
                self.assertNotIn('None', text)
                self.assertNotIn(availability, text)
                facts = self.ledger._transaction(
                    lambda state, ingress: deepcopy(state['quote']['quote_authoring_facts']))
                self.assertEqual(facts['total_cents'], 20000)
                self.assertEqual(facts['language'], language)
                self.assertEqual(text, 'as proposed')
                self.assertNotRegex(text, r'\b(?:M|R\d+)(?:-B\d+)?\b')

                self.agent.session_id = f'sim19-{language}-incomplete'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn(f'sim19-{language}-incomplete-turn', raw)
                incomplete = self.checked(plan)
                incomplete['payment_choice_needed'] = True
                incomplete_plan = {**plan, 'payment_choice': None}
                self.ledger.record_quote(incomplete_plan, incomplete)
                text = self.ledger.finalize_offer_response({'completed': True, 'final_response': 'draft', 'messages': []})['final_response']
                facts = self.ledger._transaction(
                    lambda state, ingress: deepcopy(state['quote']['quote_authoring_facts']))
                self.assertEqual(facts['total_cents'], 20000)
                self.assertEqual(facts['language'], language)
                self.assertEqual(text, 'draft')
                state = self.ledger._transaction(lambda value, ingress: deepcopy(value))
                self.assertEqual(state['pending_question']['kind'], 'payment_choice')
                self.assertNotIn('Payment options', text)

                self.agent.session_id = f'sim19-{language}-refusal'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn(f'sim19-{language}-refusal-turn', raw)
                self.ledger.record_quote(plan, {'success': False, 'quote_status': 'needs_guest_clarification',
                    'guest_safe_next_action': 'English Staff copy must not leak.', 'offer_revision': None})
                blocked = self.ledger.finalize_offer_response(
                    {'completed': True, 'final_response': 'draft', 'messages': []})
                self.assertEqual('draft', blocked['final_response'])
                self.assertEqual('offer_unavailable', blocked['response_intent']['kind'])
                self.assertNotIn('English Staff copy', blocked['final_response'])

    def test_guest_language_switch_is_observed_and_model_carry_cannot_overwrite_it(self):
        from wolfhouse.output_guard import _guest_lang_from_history

        switches = {
            'de': 'Kannst du Deutsch sprechen?',
            'it': 'Possiamo parlare italiano?',
            'es': '¿Puedes hablar español?',
            'fr': 'Pouvez-vous parler français ?',
        }
        continuations = {
            'de': ('Ja bitte', 'Getrennte Links bitte', 'Alles klar'),
            'it': ('Sì, grazie',),
            'es': ('Sí, gracias',),
            'fr': ('Oui, merci',),
        }
        for language, switch in switches.items():
            with self.subTest(language=language):
                history = [{'role': 'user', 'content': switch}]
                self.assertEqual(_guest_lang_from_history(history), language)
                for short_reply in continuations[language]:
                    history.append({'role': 'user', 'content': short_reply})
                    self.assertEqual(_guest_lang_from_history(history), language)

        self.agent.session_id = 'observed-german-beats-carried-english'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('lang-switch-de', switches['de'])
        plan = {**self.plan, 'language': 'en'}
        self.ledger.record_quote(plan, self.checked(plan))
        quote = self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft', 'messages': []}
        )['final_response']
        state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
        self.assertEqual(state['guest_language'], 'de')
        self.assertEqual(quote, 'draft')
        self.assertEqual(state['quote']['quote_authoring_facts']['language'], 'de')
        self.assertNotIn("Here's your stay", quote)

        offer = self.checked(plan)['offer_revision']
        receipt = self.ledger._styled_booking_receipt_copy(
            plan, offer,
            {'booking_code': 'KATI-OFFLINE', 'amount_due_cents': 20000,
             'secure_payment_url': 'https://example.test/pay/KATI-OFFLINE'},
            state['guest_language'],
        )
        self.assertIn('deine Buchung ist bei uns eingetragen', receipt)
        self.assertIn('*Jetzt fällig:*', receipt)
        self.assertIn('*Zahlungslink:*', receipt)
        self.assertNotIn('Your booking is saved', receipt)

    def test_de_and_fr_render_group_payment_and_shuttle_questions(self):
        for language in ('de', 'fr'):
            with self.subTest(language=language):
                copy = self.ledger._style_copy(language)
                self.assertTrue(copy['group_payment_choice'])
                self.assertTrue(copy['shuttle_choice'])

    def test_sim19_explicit_composition_and_numbered_gendered_room_instruction(self):
        soul = (Path(__file__).resolve().parents[1] / 'SOUL.md').read_text()
        self.assertIn('“zwei Jungs”', soul)
        self.assertIn('preserve it as `group_gender`', soul)
        self.assertIn("including a gendered or numbered room request", soul)
        self.assertIn('Never silently replace any of these with `mixed`', soul)
        self.assertIn('Names alone never supply these facts', soul)

    def test_saved_confirmation_uses_authoritative_person_labels_without_code_fallback(self):
        from wolfhouse import accepted_quote
        plan = {'package_code': 'malibu', 'guests': [
            {'name': 'Anna'}, {'name': 'Bert'}, {'name': 'Clemens'},
        ]}
        receipt = {
            'booking_code': 'LABEL-OFFLINE',
            'booking_guests': [
                {'booking_guest_id': 'g3', 'guest_number': 3, 'guest_name': 'Clemens'},
                {'booking_guest_id': 'g1', 'guest_number': 1, 'guest_name': 'Anna'},
                {'booking_guest_id': 'g2', 'guest_number': 2, 'guest_name': 'Bert'},
            ],
            'per_person': [
                {'booking_guest_id': 'g2', 'guest_number': 2,
                 'package_code': 'rincon', 'package_label': 'Cantabria Explorer'},
                {'booking_guest_id': 'g3', 'guest_number': 3,
                 'package_code': 'package_none'},
                {'booking_guest_id': 'g1', 'guest_number': 1,
                 'package_code': 'malibu', 'package_label': 'Costa Brava Week'},
            ],
        }
        facts = accepted_quote._saved_confirmation_facts(plan, {}, receipt)
        self.assertNotIn('package', facts, 'mixed party has no misleading aggregate package')
        by_name = {row['name']: row for row in facts['guest_presentations']}
        self.assertEqual(by_name['Anna']['package_label'], 'Costa Brava Week')
        self.assertEqual(by_name['Bert']['package_label'], 'Cantabria Explorer')
        self.assertTrue(by_name['Clemens']['accommodation_only'])
        self.assertNotIn('package_label', by_name['Clemens'])

        no_label = accepted_quote._saved_confirmation_facts(
            {'package_code': 'malibu', 'guests': []}, {},
            {'booking_code': 'NO-LABEL-OFFLINE'},
        )
        self.assertNotIn('package', no_label, 'raw package code is not title-cased or brand-mapped')


if __name__ == '__main__':
    unittest.main()
