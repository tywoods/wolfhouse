#!/usr/bin/env python3
"""RED/GREEN: Draft-mode WhatsApp turns persist an Inbox draft and never send.

SUNSET-LUNA-LIVE-TEST-001 defect 1:
  Tenant/channel Draft mode must create an editable Inbox draft on the same
  conversation. It must not send to Meta and must not stay silent with no draft.

Offline only: no network, no Docker, no guest WhatsApp.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
STAGING = ROOT.parent
PAUSE_PATH = ROOT / "pause_gate.py"
MIRROR_PATH = STAGING / "wolfhouse_whatsapp_mirror.py"
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
    pause = _load(PAUSE_PATH, "pause_gate_draft_under_test")
    pause._CACHE.clear()

    print("\n[A] Draft-mode disposition: agent drafts, Meta send blocked, persist draft")
    draft_gate = {
        "success": True,
        "bot_paused": False,
        "live_send_blocked": True,
        "can_continue_guest_automation": True,
        "paused": False,
        "needs_human": False,
        "whatsapp_channel_mode": "draft",
        "stage_outbound_as_draft": True,
    }
    check("pause_gate exports outbound_disposition_from_gate", hasattr(pause, "outbound_disposition_from_gate"))
    disp = pause.outbound_disposition_from_gate(draft_gate)
    check("draft keeps agent running", disp.get("agent_paused") is False, str(disp))
    check("draft blocks provider send", disp.get("send_blocked") is True, str(disp))
    check("draft stages inbox draft", disp.get("stage_as_draft") is True, str(disp))
    check("draft reason names channel mode", "draft" in str(disp.get("reason") or "").lower(), str(disp))

    off_gate = {
        "success": True,
        "bot_paused": True,
        "live_send_blocked": True,
        "can_continue_guest_automation": False,
        "paused": True,
        "whatsapp_channel_mode": "off",
    }
    off = pause.outbound_disposition_from_gate(off_gate)
    check("off pauses agent", off.get("agent_paused") is True, str(off))
    check("off blocks send", off.get("send_blocked") is True, str(off))
    check("off does not stage a draft", off.get("stage_as_draft") is False, str(off))

    auto_gate = {
        "success": True,
        "bot_paused": False,
        "live_send_blocked": False,
        "can_continue_guest_automation": True,
        "paused": False,
        "whatsapp_channel_mode": "auto",
    }
    auto = pause.outbound_disposition_from_gate(auto_gate)
    check("auto does not block send", auto.get("send_blocked") is False, str(auto))
    check("auto does not stage a draft", auto.get("stage_as_draft") is False, str(auto))

    print("\n[B] Draft persist is a mirror side-effect — zero provider sends")
    mirror = _load(MIRROR_PATH, "whatsapp_mirror_draft_under_test")
    check("mirror exports mirror_whatsapp_outbound_as_draft", hasattr(mirror, "mirror_whatsapp_outbound_as_draft"))

    posted = []

    def _capture_enqueue(payload):
        posted.append(dict(payload))
        return True

    with mock.patch.dict(
        os.environ,
        {
            "LUNA_CLIENT_SLUG": "sunset",
            "SUNSET_INGRESS_LOCATION_ID": "sunset-somo",
            "LUNA_BOT_INTERNAL_TOKEN": "tok",
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff.example",
        },
        clear=False,
    ):
        with mock.patch.object(mirror, "enqueue_mirror_payload", side_effect=_capture_enqueue):
            provider_calls = []

            def _forbidden_provider(*_a, **_k):
                provider_calls.append(True)
                raise AssertionError("provider send must not run in Draft mode")

            with mock.patch.object(mirror, "_post_mirror_sync", side_effect=_forbidden_provider):
                staged = mirror.mirror_whatsapp_outbound_as_draft(
                    "+34600111222",
                    "Draft-mode reply for Hernan — please review in Inbox.",
                    {"conversation_id": "conv-hernan"},
                )

    check("draft persist reports staged", staged is True or (isinstance(staged, dict) and staged.get("staged") is True), str(staged))
    check("exactly one outbound mirror payload", len(posted) == 1, str(posted))
    payload = posted[0] if posted else {}
    check("payload direction outbound", payload.get("direction") == "outbound", str(payload))
    check("payload has guest-visible draft text", "Hernan" in str(payload.get("message_text") or ""), str(payload))
    check("payload has no Meta wamid (not a send)", not payload.get("whatsapp_message_id"), str(payload))
    check("payload is sunset tenant", payload.get("client_slug") == "sunset", str(payload))
    check("zero provider/post-sync sends", provider_calls == [], str(provider_calls))

    print("\n[C] Send patch stages the draft when Draft mode blocks Meta")
    patches = PATCHES_PATH.read_text(encoding="utf-8")
    check(
        "send patch consults outbound_disposition / stage_as_draft",
        "outbound_disposition" in patches or "stage_as_draft" in patches,
    )
    check(
        "send patch calls mirror_whatsapp_outbound_as_draft",
        "mirror_whatsapp_outbound_as_draft" in patches,
    )
    check(
        "draft-blocked send never calls original provider",
        "suppressed_draft_mode" in patches or "stage_as_draft" in patches,
    )
    # Kill-switch / pause suppression must not be the only path; Draft is persistence.
    send_fn = patches
    idx_disp = send_fn.find("stage_as_draft")
    idx_orig = send_fn.find("_orig_whatsapp_cloud_send")
    check(
        "draft staging is decided before provider send",
        idx_disp != -1 and idx_orig != -1 and idx_disp < idx_orig,
        f"stage_as_draft@{idx_disp} orig@{idx_orig}",
    )

    print(f"\ntest_draft_mode_inbox_persist: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
