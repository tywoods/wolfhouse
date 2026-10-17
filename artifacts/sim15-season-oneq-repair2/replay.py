#!/usr/bin/env python3
"""Bounded offline SIM15 baseline/candidate reply replay.

No tools are exposed to the model. Inputs are explicit synthetic snapshots and
all evidence is written below the repository worktree.
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "artifacts" / "sim15-season-oneq-repair2"
BASE = "d1d42d5b45c42173848ac8ff29f272489cd3768f"
CANDIDATE = "904f1133b2910f1b79af2718805cd7aa9c9da1a9"
PLUGIN = "docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py"
SOUL = "docker/hermes-staging/SOUL.md"
MODEL = "gpt-5.6-sol"
PROVIDER = "openai-codex"

sys.path.insert(0, "/opt/hermes")
from run_agent import AIAgent  # noqa: E402


def git_show(ref: str, path: str) -> str:
    return subprocess.run(
        ["git", "show", f"{ref}:{path}"], cwd=ROOT, check=True,
        text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ).stdout


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def house_tool_description(source: str) -> str:
    match = re.search(
        r'\("get_house_info",\s*"((?:[^"\\]|\\.)*)",\s*get_house_info,', source
    )
    if not match:
        raise RuntimeError("get_house_info registration description not found")
    return bytes(match.group(1), "utf-8").decode("unicode_escape")


STALE_NOTES = {
    "success": True,
    "tool": "get_house_info",
    "has_notes": True,
    "notes": (
        "Season normally runs Easter through Halloween. Guests aged 16 may stay "
        "without a parent, but every overnight guest needs a booked available bed."
    ),
}

CASES = [
    {
        "id": "approved_november_g3",
        "guest": (
            "hi! Aisha — me + 2 friends (all women, 22-24) want 3 nights Nov 3-6 "
            "(check-in Tue 3 Nov, out Fri 6 Nov 2026). Do you have a surf+stay package, "
            "or is bed-only cheaper? Also my 16yo sister might crash one night — is that allowed?"
        ),
        "results": [
            STALE_NOTES,
            {"success": True, "tool": "check_availability", "check_in": "2026-11-03", "check_out": "2026-11-06", "guest_count": 3, "next_action": "ready_for_bot_create", "available_room_options": ["women-only dorm", "mixed dorm"]},
            {"success": True, "tool": "current_date_pricing_authority", "dates_approved": True, "check_in": "2026-11-03", "check_out": "2026-11-06", "accommodation_only_available": True, "surf_stay_min_nights": 7},
        ],
        "instruction": "Answer supported package/bed-only and minor-policy facts. Ask at most one genuinely missing next question: which dorm option. Defer the separate sister-night clarification; do not ask which night.",
    },
    {
        "id": "approved_november_holly_jake",
        "guest": "Hiya — Holly & Jake from Bristol (a couple, she/he). Private room if you have one, Nov 3-6 (3 nights). Can we rent boards there, what's parking like?",
        "results": [
            STALE_NOTES,
            {"success": True, "tool": "check_availability", "check_in": "2026-11-03", "check_out": "2026-11-06", "guest_count": 2, "room_type": "private", "private_room_available": True, "next_action": "ready_for_bot_create"},
            {"success": True, "tool": "current_date_pricing_authority", "dates_approved": True, "check_in": "2026-11-03", "check_out": "2026-11-06"},
            {"success": True, "tool": "lookup_catalog_service", "matched": True, "service": "surfboard rental", "pricing_requires_board_type_and_dates": True},
        ],
        "instruction": "Preserve their already-known private-room preference; do not re-ask private versus shared. Answer known parking/board facts and ask at most one genuinely missing next question.",
    },
    {
        "id": "closed_season",
        "guest": "Can Holly and Jake stay in a private room from 3–6 November 2026?",
        "results": [
            {"success": True, "tool": "get_house_info", "has_notes": True, "notes": "Open year-round with parking on site."},
            {"success": True, "tool": "check_availability", "capacity_available": True, "check_in": "2026-11-03", "check_out": "2026-11-06"},
            {"success": False, "tool": "quote_booking", "next_action": "closed_season", "check_in": "2026-11-03", "check_out": "2026-11-06", "write_performed": False},
        ],
        "instruction": "Respect the authoritative closed_season result despite permissive notes or capacity. Ask at most one question about alternative dates.",
    },
    {
        "id": "missing_date_authority",
        "guest": "Can Holly and Jake stay in a private room from 3–6 November 2026?",
        "results": [STALE_NOTES, {"success": True, "tool": "house_capacity_hint", "capacity_available": True}],
        "instruction": "No current pricing/date result exists. Do not claim that the property is open or that the stay is available. Ask at most one useful next question without re-asking known dates.",
    },
]


def run() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    receipt = {
        "schema": "sim15-real-agent-offline-replay-v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "command": "/opt/hermes/.venv/bin/python .sim15-repair2-replay.py",
        "offline_contract": {"model_tools": [], "writes": "receipt files under worktree only", "sends": False},
        "provider": PROVIDER,
        "model": MODEL,
        "loaded_personality": "Luna guest identity from docker/hermes-staging/SOUL.md",
        "runs": [],
    }
    for label, ref in (("baseline", BASE), ("candidate", CANDIDATE)):
        soul = git_show(ref, SOUL)
        source = git_show(ref, PLUGIN)
        desc = house_tool_description(source)
        system = (
            soul
            + "\n\nOFFLINE REPLAY BOUNDARY: Return only the guest-facing WhatsApp reply. "
              "Do not call tools, mention this replay, or invent facts. The supplied tool results are the complete evidence.\n\n"
            + "Loaded get_house_info tool description:\n" + desc
        )
        provenance = {
            "variant": label,
            "ref": ref,
            "source_sha256": sha(source),
            "soul_sha256": sha(soul),
            "tool_description_sha256": sha(desc),
            "system_prompt_sha256": sha(system),
            "tool_description": desc,
        }
        for case in CASES:
            run_id = f"sim15-repair2-{label}-{case['id']}"
            user = (
                "Original guest turn:\n" + case["guest"]
                + "\n\nExplicit synthetic Staff/notes tool results:\n"
                + json.dumps(case["results"], ensure_ascii=False, indent=2)
                + "\n\nCase-specific response constraint:\n" + case["instruction"]
            )
            agent = AIAgent(
                provider=PROVIDER, model=MODEL, enabled_toolsets=[],
                disabled_toolsets=["terminal", "web", "file", "browser", "cronjob", "skills", "memory", "todo", "delegation"],
                max_iterations=1, quiet_mode=True, skip_context_files=True,
                load_soul_identity=False, skip_memory=True,
                ephemeral_system_prompt=system, session_id=run_id,
            )
            started = time.time()
            result = agent.run_conversation(user, system_message=system, task_id=run_id)
            receipt["runs"].append({
                **provenance,
                "case": case["id"],
                "run_id": run_id,
                "input_prompt_sha256": sha(user),
                "guest_turn": case["guest"],
                "input_tool_results": case["results"],
                "case_instruction": case["instruction"],
                "elapsed_seconds": round(time.time() - started, 3),
                "actual_emitted_reply": result.get("final_response"),
                "agent_result_metadata": {k: v for k, v in result.items() if k != "final_response" and isinstance(v, (str, int, float, bool, type(None)))},
            })
            (OUT / "replay-receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"receipt": str(OUT / "replay-receipt.json"), "runs": len(receipt["runs"])}))


if __name__ == "__main__":
    run()
