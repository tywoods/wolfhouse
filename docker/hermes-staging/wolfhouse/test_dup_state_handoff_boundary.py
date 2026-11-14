"""C27: registered recovery + real reopened SessionDB/Staff SQL, no live I/O.

Reuse F's offline Staff/PGlite fixture unchanged, not the C19 fixture. LLM and
HTTP edges are synthetic; booking receipts/rows come from actual Staff handlers.
Run with the pinned Hermes Python and NODE_PATH for the pinned PGlite dependency.
"""
import asyncio
import io
import json
import os
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import apply_gateway_patches as gateway_patches
from gateway.platforms.base import SendResult
from hermes_state import SessionDB
from wolfhouse import pause_gate
from wolfhouse import explicit_human_handoff as handoff
from wolfhouse import test_first_yes_persistence as ingress
from wolfhouse import test_serious_booking_persistence as sql_fixture
import wolfhouse_staff_api as api


class RecoveredSavedReceiptTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {
            'HERMES_ROLE': 'luna', 'LUNA_CLIENT_SLUG': 'wolfhouse-somo',
            'WOLFHOUSE_STAFF_API_BASE_URL': 'https://staff-staging.lunafrontdesk.com',
        }))
        # Install the production observer before normal plugin registration.
        self.enterContext(patch.object(api, 'create_booking_from_plan', api.create_booking_from_plan))
        self.assertTrue(handoff.install_booking_save_receipt_patch())
        self.case = sql_fixture.SeriousBookingPersistenceTests()
        self.case.addCleanup = self.addCleanup
        self.case.setUp()
        self.observed = []
        original = handoff.note_successful_booking_create
        def observe(raw):
            result = json.loads(raw) if isinstance(raw, str) else raw
            verified = api._successful_owner_booking_receipt()
            turn = handoff._ORDINARY_TURN.get()
            if turn is not None and result.get('success') is True and not result.get('write_performed'):
                for changed in ({'booking_id': 'foreign-booking'}, {'booking_code': 'foreign-code'},
                                {'success': False}, {'booking_id': None, 'booking_code': None,
                                                     'booking_exists': True, 'idempotent': True}):
                    self.assertFalse(original({**result, **changed}))
                    self.assertFalse(turn.booking_saved)
                with patch.object(api, '_successful_owner_booking_receipt', return_value=None):
                    self.assertFalse(original(result))
                with patch.object(api, '_successful_owner_booking_receipt', side_effect=RuntimeError('offline read failure')):
                    self.assertFalse(original(result), 'receipt-read failure is unknown, never a failed booking save')
                with patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'foreign-tenant'}):
                    self.assertFalse(original(result), 'wrong current tenant cannot verify this saved receipt')
                self.assertFalse(turn.booking_saved)
            recognized = original(raw)
            self.observed.append((result, verified, recognized))
            return recognized
        self.enterContext(patch.object(handoff, 'note_successful_booking_create', side_effect=observe))
        self.phone = ingress.PLAN['phone']
        self.event = SimpleNamespace(source=SimpleNamespace(chat_id=self.phone), text='yes')

    async def recover_saved_booking(self):
        await asyncio.to_thread(self.case.turn, 'Please quote this booking', 'c27-quote')
        self.assertTrue(self.case.quote_result['success'])
        created = await asyncio.to_thread(self.case.turn, 'yes', 'c27-original-save')
        self.assertTrue(created['booking_result']['success'])
        self.assertIs(created['booking_result']['write_performed'], True)
        before = self.case.rpc(snapshot=True)
        self.assertEqual(before['errors'], [])
        self.assertEqual(len(before['tables']['bookings']), 1)
        self.assertEqual(len(before['tables']['booking_guests']), 3)
        self.assertEqual(len(before['tables']['booking_beds']), 3)
        self.case.db.close()
        self.case.db = SessionDB(self.case.db_path)
        self.case.agent._session_db = self.case.db
        self.observed.clear()
        return before

    async def test_registered_recovered_receipt_is_saved_without_a_new_write(self):
        before = await self.recover_saved_booking()
        for delivered in (True, False):
            async def dispatch(_event):
                recovered = await asyncio.to_thread(self.case.turn, 'yes', 'c27-recovery-' + str(delivered))
                self.assertTrue(self.observed, 'registered recovery must reach the production observer')
                result, verified, recognized = self.observed[-1]
                self.assertTrue(result['success'], result)
                self.assertIs(result['write_performed'], False, result)
                self.assertIs(result['idempotent'], True, result)
                self.assertTrue(verified, 'current scoped owner must independently retain the saved receipt')
                saved = before['tables']['bookings'][0]
                self.assertEqual(result['booking_id'], saved['id'])
                self.assertEqual(verified['booking_id'], saved['id'])
                self.assertEqual(result['booking_code'], saved['booking_code'])
                self.assertTrue(recognized, 'verified booking exists despite no new write')
                self.assertTrue(handoff.is_saved_booking_turn(self.phone))
                self.assertIn(saved['booking_code'], recovered['final_response'])
                await self.exercise_send(recovered['final_response'], delivered)
                self.assertEqual(self.case.rpc(snapshot=True)['tables'], before['tables'])
                return recovered
            await handoff.dispatch_with_handoff_notice(self.event, SimpleNamespace(dispatch_fn=dispatch))
        snapshot = self.case.rpc(snapshot=True)
        self.assertEqual(sum(c['path'] == '/booking-create-from-plan' for c in snapshot['calls']), 1,
                         'both registered recoveries use the verified saved receipt, never another create')

    async def exercise_send(self, confirmation, delivered):
        # Synthetic pause/provider edges only. All receipt/booking facts above are real SQL.
        turn = handoff._ORDINARY_TURN.get()
        turn.requested, turn.handoff_pause_created = True, True
        turn.handoff_pause_id = 'c27-same-pause'
        disposition = dict(send_blocked=True, stage_as_draft=False,
                           reason='paused', whatsapp_channel_mode='auto')
        active = dict(success=True, global_paused=False, conversation_paused=True,
                      pause_state=dict(id=turn.handoff_pause_id, paused=True, paused_by='luna_flag_needs_human'))
        def http_gate(request, **_kwargs):
            self.assertTrue(request.full_url.endswith('/check-guest-automation-gate'))
            self.assertEqual(json.loads(request.data)['client_slug'], 'wolfhouse-somo')
            return io.BytesIO(json.dumps(active).encode())
        with patch.object(handoff.urllib.request, 'urlopen', side_effect=http_gate):
            self.assertFalse(handoff.allow_saved_booking_reply('foreign-phone', confirmation, disposition))
            self.assertFalse(handoff.allow_saved_booking_reply(self.phone, 'Not a confirmation', disposition))
            with patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'foreign-tenant'}):
                self.assertFalse(handoff.allow_saved_booking_reply(self.phone, confirmation, disposition))
            for changes in ({'stage_as_draft': True}, {'whatsapp_channel_mode': 'off'}, {'reason': 'manual_pause'}):
                self.assertFalse(handoff.allow_saved_booking_reply(self.phone, confirmation, {**disposition, **changes}))
            for key, bad in (('id', 'replacement-pause'), ('paused_by', 'staff_portal')):
                good = active['pause_state'][key]
                active['pause_state'][key] = bad
                self.assertFalse(handoff.allow_saved_booking_reply(self.phone, confirmation, disposition))
                active['pause_state'][key] = good
            active['global_paused'] = True
            self.assertFalse(handoff.allow_saved_booking_reply(self.phone, confirmation, disposition))
            active['global_paused'] = False
            with patch.object(handoff.urllib.request, 'urlopen', side_effect=OSError('offline gate read failure')):
                self.assertFalse(handoff.allow_saved_booking_reply(self.phone, confirmation, disposition))
            provider = AsyncMock(return_value=SendResult(success=delivered,
                message_id='offline-provider-receipt' if delivered else None,
                error=None if delivered else 'offline-provider-failure'))
            flags = []
            def flag(payload):
                flags.append(payload)
                return {'success': False, 'needs_human': False}  # labelled Staff-alert failure edge
            with patch.dict(os.environ, {'WHATSAPP_DRY_RUN': 'false', 'LUNA_AUTO_SEND_ENABLED': 'true'}), \
                    patch.object(pause_gate, 'whatsapp_outbound_disposition', return_value=disposition), \
                    patch.object(gateway_patches, '_orig_whatsapp_cloud_send', provider, create=True), \
                    patch.object(handoff, '_load_flag_needs_human', return_value=flag):
                sent = await gateway_patches._patched_whatsapp_cloud_send(None, self.phone, confirmation,
                    metadata={'wolfhouse_guest_reply': True})
            provider.assert_awaited_once()
            self.assertEqual(sent.success, delivered)
            self.assertTrue(turn.booking_saved, 'delivery failure cannot erase durable booking truth')
            self.assertTrue(turn.saved_reply_exception_consumed)
            self.assertFalse(handoff.allow_saved_booking_reply(self.phone, confirmation, disposition))
            if not delivered:
                self.assertEqual(len(flags), 1)
                self.assertEqual(flags[0]['booking_code'], turn.booking_reference)
                self.assertIs(sent.raw_response['needs_human_flagged'], False)



if __name__ == '__main__':
    unittest.main()
