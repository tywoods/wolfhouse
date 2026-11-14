"""Guest addition uses the saved-booking owner, not a second booking create."""
import json
import unittest
from unittest.mock import patch
import wolfhouse_staff_api as plugin

class AddGuestAdapter(unittest.TestCase):
    def test_addition_preserves_receipt_and_asks_payment_before_creating_link(self):
        receipt = {'success': True, 'write_performed': True, 'booking_code': 'WH-FIXTURE',
                   'added_guests': [{'booking_guest_id': 'fixture-guest', 'guest_number': 2,
                                     'guest_name': 'Ale Test Tom'}],
                   'total_amount_cents': 59800, 'payment_choice_needed': True}
        with patch.object(plugin, '_post_bot', return_value=receipt) as post, \
             patch.object(plugin, '_session_guest_phone', return_value='+999000000000001'):
            result = json.loads(plugin.add_guest_to_booking({
                'booking_code': 'WH-FIXTURE', 'guest_name': 'Ale Test Tom'}))
        self.assertTrue(result['write_performed'])
        self.assertEqual(result['added_guests'], receipt['added_guests'])
        self.assertTrue(result['payment_choice_needed'])
        self.assertEqual(post.call_count, 1)
        path, body = post.call_args.args
        self.assertEqual(path, '/staff/bot/bookings/add-guest')
        self.assertEqual(body['guest_name'], 'Ale Test Tom')
        self.assertEqual(body['phone'], '+999000000000001')
        self.assertNotIn('secure_payment_url', result)

    def test_unpriced_added_guest_keeps_staff_review_and_no_payment_instruction(self):
        receipt = {'success': True, 'write_performed': True,
                   'booking_guest_id': 'fixture-guest', 'added_guest_total_cents': None,
                   'price_needs_staff_review': True, 'next_action': 'review_guest_price'}
        with patch.object(plugin, '_post_bot', return_value=receipt), \
             patch.object(plugin, '_session_guest_phone', return_value='+999****0001'):
            result = json.loads(plugin.add_guest_to_booking({
                'booking_code': 'WH-FIXTURE', 'guest_name': 'Sam'}))
        self.assertEqual(result['next_action'], 'review_guest_price')
        self.assertFalse(result.get('payment_choice_needed', False))
        self.assertNotIn('create_guest_payment_link', result.get('guest_safe_next_action', ''))

    def test_lookup_uses_authenticated_chat_even_when_model_carries_old_phone(self):
        with patch.object(plugin, '_post_bot', return_value={'success': True, 'bookings': []}) as post, \
             patch.object(plugin, '_session_guest_phone', return_value='+999000000000001'):
            plugin.list_my_bookings({'phone': '+999000000000002'})
        self.assertEqual(post.call_args.args[1]['phone'], '+999000000000001')

if __name__ == '__main__': unittest.main()
