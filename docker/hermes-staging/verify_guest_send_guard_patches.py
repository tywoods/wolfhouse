#!/usr/bin/env python3
"""Static gate for Luna guest WhatsApp send guard patches."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def fail(msg: str) -> None:
    print(f"FAIL  {msg}", file=sys.stderr)
    raise SystemExit(1)


def ok(msg: str) -> None:
    print(f"PASS  {msg}")


def main() -> int:
    guard = (ROOT / "wolfhouse" / "guest_send_guard.py").read_text(encoding="utf-8")
    patches = (ROOT / "apply_guest_send_guard_patches.py").read_text(encoding="utf-8")
    gateway = (ROOT / "apply_gateway_patches.py").read_text(encoding="utf-8")
    bootstrap = (ROOT / "bootstrap.sh").read_text(encoding="utf-8")
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    stt = (ROOT / "apply_stt_patches.py").read_text(encoding="utf-8")

    for needle in (
        "wolfhouse_guest_reply",
        "suppress_guest_whatsapp_text_send",
        "guest_stt_echo_enabled",
        "stt_dev_hints_enabled",
    ):
        if needle not in guard:
            fail(f"guest_send_guard missing {needle}")
    ok("guest_send_guard module")

    for needle in (
        "STT_FAIL_SEND_BLOCK",
        "APPROVAL_GUARD",
        "mark_agent_reply_metadata",
        "suppress_guest_interactive_send",
        "reapply_plain_reply_patches",
    ):
        if needle not in patches:
            fail(f"apply_guest_send_guard_patches missing {needle}")
    ok("guest send guard patch script")

    if "suppress_guest_whatsapp_text_send" not in gateway:
        fail("apply_gateway_patches runtime wrapper not wired")
    ok("runtime whatsapp wrapper")

    if "apply_guest_send_guard_patches.py" not in bootstrap:
        fail("bootstrap missing guest send guard hook")
    if "apply_stt_patches.py" not in bootstrap:
        fail("bootstrap missing stt patch hook")
    ok("bootstrap hooks")

    for needle in ("apply_guest_send_guard_patches.py", "apply_stt_patches.py", "apply_gateway_patches.py"):
        if needle not in dockerfile:
            fail(f"Dockerfile missing {needle}")
    ok("Dockerfile")

    if "STT_PROVIDER" not in stt:
        fail("apply_stt_patches missing STT_PROVIDER")
    ok("stt patches")

    print("\nverify_guest_send_guard_patches PASSED\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
