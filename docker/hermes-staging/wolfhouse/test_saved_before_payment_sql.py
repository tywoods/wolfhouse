"""Real registered create + ephemeral Staff SQL proof; no live writes or sends.

Uses the existing offline ingress fixture. Its LLM and HTTP edges are synthetic;
booking rows come from the real Staff create handler, not invented receipts.
"""
import copy
import unittest
from unittest.mock import patch


class SavedBeforePaymentTests(unittest.TestCase):
    def test_solo_and_group_save_without_selecting_a_payment_tier(self):
        from wolfhouse import test_serious_booking_persistence as fixtures
        from wolfhouse import test_first_yes_persistence as harness
        for count in (1, 4):
            with self.subTest(count=count):
                case = fixtures.SeriousBookingPersistenceTests()
                try:
                    case.setUp()
                    # The shared fixture's legacy LLM stub requires a due-now
                    # amount. This synthetic writer supports the new pending
                    # amount contract; production fact validation stays real.
                    from wolfhouse import accepted_quote as owner
                    def pending_confirmation(agent, facts, invalid_draft, **kwargs):
                        display = owner._confirmation_rewrite_payload(
                            facts, invalid_draft, [])['required_guest_facts']
                        text = (f"Your booking is saved. Reference: {display['booking_reference']}. "
                                f"Total: {display['total']}.")
                        if display.get('saved_room_type'):
                            text += f" Room type: {display['saved_room_type']}."
                        if display.get('saved_room_numbers'):
                            text += ' Room: ' + ', '.join(display['saved_room_numbers']) + '.'
                        if display.get('location_url'):
                            text += '\n' + display['location_url']
                        return text + '\nWould you like to pay the deposit or the full total?'
                    case.writer.stop()
                    writer = patch.object(owner, '_rewrite_saved_confirmation',
                                          side_effect=pending_confirmation)
                    writer.start()
                    case.addCleanup(writer.stop)
                    plan = copy.deepcopy(fixtures.R1)
                    plan.update(guest_count=count,
                                guests=[{'name': n, 'explicit_gender': 'male'}
                                        for n in ('Riley', 'Morgan', 'Alex', 'Sam')[:count]],
                                selected_bed_codes=[f'R1-B{i + 1}' for i in range(count)])
                    with patch.dict(harness.PLAN, plan, clear=True):
                        case.quote('quote-before-save')
                        result = case.turn('yes', 'save-with-no-tier')
                        receipt = result['booking_result']
                        self.assertTrue(receipt['success'], receipt)
                        self.assertTrue(receipt['write_performed'], receipt)
                        self.assertIs(receipt['ask_payment_amount'], True)
                        self.assertEqual(receipt['next_action'], 'ask_deposit_or_full')
                        self.assertFalse(receipt['payment_link_created'])
                        self.assertIsNone(receipt['secure_payment_url'])
                        self.assertEqual(case.payment_edges, [])
                        self.assertIn(receipt['booking_code'], result['final_response'])
                        self.assertIn('deposit or the full total?', result['final_response'])
                        snapshot = case.rpc(snapshot=True)
                        self.assertEqual(snapshot['errors'], [])
                        self.assertEqual(len(snapshot['tables']['bookings']), 1)
                        self.assertEqual(len(snapshot['tables']['booking_guests']), count)
                        self.assertEqual(len(snapshot['tables']['booking_beds']), count)
                        self.assertEqual(snapshot['tables']['bookings'][0]['payment_status'], 'not_requested')
                        # Real saved SQL survives a later, separately admitted
                        # checkout failure. No provider or transport is invoked.
                        from wolfhouse.pending_question import PaymentAdmissionError
                        import wolfhouse_staff_api as api
                        with patch.object(api, '_post_bot', side_effect=PaymentAdmissionError('checkout unavailable')) as checkout:
                            with self.assertRaises(PaymentAdmissionError):
                                api.create_payment_link({'payment_id': receipt['payment_id'],
                                                         'payment_choice': 'full',
                                                         'ask_payment_amount': False,
                                                         'per_guest_payment_links': False})
                            checkout.assert_called_once()
                        after_failure = case.rpc(snapshot=True)
                        self.assertEqual(after_failure['tables']['bookings'], snapshot['tables']['bookings'])
                        self.assertEqual(after_failure['tables']['booking_guests'], snapshot['tables']['booking_guests'])
                        self.assertEqual(after_failure['tables']['booking_beds'], snapshot['tables']['booking_beds'])
                finally:
                    case.doCleanups()


if __name__ == '__main__':
    unittest.main()
