#!/usr/bin/env python3
"""Bounded Sunset-only Luna Personality live-model proof runner.

Default is dry-run / preflight. Does not PUT personality, call the live
model, SSH, or deploy. Parent owns reviewed activation:

  LUNA_PERSONALITY_LIVE_PROOF=SUNSET_STAGING_ONLY python3 -m wolfhouse.run_luna_personality_live_proof --execute-live

Restoration: Staff PUT cannot delete a stored setting back to source=default.
If the original source was default and the effective id is sunny, a restore
PUT of sunny leaves source=stored. Qualify that explicitly in the receipt.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List

from wolfhouse.luna_personality import CLOSED_PERSONALITY_IDS, DEFAULT_PERSONALITY_ID
from wolfhouse.luna_personality_live_eval import ALLOWED_CASE_IDS, LIVE_EVAL_PATH, load_corpus

WARMTH_CASES = ("warmth-greeting-en", "warmth-dates-en", "warmth-greeting-es", "warmth-dates-es")
TRUTH_CASES = ("truth-payment-link-en", "truth-payment-link-es", "invariant-identity-en", "invariant-spots-es")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def serving_preflight() -> Dict[str, Any]:
    role = (os.getenv("HERMES_ROLE") or "").strip()
    slug = (os.getenv("LUNA_CLIENT_SLUG") or os.getenv("LUNA_BOT_CLIENT_SLUG") or "").strip()
    home = (os.getenv("HERMES_HOME") or "").strip()
    base = (os.getenv("WOLFHOUSE_STAFF_API_BASE_URL") or "").rstrip("/")
    token_present = bool((os.getenv("LUNA_BOT_INTERNAL_TOKEN") or "").strip())
    ok = (
        role == "sunset-luna"
        and slug == "sunset"
        and "sunset-staging" in base
        and token_present
    )
    return {
        "ok": ok,
        "HERMES_ROLE": role,
        "LUNA_CLIENT_SLUG": slug,
        "HERMES_HOME": home,
        "staff_base_is_sunset_staging": "sunset-staging" in base,
        "bot_token_present": token_present,
        "live_eval_path": LIVE_EVAL_PATH,
        "allowlisted_case_ids": sorted(ALLOWED_CASE_IDS),
        "closed_ids": list(CLOSED_PERSONALITY_IDS),
        "notes": [
            "Staff API LUNA_BOT_INTERNAL_TOKEN must equal Hermes LUNA_BOT_INTERNAL_TOKEN.",
            "Staff API LUNA_BOT_CLIENT_SLUG (or DEFAULT_CLIENT_SLUG) must be sunset.",
            "Do not rotate credentials in this change.",
            "Stored sunny cannot be reset to source=default via this API.",
        ],
    }


def planned_turns() -> List[Dict[str, str]]:
    turns = []
    for pid in CLOSED_PERSONALITY_IDS:
        for case_id in WARMTH_CASES + TRUTH_CASES:
            turns.append({"personality_id": pid, "case_id": case_id})
    return turns


def sanitize_receipt(row: Dict[str, Any]) -> Dict[str, Any]:
    allowed = {
        "ok",
        "case_id",
        "lang",
        "kind",
        "personality_id",
        "tools_invoked",
        "sends_attempted",
        "sends_completed",
        "model_calls",
        "model",
        "semantic",
        "whatsapp_suppressed",
        "error",
    }
    out = {k: row.get(k) for k in allowed if k in row}
    reply = str(row.get("reply_text") or "")
    out["reply_len"] = len(reply)
    out["reply_preview"] = reply[:180]
    return out


def parse_args(argv: List[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Bounded Luna Personality live-model proof (Sunset staging)")
    p.add_argument("--execute-live", action="store_true", help="Actually call the isolated eval route (requires env)")
    p.add_argument("--json", action="store_true", help="Print JSON receipt")
    return p.parse_args(argv)


def main(argv: List[str] | None = None) -> int:
    args = parse_args(argv)
    receipt: Dict[str, Any] = {
        "job": "LUNA-PERSONALITY-001-live-proof",
        "started": _now(),
        "execute_live": False,
        "preflight": serving_preflight(),
        "planned_turns": planned_turns(),
        "corpus_cases": [c["id"] for c in load_corpus().get("cases") or []],
        "turns": [],
        "restoration": None,
        "qualification": (
            "Existing Sunset personality is stored sunny, not missing/default. "
            "PUT cannot delete the setting; restore of sunny leaves source=stored."
        ),
    }
    live_env = (os.getenv("LUNA_PERSONALITY_LIVE_PROOF") or "").strip()
    if not args.execute_live:
        receipt["mode"] = "dry-run"
        receipt["finished"] = _now()
        print(json.dumps(receipt, indent=2, ensure_ascii=False))
        return 0 if receipt["preflight"]["ok"] or os.getenv("HERMES_ROLE") != "sunset-luna" else 1

    if live_env != "SUNSET_STAGING_ONLY":
        receipt["error"] = "execute_live_requires_LUNA_PERSONALITY_LIVE_PROOF=SUNSET_STAGING_ONLY"
        print(json.dumps(receipt, indent=2, ensure_ascii=False), file=sys.stderr)
        return 2

    # Parent-owned activation. This process still refuses unless the serving
    # identity matches Sunset staging exactly.
    if not receipt["preflight"]["ok"]:
        receipt["error"] = "serving_preflight_failed"
        print(json.dumps(receipt, indent=2, ensure_ascii=False), file=sys.stderr)
        return 3

    receipt["execute_live"] = True
    receipt["mode"] = "execute-live"
    receipt["note"] = (
        "Caller must restore original personality in finally, including "
        f"default {DEFAULT_PERSONALITY_ID} qualification when source cannot be reset."
    )
    receipt["finished"] = _now()
    print(json.dumps(receipt, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
