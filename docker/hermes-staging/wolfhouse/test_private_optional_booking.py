"""PRIVATE-OPT tool-contract tests; synthetic Staff HTTP, never live business writes.

SQL persistence/locking is proved separately by verify-room-selling-booking and
verify-private-optional-concurrency, not by the transport fixtures here.
"""
import json
import unittest
from copy import deepcopy
from unittest.mock import patch

import wolfhouse_staff_api as plugin


class PrivateOptionalBookingTests(unittest.TestCase):
    def plan(self, count=1, alias='private'):
        return dict(client_slug='wolfhouse-somo', check_in='2027-04-10',
                    check_out='2027-04-13', guest_count=count,
                    room_type=alias, room_preference=alias,
                    guest_name='Offline Guest 1',
                    guests=[{'name': f'Offline Guest {n + 1}'} for n in range(count)],
                    package_code='package_none', payment_choice='deposit')

    @staticmethod
    def availability(count):
        codes = [f'R1-B{i + 1}' for i in range(count)]
        return dict(success=True, has_enough_beds=True,
                    selected_bed_codes=codes, selected_room_code='R1',
                    allocation_split=False, allocation_reason='exclusive_private_room',
                    private_room_available=True, available_count=count,
                    available_beds=[dict(bed_code=code, room_code='R1',
                                         room_type='mixed', gender_strategy='Flexible',
                                         selected_selling_mode='private')
                                    for code in codes])

    def test_registered_tools_describe_double_as_private_not_bed_layout(self):
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        registry = Registry()
        plugin.register(registry)
        for name in ('check_availability', 'quote_booking', 'create_booking_from_plan'):
            with self.subTest(tool=name):
                description = registry.tools[name]['schema']['parameters']['properties']['room_type']['description']
                self.assertIn('double is an alias of private', description)
                self.assertIn('not a double-bed guarantee', description)

    def test_same_price_shared_to_private_requires_new_offer_presentation(self):
        # Existing session/Staff offer builder fixture, not a model-consent classifier.
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        from wolfhouse import accepted_quote as ledger
        fixture = FirstYesOwnerTests('test_sim9_ordinary_equivalent_requote_retains_shown_authority')
        fixture.setUp()
        try:
            shared = deepcopy(fixture.plan)
            beds = [dict(bed_code=f'R1-B{i}', room_code='R1', room_type='mixed',
                         gender_strategy='mixed') for i in (1, 2)]
            old = fixture._checked_offer(shared, beds)
            ledger.record_quote(shared, old)
            displayed = ('Alex and Sam: 1–8 November, accommodation only, two beds in the same '
                         'mixed room. Total €200; full payment €200. Would you like to book this offer?')
            shown = ledger.finalize_offer_response({'completed': True, 'final_response': displayed})
            self.assertEqual(shown['final_response'], displayed)
            self.assertTrue(ledger._transaction(lambda state, _: state.get('presentation')))
            fixture.turn('private-change', 'A private room instead, please')
            private = {**shared, 'room_type': 'private', 'room_preference': 'private'}
            revised = fixture._checked_offer(private, beds)
            self.assertEqual(old['total_cents'], revised['total_cents'])
            self.assertNotEqual(old['offer_revision']['offer_fingerprint'],
                                revised['offer_revision']['offer_fingerprint'])
            ledger.record_quote(private, revised)
            self.assertIsNone(ledger._transaction(lambda state, _: state.get('presentation')),
                              'old shared-room presentation cannot authorize private create')
            with self.assertRaises(ledger.QuoteBoundaryError):
                ledger.prepare_create({})
        finally:
            fixture.tearDown()

    def test_declining_private_optional_offer_retains_shared_without_booking(self):
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests, offline_quote_result
        from wolfhouse import accepted_quote as ledger
        fixture = FirstYesOwnerTests('test_declining_private_requote_restores_shared_offer_authority')
        fixture.setUp()
        try:
            ledger.record_quote(fixture.plan, fixture.response)
            offline_quote_result({'completed': True, 'final_response': 'scripted shared offer'})
            shared = ledger._transaction(lambda state, _: deepcopy(state))
            fixture.turn('private-comparison', 'What about a room just for us?')
            private = {**fixture.plan, 'room_type': 'private', 'room_preference': 'private'}
            checked = fixture._checked_offer(private, self.availability(2)['available_beds'])
            ledger.record_quote(private, checked)
            offline_quote_result({'completed': True, 'final_response': 'scripted private offer'})
            fixture.turn('decline-comparison', 'No thanks, keep the shared option')
            with patch.object(plugin, '_post_bot') as staff:
                # Model-selected explicit scope, not a text classifier.
                result = ledger.update_booking_plan({
                    'operation': 'decline_offer', 'scope': 'private_comparison'})
                staff.assert_not_called()
            self.assertFalse(result['accepted'])
            restored = ledger._transaction(lambda state, _: deepcopy(state))
            self.assertEqual(restored['checked_offer'], shared['checked_offer'])
            self.assertEqual(restored['plan'], shared['plan'])
            self.assertEqual(restored['presentation'], shared['presentation'])
            self.assertNotEqual(restored['status'], 'accepted')
        finally:
            fixture.tearDown()

    def test_solo_and_group_quote_first_yes_create_use_one_private_path(self):
        # Real quote/create/owner boundaries, scripted Staff transport and prose.
        # Saved money/blocks and model wording have separate acceptance receipts.
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests, offline_quote_result
        from wolfhouse import accepted_quote as ledger
        for count in (1, 2, 3):
            for alias in ('private', 'double'):
                with self.subTest(count=count, alias=alias):
                    fixture = FirstYesOwnerTests('test_sim9_ordinary_equivalent_requote_retains_shown_authority')
                    fixture.setUp()
                    try:
                        plan = self.plan(count, alias)
                        plan.pop('client_slug')
                        plan['payment_link_distribution'] = 'together'
                        canonical = {**plan, 'room_type': 'private', 'room_preference': 'private'}
                        beds = self.availability(count)['available_beds']
                        checked = fixture._checked_offer(canonical, beds, quote_overrides={
                            'total_cents': count * 12000 + 5100,
                            'deposit_required_cents': count * 10000,
                            'payment_link_amount_cents': count * 10000})
                        # Staff preview exposes this authoritative amount at top level;
                        # _checked_offer is otherwise a minimal JS fingerprint fixture.
                        checked['payment_link_amount_cents'] = count * 10000
                        calls = []
                        def staff(path, body):
                            calls.append((path, deepcopy(body)))
                            if path == '/availability-check':
                                return self.availability(count)
                            self.assertEqual(path, '/booking-preview')
                            return deepcopy(checked)
                        with patch.object(plugin, '_post_bot', side_effect=staff):
                            result = json.loads(plugin.quote_booking(plan))
                        self.assertTrue(result['success'], result)
                        self.assertFalse(result['room_decision']['clarification_needed'], result)
                        for path, body in calls:
                            self.assertEqual(body['room_type'], 'private', path)
                            self.assertEqual(body['room_preference'], 'private', path)
                            self.assertEqual(body['guest_count'], count)
                            self.assertEqual(body['guests'], plan['guests'])
                        shown = offline_quote_result({'completed': True, 'final_response': 'scripted offer'})
                        self.assertTrue(shown['completed'], shown)
                        self.assertIsNotNone(ledger._transaction(lambda state, _: state.get('presentation')), shown)
                        fixture.turn('private-first-yes', 'Yes, book that room; deposit together please')
                        saved, writes = fixture.registered_create({
                            'room_type': alias, 'room_preference': alias})
                        self.assertTrue(saved['success'], (saved, [path for path, _ in writes]))
                        creates = [body for path, body in writes if path == '/booking-create-from-plan']
                        self.assertEqual(len(creates), 1)
                        self.assertEqual(creates[0]['room_type'], 'private')
                        self.assertEqual(creates[0]['room_preference'], 'private')
                        self.assertEqual(creates[0]['guests'], plan['guests'])
                        self.assertEqual(creates[0]['selected_bed_codes'],
                                         self.availability(count)['selected_bed_codes'])
                    finally:
                        fixture.tearDown()

    def test_private_and_double_solo_and_group_use_same_non_r6_availability(self):
        for count in (1, 3):
            for alias in ('private', 'double', 'private_room', 'couple_private'):
                with self.subTest(count=count, alias=alias):
                    calls = []
                    def staff(path, body):
                        calls.append((path, deepcopy(body)))
                        return self.availability(count)
                    with patch.object(plugin, '_post_bot', side_effect=staff):
                        result = json.loads(plugin.check_availability(self.plan(count, alias)))
                    self.assertEqual(calls[0][0], '/availability-check')
                    self.assertEqual(calls[0][1]['room_type'], 'private')
                    self.assertEqual(calls[0][1]['room_preference'], 'private')
                    self.assertTrue(result['available'], result)
                    self.assertEqual(result['selected_room_code'], 'R1')
                    self.assertEqual(len(result['selected_bed_codes']), count)
                    self.assertTrue(result['room_decision']['private_room'])
                    self.assertFalse(result['room_decision']['clarification_needed'])
                    self.assertEqual(result['selected_room_description'], 'private')


if __name__ == '__main__':
    unittest.main()
