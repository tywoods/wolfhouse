"""Run one simulated guest turn through the live Hermes Luna gateway loop."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

_STAGING_ROOT = "/etc/hermes-staging"
if _STAGING_ROOT not in sys.path:
    sys.path.insert(0, _STAGING_ROOT)

from wolfhouse.simulate_write_guards import (
    guard_bot_path_and_payload,
    is_simulate_write_blocked,
    summarize_tool_result,
    synthetic_blocked_result,
    tool_name_from_path,
)
from wolfhouse.staging_guard import assert_staging_environment, assert_stripe_test_only
from wolfhouse.output_guard import guard_reply

SIMULATE_PATH = "/wolfhouse/simulate-guest-turn"
SIMULATE_BURST_PATH = "/wolfhouse/simulate-guest-burst"
_CAPTURE: Optional["SimulateCapture"] = None


@dataclass
class SimulateCapture:
    reply_text: Optional[str] = None
    reply_event: asyncio.Event = field(default_factory=asyncio.Event)
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    session_id: Optional[str] = None
    language_detected: Optional[str] = None
    warnings: List[str] = field(default_factory=list)
    allow_writes: bool = False
    orig_send: Any = None
    orig_post_bot: Any = None
    patched_send: bool = False
    patched_post_bot: bool = False


def thread_to_digits(thread: str) -> str:
    """Map --thread to a stable simulate guest phone (never wall-clock).

    Each distinct thread string gets a fixed E.164-style digit string across runs.
    Only explicit phone threads (10+ digits, optional leading +) pass through verbatim.
    """
    key = str(thread or "").strip()
    if not key:
        raise ValueError("thread is required")

    if key.startswith("+"):
        digits = "".join(ch for ch in key if ch.isdigit())
        if len(digits) >= 10:
            return digits

    bare = key.replace(" ", "")
    if bare.isdigit() and len(bare) >= 10:
        return bare

    # Hash the full thread id (keep sim: prefix) — reproducible, isolated per scenario.
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    suffix = int(digest[:15], 16) % 10_000_000_000
    return "49" + str(suffix).zfill(10)


def _detect_language(text: str, hint: Optional[str]) -> str:
    if hint:
        return str(hint).strip().lower()[:10]
    sample = str(text or "").lower()
    if any(w in sample for w in ("ciao", "grazie", "camera", "notte", "persone")):
        return "it"
    if any(w in sample for w in ("hola", "gracias", "habitación", "noches")):
        return "es"
    if any(w in sample for w in ("danke", "zimmer", "nächte", "personen")):
        return "de"
    return "en"


def build_meta_webhook_payload(
    *,
    digits: str,
    text: str,
    contact_name: str = "Simulate Guest",
    message_id: Optional[str] = None,
) -> Dict[str, Any]:
    phone_number_id = (os.getenv("WHATSAPP_CLOUD_PHONE_NUMBER_ID") or "1152900101233109").strip()
    msg_id = message_id or f"wamid.simulate.{uuid.uuid4().hex[:16]}"
    ts = str(int(time.time()))
    return {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "WOLFHOUSE_SIMULATE",
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {
                                "display_phone_number": digits,
                                "phone_number_id": phone_number_id,
                            },
                            "contacts": [
                                {
                                    "profile": {"name": contact_name},
                                    "wa_id": digits,
                                }
                            ],
                            "messages": [
                                {
                                    "from": digits,
                                    "id": msg_id,
                                    "timestamp": ts,
                                    "type": "text",
                                    "text": {"body": text},
                                }
                            ],
                        },
                    }
                ],
            }
        ],
    }


def _sign_webhook_body(body_bytes: bytes) -> Dict[str, str]:
    headers = {"Content-Type": "application/json"}
    secret = (os.getenv("WHATSAPP_CLOUD_APP_SECRET") or "").strip()
    if secret:
        digest = hmac.new(secret.encode("utf-8"), body_bytes, hashlib.sha256).hexdigest()
        headers["X-Hub-Signature-256"] = f"sha256={digest}"
    return headers


def _find_staff_plugin_module() -> tuple[Any, Optional[str]]:
    import importlib
    import sys

    for key, loaded in list(sys.modules.items()):
        if not loaded or not key.endswith("wolfhouse_staff_api"):
            continue
        if hasattr(loaded, "_post_bot"):
            return loaded, None

    errors: List[str] = []
    for name in ("plugins.wolfhouse_staff_api", "wolfhouse_staff_api"):
        try:
            mod = importlib.import_module(name)
            if hasattr(mod, "_post_bot"):
                return mod, None
        except Exception as exc:
            errors.append(f"{name}:{exc}")

    for plugin_root in (
        "/opt/data/plugins/wolfhouse_staff_api",
        "/etc/hermes-staging/plugins/wolfhouse_staff_api",
    ):
        if plugin_root not in sys.path:
            sys.path.insert(0, plugin_root)
        try:
            mod = importlib.import_module("wolfhouse_staff_api")
            if hasattr(mod, "_post_bot"):
                return mod, None
        except Exception as exc:
            errors.append(f"{plugin_root}:{exc}")

    return None, "; ".join(errors) if errors else "no_staff_plugin_module"


def _install_tool_capture(cap: SimulateCapture) -> None:
    global _CAPTURE
    _CAPTURE = cap
    mod, err = _find_staff_plugin_module()
    if mod is None or not hasattr(mod, "_post_bot"):
        cap.warnings.append(f"tool_capture_unavailable:{err or 'unknown'}")
        return

    if cap.patched_post_bot:
        return

    cap.orig_post_bot = mod._post_bot

    def _wrapped_post_bot(path, payload):
        norm_path, guarded, guard_warnings = guard_bot_path_and_payload(
            path,
            payload or {},
            allow_writes=cap.allow_writes,
        )
        cap.warnings.extend(guard_warnings)
        if not cap.allow_writes and is_simulate_write_blocked(guard_warnings):
            blocked = synthetic_blocked_result(norm_path, guard_warnings, allow_writes=cap.allow_writes)
            cap.tool_calls.append(
                {
                    "name": tool_name_from_path(norm_path),
                    "args": dict(payload or {}),
                    "result_summary": summarize_tool_result(blocked),
                    "simulate_guard": guard_warnings,
                }
            )
            return blocked
        result = cap.orig_post_bot(norm_path, guarded)
        if isinstance(result, dict):
            for key in ("checkout_url", "secure_payment_url", "guest_payment_url", "payment_short_url"):
                if result.get(key):
                    assert_stripe_test_only(str(result.get(key)))
        cap.tool_calls.append(
            {
                "name": tool_name_from_path(norm_path),
                "args": dict(payload or {}),
                "result_summary": summarize_tool_result(result),
                "simulate_guard": guard_warnings or None,
            }
        )
        return result

    mod._post_bot = _wrapped_post_bot
    cap.patched_post_bot = True


def _install_outbound_capture(cap: SimulateCapture) -> None:
    try:
        import gateway.platforms.whatsapp_cloud as wh_mod
    except Exception:
        cap.warnings.append("outbound_capture_unavailable")
        return

    if cap.patched_send:
        return

    cap.orig_send = wh_mod.WhatsAppCloudAdapter.send

    async def _capturing_send(self, chat_id, content, reply_to=None, metadata=None):
        if os.getenv("WOLFHOUSE_SIMULATE_GUEST_TURN") == "1":
            cap.reply_text = str(content or "").strip()
            cap.reply_event.set()
            try:
                from gateway.platforms.base import SendResult
            except Exception:
                return None
            return SendResult(
                success=True,
                message_id=f"simulate-out-{uuid.uuid4().hex[:12]}",
                raw_response={"simulated_outbound": True, "suppressed_whatsapp": True},
            )
        return await cap.orig_send(self, chat_id, content, reply_to=reply_to, metadata=metadata)

    wh_mod.WhatsAppCloudAdapter.send = _capturing_send
    cap.patched_send = True


def _remove_patches(cap: SimulateCapture) -> None:
    if cap.patched_send and cap.orig_send is not None:
        try:
            import gateway.platforms.whatsapp_cloud as wh_mod

            wh_mod.WhatsAppCloudAdapter.send = cap.orig_send
        except Exception:
            pass
    if cap.patched_post_bot and cap.orig_post_bot is not None:
        try:
            mod, _ = _find_staff_plugin_module()
            if mod is not None:
                mod._post_bot = cap.orig_post_bot
        except Exception:
            pass
    cap.patched_send = False
    cap.patched_post_bot = False


def _resolve_session_id(digits: str) -> Optional[str]:
    try:
        from gateway.run import _wolfhouse_gateway_runner  # noqa: WPS433
    except Exception:
        return None
    runner = _wolfhouse_gateway_runner
    if runner is None:
        return None
    try:
        from gateway.config import Platform
        from gateway.session import SessionSource

        source = SessionSource(
            platform=Platform.WHATSAPP_CLOUD,
            user_id=digits,
            chat_id=digits,
            chat_type="dm",
        )
        session_key = runner._session_key_for_source(source)  # noqa: SLF001
        store = runner.session_store
        store._ensure_loaded()  # noqa: SLF001
        entry = store._entries.get(session_key)  # noqa: SLF001
        return entry.session_id if entry else None
    except Exception:
        return None


async def run_simulated_turn(
    *,
    thread: str,
    text: str,
    lang: Optional[str] = None,
    allow_writes: bool = False,
    timeout_sec: float = 180.0,
) -> Dict[str, Any]:
    assert_staging_environment()
    digits = thread_to_digits(thread)
    if not text or not str(text).strip():
        raise ValueError("text is required")

    cap = SimulateCapture(allow_writes=allow_writes)
    cap.language_detected = _detect_language(text, lang)

    os.environ["WOLFHOUSE_SIMULATE_GUEST_TURN"] = "1"
    os.environ["WOLFHOUSE_SIMULATE_ALLOW_WRITES"] = "1" if allow_writes else "0"
    os.environ["WOLFHOUSE_WHATSAPP_GUEST_PHONE"] = f"+{digits}"
    os.environ["WHATSAPP_GUEST_PHONE"] = f"+{digits}"

    _install_outbound_capture(cap)
    _install_tool_capture(cap)

    webhook_path = (os.getenv("WHATSAPP_CLOUD_WEBHOOK_PATH") or "/whatsapp/webhook").strip()
    port = int(os.getenv("WHATSAPP_CLOUD_WEBHOOK_PORT") or "8090")
    url = f"http://127.0.0.1:{port}{webhook_path}"

    payload = build_meta_webhook_payload(digits=digits, text=str(text).strip())
    body_bytes = json.dumps(payload).encode("utf-8")
    headers = _sign_webhook_body(body_bytes)

    try:
        import aiohttp

        async with aiohttp.ClientSession() as session:
            async with session.post(url, data=body_bytes, headers=headers, timeout=30) as resp:
                await resp.read()
                if resp.status >= 400:
                    cap.warnings.append(f"webhook_http_{resp.status}")
    except Exception as exc:
        _remove_patches(cap)
        raise RuntimeError(f"webhook inject failed: {exc}") from exc

    try:
        await asyncio.wait_for(cap.reply_event.wait(), timeout=timeout_sec)
    except asyncio.TimeoutError as exc:
        _remove_patches(cap)
        raise RuntimeError("timed out waiting for Luna reply") from exc
    finally:
        _remove_patches(cap)
        os.environ.pop("WOLFHOUSE_SIMULATE_GUEST_TURN", None)

    session_id = _resolve_session_id(digits)

    # Output-guard (step 3): inspect the final guest-facing reply. LEAK is enforced
    # (reply replaced with a localized safe fallback); price/language are advisory
    # findings the golden suite asserts on. raw_reply_text preserves the original.
    raw_reply = cap.reply_text or ""
    safe_reply, guard_findings = guard_reply(
        raw_reply, guest_lang=cap.language_detected, tool_calls=cap.tool_calls,
    )

    return {
        "ok": True,
        "thread": thread,
        "guest_phone": f"+{digits}",
        "reply_text": safe_reply,
        "raw_reply_text": raw_reply,
        "guard_findings": guard_findings,
        "tool_calls": cap.tool_calls,
        "session_id": session_id,
        "language_detected": cap.language_detected,
        "allow_writes": allow_writes,
        "warnings": cap.warnings,
        "whatsapp_suppressed": True,
    }


@dataclass
class BurstSimulateCapture(SimulateCapture):
    replies: List[str] = field(default_factory=list)
    agent_invocation_count: int = 0


async def run_simulated_burst(
    *,
    thread: str,
    messages: List[Dict[str, Any]],
    lang: Optional[str] = None,
    allow_writes: bool = False,
    timeout_sec: float = 180.0,
) -> Dict[str, Any]:
    """Inject an ordered burst of synthetic WhatsApp messages (staging only).

    Each entry: ``{"delay_ms": 0, "text": "..."}``. Outbound WhatsApp is
    always suppressed; booking/payment/waiver writes are always blocked.
    """
    assert_staging_environment()
    digits = thread_to_digits(thread)
    if not messages:
        raise ValueError("messages is required")

    # Hard fail-closed — ignore caller intent for the burst simulator.
    allow_writes = False
    cap = BurstSimulateCapture(allow_writes=False)
    first_text = str((messages[0] or {}).get("text") or "")
    cap.language_detected = _detect_language(first_text, lang)

    os.environ["WOLFHOUSE_SIMULATE_GUEST_TURN"] = "1"
    os.environ["WOLFHOUSE_SIMULATE_ALLOW_WRITES"] = "1" if allow_writes else "0"
    os.environ["WOLFHOUSE_WHATSAPP_GUEST_PHONE"] = f"+{digits}"
    os.environ["WHATSAPP_GUEST_PHONE"] = f"+{digits}"

    _install_outbound_capture(cap)
    _install_tool_capture(cap)

    # Capture every outbound reply for consolidated-turn accounting.
    try:
        import gateway.platforms.whatsapp_cloud as wh_mod

        if cap.patched_send and cap.orig_send is not None:
            inner = wh_mod.WhatsAppCloudAdapter.send

            async def _multi_send(self, chat_id, content, reply_to=None, metadata=None):
                result = await inner(self, chat_id, content, reply_to=reply_to, metadata=metadata)
                text = str(content or "").strip()
                if text:
                    cap.replies.append(text)
                    cap.agent_invocation_count = len(cap.replies)
                    cap.reply_text = text
                    cap.reply_event.set()
                return result

            wh_mod.WhatsAppCloudAdapter.send = _multi_send
    except Exception:
        cap.warnings.append("burst_reply_capture_partial")

    webhook_path = (os.getenv("WHATSAPP_CLOUD_WEBHOOK_PATH") or "/whatsapp/webhook").strip()
    port = int(os.getenv("WHATSAPP_CLOUD_WEBHOOK_PORT") or "8090")
    url = f"http://127.0.0.1:{port}{webhook_path}"

    source_messages: List[Dict[str, Any]] = []
    t0 = time.monotonic()
    try:
        import aiohttp

        async with aiohttp.ClientSession() as session:
            for idx, item in enumerate(messages):
                delay_ms = int(item.get("delay_ms") or 0)
                text = str(item.get("text") or "").strip()
                if not text:
                    continue
                elapsed_ms = int((time.monotonic() - t0) * 1000)
                wait_ms = max(0, delay_ms - elapsed_ms)
                if wait_ms:
                    await asyncio.sleep(wait_ms / 1000.0)
                msg_id = f"wamid.simulate.burst.{uuid.uuid4().hex[:12]}"
                payload = build_meta_webhook_payload(
                    digits=digits, text=text, message_id=msg_id
                )
                body_bytes = json.dumps(payload).encode("utf-8")
                headers = _sign_webhook_body(body_bytes)
                source_messages.append(
                    {
                        "index": idx,
                        "delay_ms": delay_ms,
                        "text": text,
                        "wamid": msg_id,
                    }
                )
                async with session.post(url, data=body_bytes, headers=headers, timeout=30) as resp:
                    await resp.read()
                    if resp.status >= 400:
                        cap.warnings.append(f"webhook_http_{resp.status}")
    except Exception as exc:
        _remove_patches(cap)
        raise RuntimeError(f"burst webhook inject failed: {exc}") from exc

    # Wait for at least one reply; allow debounce quiet window (+ agent time).
    debounce_ms = int(os.getenv("WHATSAPP_BURST_DEBOUNCE_MS") or "5000")
    wait_budget = timeout_sec + (debounce_ms / 1000.0) + 5.0
    try:
        await asyncio.wait_for(cap.reply_event.wait(), timeout=wait_budget)
        # Brief settle for a possible second consolidated turn.
        await asyncio.sleep(0.5)
    except asyncio.TimeoutError as exc:
        _remove_patches(cap)
        raise RuntimeError("timed out waiting for Luna burst replies") from exc
    finally:
        _remove_patches(cap)
        os.environ.pop("WOLFHOUSE_SIMULATE_GUEST_TURN", None)

    session_id = _resolve_session_id(digits)
    burst_snap: Dict[str, Any] = {}
    try:
        from wolfhouse.whatsapp_burst_coalesce import get_coalescer

        coalescer = get_coalescer()
        if coalescer is not None:
            burst_snap = coalescer.snapshot()
    except Exception:
        pass

    raw_reply = cap.reply_text or (cap.replies[-1] if cap.replies else "")
    safe_reply, guard_findings = guard_reply(
        raw_reply, guest_lang=cap.language_detected, tool_calls=cap.tool_calls,
    )

    agent_count = int(
        (burst_snap.get("stats") or {}).get("agent_invocations")
        or cap.agent_invocation_count
        or len(cap.replies)
        or 0
    )
    return {
        "ok": True,
        "thread": thread,
        "guest_phone": f"+{digits}",
        "source_messages": source_messages,
        "consolidated_turns": [
            {
                "reply_text": r,
                "index": i,
            }
            for i, r in enumerate(cap.replies or ([safe_reply] if safe_reply else []))
        ],
        "agent_invocation_count": agent_count,
        "tool_calls": cap.tool_calls,
        "replies": cap.replies or ([safe_reply] if safe_reply else []),
        "reply_text": safe_reply,
        "guard_findings": guard_findings,
        "session_id": session_id,
        "language_detected": cap.language_detected,
        # Burst simulator always fail-closed: writes and WhatsApp outbound suppressed.
        "allow_writes": False,
        "whatsapp_suppressed": True,
        "write_guard_enforced": True,
        "burst_stats": burst_snap.get("stats"),
        "warnings": cap.warnings,
        "debounce_ms": debounce_ms,
    }


def register_simulate_route(app) -> None:
    """Register POST /wolfhouse/simulate-guest-turn on the WhatsApp aiohttp app."""

    async def _handle_simulate_guest_turn(request):
        token = (os.getenv("LUNA_BOT_INTERNAL_TOKEN") or "").strip()
        if token:
            hdr = request.headers.get("X-Luna-Bot-Token") or request.headers.get("Authorization") or ""
            if hdr.startswith("Bearer "):
                hdr = hdr[7:].strip()
            if hdr != token:
                from aiohttp import web

                return web.json_response({"ok": False, "error": "unauthorized"}, status=401)

        try:
            body = await request.json()
        except Exception:
            from aiohttp import web

            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)

        # Burst payload: ordered messages array (staging rapid-fire harness).
        if isinstance(body.get("messages"), list) and body.get("messages"):
            try:
                result = await run_simulated_burst(
                    thread=str(body.get("thread") or body.get("guest_phone") or ""),
                    messages=list(body.get("messages") or []),
                    lang=body.get("lang") or body.get("language"),
                    # Burst endpoint always fail-closed — ignore caller allow_writes.
                    allow_writes=False,
                )
            except SystemExit as exc:
                from aiohttp import web

                return web.json_response({"ok": False, "error": str(exc)}, status=403)
            except Exception as exc:
                from aiohttp import web

                return web.json_response({"ok": False, "error": str(exc)}, status=500)
            from aiohttp import web

            return web.json_response(result)

        try:
            result = await run_simulated_turn(
                thread=str(body.get("thread") or body.get("guest_phone") or ""),
                text=str(body.get("text") or body.get("message_text") or ""),
                lang=body.get("lang") or body.get("language"),
                allow_writes=bool(body.get("allow_writes")),
            )
        except SystemExit as exc:
            from aiohttp import web

            return web.json_response({"ok": False, "error": str(exc)}, status=403)
        except Exception as exc:
            from aiohttp import web

            return web.json_response({"ok": False, "error": str(exc)}, status=500)

        from aiohttp import web

        return web.json_response(result)

    app.router.add_post(SIMULATE_PATH, _handle_simulate_guest_turn)
    app.router.add_post(SIMULATE_BURST_PATH, _handle_simulate_guest_turn)
    try:
        from wolfhouse.luna_personality_live_eval import register_live_eval_route

        register_live_eval_route(app)
    except Exception:
        # Isolated eval is additive. Default simulate must still register.
        pass
