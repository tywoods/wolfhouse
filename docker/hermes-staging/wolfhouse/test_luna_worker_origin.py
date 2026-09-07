"""Canonical outer-owner extraction; retain its actual closure before worker start."""
import ast
import logging
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from wolfhouse import luna_personality_isolation as iso

SOURCE = Path('/opt/data/workspace/evidence/LUNA-PERSONALITY-001-codex-sources/agent/chat_completion_helpers.py')


def canonical_owner():
    import apply_crowsnest_ai_usage_patch as p
    installed = Path('/tmp/prc-owners/agent/chat_completion_helpers.py')
    if installed.exists():
        text = installed.read_text()
    else:
        text = SOURCE.read_text()
        text = p.patch_cancelled_registration(text)
        text = p._b3e_replace(text, p.B3E[2][0], p.B3E[2][2])
        for owner, changes in p.B4_HELPER:
            text = p._b3e_replace(text, owner, changes)
        if hasattr(p, 'patch_worker_origin'):
            text = p.patch_worker_origin(text)
    node = next(n for n in ast.parse(text).body if isinstance(n, ast.FunctionDef) and n.name == 'interruptible_api_call')
    scope = {'threading': threading, 'logger': logging.getLogger(__name__)}
    exec(compile(ast.Module(body=[node], type_ignores=[]), 'canonical-worker-owner', 'exec'), scope)
    return scope['interruptible_api_call']


class WorkerOriginTests(unittest.TestCase):
    def retain(self, cap):
        effects = []
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: effects.append('dispatch'))))
        agent = SimpleNamespace(api_mode='chat_completions', model='fixture', provider='openai',
                                _create_request_openai_client=lambda **kw: (effects.append('factory'), client)[1],
                                _close_request_openai_client=lambda *a, **kw: effects.append('close'))
        retained = {}
        class Escaped(Exception):
            pass
        def escape(*args):
            retained.update(sys._getframe(1).f_locals)
            raise Escaped()
        agent._compute_non_stream_stale_timeout = escape
        token = iso.enter_isolated_turn(cap)
        try:
            with self.assertRaises(Escaped):
                canonical_owner()(agent, {})
        finally:
            iso.exit_isolated_turn(token)
        return retained, effects, agent

    def test_retained_after_parent_reset_denies_before_factory(self):
        cap = iso.IsolatedTurnCapture(case_id='origin', personality_id='balanced', tenant_id='sunset')
        retained, effects, agent = self.retain(cap)
        retained['_call']()
        self.assertEqual(effects, [], 'retained canonical worker reached factory after parent reset')
        self.assertIsInstance(retained['result']['error'], iso.IsolationAbort)
        self.assertIs(cap._worker_abort, retained['result']['error'])

    def test_origin_state_matrix_and_attempt_revalidation(self):
        import contextvars
        import copy
        cap = iso.IsolatedTurnCapture(case_id='matrix', personality_id='balanced', tenant_id='sunset')
        other = iso.IsolatedTurnCapture(case_id='next', personality_id='balanced', tenant_id='sunset')
        for origin, ambient, revoked, allowed in (
            (cap, cap, False, True), (cap, cap, True, False),
            (cap, other, False, False), (cap, copy.copy(cap), False, False),
            (False, False, False, False), ({}, {}, False, False),
            (None, cap, False, False), (cap, None, False, False),
            (None, None, False, True),
        ):
            with self.subTest(origin=type(origin).__name__, revoked=revoked, allowed=allowed):
                cap._provider_revoked = revoked
                retained, effects, agent = self.retain(origin)
                token = iso.enter_isolated_turn(ambient)
                child = contextvars.copy_context()
                iso.exit_isolated_turn(token)
                child.run(retained['_call'])
                self.assertEqual(effects, ['factory', 'dispatch', 'close'] if allowed else [])
                if not allowed:
                    self.assertIsInstance(retained['result']['error'], iso.IsolationAbort)
                if allowed and origin is not None:
                    cap._provider_revoked = True
                    with self.assertRaises(iso.IsolationAbort):
                        child.run(retained['admit_attempt'])

    def test_attempt_omission_restores_exact_code_identity(self):
        from unittest.mock import patch
        retained, effects, agent = self.retain(None)
        attempt = retained['admit_attempt']
        original = attempt.__code__
        template = 'def outer():\n' + ''.join('    ' + n + ' = None\n' for n in original.co_freevars)
        template += '    def inner():\n        return (' + ', '.join(original.co_freevars) + ') and None\n    return inner\n'
        scope = {}
        exec(template, scope)
        attempt.__code__ = scope['outer']().__code__
        try:
            with patch.object(iso, 'current_isolated_turn', return_value=object()):
                with self.assertRaises(AssertionError):
                    with self.assertRaises(iso.IsolationAbort):
                        attempt()
        finally:
            attempt.__code__ = original
        self.assertIs(attempt.__code__, original)
        with patch.object(iso, 'current_isolated_turn', return_value=object()):
            with self.assertRaises(iso.IsolationAbort):
                attempt()

    def test_missing_attempt_and_entry_checks_are_causal(self):
        from unittest.mock import patch
        with patch.object(iso, 'check_worker_origin', lambda *args: None):
            result = unittest.TestResult()
            WorkerOriginTests('test_retained_after_parent_reset_denies_before_factory').run(result)
            self.assertEqual(result.errors, [])
            self.assertEqual(len(result.failures), 1)
        self.test_retained_after_parent_reset_denies_before_factory()

    def test_blocked_factory_cancel_before_registration_preserves_owner_close(self):
        retained, effects, agent = self.retain(None)
        entered, release = threading.Event(), threading.Event()
        client = object()
        owner_threads = []
        def factory(**kw):
            effects.append('factory')
            entered.set()
            self.assertTrue(release.wait(3))
            return client
        agent._create_request_openai_client = factory
        agent._close_request_openai_client = lambda *a, **kw: owner_threads.append(threading.get_ident())
        worker = threading.Thread(target=retained['_call'])
        worker.start()
        try:
            self.assertTrue(entered.wait(3))
            with retained['request_client_lock']:
                retained['_request_cancelled']['value'] = True
            agent._interrupt_requested = False
            retained['_close_request_client_once']('cancel')
        finally:
            release.set()
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(effects, ['factory'])
        self.assertEqual(owner_threads, [worker.ident])
        self.assertIsNone(retained['result']['error'])

    def test_stranger_abort_never_full_closes_and_owner_closes_once(self):
        retained, effects, agent = self.retain(None)
        entered, release = threading.Event(), threading.Event()
        closes, aborts = [], []
        def dispatch(**kw):
            entered.set()
            self.assertTrue(release.wait(3))
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=dispatch)))
        agent._create_request_openai_client = lambda **kw: client
        agent._close_request_openai_client = lambda *a, **kw: closes.append(threading.get_ident())
        agent._abort_request_openai_client = lambda *a, **kw: aborts.append(threading.get_ident())
        worker = threading.Thread(target=retained['_call'])
        worker.start()
        try:
            self.assertTrue(entered.wait(3))
            retained['_close_request_client_once']('cancel')
            self.assertEqual(closes, [])
            self.assertEqual(aborts, [threading.get_ident()])
        finally:
            release.set()
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(closes, [worker.ident])
        retained['_close_request_client_once']('again')
        self.assertEqual(closes, [worker.ident])

    def test_ordinary_retained_worker_preserves_factory_dispatch_close(self):
        retained, effects, agent = self.retain(None)
        retained['_call']()
        self.assertEqual(effects, ['factory', 'dispatch', 'close'])
        self.assertIsNone(retained['result']['error'])


if __name__ == '__main__':
    unittest.main()
