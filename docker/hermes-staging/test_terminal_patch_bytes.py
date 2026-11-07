"""Offline patcher byte-authentication tests; never execute resident source."""
import contextlib
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import apply_terminal_lifecycle_diagnostic_patch as patcher
from test_terminal_lifecycle_diagnostic import FIXTURE, EXPECTED_SHA256


class ByteAuthenticationTests(unittest.TestCase):
    def test_newline_changed_target_is_rejected_without_writing(self):
        original = FIXTURE.read_bytes()
        self.assertEqual(hashlib.sha256(original).hexdigest(), EXPECTED_SHA256)
        candidate = patcher.patch_text(original.decode("utf-8")).encode("utf-8")
        for label, source in (("original", original), ("candidate", candidate)):
            for newline in (b"\r\n", b"\r"):
                for all_lines in (False, True):
                    changed = source.replace(b"\n", newline, -1 if all_lines else 1)
                    self.assertNotEqual(changed, source)
                    for entry in ("patch_file", "cli_check", "cli_write"):
                        with self.subTest(source=label, newline=newline, all_lines=all_lines, entry=entry):
                            with tempfile.TemporaryDirectory() as directory:
                                target = Path(directory) / "terminal_tool.py"
                                target.write_bytes(changed)
                                if entry == "patch_file":
                                    with self.assertRaises(patcher.PatchError):
                                        patcher.patch_file(target)
                                else:
                                    args = ["--terminal-tool", str(target)]
                                    if entry == "cli_check":
                                        args.append("--check")
                                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                                        self.assertEqual(patcher.main(args), 1)
                                self.assertEqual(target.read_bytes(), changed)
        self.assertEqual(FIXTURE.read_bytes(), original)

    def test_newline_changed_reference_fixture_is_rejected(self):
        original = FIXTURE.read_bytes()
        candidate = patcher.patch_bytes(original)
        for newline in (b"\r\n", b"\r"):
            for all_lines in (False, True):
                with self.subTest(newline=newline, all_lines=all_lines):
                    with tempfile.TemporaryDirectory() as directory:
                        root = Path(directory)
                        fake_module = root / "docker/hermes-staging/patcher.py"
                        fake_module.parent.mkdir(parents=True)
                        copy = root / "fixtures/hermes-resident-terminal-tool/terminal_tool.py"
                        copy.parent.mkdir(parents=True)
                        copy.write_bytes(original.replace(b"\n", newline, -1 if all_lines else 1))
                        with patch.object(patcher, "__file__", str(fake_module)):
                            with self.assertRaisesRegex(patcher.PatchError, "fixture hash mismatch"):
                                patcher.patch_bytes(original)
                            with self.assertRaisesRegex(patcher.PatchError, "fixture hash mismatch"):
                                patcher.patch_bytes(candidate)
        self.assertEqual(FIXTURE.read_bytes(), original)

    def test_exact_bytes_patch_check_and_idempotency(self):
        original = FIXTURE.read_bytes()
        candidate = patcher.patch_bytes(original)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "terminal_tool.py"
            target.write_bytes(original)
            with patch.object(Path, "read_text", side_effect=AssertionError("text read forbidden")), patch.object(Path, "write_text", side_effect=AssertionError("text write forbidden")):
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(patcher.main(["--terminal-tool", str(target), "--check"]), 0)
                self.assertEqual(target.read_bytes(), original)
                first = patcher.patch_file(target)
                self.assertTrue(first["changed"])
                self.assertEqual(target.read_bytes(), candidate)
                self.assertEqual(first["sha256"], hashlib.sha256(target.read_bytes()).hexdigest())
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(patcher.main(["--terminal-tool", str(target), "--check"]), 0)
                    self.assertEqual(patcher.main(["--terminal-tool", str(target)]), 0)
                with patch.object(Path, "write_bytes", side_effect=AssertionError("idempotency must not write")):
                    self.assertFalse(patcher.patch_file(target)["changed"])
                self.assertEqual(target.read_bytes(), candidate)

    def test_byte_tampering_outside_guard_and_markers_is_rejected(self):
        candidate = patcher.patch_bytes(FIXTURE.read_bytes())
        marker = patcher.MARKER.encode("utf-8")
        cases = (
            candidate + b"\n# extra source bytes\n",
            candidate.replace(marker, b"removed_marker", 1),
            candidate + b"\n# " + marker + b"\n",
            candidate.replace(b"        if not force:\n", b"        if True:\n", 1),
        )
        for changed in cases:
            self.assertNotEqual(changed, candidate)
            with self.assertRaises(patcher.PatchError):
                patcher.patch_bytes(changed)

    def test_invalid_utf8_is_rejected_without_writing(self):
        for data in (b"\xff", patcher.patch_bytes(FIXTURE.read_bytes()) + b"\xff"):
            with tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / "terminal_tool.py"
                target.write_bytes(data)
                with self.assertRaises(patcher.PatchError):
                    patcher.patch_file(target)
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(patcher.main(["--terminal-tool", str(target), "--check"]), 1)
                self.assertEqual(target.read_bytes(), data)


if __name__ == "__main__":
    unittest.main()
