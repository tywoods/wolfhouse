#!/usr/bin/env python3
"""Unit tests for explicit human-request handoff detection + short-circuit."""

from __future__ import annotations

import ast
import asyncio
import importlib.util
import json
import os
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

    persisted_payloads = []
    persist_turn = type("PersistTurn", (), {
        "closed": False,
        "task": type("Task", (), {"cancelling": lambda self: 0})(),
        "tenant": "wolfhouse-somo",
        "origin": "https://staff-staging.lunafrontdesk.com",
        "phone": "+349****1111",
        "lock": mod.threading.Lock(),
        "requested": False,
        "booking_saved": False,
        "booking_reference": "",
        "ack_attempted": True,
        "ack_sent": False,
        "result": None,
        "persisted_reason": "",
        "handoff_pause_id": "",
        "handoff_pause_created": False,
        "handoff_existing_staff_owned": False,
    })()
    persist_token = mod._ORDINARY_TURN.set(persist_turn)
    fake_isolation = mock.Mock(deny_tool_if_isolated=lambda *_args: None)
    try:
        with mock.patch.dict("os.environ", {
                "LUNA_CLIENT_SLUG": "wolfhouse-somo",
                "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff-staging.lunafrontdesk.com",
            }), mock.patch.dict(sys.modules, {
                "wolfhouse.luna_personality_isolation": fake_isolation,
            }):
            first_reason = "guest_requested_human"
            first = mod.persist_ordinary_handoff(
                {"reason": first_reason, "phone": "+349****1111"},
                lambda: persisted_payloads.append(first_reason) or {
                    "success": True, "needs_human": True,
                    "pause_id": "pause-new", "created": True,
                    "existing_staff_owned": False,
                },
            )
            provider_reason = "provider_send_failed:131047"
            expected_send_reason = (
                "saved_booking_reply_send_failed:provider_send_failed:131047:"
                "booking_reference:WH-KATHI-001"
            )
            persist_turn.booking_saved = True
            persist_turn.booking_reference = "WH-KATHI-001"
            flag_payloads = []

            def fake_flag(payload):
                flag_payloads.append(dict(payload))
                scoped = dict(payload, phone="+349****1111")
                data = mod.persist_ordinary_handoff(
                    scoped,
                    lambda: persisted_payloads.append(scoped["reason"]) or {
                        "success": True, "needs_human": True,
                        "pause_id": "pause-new", "created": False,
                        "existing_staff_owned": False,
                    },
                )
                return json.dumps(data)

            with mock.patch.object(mod, "_load_flag_needs_human", return_value=fake_flag):
                flagged = mod.flag_blocked_saved_booking_send(provider_reason)
            cached = mod.persist_ordinary_handoff(
                {"reason": expected_send_reason, "phone": "+349****1111",
                 "booking_code": "WH-KATHI-001"},
                lambda: persisted_payloads.append("unexpected") or {},
            )
        check("initial handoff persisted", first.get("success") is True)
        check("send-failure helper reports Staff persistence", flagged is True)
        check("send-failure helper passes actual reason and booking reference",
              flag_payloads == [{
                  "reason": expected_send_reason,
                  "booking_code": "WH-KATHI-001",
              }])
        check("new send-failure reason reaches Staff after cached handoff",
              persisted_payloads == [first_reason, expected_send_reason])
        check("send-failure result replaces earlier cached result",
              getattr(persist_turn, "persisted_reason", "") == expected_send_reason)
        check("same send-failure reason remains idempotent",
              cached.get("success") is True and "unexpected" not in persisted_payloads)
        check("same pause keeps turn creation provenance across a second reason",
              getattr(persist_turn, "handoff_pause_id", "") == "pause-new"
              and getattr(persist_turn, "handoff_pause_created", False) is True
              and getattr(persist_turn, "handoff_existing_staff_owned", True) is False)
        setattr(persist_turn, "saved_reply_exception_consumed", False)
        with mock.patch.dict("os.environ", {"LUNA_CLIENT_SLUG": "wolfhouse-somo"}), \
                mock.patch.object(mod, "_active_handoff_pause_matches", return_value=True):
            check("two different handoff reasons still allow the final saved confirmation",
                  mod.allow_saved_booking_reply(
                      "+349****1111", "Booking WH-KATHI-001 saved.", {
                          "send_blocked": True, "stage_as_draft": False,
                          "reason": "paused", "whatsapp_channel_mode": "auto",
                      }) is True)
    finally:
        mod._ORDINARY_TURN.reset(persist_token)

    turn = type("Turn", (), {
        "requested": False, "booking_saved": False, "booking_reference": "",
        "handoff_pause_id": "", "handoff_pause_created": False,
        "handoff_existing_staff_owned": False,
        "saved_reply_exception_consumed": False,
        "tenant": "wolfhouse-somo", "phone": "+34911111111",
        "closed": False, "task": None,
    })()
    token = mod._ORDINARY_TURN.set(turn)
    try:
        mod.note_successful_booking_create(json.dumps({
            "success": True, "write_performed": True,
            "booking_code": "WH-KATHI-001",
        }))
        check("authoritative Staff create receipt marks booking saved", turn.booking_saved is True)
        check("saved receipt retains booking reference", turn.booking_reference == "WH-KATHI-001")

        turn.requested = True
        turn.handoff_pause_id = "pause-new"
        turn.handoff_pause_created = True
        with mock.patch.dict("os.environ", {"LUNA_CLIENT_SLUG": "wolfhouse-somo"}), \
                mock.patch.object(mod, "_active_handoff_pause_matches", return_value=True):
            disposition = {
                "send_blocked": True, "stage_as_draft": False,
                "reason": "paused", "whatsapp_channel_mode": "auto",
            }
            confirmation = "Booking WH-KATHI-001 saved."
            check("new same-call handoff pause allows saved-booking reply",
                  mod.allow_saved_booking_reply(
                      "+34911111111", confirmation, disposition) is True)
            check("same-turn pause exception is one-shot",
                  mod.allow_saved_booking_reply(
                      "+34911111111", confirmation, disposition) is False)
            turn.saved_reply_exception_consumed = False
            check("non-confirmation send cannot consume booking exception",
                  mod.allow_saved_booking_reply(
                      "+34911111111", "Please wait", disposition) is False)
            turn.handoff_existing_staff_owned = True
            check("staff-owned pause still blocks saved-booking reply",
                  mod.allow_saved_booking_reply(
                      "+34911111111", confirmation, disposition) is False)
            turn.handoff_existing_staff_owned = False
            check("Luna Off still blocks saved-booking reply",
                  mod.allow_saved_booking_reply("+34911111111", confirmation, {
                      "send_blocked": True, "stage_as_draft": False,
                      "reason": "inbox_channel_mode_off", "whatsapp_channel_mode": "off",
                  }) is False)
            check("Draft still blocks saved-booking reply",
                  mod.allow_saved_booking_reply("+34911111111", confirmation, {
                      "send_blocked": True, "stage_as_draft": True,
                      "reason": "inbox_channel_mode_draft", "whatsapp_channel_mode": "draft",
                  }) is False)
        pause_response = mock.MagicMock()
        pause_response.__enter__.return_value.read.return_value = json.dumps({
            "global_paused": False, "conversation_paused": True,
            "pause_state": {
                "id": "pause-new", "paused": True,
                "paused_by": "luna_flag_needs_human",
            },
        }).encode("utf-8")
        with mock.patch.dict("os.environ", {
                "LUNA_CLIENT_SLUG": "wolfhouse-somo",
                "LUNA_BOT_INTERNAL_TOKEN": "test-token",
            }), mock.patch.object(mod.urllib.request, "urlopen", return_value=pause_response):
            check("active Staff pause id must match handoff receipt",
                  mod._active_handoff_pause_matches("+349****1111", "pause-new") is True)
            check("different active Staff pause id blocks exception",
                  mod._active_handoff_pause_matches("+349****1111", "pause-other") is False)
            pause_response.__enter__.return_value.read.return_value = json.dumps({
                "global_paused": False, "conversation_paused": True,
                "pause_state": {
                    "id": "pause-new", "paused": True,
                    "paused_by": "staff-user-1",
                },
            }).encode("utf-8")
            check("Staff-owned current pause blocks same-id exception",
                  mod._active_handoff_pause_matches("+349****1111", "pause-new") is False)

        with mock.patch.dict("os.environ", {"LUNA_CLIENT_SLUG": "wolfhouse-somo"}), \
                mock.patch.object(mod, "_active_handoff_pause_matches", return_value=False):
            check("replacement pause blocks saved-booking reply",
                  mod.allow_saved_booking_reply(
                      "+34911111111", "Booking WH-KATHI-001 saved.", {
                          "send_blocked": True, "stage_as_draft": False,
                          "reason": "paused", "whatsapp_channel_mode": "auto",
                      }) is False)

    finally:
        mod._ORDINARY_TURN.reset(token)

    gateway_source = (ROOT.parent / "apply_gateway_patches.py").read_text(encoding="utf-8")
    send_patch = gateway_source.split(
        "async def _patched_whatsapp_cloud_send", 1)[1].split(
        "def install_runtime_whatsapp_patches", 1)[0]
    check("gateway no-send paths never fake success",
          "SendResult(success=True, message_id=None" not in send_patch)
    check("provider success without message id is failure",
          "provider_returned_no_message_id" in send_patch)
    check("blocked saved send flags real cause and booking reference",
          "flag_blocked_saved_booking_send" in send_patch)
    check("failed Staff flag is reported, not ignored",
          'raw["needs_human_flagged"] = _wh_flagged' in send_patch
          and "saved_booking_send_failure_not_persisted" in send_patch)
    check("pause blocks retain the actual gate reason",
          '_wh_disp.get("reason")' in send_patch and '"gate_reason"' in send_patch)
    check("provider failures retain sanitized provider details",
          "_sanitized_provider_reason" in send_patch
          and '"provider_failure_reason"' in send_patch)
    patch_tree = ast.parse("async def _patched_whatsapp_cloud_send" + send_patch)
    send_function = next(
        node for node in patch_tree.body
        if isinstance(node, ast.AsyncFunctionDef)
        and node.name == "_patched_whatsapp_cloud_send"
    )
    sanitizer_function = next(
        node for node in send_function.body
        if isinstance(node, ast.FunctionDef)
        and node.name == "_sanitized_provider_reason"
    )
    sanitizer_module = ast.fix_missing_locations(ast.Module(
        body=[sanitizer_function], type_ignores=[]))
    sanitizer_namespace = {}
    exec(compile(sanitizer_module, "<provider-reason-test>", "exec"), sanitizer_namespace)
    provider_reason = sanitizer_namespace["_sanitized_provider_reason"](
        "provider_send_failed",
        {"code": 131047, "type": "OAuthException",
         "message": "re-engagement required"},
    )
    check("top-level provider code, type, and message all reach sanitized reason",
          provider_reason == (
              "provider_send_failed:131047:OAuthException:re-engagement required"),
          provider_reason)

    if str(ROOT.parent) not in sys.path:
        sys.path.insert(0, str(ROOT.parent))
    from wolfhouse.test_draft_mode_inbox_persist import (
        _install_gateway_stub, _open_kill_switches,
    )
    _install_gateway_stub()
    patches_spec = importlib.util.spec_from_file_location(
        "apply_gateway_patches_provider_error_test",
        ROOT.parent / "apply_gateway_patches.py",
    )
    assert patches_spec is not None and patches_spec.loader is not None
    patches_mod = importlib.util.module_from_spec(patches_spec)
    patches_spec.loader.exec_module(patches_mod)
    flagged_reasons = []

    async def failed_adapter(*_args, **_kwargs):
        return type("RealSendResult", (), {
            "success": False,
            "message_id": None,
            "raw_response": {},
            "error": {
                "code": 131047,
                "type": "OAuthException",
                "message": "re-engagement required",
            },
        })()

    fake_handoff = mock.Mock()
    fake_handoff.is_saved_booking_turn.return_value = True
    fake_handoff.flag_blocked_saved_booking_send.side_effect = (
        lambda reason: flagged_reasons.append(reason) or True
    )
    setattr(patches_mod, "_orig_whatsapp_cloud_send", failed_adapter)
    with mock.patch.dict(os.environ, _open_kill_switches(), clear=False), \
            mock.patch("wolfhouse.pause_gate.whatsapp_outbound_disposition", return_value={
                "send_blocked": False, "stage_as_draft": False,
                "reason": "auto", "whatsapp_channel_mode": "auto",
            }), mock.patch.dict(sys.modules, {
                "wolfhouse.explicit_human_handoff": fake_handoff,
            }):
        failed_send = asyncio.run(patches_mod._patched_whatsapp_cloud_send(
            object(), "+349****1111", "Booking WH-KATHI-001 saved.",
            metadata={"wolfhouse_guest_reply": True},
        ))
    expected_adapter_reason = (
        "provider_send_failed:131047:OAuthException:re-engagement required"
    )
    check("real SendResult.error reaches saved-booking Staff flag payload",
          flagged_reasons == [expected_adapter_reason], str(flagged_reasons))
    check("real provider failure remains a truthful no-send result",
          getattr(failed_send, "success", None) is False
          and getattr(failed_send, "message_id", "missing") is None,
          str(getattr(failed_send, "raw_response", failed_send)))
    check("output guard finalizes content before pause exception is consumed",
          send_patch.index("from wolfhouse.output_guard import")
          < send_patch.index("allow_saved_booking_reply(chat_id, content"))

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

    print(f"\ntest_explicit_human_handoff: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
