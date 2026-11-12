"""Offline real-owner tests; all Staff and WhatsApp transports are doubles."""
from copy import deepcopy
from unittest.mock import patch
import unittest

from wolfhouse import accepted_quote as owner
from wolfhouse import test_no_final_ask as support
import wolfhouse_staff_api as plugin


class QuoteSendAckTests(unittest.TestCase):
    def setUp(self):
        self.h = support.NoFinalAskTests()
        self.h.setUp()
        self.addCleanup(self.h.tearDown)
        self.h.case = deepcopy(support.FIXTURES['klein'])
        transport = patch.object(plugin, '_post_bot', side_effect=self.h.staff)
        transport.start()
        self.addCleanup(transport.stop)
        self.h.call('quote_booking', self.h.case['quote_args'])
        # The real finalizer, deliberately WITHOUT any provider acknowledgement.
        self.text = 'Total €598. Deposit €400, remaining €198 at arrival.'
        self.output = owner.finalize_offer_response(
            {'completed': True, 'final_response': self.text})
        self.assertEqual(self.output['final_response'], self.text)

    def test_successful_send_ack_allows_checked_create(self):
        from wolfhouse import quote_delivery as delivery
        self.assertTrue(callable(getattr(delivery, 'prepare', None)), 'send ticket owner missing')
        ticket = delivery.prepare(owner._current.get().binding[1:], self.text)
        self.assertIsNotNone(ticket)
        self.assertTrue(delivery.acknowledge(ticket, self.text, 'offline-wamid-1'))
        created = self.h.call('create_booking_from_plan', self.h.case['create_args'])
        self.assertTrue(created['success'], created)
        self.assertEqual(sum(p == '/booking-create-from-plan' for p, _ in self.h.calls), 1)

    def test_changed_price_after_send_cannot_reuse_ack(self):
        from wolfhouse import quote_delivery as delivery
        ticket = delivery.prepare(owner._current.get().binding[1:], self.text)
        self.assertTrue(delivery.acknowledge(ticket, self.text, 'offline-original-price'))
        quote = self.h.case['quote_result']
        quote['total_cents'] += 1000
        quote['offer_revision']['total_cents'] += 1000
        result = self.h.call('create_booking_from_plan', self.h.case['create_args'])
        self.assertFalse(result['success'], result)
        self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.h.calls))
        self.assertFalse(delivery.claim_continuation(ticket))
        refreshed = owner.finalize_offer_response({'completed': True,
            'final_response': 'Total €608. Deposit €400, remaining €208 at arrival.'})
        self.assertIn('€608', refreshed['final_response'])
        presentation = owner._transaction(lambda state, _: deepcopy(state.get('presentation')))
        self.assertFalse(delivery.has_send_ack(presentation))
        self.assertFalse(self.h.call('create_booking_from_plan', self.h.case['create_args'])['success'])
        fresh = delivery.prepare(owner._current.get().binding[1:], refreshed['final_response'])
        self.assertIsNotNone(fresh)
        self.assertFalse(delivery.acknowledge(ticket, refreshed['final_response'], 'offline-original-price'))
        self.assertTrue(delivery.acknowledge(fresh, refreshed['final_response'], 'offline-new-price'))

    def test_changed_booking_terms_cannot_use_sent_receipt(self):
        from wolfhouse import quote_delivery as delivery
        ticket = delivery.prepare(owner._current.get().binding[1:], self.text)
        self.assertTrue(delivery.acknowledge(ticket, self.text, 'offline-wamid'))
        result = self.h.call('create_booking_from_plan',
            dict(self.h.case['create_args'], check_out='2027-09-28'))
        self.assertFalse(result['success'], result)
        self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.h.calls))

    def test_send_ticket_rejects_missing_id_changed_body_and_stale_turn(self):
        from wolfhouse import quote_delivery as delivery
        ticket = delivery.prepare(owner._current.get().binding[1:], self.text)
        self.assertFalse(delivery.acknowledge(ticket, self.text, ''))
        self.assertFalse(delivery.acknowledge(ticket, 'Different price', 'offline-wamid'))
        owner._transaction(lambda state, _: state.update(epoch=state['epoch'] + 1))
        self.assertFalse(delivery.acknowledge(ticket, self.text, 'offline-wamid'))

    def test_send_ticket_rejects_other_scope_and_ended_session(self):
        from wolfhouse import quote_delivery as delivery
        binding = owner._current.get().binding[1:]
        wrong = (binding[0], dict(binding[1], TENANT_ID='other-tenant'), binding[2])
        self.assertIsNone(delivery.prepare(wrong, self.text))
        ticket = delivery.prepare(binding, self.text)
        self.h.db._execute_write(lambda conn: conn.execute(
            'UPDATE sessions SET ended_at=? WHERE id=?', (1, binding[1]['ID'])))
        self.assertFalse(delivery.acknowledge(ticket, self.text, 'offline-wamid'))

    def test_duplicate_ack_claims_only_one_continuation_without_new_guest_turn(self):
        from wolfhouse import quote_delivery as delivery
        self.h.call('create_booking_from_plan', self.h.case['create_args'])
        state = owner._transaction(lambda state, _: deepcopy(state))
        self.assertEqual(state['post_price_create_requested']['epoch'], state['epoch'])
        ticket = delivery.prepare(owner._current.get().binding[1:], self.text)
        self.assertTrue(delivery.acknowledge(ticket, self.text, 'offline-wamid'))
        self.assertTrue(delivery.acknowledge(ticket, self.text, 'offline-wamid'))
        self.assertTrue(callable(getattr(delivery, 'claim_continuation', None)))
        self.assertTrue(delivery.claim_continuation(ticket))
        self.assertFalse(delivery.claim_continuation(ticket))
        self.assertEqual(owner._transaction(lambda state, _: deepcopy(state))['current_turn'], state['current_turn'])
        self.assertEqual(owner._transaction(lambda state, _: deepcopy(state))['seen'], state['seen'])

    def test_quote_only_does_not_claim_automatic_create(self):
        from wolfhouse import quote_delivery as delivery
        ticket = delivery.prepare(owner._current.get().binding[1:], self.text)
        delivery.acknowledge(ticket, self.text, 'offline-wamid')
        self.assertTrue(callable(getattr(delivery, 'claim_continuation', None)))
        self.assertFalse(delivery.claim_continuation(ticket))

    def test_provider_callback_rejects_failed_suppressed_and_no_id(self):
        from wolfhouse import quote_delivery as delivery
        from types import SimpleNamespace
        ticket = delivery.prepare(owner._current.get().binding[1:], self.text)
        token = delivery._sending.set(ticket)
        try:
            for success, mid, raw in ((False, 'id', {}), (True, '', {}),
                                      (True, 'id', {'suppressed_dry_run': True}),
                                      (True, 'id', {'suppressed_pause': False})):
                with self.subTest(success=success, mid=mid, raw=raw):
                    self.assertFalse(delivery.record_provider_result(self.text,
                        SimpleNamespace(success=success, message_id=mid, raw_response=raw)))
            self.assertTrue(delivery.record_provider_result(self.text,
                SimpleNamespace(success=True, message_id='offline-wamid', raw_response={})))
        finally:
            delivery._sending.reset(token)

    def test_dispatch_rechecks_ack_instead_of_trusting_prepared_plan(self):
        from wolfhouse import quote_delivery as delivery
        ticket = delivery.prepare(owner._current.get().binding[1:], self.text)
        delivery.acknowledge(ticket, self.text, 'offline-wamid')
        def remove_ack(state, _):
            state['presentation'].pop('send_ack', None)
            if isinstance(state.get('accepted_presentation'), dict):
                state['accepted_presentation'].pop('send_ack', None)
        original_dispatch = owner.dispatch_create
        def lose_ack(*args, **kwargs):
            owner._transaction(remove_ack)
            return original_dispatch(*args, **kwargs)
        with patch.object(owner, 'dispatch_create', side_effect=lose_ack):
            result = self.h.call('create_booking_from_plan', self.h.case['create_args'])
        self.assertFalse(result['success'], result)
        self.assertEqual(result['error'], 'quote_owner_sent_offer_required')
        self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.h.calls))

    def test_deferred_complete_request_authors_price_without_new_booking_question(self):
        self.h.call('create_booking_from_plan', self.h.case['create_args'])
        captured = []
        def author(facts, _draft):
            captured.append(deepcopy(facts))
            return self.text
        out = owner.finalize_offer_response(
            {'completed': True, 'final_response': 'draft', 'messages': [{'role': 'assistant', 'content': 'draft'}]},
            quote_rewrite_callback=author)
        self.assertTrue(out['final_response'])
        self.assertIsNone(captured[-1]['pending_question']['kind'])
        self.assertIsNone(captured[-1]['next_decision']['subject'])
        self.assertTrue(captured[-1]['continue_after_successful_send'])

    def test_finalized_price_alone_cannot_authorize_create(self):
        created = self.h.call('create_booking_from_plan', self.h.case['create_args'])
        self.assertFalse(created['success'], created)
        self.assertEqual(created['error'], 'quote_owner_sent_offer_required')
        self.assertFalse(any(p == '/booking-create-from-plan' for p, _ in self.h.calls))


if __name__ == '__main__':
    unittest.main()
