#!/usr/bin/env python3
"""Offline Sim28/Sim29 capture-summary verifier.

Reads immutable guest JSONL captures and the separate probe.log. It does not
call Staff, Stripe, Meta, or an LLM, and it does not rewrite inputs.

Historical result_summary strings are the only diagnostic source. A missing
reason stays unavailable. A later successful booking does not drop an earlier
failure. probe.log denials stay in their own scope and are not folded into a
journey "zero tool errors" claim. Adapter capture is not model-selection proof.
Non-string tool names or summaries, including probe n/r fields, are malformed
input and cannot pass as zero errors.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
STAGING = REPO_ROOT / "docker" / "hermes-staging"
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))

from wolfhouse.simulate_write_guards import _safe_diagnostic_text  # noqa: E402


SUMMARY_BOUND = 400
DIAGNOSTIC_BOUND = 160
GUEST_FILES = tuple(f"guest{n}.jsonl" for n in range(1, 6))
SAFE_KEYS = (
    "success",
    "reason",
    "error_code",
    "detail",
    "error",
    "simulate_write_blocked",
    "intentional_capability_block",
    "write_performed",
)
TEXT_DIAGNOSTIC_KEYS = ("reason", "error_code", "detail", "error")
PHONE_RE = re.compile(r"(?<!\w)\+?\d[\d* ().-]{7,}\d(?!\w)")
META_BLOCKED_RE = re.compile(r"blocked=(\[[^\]]*\])")
META_WA_RE = re.compile(r"wa_sends=(True|False)")

# Pinned to the immutable packet. A different capture must fail closed.
EXPECTED_SIM28_FAILURES = (
    {"guest": 3, "turn": 1, "tool": "package_price_preview"},
    {"guest": 4, "turn": 1, "tool": "package_price_preview"},
)
EXPECTED_COUNTS = {
    "sim28": {"turns": 15, "tool_calls": 40, "probe_tool_calls": 4},
    "sim29": {"turns": 15, "tool_calls": 38, "probe_tool_calls": 4},
}
EXPECTED_PROBE_ERROR = "Write disabled in simulate mode (use --allow-writes)"


class CaptureInputError(Exception):
    """Malformed or missing capture input. Never includes raw guest text."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _require_capture_string(
    value: Any,
    *,
    field: str,
    where: str,
    code: str,
    nonempty: bool = False,
) -> str:
    """Reject unsupported capture field types before they can look like success."""
    if not isinstance(value, str) or (nonempty and not value.strip()):
        expected = "a non-empty string" if nonempty else "a string"
        raise CaptureInputError(code, f"{where} {field} is not {expected}")
    return value


def parse_summary(summary: Any) -> dict[str, Any]:
    if not isinstance(summary, str):
        raise CaptureInputError("malformed_input", "result_summary is not a string")
    text = summary
    truncated = len(text) > SUMMARY_BOUND
    fields: dict[str, str] = {}
    for part in text[:SUMMARY_BOUND].split("; "):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip()
        if key in SAFE_KEYS:
            fields[key] = value.strip()
    return {"fields": fields, "truncated": truncated}


def _flag(fields: dict[str, str], key: str) -> bool:
    return fields.get(key) == "True"


def _guard_blocked(guard: Any) -> bool:
    if not isinstance(guard, list):
        return False
    return any(str(item or "").startswith("blocked") for item in guard)


def safe_diagnostic(fields: dict[str, str]) -> dict[str, Any]:
    emitted: dict[str, Any] = {}
    available = False
    for key in TEXT_DIAGNOSTIC_KEYS:
        raw = fields.get(key, "")
        safe = _safe_diagnostic_text(raw, DIAGNOSTIC_BOUND) if raw else ""
        emitted[key] = safe or None
        if safe:
            available = True
    emitted["status"] = "available" if available else "unavailable"
    emitted["simulate_write_blocked"] = _flag(fields, "simulate_write_blocked")
    emitted["intentional_capability_block"] = _flag(fields, "intentional_capability_block")
    return emitted


def classify_tool_call(name: Any, summary: Any, guard: Any) -> dict[str, Any]:
    if not isinstance(name, str) or not name.strip():
        raise CaptureInputError("malformed_input", "tool name is not a non-empty string")
    parsed = parse_summary(summary)
    fields = parsed["fields"]
    diagnostic = safe_diagnostic(fields)
    success_false = fields.get("success") == "False"
    intentional = success_false and (
        diagnostic["simulate_write_blocked"]
        or diagnostic["intentional_capability_block"]
        or _guard_blocked(guard)
    )
    if intentional:
        kind = "intentional_guard_denial"
    elif success_false:
        kind = "ordinary_failure"
    else:
        kind = "not_a_failure"
    return {
        "tool": name[:120],
        "kind": kind,
        "diagnostic": diagnostic,
        "guard_blocked": _guard_blocked(guard),
        "summary_truncated": parsed["truncated"],
        "later_booking_marker": (
            name == "create_booking_from_plan"
            and fields.get("success") == "True"
            and fields.get("write_performed") == "True"
        ),
    }


def _require_file(directory: Path, name: str) -> Path:
    path = directory / name
    if not path.is_file():
        raise CaptureInputError("missing_input", f"missing {name}")
    return path


def _load_json_line(path: Path, line_no: int, line: str) -> dict[str, Any]:
    try:
        obj = json.loads(line)
    except json.JSONDecodeError as exc:
        raise CaptureInputError(
            "malformed_json",
            f"{path.name} line {line_no} is not json ({exc.msg})",
        ) from exc
    if not isinstance(obj, dict):
        raise CaptureInputError("malformed_json", f"{path.name} line {line_no} is not an object")
    return obj


def summarize_journey(sim_dir: Path, *, sim: str) -> dict[str, Any]:
    if not sim_dir.is_dir():
        raise CaptureInputError("missing_input", f"{sim} directory missing")
    guests = []
    ordinary: list[dict[str, Any]] = []
    intentional: list[dict[str, Any]] = []
    turns = 0
    tool_calls = 0
    input_hashes = {}
    for name in GUEST_FILES:
        path = _require_file(sim_dir, name)
        input_hashes[name] = file_sha256(path)
        expected_guest = int(name.removeprefix("guest").removesuffix(".jsonl"))
        lines = path.read_text(encoding="utf-8").splitlines()
        if not lines:
            raise CaptureInputError("malformed_json", f"{name} is empty")
        guest_calls: list[dict[str, Any]] = []
        for turn, line in enumerate(lines, 1):
            if not line.strip():
                raise CaptureInputError("malformed_json", f"{name} line {turn} is blank")
            obj = _load_json_line(path, turn, line)
            if obj.get("guest") != expected_guest:
                raise CaptureInputError(
                    "malformed_json",
                    f"{name} line {turn} guest field does not match filename",
                )
            resp = obj.get("resp")
            if not isinstance(resp, dict) or not isinstance(resp.get("tool_calls"), list):
                raise CaptureInputError(
                    "malformed_json",
                    f"{name} line {turn} has no tool_calls list",
                )
            turns += 1
            for index, call in enumerate(resp["tool_calls"], 1):
                if not isinstance(call, dict) or "name" not in call or "result_summary" not in call:
                    raise CaptureInputError(
                        "malformed_json",
                        f"{name} turn {turn} tool {index} is missing name or result_summary",
                    )
                where = f"{name} turn {turn} tool {index}"
                tool_name = _require_capture_string(
                    call.get("name"),
                    field="name",
                    where=where,
                    code="malformed_json",
                    nonempty=True,
                )
                summary = _require_capture_string(
                    call.get("result_summary"),
                    field="result_summary",
                    where=where,
                    code="malformed_json",
                )
                classified = classify_tool_call(
                    tool_name,
                    summary,
                    call.get("simulator_guard"),
                )
                tool_calls += 1
                entry = {
                    "guest": expected_guest,
                    "turn": turn,
                    "tool_index": index,
                    "tool": classified["tool"],
                    "kind": classified["kind"],
                    "diagnostic": classified["diagnostic"],
                    "summary_truncated": classified["summary_truncated"],
                    "origin": "journey_jsonl_result_summary",
                    "model_selected_call_proven": False,
                    "later_booked": False,
                }
                guest_calls.append({**entry, "_booking": classified["later_booking_marker"]})
        for pos, entry in enumerate(guest_calls):
            entry["later_booked"] = any(
                later["_booking"] and (
                    later["turn"] > entry["turn"]
                    or (later["turn"] == entry["turn"] and later["tool_index"] > entry["tool_index"])
                )
                for later in guest_calls[pos + 1:]
            )
            stored = {key: value for key, value in entry.items() if key != "_booking"}
            if entry["kind"] == "ordinary_failure":
                ordinary.append(stored)
            elif entry["kind"] == "intentional_guard_denial":
                intentional.append(stored)
        guests.append({"guest": expected_guest, "turns": len(lines)})
    return {
        "sim": sim,
        "guests": guests,
        "turns": turns,
        "tool_calls": tool_calls,
        "ordinary_failures": ordinary,
        "intentional_denials": intentional,
        "ordinary_failure_count": len(ordinary),
        "intentional_denial_count": len(intentional),
        "input_hashes": input_hashes,
    }


def _parse_meta_blocked(line: str) -> list[str]:
    match = META_BLOCKED_RE.search(line)
    if not match:
        raise CaptureInputError("malformed_probe", "META line has no blocked list")
    try:
        value = ast.literal_eval(match.group(1))
    except (SyntaxError, ValueError) as exc:
        raise CaptureInputError("malformed_probe", "META blocked list is not a literal") from exc
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise CaptureInputError("malformed_probe", "META blocked list is not a string list")
    return value


def summarize_probe(sim_dir: Path) -> dict[str, Any]:
    path = _require_file(sim_dir, "probe.log")
    ordinary: list[dict[str, Any]] = []
    intentional: list[dict[str, Any]] = []
    tool_calls = 0
    blocks = 0
    wa_sends: list[bool] = []
    meta_blocked: list[list[str]] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.startswith("META "):
            meta_blocked.append(_parse_meta_blocked(line))
            wa_match = META_WA_RE.search(line)
            if wa_match:
                wa_sends.append(wa_match.group(1) == "True")
            continue
        if not line.startswith("TOOLS "):
            continue
        blocks += 1
        try:
            tools = json.loads(line[len("TOOLS "):])
        except json.JSONDecodeError as exc:
            raise CaptureInputError(
                "malformed_probe",
                f"probe.log line {line_no} TOOLS payload is not json ({exc.msg})",
            ) from exc
        if not isinstance(tools, list):
            raise CaptureInputError("malformed_probe", f"probe.log line {line_no} TOOLS is not a list")
        for index, call in enumerate(tools, 1):
            if not isinstance(call, dict) or "n" not in call or "r" not in call:
                raise CaptureInputError(
                    "malformed_probe",
                    f"probe.log block {blocks} tool {index} is missing n or r",
                )
            where = f"probe.log block {blocks} tool {index}"
            tool_name = _require_capture_string(
                call.get("n"),
                field="n",
                where=where,
                code="malformed_probe",
                nonempty=True,
            )
            summary = _require_capture_string(
                call.get("r"),
                field="r",
                where=where,
                code="malformed_probe",
            )
            classified = classify_tool_call(tool_name, summary, call.get("g"))
            tool_calls += 1
            if classified["kind"] == "not_a_failure":
                continue
            entry = {
                "probe_block": blocks,
                "tool_index": index,
                "tool": classified["tool"],
                "kind": classified["kind"],
                "diagnostic": classified["diagnostic"],
                "summary_truncated": classified["summary_truncated"],
                "origin": "probe_log_tools",
                "model_selected_call_proven": False,
                "scope": "probe_log_not_booking_journey",
            }
            if classified["kind"] == "ordinary_failure":
                ordinary.append(entry)
            else:
                intentional.append(entry)
    if blocks == 0:
        raise CaptureInputError("malformed_probe", "probe.log has no TOOLS line")
    return {
        "scope": "probe_log_not_booking_journey",
        "blocks": blocks,
        "tool_calls": tool_calls,
        "ordinary_failures": ordinary,
        "intentional_denials": intentional,
        "ordinary_failure_count": len(ordinary),
        "intentional_denial_count": len(intentional),
        "meta_blocked": meta_blocked,
        "meta_wa_sends": wa_sends,
        "sha256": file_sha256(path),
    }


def _chats_top_errors(sim_dir: Path) -> str:
    path = _require_file(sim_dir, "CHATS.md")
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("Top tool errors:"):
            return line.strip()
    raise CaptureInputError("malformed_chats", "CHATS.md has no Top tool errors line")


def _failure_identity(entry: dict[str, Any]) -> dict[str, Any]:
    return {"guest": entry["guest"], "turn": entry["turn"], "tool": entry["tool"]}


def evaluate_contract(report: dict[str, Any]) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []

    def add(check_id: str, ok: bool, detail: str) -> None:
        checks.append({"id": check_id, "ok": ok, "detail": detail})

    sim28 = report["sim28"]["journey"]
    sim29 = report["sim29"]["journey"]
    probe28 = report["sim28"]["probe"]
    probe29 = report["sim29"]["probe"]
    observed = [_failure_identity(item) for item in sim28["ordinary_failures"]]
    expected = [dict(item) for item in EXPECTED_SIM28_FAILURES]
    add(
        "sim28.preview_failures_retained_after_booking",
        observed == expected and all(item["later_booked"] is True for item in sim28["ordinary_failures"]),
        "guest3 turn1 and guest4 turn1 package_price_preview stay listed after later booking",
    )
    add(
        "sim28.preview_cause_unavailable",
        all(item["diagnostic"]["status"] == "unavailable" for item in sim28["ordinary_failures"])
        and all(item["diagnostic"][key] is None for item in sim28["ordinary_failures"] for key in TEXT_DIAGNOSTIC_KEYS),
        "historical preview bodies stay unavailable",
    )
    add(
        "sim28.preview_not_intentional_denial",
        sim28["intentional_denial_count"] == 0,
        "preview failures are ordinary capture failures, not guard denials",
    )
    add(
        "sim28.probe_separate_and_clean",
        probe28["ordinary_failure_count"] == 0 and probe28["intentional_denial_count"] == 0,
        "sim28 probe stays separate and has no tool error",
    )
    add(
        "sim29.journey_has_no_tool_failures",
        sim29["ordinary_failure_count"] == 0 and sim29["intentional_denial_count"] == 0,
        "sim29 booking journeys have no tool failures",
    )
    probe_denials = probe29["intentional_denials"]
    probe_ok = (
        probe29["ordinary_failure_count"] == 0
        and len(probe_denials) == 1
        and probe_denials[0]["tool"] == "owner_insights"
        and probe_denials[0]["diagnostic"]["error"] == EXPECTED_PROBE_ERROR
        and probe_denials[0]["diagnostic"]["simulate_write_blocked"] is True
    )
    add(
        "sim29.probe_denial_separate",
        probe_ok and report["sim29"]["zero_journey_tool_errors"] is True and report["sim29"]["zero_tool_errors"] is False,
        "owner_insights probe denial is not folded into zero tool errors",
    )
    add(
        "sim28.chats_error_summary_is_not_source",
        report["sim28"]["chats_top_tool_errors"] == "Top tool errors:"
        and report["sim28"]["journey"]["ordinary_failure_count"] == 2,
        "empty CHATS.md error summary does not hide JSONL preview failures",
    )
    add(
        "sim29.chats_error_summary_not_a_probe_waiver",
        report["sim29"]["chats_top_tool_errors"] == "Top tool errors:"
        and report["sim29"]["zero_tool_errors"] is False,
        "empty journey error summary does not waive the probe denial",
    )
    for sim, expected_counts in EXPECTED_COUNTS.items():
        journey = report[sim]["journey"]
        probe = report[sim]["probe"]
        add(
            f"{sim}.capture_counts",
            journey["turns"] == expected_counts["turns"]
            and journey["tool_calls"] == expected_counts["tool_calls"]
            and probe["tool_calls"] == expected_counts["probe_tool_calls"],
            "turn and tool counts match the immutable captures",
        )
    add(
        "no_model_selection_claim",
        all(
            item["model_selected_call_proven"] is False
            for sim in ("sim28", "sim29")
            for item in report[sim]["journey"]["ordinary_failures"]
            + report[sim]["journey"]["intentional_denials"]
            + report[sim]["probe"]["ordinary_failures"]
            + report[sim]["probe"]["intentional_denials"]
        ),
        "capture summaries are not treated as model-selected calls",
    )
    return checks


def build_report(sim28_dir: Path, sim29_dir: Path) -> dict[str, Any]:
    report: dict[str, Any] = {"ok": False, "sims": {}}
    for label, directory in (("sim28", sim28_dir), ("sim29", sim29_dir)):
        journey = summarize_journey(directory, sim=label)
        probe = summarize_probe(directory)
        journey_errors = journey["ordinary_failure_count"] + journey["intentional_denial_count"]
        probe_errors = probe["ordinary_failure_count"] + probe["intentional_denial_count"]
        chats_hash = file_sha256(_require_file(directory, "CHATS.md"))
        report[label] = {
            "journey": journey,
            "probe": probe,
            "chats_top_tool_errors": _chats_top_errors(directory),
            "chats_sha256": chats_hash,
            "zero_journey_tool_errors": journey_errors == 0,
            "zero_tool_errors": journey_errors == 0 and probe_errors == 0,
        }
    report["assertions"] = evaluate_contract(report)
    report["ok"] = all(item["ok"] for item in report["assertions"])
    report["attribution"] = "historical_capture_summary_only"
    report["cause_invented"] = False
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Offline Sim28/Sim29 capture summary verifier")
    parser.add_argument("--sim28-dir", required=True)
    parser.add_argument("--sim29-dir", required=True)
    args = parser.parse_args(argv)
    try:
        report = build_report(Path(args.sim28_dir), Path(args.sim29_dir))
    except CaptureInputError as exc:
        json.dump({"ok": False, "error": exc.code, "detail": exc.detail}, sys.stdout)
        sys.stdout.write("\n")
        return 2
    json.dump(report, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
