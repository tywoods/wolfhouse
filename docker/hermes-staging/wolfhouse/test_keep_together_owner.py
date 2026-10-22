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

    def test_old_split_offer_cannot_survive_new_together_requirement(self):
        import wolfhouse_staff_api as plugin
        split = self._checked_offer(self.plan, [
            {'bed_code': 'R7-B2', 'room_code': 'R7', 'gender_strategy': 'mixed'},
            {'bed_code': 'R10-B2', 'room_code': 'R10', 'gender_strategy': 'mixed'}])
        ledger.record_quote(self.plan, split)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
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
        decision = json.loads(self.tools['interpret_booking_turn']['handler']({
            'action': 'revise', 'action_evidence': raw, 'ambiguous': False,
            'negated': False, 'conditional': False, 'completions': {},
            'material_changes': [{'field': 'keep_together', 'value': False, 'evidence': raw}]}))
        fields = self.tools['interpret_booking_turn']['schema']['parameters']['properties']['material_changes']['items']['properties']['field']['enum']
        self.assertIn('keep_together', fields)
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
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
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
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('accept-together-before-revision', 'Yes, book the offer you just showed.')
        prepared = ledger.prepare_create({})
        ledger.record_quote(prepared, response)
        self.assertIs(ledger.prepare_create({})['keep_together'], True)
        raw = 'We agree to separate rooms. Please quote the split.'
        self.turn('revise-accepted-together', raw)
        proposal = {'action': 'revise', 'action_evidence': raw, 'ambiguous': False,
                    'negated': False, 'conditional': False, 'completions': {},
                    'material_changes': [{'field': 'keep_together', 'value': False, 'evidence': raw}]}
        decision = json.loads(self.tools['interpret_booking_turn']['handler'](proposal))
        self.assertEqual(decision['next_action'], 'requote_material_changes')
        # Idempotent revision replay grants no additional authority.
        replay = json.loads(self.tools['interpret_booking_turn']['handler'](proposal))
        self.assertEqual(replay, decision)
        state = ledger._transaction(lambda state, ingress: ledger.deepcopy(state))
        for key in ('checked_offer', 'presented_offer', 'presentation', 'accepted_presentation',
                    'operation_key', 'dispatch_pending', 'dispatch_payload', 'acceptance_message'):
            self.assertNotIn(key, state)
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_create({})
        self.assertIs(ledger.prepare_quote({})['keep_together'], True)
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
        shown = ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
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
