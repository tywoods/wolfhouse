"""Offline Richter trace regression; real ledger/finalizer, no HTTP or model calls.

Boundary-field projection of doc_771f6bfd0c22_richter-create-failure-trace.md
messages 22511/22512. Staff's combo is representation, not changed consent.
"""
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from hermes_state import SessionDB
from gateway.session_context import set_session_vars, clear_session_vars
from wolfhouse import accepted_quote as ledger
from wolfhouse.test_first_yes_owner import offline_quote_result


REQUEST = {
    'check_in': '2027-09-14', 'check_out': '2027-09-17', 'guest_count': 2,
    'guest_name': 'Eva Richter',
    'guests': [{'name': 'Eva Richter'}, {'name': 'Max Richter'}],
    'language': 'en', 'package_code': 'malibu', 'room_preference': 'shared',
    'room_type': 'shared', 'selected_bed_codes': ['R9-B1', 'R9-B2'],
    'shuttle_choice': 'declined',
    'add_ons': [{'code': 'soft_top_rental', 'days': 3, 'quantity': 2},
               {'code': 'wetsuit_rental', 'days': 3, 'quantity': 2}],
    'payment_choice': 'deposit', 'payment_link_distribution': 'separate',
    'per_guest_payment_links': True,
}
ASSIGNMENTS = [
    {'guest_index': 0, 'guest_name': 'eva richter', 'bed_code': 'R9-B1'},
    {'guest_index': 1, 'guest_name': 'max richter', 'bed_code': 'R9-B2'},
]
ROOMS = [{'bed_code': bed, 'room_code': 'R9', 'gender_strategy': 'flexible'}
         for bed in REQUEST['selected_bed_codes']]
OFFER = {
    'v': 1, 'client_slug': 'wolfhouse-somo', 'check_in': '2027-09-14',
    'check_out': '2027-09-17', 'guest_count': 2,
    'guest_bed_assignments': ASSIGNMENTS, 'room_arrangement': ROOMS,
    'room_type': 'shared', 'room_preference': 'shared', 'gender_preference': None,
    'resolved_room_claim': None, 'room_name_hints': [], 'package_code': 'malibu',
    'guest_packages': [],
    'add_ons': [{'code': 'wetsuit_soft_top_combo', 'quantity': 2, 'days': 3}],
    'total_cents': 36000, 'deposit_required_cents': 27000,
    'payment_link_amount_cents': 27000, 'currency': 'EUR',
    'payment_choice': 'deposit', 'per_guest_payment_links': True,
    'payment_distribution': [], 'availability_checked': True,
    'offer_revision_version': 1,
    'offer_fingerprint': 'b92dfd590d932aadaea6c5456dffd99833590564a344ca56f80f64fe1d803a1d',
    'staff_review_required': False,
}
RESPONSE = {
    'success': True, 'total_cents': 36000, 'deposit_required_cents': 27000,
    'payment_choice_needed': False, 'payment_choice': 'deposit',
    'per_guest_payment_links': True, 'payment_link_distribution': 'separate',
    'currency': 'EUR', 'missing_fields': [], 'staff_review_needed': False,
    'offer_revision': OFFER,
    'availability': {
        'status': 'checked', 'availability_checked': True,
        'selected_bed_codes': ['R9-B1', 'R9-B2'],
        'guest_bed_assignments': ASSIGNMENTS, 'room_arrangement': ROOMS,
        'check_in': '2027-09-14', 'check_out': '2027-09-17',
        'guest_count': 2, 'room_type': 'shared',
    },
}


class RichterSoftComboTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.db.create_session('richter', source='whatsapp')
        self.agent = SimpleNamespace(_session_db=self.db, session_id='richter')
        self.env = patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'})
        self.env.start()
        self.tokens = None
        self.turn('quote', 'Add soft boards and wetsuits for both of us for 3 days')

    def tearDown(self):
        if self.tokens:
            clear_session_vars(self.tokens)
        ledger._current.set(None)
        self.env.stop()
        self.db.close()
        self.temp.cleanup()

    def turn(self, message, text):
        if self.tokens:
            clear_session_vars(self.tokens)
        self.tokens = set_session_vars(
            platform='whatsapp', source='whatsapp', chat_id='richter-chat',
            user_id='richter-guest', session_key='richter-key',
            session_id='richter', message_id=message)
        ledger.observe_owner_turn(self.agent, text)

    def record(self, response=None):
        plan = ledger.prepare_quote(deepcopy(REQUEST))
        ledger.record_quote(plan, deepcopy(RESPONSE if response is None else response))

    def test_trace_combo_is_presented_and_next_acceptance_reaches_create(self):
        self.record()
        state = ledger._transaction(lambda state, ingress: deepcopy(state))
        self.assertIsNotNone(state.get('quote'), 'successful Staff soft combo must not be discarded')
        offline_quote_result({'completed': True, 'final_response': 'draft'})
        self.turn('accept', 'Yes, create the booking with separate deposit links')
        prepared = ledger.prepare_create({'confirm': True})
        if prepared.revalidation:
            plan = ledger.prepare_quote(dict(prepared))
            ledger.record_quote(plan, deepcopy(RESPONSE))
            prepared = ledger.prepare_create({'confirm': True})
        self.assertFalse(prepared.revalidation)
        self.assertTrue(prepared['confirm'])
        self.assertEqual(prepared['add_ons'], OFFER['add_ons'])
        self.assertEqual(prepared['selected_bed_codes'], ['R9-B1', 'R9-B2'])
        self.assertTrue(prepared['per_guest_payment_links'])


    def test_undisplayed_material_price_revision_still_blocks_create(self):
        self.record()
        offline_quote_result({'completed': True, 'final_response': 'draft'})
        self.turn('accept', 'Yes, create the booking')
        prepared = ledger.prepare_create({'confirm': True})
        self.assertTrue(prepared.revalidation)
        revised = deepcopy(RESPONSE)
        revised['total_cents'] = revised['offer_revision']['total_cents'] = 37000
        revised['offer_revision']['offer_fingerprint'] = 'offline-material-price-revision'
        plan = ledger.prepare_quote(dict(prepared))
        ledger.record_quote(plan, revised)
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_create({'confirm': True})

    def test_quantity_and_days_mismatches_discard_quote(self):
        for field, value in [('quantity', 1), ('quantity', 3), ('days', 2), ('days', 4)]:
            with self.subTest(field=field, value=value):
                response = deepcopy(RESPONSE)
                response['offer_revision']['add_ons'][0][field] = value
                self.record(response)
                state = ledger._transaction(lambda state, ingress: deepcopy(state))
                self.assertIsNone(state.get('quote'))
                with self.assertRaises(ledger.QuoteBoundaryError):
                    ledger.prepare_create({'confirm': True})

    def test_combo_equivalence_does_not_hide_extra_or_duplicate_selections(self):
        requested = deepcopy(REQUEST['add_ons'])
        combo = deepcopy(OFFER['add_ons'])
        for offered in [combo + combo, combo + [{'code': 'yoga_class', 'quantity': 1}],
                        [{'code': 'wetsuit_soft_top_combo', 'quantity': 2}],
                        [{'code': 'wetsuit_soft_top_combo', 'quantity': 2, 'days': 3,
                          'untrusted': True}],
                        [{'code': 'wetsuit_hard_board_combo', 'quantity': 2, 'days': 3}]]:
            with self.subTest(offered=offered):
                self.assertFalse(ledger._same_checked_rental_components(requested, offered))
        self.assertFalse(ledger._same_checked_rental_components(requested + requested, combo))


if __name__ == '__main__':
    unittest.main()
