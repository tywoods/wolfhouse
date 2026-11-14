"""Offline plugin bridge: saved booking with no payment row -> explicit group tier."""
import json
from pathlib import Path
import re
import unittest
from unittest.mock import patch
import wolfhouse_staff_api as staff

BOOKING='11111111-1111-4111-8111-111111111111'
PAYMENT='22222222-2222-4222-8222-222222222222'

class SavedGroupPaymentTests(unittest.TestCase):
    def run_case(self, choice=None, prepare=None, lookup=None):
        calls=[]
        def post(path,payload,**kwargs):
            calls.append((path,payload))
            if path == '/payments/status':
                return lookup if lookup is not None else {'success':True,'booking_id':BOOKING,'booking_code':'WH-OFFLINE','latest_payment':None}
            if path == '/payments/prepare':
                return prepare if prepare is not None else {'success':True,'booking_id':BOOKING,'payment_id':PAYMENT,'amount_due_cents':40000}
            if path == f'/payments/{PAYMENT}/create-stripe-link':
                return {'success':True,'payment_id':PAYMENT,'booking_code':'WH-OFFLINE',
                        'payment_short_url':'https://staff-staging.lunafrontdesk.com/pay/WH-OFFLINE'}
            raise AssertionError(path)
        params={'booking_code':'WH-OFFLINE'}
        if choice is not None: params['payment_choice']=choice
        with patch.object(staff,'_post_bot',side_effect=post),patch.object(staff,'_trusted_client_slug',return_value='wolfhouse-somo'):
            result=json.loads(staff.create_payment_link(params))
        return result,calls

    def test_pending_saved_booking_gets_deposit_or_full_draft_then_one_link(self):
        for choice in ('deposit','full'):
            with self.subTest(choice=choice):
                result,calls=self.run_case(choice)
                self.assertTrue(result['success'],result)
                self.assertEqual([p for p,_ in calls],['/payments/status','/payments/prepare',f'/payments/{PAYMENT}/create-stripe-link'])
                self.assertEqual(calls[1][1]['booking_id'],BOOKING)
                self.assertEqual(calls[1][1]['payment_choice'],choice)
                self.assertNotIn('amount_due_cents',calls[1][1])

    def test_persisted_amount_and_distribution_supply_omitted_tool_choice(self):
        from wolfhouse import accepted_quote as owner
        from wolfhouse.question_test_support import persisted_state
        receipt = dict(success=True, write_performed=True, booking_id=BOOKING,
                       booking_code='WH-OFFLINE', payment_id=None,
                       total_cents=83000, deposit_required_cents=40000)
        for choice in ('deposit', 'full'):
            with self.subTest(choice=choice), persisted_state({
                'plan': {'guest_count': 2, 'payment_choice': 'deposit', 'ask_payment_amount': True},
                'completion': receipt,
            }) as answer:
                answer(choice)
                answer('together', ['together', 'separate'])
                result, calls = self.run_case(None, lookup=dict(receipt, latest_payment=None))
                self.assertTrue(result['success'], result)
                self.assertEqual(result['next_action'], 'send_secure_payment_link')
                self.assertEqual([p for p, _ in calls], [
                    '/payments/status', '/payments/prepare', f'/payments/{PAYMENT}/create-stripe-link'])
                self.assertEqual(calls[1][1]['payment_choice'], choice)
                self.assertEqual(calls[2][1]['payment_choice'], choice)
                self.assertEqual(owner._read_owner_state(lambda s, _: s['pending_question']['status']), 'answered')

    def test_actual_plugin_preparation_path_is_registered_by_staff_router(self):
        source = (Path(__file__).resolve().parents[4] / 'scripts/staff-query-api.js').read_text()
        registered = set(re.findall(r"if \(pathname === '([^']+)'\)", source))
        for choice in ('deposit', 'full'):
            result, calls = self.run_case(choice)
            self.assertTrue(result['success'], result)
            actual_path = '/staff/bot' + calls[1][0]
            self.assertIn(actual_path, registered,
                          'the plugin must call an actual authenticated Staff HTTP route, not just a mock')

    def test_missing_or_distribution_only_choice_does_not_invent_amount_tier(self):
        for choice in (None,'together','per_guest'):
            with self.subTest(choice=choice):
                result,calls=self.run_case(choice)
                self.assertFalse(result['success'])
                self.assertTrue(result['payment_choice_needed'])
                self.assertFalse(result['staff_review_needed'])
                self.assertEqual(len(calls),1)

    def test_refused_preparation_cannot_create_link(self):
        result,calls=self.run_case('deposit',prepare={'success':False,'reason_code':'booking_not_found'})
        self.assertFalse(result['success'])
        self.assertEqual(len(calls),2)

    def test_failed_lookup_cannot_prepare_a_payment(self):
        result,calls=self.run_case('deposit',lookup={'success':False,'error':'booking_not_found'})
        self.assertFalse(result['success'])
        self.assertEqual(len(calls),1)

if __name__ == '__main__': unittest.main()
