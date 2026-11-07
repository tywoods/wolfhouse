"""Offline source acceptance: command strings are data, never shell inputs."""
import ast
import json
import types
from unittest.mock import Mock
import unittest

import apply_terminal_lifecycle_diagnostic_patch as patcher

import terminal_gateway_lifecycle_diagnostic as guard
from test_terminal_lifecycle_diagnostic import RECORDED_COMMAND, _load_original


class DescriptorGrammarTests(unittest.TestCase):
    def test_recorded_input_is_classified_not_executed(self):
        _, original = _load_original()
        self.assertTrue(original(RECORDED_COMMAND))
        self.assertEqual(guard._classify_terminal_gateway_lifecycle_command(RECORDED_COMMAND), "allow")
        self.assertIsNone(guard.terminal_gateway_guard_error(RECORDED_COMMAND))


    def test_malformed_structure_with_descriptors_is_unsupported(self):
        for command in (
            "echo ok 2>&1 &&", "echo ok 2>&1 ||", "echo ok 2>&1 |",
            "&& echo ok 2>&1", "echo ok 2>&1 ;; true", "echo ok 2>&1 & & true",
            "(echo ok 2>&1", "echo ok 2>&1)", "{ echo ok 2>&1; }",
            "echo ok 2>&1 || ; true", "echo ok 2>&1\rhermes gateway restart",
            "echo ok 2>&1\vhermes gateway restart",
        ):
            with self.subTest(command=command):
                self.assertEqual(guard._classify_terminal_gateway_lifecycle_command(command), "unsupported")


    def test_combined_redirect_tail_remains_conservative(self):
        # A deliberate unsupported grammar boundary, not a lifecycle probe.
        # Only terminal redirections may follow a combined output-file redirect;
        # subsequent argv words require syntax this bounded parser does not accept.
        for command in ("echo hi &> out.txt extra", "&> out.txt echo hello", "echo hi &>> out.txt extra"):
            with self.subTest(command=command):
                self.assertEqual(guard._classify_terminal_gateway_lifecycle_command(command), "unsupported")
        for command in ("echo hi &> out.txt", "echo hi &>> out.txt", "echo hi &> out.txt 2>&1", "echo hi &> out.txt; echo ok"):
            with self.subTest(command=command):
                self.assertEqual(guard._classify_terminal_gateway_lifecycle_command(command), "allow")

    def test_closed_output_descriptor_grammar(self):
        for source in "12":
            for target in "12":
                redirect = f"{source}>&{target}"
                for command in (
                    f"echo ok {redirect}", f"{redirect} echo ok", f"echo {redirect} ok",
                    f"echo ok {redirect}>out.txt", f"echo ok {redirect} 2>err.txt",
                    f"echo ok {redirect} && true", f"echo ok {redirect} || true",
                    f"echo ok {redirect} | cat", f"echo ok {redirect}; true",
                    f"echo ok {redirect}\ntrue", f"echo ok {redirect} # comment",
                    f"sh -c 'echo ok {redirect}'", f"timeout 3 sh -c 'echo ok {redirect}'",
                ):
                    with self.subTest(command=command):
                        self.assertEqual(guard._classify_terminal_gateway_lifecycle_command(command), "allow")

    def test_other_descriptor_forms_and_expansions_stay_fail_closed(self):
        for tail in (
            ">&1", "0>&1", "2>&0", "3>&1", "2>&3", "02>&1", "2>&01",
            "22>&1", "2>&12", "2>&-", "2>&1-", "2<&1", "2>>&1", "2><&1",
            "2>&", "2>& 1", '2>&"1"', "2>&'1'", "2>&\\1", "2>&$FD",
            "2>&${FD}", "2>&$(date)", "2>&`date`", "2>&1suffix", "2>&1#text",
            "2>&1'text'", '2>&1""', "2>&1\\\n", "2>&1\\ ", "2>&1*", "2>&1?",
            "2>&1[0]", "2>&1${X}", "2>&1$(date)", "2>&1`date`", "2>&1{a,b}",
            "2>&1 <<<word", "2>&1 <<EOF", "2>&1 <(date)", "2>&1 >(date)",
            "2>&1 $HOME", "2>&1 `date`", "2>&1 $(date)", "2>&1 >", "2>&1 > #x",
            "2>&1 >2>&1", "2>&1\x00", "2>&1\u00a0true",
        ):
            with self.subTest(tail=tail):
                self.assertEqual(guard._classify_terminal_gateway_lifecycle_command("echo ok " + tail), "unsupported")

    def test_lifecycle_blocks_survive_redirect_positions_chains_and_wrappers(self):
        from test_terminal_lifecycle_diagnostic import LIFECYCLE_COMMANDS
        from shlex import quote
        for lifecycle in LIFECYCLE_COMMANDS:
            for redirect in ("1>&1", "1>&2", "2>&1", "2>&2"):
                for command in (
                    f"{redirect} {lifecycle}", f"{lifecycle} {redirect}",
                    f"echo ok {redirect}; {lifecycle}", f"echo ok {redirect} && {lifecycle}",
                    f"echo ok {redirect} || {lifecycle}", f"echo ok {redirect} | {lifecycle}",
                    f"echo ok {redirect} & {lifecycle}", f"echo ok {redirect}\n{lifecycle}",
                    "sh -c " + quote(f"{lifecycle} {redirect}"),
                    "timeout -s TERM 2 sudo -n sh -c " + quote(f"{lifecycle} {redirect}"),
                ):
                    with self.subTest(command=command):
                        self.assertNotEqual(guard._classify_terminal_gateway_lifecycle_command(command), "allow")
                        self.assertIsNotNone(guard.terminal_gateway_guard_error(command))
        for command in ("hermes 2>&1 gateway restart", "hermes gateway 2>&1 stop", "systemctl 2>&1 restart hermes-gateway"):
            self.assertEqual(guard._classify_terminal_gateway_lifecycle_command(command), "lifecycle")

    def test_unknown_wrappers_and_nested_shell_modes_remain_denied(self):
        wrappers = ("stdbuf", "ionice", "xargs", "watch", "taskset", "chrt", "numactl", "chroot",
                    "unshare", "nsenter", "prlimit", "setpriv", "runuser", "su", "doas", "flock",
                    "setsid", "systemd-run", "start-stop-daemon", "daemonize", "parallel", "eval", "source", "nice")
        for prefix in wrappers + ("sudo --bogus", "timeout --bogus 2", "bash -ic", "sh script.sh"):
            self.assertEqual(guard._classify_terminal_gateway_lifecycle_command(prefix + " echo ok 2>&1"), "unsupported")

    def test_literals_are_data_and_do_not_hide_following_executables(self):
        for command in ("echo '2>&1'", 'echo "2>&1"', "echo 'hermes gateway restart' 2>&1", "echo ok 2>&1 # hermes gateway restart"):
            self.assertEqual(guard._classify_terminal_gateway_lifecycle_command(command), "allow")
        self.assertEqual(guard._classify_terminal_gateway_lifecycle_command("echo '2>&1'; hermes gateway restart"), "lifecycle")
        self.assertEqual(guard._classify_terminal_gateway_lifecycle_command("echo ok 2>&1 # note\nhermes gateway restart"), "lifecycle")

    def test_limits_with_supported_duplication_remain_closed(self):
        self.assertEqual(guard._classify_terminal_gateway_lifecycle_command("echo ok 2>&1", 11), "allow")
        self.assertEqual(guard._classify_terminal_gateway_lifecycle_command("echo ok 2>&1", 12), "unsupported")
        self.assertEqual(guard._classify_terminal_gateway_lifecycle_command("echo " + "a" * 99990 + " 2>&1"), "allow")
        self.assertEqual(guard._classify_terminal_gateway_lifecycle_command("echo " + "a" * 99991 + " 2>&1"), "unsupported")

    def test_no_new_allows_in_non_descriptor_fuzz(self):
        import random
        _, original = _load_original()
        rng = random.Random(1579)
        alphabet = "abcgh '\"$`<>|&;(){}\\\n#*0123"
        for _ in range(2000):
            command = "".join(rng.choice(alphabet) for _ in range(rng.randrange(1, 65)))
            # This corpus contains no supported descriptor token. A supported
            # token corpus is exercised separately with exact positive/negative expectations.
            if any(token in command for token in ("1>&1", "1>&2", "2>&1", "2>&2")):
                continue
            if original(command):
                self.assertNotEqual(guard._classify_terminal_gateway_lifecycle_command(command), "allow", command)


def load_generated_guard(text):
    """Load only pure guard definitions; never import resident tool initialization."""
    import re
    import shlex
    functions = {
        "_looks_like_env_assignment", "_read_shell_token",
        "_classify_terminal_gateway_lifecycle_command",
        "_contains_terminal_gateway_lifecycle_command", "terminal_gateway_guard_error",
    }
    constants = {"_KINDS", "LIFECYCLE_DENIAL_ERROR", "UNSUPPORTED_DENIAL_ERROR"}
    nodes = []
    for node in ast.parse(text).body:
        if isinstance(node, ast.FunctionDef) and node.name in functions:
            nodes.append(node)
        elif isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in constants for t in node.targets):
            nodes.append(node)
    namespace = {"re": re, "shlex": shlex}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), "<pure-generated-guard>", "exec"), namespace)
    return namespace


class GeneratedSourceTests(unittest.TestCase):
    def test_actual_guard_and_approval_blocks_with_inert_executor(self):
        import textwrap
        from test_terminal_lifecycle_diagnostic import LIFECYCLE_COMMANDS
        original, _ = _load_original()
        patched = patcher.patch_text(original)
        tree = ast.parse(patched)
        terminal = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "terminal_tool")
        blocks = [n for n in ast.walk(terminal) if isinstance(n, ast.If)]
        hard = next(n for n in blocks if ast.unparse(n.test) == "os.environ.get('_HERMES_GATEWAY') == '1'")
        normal = next(n for n in blocks if ast.unparse(n.test) == "not force")
        self.assertLess(hard.lineno, normal.lineno)
        self.assertNotIn("force", ast.unparse(hard.test))
        lines = patched.splitlines(keepends=True)
        body = "".join(textwrap.indent(textwrap.dedent("".join(lines[n.lineno - 1:n.end_lineno])), "    ") for n in (hard, normal))
        namespace = load_generated_guard(patched)
        approval = Mock(return_value={"approved": True})
        executor = Mock(return_value="INERT_BACKEND")
        namespace.update(os=types.SimpleNamespace(environ={"_HERMES_GATEWAY": "1"}), json=json,
                         _check_all_guards=approval, executor=executor, env_type="local")
        exec("def gate(command, force):\n" + body + "    return executor(command)\n", namespace)
        # The backend here is only a Mock. Neither a shell nor the real terminal
        # function is loaded. The recorded incident is used above as pure data only.
        for command in (*LIFECYCLE_COMMANDS, "echo $(date)", "echo ok 2>&3", "echo ok 2>&1 &&"):
            for force in (False, True):
                approval.reset_mock()
                executor.reset_mock()
                result = json.loads(namespace["gate"](command, force))
                self.assertEqual((result["exit_code"], result["status"]), (1, "error"))
                approval.assert_not_called()
                executor.assert_not_called()
        approval.reset_mock()
        executor.reset_mock()
        approval.return_value = {"approved": False, "message": "NORMAL_APPROVAL_DENIAL"}
        result = json.loads(namespace["gate"]("echo ok 2>&1", False))
        self.assertEqual(result["error"], "NORMAL_APPROVAL_DENIAL")
        approval.assert_called_once_with("echo ok 2>&1", "local")
        executor.assert_not_called()
        approval.return_value = {"approved": True}
        self.assertEqual(namespace["gate"]("echo ok 2>&1", False), "INERT_BACKEND")
        executor.assert_called_once_with("echo ok 2>&1")

    def test_every_byte_outside_guard_splices_is_preserved(self):
        original, _ = _load_original()
        patched = patcher.patch_text(original)
        start = original.index(patcher.FUNCTION_START)
        end = original.index(patcher.NEXT_FUNCTION, start)
        restored = patched.replace(patcher.replacement_block(), original[start:end], 1)
        restored = restored.replace(patcher.call_site_new(), patcher.CALL_SITE_OLD, 1)
        restored = restored.replace("\nimport shlex\n", "\n", 1)
        self.assertEqual(restored, original)
        # This includes the simulation/send guard, normal approvals, backend code,
        # original token helper, and every other resident source byte.

    def test_patched_marker_does_not_trust_modified_source(self):
        original, _ = _load_original()
        patched = patcher.patch_text(original)
        tampered = patched.replace('if _depth >= 12', 'if _depth >= 120')
        self.assertNotEqual(patched, tampered)
        with self.assertRaises(patcher.PatchError):
            patcher.patch_text(tampered)
        with self.assertRaises(patcher.PatchError):
            patcher.validate_patched_source(tampered)

    def test_generated_error_helper_has_all_runtime_dependencies(self):
        original, _ = _load_original()
        namespace = load_generated_guard(patcher.patch_text(original))
        self.assertIsNone(namespace["terminal_gateway_guard_error"](RECORDED_COMMAND))
        self.assertEqual(namespace["terminal_gateway_guard_error"]("hermes gateway restart"), guard.LIFECYCLE_DENIAL_ERROR)
        self.assertEqual(namespace["terminal_gateway_guard_error"]("echo $(date)"), guard.UNSUPPORTED_DENIAL_ERROR)


if __name__ == "__main__":
    unittest.main()
