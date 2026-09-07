"""Canonical six-entry denial probes; run in the pinned offline image."""
import contextvars
import unittest
from contextlib import ExitStack
from unittest.mock import patch
from types import SimpleNamespace
from wolfhouse import luna_personality_isolation as isolation
from agent import context_compressor as compressor, conversation_compression as conversation, auxiliary_client as auxiliary


class CompressorSixTests(unittest.TestCase):
    def test_independent_removal_late_and_caught_controls(self):
        import ast
        import copy
        import types
        from pathlib import Path
        owners = (compressor.ContextCompressor.__init__, compressor.ContextCompressor._generate_summary,
                  conversation.check_compression_model_feasibility, auxiliary.get_text_auxiliary_client,
                  auxiliary.call_llm, auxiliary._get_cached_client)
        for fn in owners:
            for mode in ('remove', 'late', 'caught', 'unconditional'):
                tree = ast.parse(Path(fn.__code__.co_filename).read_text())
                scope = tree
                for part in fn.__qualname__.split('.'):
                    scope = next(n for n in scope.body if getattr(n, 'name', None) == part)
                index = int(isinstance(scope.body[0], ast.Expr))
                guard = scope.body[index:index + 2]
                self.assertIsInstance(guard[0], ast.ImportFrom)
                del scope.body[index:index + 2]
                if mode == 'unconditional':
                    guard[1].test = ast.Constant(value=True)
                    scope.body[index:index] = guard
                if mode == 'late':
                    late = index + (3 if fn is auxiliary._get_cached_client else 1)
                    scope.body[late:late] = guard
                if mode == 'caught':
                    caught = ast.Try(body=guard, handlers=[ast.ExceptHandler(type=ast.Name(id='Exception', ctx=ast.Load()), body=[ast.Pass()])], orelse=[], finalbody=[])
                    scope.body.insert(index, caught)
                code = compile(ast.fix_missing_locations(tree), fn.__code__.co_filename, 'exec')
                for part in fn.__qualname__.split('.'):
                    code = next(c for c in code.co_consts if isinstance(c, types.CodeType) and c.co_name == part)
                saved = fn.__code__
                try:
                    fn.__code__ = code
                    if mode == 'unconditional':
                        self.assertIsNone(isolation.current_isolated_turn())
                        positive = self.test_ordinary_auxiliary_cold_warm_overrides_stale if fn in owners[3:] else self.test_ordinary_constructor_summary_feasibility
                        with self.assertRaises(isolation.IsolationAbort) as rejected:
                            positive()
                        self.assertEqual(rejected.exception.reason, 'auth_boundary_unsupported')
                        print('COMPRESSOR_UNCONDITIONAL_KILLED', fn.__qualname__, flush=True)
                        continue
                    result = unittest.TestResult()
                    CompressorSixTests('test_six_entries_before_first_effect').run(result)
                    self.assertEqual(result.errors, [], 'fixture errors cannot kill a mutant')
                    self.assertEqual(len(result.failures), 16 if fn is auxiliary._get_cached_client else 8)
                    self.assertTrue(all('first effect must remain unreachable' in detail for _, detail in result.failures))
                    print('COMPRESSOR_MUTANT_KILLED', fn.__qualname__, mode, flush=True)
                finally:
                    fn.__code__ = saved
                    self.assertIs(fn.__code__, saved)
        self.test_six_entries_before_first_effect()
        self.test_ordinary_constructor_summary_feasibility()
        self.test_ordinary_auxiliary_cold_warm_overrides_stale()

    def test_ordinary_constructor_summary_feasibility(self):
        from agent import model_metadata
        self.assertIsNone(isolation.current_isolated_turn())
        with patch.object(compressor, 'get_model_context_length', return_value=128000) as metadata:
            instance = compressor.ContextCompressor('fixture', api_key='synthetic-only', quiet_mode=True)
        self.assertEqual(instance.model, 'fixture')
        self.assertEqual(instance.api_key, 'synthetic-only')
        metadata.assert_called_once()
        response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='Synthetic summary'))])
        with patch.object(compressor, 'call_llm', return_value=response) as dispatch:
            summary = instance._generate_summary([{'role': 'user', 'content': 'Synthetic question'}])
        self.assertIn('Synthetic summary', summary)
        self.assertEqual(dispatch.call_count, 1)
        self.assertEqual(dispatch.call_args.kwargs['main_runtime']['model'], 'fixture')
        before = instance.__dict__.copy()
        token = isolation.enter_isolated_turn(False)
        try:
            with self.assertRaises(isolation.IsolationAbort):
                instance._generate_summary([])
            self.assertEqual(instance.__dict__, before)
        finally:
            isolation.exit_isolated_turn(token)
        agent = SimpleNamespace(compression_enabled=True, _current_main_runtime=lambda: {'model': 'fixture'},
                                _custom_providers=[], context_compressor=instance, provider='fixture')
        with patch.object(auxiliary, 'get_text_auxiliary_client', return_value=(SimpleNamespace(base_url='https://fixture.invalid', api_key='synthetic-only'), 'fixture')) as client:
            with patch.object(auxiliary, '_resolve_task_provider_model', return_value=('fixture', '', '', '', '')):
                with patch.object(model_metadata, 'get_model_context_length', return_value=128000) as metadata:
                    self.assertIsNone(conversation.check_compression_model_feasibility(agent))
        client.assert_called_once()
        metadata.assert_called_once()

    def test_ordinary_auxiliary_cold_warm_overrides_stale(self):
        import asyncio
        import threading
        response = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='Synthetic answer'))])
        from unittest.mock import Mock
        client = SimpleNamespace(base_url='https://fixture.invalid', chat=SimpleNamespace(completions=SimpleNamespace(create=Mock(return_value=response))))
        config = ('custom', 'fixture', 'https://fixture.invalid', 'synthetic-only', 'chat_completions')
        with ExitStack() as stack:
            resolver = stack.enter_context(patch.object(auxiliary, 'resolve_provider_client', return_value=(client, 'fixture')))
            stack.enter_context(patch.object(auxiliary, '_resolve_task_provider_model', return_value=config))
            stack.enter_context(patch.object(auxiliary, '_client_cache', {}))
            stack.enter_context(patch.object(auxiliary, '_client_cache_lock', threading.Lock()))
            stack.enter_context(patch.object(auxiliary, '_get_task_extra_body', return_value={}))
            self.assertEqual(auxiliary.get_text_auxiliary_client('compression'), (client, 'fixture'))
            resolver.reset_mock()
            kwargs = dict(provider='custom', api_key='synthetic-only', base_url='https://fixture.invalid')
            for warm in (False, True):
                self.assertEqual(auxiliary._get_cached_client(**kwargs), (client, 'fixture'))
            self.assertEqual(resolver.call_count, 1)
            self.assertEqual(auxiliary._get_cached_client(model='override', **kwargs), (client, 'override'))
            self.assertIs(auxiliary.call_llm('compression', messages=[{'role': 'user', 'content': 'Synthetic'}], timeout=10), response)
            self.assertEqual(client.chat.completions.create.call_count, 1)
            old_loop, new_loop = Mock(), Mock()
            old_loop.is_closed.return_value = False
            new_loop.is_closed.return_value = False
            close = stack.enter_context(patch.object(auxiliary, '_force_close_async_httpx'))
            with patch.object(asyncio, 'get_event_loop', return_value=old_loop):
                self.assertEqual(auxiliary._get_cached_client(async_mode=True, **kwargs), (client, 'fixture'))
                self.assertEqual(auxiliary._get_cached_client(async_mode=True, **kwargs), (client, 'fixture'))
            with patch.object(asyncio, 'get_event_loop', return_value=new_loop):
                self.assertEqual(auxiliary._get_cached_client(async_mode=True, **kwargs), (client, 'fixture'))
            close.assert_called_once_with(client)
            before = auxiliary._client_cache.copy()
            resolver.reset_mock()
            close.reset_mock()
            token = isolation.enter_isolated_turn(False)
            try:
                for async_mode in (False, True):
                    with patch.object(asyncio, 'get_event_loop', side_effect=AssertionError('loop inspected')):
                        with self.assertRaises(isolation.IsolationAbort):
                            auxiliary._get_cached_client(async_mode=async_mode, **kwargs)
                self.assertEqual(auxiliary._client_cache, before)
                resolver.assert_not_called()
                close.assert_not_called()
            finally:
                isolation.exit_isolated_turn(token)

    def test_six_entries_before_first_effect(self):
        effects = []
        def tripwire(*args, **kwargs):
            effects.append('effect')
            raise AssertionError('original operation reached')
        class Hostile:
            __getattr__ = __setattr__ = __bool__ = tripwire
        retained = compressor.ContextCompressor.__new__(compressor.ContextCompressor)
        entries = (
            (compressor.ContextCompressor.__init__, (Hostile(), 'fixture'), {}),
            (compressor.ContextCompressor._generate_summary, (retained, []), {}),
            (conversation.check_compression_model_feasibility, (Hostile(),), {}),
            (auxiliary.get_text_auxiliary_client, ('compression',), {}),
            (auxiliary.call_llm, ('compression',), {'messages': []}),
            (auxiliary._get_cached_client, ('fixture',), {'async_mode': False}),
            (auxiliary._get_cached_client, ('fixture',), {'async_mode': True}),
        )
        cap = isolation.IsolatedTurnCapture(case_id='compressor-six', personality_id='balanced', tenant_id='sunset')
        for state in (cap, False, {}, Hostile()):
            token = isolation.enter_isolated_turn(state)
            copied = contextvars.copy_context()
            isolation.exit_isolated_turn(token)
            for revoked in (False, True):
                if revoked:
                    isolation.settle_isolated_work(cap)
                for fn, args, kwargs in entries:
                    with self.subTest(owner=fn.__qualname__, state=type(state).__name__, revoked=revoked, async_mode=kwargs.get('async_mode')), ExitStack() as stack:
                        self.assertTrue(fn.__code__.co_filename.startswith('/tmp/prc-owners/'))
                        stack.enter_context(patch.object(compressor, 'time', SimpleNamespace(monotonic=tripwire)))
                        for name in ('_resolve_task_provider_model', '_normalize_main_runtime'):
                            stack.enter_context(patch.object(auxiliary, name, tripwire))
                        import asyncio
                        stack.enter_context(patch.object(asyncio, 'get_event_loop', tripwire))
                        effects.clear()
                        try:
                            copied.run(fn, *args, **kwargs)
                        except Exception as error:
                            caught = error
                        else:
                            caught = None
                        self.assertEqual(effects, [], 'first effect must remain unreachable')
                        self.assertIsInstance(caught, isolation.IsolationAbort)
                        self.assertEqual(caught.reason, 'auth_boundary_unsupported')
        self.assertIsNone(isolation.current_isolated_turn())
