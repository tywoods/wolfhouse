"""Offline R7 regression: saved privacy is a Staff fact, not catalog inference."""
import json
import unittest
from copy import deepcopy
from unittest.mock import patch
from wolfhouse import accepted_quote as ledger
import wolfhouse_staff_api as plugin

CODE = 'WH-20270920-00516771'
PRIVACY = {'source': 'saved_booking', 'booking_code': CODE,
           'private_room_enabled': True, 'room_codes': ['R7'],
           'companion_blocks': [{'booking_code': 'PRV-20270920-58F441',
                                 'bed_codes': ['R7-B3', 'R7-B4']}],
           'staff_only_warnings': []}
URL = 'https://staff-staging.lunafrontdesk.com/pay/test-r7-private'
PLAN = {'check_in': '2027-09-20', 'check_out': '2027-09-27',
        'guests': [{'name': 'Guest One'}, {'name': 'Guest Two'}], 'language': 'en'}
OFFER = {'total_cents': 80000, 'deposit_required_cents': 40000,
         'room_type': 'shared', 'selected_room_description': 'mixed'}
RECEIPT = {'success': True, 'write_performed': True, 'booking_code': CODE,
           'room_privacy': PRIVACY, 'total_cents': 80000,
           'amount_due_cents': 40000, 'secure_payment_url': URL,
           'guest_rooms': [{'room_kind': 'shared', 'type': 'mixed',
                            'room_label': 'Room 7, mixed shared room', 'number': 'R7'}]}

class SavedPrivateRoomTests(unittest.TestCase):
    def test_create_bridge_retains_canonical_privacy_not_catalog(self):
        for body in ({'room_privacy': PRIVACY},
                     {'create_outcome': {'create_response': {'room_privacy': PRIVACY}}}):
            self.assertEqual(plugin._extract_booking_write_fields(body).get('room_privacy'), PRIVACY)

    def test_exact_r7_saved_private_fact_overrules_stale_shared_projection(self):
        facts = ledger._saved_confirmation_facts(PLAN, OFFER, RECEIPT)
        self.assertEqual(facts.get('room_type'), 'private')
        self.assertEqual(facts.get('room_privacy'), PRIVACY)
        self.assertNotIn('shared', json.dumps(facts.get('room')))
        self.assertEqual(facts['payment_links'], [URL])

    def test_shared_booking_is_not_made_private_by_catalog_or_quote(self):
        receipt = deepcopy(RECEIPT)
        receipt['room_privacy']['private_room_enabled'] = False
        receipt['room_privacy']['companion_blocks'] = []
        receipt['guest_rooms'][0].update(room_kind='private', room_label='Room 7, private room')
        facts = ledger._saved_confirmation_facts(PLAN, {**OFFER, 'room_type': 'private'}, receipt)
        self.assertEqual(facts.get('room_type'), 'shared')

    def test_no_canonical_saved_privacy_means_unknown_not_catalog_shared(self):
        receipt = deepcopy(RECEIPT)
        receipt.pop('room_privacy')
        facts = ledger._saved_confirmation_facts(PLAN, OFFER, receipt)
        self.assertNotIn('room_type', facts)

    def test_room_diagnostic_cannot_withhold_confirmation_or_payment(self):
        facts = ledger._saved_confirmation_facts(PLAN, OFFER, RECEIPT)
        facts['location_already_sent'] = True
        text = f'Booked {CODE}. Private room for Guest One and Guest Two. Total €800; deposit €400; remaining €400. {URL}'
        with patch.object(plugin, 'flag_needs_human') as flag:
            self.assertEqual(ledger._sendable_saved_confirmation(text, facts), text)
            flag.assert_not_called()

    def test_exact_r7_finalizer_delivers_confirmation_without_escalation(self):
        from wolfhouse.test_no_final_ask import NoFinalAskTests
        context = NoFinalAskTests()
        context.setUp()
        try:
            ledger._transaction(lambda state, ingress: state.update(
                plan=deepcopy(PLAN), checked_offer=deepcopy(OFFER),
                completion=deepcopy(RECEIPT)))
            text = f'Booked {CODE}. Private room. Total €800; deposit €400; remaining €400. {URL}'
            result = {'completed': True, 'final_response': text,
                      'messages': [{'role': 'user', 'content': 'Deposit please'},
                                   {'role': 'assistant', 'content': text}]}
            with patch.object(plugin, 'flag_needs_human') as flag, \
                    patch.object(plugin, '_post_bot', return_value={}) as post:
                output = ledger.finalize_offer_response(
                    result, saved_booking_projection=deepcopy(RECEIPT),
                    rewrite_callback=lambda *args: self.fail('Room mismatch triggered rewrite'))
            self.assertEqual(output['final_response'], text)
            self.assertFalse(output.get('confirmation_withheld'))
            flag.assert_not_called()
            self.assertFalse(any(call.args[0] == '/conversation/needs-human' for call in post.call_args_list))
        finally:
            context.tearDown()

    def test_room_review_reason_never_persists_needs_human(self):
        with patch.object(plugin, '_post_bot') as post:
            result = json.loads(plugin.flag_needs_human({'reason': 'post_save_room_check: R7 private label mismatch'}))
        self.assertFalse(result.get('needs_human'))
        self.assertTrue(result.get('do_not_escalate'))
        post.assert_not_called()

if __name__ == '__main__':
    unittest.main()
