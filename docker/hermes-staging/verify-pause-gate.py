#!/usr/bin/env python3
"""Static checks for Hermes Luna pause gate wiring."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PAUSE = ROOT / "wolfhouse" / "pause_gate.py"
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
    check("webhook body phone parse", "_phones_from_webhook_body" in pause)
    check("send block helper", "whatsapp_send_blocked" in pause)
    check("webhook patch installer", "install_whatsapp_pause_webhook_patch" in pause)
    check("runtime send suppression", "suppressed_guest_automation_paused" in patches)
    check("runtime webhook hook", "pause_webhook" in patches and "install_whatsapp_pause_webhook_patch" in patches)

    print(f"\nverify-pause-gate: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
