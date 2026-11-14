"""Offline P1 authority failures: real owner SQLite; synthetic Staff transport only."""
import json
import os
import unittest
from copy import deepcopy
from unittest.mock import patch

from wolfhouse import accepted_quote as owner, pending_question
import wolfhouse_staff_api as plugin


class PaymentAdmissionFailureTests(unittest.TestCase):
    def setUp(self):
        for guard in (
            patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo',
                                    'PATH': os.environ.get('PATH', ''),
                                    'NODE_OPTIONS': '--max-old-space-size=1024'}, clear=True),
            patch('socket.socket.connect', side_effect=AssertionError('NETWORK FORBIDDEN')),
            patch('socket.create_connection', side_effect=AssertionError('NETWORK FORBIDDEN')),
        ):
            guard.start()
            self.addCleanup(guard.stop)

    def exercise(self, distribution, choice, fail_admission):
        from wolfhouse.test_accepted_quote import OwnerHostileTests
        fixture = OwnerHostileTests()
        fixture.setUp()
        try:
            # R2 binds consent to offered questions, not model tool arguments.
            # The pre-R2 owner has no atomic question writer; assertions below
            # are identical on both sources (no skipped cases or weaker counts).
            if callable(getattr(owner, 'commit_question_outbound', None)):
                owner.commit_question_outbound('Deposit or full?', 'payment_choice', ['deposit', 'full'])
                fixture.turn('authority-amount-answer', choice)
                owner.commit_question_outbound('Together or separate?', 'payment_choice', ['together', 'separate'])
                fixture.turn('authority-distribution-answer', distribution)
            ticket = fixture.accept(params={'payment_link_distribution': distribution,
                                            'payment_choice': choice})
            saved = {
                'success': True, 'write_performed': True,
                'booking_id': 'offline-booking', 'booking_code': 'WH-OFFLINE-P1',
                'payment_id': 'offline-payment', 'payment_status': 'draft',
                'total_cents': 60000, 'deposit_required_cents': 20000,
                'uses_per_guest_model': distribution == 'separate',
                'booking_guests': [{'booking_guest_id': f'g{i}', 'guest_number': i,
                                    'guest_name': name} for i, name in enumerate(('Alex', 'Sam'), 1)],
            }
            calls = []
            def transport(path, payload, **kwargs):
                calls.append(path)
                if path == '/booking-create-from-plan':
                    return deepcopy(saved)
                if path.endswith('/create-stripe-link') or path.endswith('/create-payment-link'):
                    return {'success': True, 'payment_short_url': 'https://pay.invalid/offline'}
                raise AssertionError(path)
            token = owner._dispatch_ticket.set(ticket)
            try:
                with patch.object(plugin, '_post_bot', side_effect=transport), \
                     patch.object(plugin, 'flag_needs_human', side_effect=AssertionError('NO HANDOFF')), \
                     patch.object(pending_question, 'withhold_payment_link',
                                  side_effect=RuntimeError('private ledger details') if fail_admission else None,
                                  return_value=False):
                    result = json.loads(plugin._commit_and_complete_booking(dict(ticket)))
                    durable = owner.dispatch_recovery(ticket)['receipt']
            finally:
                owner._dispatch_ticket.reset(token)
            self.assertTrue(result['success'], 'a payment admission error must not undo a saved booking')
            self.assertTrue(result['write_performed'])
            self.assertEqual(result['booking_id'], saved['booking_id'])
            self.assertEqual(result['payment_id'], saved['payment_id'])
            self.assertEqual(durable['booking_id'], saved['booking_id'])
            self.assertEqual(durable['payment_id'], saved['payment_id'])
            self.assertEqual(calls.count('/booking-create-from-plan'), 1)
            return result, calls
        finally:
            fixture.tearDown()

    def test_admission_exception_preserves_saved_receipt_and_never_calls_checkout(self):
        for distribution in ('together', 'separate'):
            for choice in ('deposit', 'full'):
                with self.subTest(distribution=distribution, choice=choice):
                    result, calls = self.exercise(distribution, choice, True)
                    self.assertEqual(calls, ['/booking-create-from-plan'])
                    self.assertEqual(result['payment_admission'],
                                     {'success': False, 'error': 'payment_admission_failed'})
                    self.assertTrue(result['payment_link_withheld'])
                    self.assertIsNone(result['secure_payment_url'])
                    self.assertFalse(result.get('guest_payment_links'))
                    self.assertIsNone(result['next_action'])
                    self.assertFalse(result['needs_human'])
                    self.assertFalse(result['staff_review_needed'])
                    self.assertIsNone(result['reply_draft'])
                    self.assertNotIn('private ledger details', json.dumps(result))

    def test_successful_admission_still_creates_requested_checkout(self):
        for distribution in ('together', 'separate'):
            with self.subTest(distribution=distribution):
                result, calls = self.exercise(distribution, 'deposit', False)
                self.assertEqual(len(calls), 2 if distribution == 'together' else 3)
                self.assertTrue(result['secure_payment_url'] or result['guest_payment_links'])
                self.assertNotIn('payment_admission', result)


class PaymentCompletionRetentionTests(unittest.TestCase):
    def test_owner_completion_failure_is_not_silently_reported_as_retained(self):
        token = owner._current.set(object())
        error = RuntimeError('owner completion persistence failed')
        try:
            with patch.object(owner, 'record_payment_completion', side_effect=error):
                with self.assertRaises(RuntimeError) as caught:
                    plugin._retain_owner_payment_completion({'success': True})
            self.assertIs(caught.exception, error)
        finally:
            owner._current.reset(token)


class QuestionAuthorityFailureTests(unittest.TestCase):
    def test_ledger_read_failure_is_explicit_unknown_context_not_a_save_stop(self):
        with patch.object(owner, '_transaction', side_effect=OSError('private ledger read details')):
            result = plugin._pending_question_model_context()
        self.assertEqual(result['question_context'], {
            'status': 'unavailable', 'error': 'question_authority_read_failed',
            'reconciliation_needed': True})
        self.assertIn('question_authority_read_failed', result['context'])
        self.assertNotIn('pending_booking_question', result)
        self.assertNotIn('private ledger read details', json.dumps(result))

    def test_real_hermes_hook_dispatch_preserves_model_path_on_question_read_failure(self):
        # Execute the installed Hermes pre-LLM hook block, including its real
        # best-effort catch, through the real PluginManager callback dispatcher.
        # The rest of turn preparation is not needed to exercise this boundary.
        import ast
        import inspect
        from types import SimpleNamespace
        from unittest.mock import Mock
        from agent import turn_context
        from hermes_cli import plugins
        tree = ast.parse(inspect.getsource(turn_context))
        blocks = [node for node in ast.walk(tree) if isinstance(node, ast.Try)
                  and any(isinstance(child, ast.Call) and isinstance(child.func, ast.Name)
                          and child.func.id == '_invoke_hook' for child in ast.walk(node))]
        self.assertEqual(len(blocks), 1, 'installed hook boundary must be unambiguous')
        code = compile(ast.fix_missing_locations(ast.Module(body=blocks, type_ignores=[])),
                       inspect.getfile(turn_context), 'exec')
        manager = object.__new__(plugins.PluginManager)
        manager._hooks = {}
        ctx = SimpleNamespace(register_hook=lambda name, callback:
                              manager._hooks.setdefault(name, []).append(callback),
                              register_tool=lambda **kwargs: None)
        with patch.object(plugin, '_booking_names_helper', return_value=None), \
             patch.object(owner, 'install_owner_hook'):
            plugin.register(ctx)
        reached_model = Mock()
        namespace = dict(agent=SimpleNamespace(session_id='offline', model='offline'),
                         effective_task_id='offline', turn_id='offline',
                         original_user_message='Alex and Sam', messages=[],
                         conversation_history=[], logger=Mock())
        with patch.object(plugins, 'get_plugin_manager', return_value=manager), \
             patch.object(owner, '_transaction', side_effect=OSError('ledger unavailable')):
            exec(code, namespace)
            reached_model()
        reached_model.assert_called_once()
        self.assertIn('question_authority_read_failed', namespace['plugin_user_context'])

    def test_acceptance_saves_actual_staff_rows_despite_question_context_read_failure(self):
        # Reuse, do not edit Seadog's real SQLite/Staff/PGlite bridge. Only model
        # intent and HTTP transport are synthetic; create and SELECT are real.
        from wolfhouse.test_first_yes_persistence import FirstYesPersistenceTests
        fixture = FirstYesPersistenceTests()
        try:
            fixture.setUp()
            # Synthetic model edge must support the real pending-amount receipt.
            # Keep the production finalizer, question writer, create and SQL real.
            fixture.writer.stop()
            def pending_confirmation(agent, facts, invalid_draft, **kwargs):
                display = owner._confirmation_rewrite_payload(facts, invalid_draft, [])['required_guest_facts']
                text = (f"Your booking is saved. Reference: {display['booking_reference']}. "
                        f"Total: {display['total']}.")
                if display.get('saved_room_type'):
                    text += f" Room type: {display['saved_room_type']}."
                if display.get('saved_room_numbers'):
                    text += ' Room: ' + ', '.join(display['saved_room_numbers']) + '.'
                if display.get('location_url'):
                    text += '\n' + display['location_url']
                return text + '\nWould you like to pay the deposit or the full total?'
            writer = patch.object(owner, '_rewrite_saved_confirmation', side_effect=pending_confirmation)
            writer.start()
            fixture.addCleanup(writer.stop)
            fixture.direct_create = True
            fixture.turn('Please quote this booking', 'offer')
            revision = fixture.quote_result['offer_revision']
            original_context = plugin._pending_question_model_context
            observed = []
            def failed_question_context():
                with patch.object(owner, '_transaction', side_effect=OSError('question read unavailable')):
                    result = original_context()
                observed.append(result)
                return result
            with patch.object(plugin, '_pending_question_model_context', side_effect=failed_question_context):
                result = fixture.turn('yes', 'acceptance-read-failure')
            self.assertTrue(observed)
            self.assertEqual(observed[0]['question_context']['status'], 'unavailable')
            saved = result['booking_result']
            self.assertTrue(saved['success'], saved)
            self.assertTrue(saved['write_performed'], saved)
            snapshot = fixture.assert_one_booking(revision)
            self.assertEqual(snapshot['tables']['bookings'][0]['id'], saved['booking_id'])
            self.assertEqual(len([c for c in snapshot['calls'] if c['path'] == '/booking-create-from-plan']), 1)
        finally:
            fixture.doCleanups()

    def test_names_question_is_carried_without_losing_authority(self):
        pending = {'kind': 'names', 'question_id': 'names-1', 'guest_count': 2,
                   'missing_guest_indices': [0, 1]}
        with patch.object(owner, '_transaction', return_value=pending), \
             patch.object(owner, '_staff_sent_reply_context', return_value={}), \
             patch.object(owner, 'shuttle_offer_context', return_value=None):
            result = plugin._pending_question_model_context()
        self.assertEqual(result.get('pending_booking_question'), pending)
        result['pending_booking_question']['missing_guest_indices'].append(2)
        self.assertEqual(pending['missing_guest_indices'], [0, 1])

    def test_successful_read_with_no_pending_question_is_not_a_failure(self):
        with patch.object(owner, '_transaction', return_value=None), \
             patch.object(owner, '_staff_sent_reply_context', return_value={}), \
             patch.object(owner, 'shuttle_offer_context', return_value=None):
            result = plugin._pending_question_model_context()
        self.assertIsInstance(result, dict)
        self.assertNotIn('pending_booking_question', result)


if __name__ == '__main__':
    unittest.main()
