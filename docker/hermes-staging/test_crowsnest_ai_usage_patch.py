import shutil
import tempfile
import unittest
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import apply_crowsnest_ai_usage_patch as patcher

PINNED = Path("/opt/hermes")


class PatcherTests(unittest.TestCase):
    def test_compressor_qualified_selection_and_inversion(self):
        import ast
        for module in ('agent.context_compressor', 'agent.conversation_compression'):
            row = next(row for row in patcher.PRD if row[0] == module)
            source = (PINNED / (module.replace('.', '/') + '.py')).read_text()
            target = Path('compressor.py')
            def emit(text):
                candidates = {}
                with patch.object(patcher, 'PRD', (row,)):
                    patcher.patch_auth_admission({target: text}, candidates, (target,))
                return candidates[target]
            emitted = emit(source)
            self.assertEqual(emit(emitted), emitted)
            tree = ast.parse(emitted)
            for name in row[2]:
                scope = tree
                for part in name.split('.'):
                    matches = [n for n in scope.body if getattr(n, 'name', None) == part]
                    self.assertEqual(len(matches), 1)
                    scope = matches[0]
                index = int(isinstance(scope.body[0], ast.Expr))
                guard = scope.body[index:index + 2]
                self.assertEqual(ast.unparse(guard[0]), 'from wolfhouse.luna_personality_isolation import current_isolated_turn, IsolationAbort')
                self.assertEqual(ast.unparse(guard[1]), "if current_isolated_turn() is not None:\n    raise IsolationAbort('auth_boundary_unsupported')")
                lines = emitted.splitlines(keepends=True)
                partial = ''.join(lines[:guard[0].lineno - 1] + lines[guard[1].end_lineno:])
                self.assertEqual(emit(partial), emitted)
                del scope.body[index:index + 2]
            self.assertEqual(ast.dump(tree), ast.dump(ast.parse(source)))
        fixture = 'class Decoy:\n    def __init__(self): pass\nclass ContextCompressor:\n    def __init__(self): pass\n'
        self.assertEqual(patcher._admission_owner(fixture, 'ContextCompressor.__init__').lineno, 4)
        for altered in (fixture.replace('ContextCompressor', 'Wrong'), fixture + fixture, fixture.replace('    def __init__(self): pass', '    def other(self): pass')):
            with self.assertRaisesRegex(RuntimeError, 'qualified lexical owner drift'):
                patcher._admission_owner(altered, 'ContextCompressor.__init__')

    def test_compressor_compile_and_restoration_omission_controls(self):
        self.test_auxiliary_compile_and_restoration_omission_controls('context_compressor', 10)
        self.test_auxiliary_compile_and_restoration_omission_controls('conversation_compression', 11)

    def copy_pinned(self, root):
        run_agent = root / "run_agent.py"
        runtime = root / "agent/codex_runtime.py"
        helper = root / "agent/chat_completion_helpers.py"
        runtime.parent.mkdir(parents=True)
        shutil.copy2(PINNED / "run_agent.py", run_agent)
        shutil.copy2(PINNED / "agent/codex_runtime.py", runtime)
        shutil.copy2(PINNED / "agent/chat_completion_helpers.py", helper)
        for path in (run_agent, runtime, helper):
            path.chmod(0o600)
        shutil.copy2(PINNED / "agent/conversation_loop.py", root / "agent/conversation_loop.py")
        (root / "agent/conversation_loop.py").chmod(0o600)
        for relative in ('agent/agent_init.py', 'hermes_cli/runtime_provider.py', 'hermes_cli/auth.py', 'agent/credential_pool.py', 'agent/auxiliary_client.py', 'agent/model_metadata.py', 'agent/context_compressor.py', 'agent/conversation_compression.py'):
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(PINNED / relative, target)
            target.chmod(0o600)
        return run_agent, runtime, helper

    def module_paths(self, paths):
        names = ('run_agent', 'agent.codex_runtime', 'agent.chat_completion_helpers', 'agent.conversation_loop',
                 'agent.agent_init', 'hermes_cli.runtime_provider', 'hermes_cli.auth', 'agent.credential_pool', 'agent.auxiliary_client', 'agent.model_metadata', 'agent.context_compressor', 'agent.conversation_compression')
        return {name: paths[0].parent / (name.replace('.', '/') + '.py') for name in names}

    def test_metadata_first_operation_ast_parity_and_each_repair(self):
        self.test_auxiliary_first_operation_ast_parity_and_each_repair('agent.model_metadata')

    def test_auxiliary_first_operation_ast_parity_and_each_repair(self, module='agent.auxiliary_client'):
        import ast
        row = next(row for row in patcher.PRD if row[0] == module)
        source = (PINNED / (module.replace('.', '/') + '.py')).read_text()
        target = Path('auxiliary.py')
        def emit(text):
            candidates = {}
            with patch.object(patcher, 'PRD', (row,)):
                patcher.patch_auth_admission({target: text}, candidates, (target,))
            return candidates[target]
        emitted = emit(source)
        self.assertEqual(emit(emitted), emitted)
        tree = ast.parse(emitted)
        for name in row[2]:
            node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
            self.assertIsInstance(node.body[1], ast.ImportFrom)
            self.assertEqual(ast.unparse(node.body[2]), "if current_isolated_turn() is not None:\n    raise IsolationAbort('auth_boundary_unsupported')")
            first, last = node.body[1].lineno, node.body[2].end_lineno
            lines = emitted.splitlines(keepends=True)
            partial = ''.join(lines[:first - 1] + lines[last:])
            self.assertEqual(emit(partial), emitted)
            del node.body[1:3]
        self.assertEqual(ast.dump(tree), ast.dump(ast.parse(source)))

    def test_metadata_compile_and_restoration_omission_controls(self):
        self.test_auxiliary_compile_and_restoration_omission_controls('model_metadata', 9)

    def test_auxiliary_compile_and_restoration_omission_controls(self, owner='auxiliary_client', index=8):
        source = Path(patcher.__file__).read_text()
        for old, new, probe in (
            ('compile(candidates[path], str(path), "exec")', 'compile("pass" if path.name == "auxiliary_client.py" else candidates[path], str(path), "exec")',
             lambda: PatcherTests().test_main_final_candidate_validation_precedes_all_writes(admission='agent.auxiliary_client')),
            ('for path, data in originals.items():', 'for path, data in originals.items():\n            if path.name == "auxiliary_client.py":\n                continue',
             lambda: PatcherTests().test_main_all_candidate_write_faults(targets=(8,))),
        ):
            old, new = old.replace('auxiliary_client', owner), new.replace('auxiliary_client', owner)
            if owner != 'auxiliary_client':
                probe = (lambda: PatcherTests().test_main_final_candidate_validation_precedes_all_writes(admission='agent.' + owner)) if old.startswith('compile') else (lambda: PatcherTests().test_main_all_candidate_write_faults(targets=(index,)))
            self.assertEqual(source.count(old), 1)
            namespace = {'__name__': 'mutant'}
            exec(compile(source.replace(old, new), 'patcher-mutant.py', 'exec'), namespace)
            original = patcher.main.__code__
            patcher.main.__code__ = namespace['main'].__code__
            try:
                with self.assertRaises(AssertionError):
                    probe()
            finally:
                patcher.main.__code__ = original
            self.assertIs(patcher.main.__code__, original)
            print('GENERATOR_OMISSION_KILLED', old, flush=True)
        self.test_main_final_candidate_validation_precedes_all_writes(admission='agent.' + owner)
        self.test_main_all_candidate_write_faults(targets=(index,))

    def test_auth_pool_fingerprint_rejection_before_write(self):
        import io
        for module, _, owners in patcher.PRD:
            for altered in ('drift', 'relocated'):
                with self.subTest(module=module, altered=altered), tempfile.TemporaryDirectory() as d:
                    names = self.module_paths(self.copy_pinned(Path(d)))
                    target = names[module]
                    candidates = {}
                    source = {target: target.read_text()}
                    with patch.object(patcher, 'PRD', ((module, next(row[1] for row in patcher.PRD if row[0] == module), owners),)):
                        patcher.patch_auth_admission(source, candidates, (target,))
                    text = candidates[target]
                    if altered == 'drift':
                        text += '\n# unexpected source drift\n'
                    else:
                        guard = '    from wolfhouse.luna_personality_isolation import current_isolated_turn, IsolationAbort\n    if current_isolated_turn() is not None:\n        raise IsolationAbort("auth_boundary_unsupported")\n'
                        if module in ('agent.credential_pool', 'agent.context_compressor'):
                            guard = ''.join('    ' + line for line in guard.splitlines(keepends=True))
                        indent = '        ' if module in ('agent.credential_pool', 'agent.context_compressor') else '    '
                        text = text.replace(guard, indent + 'if False:\n' + ''.join('    ' + line for line in guard.splitlines(keepends=True)), 1)
                        compile(text, str(target), 'exec')
                    target.write_text(text)
                    before = {p: p.read_bytes() for p in names.values()}
                    with patch.object(patcher, '_module_path', names.__getitem__), patch.object(Path, 'write_text', side_effect=AssertionError('write reached')), patch('sys.stderr', io.StringIO()):
                        self.assertEqual(patcher.main(), 1)
                    self.assertEqual({p: p.read_bytes() for p in names.values()}, before)

    def test_main_final_write_failure_restores_inputs(self):
        import io
        for crowsnest in (False, True):
            for partial, restore_denied in ((False, False), (True, False), (True, True)):
                with self.subTest(crowsnest=crowsnest, partial=partial, restore_denied=restore_denied), tempfile.TemporaryDirectory() as d:
                    paths = self.copy_pinned(Path(d))
                    if crowsnest:
                        patcher.patch_files(*paths)
                    before = [p.read_bytes() for p in paths]
                    names = self.module_paths(paths)
                    write_text, write_bytes = Path.write_text, Path.write_bytes
                    error = OSError('R1 final-helper-write denial')
                    def fail_final(path, text, *args, **kwargs):
                        if path == paths[2] and 'Request cancelled before client registration' in text:
                            if partial:
                                write_text(path, text[:31], *args, **kwargs)
                            raise error
                        return write_text(path, text, *args, **kwargs)
                    def restore(path, data):
                        if restore_denied and path == paths[2]:
                            raise OSError('R1 restore denial')
                        return write_bytes(path, data)
                    stderr = io.StringIO()
                    with patch.object(patcher, '_module_path', names.__getitem__), patch.object(Path, 'write_text', fail_final), patch.object(Path, 'write_bytes', restore), patch('sys.stderr', stderr):
                        self.assertEqual(patcher.main(), 1)
                    self.assertIn(str(error), stderr.getvalue())
                    after = [p.read_bytes() for p in paths]
                    if restore_denied:
                        self.assertIn('rollback failed', stderr.getvalue())
                        self.assertIn('R1 restore denial', stderr.getvalue())
                        self.assertEqual(after[:2], before[:2])
                        self.assertNotEqual(after[2], before[2])
                    else:
                        self.assertTrue(after == before, 'R1 failed main must restore every input byte')

    def test_worker_origin_inverse_repair_and_no_write_drift(self):
        import ast
        with tempfile.TemporaryDirectory() as d:
            paths = self.copy_pinned(Path(d))
            names = self.module_paths(paths)
            with patch.object(patcher, '_module_path', names.__getitem__):
                self.assertEqual(patcher.main(), 0)
                expected = {p: p.read_bytes() for p in names.values()}
                helper = paths[2]
                text = helper.read_text()
                node = patcher._admission_owner(text, 'interruptible_api_call')
                workers = [n for n in node.body if isinstance(n, ast.FunctionDef) and n.name == '_call']
                self.assertEqual(len(workers), 1)
                self.assertIsInstance(workers[0].body[0], ast.Try)
                self.assertEqual(workers[0].body[0].body[0].value.func.id, 'check_worker_origin')
                for old, new in patcher.WORKER_ORIGIN:
                    helper.write_text(patcher._b3e_replace(text, 'interruptible_api_call', ((old, new),), inverse=True))
                    self.assertEqual(patcher.main(), 0)
                    self.assertEqual(helper.read_text(), text)
                helper.write_text(text.replace('check_worker_origin(_worker_origin, agent)', 'check_worker_origin(None, agent)', 1))
                before = {p: p.read_bytes() for p in names.values()}
                with patch.object(Path, 'write_text', side_effect=AssertionError('drift wrote')):
                    self.assertEqual(patcher.main(), 1)
                self.assertEqual({p: p.read_bytes() for p in names.values()}, before)
                helper.write_bytes(expected[helper])
                self.assertEqual(patcher.main(), 0)
                self.assertEqual({p: p.read_bytes() for p in names.values()}, expected)

    def test_preparation_and_main_commit_exact_candidates(self):
        self.assertTrue(callable(getattr(patcher, 'prepare_files', None)), 'pure preparation boundary required')
        for state in ('pristine', 'crowsnest', 'b3d'):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as d:
                paths = self.copy_pinned(Path(d))
                if state != 'pristine':
                    patcher.patch_files(*paths)
                if state == 'b3d':
                    paths[2].write_text(patcher.patch_cancelled_registration(paths[2].read_text()))
                before = {p: p.read_text() for p in paths}
                with patch.object(Path, 'write_text', side_effect=AssertionError('preparation wrote')), patch.object(Path, 'write_bytes', side_effect=AssertionError('preparation wrote')):
                    originals, candidates, result = patcher.prepare_files(*paths)
                self.assertEqual(originals, before)
                self.assertEqual(set(candidates), set(paths))
                self.assertEqual(candidates[paths[0]], before[paths[0]])
                expected = dict(candidates)
                patcher.patch_codex_cancellation(expected, paths)
                self.assertEqual(result, {'changed': state == 'pristine', 'paths': [str(p) for p in paths[1:]]})
                writes = []
                write_text = Path.write_text
                def record(path, text, *args, **kwargs):
                    writes.append((path, text))
                    return write_text(path, text, *args, **kwargs)
                names = self.module_paths(paths)
                conversation = names['agent.conversation_loop']
                before[conversation] = conversation.read_text()
                expected[conversation] = patcher.patch_conversation_abort(before[conversation])
                admission = tuple(names[name] for name, *_ in patcher.PRC)
                before.update({p: p.read_text() for p in admission})
                patcher.patch_constructor_admission(before, expected, admission)
                auth_paths = tuple(names[name] for name, *_ in patcher.PRD)
                before.update({p: p.read_text() for p in auth_paths})
                patcher.patch_auth_admission(before, expected, auth_paths)
                admission += auth_paths
                with patch.object(patcher, '_module_path', names.__getitem__), patch.object(Path, 'write_text', record):
                    self.assertEqual(patcher.main(), 0)
                    self.assertEqual(patcher.main(), 0)
                self.assertTrue(all(p.read_text() == data for p, data in expected.items()), 'exact candidate bytes')
                self.assertTrue(writes == [(p, expected[p]) for p in (paths[1], paths[2], paths[0], conversation, *admission) if expected[p] != before[p]], 'only final changed candidates written once')

    def test_conversation_candidate_compile_precedes_writes(self):
        self.test_main_final_candidate_validation_precedes_all_writes(conversation=True)

    def test_prc_candidate_compile_precedes_writes(self):
        for name, *_ in (*patcher.PRC, *patcher.PRD):
            self.test_main_final_candidate_validation_precedes_all_writes(admission=name)

    def test_main_final_candidate_validation_precedes_all_writes(self, conversation=False, admission=None):
        import io
        with tempfile.TemporaryDirectory() as d:
            paths = self.copy_pinned(Path(d))
            before = [p.read_bytes() for p in paths]
            names = self.module_paths(paths)
            writes = []
            write_text = Path.write_text
            def record(path, text, *args, **kwargs):
                writes.append(path)
                return write_text(path, text, *args, **kwargs)
            transform = patcher.patch_codex_cancellation
            def invalid_final(candidates, paths):
                transform(candidates, paths)
                target = names[admission] if admission else paths[2].with_name('conversation_loop.py') if conversation else paths[2]
                candidates[target] = 'not valid python !'
            # Corrupt the final candidate after fingerprint validation, before compile/write.
            with patch.object(patcher, '_module_path', names.__getitem__), patch.object(patcher, 'patch_codex_cancellation', side_effect=invalid_final), patch.object(Path, 'write_text', record), patch('sys.stderr', io.StringIO()):
                status = patcher.main()
            self.assertEqual(status, 1, 'invalid final candidate must fail')
            self.assertEqual(writes, [], 'validate final candidates before any write')
            self.assertTrue([p.read_bytes() for p in paths] == before)

    def test_main_never_writes_intermediate_helper(self):
        with tempfile.TemporaryDirectory() as d:
            paths = self.copy_pinned(Path(d))
            names = self.module_paths(paths)
            writes = []
            write_text = Path.write_text
            def record(path, text, *args, **kwargs):
                if path == paths[2]:
                    writes.append('Request cancelled before client registration' in text)
                return write_text(path, text, *args, **kwargs)
            with patch.object(patcher, '_module_path', names.__getitem__), patch.object(Path, 'write_text', record):
                self.assertEqual(patcher.main(), 0)
            self.assertEqual(writes, [True], 'main must commit final helper only')

    def test_main_all_candidate_write_faults(self, targets=(1, 2, 0, 3, 4, 5, 6, 7, 8, 9)):
        import io
        self.assertTrue(callable(getattr(patcher, 'prepare_files', None)), 'candidate ownership boundary required')
        for target in targets:
            for fault in ('deny', 'partial', 'restore-denied', 'earlier-restore-denied'):
                with self.subTest(target=target, fault=fault), tempfile.TemporaryDirectory() as d:
                    paths = self.copy_pinned(Path(d))
                    names = self.module_paths(paths)
                    paths = tuple(names.values())
                    before = {p: p.read_bytes() for p in paths}
                    write_text, write_bytes = Path.write_text, Path.write_bytes
                    denied = paths[target] if fault == 'restore-denied' else paths[1] if fault == 'earlier-restore-denied' else None
                    restored = []
                    def fail(path, text, *args, **kwargs):
                        if path == paths[target]:
                            if fault != 'deny':
                                write_text(path, text[:31], *args, **kwargs)
                            raise OSError('B3e original write denial')
                        return write_text(path, text, *args, **kwargs)
                    def restore(path, data):
                        restored.append(path)
                        if path == denied:
                            raise OSError('B3e restore denial')
                        return write_bytes(path, data)
                    stderr = io.StringIO()
                    with patch.object(patcher, '_module_path', names.__getitem__), patch.object(Path, 'write_text', fail), patch.object(Path, 'write_bytes', restore), patch('sys.stderr', stderr):
                        self.assertEqual(patcher.main(), 1)
                    self.assertIn('B3e original write denial', stderr.getvalue())
                    self.assertTrue(all(p.read_bytes() == data for p, data in before.items() if p != denied), 'restore traversal must recover every non-denied input')
                    if denied is not None:
                        self.assertIn('rollback failed', stderr.getvalue())
                        self.assertIn('B3e restore denial', stderr.getvalue())
                        self.assertTrue(denied.read_bytes() != before[denied])
                    if fault == 'earlier-restore-denied' and target != 1:
                        self.assertIn(paths[target], restored, 'restoration must continue after earlier denial')

    def test_three_owner_drift_and_mixed_states_never_attempt_writes(self):
        import io
        for state in ('pristine', 'crowsnest', 'b3d', 'b3e'):
            for target in range(6):
                with self.subTest(state=state, target=target), tempfile.TemporaryDirectory() as d:
                    paths = self.copy_pinned(Path(d))
                    names = self.module_paths(paths)
                    if state != 'pristine':
                        patcher.patch_files(*paths)
                    if state == 'b3d':
                        paths[2].write_text(patcher.patch_cancelled_registration(paths[2].read_text()))
                    paths = tuple(names.values())
                    with patch.object(patcher, '_module_path', names.__getitem__):
                        before_patch = paths[target].read_bytes()
                        if state == 'b3e':
                            self.assertEqual(patcher.main(), 0)
                        for drift in (paths[target].read_bytes() + b'\n', before_patch):
                            if drift == before_patch and state != 'b3e':
                                continue
                            paths[target].write_bytes(drift)
                            before = [p.read_bytes() for p in paths]
                            with patch.object(Path, 'write_text') as wt, patch.object(Path, 'write_bytes') as wb, patch('sys.stderr', io.StringIO()):
                                self.assertEqual(patcher.main(), 1)
                            wt.assert_not_called()
                            wb.assert_not_called()
                            self.assertEqual([p.read_bytes() for p in paths], before)

    def load_patched_runtime(self, root):
        paths = self.copy_pinned(root)
        patcher.patch_files(*paths)
        spec = importlib.util.spec_from_file_location("crowsnest_patched_codex_runtime", paths[1])
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    @staticmethod
    def fake_agent():
        return SimpleNamespace(provider="openai-codex", _interrupt_requested=False,
            _fire_stream_delta=lambda _text: None, _fire_reasoning_delta=lambda _text: None,
            _touch_activity=lambda _reason: None, _client_log_context=lambda: "test")

    def test_realistic_attempt_sequences_emit_once_and_preserve_semantics(self):
        class Responses:
            def __init__(self, outcomes): self.outcomes = iter(outcomes)
            def create(self, **_kwargs):
                outcome = next(self.outcomes)
                if isinstance(outcome, BaseException): raise outcome
                return outcome
        class BrokenIterator:
            def __init__(self, exc): self.exc = exc
            def __iter__(self): return self
            def __next__(self): raise self.exc

        completed = [{"type": "response.completed", "response": {"status": "completed"}}]
        partial = [{"type": "response.output_text.delta", "delta": "usable"}]
        with tempfile.TemporaryDirectory() as d:
            runtime = self.load_patched_runtime(Path(d))
            from wolfhouse import crowsnest_ai_usage_reporter as reporter

            def exercise(outcomes):
                seen = []
                client = SimpleNamespace(responses=Responses(outcomes))
                with patch.object(reporter, "observe_attempt_failure", side_effect=lambda exc, *_a, **_k: seen.append(("failure", exc))), patch.object(reporter, "observe_attempt_result", side_effect=lambda result, *_a, **_k: seen.append(("result", result))):
                    result = runtime.run_codex_stream(self.fake_agent(), {"model": "gpt-test"}, client=client)
                return result, seen

            result, seen = exercise([ConnectionError("first"), completed])
            self.assertEqual([kind for kind, _ in seen], ["failure", "result"])
            self.assertIs(seen[-1][1], result)

            for stream, status, terminal in (
                (partial, "failed", None),
                ([{"type": "response.failed", "response": {"status": "failed"}}], "failed", "response.failed"),
                ([{"type": "response.incomplete", "response": {"status": "incomplete"}}], "incomplete", "response.incomplete"),
            ):
                result, seen = exercise([stream])
                self.assertEqual(len(seen), 1)
                self.assertIs(seen[0][1], result)
                self.assertEqual((result.status, result.terminal_event_type), (status, terminal))

            broken = RuntimeError("malformed iterator")
            with patch.object(reporter, "observe_attempt_failure") as observe, self.assertRaises(RuntimeError) as raised:
                runtime.run_codex_stream(self.fake_agent(), {"model": "gpt-test"}, client=SimpleNamespace(responses=Responses([BrokenIterator(broken)])))
            self.assertIs(raised.exception, broken)
            observe.assert_called_once()

            with patch.object(reporter, "observe_attempt_failure") as observe, self.assertRaises(RuntimeError):
                runtime.run_codex_stream(self.fake_agent(), {"model": "gpt-test"}, client=SimpleNamespace(responses=Responses([[]])))
            observe.assert_called_once()

            with patch.object(reporter, "observe_attempt_failure") as observe, self.assertRaises(Exception):
                runtime.run_codex_stream(self.fake_agent(), {"model": "gpt-test"}, client=SimpleNamespace(responses=Responses([[{"type": "error", "message": "provider rejected"}]])))
            observe.assert_called_once()

            failures = [ConnectionError("first"), ConnectionError("second")]
            with patch.object(reporter, "observe_attempt_failure") as observe, self.assertRaises(ConnectionError) as raised:
                runtime.run_codex_stream(self.fake_agent(), {"model": "gpt-test"}, client=SimpleNamespace(responses=Responses(failures)))
            self.assertIs(raised.exception, failures[1])
            self.assertEqual(observe.call_count, 2)

            for interrupt in (KeyboardInterrupt(), SystemExit(7)):
                with patch.object(reporter, "observe_attempt_failure") as observe, self.assertRaises(type(interrupt)) as raised:
                    runtime.run_codex_stream(self.fake_agent(), {"model": "gpt-test"}, client=SimpleNamespace(responses=Responses([interrupt])))
                self.assertIs(raised.exception, interrupt)
                observe.assert_not_called()

    def test_exact_actual_pinned_sources_patch_and_are_idempotent(self):
        with tempfile.TemporaryDirectory() as d:
            paths = self.copy_pinned(Path(d))
            first = patcher.patch_files(*paths)
            once = [p.read_bytes() for p in paths]
            second = patcher.patch_files(*paths)
            self.assertTrue(first["changed"])
            self.assertFalse(second["changed"])
            self.assertEqual([p.read_bytes() for p in paths], once)

    def test_corruption_and_drift_fail_closed_without_any_modification(self):
        for corrupt_index, mutation in ((1, lambda s: s.replace("active_client.responses.create(**stream_kwargs)", "active_client.responses.send(**stream_kwargs)")),
                                        (2, lambda s: s.replace('result["response"] = agent._run_codex_stream(', 'result["response"] = agent._run_other_stream(', 1))):
            with self.subTest(corrupt_index=corrupt_index), tempfile.TemporaryDirectory() as d:
                paths = self.copy_pinned(Path(d))
                paths[corrupt_index].write_text(mutation(paths[corrupt_index].read_text()))
                before = [p.read_bytes() for p in paths]
                with self.assertRaisesRegex(RuntimeError, "anchor"):
                    patcher.patch_files(*paths)
                self.assertEqual([p.read_bytes() for p in paths], before)

        with tempfile.TemporaryDirectory() as d:
            paths = self.copy_pinned(Path(d)); patcher.patch_files(*paths)
            paths[1].write_text(paths[1].read_text().replace(
                "_crowsnest_observe_result(final, _crowsnest_attempt_started)",
                "_crowsnest_observe_result_corrupted(final, _crowsnest_attempt_started)",
            ))
            before = [p.read_bytes() for p in paths]
            with self.assertRaisesRegex(RuntimeError, "corruption"):
                patcher.patch_files(*paths)
            self.assertEqual([p.read_bytes() for p in paths], before)

        for needle, replacement in (
            ("active_client.responses.create(**stream_kwargs)", "active_client.responses.send(**stream_kwargs)"),
            ("with guest_reply_context():", "with other_context():"),
            ("crowsnest_guest_reply_context_v2", "crowsnest_guest_reply_context_changed"),
        ):
            with self.subTest(post_patch_drift=needle), tempfile.TemporaryDirectory() as d:
                paths = self.copy_pinned(Path(d)); patcher.patch_files(*paths)
                target = paths[1] if "responses.create" in needle else paths[2]
                target.write_text(target.read_text().replace(needle, replacement, 1))
                before = [p.read_bytes() for p in paths]
                with self.assertRaisesRegex(RuntimeError, "corruption"):
                    patcher.patch_files(*paths)
                self.assertEqual([p.read_bytes() for p in paths], before)

    def test_each_authoritative_terminal_assignment_corruption_fails_closed_without_write(self):
        mutations = (
            ('terminal_status = "completed"', 'terminal_status = "failed"'),
            ('terminal_status = "incomplete"', 'terminal_status = "completed"'),
            ('terminal_status = "failed"', 'terminal_status = "incomplete"'),
            ('"response.completed" if saw_terminal and terminal_status == "completed"',
             '"response.completed" if terminal_status == "completed"'),
        )
        for needle, replacement in mutations:
            with self.subTest(needle=needle), tempfile.TemporaryDirectory() as d:
                paths = self.copy_pinned(Path(d))
                patcher.patch_files(*paths)
                runtime = paths[1].read_text()
                self.assertEqual(runtime.count(needle), 1)
                paths[1].write_text(runtime.replace(needle, replacement, 1))
                before = [p.read_bytes() for p in paths]
                with self.assertRaisesRegex(RuntimeError, "corruption"):
                    result = patcher.patch_files(*paths)
                    self.assertFalse(result["changed"], "corrupt prepatch must not be accepted unchanged")
                self.assertEqual([p.read_bytes() for p in paths], before)

    def test_patch_marks_only_main_turn_and_instruments_each_real_attempt(self):
        with tempfile.TemporaryDirectory() as d:
            paths = self.copy_pinned(Path(d)); patcher.patch_files(*paths)
            runtime, helper = paths[1].read_text(), paths[2].read_text()
            self.assertEqual(helper.count("from wolfhouse.crowsnest_ai_usage_reporter import guest_reply_context"), 1)
            self.assertEqual(helper.count("with guest_reply_context():"), 1)
            main = helper.index('reason="codex_stream_request",')
            marker = helper.index("with guest_reply_context():")
            summary = helper.index("iteration_limit_summary")
            self.assertLess(main, marker)
            self.assertLess(marker, summary)
            self.assertNotIn("guest_reply_context", helper[summary:])
            create = runtime.index("active_client.responses.create(**stream_kwargs)")
            attempt_start = runtime.rindex("monotonic()", 0, create)
            result_observer = runtime.index("_crowsnest_observe_result(final", create)
            self.assertLess(attempt_start, create)
            self.assertGreater(result_observer, create)
            self.assertEqual(runtime.count("_crowsnest_observe_failure(exc, _crowsnest_attempt_started)"), 4)
            self.assertEqual(runtime.count("except Exception as exc:\n            _crowsnest_observe_failure(exc, _crowsnest_attempt_started)"), 1)
            self.assertEqual(runtime.count("except Exception as exc:\n                _crowsnest_observe_failure(exc, _crowsnest_attempt_started)"), 1)
            self.assertIn('terminal_event_type="response.completed" if saw_terminal and terminal_status == "completed" else (', runtime)
            self.assertIn('terminal_status = "incomplete"', runtime)
            self.assertIn('terminal_status = "failed"', runtime)

    def test_old_outer_run_agent_wrapper_is_absent(self):
        with tempfile.TemporaryDirectory() as d:
            paths = self.copy_pinned(Path(d)); patcher.patch_files(*paths)
            run_agent = paths[0].read_text()
            self.assertNotIn("_run_codex_stream_without_crowsnest", run_agent)


if __name__ == "__main__":
    unittest.main()
