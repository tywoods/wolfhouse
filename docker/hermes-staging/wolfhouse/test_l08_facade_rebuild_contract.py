"""BC-L08-FACADE-PREP: consumer behavior, not a rebuilt facade or release gate.

Use Seadog #1723 (L08-A + S14) read-only to expose current facade defects.
No guessed API, substitute owner, counterfeit producer result,
booking/payment table, registered create or network operation. The exact prep
base predates S14; owner-dependent cases fail explicitly there (no skip/xfail).
See docs/reviews/bc-l08-facade-prep.md for the reference command and limitations.
"""
from copy import deepcopy
from unittest.mock import patch

from gateway import session_context
from wolfhouse import accepted_quote as owner
from wolfhouse import booking_names as facade
from wolfhouse.test_l08_atomic_conversion_contract import _OwnerFixture, PHONE


SCOPE = {'tenant': 'wolfhouse-somo', 'location': '', 'phone': PHONE}
LEGACY = {'guest_name': 'Legacy contact',
          'guests': [{'name': 'Lead'}, {'name': 'Morgan'}]}
CURRENT = {'guest_name': 'Current contact',
           'guests': [{'name': 'Lead'}, {'name': 'Casey'}]}


class _FacadeFixture(_OwnerFixture):
    def setUp(self):
        super().setUp()
        # Real trusted-agent binding seam used by the ordinary facade hook.
        # No conversation-loop replacement or global SessionDB observer install.
        token = facade._agent.set(self.agent)
        invalid = facade._invalidated.set(False)
        self.addCleanup(lambda: facade._agent.reset(token))
        self.addCleanup(lambda: facade._invalidated.reset(invalid))
        self.addCleanup(facade.end_turn)

    def bind(self, *, history=()):
        return facade.begin_turn(session_id=self.agent.session_id,
                                 scope=deepcopy(SCOPE), conversation_history=history)

    def reopen_facade(self):
        facade.end_turn()
        self.reopen()
        self.bind()

    def legacy(self):
        return self.seed_legacy(LEGACY)

    def decision(self, payload):
        before = deepcopy(payload)
        result = facade.create_decision(payload, SCOPE)
        self.assertEqual(payload, before, 'facade must not mutate explicit intent')
        self.assertIn(result.get('outcome'), {'ready', 'standalone'},
                      'identity continuity/clarification must never veto agreed save')
        return result

    def reject_legacy_write(self):
        for operation in ('INSERT', 'UPDATE'):
            self.db._execute_write(lambda conn, op=operation: conn.execute(f'''
                CREATE TRIGGER facade_reject_legacy_{op.lower()} BEFORE {op} ON state_meta
                WHEN NEW.key LIKE 'wolfhouse.booking_names.v2:%'
                BEGIN SELECT RAISE(ABORT, 'offline legacy compatibility write rejected'); END
            '''))


class NativeFacadeControls(_FacadeFixture):
    """These qualify actual facade binding and fixtures, not the requested fix."""
    def test_real_committed_legacy_fixture_is_reached_not_transcript_restored(self):
        self.legacy()
        self.assertIsNotNone(self.bind(history=[{'role': 'user', 'content': 'Name is Invented'}]))
        result = facade.apply_names({'guest_count': 2}, SCOPE)
        self.assertEqual(result['guest_name'], LEGACY['guest_name'])
        self.assertEqual(result['guests'], LEGACY['guests'])

    def test_explicit_input_and_count_aliases_remain_detached(self):
        self.legacy()
        self.bind()
        payload = {'guest_name': 'Explicit', 'guest_count': 3, 'num_guests': 3,
                   'guests': [{'name': 'Explicit occupant'}], 'confirm': True}
        before = deepcopy(payload)
        projected = facade.apply_names(payload, SCOPE)
        projected['guests'][0]['name'] = 'Mutated output'
        self.assertEqual(payload, before)
        self.assertEqual(projected['guest_count'], 3)
        self.assertEqual(projected['num_guests'], 3)

    def test_foreign_facade_scope_does_not_borrow_identity(self):
        self.legacy()
        self.bind()
        payload = {'confirm': True}
        before = self.snapshot()
        self.assertEqual(facade.apply_names(payload, {**SCOPE, 'phone': 'foreign'}), payload)
        self.assertEqual(self.snapshot(), before)


class _OwnerApiFixture(_FacadeFixture):
    def setUp(self):
        super().setUp()
        for method in ('read_booking_identity', 'apply_booking_identity',
                       'adopt_legacy_booking_identity'):
            if not callable(getattr(owner, method, None)):
                self.fail('PREP PREREQUISITE RED: real owner API missing: ' + method
                          + '; run the pinned read-only L08-A reference, never a stub')

    def current(self, values=CURRENT):
        record = owner.apply_booking_identity(deepcopy(values))
        self.assertEqual(self.identity(), record, 'independent committed SQL readback')
        return record


class OwnerApiReferenceControls(_OwnerApiFixture):
    """The actual approved owner API is used, not synthetic owner-shaped rows."""
    def test_real_public_correction_and_clear_survive_reopen(self):
        self.current(LEGACY)
        changed = self.current()
        self.assertEqual(changed['revision'], 2)
        self.reopen()
        self.assertEqual(owner.read_booking_identity(), changed)
        cleared = self.current({'guest_name': None, 'guests': []})
        self.assertEqual(cleared['tombstones'], ['guest_name', 'guests'])
        self.reopen()
        self.assertEqual(owner.read_booking_identity(), cleared)

    def test_real_atomic_adoption_result_and_revision_rejection_are_reached(self):
        self.legacy()
        source = self.legacy_rows()
        adopted = owner.adopt_legacy_booking_identity(legacy_version=2, expected_revision=0)
        self.assertEqual(adopted['outcome'], 'adopted')
        self.assertEqual(adopted['identity']['values'], LEGACY)
        self.assertEqual(self.identity(), adopted['identity'])
        not_adopted = owner.adopt_legacy_booking_identity(legacy_version=2, expected_revision=0)
        self.assertEqual(not_adopted, {'outcome': 'not_adopted', 'reason': 'revision_changed',
                                      'identity': adopted['identity']})
        self.assertEqual(self.legacy_rows(), source)

    def test_real_public_owner_write_fault_rolls_back_without_altering_input(self):
        import sqlite3
        before = self.current()
        self.reject_owner_write()
        payload = {'guest_name': 'Explicit new', 'confirm': True}
        original = deepcopy(payload)
        with self.assertRaisesRegex(sqlite3.IntegrityError, 'offline conversion write rejected'):
            owner.apply_booking_identity(payload)
        self.assertEqual(payload, original)
        self.assertEqual(self.identity(), before)


class FacadeRebuildContracts(_OwnerApiFixture):
    """Consumer semantics bound to #1723; spies always invoke the real owner."""
    def test_virgin_bind_calls_the_real_atomic_api_with_current_revision(self):
        self.legacy()
        with patch.object(owner, 'adopt_legacy_booking_identity',
                          wraps=owner.adopt_legacy_booking_identity) as adoption:
            self.bind()
        adoption.assert_called_once_with(legacy_version=2, expected_revision=0)
        self.assertEqual(owner.read_booking_identity()['values'], LEGACY)

    def test_revision_race_before_atomic_entry_uses_the_real_not_adopted_identity(self):
        self.legacy()
        original = owner.adopt_legacy_booking_identity
        observed = []

        def interleaved(*, legacy_version, expected_revision):
            # Commit a genuine S14 correction between the caller snapshot and
            # entry into the genuine atomic API. No fabricated API response.
            self.current()
            result = original(legacy_version=legacy_version, expected_revision=expected_revision)
            observed.append(deepcopy(result))
            return result

        with patch.object(owner, 'adopt_legacy_booking_identity', side_effect=interleaved) as adoption:
            self.bind()
        adoption.assert_called_once_with(legacy_version=2, expected_revision=0)
        self.assertEqual(observed[0]['outcome'], 'not_adopted')
        self.assertEqual(observed[0]['reason'], 'revision_changed')
        self.assertEqual(observed[0]['identity']['values'], CURRENT)
        projected = facade.apply_names({'guest_count': 2}, SCOPE)
        self.assertEqual(projected['guest_name'], CURRENT['guest_name'])
        self.assertEqual(projected['guests'], CURRENT['guests'])
        self.assertEqual(owner.read_booking_identity(), observed[0]['identity'])

    def test_virgin_owner_adopts_committed_legacy_once_and_reopen_keeps_it(self):
        self.legacy()
        self.assertEqual(owner.read_booking_identity()['revision'], 0)
        source = self.legacy_rows()
        self.bind()
        adopted = owner.read_booking_identity()
        self.assertEqual(adopted['values'], LEGACY, 'facade must use atomic owner adoption')
        self.assertGreater(adopted['revision'], 0)
        self.assertEqual(self.legacy_rows(), source)
        self.reopen_facade()
        self.assertEqual(owner.read_booking_identity(), adopted, 'no repeated adoption/revision bump')

    def test_owner_correction_outweighs_legacy_on_sparse_projection(self):
        self.legacy()
        expected = self.current()
        self.bind()
        result = facade.apply_names({'guest_count': 2}, SCOPE)
        self.assertEqual(result['guest_name'], CURRENT['guest_name'])
        self.assertEqual(result['guests'], CURRENT['guests'])
        self.assertEqual(owner.read_booking_identity(), expected)

    def test_owner_clear_is_not_resurrected_from_legacy(self):
        self.legacy()
        expected = self.current({'guest_name': None, 'guests': []})
        self.bind()
        result = facade.apply_names({'guest_count': 2}, SCOPE)
        self.assertIsNone(result.get('guest_name'))
        self.assertEqual(result.get('guests'), [])
        self.assertEqual(owner.read_booking_identity(), expected)

    def test_owner_correction_after_facade_binding_is_read_fresh(self):
        self.legacy()
        self.current(LEGACY)
        self.bind()
        epoch = self.owner_state()['epoch']
        expected = self.current()
        self.assertEqual(self.owner_state()['epoch'], epoch, 'identity revision is a separate fence')
        projected = facade.apply_names({'guest_count': 2}, SCOPE)
        self.assertEqual(projected['guests'], CURRENT['guests'])
        self.assertEqual(owner.read_booking_identity(), expected)

    def test_owner_clear_after_facade_binding_is_read_fresh(self):
        self.legacy()
        self.current(LEGACY)
        self.bind()
        expected = self.current({'guest_name': None, 'guests': []})
        projected = facade.apply_names({'guest_count': 2}, SCOPE)
        self.assertEqual(projected.get('guests'), [])
        self.assertIsNone(projected.get('guest_name'))
        self.assertEqual(owner.read_booking_identity(), expected)

    def test_explicit_alias_is_captured_before_owner_projection_not_from_enriched_payload(self):
        self.legacy()
        self.current()
        self.bind()
        state = self.owner_state()
        payload = {'name': 'Explicit correction', 'guest_count': 2,
                   'confirm': True, 'total_cents': 12345}
        original = deepcopy(payload)
        facade.apply_names(payload, SCOPE)
        record = owner.read_booking_identity()
        self.assertEqual(record['values']['guest_name'], 'Explicit correction')
        self.assertEqual(record['values']['guests'], CURRENT['guests'])
        self.assertEqual(payload, original)
        after = self.owner_state()
        after.pop('booking_identity')
        state.pop('booking_identity')
        self.assertEqual(after, state, 'identity capture cannot confer price, plan or consent authority')

    def test_explicit_clear_is_captured_as_owner_tombstones(self):
        self.legacy()
        self.current()
        self.bind()
        facade.apply_names({'guest_name': None, 'guests': []}, SCOPE)
        record = owner.read_booking_identity()
        self.assertEqual(record['values'], {'guest_name': None, 'guests': []})
        self.assertEqual(record['tombstones'], ['guest_name', 'guests'])

    def test_begin_and_capture_do_not_rewrite_legacy_authority(self):
        self.legacy()
        self.current()
        source = self.legacy_rows()
        self.bind()
        facade.remember_names({'guest_name': 'Explicit correction'}, SCOPE)
        self.assertEqual(self.legacy_rows(), source, 'no regenerated legacy authority or dual write')
        self.assertEqual(owner.read_booking_identity()['values']['guest_name'], 'Explicit correction')

    def test_agreed_partial_roster_does_not_produce_a_create_veto(self):
        self.legacy()
        self.current({'guest_name': 'Lead', 'guests': [{'name': 'Lead'}]})
        self.bind()
        payload = {'confirm': True, 'guest_count': 3, 'num_guests': 3}
        decision = self.decision(payload)
        self.assertEqual(decision['payload']['guest_count'], 3)
        self.assertEqual(decision['payload']['num_guests'], 3)
        self.assertEqual(decision['payload']['guests'], [{'name': 'Lead'}])

    def test_party_clarification_predicate_cannot_veto_agreed_save(self):
        self.legacy()
        self.current({'guest_name': 'Lead', 'guests': [{'name': 'Lead'}]})
        self.bind()
        self.assertFalse(facade.needs_party_clarification({'confirm': True, 'guest_count': 3}, SCOPE),
                         'missing identity can be advisory, not a save-blocking predicate')

    def test_legacy_party_count_does_not_infer_limit_or_block_current_intent(self):
        self.legacy()  # synthetic historical party_count=99, not current authority
        self.current()
        self.bind()
        result = self.decision({'confirm': True})
        for key in ('guest_count', 'num_guests', 'count'):
            self.assertNotIn(key, result['payload'])
        self.assertEqual(result['payload']['guests'], CURRENT['guests'])

    def test_real_owner_write_failure_preserves_explicit_create_intent(self):
        self.legacy()
        current = self.current()
        self.bind()
        source = self.legacy_rows()
        self.reject_owner_write()
        attempted = []
        # Instrument real SQL only; do not substitute an owner/DB implementation.
        self.db._conn.set_trace_callback(lambda sql: attempted.append(True)
            if sql.lstrip().upper().startswith(('INSERT', 'UPDATE'))
            and 'wolfhouse.accepted_quote.v1:' in sql else None)
        payload = {'confirm': True, 'guest_count': 2, 'guest_name': 'Explicit new',
                   'guests': [{'name': 'Explicit one'}, {'name': 'Explicit two'}]}
        try:
            result = self.decision(payload)
        finally:
            self.db._conn.set_trace_callback(None)
        self.assertTrue(attempted, 'must actually encounter the injected owner SQL write fault')
        self.assertEqual(result['payload'], payload, 'no stale/guessed replacement for explicit intent')
        self.assertEqual(self.identity(), current)
        self.assertEqual(self.legacy_rows(), source)

    def test_legacy_compatibility_write_failure_is_not_a_create_veto(self):
        self.legacy()
        self.current()
        self.bind()
        source = self.legacy_rows()
        self.reject_legacy_write()
        payload = {'confirm': True, 'guest_count': 2, **deepcopy(CURRENT)}
        result = self.decision(payload)
        self.assertEqual(result['payload'], payload)
        self.assertEqual(self.legacy_rows(), source)

    def test_changed_runtime_owner_scope_does_not_leak_retained_names(self):
        self.legacy()
        self.current()
        self.bind()
        before = self.snapshot()
        var = session_context._VAR_MAP['HERMES_SESSION_CHAT_ID']
        token = var.set('different-chat')
        try:
            self.assertEqual(facade.apply_names({'confirm': True}, SCOPE), {'confirm': True})
        finally:
            var.reset(token)
        self.assertEqual(self.snapshot(), before)

    def test_closed_owner_does_not_leak_still_bound_legacy_names(self):
        self.legacy()
        self.current()
        self.bind()
        before = self.snapshot()
        owner.close_turn()
        self.assertEqual(facade.apply_names({'confirm': True}, SCOPE), {'confirm': True})
        self.assertEqual(self.snapshot(), before)

    def test_semantic_intake_uses_owner_identity_not_legacy_names(self):
        self.legacy()
        self.current()
        self.bind()
        intake = facade.name_intake_state({'guest_count': 2}, SCOPE)
        self.assertEqual(intake['guest_name'], CURRENT['guest_name'])
        self.assertFalse(intake['contact_name_needed'])
        self.assertEqual(intake['missing_occupant_count'], 0)
