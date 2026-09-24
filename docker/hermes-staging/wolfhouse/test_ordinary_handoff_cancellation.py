"""Offline regression for the real installed adapter's cancellation cleanup.

Prerequisite: Hermes source and dependencies installed at /opt/hermes. Run in a
fresh process (other offline suites install gateway stubs in sys.modules):
  /opt/hermes/.venv/bin/python3 -B -m unittest discover \
      -s docker/hermes-staging/wolfhouse -p test_ordinary_handoff_cancellation.py -v
Missing dependencies or substituted adapter classes are errors, never skips.
Only model/provider/Staff/hook boundaries are injected; no gateway emission is
installed or validated by this test. All outbound network attempts are denied.
"""
import asyncio
import contextvars
import functools
import inspect
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HERMES = Path('/opt/hermes')
sys.path[:0] = [str(ROOT), str(ROOT / 'plugins'), str(HERMES)]
NETWORK_ATTEMPTS = []


def deny_network(event, args):
    if event in {'socket.connect', 'socket.getaddrinfo', 'socket.sendto', 'urllib.Request'}:
        NETWORK_ATTEMPTS.append(event)
        raise RuntimeError('Network forbidden by cancellation regression: ' + event)


sys.addaudithook(deny_network)
try:
    from gateway.platforms.whatsapp_cloud import WhatsAppCloudAdapter
    from gateway.platforms.base import BasePlatformAdapter, MessageEvent, SendResult
    from gateway.session import SessionSource
    from gateway.config import PlatformConfig, Platform
except ImportError as exc:
    raise RuntimeError(
        'Real-adapter test prerequisite missing: use /opt/hermes/.venv/bin/python3 '
        'with the installed Hermes dependencies; no fake adapter fallback is allowed'
    ) from exc

import apply_gateway_patches as gw
import wolfhouse_staff_api as plugin
from wolfhouse import explicit_human_handoff as handoff, pause_gate

TENANTS = (
    ('wolfhouse-somo', 'luna', 'https://staff-staging.lunafrontdesk.com'),
    ('sunset', 'sunset-luna', 'https://sunset-staging.lunafrontdesk.com'),
)


class RealAdapterCancellationTests(unittest.TestCase):
    def setUp(self):
        for cls, relative in (
            (WhatsAppCloudAdapter, 'gateway/platforms/whatsapp_cloud.py'),
            (BasePlatformAdapter, 'gateway/platforms/base.py'),
            (MessageEvent, 'gateway/platforms/base.py'),
            (SessionSource, 'gateway/session.py'),
        ):
            self.assertEqual(Path(inspect.getfile(cls)).resolve(), HERMES / relative,
                             'Real installed Hermes classes required; run this suite separately')
        self.assertIs(WhatsAppCloudAdapter._process_message_background,
                      BasePlatformAdapter._process_message_background)
        self.assertIs(WhatsAppCloudAdapter.handle_message, BasePlatformAdapter.handle_message)

    async def scenario(self, tenant, *, cancel):
        adapter = WhatsAppCloudAdapter(PlatformConfig(enabled=True))
        source = SessionSource(platform=Platform.WHATSAPP,
                               chat_id='34900000001', user_id='34900000001')
        event = MessageEvent(text='There is an urgent safety problem', source=source,
                             message_id='offline-cancellation-regression')
        ack_started, ack_release, cleanup_started, cleanup_release, enter, begin = (
            asyncio.Event() for _ in range(6))
        timeline, flags, workers, send_results = [], [], [], []

        async def provider(_adapter, phone, content, **kwargs):
            self.assertEqual(phone, source.chat_id)
            timeline.append('ack_send')
            if cancel:
                ack_started.set()
                await ack_release.wait()
            return SendResult(success=True, message_id='offline-receipt')

        async def send(_adapter, *args, **kwargs):
            result = await gw._patched_whatsapp_cloud_send(_adapter, *args, **kwargs)
            send_results.append(result)
            return result

        def post(path, payload):
            self.assertEqual(path, '/conversation/needs-human')
            self.assertEqual(handoff._digits(payload['phone']), source.chat_id)
            self.assertNotIn('conversation_id', payload)
            self.assertNotIn('client_slug', payload)
            timeline.append('persist')
            return {'success': True, 'needs_human': True}

        def worker():
            flags.append(json.loads(plugin.flag_needs_human({
                'reason': 'urgent_safety', 'phone': '34999999999',
                'client_slug': 'other', 'conversation_id': 'other',
            })))

        async def handler(evt):
            self.assertIs(evt, event)
            enter.set()
            await begin.wait()
            # Raw executor with the production submission's context-copy boundary.
            future = asyncio.get_running_loop().run_in_executor(
                None, functools.partial(contextvars.copy_context().run, worker))
            workers.append(future)
            await asyncio.shield(future)
            return 'A teammate will take over.'

        async def hook(name, *args):
            if cancel and name == 'on_processing_complete':
                timeline.append('cancellation_cleanup')
                cleanup_started.set()
                await cleanup_release.wait()

        async def no_io(*args, **kwargs):
            pass

        adapter._message_handler = handler
        adapter._run_processing_hook = hook
        adapter.send_typing = no_io
        adapter.stop_typing = no_io
        ingress = WhatsAppCloudAdapter.handle_message
        with patch.object(WhatsAppCloudAdapter, '_process_message_background',
                          BasePlatformAdapter._process_message_background), \
             patch.object(WhatsAppCloudAdapter, '_wolfhouse_ordinary_handoff', False, create=True), \
             patch.object(WhatsAppCloudAdapter, 'send', send), \
             patch.object(gw, '_orig_whatsapp_cloud_send', provider, create=True), \
             patch.object(plugin, '_post_bot', post), \
             patch.object(plugin, '_session_guest_phone', return_value='34888888888'), \
             patch.object(pause_gate, 'whatsapp_outbound_disposition', return_value={}):
            self.assertTrue(handoff.install_ordinary_handoff_patch())
            installed = WhatsAppCloudAdapter._process_message_background
            self.assertTrue(handoff.install_ordinary_handoff_patch())
            self.assertIs(WhatsAppCloudAdapter._process_message_background, installed)
            self.assertIs(WhatsAppCloudAdapter.handle_message, ingress)
            await asyncio.wait_for(adapter.handle_message(event), 1)
            tasks = list(adapter._background_tasks)
            self.assertEqual(len(tasks), 1)
            task = tasks[0]
            try:
                self.assertFalse(task.done(), 'handle_message must not await model work')
                self.assertEqual(workers, [])
                await asyncio.wait_for(enter.wait(), 1)
                begin.set()
                if cancel:
                    await asyncio.wait_for(ack_started.wait(), 2)
                    self.assertTrue(task.cancel())
                    await asyncio.wait_for(cleanup_started.wait(), 2)
                    self.assertGreater(task.cancelling(), 0)
                    self.assertFalse(task.done())
                    # Real BasePlatformAdapter has caught cancellation but cannot
                    # reach the notice wrapper's finally until this hook returns.
                    ack_release.set()
                    await asyncio.wait_for(asyncio.shield(workers[0]), 2)
                    self.assertFalse(task.done(), 'receipt must settle DURING cleanup')
                    print(json.dumps({'tenant': tenant, 'cancel': cancel,
                                      'timeline': timeline, 'flags': flags}), flush=True)
                    self.assertEqual(timeline, ['ack_send', 'cancellation_cleanup'],
                                     'Late receipt must not authorize persistence during cleanup')
                    self.assertEqual(len(flags), 1)
                    self.assertFalse(flags[0]['success'])
                    self.assertFalse(flags[0]['needs_human'])
                    self.assertEqual(flags[0]['error'], 'handoff_scope_closed')
                    self.assertTrue(flags[0]['ack_sent'], 'late provider receipt remains truthful')
                    self.assertFalse(flags[0]['ack_send_failed'])
                    self.assertTrue(flags[0]['needs_operator_reconciliation'])
                    self.assertTrue(flags[0]['local_fail_closed'])
                    self.assertTrue(handoff.is_local_automation_blocked(source.chat_id))
                    self.assertEqual(len(send_results), 1, 'no duplicate final or correction send')
                    self.assertEqual(send_results[0].message_id, 'offline-receipt')
                    cleanup_release.set()
                    with self.assertRaises(asyncio.CancelledError):
                        await asyncio.wait_for(asyncio.shield(task), 2)
                    self.assertTrue(task.cancelled(), 'cancellation must still propagate')
                else:
                    await asyncio.wait_for(asyncio.shield(task), 3)
                    print(json.dumps({'tenant': tenant, 'cancel': cancel,
                                      'timeline': timeline, 'flags': flags}), flush=True)
                    self.assertEqual(timeline, ['ack_send', 'persist'])
                    self.assertTrue(flags[0]['success'])
                    self.assertTrue(flags[0]['ack_sent'])
                    self.assertFalse(flags[0]['needs_operator_reconciliation'])
                    self.assertFalse(handoff.is_local_automation_blocked(source.chat_id))
                    self.assertEqual(len(send_results), 2)
                    self.assertIsNone(send_results[-1].message_id)
                    self.assertTrue(send_results[-1].raw_response['suppressed_handoff_duplicate'])
                self.assertFalse(adapter._active_sessions, 'real cleanup releases session guard')
                self.assertFalse(adapter._session_tasks)
            finally:
                begin.set()
                ack_release.set()
                cleanup_release.set()
                if not task.done() and not task.cancelling():
                    task.cancel()
                await asyncio.wait_for(asyncio.gather(task, *workers, return_exceptions=True), 3)

    def run_tenants(self, *, cancel):
        for tenant, role, origin in TENANTS:
            with self.subTest(tenant=tenant), patch.dict(os.environ, {
                'LUNA_CLIENT_SLUG': tenant, 'HERMES_ROLE': role,
                'WOLFHOUSE_STAFF_API_BASE_URL': origin, 'LUNA_AUTO_SEND_ENABLED': 'true',
                'WHATSAPP_DRY_RUN': 'false', 'SUNSET_INGRESS_LOCATION_ID': 'sunset-somo',
                'HERMES_HUMAN_DELAY_MODE': 'off',
            }), patch.object(handoff, '_LOCAL_AUTOMATION_BLOCKED', set()):
                asyncio.run(self.scenario(tenant, cancel=cancel))
                self.assertEqual(NETWORK_ATTEMPTS, [], 'no external I/O is permitted')

    def test_normal_control_preserves_async_ingress_and_notice_before_persist(self):
        self.run_tenants(cancel=False)

    def test_late_receipt_during_real_cancellation_cleanup_cannot_persist(self):
        self.run_tenants(cancel=True)


if __name__ == '__main__':
    unittest.main()
