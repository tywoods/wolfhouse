import shutil
import tempfile
import unittest
from pathlib import Path

import apply_crowsnest_ai_usage_patch as patcher

PINNED = Path("/opt/hermes")


class PatcherTests(unittest.TestCase):
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
        return run_agent, runtime, helper

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
            self.assertEqual(runtime.count("_crowsnest_observe_failure(exc, _crowsnest_attempt_started)"), 2)
            self.assertIn('terminal_status = "incomplete"', runtime)
            self.assertIn('terminal_status = "failed"', runtime)

    def test_old_outer_run_agent_wrapper_is_absent(self):
        with tempfile.TemporaryDirectory() as d:
            paths = self.copy_pinned(Path(d)); patcher.patch_files(*paths)
            run_agent = paths[0].read_text()
            self.assertNotIn("_run_codex_stream_without_crowsnest", run_agent)


if __name__ == "__main__":
    unittest.main()
