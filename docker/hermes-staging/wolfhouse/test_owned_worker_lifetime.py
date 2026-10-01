"""Real blocked executor lifetime regressions; no external transports."""
import asyncio
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch
from wolfhouse import crowsnest_guest_door as door

class OwnedLifetime(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, mode):
        class Adapter:
            async def send(self, *args, **kwargs):
                raise AssertionError('external transport')
        staff = SimpleNamespace(_post_bot=lambda *a, **k: {'ok': True})
        door.install_request_owned_guards(staff, SimpleNamespace(WhatsAppCloudAdapter=Adapter))
        entered, release, settled = threading.Event(), threading.Event(), threading.Event()
        pool = ThreadPoolExecutor(max_workers=1)
        thread = 'sim:golden-lifetime-' + mode
        scope = door.golden_scope(thread)
        async def mirror(**kwargs): pass
        def worker():
            entered.set()
            release.wait(5)
            settled.set()
        async def handler(event):
            future = asyncio.get_running_loop().run_in_executor(pool, worker)
            if mode == 'detached':
                async def child():
                    await future
                asyncio.create_task(child())
                return 'reply'
            await future
            return 'reply'
        runner = SimpleNamespace(_handle_message=handler)
        owner = door._GOLDEN_REQUEST.set(door._GOLDEN_OWNER)
        try:
            turn = asyncio.create_task(door.run_crowsnest_guest_turn(
                runner=runner, phone=scope.synthetic_phone, text='hello', mirror=mirror,
                timeout_sec=.03 if mode == 'timeout' else 5, late_settle_sec=0))
        finally:
            door._GOLDEN_REQUEST.reset(owner)
        try:
            for _ in range(1000):
                if entered.is_set(): break
                await asyncio.sleep(.001)
            self.assertTrue(entered.is_set())
            if mode == 'cancel':
                turn.cancel()
                with self.assertRaises(asyncio.CancelledError): await turn
            else:
                result = await turn
                self.assertEqual(result['ok'], mode == 'detached')
            await asyncio.sleep(0)
            self.assertFalse(settled.is_set())
            with self.assertRaisesRegex(RuntimeError, 'late_worker'):
                await door.cleanup_golden_thread(thread)
            result = await door.run_crowsnest_guest_turn(runner=runner,
                phone=scope.synthetic_phone, text='next', mirror=mirror)
            self.assertEqual(result['error'], 'session_tainted_by_late_worker')
        finally:
            release.set()
            pool.shutdown(wait=True)
            for _ in range(100):
                if scope.session_key not in door._TAINTED_SESSIONS: break
                await asyncio.sleep(.001)
        self.assertNotIn(scope.session_key, door._TAINTED_SESSIONS)
        self.assertIsNone(door.current_crowsnest_scope())

    async def test_cancel_real_executor(self): await self.exercise('cancel')
    async def test_timeout_real_executor(self): await self.exercise('timeout')
    async def test_success_detached_child(self): await self.exercise('detached')

    async def test_false_reset_ack(self):
        for ack in (None, False, True, {}):
            runner = SimpleNamespace(session_store=SimpleNamespace(reset_session=lambda key: ack, _generate_session_key=lambda source: source.chat_id))
            with patch.object(door, '_golden_runner', return_value=runner):
                with self.assertRaisesRegex(RuntimeError, 'rotation_unconfirmed'):
                    await door.cleanup_golden_thread('sim:golden-false-ack-' + str(ack).replace(' ', '').replace('{', 'object').replace('}', ''))
