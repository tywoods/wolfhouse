"""Canonical six-entry denial probes; run in the pinned offline image."""
import contextvars
import unittest
from contextlib import ExitStack
from unittest.mock import patch
from types import SimpleNamespace
from wolfhouse import luna_personality_isolation as isolation
from agent import context_compressor as compressor, conversation_compression as conversation, auxiliary_client as auxiliary


class CompressorSixTests(unittest.TestCase):
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
