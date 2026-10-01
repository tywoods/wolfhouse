"""Actual directory plugin registration/urllib boundary; no network or service storage."""
import asyncio
import contextvars
import importlib.util
import json
import os
from pathlib import Path
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch
from wolfhouse import crowsnest_guest_door as door

class RegisteredTransport(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        path = Path(__file__).resolve().parents[1] / 'plugins/wolfhouse_staff_api/__init__.py'
        spec = importlib.util.spec_from_file_location('pass4_staff_api', path, submodule_search_locations=[str(path.parent)])
        self.plugin = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.plugin)
        self.alias = self.plugin._post_bot
        self.calls = []
        class Response:
            def __enter__(self): return self
            def __exit__(self, *a): pass
            def read(self): return b'{"success":true,"bookings":[],"has_enough_beds":true}'
        def transport(req, **kwargs):
            self.calls.append((req.full_url, json.loads(req.data)))
            return Response()
        self.env = patch.dict(os.environ, {'LUNA_CLIENT_SLUG':'wolfhouse-somo','LUNA_BOT_INTERNAL_TOKEN':'offline-token','LUNA_ALLOWED_LOCATION_IDS':''})
        self.env.start()
        self.network = patch('urllib.request.urlopen', transport); self.network.start()
        self.tools = {}
        self.plugin.register(SimpleNamespace(register_tool=lambda **kw: self.tools.update({kw['name']:kw['handler']})))
        class Adapter:
            async def send(self, *a, **k): raise AssertionError('external send')
        self.wa = SimpleNamespace(WhatsAppCloudAdapter=Adapter)
        door.install_request_owned_guards(self.plugin, self.wa)
        owner = door._GOLDEN_REQUEST.set(door._GOLDEN_OWNER)
        self.scope = door.CrowsnestGuestScope.create('+999123456789012')
        door._GOLDEN_REQUEST.reset(owner)
    async def asyncTearDown(self):
        self.network.stop(); self.env.stop()
    def invoke(self): return json.loads(self.tools['list_my_bookings']({'phone':'+491234567890'}))
    async def test_empty_context_callback_registered_staff_and_child_fences(self):
        for api in ('call_soon', 'call_later', 'call_at'):
            thread = 'sim:golden-registered-callback-' + api.replace('_', '-')
            synthetic = door.golden_scope(thread)
            release = asyncio.Event()
            children = []
            observed = []
            async def child():
                observed.append(door.current_crowsnest_scope())
                self.invoke()
                await release.wait()
            def callback():
                observed.append(door.current_crowsnest_scope())
                self.invoke()
                children.append(asyncio.create_task(child(), context=contextvars.Context()))
            async def handler(event):
                scope = door.current_crowsnest_scope()
                observed.append(scope)
                loop = asyncio.get_running_loop()
                args = (callback,) if api == 'call_soon' else ((.01 if api == 'call_later' else loop.time() + .01), callback)
                getattr(loop, api)(*args, context=contextvars.Context())
                return 'reply'
            async def mirror(**kwargs): pass
            owner = door._GOLDEN_REQUEST.set(door._GOLDEN_OWNER)
            try:
                result = await door.run_crowsnest_guest_turn(runner=SimpleNamespace(_handle_message=handler), phone=synthetic.synthetic_phone, text='hello', mirror=mirror)
            finally: door._GOLDEN_REQUEST.reset(owner)
            self.assertTrue(result['ok'])
            self.invoke()  # ordinary positive while scoped deferred work is live
            ordinary_count = len(self.calls)
            with self.assertRaisesRegex(RuntimeError, 'late_worker'):
                await door.cleanup_golden_thread(thread)
            denied = await door.run_crowsnest_guest_turn(runner=SimpleNamespace(_handle_message=handler), phone=synthetic.synthetic_phone, text='next', mirror=mirror)
            self.assertEqual(denied['error'], 'session_tainted_by_late_worker')
            for _ in range(100):
                if len(observed) == 3: break
                await asyncio.sleep(.001)
            try:
                self.assertEqual(len(observed), 3)
                self.assertTrue(observed[0].revoked)
                self.assertIs(observed[1], observed[0])
                self.assertIs(observed[2], observed[0])
                self.assertEqual(len(self.calls), ordinary_count)
            finally:
                release.set()
                await asyncio.gather(*children)
                for _ in range(10): await asyncio.sleep(0)
            self.assertNotIn(synthetic.session_key, door._TAINTED_SESSIONS)

    async def test_stripped_executor_ownership_and_ordinary_reuse(self):
        with ThreadPoolExecutor(max_workers=1) as pool:
            token = door._SCOPE.set(self.scope)
            try:
                await asyncio.wrap_future(pool.submit(lambda: contextvars.Context().run(self.invoke)))
            finally: door._SCOPE.reset(token)
            self.assertEqual(self.calls, [], 'context-stripped golden must not reach transport')
            await asyncio.wrap_future(pool.submit(self.invoke))
            self.assertEqual(len(self.calls), 1, 'ordinary reused worker remains positive')
    async def test_stripped_task_and_concurrent_ordinary(self):
        token = door._SCOPE.set(self.scope)
        try:
            async def golden():
                self.invoke()
                result = await self.wa.WhatsAppCloudAdapter().send('+49' + '1234567890', 'stripped reply')
                self.assertTrue(result.raw_response['whatsapp_suppressed'])
            task = asyncio.create_task(golden(), context=contextvars.Context())
        finally: door._SCOPE.reset(token)
        self.invoke()
        await task
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][1]['phone'], '+491234567890')
    async def test_real_event_runner_exception_and_cancellation_restore_owners(self):
        for mode in ('exception', 'cancel'):
            with self.subTest(mode=mode):
                entered = asyncio.Event()
                async def handler(event):
                    self.assertTrue(event.source.chat_id.startswith('crowsnest-sim:'))
                    self.assertTrue(event.metadata['crowsnest_simulator'])
                    self.invoke()
                    entered.set()
                    if mode == 'exception': raise RuntimeError('handler failed')
                    await asyncio.Event().wait()
                async def live(**kwargs):
                    return await door.run_crowsnest_guest_turn(runner=SimpleNamespace(_handle_message=handler), **kwargs)
                with patch.object(door, 'run_live_crowsnest_guest_turn', live):
                    task = asyncio.create_task(door.run_golden_guest_turn(thread='sim:golden-owner-' + mode, text='hello'))
                    await asyncio.wait_for(entered.wait(), 2)
                    if mode == 'cancel':
                        task.cancel()
                        with self.assertRaises(asyncio.CancelledError): await task
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'handler failed'): await task
                await asyncio.sleep(0)
                self.assertIsNone(door._SCOPE.get())
                self.assertIsNone(door._GOLDEN_REQUEST.get())
                self.assertEqual(self.calls, [])

    async def test_missing_installed_guard_and_alternate_module_alias(self):
        path = Path(self.plugin.__file__)
        spec = importlib.util.spec_from_file_location('pass4_alternate_staff_api', path, submodule_search_locations=[str(path.parent)])
        alternate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(alternate)
        token = door._SCOPE.set(self.scope)
        try:
            alternate._post_bot('availability-check', {})
            self.plugin._post_bot = self.alias  # simulate absent installed attribute guard
            self.invoke()
        finally: door._SCOPE.reset(token)
        self.assertEqual(self.calls, [])
        self.invoke()
        self.assertEqual(len(self.calls), 1)

    async def test_prebound_alias_and_missing_guard(self):
        token = door._SCOPE.set(self.scope)
        try:
            self.alias('availability-check', {})
        finally: door._SCOPE.reset(token)
        self.assertEqual(self.calls, [])
    async def test_revoked_worker(self):
        self.scope.revoked = True
        token = door._SCOPE.set(self.scope)
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                await asyncio.wrap_future(pool.submit(lambda: contextvars.Context().run(self.invoke)))
        finally: door._SCOPE.reset(token)
        self.assertEqual(self.calls, [])
    async def test_unsafe_reads_and_identifiers_denied(self):
        token = door._SCOPE.set(self.scope)
        try:
            for route in ('payments/status','booking-guests/payment-status','surf-report','catalog','bookings/by-phone'):
                self.plugin._post_bot(route, {'booking_id':'foreign','phone':'+491234567890'})
            for payload in ({'booking_id':'foreign'}, {'nested':{'paymentId':'foreign'}}, {'guest_phone':{'value':'+491234567890'}}):
                self.plugin._post_bot('booking-preview', payload)
        finally: door._SCOPE.reset(token)
        self.assertEqual(self.calls, [])
    async def test_safe_preview_identity_and_ordinary_positive(self):
        token = door._SCOPE.set(self.scope)
        try: self.plugin._post_bot('booking-preview', {'phone':'+491234567890','check_in':'2026-10-01'})
        finally: door._SCOPE.reset(token)
        self.assertEqual(self.calls[0][1]['phone'], self.scope.inbox_phone)
        self.invoke()
        self.assertEqual(len(self.calls), 2)

if __name__ == '__main__': unittest.main()
