"""Offline registered-handler regression: guest choices and capacity facts.

Synthetic Staff receipts only; socket/HTTP tripwires prohibit live calls.
Run with the worktree docker/hermes-staging and plugins on PYTHONPATH.
"""
import copy
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import wolfhouse_staff_api as plugin


class Registry:
    def __init__(self):
        self.tools = {}

    def register_tool(self, **tool):
        self.tools[tool["name"]] = tool


class GuestSimQuoteAvailabilityTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(Path(plugin.__file__).resolve(), Path(__file__).with_name("__init__.py").resolve())
        for target in ("urllib.request.urlopen", "socket.socket.connect", "socket.socket.connect_ex",
                       "socket.create_connection", "socket.getaddrinfo"):
            tripwire = patch(target, side_effect=AssertionError("offline socket/HTTP tripwire"))
            mocked = tripwire.start()
            self.addCleanup(tripwire.stop)
            self.addCleanup(mocked.assert_not_called)
        env = patch.dict(os.environ, {"LUNA_CLIENT_SLUG": "wolfhouse-somo"})
        env.start()
        self.addCleanup(env.stop)
        registry = Registry()
        plugin.register(registry)
        self.tools = registry.tools
        self.params = {
            "check_in": "2027-07-05", "check_out": "2027-07-12", "guest_count": 2,
            "package_code": "malibu", "room_preference": "mixed",
        }
        self.quote = {
            "success": True, "quote_status": "ready",
            "quote": {"total_cents": 84000, "deposit_required_cents": 24000,
                      "balance_due_cents": 84000},
        }

    def invoke(self, name, params, receipt):
        original_params, original_receipt = copy.deepcopy(params), copy.deepcopy(receipt)
        with patch.object(plugin, "_post_bot", return_value=receipt) as transport:
            result = json.loads(self.tools[name]["handler"](params))
        transport.assert_called_once()
        self.assertEqual(transport.call_args.args[0],
                         "/booking-preview" if name == "quote_booking" else "/availability-check")
        self.assertEqual(params, original_params)
        self.assertEqual(receipt, original_receipt)
        return result, transport.call_args.args[1]

    def test_explicit_payment_choice_survives_quote_without_reasking(self):
        for choice in ("deposit", "full", "split", "per_guest", "full amount", "pay on arrival"):
            with self.subTest(choice=choice):
                result, sent = self.invoke("quote_booking", {**self.params, "payment_choice": choice}, self.quote)
                self.assertEqual(result.get("payment_choice"), choice)
                self.assertFalse(result["payment_choice_needed"])
                self.assertFalse(result["full_payment_only"], "known choice is not a full-payment-only tariff")
                self.assertEqual(result["total_cents"], 84000)
                self.assertEqual(result["deposit_required_cents"], 24000)
                self.assertEqual(result["remaining_after_deposit_cents"], 60000)
                self.assertEqual(result["balance_due_cents"], 84000, "quote balance is not money received")
                self.assertEqual(sent["payment_choice"], choice)
                self.assertNotIn("confirm", sent)


    def test_blank_unknown_and_nonstring_are_not_payment_consent(self):
        for choice in (None, '', '  ', 'surprise', False, 1, {}):
            with self.subTest(choice=choice):
                result, sent = self.invoke('quote_booking', {**self.params, 'payment_choice': choice}, self.quote)
                self.assertTrue(result['payment_choice_needed'])
                self.assertFalse(result['full_payment_only'])
                self.assertNotIn('payment_choice', result)
                self.assertNotIn('confirm', sent)

    def test_full_payment_only_is_money_based_not_choice_based(self):
        receipt = {'success': True, 'quote': {'total_cents': 10000, 'deposit_required_cents': 10000}}
        for choice in ('', 'deposit', 'full', 'split'):
            result, _ = self.invoke('quote_booking', {**self.params, 'payment_choice': choice}, receipt)
            self.assertTrue(result['full_payment_only'])
            self.assertFalse(result['payment_choice_needed'])
            if not choice:
                self.assertNotIn('payment_choice', result)

    def test_available_beds_are_safe_staff_facts_with_eligibility_preserved(self):
        receipt = {'success': True, 'has_enough_beds': True,
                   'selected_room_code': 'MIX', 'selected_bed_codes': ['M1'],
                   'girls_room_available': True,
                   'available_beds': [
                       {'bed_code': 'M1', 'room_code': 'MIX', 'room_type': 'mixed',
                        'bed_label': 'Bed 1', 'active': True, 'sellable': True,
                        'occupant': {'name': 'PRIVATE'}, 'guest_phone': 'PRIVATE', 'price': 777},
                       {'bed_code': 'F1', 'room_code': 'GIRLS', 'room_type': 'female_only'},
                   ]}
        result, _ = self.invoke('check_availability', {**self.params, 'group_gender': 'male'}, receipt)
        self.assertEqual(result.get('available_beds'), [
            {'bed_code': 'M1', 'room_code': 'MIX', 'room_type': 'mixed', 'bed_label': 'Bed 1'}])
        self.assertEqual(result.get('selected_room_code'), 'MIX')
        self.assertFalse(result['girls_room_available'])
        self.assertIn('female_only', result['room_decision']['excluded_room_preferences'])
        self.assertFalse(result['needs_human'])
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_mixed_gendered_selection_is_never_relabelled_from_filtered_subset(self):
        receipt = {'success': True, 'has_enough_beds': True,
                   'selected_bed_codes': ['A1', 'B1'],
                   'available_beds': [
                       {'bed_code': 'A1', 'room_code': 'A', 'room_type': 'male_only'},
                       {'bed_code': 'B1', 'room_code': 'B', 'room_type': 'female_only'},
                   ]}
        result, _ = self.invoke('check_availability', {**self.params, 'group_gender': 'male'}, receipt)
        self.assertEqual(result['selected_room_types'], ['male_only', 'female_only'])
        self.assertIsNone(result['selected_room_description'])
        self.assertIsNone(result['guest_safe_room_label'])
        self.assertEqual(result['selected_bed_codes'], ['A1', 'B1'])

    def test_post_booking_email_save_outcomes_replay_and_no_write_fences(self):
        payload = {'client_slug': 'wolfhouse-somo', 'email': 'alex@example.test'}
        created = {'success': True, 'write_performed': True}
        fields = {'booking_code': 'UNIT-EMAIL'}
        cases = (
            ({'success': True, 'write_performed': True, 'email_sent': True}, True, 'saved'),
            ({'success': False, 'write_performed': False, 'error': 'refused'}, False, 'refused'),
            ({'success': False, 'error': 'timeout'}, False, 'unknown'),
        )
        for adapter_result, saved, outcome in cases:
            with self.subTest(outcome=outcome), patch.object(plugin, '_post_bot', return_value=adapter_result) as post:
                result = plugin._save_post_booking_email(payload, created, fields)
                self.assertEqual(result['saved'], saved)
                self.assertEqual(result['outcome'], outcome)
                self.assertFalse(result['sent'])
                self.assertFalse(result['send_performed'])
                post.assert_called_once_with('/bookings/update-contact', {
                    'client_slug': 'wolfhouse-somo', 'booking_code': 'UNIT-EMAIL',
                    'email': 'alex@example.test',
                })

        prior = {'post_booking_email': {'requested': True, 'saved': True, 'sent': False,
                                        'send_performed': False, 'outcome': 'saved'}}
        with patch.object(plugin, '_post_bot') as post:
            self.assertEqual(plugin._save_post_booking_email(payload, created, fields, prior),
                             prior['post_booking_email'])
            self.assertIsNone(plugin._save_post_booking_email(payload,
                {'success': False, 'write_performed': False}, fields))
            self.assertIsNone(plugin._save_post_booking_email(payload,
                {'success': True, 'write_performed': False}, fields))
            self.assertIsNone(plugin._save_post_booking_email({}, created, fields))
            post.assert_not_called()

    def test_post_booking_contact_owner_status_controls_replay_transport(self):
        from wolfhouse import accepted_quote as ledger
        payload = {'client_slug': 'wolfhouse-somo', 'email': 'alex@example.test'}
        created = {'success': True, 'write_performed': True}
        fields = {'booking_code': 'UNIT-EMAIL'}
        ticket = {'owner': 'opaque'}

        with patch.object(ledger, 'post_booking_contact_status',
                          return_value={'status': 'unknown'}), \
                patch.object(ledger, 'begin_post_booking_contact') as begin, \
                patch.object(plugin, '_post_bot') as post:
            result = plugin._save_post_booking_email(
                payload, created, fields, prior_receipt=created, ticket=ticket)
        self.assertEqual(result['outcome'], 'unknown')
        self.assertTrue(result['uncertain'])
        self.assertFalse(result['sent'])
        begin.assert_not_called()
        post.assert_not_called()

        with patch.object(ledger, 'post_booking_contact_status',
                          return_value={'status': 'pending'}), \
                patch.object(ledger, 'begin_post_booking_contact',
                             return_value={'perform': True, 'contact': {'status': 'unknown'}}), \
                patch.object(ledger, 'complete_post_booking_contact') as complete, \
                patch.object(plugin, '_post_bot',
                             return_value={'success': True, 'write_performed': True}):
            result = plugin._save_post_booking_email(
                payload, created, fields, prior_receipt=created, ticket=ticket)
        self.assertEqual(result['outcome'], 'saved')
        complete.assert_called_once()
        self.assertFalse(complete.call_args.kwargs['outcome']['sent'])

    def test_failed_or_malformed_availability_cannot_project_beds(self):
        for receipt in (
            {'success': False, 'available_beds': [{'bed_code': 'M1'}], 'selected_room_code': 'MIX'},
            {'success': True, 'available_beds': {'occupant': 'PRIVATE'}, 'selected_room_code': {'guest': 'PRIVATE'}},
            {'success': True, 'available_beds': [None, 'PRIVATE', {'bed_code': {'name': 'PRIVATE'}}]},
        ):
            result, _ = self.invoke('check_availability', self.params, receipt)
            self.assertEqual(result.get('available_beds'), [])
            self.assertIsNone(result.get('selected_room_code'))
            self.assertNotIn('PRIVATE', json.dumps(result))


if __name__ == "__main__":
    unittest.main()
