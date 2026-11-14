"""Offline owner contract tests. No model/provider delivery claim."""
import unittest
from wolfhouse import pending_question as q

class QuestionBindingTests(unittest.TestCase):
    def test_prepare_does_not_scan_unbound_text(self):
        from wolfhouse import accepted_quote as ledger
        state = {'plan': {}, 'current_turn': {'raw': 'full together'}}
        result = ledger._with_inferred_guest_payment({}, state)
        self.assertTrue(result['ask_payment_amount'])
        self.assertNotIn('payment_link_distribution', result)

    def test_legacy_default_amount_is_not_bound_consent(self):
        from wolfhouse import accepted_quote as ledger
        for bound in ({}, {'payment_link_distribution': 'together', 'per_guest_payment_links': False}):
            state = {'plan': {'payment_choice': 'deposit', 'ask_payment_amount': False},
                     'bound_question_fields': bound}
            result = ledger._with_inferred_guest_payment({}, state)
            self.assertTrue(result['ask_payment_amount'])

    def test_model_distribution_is_not_consent(self):
        from wolfhouse import accepted_quote as ledger
        result = ledger._with_inferred_guest_payment(
            {'payment_link_distribution': 'separate', 'per_guest_payment_links': True},
            {'plan': {}, 'current_turn': {'raw': 'yes'}})
        self.assertNotIn('payment_link_distribution', result)
        self.assertNotIn('per_guest_payment_links', result)

    def test_shuttle_precedes_save_even_create_ready(self):
        self.assertEqual(q.quote_question_kind({'package_code': 'malibu'}, {}, 'en', True), 'add_on')

    def test_options_only_and_replay_controls(self):
        for raw in ('yes', 'sí', 'together', 'not full', 'full or deposit'):
            with self.subTest(raw=raw):
                state = {'plan': {}}
                q.open_question(state, 'payment_choice', ['deposit', 'full'], 1, 'Amount?', scope='a')
                self.assertFalse(q.bind_answer(state, raw, 'i', scope='a'))
                self.assertEqual(state['pending_question']['status'], 'open')
        state = {'plan': {}}
        q.open_question(state, 'payment_choice', ['deposit', 'full'], 1, 'Amount?', scope='a')
        self.assertFalse(q.bind_answer(state, 'full', 'i', scope='wrong'))
        self.assertFalse(q.bind_answer(state, 'full', 'i', scope='a', question_id=0))
        self.assertTrue(q.bind_answer(state, 'full together', 'i', scope='a'))
        self.assertNotIn('payment_link_distribution', state['plan'])
        q.open_question(state, 'payment_choice', ['together', 'separate'], 2, 'Distribution?', scope='a')
        self.assertFalse(q.bind_answer(state, 'together', 'i', scope='a'))
        self.assertTrue(q.bind_answer(state, 'por separado', 'j', scope='a'))
        self.assertTrue(state['plan']['per_guest_payment_links'])

    def test_answer_history_survives_next_question(self):
        state = {}
        first = q.open_question(state, 'payment_choice', ['deposit', 'full'], 1, 'Amount?', scope='a')
        q.bind_answer(state, 'full', 'i', scope='a')
        q.open_question(state, 'payment_choice', ['together', 'separate'], 2, 'Distribution?', scope='a')
        self.assertEqual(state['question_history'][0], first)
        q.retire_legacy(state)
        self.assertEqual(state['pending_question']['status'], 'open')

    def test_legacy_descriptor_cannot_overwrite_open_record(self):
        state = {'plan': {}}
        record = q.open_question(state, 'add_on', ['accepted', 'declined'], 1, 'Shuttle?', scope='a')
        q.persist(state, 'payment_choice', ['deposit', 'full'])
        self.assertEqual(state['pending_question'], record)
        q.persist(state, None)
        self.assertEqual(state['pending_question'], record)

    def test_shuttle_answer_writes_both_plans(self):
        state = {'plan': {}, 'completion_plan': {}}
        self.assertTrue(callable(getattr(q, 'open_question', None)), 'durable question API missing')
        q.open_question(state, 'add_on', ['accepted', 'declined'], 12, 'Shuttle?', scope='tenant/session')
        self.assertTrue(q.bind_answer(state, 'sí', 'in-1', scope='tenant/session'))
        self.assertEqual(state['plan']['shuttle_choice'], 'accepted')
        self.assertEqual(state['completion_plan']['shuttle_choice'], 'accepted')
        self.assertEqual(state['pending_question']['status'], 'answered')

class OwnerAtomicTests(unittest.TestCase):
    def setUp(self):
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        self.case = FirstYesOwnerTests('test_only_owner_final_question_authorizes_contextual_yes')
        self.case.setUp()
        self.addCleanup(self.case.tearDown)

    def test_atomic_outbound_then_observe_before_tools(self):
        from wolfhouse import accepted_quote as ledger
        self.assertTrue(callable(getattr(ledger, 'commit_question_outbound', None)), 'atomic outbound API missing')
        result = ledger.commit_question_outbound('Shuttle?', 'add_on', ['accepted', 'declined'])
        row = self.case.db._conn.execute('SELECT content FROM messages WHERE id=?', (result['message_id'],)).fetchone()
        self.assertEqual(row[0], 'Shuttle?')
        self.case.turn('shuttle-answer', 'sí')
        state = ledger._read_owner_state(lambda state, _: state.copy())
        self.assertEqual(state['plan']['shuttle_choice'], 'accepted')
        self.assertEqual(state['completion_plan']['shuttle_choice'], 'accepted')
        self.assertEqual(state['pending_question']['answer']['inbound_message_id'], 'shuttle-answer')

    def test_parallel_shuttle_asker_removed(self):
        from wolfhouse import accepted_quote as ledger
        ledger._transaction(lambda state, _: state.update(plan={'package_code': 'malibu'}))
        self.assertIsNone(ledger.shuttle_offer_context())

    def test_incident_shaped_owner_replays(self):
        # 74753 is SYNTHETIC: actual full incident transcript was unavailable.
        from wolfhouse import accepted_quote as ledger
        for label, count, tier, distribution in (
                ('74750', 1, 'full', None), ('74752', 2, 'completo', 'juntos'),
                ('74753-synthetic', 1, 'full', None), ('group-deposit', 2, 'deposit', 'por separado')):
            with self.subTest(scenario=label):
                ledger._transaction(lambda state, _: state.update(
                    plan={'guest_count': count, 'ask_payment_amount': True},
                    completion_plan={'guest_count': count},
                    completion={'success': True, 'write_performed': True, 'booking_id': label}))
                ledger.commit_question_outbound('Deposit or full?', 'payment_choice', ['deposit', 'full'])
                self.case.turn(label + '-amount', tier)
                state = ledger._read_owner_state(lambda s, _: s.copy())
                self.assertEqual(state['plan']['payment_choice'], 'deposit' if tier == 'deposit' else 'full')
                self.assertFalse(state['completion_plan']['ask_payment_amount'])
                if distribution:
                    self.assertNotIn('payment_link_distribution', state['plan'])
                    ledger.commit_question_outbound('Together or separate?', 'payment_choice', ['together', 'separate'])
                    self.case.turn(label + '-distribution', distribution)
                    state = ledger._read_owner_state(lambda s, _: s.copy())
                    self.assertEqual(state['plan']['per_guest_payment_links'], distribution == 'por separado')

    def test_legacy_confirmation_debt_cannot_restore_answered_amount_after_restart(self):
        self.test_confirmation_debt_cannot_restore_answered_amount_after_restart(legacy=True)

    def test_confirmation_debt_cannot_restore_answered_amount_after_restart(self, legacy=False):
        from copy import deepcopy
        from pathlib import Path
        from hermes_state import SessionDB
        from wolfhouse import accepted_quote as ledger
        from wolfhouse.test_first_yes_owner import offline_saved_confirmation

        plan = {**self.case.plan, 'ask_payment_amount': True}
        receipt = {'success': True, 'write_performed': True,
                   'booking_id': 'saved-group', 'booking_code': 'WH-RESTART',
                   'total_cents': 70000, 'ask_payment_amount': True,
                   'payment_choice_pending': True, 'next_action': 'ask_deposit_or_full'}
        ledger._transaction(lambda state, _: state.update(
            plan=deepcopy(plan), completion_plan=deepcopy(plan),
            checked_offer=deepcopy(self.case.response['offer_revision']),
            completion=deepcopy(receipt)))
        # Real finalization creates debt when external authoring was interrupted.
        interrupted = ledger.finalize_offer_response(
            {'completed': False, 'interrupted': True,
             'final_response': 'Booking WH-RESTART saved.'},
            saved_booking_projection=receipt)
        self.assertTrue(interrupted['confirmation_withheld'])
        debt = ledger._read_owner_state(lambda state, _: deepcopy(state['confirmation_owed']))
        if not legacy:
            self.assertNotIn('ask_payment_amount', debt)
            self.assertNotIn('ask_payment_distribution', debt)
        if legacy:
            ledger._transaction(lambda state, _: state['confirmation_owed'].update(
                ask_payment_amount=True, payment_choice_pending=True,
                next_action='ask_deposit_or_full'))
        ledger.commit_question_outbound('Deposit or full?', 'payment_choice', ['deposit', 'full'])
        self.case.turn('full-before-restart', 'full')
        import json
        from unittest.mock import patch
        import wolfhouse_staff_api as api
        with patch.object(api, '_post_bot', side_effect=AssertionError('NO CHECKOUT')):
            payment = json.loads(api.create_payment_link({'booking_code': 'WH-RESTART'}))
        self.assertEqual(payment['next_action'], 'ask_together_or_separate', payment)
        before = ledger._read_owner_state(lambda state, _: deepcopy(state))
        self.assertEqual(before['pending_question']['status'], 'answered')
        self.assertEqual(before['completion_plan']['payment_choice'], 'full')
        self.assertFalse(before['completion']['ask_payment_amount'])

        ledger.close_turn()
        self.case.db.close()
        self.case.db = SessionDB(Path(self.case.temp.name) / 'state.db')
        self.case.agent._session_db = self.case.db
        self.case.turn('after-restart', 'Please continue')
        reopened = ledger._read_owner_state(lambda state, _: deepcopy(state))
        self.assertEqual(reopened['completion_plan']['payment_choice'], 'full')
        captured = []
        def author(facts, draft):
            captured.append(deepcopy(facts))
            return offline_saved_confirmation(facts, draft) + '\nPay together or separately?'
        result = ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'Booking WH-RESTART saved.'},
            rewrite_callback=author, saved_booking_projection=reopened['completion'])
        self.assertTrue(captured, result)
        self.assertFalse(captured[-1].get('ask_payment_amount'), captured[-1])
        self.assertTrue(captured[-1]['ask_payment_distribution'])
        self.assertIn('together or separately', result['final_response'])
        self.assertNotIn('deposit or full', result['final_response'].lower())
        state = ledger._read_owner_state(lambda state, _: deepcopy(state))
        self.assertEqual(state['completion_plan']['payment_choice'], 'full')
        self.assertEqual(state['plan']['payment_choice'], 'full')
        self.assertEqual(state['outbound_question']['options'], ['together', 'separate'])
        descriptor = state['outbound_question']
        committed = ledger.commit_question_outbound(
            result['final_response'], descriptor['kind'], descriptor['options'])
        self.assertEqual(committed['question']['options'], ['together', 'separate'])
        self.assertEqual(committed['question']['status'], 'open')
        self.assertNotIn('confirmation_owed', state)

    def test_metadata_failure_rolls_back_transcript_and_counter(self):
        from wolfhouse import accepted_quote as ledger
        import sqlite3
        conn = self.case.db._conn
        before = conn.execute('SELECT message_count FROM sessions').fetchall()
        conn.execute("CREATE TRIGGER reject_question BEFORE INSERT ON state_meta BEGIN SELECT RAISE(ABORT, 'metadata rejected'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            ledger.commit_question_outbound('Shuttle?', 'add_on', ['accepted', 'declined'])
        self.assertEqual(conn.execute('SELECT count(*) FROM messages').fetchone()[0], 0)
        self.assertEqual(conn.execute('SELECT message_count FROM sessions').fetchall(), before)
        self.assertFalse(ledger._read_owner_state(lambda s, _: s.get('pending_question')))

    def test_unsupported_question_options_fail_closed(self):
        from wolfhouse import accepted_quote as ledger
        for kind, options in [('names', ['Riley']), ('add_on', ['full', 'deposit'])]:
            with self.subTest(kind=kind), self.assertRaises(q.QuestionLedgerError):
                ledger.commit_question_outbound('Unsupported?', kind, options)
        self.assertEqual(self.case.db._conn.execute('SELECT count(*) FROM messages').fetchone()[0], 0)

    def test_question_failure_rolls_back_transcript(self):
        from wolfhouse import accepted_quote as ledger
        self.assertTrue(callable(getattr(ledger, 'commit_question_outbound', None)), 'atomic outbound API missing')
        before = self.case.db._conn.execute('SELECT count(*) FROM messages').fetchone()[0]
        with self.assertRaises(q.QuestionLedgerError):
            ledger.commit_question_outbound('Invalid', 'invalid', ['yes', 'no'])
        self.assertEqual(self.case.db._conn.execute('SELECT count(*) FROM messages').fetchone()[0], before)

if __name__ == '__main__': unittest.main()
