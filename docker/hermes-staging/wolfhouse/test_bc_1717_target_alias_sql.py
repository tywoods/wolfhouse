"""BC-1717: offline SQL-saved receipt must not authorize a different target.

Run with Hermes dependencies and staging/plugins on PYTHONPATH:
  python -m unittest wolfhouse.test_bc_1717_target_alias_sql -v

Stacked on #1717. The amendment-changing RED needs its declared #1715 owner
contract dependency at 5f8c990584b34b7645a513decf16d48a19231e8a; running this
checkout without that owner overlay produces a false-negative same-booking
positive control because the base owner cannot register any amendment.
Actual registered create -> Staff body reader/handler -> PGlite commit/readback;
actual owner SQLite and question binding. No live SQL, provider, lookup or send.
Payment aliases use an explicitly synthetic known-payment receipt control, not
proof of a real payment. Only booking A is SQL-created; B is an unresolved target.
"""
from copy import deepcopy
import io
import json
import os
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit

from gateway.session_context import set_session_vars, clear_session_vars
from wolfhouse import accepted_quote as owner
from wolfhouse import test_first_yes_persistence as harness
from wolfhouse.question_test_support import persisted_state
import wolfhouse_staff_api as api


class TargetAliasSQLTests(unittest.TestCase):
    rpc = harness.FirstYesPersistenceTests.rpc
    turn = harness.FirstYesPersistenceTests.turn
    clear_context = harness.FirstYesPersistenceTests.clear_context
    close_node = harness.FirstYesPersistenceTests.close_node

    def setUp(self):
        self.enterContext(patch.dict(os.environ, {
            'NODE_OPTIONS': '--max-old-space-size=1024',
        }))
        harness.FirstYesPersistenceTests.setUp(self)
        self.direct_create = True
        # Script only confirmation authoring; pending-amount saves have no
        # amount_due_now, unlike the older general fixture's writer assumption.
        self.writer.stop()
        def confirmation(agent, facts, invalid_draft, **kwargs):
            display = owner._confirmation_rewrite_payload(
                facts, invalid_draft, [])['required_guest_facts']
            text = (f"Booking {display['booking_reference']} saved. "
                    f"Total: {display['total']}.")
            if display.get('saved_room_type'):
                text += f" Room type: {display['saved_room_type']}."
            if display.get('saved_room_numbers'):
                text += ' Room: ' + ', '.join(display['saved_room_numbers']) + '.'
            if display.get('location_url'):
                text += '\n' + display['location_url']
            return text + '\nDeposit or full?'
        self.enterContext(patch.object(owner, '_rewrite_saved_confirmation', side_effect=confirmation))

    def http_edge(self, request, **kwargs):
        path = urlsplit(request.full_url).path.removeprefix('/staff/bot')
        self.assertIn(path, ('/contact-identity', '/booking-preview',
                             '/availability-check', '/booking-create-from-plan'))
        command = dict(path=path, body=json.loads(request.data),
                       guest_phone=request.get_header('X-luna-guest-phone'))
        if path == '/booking-create-from-plan':
            command.update(staff_body_stream=True, raw_body=request.data.decode())
        result = self.rpc(**command)
        self.assertLess(result['status'], 400, result)
        response = io.BytesIO(json.dumps(result['body']).encode())
        response.status, response.headers = result['status'], {}
        return response

    def exercise(self, alias, same_target=False, known_payment=False):
        plan = deepcopy(harness.PLAN)
        plan.pop('payment_choice', None)
        plan.update(check_in='2027-10-20', check_out='2027-10-24',
                    payment_link_distribution='together', per_guest_payment_links=False)
        with patch.dict(harness.PLAN, plan, clear=True):
            self.turn('Please quote this booking', 'alias-sql-offer')
            saved = self.turn('yes', 'alias-sql-save')['booking_result']
        self.assertTrue(saved['success'], saved)
        self.assertTrue(saved['write_performed'], saved)
        before_sql = self.rpc(snapshot=True)
        self.assertEqual(before_sql['errors'], [])
        self.assertEqual(len(before_sql['tables']['bookings']), 1)
        self.assertEqual(before_sql['tables']['bookings'][0]['id'], saved['booking_id'])
        self.assertEqual(len(before_sql['tables']['booking_guests']), 2)
        self.assertEqual(len(before_sql['tables']['booking_beds']), 2)
        self.assertEqual(sum(c['path'] == '/booking-create-from-plan'
                             for c in before_sql['calls']), 1)

        receipt = deepcopy(saved)
        if known_payment:
            # Deliberately a receipt-control identity, NOT an inserted payment.
            receipt['payment_id'] = '11111111-1111-4111-8111-111111111111'
        initial = {'plan': plan, 'completion_plan': plan, 'completion': receipt}
        calls = []
        class TransportBoundary(BaseException):
            """Stop before lookup/payment and before any error-handoff path."""

        def stop_at_transport(path, payload, **kwargs):
            calls.append((path, deepcopy(payload)))
            raise TransportBoundary(path)

        with persisted_state(initial) as answer:
            answer('deposit')
            answer('together', ['together', 'separate'])
            before = owner._read_owner_state(lambda s, _: deepcopy(s))
            self.assertEqual(before['bound_question_fields']['payment_choice'], 'deposit')
            # A fresh consumed turn asks to amend A; the adversarial model
            # arguments instead select B. Trusted identity is never mocked.
            agent = owner._current.get().binding[0]
            tokens = set_session_vars(platform='whatsapp', source='whatsapp',
                chat_id='c1', user_id='g1', session_key='k1',
                session_id=agent.session_id, message_id='alias-amendment')
            try:
                owner.observe_owner_turn(agent, 'For my saved booking, pay the full amount instead of the deposit.')
                self.assertEqual(api._trusted_inbound_message_id(), 'alias-amendment')
                before = owner._read_owner_state(lambda s, _: deepcopy(s))
                params = {alias: (receipt['payment_id'] if known_payment else receipt['booking_id'])
                          if same_target else '22222222-2222-4222-8222-222222222222',
                          'payment_choice_amendment': {'payment_choice': 'full', 'guest_confirmed': True}}
                result = {}
                with patch.object(api, '_post_bot', side_effect=stop_at_transport):
                    try:
                        result = json.loads(self.registry.tools['create_payment_link']['handler'](params))
                    except TransportBoundary:
                        pass
                after = owner._read_owner_state(lambda s, _: deepcopy(s))
            finally:
                clear_session_vars(tokens)

        self.assertEqual(self.rpc(snapshot=True)['tables'], before_sql['tables'],
                         'Checkout admission must not change any saved SQL rows')
        actual = after['bound_question_fields']['payment_choice']
        print(f'ALIAS {alias}: same_target={same_target}; tier={actual}; '
              f'boundaries={[p for p, _ in calls]}; '
              f'withheld={result.get("payment_link_withheld", False)}', flush=True)
        if same_target:
            self.assertEqual(actual, 'full', 'Positive control requires #1715 owner dependency')
            self.assertTrue(calls, 'Same-booking amendment must reach the offline boundary')
        else:
            self.assertEqual(actual, 'deposit',
                             f'{alias}=B rebound SQL-saved booking A authority; boundaries={calls}')
            self.assertEqual(after.get('saved_payment_amendment'), before.get('saved_payment_amendment'))
            self.assertEqual(after['completion_plan'].get('payment_choice'),
                             before['completion_plan'].get('payment_choice'))
            self.assertTrue(result.get('payment_link_withheld'), result)
            self.assertFalse(any(p.endswith('/create-stripe-link') for p, _ in calls))

    def test_bookingId_foreign_target_preserves_saved_A(self):
        self.exercise('bookingId')

    def test_paymentId_foreign_target_preserves_known_receipt_A(self):
        self.exercise('paymentId', known_payment=True)

    def test_id_foreign_target_preserves_known_receipt_A(self):
        self.exercise('id', known_payment=True)

    def test_canonical_booking_id_foreign_target_control(self):
        self.exercise('booking_id')

    def test_canonical_payment_id_foreign_target_control(self):
        self.exercise('payment_id', known_payment=True)

    def test_same_booking_amendment_positive_control(self):
        self.exercise('booking_id', same_target=True)


if __name__ == '__main__':
    unittest.main()
