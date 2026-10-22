#!/usr/bin/env python3
"""Offline tests for the Sim28/Sim29 capture-summary verifier and capture seams.

These tests call the existing summarizer and the real simulate_core /
crowsnest_guest_door capture functions. They do not change those wrappers and
do not treat a scripted adapter return as a model-selected tool call.

Packet paths come from SIM28_INPUT_DIR and SIM29_INPUT_DIR. Missing inputs fail
the test; they are not skipped and no private packet directory is created.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


REPO_ROOT = Path(__file__).resolve().parents[1]
STAGING = REPO_ROOT / "docker" / "hermes-staging"
SCRIPTS = REPO_ROOT / "scripts"
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import wolfhouse.crowsnest_guest_door as door  # noqa: E402
import wolfhouse.simulate_core as core  # noqa: E402
from wolfhouse.simulate_write_guards import summarize_tool_result  # noqa: E402

SPEC = importlib.util.spec_from_file_location(
    "verify_sim28_sim29_capture_summary",
    SCRIPTS / "verify-sim28-sim29-capture-summary.py",
)
assert SPEC and SPEC.loader
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)


FULL_REASON = {
    "success": False,
    "reason": "synthetic_inventory_gap",
    "error_code": "SYNTHETIC_409",
    "message": "synthetic tier unavailable",
    "diagnostics": {
        "reason": "nested_should_not_override",
        "error_code": "NESTED_SHOULD_NOT_OVERRIDE",
        "message": "nested should not override",
    },
}
NESTED_ONLY = {
    "success": False,
    "diagnostics": {"reason": "nested_reason", "code": "NESTED_CODE", "detail": "nested detail"},
}
UNSAFE_MESSAGE = (
    "guest_text=do not retain guest@example.test +34600000000 "
    "https://example.test/pay?signature=SECRET token=SECRET"
)
SECRET_TAIL = "MUST_NOT_APPEAR_SECRET"


def _hashes(directory: Path) -> dict[str, str]:
    return {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(directory.iterdir())
        if path.is_file()
    }


def capture_input_dirs() -> tuple[Path, Path]:
    """Packet paths come only from SIM28_INPUT_DIR and SIM29_INPUT_DIR.

    Missing variables or directories fail the calling test. They are not skipped
    and this suite does not recreate a private packet path.
    """
    raw28 = os.environ.get("SIM28_INPUT_DIR", "")
    raw29 = os.environ.get("SIM29_INPUT_DIR", "")
    if not raw28 or not raw29:
        raise AssertionError(
            "SIM28_INPUT_DIR and SIM29_INPUT_DIR must both be set to the packet "
            "input directories. This suite does not use a private path and does not skip."
        )
    sim28 = Path(raw28)
    sim29 = Path(raw29)
    missing = [
        f"{label}={path}"
        for label, path in (("SIM28_INPUT_DIR", sim28), ("SIM29_INPUT_DIR", sim29))
        if not path.is_dir()
    ]
    if missing:
        raise AssertionError("packet input directory missing: " + ", ".join(missing))
    return sim28, sim29


def _cli_env() -> dict[str, str]:
    return {
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPATH": f"{STAGING}{os.pathsep}{STAGING / 'plugins'}",
        "PATH": os.environ.get("PATH", ""),
    }


def _run_verifier(sim28: Path, sim29: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "verify-sim28-sim29-capture-summary.py"),
            "--sim28-dir",
            str(sim28),
            "--sim29-dir",
            str(sim29),
        ],
        cwd=REPO_ROOT,
        env=_cli_env(),
        text=True,
        capture_output=True,
        check=False,
    )


def _copy_packet(root: Path) -> tuple[Path, Path]:
    sim28, sim29 = capture_input_dirs()
    for label, source in (("sim28", sim28), ("sim29", sim29)):
        dest = root / label
        dest.mkdir()
        for path in source.iterdir():
            if path.is_file():
                dest.joinpath(path.name).write_bytes(path.read_bytes())
    return root / "sim28", root / "sim29"


def _journey_tool_count(sim_dir: Path) -> int:
    total = 0
    for guest in range(1, 6):
        for line in (sim_dir / f"guest{guest}.jsonl").read_text(encoding="utf-8").splitlines():
            if line.strip():
                total += len(json.loads(line)["resp"]["tool_calls"])
    return total


def _probe_tool_count(sim_dir: Path) -> int:
    total = 0
    for line in (sim_dir / "probe.log").read_text(encoding="utf-8").splitlines():
        if line.startswith("TOOLS "):
            total += len(json.loads(line[len("TOOLS "):]))
    return total


def _write_guest(directory: Path, guest: int, turns: list[list[dict]]) -> None:
    lines = []
    for calls in turns:
        lines.append(json.dumps({
            "guest": guest,
            "resp": {"tool_calls": calls},
        }))
    (directory / f"guest{guest}.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _success_call(name: str) -> dict:
    summary = "success=True; write_performed=True" if name == "create_booking_from_plan" else "success=True"
    return {"name": name, "result_summary": summary, "simulator_guard": None}


class SummaryContractTests(unittest.TestCase):
    def test_safe_full_structured_reason_prefers_top_level_fields(self):
        summary = summarize_tool_result(FULL_REASON)
        self.assertIn("success=False", summary)
        self.assertIn("reason=synthetic_inventory_gap", summary)
        self.assertIn("error_code=SYNTHETIC_409", summary)
        self.assertIn("detail=synthetic tier unavailable", summary)
        self.assertNotIn("nested_should_not_override", summary)
        self.assertLessEqual(len(summary), 400)

    def test_missing_nested_success_denial_and_truncation(self):
        self.assertEqual(
            summarize_tool_result({"success": False}),
            "success=False; reason=unavailable",
        )
        nested = summarize_tool_result(NESTED_ONLY)
        self.assertIn("reason=nested_reason", nested)
        self.assertIn("error_code=NESTED_CODE", nested)
        self.assertIn("detail=nested detail", nested)
        blocked = summarize_tool_result({
            "success": False,
            "error": "Write disabled in simulate mode (use --allow-writes)",
            "simulate_write_blocked": True,
        })
        self.assertIn("simulate_write_blocked=True", blocked)
        long_summary = summarize_tool_result("synthetic " + ("x" * 500))
        self.assertEqual(len(long_summary), 400)
        self.assertNotIn(SECRET_TAIL, long_summary + SECRET_TAIL[:0])

    def test_unsafe_payload_is_not_emitted(self):
        summary = summarize_tool_result({"success": False, "message": UNSAFE_MESSAGE + SECRET_TAIL})
        self.assertEqual(summary, "success=False; reason=unavailable")
        for forbidden in ("guest@example.test", "+34600000000", "signature=SECRET", "token=SECRET", SECRET_TAIL):
            self.assertNotIn(forbidden, summary)

    def test_constructed_failure_survives_later_booking_and_stays_separate_from_denial(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            _write_guest(directory, 3, [[
                {
                    "name": "package_price_preview",
                    "result_summary": "success=False",
                    "simulator_guard": None,
                },
                {
                    "name": "owner_insights",
                    "result_summary": "success=False; error=Write disabled in simulate mode (use --allow-writes); simulate_write_blocked=True",
                    "simulator_guard": ["blocked_unlisted_wolfhouse_sim_write"],
                },
            ], [
                _success_call("create_booking_from_plan"),
            ]])
            for guest in (1, 2, 4, 5):
                _write_guest(directory, guest, [[_success_call("check_availability")]])
            journey = verifier.summarize_journey(directory, sim="constructed")
        ordinary = journey["ordinary_failures"]
        self.assertEqual(len(ordinary), 1)
        self.assertEqual(ordinary[0]["tool"], "package_price_preview")
        self.assertTrue(ordinary[0]["later_booked"])
        self.assertEqual(ordinary[0]["diagnostic"]["status"], "unavailable")
        self.assertFalse(ordinary[0]["model_selected_call_proven"])
        self.assertEqual(journey["intentional_denial_count"], 1)
        self.assertEqual(journey["intentional_denials"][0]["tool"], "owner_insights")
        self.assertNotEqual(ordinary[0]["kind"], "intentional_guard_denial")

    def test_safe_summary_fields_remain_available_without_raw_body(self):
        classified = verifier.classify_tool_call(
            "package_price_preview",
            summarize_tool_result(FULL_REASON),
            None,
        )
        self.assertEqual(classified["kind"], "ordinary_failure")
        self.assertEqual(classified["diagnostic"]["reason"], "synthetic_inventory_gap")
        self.assertEqual(classified["diagnostic"]["error_code"], "SYNTHETIC_409")
        self.assertEqual(classified["diagnostic"]["detail"], "synthetic tier unavailable")

    def test_truncated_or_unsafe_summary_does_not_leak(self):
        leaked = "x" * 400 + " signature=SECRET " + SECRET_TAIL
        classified = verifier.classify_tool_call("package_price_preview", leaked, None)
        blob = json.dumps(classified)
        self.assertTrue(classified["summary_truncated"])
        self.assertNotIn("signature=SECRET", blob)
        self.assertNotIn(SECRET_TAIL, blob)
        unsafe = verifier.classify_tool_call(
            "package_price_preview",
            "success=False; error=" + UNSAFE_MESSAGE,
            None,
        )
        self.assertEqual(unsafe["diagnostic"]["status"], "unavailable")
        self.assertNotIn("guest@example.test", json.dumps(unsafe))


class CaptureSeamTests(unittest.TestCase):
    def tearDown(self):
        sys.modules.pop("wolfhouse_staff_api", None)

    def _assert_full_reason(self, summary: str) -> None:
        self.assertIn("success=False", summary)
        self.assertIn("reason=synthetic_inventory_gap", summary)
        self.assertIn("error_code=SYNTHETIC_409", summary)
        self.assertIn("detail=synthetic tier unavailable", summary)
        self.assertNotIn("nested_should_not_override", summary)
        self.assertNotIn(SECRET_TAIL, summary)

    def test_simulate_core_capture_keeps_safe_reason_and_existing_keys(self):
        import types

        def orig_post_bot(path, payload):
            return dict(FULL_REASON)

        fake = types.ModuleType("wolfhouse_staff_api")
        fake._post_bot = orig_post_bot
        sys.modules["wolfhouse_staff_api"] = fake
        cap = core.SimulateCapture(allow_writes=False)
        core._install_tool_capture(cap)
        try:
            returned = fake._post_bot("/package-price-preview", {"synthetic": True})
        finally:
            core._remove_patches(cap)
        self.assertFalse(returned["success"])
        self.assertEqual(len(cap.tool_calls), 1)
        recorded = cap.tool_calls[0]
        self.assertEqual(set(recorded), {"name", "args", "result_summary", "follow_up_links", "simulate_guard"})
        self.assertEqual(recorded["name"], "package_price_preview")
        self.assertNotIn("model_selected", recorded)
        self._assert_full_reason(recorded["result_summary"])
        # Scripted adapter return, not evidence the model selected this call.
        self.assertIs(returned["reason"], "synthetic_inventory_gap")

    def test_simulate_core_blocked_write_is_intentional_not_ordinary(self):
        import types

        def orig_post_bot(path, payload):
            raise AssertionError("blocked write must not reach orig")

        fake = types.ModuleType("wolfhouse_staff_api")
        fake._post_bot = orig_post_bot
        sys.modules["wolfhouse_staff_api"] = fake
        cap = core.SimulateCapture(allow_writes=False)
        core._install_tool_capture(cap)
        try:
            fake._post_bot("/sunset/payment-link", {"booking_id": "synthetic"})
        finally:
            core._remove_patches(cap)
        recorded = cap.tool_calls[0]
        classified = verifier.classify_tool_call(
            recorded["name"], recorded["result_summary"], recorded["simulate_guard"],
        )
        self.assertEqual(classified["kind"], "intentional_guard_denial")
        self.assertNotEqual(classified["kind"], "ordinary_failure")

    def test_crowsnest_local_and_guarded_post_seams_keep_same_safe_reason(self):
        scope = door.CrowsnestGuestScope.create("+" + ("9" * 3) + ("0" * 6) + "1394")
        token = door._SCOPE.set(scope)
        try:
            self.assertTrue(door.record_local_tool_result(
                "package_price_preview",
                {"synthetic": True},
                FULL_REASON,
                stage="local_test",
            ))
        finally:
            door._SCOPE.reset(token)
        local = scope.tool_calls[0]
        self.assertEqual(set(local), {"name", "args", "result_summary", "attempt_stage"})
        self.assertNotIn("model_selected", local)
        self._assert_full_reason(local["result_summary"])

        class _Staff:
            def __init__(self):
                self.calls = []

            def _post_bot(self, path, payload):
                self.calls.append(path)
                return dict(FULL_REASON)

            def _session_guest_phone(self):
                return "+99900000000"

        class _WhatsApp:
            class WhatsAppCloudAdapter:
                async def send(self, chat_id, content, reply_to=None, metadata=None):
                    return SimpleNamespace(success=True, message_id="synthetic")

        staff = _Staff()
        door._INSTALLED_STAFF.discard(id(staff))
        door.install_request_owned_guards(staff, _WhatsApp())
        guarded_scope = door.CrowsnestGuestScope.create("+" + ("9" * 3) + ("0" * 6) + "1395")
        token = door._SCOPE.set(guarded_scope)
        try:
            result = staff._post_bot("/package-price-preview", {"synthetic": True})
        finally:
            door._SCOPE.reset(token)
        self.assertFalse(result["success"])
        recorded = guarded_scope.tool_calls[0]
        self.assertEqual(
            set(recorded),
            {"name", "args", "result_summary", "simulator_guard", "effective_capability"},
        )
        self.assertEqual(recorded["name"], "package_price_preview")
        self.assertNotIn("model_selected", recorded)
        self._assert_full_reason(recorded["result_summary"])
        self._assert_full_reason(local["result_summary"])
        self.assertEqual(recorded["result_summary"], local["result_summary"])


class VerifierCliTests(unittest.TestCase):
    def _sources(self) -> tuple[Path, Path]:
        return capture_input_dirs()

    def _source_hashes(self) -> dict[str, dict[str, str]]:
        sim28, sim29 = self._sources()
        return {"sim28": _hashes(sim28), "sim29": _hashes(sim29)}

    def test_input_dirs_come_from_env_not_a_private_path(self):
        sim28, sim29 = self._sources()
        self.assertEqual(sim28, Path(os.environ["SIM28_INPUT_DIR"]))
        self.assertEqual(sim29, Path(os.environ["SIM29_INPUT_DIR"]))
        source = Path(__file__).read_text(encoding="utf-8")
        private_inputs = "/".join((
            "packet-extract",
            "booking-cleanup-step4-slice3-brief",
            "inputs",
        ))
        self.assertNotIn(private_inputs, source)

    def test_missing_input_dirs_fail_clearly_and_are_not_skipped(self):
        saved = {key: os.environ.get(key) for key in ("SIM28_INPUT_DIR", "SIM29_INPUT_DIR")}
        try:
            os.environ.pop("SIM28_INPUT_DIR", None)
            os.environ.pop("SIM29_INPUT_DIR", None)
            with self.assertRaises(AssertionError) as ctx:
                capture_input_dirs()
            message = str(ctx.exception)
            self.assertIn("SIM28_INPUT_DIR", message)
            self.assertIn("does not skip", message)
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        self.assertFalse(getattr(self, "__unittest_skip__", False))

    def test_missing_input_directory_fails_clearly(self):
        saved = os.environ.get("SIM28_INPUT_DIR")
        try:
            os.environ["SIM28_INPUT_DIR"] = "/tmp/no-such-sim28-packet-dh1395"
            with self.assertRaises(AssertionError) as ctx:
                capture_input_dirs()
            self.assertIn("missing", str(ctx.exception))
            self.assertIn("SIM28_INPUT_DIR", str(ctx.exception))
        finally:
            if saved is None:
                os.environ.pop("SIM28_INPUT_DIR", None)
            else:
                os.environ["SIM28_INPUT_DIR"] = saved

    def test_real_packet_passes_and_does_not_mutate_or_leak(self):
        sim28, sim29 = self._sources()
        before = self._source_hashes()
        proc = _run_verifier(sim28, sim29)
        after = self._source_hashes()
        self.assertEqual(before, after)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout[:500])
        report = json.loads(proc.stdout)
        self.assertTrue(report["ok"])
        self.assertFalse(report["sim29"]["zero_tool_errors"])
        self.assertTrue(report["sim29"]["zero_journey_tool_errors"])
        blob = proc.stdout
        self.assertNotIn("http://", blob)
        self.assertNotIn("https://", blob)
        self.assertNotIn("guest_text", blob)
        self.assertNotIn("free beds", blob)
        self.assertIsNone(verifier.PHONE_RE.search(blob))
        identities = [
            {"guest": item["guest"], "turn": item["turn"], "tool": item["tool"]}
            for item in report["sim28"]["journey"]["ordinary_failures"]
        ]
        self.assertEqual(identities, [
            {"guest": 3, "turn": 1, "tool": "package_price_preview"},
            {"guest": 4, "turn": 1, "tool": "package_price_preview"},
        ])

    def test_packet_copy_in_another_directory_still_passes(self):
        before = self._source_hashes()
        with tempfile.TemporaryDirectory() as tmp:
            sim28, sim29 = _copy_packet(Path(tmp))
            self.assertNotEqual(sim28, Path(os.environ["SIM28_INPUT_DIR"]))
            proc = _run_verifier(sim28, sim29)
        self.assertEqual(self._source_hashes(), before)
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout[:500])
        report = json.loads(proc.stdout)
        identities = [
            {"guest": item["guest"], "turn": item["turn"], "tool": item["tool"]}
            for item in report["sim28"]["journey"]["ordinary_failures"]
        ]
        self.assertEqual(identities, [
            {"guest": 3, "turn": 1, "tool": "package_price_preview"},
            {"guest": 4, "turn": 1, "tool": "package_price_preview"},
        ])
        self.assertTrue(all(item["later_booked"] is True for item in report["sim28"]["journey"]["ordinary_failures"]))

    def test_missing_and_malformed_inputs_exit_nonzero(self):
        _sim28, sim29 = self._sources()
        missing = subprocess.run(
            [sys.executable, str(SCRIPTS / "verify-sim28-sim29-capture-summary.py"),
             "--sim28-dir", "/tmp/does-not-exist-sim28", "--sim29-dir", str(sim29)],
            cwd=REPO_ROOT,
            env={"PYTHONDONTWRITEBYTECODE": "1", "PATH": os.environ.get("PATH", "")},
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(missing.returncode, 2)
        self.assertFalse(json.loads(missing.stdout)["ok"])
        self.assertEqual(json.loads(missing.stdout)["error"], "missing_input")

        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "sim28"
            bad.mkdir()
            for name in verifier.GUEST_FILES:
                (bad / name).write_text("{not json}\n", encoding="utf-8")
            (bad / "probe.log").write_text("TOOLS []\n", encoding="utf-8")
            (bad / "CHATS.md").write_text("Top tool errors:\n", encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, str(SCRIPTS / "verify-sim28-sim29-capture-summary.py"),
                 "--sim28-dir", str(bad), "--sim29-dir", str(sim29)],
                cwd=REPO_ROOT,
                env={"PYTHONDONTWRITEBYTECODE": "1", "PATH": os.environ.get("PATH", "")},
                text=True,
                capture_output=True,
                check=False,
            )
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stdout)["error"], "malformed_json")
        self.assertNotIn("{not json}", proc.stdout)

    def test_dropping_a_later_booked_preview_is_assertion_mismatch(self):
        sim28, _sim29 = self._sources()
        before = _hashes(sim28)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            copied28, copied29 = _copy_packet(root)
            guest3 = copied28 / "guest3.jsonl"
            rows = [json.loads(line) for line in guest3.read_text(encoding="utf-8").splitlines()]
            for call in rows[0]["resp"]["tool_calls"]:
                if call.get("name") == "package_price_preview":
                    call["result_summary"] = "success=True"
            guest3.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            proc = _run_verifier(copied28, copied29)
        self.assertEqual(proc.returncode, 1, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertFalse(report["ok"])
        failed = [item["id"] for item in report["assertions"] if not item["ok"]]
        self.assertIn("sim28.preview_failures_retained_after_booking", failed)
        self.assertEqual(_hashes(sim28), before)

    def _assert_schema_rejection_preserves_counts(
        self,
        proc: subprocess.CompletedProcess[str],
        *,
        error: str,
        field: str,
        before_count: int,
        after_count: int,
    ) -> None:
        self.assertEqual(before_count, after_count)
        self.assertNotEqual(proc.returncode, 0, proc.stdout[:500])
        report = json.loads(proc.stdout)
        self.assertFalse(report["ok"])
        self.assertEqual(report["error"], error)
        self.assertIn(field, report["detail"])
        self.assertNotIn("assertions", report)
        self.assertNotIn("synthetic_failure", proc.stdout)
        self.assertNotIn("free beds", proc.stdout)
        self.assertIsNone(verifier.PHONE_RE.search(proc.stdout))

    def _mutate_sim29_success_summary(self, sim29: Path, key: str, value: object) -> tuple[int, int]:
        target = sim29 / "guest1.jsonl"
        before = _journey_tool_count(sim29)
        rows = [json.loads(line) for line in target.read_text(encoding="utf-8").splitlines()]
        call = rows[0]["resp"]["tool_calls"][0]
        self.assertEqual(call["name"], "check_availability")
        self.assertIsInstance(call["result_summary"], str)
        self.assertTrue(str(call["result_summary"]).startswith("success=True"))
        call[key] = value
        target.write_text(
            "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
            encoding="utf-8",
        )
        after = _journey_tool_count(sim29)
        return before, after

    def _reject_journey_type(self, key: str, value: object, field: str) -> None:
        sources = self._source_hashes()
        with tempfile.TemporaryDirectory() as tmp:
            _sim28, sim29 = _copy_packet(Path(tmp))
            before, after = self._mutate_sim29_success_summary(sim29, key, value)
            proc = _run_verifier(_sim28, sim29)
        self.assertEqual(self._source_hashes(), sources)
        self._assert_schema_rejection_preserves_counts(
            proc,
            error="malformed_json",
            field=field,
            before_count=before,
            after_count=after,
        )
        self.assertEqual(before, verifier.EXPECTED_COUNTS["sim29"]["tool_calls"])

    def test_null_summary_is_rejected_when_counts_unchanged(self):
        self._reject_journey_type("result_summary", None, "result_summary")

    def test_list_summary_is_rejected_when_counts_unchanged(self):
        self._reject_journey_type("result_summary", [], "result_summary")

    def test_object_summary_is_rejected_when_counts_unchanged(self):
        self._reject_journey_type(
            "result_summary",
            {"success": False, "reason": "synthetic_failure"},
            "result_summary",
        )

    def test_null_tool_name_is_rejected_when_counts_unchanged(self):
        self._reject_journey_type("name", None, "name")

    def _mutate_probe_success_field(self, sim29: Path, field: str, value: object) -> tuple[int, int]:
        path = sim29 / "probe.log"
        before = _probe_tool_count(sim29)
        lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
        mutated = False
        for index, line in enumerate(lines):
            if not line.startswith("TOOLS "):
                continue
            newline = "\n" if line.endswith("\n") else ""
            tools = json.loads(line[len("TOOLS "):].strip())
            if not tools or tools[0].get("n") != "check_availability":
                continue
            if not isinstance(tools[0].get("r"), str) or not tools[0]["r"].startswith("success=True"):
                continue
            tools[0][field] = value
            lines[index] = "TOOLS " + json.dumps(tools, ensure_ascii=False) + newline
            mutated = True
            break
        self.assertTrue(mutated, "expected a successful probe tool whose counts stay unchanged")
        path.write_text("".join(lines), encoding="utf-8")
        return before, _probe_tool_count(sim29)

    def _reject_probe_type(self, field: str, value: object) -> None:
        sources = self._source_hashes()
        with tempfile.TemporaryDirectory() as tmp:
            sim28, sim29 = _copy_packet(Path(tmp))
            before, after = self._mutate_probe_success_field(sim29, field, value)
            proc = _run_verifier(sim28, sim29)
        self.assertEqual(self._source_hashes(), sources)
        self._assert_schema_rejection_preserves_counts(
            proc,
            error="malformed_probe",
            field=field,
            before_count=before,
            after_count=after,
        )
        self.assertEqual(before, verifier.EXPECTED_COUNTS["sim29"]["probe_tool_calls"])

    def test_probe_null_n_is_rejected_when_counts_unchanged(self):
        self._reject_probe_type("n", None)

    def test_probe_null_r_is_rejected_when_counts_unchanged(self):
        self._reject_probe_type("r", None)

    def test_probe_list_r_is_rejected_when_counts_unchanged(self):
        self._reject_probe_type("r", [])

    def test_probe_object_r_is_rejected_when_counts_unchanged(self):
        self._reject_probe_type("r", {"success": False, "reason": "synthetic_failure"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
