"""BC-L08-PREP: executable proposal, NOT an implementation or release gate.

Run NativePreconditions alone for existing-owner/real-SQLite controls. Run
AtomicConversionContract for the proposed API: intentionally RED until Cap rules
and Seadog supplies it. No skip, xfail, mock owner, monkeypatched implementation,
booking/payment tables, network, facade hooks, or runtime changes are used.
Base bd48250a3ce111a744fec28c5c939a451e3b5cac also predates S14's public API.
"""
from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
import socket
import sqlite3
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from gateway import session_context
from gateway.session_context import set_session_vars, clear_session_vars
from hermes_state import SessionDB
from wolfhouse import accepted_quote as owner


EMPTY = {'revision': 0, 'values': {}, 'tombstones': []}
LEGACY_PREFIX = 'wolfhouse.booking_names.v2:'
PHONE = '+999' + '88001001'  # inert reserved test identity; never sent anywhere


class _OwnerFixture(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(prefix='l08-prep-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'state.db'
        self.db = SessionDB(self.path)
        self.agent = SimpleNamespace(_session_db=self.db, session_id='l08-prep-session')
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.addCleanup(lambda: self.agent._session_db.close())
        self.enterContext(patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}))
        self.enterContext(patch.object(socket.socket, 'connect',
                                      side_effect=AssertionError('No network in L08 prep')))
        self.tokens = None
        self.message = 0
        self.addCleanup(self.close_context)
        self.turn()

    def close_context(self):
        owner.close_turn()
        if self.tokens is not None:
            clear_session_vars(self.tokens)
            self.tokens = None

    def turn(self):
        self.close_context()
        self.message += 1
        self.tokens = set_session_vars(platform='whatsapp', source='whatsapp',
            chat_id=PHONE, user_id=PHONE, session_key='l08-prep-key',
            session_id=self.agent.session_id, message_id=f'prep-{self.message}')
        owner.observe_owner_turn(self.agent, 'Offline identity contract observation')

    def reopen(self):
        self.close_context()
        self.db.close()
        self.db = self.agent._session_db = SessionDB(self.path)
        self.turn()

    def snapshot(self):
        # Independent connection/readback, not an API's returned projection.
        with closing(sqlite3.connect(self.path)) as conn:
            return dict(conn.execute('SELECT key,value FROM state_meta ORDER BY key'))

    def identity(self):
        rows = [json.loads(value) for key, value in self.snapshot().items()
                if key.startswith('wolfhouse.accepted_quote.v1:')]
        state = next(row for row in rows if row['scope']['ID'] == self.agent.session_id)
        return deepcopy(state.get('booking_identity', EMPTY))

    def owner_state(self):
        return owner._read_owner_state(lambda state, scope: deepcopy(state))

    def seed_current(self, values, *, revision=1, tombstones=()):
        # Synthetic S14-shaped fixture data written by the REAL native owner
        # transaction. This is not a stand-in implementation of any public API.
        record = {'revision': revision, 'values': deepcopy(values),
                  'tombstones': sorted(tombstones)}
        owner._transaction(lambda state, scope: state.update(booking_identity=record))
        return record

    def seed_legacy(self, names=None, *, session_id=None):
        session_id = session_id or self.agent.session_id
        row = self.db.get_session(session_id)
        epoch_key = '!epoch:l08-prep-' + session_id
        record = {'version': 2,
            'scope': {'tenant': 'wolfhouse-somo', 'location': '', 'phone': PHONE},
            'started_at': row['started_at'], 'generation': 'stored-legacy-generation',
            'names': deepcopy(names if names is not None else {
                'guest_name': 'Legacy', 'guests': [{'name': 'Legacy occupant'}]}),
            'epoch_key': epoch_key, 'epoch': 'stored-legacy-epoch', 'party_count': 99}
        self.put_legacy(epoch_key, {'epoch': record['epoch'],
                                   'witnesses': {session_id: row['started_at']}})
        self.put_legacy(session_id, record)
        return record

    def put_legacy(self, key, value):
        self.db._execute_write(lambda conn: conn.execute(
            'INSERT OR REPLACE INTO state_meta(key,value) VALUES (?,?)',
            (LEGACY_PREFIX + key, json.dumps(value, sort_keys=True))))

    def legacy_rows(self):
        return {key: value for key, value in self.snapshot().items()
                if key.startswith(LEGACY_PREFIX)}

    def reject_owner_write(self):
        for operation in ('INSERT', 'UPDATE'):
            self.db._execute_write(lambda conn, op=operation: conn.execute(f'''
                CREATE TRIGGER prep_reject_{op.lower()} BEFORE {op} ON state_meta
                WHEN NEW.key LIKE 'wolfhouse.accepted_quote.v1:%'
                BEGIN SELECT RAISE(ABORT, 'offline conversion write rejected'); END
            '''))


class NativePreconditions(_OwnerFixture):
    """Green fixture/auth/rollback controls available on the assigned base."""
    def test_native_owner_and_stored_legacy_fixture_survive_real_reopen(self):
        current = self.seed_current({'guest_name': 'Current'})
        legacy = self.seed_legacy()
        rows = self.legacy_rows()
        self.reopen()
        self.assertEqual(self.identity(), current)
        self.assertEqual(self.legacy_rows(), rows)
        self.assertEqual(json.loads(rows[LEGACY_PREFIX + self.agent.session_id]), legacy)

    def test_native_owner_transaction_fault_rolls_back_real_sql(self):
        before = self.seed_current({'guest_name': 'Current'})
        snapshot = self.snapshot()
        self.reject_owner_write()
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'offline conversion write rejected'):
            self.seed_current({'guest_name': 'Must roll back'}, revision=2)
        self.assertEqual(self.snapshot(), snapshot)
        self.assertEqual(self.identity(), before)

    def test_native_owner_scope_and_closed_turn_checks_are_real(self):
        self.seed_current({'guest_name': 'Current'})
        before = self.snapshot()
        var = session_context._VAR_MAP['HERMES_SESSION_CHAT_ID']
        token = var.set('foreign-chat')
        try:
            with self.assertRaises(owner.QuoteBoundaryError):
                self.owner_state()
        finally:
            var.reset(token)
        owner.close_turn()
        with self.assertRaises(owner.QuoteBoundaryError):
            self.owner_state()
        self.assertEqual(self.snapshot(), before)


class AtomicConversionContract(_OwnerFixture):
    """Proposed API contract; missing API is an explicit assertion failure."""
    def api(self):
        method = getattr(owner, 'adopt_legacy_booking_identity', None)
        if not callable(method):
            self.fail('PREP RED: proposed owner.adopt_legacy_booking_identity is not implemented; '
                      'Cap ruling and producer work are pending (no local substitute)')
        return method

    def adopt(self, *, legacy_version=2, expected_revision=0):
        return self.api()(legacy_version=legacy_version, expected_revision=expected_revision)

    def unchanged(self, reason, before, *, expected_revision=0, legacy_version=2):
        result = self.adopt(legacy_version=legacy_version, expected_revision=expected_revision)
        self.assertEqual(result, {'outcome': 'not_adopted', 'reason': reason,
                                  'identity': self.identity()})
        self.assertEqual(self.snapshot(), before)
        return result

    def test_adopts_stored_legacy_once_and_survives_reopen(self):
        self.api()
        legacy = self.seed_legacy()
        before, source = self.owner_state(), self.legacy_rows()
        result = self.adopt()
        expected = {'revision': 1, 'values': legacy['names'], 'tombstones': []}
        self.assertEqual(result, {'outcome': 'adopted', 'reason': 'adopted', 'identity': expected})
        self.assertEqual(self.identity(), expected)
        after = self.owner_state()
        after.pop('booking_identity')
        self.assertEqual(after, before, 'identity import is not plan, consent, epoch or save authority')
        self.assertEqual(self.legacy_rows(), source, 'party_count=99 is neither imported nor a gate')
        self.unchanged('current_identity', self.snapshot(), expected_revision=1)
        self.reopen()
        self.assertEqual(self.identity(), expected)
        self.unchanged('current_identity', self.snapshot(), expected_revision=1)

    def test_reads_legacy_without_refreshing_invalidating_or_dual_writing(self):
        self.api()
        self.seed_legacy()
        source = self.legacy_rows()
        for operation in ('INSERT', 'UPDATE', 'DELETE'):
            ref = 'OLD' if operation == 'DELETE' else 'NEW'
            self.db._execute_write(lambda conn, op=operation, obj=ref: conn.execute(f'''
                CREATE TRIGGER prep_no_legacy_{op.lower()} BEFORE {op} ON state_meta
                WHEN {obj}.key LIKE 'wolfhouse.booking_names.v2:%'
                BEGIN SELECT RAISE(ABORT, 'legacy is read-only'); END
            '''))
        self.assertEqual(self.adopt()['outcome'], 'adopted')
        self.assertEqual(self.legacy_rows(), source)

    def test_missing_source_is_not_adopted(self):
        self.api()
        self.unchanged('no_legacy', self.snapshot())

    def test_unsupported_conversion_version_is_not_adopted(self):
        self.api()
        self.seed_legacy()
        self.unchanged('unsupported_version', self.snapshot(), legacy_version=1)

    def test_invalid_request_types_do_not_mutate_owner(self):
        api = self.api()
        self.seed_legacy()
        for key in ('legacy_version', 'expected_revision'):
            for bad in (True, None, '2', -1, 2.0):
                with self.subTest(field=key, value=bad):
                    args = {'legacy_version': 2, 'expected_revision': 0, key: bad}
                    before = self.snapshot()
                    with self.assertRaisesRegex(owner.QuoteBoundaryError,
                                                'booking_identity_legacy_request_invalid'):
                        api(**args)
                    self.assertEqual(self.snapshot(), before)

    def test_caller_cannot_supply_a_roster_or_source_scope(self):
        api = self.api()
        before = self.snapshot()
        for extra in ({'names': {'guest_name': 'Forged'}}, {'session_id': 'foreign'},
                      {'scope': {'tenant': 'wolfhouse-somo', 'phone': PHONE}}):
            with self.subTest(extra=extra), self.assertRaises(TypeError):
                api(legacy_version=2, expected_revision=0, **extra)
            self.assertEqual(self.snapshot(), before)

    def test_any_current_fact_prevents_even_partial_legacy_filling(self):
        self.api()
        self.seed_legacy()
        current = self.seed_current({'guest_name': 'Current'})
        self.unchanged('current_identity', self.snapshot(), expected_revision=1)
        self.assertEqual(self.identity(), current)

    def test_current_tombstones_are_never_resurrected(self):
        self.api()
        self.seed_legacy()
        for values, tombstones in (({'guest_name': None}, ['guest_name']),
                                   ({'guests': []}, ['guests'])):
            with self.subTest(clear=tombstones):
                current = self.seed_current(values, tombstones=tombstones)
                self.unchanged('current_identity', self.snapshot(), expected_revision=1)
                self.assertEqual(self.identity(), current)

    def test_malformed_owner_identity_is_never_treated_as_virgin(self):
        self.api()
        self.seed_legacy()
        owner._transaction(lambda state, scope: state.update(booking_identity=None))
        before = self.snapshot()
        with self.assertRaisesRegex(owner.QuoteBoundaryError, 'booking_identity_invalid'):
            self.adopt()
        self.assertEqual(self.snapshot(), before)

    def test_legacy_clears_are_canonical_tombstones_only_in_a_virgin_owner(self):
        self.api()
        self.seed_legacy({'guest_name': '', 'guests': []})
        expected = {'revision': 1, 'values': {'guest_name': None, 'guests': []},
                    'tombstones': ['guest_name', 'guests']}
        self.assertEqual(self.adopt()['identity'], expected)
        self.assertEqual(self.identity(), expected)
        self.seed_legacy({'guest_name': 'Must not resurrect', 'guests': [{'name': 'Old'}]})
        self.reopen()
        self.unchanged('current_identity', self.snapshot(), expected_revision=1)
        self.assertEqual(self.identity(), expected)

    def test_current_revision_prevents_import_even_if_values_are_empty(self):
        self.api()
        self.seed_legacy()
        self.seed_current({}, revision=2)
        self.unchanged('current_identity', self.snapshot(), expected_revision=2)

    def test_revision_race_keeps_actual_new_correction_and_tombstone(self):
        self.api()
        self.seed_legacy()
        old_revision = self.identity()['revision']
        # Deterministic outside-read/current-write/import interleaving, with a
        # real committed native transaction, not a fake public API response.
        current = self.seed_current({'guest_name': 'Current', 'guests': []},
                                    tombstones=['guests'])
        self.unchanged('revision_changed', self.snapshot(), expected_revision=old_revision)
        self.assertEqual(self.identity(), current)

    def test_all_authoritative_reads_are_under_one_real_sqlite_write_lease(self):
        api = self.api()
        self.seed_legacy()
        events, rival_attempts = [], []
        rival = sqlite3.connect(self.path, timeout=0, isolation_level=None)
        self.addCleanup(rival.close)
        def trace(sql):
            text = sql.upper()
            events.append((text, self.db._conn.in_transaction))
            if 'SELECT' in text and ('STATE_META' in text or 'FROM SESSIONS' in text):
                try:
                    rival.execute('BEGIN IMMEDIATE')
                except sqlite3.OperationalError as error:
                    rival_attempts.append(('blocked', error.sqlite_errorcode))
                else:
                    rival_attempts.append(('acquired', None))
                    rival.rollback()
        self.db._conn.set_trace_callback(trace)
        try:
            result = api(legacy_version=2, expected_revision=0)
        finally:
            self.db._conn.set_trace_callback(None)
        self.assertEqual(result['outcome'], 'adopted')
        reads = [(sql, active) for sql, active in events if 'SELECT' in sql
                 and ('STATE_META' in sql or 'FROM SESSIONS' in sql)]
        self.assertTrue(reads, 'must actually read stored scope, identity, source and witnesses')
        self.assertTrue(all(active for _, active in reads), events)
        self.assertTrue(rival_attempts, 'independent SQLite connection must exercise the lease')
        self.assertTrue(all(status == 'blocked' and code == sqlite3.SQLITE_BUSY
                            for status, code in rival_attempts), rival_attempts)
        self.assertEqual(sum(sql.startswith('BEGIN IMMEDIATE') for sql, _ in events), 1)
        self.assertEqual(sum(sql.startswith('COMMIT') for sql, _ in events), 1)

    def test_foreign_or_invalid_stored_legacy_is_not_adopted_or_repaired(self):
        self.api()
        original = self.seed_legacy()
        invalid = []
        for field, value in (('tenant', 'foreign'), ('phone', 'foreign'), ('location', 'unbound')):
            record = deepcopy(original)
            record['scope'][field] = value
            invalid.append(record)
        for field, value in (('started_at', -1), ('version', 2.0), ('generation', ''),
                             ('epoch', 'revoked'), ('epoch_key', '!epoch:missing'),
                             ('names', {'guests': [False]})):
            record = deepcopy(original)
            record[field] = value
            invalid.append(record)
        for record in invalid:
            with self.subTest(record=record):
                self.put_legacy(self.agent.session_id, record)
                self.unchanged('invalid_legacy', self.snapshot())

    def test_reset_family_witness_invalidates_source_without_revocation_writes(self):
        self.api()
        record = self.seed_legacy()
        self.db.create_session('reset-witness', source='whatsapp')
        witness = self.db.get_session('reset-witness')
        self.put_legacy(record['epoch_key'], {'epoch': record['epoch'], 'witnesses': {
            self.agent.session_id: record['started_at'], 'reset-witness': witness['started_at']}})
        self.db.end_session('reset-witness', 'reset')
        self.unchanged('invalid_legacy', self.snapshot())

    def test_missing_current_source_never_borrows_another_session(self):
        self.api()
        self.db.create_session('foreign-session', source='whatsapp')
        self.seed_legacy(session_id='foreign-session')
        self.unchanged('no_legacy', self.snapshot())

    def test_real_sql_write_fault_rolls_back_import_and_does_not_change_explicit_intent(self):
        self.api()
        self.seed_legacy()
        intent = {'confirm': True, 'guest_name': 'Explicit current name', 'guest_count': 1}
        untouched, before = deepcopy(intent), self.snapshot()
        self.reject_owner_write()
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'offline conversion write rejected'):
            self.adopt()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(intent, untouched)
        # No registered create is called in this prep. This is NOT proof that a
        # consumer handles the optional error and proceeds to save; L08 must prove it.

    def test_authenticated_scope_changes_are_not_rebound_from_legacy_metadata(self):
        self.api()
        self.seed_legacy()
        before = self.snapshot()
        for field in ('CHAT_ID', 'USER_ID', 'KEY', 'ID', 'PLATFORM', 'THREAD_ID', 'SOURCE'):
            var = session_context._VAR_MAP['HERMES_SESSION_' + field]
            token = var.set('foreign')
            try:
                with self.subTest(field=field), self.assertRaises(owner.QuoteBoundaryError):
                    self.adopt()
            finally:
                var.reset(token)
            self.assertEqual(self.snapshot(), before)
        with patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'foreign'}):
            with self.assertRaises(owner.QuoteBoundaryError):
                self.adopt()
        self.assertEqual(self.snapshot(), before)

    def test_ended_owner_session_cannot_import_legacy(self):
        self.api()
        self.seed_legacy()
        self.db.end_session(self.agent.session_id, 'reset')
        before = self.snapshot()
        with self.assertRaises(owner.QuoteBoundaryError):
            self.adopt()
        self.assertEqual(self.snapshot(), before)

    def test_closed_or_superseded_owner_cannot_import_legacy(self):
        self.api()
        self.seed_legacy()
        owner._transaction(lambda state, scope: state.update(epoch=state['epoch'] + 1))
        before = self.snapshot()
        with self.assertRaisesRegex(owner.QuoteBoundaryError, 'quote_owner_superseded'):
            self.adopt()
        owner.close_turn()
        with self.assertRaisesRegex(owner.QuoteBoundaryError, 'quote_owner_turn_missing'):
            self.adopt()
        self.assertEqual(self.snapshot(), before)


if __name__ == '__main__':
    unittest.main()
