#!/usr/bin/env python3

import importlib.util
import io
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest import mock

SCRIPT = pathlib.Path(__file__).with_name("luna-v3-cap-evidence-sanitize.py")
SPEC = importlib.util.spec_from_file_location("evidence_sanitize", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {SCRIPT}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class EvidenceSanitizeTest(unittest.TestCase):
    def test_inspect_recursively_drops_env_and_sensitive_fields(self):
        source = [{
            "Id": "safe-id",
            "Config": {"Env": ["MODEL_KEY=fixture"], "Image": "safe-image"},
            "Nested": {"secret_name": "not-safe", "safe": "kept"},
        }]
        self.assertEqual(
            MODULE.scrub_structure(source),
            [{"Id": "safe-id", "Config": {"Image": "safe-image"}, "Nested": {"safe": "kept"}}],
        )

    def test_log_scrub_replaces_sensitive_env_values_and_provider_tokens(self):
        provider_token = b"s" + b"k-fixture-token"
        with mock.patch.dict(os.environ, {"MODEL_API_KEY": "fixture-sensitive-value"}, clear=True):
            scrubbed = MODULE.scrub_bytes(b"a fixture-sensitive-value b " + provider_token + b" c")
        self.assertEqual(scrubbed, b"a [REDACTED] b [REDACTED] c")

    def test_check_fails_closed_without_printing_matches(self):
        provider_token = "s" + "k-fixture-token"
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "bad.log").write_text("prefix fixture-sensitive-value suffix\n")
            (root / "token.log").write_text(f"prefix {provider_token} suffix\n")
            stderr = io.StringIO()
            with mock.patch.dict(os.environ, {"MODEL_API_KEY": "fixture-sensitive-value"}, clear=True):
                with redirect_stderr(stderr):
                    result = MODULE.check_command(root)
            self.assertEqual(result, 1)
            report = stderr.getvalue()
            self.assertIn("bad.log", report)
            self.assertIn("token.log", report)
            self.assertNotIn("fixture-sensitive-value", report)
            self.assertNotIn(provider_token, report)

    def test_cli_check_passes_clean_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            pathlib.Path(directory, "clean.json").write_text('{"safe":true}\n')
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "check", directory],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                env={"PATH": os.environ.get("PATH", "")},
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PASS: evidence sensitive-data scan", result.stdout)


if __name__ == "__main__":
    unittest.main()
