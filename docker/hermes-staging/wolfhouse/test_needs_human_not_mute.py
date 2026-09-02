#!/usr/bin/env python3
"""RED/GREEN: needs_human is review state, not an inbound mute.

SUNSET-LUNA-LIVE-TEST-001 defect 4:
  Setting Needs human must not mute Luna.
  On the handoff turn: persist the review flag AND produce guest-visible reassurance.
  On later inbound turns: Luna keeps answering answerable questions.
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
STAGING = ROOT.parent
PAUSE_PATH = ROOT / "pause_gate.py"
HANDOFF_PATH = ROOT / "explicit_human_handoff.py"
PATCHES_PATH = STAGING / "apply_gateway_patches.py"

passed = 0
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}" + (f" — {detail}" if detail else ""))


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    pause = _load(PAUSE_PATH, "pause_gate_nh_under_test")
    pause._CACHE.clear()
    src = PAUSE_PATH.read_text(encoding="utf-8")

    print("\n[A] needs_human is not an agent/send suppression condition")
    check(
        "pause_gate does not OR raw needs_human into agent pause",
        'data.get("needs_human") is True' not in src
        and "payload.get(\"needs_human\") is True" not in src,
    )
    sunset_nh = {
        "success": True,
        "bot_paused": False,
        "live_send_blocked": False,
        "can_continue_guest_automation": True,
        "paused": False,
        "needs_human": True,
        "whatsapp_channel_mode": "auto",
        "source": "default_active",
    }
    disp = pause.outbound_disposition_from_gate(sunset_nh)
    check("Sunset needs_human keeps agent running", disp.get("agent_paused") is False, str(disp))
    check("Sunset needs_human does not block Meta send", disp.get("send_blocked") is False, str(disp))
    check("Sunset needs_human is not a draft toggle", disp.get("stage_as_draft") is False, str(disp))
    check("_agent_paused_from_gate ignores needs_human", pause._agent_paused_from_gate(sunset_nh) is False)

    wolf_nh = {
        "success": True,
        "bot_paused": True,
        "live_send_blocked": True,
        "can_continue_guest_automation": False,
        "paused": True,
        "needs_human": True,
        "source": "conversations_needs_human",
        "whatsapp_channel_mode": "auto",
    }
    wolf = pause.outbound_disposition_from_gate(wolf_nh)
    check("Wolfhouse needs_human still pauses via bot_paused", wolf.get("agent_paused") is True, str(wolf))

    print("\n[B] Later inbound on a Needs-human Sunset thread still runs the agent")
    class _NhResp:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def read(self):
            return json.dumps(sunset_nh).encode("utf-8")

    pause._CACHE.clear()
    with mock.patch.dict(
        os.environ,
        {
            "HERMES_ROLE": "sunset-luna",
            "LUNA_CLIENT_SLUG": "sunset",
            "LUNA_BOT_INTERNAL_TOKEN": "tok",
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff.example",
        },
        clear=False,
    ):
        with mock.patch("urllib.request.urlopen", return_value=_NhResp()):
            later = pause.guest_automation_paused("+34600111222", force_refresh=True)
            send_blocked = pause.whatsapp_send_blocked("+34600111222")
    check("later inbound is not paused", later is False)
    check("later inbound send is not suppressed by needs_human", send_blocked is False)

    print("\n[C] Handoff turn: persist review flag AND guest-visible reassurance")
    handoff = _load(HANDOFF_PATH, "explicit_human_handoff_nh_under_test")
    ack = handoff.acknowledgement_for("I want to speak to a human")
    check("handoff ack is guest-visible", len(ack) > 10 and "teammate" in ack.lower() or "equipo" in ack.lower() or "team" in ack.lower(), ack)
    check("handoff ack asks no question", "?" not in ack, ack)
    check(
        "draft-mode staged ack is not treated as a failed mute",
        "suppressed_draft_mode" not in handoff._SUPPRESSED_MARKERS,
        str(handoff._SUPPRESSED_MARKERS),
    )
    patches = PATCHES_PATH.read_text(encoding="utf-8")
    check(
        "send path does not treat needs_human as the send block",
        "needs_human" not in patches.lower() or "stage_as_draft" in patches,
    )

    print(f"\ntest_needs_human_not_mute: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
