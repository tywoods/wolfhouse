"""Offline simulator regressions using the real flag tool and ordinary owner.

Only Staff transport, the adapter's external transport and Inbox mirror are fake.
No model, Meta, Staff HTTP or other network calls are allowed.
"""
import asyncio
import json
import os
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from gateway.config import Platform
import wolfhouse_staff_api as plugin
from wolfhouse import crowsnest_guest_door as door
from wolfhouse import explicit_human_handoff as handoff
from wolfhouse_staff_api.handoff_guest_note import WARM_NOTES
from wolfhouse_staff_api import handoff_guest_note as notes

WARM_NOTE = WARM_NOTES['en']
GENERIC_FINAL = 'There was a technical issue. Please try again.'
ENV = {
    'HERMES_ROLE': 'luna', 'LUNA_TENANT_ID': 'wolfhouse-somo',
    'LUNA_CLIENT_SLUG': 'wolfhouse-somo',
    'WOLFHOUSE_STAFF_API_BASE_URL': 'https://staff-staging.lunafrontdesk.com',
    'PUBLIC_PAYMENT_BASE_URL': 'https://staff-staging.lunafrontdesk.com',
    'BOT_BOOKING_ENABLED': 'true', 'WOLFHOUSE_STRIPE_MODE': 'test',
    'STRIPE_SECRET_KEY': '',
}


class CrowsnestHandoffTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.enterContext(patch.dict(os.environ, ENV))
        self.enterContext(patch('urllib.request.urlopen', side_effect=AssertionError('network forbidden')))
        self.meta, self.posts, self.mirrors, self.flags = [], [], [], []
        self.state = {'needs_human': False}
        self.scope = None
        self.event = None
        test = self

        class Adapter:
            async def send(self, chat_id, content, reply_to=None, metadata=None):
                test.meta.append((chat_id, content))
                raise AssertionError('simulator must not reach Meta')

        self.adapter = Adapter()
        self.enterContext(patch.object(plugin, '_post_bot', self.staff))
        # Restore the phone wrappers too: installation is permanent in production
        # but these tests supply a fresh fake transport boundary per case.
        self.enterContext(patch.object(plugin, '_session_guest_phone', plugin._session_guest_phone))
        self.enterContext(patch.object(plugin, '_live_turn_guest_phone', plugin._live_turn_guest_phone))
        door.install_request_owned_guards(plugin, SimpleNamespace(WhatsAppCloudAdapter=Adapter))

    def staff(self, path, payload, **kwargs):
        self.posts.append((path, dict(payload)))
        self.assertEqual(payload['phone'], self.scope.inbox_phone)
        if path == '/staff/bot/booking-create-from-plan':
            return {'success': False, 'error': 'offline persistent booking database failure'}
        self.assertEqual(path, '/staff/bot/conversation/needs-human')
        # The note is captured before the actual persistence boundary.
        self.assertEqual(self.scope.reply_text, WARM_NOTE)
        self.state['needs_human'] = True
        return {'success': True, 'needs_human': True, 'conversation_paused': True,
                'staff_handoff': {'id': 'offline-staff-review'}}

    async def mirror(self, *, direction, phone, text, scope):
        self.mirrors.append((direction, text))
        return {'success': True, 'thread_message': {'persisted': True}}

    async def flag(self, reason='booking_create_failure_limit'):
        result = json.loads(await asyncio.to_thread(plugin.flag_needs_human, {
            'reason': reason, 'guest_note': WARM_NOTE,
            # Model identity must never displace the trusted simulator Inbox.
            'phone': '+34600999888', 'conversation_id': 'untrusted-model-id',
        }))
        self.flags.append(result)
        return result

    def runner(self, handler):
        async def dispatch(event):
            self.event = event
            self.scope = door.current_crowsnest_scope()
            self.assertEqual(event.source.chat_id, self.scope.session_key)
            self.assertTrue(event.source.chat_id.startswith('crowsnest-sim:'))
            self.assertEqual(handoff.ordinary_handoff_phone(), self.scope.inbox_phone)
            self.assertIs(handoff._ORDINARY_TURN.get().adapter, self.adapter)
            return await handler(event)
        return SimpleNamespace(adapters={Platform.WHATSAPP_CLOUD: self.adapter}, _handle_message=dispatch)

    async def run_turn(self, handler, **kwargs):
        return await door.run_crowsnest_guest_turn(
            runner=self.runner(handler), phone='+34600111222', text='Please save my booking',
            mirror=self.mirror, timeout_sec=2, **kwargs)

    async def test_persistent_save_failure_captures_warm_note_and_persists_needs_human(self):
        async def handler(event):
            # Real simulator Staff guard forwards failed saves to fake Staff;
            # the production flag tool and ordinary owner handle the escalation.
            for _ in range(2):
                result = await asyncio.to_thread(plugin._post_bot, '/booking-create-from-plan', {
                    'phone': self.scope.inbox_phone,
                })
                self.assertFalse(result['success'])
            self.assertTrue((await self.flag())['handoff_persisted'])
            self.assertTrue((await self.flag())['handoff_persisted'])
            for destination in (event.source.chat_id, self.scope.inbox_phone):
                receipt = await self.adapter.send(destination, GENERIC_FINAL)
                self.assertTrue(receipt.raw_response['suppressed_handoff_or_revoked'])
                self.assertEqual(self.scope.reply_text, WARM_NOTE)
            # Runner return values must not bypass the guarded adapter capture.
            return GENERIC_FINAL

        result = await self.run_turn(handler)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['reply_text'], WARM_NOTE)
        self.assertTrue(self.state['needs_human'])
        self.assertEqual([path for path, _ in self.posts], [
            '/staff/bot/booking-create-from-plan', '/staff/bot/booking-create-from-plan',
            '/staff/bot/conversation/needs-human'])
        self.assertTrue(all(flag['ack_sent'] and flag['conversation_paused'] for flag in self.flags))
        self.assertEqual(self.mirrors[-1], ('outbound', WARM_NOTE))
        self.assertNotIn(self.scope.session_key, door._PENDING_SIM_REPLIES)
        self.assertEqual(result['transport_calls'], 0)
        self.assertEqual(self.meta, [])
        self.assertIsNone(handoff._ORDINARY_TURN.get())

    async def test_final_response_standard_note_persists_before_simulator_mirror(self):
        """bf3c2150-shaped turn: final note, no flag tool invocation."""
        expected = notes.default_guest_note('en', 'Camila')
        boundaries = []

        def staff(path, payload, **kwargs):
            self.assertEqual(path, '/staff/bot/conversation/needs-human')
            self.assertEqual(payload['phone'], self.scope.inbox_phone)
            self.assertEqual(self.scope.reply_text, expected, 'capture note before flag')
            boundaries.append('flag')
            self.state['needs_human'] = True
            return {'success': True, 'needs_human': True,
                    'staff_handoff': {'id': 'offline-final-handoff'}}

        async def mirror(**kwargs):
            if kwargs['direction'] == 'outbound':
                boundaries.append('mirror')
                self.assertTrue(self.state['needs_human'], 'note must not escape unflagged')
            return await self.mirror(**kwargs)

        async def handler(event):
            return expected

        with patch.object(notes, 'default_fetch_staff_info', return_value={'staff_member_name': 'Camila'}), \
                patch.object(plugin, '_post_bot', new=staff):
            # Reinstall the real simulator guards around our fake Staff boundary.
            door.install_request_owned_guards(plugin, SimpleNamespace(WhatsAppCloudAdapter=type(self.adapter)))
            result = await door.run_crowsnest_guest_turn(
                runner=self.runner(handler), phone='+34600001222', text='deposit',
                mirror=mirror, timeout_sec=2)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['reply_text'], expected)
        self.assertEqual(boundaries, ['flag', 'mirror'])
        self.assertEqual(self.meta, [])
        self.assertEqual(result['transport_calls'], 0)

    async def test_generic_model_authored_handoff_note_keeps_existing_path(self):
        async def handler(event):
            await self.flag('human_requested')
            return ''
        result = await self.run_turn(handler)
        self.assertEqual(result['reply_text'], WARM_NOTE)
        self.assertTrue(self.state['needs_human'])
        self.assertEqual(self.meta, [])

    async def test_cancellation_does_not_reopen_note_or_staff_authority(self):
        for persist_first in (False, True):
            with self.subTest(persist_first=persist_first):
                started, release, settled = asyncio.Event(), asyncio.Event(), asyncio.Event()
                self.posts.clear()
                self.mirrors.clear()
                self.state['needs_human'] = False
                late_results = []

                async def handler(event):
                    if persist_first:
                        await self.flag()
                    started.set()
                    try:
                        await release.wait()
                    except asyncio.CancelledError:
                        await release.wait()  # emulate a hostile late worker
                    try:
                        late = await self.flag('business_tool_error: booking save failed')
                        late_results.append(late)
                        # Revocation is strict even with the acknowledgement context.
                        token = handoff._SENDING_ACK.set(True)
                        try:
                            await self.adapter.send(event.source.chat_id, 'late acknowledgement')
                        finally:
                            handoff._SENDING_ACK.reset(token)
                        return GENERIC_FINAL
                    finally:
                        settled.set()

                task = asyncio.create_task(self.run_turn(handler))
                await asyncio.wait_for(started.wait(), 2)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertTrue(self.scope.revoked)
                release.set()
                await asyncio.wait_for(settled.wait(), 2)
                # Let task completion callbacks clear the lifetime fence.
                await asyncio.sleep(0)
                self.assertEqual(len(late_results), 1)
                self.assertFalse(late_results[0]['needs_human'])
                self.assertEqual(late_results[0]['error'], 'handoff_scope_closed')
                self.assertEqual(self.scope.reply_text, WARM_NOTE if persist_first else '')
                self.assertEqual(len(self.posts), int(persist_first))
                self.assertEqual(self.state['needs_human'], persist_first)
                self.assertEqual([direction for direction, _ in self.mirrors], ['inbound'])
                self.assertNotIn(self.scope.session_key, door._PENDING_SIM_REPLIES)
                self.assertEqual(self.meta, [])

    async def test_timeout_closes_ordinary_owner_before_late_flag(self):
        late_results = []
        settled = asyncio.Event()

        async def handler(event):
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                late_results.append(await self.flag())
                await self.adapter.send(event.source.chat_id, GENERIC_FINAL)
                settled.set()
                return GENERIC_FINAL

        result = await door.run_crowsnest_guest_turn(
            runner=self.runner(handler), phone='+34' + '600111224', text='Please save my booking',
            mirror=self.mirror, timeout_sec=0.01, late_settle_sec=0)
        await asyncio.wait_for(settled.wait(), 2)
        self.assertEqual(result['error'], 'turn_timeout')
        self.assertTrue(self.scope.revoked)
        self.assertEqual(late_results[0]['error'], 'handoff_scope_closed')
        self.assertEqual(self.scope.reply_text, '')
        self.assertFalse(self.state['needs_human'])
        self.assertEqual(self.posts, [])
        self.assertEqual(self.meta, [])
        self.assertEqual([direction for direction, _ in self.mirrors], ['inbound'])

    async def test_runner_without_adapter_retains_compatibility(self):
        async def handle(event):
            self.assertIsNone(handoff._ORDINARY_TURN.get())
            return 'ordinary simulator response'
        result = await door.run_crowsnest_guest_turn(
            runner=SimpleNamespace(_handle_message=handle), phone='+34600111223', text='Hello',
            mirror=self.mirror)
        self.assertEqual(result['reply_text'], 'ordinary simulator response')
        self.assertEqual(self.meta, [])


if __name__ == '__main__':
    unittest.main()
