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
    scope['interruptible_api_call']._source = ast.unparse(node)
    return scope['interruptible_api_call']


class WorkerOriginTests(unittest.TestCase):
    def retain(self, cap, shared_agent=None):
        effects = []
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: effects.append('dispatch'))))
        agent = SimpleNamespace(api_mode='chat_completions', model='fixture', provider='openai',
                                _create_request_openai_client=lambda **kw: (effects.append('factory'), client)[1],
                                _close_request_openai_client=lambda *a, **kw: effects.append('close'))
        if shared_agent is not None:
            agent = shared_agent
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

    def test_lexical_guard_and_cleanup_mutants(self):
        import types
        from unittest.mock import patch
        fn = canonical_owner()
        saved = fn.__code__
        mutants = (
            ('_worker_origin = current_isolated_turn()', '_worker_origin = None', 'test_retained_after_parent_reset_denies_before_factory'),
            ('check_worker_origin(_worker_origin, agent)', 'check_worker_origin(current_isolated_turn(), agent)', 'test_retained_after_parent_reset_denies_before_factory'),
            ('check_worker_origin(_worker_origin, agent)', 'None', 'test_origin_state_matrix_and_attempt_revalidation'),
            ('if _request_cancelled[\'value\']:', 'if False:', 'test_blocked_factory_cancel_before_registration_preserves_owner_close'),
            ('agent._abort_request_openai_client(request_client, reason=reason)', 'agent._close_request_openai_client(request_client, reason=reason)', 'test_stranger_abort_never_full_closes_and_owner_closes_once'),
        )
        for old, new, test in mutants:
            with self.subTest(mutant=new):
                self.assertIn(old, fn._source)
                code = compile(fn._source.replace(old, new), 'canonical-worker-mutant', 'exec')
                fn.__code__ = next(c for c in code.co_consts if isinstance(c, types.CodeType) and c.co_name == fn.__name__)
                try:
                    with patch(__name__ + '.canonical_owner', return_value=fn):
                        result = unittest.TestResult()
                        WorkerOriginTests(test).run(result)
                    self.assertEqual(result.errors, [], 'fixture errors are not mutant kills')
                    self.assertGreater(len(result.failures), 0)
                finally:
                    fn.__code__ = saved
                self.assertIs(fn.__code__, saved)
        self.test_retained_after_parent_reset_denies_before_factory()
        self.test_stranger_abort_never_full_closes_and_owner_closes_once()

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

    def test_unconditional_denial_fails_ordinary_positive(self):
        from unittest.mock import patch
        def deny(*args):
            raise iso.IsolationAbort('fixture_unconditional_denial')
        with patch.object(iso, 'check_worker_origin', deny):
            result = unittest.TestResult()
            WorkerOriginTests('test_ordinary_retained_worker_preserves_factory_dispatch_close').run(result)
            self.assertEqual(result.errors, [])
            self.assertEqual(len(result.failures), 1)

    def test_old_worker_overlaps_next_without_adopting_next(self):
        from contextvars import copy_context
        old = iso.IsolatedTurnCapture(case_id='old', personality_id='balanced', tenant_id='sunset')
        nxt = iso.IsolatedTurnCapture(case_id='next', personality_id='balanced', tenant_id='sunset')
        retained, effects, agent = self.retain(old)
        entered, release = threading.Event(), threading.Event()
        def dispatch(**kw):
            entered.set()
            self.assertTrue(release.wait(3))
            retained['admit_attempt']()
            effects.append('retry-dispatch')
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=dispatch)))
        agent._create_request_openai_client = lambda **kw: (effects.append('factory'), client)[1]
        token = iso.enter_isolated_turn(old)
        context = copy_context()
        iso.exit_isolated_turn(token)
        worker = threading.Thread(target=lambda: context.run(retained['_call']))
        worker.start()
        try:
            self.assertTrue(entered.wait(3))
            iso.settle_isolated_work(old)
            token = iso.enter_isolated_turn(nxt)
            try:
                agent._interrupt_requested = True
                following, next_effects, next_agent = self.retain(nxt, agent)
                self.assertIs(next_agent, agent)
                self.assertIs(following['agent'], retained['agent'])
                next_client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: next_effects.append('dispatch'))))
                agent._create_request_openai_client = lambda **kw: (next_effects.append('factory'), next_client)[1]
                owner_tid = worker.ident
                agent._close_request_openai_client = lambda *a, **kw: (effects if threading.get_ident() == owner_tid else next_effects).append('close')
                agent._interrupt_requested = False
                following['_call']()
                self.assertEqual(next_effects, ['factory', 'dispatch', 'close'])
                with self.assertRaises(iso.IsolationAbort):
                    retained['admit_attempt']()
                self.assertIsNone(nxt._worker_abort)
            finally:
                iso.exit_isolated_turn(token)
        finally:
            release.set()
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(effects, ['factory', 'close'])
        self.assertIs(old._worker_abort, retained['result']['error'])
        self.assertIsInstance(old._worker_abort, iso.IsolationAbort)
        self.assertIsNone(nxt._worker_abort)

    def test_registration_lock_serializes_returned_client_and_cancel(self):
        retained, effects, agent = self.retain(None)
        progress = threading.Event()
        mutex = threading.Lock()
        class ObservedLock:
            def __enter__(self):
                progress.set()
                mutex.acquire()
            def __exit__(self, *args):
                mutex.release()
        class Holder(dict):
            def __setitem__(self, key, value):
                super().__setitem__(key, value)
                progress.set()
        holder = Holder(retained['request_client_holder'])
        for fn in (retained['_set_request_client'], retained['_close_request_client_once'], retained['admit_attempt']):
            cells = dict(zip(fn.__code__.co_freevars, fn.__closure__))
            if 'request_client_lock' in cells:
                cells['request_client_lock'].cell_contents = ObservedLock()
            if 'request_client_holder' in cells:
                cells['request_client_holder'].cell_contents = holder
        closed, errors = [], []
        client = object()
        agent._close_request_openai_client = lambda obj, **kw: closed.append((obj, threading.get_ident()))
        def register():
            try:
                retained['_set_request_client'](client)
            except BaseException as exc:
                errors.append(exc)
            finally:
                retained['_close_request_client_once']('complete')
        mutex.acquire()
        worker = threading.Thread(target=register)
        worker.start()
        try:
            self.assertTrue(progress.wait(3))
            self.assertIsNone(holder['client'], 'registration published while cancellation owns lock')
            retained['_request_cancelled']['value'] = True
        finally:
            mutex.release()
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], InterruptedError)
        self.assertEqual(closed, [(client, worker.ident)])

    def test_request_local_cancel_survives_shared_interrupt_clear(self):
        retained, effects, agent = self.retain(None)
        retained['_request_cancelled']['value'] = True
        agent._interrupt_requested = False
        with self.assertRaises(InterruptedError):
            retained['admit_attempt']()
        self.assertEqual(effects, [])

    def test_required_targeted_omissions_are_behavioral(self):
        import types
        from unittest.mock import patch
        fn = canonical_owner()
        saved = fn.__code__
        for owner, mutation, test in (
            ('_set_request_client', 'lock', 'test_registration_lock_serializes_returned_client_and_cancel'),
            ('request_cancelled', 'shared', 'test_request_local_cancel_survives_shared_interrupt_clear'),
            ('admit_attempt', 'origin', 'test_old_worker_overlaps_next_without_adopting_next'),
        ):
            with self.subTest(owner=owner):
                tree = ast.parse(fn._source)
                target = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == owner)
                if mutation == 'lock':
                    self.assertIsInstance(target.body[0], ast.With)
                    target.body[0:1] = target.body[0].body
                elif mutation == 'shared':
                    target.body = ast.parse('return agent._interrupt_requested').body
                else:
                    self.assertEqual(ast.unparse(target.body[0]), 'check_worker_origin(_worker_origin, agent)')
                    target.body.pop(0)
                    self.assertEqual(ast.unparse(tree).count('check_worker_origin(_worker_origin, agent)'), 1)
                compiled = compile(ast.fix_missing_locations(tree), 'targeted-origin-mutant', 'exec')
                fn.__code__ = next(c for c in compiled.co_consts if isinstance(c, types.CodeType) and c.co_name == fn.__name__)
                try:
                    with patch(__name__ + '.canonical_owner', return_value=fn):
                        result = unittest.TestResult()
                        WorkerOriginTests(test).run(result)
                    self.assertEqual(result.errors, [], 'fixture errors are not causal kills')
                    self.assertGreater(len(result.failures), 0, owner)
                finally:
                    fn.__code__ = saved
                self.assertIs(fn.__code__, saved)
        self.test_registration_lock_serializes_returned_client_and_cancel()
        self.test_request_local_cancel_survives_shared_interrupt_clear()
        self.test_old_worker_overlaps_next_without_adopting_next()

    def test_ordinary_retained_worker_preserves_factory_dispatch_close(self):
        retained, effects, agent = self.retain(None)
        retained['_call']()
        self.assertEqual(effects, ['factory', 'dispatch', 'close'])
        self.assertIsNone(retained['result']['error'])


if __name__ == '__main__':
    unittest.main()
