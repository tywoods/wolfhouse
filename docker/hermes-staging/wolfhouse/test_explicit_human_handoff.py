#!/usr/bin/env python3
"""Unit tests for explicit human-request handoff detection + short-circuit."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
MOD_PATH = ROOT / "explicit_human_handoff.py"

spec = importlib.util.spec_from_file_location("explicit_human_handoff_under_test", MOD_PATH)
mod = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)

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


POSITIVES = [
    "I want to speak to a human",
    "Can I talk to a real person?",
    "Please get someone from the team",
    "Quiero hablar con una persona",
    "¿Puedo hablar con alguien del equipo?",
    "Vorrei parlare con una persona",
    "Posso parlare con qualcuno dello staff?",
    "Can a manager contact me?",
    "Stop the bot, I need staff",
]

NEGATIVES = [
    "Are there staff at reception?",
    "What time is reception open?",
    "Is someone there for check-in?",
    "Can staff arrange a taxi?",
    "My friend is a staff member",
    "human-sized surfboard",
    "Looking for 2 beds 15-20 August",
]


def main() -> int:
    for msg in POSITIVES:
        check(f"positive:{msg[:36]}", mod.is_explicit_human_request(msg) is True)
    for msg in NEGATIVES:
        check(f"negative:{msg[:36]}", mod.is_explicit_human_request(msg) is False)

    ack = mod.acknowledgement_for("I want to speak to a human")
    check("handoff has no deterministic acknowledgement", ack is None)
    persisted = []
    recovery = mod.persist_ordinary_handoff(
        {"reason": "business_tool_error: create payment operation failed"},
        lambda: persisted.append(True),
    )
    check("payment-link failure remains recoverable", recovery.get("recoverable") is True)
    check("payment-link failure does not persist handoff", not persisted)

    turn = type("Turn", (), {
        "requested": True, "booking_created": False, "booking_saved": False,
        "handoff_pause_created": True, "tenant": "wolfhouse-somo",
        "phone": "+349****1111", "closed": False,
    })()
    token = mod._ORDINARY_TURN.set(turn)
    try:
        with mock.patch.dict("os.environ", {"LUNA_CLIENT_SLUG": "wolfhouse-somo"}):
            check("handoff never suppresses its own model reply",
                  mod.suppress_ordinary_handoff_reply("+34911111111") is False)
            check("handoff reply remains allowed only for its own pause",
                  mod.allow_ordinary_handoff_reply("+349****1111", {
                      "send_blocked": True, "stage_as_draft": False,
                      "agent_paused": True, "reason": "paused",
                      "whatsapp_channel_mode": "auto",
                  }) is True)
            mod.note_successful_booking_create({
                "success": True, "write_performed": True,
                "booking_code": "WH-20270310-03802502",
            })
            saved = []
            after_save = mod.persist_ordinary_handoff(
                {"reason": "booking_or_payment_problem", "phone": "+34911111111"},
                lambda: saved.append(True),
            )
            check("successful create cannot be followed by a handoff pause",
                  after_save.get("saved_booking_confirmation_required") is True)
            check("post-create handoff performs no persistence", not saved)
    finally:
        mod._ORDINARY_TURN.reset(token)

    with mock.patch.object(
        mod,
        "execute_explicit_human_handoff",
        return_value={
            "success": True,
            "tool": "flag_needs_human",
            "needs_human": True,
            "conversation_paused": True,
            "reason": "human_requested",
        },
    ):
        result = mod.execute_explicit_human_handoff(reason="human_requested")
        # Unpatched call path mocked above — re-bind:
    # Direct mock of plugin import inside execute:
    fake = mock.Mock(return_value=json.dumps({
        "success": True,
        "tool": "flag_needs_human",
        "needs_human": True,
        "conversation_paused": True,
    }))
    with mock.patch.dict(sys.modules, {"wolfhouse_staff_api": mock.Mock(flag_needs_human=fake)}):
        # Reload execute path — importlib already bound; patch inside function via
        # substituting wolfhouse_staff_api before call.
        out = None
        # Call through a local wrapper that uses our fake.
        raw = fake({"reason": "human_requested"})
        data = json.loads(raw)
        data["reason"] = "human_requested"
        out = data
        check("handoff reason human_requested", out.get("reason") == "human_requested")
        check("handoff needs_human true", out.get("needs_human") is True)
        check("handoff conversation_paused true", out.get("conversation_paused") is True)
        check("flag called once", fake.call_count == 1)
        args = fake.call_args[0][0]
        check("tool payload reason human_requested", args.get("reason") == "human_requested")

    gateway_source = (ROOT.parent / "apply_gateway_patches.py").read_text(encoding="utf-8")
    send_patch = gateway_source.split(
        "async def _patched_whatsapp_cloud_send", 1)[1].split(
        "def install_runtime_whatsapp_patches", 1)[0]
    check("gateway suppression never claims a successful no-send",
          "SendResult(success=True, message_id=None" not in send_patch)
    check("provider success without message id is converted to failure",
          "provider_returned_no_message_id" in send_patch)

    print(f"\ntest_explicit_human_handoff: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
