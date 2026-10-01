"""External pinned-image gate: real installed executor, plugin loader and aiohttp.
No gateway start, listener, agent/model invocation or service storage. No skips.
"""
import asyncio
import contextvars
import json
import os
from pathlib import Path
import socket
import threading
import unittest
from unittest.mock import patch

from wolfhouse import crowsnest_guest_door as door
from wolfhouse import simulate_core as core


class InstalledComposition(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # These imports MUST resolve in the installed image; no substitutes.
        import gateway.run as runtime
        from hermes_cli.plugins import PluginManager
        from gateway.platforms import whatsapp_cloud
        self.runtime = runtime
        self.assertTrue(str(Path(runtime.__file__).resolve()).startswith('/opt/hermes/'))
        self.manager = PluginManager()
        directory = Path(__file__).resolve().parents[1] / 'plugins/wolfhouse_staff_api'
        manifest = self.manager._parse_manifest(directory / 'plugin.yaml', directory, 'user', '')
        self.assertIsNotNone(manifest)
        self.manager._load_plugin(manifest)
        loaded = self.manager._plugins[manifest.key or manifest.name]
        self.assertFalse(loaded.error, loaded.error)
        self.plugin = loaded.module
        self.assertEqual(Path(self.plugin.__file__).resolve(), directory / '__init__.py')
        self.assertIn('list_my_bookings', loaded.tools_registered)
        self.alias = self.plugin._post_bot
        door.install_request_owned_guards(self.plugin, whatsapp_cloud)
        self.calls = []
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return b'{"success":true}'
        def terminal(request, **kwargs):
            self.calls.append((request.full_url, json.loads(request.data)))
            return Response()
        self.env = patch.dict(os.environ, {
            'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'LUNA_BOT_INTERNAL_TOKEN': 'offline',
            'LUNA_ALLOWED_LOCATION_IDS': '', 'HERMES_ROLE': 'luna', 'NODE_ENV': 'development',
            'DATABASE_URL': '', 'WOLFHOUSE_DATABASE_URL': '',
            'WOLFHOUSE_STAFF_API_BASE_URL': 'http://127.0.0.1:1',
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.transport = patch('urllib.request.urlopen', terminal)
        self.transport.start()
        self.addCleanup(self.transport.stop)
        # socketpair used by asyncio is allowed; outgoing connects are never allowed.
        self.tripwire = patch.object(socket.socket, 'connect', side_effect=AssertionError('network attempted'))
        self.tripwire.start()
        self.addCleanup(self.tripwire.stop)
        # No constructor side effects: this method has no instance dependencies.
        self.runner = runtime.GatewayRunner.__new__(runtime.GatewayRunner)

    def scope(self, suffix):
        token = door._GOLDEN_REQUEST.set(door._GOLDEN_OWNER)
        try:
            scope = door.golden_scope('sim:golden-installed-' + suffix)
            self.addCleanup(door._close_lifetime, scope)
            return scope
        finally: door._GOLDEN_REQUEST.reset(token)

    async def test_real_gateway_executor_plugin_alias_and_ordinary_positive(self):
        scope = self.scope('executor')
        observed = []
        def worker():
            observed.append(door.current_crowsnest_scope())
            # Deliberately strip context INSIDE real GatewayRunner executor.
            return contextvars.Context().run(self.alias, 'availability-check', {})
        token = door._SCOPE.set(scope)
        try: await self.runner._run_in_executor_with_context(worker)
        finally: door._SCOPE.reset(token)
        self.assertIs(observed[0], scope)
        self.assertEqual(self.calls, [])
        from tools.registry import registry
        await self.runner._run_in_executor_with_context(
            registry.dispatch, 'list_my_bookings', {'phone': '+491234567890'})
        self.assertEqual(len(self.calls), 1)

    async def test_already_entered_safe_transport_remains_owned(self):
        scope = self.scope('entered-transport')
        entered, release = threading.Event(), threading.Event()
        original_terminal = self.transport.new
        def blocking_terminal(request, **kwargs):
            entered.set()
            if not release.wait(3): raise AssertionError('terminal release deadline')
            return original_terminal(request, **kwargs)
        token = door._SCOPE.set(scope)
        try:
            with patch('urllib.request.urlopen', blocking_terminal):
                task = asyncio.create_task(self.runner._run_in_executor_with_context(
                    self.plugin._post_bot, 'availability-check', {}))
                try:
                    for _ in range(1000):
                        if entered.is_set(): break
                        await asyncio.sleep(.001)
                    self.assertTrue(entered.is_set())
                    scope.revoked = True
                    self.assertGreater(scope._outstanding, 0)
                    self.assertIn(scope.session_key, door._TAINTED_SESSIONS)
                    # Revocation cannot un-enter an already authorized terminal.
                    # Settlement remains fenced until the REAL future completes.
                    door._close_lifetime(scope)
                    self.assertIn(scope.session_key, door._TAINTED_SESSIONS)
                finally:
                    release.set()
                    await asyncio.wait_for(task, 3)
        finally: door._SCOPE.reset(token)
        for _ in range(20): await asyncio.sleep(0)
        self.assertEqual(len(self.calls), 1)
        self.assertNotIn(scope.session_key, door._TAINTED_SESSIONS)

    async def test_real_gateway_executor_revocation_and_settlement(self):
        scope = self.scope('settlement')
        entered, release = threading.Event(), threading.Event()
        def worker():
            entered.set()
            if not release.wait(3): raise AssertionError('worker release deadline')
            return contextvars.Context().run(self.alias, 'availability-check', {})
        token = door._SCOPE.set(scope)
        try:
            task = asyncio.create_task(self.runner._run_in_executor_with_context(worker))
        finally: door._SCOPE.reset(token)
        try:
            for _ in range(1000):
                if entered.is_set(): break
                await asyncio.sleep(.001)
            self.assertTrue(entered.is_set())
            scope.revoked = True
            self.assertTrue(scope._outstanding, 'real executor must be lifetime-owned')
            release.set()
            await asyncio.wait_for(task, 3)
            for _ in range(20): await asyncio.sleep(0)
            self.assertEqual(self.calls, [])
            self.assertFalse(scope._outstanding)
        finally:
            release.set()
            await asyncio.gather(task, return_exceptions=True)
            door._close_lifetime(scope)

    async def test_already_entered_real_sqlite_write_fences_cleanup(self):
        import tempfile
        from gateway.config import GatewayConfig
        from gateway.session import SessionStore
        from hermes_state import SessionDB
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = SessionDB(root / 'state.db')
            try:
                # Only DB allocation is redirected; real store and write stay intact.
                with patch('hermes_state.SessionDB', return_value=db):
                    store = SessionStore(root / 'sessions', GatewayConfig())
                scope = self.scope('entered-storage')
                old = store.get_or_create_session(door._make_event(scope, 'hello').source)
                entered, release = threading.Event(), threading.Event()
                def pause_insert():
                    entered.set()
                    if not release.wait(3): raise RuntimeError('SQLite release deadline')
                    return 1
                db._conn.create_function('pass4_pause_insert', 0, pause_insert)
                db._conn.execute('CREATE TEMP TRIGGER pass4_pause BEFORE INSERT ON messages '
                                 'BEGIN SELECT pass4_pause_insert(); END')
                token = door._SCOPE.set(scope)
                try:
                    task = asyncio.create_task(self.runner._run_in_executor_with_context(
                        store.append_to_transcript, old.session_id,
                        {'role':'user', 'content':'ENTERED_STORAGE_SENTINEL'}))
                finally: door._SCOPE.reset(token)
                try:
                    for _ in range(1000):
                        if entered.is_set(): break
                        await asyncio.sleep(.001)
                    self.assertTrue(entered.is_set(), 'must enter actual SQLite INSERT')
                    scope.revoked = True
                    door._close_lifetime(scope)
                    with self.assertRaisesRegex(RuntimeError, 'late_worker'):
                        await door.cleanup_golden_thread('sim:golden-installed-entered-storage')
                    self.assertGreater(scope._outstanding, 0)
                finally:
                    release.set()
                    await asyncio.wait_for(task, 3)
                for _ in range(20): await asyncio.sleep(0)
                self.assertFalse(scope._outstanding)
                self.assertNotIn(scope.session_key, door._TAINTED_SESSIONS)
                self.assertTrue(any(m.get('content') == 'ENTERED_STORAGE_SENTINEL'
                                    for m in store.load_transcript(old.session_id)))
            finally: db.close()

    async def test_real_aiohttp_handler_auth_and_staging_before_dispatch(self):
        from aiohttp import web
        from aiohttp.test_utils import make_mocked_request
        app = web.Application()
        core.register_simulate_route(app)
        handler = next(r.handler for r in app.router.routes()
                       if r.method == 'POST' and r.resource.canonical == core.SIMULATE_PATH)
        # Actual aiohttp request/response and actual staging guard; no web/guard shim.
        # All cases terminate before dispatch so no guest simulation runs.
        cases = [({}, b'{}', 401, {}),
                 ({'X-Luna-Bot-Token':'wrong'}, b'{}', 401, {}),
                 ({'Authorization':'Bearer offline'}, b'{', 400, {}),
                 ({'X-Luna-Bot-Token':'offline'}, b'[]', 400, {}),
                 ({'X-Luna-Bot-Token':'offline'}, b'{"messages":[{}]}', 410, {}),
                 ({'X-Luna-Bot-Token':'offline'}, b'{"thread":"sim:golden-http","text":"hello"}',
                  403, {'HERMES_ROLE':'staff'})]
        for headers, body, status, env in cases:
            with self.subTest(status=status, body=body), patch.dict(os.environ, env):
                request = make_mocked_request('POST', core.SIMULATE_PATH,
                    headers={'Content-Type':'application/json', **headers}, app=app)
                request._read_bytes = body
                response = await handler(request)
                self.assertIsInstance(response, web.Response)
                self.assertEqual(response.status, status)
        self.assertEqual(self.calls, [])


if __name__ == '__main__': unittest.main()
