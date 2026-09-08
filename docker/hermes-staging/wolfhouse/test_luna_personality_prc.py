"""Direct canonical pre-resource refusal; only pinned offline image execution."""
import contextvars
import sys
import unittest
from types import SimpleNamespace

from agent.agent_init import init_agent
from hermes_cli.runtime_provider import resolve_runtime_provider
from wolfhouse import luna_personality_isolation as isolation


AUTH_ENTRIES = ('resolve_codex_runtime_credentials', '_read_codex_tokens', '_auth_store_lock',
                '_load_auth_store', '_save_auth_store', '_sync_codex_pool_entries', '_save_codex_tokens',
                '_recover_codex_tokens_from_cli', 'refresh_codex_oauth_pure', '_refresh_codex_auth_tokens',
                '_import_codex_cli_tokens', '_pool_codex_access_token', '_codex_pool_rate_limit_status')
POOL_ENTRIES = ('load_pool', 'select', '_select_unlocked', '_available_entries', '_refresh_entry',
                'mark_exhausted_and_rotate', 'try_refresh_current', '_try_refresh_current_unlocked', '_persist')


AUX_ENTRIES = ('resolve_provider_client', 'resolve_vision_provider_client',
               '_refresh_provider_credentials', '_recover_provider_pool', '_select_pool_entry', '_peek_pool_entry')


METADATA_ENTRIES = ('get_model_context_length', '_fetch_codex_oauth_context_lengths',
                    'save_context_length', '_save_model_metadata_disk_cache')


class MetadataAdmissionTests(unittest.TestCase):
    def test_four_entries_deny_before_original_operations(self):
        from contextlib import ExitStack
        from unittest.mock import patch
        from agent import model_metadata as metadata
        from hermes_cli import config
        effects = []
        def tripwire(*args, **kwargs):
            effects.append('original operation')
            raise AssertionError('original metadata operation reached')
        class Hostile:
            __bool__ = __str__ = __format__ = __getattr__ = tripwire
        hostile = Hostile()
        calls = (
            ('get_model_context_length', ('fixture',), {'config_context_length': 8192}),
            ('get_model_context_length', ('fixture', 'https://fixture.invalid'), {'custom_providers': [hostile]}),
            ('get_model_context_length', ('fixture', 'https://fixture.invalid'), {'provider': 'openai-codex'}),
            ('_fetch_codex_oauth_context_lengths', ('synthetic-only',), {}),
            ('save_context_length', ('fixture', 'https://fixture.invalid', 8192), {}),
            ('save_context_length', (hostile, hostile, 8192), {}),
            ('_save_model_metadata_disk_cache', ({'fixture': {}},), {}),
        )
        cap = isolation.IsolatedTurnCapture(case_id='metadata', personality_id='balanced', tenant_id='sunset')
        for state in (cap, False, {}, hostile):
            token = isolation.enter_isolated_turn(state)
            retained = contextvars.copy_context()
            isolation.exit_isolated_turn(token)
            for revoked in (False, True):
                if revoked:
                    isolation.settle_isolated_work(cap)
                for name, args, kwargs in calls:
                    owner = getattr(metadata, name)
                    self.assertTrue(owner.__code__.co_filename.startswith('/tmp/prc-owners/'))
                    with self.subTest(owner=name, state=type(state).__name__, revoked=revoked, args=len(args)), ExitStack() as stack:
                        for dependency in (*METADATA_ENTRIES, '_strip_provider_prefix', '_load_context_cache',
                                           '_get_context_cache_path', '_get_model_metadata_cache_path',
                                           '_invalidate_cached_context_length', 'atomic_json_write'):
                            if dependency != name:
                                stack.enter_context(patch.object(metadata, dependency, tripwire))
                        stack.enter_context(patch.object(config, 'get_custom_provider_context_length', tripwire))
                        stack.enter_context(patch.object(metadata.time, 'time', tripwire))
                        stack.enter_context(patch.object(metadata.requests, 'get', tripwire))
                        stack.enter_context(patch.object(metadata, '_codex_oauth_context_cache', {'fixture': 8192}))
                        stack.enter_context(patch.object(metadata, '_codex_oauth_context_cache_time', 1e30))
                        effects.clear()
                        try:
                            retained.run(owner, *args, **kwargs)
                        except Exception as error:
                            caught = error
                        else:
                            caught = None
                        self.assertEqual(effects, [], 'denial must precede config/cache/path/read/HTTP/write')
                        self.assertIsInstance(caught, isolation.IsolationAbort)
                        self.assertEqual(caught.reason, 'auth_boundary_unsupported')
        self.assertIsNone(isolation.current_isolated_turn())


    def test_independent_metadata_guard_removal_and_restoration(self):
        import ast
        import copy
        import types
        from pathlib import Path
        from agent import model_metadata as metadata
        original = ast.parse(Path(metadata.__file__).read_text())
        for name in METADATA_ENTRIES:
            owner = getattr(metadata, name)
            saved = owner.__code__
            tree = copy.deepcopy(original)
            node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
            self.assertIsInstance(node.body[1], ast.ImportFrom)
            del node.body[1:3]
            code = compile(tree, metadata.__file__, 'exec')
            owner.__code__ = next(c for c in code.co_consts if isinstance(c, types.CodeType) and c.co_name == name)
            try:
                result = unittest.TestResult()
                MetadataAdmissionTests('test_four_entries_deny_before_original_operations').run(result)
                self.assertEqual(result.errors, [], 'fixture errors are not causal kills')
                self.assertEqual(len(result.failures), {'get_model_context_length': 24, 'save_context_length': 16}.get(name, 8))
                print('METADATA_GUARD_REMOVAL_KILLED', name, len(result.failures), flush=True)
            finally:
                owner.__code__ = saved
            self.assertIs(owner.__code__, saved)
        self.test_four_entries_deny_before_original_operations()
        self.test_ordinary_cache_controls_and_warm_denial()

    def test_ordinary_cache_controls_and_warm_denial(self):
        import json
        import os
        import tempfile
        from pathlib import Path
        from unittest.mock import patch, Mock
        from contextlib import ExitStack
        from agent import model_metadata as metadata
        self.assertIsNone(isolation.current_isolated_turn())
        with tempfile.TemporaryDirectory() as home, ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {'HERMES_HOME': home, 'HOME': home}))
            stack.enter_context(patch.object(metadata, '_codex_oauth_context_cache', {}))
            stack.enter_context(patch.object(metadata, '_codex_oauth_context_cache_time', 0))
            response = Mock(status_code=200)
            response.json.return_value = {'models': [{'slug': 'gpt-5-fixture', 'context_window': 272000}]}
            http = stack.enter_context(patch.object(metadata.requests, 'get', return_value=response))
            stack.enter_context(patch.object(metadata, '_resolve_requests_verify', return_value=True))
            model, url = 'gpt-5-fixture', 'https://chatgpt.com/backend-api/codex'
            self.assertEqual(metadata.get_model_context_length(model, config_context_length=8192), 8192)
            for warm in (False, True):
                self.assertIsNone(metadata.save_context_length(model, url, 8192))
                self.assertEqual(metadata.get_model_context_length(model, url), 8192)
                self.assertEqual(metadata._fetch_codex_oauth_context_lengths('synthetic-only'), {model: 272000})
                self.assertIsNone(metadata._save_model_metadata_disk_cache({model: {'context_length': 8192}}))
                disk = json.loads(metadata._get_model_metadata_cache_path().read_text())
                self.assertIn(model, str(disk))
            self.assertEqual(http.call_count, 1, 'hot Codex memory cache avoids second HTTP')
            metadata.save_context_length(model, url, 1050000)
            before = {p: p.read_bytes() for p in Path(home).rglob('*') if p.is_file()}
            calls = (
                (metadata.get_model_context_length, (model,), {'config_context_length': 8192}),
                (metadata.get_model_context_length, (model, url), {'provider': 'openai-codex', 'api_key': 'synthetic-only'}),
                (metadata._fetch_codex_oauth_context_lengths, ('synthetic-only',), {}),
                (metadata.save_context_length, (model, url, 1050000), {}),
                (metadata._save_model_metadata_disk_cache, ({model: {}},), {}),
            )
            token = isolation.enter_isolated_turn(False)
            try:
                with patch('builtins.open', side_effect=AssertionError('warm denial read/write')):
                    for owner, args, kwargs in calls:
                        with self.assertRaises(isolation.IsolationAbort) as caught:
                            owner(*args, **kwargs)
                        self.assertEqual(caught.exception.reason, 'auth_boundary_unsupported')
            finally:
                isolation.exit_isolated_turn(token)
            self.assertEqual({p: p.read_bytes() for p in Path(home).rglob('*') if p.is_file()}, before)
            self.assertEqual(http.call_count, 1)
            self.assertEqual(metadata.get_model_context_length(model, url, provider='openai-codex', api_key='synthetic-only'), 272000)
            self.assertEqual(metadata.get_cached_context_length(model, url), 272000)
            self.assertEqual(http.call_count, 1, 'stale persistent cache reconciles with hot Codex cache')


class AuxiliaryAdmissionTests(unittest.TestCase):
    def test_six_entries_deny_before_effects(self):
        import inspect
        from contextlib import ExitStack
        from unittest.mock import patch
        from agent import auxiliary_client as aux
        effects = []
        def tripwire(*args, **kwargs):
            effects.append('acquisition/coercion')
            raise AssertionError('acquisition/coercion reached')
        class Hostile:
            __getattr__ = __getitem__ = __bool__ = __str__ = tripwire
        hostile = Hostile()
        cap = isolation.IsolatedTurnCapture(case_id='aux', personality_id='balanced', tenant_id='sunset')
        for state in (cap, False, {}, hostile):
            token = isolation.enter_isolated_turn(state)
            retained = contextvars.copy_context()
            isolation.exit_isolated_turn(token)
            for revoked in (False, True):
                if revoked:
                    isolation.settle_isolated_work(cap)
                for name in AUX_ENTRIES:
                    owner = getattr(aux, name)
                    self.assertTrue(owner.__code__.co_filename.startswith('/tmp/prc-owners/'))
                    with self.subTest(owner=name, state=type(state).__name__, revoked=revoked), ExitStack() as stack:
                        for dependency in (*AUX_ENTRIES, '_validate_proxy_env_urls', '_normalize_aux_provider',
                                           '_resolve_task_provider_model', 'load_pool', '_evict_cached_clients',
                                           'OpenAI', '_read_main_model'):
                            if dependency != name:
                                stack.enter_context(patch.object(aux, dependency, tripwire))
                        args, kwargs = [], {}
                        for parameter in inspect.signature(owner).parameters.values():
                            if parameter.kind == parameter.KEYWORD_ONLY:
                                kwargs[parameter.name] = hostile
                            else:
                                args.append(hostile)
                        effects.clear()
                        try:
                            retained.run(owner, *args, **kwargs)
                        except Exception as error:
                            caught = error
                        else:
                            caught = None
                        self.assertEqual(effects, [], 'entry must refuse before acquisition/coercion')
                        self.assertIsInstance(caught, isolation.IsolationAbort)
                        self.assertEqual(caught.reason, 'auth_boundary_unsupported')
                        self.assertIsNone(caught.__cause__)
        self.assertIsNone(isolation.current_isolated_turn())


    def test_independent_guard_mutants_and_restored_control(self):
        import ast
        import copy
        import types
        from pathlib import Path
        from agent import auxiliary_client as aux
        original = ast.parse(Path(aux.__file__).read_text())
        for name in AUX_ENTRIES:
            owner = getattr(aux, name)
            saved = owner.__code__
            for mutation in ('remove', 'after-acquisition', 'inside-catch', 'unconditional'):
                tree = copy.deepcopy(original)
                node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
                guard = node.body[1:3]
                del node.body[1:3]
                if mutation == 'after-acquisition':
                    node.body[2:2] = guard
                elif mutation == 'inside-catch':
                    catch = next((n for n in node.body if isinstance(n, ast.Try)), None)
                    if catch is None:
                        catch = ast.Try(body=node.body[1:], handlers=[ast.ExceptHandler(type=ast.Name(id='Exception', ctx=ast.Load()), name=None, body=[ast.Return(value=ast.Constant(None))])], orelse=[], finalbody=[])
                        node.body[1:] = [catch]
                    catch.body[0:0] = guard
                elif mutation == 'unconditional':
                    guard[1].test = ast.Constant(True)
                    node.body[1:1] = guard
                code = compile(ast.fix_missing_locations(tree), aux.__file__, 'exec')
                owner.__code__ = next(c for c in code.co_consts if isinstance(c, types.CodeType) and c.co_name == name)
                try:
                    method = 'test_ordinary_cold_warm_clients_and_recovery' if mutation == 'unconditional' else 'test_six_entries_deny_before_effects'
                    result = unittest.TestResult()
                    AuxiliaryAdmissionTests(method).run(result)
                    self.assertFalse(result.wasSuccessful(), (name, mutation, 'survived'))
                    if mutation != 'unconditional':
                        self.assertEqual(result.errors, [])
                        self.assertEqual(len(result.failures), 8)
                    else:
                        self.assertTrue(all('IsolationAbort: auth_boundary_unsupported' in trace for _, trace in result.errors))
                    print('AUX_MUTANT_KILLED', name, mutation, len(result.failures), len(result.errors), flush=True)
                finally:
                    owner.__code__ = saved
        self.test_six_entries_deny_before_effects()
        self.test_ordinary_cold_warm_clients_and_recovery()

    def test_ordinary_cold_warm_clients_and_recovery(self):
        import asyncio
        import os
        from unittest.mock import patch, Mock
        from agent import auxiliary_client as aux
        from hermes_cli import auth
        self.assertIsNone(isolation.current_isolated_turn())
        sentinel = object()
        unrelated = ('unrelated', 'model', False)
        with patch.dict(aux._client_cache, {unrelated: (sentinel, 'model', None)}, clear=True), patch.dict(os.environ, {'OPENAI_API_KEY': 'synthetic-only'}):
            for temperature in ('cold', 'warm'):
                for asynchronous in (False, True):
                    for vision in (False, True):
                        if vision:
                            provider, client, model = aux.resolve_vision_provider_client('custom', 'fixture-model',
                                base_url='https://fixture.invalid/v1', api_key='synthetic-only', async_mode=asynchronous)
                            self.assertEqual(provider, 'custom')
                        else:
                            client, model = aux.resolve_provider_client('custom', 'fixture-model',
                                explicit_base_url='https://fixture.invalid/v1', async_mode=asynchronous)
                        self.assertEqual(model, 'fixture-model')
                        self.assertEqual(str(client.base_url), 'https://fixture.invalid/v1/')
                        self.assertEqual(client.api_key, 'synthetic-only')
                        self.assertEqual(type(client).__name__, 'AsyncOpenAI' if asynchronous else 'OpenAI')
                        if asynchronous:
                            asyncio.run(client.close())
                        else:
                            client.close()
                self.assertIs(aux._client_cache[unrelated][0], sentinel)
            cached, model = aux._get_cached_client('custom', 'fixture-model', False, base_url='https://fixture.invalid/v1', api_key='synthetic-only')
            self.assertIs(aux._get_cached_client('custom', 'fixture-model', False, base_url='https://fixture.invalid/v1', api_key='synthetic-only')[0], cached)
            self.assertEqual(model, 'fixture-model')
            aux._evict_cached_clients('custom')
            for outcome in ({'api_key': 'synthetic-new'}, {'api_key': ''}, OSError('synthetic refresh')):
                stale = Mock()
                key = ('openai-codex', 'fixture', False)
                aux._client_cache[key] = (stale, 'fixture', None)
                with patch.object(auth, 'resolve_codex_runtime_credentials', side_effect=outcome if isinstance(outcome, Exception) else None, return_value=outcome) as refresh:
                    self.assertEqual(aux._refresh_provider_credentials('codex'), outcome == {'api_key': 'synthetic-new'})
                    refresh.assert_called_once_with(force_refresh=True)
                self.assertEqual(key not in aux._client_cache, outcome == {'api_key': 'synthetic-new'})
                self.assertIs(aux._client_cache[unrelated][0], sentinel)
            pool = Mock()
            entry = object()
            pool.has_credentials.return_value = True
            pool.select.return_value = pool.current.return_value = entry
            with patch.object(aux, 'load_pool', return_value=pool):
                self.assertEqual(aux._select_pool_entry('openai'), (True, entry))
                self.assertIs(aux._peek_pool_entry('openai'), entry)
                for success in (True, False):
                    pool.try_refresh_current.return_value = entry if success else None
                    pool.mark_exhausted_and_rotate.return_value = None
                    error = RuntimeError('synthetic auth')
                    error.status_code = 401
                    self.assertEqual(aux._recover_provider_pool('openai', error), success)
            with patch.object(aux, 'load_pool', side_effect=OSError('synthetic pool')):
                self.assertEqual(aux._select_pool_entry('openai'), (False, None))
                self.assertIsNone(aux._peek_pool_entry('openai'))
                self.assertFalse(aux._recover_provider_pool('openai', RuntimeError('synthetic')))
            self.assertIs(aux._client_cache[unrelated][0], sentinel)


class DirectAuthPoolTests(unittest.TestCase):
    def test_all_direct_entries_active_revoked_and_hostile(self):
        import inspect
        from contextlib import ExitStack
        from unittest.mock import patch
        from hermes_cli import auth
        from agent import credential_pool as pools
        seen = []
        def tripwire(*args, **kwargs):
            seen.append('resource/coercion')
            raise AssertionError('resource/coercion reached')
        class Hostile:
            __getattr__ = __getitem__ = __bool__ = __iter__ = __enter__ = tripwire
        hostile = Hostile()
        entries = [(auth, name) for name in AUTH_ENTRIES]
        entries += [(pools if name == 'load_pool' else pools.CredentialPool, name) for name in POOL_ENTRIES]
        cap = isolation.IsolatedTurnCapture(case_id='direct-auth', personality_id='balanced', tenant_id='sunset')
        token = isolation.enter_isolated_turn(cap)
        retained = contextvars.copy_context()
        isolation.exit_isolated_turn(token)
        for revoked in (False, True):
            if revoked:
                isolation.settle_isolated_work(cap)
            for module, name in entries:
                owner = getattr(module, name)
                effective = inspect.unwrap(owner)
                self.assertTrue(effective.__code__.co_filename.startswith('/tmp/prc-owners/'))
                with self.subTest(revoked=revoked, owner=name), ExitStack() as stack:
                    for peer_module, peer_name in entries:
                        if (peer_module, peer_name) != (module, name):
                            stack.enter_context(patch.object(peer_module, peer_name, tripwire))
                    for dependency in ('_file_lock', '_auth_file_path', 'write_credential_pool'):
                        for resource_module in (auth, pools):
                            if hasattr(resource_module, dependency):
                                stack.enter_context(patch.object(resource_module, dependency, tripwire))
                    stack.enter_context(patch.object(auth.os, 'getenv', tripwire))
                    stack.enter_context(patch.object(pools.time, 'time', tripwire))
                    args, kwargs = [], {}
                    for parameter in inspect.signature(owner).parameters.values():
                        if parameter.kind == parameter.KEYWORD_ONLY:
                            kwargs[parameter.name] = hostile
                        else:
                            args.append(hostile)
                    def invoke():
                        result = owner(*args, **kwargs)
                        if name == '_auth_store_lock':
                            with result:
                                pass
                    seen.clear()
                    try:
                        retained.run(invoke)
                    except Exception as error:
                        caught = error
                    else:
                        caught = None
                    self.assertIsInstance(caught, isolation.IsolationAbort)
                    self.assertEqual(caught.reason, 'auth_boundary_unsupported')
                    self.assertEqual(seen, [])
        self.assertIsNone(isolation.current_isolated_turn())

    def test_ordinary_and_retained_real_pool(self):
        from hermes_cli import auth
        from agent.credential_pool import load_pool
        from unittest.mock import patch
        CanonicalAdmissionTests('test_ordinary_auth_pool_resolution_uses_canonical_synthetic_store').test_ordinary_auth_pool_resolution_uses_canonical_synthetic_store()
        pool = load_pool('openai-codex')
        for temperature in ('cold', 'warm'):
            entry = pool.select()
            self.assertIsNotNone(entry)
            self.assertEqual(auth.resolve_codex_runtime_credentials()['api_key'], entry.access_token)
        cap = isolation.IsolatedTurnCapture(case_id='retained-pool', personality_id='balanced', tenant_id='sunset')
        token = isolation.enter_isolated_turn(cap)
        retained = contextvars.copy_context()
        isolation.exit_isolated_turn(token)
        for revoked in (False, True):
            if revoked:
                isolation.settle_isolated_work(cap)
            with patch.object(pool, '_lock') as lock:
                for invoke in (pool.select, pool._select_unlocked, pool._available_entries, pool._persist,
                               pool.try_refresh_current, pool._try_refresh_current_unlocked,
                               lambda: pool._refresh_entry(entry, force=True),
                               lambda: pool.mark_exhausted_and_rotate(status_code=429)):
                    with self.assertRaises(isolation.IsolationAbort):
                        retained.run(invoke)
                lock.__enter__.assert_not_called()
        self.assertEqual(pool.select().access_token, entry.access_token)

    def test_direct_codex_resolution_precedes_acquisition(self):
        from hermes_cli import auth
        from unittest.mock import patch
        cap = isolation.IsolatedTurnCapture(case_id='direct-auth', personality_id='balanced', tenant_id='sunset')
        token = isolation.enter_isolated_turn(cap)
        try:
            with patch.object(auth, '_read_codex_tokens', side_effect=AssertionError('credential acquisition reached')) as read:
                with self.assertRaises(isolation.IsolationAbort):
                    auth.resolve_codex_runtime_credentials(force_refresh=[])
                read.assert_not_called()
        finally:
            isolation.exit_isolated_turn(token)


class CanonicalAdmissionTests(unittest.TestCase):
    def test_runtime_resolver_is_admitted_only_inside_bound_provider_auth_scope(self):
        runner = SimpleNamespace(_agent_cache={"image": SimpleNamespace(api_mode="codex_responses")})
        source = SimpleNamespace(platform=SimpleNamespace(value="whatsapp_cloud"),
                                 chat_id="image-eval", user_id="image-eval")
        cap = isolation.IsolatedTurnCapture("warmth-greeting-en", "sunny", tenant_id="sunset")
        isolation._ACTIVE_RUNNER = runner
        turn = isolation.enter_isolated_turn(cap)
        route = isolation._issue_runtime_route_admission(cap, SimpleNamespace(source=source), runner)
        try:
            isolation.refuse_unverified_runtime(isolation.RUNTIME_RESOLUTION_STAGE)
            isolation.refuse_unverified_runtime(isolation.AGENT_EXECUTION_STAGE)
            with isolation.isolated_provider_auth_scope():
                resolved = resolve_runtime_provider(requested="openai-codex", target_model="gpt-5")
            self.assertIs(type(resolved), dict)
            self.assertEqual(resolved["provider"], "openai-codex")
            self.assertEqual(resolved["api_mode"], "codex_responses")
            self.assertTrue(isolation.runtime_route_execution_admitted())
            with self.assertRaises(isolation.IsolationAbort):
                with isolation.isolated_provider_auth_scope():
                    pass
        finally:
            isolation._RUNTIME_ROUTE.reset(route)
            isolation.exit_isolated_turn(turn)
            isolation._ACTIVE_RUNNER = None

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
