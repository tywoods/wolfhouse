#!/usr/bin/env python3
"""MAIL-MVP-007 hotfix: KV bearer/HMAC must be exact 64 hex bytes, no newline.

A heredoc piped to `az keyvault secret set --file /dev/stdin` appends a
newline. ACA injects that byte; the draft server correctly rejects
leading/trailing whitespace and crashloops. Generation must use 0600 mktemp
files populated by secrets.token_hex(32) + write() (no newline), then
`--file` and shred. Never keep $TOKEN in the shell.
"""

from __future__ import annotations

import io
import os
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

STAGING = Path(__file__).resolve().parents[1]
REPO = STAGING.parent.parent
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))

from wolfhouse.email_draft_replay import ReplayCache  # noqa: E402
from wolfhouse.email_draft_server import (  # noqa: E402
    handle_draft_request,
    main as draft_server_main,
)

RUNBOOK = REPO / "docs/MAIL-MVP-007-SUNSET-EMAIL-SOL-RUNBOOK.md"
VERIFIER = REPO / "scripts/verify-email-luna-sunset-email-hermes-sol.js"
INSTANCE = STAGING / "verify_sunset_email_luna_instance.py"
HEX64 = re.compile(rb"^[0-9a-f]{64}\Z")
AZ_STUB = r'''#!/usr/bin/env python3
import os
import re
import sys
from pathlib import Path

proof = Path(os.environ["MAIL_MVP_007_SECRET_PROOF"])
args = sys.argv[1:]
if args[:3] != ["keyvault", "secret", "set"]:
    sys.stderr.write("unexpected az argv\n")
    raise SystemExit(1)
joined = " ".join(args)
if "--value" in args or "/dev/stdin" in args:
    sys.stderr.write("refuse: argv or stdin secret method\n")
    raise SystemExit(1)
if "--file" not in args or "--name" not in args:
    sys.stderr.write("refuse: missing --file/--name\n")
    raise SystemExit(1)
name = args[args.index("--name") + 1]
path = Path(args[args.index("--file") + 1])
raw = path.read_bytes()
mode = path.stat().st_mode & 0o777
exact = bool(re.fullmatch(rb"[0-9a-f]{64}", raw))
newline = b"\n" in raw or b"\r" in raw
secret = raw.decode("ascii") if exact else ""
if secret and secret in joined:
    sys.stderr.write("refuse: secret in argv\n")
    raise SystemExit(1)
line = (
    f"name={name} len={len(raw)} mode={mode:o} exact_hex={exact} "
    f"newline={newline} stdin={path.as_posix() == '/dev/stdin'}\n"
)
if secret and secret in line:
    sys.stderr.write("refuse: proof would leak secret\n")
    raise SystemExit(1)
with proof.open("a", encoding="utf-8") as fh:
    fh.write(line)
'''


def _runbook() -> str:
    return RUNBOOK.read_text(encoding="utf-8")


def _section5(runbook: str) -> str:
    match = re.search(
        r"^### 5\. Bearer \+ response HMAC secrets.*?\n(.*?)(?=^### |\Z)",
        runbook,
        re.M | re.S,
    )
    if not match:
        raise AssertionError("runbook missing section 5")
    return match.group(0)


def _fenced_bash(section: str) -> str:
    match = re.search(r"```bash\n(.*?)```", section, re.S)
    if not match:
        raise AssertionError("section 5 missing bash fence")
    return match.group(1)


def _python_blocks(bash: str) -> list[str]:
    return re.findall(r"python3 - \"\$TOKEN_FILE\" \"\$HMAC_FILE\" <<'PY'.*?\n(.*?)PY", bash, re.S)


class HeredocSecretMethodFailsTests(unittest.TestCase):
    def test_heredoc_appends_newline_and_server_rejects(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "from-heredoc"
            hex_secret = "ab" * 32
            script = f"""
set -eu
TOKEN={hex_secret}
cat > "{dest}" <<TOKEN_EOF
$TOKEN
TOKEN_EOF
"""
            subprocess.run(["bash", "-c", script], check=True, capture_output=True, text=True)
            raw = dest.read_bytes()
            self.assertEqual(raw, hex_secret.encode("ascii") + b"\n")
            self.assertTrue(raw.endswith(b"\n"))
            self.assertEqual(len(raw), 65)
            self.assertIsNone(HEX64.match(raw))
            status, payload = handle_draft_request(
                raw_body=b"{}",
                authorization="Bearer tok",
                expected_token="tok",
                invoke=lambda _s, _u: None,
                replay=ReplayCache(),
                hmac_secret=raw.decode("utf-8"),
            )
            self.assertEqual(status, 500)
            self.assertEqual(payload["error"], "hmac_unconfigured")
            self.assertNotIn("provenance", payload)

    def test_echo_and_printf_newline_are_not_exact_hex(self):
        with tempfile.TemporaryDirectory() as tmp:
            echoed = Path(tmp) / "echoed"
            printed = Path(tmp) / "printed"
            hex_secret = "cd" * 32
            subprocess.run(
                ["bash", "-c", f"echo '{hex_secret}' > '{echoed}'; printf '%s\\n' '{hex_secret}' > '{printed}'"],
                check=True,
            )
            for path in (echoed, printed):
                raw = path.read_bytes()
                self.assertTrue(raw.endswith(b"\n"), path.name)
                self.assertIsNone(HEX64.match(raw))


class WriteNoNewlineSecretTests(unittest.TestCase):
    def test_token_hex_write_is_exact_64_lowercase_hex(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "secret"
            with open(path, "w", encoding="ascii") as fh:
                fh.write(secrets.token_hex(32))
            os.chmod(path, 0o600)
            raw = path.read_bytes()
            self.assertEqual(len(raw), 64)
            self.assertFalse(raw.endswith(b"\n"))
            self.assertIsNotNone(HEX64.match(raw))
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(raw.decode("ascii").strip(), raw.decode("ascii"))
            status, payload = handle_draft_request(
                raw_body=b"{}",
                authorization="Bearer tok",
                expected_token="tok",
                invoke=lambda _s, _u: None,
                replay=ReplayCache(),
                hmac_secret=raw.decode("ascii"),
            )
            self.assertNotEqual(payload.get("error"), "hmac_unconfigured")
            self.assertNotEqual(status, 500)


class DraftServerWhitespaceSecretTests(unittest.TestCase):
    def test_handle_rejects_leading_and_trailing_whitespace(self):
        for secret in ("abc\n", "\nabc", "abc ", " abc", "abc\t"):
            status, payload = handle_draft_request(
                raw_body=b"{}",
                authorization="Bearer tok",
                expected_token="tok",
                invoke=lambda _s, _u: None,
                replay=ReplayCache(),
                hmac_secret=secret,
            )
            self.assertEqual(status, 500, secret.encode("unicode_escape"))
            self.assertEqual(payload["error"], "hmac_unconfigured")

    def test_main_trailing_newline_hmac_exits_before_listen(self):
        token = "a" * 64
        hmac_secret = ("b" * 64) + "\n"
        env = {
            k: v
            for k, v in os.environ.items()
            if k
            not in {
                "API_SERVER_KEY",
                "EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET",
            }
        }
        env["API_SERVER_KEY"] = token
        env["EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET"] = hmac_secret
        env["HERMES_ROLE"] = "sunset-email-luna"
        stderr = io.StringIO()
        stdout = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True):
            with mock.patch("sys.stderr", stderr), mock.patch("sys.stdout", stdout):
                with mock.patch(
                    "wolfhouse.email_draft_server.ThreadingHTTPServer"
                ) as httpd:
                    rc = draft_server_main()
        self.assertEqual(rc, 1)
        httpd.assert_not_called()
        dumped = stderr.getvalue() + stdout.getvalue()
        self.assertIn("EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET", dumped)
        self.assertNotIn(token, dumped)
        self.assertNotIn("b" * 64, dumped)

    def test_main_exact_hex_hmac_reaches_listen(self):
        token = secrets.token_hex(32)
        hmac_secret = secrets.token_hex(32)
        self.assertEqual(len(token), 64)
        self.assertEqual(len(hmac_secret), 64)
        self.assertFalse(hmac_secret.endswith("\n"))
        env = {
            k: v
            for k, v in os.environ.items()
            if k
            not in {
                "API_SERVER_KEY",
                "EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET",
            }
        }
        env["API_SERVER_KEY"] = token
        env["EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET"] = hmac_secret
        env["HERMES_ROLE"] = "sunset-email-luna"
        stderr = io.StringIO()
        stdout = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=True):
            with mock.patch(
                "wolfhouse.email_draft_server.ensure_isolated_sol_home"
            ), mock.patch(
                "wolfhouse.email_draft_server.ThreadingHTTPServer"
            ) as httpd:
                httpd.return_value.serve_forever.return_value = None
                with mock.patch("sys.stderr", stderr), mock.patch("sys.stdout", stdout):
                    rc = draft_server_main()
        self.assertEqual(rc, 0)
        dumped = stderr.getvalue() + stdout.getvalue()
        self.assertNotIn(token, dumped)
        self.assertNotIn(hmac_secret, dumped)


class RunbookSecretGenerationTests(unittest.TestCase):
    def test_section5_forbids_heredoc_stdin_and_shell_token(self):
        runbook = _runbook()
        section = _section5(runbook)
        bash = _fenced_bash(section)
        self.assertNotIn("/dev/stdin", bash)
        self.assertNotIn("TOKEN_EOF", bash)
        self.assertNotIn("HMAC_EOF", bash)
        self.assertNotIn("openssl rand -hex 32", bash)
        self.assertNotIn("TOKEN=$(", bash)
        self.assertNotIn("HMAC=$(", bash)
        self.assertNotIn("--value", bash)
        self.assertNotIn("unset TOKEN", runbook)
        self.assertNotIn("Keep `$TOKEN` in memory", runbook)
        self.assertIn("mktemp", bash)
        self.assertIn("chmod 0600", bash)
        self.assertIn("secrets.token_hex(32)", bash)
        self.assertIn("fh.write(secrets.token_hex(32))", bash)
        self.assertIn("shred -u", bash)
        self.assertIn("trap cleanup_kv_secret_files EXIT INT TERM", bash)
        self.assertIn('--file "$TOKEN_FILE"', bash)
        self.assertIn('--file "$HMAC_FILE"', bash)
        self.assertIn("keyvaultref", runbook)
        self.assertNotRegex(bash, r"print\(")

        verifier = VERIFIER.read_text(encoding="utf-8")
        instance = INSTANCE.read_text(encoding="utf-8")
        self.assertIn("test_sunset_email_secret_newline", verifier)
        self.assertIn("secrets.token_hex(32)", instance)
        self.assertIn("/dev/stdin", instance)

    def test_runbook_python_write_block_produces_exact_hex(self):
        bash = _fenced_bash(_section5(_runbook()))
        blocks = _python_blocks(bash)
        self.assertGreaterEqual(len(blocks), 2)
        write_block = blocks[0]
        verify_block = blocks[1]
        self.assertIn("secrets.token_hex(32)", write_block)
        self.assertIn("fh.write(secrets.token_hex(32))", write_block)
        self.assertNotIn("print(", write_block)
        self.assertIn(r"^[0-9a-f]{64}\Z", verify_block)
        with tempfile.TemporaryDirectory() as tmp:
            token_file = Path(tmp) / "token"
            hmac_file = Path(tmp) / "hmac"
            token_file.write_bytes(b"")
            hmac_file.write_bytes(b"")
            os.chmod(token_file, 0o600)
            os.chmod(hmac_file, 0o600)
            written = subprocess.run(
                ["python3", "-", str(token_file), str(hmac_file)],
                input=write_block,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(written.returncode, 0, written.stderr)
            self.assertEqual(written.stdout, "")
            checked = subprocess.run(
                ["python3", "-", str(token_file), str(hmac_file)],
                input=verify_block,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(checked.returncode, 0, checked.stderr)
            for path in (token_file, hmac_file):
                raw = path.read_bytes()
                self.assertIsNotNone(HEX64.match(raw), path.name)
                self.assertEqual(len(raw), 64)
                self.assertFalse(raw.endswith(b"\n"))
                self.assertNotIn(raw.decode("ascii"), written.stdout + written.stderr)
                self.assertNotIn(raw.decode("ascii"), checked.stdout + checked.stderr)

    def test_runbook_verify_block_rejects_newline_secret_file(self):
        verify_block = _python_blocks(_fenced_bash(_section5(_runbook())))[1]
        with tempfile.TemporaryDirectory() as tmp:
            token_file = Path(tmp) / "token"
            hmac_file = Path(tmp) / "hmac"
            token_file.write_bytes(secrets.token_hex(32).encode("ascii") + b"\n")
            hmac_file.write_bytes(secrets.token_hex(32).encode("ascii"))
            checked = subprocess.run(
                ["python3", "-", str(token_file), str(hmac_file)],
                input=verify_block,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(checked.returncode, 0)
            combined = checked.stdout + checked.stderr
            self.assertIn("refuse:", combined)
            self.assertNotRegex(combined, r"[0-9a-f]{64}")

    def test_runbook_section5_bash_uploads_via_file_then_shreds(self):
        bash = _fenced_bash(_section5(_runbook()))
        with tempfile.TemporaryDirectory() as tmp:
            az = Path(tmp) / "az"
            proof = Path(tmp) / "proof"
            az.write_text(AZ_STUB, encoding="utf-8")
            az.chmod(0o700)
            proof.write_text("", encoding="utf-8")
            env = os.environ.copy()
            env["AZ"] = str(az)
            env["KV"] = "luna-sunset-staging-kv"
            env["MAIL_MVP_007_SECRET_PROOF"] = str(proof)
            env["TMPDIR"] = tmp
            result = subprocess.run(
                ["bash", "-c", bash],
                cwd=tmp,
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            combined = result.stdout + result.stderr
            self.assertEqual(result.returncode, 0, combined)
            self.assertEqual(result.stdout, "")
            proof_text = proof.read_text(encoding="utf-8")
            self.assertIn("name=email-luna-hermes-sol-token", proof_text)
            self.assertIn("name=email-luna-hermes-sol-hmac", proof_text)
            self.assertEqual(proof_text.count("exact_hex=True"), 2)
            self.assertEqual(proof_text.count("newline=False"), 2)
            self.assertEqual(proof_text.count("mode=600"), 2)
            self.assertEqual(proof_text.count("stdin=False"), 2)
            leftovers = [
                p
                for p in Path(tmp).iterdir()
                if p.name not in {"az", "proof"} and p.is_file()
            ]
            self.assertEqual(leftovers, [], "temp secret files must be shredded")
            self.assertNotRegex(combined, r"[0-9a-f]{64}")
            self.assertNotRegex(proof_text, r"(?<![n=])[0-9a-f]{64}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
