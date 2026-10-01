"""Offline tests: real permanent boundary, external transports replaced by counters."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from wolfhouse import crowsnest_guest_door as door

class GoldenSafety(unittest.IsolatedAsyncioTestCase):
    async def test_golden_owner_denies_mutations_even_with_runtime_capability(self):
        calls = []
        class Adapter:
            async def send(self, *args, **kwargs): calls.append('send')
        staff = SimpleNamespace(_post_bot=lambda *a, **k: calls.append(a) or {'ok': True},
                                _session_guest_phone=lambda: '+491234567890')
        wa = SimpleNamespace(WhatsAppCloudAdapter=Adapter)
        door.install_request_owned_guards(staff, wa)
        async def live(**kwargs):
            await kwargs['mirror'](direction='inbound', text='hello')
            scope = door.CrowsnestGuestScope.create(kwargs['phone'])
            token = door._SCOPE.set(scope)
            try:
                import sys
                with patch.dict(sys.modules, {'gateway.platforms.base': SimpleNamespace(SendResult=SimpleNamespace)}):
                    await Adapter().send(scope.session_key, 'reply')
                    scope.revoked = True
                    await Adapter().send('+491234567890', 'late reply')
                    scope.revoked = False
                for path in ('create-booking-from-plan', 'payments/create-link', 'flag-needs-human',
                             'availability-check/delete', 'unknown-new-write'):
                    result = staff._post_bot(path, {'guest_phone': '+491234567890'})
                    self.assertFalse(result.get('ok', False))
                staff._post_bot('availability-check', {})
                return {'ok': True}
            finally:
                door._SCOPE.reset(token)
        with patch.object(door, 'run_live_crowsnest_guest_turn', live), \
             patch.object(door, '_sunset_staging_staff_writes_enabled', return_value=True), \
             patch.object(door, 'evaluate_wolfhouse_staging_booking_capability', return_value={'admitted': True}):
            await door.run_golden_guest_turn(thread='sim:golden-case-123', text='hello')
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], '/staff/bot/availability-check')
        self.assertIsNone(door._GOLDEN_REQUEST.get())

    async def test_cleanup_rotates_only_exact_synthetic_namespace(self):
        keys = []
        import tempfile
        import json
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            def reset(key):
                keys.append(key)
                Path(directory, 'sessions.json').write_text(json.dumps({key: {'session_id': 'rotated'}}))
                return SimpleNamespace(session_key=key, session_id='rotated')
            runner = SimpleNamespace(session_store=SimpleNamespace(reset_session=reset, sessions_dir=directory, _generate_session_key=lambda source: source.chat_id))
            with patch.object(door, '_golden_runner', return_value=runner):
                result = await door.cleanup_golden_thread('sim:golden-case-123')
        self.assertTrue(result['ok'])
        self.assertEqual(keys, [door.golden_scope('sim:golden-case-123').session_key])
        self.assertTrue(keys[0].startswith('crowsnest-sim:'))

    async def test_arbitrary_guest_and_namespace_cleanup_rejected(self):
        for value in ('+491234567890', 'whatsapp:491234567890', 'crowsnest-sim:any',
                      'sim:other-case', 'sim:golden-../USER.md'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                await door.cleanup_golden_thread(value)

    async def test_teardown_failure_propagates(self):
        def fail(key): raise RuntimeError('fixture reset failed')
        runner = SimpleNamespace(session_store=SimpleNamespace(reset_session=fail, _generate_session_key=lambda source: source.chat_id))
        with patch.object(door, '_golden_runner', return_value=runner), self.assertRaises(RuntimeError):
            await door.cleanup_golden_thread('sim:golden-case-123')

    async def test_caller_boolean_is_not_golden_provenance(self):
        with self.assertRaises(TypeError):
            await door.run_golden_guest_turn(thread='sim:golden-case-123', text='hello', trusted=True)

class GoldenRouteSafety(unittest.IsolatedAsyncioTestCase):
    async def test_authenticated_route_owns_golden_dispatch_and_cleanup(self):
        import sys
        from wolfhouse import simulate_core as core
        routes = {}
        app = SimpleNamespace(router=SimpleNamespace(add_post=lambda path, fn: routes.update({path: fn})))
        core.register_simulate_route(app)
        request = SimpleNamespace(headers={'X-Luna-Bot-Token': 'offline-token'})
        async def body(): return {'thread':'sim:golden-case-123','text':'hello','allow_writes':True}
        request.json = body
        async def golden(**kwargs): return {'ok':True,'owner':'golden'}
        web = SimpleNamespace(json_response=lambda data, status=200: (status,data))
        with patch.dict(sys.modules, {'aiohttp':SimpleNamespace(web=web)}), \
             patch.dict('os.environ', {'LUNA_BOT_INTERNAL_TOKEN':'offline-token'}), \
             patch.object(door, 'run_golden_guest_turn', golden), \
             patch.object(core, 'assert_staging_environment'):
            status, result = await routes[core.SIMULATE_PATH](request)
        self.assertEqual(status,200)
        self.assertEqual(result.get('owner'),'golden')
        async def cleanup_body(): return {'thread':'sim:golden-case-123','action':'cleanup'}
        request.json = cleanup_body
        async def cleanup(thread):
            self.assertEqual(thread,'sim:golden-case-123')
            return {'ok':True,'owner':'cleanup'}
        with patch.dict(sys.modules, {'aiohttp':SimpleNamespace(web=web)}), \
             patch.dict('os.environ', {'LUNA_BOT_INTERNAL_TOKEN':'offline-token'}), \
             patch.object(door, 'cleanup_golden_thread', cleanup), \
             patch.object(core, 'assert_staging_environment'):
            status, result = await routes[core.SIMULATE_PATH](request)
        self.assertEqual((status,result.get('owner')),(200,'cleanup'))

    async def test_missing_installed_token_fails_closed(self):
        import sys
        from wolfhouse import simulate_core as core
        routes = {}
        core.register_simulate_route(SimpleNamespace(router=SimpleNamespace(add_post=lambda path, fn: routes.update({path:fn}))))
        request = SimpleNamespace(headers={})
        async def body(): return {'thread':'sim:golden-case-123','text':'hello'}
        request.json = body
        with patch.dict(sys.modules, {'aiohttp':SimpleNamespace(web=SimpleNamespace(json_response=lambda data,status=200:(status,data)))}), \
             patch.dict('os.environ', {'LUNA_BOT_INTERNAL_TOKEN':''}):
            status, _ = await routes[core.SIMULATE_PATH](request)
        self.assertEqual(status,401)

if __name__ == '__main__': unittest.main()
