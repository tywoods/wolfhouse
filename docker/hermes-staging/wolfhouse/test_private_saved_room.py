"""Offline R7 regression: saved privacy is a Staff fact, not catalog inference."""
import asyncio
import json
import unittest
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import patch
from wolfhouse import accepted_quote as ledger
import wolfhouse_staff_api as plugin

CODE = 'WH-20270920-00516771'
PRIVACY = {'source': 'saved_booking', 'booking_code': CODE,
           'private_room_enabled': True, 'room_codes': ['R7'],
           'check_in': '2027-09-20', 'check_out': '2027-09-27',
           'persisted_flags': {'room_preference': 'couple_private',
                               'requested_room_type': 'double', 'private_room_enabled': True},
           'blocked_bed_codes': ['R7-B3', 'R7-B4'],
           'block_booking_codes': ['PRV-20270920-58F441'],
           'blocks': [{'booking_id': 'offline-prv-id',
                       'booking_code': 'PRV-20270920-58F441', 'room_code': 'R7',
                       'bed_code': bed, 'check_in': '2027-09-20', 'check_out': '2027-09-27'}
                      for bed in ('R7-B3', 'R7-B4')],
           'evidence_complete': True, 'diagnostics': []}
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

    def test_same_type_wrong_room_is_advisory_not_guest_fact(self):
        for row in (
                {'room_kind': 'private', 'number': 'R8', 'room_label': 'Room 8, private room'},
                {'room_name': 'Wrong room name', 'room_code': 'R8'},
                {'room_kind': 'private', 'number': 'R7', 'room_code': 'R8', 'room_label': 'Conflicting identity'}):
            with self.subTest(row=row):
                receipt = deepcopy(RECEIPT)
                receipt['guest_rooms'] = [row]
                receipt['booking_guests'] = [{'booking_guest_id': 'g1', 'guest_number': 1,
                                              'assigned_bed_code': 'R8-B1'}]
                receipt['per_person'] = [{'booking_guest_id': 'g1', 'package_code': 'none'}]
                receipt['room_arrangement'] = [{'bed_code': 'R8-B1', 'room_code': 'R8',
                                                'room_name': 'Wrong room fallback'}]
                facts = ledger._saved_confirmation_facts(PLAN, OFFER, receipt)
                self.assertEqual(facts['room'], [])
                self.assertTrue(facts.get('staff_only_room_warnings'))
                self.assertNotIn('room_label', facts['guest_presentations'][0])
                self.assertEqual(facts['payment_links'], [URL])
                self.assertEqual(facts['reference'], CODE)

    def test_canonical_room_preserves_configured_name(self):
        receipt = deepcopy(RECEIPT)
        receipt['guest_rooms'] = [{'number': 'R7', 'room_kind': 'private', 'room_label': 'Malibu'}]
        facts = ledger._saved_confirmation_facts(PLAN, OFFER, receipt)
        self.assertEqual(facts['room'], ['Malibu'])
        self.assertNotIn('staff_only_room_warnings', facts)

    def test_shared_booking_is_not_made_private_by_catalog_or_quote(self):
        receipt = deepcopy(RECEIPT)
        receipt['room_privacy']['private_room_enabled'] = False
        receipt['room_privacy'].update(blocks=[], blocked_bed_codes=[], block_booking_codes=[])
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

    def test_room_advisory_author_outage_keeps_existing_confirmation(self):
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
            attempts = []
            def unavailable(facts, draft):
                attempts.append(draft)
                raise RuntimeError('offline author unavailable')
            with patch.object(plugin, 'flag_needs_human') as flag, \
                    patch.object(plugin, '_post_bot', return_value={}) as post:
                output = ledger.finalize_offer_response(
                    result, saved_booking_projection=deepcopy(RECEIPT),
                    rewrite_callback=unavailable)
            self.assertEqual(attempts, [None])
            self.assertEqual(output['final_response'], text)
            self.assertFalse(output.get('confirmation_withheld'))
            flag.assert_not_called()
            self.assertFalse(any(call.args[0] == '/conversation/needs-human' for call in post.call_args_list))
        finally:
            context.tearDown()

    def test_explicit_room_review_sends_warm_note_then_persists_without_changing_save(self):
        from wolfhouse.test_no_final_ask import NoFinalAskTests
        from wolfhouse import explicit_human_handoff as handoff
        from wolfhouse_staff_api import handoff_guest_note
        context = NoFinalAskTests()
        context.setUp()
        try:
            ledger._transaction(lambda state, _: state.update(completion=deepcopy(RECEIPT)))
            timeline = []
            test = self
            reason = 'post_save_room_check: R7 private label mismatch'
            class Adapter:
                async def send(self, chat_id, content, **kwargs):
                    test.assertEqual(content, handoff_guest_note.default_guest_note('en', 'Ale'))
                    timeline.append('note')
                    return SimpleNamespace(success=True, message_id='offline-room-note', raw_response={})
            def persist(path, payload):
                self.assertEqual(path, '/conversation/needs-human')
                self.assertEqual(payload['reason'], reason)
                timeline.append('flag')
                return {'success': True, 'needs_human': True,
                        'staff_handoff': {'id': 'offline-room-review'}}
            async def dispatch(_event):
                result = json.loads(await asyncio.to_thread(plugin.flag_needs_human, {'reason': reason}))
                self.assertTrue(result['needs_human'], result)
                self.assertTrue(result['handoff_persisted'], result)
                self.assertTrue(result['ack_sent'], result)
            async def run():
                await handoff.dispatch_with_handoff_notice(
                    SimpleNamespace(source=SimpleNamespace(chat_id='+349****0981'), text='Please check my room'),
                    SimpleNamespace(adapter=Adapter(), dispatch_fn=dispatch))
            with patch.dict('os.environ', {'HERMES_ROLE': 'luna', 'WOLFHOUSE_STAFF_API_BASE_URL': 'https://offline.invalid'}), \
                 patch.object(plugin, '_post_bot', side_effect=persist), \
                 patch.object(handoff_guest_note, 'default_fetch_staff_info', return_value={'staff_member_name': 'Ale'}):
                ledger._transaction(lambda state, _: state.update(guest_language='en'))
                asyncio.run(run())
            self.assertEqual(timeline, ['note', 'flag'])
            self.assertEqual(ledger.current_create_receipt(), RECEIPT)
            self.assertEqual(ledger._saved_confirmation_facts(PLAN, OFFER, RECEIPT)['payment_links'], [URL])
        finally:
            context.tearDown()

    def test_advisory_payment_alarm_is_reauthored_without_handoff_or_withholding(self):
        from wolfhouse.test_no_final_ask import NoFinalAskTests
        context = NoFinalAskTests()
        context.setUp()
        try:
            ledger._transaction(lambda state, _: state.update(
                plan=deepcopy(PLAN), checked_offer=deepcopy(OFFER), completion=deepcopy(RECEIPT)))
            good = f'Booked {CODE}. Room 7, private room. Total €800; deposit €400; remaining €400. {URL}'
            bad = good + ' Please hold off paying while staff check the room.'
            authored = []
            def author(facts, draft):
                authored.append((deepcopy(facts), draft))
                self.assertIsNone(draft, 'Do not seed the author with the obsolete payment alarm')
                self.assertEqual(facts['payment_links'], [URL])
                self.assertTrue(facts['staff_only_room_warnings'])
                return good
            for recovery, wrong_room in ((False, False), (True, False), (True, True)):
                with self.subTest(recovery=recovery, wrong_room=wrong_room):
                    authored.clear()
                    receipt = deepcopy(RECEIPT)
                    if wrong_room:
                        receipt['guest_rooms'] = [{'room_kind': 'private', 'number': 'R8',
                                                   'room_label': 'Room 8, private room'}]
                        bad = bad.replace('Room 7', 'Room 8')
                    ledger._transaction(lambda state, _: state.update(completion=deepcopy(receipt)))
                    # Historical no-op receipt fixture exercises finalizer recovery;
                    # explicit flag calls now persist a handoff, never this advisory.
                    advisory = json.dumps({'tool': 'flag_needs_human',
                                           'saved_booking_preserved': True, 'needs_human': False,
                                           'fixture': 'historical_room_advisory_noop'})
                    result = {'completed': True, 'final_response': bad,
                              'messages': [{'role': 'user', 'content': 'Deposit please'},
                                           {'role': 'tool', 'content': advisory},
                                           {'role': 'assistant', 'content': bad}]}
                    with patch.object(plugin, 'flag_needs_human') as flag:
                        output = ledger.finalize_offer_response(
                            result, saved_booking_projection=deepcopy(receipt) if recovery else None,
                            rewrite_callback=author)
                    self.assertEqual(len(authored), 1)
                    self.assertEqual(output['final_response'], good)
                    self.assertIn(URL, output['final_response'])
                    self.assertFalse(output.get('confirmation_withheld'))
                    flag.assert_not_called()
        finally:
            context.tearDown()

    def test_exhausted_confirmation_author_never_calls_needs_human(self):
        from wolfhouse.test_no_final_ask import NoFinalAskTests
        context = NoFinalAskTests()
        context.setUp()
        try:
            ledger._transaction(lambda state, _: state.update(
                plan=deepcopy(PLAN), checked_offer=deepcopy(OFFER), completion=deepcopy(RECEIPT)))
            result = {'completed': True, 'final_response': 'bad draft', 'messages': []}
            with patch.object(plugin, 'flag_needs_human') as flag:
                output = ledger.finalize_offer_response(result, saved_booking_projection=deepcopy(RECEIPT),
                                                       rewrite_callback=lambda *_: None)
            flag.assert_not_called()
            saved = ledger._transaction(lambda state, _: deepcopy(state['completion']))
            self.assertEqual(saved, RECEIPT)
            self.assertEqual(output['confirmation_status']['booking_reference'], CODE)
        finally:
            context.tearDown()

if __name__ == '__main__':
    unittest.main()
