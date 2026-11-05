"""Actual SessionDB/owner boundaries, synthetic Staff receipts, no network."""
import unittest
import json
from unittest.mock import patch
from wolfhouse import accepted_quote as ledger
from wolfhouse import test_first_yes_owner as harness


class KeepTogetherOwnerTests(unittest.TestCase):
    def setUp(self):
        harness.FirstYesOwnerTests.setUp(self)
        import wolfhouse_staff_api as plugin
        from wolfhouse_staff_api.test_keep_together import Registry
        registry = Registry()
        plugin.register(registry)
        self.tools = registry.tools
        for target in ('urllib.request.urlopen', 'socket.socket.connect', 'socket.create_connection'):
            guard = patch(target, side_effect=AssertionError('offline only'))
            guard.start()
            self.addCleanup(guard.stop)
    tearDown = harness.FirstYesOwnerTests.tearDown
    turn = harness.FirstYesOwnerTests.turn
    _checked_offer = harness.FirstYesOwnerTests._checked_offer

    def _snapshot(self):
        # Read SQL directly: using _transaction here would itself write the ledger.
        with self.db._lock:
            return [tuple(row) for row in self.db._conn.execute(
                'SELECT key,value FROM state_meta ORDER BY key').fetchall()]

    def _state(self):
        rows = [value for key, value in self._snapshot() if key.startswith(ledger._PREFIX)]
        self.assertEqual(len(rows), 1)
        return json.loads(rows[0])

    def _runtime_update(self, params):
        import importlib
        from types import SimpleNamespace
        from hermes_cli.plugins import PluginContext
        from tools.registry import ToolRegistry
        import wolfhouse_staff_api as plugin
        registry_module = importlib.import_module('tools.registry')
        registry = ToolRegistry()
        context = PluginContext(SimpleNamespace(name='wolfhouse_staff_api'),
                                SimpleNamespace(_plugin_tool_names=set()))
        with (patch.object(registry_module, 'registry', registry),
              patch.object(context, 'register_hook'),
              patch.object(ledger, 'install_owner_hook'),
              patch('wolfhouse.booking_names.install_turn_cleanup'),
              patch.object(plugin, '_post_bot', side_effect=AssertionError('no Staff I/O'))):
            plugin.register(context)
            self.assertIn('update_booking_plan', registry.get_all_tool_names())
            return json.loads(registry.dispatch('update_booking_plan', params,
                task_id='offline-task', session_id='untrusted-metadata',
                user_task='not revision authority'))

    def test_registered_explicit_revision_preserves_facts_and_requires_fresh_presentation(self):
        plan = {**self.plan, 'keep_together': True,
                'add_ons': [{'code': 'yoga_class', 'quantity': 1}]}
        response = self._checked_offer(plan, [
            {'bed_code': 'M1', 'room_code': 'M', 'gender_strategy': 'mixed'},
            {'bed_code': 'M2', 'room_code': 'M', 'gender_strategy': 'mixed'}])
        ledger.record_quote(plan, response)
        harness.offline_quote_result({'completed': True, 'final_response': 'draft'})
        self.turn('accept-old', 'Book this')
        refresh = ledger.prepare_create({})
        ledger.record_quote(refresh, response)
        stale_ticket = ledger.prepare_create({})
        self.turn('explicit-revision', '任意の言語 — model owns the meaning')
        before = self._state()
        params = {'operation': 'revise', 'changes': {'keep_together': False}}
        result = self._runtime_update(params)
        self.assertTrue(result['success'], result)
        self.assertFalse(result['accepted'])
        self.assertFalse(result['create_ready'])
        self.assertEqual(result['next_action'], 'requote_material_changes')
        state = self._state()
        self.assertEqual(state['epoch'], before['epoch'] + 1)
        expected = ledger._presentation_plan(before)
        expected['keep_together'] = False
        self.assertEqual(ledger._presentation_plan(state), expected)
        for key in ('checked_offer', 'presented_offer', 'presentation',
                    'accepted_presentation', 'operation_key', 'dispatch_pending',
                    'dispatch_payload', 'acceptance_message'):
            self.assertNotIn(key, state)
        snapshot = self._snapshot()
        self.assertEqual(self._runtime_update(params), result)
        self.assertEqual(self._snapshot(), snapshot)
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.dispatch_create(stale_ticket, lambda: self.fail('stale create'))
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_create({})
        revised = ledger.prepare_quote({})
        self.assertIs(revised['keep_together'], False)
        split = self._checked_offer(revised, [
            {'bed_code': 'M1', 'room_code': 'M', 'gender_strategy': 'mixed'},
            {'bed_code': 'N1', 'room_code': 'N', 'gender_strategy': 'mixed'}])
        ledger.record_quote(revised, split)
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_create({})
        harness.offline_quote_result({'completed': True, 'final_response': 'draft'})
        self.turn('accept-fresh', 'Book this revised offer')
        refreshed = ledger.prepare_create({})
        ledger.record_quote(refreshed, split)
        prepared = ledger.prepare_create({})
        self.assertIs(prepared['keep_together'], False)
        # Staff canonicalizes false as an omitted optional offer constraint.
        self.assertIs(prepared['accepted_offer'].get('keep_together', False), False)
        self.assertNotEqual(prepared['idempotency_key'], stale_ticket['idempotency_key'])
        print('SLICE1_SQL_SNAPSHOT: explicit revision, replay, stale ticket, fresh presentation verified')

    def _accepted_together_ticket(self):
        plan = {**self.plan, 'keep_together': True}
        response = self._checked_offer(plan, [
            {'bed_code': 'M1', 'room_code': 'M', 'gender_strategy': 'mixed'},
            {'bed_code': 'M2', 'room_code': 'M', 'gender_strategy': 'mixed'}])
        ledger.record_quote(plan, response)
        harness.offline_quote_result({'completed': True, 'final_response': 'draft'})
        self.turn('accepted-together', 'Book it')
        refresh = ledger.prepare_create({})
        ledger.record_quote(refresh, response)
        return ledger.prepare_create({})

    def test_explicit_update_refuses_unresolved_dispatch_without_erasing_recovery(self):
        ticket = self._accepted_together_ticket()
        with self.assertRaises(TimeoutError):
            ledger.dispatch_create(ticket, lambda: (_ for _ in ()).throw(TimeoutError('offline')))
        before = self._snapshot()
        result = self._runtime_update({'operation': 'revise', 'changes': {'keep_together': False}})
        self.assertFalse(result['success'], result)
        self.assertEqual(result['error'], 'booking_plan_update_recovery_required')
        self.assertEqual(self._snapshot(), before)
        self.assertEqual(ledger.prepare_create({})['idempotency_key'], ticket['idempotency_key'])
        self.assertEqual(self._snapshot(), before)
        print('SLICE1_RECOVERY: pending dispatch bytes and original operation identity retained')

    def test_explicit_update_refuses_saved_receipt_without_erasing_completion(self):
        ticket = self._accepted_together_ticket()
        receipt = {'success': True, 'booking_id': 'offline-booking', 'booking_code': 'OFFLINE-1'}
        ledger.dispatch_create(ticket, lambda: receipt)
        ledger.record_create_completion(ticket, receipt)
        self.turn('revise-saved', 'Change rooms')
        before = self._snapshot()
        result = self._runtime_update({'operation': 'revise', 'changes': {'keep_together': False}})
        self.assertFalse(result['success'], result)
        self.assertEqual(result['error'], 'booking_plan_update_saved_booking')
        self.assertEqual(self._snapshot(), before)
        self.assertEqual(self._state()['receipt'], receipt)
        self.assertEqual(self._state()['completion'], receipt)
        print('SLICE1_RECOVERY: saved receipt/completion bytes retained')

    def test_split_authority_is_explicit_and_bound_to_current_revision(self):
        ledger.record_availability_context({**self.plan, 'keep_together': True})
        result = self._runtime_update({'operation': 'revise', 'changes': {'keep_together': False}})
        self.assertTrue(result['success'], result)
        state = self._state()
        self.assertTrue(ledger._split_revision_proposed(state))
        for mutate in (
                lambda s: s.update(epoch=s['epoch'] + 1),
                lambda s: s['current_turn'].update(message_id='old-turn'),
                lambda s: s['scope'].update(CHAT_ID='foreign-phone'),
                lambda s: s.update(incarnation=-1),
                lambda s: s['plan'].update(check_out='2026-12-01')):
            stale = ledger.deepcopy(state)
            mutate(stale)
            self.assertFalse(ledger._split_revision_proposed(stale))
        self.turn('next-turn', 'A new turn')
        self.assertFalse(ledger._split_revision_proposed(self._state()))
        # A pre-migration interpretation result must not authorize a relaxation.
        forged = self._state()
        forged['current_turn']['interpretation_result'] = {'next_action': 'requote_material_changes'}
        forged['authorized_revision_changes'] = [{'field': 'keep_together', 'value': False}]
        self.assertFalse(ledger._split_revision_proposed(forged))

    def test_legacy_keep_together_mutator_is_not_a_second_update_path(self):
        ledger.record_availability_context({**self.plan, 'keep_together': True})
        raw = 'We agree to separate rooms. Please quote the split.'
        self.turn('legacy-split', raw)
        before = self._snapshot()
        result = json.loads(self.tools['interpret_booking_turn']['handler']({
            'action': 'revise', 'action_evidence': raw, 'ambiguous': False,
            'negated': False, 'conditional': False, 'completions': {},
            'material_changes': [{'field': 'keep_together', 'value': False, 'evidence': raw}]}))
        self.assertNotEqual(result.get('next_action'), 'requote_material_changes')
        self.assertEqual(self._snapshot(), before)
        with self.assertRaisesRegex(ledger.QuoteBoundaryError, 'keep_together_revision_required'):
            ledger.prepare_quote({'keep_together': False})

    def test_update_schema_and_invalid_arguments_refuse_without_mutation(self):
        ledger.record_availability_context({**self.plan, 'keep_together': True})
        schema = self.tools['update_booking_plan']['schema']['parameters']
        self.assertFalse(schema['additionalProperties'])
        self.assertEqual(set(schema['properties']), {'operation', 'changes'})
        self.assertEqual(schema['properties']['operation']['enum'], ['revise'])
        self.assertFalse(schema['properties']['changes']['additionalProperties'])
        good = {'operation': 'revise', 'changes': {'keep_together': False}}
        invalid = [None, [], '', {}, {'operation': 'revise'},
                   {**good, 'operation': 'accept'}, {**good, 'operation': 'decline_offer'},
                   {**good, 'changes': {}}, {**good, 'changes': []},
                   {**good, 'changes': {'keep_together': False, 'guest_count': 3}}]
        invalid += [{**good, 'changes': {'keep_together': value}}
                    for value in (None, True, 0, 1, 'false', [], {})]
        invalid += [{**good, key: 'forged'} for key in
                    ('tenant', 'session_id', 'phone', 'message_id', 'epoch', 'offer_revision', 'evidence')]
        before = self._snapshot()
        for params in invalid:
            with self.subTest(params=params):
                # Direct adapter is intentional: Hermes may reject malformed JSON
                # shapes first; the actual owner must also enforce its contract.
                result = json.loads(self.tools['update_booking_plan']['handler'](params))
                self.assertFalse(result['success'], result)
                self.assertEqual(result['error'], 'booking_plan_update_invalid')
                self.assertEqual(self._snapshot(), before)
        self.assertTrue(self._runtime_update(good)['success'])

    def test_update_revalidates_tenant_phone_session_turn_and_epoch(self):
        from gateway import session_context
        ledger.record_availability_context({**self.plan, 'keep_together': True})
        good = {'operation': 'revise', 'changes': {'keep_together': False}}
        before = self._snapshot()
        for name in ('CHAT_ID', 'USER_ID', 'KEY', 'ID', 'MESSAGE_ID', 'PLATFORM', 'THREAD_ID'):
            with self.subTest(scope=name):
                var = session_context._VAR_MAP['HERMES_SESSION_' + name]
                token = var.set('foreign')
                try:
                    result = self._runtime_update(good)
                    self.assertFalse(result['success'], result)
                    self.assertEqual(self._snapshot(), before)
                finally:
                    var.reset(token)
        with patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'foreign-tenant'}):
            self.assertFalse(self._runtime_update(good)['success'])
        with patch.object(self.agent, 'session_id', 'rotated'):
            self.assertFalse(self._runtime_update(good)['success'])
        bound = ledger._current.get()
        epoch = bound.epoch
        bound.epoch -= 1
        try:
            self.assertEqual(self._runtime_update(good)['error'], 'quote_owner_superseded')
        finally:
            bound.epoch = epoch
        self.assertEqual(self._snapshot(), before)
        ledger.close_turn()
        self.assertFalse(self._runtime_update(good)['success'])
        self.assertEqual(self._snapshot(), before)
        print('SLICE1_SCOPE: tenant, phone/chat, user, session, turn, epoch and closed capability denied')

    def test_update_refuses_absent_plan_and_non_together_plan_without_inserting_state(self):
        good = {'operation': 'revise', 'changes': {'keep_together': False}}
        before = self._snapshot()
        self.assertFalse(self._runtime_update(good)['success'])
        self.assertEqual(self._snapshot(), before)
        ledger.record_availability_context({**self.plan, 'keep_together': False})
        before = self._snapshot()
        self.assertFalse(self._runtime_update(good)['success'])
        self.assertEqual(self._snapshot(), before)
        self.db._execute_write(lambda conn: conn.execute(
            'DELETE FROM state_meta WHERE key LIKE ?', (ledger._PREFIX + '%',)))
        before = self._snapshot()
        self.assertFalse(self._runtime_update(good)['success'])
        self.assertEqual(self._snapshot(), before)

    def test_update_refuses_partial_legacy_recovery_shapes(self):
        ledger.record_availability_context({**self.plan, 'keep_together': True})
        for key, value in (('receipt', {}), ('completion', {}), ('partial_completion', {}),
                           ('dispatch_pending', True), ('dispatch_payload', {})):
            with self.subTest(key=key):
                ledger._transaction(lambda state, ingress: state.update({
                    key: value, 'operation_key': 'original-key'}))
                before = self._snapshot()
                self.assertFalse(self._runtime_update({
                    'operation': 'revise', 'changes': {'keep_together': False}})['success'])
                self.assertEqual(self._snapshot(), before)
                ledger._transaction(lambda state, ingress: state.pop(key))

    def test_update_refuses_corrupt_turn_and_update_record_without_mutation(self):
        ledger.record_availability_context({**self.plan, 'keep_together': True})
        original = self._state()['current_turn']
        for pending in (None, {}, {**original, 'raw_digest': 'stale'},
                        {**original, 'plan_update': 'invalid'},
                        {**original, 'plan_update': {}}):
            with self.subTest(pending=pending):
                ledger._transaction(lambda state, ingress: state.update(current_turn=pending))
                before = self._snapshot()
                result = self._runtime_update({'operation': 'revise', 'changes': {'keep_together': False}})
                self.assertFalse(result['success'], result)
                self.assertIn(result['error'], ('booking_plan_update_turn_invalid',
                                               'booking_plan_update_superseded'))
                self.assertEqual(self._snapshot(), before)

    def test_update_replay_cannot_revoke_a_later_revision(self):
        ledger.record_availability_context({**self.plan, 'keep_together': True})
        good = {'operation': 'revise', 'changes': {'keep_together': False}}
        self.assertTrue(self._runtime_update(good)['success'])
        ledger.record_availability_context({'check_out': '2026-11-09'})
        before = self._snapshot()
        result = self._runtime_update(good)
        self.assertFalse(result['success'], result)
        self.assertEqual(result['error'], 'booking_plan_update_superseded')
        self.assertEqual(self._snapshot(), before)

    def test_old_split_offer_cannot_survive_new_together_requirement(self):
        import wolfhouse_staff_api as plugin
        split = self._checked_offer(self.plan, [
            {'bed_code': 'R7-B2', 'room_code': 'R7', 'gender_strategy': 'mixed'},
            {'bed_code': 'R10-B2', 'room_code': 'R10', 'gender_strategy': 'mixed'}])
        ledger.record_quote(self.plan, split)
        harness.offline_quote_result({'completed': True, 'final_response': 'draft'})
        self.turn('refuse-split', 'No split rooms. We must stay together.')
        refusal = {'success': True, 'has_enough_beds': False,
                   'allocation_reason': 'same_room_unavailable', 'allocation_split': True,
                   'blockers': ['same_room_unavailable'], 'selected_bed_codes': []}
        with patch.object(plugin, '_post_bot', return_value=refusal) as transport:
            result = json.loads(self.tools['check_availability']['handler'](
                {**self.plan, 'keep_together': True}))
            self.assertFalse(result['available'])
            transport.assert_called_once()
        self.turn('later-yes', 'Yes')
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_create({})
        with patch.object(plugin, '_post_bot') as transport:
            result = json.loads(self.tools['create_booking_from_plan']['handler']({}))
            transport.assert_not_called()
            self.assertFalse(result.get('success'))

    def test_invalid_constraint_cannot_mutate_owner_or_reach_transport(self):
        import json
        import wolfhouse_staff_api as plugin
        ledger.record_availability_context({**self.plan, 'keep_together': True})
        before = ledger._transaction(lambda state, ingress: ledger.deepcopy(state))
        for bad in (None, 'true', 'false', 0, 1, [], {}):
            with self.subTest(value=bad):
                with patch.object(plugin, '_post_bot', return_value={'success': False, 'error': 'invalid_keep_together'}) as transport:
                    result = json.loads(plugin.check_availability({**self.plan, 'keep_together': bad}))
                    self.assertFalse(result.get('success'))
                    transport.assert_not_called()
                self.assertEqual(ledger._transaction(lambda state, ingress: ledger.deepcopy(state)), before)
                for boundary in (ledger.prepare_quote, ledger.prepare_create):
                    with self.assertRaisesRegex(ledger.QuoteBoundaryError, 'invalid_keep_together'):
                        boundary({'keep_together': bad})
                with self.assertRaisesRegex(ledger.QuoteBoundaryError, 'keep_together_revision_required'):
                    ledger.prepare_quote({'keep_together': False})

    def test_explicit_split_revision_after_refusal_requires_fresh_offer_acceptance(self):
        ledger.record_availability_context({**self.plan, 'keep_together': True})
        raw = 'We agree to separate rooms. Please quote the split.'
        self.turn('split-revision', raw)
        decision = self._runtime_update({'operation': 'revise', 'changes': {'keep_together': False}})
        self.assertTrue(decision['success'], decision)
        self.assertFalse(decision['accepted'])
        self.assertEqual(decision['next_action'], 'requote_material_changes')
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_create({})
        ledger.record_availability_context({**self.plan, 'keep_together': False})
        plan = ledger.prepare_quote({**self.plan, 'keep_together': False})
        response = self._checked_offer(plan, [
            {'bed_code': 'R7-B2', 'room_code': 'R7', 'gender_strategy': 'mixed'},
            {'bed_code': 'R10-B2', 'room_code': 'R10', 'gender_strategy': 'mixed'}])
        ledger.record_quote(plan, response)
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_create({})
        harness.offline_quote_result({'completed': True, 'final_response': 'draft'})
        self.turn('accept-new-split', 'Yes, book the offer you just showed.')
        prepared = ledger.prepare_create({})
        ledger.record_quote(prepared, response)
        prepared = ledger.prepare_create({})
        self.assertIs(prepared['keep_together'], False)
        self.assertIs(prepared['accepted_offer'].get('keep_together', False), False)

    def test_split_revision_revokes_previously_accepted_together_offer(self):
        plan = {**self.plan, 'keep_together': True}
        response = self._checked_offer(plan, [
            {'bed_code': 'M1', 'room_code': 'M', 'gender_strategy': 'mixed'},
            {'bed_code': 'M2', 'room_code': 'M', 'gender_strategy': 'mixed'}])
        ledger.record_quote(plan, response)
        harness.offline_quote_result({'completed': True, 'final_response': 'draft'})
        self.turn('accept-together-before-revision', 'Yes, book the offer you just showed.')
        prepared = ledger.prepare_create({})
        ledger.record_quote(prepared, response)
        self.assertIs(ledger.prepare_create({})['keep_together'], True)
        raw = 'We agree to separate rooms. Please quote the split.'
        self.turn('revise-accepted-together', raw)
        proposal = {'operation': 'revise', 'changes': {'keep_together': False}}
        decision = self._runtime_update(proposal)
        self.assertEqual(decision['next_action'], 'requote_material_changes')
        # Idempotent revision replay grants no additional authority.
        replay = self._runtime_update(proposal)
        self.assertEqual(replay, decision)
        state = ledger._transaction(lambda state, ingress: ledger.deepcopy(state))
        for key in ('checked_offer', 'presented_offer', 'presentation', 'accepted_presentation',
                    'operation_key', 'dispatch_pending', 'dispatch_payload', 'acceptance_message'):
            self.assertNotIn(key, state)
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_create({})
        self.assertIs(ledger.prepare_quote({})['keep_together'], False)
        self.assertIs(ledger.prepare_quote({'keep_together': False})['keep_together'], False)

    def test_uncertain_or_unevidenced_split_revision_never_unlocks_quote(self):
        ledger.record_availability_context({**self.plan, 'keep_together': True})
        for index, override in enumerate((
                {'ambiguous': True}, {'negated': True}, {'conditional': True},
                {'action': 'accept'}, {'evidence': 'separate rooms'},
                {'evidence': 'This is a stale guest message'}, {'value': 'false'})):
            with self.subTest(override=override):
                raw = 'We agree to separate rooms. Please quote the split.'
                self.turn(f'bad-split-revision-{index}', raw)
                change = {'field': 'keep_together', 'value': False, 'evidence': raw}
                change.update({key: value for key, value in override.items() if key in change})
                proposal = {'action': 'revise', 'action_evidence': raw, 'ambiguous': False,
                            'negated': False, 'conditional': False, 'completions': {},
                            'material_changes': [change]}
                proposal.update({key: value for key, value in override.items() if key in proposal})
                result = json.loads(self.tools['interpret_booking_turn']['handler'](proposal))
                self.assertFalse(result.get('accepted'))
                self.assertNotEqual(result.get('next_action'), 'requote_material_changes')
                with self.assertRaisesRegex(ledger.QuoteBoundaryError, 'keep_together_revision_required'):
                    ledger.prepare_quote({'keep_together': False})

    def test_quote_cannot_relax_retained_requirement(self):
        ledger.record_availability_context({**self.plan, 'keep_together': True})
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_quote({**self.plan, 'keep_together': False})
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.record_availability_context({**self.plan, 'keep_together': False})

    def test_registered_availability_restores_constraint_and_stops_explicit_downgrade(self):
        import wolfhouse_staff_api as plugin
        ledger.record_availability_context({**self.plan, 'keep_together': True})
        with patch.object(plugin, '_post_bot', return_value={'success': False}) as transport:
            plugin.check_availability(dict(self.plan))
            self.assertIs(transport.call_args.args[1].get('keep_together'), True)
        with patch.object(plugin, '_post_bot', return_value={'success': True}) as transport:
            import json
            result = json.loads(plugin.check_availability({**self.plan, 'keep_together': False}))
            transport.assert_not_called()
            self.assertFalse(result.get('success'))

    def test_availability_requirement_survives_omitted_quote_field(self):
        params = {**self.plan, 'keep_together': True}
        ledger.record_availability_context(params)
        hydrated = ledger.prepare_quote({**self.plan})
        self.assertIs(hydrated.get('keep_together'), True)
        self.assertNotIn('group_gender', hydrated)

    def test_accepted_requirement_survives_omission_and_cannot_be_relaxed_at_create(self):
        self.plan['keep_together'] = True
        self.response = self._checked_offer(self.plan, [
            {'bed_code': 'R7-B2', 'room_code': 'R7', 'gender_strategy': 'mixed'},
            {'bed_code': 'R7-B3', 'room_code': 'R7', 'gender_strategy': 'mixed'},
        ])
        ledger.record_quote(self.plan, self.response)
        shown = harness.offline_quote_result({'completed': True, 'final_response': 'draft'})
        self.assertIn('same mixed room', shown['final_response'])
        self.turn('accept-together', 'Yes, please book that')
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_create({'keep_together': False})
        prepared = ledger.prepare_create({})
        self.assertIs(prepared['keep_together'], True)
        self.assertTrue(prepared.revalidation)
        ledger.record_quote(prepared, self.response)
        prepared = ledger.prepare_create({})
        self.assertIs(prepared['keep_together'], True)
        self.assertIs(prepared['accepted_offer']['keep_together'], True)
        self.assertNotIn('group_gender', prepared)


if __name__ == '__main__':
    unittest.main()
