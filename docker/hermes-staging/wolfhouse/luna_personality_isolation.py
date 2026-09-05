"""Turn-local fail-closed isolation for Luna Personality live-model eval.

ContextVar-gated: concurrent real WhatsApp turns are unchanged. Wrappers are
passthrough unless the isolated ContextVar is set. Isolation failure aborts
BEFORE the model is invoked — never warn-and-continue.

Only the canonical read-only personality GET and the model provider request
are permitted. Business tools (including booking/payment reads and previews),
send adapters, drafts, approvals, and journal writes are denied.
"""

from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

ISOLATION_DENY_MESSAGE = "luna_personality_isolated_no_tools"
ISOLATION_NO_SEND = "luna_personality_isolated_no_send"

_ISOLATED: ContextVar[Optional["IsolatedTurnCapture"]] = ContextVar(
    "luna_personality_isolated_turn",
    default=None,
)

_installed = False
_send_wrapped = False
_post_bot_wrapped = False
_tool_hook_wrapped = False
_journal_wrapped = False


@dataclass
class IsolatedTurnCapture:
    case_id: str
    personality_id: str
    tenant_id: str = "sunset"
    reply_text: Optional[str] = None
    tools_denied: List[str] = field(default_factory=list)
    tools_invoked: int = 0
    sends_attempted: int = 0
    sends_completed: int = 0
    journal_writes_denied: int = 0
    personality_fetches: int = 0
    model_calls: int = 0
    model: Optional[str] = None
    model_called: bool = False
    isolation_ready: bool = False


class IsolationAbort(RuntimeError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def current_isolated_turn() -> Optional[IsolatedTurnCapture]:
    return _ISOLATED.get()


def enter_isolated_turn(cap: IsolatedTurnCapture) -> Token:
    return _ISOLATED.set(cap)


def exit_isolated_turn(token: Token) -> None:
    _ISOLATED.reset(token)


def deny_tool_if_isolated(tool_name: str, args: Optional[Dict[str, Any]] = None, **_kwargs: Any) -> Optional[str]:
    """Return a block message when an isolated turn is active; else None."""
    cap = _ISOLATED.get()
    if cap is None:
        return None
    name = str(tool_name or "unknown")
    cap.tools_denied.append(name)
    # Count as denied-before-invocation, not invoked.
    return ISOLATION_DENY_MESSAGE


def deny_post_bot_if_isolated(path: str, payload: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    cap = _ISOLATED.get()
    if cap is None:
        return None
    cap.tools_denied.append(str(path or "staff_bot"))
    return {
        "success": False,
        "simulate_write_blocked": True,
        "luna_personality_isolated": True,
        "error": ISOLATION_DENY_MESSAGE,
        "path": path,
    }


def capture_send_if_isolated(content: Any) -> Optional[Dict[str, Any]]:
    cap = _ISOLATED.get()
    if cap is None:
        return None
    cap.sends_attempted += 1
    cap.reply_text = str(content or "").strip()
    return {"suppressed": True, "raw_response": {ISOLATION_NO_SEND: True}}


def deny_journal_if_isolated() -> bool:
    cap = _ISOLATED.get()
    if cap is None:
        return False
    cap.journal_writes_denied += 1
    return True


def _wrap_pre_tool_call_block() -> bool:
    global _tool_hook_wrapped
    try:
        import hermes_cli.plugins as plugins
    except Exception:
        return False
    current = getattr(plugins, "get_pre_tool_call_block_message", None)
    if current is None:
        return False
    if getattr(current, "_luna_personality_isolated", False):
        _tool_hook_wrapped = True
        return True

    def _wrapped(
        tool_name: str,
        args: Optional[Dict[str, Any]] = None,
        *rest: Any,
        **kwargs: Any,
    ) -> Optional[str]:
        blocked = deny_tool_if_isolated(tool_name, args, **kwargs)
        if blocked:
            return blocked
        return current(tool_name, args, *rest, **kwargs)

    _wrapped._luna_personality_isolated = True  # type: ignore[attr-defined]
    plugins.get_pre_tool_call_block_message = _wrapped  # type: ignore[method-assign]
    _tool_hook_wrapped = True
    return True


def _wrap_send_adapter() -> bool:
    global _send_wrapped
    try:
        import gateway.platforms.whatsapp_cloud as wh_mod
    except Exception:
        return False
    send = getattr(wh_mod.WhatsAppCloudAdapter, "send", None)
    if send is None:
        return False
    if getattr(send, "_luna_personality_isolated", False):
        _send_wrapped = True
        return True

    async def _isolated_send(self, chat_id, content, reply_to=None, metadata=None):
        captured = capture_send_if_isolated(content)
        if captured is not None:
            try:
                from gateway.platforms.base import SendResult

                return SendResult(
                    success=True,
                    message_id=None,
                    raw_response=captured["raw_response"],
                )
            except Exception:
                return None
        return await send(self, chat_id, content, reply_to=reply_to, metadata=metadata)

    _isolated_send._luna_personality_isolated = True  # type: ignore[attr-defined]
    wh_mod.WhatsAppCloudAdapter.send = _isolated_send  # type: ignore[method-assign]
    _send_wrapped = True
    return True


def _wrap_post_bot() -> bool:
    global _post_bot_wrapped
    try:
        import importlib
        import sys
    except Exception:
        return False

    mod = None
    for key, loaded in list(sys.modules.items()):
        if loaded and key.endswith("wolfhouse_staff_api") and hasattr(loaded, "_post_bot"):
            mod = loaded
            break
    if mod is None:
        for name in ("plugins.wolfhouse_staff_api", "wolfhouse_staff_api"):
            try:
                cand = importlib.import_module(name)
            except Exception:
                continue
            if hasattr(cand, "_post_bot"):
                mod = cand
                break
    if mod is None or not hasattr(mod, "_post_bot"):
        return False
    orig = mod._post_bot
    if getattr(orig, "_luna_personality_isolated", False):
        _post_bot_wrapped = True
        return True

    def _isolated_post_bot(path, payload):
        denied = deny_post_bot_if_isolated(path, payload)
        if denied is not None:
            return denied
        return orig(path, payload)

    _isolated_post_bot._luna_personality_isolated = True  # type: ignore[attr-defined]
    mod._post_bot = _isolated_post_bot
    _post_bot_wrapped = True
    return True


def _wrap_journal(runner: Any = None) -> bool:
    global _journal_wrapped
    target = runner
    if target is None:
        try:
            from gateway.run import _wolfhouse_gateway_runner as target  # noqa: WPS433
        except Exception:
            target = None
    store = getattr(target, "session_store", None) if target is not None else None
    if store is None or not hasattr(store, "append_to_transcript"):
        return False
    orig = store.append_to_transcript
    if getattr(orig, "_luna_personality_isolated", False):
        _journal_wrapped = True
        return True

    def _isolated_append(*args: Any, **kwargs: Any):
        if deny_journal_if_isolated():
            return None
        return orig(*args, **kwargs)

    _isolated_append._luna_personality_isolated = True  # type: ignore[attr-defined]
    store.append_to_transcript = _isolated_append  # type: ignore[method-assign]
    _journal_wrapped = True
    return True


def install_isolation_runtime(*, runner: Any = None) -> Dict[str, bool]:
    """Idempotent passthrough wrappers. Safe for concurrent real turns."""
    global _installed
    send_ok = _wrap_send_adapter()
    post_ok = _wrap_post_bot()
    hook_ok = _wrap_pre_tool_call_block()
    journal_ok = _wrap_journal(runner)
    _installed = True
    return {
        "installed": True,
        "send_wrapped": send_ok or _send_wrapped,
        "post_bot_wrapped": post_ok or _post_bot_wrapped,
        "tool_hook_wrapped": hook_ok or _tool_hook_wrapped,
        "journal_wrapped": journal_ok or _journal_wrapped,
    }


def mark_test_isolation_installed() -> None:
    """Unit tests that supply fakes still go through preflight."""
    global _installed, _send_wrapped, _post_bot_wrapped, _tool_hook_wrapped, _journal_wrapped
    _installed = True
    _send_wrapped = True
    _post_bot_wrapped = True
    _tool_hook_wrapped = True
    _journal_wrapped = True


def isolation_status() -> Dict[str, bool]:
    return {
        "installed": _installed,
        "send_wrapped": _send_wrapped,
        "post_bot_wrapped": _post_bot_wrapped,
        "tool_hook_wrapped": _tool_hook_wrapped,
        "journal_wrapped": _journal_wrapped,
        "context_active": _ISOLATED.get() is not None,
    }


def preflight_isolation_or_abort(*, require_live_seams: bool = False) -> IsolatedTurnCapture:
    """Abort BEFORE any model call if isolation is not active and installed."""
    cap = _ISOLATED.get()
    if cap is None:
        raise IsolationAbort("isolation_context_missing")
    if not _installed:
        raise IsolationAbort("isolation_not_installed")
    if require_live_seams:
        if not _send_wrapped:
            raise IsolationAbort("send_adapter_not_isolated")
        if not (_post_bot_wrapped or _tool_hook_wrapped):
            raise IsolationAbort("tools_not_isolated")
    cap.isolation_ready = True
    return cap


def record_model_call(model: Optional[str] = None) -> None:
    cap = _ISOLATED.get()
    if cap is None:
        return
    cap.model_called = True
    cap.model_calls += 1
    if model:
        cap.model = str(model)


def record_personality_fetch() -> None:
    cap = _ISOLATED.get()
    if cap is None:
        return
    cap.personality_fetches += 1


def record_tool_invocation_violation(tool_name: str) -> None:
    """If a tool body actually ran, isolation failed."""
    cap = _ISOLATED.get()
    if cap is None:
        return
    cap.tools_invoked += 1
    cap.tools_denied.append(f"INVOKED:{tool_name}")
