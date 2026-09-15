import hashlib
import unittest
from pathlib import Path

import apply_luna_executor_handoff_patch as patcher
import apply_luna_live_loop_trace_patch as live_loop_patcher

PINNED = Path("/opt/hermes")


def _adapter_live_loop_hunk():
    for relative, anchor, replacement in live_loop_patcher.PATCHES:
        if relative == "agent/codex_responses_adapter.py":
            return anchor, replacement
    raise AssertionError("live-loop adapter hunk missing")


def _read_adapter():
    return (PINNED / "agent/codex_responses_adapter.py").read_text()


def _without_handoff(source):
    if patcher.ITEM_NEW in source:
        source = source.replace(patcher.ITEM_NEW, patcher.ITEM_OLD, 1)
        source = source.replace(patcher.FIELDS_NEW, patcher.FIELDS_OLD, 1)
    return source


class ExecutorHandoffPatchTests(unittest.TestCase):
    def test_current_lineage_accepts_handoff_reapply(self):
        source = _read_adapter()
        emitted = patcher.patch_text(source)
        self.assertEqual(patcher.patch_text(emitted), emitted)
        compile(emitted, "agent/codex_responses_adapter.py", "exec")
        self.assertEqual(emitted.count(patcher.ITEM_NEW), 1)
        self.assertEqual(emitted.count(patcher.FIELDS_NEW), 1)

    def test_ordered_live_loop_lineage_is_accepted_and_preserves_hook(self):
        source = _without_handoff(_read_adapter())
        anchor, replacement = _adapter_live_loop_hunk()
        if replacement not in source:
            self.assertEqual(source.count(anchor), 1)
            source = source.replace(anchor, replacement, 1)
        else:
            self.assertEqual(source.count(replacement), 1)
        self.assertEqual(
            hashlib.sha256(source.encode()).hexdigest(),
            patcher.LIVE_LOOP_ADAPTER_SHA256,
        )
        emitted = patcher.patch_text(source)
        self.assertEqual(patcher.patch_text(emitted), emitted)
        self.assertEqual(emitted.count(replacement), 1)
        self.assertEqual(emitted.count(patcher.ITEM_NEW), 1)
        self.assertEqual(emitted.count(patcher.FIELDS_NEW), 1)
        compile(emitted, "agent/codex_responses_adapter.py", "exec")
        with self.assertRaisesRegex(RuntimeError, "executor handoff adapter source fingerprint drift"):
            patcher.patch_text(source + "\n# unknown lineage\n")

    def test_unexpected_source_drift_fails_closed(self):
        source = _read_adapter()
        with self.assertRaisesRegex(RuntimeError, "executor handoff adapter source fingerprint drift"):
            patcher.patch_text(source + "\n# unknown lineage\n")

    def test_mixed_handoff_state_fails_closed(self):
        source = _without_handoff(_read_adapter())
        mixed = source.replace(patcher.ITEM_OLD, patcher.ITEM_NEW, 1)
        with self.assertRaisesRegex(RuntimeError, "executor handoff mixed patch state"):
            patcher.patch_text(mixed)

    def test_dockerfile_copies_and_gates_patcher(self):
        dockerfile = Path(__file__).parent / "Dockerfile"
        if not dockerfile.exists():
            self.skipTest("Dockerfile is not copied into the built image")
        text = dockerfile.read_text()
        self.assertIn("COPY apply_luna_executor_handoff_patch.py", text)
        self.assertIn("COPY test_luna_executor_handoff_patch.py", text)
        self.assertEqual(text.count("python /etc/hermes-staging/apply_luna_executor_handoff_patch.py"), 2)
        self.assertIn("test_luna_executor_handoff_patch", text)


if __name__ == "__main__":
    unittest.main()
