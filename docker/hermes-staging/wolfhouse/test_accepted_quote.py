"""Offline owner-ledger tracer bullet; real Hermes SessionDB, no business writes."""
import hashlib
import json
import re
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

from wolfhouse.test_first_yes_owner import offline_quote_result


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
                    offline_quote_result(
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

    def test_saved_confirmation_keeps_money_without_inventing_checkout_policy(self):
        from wolfhouse import accepted_quote
        plan = {'guests': [{'name': 'Alex'}, {'name': 'Sam'}], 'language': 'en'}
        offer = {'total_cents': 69800, 'deposit_required_cents': 40000}
        receipt = {
            'booking_code': 'WH-20270424-00000001',
            'amount_due_cents': 40000, 'remaining_balance_cents': 29800,
            'guest_payment_links': [
                {'guest_name': 'Alex', 'amount_due_cents': 20000,
                 'secure_payment_url': 'https://pay.invalid/alex'},
                {'guest_name': 'Sam', 'amount_due_cents': 20000,
                 'secure_payment_url': 'https://pay.invalid/sam'}],
            'payment_status': 'not_requested',
        }
        original = deepcopy((plan, offer, receipt))
        facts = accepted_quote._saved_confirmation_facts(plan, offer, receipt)
        self.assertEqual(facts['reference'], receipt['booking_code'])
        self.assertEqual(facts['total_cents'], 69800)
        self.assertEqual(facts['deposit_cents'], 40000)
        self.assertEqual(facts['amount_due_now_cents'], 40000)
        self.assertEqual(facts['remains_owed_cents'], 29800)
        self.assertEqual(facts['payment_links'], [
            'https://pay.invalid/alex', 'https://pay.invalid/sam'])
        self.assertEqual((plan, offer, receipt), original)
        self.assertNotIn('balance_settlement', facts)

    def test_stay_arrival_policy_cannot_be_deferred_by_addon_guidance(self):
        soul = (Path(__file__).resolve().parents[1] / 'SOUL.md').read_text()
        confirmation = soul.split('**When:** Immediately after the booking is saved', 1)[1]
        confirmation = confirmation.split('A null `room_name`', 1)[0]
        self.assertIn('stay remainder is due at arrival/check-in, never checkout', confirmation)
        self.assertIn('rephrasing or translating an earlier confirmation', confirmation)
        self.assertIn('zero', confirmation)
        addons = soul.split('**Post-booking add-ons (existing booking):**', 1)[1]
        addons = addons.split('**Meals & yoga', 1)[0]
        self.assertIn('service charges at checkout', addons)
        self.assertIn('does not defer the original stay remainder', addons)
        self.assertIn('arrival/check-in', addons)
        self.assertNotIn('Guests can pay the balance link now or settle at checkout', addons)

    def test_saved_confirmation_rewrite_supplies_exact_guest_display_amounts(self):
        from wolfhouse import accepted_quote
        facts = {
            'reference': 'WH-20270622-00994446',
            'total_cents': 24900,
            'amount_due_now_cents': 10000,
            'remains_owed_cents': 14900,
            'payment_links': ['https://pay.invalid/test'],
            'location_url': 'https://maps.invalid/wolfhouse',
            'room_type': 'shared',
            'room': ['R3'],
            'rewrite_context': {'language': 'es'},
        }
        payload = accepted_quote._confirmation_rewrite_payload(
            facts, 'borrador inválido', ['total_amount_not_stated:249,00 €'])
        self.assertEqual(payload['required_guest_facts'], {
            'booking_reference': 'WH-20270622-00994446',
            'total': '249,00 €',
            'amount_due_now': '100,00 €',
            'remaining_balance': '149,00 €',
            'payment_links': ['https://pay.invalid/test'],
            'saved_room_type': 'shared',
            'saved_room_numbers': ['R3'],
            'location_url': 'https://maps.invalid/wolfhouse',
        })
        self.assertIn('required_guest_facts', payload['requirements'])
        self.assertIn('copy each displayed value exactly', payload['requirements'])

    def test_saved_confirmation_accepts_model_json_envelope_as_guest_prose(self):
        from wolfhouse import accepted_quote
        facts = {
            'reference': 'WH-20270706-11698858',
            'total_cents': 29900,
            'amount_due_now_cents': 10000,
            'remains_owed_cents': 19900,
            'payment_links': ['https://pay.invalid/test'],
            'location_url': 'https://maps.invalid/wolfhouse',
            'rewrite_context': {'language': 'es'},
        }
        prose = ('Reserva WH-20270706-11698858 confirmada. Total: 299,00 €. '
                 'Depósito ahora: 100,00 €. Saldo: 199,00 € a la llegada. '
                 'Paga aquí: https://pay.invalid/test Ubicación: '
                 'https://maps.invalid/wolfhouse')
        wrapped = ('```json\n' + json.dumps({
            'confirmation': prose, 'language': 'es', 'status': 'saved'
        }, ensure_ascii=False) + '\n```')

        self.assertEqual(
            accepted_quote._sendable_saved_confirmation(wrapped, facts), prose)

    def test_codex_confirmation_stream_uses_only_parts_from_its_own_call(self):
        from wolfhouse import accepted_quote
        agent = SimpleNamespace(
            model='gpt-test',
            _codex_streamed_text_parts=['Earlier guest reply with €999. '])
        expected = 'Reserva WH-TEST confirmada. Total 299,00 €.'

        def fake_run_codex_stream(owner, _payload, client=None):
            owner._codex_streamed_text_parts.append(expected)
            # Match the consumer's explicit successful terminal contract;
            # text alone is not evidence that this attempt completed.
            return SimpleNamespace(output_text=expected, status='completed',
                                   terminal_event_type='response.completed')

        runtime = SimpleNamespace(run_codex_stream=fake_run_codex_stream)
        with patch.dict(sys.modules, {'agent.codex_runtime': runtime}):
            actual = accepted_quote._run_codex_confirmation_stream(
                agent, object(), [
                    {'role': 'system', 'content': 'system'},
                    {'role': 'user', 'content': 'user'},
                ], 12)

        self.assertEqual(actual, expected)
        self.assertEqual(agent._codex_streamed_text_parts, [
            'Earlier guest reply with €999. '])

    def test_saved_confirmation_without_payment_link_can_still_be_valid(self):
        from wolfhouse import accepted_quote
        facts = {
            'reference': 'WH-20270914-10160299',
            'total_cents': 29900,
            'amount_due_now_cents': 10000,
            'remains_owed_cents': 19900,
            'payment_links': [],
            'location_url': 'https://maps.invalid/wolfhouse',
            'rewrite_context': {'language': 'es'},
        }
        prose = ('Reserva WH-20270914-10160299 guardada. Total: 299,00 €. '
                 'Depósito: 100,00 €. Quedan 199,00 € a la llegada. '
                 'La reserva está confirmada. '
                 'Ubicación: https://maps.invalid/wolfhouse')

        self.assertEqual(
            accepted_quote._sendable_saved_confirmation(prose, facts), prose)


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
        offline_quote_result({'completed': True, 'final_response': 'draft'})

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

    def accept(self, **checked_facts):
        self.turn('m2', 'I accept the quote')
        return self.checked_create(**checked_facts)

    def checked_create(self, params=None, beds=None, quote_overrides=None):
        """Unit Staff fixture, following the registered create/quote/create sequence.

        The typed create call is the scripted model decision; the diagnostic
        interpreter never supplies authority. Revalidation uses current checked
        fixture facts, not an accepted-state seed or a compatibility response.
        """
        params = {'confirm': True, **(params or {})}
        prepared = self.ledger.prepare_create(params)
        if prepared.revalidation:
            quote_plan = self.ledger.prepare_quote(dict(prepared))
            response = self.checked(quote_plan, beds, quote_overrides)
            self.ledger.record_quote(quote_plan, response)
            prepared = self.ledger.prepare_create(params)
        self.assertFalse(prepared.revalidation)
        self.assertTrue(prepared['confirm'])
        return prepared

    def checked(self, plan=None, beds=None, quote_overrides=None):
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        plan = plan or self.plan
        beds = beds or [dict(bed_code=code, room_code='M', gender_strategy='mixed')
                        for code in plan['selected_bed_codes']]
        return FirstYesOwnerTests._checked_offer(
            object.__new__(FirstYesOwnerTests), plan, beds, quote_overrides)

    def checked_requote(self, params):
        """Unit Staff quote fixture; unresolved payment remains provisional."""
        prepared = self.ledger.prepare_quote(params)
        response = self.checked({**prepared, 'payment_choice': prepared.get('payment_choice') or 'deposit'})
        if not prepared.get('payment_choice'):
            response['payment_choice_needed'] = True
        self.ledger.record_quote(prepared, response)
        return prepared

    def present(self, plan=None, response=None):
        plan = plan or self.plan
        response = response or self.checked(plan)
        self.ledger.record_quote(plan, response)
        offline_quote_result({'completed': True, 'final_response': 'draft'})
        return response

    def interpret(self, raw, action='accept', material_changes=None, completions=None,
                  ambiguous=False, negated=False, conditional=False):
        return self.ledger.interpret_owner_turn({
            'action': action, 'action_evidence': raw, 'ambiguous': ambiguous,
            'negated': negated, 'conditional': conditional,
            'material_changes': material_changes or [], 'completions': completions or {},
        })

    # Final Phase1B contract. These tests deliberately coexist with the legacy
    # mutating-interpreter tests below until their callers have been migrated.
    def _phase1b_rows(self):
        """Read bytes directly: _transaction is itself a writer, even for reads."""
        with self.db._lock:
            return {
                table: [tuple(row) for row in self.db._conn.execute(
                    f'SELECT * FROM {table} ORDER BY 1')]
                for table in ('state_meta', 'sessions')
            }

    def _phase1b_state(self):
        rows = self.db._conn.execute(
            "SELECT key,value FROM state_meta WHERE key LIKE 'wolfhouse.accepted_quote.%'"
        ).fetchall()
        self.assertEqual(len(rows), 1)
        return rows[0][0], json.loads(rows[0][1])

    def _phase1b_present_and_turn(self, raw='Please inspect the booking facts'):
        # Reuse the existing checked-offer fixture and genuine presentation
        # owner; literal 'draft' alone is not presentation evidence.
        self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft'}, None, None,
            lambda facts, _draft: f"Total €{facts['total_cents'] / 100:.2f}")
        self.turn('phase1b-diagnostic', raw)

    def _phase1b_legacy_payload(self, action='clarify', raw=None, **overrides):
        if raw is None:
            raw = self._phase1b_state()[1]['current_turn']['raw']
        return {
            'action': action, 'action_evidence': raw, 'ambiguous': False,
            'negated': False, 'conditional': False, 'material_changes': [],
            'completions': {}, **overrides,
        }

    def _phase1b_diagnose(self, payloads, *, useful=False, rejected=False):
        """Observe real writes after setup; never mock the ledger/SQL execution.

        The wraps spy delegates to SessionDB, and SQLite's trace sees actual
        executed SQL, including an INSERT OR REPLACE of unchanged JSON. Row
        bytes, total_changes and the live capability epoch are separate checks.
        Only external Staff I/O is denied. A diagnostic must not dispatch it.
        """
        import wolfhouse_staff_api as plugin
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        registry = Registry()
        plugin.register(registry)
        handler = registry.tools['interpret_booking_turn']['handler']
        results = []
        for index, payload in enumerate(payloads):
            before = self._phase1b_rows()
            bound = self.ledger._current.get()
            epoch = getattr(bound, 'epoch', None)
            changes = self.db._conn.total_changes
            statements = []
            # Install only after fixture initialization and remove before any
            # subsequent fixture mutation or teardown.
            self.db._conn.set_trace_callback(statements.append)
            try:
                with patch.object(self.db, '_execute_write',
                                  wraps=self.db._execute_write) as writer, \
                        patch.object(plugin, '_post_bot', side_effect=AssertionError(
                            'diagnostic attempted Staff I/O')) as staff:
                    result = json.loads(handler(
                        deepcopy(payload), task_id='diagnostic-task',
                        session_id='untrusted-metadata-session', user_task='inspect'))
            finally:
                self.db._conn.set_trace_callback(None)
            after = self._phase1b_rows()
            writes = [sql for sql in statements if re.match(
                r'^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|REINDEX|VACUUM)\b',
                sql, re.IGNORECASE)]
            changed_fields = []
            old_rows, new_rows = dict(before['state_meta']), dict(after['state_meta'])
            for key in old_rows.keys() | new_rows.keys():
                if old_rows.get(key) == new_rows.get(key):
                    continue
                try:
                    old_state = json.loads(old_rows.get(key, '{}'))
                    new_state = json.loads(new_rows.get(key, '{}'))
                    changed_fields.extend(sorted(
                        field for field in old_state.keys() | new_state.keys()
                        if old_state.get(field) != new_state.get(field)
                        or (field in old_state) != (field in new_state)))
                except (ValueError, AttributeError):
                    changed_fields.append('unparseable_record')
            print('PHASE1B_DIAGNOSTIC_OBSERVATION', json.dumps({
                'test': self._testMethodName, 'call': index,
                'payload': payload, 'writer_calls': writer.call_count,
                'sql_writes': [sql[:240] for sql in writes],
                'sqlite_changes': self.db._conn.total_changes - changes,
                'rows_unchanged': before == after,
                'changed_owner_fields': changed_fields,
                'capability_epoch_before': epoch,
                'capability_epoch_after': getattr(bound, 'epoch', None),
                'staff_attempts': staff.call_count, 'result': result,
            }, sort_keys=True), flush=True)
            for invariant, actual, expected in (
                ('SessionDB writer entry', writer.call_count, 0),
                ('actual SQL write attempts', [sql[:240] for sql in writes], []),
                ('SQLite total_changes', self.db._conn.total_changes, changes),
                ('persisted row bytes (all owner fields and session identity)', after, before),
                ('live capability epoch', getattr(bound, 'epoch', None), epoch),
                ('Staff/create attempts', staff.call_count, 0),
            ):
                with self.subTest(call=index, invariant=invariant):
                    self.assertEqual(actual, expected, invariant)
            with self.subTest(call=index, invariant='typed adapter result'):
                self.assertIsInstance(result, dict)
                self.assertIs(type(result.get('success')), bool, result)
            if rejected:
                with self.subTest(call=index, invariant='runtime refusal'):
                    self.assertTrue(
                        result.get('success') is False
                        or isinstance(result.get('warning'), str)
                        or isinstance(result.get('error'), str), result)
            if useful:
                with self.subTest(call=index, invariant='useful structured facts'):
                    self.assertIs(result.get('success'), True, result)
                    # Do not freeze an envelope/field layout. A bare success or
                    # diagnostic_only/write_performed/accepted=false warning is
                    # not a useful read of an existing valid offer. Any of these
                    # typed state facts may appear at any nesting level.
                    def facts(value):
                        if isinstance(value, dict):
                            for key, item in value.items():
                                if key in {
                                    'status', 'epoch', 'plan', 'quote', 'checked_offer',
                                    'presented_offer', 'pending_question', 'missing',
                                    'create_ready', 'question_required',
                                } and item is not None:
                                    yield key, item
                                yield from facts(item)
                        elif isinstance(value, list):
                            for item in value:
                                yield from facts(item)
                    found = list(facts(result))
                    self.assertTrue(found, result)
                    for key, value in found:
                        if key == 'epoch':
                            self.assertIs(type(value), int)
                        elif key in ('create_ready', 'question_required'):
                            self.assertIs(type(value), bool)
                        elif key == 'status':
                            self.assertIsInstance(value, str)
                        elif key == 'missing':
                            self.assertIsInstance(value, list)
                        else:
                            self.assertIsInstance(value, dict)
            results.append(result)
        return results

    def _phase1b_prepare_accepted(self):
        """Use direct create admission, not the soon-to-be-retired interpreter."""
        self._phase1b_present_and_turn('Yes, create this booking')
        prepared = self.ledger.prepare_create({})
        if prepared.revalidation:
            self.ledger.record_quote(prepared, self.response)
            prepared = self.ledger.prepare_create({})
        self.assertEqual(self._phase1b_state()[1]['status'], 'accepted')
        return prepared

    def test_phase1b_diagnostic_valid_read_has_useful_typed_facts_without_writes(self):
        self._phase1b_present_and_turn()
        self._phase1b_diagnose([{}], useful=True)

    def test_phase1b_diagnostic_repeated_read_is_stable_without_same_state_rewrite(self):
        self._phase1b_present_and_turn()
        first, repeated = self._phase1b_diagnose([{}, {}], useful=True)
        self.assertEqual(repeated, first)

    def test_phase1b_diagnostic_legacy_repeat_cannot_write_identical_state(self):
        self._phase1b_present_and_turn('Please clarify this offer')
        payload = self._phase1b_legacy_payload()
        first, repeated = self._phase1b_diagnose([payload, payload])
        self.assertEqual(repeated, first)

    def test_phase1b_diagnostic_malformed_and_unknown_actions_do_not_claim_turn(self):
        self._phase1b_present_and_turn()
        # The first malformed call must not poison the later ordinary read.
        for index, payload in enumerate(({'action': 'accept'},
                        self._phase1b_legacy_payload('unknown_action'),
                        self._phase1b_legacy_payload(completions=[]),
                        self._phase1b_legacy_payload(ambiguous='false'))):
            with self.subTest(payload=payload):
                # Each malformed proposal gets an unclaimed ingress, so an
                # earlier persisted digest cannot mask another mutation branch.
                self.turn('phase1b-malformed-' + str(index),
                          'Please inspect the booking facts')
                self._phase1b_diagnose([payload])
                self._phase1b_diagnose([{}], useful=True)

    def test_phase1b_diagnostic_legacy_accept_has_no_acceptance_authority(self):
        self._phase1b_present_and_turn('I accept the quote')
        self.assertEqual(self._phase1b_state()[1]['status'], 'offered')
        self._phase1b_diagnose([self._phase1b_legacy_payload('accept')])

    def test_phase1b_diagnostic_legacy_revise_cannot_revoke_or_advance_epoch(self):
        self._phase1b_prepare_accepted()
        self.turn('phase1b-revise', 'Change check_out to 2026-11-09')
        self._phase1b_diagnose([self._phase1b_legacy_payload(
            'revise', material_changes=[{'field': 'check_out', 'value': '2026-11-09',
                                        'evidence': '2026-11-09'}])])

    def test_phase1b_diagnostic_legacy_decline_cannot_revoke_acceptance(self):
        self._phase1b_prepare_accepted()
        self.turn('phase1b-decline', 'Cancel the entire booking')
        self._phase1b_diagnose([self._phase1b_legacy_payload('reject')])

    def test_phase1b_diagnostic_decline_offer_payload_has_no_authority(self):
        self._phase1b_prepare_accepted()
        self.turn('phase1b-decline-offer', 'Cancel the entire booking')
        self._phase1b_diagnose([self._phase1b_legacy_payload('decline_offer')])

    def test_phase1b_diagnostic_accepted_state_and_recovery_identity_are_immutable(self):
        self._phase1b_prepare_accepted()
        self.turn('phase1b-accepted-read', 'Please inspect the booking facts')
        before = self._phase1b_state()[1]
        self.assertTrue(before['acceptance_message'])
        self.assertTrue(before['acceptance_raw_digest'])
        self.assertTrue(before['operation_key'])
        self._phase1b_diagnose([{}], useful=True)

    def test_phase1b_diagnostic_pending_question_and_completions_are_not_answers(self):
        self._phase1b_present_and_turn('No shuttle; separate links; my name is Alex Smith')
        from wolfhouse import pending_question
        # Seed a real persisted pending descriptor, just as existing owner tests
        # do. All setup writes precede the observer.
        def pending(state, _ingress):
            pending_question.persist(state, 'add_on')
        self.ledger._transaction(pending)
        self._phase1b_diagnose([self._phase1b_legacy_payload(
            'clarify', completions={
                'guests': [{'guest_index': 0, 'name': 'Alex Smith', 'evidence': 'Alex Smith'}],
                'shuttle_choice': {'value': 'declined', 'evidence': 'No shuttle'},
                'payment_link_distribution': {'value': 'separate', 'evidence': 'separate links'},
            })])

    def test_phase1b_diagnostic_pending_polarity_cannot_bind_answer(self):
        self._phase1b_present_and_turn('No')
        from wolfhouse import pending_question
        self.ledger._transaction(lambda state, _ingress:
                                 pending_question.persist(state, 'add_on'))
        self._phase1b_diagnose([self._phase1b_legacy_payload('reject')])

    def test_phase1b_diagnostic_payment_completion_has_no_authority(self):
        self._phase1b_present_and_turn('I choose deposit')
        self._phase1b_diagnose([self._phase1b_legacy_payload(
            'accept', completions={
                'payment_choice': {'value': 'deposit', 'evidence': 'deposit'},
            })])

    def test_phase1b_diagnostic_indexed_eligibility_has_no_authority(self):
        self._phase1b_present_and_turn('Alex is male')
        self._phase1b_diagnose([self._phase1b_legacy_payload(
            'clarify', completions={
                'eligibility': {'guest_index': 0, 'value': 'male', 'evidence': 'Alex is male'},
            })])

    def test_phase1b_diagnostic_saved_receipt_and_completion_are_protected(self):
        prepared = self._phase1b_prepare_accepted()
        receipt = {'success': True, 'booking_id': 'offline-phase1b-saved',
                   'booking_code': 'OFFLINE-PHASE1B',
                   'secure_payment_url': 'https://payments.invalid/phase1b'}
        # A simulated external receipt, persisted by the real owner. This is
        # recovery-state evidence, not a claim of a real Staff booking write.
        self.ledger.dispatch_create(prepared, lambda: deepcopy(receipt))
        self.ledger.record_create_completion(prepared, receipt)
        self.turn('phase1b-saved-read', 'Cancel the entire booking')
        state = self._phase1b_state()[1]
        self.assertEqual(state['receipt'], receipt)
        self.assertTrue(state['completion'])
        self._phase1b_diagnose([self._phase1b_legacy_payload('reject'), {}])

    def test_phase1b_diagnostic_unresolved_dispatch_and_frozen_payload_are_protected(self):
        prepared = self._phase1b_prepare_accepted()
        attempts = []
        def lost_reply():
            attempts.append(prepared['idempotency_key'])
            raise TimeoutError('offline unresolved dispatch fixture')
        with self.assertRaises(TimeoutError):
            self.ledger.dispatch_create(prepared, lost_reply)
        self.turn('phase1b-unresolved-read', 'Please inspect the booking facts')
        state = self._phase1b_state()[1]
        self.assertTrue(state['dispatch_pending'])
        self.assertEqual(state['dispatch_payload'], dict(prepared))
        self.assertFalse(state.get('receipt'))
        self._phase1b_diagnose([self._phase1b_legacy_payload('revise'), {}])
        self.assertEqual(attempts, [prepared['idempotency_key']])

    def test_phase1b_diagnostic_partial_receipt_cannot_be_repaired_or_erased(self):
        prepared = self._phase1b_prepare_accepted()
        receipt = {'success': True, 'booking_id': 'offline-phase1b-partial',
                   'booking_code': 'OFFLINE-PHASE1B-PARTIAL'}
        self.ledger.dispatch_create(prepared, lambda: deepcopy(receipt))
        partial = {**receipt, 'payment_link_error': 'offline lost payment reply'}
        self.ledger.record_create_completion(prepared, partial)
        self.turn('phase1b-partial-read', 'Please inspect the booking facts')
        self.assertEqual(self._phase1b_state()[1]['partial_completion'], partial)
        self._phase1b_diagnose([self._phase1b_legacy_payload('reject'), {}])

    def test_phase1b_diagnostic_legacy_missing_epoch_is_read_not_migration(self):
        self._phase1b_present_and_turn()
        key, state = self._phase1b_state()
        state.pop('epoch', None)
        self.db._execute_write(lambda conn: conn.execute(
            'UPDATE state_meta SET value=? WHERE key=?', (json.dumps(state), key)))
        # Missing epoch is the supported v1 default, not an excuse to persist it.
        self.ledger._current.get().epoch = 0
        self._phase1b_diagnose([{}], useful=True)

    def test_phase1b_diagnostic_absent_row_cannot_create_default_state(self):
        self._phase1b_present_and_turn()
        key, _state = self._phase1b_state()
        self.db._execute_write(lambda conn: conn.execute(
            'DELETE FROM state_meta WHERE key=?', (key,)))
        self._phase1b_diagnose([{}])

    def test_phase1b_diagnostic_invalid_record_is_not_repaired(self):
        self._phase1b_present_and_turn()
        key, _state = self._phase1b_state()
        self.db._execute_write(lambda conn: conn.execute(
            'UPDATE state_meta SET value=? WHERE key=?', ('{invalid-json', key)))
        self._phase1b_diagnose([{}], rejected=True)

    def test_phase1b_diagnostic_stale_epoch_cannot_write_or_return_live_authority(self):
        self._phase1b_present_and_turn()
        key, state = self._phase1b_state()
        state['epoch'] += 1
        self.db._execute_write(lambda conn: conn.execute(
            'UPDATE state_meta SET value=? WHERE key=?', (json.dumps(state), key)))
        self._phase1b_diagnose([{}], rejected=True)

    def test_phase1b_diagnostic_wrong_runtime_scope_cannot_write(self):
        self._phase1b_present_and_turn()
        # Change trusted ingress WITHOUT observe_owner_turn rebinding the owner.
        # Model metadata supplied by _phase1b_diagnose must not repair this.
        for field, value in (('chat_id', 'other-phone'), ('user_id', 'other-guest'),
                             ('session_key', 'other-key'), ('session_id', 'other-session'),
                             ('message_id', 'other-turn')):
            with self.subTest(field=field):
                scope = dict(platform='whatsapp', source='whatsapp', chat_id='chat1',
                             user_id='guest1', session_key='key1', session_id='s1',
                             message_id='phase1b-diagnostic')
                scope[field] = value
                token = set_session_vars(**scope)
                try:
                    self._phase1b_diagnose([{}], rejected=True)
                finally:
                    clear_session_vars(token)
        with patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'other-tenant'}):
            self._phase1b_diagnose([{}], rejected=True)

    def test_phase1b_diagnostic_closed_turn_cannot_write(self):
        self._phase1b_present_and_turn()
        self.ledger.close_turn()
        self._phase1b_diagnose([{}], rejected=True)

    def test_phase1b_diagnostic_rotated_session_cannot_write(self):
        self._phase1b_present_and_turn()
        self.agent.session_id = 'rotated-session'
        self._phase1b_diagnose([{}], rejected=True)

    def test_phase1b_diagnostic_ended_session_cannot_write(self):
        self._phase1b_present_and_turn()
        self.db._execute_write(lambda conn: conn.execute(
            'UPDATE sessions SET ended_at=started_at+1 WHERE id=?', ('s1',)))
        self._phase1b_diagnose([{}], rejected=True)

    def test_phase1b_diagnostic_changed_session_incarnation_cannot_write(self):
        self._phase1b_present_and_turn()
        self.db._execute_write(lambda conn: conn.execute(
            'UPDATE sessions SET started_at=started_at+1 WHERE id=?', ('s1',)))
        self._phase1b_diagnose([{}], rejected=True)

    def test_owner_accepted_presented_snapshot_survives_current_slot_rebuild(self):
        """A Luna-rendered accepted offer remains owned during a slot rebuild."""
        # The ordinary test fixture's literal ``draft`` is intentionally not
        # presentation evidence. Render the Staff total as Luna would so this
        # regression starts from a genuinely presented owner snapshot.
        self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft'}, None, None,
            lambda facts, _draft: f"Total €{facts['total_cents'] / 100:.2f}")
        state = self.ledger._transaction(lambda state, ingress: deepcopy(state))
        self.assertTrue(
            self.ledger._presentation_matches_completion_state(state, state['presentation']),
            {'presented': state['presentation']['plan'],
             'expected': self.ledger._presentation_plan(state)})
        self.accept()
        accepted_state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
        self.assertEqual(accepted_state['accepted_presentation']['quote_revision'],
                         accepted_state['checked_offer'])
        self.assertEqual(accepted_state['accepted_presentation']['authoritative_quote'],
                         accepted_state['quote'])
        # Reproduce the production slot-rebuild state: acceptance is durable,
        # while the ephemeral current presentation has been removed.
        self.ledger._transaction(lambda state, _ingress: state.pop('presentation', None))
        raw = 'Yes, proceed with the same quoted offer'
        self.turn('m3-owner-slot-rebuild', raw)
        rebuilt, ingress_tenant = self.ledger._transaction(
            lambda state, ingress: (deepcopy(state), ingress['tenant']))
        self.assertEqual(rebuilt['status'], 'accepted')
        self.assertNotIn('presentation', rebuilt)
        self.assertIn('accepted_presentation', rebuilt)
        accepted = rebuilt['accepted_presentation']
        self.assertEqual(accepted['tenant'], ingress_tenant)
        self.assertIsInstance(rebuilt['checked_offer'], dict)
        self.assertEqual(accepted['quote_revision'], rebuilt['checked_offer'])
        self.assertEqual(accepted['authoritative_quote'], rebuilt['quote'])
        self.assertEqual(accepted['scope'], rebuilt['scope'])
        self.assertEqual(accepted['incarnation'], rebuilt['incarnation'])
        self.assertEqual(accepted['original_turn'], rebuilt['offer_message'])
        self.assertIn(accepted['original_turn'], rebuilt['seen'])
        self.assertEqual(accepted['displayed_text_digest'], hashlib.sha256(
            accepted['displayed_text'].encode()).hexdigest())
        self.assertTrue(self.ledger._presentation_matches_completion_state(
            rebuilt, rebuilt['accepted_presentation']), {
                'presented': rebuilt['accepted_presentation']['plan'],
                'expected': self.ledger._presentation_plan(rebuilt)})
        before_diagnostic = self._phase1b_rows()
        repeated = self.interpret(raw)
        self.assertTrue(repeated['diagnostic_only'])
        self.assertEqual(self._phase1b_rows(), before_diagnostic)
        after_repeat = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
        self.assertEqual(after_repeat['status'], 'accepted', after_repeat)
        self.assertNotIn('presentation', after_repeat)
        prepared = self.ledger.prepare_create({})
        self.assertEqual(prepared['accepted_offer'], self.response['offer_revision'])
        self.assertEqual(prepared['idempotency_key'], accepted_state['operation_key'])
        self.assertEqual(self._phase1b_state()[1]['presentation'], accepted)

    def test_accepted_snapshot_fallback_rejects_stale_or_corrupt_authority(self):
        self.accept()
        self.ledger._transaction(lambda state, _ingress: state.pop('presentation', None))
        original = self._phase1b_state()[1]
        corruptions = [
            ('tenant', 'foreign'), ('scope', {}), ('incarnation', 'foreign'),
            ('original_turn', 'unseen'), ('displayed_text', 'altered'),
            ('displayed_text_digest', 'altered'), ('quote_revision', {}),
            ('authoritative_quote', {}), ('plan', {}),
        ]
        for field, value in corruptions:
            with self.subTest(field=field):
                def corrupt(state, _ingress):
                    state.clear()
                    state.update(deepcopy(original))
                    state['accepted_presentation'][field] = value
                self.ledger._transaction(corrupt)
                before = self._phase1b_rows()
                with self.assertRaises(self.ledger.QuoteBoundaryError):
                    self.ledger.prepare_create({})
                self.assertEqual(self._phase1b_rows(), before)

    def test_prepare_create_strips_every_staff_forbidden_money_field(self):
        """Model-restated money never crosses Staff's client-money boundary."""
        self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft'}, None, None,
            lambda facts, _draft: f"Total €{facts['total_cents'] / 100:.2f}",
        )
        self.accept()
        forbidden = (
            'total_cents', 'deposit_required_cents', 'balance_due_cents',
            'payment_link_amount_cents', 'deposit_amount_cents',
            'total_amount_cents', 'amount_due_cents', 'amount_paid_cents',
            'paid_amount_cents', 'subtotal_cents', 'discount_cents',
        )
        prepared = self.ledger.prepare_create({
            'confirm': True,
            **{field: 12345 for field in forbidden},
        })
        for field in forbidden:
            self.assertNotIn(field, prepared, field)
        self.assertEqual(prepared['accepted_offer'], self.response['offer_revision'])
        self.assertEqual(
            prepared['accepted_offer']['total_cents'],
            self.response['offer_revision']['total_cents'],
        )

    def test_staff_forbidden_money_projection_cannot_drift(self):
        """The Python projection tracks Staff's actual create-boundary list."""
        root = Path(__file__).resolve().parents[3]
        service = root / 'scripts/lib/luna-front-desk-accommodation-booking-create-service.js'
        source = service.read_text(encoding='utf-8')
        block = re.search(
            r'const ACCOMMODATION_CLIENT_MONEY_FIELDS = Object\.freeze\(\[(.*?)\]\);',
            source,
            re.DOTALL,
        )
        self.assertIsNotNone(block)
        if block is None:
            self.fail('Staff money-field definition is missing')
        staff_fields = tuple(re.findall(r"'([^']+)'", block.group(1)))
        self.assertEqual(self.ledger._STAFF_FORBIDDEN_MONEY_FIELDS, staff_fields)

    def test_persisted_plain_422_retry_uses_same_sanitized_operation_once(self):
        """A pre-fix frozen 422 payload recovers without reset or duplicate save."""
        self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft'}, None, None,
            lambda facts, _draft: f"Total €{facts['total_cents'] / 100:.2f}",
        )
        self.accept()
        prepared = self.ledger.prepare_create({'confirm': True})
        operation_key = prepared['idempotency_key']
        legacy = self.ledger.PreparedPlan(
            deepcopy(dict(prepared)), prepared.capability, prepared.epoch)
        legacy.revalidation = prepared.revalidation
        legacy['deposit_required_cents'] = 12345
        calls = []

        refused = self.ledger.dispatch_create(
            legacy,
            lambda: calls.append('ordinary-422') or {
                'success': False, 'error': 'HTTP 422', 'write_performed': False,
            },
        )
        self.assertEqual(refused['error'], 'HTTP 422')
        frozen = self.ledger._transaction(
            lambda state, _ingress: deepcopy(state['dispatch_payload']))
        self.assertEqual(frozen['deposit_required_cents'], 12345)

        retry = self.ledger.prepare_create({})
        self.assertNotIn('deposit_required_cents', retry)
        self.assertEqual(retry['idempotency_key'], operation_key)
        self.assertEqual(retry['accepted_offer'], self.response['offer_revision'])
        saved = self.ledger.dispatch_create(
            retry,
            lambda: calls.append('saved') or {
                'success': True, 'booking_id': 71, 'booking_code': 'WH-TEST-71',
            },
        )
        self.assertEqual(saved['booking_code'], 'WH-TEST-71')

        same_operation = self.ledger.prepare_create({})
        self.assertEqual(same_operation['idempotency_key'], operation_key)
        replayed = self.ledger.dispatch_create(
            same_operation,
            lambda: calls.append('unexpected-duplicate') or {},
        )
        self.assertEqual(replayed['booking_code'], 'WH-TEST-71')
        self.assertEqual(calls, ['ordinary-422', 'saved'])

    def test_fresh_first_acceptance_passes_real_staff_gate_and_persists(self):
        """The exact owner-prepared payload commits and reads back through Staff."""
        import subprocess

        # Build and record a fresh Staff-checked offer whose inventory code is
        # provided by the real PGlite fixture. This supersedes setUp's baseline
        # quote before any acceptance happens.
        scenario = {'package_weekly_per_person_cents': 20000}
        plan = {**self.plan, 'guest_count': 1,
                'guests': [{'name': 'Fresh Owner Acceptance'}],
                'selected_bed_codes': ['R3-B1'], 'catalog_selections': []}
        # The seeded R3 inventory uses Flexible, not the unit fixture's mixed
        # strategy. Both quote checks must fingerprint the real Staff room rule.
        response = self.checked(plan, [
            dict(bed_code='R3-B1', room_code='R3', gender_strategy='Flexible')], {
                'total_cents': scenario['package_weekly_per_person_cents'],
            })
        response['offer_revision']['payment_link_amount_cents'] = (
            response['offer_revision']['deposit_required_cents'])
        self.ledger.record_quote(plan, response)
        # Render the actual Staff-owned total now: a literal draft is
        # deliberately not presentation evidence.
        self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft'}, None, None,
            lambda facts, _draft: f"Total €{facts['total_cents'] / 100:.2f}")
        state = self.ledger._transaction(lambda current, _ingress: deepcopy(current))
        self.assertTrue(self.ledger._presentation_matches_completion_state(
            state, state['presentation']))

        # This is the first acceptance in this fresh SessionDB/session. Do not
        # reconstruct accepted_offer: serialize prepare_create's exact output.
        self.accept(beds=[dict(bed_code='R3-B1', room_code='R3', gender_strategy='Flexible')],
                    quote_overrides={'total_cents': scenario['package_weekly_per_person_cents']})
        prepared = self.ledger.prepare_create({'confirm': True})
        prepared['require_offer_identity'] = True
        prepared['phone'] = '+34612341569'
        self.assertEqual(prepared['accepted_offer'], response['offer_revision'])
        self.assertTrue(prepared['accepted_offer']['offer_fingerprint'])

        root = Path(__file__).resolve().parents[3]
        completed = subprocess.run(
            ['node', 'scripts/test-accepted-owner-payload-persistence.js'],
            cwd=root, input=json.dumps({'plan': prepared, 'scenario': scenario}), text=True,
            capture_output=True, timeout=120)
        self.assertEqual(completed.returncode, 0,
                         f"stdout={completed.stdout}\nstderr={completed.stderr}")
        receipt = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertRegex(receipt['booking_code'], r'^WH-')
        self.assertTrue(receipt['booking_id'])
        self.assertTrue(receipt['conversation_id'])

    def test_unpresented_quote_cannot_use_owner_snapshot_fallback(self):
        """No accepted owner snapshot means no presentation authority."""
        self.ledger._transaction(lambda state, _ingress: (
            state.pop('presentation', None), state.pop('accepted_presentation', None)))
        raw = 'Yes, create it'
        self.turn('m2-never-presented', raw)
        before = self._phase1b_rows()
        self.assertTrue(self.interpret(raw)['diagnostic_only'])
        self.assertEqual(self._phase1b_rows(), before)
        prepared = self.assert_prepares_with_warning(
            {'confirm': True}, 'quote_owner_presented_offer_required')
        self.assertEqual(prepared['guests'], self.plan['guests'])
        self.assertEqual(prepared['accepted_quote'], self.response)
        self.assertEqual(prepared['accepted_offer'], self.response['offer_revision'])
        self.assertNotIn('accepted_presentation', self._phase1b_state()[1])

    def test_distribution_then_payment_acceptance_reloads_revalidates_and_saves(self):
        """One German, offer-bound consent survives distribution/amount revalidation."""
        plan = dict(self.plan)
        plan.pop('payment_choice')
        response = self.checked({**plan, 'payment_choice': 'deposit'})
        response['payment_choice_needed'] = True
        self.agent.session_id = 'de-distribution-payment'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('de-offer', 'Bitte Angebot zeigen')
        self.ledger.record_quote(plan, response)
        self.ledger.finalize_offer_response(
            {'completed': True, 'final_response': 'draft'}, None, None,
            lambda facts, _draft: f"Total €{facts['total_cents'] / 100:.2f}")
        distribution = 'Bitte getrennte Zahlungslinks für uns beide.'
        self.turn('de-distribution', distribution)
        first = self.interpret(distribution, action='clarify')
        self.assertTrue(first['diagnostic_only'])
        # Scripted model retains distribution while asking the amount choice.
        selected_distribution = 'separate'

        payment = 'Dann nehmen wir die Anzahlung, bitte so buchen.'
        self.turn('de-payment', payment)
        accepted = self.ledger.prepare_create({'confirm': True,
            'payment_choice': 'deposit', 'payment_link_distribution': selected_distribution})
        self.assertTrue(accepted.revalidation)

        # Exercise durable decode, not merely the in-memory transaction object.
        self.ledger.close_turn()
        self.db.close()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.agent._session_db = self.db
        self.turn('de-revalidate', payment)
        refreshed_plan = self.ledger.prepare_quote({})
        self.assertEqual(refreshed_plan['payment_link_distribution'], 'separate')
        self.assertEqual(refreshed_plan['payment_choice'], 'deposit')
        refreshed = self.checked(refreshed_plan)
        self.ledger.record_quote(refreshed_plan, refreshed)
        create_plan = self.ledger.prepare_create({'confirm': True})
        self.assertEqual(create_plan['payment_link_distribution'], 'separate')
        self.assertEqual(create_plan['payment_choice'], 'deposit')

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
                offline_quote_result({'completed': True, 'final_response': 'draft'})
                self.turn(f'{language}-addon-no-answer', addon_no)
                self.assertTrue(self.interpret(addon_no, action='reject', negated=True)['diagnostic_only'])
                self.checked_requote({'shuttle_choice': 'declined'})
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertEqual(state['plan']['shuttle_choice'], 'declined')
                self.assertEqual(state['plan']['pending_transfers'], [])
                self.assertNotEqual(state['status'], 'accepted')
            with self.subTest(language=language, answer='addon-yes'):
                self.agent.session_id = f'pending-addon-yes-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn(f'{language}-addon-yes-offer', 'Quote package')
                self.ledger.record_quote(plan, package_response)
                offline_quote_result({'completed': True, 'final_response': 'draft'})
                self.turn(f'{language}-addon-yes-answer', addon_yes)
                self.assertTrue(self.interpret(addon_yes)['diagnostic_only'])
                self.checked_requote({'shuttle_choice': 'accepted'})
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertEqual(state['plan']['shuttle_choice'], 'accepted')
                self.assertNotEqual(state['status'], 'accepted')
            with self.subTest(language=language, answer='quote-decline'):
                self.agent.session_id = f'pending-quote-no-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn(f'{language}-quote-offer', 'Quote stay')
                self.ledger.record_quote({**self.plan, 'language': language}, self.checked(self.plan))
                offline_quote_result({'completed': True, 'final_response': 'draft'})
                self.turn(f'{language}-quote-answer', quote_no)
                result = self.ledger.update_booking_plan({'operation': 'decline_offer', 'scope': 'whole_offer'})
                self.assertEqual(result['next_action'], 'offer_declined')
                with self.assertRaises(self.ledger.QuoteBoundaryError):
                    self.ledger.prepare_create({'confirm': True})
            with self.subTest(language=language, answer='explicit-cancel'):
                self.agent.session_id = f'pending-cancel-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn(f'{language}-cancel-offer', 'Quote package')
                self.ledger.record_quote(plan, package_response)
                offline_quote_result({'completed': True, 'final_response': 'draft'})
                self.turn(f'{language}-cancel-answer', cancel)
                result = self.ledger.update_booking_plan({'operation': 'decline_offer', 'scope': 'whole_offer'})
                self.assertEqual(result['next_action'], 'offer_declined')
                with self.assertRaises(self.ledger.QuoteBoundaryError):
                    self.ledger.prepare_create({'confirm': True})

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
                    offline_quote_result(
                        {'completed': True, 'final_response': 'draft'})
                    self.turn(f'answer-last-addon-cancel-reply-{language}-{len(reply)}', reply)
                    self.assertTrue(self.interpret(reply, action='reject', negated=True)['diagnostic_only'])
                    self.checked_requote({'shuttle_choice': 'declined'})
                    state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                    self.assertEqual(state['plan']['shuttle_choice'], 'declined')
                    self.assertEqual(state['plan']['pending_transfers'], [])
                    self.assertNotEqual(state['status'], 'accepted')

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
                    offline_quote_result(
                        {'completed': True, 'final_response': 'draft'})
                    self.turn(f'answer-last-addon-cancel-whole-reply-{session_suffix}', reply)
                    result = self.ledger.update_booking_plan({'operation': 'decline_offer', 'scope': 'whole_offer'})
                    state = self.ledger._transaction(
                        lambda current, _ingress: deepcopy(current))
                    self.assertEqual(result['next_action'], 'offer_declined')
                    self.assertNotIn('add_on_decisions', state)
                    with self.assertRaises(self.ledger.QuoteBoundaryError):
                        self.ledger.prepare_create({'confirm': True})

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
                offline_quote_result({'completed': True, 'final_response': 'draft'})
                self.turn(f'answer-last-payment-distribution-{language}', payment_no)
                # Explicit model decision, not a production polarity classifier.
                self.checked_requote({'payment_distribution': 'separate'})
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertIsNone(state.get('checked_offer'))
                self.assertEqual(self.ledger._presentation_plan(state)['payment_link_distribution'], 'separate')
                self.assertNotIn('payment_choice', state['plan'])
                revised = self.ledger.prepare_quote({})
                revised_response = self.checked({**revised, 'payment_choice': 'deposit'})
                revised_response['payment_choice_needed'] = True
                self.ledger.record_quote(revised, revised_response)
                offline_quote_result({'completed': True, 'final_response': 'updated'})
                self.turn(f'answer-last-payment-reply-{language}', payment_no)
                result = self.ledger.prepare_create({'confirm': True, 'payment_choice': 'full'})
                self.assertTrue(result.revalidation)
                self.assertNotIn('accepted_offer', result)
                self.assertEqual(result['payment_choice'], 'full')

            with self.subTest(language=language, target='whole-booking'):
                self.agent.session_id = f'answer-last-booking-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'language': language, 'package_code': 'package_surf_week'}
                plan.pop('payment_choice')
                response = self.checked({**plan, 'payment_choice': 'deposit'})
                response['payment_choice_needed'] = True
                self.turn(f'answer-last-addon-offer-{language}', 'Quote package')
                self.ledger.record_quote(plan, response)
                offline_quote_result({'completed': True, 'final_response': 'draft'})
                self.turn(f'answer-last-addon-reply-{language}', booking_no)
                result = self.ledger.update_booking_plan({
                    'operation': 'decline_offer', 'scope': 'whole_offer'})
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertFalse(result['create_ready'])
                with self.assertRaises(self.ledger.QuoteBoundaryError):
                    self.ledger.prepare_create({'confirm': True})
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
                offline_quote_result({'completed': True, 'final_response': 'draft'})
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                expected = ['together', 'separate']
                self.assertEqual(state['pending_question'],
                                 {'kind': 'payment_choice', 'options': expected})
                self.turn(f'{language}-distribution-answer', no)
                self.checked_requote({'payment_distribution': 'separate'})
                offline_quote_result({'completed': True, 'final_response': 'updated'})
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertIsNone(state.get('checked_offer'))
                self.assertEqual(state['pending_question'],
                                 {'kind': 'payment_choice', 'options': ['deposit', 'full']})
                self.assertEqual(self.ledger._presentation_plan(state)['payment_link_distribution'], 'separate')
                self.assertNotIn('payment_choice', state['plan'])
                revised = self.ledger.prepare_quote({})
                revised_response = self.checked({**revised, 'payment_choice': 'deposit'})
                revised_response['payment_choice_needed'] = True
                self.ledger.record_quote(revised, revised_response)
                offline_quote_result({'completed': True, 'final_response': 'updated'})
                self.turn(f'{language}-payment-answer', no)
                result = self.ledger.prepare_create({'confirm': True, 'payment_choice': 'full'})
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertTrue(result.revalidation)
                self.assertNotIn('accepted_offer', result)
                self.assertEqual(result['payment_choice'], 'full')
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
                offline_quote_result({'completed': True, 'final_response': 'draft'})
                self.turn(f'{language}-shuttle-answer', yes)
                self.checked_requote({'shuttle_needed': True, 'shuttle_choice': 'accepted'})
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertIsNone(state.get('checked_offer'))
                self.assertNotIn('pending_transfers', state['plan'])
                self.assertTrue(state['plan']['shuttle_needed'])
                self.assertEqual(state['plan']['shuttle_choice'], 'accepted')
                revised = self.ledger.prepare_quote({})
                self.assertNotIn('pending_transfers', revised)
                revised_response = self.checked({**dict(revised), 'payment_choice': 'deposit'})
                revised_response['payment_choice_needed'] = True
                self.ledger.record_quote(revised, revised_response)
                offline_quote_result({'completed': True, 'final_response': 'draft'})
                self.turn(f'{language}-next-turn', no)
                next_plan = self.checked_requote({'payment_distribution': 'separate'})
                self.assertEqual(next_plan['payment_link_distribution'], 'separate')
                self.assertTrue(next_plan['shuttle_needed'])

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
                shown = offline_quote_result({'completed': True, 'final_response': 'draft'})
                self.assertIn(self.ledger._style_copy(language)['shuttle_choice'], shown['final_response'])
                self.db.close()
                self.db = SessionDB(Path(self.temp.name) / 'state.db')
                self.agent._session_db = self.db
                self.turn(f'uncertain-addon-answer-{language}', conditional)
                before = self._phase1b_rows()
                result = self.interpret(conditional, conditional=True)
                self.assertEqual(self._phase1b_rows(), before)
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertNotIn('add_on_decisions', state)
                self.assertNotIn('pending_transfers', state['plan'])
                self.assertEqual(state['pending_question']['kind'], 'add_on')
                self.assertTrue(result['diagnostic_only'])
                self.assertEqual(state['presentation']['displayed_text'], shown['final_response'])

            with self.subTest(language=language, question='payment'):
                self.agent.session_id = f'uncertain-payment-{language}'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'language': language}
                plan.pop('payment_choice')
                response = self.checked({**plan, 'payment_choice': 'deposit'})
                response['payment_choice_needed'] = True
                self.turn(f'uncertain-payment-offer-{language}', 'Quote stay')
                self.ledger.record_quote(plan, response)
                shown = offline_quote_result({'completed': True, 'final_response': 'draft'})
                self.assertIn(payment_question, shown['final_response'])
                self.db.close()
                self.db = SessionDB(Path(self.temp.name) / 'state.db')
                self.agent._session_db = self.db
                self.turn(f'uncertain-payment-answer-{language}', conditional)
                before = self._phase1b_rows()
                result = self.interpret(conditional, conditional=True)
                self.assertEqual(self._phase1b_rows(), before)
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertNotIn('payment_choice', state['plan'])
                self.assertEqual(state['pending_question']['kind'], 'payment_choice')
                self.assertTrue(result['diagnostic_only'])
                self.assertEqual(state['presentation']['displayed_text'], shown['final_response'])

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
                offline_quote_result({'completed': True, 'final_response': 'draft'})
                self.turn(f'explicit-payment-answer-{label}', answer)
                self.checked_requote({'payment_distribution': expected})
                offline_quote_result({'completed': True, 'final_response': 'updated'})
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertIsNone(state.get('checked_offer'))
                self.assertEqual(self.ledger._presentation_plan(state)['payment_link_distribution'], expected)
                self.assertNotIn('payment_choice', state['plan'])
                self.assertEqual(state['pending_question'],
                                 {'kind': 'payment_choice', 'options': ['deposit', 'full']})
                stage_two_plan = self.ledger.prepare_quote({})
                stage_two = self.checked({**stage_two_plan, 'payment_choice': 'deposit'})
                stage_two['payment_choice_needed'] = True
                self.ledger.record_quote(stage_two_plan, stage_two)
                offline_quote_result({'completed': True, 'final_response': 'updated'})
                self.turn(f'explicit-payment-amount-{label}', 'deposit')
                amount_result = self.checked_create({'payment_choice': 'deposit'})
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertFalse(amount_result.revalidation)
                self.assertEqual(amount_result['payment_link_distribution'], expected)
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
                    shown = offline_quote_result(
                        {'completed': True, 'final_response': 'draft'})
                    expected_question = shown['final_response'].rsplit('\n\n', 1)[-1]
                    self.db.close()
                    self.db = SessionDB(Path(self.temp.name) / 'state.db')
                    self.agent._session_db = self.db
                    self.turn(f'conditional-negative-answer-{question_kind}-{language}', conditional)
                    before = self._phase1b_rows()
                    result = self.interpret(conditional, action='reject', negated=True, conditional=True)
                    self.assertEqual(self._phase1b_rows(), before)
                    state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                    self.assertTrue(result['diagnostic_only'])
                    self.assertEqual(state['presentation']['displayed_text'].rsplit('\n\n', 1)[-1],
                                     expected_question)
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
                shown = offline_quote_result(
                    {'completed': True, 'final_response': 'draft'})
                state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
                self.assertEqual(state['pending_question'], {'kind': 'names'})
                self.assertEqual(state['presentation']['question_kind'], 'names')
                self.assertEqual(state['presentation']['payment_choices'], [])
                self.db.close()
                self.db = SessionDB(Path(self.temp.name) / 'state.db')
                self.agent._session_db = self.db
                self.turn(f'full-names-answer-{language}', answer)
                before = self._phase1b_rows()
                result = self.interpret(answer)
                self.assertTrue(result['diagnostic_only'])
                self.assertEqual(self._phase1b_rows(), before)
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
                shown = offline_quote_result({'completed': True, 'final_response': 'draft'})
                self.assertIn(self.ledger._style_copy(language)['save'], shown['final_response'])
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
                    shown = offline_quote_result(
                        {'completed': True, 'final_response': 'draft'})
                    save_questions = [
                        self.ledger._style_copy(code)['save']
                        for code in ('en', 'es', 'de', 'it', 'fr')]
                    self.assertEqual(sum(shown['final_response'].count(question)
                                         for question in save_questions), 1)
                    state = self.ledger._transaction(
                        lambda current, _ingress: deepcopy(current))
                    self.assertEqual(state['pending_question'], {'kind': 'go_ahead'})
                    self.turn(f'accept-{language}-{count}', answer)
                    # Scripted model decides to save. The real boundary must
                    # refresh Staff facts once, without another consent turn.
                    with patch.object(self, 'checked', wraps=self.checked) as refresh:
                        create = self.checked_create()
                    self.assertEqual(refresh.call_count, 1)
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
                offline_quote_result({'completed': True, 'final_response': 'draft'})
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
                self.assertTrue(distribution['diagnostic_only'])
                self.assertEqual(after_distribution['checked_offer'], before['checked_offer'])
                self.assertEqual(after_distribution.get('presented_offer'), before.get('presented_offer'))
                self.assertEqual(after_distribution['presentation'], before['presentation'])
                self.assertEqual(after_distribution.get('pending_question'), before.get('pending_question'))

                self.turn(f'amount-answer-{language}', amount_text)
                amount = self.ledger.interpret_owner_turn({
                    'action': 'clarify', 'action_evidence': amount_text,
                    'ambiguous': False, 'negated': False, 'conditional': False,
                    'material_changes': [], 'completions': {
                        'payment_choice': {'value': 'deposit', 'evidence': amount_text}},
                })
                self.assertTrue(amount['diagnostic_only'])
                revised = self.ledger.prepare_quote({
                    'payment_link_distribution': 'separate', 'payment_choice': 'deposit'})
                self.assertEqual(revised['payment_link_distribution'], 'separate')
                self.assertEqual(revised['payment_choice'], 'deposit')
                self.ledger.record_quote(revised, self.checked(revised))
                offline_quote_result({'completed': True, 'final_response': 'draft'})
                self.assertNotEqual(self.ledger._transaction(
                    lambda state, _ingress: state['status']), 'accepted')

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
        offline_quote_result({'completed': True, 'final_response': 'draft'})

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
        self.assertTrue(result['diagnostic_only'], result)
        self.assertNotIn('accepted', result)
        # The model asks which distribution, rather than invoking create.
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
        offline_quote_result({'completed': True, 'final_response': 'draft'})
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
        offline_quote_result({'completed': True, 'final_response': 'draft'})
        state = self.ledger._transaction(lambda owner, _ingress: deepcopy(owner))
        self.assertTrue(state['quote']['payment_choice_needed'], state)
        self.assertEqual(state['presentation']['payment_choices'],
                         ['deposit', 'per_guest', 'full'])

        raw = 'We will pay per_guest'
        self.turn('choose-split', raw)
        accepted = self.ledger.prepare_create({'confirm': True, 'payment_choice': 'per_guest'})
        self.assertTrue(accepted.revalidation)
        revalidation = self.ledger.prepare_quote(dict(accepted))
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
                offline_quote_result({'completed': True, 'final_response': 'draft'})
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
        """Scripted model copy traverses the real presentation/descriptor boundary.

        This is offline fixture and commercial-state coverage, not evidence of
        live language quality or production ownership of guest wording.
        """
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
                shown = offline_quote_result(
                    {'completed': True, 'final_response': 'model draft', 'messages': []})
                self.assertIn(expected, shown['final_response'])
                self.assertNotIn('deposit now or the full', shown['final_response'])
                self.assertNotIn('depósito de €100 o el total', shown['final_response'])

        self.agent.session_id = 'package-shuttle-before-payment'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = {**self.plan, 'package_code': 'package_surf_week'}
        plan.pop('payment_choice')
        response = self.checked({**plan, 'payment_choice': 'deposit'})
        response['payment_choice_needed'] = True
        self.turn('package-shuttle', 'Quote the surf package')
        self.ledger.record_quote(plan, response)
        shown = offline_quote_result(
            {'completed': True, 'final_response': 'model draft', 'messages': []})
        self.assertIn('airport transfer', shown['final_response'])
        self.assertNotIn('Would you like to pay together', shown['final_response'])

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
        shown = offline_quote_result(
            {'completed': True, 'final_response': 'model draft', 'messages': []})
        self.assertIn('You can pay a €100 deposit now or the full €200. Which would you like?',
                      shown['final_response'])
        self.assertNotIn('pay together', shown['final_response'])

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
        shown = offline_quote_result(
            {'completed': True, 'final_response': 'model draft', 'messages': []})
        self.assertIn('Shall I save this booking?', shown['final_response'])
        self.assertNotIn('pay together', shown['final_response'])

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
        offline_quote_result({'completed': True, 'final_response': 'draft'})
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
        prepared = self.checked_create()
        self.assertTrue(prepared['confirm'])
        recheck = self.ledger.prepare_quote({})
        self.ledger.record_quote(recheck, self.checked(recheck))
        self.assertEqual(self.ledger.prepare_create({})['idempotency_key'],
                         prepared['idempotency_key'])

    def test_installed_entrypoint_revalidates_completed_name_before_create(self):
        import json
        from agent import conversation_loop
        from wolfhouse.offline_ingress_harness import gateway_ingress
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        self.agent.session_id = 'accepted-name-entrypoint-owner'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = {**self.plan, 'room_type': 'shared', 'room_preference': 'mixed',
                'guests': [{'name': 'Emre'}, {'name': 'Diego Navarro'}],
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
                prepared = self.ledger.prepare_create({'confirm': True, 'guests': [
                    {'name': 'Emre Yilmaz'}, {'name': 'Diego Navarro'}]})
                self.assertTrue(prepared.revalidation)
                quote(dict(prepared))
                create(dict(self.ledger.prepare_create({'confirm': True})))
            return offline_quote_result(
                {'completed': True, 'final_response': 'offline model edge', 'messages': []})
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
        offline_quote_result({'completed': True, 'final_response': 'draft'})
        raw = "€ that works. lock it in please — Emre Yilmaz, I'll pay the deposit when you send the link"
        self.turn('accepted-name-payment-completion', raw)
        first = self.ledger.prepare_create({'confirm': True, 'guests': [
            {'name': 'Emre Yilmaz'}, {'name': 'Guest Two'}], 'payment_choice': 'deposit'})
        self.assertFalse(first.revalidation)
        self.assertIn('quote_revalidation_advisory', first['booking_check_warnings'])
        revalidation = self.ledger.prepare_quote(dict(first))
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
        self.assert_model_details_warn({}, 'quote_owner_presented_offer_required')

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
                shown = offline_quote_result(
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
        text = offline_quote_result(
            {'completed': True, 'final_response': 'draft', 'messages': []})['final_response']
        for value in ('Quoted deposit:', 'needs review', '€0'):
            self.assertIn(value, text)
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
        shown = offline_quote_result(
            {'completed': True, 'final_response': 'draft', 'messages': []})
        self.assertIn('💶 *Total:* €200', shown['final_response'].splitlines())
        self.assertNotIn('Total: €200 (deposit:', shown['final_response'])
        self.assertIn('⏳ *Remaining balance:* €200', shown['final_response'])
        self.assertIn('💳 *Due now:* €0', shown['final_response'])
        self.assertIn('No payment is due now.', shown['final_response'])
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
                shown = offline_quote_result(
                    {'completed': True, 'final_response': 'draft', 'messages': []})
                text = shown['final_response']
                self.assertIn('💶 *Total:* €200', text.splitlines())
                self.assertNotIn('Total: €200 (deposit:', text)
                if choice == 'full':
                    self.assertNotIn('Due on arrival:', text)
                else:
                    label = 'Remaining balance' if choice == 'pay_on_arrival' else 'Remaining after this payment'
                    self.assertIn(f"⏳ *{label}:* {expected_due[choice]}", text)

    def test_g4_first_create_accepts_only_synced_same_person_room_hints(self):
        plan = {**self.plan, 'guests': [{'name': 'Mateo Ríos'}, {'name': 'Guest Two'}],
                'room_name_hints': [{'name': 'Mateo Ríos', 'explicit_gender': 'male'},
                                    {'name': 'Guest Two', 'explicit_gender': 'male'}]}
        response = self.checked(plan)
        response['offer_revision']['room_name_hints'] = deepcopy(plan['room_name_hints'])
        self.turn('g4-first-create-offer', 'Quote this please')
        self.ledger.record_quote(plan, response)
        offline_quote_result({'completed': True, 'final_response': 'draft'})
        stale_hints = [{'name': 'Mateo', 'explicit_gender': 'male'},
                       {'name': 'Guest Two', 'explicit_gender': 'male'}]
        changed = deepcopy(stale_hints)
        changed[0]['explicit_gender'] = 'female'
        self.assert_model_details_warn({'room_name_hints': changed}, 'accepted_quote_changed')
        prepared = self.ledger.prepare_create({'room_name_hints': stale_hints})
        self.assertEqual(prepared['room_name_hints'], stale_hints)
        self.assertEqual(prepared['accepted_offer'], response['offer_revision'])

    def test_payment_incomplete_requote_keeps_checked_offer_provisional(self):
        self.agent.session_id = 'g4-provisional-requote'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        provisional_plan = {key: deepcopy(value) for key, value in self.plan.items()
                            if key != 'payment_choice'}
        response = self.checked({**provisional_plan, 'payment_choice': 'deposit'})
        response['payment_choice_needed'] = True
        self.turn('g4-provisional-offer', 'Quote this please')
        self.ledger.record_quote(provisional_plan, response)
        offline_quote_result(
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
                                    {'name': 'Diego Navarro', 'explicit_gender': 'male'}],
                # The Staff builder consumes canonical guest facts, not the
                # request-only hints. Both occupants are explicitly identified.
                'guests': [{'name': 'Mateo Ríos', 'explicit_gender': 'male'},
                           {'name': 'Diego Navarro', 'explicit_gender': 'male'}],
                'payment_choice': 'deposit'}
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='male_only'),
                dict(bed_code='M2', room_code='M', gender_strategy='male_only')]
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        response = FirstYesOwnerTests._checked_offer(object.__new__(FirstYesOwnerTests), plan, beds)
        self.turn('structured-g4-offer', 'Quote this please')
        self.ledger.record_quote(plan, response)
        offline_quote_result({'completed': True, 'final_response': 'draft'})
        raw = 'dale, book it — Mateo Ríos. send deposit link if needed'
        self.turn('structured-g4-accept', raw)
        before_diagnostic = self._phase1b_rows()
        diagnostic = self.ledger.interpret_owner_turn({
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
        self.assertTrue(diagnostic['diagnostic_only'])
        self.assertEqual(self._phase1b_rows(), before_diagnostic)
        prepared = self.checked_create(beds=beds)
        self.assertEqual(prepared['accepted_offer'], response['offer_revision'])
        self.assertEqual(prepared['payment_choice'], 'deposit')
        self.assertEqual(prepared['guests'], plan['guests'])
        self.assertEqual(prepared['selected_bed_codes'], ['M1', 'M2'])

    def test_g4_request_only_gender_hints_cannot_borrow_checked_authority(self):
        # Preserve the old inconsistent fixture as a negative, including a
        # real-name control: placeholders were not the cause of this refusal.
        beds = [dict(bed_code=code, room_code='M', gender_strategy='male_only')
                for code in ('M1', 'M2')]
        for second_name in ('Guest Two', 'Diego Navarro'):
            with self.subTest(second_name=second_name):
                self.agent.session_id = 'g4-unchecked-facts-' + second_name
                self.db.create_session(self.agent.session_id, source='whatsapp')
                plan = {**self.plan, 'room_preference': 'male_only', 'group_gender': 'male',
                        'guests': [{'name': 'Mateo Ríos'}, {'name': second_name}],
                        'room_name_hints': [{'name': name, 'explicit_gender': 'male'}
                                           for name in ('Mateo Ríos', second_name)]}
                response = self.checked(plan, beds)
                self.assertEqual(response['offer_revision']['room_name_hints'], [])
                self.turn('offer', 'Quote this please')
                self.ledger.record_quote(plan, response)
                offline_quote_result({'completed': True, 'final_response': 'draft'})
                self.turn('accept', 'Please book the same offer')
                with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                            '^quote_owner_acceptance_required$'):
                    self.checked_create(beds=beds)
                state = self.ledger._transaction(lambda state, _: deepcopy(state))
                self.assertNotIn('operation_key', state)
                self.assertFalse(state.get('dispatch_pending'))

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
        offline_quote_result({'completed': True, 'final_response': 'draft'})
        self.turn('reply', raw)

    def test_structured_interpreter_accepts_spanish_paraphrase(self):
        self._present_checked_for_interpreter('spanish-paraphrase',
                                              'Sí, resérvalo por favor')
        result = self.ledger.interpret_owner_turn({
            'action': 'accept', 'action_evidence': 'Sí, resérvalo por favor',
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [], 'completions': {},
        })
        self.assertTrue(result['diagnostic_only'])
        repeated = self.ledger.interpret_owner_turn({
            'action': 'accept', 'action_evidence': 'Sí, resérvalo por favor',
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [], 'completions': {},
        })
        self.assertEqual(repeated, result)
        before = self._phase1b_rows()
        self.ledger.interpret_owner_turn({'action': 'reject'})
        self.assertEqual(self._phase1b_rows(), before)
        prepared = self.checked_create()
        self.assertTrue(prepared['require_offer_identity'])
        self.assertEqual(prepared['selected_bed_codes'], ['M1', 'M2'])

    def test_structured_interpreter_conditional_intent_is_diagnostic(self):
        self._present_checked_for_interpreter('conditional-owner',
                                              'Book it if the transfer is included')
        conditional = self.ledger.interpret_owner_turn({
            'action': 'accept', 'action_evidence': 'Book it if the transfer is included',
            'ambiguous': False, 'negated': False, 'conditional': True,
            'material_changes': [], 'completions': {},
        })
        self.assertTrue(conditional['diagnostic_only'])
        self.assertNotIn('accepted', conditional)
        state = self.ledger._transaction(lambda stored, _ingress: deepcopy(stored))
        self.assertEqual(state['status'], 'offered')

    def test_structured_interpreter_rejects_material_change_and_fake_evidence(self):
        """Legacy evidence has no authority; changed dates warn without replacing facts."""
        self._present_checked_for_interpreter('changed-owner',
                                              'Book it, but move us to next week')
        before = self._phase1b_rows()
        diagnostic = self.interpret('Book it, but move us to next week', material_changes=[{
            'field': 'check_in', 'value': '2026-11-08', 'evidence': 'next week'}])
        self.assertTrue(diagnostic['diagnostic_only'])
        self.assertEqual(self._phase1b_rows(), before)
        prepared = self.assert_prepares_with_warning(
            {'confirm': True, 'check_in': '2026-11-08'}, 'accepted_quote_changed')
        self.assertEqual(prepared['check_in'], '2026-11-01')
        self.assertEqual(prepared['guests'], [{'name': 'Riley'}, {'name': 'Morgan'}])
        self.assertEqual(prepared['accepted_offer']['check_in'], prepared['check_in'])
        self.assertEqual(
            self.ledger._transaction(lambda stored, _ingress: stored['status']), 'accepted')

        self.turn('reply-2', 'Please reserve this')
        before = self._phase1b_rows()
        self.interpret('book it')  # Deliberately fabricated evidence is diagnostic, not authority.
        self.interpret('Please reserve this')
        self.assertEqual(self._phase1b_rows(), before)
        self.assertEqual(
            self.ledger._transaction(lambda stored, _ingress: stored['status']), 'accepted')
        self.assertTrue(self.checked_create()['require_offer_identity'])

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
        offline_quote_result({'completed': True, 'final_response': 'draft'})
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
        self.assertTrue(result['diagnostic_only'])
        # Scripted model asks about breakfast; no typed create/update decision.
        state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
        self.assertEqual(state['status'], 'offered')
        self.assertNotIn('acceptance_message', state)
        self.assertEqual(state['plan']['guests'][0]['name'], 'Aisha')

    def test_accept_with_checkout_change_and_partial_name_completion_requotes(self):
        self._present_three_guest_quote_with_two_anonymous_guests('checkout-change-partial-name')
        raw = 'I accept, but change checkout to 2026-11-09. I am Aisha Rahman.'
        self.turn('checkout-change-partial-name-accept', raw)
        result = self.ledger.update_booking_plan({'operation': 'revise', 'changes': {
            'check_out': '2026-11-09',
            'guests': [{'guest_index': 0, 'name': 'Aisha Rahman'}]}})
        self.assertEqual(result['next_action'], 'requote_material_changes')
        revised = self.ledger.prepare_quote({})
        self.assertEqual(revised['check_out'], '2026-11-09')
        self.assertEqual(revised['guests'][0]['name'], 'Aisha Rahman')
        self.assertEqual(revised['catalog_selections'], self.plan['catalog_selections'])
        prepared = self.assert_prepares_with_warning(
            {'confirm': True}, 'quote_owner_presented_offer_required')
        self.assertEqual(prepared['check_out'], revised['check_out'])
        self.assertEqual(prepared['guests'], revised['guests'])
        self.assertEqual(prepared['catalog_selections'], revised['catalog_selections'])

    def test_unconditional_accept_with_partial_name_completion_requires_full_roster(self):
        self._present_three_guest_quote_with_two_anonymous_guests('accept-partial-name')
        raw = 'I accept. I am Aisha Rahman.'
        self.turn('accept-partial-name-accept', raw)
        self.assert_model_details_warn({'confirm': True, 'guests': [
            {'name': 'Aisha Rahman'}, {'name': ''}, {'name': ''}]})

    def test_structured_acceptance_survives_reopen_but_not_cross_owner(self):
        self._present_checked_for_interpreter('structured-restart', 'Perfecto, haz la reserva')
        accepted = {
            'action': 'accept', 'action_evidence': 'Perfecto, haz la reserva',
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [], 'completions': {},
        }
        self.assertTrue(self.ledger.interpret_owner_turn(accepted)['diagnostic_only'])
        prepared = self.checked_create()
        operation_key = prepared['idempotency_key']
        self.db.close()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.agent._session_db = self.db
        self.turn('retry', 'Please proceed')
        self.assertTrue(self.ledger.prepare_create({})['require_offer_identity'])
        self.assertEqual(self.ledger.prepare_create({})['idempotency_key'], operation_key)

        self.ledger.close_turn()
        self.agent.session_id = 'foreign-owner'
        self.db.create_session('foreign-owner', source='whatsapp')
        self.turn('foreign', 'Perfecto, haz la reserva', chat_id='foreign-chat',
                  user_id='foreign-user', session_key='foreign-key')
        empty = self.assert_empty_owner_create()
        self.assertNotEqual(empty['idempotency_key'], operation_key)

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
        self.assertEqual(intent_schema['required'], [])
        self.assertEqual(intent_schema['properties'], {})
        self.agent.session_id = 'registered-structured-g4-owner'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = {**self.plan, 'room_type': 'shared', 'room_preference': 'male_only',
                'group_gender': 'male',
                'room_name_hints': [{'name': 'Mateo Ríos', 'explicit_gender': 'male'},
                                    {'name': 'Diego Navarro', 'explicit_gender': 'male'}],
                # The Staff builder consumes canonical guest facts, not the
                # request-only hints. Both occupants are explicitly identified.
                'guests': [{'name': 'Mateo Ríos', 'explicit_gender': 'male'},
                           {'name': 'Diego Navarro', 'explicit_gender': 'male'}],
                'payment_choice': 'deposit'}
        beds = [dict(bed_code='M1', room_code='M', gender_strategy='male_only'),
                dict(bed_code='M2', room_code='M', gender_strategy='male_only')]
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        response = FirstYesOwnerTests._checked_offer(object.__new__(FirstYesOwnerTests), plan, beds)
        self.turn('registered-g4-offer', 'Quote this please')
        self.ledger.record_quote(plan, response)
        offline_quote_result({'completed': True, 'final_response': 'draft'})
        raw = 'dale, book it — Mateo Ríos. send deposit link if needed'
        self.turn('registered-g4-accept', raw)
        before_diagnostic = self._phase1b_rows()
        interpreted = json.loads(intent_tool['handler']({
            'action': 'accept', 'action_evidence': raw,
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [],
            'completions': {'guests': [{'guest_index': 0, 'name': 'Mateo Ríos',
                                        'evidence': 'Mateo Ríos'}],
                            'payment_choice': {'value': 'deposit',
                                               'evidence': 'send deposit link if needed'}},
        }))
        self.assertTrue(interpreted['diagnostic_only'])
        self.assertEqual(self._phase1b_rows(), before_diagnostic)
        calls = []
        def api(path, body):
            calls.append((path, deepcopy(body)))
            if path == '/booking-preview':
                return self.checked(plan, beds)
            if path == '/availability-check':
                return {'success': True, 'has_enough_beds': True,
                        'exact_bed_eligibility': {
                            'eligible': True, 'selected_bed_codes': ['M1', 'M2'],
                            'guest_bed_assignments': [
                                {'guest_index': 0, 'guest_name': 'Mateo Ríos', 'bed_code': 'M1'},
                                {'guest_index': 1, 'guest_name': 'Diego Navarro', 'bed_code': 'M2'},
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
        self.assertEqual([path for path, _ in calls], [
            '/booking-preview', '/availability-check', '/booking-create-from-plan'])
        self.assertEqual(calls[-1][0], '/booking-create-from-plan')
        self.assertEqual(calls[-1][1]['guests'], plan['guests'])
        self.assertEqual(calls[-1][1]['accepted_offer'], response['offer_revision'])
        self.assertEqual(calls[-1][1]['selected_bed_codes'], ['M1', 'M2'])

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
        offline_quote_result({'completed': True, 'final_response': 'draft'})
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
                'guests': [{'name': 'Mateo', 'explicit_gender': 'male'},
                           {'name': 'Diego Navarro', 'explicit_gender': 'male'}],
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
        shown = offline_quote_result({
            'completed': True,
            'final_response': 'Total: 200.00 EUR. Deposit: 100.00 EUR. Would you like deposit or full?',
            'messages': [{'role': 'assistant', 'id': 'reply-incomplete',
                          'content': 'Total: 200.00 EUR. Deposit: 100.00 EUR. Would you like deposit or full?'}],
        })
        self.assertNotIn('Would you like deposit or full?', shown['final_response'])
        self.assertIn('Would you like to pay together (one person pays the deposit for everyone) or separately (each person gets their own deposit link)?', shown['final_response'])
        raw = 'dale, book it — Mateo Ríos. send deposit link if needed'
        self.turn('incomplete-accept', raw)
        result = self.ledger.prepare_create({'confirm': True, 'guests': [
            {'name': 'Mateo Ríos', 'explicit_gender': 'male'},
            {'name': 'Diego Navarro', 'explicit_gender': 'male'}],
            'payment_choice': 'deposit'})
        self.assertTrue(result.revalidation)
        self.assertNotIn('accepted_offer', result)
        revalidation = self.ledger.prepare_quote(dict(result))
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
        for export_id, names in ((3001, ('Emre Yilmaz', 'Diego Navarro')),
                                 (3004, ('Mateo Ríos', 'Diego Navarro'))):
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
                offline_quote_result(
                    {'completed': True, 'final_response': 'draft'})

                raw = 'Book it with the deposit'
                self.turn(f'export-{export_id}-create-1', raw)
                accepted = self.ledger.prepare_create({'confirm': True, 'payment_choice': 'deposit'})
                self.assertTrue(accepted.revalidation)
                self.assertNotIn('accepted_offer', accepted)
                revalidation = self.ledger.prepare_quote(dict(accepted))
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
                                                {'name': 'Diego Navarro'}]}
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
                    shown = offline_quote_result(
                        {'completed': True, 'final_response': 'model draft', 'messages': []})
                    self.assertIn('Would you like to pay together (one person pays the deposit for everyone) or separately (each person gets their own deposit link)?', shown['final_response'])
                    raw = f'I choose {choice}'
                    self.turn(f'producer-accept-{choice}', raw)
                    prepared = self.ledger.prepare_create({'confirm': True, 'payment_choice': choice})
                    self.assertTrue(prepared.revalidation)
                    self.assertNotIn('accepted_offer', prepared)
                    revalidated = json.loads(registry.tools['quote_booking']['handler'](dict(prepared)))
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
        offline_quote_result({'completed': True, 'final_response': 'draft'})
        raw = "€ that works. lock it in please — Emre Yilmaz, I'll pay the deposit when you send the link"
        self.turn('accepted-known-full-name-completion', raw)
        self.interpret(raw)
        prepared = self.ledger.prepare_create({})
        self.assertEqual(prepared['guests'], plan['guests'])

    def test_accepted_create_warns_on_changed_terms_without_guessing_name(self):
        self.agent.session_id = 'accepted-name-payment-changed-owner'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        plan = {**self.plan, 'payment_choice': 'deposit'}
        self.turn('accepted-name-payment-change-offer', 'Quote this please')
        self.present(plan)
        self.turn('accepted-name-payment-change-consent', 'I accept the quote')
        self.turn('accepted-name-payment-change',
                  "My full name is Emre Kaya and I'll pay the deposit for 8 nights instead")
        prepared = self.assert_prepares_with_warning(
            {'check_out': '2026-11-09'}, 'accepted_quote_changed')
        self.assertEqual(prepared['check_out'], plan['check_out'])
        self.assertEqual(prepared['guests'], plan['guests'])
        self.assertEqual(prepared['accepted_offer']['check_out'], plan['check_out'])

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
        offline_quote_result({'completed': True, 'final_response': 'draft'})
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
        prepared = self.assert_model_details_warn({}, 'quote_owner_presented_offer_required')
        self.assertEqual(prepared['guests'], revalidation['guests'])
        self.assertEqual(prepared['guests'], plan['guests'])
        # The diagnostic interpreter above did not supply a model create roster.

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
        offline_quote_result({'completed': True, 'final_response': 'draft'})
        self.turn('accepted-conflicting-name',
                  "Lock it in — my full name is Alice Smith and I'll pay the deposit")
        # Omitted model roster must never be replaced from raw name-like wording.
        self.assertEqual(self.ledger.prepare_create({})['guests'], plan['guests'])

    def test_named_removal_authorizes_only_evidenced_material_field(self):
        raw = 'Remove the yoga'
        self.turn('remove-yoga', raw)
        result = self.ledger.update_booking_plan({'operation': 'revise', 'changes': {
            'catalog_selections': [{'operation': 'remove',
                                    'item': {'service_code': 'yoga_class'}}]}})
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
        result = self.ledger.update_booking_plan({'operation': 'revise', 'changes': {
            'check_in': '2026-11-02'}})
        self.assertEqual(result['next_action'], 'requote_material_changes')
        self.assertEqual(self.ledger.prepare_quote({'check_in': '2026-11-07'})['check_in'],
                         '2026-11-07')
        revised = self.ledger.prepare_quote({'check_in': '2026-11-02'})
        self.assertEqual(revised['check_in'], '2026-11-02')
        self.assertEqual(revised['check_out'], self.plan['check_out'])
        self.assertEqual(revised['catalog_selections'], self.plan['catalog_selections'])
        prepared = self.assert_prepares_with_warning(
            {'confirm': True}, 'quote_owner_presented_offer_required')
        self.assertEqual(prepared['check_in'], revised['check_in'])
        self.assertEqual(prepared['check_out'], revised['check_out'])
        self.assertEqual(prepared['guests'], revised['guests'])
        self.assertEqual(prepared['catalog_selections'], revised['catalog_selections'])

    def test_material_revision_warns_on_unquoted_create_date(self):
        raw = 'Move check-in to 2026-11-02.'
        self.turn('move-date-mismatch', raw)
        # Restated dates warn rather than veto; owner-held dates and Staff's
        # quote remain authoritative, never fabricated for the new date.
        prepared = self.assert_prepares_with_warning(
            {'confirm': True, 'check_in': '2030-01-01'}, 'accepted_quote_changed')
        self.assertEqual(prepared['check_in'], self.plan['check_in'])
        self.assertEqual(prepared['accepted_offer'], self.response['offer_revision'])
        self.assertEqual(prepared['guests'], self.plan['guests'])

    def test_material_revision_preserves_invalid_date_refusal_but_create_warns(self):
        raw = 'Date numbers are 02, 11, and 2026.'
        self.turn('reordered-date', raw)
        before = self._phase1b_rows()
        self.interpret(raw, action='revise', material_changes=[{
            'field': 'check_in', 'value': '2026-11-02', 'evidence': '02, 11, and 2026'}])
        self.assertEqual(self._phase1b_rows(), before)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'booking_plan_update_invalid'):
            self.ledger.update_booking_plan({'operation': 'revise', 'changes': {
                'check_in': '02-11-2026'}})
        prepared = self.assert_prepares_with_warning(
            {'confirm': True, 'check_in': '2026-11-02'}, 'accepted_quote_changed')
        self.assertEqual(prepared['check_in'], self.plan['check_in'])
        self.assertEqual(prepared['accepted_offer'], self.response['offer_revision'])

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
        # Gender is a person-bound fact, not a substring of model evidence.
        # A group label alone is not a frozen person fact. Establish the actual
        # female eligibility before probing the contradictory male completion.
        plan = {**self.plan, 'guests': [
            {'name': 'Alex', 'explicit_gender': 'female'}, {'name': 'Sam'}],
            'room_name_hints': [{'name': 'Alex', 'explicit_gender': 'female'}]}
        self.present(plan, self.checked(plan))
        raw = 'Make it female.'
        self.turn('gender-substring', raw)
        before = self._phase1b_rows()
        self.interpret(raw, action='revise', material_changes=[{
            'field': 'group_gender', 'value': 'male', 'evidence': 'female'}])
        self.assertEqual(self._phase1b_rows(), before)
        self.assert_model_details_warn({'confirm': True, 'guests': [
            {'name': 'Alex', 'explicit_gender': 'male'}, {'name': 'Sam'}]})

    def test_eligibility_rejects_name_substring_collision(self):
        raw = 'Alexandra is male.'
        self.turn('name-substring', raw)
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'quote_completion_identity_changed'):
            self.ledger.update_booking_plan({'operation': 'revise', 'changes': {
                'guests': [{'guest_index': 0, 'name': 'Alexandra', 'explicit_gender': 'male'}]}})
        self.assert_model_details_warn({'confirm': True, 'guests': [
            {'name': 'Alexandra', 'explicit_gender': 'male'}, {'name': 'Sam'}]})

    def test_list_revision_rejects_unevidenced_quantity(self):
        raw = 'Add one yoga class'
        self.turn('add-yoga-mismatch', raw)
        prepared = self.assert_prepares_with_warning(
            {'confirm': True, 'catalog_selections': [
                {'service_code': 'yoga_class', 'quantity': 999}]}, 'accepted_quote_changed')
        self.assertEqual(prepared['catalog_selections'], self.plan['catalog_selections'])
        self.assertEqual(prepared['guests'], self.plan['guests'])
        self.assertEqual(prepared['accepted_quote'], self.response)
        self.assertEqual(self.ledger.prepare_quote({})['catalog_selections'],
                         self.plan['catalog_selections'])

    def test_multiple_evidenced_list_revisions_apply_in_order(self):
        raw = 'Remove yoga and add 2 meals'
        self.turn('multi-list-change', raw)
        result = self.ledger.update_booking_plan({'operation': 'revise', 'changes': {
            'catalog_selections': [
                {'operation': 'remove', 'item': {'service_code': 'yoga_class'}},
                {'operation': 'add', 'item': {'service_code': 'meal', 'quantity': 2}}]}})
        self.assertEqual(result['next_action'], 'requote_material_changes')
        revised = self.ledger.prepare_quote({})
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
        offline_quote_result({'completed': True, 'final_response': 'draft'})
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
        before = self._phase1b_rows()
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    'booking_plan_update_invalid'):
            self.ledger.update_booking_plan({'operation': 'revise', 'changes': {
                'catalog_selections': [
                    {'operation': 'remove', 'item': {'service_code': 'yoga_class'}},
                    {'operation': 'add', 'item': {'service_code': 'yoga_class'}}]}})
        self.assertEqual(self._phase1b_rows(), before)

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
                                    'quote_completion_identity_changed'):
            self.ledger.update_booking_plan({'operation': 'revise', 'changes': {
                'guests': [{'guest_index': 0, 'name': 'Guest Two', 'explicit_gender': 'male'}]}})

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
            if path == '/availability-check':
                checked = self.checked({**body, 'package_code': 'package_none',
                    'payment_choice': 'deposit', 'selected_bed_codes': ['M1', 'M2']})
                return {'success': checked['success'], **checked['availability']}
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
            offline_quote_result(
                {'completed': True, 'final_response': 'draft', 'messages': []})
            raw = 'Remove the yoga and add 3 wetsuit rental'
            self.turn('wire-remove-yoga', raw)
            revised = json.loads(registry.tools['update_booking_plan']['handler']({
                'operation': 'revise', 'changes': {
                    'catalog_selections': [{'operation': 'remove', 'item': {'service_code': 'yoga_class'}}],
                    'add_ons': [{'operation': 'add', 'item': {'code': 'wetsuit_rental', 'quantity': 3}}],
                },
            }))
            self.assertEqual(revised['next_action'], 'requote_material_changes', revised)
            result = json.loads(registry.tools['quote_booking']['handler']({
                'catalog_selections': [],
                'add_ons': [{'code': 'wetsuit_rental', 'quantity': 3}],
            }))
            self.assertTrue(result['success'], result)
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
        self.assert_model_details_warn({'confirm': True, 'guests': [
            {'name': 'Sam Smith'}, {'name': 'Sam'}]})
        self.turn('same-person-name', 'Book it for Alex Grey')
        accepted = self.checked_create({'guests': [{'name': 'Alex Grey'}, {'name': 'Sam'}]})
        self.assertEqual(accepted['guests'][0]['name'], 'Alex Grey')
        reordered = self.ledger.prepare_quote({'guests': [
            {'name': 'Sam'}, {'name': 'Alex Grey'}]})
        eligibility = self.ledger.validated_guest_eligibility(reordered)
        self.assertNotIn(0, eligibility)
        self.assert_model_details_warn({'guests': reordered['guests']})

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
        offline_quote_result({'completed': True, 'final_response': 'draft'})
        raw = 'Book it for Alex Smith'
        self.turn('collision-completion', raw)
        self.assert_model_details_warn({'confirm': True, 'guests': [
            {'name': 'Alex Smith'}, {'name': 'Alex Smith'}]})

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
        offline_quote_result({'completed': True, 'final_response': 'draft'})
        raw = 'Book it for Alex Grey'
        self.turn('duplicate-completion', raw)
        self.assert_model_details_warn({'confirm': True, 'guests': [
            {'name': 'Alex Grey'}, {'name': 'Alex'}]})
        # Explicit model details disambiguate the occupant; no invented names.
        self.ledger.update_booking_plan({'operation': 'revise', 'changes': {
            'guests': [{'guest_index': 0, 'name': 'Alex Grey'}]}})
        revised = self.ledger.prepare_quote({})
        self.assertEqual(revised['guests'], [{'name': 'Alex Grey'}, {'name': 'Alex'}])
        prepared = self.ledger.prepare_create({})
        self.assertFalse(prepared.revalidation)
        self.assertEqual(prepared['guests'], revised['guests'])
        beds = [dict(bed_code=code, room_code='M', gender_strategy='mixed')
                for code in ('M1', 'M2')]
        response = self.checked(revised, beds)
        self.ledger.record_quote(revised, response)
        offline_quote_result({'completed': True, 'final_response': 'draft'})
        self.turn('duplicate-indexed-accept', 'Book the displayed offer')
        completed = self.checked_create(beds=beds)
        self.assertEqual(completed['guests'], revised['guests'])
        self.assertEqual(completed['selected_bed_codes'], ['M1', 'M2'])

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
            offline_quote_result(
                {'completed': True, 'final_response': 'draft', 'messages': []})
            raw = 'Yes, I am male'
            self.turn('eligibility-answer', raw)
            accepted = self.ledger.prepare_create({'confirm': True, 'guests': [
                {'name': 'Alex Grey', 'explicit_gender': 'male'},
                {'name': 'Sam Lee', 'explicit_gender': 'male'}]})
            self.assertTrue(accepted.revalidation)
            checked = json.loads(registry.tools['quote_booking']['handler'](dict(accepted)))
            self.assertTrue(checked['success'])
            self.ledger.prepare_create({})
            raw = 'Sam Lee is male'
            self.turn('eligibility-partner-answer', raw)
            accepted = self.ledger.prepare_create({'confirm': True, 'guests': [
                {'name': 'Alex Grey', 'explicit_gender': 'male'},
                {'name': 'Sam Lee', 'explicit_gender': 'male'}]})
            self.assertEqual(accepted['accepted_offer'], checked['offer_revision'])
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
                plan['guests'] = [{'name': 'Mateo'}, {'name': 'Diego Navarro'}]
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
                    offline_quote_result(
                        {'completed': True, 'final_response': 'draft', 'messages': []})
                    def complete(message_id, raw, values):
                        self.turn(message_id, raw)
                        return self.ledger.prepare_create({'confirm': True, **values})
                    name = {'guests': [{'name': 'Mateo Ríos'}, {'name': 'Diego Navarro'}]}
                    payment = {'payment_choice': 'deposit'}
                    steps = ((name, 'Book it for Mateo Ríos'), (payment, 'deposit'))
                    if order == 'payment_first':
                        steps = tuple(reversed(steps))
                    for index, (completion, raw) in enumerate(steps):
                        result = complete(f'{order}-{index}', raw, completion)
                        self.assertTrue(result.revalidation)
                        self.assertNotIn('accepted_offer', result)
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
        self.assertTrue(interpreted['diagnostic_only'])
        guests = deepcopy(self.plan['guests'])
        guests[0]['explicit_gender'] = 'male'
        create = self.ledger.prepare_create({'confirm': True, 'guests': guests})
        self.assertTrue(create.revalidation)
        prepared = self.ledger.prepare_quote(dict(create))
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
                    self.assert_empty_owner_create()
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

    def assert_model_details_warn(self, params, warning='quote_completion_identity_changed'):
        """Model facts survive; advisory diagnostics are not verified eligibility."""
        state = self.ledger._transaction(lambda owner, _ingress: deepcopy(owner))
        presentation = state.get('accepted_presentation') or state.get('presentation') or {}
        offer = (presentation.get('quote_revision') or state.get('checked_offer')
                 or (state.get('quote') or {}).get('offer_revision'))
        prepared = self.assert_prepares_with_warning(params, warning)
        for key in ('guests', 'room_name_hints'):
            if key in params:
                self.assertEqual(prepared[key], params[key])
        if offer:
            self.assertEqual(prepared['accepted_offer'], offer)
        return prepared

    def assert_prepares_with_warning(self, params, warning):
        prepared = self.ledger.prepare_create(params)
        self.assertTrue(prepared['confirm'])
        self.assertTrue(prepared['always_save_accepted_booking'])
        self.assertFalse(prepared.revalidation)
        self.assertIn(warning, prepared['booking_check_warnings'])
        state = self.ledger._transaction(lambda owner, _ingress: deepcopy(owner))
        self.assertEqual(state['status'], 'accepted')
        self.assertEqual(state['booking_check_warnings'], prepared['booking_check_warnings'])
        self.assertEqual(state['operation_key'], prepared['idempotency_key'])
        return prepared

    def test_model_create_without_presentation_warns_and_keeps_owner_facts(self):
        self.ledger._transaction(lambda state, ingress: state.pop('presentation', None))
        prepared = self.assert_prepares_with_warning(
            {'confirm': True}, 'quote_owner_presented_offer_required')
        self.assertEqual(prepared['accepted_offer'], self.response['offer_revision'])
        self.assertEqual(prepared['accepted_quote'], self.response)
        self.assertEqual(prepared['guests'], self.plan['guests'])
        self.assertEqual(prepared['selected_bed_codes'], self.plan['selected_bed_codes'])

    def test_ambiguous_yes_is_not_acceptance(self):
        self.model_waits('ambiguous-model', 'yes, but which room?')

    def test_changed_create_picks_warn_without_rewriting_owner_quote(self):
        self.accept()
        # Catalog changes are diagnostic, not a veto on accepted booking save.
        self.ledger.prepare_create({'catalog_selections': []})
        for picks in ([{'service_code': 'drone', 'quantity': 2}], [{'service_code': 'yoga_class', 'quantity': 1}]):
            with self.subTest(picks=picks):
                prepared = self.assert_prepares_with_warning(
                    {'catalog_selections': picks}, 'quote_owner_acceptance_required')
                self.assertEqual(prepared['catalog_selections'], self.plan['catalog_selections'])
                self.assertEqual(prepared['accepted_offer'], self.response['offer_revision'])
                self.assertEqual(prepared['accepted_quote'], self.response)
        self.assertEqual(self.ledger.prepare_quote({'catalog_selections': []})['add_ons'], [])
        self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])

    def test_revision_without_fresh_presentation_prepares_with_warning(self):
        self.accept()
        raw = 'Remove the yoga'
        self.turn('m3', raw)
        self.ledger.update_booking_plan({'operation': 'revise', 'changes': {
            'catalog_selections': [{'operation': 'remove',
                                    'item': {'service_code': 'yoga_class'}}]}})
        revised = self.ledger.prepare_quote({'catalog_selections': []})
        self.ledger.record_quote(revised, self.checked({
            **revised, 'selected_bed_codes': self.plan['selected_bed_codes']}))
        # Missing presentation is advisory once the model invokes create.
        prepared = self.assert_prepares_with_warning(
            {}, 'quote_owner_presented_offer_required')
        self.assertEqual(prepared['catalog_selections'], [])
        self.assertEqual(prepared['guests'], self.plan['guests'])
        self.assertEqual(prepared['check_in'], self.plan['check_in'])
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

    def assert_empty_owner_create(self):
        prepared = self.assert_prepares_with_warning(
            {'confirm': True}, 'quote_owner_presented_offer_required')
        self.assertIsNone(prepared['accepted_quote'])
        for field in ('accepted_offer', 'require_offer_identity', 'guests',
                      'selected_bed_codes', 'catalog_selections', 'check_in', 'check_out',
                      'room_name_hints', 'payment_choice'):
            self.assertNotIn(field, prepared)
        return prepared

    def test_tenant_chat_and_session_isolation(self):
        self.accept()
        operation_key = self.ledger.prepare_create({})['idempotency_key']
        self.turn('foreign', 'I accept the quote', chat_id='chat2')
        chat = self.assert_empty_owner_create()
        self.assertNotEqual(chat['idempotency_key'], operation_key)
        with patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'other'}):
            self.turn('foreign2', 'I accept the quote')
            with self.assertRaises(self.ledger.QuoteBoundaryError):
                self.ledger.prepare_create({})
        self.db.create_session('s2', source='whatsapp')
        self.agent.session_id = 's2'
        self.turn('foreign3', 'I accept the quote')
        session = self.assert_empty_owner_create()
        self.assertNotEqual(session['idempotency_key'], operation_key)
        self.assertNotEqual(session['idempotency_key'], chat['idempotency_key'])

    def test_reset_revokes_even_active_turn(self):
        self.accept()
        self.db.end_session('s1', 'reset')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_changed_raw_acceptance_fails_closed(self):
        for text in ('Yes, create the booking without yoga', 'Yes, create the booking with the Drone session included for both of us',
                     'I accept the quote but change dates to 2026-12-01'):
            self.model_waits(text, text)

    def test_refused_catalog_selection_is_retained_as_accepted_create_diagnostic(self):
        # This is a FIRST refused offer, not an unauthorized Yoga -> Drone replacement.
        self.db.create_session('first-refused-offer', source='whatsapp')
        self.agent.session_id = 'first-refused-offer'
        self.turn('refused-offer', 'Please quote this')
        self.ledger.record_quote({**self.plan, 'catalog_selections': [{'service_code': 'drone', 'quantity': 2}]},
                                 {'success': False, 'error': 'catalog_selection_not_atomic'})
        self.turn('m2', 'Yes, create the booking with the Drone session included for both of us')
        restored = self.ledger.prepare_quote({'check_in': '2026-11-01'})
        self.assertEqual(restored['catalog_selections'], [{'service_code': 'drone', 'quantity': 2}])
        prepared = self.assert_prepares_with_warning(
            {}, 'quote_owner_presented_offer_required')
        self.assertEqual(prepared['catalog_selections'], restored['catalog_selections'])
        self.assertEqual(prepared['guests'], self.plan['guests'])
        self.assertIsNone(prepared['accepted_quote'])
        self.assertNotIn('accepted_offer', prepared)

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
                             ['/booking-preview', '/booking-preview', '/availability-check',
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
        self.assertFalse(prepared.revalidation)
        self.assertEqual(prepared['group_gender'], 'mixed')
        prepared = self.ledger.prepare_quote(dict(prepared))
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
        contradictory = self.ledger.prepare_quote(dict(contradictory))
        changed = self.checked({**dict(contradictory), 'selected_bed_codes': ['F1', 'F2']},
                               [dict(bed_code='F1', room_code='F', gender_strategy='female_only'),
                                dict(bed_code='F2', room_code='F', gender_strategy='female_only')])
        self.ledger.record_quote(contradictory, changed)
        self.assert_model_details_warn({}, 'quote_owner_presented_offer_required')

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
        self.assertFalse(carried.revalidation)
        carried = self.ledger.prepare_quote(dict(carried))
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
            with self.subTest(change=change):
                prepared = self.assert_prepares_with_warning(change, 'accepted_quote_changed')
                self.assertEqual(prepared['accepted_offer'], first['accepted_offer'])
                self.assertEqual(prepared['idempotency_key'], key)
                for field in change:
                    self.assertEqual(prepared[field], first[field])

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
                old_key = self.checked_create()['idempotency_key']
                changed = {**deepcopy(self.plan), **change}
                self.turn(f'offer-{index}-b', 'Please quote the changed offer')
                self.present(changed, self.checked(changed))
                self.turn(f'accept-{index}-b', 'yes')
                self.assertNotEqual(self.checked_create()['idempotency_key'], old_key)

        self.agent.session_id = 'jw1749-new-operation-price'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('price-offer-a', 'Quote this please')
        original = self.present()
        self.turn('price-accept-a', 'yes')
        old_key = self.checked_create()['idempotency_key']
        price_change = {field: original['offer_revision'][field] + 1000
                        for field in ('total_cents', 'deposit_required_cents', 'payment_link_amount_cents')}
        repriced = self.checked(self.plan, quote_overrides=price_change)
        self.turn('price-offer-b', 'Please quote the new price')
        self.present(self.plan, repriced)
        self.turn('price-accept-b', 'yes')
        self.assertNotEqual(self.checked_create(quote_overrides=price_change)['idempotency_key'], old_key)

    def test_jw1749_newer_checked_tool_truth_supersedes_stale_eligibility(self):
        import json
        eligibility = {'success': True, 'availability_status': 'eligibility_required',
                       'next_action': 'ask_room_eligibility',
                       'reply_draft': 'Are all guests women?'}
        checked = self.checked()
        rendered = offline_quote_result({
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
        # Scripted model wording, not a claim that the finalizer repairs false prose.
        model_reply = "Would a mixed dorm work for you?"
        rendered = self.ledger.finalize_offer_response({
            'completed': True, 'final_response': model_reply,
            'messages': [
                {'role': 'user', 'content': 'Can I have a women-only dorm?'},
                {'role': 'tool', 'content': json.dumps(receipt)},
                {'role': 'assistant', 'content': model_reply},
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
        shown = offline_quote_result(
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
        shown = offline_quote_result(
            {'completed': True, 'final_response': 'as proposed', 'messages': []})
        self.assertIn('two separate mixed rooms', shown['final_response'])
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
        shown = offline_quote_result(
            {'completed': True, 'final_response': 'draft', 'messages': []})
        self.assertIn('💶 *Total:* €200', shown['final_response'])
        self.assertIn('¿Preferís pagar juntos (una persona paga el depósito de todos) o por separado (cada uno recibe su propio enlace de depósito)?', shown['final_response'])

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
                text = offline_quote_result({'completed': True, 'final_response': 'as proposed', 'messages': []})['final_response']
                self.assertNotIn('package_none', text)
                self.assertNotIn('None', text)
                self.assertNotIn(availability, text)
                self.assertIn('€200', text)
                self.assertIn('€100', text)
                self.assertEqual(text.count('€100'), 2)  # deposit once, remainder once
                self.assertNotIn('as proposed', text.casefold())
                self.assertNotRegex(text, r'\b(?:M|R\d+)(?:-B\d+)?\b')

                self.agent.session_id = f'sim19-{language}-incomplete'
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn(f'sim19-{language}-incomplete-turn', raw)
                incomplete = self.checked(plan)
                incomplete['payment_choice_needed'] = True
                incomplete_plan = {**plan, 'payment_choice': None}
                self.ledger.record_quote(incomplete_plan, incomplete)
                text = offline_quote_result({'completed': True, 'final_response': 'draft', 'messages': []})['final_response']
                self.assertIn(options, text)
                self.assertIn('€200', text)
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
        quote = offline_quote_result(
            {'completed': True, 'final_response': 'draft', 'messages': []}
        )['final_response']
        state = self.ledger._transaction(lambda state, _ingress: deepcopy(state))
        self.assertEqual(state['guest_language'], 'de')
        self.assertIn('*Daten:*', quote)
        self.assertIn('*Gesamt:*', quote)
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


class CountAdvisoryBoundaryTests(unittest.TestCase):
    """Advisory composition cannot preempt the original quote count validator."""

    def loop(self, label):
        from wolfhouse_staff_api.test_sim16_jonas_liam_fix import DeterministicRegisteredLoop
        loop = DeterministicRegisteredLoop(self, label)
        loop.turn(label, 'Please quote this stay')
        return loop

    @staticmethod
    def plan():
        # No aggregate demographic projection assertion: that contract is separate.
        return {'check_in': '2026-11-18', 'check_out': '2026-11-21',
                'package_code': 'package_none', 'room_type': 'shared',
                'room_preference': 'mixed', 'selected_bed_codes': ['M-B1', 'M-B2'],
                'guests': [{'name': 'Alex'}, {'name': 'Sam'}]}

    def test_registered_quote_preserves_count_aliases_and_original_validation(self):
        import wolfhouse_staff_api as plugin
        values = (None, '', [], False, True, '2', '4.0', 2.5, 0, -1, 1, 2, 41)
        cases = [({}, None)]
        for key in ('guest_count', 'num_guests', 'count'):
            for value in values:
                error = ('guest_count_not_positive' if type(value) is int and value <= 0
                         else 'guest_count_implausible' if value == 41 else None)
                cases.append(({key: value}, error if key == 'guest_count' else None))
        for index, (counts, error) in enumerate(cases):
            with self.subTest(counts=counts):
                loop = self.loop(f'count-wire-{index}')
                try:
                    args = {**self.plan(), **counts}
                    before = deepcopy(args)
                    with patch.object(plugin, 'guard_tool_input',
                                      wraps=plugin.guard_tool_input) as guard:
                        result = loop.call('quote_booking', args, {
                            '/booking-preview': {'success': False, 'error': 'offline_capture'}})
                    guard.assert_called_once()
                    self.assertEqual(guard.call_args.args[0], 'quote_booking')
                    guarded = guard.call_args.args[1]
                    for key in ('guest_count', 'num_guests', 'count'):
                        self.assertEqual(key in guarded, key in counts)
                        if key in counts:
                            self.assertEqual(guarded[key], counts[key])
                            self.assertIs(type(guarded[key]), type(counts[key]))
                    self.assertEqual(args, before)
                    if error:
                        self.assertEqual(result['input_error'], error)
                        self.assertFalse(result['success'])
                        self.assertEqual(loop.staff, [])
                    else:
                        self.assertEqual([row['route'] for row in loop.staff], ['/booking-preview'])
                        wire = loop.staff[0]['body']
                        for key in ('guest_count', 'num_guests', 'count'):
                            self.assertEqual(key in wire, key in counts)
                            if key in counts:
                                self.assertEqual(wire[key], counts[key])
                                self.assertIs(type(wire[key]), type(counts[key]))
                    self.assertEqual(loop.create_dispatches, [])
                finally:
                    loop.close()

    def test_advisory_requires_strict_positive_count_and_incomplete_roster(self):
        from wolfhouse import accepted_quote as owner
        cases = [
            ({'guest_count': 2, 'guests': []}, 'female'),
            ({'guest_count': 2}, 'female'),
            ({'guest_count': 2, 'guests': [{'name': 'A'}], 'group_gender': 'male'}, 'male'),
            ({'guest_count': 2, 'guests': [{'name': 'A'}, {'name': 'B'}]}, None),
            ({'guest_count': 1, 'guests': [{'name': 'A'}, {'name': 'B'}]}, None),
            ({'guest_count': 2, 'group_gender': 'mixed'}, None),
            ({'guest_count': 2, 'group_gender': 'unknown'}, None),
            ({'guest_count': 41}, 'female'),  # maximum belongs to original validator
            ({}, None),
        ]
        cases.extend(({'guest_count': count, 'guests': []}, None)
                     for count in (None, '', [], False, True, '2', 2.5, 0, -1))
        for index, (fields, expected) in enumerate(cases):
            with self.subTest(fields=fields):
                loop = self.loop(f'count-advisory-{index}')
                try:
                    prepared = owner.prepare_quote({'group_gender': 'female', **fields})
                    before = deepcopy(dict(prepared))
                    self.assertEqual(owner.validated_unnamed_group_composition(prepared), expected)
                    self.assertEqual(dict(prepared), before)
                finally:
                    loop.close()

    def test_advisory_preserves_person_contradiction_and_rejects_stale_capability(self):
        from wolfhouse import accepted_quote as owner
        loop = self.loop('count-advisory-authority')
        try:
            prepared = owner.prepare_quote({'guest_count': 2, 'group_gender': 'female',
                'guests': [{'name': 'A', 'explicit_gender': 'male'}, {'name': 'B'}]})
            before = deepcopy(dict(prepared))
            self.assertIsNone(owner.validated_unnamed_group_composition(prepared))
            self.assertEqual(owner.validated_guest_eligibility(prepared), {0: 'male', 1: 'female'})
            self.assertEqual(dict(prepared), before)
            invalid = owner.prepare_quote({'guest_count': None, 'group_gender': 'female'})
            # A real new turn invalidates capability; invalid count cannot bypass it.
            loop.turn('count-new-turn', 'Please check again')
            with self.assertRaisesRegex(owner.QuoteBoundaryError, 'quote_response_superseded'):
                owner.validated_unnamed_group_composition(invalid)
            with self.assertRaisesRegex(owner.QuoteBoundaryError, 'quote_response_superseded'):
                owner.validated_unnamed_group_composition(dict(invalid))
            stale_epoch = owner.prepare_quote({'guest_count': None, 'group_gender': 'female'})
            # Recording a real quote response advances epoch within the same capability.
            loop.call('quote_booking', {**self.plan(), 'guest_count': 2}, {
                '/booking-preview': {'success': False, 'error': 'offline_capture'}})
            current = owner._transaction(lambda state, _ingress: state['epoch'])
            self.assertIs(stale_epoch.capability, owner._current.get())
            self.assertNotEqual(stale_epoch.epoch, current)
            with self.assertRaisesRegex(owner.QuoteBoundaryError, 'quote_response_superseded'):
                owner.validated_unnamed_group_composition(stale_epoch)
        finally:
            loop.close()


if __name__ == '__main__':
    unittest.main()


class SoloDefaultEvidenceTests(unittest.TestCase):
    def test_default_requires_canonical_integer_one_without_rewriting_inputs(self):
        import wolfhouse_staff_api as plugin
        from wolfhouse import accepted_quote as owner
        token = owner._current.set(None)
        try:
            cases = [{}, {'num_guests': 4}, {'count': 4}, {'num_guests': 1}]
            cases += [{'guest_count': value} for value in
                      (None, '', [], False, True, 0, -1, 1.5, '1', 2)]
            for fields in cases:
                with self.subTest(fields=fields):
                    payload = {'room_type': 'shared', **deepcopy(fields)}
                    before = deepcopy(payload)
                    plugin._default_solo_shared_placement(payload)
                    self.assertEqual(payload, before)
            for fields in ({}, {'explicit_gender': 'male'}):
                payload = {'guest_count': 1, **fields}
                plugin._default_solo_shared_placement(payload)
                self.assertEqual(payload, {'guest_count': 1, **fields, 'room_preference': 'mixed'})
            for fields in ({'explicit_gender': 'female'}, {'group_gender': 'female'},
                           {'guests': [{'name': 'A', 'explicit_gender': 'female'}]},
                           {'gender_preference': 'female'}, {'room_type': 'private'},
                           {'room_preference': 'R5'}):
                payload = {'guest_count': 1, **deepcopy(fields)}
                before = deepcopy(payload)
                plugin._default_solo_shared_placement(payload)
                self.assertEqual(payload, before)
        finally:
            owner._current.reset(token)


class MixedMetadataBoundaryTests(unittest.TestCase):
    def test_registered_wire_preserves_mixed_but_only_person_facts_authorize(self):
        from wolfhouse import accepted_quote as owner
        from wolfhouse_staff_api.test_sim16_jonas_liam_fix import DeterministicRegisteredLoop
        parties = [[], [{'name': 'Alex'}], [{'name': 'Alex'}, {'name': 'Sam'}],
                   [{'name': 'Alex', 'explicit_gender': 'male'}, {'name': 'Sam', 'explicit_gender': 'male'}],
                   [{'name': 'Alex', 'explicit_gender': 'female'}, {'name': 'Sam', 'explicit_gender': 'female'}],
                   [{'name': 'Alex', 'explicit_gender': 'male'}, {'name': 'Sam', 'explicit_gender': 'female'}]]
        for index, guests in enumerate(parties):
            with self.subTest(guests=guests):
                loop = DeterministicRegisteredLoop(self, f'metadata-wire-{index}')
                try:
                    loop.turn('quote', 'Please quote this stay')
                    args = {**CountAdvisoryBoundaryTests.plan(), 'guest_count': 2,
                            'group_gender': 'mixed', 'guests': guests,
                            'room_name_hints': [{'name': 'Alex', 'explicit_gender':
                                                 (guests[0].get('explicit_gender') if guests else None) or 'female'}]}
                    prepared = owner.prepare_quote(args)
                    expected = {i: row['explicit_gender'] for i, row in enumerate(guests)
                                if 'explicit_gender' in row}
                    self.assertEqual(owner.validated_guest_eligibility(prepared), expected)
                    self.assertIsNone(owner.validated_unnamed_group_composition(prepared))
                    loop.call('quote_booking', args, {
                        '/booking-preview': {'success': False, 'error': 'offline_capture'}})
                    self.assertEqual(len(loop.staff), 1)
                    wire = loop.staff[0]['body']
                    self.assertEqual(wire.get('group_gender'), 'mixed')
                    self.assertEqual(wire.get('guests', []), guests)
                    hints = [row for row in guests if 'explicit_gender' in row]
                    self.assertEqual(wire.get('room_name_hints', []), hints)
                    self.assertEqual(wire['guest_count'], 2)
                    self.assertEqual(wire['selected_bed_codes'], args['selected_bed_codes'])
                    self.assertEqual(loop.create_dispatches, [])
                    state = owner._transaction(lambda state, _ingress: deepcopy(state))
                    self.assertNotEqual(state.get('status'), 'accepted')
                    self.assertFalse(state.get('checked_offer'))
                    loop.turn('next', 'Please check again')
                    with self.assertRaisesRegex(owner.QuoteBoundaryError, 'quote_response_superseded'):
                        owner.validated_guest_eligibility(prepared)
                finally:
                    loop.close()

    def test_legacy_local_fallback_mixed_does_not_change_person_eligibility(self):
        import wolfhouse_staff_api as plugin
        from wolfhouse_staff_api.test_sim16_jonas_liam_fix import DeterministicRegisteredLoop
        for gender in ('male', 'female', None):
            for stock in ('male', 'female', 'mixed'):
                with self.subTest(gender=gender, stock=stock):
                    guests = [{'name': name, **({'explicit_gender': gender} if gender else {})}
                              for name in ('Alex', 'Sam')]
                    plan = {**CountAdvisoryBoundaryTests.plan(), 'guest_count': 2,
                            'room_preference': f'{stock}_only' if stock != 'mixed' else 'mixed',
                            'guests': guests}
                    plan.pop('selected_bed_codes')
                    receipt = {'success': True, 'has_enough_beds': True,
                               'selected_bed_codes': ['R-B1', 'R-B2']}
                    self.assertEqual(plugin._room_decision_for_tool(plan, receipt),
                                     plugin._room_decision_for_tool({**plan, 'group_gender': 'mixed'}, receipt))
                    loop = DeterministicRegisteredLoop(self, f'legacy-metadata-{gender}-{stock}')
                    try:
                        loop.turn('quote', 'Please quote this stay')
                        result = loop.call('quote_booking', {**plan, 'group_gender': 'mixed'}, {
                            '/availability-check': receipt,
                            '/booking-preview': {'success': False, 'error': 'offline_capture'}})
                        expected_routes = ['/availability-check']
                        if stock == 'mixed' or gender == stock:
                            expected_routes.append('/booking-preview')
                        self.assertEqual([row['route'] for row in loop.staff], expected_routes)
                        for row in loop.staff:
                            self.assertEqual(row['body'].get('group_gender'), 'mixed')
                        self.assertEqual(loop.create_dispatches, [])
                        self.assertFalse(result['success'])
                    finally:
                        loop.close()


class IncomingDistributionAliasTests(unittest.TestCase):
    def test_conflicting_incoming_aliases_fail_before_either_owner_transaction(self):
        from wolfhouse import accepted_quote as owner
        for prepare in (owner.prepare_quote, owner.prepare_create):
            for canonical, legacy in (('separate', 'together'), ('together', 'separate')):
                with self.subTest(boundary=prepare.__name__, canonical=canonical):
                    payload = {'payment_link_distribution': canonical,
                               'payment_distribution': legacy,
                               'guests': [{'name': 'Alex'}]}
                    before = deepcopy(payload)
                    # Admission must precede even acquiring the state writer.
                    with patch.object(owner, '_transaction', return_value={}) as transaction:
                        with self.assertRaisesRegex(owner.QuoteBoundaryError,
                                                    '^payment_distribution_conflict$'):
                            prepare(payload)
                        transaction.assert_not_called()
                    self.assertEqual(payload, before)

    def test_equivalent_and_single_aliases_keep_existing_normalization(self):
        from wolfhouse import accepted_quote as owner
        for value in ('together', 'separate'):
            mirror = value == 'separate'
            cases = [
                {'payment_link_distribution': value},
                {'payment_distribution': value},
                {'per_guest_payment_links': mirror},
                {'payment_link_distribution': value, 'payment_distribution': value},
                {'payment_distribution': value, 'per_guest_payment_links': mirror},
                {'payment_link_distribution': value, 'payment_distribution': value,
                 'per_guest_payment_links': mirror},
                {'payment_link_distribution': None, 'payment_distribution': value},
                {'payment_link_distribution': value, 'payment_distribution': None},
            ]
            for payload in cases:
                with self.subTest(payload=payload):
                    before = deepcopy(payload)
                    self.assertEqual(owner._normalize_completion_inputs(payload), {
                        'payment_link_distribution': value, 'per_guest_payment_links': mirror})
                    self.assertEqual(payload, before)

    def test_omission_null_and_non_alias_legacy_values_keep_existing_contract(self):
        from wolfhouse import accepted_quote as owner
        receipt = [{'guest_index': 0, 'amount_due_cents': 10000}]
        cases = [{}, {'payment_link_distribution': None}, {'payment_distribution': None},
                 {'payment_link_distribution': None, 'payment_distribution': None}]
        # Legacy non-alias values are not a newly invented validation policy.
        cases += [{'payment_distribution': value} for value in
                  ('unknown', False, 0, [], receipt)]
        for payload in cases:
            with self.subTest(payload=payload):
                before = deepcopy(payload)
                self.assertEqual(owner._normalize_completion_inputs(payload), before)
                self.assertEqual(payload, before)
        for legacy in ('unknown', receipt):
            payload = {'payment_link_distribution': 'separate', 'payment_distribution': legacy}
            before = deepcopy(payload)
            self.assertEqual(owner._normalize_completion_inputs(payload), {
                'payment_link_distribution': 'separate', 'per_guest_payment_links': True})
            self.assertEqual(payload, before)

    def test_existing_boolean_validation_and_conflict_errors_are_preserved(self):
        from wolfhouse import accepted_quote as owner
        for prepare in (owner.prepare_quote, owner.prepare_create):
            for invalid in (None, 'true', 'false', 0, 1, [], {}):
                payload = {'payment_link_distribution': 'separate',
                           'payment_distribution': 'together', 'per_guest_payment_links': invalid}
                with self.subTest(boundary=prepare.__name__, invalid=invalid):
                    before = deepcopy(payload)
                    with patch.object(owner, '_transaction') as transaction:
                        with self.assertRaisesRegex(owner.QuoteBoundaryError,
                                                    '^payment_distribution_invalid$'):
                            prepare(payload)
                        transaction.assert_not_called()
                    self.assertEqual(payload, before)
            for payload in (
                    {'payment_link_distribution': 'separate', 'per_guest_payment_links': False},
                    {'payment_distribution': 'together', 'per_guest_payment_links': True}):
                with self.subTest(boundary=prepare.__name__, payload=payload):
                    with patch.object(owner, '_transaction') as transaction:
                        with self.assertRaisesRegex(owner.QuoteBoundaryError,
                                                    '^payment_distribution_conflict$'):
                            prepare(payload)
                        transaction.assert_not_called()


class DistributionAliasOwnerBoundaryTests(unittest.TestCase):
    # Reuse the real isolated SessionDB fixture without inheriting its test suite.
    setUp = OwnerHostileTests.setUp
    tearDown = OwnerHostileTests.tearDown
    turn = OwnerHostileTests.turn
    _phase1b_rows = OwnerHostileTests._phase1b_rows

    def test_conflicts_leave_owner_rows_and_input_unchanged_without_staff_dispatch(self):
        import wolfhouse_staff_api as plugin
        for entrypoint in (self.ledger.prepare_quote, self.ledger.prepare_create,
                           plugin.quote_booking, plugin.create_booking_from_plan):
            for canonical, legacy in (('separate', 'together'), ('together', 'separate')):
                with self.subTest(entrypoint=entrypoint.__name__, canonical=canonical):
                    payload = {'payment_link_distribution': canonical,
                               'payment_distribution': legacy, 'confirm': True,
                               'guests': [{'name': 'Alex'}, {'name': 'Sam'}]}
                    before = deepcopy(payload)
                    rows = self._phase1b_rows()
                    with patch.object(self.ledger, '_transaction',
                                      wraps=self.ledger._transaction) as transaction, \
                            patch.object(plugin, '_post_bot') as staff:
                        if entrypoint in (self.ledger.prepare_quote, self.ledger.prepare_create):
                            with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                                        '^payment_distribution_conflict$'):
                                entrypoint(payload)
                        else:
                            response = json.loads(entrypoint(payload))
                            self.assertEqual(response['error'], 'payment_distribution_conflict')
                            self.assertFalse(response['success'])
                            self.assertFalse(response['write_performed'])
                        transaction.assert_not_called()
                        staff.assert_not_called()
                    self.assertEqual(self._phase1b_rows(), rows)
                    self.assertEqual(payload, before)

    def test_canonical_replacement_overrides_retained_mirror_in_quote(self):
        for value in ('separate', 'together'):
            with self.subTest(value=value):
                old = 'together' if value == 'separate' else 'separate'
                def retain(state, _ingress):
                    state['plan'].update(payment_link_distribution=old,
                                         per_guest_payment_links=old == 'separate')
                self.ledger._transaction(retain)
                payload = {'payment_link_distribution': value}
                prepared = self.ledger.prepare_quote(payload)
                self.assertEqual(prepared['payment_link_distribution'], value)
                self.assertIs(prepared['per_guest_payment_links'], value == 'separate')
                self.assertEqual(payload, {'payment_link_distribution': value})
