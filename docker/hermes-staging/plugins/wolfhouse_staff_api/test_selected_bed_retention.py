"""Offline registered-handler regression; all HTTP is intercepted, never books/sends."""
import copy
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
os.environ['LUNA_CLIENT_SLUG'] = 'wolfhouse-somo'
import wolfhouse_staff_api as plugin


class Registry:
    def __init__(self):
        self.tools = {}
    def register_tool(self, **kwargs):
        self.tools[kwargs['name']] = kwargs['handler']


class SelectedBedRetention(unittest.TestCase):
    def setUp(self):
        self.registry = Registry()
        plugin.register(self.registry)
        self.payload = dict(client_slug='wolfhouse-somo', guest_name='Alice',
            guests=[{'name': 'Alice'}, {'name': 'Bob'}], guest_count=2,
            check_in='2026-10-14', check_out='2026-10-16', package_code='package_none',
            room_preference='shared', group_gender='mixed',
            selected_bed_codes=['R8-B3', 'R4-B1'],
            room_name_hints=[{'name': 'Alice', 'hint': 'female', 'confidence': .99},
                             {'name': 'Bob', 'hint': 'male', 'confidence': .99}])
        self.beds = [{'bed_code': 'R8-B3', 'room_code': 'R8', 'room_type': 'female_only'},
                     {'bed_code': 'R4-B1', 'room_code': 'R4', 'room_type': 'male_only'}]
        self.calls = []

    def run_handler(self):
        def api(route, payload):
            self.calls.append((route, copy.deepcopy(payload)))
            if route == '/availability-check':
                return dict(success=True, has_enough_beds=True, available_beds=self.beds)
            self.assertEqual(route, '/booking-create-from-plan', 'no payment/send/handoff requests')
            return dict(success=False, write_performed=False, error='offline_intercept')
        with patch('urllib.request.urlopen', side_effect=AssertionError('network forbidden')), \
             patch.object(plugin, '_post_bot', side_effect=api):
            return json.loads(self.registry.tools['create_booking_from_plan'](self.payload))

    def create_payload(self):
        return next(body for route, body in self.calls if route == '/booking-create-from-plan')

    def test_accepted_mixed_couple_split_dorm_keeps_exact_order(self):
        self.run_handler()
        self.assertEqual(self.create_payload().get('selected_bed_codes'), ['R8-B3', 'R4-B1'])
        self.assertEqual(self.create_payload()['guests'], [{'name': 'Alice'}, {'name': 'Bob'}])


    def test_opposite_gender_drops_whole_selection_not_one_slot(self):
        self.beds[0]['room_type'] = 'male_only'
        self.run_handler()
        self.assertNotIn('selected_bed_codes', self.create_payload())
        self.assertEqual(self.create_payload()['guests'], [{'name': 'Alice'}, {'name': 'Bob'}])

    def test_mixed_rooms_allowed_for_both_travelers(self):
        for bed in self.beds:
            bed['room_type'] = 'mixed'
        self.run_handler()
        self.assertEqual(self.create_payload()['selected_bed_codes'], self.payload['selected_bed_codes'])

    def test_unknown_metadata_uses_existing_staff_fallback(self):
        for metadata in (None, 'shared', 'unknown', {}, ['female_only']):
            with self.subTest(metadata=metadata):
                self.calls = []
                self.beds[0]['room_type'] = metadata
                self.run_handler()
                self.assertNotIn('selected_bed_codes', self.create_payload())

    def test_missing_or_duplicate_bed_metadata_fails_closed(self):
        for beds in ([], None, 'bad', [self.beds[0]], self.beds + [self.beds[0]]):
            with self.subTest(beds=beds):
                old = self.beds
                self.beds = beds
                self.calls = []
                self.run_handler()
                self.assertNotIn('selected_bed_codes', self.create_payload())
                self.beds = old

    def test_hint_roster_order_and_shape_never_shift_slots(self):
        original = copy.deepcopy(self.payload['room_name_hints'])
        for hints in (None, [], original[::-1], [original[0]], [None, original[1]]):
            with self.subTest(hints=hints):
                self.calls = []
                self.payload['room_name_hints'] = hints
                self.run_handler()
                self.assertNotIn('selected_bed_codes', self.create_payload())

    def test_low_confidence_or_ambiguous_hint_not_compatibility(self):
        for change in ({'confidence': .69}, {'confidence': True}, {'ambiguous': True}):
            with self.subTest(change=change):
                self.calls = []
                self.payload['room_name_hints'][0] = {'name': 'Alice', 'hint': 'female', **change}
                self.run_handler()
                self.assertNotIn('selected_bed_codes', self.create_payload())

    def test_explicit_traveler_statement_overrides_hint(self):
        self.payload['room_name_hints'][0].update(hint='male', explicit_gender='female')
        self.run_handler()
        self.assertEqual(self.create_payload()['selected_bed_codes'], self.payload['selected_bed_codes'])

    def test_private_existing_exclusions_require_known_compatibility(self):
        self.payload['room_preference'] = 'private'
        self.beds[0]['room_type'] = 'private'
        self.run_handler()
        self.assertNotIn('selected_bed_codes', self.create_payload())

    def test_malformed_code_order_or_count_fails_closed(self):
        for codes in (['R4-B1', 'R8-B3'], ['R8-B3'], ['R8-B3', 'R8-B3'], ['R8-B3', {}]):
            with self.subTest(codes=codes):
                self.calls = []
                self.payload['selected_bed_codes'] = codes
                self.run_handler()
                self.assertNotIn('selected_bed_codes', self.create_payload())

    def test_empty_exclusions_leave_selection_unchanged(self):
        from wolfhouse.room_eligibility_policy import decide_room_eligibility
        decision = decide_room_eligibility(guest_count=2, explicit_gender='mixed', room_preference='shared')
        decision['excluded_room_preferences'] = []
        with patch.object(plugin, '_room_decision_for_tool', return_value=decision):
            self.run_handler()
        self.assertEqual(self.create_payload()['selected_bed_codes'], self.payload['selected_bed_codes'])
        self.assertEqual([route for route, _ in self.calls], ['/booking-create-from-plan'])


if __name__ == '__main__':
    unittest.main()
