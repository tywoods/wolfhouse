"""Focused owner units. Staff HTTP is substituted; no business persistence claim."""
import json
import subprocess
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from hermes_state import SessionDB
from gateway.session_context import set_session_vars, clear_session_vars
from wolfhouse import accepted_quote as ledger
import wolfhouse_staff_api as plugin


class FirstYesOwnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.db.create_session('first-yes', source='whatsapp')
        self.agent = SimpleNamespace(_session_db=self.db, session_id='first-yes')
        self.env = patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'})
        self.env.start()
        self.tokens = None
        self.plan = dict(check_in='2026-11-01', check_out='2026-11-08', guest_count=2,
                         package_code='package_none', room_type='shared', room_preference='mixed',
                         guests=[{'name': 'Alex'}, {'name': 'Sam'}], payment_choice='full',
                         email='alex@example.test')
        root = Path(__file__).resolve().parents[3]
        source = "const {buildCheckedWolfhousePreviewOffer:b}=require('./scripts/lib/luna-front-desk-accommodation-availability-service'); console.log(JSON.stringify(b(JSON.parse(process.argv[1]))));"
        quote = dict(success=True, total_cents=70000, deposit_required_cents=20000,
                     payment_link_amount_cents=70000, currency='EUR', package_code='package_none')
        checked = json.loads(subprocess.check_output(['node', '-e', source, json.dumps(dict(
            client_slug='wolfhouse-somo', quote=quote, guests=self.plan['guests'],
            payment_choice='full', availability={**self.plan, 'status': 'checked',
            'selected_bed_codes': ['M1', 'M2']}, room_rows=[
                dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]))], cwd=root))
        self.response = dict(success=True, total_cents=70000, deposit_required_cents=20000,
                             payment_choice_needed=False, currency='EUR', **checked)
        self.turn('q1', 'Quote this please')

    def tearDown(self):
        ledger.close_turn()
        if self.tokens:
            clear_session_vars(self.tokens)
        self.env.stop()
        self.db.close()
        self.temp.cleanup()

    def turn(self, message, raw):
        if self.tokens:
            clear_session_vars(self.tokens)
        self.tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='c1',
            user_id='g1', session_key='k1', session_id=self.agent.session_id, message_id=message)
        ledger.observe_owner_turn(self.agent, raw)

    def test_only_owner_final_question_authorizes_contextual_yes(self):
        ledger.record_quote(self.plan, self.response)
        self.turn('not-presented', 'yes')
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_create({})
        ledger.record_quote({}, self.response)
        finalize = getattr(ledger, 'finalize_offer_response', None)
        self.assertTrue(callable(finalize), 'missing owner final-response boundary')
        result = finalize({'completed': True, 'final_response': 'model says reserved',
                           'messages': [{'role': 'assistant', 'content': 'model says reserved'}]})
        self.assertNotIn('reserved', result['final_response'])
        self.assertIn('Alex', result['final_response'])
        self.assertIn('M1', result['final_response'])
        self.assertIn('700.00 EUR', result['final_response'])
        self.assertIn('full', result['final_response'].lower())
        self.assertTrue(result['final_response'].endswith('Shall I create this booking?'))
        self.assertEqual(result['messages'][-1]['content'], result['final_response'])
        self.turn('contextual-yes', 'Yes!')
        self.assertIs(ledger.prepare_create({})['require_offer_identity'], True)

    def test_incomplete_checked_responses_never_present_accept_ready_question(self):
        mutations = [
            lambda r: r.update(success=False),
            lambda r: r.update(payment_choice_needed=True),
            lambda r: r['offer_revision'].update(payment_choice=None),
            lambda r: r['offer_revision'].update(payment_link_amount_cents=None),
            lambda r: r['offer_revision'].update(total_cents=1),
            lambda r: r['offer_revision'].update(room_arrangement=[]),
            lambda r: r['offer_revision']['guest_bed_assignments'][1].update(bed_code='M1'),
            lambda r: r['availability'].update(selected_bed_codes=['M2', 'M1']),
            lambda r: r['offer_revision']['guest_bed_assignments'][1].update(guest_name=None),
            lambda r: r['offer_revision'].update(check_in=None),
            lambda r: r.update(offer_revision=None),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.agent.session_id = 'invalid-' + str(index)
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn('invalid-q-' + str(index), 'Quote this please')
                response = deepcopy(self.response)
                mutate(response)
                ledger.record_quote(self.plan, response)
                result = ledger.finalize_offer_response({'completed': True, 'final_response': 'Information only'})
                self.assertEqual(result['final_response'], 'Information only')
                self.turn('invalid-yes-' + str(index), 'yes')
                with self.assertRaises(ledger.QuoteBoundaryError):
                    ledger.prepare_create({})

    def test_unchanged_revalidation_preserves_acceptance_and_operation_key(self):
        ledger.record_quote(self.plan, self.response)
        self.turn('accept', 'I accept the quote')
        before = ledger.prepare_create({})
        ledger.record_quote({}, {**self.response, 'reply_draft': 'different cosmetic text'})
        self.assertEqual(ledger.prepare_create({}), before)
        for changed in ({**self.response, 'success': False},
                        {**self.response, 'availability': {'status': 'unavailable'}, 'offer_revision': None}):
            ledger.record_quote({}, changed)
            with self.assertRaises(ledger.QuoteBoundaryError):
                ledger.prepare_create({})

    def test_changed_price_revokes_acceptance(self):
        ledger.record_quote(self.plan, self.response)
        self.turn('accept', 'I accept the quote')
        changed = deepcopy(self.response)
        changed['total_cents'] += 100
        changed['offer_revision']['total_cents'] += 100
        ledger.record_quote({}, changed)
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_create({})

    def test_successful_staff_receipt_is_durable_and_not_redispatched(self):
        ledger.record_quote(self.plan, self.response)
        self.turn('accept', 'I accept the quote')
        prepared = ledger.prepare_create({})
        receipt = {'success': True, 'write_performed': True, 'booking_id': 'offline-unit-booking'}
        calls = []
        self.assertEqual(ledger.dispatch_create(prepared, lambda: calls.append(1) or receipt), receipt)
        self.db.close()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.agent._session_db = self.db
        self.turn('retry', 'Please proceed')
        retried = ledger.prepare_create({})
        self.assertEqual(retried['idempotency_key'], prepared['idempotency_key'])
        self.assertEqual(ledger.dispatch_create(retried, lambda: calls.append(2) or {}), receipt)
        self.assertEqual(calls, [1])

    def test_crash_after_staff_commit_reuses_original_frozen_operation(self):
        ledger.record_quote(self.plan, self.response)
        self.turn('accept', 'I accept the quote')
        before = ledger.prepare_create({})
        committed = {}
        def lost_response():
            committed[before['idempotency_key']] = dict(before)
            raise ConnectionError('unit: committed but response lost')
        with self.assertRaises(ConnectionError):
            ledger.dispatch_create(before, lost_response)
        self.turn('retry', 'Please proceed')
        after = ledger.prepare_create({})
        self.assertEqual(after, committed[after['idempotency_key']])

    def test_hook_runs_registered_create_on_first_yes_without_model_create(self):
        from agent import conversation_loop
        from wolfhouse import booking_names
        from wolfhouse.offline_ingress_harness import gateway_ingress
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        registry = Registry()
        calls, model_calls = [], []
        def staff(path, body):
            calls.append((path, deepcopy(body)))
            if path == '/booking-preview': return deepcopy(self.response)
            if path == '/availability-check':
                return {'success': True, 'has_enough_beds': True, 'available_beds': [
                    {'bed_code': 'M1', 'room_type': 'mixed'}, {'bed_code': 'M2', 'room_type': 'mixed'}]}
            if path == '/payments/unit-payment/create-stripe-link':
                # Explicit unit-only HTTP substitution, not Stripe/persistence proof.
                return {'success': True, 'guest_payment_url': 'https://example.invalid/pay/unit-payment'}
            if path == '/bookings/update-contact':
                return {'success': True, 'write_performed': True, 'email_saved': True,
                        'email_sent': True}  # must not be trusted as send proof
            self.assertEqual(path, '/booking-create-from-plan')
            return {'success': True, 'write_performed': True, 'booking_id': 'unit-booking',
                    'booking_code': 'UNIT-1', 'payment_id': 'unit-payment'}
        def model(agent, text, *args, **kwargs):
            model_calls.append(text)
            booking_names.begin_turn(session_id=agent.session_id, scope=plugin._booking_name_scope())
            if text == 'Please quote this':
                self.assertTrue(json.loads(registry.tools['quote_booking']['handler'](self.plan))['success'])
            return {'completed': True, 'final_response': 'Model did not book',
                    'messages': [{'role': 'assistant', 'content': 'Model did not book'}]}
        with patch.object(conversation_loop, 'run_conversation', model), patch.object(plugin, '_post_bot', side_effect=staff):
            plugin.register(registry)
            offered = gateway_ingress(self.agent, 'Please quote this', 'hook-q',
                lambda raw: conversation_loop.run_conversation(self.agent, raw))
            self.assertIn('Shall I create this booking?', offered['final_response'])
            accepted = gateway_ingress(self.agent, 'yes', 'hook-a',
                lambda raw: conversation_loop.run_conversation(self.agent, raw))
            self.assertIn('UNIT-1', accepted['final_response'])
            self.assertIn('https://example.invalid/pay/unit-payment', accepted['final_response'])
            calls_before_retry = deepcopy(calls)
            self.db.close()
            self.db = SessionDB(Path(self.temp.name) / 'state.db')
            self.agent._session_db = self.db
            retried = gateway_ingress(self.agent, 'yes', 'hook-a',
                lambda raw: conversation_loop.run_conversation(self.agent, raw))
            self.assertIn('https://example.invalid/pay/unit-payment', retried['final_response'])
            self.assertEqual(retried['booking_result']['secure_payment_url'],
                             accepted['booking_result']['secure_payment_url'])
            self.assertEqual(calls, calls_before_retry, 'No duplicate booking or payment-link side effect')
            self.assertEqual(model_calls, ['Please quote this'])
            creates = [body for path, body in calls if path == '/booking-create-from-plan']
            self.assertEqual(len(creates), 1)
            self.assertEqual(creates[0]['accepted_offer'], self.response['offer_revision'])
            self.assertEqual(creates[0]['guests'], self.plan['guests'])
            self.assertEqual(creates[0]['selected_bed_codes'], ['M1', 'M2'])
            email_updates = [body for path, body in calls if path == '/bookings/update-contact']
            self.assertEqual(email_updates, [{'client_slug': 'wolfhouse-somo', 'booking_code': 'UNIT-1',
                                              'email': 'alex@example.test'}])
            self.assertTrue(accepted['booking_result']['post_booking_email']['saved'])
            self.assertFalse(accepted['booking_result']['post_booking_email']['sent'])
            self.assertEqual(accepted['booking_result']['post_booking_email']['outcome'], 'saved')

    def test_post_booking_email_save_outcomes_and_no_write_fences(self):
        payload = {'client_slug': 'wolfhouse-somo', 'email': 'alex@example.test'}
        created = {'success': True, 'write_performed': True}
        fields = {'booking_code': 'UNIT-EMAIL'}
        cases = (
            ({'success': True, 'write_performed': True, 'email_sent': True}, True, 'saved'),
            ({'success': False, 'write_performed': False, 'error': 'refused'}, False, 'refused'),
            ({'success': False, 'error': 'timeout'}, False, 'unknown'),
        )
        for adapter_result, saved, outcome in cases:
            with self.subTest(outcome=outcome), patch.object(plugin, '_post_bot', return_value=adapter_result) as post:
                result = plugin._save_post_booking_email(payload, created, fields)
                self.assertEqual(result['saved'], saved)
                self.assertEqual(result['outcome'], outcome)
                self.assertFalse(result['sent'])
                self.assertFalse(result['send_performed'])
                post.assert_called_once_with('/bookings/update-contact', {
                    'client_slug': 'wolfhouse-somo', 'booking_code': 'UNIT-EMAIL',
                    'email': 'alex@example.test',
                })

        prior = {'post_booking_email': {'requested': True, 'saved': True, 'sent': False,
                                        'send_performed': False, 'outcome': 'saved'}}
        with patch.object(plugin, '_post_bot') as post:
            self.assertEqual(plugin._save_post_booking_email(payload, created, fields, prior),
                             prior['post_booking_email'])
            post.assert_not_called()
            self.assertIsNone(plugin._save_post_booking_email(payload,
                {'success': False, 'write_performed': False}, fields))
            self.assertIsNone(plugin._save_post_booking_email(payload,
                {'success': True, 'write_performed': False}, fields))
            self.assertIsNone(plugin._save_post_booking_email({}, created, fields))
            post.assert_not_called()

    def test_checked_offer_freezes_staff_order_payment_and_identity(self):
        hints = [{'name': 'Alex', 'hint': 'unknown'}, {'name': 'Sam', 'hint': 'unknown'}]
        ledger.record_quote({**self.plan, 'room_name_hints': hints}, self.response)
        self.turn('a1', 'I accept the quote')
        prepared = ledger.prepare_create({'accepted_offer': {'forged': True}, 'require_offer_identity': False})
        self.assertEqual(prepared.get('accepted_offer'), self.response['offer_revision'])
        self.assertIs(prepared.get('require_offer_identity'), True)
        self.assertEqual(prepared.get('selected_bed_codes'), ['M1', 'M2'])
        self.assertEqual(prepared.get('guests'), self.plan['guests'])
        self.assertEqual(prepared.get('room_name_hints'), hints)
        self.assertEqual(prepared.get('payment_choice'), 'full')
        for changed in ({'guests': list(reversed(self.plan['guests']))},
                        {'payment_choice': 'deposit'}, {'selected_bed_codes': ['M2', 'M1']},
                        {'room_name_hints': list(reversed(hints))}):
            with self.subTest(changed=changed), self.assertRaises(ledger.QuoteBoundaryError):
                ledger.prepare_create(changed)

    def test_adapter_preserves_staff_checked_offer_not_model_offer(self):
        with patch.object(plugin, '_post_bot', return_value=self.response):
            result = json.loads(plugin.quote_booking({**self.plan,
                'offer_revision': {'forged': True}, 'availability': {'status': 'held'}}))
        self.assertEqual(result.get('availability'), self.response['availability'])
        self.assertEqual(result.get('offer_revision'), self.response['offer_revision'])
