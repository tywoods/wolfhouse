"""Offline: genuine adoption SQL fault -> registered create -> real booking INSERT.

Reuses the unchanged always-save Staff builder/executor/PGlite boundary. Atomic
booking/bed SQL and independent SELECT/COMMIT receipts are real. Quote,
availability, guest-row adapter and payment-link edges remain explicit fixtures;
no production HTTP middleware, live database, guest send or provider call.
"""
from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
import socket
import sqlite3
import unittest
from unittest.mock import patch

from gateway.session_context import set_session_vars, clear_session_vars
from wolfhouse import accepted_quote as owner, booking_names as facade
from wolfhouse import test_always_save as saved
import wolfhouse_staff_api as plugin
from wolfhouse.test_l08_atomic_conversion_contract import _OwnerFixture, PHONE as FIXTURE_PHONE

PHONE = '+999' + '88001031'
PREFIX = 'wolfhouse.booking_names.v2:'


class OptionalAdoptionSaveTests(unittest.TestCase):
    setUp = saved.PersistedOwnerAlwaysSaveTests.setUp
    tearDown = saved.PersistedOwnerAlwaysSaveTests.tearDown
    call = saved.PersistedOwnerAlwaysSaveTests.call
    staff = saved.PersistedOwnerAlwaysSaveTests.staff
    prepare_fixture = saved.PersistedOwnerAlwaysSaveTests.prepare_fixture
    persisted_staff = saved.PersistedOwnerAlwaysSaveTests.persisted_staff
    assert_persisted = saved.PersistedOwnerAlwaysSaveTests.assert_persisted

    def legacy_rows(self):
        with closing(sqlite3.connect(Path(self.temp.name) / 'state.db')) as conn:
            return dict(conn.execute("SELECT key,value FROM state_meta WHERE key LIKE ? ORDER BY key",
                                     (PREFIX + '%',)))

    def test_real_failed_adoption_never_blocks_the_registered_booking_insert(self):
        self.prepare_fixture()
        # Use a provable, reserved direct WhatsApp identity for the real importer.
        owner.close_turn()
        clear_session_vars(self.tokens)
        self.tokens = set_session_vars(platform='whatsapp', source='whatsapp',
            chat_id=PHONE, user_id=PHONE, session_key='l08-save-key',
            session_id=self.agent.session_id, message_id='l08-save-explicit')
        owner.observe_owner_turn(self.agent, 'Please save this synthetic booking.')
        for key in ('quote_args', 'create_args'):
            self.case[key]['phone'] = PHONE
        self.enterContext(patch.object(plugin, '_session_guest_phone', return_value=PHONE))
        self.enterContext(patch.object(socket.socket, 'connect',
                                      side_effect=AssertionError('Offline proof: no network')))
        token = facade._agent.set(self.agent)
        self.addCleanup(lambda: facade._agent.reset(token))
        self.addCleanup(facade.end_turn)
        scope = {'tenant': 'wolfhouse-somo', 'location': '', 'phone': PHONE}
        row = self.db.get_session(self.agent.session_id)
        epoch_key = '!epoch:l08-sql-save'
        source = {'version': 2, 'scope': scope, 'started_at': row['started_at'],
                  'generation': 'offline-legacy', 'names': {'guest_name': 'Legacy migration only',
                  'guests': [{'name': 'Old one'}, {'name': 'Old two'}]},
                  'epoch_key': epoch_key, 'epoch': 'offline-epoch', 'party_count': 99}
        authority = {'epoch': source['epoch'], 'witnesses': {self.agent.session_id: row['started_at']}}
        for key, value in ((self.agent.session_id, source), (epoch_key, authority)):
            self.db._execute_write(lambda conn, k=key, v=value: conn.execute(
                'INSERT INTO state_meta(key,value) VALUES (?,?)', (PREFIX + k, json.dumps(v))))
        legacy_before = self.legacy_rows()
        # Reject only the optional import's new identity, not primary owner/save
        # writes. The exception must originate in real SQLite, not a mock API.
        self.db._execute_write(lambda conn: conn.execute('''
            CREATE TRIGGER reject_optional_adoption BEFORE INSERT ON state_meta
            WHEN NEW.key LIKE 'wolfhouse.accepted_quote.v1:%'
              AND json_extract(NEW.value, '$.booking_identity.values.guest_name')='Legacy migration only'
            BEGIN SELECT RAISE(ABORT, 'offline optional adoption rejected'); END
        '''))
        real_adoption = owner.adopt_legacy_booking_identity
        failures = []

        def observed_adoption(**kwargs):
            try:
                return real_adoption(**kwargs)
            except sqlite3.IntegrityError as error:
                failures.append(type(error).__name__)
                raise

        with patch.object(owner, 'adopt_legacy_booking_identity', side_effect=observed_adoption) as adoption:
            with self.assertLogs(facade.__name__, level='WARNING') as diagnostics:
                facade.begin_turn(session_id=self.agent.session_id, scope=scope)
            adoption.assert_called_once_with(legacy_version=2, expected_revision=0)
        self.assertEqual(failures, ['IntegrityError'])
        self.assertEqual(owner.read_booking_identity()['revision'], 0, 'real SQL rollback')
        self.assertTrue(any('stage=adoption class=IntegrityError' in line for line in diagnostics.output))
        self.assertEqual(self.legacy_rows(), legacy_before)
        with patch.object(plugin, '_post_bot', side_effect=self.persisted_staff):
            quote = self.call('quote_booking', deepcopy(self.case['quote_args']))
            self.assertTrue(quote['success'], quote)
            result = self.call('create_booking_from_plan', deepcopy(self.case['create_args']))
        # Unchanged fixture assertions require COMMIT + independent SELECT of an
        # actual booking_id, original money/dates, and both ordered bed rows.
        self.assert_persisted(result)
        self.assertEqual(self.legacy_rows(), legacy_before)
        self.assertEqual(owner.read_booking_identity()['values']['guest_name'],
                         self.case['quote_args']['guest_name'])
        self.assertEqual(sum(path == '/booking-create-from-plan' for path, _ in self.calls), 1)
        self.assertFalse(any(path == '/conversation/needs-human' for path, _ in self.calls))
        print(json.dumps({'offline_adoption_fault': failures[0], 'adoption_calls': adoption.call_count,
                          'booking_id': result['booking_id'], 'commits': self.persisted[0]['commits'],
                          'booking_rows': len(self.persisted[0]['bookings']),
                          'bed_rows': len(self.persisted[0]['beds'])}, sort_keys=True))


class OwnerFacadeBoundaryTests(_OwnerFixture):
    def setUp(self):
        super().setUp()
        facade.end_turn()
        token = facade._agent.set(self.agent)
        self.addCleanup(lambda: facade._agent.reset(token))
        self.addCleanup(facade.end_turn)
        self.scope = {'tenant': 'wolfhouse-somo', 'location': '', 'phone': FIXTURE_PHONE}

    def test_corrected_occupants_reach_create_after_real_db_reopen(self):
        obsolete = {'guest_name': 'Obsolete contact',
                    'guests': [{'name': 'Old first'}, {'name': 'Old second'}]}
        self.seed_legacy(obsolete)
        legacy_before = self.legacy_rows()
        facade.begin_turn(session_id=self.agent.session_id, scope=self.scope)
        # A different public-owner writer corrects and reorders the occupants
        # after facade binding; no caller roster is supplied to create below.
        corrected = {'guest_name': 'Corrected contact', 'guests': [
            {'name': 'Second now first', 'explicit_gender': 'female'},
            {'name': 'First now second', 'explicit_gender': 'male'}]}
        expected = owner.apply_booking_identity(deepcopy(corrected))
        self.assertEqual(self.identity(), expected, 'independent SQLite readback')
        payload = {'confirm': True, 'guest_count': 2, 'num_guests': 2}
        for phase in ('after_correction', 'after_reopen'):
            with self.subTest(phase=phase):
                if phase == 'after_reopen':
                    prior_db = self.db
                    facade.end_turn()
                    self.reopen()  # Close actual SessionDB and reopen its file.
                    self.assertIsNot(self.db, prior_db)
                    facade.begin_turn(session_id=self.agent.session_id, scope=self.scope,
                        conversation_history=[{'role': 'assistant',
                            'content': 'Summary with obsolete occupants; never authority.'}])
                explicit_before = deepcopy(payload)
                decision = facade.create_decision(payload, self.scope)
                self.assertEqual(decision['outcome'], 'ready')
                self.assertEqual(decision['payload'], {**payload, **corrected})
                self.assertEqual(decision['names'], corrected)
                self.assertEqual(payload, explicit_before, 'explicit intent stays detached')
                self.assertEqual(self.identity(), expected, 'no stale import/revision bump')
                self.assertEqual(self.legacy_rows(), legacy_before)

    def test_uninitialized_names_preflight_is_not_a_create_permission_gate(self):
        before = self.snapshot()
        payload = {'confirm': True, 'guest_count': 3}
        decision = facade.create_decision(payload, self.scope)
        self.assertEqual(decision['outcome'], 'ready')
        self.assertEqual(decision['payload'], payload)
        self.assertIsNone(decision['names'])
        self.assertEqual(self.snapshot(), before)

    def test_trusted_profile_seed_cannot_resurrect_an_explicit_owner_clear(self):
        cleared = owner.apply_booking_identity({'guest_name': None, 'guests': []})
        facade.begin_turn(session_id=self.agent.session_id, scope=self.scope)
        intake = facade.seed_contact_name('Profile label', self.scope, source='whatsapp')
        self.assertFalse(intake['contact_seeded'])
        self.assertTrue(intake['contact_name_needed'])
        self.assertEqual(owner.read_booking_identity(), cleared)

    def test_compression_before_names_preflight_never_copies_legacy_authority(self):
        self.seed_legacy()
        before = self.legacy_rows()
        parent = self.agent.session_id

        def compress():
            self.db.create_session('l08-child', source='whatsapp', parent_session_id=parent)
            self.agent.session_id = 'l08-child'
            return 'native-compression-result'

        self.agent._compress_context = compress
        facade._observe_compression(self.agent)
        self.assertEqual(self.agent._compress_context(), 'native-compression-result')
        self.assertEqual(self.legacy_rows(), before)
