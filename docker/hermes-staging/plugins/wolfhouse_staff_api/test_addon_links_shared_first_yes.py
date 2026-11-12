"""58ef0f7a follow-on: real adapter, explicit offline Staff responses.
Instruction assertions are not model/live acceptance evidence.
"""
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import wolfhouse_staff_api as plugin


class AddonLinksSharedFirstYesTests(unittest.TestCase):
    def test_two_saved_extras_keep_their_own_guest_payment_links(self):
        links = []
        for kind, date in [('meal', '2027-06-28'), ('yoga', None)]:
            url = 'https://checkout.stripe.com/c/pay/cs_test_max_' + kind
            receipt = dict(success=True, write_performed=True, service_record_id=kind + '-id',
                           booking_code='WH-OFFLINE-HOFFMANN', booking_guest_id='max-id',
                           guest_name='Max Hoffmann', guest_number=2, service_type=kind,
                           service_date=date, quantity=1, payment_required=True,
                           payment_id=kind + '-payment', checkout_url=url, amount_due_cents=1500)
            with patch.object(plugin, '_post_bot', return_value=receipt) as post:
                result = json.loads(plugin.add_service_to_booking({
                    'booking_code': receipt['booking_code'], 'booking_guest_id': 'max-id',
                    'service_type': kind, 'service_date': date, 'quantity': 1}))
            post.assert_called_once()
            self.assertEqual(post.call_args.args[0], '/addon-requests/create')
            self.assertEqual(result['next_action'], 'send_payment_link')
            self.assertFalse(result['use_balance_payment_link'])
            self.assertEqual(result['secure_payment_url'], url)
            self.assertEqual(result['payment_id'], kind + '-payment')
            self.assertEqual(result['booking_guest_id'], 'max-id')
            self.assertEqual(result['guest_name'], 'Max Hoffmann')
            self.assertFalse(result['staff_review_needed'])
            self.assertNotIn('Call create_balance_payment_link', result['guidance'])
            links.append(result['secure_payment_url'])
        self.assertEqual(len(set(links)), 2)

    def test_saved_extra_missing_link_requires_warm_persisted_handoff_not_reception(self):
        with patch.object(plugin, '_post_bot', return_value=dict(
                success=True, write_performed=True, payment_required=True,
                booking_guest_id='max-id', service_record_id='yoga-id',
                checkout_url=None, stripe_error='offline provider failure')):
            result = json.loads(plugin.add_service_to_booking({'service_type': 'yoga'}))
        self.assertTrue(result['write_performed'])
        self.assertFalse(result['payment_link_created'])
        self.assertTrue(result['staff_review_needed'])
        self.assertEqual(result['next_action'], 'flag_needs_human')
        self.assertIn('warm note', result['guidance'])
        self.assertIn('handoff_persisted=true', result['guidance'])
        self.assertIn('Do not ask the guest to contact reception', result['guidance'])
        self.assertNotIn('Call create_balance_payment_link', result['guidance'])

    def test_addon_guide_and_schema_do_not_replace_saved_links_with_balance_step(self):
        root = Path(plugin.__file__).resolve().parents[2]
        for path in (root / 'SOUL.md', root / 'soul-guides/10-packages-extras.md'):
            text = path.read_text()
            self.assertIn('one link per saved add-on', text)
            self.assertNotIn('Never stack per-service links', text)
            self.assertNotIn('**Never** send the per-service checkout URL', text)
        tools = self.tools()
        self.assertNotIn('After success when payment is required, call create_balance_payment_link',
                         tools['add_service_to_booking']['schema']['description'])
        self.assertNotIn('OR immediately after each successful add_service_to_booking',
                         tools['create_balance_payment_link']['schema']['description'])

    def test_payment_failure_instructions_open_handoff_instead_of_sending_guest_away(self):
        root = Path(plugin.__file__).resolve().parents[2]
        for path in (root / 'SOUL.md', root / 'soul-guides/03-info-questions.md'):
            text = path.read_text()
            self.assertNotIn('ask the guest to contact reception directly', text)
            self.assertIn('no handoff has been attempted', text)
            self.assertIn('handoff_persisted=true', text)

    @staticmethod
    def tools():
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **tool): self.tools[tool['name']] = tool
        registry = Registry()
        with patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}):
            plugin.register(registry)
        return registry.tools

    def test_shared_payment_choice_does_not_acquire_another_proceed_question(self):
        tools = self.tools()
        for name in ('quote_booking', 'create_booking_from_plan'):
            text = tools[name]['schema']['description']
            self.assertIn('shared-room booking', text)
            self.assertIn('no final confirmation question', text)
            self.assertIn('previously displayed offer', text)
        root = Path(plugin.__file__).resolve().parents[2]
        for path in (root / 'SOUL.md', root / 'soul-guides/05-quote.md'):
            text = path.read_text()
            self.assertIn('Shared and private rooms follow the same first-yes rule', text)
            self.assertIn('pending_question=go_ahead', text)
            self.assertIn('create_booking_from_plan', text)


if __name__ == '__main__':
    unittest.main()
