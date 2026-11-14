"""Owner API only: no registered tools, booking_names hooks or live calls."""
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from gateway.session_context import set_session_vars, clear_session_vars
from hermes_state import SessionDB
from wolfhouse import accepted_quote as owner


class IdentityOwnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.path = Path(self.temp.name) / 'state.db'
        self.db = SessionDB(self.path)
        self.db.create_session('identity-owner', source='whatsapp')
        self.agent = SimpleNamespace(_session_db=self.db, session_id='identity-owner')
        self.env = patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'})
        self.env.start()
        self.tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='chat',
                                      user_id='guest', session_key='key',
                                      session_id=self.agent.session_id, message_id='m1')
        owner.observe_owner_turn(self.agent, 'hello')

    def tearDown(self):
        owner.close_turn()
        clear_session_vars(self.tokens)
        self.env.stop()
        self.agent._session_db.close()
        self.temp.cleanup()

    def reopen(self):
        owner.close_turn()
        self.agent._session_db.close()
        self.db = self.agent._session_db = SessionDB(self.path)
        clear_session_vars(self.tokens)
        self.message = getattr(self, 'message', 1) + 1
        self.tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='chat',
                                      user_id='guest', session_key='key',
                                      session_id=self.agent.session_id, message_id=f'm{self.message}')
        owner.observe_owner_turn(self.agent, 'hello')

    def test_corrections_and_tombstones_survive_reopen_without_resurrection(self):
        owner.apply_booking_identity({'guest_name': 'Alex', 'guests': [{'name': 'Old'}]})
        corrected = owner.apply_booking_identity({'guests': [{'name': 'Correct'}]})
        self.assertEqual(corrected['revision'], 2)
        self.reopen()
        self.assertEqual(owner.read_booking_identity(), corrected)
        cleared = owner.apply_booking_identity({'guests': [], 'guest_name': None})
        self.assertEqual(cleared, {'revision': 3, 'values': {'guests': [], 'guest_name': None},
                                  'tombstones': ['guest_name', 'guests']})
        self.reopen()
        self.assertEqual(owner.apply_booking_identity({'confirm': True}), cleared)
        self.assertEqual(owner.apply_booking_identity({'guests': None, 'guest_name': ''}), cleared)
        self.assertEqual(owner.read_booking_identity(), cleared)
        restored = owner.apply_booking_identity({'guest_name': 'New'})
        self.assertEqual(restored['tombstones'], ['guests'])
        self.assertEqual(restored['values']['guests'], [])

    def test_projection_rejects_bad_types_and_strips_nonidentity_guest_fields(self):
        record = owner.apply_booking_identity({'guests': [
            {'name': 'Alex', 'explicit_gender': 'female', 'total_cents': 99, 'confirm': True}]})
        self.assertEqual(record['values']['guests'], [{'name': 'Alex', 'explicit_gender': 'female'}])
        for bad in (None, [], {'guest_name': 1}, {'guests': {}}, {'guests': [False]},
                    {'guests': [{'name': 1}]}):
            with self.subTest(payload=bad), self.assertRaisesRegex(
                    owner.QuoteBoundaryError, 'booking_identity_payload_invalid'):
                owner.apply_booking_identity(bad)
            self.assertEqual(owner.read_booking_identity(), record)

    def test_contact_and_row_aliases_have_one_slot_including_clears(self):
        aliases = ('guest_name', 'name', 'booking_name', 'channel_guest_name',
                   'whatsapp_guest_name')
        for alias in aliases:
            with self.subTest(alias=alias):
                owner.apply_booking_identity({'guest_name': 'Old'})
                corrected = owner.apply_booking_identity({alias: 'Correct'})
                self.assertEqual(corrected['values'], {'guest_name': 'Correct'})
                cleared = owner.apply_booking_identity({alias: None})
                self.assertEqual(cleared['values'], {'guest_name': None})
                self.assertEqual(cleared['tombstones'], ['guest_name'])
        # First present alias wins, even when it explicitly clears; never truthiness.
        for first, second in zip(aliases, aliases[1:]):
            record = owner.apply_booking_identity({second: 'Ignored', first: ''})
            self.assertEqual(record['values'], {'guest_name': None})
        record = owner.apply_booking_identity({'guests': [
            {'guest_name': 'Alias'}, {'guest_name': 'Ignored', 'name': None},
            {'guest_name': 'Ignored', 'name': 'Canonical'}]})
        self.assertEqual(record['values']['guests'],
                         [{'name': 'Alias'}, {'name': None}, {'name': 'Canonical'}])
        self.reopen()
        self.assertEqual(owner.read_booking_identity(), record)

    def test_malformed_record_is_not_returned_or_overwritten(self):
        for bad in (None, {}, {'revision': True, 'values': {}, 'tombstones': []},
                    {'revision': 1, 'values': {'confirm': True}, 'tombstones': []},
                    {'revision': 1, 'values': {'guests': []}, 'tombstones': []}):
            owner._transaction(lambda state, scope: state.update(booking_identity=bad))
            for call in (owner.read_booking_identity,
                         lambda: owner.apply_booking_identity({'guest_name': 'New'})):
                with self.subTest(record=bad), self.assertRaisesRegex(
                        owner.QuoteBoundaryError, 'booking_identity_invalid'):
                    call()

    def test_persisted_values_must_be_canonical_valid_projection(self):
        for values in ({'guests': 'not-a-roster'}, {'guests': [False]},
                       {'guests': [{'name': 1}]}, {'guest_name': 1},
                       {'guests': [{'name': 'Alex', 'total_cents': 99}]},
                       {'guests': [{'explicit_gender': []}]},
                       {'guest_name': 'Old', 'name': 'Correct'},
                       {'guests': [{'guest_name': 'Alias'}]}, {'email': ''}):
            bad = {'revision': 1, 'values': values, 'tombstones': []}
            owner._transaction(lambda state, scope: state.update(booking_identity=bad))
            for call in (owner.read_booking_identity,
                         lambda: owner.apply_booking_identity({'guest_name': 'New'})):
                with self.subTest(values=values, call=call), self.assertRaisesRegex(
                        owner.QuoteBoundaryError, 'booking_identity_invalid'):
                    call()
                self.assertEqual(owner._read_owner_state(
                    lambda state, scope: state['booking_identity']), bad)

    def test_owner_write_trigger_rollback_preserves_explicit_caller_payload(self):
        from copy import deepcopy
        import sqlite3

        before = owner.apply_booking_identity({'guest_name': 'Old'})
        payload = {'name': 'Correct', 'guests': [{'guest_name': 'Correct'}],
                   'confirm': True, 'total_cents': 123}
        original = deepcopy(payload)
        self.db._execute_write(lambda conn: conn.execute('''
            CREATE TRIGGER reject_owner_write BEFORE INSERT ON state_meta
            BEGIN SELECT RAISE(ABORT, 'owner write rejected'); END
        '''))
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'owner write rejected'):
            owner.apply_booking_identity(payload)
        self.assertEqual(payload, original)
        self.assertEqual(owner.read_booking_identity(), before)
        self.db._execute_write(lambda conn: conn.execute('DROP TRIGGER reject_owner_write'))
        self.reopen()
        self.assertEqual(owner.read_booking_identity(), before)

    def test_owner_scope_and_lifecycle_safeguards(self):
        owner.apply_booking_identity({'guest_name': 'Private'})
        capability = owner._current.get()
        for field in ('CHAT_ID', 'USER_ID', 'KEY', 'ID', 'PLATFORM', 'THREAD_ID', 'SOURCE'):
            from gateway import session_context
            var = session_context._VAR_MAP['HERMES_SESSION_' + field]
            token = var.set('other')
            try:
                for call in (owner.read_booking_identity, lambda: owner.apply_booking_identity({})):
                    with self.subTest(field=field), self.assertRaises(owner.QuoteBoundaryError):
                        call()
            finally:
                var.reset(token)
        with patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'other'}):
            with self.assertRaises(owner.QuoteBoundaryError):
                owner.read_booking_identity()
        self.db._execute_write(lambda conn: conn.execute(
            'UPDATE sessions SET ended_at=1 WHERE id=?', (self.agent.session_id,)))
        with self.assertRaisesRegex(owner.QuoteBoundaryError, 'quote_owner_ended'):
            owner.read_booking_identity()
        owner.close_turn()
        with self.assertRaisesRegex(owner.QuoteBoundaryError, 'quote_owner_turn_missing'):
            owner.apply_booking_identity({})
        owner._current.set(capability)
        with self.assertRaisesRegex(owner.QuoteBoundaryError, 'quote_owner_turn_closed'):
            owner.read_booking_identity()

    def test_sparse_detached_identity_and_stable_revision(self):
        self.assertEqual(owner.read_booking_identity(),
                         {'revision': 0, 'values': {}, 'tombstones': []})
        payload = {'guest_name': 'Alex', 'guests': [{'name': 'Alex'}],
                   'confirm': True, 'total_cents': 100, 'check_in': '2026-12-01'}
        record = owner.apply_booking_identity(payload)
        self.assertEqual(record, {'revision': 1, 'values': {'guest_name': 'Alex',
                         'guests': [{'name': 'Alex'}]}, 'tombstones': []})
        payload['guests'][0]['name'] = 'input mutation'
        record['values']['guests'][0]['name'] = 'output mutation'
        read = owner.read_booking_identity()
        read['values']['guests'].clear()
        self.assertEqual(owner.apply_booking_identity({'guest_name': 'Alex'})['revision'], 1)
        self.assertEqual(owner.read_booking_identity()['values']['guests'], [{'name': 'Alex'}])
        self.assertEqual(owner._read_owner_state(lambda state, scope: state['status']), 'empty')
