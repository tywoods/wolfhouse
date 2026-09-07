"""Actual pinned streaming lexical caller, counter-only SDK boundary."""
import ast
import logging
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from wolfhouse import luna_personality_isolation as iso


class StreamingOriginTests(unittest.TestCase):
    def test_retained_request_attempt_reset_refuses_before_acquisition(self):
        source = Path('/tmp/prc-owners/agent/chat_completion_helpers.py').read_text()
        node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef)
                    and n.name == 'interruptible_streaming_api_call')
        retained, effects = {}, []
        class Escaped(Exception):
            pass
        class ReachedSDK(Exception):
            pass
        def escape(*args):
            retained.update(sys._getframe(1).f_locals)
            raise Escaped()
        def dispatch(**kwargs):
            effects.append('SDK')
            raise ReachedSDK()
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=dispatch)))
        def factory(**kwargs):
            effects.append('acquisition')
            return client
        agent = SimpleNamespace(api_mode='chat_completions', provider='openai', model='fixture',
            base_url=None, _interrupt_requested=False, _create_request_openai_client=factory,
            _touch_activity=lambda *a: None, _stream_diag_init=lambda: {})
        scope = dict(threading=threading, time=time, logger=logging.getLogger(__name__),
            get_provider_stale_timeout=escape, get_provider_request_timeout=lambda *a: 10,
            env_float=lambda key, default: default, env_int=lambda key, default: default)
        exec(compile(ast.Module(body=[node], type_ignores=[]), 'canonical-streaming-owner', 'exec'), scope)
        cap = iso.IsolatedTurnCapture(case_id='stream-origin', personality_id='balanced', tenant_id='sunset')
        token = iso.enter_isolated_turn(cap)
        try:
            with self.assertRaises(Escaped):
                scope[node.name](agent, {})
        finally:
            iso.exit_isolated_turn(token)
        try:
            retained['_call_chat_completions']()
        except (iso.IsolationAbort, ReachedSDK):
            pass
        self.assertEqual(effects, [], 'retained OLD attempt reached acquisition/SDK after reset')


if __name__ == '__main__':
    unittest.main()
