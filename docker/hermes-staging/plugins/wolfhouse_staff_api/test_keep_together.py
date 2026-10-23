"""Offline Wolfhouse stay-together contract; mocked transport, socket tripwires."""
import copy
import json
import os
import unittest
from unittest.mock import patch
import wolfhouse_staff_api as plugin
from wolfhouse import accepted_quote as ledger


class Registry:
    def __init__(self):
        self.tools = {}
    def register_tool(self, **tool):
        self.tools[tool['name']] = tool


class KeepTogetherTests(unittest.TestCase):
    def setUp(self):
        for target in ('urllib.request.urlopen', 'socket.socket.connect',
                       'socket.socket.connect_ex', 'socket.create_connection'):
            guard = patch(target, side_effect=AssertionError('offline only'))
            guard.start()
            self.addCleanup(guard.stop)
        env = patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'})
        env.start()
        self.addCleanup(env.stop)
        registry = Registry()
        plugin.register(registry)
        self.tools = registry.tools
        self.params = {'check_in': '2026-11-05', 'check_out': '2026-11-15',
                       'guest_count': 2, 'room_type': 'shared', 'room_preference': 'mixed',
                       'keep_together': True, 'package_code': 'package_none',
                       'guests': [{'name': 'Emma'}, {'name': 'Marco'}]}
        self.receipt = {'success': True, 'has_enough_beds': True,
                        'selected_bed_codes': ['R7-B2', 'R7-B3'], 'selected_room_code': 'R7',
                        'available_beds': [{'bed_code': code, 'room_code': 'R7', 'room_type': 'mixed'}
                                           for code in ['R7-B2', 'R7-B3']]}

    def invoke(self, name, params, receipt):
        original = copy.deepcopy(params)
        with patch.object(plugin, '_post_bot', return_value=receipt) as transport:
            result = json.loads(self.tools[name]['handler'](params))
        self.assertEqual(params, original)
        return result, transport

    def test_availability_forwards_exact_beds_and_keep_together_without_demographic_inference(self):
        params = {**self.params, 'selected_bed_codes': ['R7-B3', 'R7-B2']}
        _, transport = self.invoke('check_availability', params, self.receipt)
        transport.assert_called_once()
        sent = transport.call_args.args[1]
        self.assertIs(sent.get('keep_together'), True)
        self.assertEqual(sent.get('selected_bed_codes'), params['selected_bed_codes'])
        self.assertNotIn('group_gender', sent)
        self.assertEqual(sent['guests'], self.params['guests'])

    def test_person_beds_are_preserved_as_an_ordered_request_not_a_validated_fact(self):
        params = {**self.params, 'guests': [
            {'name': 'Emma', 'selected_bed_code': 'R7-B3', 'room_code': 'R7'},
            {'name': 'Marco', 'selected_bed_code': 'R7-B2', 'room_code': 'R7'}]}
        _, transport = self.invoke('check_availability', params, self.receipt)
        sent = transport.call_args.args[1]
        self.assertEqual(sent.get('selected_bed_codes'), ['R7-B3', 'R7-B2'])
        self.assertNotIn('exact_bed_eligibility', sent)
        self.assertEqual(sent['guests'], self.params['guests'])

    def test_split_only_is_disclosed_and_quote_stops_before_price(self):
        split = {**self.receipt, 'selected_bed_codes': [], 'selected_room_code': None,
                 'keep_together': True, 'needs_clarification': True,
                 'allocation_reason': 'same_room_unavailable', 'allocation_split': True,
                 'blockers': ['needs_clarification', 'same_room_unavailable'],
                 'warnings': ['group_split_across_rooms_required'],
                 'next_action': 'explain_split_or_alternate_dates'}
        for name in ('check_availability', 'quote_booking'):
            result, transport = self.invoke(name, self.params, split)
            self.assertEqual([c.args[0] for c in transport.call_args_list], ['/availability-check'])
            self.assertIs(transport.call_args.args[1].get('keep_together'), True)
            self.assertFalse(result.get('available'))
            self.assertEqual(result.get('next_action'), 'explain_split_or_alternate_dates')
            self.assertNotIn('gender', (result.get('guest_safe_next_action') or '').lower())
            self.assertIn('room', (result.get('guest_safe_next_action') or '').lower())
            self.assertFalse(result.get('write_performed', False))

    def test_rejected_explicit_split_does_not_claim_all_same_room_stock_is_unavailable(self):
        receipt = {'allocation_reason': 'same_room_unavailable', 'allocation_split': False,
                   'blockers': ['same_room_unavailable']}
        result = plugin._same_room_refusal(receipt, 'check_availability')
        self.assertNotIn('No eligible room', result['guest_safe_next_action'])
        self.assertIn('requested beds', result['guest_safe_next_action'])
        self.assertEqual(result['next_action'], 'ask_same_room_reselection')

    def test_create_auxiliary_requests_retain_together(self):
        from wolfhouse_staff_api.test_selected_bed_retention import SelectedBedRetention
        for exact in (False, True):
            with self.subTest(exact=exact):
                case = SelectedBedRetention()
                case.setUp()
                case.payload.update(self.params)
                case.payload.pop('room_name_hints', None)
                case.payload.pop('group_gender', None)
                case.beds = copy.deepcopy(self.receipt['available_beds'])
                if exact:
                    case.payload['selected_bed_codes'] = ['R7-B2', 'R7-B3']
                else:
                    case.payload.pop('selected_bed_codes')
                    case.availability = copy.deepcopy(self.receipt)
                case.run_handler()
                checks = [body for route, body in case.calls if route == '/availability-check']
                self.assertTrue(checks)
                self.assertTrue(all(body.get('keep_together') is True for body in checks))
                self.assertIs(case.create_payload().get('keep_together'), True)

    def test_tool_schemas_and_owner_material_identity_retain_requirement(self):
        for name in ('check_availability', 'quote_booking', 'create_booking_from_plan'):
            props = self.tools[name]['schema']['parameters']['properties']
            self.assertEqual(props['keep_together']['type'], 'boolean')
            self.assertEqual(props['selected_bed_codes']['type'], 'array')
        self.assertIn('keep_together', ledger._FIELDS)
        self.assertIn('keep_together', ledger._CARRIED_FIELDS)
        self.assertNotEqual(ledger._material_projection(self.params),
                            ledger._material_projection({**self.params, 'keep_together': False}))


if __name__ == '__main__':
    unittest.main()
