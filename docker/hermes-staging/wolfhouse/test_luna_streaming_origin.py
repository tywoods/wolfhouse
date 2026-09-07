"""Pinned canonical streaming outer owner; counter-only external boundaries."""
import ast
import contextvars
import copy
import logging
import os
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace as NS
import types
import uuid
import unittest
from unittest.mock import patch
from wolfhouse import luna_personality_isolation as iso

SOURCE = Path(os.environ.get('LUNA_STREAMING_SOURCE', '/tmp/prc-owners/agent/chat_completion_helpers.py'))


def canonical_owner():
    if not SOURCE.exists():
        raise unittest.SkipTest('pinned emitted helper not supplied')
    node = next(n for n in ast.parse(SOURCE.read_text()).body if isinstance(n, ast.FunctionDef)
                and n.name == 'interruptible_streaming_api_call')
    scope = dict(threading=threading, time=time, uuid=uuid, logger=logging.getLogger(__name__),
        get_provider_request_timeout=lambda *a: 10, SimpleNamespace=NS,
        env_float=lambda key, default: default, env_int=lambda key, default: default)
    exec(compile(ast.Module(body=[node], type_ignores=[]), 'canonical-streaming-owner', 'exec'), scope)
    fn = scope[node.name]
    fn._source = ast.unparse(node)
    return fn


def capture(name='OLD'):
    return iso.IsolatedTurnCapture(case_id=name, personality_id='balanced', tenant_id='sunset')


class StreamingOriginTests(unittest.TestCase):
    def retain(self, origin, agent=None):
        retained, effects = {}, []
        class Escaped(Exception):
            pass
        def escape(*args):
            retained.update(sys._getframe(1).f_locals)
            raise Escaped()
        if agent is None:
            def dispatch(**kwargs):
                effects.append('SDK')
                return [NS(choices=[NS(delta=NS(content='fixture', tool_calls=None), finish_reason='stop')])]
            client = NS(chat=NS(completions=NS(create=dispatch)))
            agent = NS(api_mode='chat_completions', provider='openai', model='fixture',
                base_url=None, _interrupt_requested=False,
                _create_request_openai_client=lambda **kw: (effects.append('acquisition'), client)[1],
                _stream_diag_init=lambda: {}, _close_request_openai_client=lambda *a, **kw: effects.append('close'))
            for name in ('_touch_activity', '_capture_rate_limits', '_capture_credits',
                         '_stream_diag_capture_response', '_check_openrouter_cache_status', '_fire_stream_delta'):
                setattr(agent, name, lambda *a: None)
        fn = canonical_owner()
        fn.__globals__['get_provider_stale_timeout'] = escape
        token = iso.enter_isolated_turn(origin)
        try:
            with self.assertRaises(Escaped):
                fn(agent, {'model': agent.model})
        finally:
            iso.exit_isolated_turn(token)
        return retained, effects, agent

    def invoke(self, retained, ambient, name='_call'):
        token = iso.enter_isolated_turn(ambient)
        try:
            return contextvars.copy_context().run(retained[name])
        finally:
            iso.exit_isolated_turn(token)

    def test_retained_request_attempt_reset_refuses_before_acquisition(self):
        retained, effects, _ = self.retain(capture())
        try:
            retained['_call_chat_completions']()
        except iso.IsolationAbort:
            pass
        self.assertEqual(effects, [], 'retained OLD attempt reached acquisition/SDK after reset')

    def test_matrix_and_first_cause_settlement(self):
        for state in ('absent', 'NEXT', 'false', 'malformed', 'copied', 'revoked', 'same', 'ordinary'):
            with self.subTest(state=state):
                old, nxt = capture(), capture('NEXT')
                ambient = {'absent': None, 'NEXT': nxt, 'false': False, 'malformed': {},
                           'copied': copy.copy(old), 'revoked': old, 'same': old, 'ordinary': None}[state]
                origin = None if state == 'ordinary' else old
                retained, effects, _ = self.retain(origin)
                if state == 'revoked':
                    old._provider_revoked = True
                self.invoke(retained, ambient)
                if state in ('same', 'ordinary'):
                    self.assertEqual(effects, ['acquisition', 'SDK', 'close'])
                    self.assertEqual(retained['result']['response'].choices[0].message.content, 'fixture')
                else:
                    self.assertEqual(effects, [])
                    cause = retained['result']['error']
                    self.assertIsInstance(cause, iso.IsolationAbort)
                    self.assertIs(old._worker_abort, cause)
                    self.assertIsNone(nxt._worker_abort)
                    token = iso.enter_isolated_turn(nxt)
                    try:
                        with self.assertRaises(iso.IsolationAbort) as settled:
                            iso.settle_isolated_work(old)
                        self.assertIs(settled.exception, cause)
                        iso.retain_worker_abort(iso.IsolationAbort('later'), old)
                        self.assertIs(old._worker_abort, cause)
                        self.assertIsNone(nxt._worker_abort)
                    finally:
                        iso.exit_isolated_turn(token)

    def test_same_cached_agent_old_next_ordinary_overlap(self):
        old, nxt = capture(), capture('NEXT')
        retained, effects, agent = self.retain(old)
        newer, _, same = self.retain(nxt, agent)
        normal, _, also_same = self.retain(None, agent)
        self.assertIs(agent, same)
        self.assertIs(agent, also_same)
        self.invoke(retained, nxt)
        self.assertEqual(effects, [])
        self.invoke(newer, nxt)
        self.invoke(normal, None)
        self.assertEqual(effects, ['acquisition', 'SDK', 'close'] * 2)
        self.assertIsNone(nxt._worker_abort)

    def test_entry_is_independent_of_acquisition_authority(self):
        with patch.object(iso, 'acquire_streaming_request_client', lambda origin, agent, **kw: agent._create_request_openai_client(**kw)):
            retained, effects, agent = self.retain(capture())
            self.invoke(retained, None)
        self.assertEqual(effects, [])
        self.assertIsInstance(retained['result']['error'], iso.IsolationAbort)

    def test_acquisition_authority_is_independent_of_entry(self):
        old = capture()
        retained, effects, agent = self.retain(old)
        # Neutralize only the lexical entry/dispatch peer, not the authority owner's guard.
        original = retained['_call_chat_completions'].__code__
        fn = canonical_owner()
        code = compile(fn._source.replace('check_worker_origin(_stream_origin, agent)', 'None'), 'entry-peer-neutralized', 'exec')
        saved = fn.__code__
        fn.__code__ = next(c for c in code.co_consts if isinstance(c, types.CodeType) and c.co_name == fn.__name__)
        try:
            with patch(__name__ + '.canonical_owner', return_value=fn):
                retained, effects, agent = self.retain(old)
            self.invoke(retained, None)
            self.assertEqual(effects, [])
            self.assertIsInstance(retained['result']['error'], iso.IsolationAbort)
        finally:
            fn.__code__ = saved
        self.assertIs(fn.__code__, saved)
        self.assertIsNotNone(original)

    def test_causal_lexical_mutants_restore_identity(self):
        fn = canonical_owner()
        saved = fn.__code__
        mutants = (
            ('_stream_origin = current_isolated_turn()', '_stream_origin = None', 'test_matrix_and_first_cause_settlement'),
            ('_stream_origin, agent', 'current_isolated_turn(), agent', 'test_matrix_and_first_cause_settlement'),
            ('check_worker_origin(_stream_origin, agent)', 'None', 'test_entry_is_independent_of_acquisition_authority'),
            ('check_worker_origin(_stream_origin, agent)', "(_ for _ in ()).throw(IsolationAbort('deny'))", 'test_same_cached_agent_old_next_ordinary_overlap'),
            ('retain_worker_abort(e, _stream_origin)', 'None', 'test_matrix_and_first_cause_settlement'),
        )
        for old, new, test in mutants:
            with self.subTest(mutant=new):
                self.assertIn(old, fn._source)
                code = compile(fn._source.replace(old, new), 'streaming-mutant', 'exec')
                fn.__code__ = next(c for c in code.co_consts if isinstance(c, types.CodeType) and c.co_name == fn.__name__)
                try:
                    with patch(__name__ + '.canonical_owner', return_value=fn):
                        result = unittest.TestResult()
                        StreamingOriginTests(test).run(result)
                    self.assertEqual(result.errors, [], 'fixture errors are not kills')
                    self.assertGreater(len(result.failures), 0)
                finally:
                    fn.__code__ = saved
                self.assertIs(fn.__code__, saved)
        self.test_matrix_and_first_cause_settlement()


class CanonicalFactoryStreamingTests(unittest.TestCase):
    retain = StreamingOriginTests.retain
    invoke = StreamingOriginTests.invoke

    def setUp(self):
        from wolfhouse.test_luna_personality_live_eval import RequestIdentityBoundaryTests
        # A nested mutant must not inherit a previously installed GREEN class
        # wrapper through the new instance wrapper's bound-original closure.
        iso.reset_isolation_runtime_for_tests()
        RequestIdentityBoundaryTests.setUp(self)
        expected = next(c for c in iso._wrap_openai_client_factory.__code__.co_consts
                        if isinstance(c, types.CodeType) and c.co_name == '_wrapped')
        for owner in (self.ra.AIAgent, self.agent):
            for name in ('_create_request_openai_client', '_ensure_primary_openai_client'):
                fn = getattr(owner, name)
                self.assertIs(fn.__code__, expected)
                cells = dict(zip(fn.__code__.co_freevars,
                                 (c.cell_contents for c in fn.__closure__)))
                original = cells['orig']
                if iso._is_wrapped(original):
                    self.assertIs(original.__code__, expected)
        self.effects = []
        agent = self.agent
        agent.base_url = 'https://api.githubcopilot.com'
        agent._client_kwargs['base_url'] = agent.base_url
        agent._client_kwargs.pop('http_client')
        self.original_kwargs = dict(agent._client_kwargs)
        lock = agent._openai_client_lock
        def locked():
            self.effects.append('lock')
            return lock()
        agent._openai_client_lock = locked
        agent._copilot_headers_for_request = lambda **kw: (self.effects.append('headers'), {'vision': 'fixture'})[1]
        agent._close_request_openai_client = lambda *a, **kw: self.effects.append(('close', threading.get_ident()))
        agent._stream_diag_init = lambda: {}
        for name in ('_touch_activity', '_capture_rate_limits', '_capture_credits',
                     '_stream_diag_capture_response', '_check_openrouter_cache_status', '_fire_stream_delta'):
            setattr(agent, name, lambda *a: None)
        def sdk(**kwargs):
            self.effects.append(('client', kwargs))
            def create(**payload):
                self.effects.append('SDK')
                return [NS(choices=[NS(delta=NS(content='fixture', tool_calls=None), finish_reason='stop')])]
            return NS(chat=NS(completions=NS(create=create)), is_closed=lambda: False)
        self.ra.OpenAI = sdk

    def test_real_factory_refusal_keyword_binding_forms_and_positive_config(self):
        for form in ('class', 'bound', 'shadow'):
            with self.subTest(form=form):
                iso.reset_isolation_runtime_for_tests()
                agent = self.agent
                if form == 'shadow':
                    agent._create_request_openai_client = types.MethodType(self.ra.AIAgent._create_request_openai_client, agent)
                iso._wrap_openai_client_factory(self.ra.AIAgent if form == 'class' else agent)
                old, nxt = capture(), capture('NEXT')
                retained, _, same = self.retain(old, agent)
                self.assertIs(same, agent)
                for ambient in (None, nxt, False, {}, copy.copy(old)):
                    before = list(self.effects)
                    self.invoke(retained, ambient)
                    self.assertEqual(self.effects, before, 'refusal entered lock/rebuild/header/client/SDK')
                old._provider_revoked = True
                self.invoke(retained, old)
                self.assertEqual(self.effects, before)
                token = iso.enter_isolated_turn(nxt)
                try:
                    with self.assertRaises(iso.IsolationAbort):
                        agent._ensure_primary_openai_client(reason='direct-summary-or-codex')
                    self.assertEqual(self.effects, before)
                    fn = self.ra.AIAgent._create_request_openai_client if form == 'class' else agent._create_request_openai_client
                    kwargs = dict(reason='keyword-positive', api_kwargs={'messages': [{'content': [{'type': 'image_url'}]}]})
                    if form == 'class':
                        kwargs['self'] = agent
                    client = fn(**kwargs)
                    self.assertIsNotNone(client)
                finally:
                    iso.exit_isolated_turn(token)
                self.assertIn('headers', self.effects)
                clients = [e[1] for e in self.effects if isinstance(e, tuple) and e[0] == 'client']
                self.assertEqual(clients[-1]['max_retries'], 0)
                self.assertEqual(agent._client_kwargs, self.original_kwargs)
                newer, _, same = self.retain(nxt, agent)
                normal, _, also_same = self.retain(None, agent)
                self.assertIs(same, also_same)
                self.invoke(newer, nxt)
                self.invoke(normal, None)
                self.assertEqual(newer['result']['response'].choices[0].message.content, 'fixture')
                self.assertEqual(normal['result']['response'].choices[0].message.content, 'fixture')

    def test_blocked_acquisition_revoked_return_owned_cleanup_no_sdk(self):
        entered, release = threading.Event(), threading.Event()
        edge, outcomes = self.ra.OpenAI, []
        old, nxt = capture(), capture('NEXT')
        retained, _, agent = self.retain(old, self.agent)
        def sdk(**kwargs):
            entered.set()
            self.assertTrue(release.wait(3))
            return edge(**kwargs)
        self.ra.OpenAI = sdk
        def work():
            try:
                self.invoke(retained, old)
            except BaseException as exc:
                outcomes.append(exc)
        worker = threading.Thread(target=work)
        worker.start()
        try:
            self.assertTrue(entered.wait(3))
            with self.assertRaises(iso.IsolationAbort) as unsettled:
                iso.settle_isolated_work(old, timeout_s=0.01)
            self.assertEqual(unsettled.exception.reason, 'provider_work_unsettled')
            self.ra.OpenAI = edge
            newer, _, same = self.retain(nxt, agent)
            self.assertIs(same, agent)
            self.invoke(newer, nxt)
            self.assertIsNone(nxt._worker_abort)
        finally:
            release.set()
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(outcomes, [])
        self.assertEqual(self.effects.count('SDK'), 1, 'only NEXT may dispatch')
        self.assertEqual(self.effects.count(('close', worker.ident)), 1)
        self.assertIsNone(retained['request_client_holder']['client'])
        cause = retained['result']['error']
        self.assertIsInstance(cause, iso.IsolationAbort)
        self.assertIs(old._worker_abort, cause)
        with self.assertRaises(iso.IsolationAbort) as settled:
            iso.settle_isolated_work(old)
        self.assertIs(settled.exception, cause)

    def test_dispatch_guard_independent_after_real_acquisition(self):
        old = capture()
        retained, _, agent = self.retain(old, self.agent)
        acquire = iso.acquire_streaming_request_client
        def revoke_after_return(origin, actual, **kwargs):
            client = acquire(origin, actual, **kwargs)
            old._provider_revoked = True
            return client
        # Keep canonical acquisition/headers/client creation; neutralize only
        # the downstream observer peer to attribute refusal to lexical dispatch.
        with patch.object(iso, '_observe_openai_client', lambda client: client), \
             patch.object(iso, 'acquire_streaming_request_client', revoke_after_return):
            self.invoke(retained, old)
        self.assertIn('lock', self.effects)
        self.assertIn('headers', self.effects)
        self.assertEqual(sum(isinstance(e, tuple) and e[0] == 'client' for e in self.effects), 1)
        self.assertNotIn('SDK', self.effects)
        self.assertEqual(self.effects.count(('close', threading.get_ident())), 1)
        self.assertIsNone(retained['request_client_holder']['client'])
        self.assertIsInstance(retained['result']['error'], iso.IsolationAbort)
        self.assertIs(old._worker_abort, retained['result']['error'])

    def test_causal_dispatch_guard_restores_green(self):
        fn = canonical_owner()
        saved = fn.__code__
        old = 'check_worker_origin(_stream_origin, agent)\n        stream ='
        self.assertEqual(fn._source.count(old), 1)
        code = compile(fn._source.replace(old, 'None\n        stream ='), 'dispatch-mutant', 'exec')
        fn.__code__ = next(c for c in code.co_consts if isinstance(c, types.CodeType) and c.co_name == fn.__name__)
        try:
            with patch(__name__ + '.canonical_owner', return_value=fn):
                result = unittest.TestResult()
                CanonicalFactoryStreamingTests('test_dispatch_guard_independent_after_real_acquisition').run(result)
            self.assertEqual(result.errors, [], 'fixture errors are not kills')
            self.assertGreater(len(result.failures), 0)
        finally:
            fn.__code__ = saved
        self.assertIs(fn.__code__, saved)
        result = unittest.TestResult()
        CanonicalFactoryStreamingTests('test_dispatch_guard_independent_after_real_acquisition').run(result)
        self.assertTrue(result.wasSuccessful(), result.errors or result.failures)

    def test_causal_acquisition_and_primary_mutants(self):
        import inspect
        rows = (
            (iso.acquire_streaming_request_client, 'check_worker_origin(origin, agent)', 'pass',
             StreamingOriginTests, 'test_acquisition_authority_is_independent_of_entry'),
            (iso._wrap_openai_client_factory, 'if caller is not None:', 'if False:',
             CanonicalFactoryStreamingTests, 'test_factory_caller_authority_and_primary_independent'),
            (iso._wrap_openai_client_factory, 'if binding is None or _REQUEST_ACQUISITION.get() is not binding:', 'if False:',
             CanonicalFactoryStreamingTests, 'test_factory_caller_authority_and_primary_independent'),
        )
        for fn, old, new, cls, test in rows:
            with self.subTest(mutant=old):
                text = inspect.getsource(fn)
                self.assertEqual(text.count(old), 1)
                code = compile(text.replace(old, new), 'authority-mutant', 'exec')
                saved = fn.__code__
                fn.__code__ = next(c for c in code.co_consts if isinstance(c, types.CodeType) and c.co_name == fn.__name__)
                try:
                    result = unittest.TestResult()
                    cls(test).run(result)
                    self.assertEqual(result.errors, [], 'fixture errors are not kills')
                    self.assertGreater(len(result.failures), 0)
                finally:
                    fn.__code__ = saved
                self.assertIs(fn.__code__, saved)
        result = unittest.TestResult()
        CanonicalFactoryStreamingTests('test_factory_caller_authority_and_primary_independent').run(result)
        self.assertTrue(result.wasSuccessful(), result.errors or result.failures)

    def test_factory_caller_authority_and_primary_independent(self):
        old, nxt = capture(), capture('NEXT')
        agent = self.agent
        token = iso.enter_isolated_turn(nxt)
        authority = iso._REQUEST_CALLER.set((old, agent))
        try:
            before = list(self.effects)
            with self.assertRaises(iso.IsolationAbort):
                agent._create_request_openai_client(reason='retained-authority')
            self.assertEqual(self.effects, before)
        finally:
            iso._REQUEST_CALLER.reset(authority)
            iso.exit_isolated_turn(token)
        token = iso.enter_isolated_turn(old)
        try:
            agent._create_request_openai_client(reason='prime-binding')
        finally:
            iso.exit_isolated_turn(token)
        before = list(self.effects)
        for mode in ('chat_completions', 'codex_responses'):
            token = iso.enter_isolated_turn(old)
            agent.api_mode = mode
            try:
                with self.assertRaises(iso.IsolationAbort):
                    self.ra.AIAgent._ensure_primary_openai_client(self=agent, reason='direct')
                self.assertEqual(self.effects, before)
            finally:
                iso.exit_isolated_turn(token)
        agent.api_mode = 'chat_completions'


if __name__ == '__main__':
    unittest.main()
