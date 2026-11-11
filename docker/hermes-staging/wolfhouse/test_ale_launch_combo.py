"""Ale launch 13/1: reported three-person, one-day combo through deposit link.

Offline reconstruction of 880a32c2, NOT an exported transcript or live booking.
Staff transport/amounts/receipts are fixtures; real JS offer fingerprinting,
registered plugin, owner persistence, presentation and create guards run intact.
"""
import json
import unittest
from copy import deepcopy
from unittest.mock import patch

from wolfhouse import accepted_quote as ledger
from wolfhouse import test_first_yes_owner as first_yes
import wolfhouse_staff_api as plugin


class AleLaunchComboTests(unittest.TestCase):
    setUp = first_yes.FirstYesOwnerTests.setUp
    tearDown = first_yes.FirstYesOwnerTests.tearDown
    turn = first_yes.FirstYesOwnerTests.turn
    _checked_offer = first_yes.FirstYesOwnerTests._checked_offer
    _exact_recheck = staticmethod(first_yes.FirstYesOwnerTests._exact_recheck)

    def test_three_guest_one_day_combo_creates_booking_and_deposit_link(self):
        plan = dict(check_in='2027-04-15', check_out='2027-04-22', guest_count=3,
                    guests=[{'name': name} for name in ('Marie', 'Jonas', 'Kathi')],
                    package_code='malibu', room_type='shared', room_preference='mixed',
                    selected_bed_codes=['R1-B1', 'R1-B2', 'R1-B3'],
                    add_ons=[{'code': code, 'quantity': 3, 'days': 1}
                             for code in ('hard_board_rental', 'wetsuit_rental')],
                    payment_choice='deposit', per_guest_payment_links=False)
        beds = [dict(bed_code=code, room_code='R1', gender_strategy='flexible')
                for code in plan['selected_bed_codes']]
        combo = [{'code': 'wetsuit_hard_board_combo', 'quantity': 3, 'days': 1}]
        # Synthetic amounts: test the reported EUR600 deposit, not the tariff.
        response = self._checked_offer({**plan, 'add_ons': combo}, beds,
                                      dict(total_cents=80700, deposit_required_cents=60000,
                                           payment_link_amount_cents=60000))
        calls = []
        url = 'https://example.invalid/ale-launch-deposit'

        def staff(path, body):
            calls.append((path, deepcopy(body)))
            if path == '/booking-preview':
                return deepcopy(response)
            if path == '/availability-check':
                return self._exact_recheck(body, beds)
            if path == '/booking-create-from-plan':
                return dict(success=True, write_performed=True, booking_id='offline-ale',
                            booking_code='OFFLINE-ALE', payment_id='offline-deposit')
            if path == '/payments/offline-deposit/create-stripe-link':
                return dict(success=True, guest_payment_url=url)
            self.fail('Unexpected transport: ' + path)

        class Registry:
            def __init__(self):
                self.tools = {}
            def register_tool(self, **tool):
                self.tools[tool['name']] = tool
            def register_hook(self, *args, **kwargs):
                pass

        registry = Registry()
        plugin.register(registry)

        def call(name, params):
            return json.loads(registry.tools[name]['handler'](deepcopy(params)))

        with patch.object(plugin, '_post_bot', side_effect=staff):
            self.turn('ale-quote', 'Please quote Malibu for Marie, Jonas and Kathi, '
                      '15–22 April 2027, with hard boards and wetsuits for one day.')
            quoted = call('quote_booking', plan)
            self.assertTrue(quoted['success'], quoted)
            shown = ledger.finalize_offer_response({'completed': True, 'final_response':
                'Marie, Jonas and Kathi: 15–22 April 2027, shared room with Malibu. '
                'Hard boards and wetsuits for all three for one day. Total €807; '
                'deposit €600 now and €207 at arrival. Shall I save this booking?'})
            self.assertTrue(shown['completed'], shown)
            self.turn('ale-yes', 'Yes, book it with one deposit link for all three.')
            created = call('create_booking_from_plan', plan)
            self.assertTrue(created['success'], created)
            creates = [body for path, body in calls if path == '/booking-create-from-plan']
            self.assertEqual(len(creates), 1)
            self.assertEqual(creates[0]['add_ons'], combo)
            self.assertEqual(creates[0]['accepted_offer'], response['offer_revision'])
            self.assertEqual(creates[0]['accepted_offer']['payment_link_amount_cents'], 60000)
            self.assertEqual(created['secure_payment_url'], url)
            self.assertEqual(sum(path == '/payments/offline-deposit/create-stripe-link'
                                 for path, _ in calls), 1)


if __name__ == '__main__':
    unittest.main()
