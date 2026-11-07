"""Non-executing preservation tests for the resident terminal lifecycle guard.

Strings in this file are classifier inputs. None of them are passed to a shell.
"""

from __future__ import annotations

import ast
import hashlib
import inspect
import random
import re
import shlex
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import apply_terminal_lifecycle_diagnostic_patch as patcher
import terminal_gateway_lifecycle_diagnostic as diagnostic

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "fixtures" / "hermes-resident-terminal-tool" / "terminal_tool.py"
EXPECTED_SHA256 = "01fde249886999f2ed7de936ac610221214572abf8d0baaff008670d59be7dc1"
RECORDED_COMMAND = (
    "gh pr view 1578 --repo Wolfhouse-Surf-Camp/WH --json "
    "number,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,"
    "mergeStateStatus,statusCheckRollup,url 2>&1 || true"
)

LIFECYCLE_COMMANDS = (
    "hermes gateway restart",
    "hermes gateway stop",
    "hermes gateway start",
    "HERMES GATEWAY RESTART",
    "/usr/local/bin/hermes gateway restart",
    "sudo -n hermes gateway restart",
    "sudo --user root hermes gateway stop",
    "env hermes gateway stop",
    "timeout 5 hermes gateway restart",
    "timeout --signal TERM 2 hermes gateway stop",
    "command -p hermes gateway start",
    "sh -c 'hermes gateway restart'",
    "bash -lc 'systemctl restart hermes-gateway'",
    "systemctl restart hermes-gateway",
    "systemctl --user stop hermes",
    "launchctl kickstart gui/501/ai.hermes.gateway",
    "launchctl stop hermes",
    "kill hermes gateway",
    "pkill -f hermes-gateway",
    "FOO=1 hermes gateway restart",
)

UNSUPPORTED_COMMANDS = (
    RECORDED_COMMAND,
    "gh pr view 1578 --repo Wolfhouse-Surf-Camp/WH --json number 2>&1",
    "echo hi 2>&1",
    "echo hi >&1",
    "echo hi >>&1",
    "cat <<EOF",
    "echo $(date)",
    "echo `date`",
    "sh script.sh",
    "bash -ic 'hermes gateway restart'",
    "xargs rm",
    "eval echo hi",
    "nice hermes gateway restart",
    "sudo --bogus hermes gateway restart",
    "timeout hermes gateway restart",
    "sh -c",
    "*",
    "echo hi \\\n",
    "hermes gateway restart >",
)

ALLOW_COMMANDS = (
    "",
    "echo hello",
    "gh pr view 1578 --repo Wolfhouse-Surf-Camp/WH --json number,state,url",
    "hermes gateway status",
    "hermes chat",
    "systemctl status nginx",
    "launchctl print system",
    "kill 1234",
    "pkill hermes",
    "pkill gateway",
    "echo 'hermes gateway restart'",
    "echo '2>&1'",
    "command -v hermes",
    "echo hi > out.txt",
    "echo hi >> out.txt",
    "echo hi 2> err.txt",
    "echo hi &> out.txt",
    "FOO=bar echo hi",
    "sh -c 'echo ok'",
    "sh -c echo ok",
)


def _load_original():
    text = FIXTURE.read_text(encoding="utf-8")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    if digest != EXPECTED_SHA256:
        raise AssertionError(f"fixture hash {digest}")
    tree = ast.parse(text)
    wanted = (
        "_looks_like_env_assignment",
        "_read_shell_token",
        "_contains_terminal_gateway_lifecycle_command",
    )
    chunks = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in wanted:
            segment = ast.get_source_segment(text, node)
            if not segment:
                raise AssertionError(f"missing source for {node.name}")
            chunks.append(segment)
    if [ast.parse(chunk).body[0].name for chunk in chunks] != list(wanted):  # type: ignore[attr-defined]
        raise AssertionError("resident helper extraction order drifted")
    namespace = {"re": re}
    exec("\n\n".join(chunks), namespace)  # noqa: S102 — load resident pure functions, no shell
    return text, namespace["_contains_terminal_gateway_lifecycle_command"]


def _nested_sh(payload: str, depth: int) -> str:
    command = payload
    for _ in range(depth):
        command = "sh -c " + shlex.quote(command)
    return command


class ResidentClassifierParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        text, function = _load_original()
        cls.resident_text = text
        # Keep the pure function unbound. A raw function stored on a TestCase
        # becomes a bound method and would receive the test instance as command.
        cls.original = staticmethod(function)

    def assert_same_denial(self, command: str):
        resident_denies = bool(self.original(command))
        kind = diagnostic._classify_terminal_gateway_lifecycle_command(command)
        self.assertIn(kind, {"allow", "lifecycle", "unsupported"})
        self.assertEqual(resident_denies, kind != "allow", command)
        self.assertEqual(
            resident_denies,
            diagnostic._contains_terminal_gateway_lifecycle_command(command),
            command,
        )
        error = diagnostic.terminal_gateway_guard_error(command)
        if kind == "allow":
            self.assertIsNone(error)
        elif kind == "lifecycle":
            self.assertEqual(error, diagnostic.LIFECYCLE_DENIAL_ERROR)
            self.assertNotIn("unsupported shell syntax", error)
        else:
            self.assertEqual(error, diagnostic.UNSUPPORTED_DENIAL_ERROR)
            self.assertNotIn("SIGTERM", error)
            self.assertNotIn("hermes gateway restart", error)

    def test_fixture_is_the_recovered_resident_bytes(self):
        self.assertEqual(FIXTURE.stat().st_size, 129880)
        self.assertIn("def _contains_terminal_gateway_lifecycle_command", self.resident_text)
        self.assertNotIn("wolfhouse_terminal_lifecycle_diagnostic_v1", self.resident_text)

    def test_helpers_match_the_resident_source(self):
        resident = ast.parse(self.resident_text)
        for name in ("_looks_like_env_assignment", "_read_shell_token"):
            resident_node = next(node for node in resident.body if isinstance(node, ast.FunctionDef) and node.name == name)
            current = ast.parse(inspect_source(name))
            self.assertEqual(
                ast.dump(resident_node, include_attributes=False),
                ast.dump(current.body[0], include_attributes=False),
                name,
            )

    def test_recorded_descriptor_duplication_stays_denied_as_syntax(self):
        self.assertTrue(self.original(RECORDED_COMMAND))
        self.assertEqual(
            diagnostic._classify_terminal_gateway_lifecycle_command(RECORDED_COMMAND),
            "unsupported",
        )
        error = diagnostic.terminal_gateway_guard_error(RECORDED_COMMAND)
        self.assertEqual(error, diagnostic.UNSUPPORTED_DENIAL_ERROR)
        self.assertNotEqual(error, diagnostic.LIFECYCLE_DENIAL_ERROR)

    def test_confirmed_lifecycle_commands_keep_the_resident_sentence(self):
        for command in LIFECYCLE_COMMANDS:
            with self.subTest(command=command):
                self.assertTrue(self.original(command))
                self.assertEqual(
                    diagnostic._classify_terminal_gateway_lifecycle_command(command),
                    "lifecycle",
                )
                self.assert_same_denial(command)

    def test_unsupported_forms_stay_denied_and_are_not_lifecycle(self):
        for command in UNSUPPORTED_COMMANDS:
            with self.subTest(command=command):
                self.assertTrue(self.original(command), command)
                self.assertEqual(
                    diagnostic._classify_terminal_gateway_lifecycle_command(command),
                    "unsupported",
                )
                self.assert_same_denial(command)

    def test_resident_allows_stay_allows(self):
        for command in ALLOW_COMMANDS:
            with self.subTest(command=command):
                self.assertFalse(self.original(command), command)
                self.assertEqual(
                    diagnostic._classify_terminal_gateway_lifecycle_command(command),
                    "allow",
                )
                self.assertIsNone(diagnostic.terminal_gateway_guard_error(command))

    def test_depth_and_length_limits_stay_fail_closed(self):
        self.assertFalse(self.original("echo ok", 11))
        self.assertTrue(self.original("echo ok", 12))
        self.assertEqual(
            diagnostic._classify_terminal_gateway_lifecycle_command("echo ok", 11),
            "allow",
        )
        self.assertEqual(
            diagnostic._classify_terminal_gateway_lifecycle_command("echo ok", 12),
            "unsupported",
        )
        self.assert_same_denial("a" * 100_000)
        oversized = "a" * 100_001
        self.assertTrue(self.original(oversized))
        self.assertEqual(
            diagnostic._classify_terminal_gateway_lifecycle_command(oversized),
            "unsupported",
        )
        self.assert_same_denial(oversized)

    def test_force_is_not_a_bypass_parameter(self):
        self.assertEqual(
            diagnostic._classify_terminal_gateway_lifecycle_command.__code__.co_varnames[:2],
            ("command", "_depth"),
        )
        self.assertNotIn("force", diagnostic.terminal_gateway_guard_error.__code__.co_varnames)

    def test_deterministic_inputs_match_the_resident_denial_bit(self):
        rng = random.Random(20261107)
        alphabet = "abcgh '\"$`<>|&;(){}\\\n#*"
        samples = list(LIFECYCLE_COMMANDS) + list(UNSUPPORTED_COMMANDS) + list(ALLOW_COMMANDS)
        samples.append(_nested_sh("hermes gateway restart", 3))
        samples.append("echo hi; hermes gateway stop")
        samples.append("echo hi | hermes gateway restart")
        for _ in range(180):
            samples.append("".join(rng.choice(alphabet) for _ in range(rng.randint(0, 48))))
        for command in samples:
            with self.subTest(command=command):
                self.assert_same_denial(command)


def inspect_source(name: str) -> str:
    return inspect.getsource(getattr(diagnostic, name))


class PatchApplicationTests(unittest.TestCase):
    def test_refuses_live_install_and_the_evidence_fixture(self):
        self.assertTrue(patcher.path_is_forbidden(Path("/opt/hermes/tools/terminal_tool.py")))
        self.assertTrue(patcher.path_is_forbidden(Path("/opt/data/workspace/terminal_tool.py")))
        self.assertTrue(patcher.path_is_forbidden(Path("/var/lib/hermes-orchestrator/terminal_tool.py")))
        with self.assertRaises(patcher.PatchError):
            patcher.assert_target_allowed(Path("/opt/hermes/tools/terminal_tool.py"))
        with self.assertRaises(patcher.PatchError):
            patcher.assert_target_allowed(FIXTURE)

    def test_patch_copy_preserves_denials_and_leaves_the_fixture_unchanged(self):
        before = hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "terminal_tool.py"
            shutil.copyfile(FIXTURE, target)
            check = subprocess.run(
                ["python3", str(Path(patcher.__file__)), "--check", "--terminal-tool", str(target)],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(check.returncode, 0, check.stderr)
            self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), EXPECTED_SHA256)
            applied = subprocess.run(
                ["python3", str(Path(patcher.__file__)), "--terminal-tool", str(target)],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(applied.returncode, 0, applied.stderr)
            patched = target.read_text(encoding="utf-8")
            self.assertIn(patcher.MARKER, patched)
            self.assertIn(diagnostic.LIFECYCLE_DENIAL_ERROR, patched)
            self.assertIn(diagnostic.UNSUPPORTED_DENIAL_ERROR, patched)
            self.assertNotEqual(hashlib.sha256(patched.encode("utf-8")).hexdigest(), EXPECTED_SHA256)
            ast.parse(patched)
            again = subprocess.run(
                ["python3", str(Path(patcher.__file__)), "--terminal-tool", str(target)],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertIn("changed=False", again.stdout)
            self.assertEqual(target.read_text(encoding="utf-8"), patched)
            loaded = _load_patched_classifier(patched)
            self.assertEqual(loaded(RECORDED_COMMAND), "unsupported")
            self.assertEqual(loaded("hermes gateway restart"), "lifecycle")
            self.assertEqual(loaded("echo hello"), "allow")
            self.assertEqual(loaded("echo hi > out.txt"), "allow")
        self.assertEqual(hashlib.sha256(FIXTURE.read_bytes()).hexdigest(), before)

    def test_wrong_hash_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "terminal_tool.py"
            target.write_text("def _contains_terminal_gateway_lifecycle_command(command):\n    return False\n", encoding="utf-8")
            result = subprocess.run(
                ["python3", str(Path(patcher.__file__)), "--terminal-tool", str(target)],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn(EXPECTED_SHA256, result.stderr)
            self.assertNotIn(patcher.MARKER, target.read_text(encoding="utf-8"))


def _load_patched_classifier(text: str):
    tree = ast.parse(text)
    segment = next(
        ast.get_source_segment(text, node)
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "_classify_terminal_gateway_lifecycle_command"
    )
    helpers = []
    for name in ("_looks_like_env_assignment", "_read_shell_token"):
        helpers.append(next(
            ast.get_source_segment(text, node)
            for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name == name
        ))
    namespace = {"re": re, "shlex": shlex}
    exec("\n\n".join(helpers + [segment]), namespace)  # noqa: S102 — pure classifier, no shell
    return namespace["_classify_terminal_gateway_lifecycle_command"]


if __name__ == "__main__":
    unittest.main()
