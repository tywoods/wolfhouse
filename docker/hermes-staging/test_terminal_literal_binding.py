"""Closed literal-binding tests. Command strings are data and are never executed."""

from __future__ import annotations

import ast
import json
import textwrap
import types
import unittest
from unittest.mock import Mock

import apply_terminal_lifecycle_diagnostic_patch as patcher
import terminal_gateway_lifecycle_diagnostic as guard
from test_terminal_descriptor_grammar import load_generated_guard
from test_terminal_lifecycle_diagnostic import LIFECYCLE_COMMANDS, _load_original

# Retained incident text. Classification and an inert approval mock only.
INCIDENT = (
    "set -euo pipefail; "
    "out=/tmp/wolfhouse-5c268fc0dc3c9aed1620fe0c8b33ffe240176223.tar.gz; "
    'git archive --format=tar.gz -o "$out" 5c268fc0dc3c9aed1620fe0c8b33ffe240176223; '
    'sha256sum "$out"; scp "$out" france:/tmp/'
)


def _gate(patched):
    tree = ast.parse(patched)
    terminal = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "terminal_tool")
    blocks = [node for node in ast.walk(terminal) if isinstance(node, ast.If)]
    hard = next(node for node in blocks if ast.unparse(node.test) == "os.environ.get('_HERMES_GATEWAY') == '1'")
    normal = next(node for node in blocks if ast.unparse(node.test) == "not force")
    lines = patched.splitlines(keepends=True)
    body = "".join(
        textwrap.indent(textwrap.dedent("".join(lines[node.lineno - 1:node.end_lineno])), "    ")
        for node in (hard, normal)
    )
    namespace = load_generated_guard(patched)
    approval = Mock(return_value={"approved": False, "message": "NORMAL_APPROVAL_DENIAL"})
    executor = Mock(return_value="INERT_BACKEND")
    namespace.update(
        os=types.SimpleNamespace(environ={"_HERMES_GATEWAY": "1"}),
        json=json,
        _check_all_guards=approval,
        executor=executor,
        env_type="local",
    )
    exec("def gate(command, force):\n" + body + "    return executor(command)\n", namespace)  # noqa: S102
    return namespace["gate"], approval, executor, hard, normal


class LiteralBindingTests(unittest.TestCase):
    def test_incident_reaches_approval_as_the_original_command(self):
        self.assertEqual(guard._classify_terminal_gateway_lifecycle_command(INCIDENT), "allow")
        self.assertIsNone(guard.terminal_gateway_guard_error(INCIDENT))
        original, _ = _load_original()
        patched = patcher.patch_text(original)
        gate, approval, executor, hard, normal = _gate(patched)
        self.assertLess(hard.lineno, normal.lineno)
        self.assertNotIn("force", ast.unparse(hard.test))
        result = json.loads(gate(INCIDENT, False))
        self.assertEqual(result["error"], "NORMAL_APPROVAL_DENIAL")
        approval.assert_called_once_with(INCIDENT, "local")
        executor.assert_not_called()

    def test_descriptor_duplication_still_allows_and_other_descriptors_do_not(self):
        self.assertEqual(guard._classify_terminal_gateway_lifecycle_command('echo ok 2>&1'), "allow")
        self.assertEqual(guard._classify_terminal_gateway_lifecycle_command('echo ok 2>&3'), "unsupported")
        self.assertEqual(guard._classify_terminal_gateway_lifecycle_command('echo ok >&1'), "unsupported")

    def test_resolved_data_arguments_keep_lifecycle_denial(self):
        denied = (
            'action=restart; hermes gateway "$action"',
            'action=restart; hermes gateway "${action}"',
            'unit=hermes-gateway; systemctl restart "$unit"',
            'svc=hermes; systemctl "$svc" restart',
            'bin=hermes; sudo "$bin" gateway restart',
            'out=/tmp/safe; out=hermes-gateway; systemctl stop "$out"',
            'out=gateway; echo ok && hermes "$out" restart',
            'name=hermes-gateway; kill "$name"',
        )
        for command in denied:
            with self.subTest(command=command):
                self.assertEqual(guard._classify_terminal_gateway_lifecycle_command(command), "lifecycle")
                self.assertEqual(guard.terminal_gateway_guard_error(command), guard.LIFECYCLE_DENIAL_ERROR)
        for command in LIFECYCLE_COMMANDS:
            self.assertNotEqual(guard._classify_terminal_gateway_lifecycle_command(command), "allow")

    def test_unproved_expansion_and_hidden_executables_stay_closed(self):
        denied = (
            'echo "$out"',
            'echo $out',
            'echo "${out}"',
            'echo "$(date)"',
            "echo `date`",
            'echo "${out:-/tmp}"',
            'echo "${!out}"',
            'echo "$((1+1))"',
            'out=/tmp/foo; echo $out',
            'out=/tmp/foo; echo "$out extra"',
            'out=/tmp/foo; echo "${out}/x"',
            'out="$(date)"; echo "$out"',
            'out=~/secret; echo "$out"',
            'out=/tmp/*; echo "$out"',
            'out=/tmp/foo; unset out; echo "$out"',
            'out=/tmp/foo; export out; echo "$out"',
            'out=/tmp/foo; set -a; echo "$out"',
            'out=/tmp/foo | echo "$out"',
            'out=/tmp/foo || echo "$out"',
            'out=/tmp/foo echo "$out"',
            'out=echo; "$out" hi',
            'bin=systemctl; "$bin" restart hermes-gateway',
            'out=/tmp/foo; echo hi > "$out"',
            'out=/tmp/foo; sh -c \'echo "$out"\'',
            'out=/tmp/foo; sh -c "echo \\"$out\\""',
            "echo ok 2>&$FD",
            "echo $(hermes gateway restart)",
        )
        for command in denied:
            with self.subTest(command=command):
                self.assertEqual(guard._classify_terminal_gateway_lifecycle_command(command), "unsupported", command)

    def test_same_list_literal_references_are_data(self):
        allowed = (
            'out=/tmp/wolfhouse-5c268fc0dc3c9aed1620fe0c8b33ffe240176223.tar.gz; sha256sum "$out"',
            'out=/tmp/box; sha256sum "${out}"',
            'set -euo pipefail; out=/tmp/box; echo "$out"',
            'out=/tmp/a; out=/tmp/b; echo "$out"',
            'out=/tmp/box && echo "$out"',
            'dest=france:/tmp; echo "$dest"',
        )
        for command in allowed:
            with self.subTest(command=command):
                self.assertEqual(guard._classify_terminal_gateway_lifecycle_command(command), "allow", command)

    def test_force_still_cannot_bypass_a_denial(self):
        original, _ = _load_original()
        gate, approval, executor, _hard, _normal = _gate(patcher.patch_text(original))
        for command in (
            'action=restart; hermes gateway "$action"',
            'echo "$(date)"',
            'echo "$missing"',
            *LIFECYCLE_COMMANDS,
        ):
            for force in (False, True):
                approval.reset_mock()
                executor.reset_mock()
                result = json.loads(gate(command, force))
                self.assertEqual((result["exit_code"], result["status"]), (1, "error"), command)
                approval.assert_not_called()
                executor.assert_not_called()


if __name__ == "__main__":
    unittest.main()
