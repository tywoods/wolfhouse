#!/usr/bin/env python3
"""RED/GREEN: Draft-mode WhatsApp turns persist an Inbox draft and never send.

SUNSET-LUNA-LIVE-TEST-001 defect 1:
  Tenant/channel Draft mode must create an editable Inbox draft on the same
  conversation. It must not send to Meta and must not stay silent with no draft.

Offline only: no network, no Docker, no guest WhatsApp.
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
import types
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
STAGING = ROOT.parent
PAUSE_PATH = ROOT / "pause_gate.py"
MIRROR_PATH = STAGING / "wolfhouse_whatsapp_mirror.py"
PATCHES_PATH = STAGING / "apply_gateway_patches.py"

if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))

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

    print("\n[B] Draft persist is a Staff API side-effect — zero provider sends")
    mirror = _load(MIRROR_PATH, "whatsapp_mirror_draft_under_test")
    check("mirror exports mirror_whatsapp_outbound_as_draft", hasattr(mirror, "mirror_whatsapp_outbound_as_draft"))

    posted = []
    enqueue_calls = []

    def _capture_staff_post(payload):
        posted.append(dict(payload))
        return {
            "success": True,
            "whatsapp_channel_mode": "draft",
            "thread_message": {
                "persisted": False,
                "draft_staged": True,
                "approval_id": "appr-b",
                "reason": "inbox_channel_mode_draft",
            },
            "draft": {"draft_available": True, "status": "pending"},
        }

    def _forbid_enqueue(payload):
        enqueue_calls.append(dict(payload or {}))
        raise AssertionError("draft persist must not treat enqueue as durability")

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
        with mock.patch.object(mirror, "enqueue_mirror_payload", side_effect=_forbid_enqueue):
            with mock.patch.object(mirror, "_post_mirror_sync", side_effect=_capture_staff_post):
                staged = mirror.mirror_whatsapp_outbound_as_draft(
                    "+34600111222",
                    "Draft-mode reply for Hernan — please review in Inbox.",
                    {"conversation_id": "conv-hernan"},
                )

    check("draft persist reports staged", isinstance(staged, dict) and staged.get("staged") is True, str(staged))
    check("exactly one outbound Staff mirror payload", len(posted) == 1, str(posted))
    payload = posted[0] if posted else {}
    check("payload direction outbound", payload.get("direction") == "outbound", str(payload))
    check("payload has guest-visible draft text", "Hernan" in str(payload.get("message_text") or ""), str(payload))
    check("payload has no Meta wamid (not a send)", not payload.get("whatsapp_message_id"), str(payload))
    check("payload is sunset tenant", payload.get("client_slug") == "sunset", str(payload))
    check("zero enqueue substitutes for durability", enqueue_calls == [], str(enqueue_calls))

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

    print("\n[D] Staging exception/false cannot claim draft_staged or fall through to Meta")
    _run_fail_closed_send_regressions()

    print("\n[E] Helper durability is Staff API draft_staged, not enqueue acceptance")
    _run_helper_durability_regressions(mirror)

    print(f"\ntest_draft_mode_inbox_persist: {passed} passed, {failed} failed")
    return 1 if failed else 0


class _SendResult:
    def __init__(self, success=False, message_id=None, raw_response=None, **kwargs):
        self.success = success
        self.message_id = message_id
        self.raw_response = raw_response or {}


def _claimed_draft_staged(result) -> bool:
    raw = getattr(result, "raw_response", None) or {}
    return isinstance(raw, dict) and raw.get("draft_staged") is True


def _install_gateway_stub() -> None:
    gateway = types.ModuleType("gateway")
    gateway.__path__ = []
    platforms = types.ModuleType("gateway.platforms")
    platforms.__path__ = []
    base = types.ModuleType("gateway.platforms.base")
    base.SendResult = _SendResult
    platforms.base = base
    gateway.platforms = platforms
    sys.modules["gateway"] = gateway
    sys.modules["gateway.platforms"] = platforms
    sys.modules["gateway.platforms.base"] = base


def _open_kill_switches() -> dict:
    return {
        "LUNA_AUTO_SEND_ENABLED": "true",
        "WHATSAPP_DRY_RUN": "false",
        "LUNA_CLIENT_SLUG": "sunset",
        "LUNA_BOT_INTERNAL_TOKEN": "tok",
        "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff.example",
        "HERMES_ROLE": "sunset-luna",
        "SUNSET_INGRESS_LOCATION_ID": "sunset-somo",
    }


def _exec_draft_send(mirror_impl):
    """Run the shipped send patch in Draft mode with an injected mirror helper."""
    _install_gateway_stub()
    spec = importlib.util.spec_from_file_location(
        "apply_gateway_patches_draft_failclosed", PATCHES_PATH
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)

    provider_calls = []

    async def recorder(adapter_self, chat_id, content, reply_to=None, metadata=None):
        provider_calls.append({"chat_id": chat_id, "content": content})
        return _SendResult(success=True, message_id="wamid.LEAK", raw_response={"probe": True})

    mod._orig_whatsapp_cloud_send = recorder

    fake_mod = types.ModuleType("wolfhouse_whatsapp_mirror")
    fake_mod.mirror_whatsapp_outbound_as_draft = mirror_impl
    fake_spec = types.SimpleNamespace()
    fake_spec.loader = types.SimpleNamespace()
    fake_spec.loader.exec_module = lambda _m: None

    real_spec_from_file = importlib.util.spec_from_file_location
    real_module_from_spec = importlib.util.module_from_spec

    def spec_from_file_location(name, path, *a, **k):
        if name == "wolfhouse_whatsapp_mirror" or str(path).endswith("wolfhouse_whatsapp_mirror.py"):
            return fake_spec
        return real_spec_from_file(name, path, *a, **k)

    def module_from_spec(spec_obj):
        if spec_obj is fake_spec:
            return fake_mod
        return real_module_from_spec(spec_obj)

    disp = {
        "agent_paused": False,
        "send_blocked": True,
        "stage_as_draft": True,
        "reason": "inbox_channel_mode_draft",
        "whatsapp_channel_mode": "draft",
    }
    with mock.patch.dict(os.environ, _open_kill_switches(), clear=False):
        with mock.patch(
            "wolfhouse.pause_gate.whatsapp_outbound_disposition",
            return_value=disp,
        ):
            with mock.patch(
                "importlib.util.spec_from_file_location",
                side_effect=spec_from_file_location,
            ):
                with mock.patch(
                    "importlib.util.module_from_spec",
                    side_effect=module_from_spec,
                ):
                    result = asyncio.run(
                        mod._patched_whatsapp_cloud_send(
                            object(),
                            "+34600111222",
                            "Draft-mode reply for Hernan — please review in Inbox.",
                        )
                    )
    return result, provider_calls


def _run_fail_closed_send_regressions() -> None:
    def _raise(*_a, **_k):
        raise RuntimeError("staff draft persist exploded")

    result, provider_calls = _exec_draft_send(_raise)
    check(
        "staging exception does not claim draft_staged",
        not _claimed_draft_staged(result),
        str(getattr(result, "raw_response", result)),
    )
    check(
        "staging exception does not fall through to provider send",
        provider_calls == [],
        str(provider_calls),
    )
    check(
        "staging exception returns a typed blocked failure",
        result is not None
        and getattr(result, "success", None) is not True
        and isinstance(getattr(result, "raw_response", None), dict)
        and getattr(result, "raw_response", {}).get("draft_staged") is False
        and bool(getattr(result, "raw_response", {}).get("blocked_reason")),
        str(getattr(result, "raw_response", result)),
    )
    check("staging exception has no Meta wamid", getattr(result, "message_id", "missing") is None)

    result, provider_calls = _exec_draft_send(lambda *_a, **_k: False)
    check(
        "false staging result does not claim draft_staged",
        not _claimed_draft_staged(result),
        str(getattr(result, "raw_response", result)),
    )
    check(
        "false staging result does not fall through to provider send",
        provider_calls == [],
        str(provider_calls),
    )
    check(
        "false staging result is a typed blocked failure",
        result is not None
        and getattr(result, "success", None) is not True
        and isinstance(getattr(result, "raw_response", None), dict)
        and getattr(result, "raw_response", {}).get("draft_staged") is False,
        str(getattr(result, "raw_response", result)),
    )

    result, provider_calls = _exec_draft_send(
        lambda *_a, **_k: {"staged": False, "reason": "draft_upsert_failed"}
    )
    check(
        "typed staged=false does not claim draft_staged",
        not _claimed_draft_staged(result),
        str(getattr(result, "raw_response", result)),
    )
    check(
        "typed staged=false does not fall through to provider send",
        provider_calls == [],
        str(provider_calls),
    )

    result, provider_calls = _exec_draft_send(lambda *_a, **_k: True)
    check(
        "bare enqueue True is not durable draft_staged success",
        not _claimed_draft_staged(result),
        str(getattr(result, "raw_response", result)),
    )
    check(
        "bare enqueue True does not fall through to provider send",
        provider_calls == [],
        str(provider_calls),
    )

    result, provider_calls = _exec_draft_send(
        lambda *_a, **_k: {"staged": True, "approval_id": "appr-1"}
    )
    check(
        "Staff-confirmed staged dict reports draft_staged",
        _claimed_draft_staged(result) is True,
        str(getattr(result, "raw_response", result)),
    )
    check(
        "Staff-confirmed staged dict never sends to Meta",
        provider_calls == [] and getattr(result, "message_id", "missing") is None,
        str(provider_calls),
    )


def _staff_draft_ok_body():
    return {
        "success": True,
        "whatsapp_channel_mode": "draft",
        "thread_message": {
            "persisted": False,
            "draft_staged": True,
            "approval_id": "appr-live",
            "reason": "inbox_channel_mode_draft",
        },
        "draft": {"draft_available": True, "approval_id": "appr-live", "status": "pending"},
    }


def _run_helper_durability_regressions(mirror) -> None:
    env = {
        "LUNA_CLIENT_SLUG": "sunset",
        "SUNSET_INGRESS_LOCATION_ID": "sunset-somo",
        "LUNA_BOT_INTERNAL_TOKEN": "tok",
        "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff.example",
    }
    phone = "+34600111222"
    text = "Draft-mode reply for Hernan — please review in Inbox."

    def _is_staged(value) -> bool:
        return value is True or (isinstance(value, dict) and value.get("staged") is True)

    with mock.patch.dict(os.environ, env, clear=False):
        with mock.patch.object(mirror, "enqueue_mirror_payload", return_value=True) as enq:
            with mock.patch.object(mirror, "_post_mirror_sync", return_value=None):
                staged = mirror.mirror_whatsapp_outbound_as_draft(phone, text, {"conversation_id": "conv-hernan"})
    check(
        "enqueue acceptance without Staff confirmation is not staged",
        not _is_staged(staged),
        str(staged),
    )
    check(
        "failed draft persist does not enqueue as a substitute for durability",
        enq.call_count == 0 or not _is_staged(staged),
        f"enqueue={enq.call_count} staged={staged}",
    )

    with mock.patch.dict(os.environ, env, clear=False):
        with mock.patch.object(
            mirror,
            "_post_mirror_sync",
            return_value={"success": True, "thread_message": {"draft_staged": False, "reason": "draft_upsert_failed"}},
        ):
            staged = mirror.mirror_whatsapp_outbound_as_draft(phone, text, {})
    check("Staff draft_staged false is not helper success", not _is_staged(staged), str(staged))
    check(
        "Staff false result is a typed failure",
        isinstance(staged, dict) and staged.get("staged") is False and bool(staged.get("reason")),
        str(staged),
    )

    with mock.patch.dict(os.environ, env, clear=False):
        with mock.patch.object(mirror, "_post_mirror_sync", side_effect=RuntimeError("staff down")):
            staged = mirror.mirror_whatsapp_outbound_as_draft(phone, text, {})
    check("Staff exception is not helper success", not _is_staged(staged), str(staged))
    check(
        "Staff exception is a typed failure",
        isinstance(staged, dict) and staged.get("staged") is False,
        str(staged),
    )

    posted = []

    def _capture_post(payload):
        posted.append(dict(payload))
        return _staff_draft_ok_body()

    with mock.patch.dict(os.environ, env, clear=False):
        with mock.patch.object(mirror, "enqueue_mirror_payload", side_effect=AssertionError("draft must not enqueue")):
            with mock.patch.object(mirror, "_post_mirror_sync", side_effect=_capture_post):
                staged = mirror.mirror_whatsapp_outbound_as_draft(phone, text, {"conversation_id": "conv-hernan"})
    check("Staff draft_staged true reports staged", _is_staged(staged) is True, str(staged))
    check("durable persist posted exactly one Staff payload", len(posted) == 1, str(posted))
    payload = posted[0] if posted else {}
    check("durable payload has no Meta wamid", not payload.get("whatsapp_message_id"), str(payload))
    check("durable payload is outbound sunset", payload.get("direction") == "outbound" and payload.get("client_slug") == "sunset", str(payload))


if __name__ == "__main__":
    raise SystemExit(main())
