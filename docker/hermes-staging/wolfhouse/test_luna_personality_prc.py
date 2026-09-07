"""Direct canonical pre-resource refusal; only pinned offline image execution."""
import contextvars
import sys
import unittest
from types import SimpleNamespace

from agent.agent_init import init_agent
from hermes_cli.runtime_provider import resolve_runtime_provider
from wolfhouse import luna_personality_isolation as isolation


class CanonicalAdmissionTests(unittest.TestCase):
    def test_canonical_constructor_abort_survives_real_eval_with_unknown_effects(self):
        import asyncio
        from wolfhouse import luna_personality_live_eval as live
        from unittest.mock import patch
        settle = live.settle_isolated_work
        for owner, args, reason in ((init_agent, (SimpleNamespace(),), 'constructor_boundary_unverified'),
                                     (resolve_runtime_provider, (), 'runtime_resolution_unverified')):
            self.assertTrue(owner.__code__.co_filename.startswith('/tmp/prc-owners/'))
            print('EFFECTIVE', owner.__module__, owner.__code__.co_filename, flush=True)
            for cleanup_failure in (False, True):
                causes, original_cause = [], ValueError('synthetic original cause')
                async def invoke(message, cap, meta):
                    cap.telemetry_producer_suppressed = 7
                    try:
                        owner(*args)
                    except isolation.IsolationAbort as error:
                        causes.append(error)
                        raise error from original_cause
                def cleanup(cap):
                    settle(cap)
                    if cleanup_failure:
                        raise OSError('synthetic cleanup failure')
                with patch.object(live, 'settle_isolated_work', cleanup), self.assertRaises(isolation.IsolationAbort) as raised:
                    asyncio.run(live.run_isolated_personality_eval(case_id='warmth-greeting-en', personality_id='sunny',
                        serving_preflight=False, fetch_setting=lambda slug: {'personality_id': 'sunny'}, invoke_turn=invoke))
                self.assertEqual(len(causes), 1)
                self.assertIs(raised.exception, causes[0])
                self.assertEqual(raised.exception.reason, reason)
                self.assertIs(raised.exception.__cause__, original_cause)
                self.assertEqual(raised.exception.cleanup_error, 'cleanup_failed' if cleanup_failure else None)
                self.assertIsNone(isolation.current_isolated_turn())
                self.assertEqual(raised.exception.counters['telemetry_producer_suppressed'], 7)
                for field in ('auth_effects', 'provider_http_effects', 'telemetry_effects'):
                    self.assertIsNone(raised.exception.counters[field])

    def test_ordinary_auth_pool_resolution_uses_canonical_synthetic_store(self):
        import base64
        import json
        import os
        import time
        from pathlib import Path
        from unittest.mock import patch
        from hermes_cli import auth
        home = Path(os.environ['HERMES_HOME'])
        self.assertEqual(str(home), '/tmp/synthetic/.hermes')
        self.assertIsNone(isolation.current_isolated_turn())
        payload = base64.urlsafe_b64encode(json.dumps({'exp': int(time.time()) + 86400}).encode()).decode().rstrip('=')
        synthetic = 'synthetic.' + payload + '.fixture'
        with patch('requests.sessions.Session.request', side_effect=AssertionError('unexpected HTTP')):
            auth._save_codex_tokens({'access_token': synthetic, 'refresh_token': 'synthetic-refresh'})
            for temperature in ('cold', 'warm'):
                result = resolve_runtime_provider(requested='openai-codex', target_model='gpt-5')
                self.assertEqual(result['provider'], 'openai-codex')
                self.assertEqual(result['api_mode'], 'codex_responses')
                self.assertEqual(result['api_key'], synthetic)
        self.assertTrue((home / 'auth.json').is_file())

    def test_direct_entries_precede_every_resource_and_retain_context(self):
        self.assertTrue(sys.modules[init_agent.__module__].__file__.startswith('/tmp/prc-owners/'))
        self.assertTrue(sys.modules[resolve_runtime_provider.__module__].__file__.startswith('/tmp/prc-owners/'))
        resources = {'_install_safe_stdio', 'resolve_requested_provider', 'load_pool',
                     'select', '_available_entries', '_select_unlocked', '_persist',
                     'try_refresh_current', '_auth_store_lock', '_file_lock',
                     'resolve_codex_runtime_credentials', '_save_auth_store',
                     '_refresh_codex_auth_tokens', 'refresh_codex_oauth_pure',
                     '_recover_codex_tokens_from_cli', '_import_codex_cli_tokens',
                     'resolve_provider_client', 'create_openai_client',
                     'get_model_context_length', '_fetch_codex_oauth_context_lengths',
                     'load_from_disk', 'load_memory_provider', 'initialize_all'}
        cap = isolation.IsolatedTurnCapture(case_id='prc', personality_id='balanced', tenant_id='sunset')
        token = isolation.enter_isolated_turn(cap)
        retained = contextvars.copy_context()
        isolation.exit_isolated_turn(token)
        self.assertIsNone(isolation.current_isolated_turn())
        seen = []
        def tripwire(frame, event, arg):
            if event == 'call' and frame.f_code.co_name in resources:
                seen.append(frame.f_code.co_name)
                raise AssertionError('pre-resource boundary reached')
        for revoked in (False, True):
            if revoked:
                isolation.settle_isolated_work(cap)
            for kwargs in ({}, {'provider': 'openai-codex', 'api_mode': 'codex_responses'},
                           {'api_mode': []}, {'credential_pool': object()},
                           {'fallback_model': {'provider': 'custom', 'model': 'alternate'}},
                           {'api_key': 'synthetic', 'base_url': 'https://fixture.invalid/v1', 'skip_memory': False}):
                with self.subTest(revoked=revoked, constructor=tuple(kwargs)):
                    agent = SimpleNamespace()
                    sys.setprofile(tripwire)
                    try:
                        try:
                            retained.run(init_agent, agent, **kwargs)
                        except Exception as error:
                            caught = error
                        else:
                            caught = None
                    finally:
                        sys.setprofile(None)
                    self.assertIsInstance(caught, isolation.IsolationAbort)
                    self.assertEqual(caught.reason, 'constructor_boundary_unverified')
                    self.assertEqual(vars(agent), {})
                    self.assertEqual(seen, [])
            for requested in (None, 'openai-codex', 'auto', 'custom', [], 'unknown'):
                with self.subTest(revoked=revoked, requested=requested):
                    sys.setprofile(tripwire)
                    try:
                        try:
                            retained.run(resolve_runtime_provider, requested=requested)
                        except Exception as error:
                            caught = error
                        else:
                            caught = None
                    finally:
                        sys.setprofile(None)
                    self.assertIsInstance(caught, isolation.IsolationAbort)
                    self.assertEqual(caught.reason, 'runtime_resolution_unverified')
                    self.assertEqual(seen, [])
        self.assertIsNone(isolation.current_isolated_turn())
        self.assertNotIn('codex_responses', isolation.SUPPORTED_PROVIDER_BACKENDS)
