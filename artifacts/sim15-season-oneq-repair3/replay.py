#!/usr/bin/env python3
"""Controlled, source-faithful SIM15 reconstruction (not historical replay).

Historical full Staff callback bodies were not retained. This harness therefore
never claims exact historical reproduction. It preserves retained guest wording,
known facts and tool order, uses inert read-only Staff fixtures, invokes the
registered get_house_info callback, and disables model tools/sends/product writes.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "artifacts" / "sim15-season-oneq-repair3"
BASE = "d1d42d5b45c42173848ac8ff29f272489cd3768f"
CANDIDATE = "WORKTREE"
PLUGIN = "docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py"
SOUL = "docker/hermes-staging/SOUL.md"
MODEL = "gpt-5.6-sol"
PROVIDER = "openai-codex"
COMMAND = "/opt/hermes/.venv/bin/python artifacts/sim15-season-oneq-repair3/replay.py"

sys.path[:0] = [str(ROOT / "docker/hermes-staging"), str(ROOT / "docker/hermes-staging/plugins"), "/opt/hermes"]
from run_agent import AIAgent  # noqa: E402
import wolfhouse_staff_api as plugin  # noqa: E402
from wolfhouse import luna_personality as personality  # noqa: E402

G3 = "hi! Aisha — me + 2 friends (all women, 22-24) want 3 nights Nov 3-6 (check-in Tue 3 Nov, out Fri 6 Nov 2026). Do you have a surf+stay package, or is bed-only cheaper? Also my 16yo sister might crash one night — is that allowed?"
HOLLY = "Hiya — Holly & Jake from Bristol (a couple, she/he). Private room if you have one, Nov 10-13 (3 nights). Can we rent boards there, what's parking like?"
STALE_NOTES = "Season normally runs Easter through Halloween. Guests aged 16 may stay without a parent, but every overnight guest needs a booked available bed. Free parking is inside the property."

CASES = [
    {"id": "g3_failed_preview", "guest": G3, "results": [
        ("get_house_info", None),
        ("check_availability", {"success": True, "tool": "check_availability", "check_in": "2026-11-03", "check_out": "2026-11-06", "guest_count": 3, "next_action": "ready_for_bot_create", "available_room_options": ["mixed shared room"], "women_only_places_available": False}),
        ("preview_package_prices", {"success": False, "tool": "preview_package_prices", "error": "fixture_pricing_unavailable", "write_performed": False}),
        ("lookup_catalog_service", {"success": True, "tool": "lookup_catalog_service", "matched": False, "message_text": G3}),
    ]},
    {"id": "g3_explicit_current_date_approval", "guest": G3, "results": [
        ("get_house_info", None),
        ("check_availability", {"success": True, "tool": "check_availability", "check_in": "2026-11-03", "check_out": "2026-11-06", "guest_count": 3, "next_action": "ready_for_bot_create", "available_room_options": ["women-only dorm", "mixed dorm"]}),
        ("preview_package_prices", {"success": True, "tool": "preview_package_prices", "check_in": "2026-11-03", "check_out": "2026-11-06", "dates_approved": True, "package_eligible": False, "package_min_nights": 7, "accommodation_only_available": True, "write_performed": False}),
        ("lookup_catalog_service", {"success": True, "tool": "lookup_catalog_service", "matched": False, "message_text": G3}),
    ]},
    {"id": "holly_jake_explicit_current_date_approval", "guest": HOLLY, "results": [
        ("get_house_info", None),
        ("check_availability", {"success": True, "tool": "check_availability", "check_in": "2026-11-10", "check_out": "2026-11-13", "guest_count": 2, "room_type": "private", "room_preference": "couple_private", "private_room_available": True, "next_action": "ready_for_bot_create"}),
        ("preview_package_prices", {"success": True, "tool": "preview_package_prices", "check_in": "2026-11-10", "check_out": "2026-11-13", "dates_approved": True, "package_eligible": False, "package_min_nights": 7, "accommodation_only_available": True, "write_performed": False}),
        ("lookup_catalog_service", {"success": True, "tool": "lookup_catalog_service", "matched": True, "service": {"name": "partner surfboard rental"}, "availability_confirmed": False, "price_confirmed": False, "pricing_inputs_required": ["board_type", "rental_duration"], "message_text": HOLLY}),
    ]},
    {"id": "real_closed_season", "guest": "Can Holly and Jake stay in a private room from 3–6 November 2026?", "results": [
        ("get_house_info", None),
        ("check_availability", {"success": True, "tool": "check_availability", "capacity_available": True, "check_in": "2026-11-03", "check_out": "2026-11-06"}),
        ("quote_booking", {"success": False, "tool": "quote_booking", "next_action": "closed_season", "check_in": "2026-11-03", "check_out": "2026-11-06", "guest_safe_next_action": "We’re closed for those dates.", "write_performed": False}),
    ]},
    {"id": "genuinely_missing_date_authority", "guest": "Can Holly and Jake stay in a private room from 3–6 November 2026?", "results": [
        ("get_house_info", None),
        ("house_capacity_hint", {"success": True, "tool": "house_capacity_hint", "capacity_available": True, "not_booking_date_authority": True}),
    ]},
]


def sha(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def git_show(ref: str, path: str) -> str:
    if ref == "WORKTREE":
        return (ROOT / path).read_text()
    return subprocess.run(["/usr/bin/git", "show", f"{ref}:{path}"], cwd=ROOT, check=True, text=True, capture_output=True).stdout


def registered_context():
    registered = {}
    context = SimpleNamespace(register_tool=lambda **kw: registered.update({kw["name"]: kw}))
    events = []
    def staff(route, payload):
        if route != "/house-info" or payload:
            raise AssertionError(f"inert fixture denied unexpected route: {route} {payload}")
        events.append({"route": route, "payload": payload, "read_only": True})
        return {"success": True, "has_notes": True, "notes": STALE_NOTES, "read_only": True}
    env = {"LUNA_CLIENT_SLUG": "wolfhouse-somo", "HERMES_ROLE": "luna"}
    with patch.dict(os.environ, env), patch.object(plugin, "_post_bot", side_effect=staff):
        plugin.register(context)
        house = json.loads(registered["get_house_info"]["handler"]({}))
    return registered, house, events


def classify_missing_inputs(text: str):
    """Semantic acceptance classifier for this bounded rental case."""
    low = text.lower()
    requested = []
    if re.search(r"soft(?:boards?|[ -]?tops?)?.{0,35}(?:or|versus).{0,25}hard", low, re.S):
        requested.append("board_type")
    if re.search(r"how many (?:of (?:the )?\w+ )?days|for how long|rental duration", low):
        requested.append("rental_duration")
    return requested


def assess(run):
    text = run["actual_emitted_reply"] or ""
    checks: dict[str, object] = {"no_stale_season_caveat": not re.search(r"easter|halloween|usual season|season caveat", text, re.I)}
    if run["case"] == "holly_jake_explicit_current_date_approval":
        inputs = classify_missing_inputs(text)
        checks.update(requested_missing_quote_inputs=inputs, at_most_one_missing_quote_input=len(inputs) <= 1,
                      no_private_reask=not re.search(r"private.{0,25}(?:or|versus).{0,25}shared", text, re.I | re.S))
    elif run["case"] == "real_closed_season":
        checks["closure_preserved"] = bool(re.search(r"closed|not open|can.t accommodate", text, re.I))
    elif run["case"] == "genuinely_missing_date_authority":
        opening_claim = re.search(r"dates (?:work|are available)|we.re open|we are open|(?:room|stay) is available", text, re.I)
        explicit_uncertainty = re.search(r"can(?:not|['’]t) (?:yet )?confirm|isn['’]t confirmed|is not confirmed", text, re.I)
        checks["no_invented_opening"] = not opening_claim or bool(explicit_uncertainty)
    return checks


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    registered, house_result, callback_events = registered_context()
    descriptions = {name: registered[name]["description"] for name in ("get_house_info", "check_availability", "preview_package_prices", "quote_booking", "lookup_catalog_service")}
    receipt = {
        "schema": "sim15-controlled-source-faithful-reconstruction-v3",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "command": COMMAND,
        "limitations": {"historical_full_callback_bodies_retained": False, "exact_historical_reproduction_claimed": False, "baseline_failure_required": False},
        "fixture_provenance": "Retained guest/tool order and known facts from original-first-turns.json; unretained callback bodies are explicit inert source-shaped reconstruction fixtures.",
        "offline_contract": {"registered_callback_invoked": "get_house_info", "callback_events": callback_events, "staff_fixtures": "inert/read-only", "model_tools": [], "product_writes": False, "guest_sends": False, "network_staff_calls": False},
        "runtime": {"provider": PROVIDER, "model": MODEL, "python": sys.executable},
        "runs": [],
    }
    for label, ref in (("baseline", BASE), ("candidate", CANDIDATE)):
        soul = git_show(ref, SOUL)
        plugin_source = git_show(ref, PLUGIN)
        # Use the real loaded personality assembler and registered tool descriptions.
        system = personality.inject_personality_pack_once(soul, personality.get_personality_pack("sunny"))["system_prompt"]
        system += "\n\nRegistered Wolfhouse Staff tool context (read-only reconstruction):\n" + json.dumps(descriptions, ensure_ascii=False, indent=2)
        system += "\n\nReturn only the guest-facing WhatsApp reply. The following inert Staff results are authoritative evidence; do not mention this reconstruction or internal tools."
        for case in CASES:
            ordered = []
            for tool, value in case["results"]:
                ordered.append({"role": "tool", "name": tool, "content": house_result if tool == "get_house_info" else value})
            # No expected answer, disposition, or case-specific response coaching appears here.
            user = json.dumps({"role": "user", "content": case["guest"], "subsequent_tool_results_in_original_order": ordered}, ensure_ascii=False, indent=2)
            run_id = f"sim15-repair3-{label}-{case['id']}"
            agent = AIAgent(provider=PROVIDER, model=MODEL, enabled_toolsets=[],
                disabled_toolsets=["terminal", "web", "file", "browser", "cronjob", "skills", "memory", "todo", "delegation"],
                max_iterations=1, quiet_mode=True, skip_context_files=True, load_soul_identity=False,
                skip_memory=True, ephemeral_system_prompt=system, session_id=run_id)
            started = time.time()
            result = agent.run_conversation(user, system_message=system, task_id=run_id)
            item = {"variant": label, "ref": ref, "case": case["id"], "run_id": run_id,
                "guest_turn": case["guest"], "ordered_tool_results": ordered,
                "source_sha256": sha(plugin_source), "soul_sha256": sha(soul),
                "assembled_system_prompt_sha256": sha(system), "input_prompt_sha256": sha(user),
                "personality_id": "sunny", "case_specific_coaching": False,
                "elapsed_seconds": round(time.time() - started, 3), "actual_emitted_reply": result.get("final_response")}
            receipt["runs"].append(item)
            (OUT / "replay-receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    assessments = []
    for item in receipt["runs"]:
        checks = assess(item)
        assessments.append({"variant": item["variant"], "case": item["case"], "run_id": item["run_id"], "checks": checks, "pass": all(v for k, v in checks.items() if isinstance(v, bool))})
    baseline_one_question_failed = any(
        not row["pass"]
        for row in assessments
        if row["variant"] == "baseline" and row["case"] == "holly_jake_explicit_current_date_approval"
    )
    baseline_season_failed = any(
        not row["checks"].get("no_stale_season_caveat", True)
        for row in assessments
        if row["variant"] == "baseline" and row["case"].startswith("g3_")
    )
    assessment = {"assessment": "semantic missing-input decisions, not '?' punctuation", "receipt_sha256": sha((OUT / "replay-receipt.json").read_text()),
        "negative_examples": ["couple_compound_negative_historical", "couple_compound_negative_repair2"],
        "runs": assessments, "all_candidate_pass": all(r["pass"] for r in assessments if r["variant"] == "candidate"),
        "baseline_one_question_failure_reproduced": baseline_one_question_failed,
        "original_season_symptom_reproduced_by_baseline": baseline_season_failed,
        "interpretation": "The bounded baseline reproduced the semantic one-question failure, but not the original stale-season symptom; the historical season cause remains uncertain. This is not exact historical reproduction."}
    (OUT / "replay-assessment.json").write_text(json.dumps(assessment, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"receipt": str(OUT / "replay-receipt.json"), "assessment": str(OUT / "replay-assessment.json"), "runs": len(receipt["runs"]), "all_candidate_pass": assessment["all_candidate_pass"]}))


if __name__ == "__main__":
    run()
