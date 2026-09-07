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


if __name__ == '__main__':
    unittest.main()
