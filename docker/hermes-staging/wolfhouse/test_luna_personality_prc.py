"""Direct canonical pre-resource refusal; only pinned offline image execution."""
import contextvars
import sys
import unittest
from types import SimpleNamespace

from agent.agent_init import init_agent
from hermes_cli.runtime_provider import resolve_runtime_provider
from wolfhouse import luna_personality_isolation as isolation


class CanonicalAdmissionTests(unittest.TestCase):
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
