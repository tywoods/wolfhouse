#!/usr/bin/env python3
"""Static checks for Hermes Luna pause gate + kill-switch wiring.

Wiring only. The behaviour these names are supposed to have is proved by
`scripts/verify-hermes-send-flags.js`, which runs the patched send for real.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PAUSE = ROOT / "wolfhouse" / "pause_gate.py"
FLAGS = ROOT / "wolfhouse" / "send_flags.py"
PATCHES = ROOT / "apply_gateway_patches.py"

passed = 0
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        msg = f"  FAIL  {name}"
        if detail:
            msg += f" — {detail}"
        print(msg)


def main() -> int:
    pause = PAUSE.read_text(encoding="utf-8")
    patches = PATCHES.read_text(encoding="utf-8")

    check("pause_gate module exists", PAUSE.is_file())
    check("calls check-guest-automation-gate", "check-guest-automation-gate" in pause)
    check("uses LUNA_CLIENT_SLUG", "LUNA_CLIENT_SLUG" in pause)
    check("enables sunset-luna runtime", "_is_luna_runtime" in pause and 'endswith("-luna")' in pause)
    check("webhook body phone parse", "_phones_from_webhook_body" in pause)
    check("send block helper", "whatsapp_send_blocked" in pause)
    check("guest_paused_for_event helper", "guest_paused_for_event" in pause)
    check("webhook patch installer", "install_whatsapp_pause_webhook_patch" in pause)
    check("runtime send suppression", "suppressed_guest_automation_paused" in patches)
    check("runtime webhook hook", "pause_webhook" in patches and "install_whatsapp_pause_webhook_patch" in patches)

    flags = FLAGS.read_text(encoding="utf-8")
    check("send_flags module exists", FLAGS.is_file())
    check("reads WHATSAPP_DRY_RUN", "WHATSAPP_DRY_RUN" in flags)
    check("reads LUNA_AUTO_SEND_ENABLED", "LUNA_AUTO_SEND_ENABLED" in flags)
    check("send patch consults the kill switches", "guest_whatsapp_send_flag_block(chat_id)" in patches)
    check(
        "kill switches are checked before the pause gate",
        patches.index("guest_whatsapp_send_flag_block(chat_id)")
        < patches.index("from wolfhouse.pause_gate import whatsapp_send_blocked"),
    )
    check("a flag-blocked send is logged", "log_flag_block" in patches and "logger.warning" in flags)

    print(f"\nverify-pause-gate: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
