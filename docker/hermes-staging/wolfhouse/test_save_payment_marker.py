"""SD-STAGING-FIX-0250: checked Staff projection must not invent payment consent."""
import unittest
from wolfhouse import accepted_quote as owner
from wolfhouse import pending_question as pq
from wolfhouse.question_test_support import persisted_answer


def checked_response(count=1):
    beds = [f'M{i + 1}' for i in range(count)]
    offer = {
        'client_slug': 'wolfhouse-somo', 'availability_checked': True,
        'offer_fingerprint': 'offline-staff-fixture',
        'check_in': '2027-06-01', 'check_out': '2027-06-08',
        'currency': 'EUR', 'room_type': 'shared', 'package_code': 'package_none',
        'guest_count': count, 'payment_choice': 'deposit',
        'per_guest_payment_links': False, 'total_cents': 41500 * count,
        'deposit_required_cents': 20000 * count, 'payment_link_amount_cents': 20000 * count,
        'guest_bed_assignments': [
            {'guest_index': i, 'guest_name': f'guest {i}', 'bed_code': bed}
            for i, bed in enumerate(beds)],
        'room_arrangement': [
            {'bed_code': bed, 'room_code': 'M', 'gender_strategy': 'mixed'} for bed in beds],
    }
    return {'success': True, 'total_cents': offer['total_cents'],
            'deposit_required_cents': offer['deposit_required_cents'],
            'offer_revision': offer,
            'availability': {'status': 'checked', 'selected_bed_codes': beds}}


class SavePaymentMarkerTests(unittest.TestCase):
    def test_actual_quote_renderer_never_asks_tier_before_save(self):
        for count in (1, 4):
            for separate in (False, True):
                with self.subTest(count=count, separate=separate):
                    offer = checked_response(count)['offer_revision']
                    plan = {'guest_count': count, 'per_guest_payment_links': separate,
                            'payment_choice': 'deposit', 'ask_payment_amount': True}
                    text = owner._styled_quote_copy(plan, offer, create_ready=False)
                    self.assertNotIn('Which would you like', text)
                    self.assertIn(owner._style_copy('en')['save'], text)
                    self.assertEqual(pq.quote_question_kind(plan, offer, 'en', False), 'go_ahead')

    def test_declared_payment_options_do_not_override_presave_question(self):
        # Exercise the actual model-authoring producer, not just styled copy.
        for count in (1, 4):
            for ready in (False, True):
                for separate in (None, False, True):
                    with self.subTest(count=count, ready=ready, separate=separate):
                        response = checked_response(count)
                        response['_present_payment_options'] = ['deposit', 'full']
                        plan = {'guest_count': count, 'payment_choice': 'deposit',
                                'ask_payment_amount': True}
                        if separate is not None:
                            plan['per_guest_payment_links'] = separate
                        facts = owner._quote_authoring_facts(
                            plan, response['offer_revision'], create_ready=ready, quote=response)
                        self.assertEqual(facts['pending_question'], {'kind': 'go_ahead', 'options': None})
                        self.assertEqual(facts['next_decision']['subject'], 'go_ahead')
                        self.assertIsNone(facts['present_payment_options'])

    def test_declared_options_finalizer_persists_save_question(self):
        from wolfhouse.test_tyler_offer_carryover import TylerOfferCarryoverTests
        case = TylerOfferCarryoverTests()
        case.setUp()
        try:
            quoted = case.call('quote_booking', {
                **case.plan, 'payment_choice': 'deposit',
                'present_payment_options': ['deposit', 'full']})
            self.assertTrue(quoted['success'], quoted)
            text = 'Your stay totals €190. Would you like me to save it?'
            result = owner.finalize_offer_response({'completed': True, 'final_response': text})
            self.assertTrue(result['completed'], result)
            self.assertEqual(case.state()['pending_question']['kind'], 'go_ahead')
            self.assertNotIn('options', case.state()['pending_question'])
            self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in case.calls))
        finally:
            case.tearDown()
            case.doCleanups()

    def test_explicit_tier_survives_checked_projection(self):
        for choice in ('deposit', 'full'):
            response = checked_response()
            offer = response['offer_revision']
            offer['payment_choice'] = choice
            if choice == 'full':
                offer['payment_link_amount_cents'] = offer['total_cents']
            prepared = owner._with_inferred_guest_payment({}, persisted_answer({}, choice))
            checked = owner._checked_plan(prepared, response, 'wolfhouse-somo')
            self.assertIsNotNone(checked)
            self.assertIs(checked['ask_payment_amount'], False)
            self.assertFalse(pq.withhold_payment_link(checked, offer))

    def test_saved_receipt_renderer_asks_tier_without_a_url(self):
        for count in (1, 4):
            offer = checked_response(count)['offer_revision']
            plan = {'guest_count': count, 'payment_choice': 'deposit', 'ask_payment_amount': True}
            receipt = {'booking_code': 'WH-OFFLINE-0250', 'ask_payment_amount': True,
                       'payment_status': 'not_requested'}
            text = owner._styled_booking_receipt_copy(plan, offer, receipt)
            self.assertIn('WH-OFFLINE-0250', text)
            self.assertIn('Which would you like?', text)
            self.assertNotIn('https://', text)
            self.assertLessEqual(text.count('🌊'), 1)
            self.assertLessEqual(text.count('😊'), 1)

    def test_checked_quote_then_bare_save_does_not_authorize_deposit(self):
        for count in (1, 4):
            with self.subTest(count=count):
                response = checked_response(count)
                prepared = owner._with_inferred_guest_payment(
                    {'payment_choice': 'deposit', 'guest_count': count},
                    {'current_turn': {'raw': 'please quote my stay'}})
                checked = owner._checked_plan(prepared, response, 'wolfhouse-somo')
                self.assertIsNotNone(checked)
                saved = owner._with_inferred_guest_payment(
                    {'payment_choice': 'deposit'},
                    {'plan': checked, 'current_turn': {'raw': 'save'}})
                self.assertIs(saved.get('ask_payment_amount'), True)
                self.assertTrue(pq.withhold_payment_link(saved, response['offer_revision']))
                for answer in ('deposit', 'full'):
                    answered = owner._with_inferred_guest_payment({}, persisted_answer(
                        {'plan': saved}, answer))
                    self.assertEqual(answered['payment_choice'], answer)
                    self.assertIs(answered['ask_payment_amount'], False)
                    self.assertEqual(pq.withhold_payment_link(answered, response['offer_revision']), count >= 2)


if __name__ == '__main__':
    unittest.main()
