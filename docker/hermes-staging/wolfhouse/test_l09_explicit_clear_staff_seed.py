"""C26 qualification on the named L08 base; real clear, reopen and registered hook.

Native AQ/SessionDB and facade APIs are unchanged; only Staff HTTP responses are
explicit offline fixtures. No CRM deletion, production changes or model calls.
The model-context contract is deliberately separate from durable identity truth.
"""
from copy import deepcopy
from contextlib import closing
import json
from pathlib import Path
import socket
import sqlite3
import unittest
from unittest.mock import patch

from gateway.session_context import set_session_vars, clear_session_vars
from hermes_state import SessionDB
from wolfhouse import accepted_quote as owner, booking_names as names
from wolfhouse import test_always_save as saved
from wolfhouse.test_l08_atomic_conversion_contract import _OwnerFixture, PHONE
from wolfhouse_staff_api.test_persist_guest_names import Registry
import wolfhouse_staff_api as plugin

SCOPE = {'tenant': 'wolfhouse-somo', 'location': '', 'phone': PHONE}
OLD = 'Offline Old contact'


class ClearStaffSeedTests(_OwnerFixture):
    def setUp(self):
        super().setUp()
        token = names._agent.set(self.agent)
        self.addCleanup(lambda: names._agent.reset(token))
        self.addCleanup(names.end_turn)
        self.crm = {'full_name': OLD}
        self.calls = []
        self.enterContext(patch.object(plugin, '_session_guest_phone', return_value=PHONE))
        self.enterContext(patch.object(plugin, '_booking_name_scope', return_value=deepcopy(SCOPE)))
        self.enterContext(patch.object(plugin, '_post_bot', side_effect=self.staff))
        self.registry = Registry()
        plugin.register(self.registry)

    def staff(self, route, body, **kwargs):
        self.calls.append((route, deepcopy(body)))
        if route == '/contact-identity' and body == {}:
            return {'success': True, **deepcopy(self.crm)}
        if route == '/staff/bot/bookings/confirmation-preview':
            return {'success': False, 'error': 'offline_history_unavailable'}
        self.fail('Unexpected Staff write/route in clear/seed qualification: ' + route)

    def hook(self):
        return self.registry.hooks['pre_llm_call'](
            session_id=self.agent.session_id, user_message='Offline continuation')

    def capture(self, payload):
        return json.loads(self.registry.tools['capture_booking_names']['handler'](deepcopy(payload)))

    def cleared_then_reopened(self):
        self.hook()
        self.assertEqual(self.identity()['values']['guest_name'], OLD, 'real initial Staff seed reached')
        # Persist a real roster before the clear; no owner-shaped counterfeit.
        names.remember_names({'guests': [{'name': 'Offline old occupant'}]}, SCOPE)
        response = self.capture({'clear': True})
        self.assertTrue(response['success'], response)
        self.assertEqual(response['status'], 'saved')
        self.assertEqual(response['names'], {'guest_name': None, 'guests': []})
        cleared = self.identity()  # Independent SQLite connection, not response.
        self.assertEqual(cleared['values'], {'guest_name': None, 'guests': []})
        self.assertEqual(cleared['tombstones'], ['guest_name', 'guests'])
        before_db = self.db
        names.end_turn()
        self.reopen()  # Close the real DB object, reopen the actual same DB file.
        self.assertIsNot(self.db, before_db)
        self.assertEqual(self.identity(), cleared, 'clear survives native DB reopen before seed')
        self.calls.clear()
        return cleared, self.hook()

    def assert_no_crm_mutation(self):
        self.assertEqual(self.crm, {'full_name': OLD})
        self.assertTrue(any(route == '/contact-identity' for route, _ in self.calls))
        self.assertTrue(all(body == {} for route, body in self.calls if route == '/contact-identity'))

    def test_clear_reopen_old_staff_seed_retains_canonical_tombstone(self):
        cleared, context = self.cleared_then_reopened()
        self.assertEqual(self.identity(), cleared, 'old Staff seed cannot resurrect canonical contact')
        self.assertTrue(context['name_intake']['contact_name_needed'])
        self.assertFalse(context['name_intake']['contact_seeded'])
        self.assert_no_crm_mutation()
        print(json.dumps({'case': 'C26_durable', 'revision_unchanged': self.identity() == cleared,
                          'tombstones': cleared['tombstones'], 'contact_seeded': False,
                          'real_reopen': True, 'crm_writes': 0}, sort_keys=True))

    def test_clear_reopen_old_staff_name_is_not_republished_as_known_model_identity(self):
        cleared, context = self.cleared_then_reopened()
        self.assertEqual(self.identity(), cleared)
        self.assert_no_crm_mutation()
        self.assertNotIn(OLD, context['context'],
                         'registered pre-LLM context must honor session clear, not reassert raw CRM name')
        self.assertFalse(context.get('known_contact_name'), 'no known session contact after explicit clear')

    def test_virgin_session_still_accepts_staff_seed(self):
        context = self.hook()
        self.assertEqual(self.identity()['values']['guest_name'], OLD)
        self.assertTrue(context['name_intake']['contact_seeded'])
        self.assertFalse(context['name_intake']['contact_name_needed'])
        self.assert_no_crm_mutation()

    def test_new_explicit_booking_identity_after_clear_is_not_a_facade_save_veto(self):
        _, _context = self.cleared_then_reopened()
        payload = {'confirm': True, 'guest_count': 2, 'guest_name': 'Offline new contact',
                   'guests': [{'name': 'Offline new first'}, {'name': 'Offline new second'}]}
        before = deepcopy(payload)
        decision = names.create_decision(payload, SCOPE)
        self.assertEqual(decision['outcome'], 'ready')
        self.assertEqual(decision['payload'], before)
        self.assertEqual(payload, before)
        self.assertEqual(self.identity()['tombstones'], [])
        self.assertEqual(self.identity()['values']['guest_name'], payload['guest_name'])
        self.assert_no_crm_mutation()

    def test_session_forget_does_not_clear_other_same_phone_session(self):
        cleared, _ = self.cleared_then_reopened()
        original_session = self.agent.session_id
        names.end_turn()
        self.agent.session_id = 'l09-other-session'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn()
        self.hook()
        self.assertEqual(self.identity()['values']['guest_name'], OLD, 'CRM identity still available in another session')
        names.end_turn()
        self.agent.session_id = original_session
        self.turn()
        self.hook()
        self.assertEqual(self.identity(), cleared, 'original session clear remains scoped and durable')
        self.assert_no_crm_mutation()


class ClearedSessionSavedBookingTests(unittest.TestCase):
    """Unchanged Staff JS/PGlite booking/bed INSERT/COMMIT fixture, no fake save.

    Quote/availability/guest-row/link edges retain their explicit offline fixtures.
    This proves a supplied booking identity can save, not a full live HTTP flow.
    """
    setUp = saved.PersistedOwnerAlwaysSaveTests.setUp
    tearDown = saved.PersistedOwnerAlwaysSaveTests.tearDown
    call = saved.PersistedOwnerAlwaysSaveTests.call
    staff = saved.PersistedOwnerAlwaysSaveTests.staff
    prepare_fixture = saved.PersistedOwnerAlwaysSaveTests.prepare_fixture
    persisted_staff = saved.PersistedOwnerAlwaysSaveTests.persisted_staff
    assert_persisted = saved.PersistedOwnerAlwaysSaveTests.assert_persisted

    def test_registered_clear_reopen_seed_then_supplied_identity_reaches_real_booking_commit(self):
        self.prepare_fixture()
        self.enterContext(patch.object(plugin, '_session_guest_phone', return_value=PHONE))
        self.enterContext(patch.object(plugin, '_booking_name_scope', return_value=deepcopy(SCOPE)))
        self.enterContext(patch.object(socket.socket, 'connect',
            side_effect=AssertionError('Offline C26 proof forbids network')))
        token = names._agent.set(self.agent)
        self.addCleanup(lambda: names._agent.reset(token))
        self.addCleanup(names.end_turn)
        self.registry = Registry()
        plugin.register(self.registry)
        db_path = Path(self.temp.name) / 'state.db'
        turn_sequence = 0

        def bind():
            nonlocal turn_sequence
            turn_sequence += 1
            owner.close_turn()
            clear_session_vars(self.tokens)
            self.tokens = set_session_vars(platform='whatsapp', source='whatsapp',
                chat_id=PHONE, user_id=PHONE, session_key='l09-sql-save',
                session_id=self.agent.session_id, message_id=f'l09-supplied-identity-{turn_sequence}')
            owner.observe_owner_turn(self.agent, 'Please save this synthetic booking.')

        def identity():
            with closing(sqlite3.connect(db_path)) as conn:
                records = [json.loads(value) for (value,) in conn.execute(
                    "SELECT value FROM state_meta WHERE key LIKE 'wolfhouse.accepted_quote.v1:%'")]
            state = next(row for row in records if row['scope']['ID'] == self.agent.session_id
                         and row['scope']['CHAT_ID'] == PHONE)
            return state['booking_identity']

        def transport(route, body):
            if route == '/contact-identity':
                self.assertEqual(body, {}, 'session forget must not delete/change CRM')
                self.calls.append((route, deepcopy(body)))
                return {'success': True, 'full_name': OLD}
            if route == '/staff/bot/bookings/confirmation-preview':
                return {'success': False, 'error': 'offline_history_unavailable'}
            return self.persisted_staff(route, body)

        bind()
        for key in ('quote_args', 'create_args'):
            self.case[key]['phone'] = PHONE
        with patch.object(plugin, '_post_bot', side_effect=transport):
            self.registry.hooks['pre_llm_call'](session_id=self.agent.session_id)
            self.assertEqual(identity()['values']['guest_name'], OLD)
            cleared = self.call('capture_booking_names', {'clear': True})
            self.assertTrue(cleared['success'])
            tombstone = identity()
            self.assertEqual(tombstone['tombstones'], ['guest_name', 'guests'])
            names.end_turn()
            owner.close_turn()
            before_db = self.db
            self.db.close()
            self.db = self.agent._session_db = SessionDB(db_path)
            self.assertIsNot(self.db, before_db)
            bind()
            self.registry.hooks['pre_llm_call'](session_id=self.agent.session_id)
            self.assertEqual(identity(), tombstone, 'old Staff seed still cannot rewrite the owner')
            self.assertTrue(self.call('quote_booking', deepcopy(self.case['quote_args']))['success'])
            result = self.call('create_booking_from_plan', deepcopy(self.case['create_args']))
        self.assert_persisted(result)  # Actual SQL COMMIT + independent booking/bed SELECT.
        self.assertEqual(identity()['values']['guest_name'], self.case['quote_args']['guest_name'])
        self.assertFalse(identity()['tombstones'])
        self.assertTrue(all(body == {} for route, body in self.calls if route == '/contact-identity'))
        print(json.dumps({'case': 'C26_saved_booking', 'booking_id': result['booking_id'],
                          'booking_rows': len(self.persisted[0]['bookings']),
                          'bed_rows': len(self.persisted[0]['beds']),
                          'commits': self.persisted[0]['commits'], 'crm_writes': 0}, sort_keys=True))
