"""Captain R3 person-bound initial eligibility regressions (offline)."""
import inspect
import json
import unittest
from unittest.mock import patch

from wolfhouse import accepted_quote
import wolfhouse_staff_api as plugin


class CaptainR3Tests(unittest.TestCase):
    def validated(self, raw, guests):
        capability = object()
        prepared = accepted_quote.PreparedPlan({'guests': guests}, capability, 0)
        state = {'epoch': 0, 'current_turn': {'raw': raw}}
        with patch.object(accepted_quote, '_current') as current, \
                patch.object(accepted_quote, '_transaction') as transaction:
            current.get.return_value = capability
            transaction.side_effect = lambda operation: operation(state, {})
            return accepted_quote.validated_guest_eligibility(prepared)

    def quote(self, params, allowed, receipt):
        calls = []
        def post(path, payload):
            calls.append((path, payload))
            return receipt
        with patch.object(plugin, '_post_bot', side_effect=post):
            result = json.loads(plugin.quote_booking.__wrapped__(
                params, _owner_validated_guest_eligibility=allowed))
        return result, calls

    @staticmethod
    def receipt(room_type):
        return {'success': True, 'quote_total_cents': 10000,
                'deposit_required_cents': 2000, 'balance_due_cents': 8000,
                'girls_room_available': room_type == 'female_only'}

    def test_fresh_solo_female_and_male_are_consistent(self):
        for value, noun, room in (('female', 'woman', 'female_only'),
                                  ('male', 'man', 'male_only')):
            raw = f"I'm a {noun}; {room} please"
            guests = [{'name': 'Alex', 'explicit_gender': value,
                       'gender_evidence': f"I'm a {noun}"}]
            allowed = self.validated(raw, guests)
            self.assertEqual(allowed, {0: value})
            result, calls = self.quote({
                'check_in': '2027-01-01', 'check_out': '2027-01-02',
                'guest_count': 1, 'package_code': 'package_none',
                'room_preference': room, 'guests': guests}, allowed,
                self.receipt(room))
            sent = calls[0][1]
            expected = [{'name': 'Alex', 'explicit_gender': value}]
            self.assertEqual(sent['guests'], expected)
            self.assertEqual(sent['room_name_hints'], expected)
            self.assertEqual(result['room_decision']['resolved_composition'], value)
            self.assertFalse(result['room_decision']['clarification_needed'])

    def test_explicit_all_women_group_is_person_bound(self):
        evidence = 'Ana and Bea are both women'
        guests = [{'name': name, 'explicit_gender': 'female',
                   'gender_evidence': evidence} for name in ('Ana', 'Bea')]
        allowed = self.validated(evidence + '; female-only please', guests)
        self.assertEqual(allowed, {0: 'female', 1: 'female'})
        result, calls = self.quote({
            'check_in': '2027-01-01', 'check_out': '2027-01-02',
            'guest_count': 2, 'package_code': 'package_none',
            'room_preference': 'female_only', 'guests': guests}, allowed,
            self.receipt('female_only'))
        expected = [{'name': name, 'explicit_gender': 'female'} for name in ('Ana', 'Bea')]
        self.assertEqual(calls[0][1]['room_name_hints'], expected)
        self.assertEqual(result['room_decision']['resolved_composition'], 'female')

    def test_unknown_name_room_and_arbitrary_group_fields_do_not_prove_person(self):
        guests = [{'name': 'Nora', 'explicit_gender': 'female',
                   'gender_evidence': 'Nora wants the women room'}]
        self.assertEqual(self.validated('Nora wants the women room', guests), {})
        self.assertEqual(self.validated('Nora is coming', [{
            'name': 'Nora', 'explicit_gender': 'female',
            'gender_evidence': 'Nora is coming'}]), {})
        result, calls = self.quote({
            'check_in': '2027-01-01', 'check_out': '2027-01-02',
            'guest_count': 1, 'package_code': 'package_none',
            'room_preference': 'female_only', 'guests': guests,
            'group_gender': 'female'}, {}, self.receipt('female_only'))
        self.assertNotIn('room_name_hints', calls[0][1])
        self.assertTrue(result['room_decision']['clarification_needed'])
        self.assertEqual(result['next_action'], 'ask_room_eligibility')
        self.assertFalse(result['staff_review_needed'])

    def test_first_to_full_name_preserves_slot_hint(self):
        allowed = self.validated('I am a woman, name Alex', [{
            'name': 'Alex', 'explicit_gender': 'female',
            'gender_evidence': 'I am a woman'}])
        result, calls = self.quote({
            'check_in': '2027-01-01', 'check_out': '2027-01-02',
            'guest_count': 1, 'package_code': 'package_none',
            'room_preference': 'female_only',
            'guests': [{'name': 'Alex Grey', 'explicit_gender': 'female'}]},
            allowed, self.receipt('female_only'))
        self.assertEqual(calls[0][1]['room_name_hints'],
                         [{'name': 'Alex Grey', 'explicit_gender': 'female'}])
        self.assertEqual(result['room_decision']['resolved_composition'], 'female')

    def test_same_term_owner_comparison_and_revision_guard_remain(self):
        before = {'offer_fingerprint': 'same', 'guest_bed_assignments': [
            {'guest_index': 0, 'guest_name': 'Alex', 'bed_code': 'F1'}],
            'room_name_hints': [{'name': 'Alex', 'explicit_gender': 'female'}]}
        self.assertTrue(accepted_quote._completion_revision_matches(before, before))
        self.assertIn('quote_revision_requires_owner',
                      inspect.getsource(accepted_quote.prepare_quote))


if __name__ == '__main__':
    unittest.main()
