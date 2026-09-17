"""Protected Crows Nest guest-turn door into the live Luna GatewayRunner.

Unlike the legacy simulator this module never mutates process environment or swaps
functions per request.  A request-owned ContextVar capability follows the turn
through asyncio tasks.  Permanent boundary guards use that capability to deny
external transport and writes; revocation therefore remains effective after a
request timeout or cancellation, including late worker completion.
"""
from __future__ import annotations

import asyncio
import hashlib
import inspect
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar, copy_context
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, Awaitable, Callable, Dict, Optional

from wolfhouse.simulate_write_guards import (
    guard_bot_path_and_payload,
    is_simulate_write_blocked,
    summarize_tool_result,
    synthetic_blocked_result,
    tool_name_from_path,
)

_SCOPE: ContextVar[Optional["CrowsnestGuestScope"]] = ContextVar(
    "wolfhouse_crowsnest_guest_scope", default=None
)
_SESSION_LOCKS: Dict[str, asyncio.Lock] = {}
_SESSION_LOCKS_GUARD = asyncio.Lock()
_TAINTED_SESSIONS: set[str] = set()
_GLOBAL_LIMIT: Optional[asyncio.Semaphore] = None
_INSTALLED_STAFF: set[int] = set()
_INSTALLED_WHATSAPP: set[int] = set()
_EXECUTOR_GUARD_INSTALLED = False
_PHONE_RE = re.compile(r"^\+?[0-9]{10,15}$")


@dataclass
class CrowsnestGuestScope:
    request_id: str
    synthetic_phone: str
    inbox_phone: str
    session_key: str
    revoked: bool = False
    reply_text: str = ""
    transport_attempts: int = 0
    transport_calls: int = 0
    tool_calls: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def create(cls, phone: str) -> "CrowsnestGuestScope":
        normalized = normalize_phone(phone)
        digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:24]
        # +999 is unassigned by ITU-T. Keep simulator Inbox identity stable by
        # selected phone while making collision with an ordinary guest impossible.
        inbox_digits = str(int(digest[:14], 16) % 1_000_000_000_000).zfill(12)
        return cls(
            request_id=f"crowsnest-{uuid.uuid4().hex}",
            synthetic_phone=normalized,
            inbox_phone=f"+999{inbox_digits}",
            session_key=f"crowsnest-sim:{digest}",
        )


def normalize_phone(phone: str) -> str:
    raw = str(phone or "").strip().replace(" ", "")
    if not _PHONE_RE.fullmatch(raw):
        raise ValueError("phone must be E.164 with 10-15 digits")
    return "+" + raw.lstrip("+")


def current_crowsnest_scope() -> Optional[CrowsnestGuestScope]:
    return _SCOPE.get()


def simulator_mirror_fields(
    scope: Optional[CrowsnestGuestScope] = None,
) -> Dict[str, Any]:
    """Request-owned Inbox labels; empty for every ordinary WhatsApp turn."""
    scope = scope or current_crowsnest_scope()
    if scope is None:
        return {}
    return {
        "simulator_synthetic": True,
        "source_owner": "crowsnest-guest-door",
        "suppress_notifications": True,
        "suppress_approvals": True,
        "guest_tester_class": "Simulator",
        "whatsapp_delivered": False,
        "simulator_session_key": scope.session_key,
        "simulator_source_phone_hash": hashlib.sha256(
            scope.synthetic_phone.encode("utf-8")
        ).hexdigest()[:16],
    }


def install_request_owned_guards(staff_module: Any, whatsapp_module: Any) -> None:
    """Install idempotent permanent guards; ordinary calls retain original behavior."""
    global _EXECUTOR_GUARD_INSTALLED
    if not _EXECUTOR_GUARD_INSTALLED:
        original_submit = ThreadPoolExecutor.submit

        def context_owned_submit(self, fn, /, *args, **kwargs):
            # Capture at enqueue time: reused threads neither lose simulator
            # authority nor retain a previous request's authority.
            ctx = copy_context()
            return original_submit(self, ctx.run, fn, *args, **kwargs)

        context_owned_submit._crowsnest_request_guard = True  # type: ignore[attr-defined]
        ThreadPoolExecutor.submit = context_owned_submit
        _EXECUTOR_GUARD_INSTALLED = True

    staff_id = id(staff_module)
    if staff_id not in _INSTALLED_STAFF:
        original_post = staff_module._post_bot
        original_phone = getattr(staff_module, "_session_guest_phone", lambda: "")

        def guarded_phone():
            scope = current_crowsnest_scope()
            return scope.synthetic_phone if scope is not None else original_phone()

        def guarded_post(path, payload):
            scope = current_crowsnest_scope()
            if scope is None:
                return original_post(path, payload)
            if scope.revoked:
                result = synthetic_blocked_result(
                    str(path or ""), ["request_scope_revoked"], allow_writes=False
                )
                scope.tool_calls.append({
                    "name": tool_name_from_path(str(path or "")),
                    "args": {},
                    "result_summary": summarize_tool_result(result),
                    "simulator_guard": ["request_scope_revoked"],
                })
                return result
            norm, guarded, warnings = guard_bot_path_and_payload(
                path,
                payload or {},
                allow_writes=False,
                booking_only_mode="",
                synthetic_identity=scope.synthetic_phone,
            )
            if is_simulate_write_blocked(warnings):
                result = synthetic_blocked_result(norm, warnings, allow_writes=False)
            else:
                result = original_post(norm, guarded)
            scope.tool_calls.append({
                "name": tool_name_from_path(norm),
                "args": dict(payload or {}),
                "result_summary": summarize_tool_result(result),
                "simulator_guard": warnings or None,
            })
            return result

        guarded_post._crowsnest_request_guard = True  # type: ignore[attr-defined]
        staff_module._post_bot = guarded_post
        staff_module._session_guest_phone = guarded_phone
        _INSTALLED_STAFF.add(staff_id)

    adapter_cls = whatsapp_module.WhatsAppCloudAdapter
    wa_id = id(adapter_cls)
    if wa_id not in _INSTALLED_WHATSAPP:
        original_send = adapter_cls.send

        async def guarded_send(self, chat_id, content, reply_to=None, metadata=None):
            scope = current_crowsnest_scope()
            synthetic_destination = str(chat_id or "").startswith("crowsnest-sim:")
            if scope is None and not synthetic_destination:
                return await original_send(
                    self, chat_id, content, reply_to=reply_to, metadata=metadata
                )
            if scope is None:
                # Permanent destination denial survives unsupported queues that
                # accidentally strip ContextVars.
                return SimpleNamespace(
                    success=False,
                    message_id=None,
                    raw_response={
                        "simulator": True,
                        "whatsapp_suppressed": True,
                        "reason": "request_scope_missing",
                    },
                )
            # No authority can be acquired later: active, revoked and timed-out
            # simulator work all terminate here without calling real transport.
            scope.transport_attempts += 1
            scope.reply_text = str(content or "").strip()
            return SimpleNamespace(
                success=True,
                message_id=f"crowsnest-suppressed-{uuid.uuid4().hex[:12]}",
                raw_response={"simulator": True, "whatsapp_suppressed": True},
            )

        guarded_send._crowsnest_request_guard = True  # type: ignore[attr-defined]
        adapter_cls.send = guarded_send
        _INSTALLED_WHATSAPP.add(wa_id)


async def install_live_request_guards() -> None:
    import gateway.platforms.whatsapp_cloud as whatsapp_module

    staff_module = _find_staff_module()
    if staff_module is None:
        raise RuntimeError("staff_plugin_unavailable")
    install_request_owned_guards(staff_module, whatsapp_module)


def _find_staff_module() -> Any:
    import importlib
    import sys

    for name in ("wolfhouse_staff_api", "plugins.wolfhouse_staff_api"):
        loaded = sys.modules.get(name)
        if loaded is not None and hasattr(loaded, "_post_bot"):
            return loaded
    for name in ("plugins.wolfhouse_staff_api", "wolfhouse_staff_api"):
        try:
            loaded = importlib.import_module(name)
            if hasattr(loaded, "_post_bot"):
                return loaded
        except Exception:
            continue
    return None


async def _session_lock(key: str) -> asyncio.Lock:
    async with _SESSION_LOCKS_GUARD:
        return _SESSION_LOCKS.setdefault(key, asyncio.Lock())


def _global_limit() -> asyncio.Semaphore:
    global _GLOBAL_LIMIT
    if _GLOBAL_LIMIT is None:
        _GLOBAL_LIMIT = asyncio.Semaphore(4)
    return _GLOBAL_LIMIT


def _make_event(scope: CrowsnestGuestScope, text: str) -> Any:
    try:
        from gateway.config import Platform
        from gateway.platforms.base import MessageEvent, MessageType
        from gateway.session import SessionSource

        source = SessionSource(
            platform=Platform.WHATSAPP_CLOUD,
            chat_id=scope.session_key,
            user_id=scope.session_key,
            chat_type="dm",
            user_name="Simulator",
        )
        return MessageEvent(
            text=text,
            message_type=MessageType.TEXT,
            source=source,
            message_id=f"crowsnest.sim.{uuid.uuid4().hex}",
            metadata={"crowsnest_simulator": True, "simulator_session_key": scope.session_key},
        )
    except Exception:
        return SimpleNamespace(
            text=text,
            source=SimpleNamespace(
                platform=SimpleNamespace(value="whatsapp_cloud"),
                chat_id=scope.session_key,
                user_id=scope.session_key,
                chat_type="dm",
                user_name="Simulator",
            ),
            message_id=f"crowsnest.sim.{uuid.uuid4().hex}",
            metadata={"crowsnest_simulator": True, "simulator_session_key": scope.session_key},
        )


async def _call_mirror(mirror: Callable[..., Any], **kwargs: Any) -> Any:
    result = mirror(**kwargs)
    return await result if inspect.isawaitable(result) else result


async def _default_mirror(*, direction: str, phone: str, text: str, scope: CrowsnestGuestScope) -> Any:
    import wolfhouse_whatsapp_mirror as mirror_mod  # type: ignore

    payload = {
        "client_slug": "sunset",
        "guest_phone": scope.inbox_phone,
        "direction": direction,
        "message_text": text[:4000],
        **simulator_mirror_fields(scope),
        "location_id": "sunset-somo",
        "idempotency_key": hashlib.sha256(
            f"{scope.request_id}:{direction}:{text}".encode("utf-8")
        ).hexdigest()[:32],
    }
    # Durable readback: this call returns only after Staff API persisted the row.
    posted = await asyncio.to_thread(mirror_mod._post_mirror_sync, payload)
    thread = posted.get("thread") if isinstance(posted, dict) else None
    durable = isinstance(thread, dict) and (
        thread.get("persisted") is True or thread.get("duplicate") is True
    )
    if not isinstance(posted, dict) or posted.get("ok") is not True or not durable:
        raise RuntimeError("inbox_persist_unconfirmed")
    return posted


async def run_crowsnest_guest_turn(
    *,
    runner: Any,
    phone: str,
    text: str,
    mirror: Optional[Callable[..., Awaitable[Any]]] = None,
    timeout_sec: float = 120.0,
    late_settle_sec: float = 0.25,
) -> Dict[str, Any]:
    """Run one bounded synthetic turn on the live runner with a separate session."""
    if runner is None or not callable(getattr(runner, "_handle_message", None)):
        raise RuntimeError("gateway_runner_unavailable")
    message = str(text or "").strip()
    if not message:
        raise ValueError("text is required")
    scope = CrowsnestGuestScope.create(phone)
    if scope.session_key in _TAINTED_SESSIONS:
        return {
            "ok": False,
            "error": "session_tainted_by_late_worker",
            "session_key": scope.session_key,
            "whatsapp_suppressed": True,
            "transport_calls": 0,
            "transport_attempts": 0,
        }
    event = _make_event(scope, message)
    mirror_fn = mirror or _default_mirror
    lock = await _session_lock(scope.session_key)

    async with _global_limit(), lock:
        if scope.session_key in _TAINTED_SESSIONS:
            return {
                "ok": False,
                "error": "session_tainted_by_late_worker",
                "session_key": scope.session_key,
                "whatsapp_suppressed": True,
                "transport_calls": 0,
                "transport_attempts": 0,
            }
        token = _SCOPE.set(scope)
        task: Optional[asyncio.Task] = None
        try:
            await _call_mirror(
                mirror_fn, direction="inbound", phone=scope.synthetic_phone,
                text=message, scope=scope,
            )
            task = asyncio.create_task(runner._handle_message(event))
            try:
                done, _ = await asyncio.wait(
                    {task}, timeout=max(0.001, float(timeout_sec))
                )
            except asyncio.CancelledError:
                scope.revoked = True
                _TAINTED_SESSIONS.add(scope.session_key)
                task.cancel()

                def _consume_cancelled(fut: asyncio.Future) -> None:
                    try:
                        fut.exception()
                    except (asyncio.CancelledError, Exception):
                        pass
                    finally:
                        _TAINTED_SESSIONS.discard(scope.session_key)

                task.add_done_callback(_consume_cancelled)
                raise
            if not done:
                scope.revoked = True
                _TAINTED_SESSIONS.add(scope.session_key)
                task.cancel()

                def _consume_late(fut: asyncio.Future) -> None:
                    try:
                        fut.exception()
                    except (asyncio.CancelledError, Exception):
                        pass
                    finally:
                        _TAINTED_SESSIONS.discard(scope.session_key)

                task.add_done_callback(_consume_late)
                if late_settle_sec > 0:
                    await asyncio.sleep(min(float(late_settle_sec), 1.0))
                return {
                    "ok": False,
                    "error": "turn_timeout",
                    "session_key": scope.session_key,
                    "whatsapp_suppressed": True,
                    "transport_calls": scope.transport_calls,
                    "transport_attempts": scope.transport_attempts,
                }
            result = task.result()
            reply = str(result or scope.reply_text or "").strip()
            if not reply:
                raise RuntimeError("missing_reply")
            await _call_mirror(
                mirror_fn, direction="outbound", phone=scope.synthetic_phone,
                text=reply, scope=scope,
            )
            return {
                "ok": True,
                "reply_text": reply,
                "session_key": scope.session_key,
                "request_id": scope.request_id,
                "tool_calls": list(scope.tool_calls),
                "whatsapp_suppressed": True,
                "transport_calls": scope.transport_calls,
                "transport_attempts": scope.transport_attempts,
                "inbox_persisted": True,
            }
        finally:
            scope.revoked = True
            _SCOPE.reset(token)


async def run_live_crowsnest_guest_turn(**kwargs: Any) -> Dict[str, Any]:
    await install_live_request_guards()
    try:
        from gateway.run import _wolfhouse_gateway_runner
    except Exception as exc:
        raise RuntimeError("gateway_runner_unavailable") from exc
    return await run_crowsnest_guest_turn(runner=_wolfhouse_gateway_runner, **kwargs)
