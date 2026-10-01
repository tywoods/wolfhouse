"""Offline regressions for fresh independent review findings."""
import asyncio
import contextvars
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from wolfhouse import crowsnest_guest_door as door

class CallbackOwnership(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        class Adapter:
            async def send(self, *a, **k): pass
        door.install_request_owned_guards(SimpleNamespace(_post_bot=lambda *a, **k: {}), SimpleNamespace(WhatsAppCloudAdapter=Adapter))

    async def test_empty_context_callbacks_and_children(self):
        class Adapter:
            async def send(self, *a, **k): pass
        door.install_request_owned_guards(SimpleNamespace(_post_bot=lambda *a, **k: {}), SimpleNamespace(WhatsAppCloudAdapter=Adapter))
        loop = asyncio.get_running_loop()
        for api in ('call_soon', 'call_later', 'call_at'):
            scope = door.golden_scope('sim:golden-callback-' + api.replace('_', '-'))
            observed = []
            release = asyncio.Event()
            children = []
            async def child():
                observed.append(door.current_crowsnest_scope())
                await release.wait()
            def callback():
                observed.append(door.current_crowsnest_scope())
                observed.append(door.staff_transport_denial('booking-create'))
                children.append(loop.create_task(child(), context=contextvars.Context()))
            token = door._SCOPE.set(scope)
            try:
                args = (callback,) if api == 'call_soon' else ((0 if api == 'call_later' else loop.time()), callback)
                getattr(loop, api)(*args, context=contextvars.Context())
            finally:
                door._SCOPE.reset(token)
            for _ in range(4): await asyncio.sleep(0)
            try:
                self.assertIs(observed[0], scope)
                self.assertIsNotNone(observed[1])
                self.assertIs(observed[2], scope)
                door._close_lifetime(scope)
                self.assertIn(scope.session_key, door._TAINTED_SESSIONS)
            finally:
                release.set()
                await asyncio.gather(*children)
                await asyncio.sleep(0)
            self.assertNotIn(scope.session_key, door._TAINTED_SESSIONS)
            self.assertIsNone(door.current_crowsnest_scope())

    async def test_cancel_handle_releases_once(self):
        scope = door.golden_scope('sim:golden-callback-cancel')
        token = door._SCOPE.set(scope)
        try:
            handle = asyncio.get_running_loop().call_later(60, lambda: self.fail('cancelled callback ran'), context=contextvars.Context())
        finally: door._SCOPE.reset(token)
        self.assertGreater(scope._outstanding, 0)
        door._close_lifetime(scope)
        handle.cancel(); handle.cancel()
        self.assertEqual(scope._outstanding, 0)
        self.assertNotIn(scope.session_key, door._TAINTED_SESSIONS)

class ResetUncertainty(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_recovery_requires_storage_evidence_and_no_workers(self):
        thread = 'sim:golden-explicit-recovery'
        scope = door.golden_scope(thread)
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'sessions.json').write_text('{"routing":{"session_id":"new"}}')
            rows = {'old':{'ended_at':1}, 'new':{'ended_at':None}}
            store = SimpleNamespace(_generate_session_key=lambda source: 'routing', sessions_dir=directory,
                _entries={'routing':SimpleNamespace(session_id='new')}, _db=SimpleNamespace(get_session=rows.get))
            door._RESET_UNCERTAIN.add(scope.session_key); door._TAINTED_SESSIONS.add(scope.session_key)
            door._PENDING_SIM_REPLIES[scope.session_key] = 'retained'
            with patch.object(door, '_golden_runner', return_value=SimpleNamespace(session_store=store)):
                with self.assertRaises(ValueError):
                    await door.recover_golden_thread(thread, expected_session_id='new', ended_session_ids=[], operator_reason='reviewed')
                rows['old']['ended_at'] = None
                with self.assertRaises(RuntimeError):
                    await door.recover_golden_thread(thread, expected_session_id='new', ended_session_ids=['old'], operator_reason='reviewed')
                self.assertIn(scope.session_key, door._RESET_UNCERTAIN)
                rows['old']['ended_at'] = 1
                result = await door.recover_golden_thread(thread, expected_session_id='new', ended_session_ids=['old'], operator_reason='offline reconciliation reviewed')
                self.assertTrue(result['ok'])
                self.assertNotIn(scope.session_key, door._TAINTED_SESSIONS)
                self.assertEqual(door._PENDING_SIM_REPLIES.pop(scope.session_key), 'retained')

    async def test_all_publication_failures_quarantine_until_explicit_recovery(self):
        for mode in ('save', 'malformed', 'mismatch', 'missing'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                thread = 'sim:golden-reset-' + mode
                scope = door.golden_scope(thread)
                door._PENDING_SIM_REPLIES[scope.session_key] = 'retained'
                key = 'routing'
                def reset(_):
                    if mode == 'save': raise OSError('save failure after mutation')
                    if mode != 'missing':
                        Path(directory, 'sessions.json').write_text('{' if mode == 'malformed' else '{"routing":{"session_id":"wrong"}}')
                    return SimpleNamespace(session_key=key, session_id='new')
                store = SimpleNamespace(_generate_session_key=lambda source: key, reset_session=reset, sessions_dir=directory)
                with patch.object(door, '_golden_runner', return_value=SimpleNamespace(session_store=store)):
                    with self.assertRaises(Exception): await door.cleanup_golden_thread(thread)
                try:
                    self.assertIn(scope.session_key, door._TAINTED_SESSIONS)
                    door._close_lifetime(scope)
                    self.assertIn(scope.session_key, door._TAINTED_SESSIONS)
                    self.assertEqual(door._PENDING_SIM_REPLIES[scope.session_key], 'retained')
                finally:
                    door._TAINTED_SESSIONS.discard(scope.session_key)
                    if hasattr(door, '_RESET_UNCERTAIN'): door._RESET_UNCERTAIN.discard(scope.session_key)
                    door._PENDING_SIM_REPLIES.pop(scope.session_key, None)
