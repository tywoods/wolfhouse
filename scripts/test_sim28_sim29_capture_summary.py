#!/usr/bin/env python3
"""Offline tests for the Sim28/Sim29 capture-summary verifier and capture seams.

These tests call the existing summarizer and the real simulate_core /
crowsnest_guest_door capture functions. They do not change those wrappers and
do not treat a scripted adapter return as a model-selected tool call.
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
PACKET = Path(
    "/opt/data/workspace/notes/DH-STEP4-S3-DIAGNOSTICS-CLOSEOUT-20261022/"
    "packet-extract/booking-cleanup-step4-slice3-brief/inputs"
)
SIM28 = PACKET / "sim28"
SIM29 = PACKET / "sim29"
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
    def test_real_packet_passes_and_does_not_mutate_or_leak(self):
        before = {"sim28": _hashes(SIM28), "sim29": _hashes(SIM29)}
        proc = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / "verify-sim28-sim29-capture-summary.py"),
                "--sim28-dir", str(SIM28),
                "--sim29-dir", str(SIM29),
            ],
            cwd=REPO_ROOT,
            env={
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONPATH": f"{STAGING}{os.pathsep}{STAGING / 'plugins'}",
                "PATH": os.environ.get("PATH", ""),
            },
            text=True,
            capture_output=True,
            check=False,
        )
        after = {"sim28": _hashes(SIM28), "sim29": _hashes(SIM29)}
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

    def test_missing_and_malformed_inputs_exit_nonzero(self):
        missing = subprocess.run(
            [sys.executable, str(SCRIPTS / "verify-sim28-sim29-capture-summary.py"),
             "--sim28-dir", "/tmp/does-not-exist-sim28", "--sim29-dir", str(SIM29)],
            cwd=REPO_ROOT,
            env={"PYTHONDONTWRITEBYTECODE": "1", "PATH": os.environ.get("PATH", "")},
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(missing.returncode, 2)
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
                 "--sim28-dir", str(bad), "--sim29-dir", str(SIM29)],
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
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for label, source in (("sim28", SIM28), ("sim29", SIM29)):
                dest = root / label
                dest.mkdir()
                for path in source.iterdir():
                    if path.is_file():
                        dest.joinpath(path.name).write_bytes(path.read_bytes())
            guest3 = root / "sim28" / "guest3.jsonl"
            rows = [json.loads(line) for line in guest3.read_text(encoding="utf-8").splitlines()]
            for call in rows[0]["resp"]["tool_calls"]:
                if call.get("name") == "package_price_preview":
                    call["result_summary"] = "success=True"
            guest3.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, str(SCRIPTS / "verify-sim28-sim29-capture-summary.py"),
                 "--sim28-dir", str(root / "sim28"), "--sim29-dir", str(root / "sim29")],
                cwd=REPO_ROOT,
                env={"PYTHONDONTWRITEBYTECODE": "1", "PATH": os.environ.get("PATH", "")},
                text=True,
                capture_output=True,
                check=False,
            )
        self.assertEqual(proc.returncode, 1, proc.stderr)
        report = json.loads(proc.stdout)
        self.assertFalse(report["ok"])
        failed = [item["id"] for item in report["assertions"] if not item["ok"]]
        self.assertIn("sim28.preview_failures_retained_after_booking", failed)
        self.assertEqual(_hashes(SIM28), _hashes(SIM28))


if __name__ == "__main__":
    unittest.main(verbosity=2)
