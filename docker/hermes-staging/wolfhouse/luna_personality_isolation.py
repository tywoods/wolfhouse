"""Turn-local fail-closed isolation for Luna Personality live-model eval.

ContextVar-gated: concurrent real WhatsApp turns are unchanged. Wrappers are
passthrough unless the isolated ContextVar is set. Isolation failure aborts
BEFORE the model is invoked — never warn-and-continue.

Every authoritative seam is required (AND, never OR): tool hook, tool
dispatcher, Staff _post_bot, every WhatsApp send method, journal/persistence,
executor ContextVar propagation, and provider observation. Historical global
flags are not evidence — preflight inspects the live function objects.

Only the canonical read-only personality GET and the model provider request
are permitted. Business tools (including booking/payment reads and previews,
terminal, and network capabilities), send adapters, drafts, approvals, and
journal writes are denied before invocation.
"""

from __future__ import annotations

import json
from concurrent.futures.thread import ThreadPoolExecutor
from contextvars import ContextVar, Token, copy_context
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

ISOLATION_DENY_MESSAGE = "luna_personality_isolated_no_tools"
ISOLATION_NO_SEND = "luna_personality_isolated_no_send"
PACK_INJECTION_MARK = "Luna Personality this turn:"
_WRAP_MARK = "_luna_personality_isolated"
_CTX_MARK = "_luna_personality_ctx"

REQUIRED_LIVE_SEAMS: Tuple[str, ...] = (
    "send_wrapped",
    "send_methods_wrapped",
    "tool_hook_wrapped",
    "tool_dispatcher_wrapped",
    "post_bot_wrapped",
    "journal_wrapped",
    "executor_ctx_wrapped",
    "provider_wrapped",
)

WHATSAPP_SEND_METHODS: Tuple[str, ...] = (
    "send",
    "send_typing",
    "send_clarify",
    "send_exec_approval",
    "send_slash_confirm",
    "send_image",
    "send_image_file",
    "send_video",
    "send_voice",
    "send_document",
)

_ISOLATED: ContextVar[Optional["IsolatedTurnCapture"]] = ContextVar(
    "luna_personality_isolated_turn",
    default=None,
)

_installed = False
_send_wrapped = False
_send_methods_wrapped = False
_post_bot_wrapped = False
_tool_hook_wrapped = False
_tool_dispatcher_wrapped = False
_journal_wrapped = False
_executor_ctx_wrapped = False
_provider_wrapped = False

# (owner, attr, original). Tests restore these; production never unwraps.
_ORIG_OWNERS: List[Tuple[Any, str, Any]] = []
_EXECUTOR_ORIG: Optional[Callable[..., Any]] = None


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
    journal_writes_completed: int = 0
    personality_fetches: int = 0
    model_calls: int = 0
    model: Optional[str] = None
    model_called: bool = False
    isolation_ready: bool = False
    observed_pack_id: Optional[str] = None
    observed_pack_injected: bool = False
    observed_pack_from_provider: bool = False
    setting_source: Optional[str] = None
    setting_fallback: Optional[str] = None
    ephemeral_chat_id: Optional[str] = None
    evidence_kind: str = "unspecified"


@dataclass
class IsolationTargets:
    """Optional injected owners for tests. Production discovers pinned modules.

    Labeled test doubles must set evidence_kind on the capture; these targets
    are never live acceptance.
    """

    whatsapp_adapter_cls: Any = None
    plugins_mod: Any = None
    post_bot_mods: Sequence[Any] = ()
    session_store_cls: Any = None
    session_store: Any = None
    handle_function_call_mod: Any = None
    provider_mod: Any = None
    provider_attr: str = "interruptible_api_call"
    wrap_executor: bool = True


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


def _is_wrapped(fn: Any) -> bool:
    return bool(fn) and bool(getattr(fn, _WRAP_MARK, False) or getattr(fn, _CTX_MARK, False))


def deny_tool_if_isolated(tool_name: str, args: Optional[Dict[str, Any]] = None, **_kwargs: Any) -> Optional[str]:
    """Return a block message when an isolated turn is active; else None."""
    cap = _ISOLATED.get()
    if cap is None:
        return None
    name = str(tool_name or "unknown")
    cap.tools_denied.append(name)
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
    text = str(content or "").strip()
    if text:
        cap.reply_text = text
    return {"suppressed": True, "raw_response": {ISOLATION_NO_SEND: True}}


def deny_journal_if_isolated() -> bool:
    cap = _ISOLATED.get()
    if cap is None:
        return False
    cap.journal_writes_denied += 1
    return True


def record_consumed_pack(
    pack_id: Optional[str],
    *,
    injected: bool = False,
    source: Optional[str] = None,
    fallback: Optional[str] = None,
) -> None:
    cap = _ISOLATED.get()
    if cap is None:
        return
    if pack_id:
        cap.observed_pack_id = str(pack_id)
    if injected:
        cap.observed_pack_injected = True
    if source:
        cap.setting_source = str(source)
    if fallback:
        cap.setting_fallback = str(fallback)


def observe_provider_invocation(model: Optional[str] = None, prompt_blob: Any = None) -> None:
    """Record an actual provider entry. Not a voluntary test counter."""
    cap = _ISOLATED.get()
    if cap is None:
        return
    cap.model_called = True
    cap.model_calls += 1
    if model:
        cap.model = str(model)
    blob = str(prompt_blob or "")
    if PACK_INJECTION_MARK in blob:
        cap.observed_pack_from_provider = True
        marker = PACK_INJECTION_MARK
        idx = blob.find(marker)
        rest = blob[idx + len(marker) :].strip()
        token = rest.split(None, 1)[0].strip("().").lower() if rest else ""
        if token:
            cap.observed_pack_id = token
            cap.observed_pack_injected = True


def record_model_call(model: Optional[str] = None) -> None:
    """Deprecated alias — production must observe via provider wrapper."""
    observe_provider_invocation(model)


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


def _mark(fn: Any, *, ctx: bool = False) -> Any:
    setattr(fn, _CTX_MARK if ctx else _WRAP_MARK, True)
    return fn


def _save_orig(owner: Any, attr: str, orig: Any) -> None:
    _ORIG_OWNERS.append((owner, attr, orig))


def _wrap_pre_tool_call_block(plugins_mod: Any = None) -> bool:
    global _tool_hook_wrapped
    mod = plugins_mod
    if mod is None:
        try:
            import hermes_cli.plugins as mod  # type: ignore
        except Exception:
            _tool_hook_wrapped = False
            return False
    current = getattr(mod, "get_pre_tool_call_block_message", None)
    if current is None:
        _tool_hook_wrapped = False
        return False
    if _is_wrapped(current):
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

    _mark(_wrapped)
    _save_orig(mod, "get_pre_tool_call_block_message", current)
    mod.get_pre_tool_call_block_message = _wrapped
    _tool_hook_wrapped = True
    return True


def _wrap_tool_dispatcher(handle_mod: Any = None) -> bool:
    global _tool_dispatcher_wrapped
    mod = handle_mod
    if mod is None:
        try:
            import model_tools as mod  # type: ignore
        except Exception:
            _tool_dispatcher_wrapped = False
            return False
    orig = getattr(mod, "handle_function_call", None)
    if orig is None:
        _tool_dispatcher_wrapped = False
        return False
    if _is_wrapped(orig):
        _tool_dispatcher_wrapped = True
        return True

    def _wrapped(function_name: str, function_args: Any = None, *rest: Any, **kwargs: Any) -> Any:
        blocked = deny_tool_if_isolated(str(function_name), function_args if isinstance(function_args, dict) else {})
        if blocked:
            return json.dumps({"error": blocked}, ensure_ascii=False)
        return orig(function_name, function_args, *rest, **kwargs)

    _mark(_wrapped)
    _save_orig(mod, "handle_function_call", orig)
    mod.handle_function_call = _wrapped
    _tool_dispatcher_wrapped = True
    return True


def _send_result(captured: Dict[str, Any]) -> Any:
    try:
        from gateway.platforms.base import SendResult  # type: ignore

        return SendResult(
            success=True,
            message_id=None,
            raw_response=captured["raw_response"],
        )
    except Exception:
        return None


def _wrap_send_adapter(adapter_cls: Any = None) -> bool:
    global _send_wrapped, _send_methods_wrapped
    cls = adapter_cls
    if cls is None:
        try:
            import gateway.platforms.whatsapp_cloud as wh_mod  # type: ignore

            cls = getattr(wh_mod, "WhatsAppCloudAdapter", None)
        except Exception:
            cls = None
    if cls is None:
        _send_wrapped = False
        _send_methods_wrapped = False
        return False

    wrapped_any = False
    missing_required = False
    for name in WHATSAPP_SEND_METHODS:
        orig = getattr(cls, name, None)
        if orig is None:
            if name == "send":
                missing_required = True
            continue
        if _is_wrapped(orig):
            wrapped_any = True
            continue

        def _factory(method_name: str, original: Any):
            async def _isolated_send(self, *args: Any, **kwargs: Any):
                content = None
                if method_name == "send":
                    if len(args) >= 2:
                        content = args[1]
                    else:
                        content = kwargs.get("content")
                captured = capture_send_if_isolated(content)
                if captured is not None:
                    return _send_result(captured)
                result = original(self, *args, **kwargs)
                if hasattr(result, "__await__"):
                    result = await result
                cap = _ISOLATED.get()
                if cap is not None:
                    cap.sends_completed += 1
                return result

            return _isolated_send

        wrapped = _factory(name, orig)
        _mark(wrapped)
        _save_orig(cls, name, orig)
        setattr(cls, name, wrapped)
        wrapped_any = True

    send_fn = getattr(cls, "send", None)
    _send_wrapped = _is_wrapped(send_fn)
    extra = [n for n in WHATSAPP_SEND_METHODS if n != "send" and getattr(cls, n, None) is not None]
    _send_methods_wrapped = _send_wrapped and all(_is_wrapped(getattr(cls, n, None)) for n in extra)
    if missing_required:
        _send_wrapped = False
        _send_methods_wrapped = False
        return False
    return bool(_send_wrapped and _send_methods_wrapped and wrapped_any)


def _iter_post_bot_modules(explicit: Sequence[Any] = ()) -> List[Any]:
    found: List[Any] = []
    seen: set = set()
    for mod in explicit:
        if mod is not None and id(mod) not in seen and hasattr(mod, "_post_bot"):
            found.append(mod)
            seen.add(id(mod))
    try:
        import sys
        import importlib
    except Exception:
        return found
    for key, loaded in list(sys.modules.items()):
        if loaded and key.endswith("wolfhouse_staff_api") and hasattr(loaded, "_post_bot"):
            if id(loaded) not in seen:
                found.append(loaded)
                seen.add(id(loaded))
    if not found:
        for name in ("plugins.wolfhouse_staff_api", "wolfhouse_staff_api"):
            try:
                cand = importlib.import_module(name)
            except Exception:
                continue
            if hasattr(cand, "_post_bot") and id(cand) not in seen:
                found.append(cand)
                seen.add(id(cand))
    return found


def _wrap_post_bot(explicit: Sequence[Any] = ()) -> bool:
    global _post_bot_wrapped
    mods = _iter_post_bot_modules(explicit)
    if not mods:
        _post_bot_wrapped = False
        return False
    ok_all = True
    for mod in mods:
        orig = getattr(mod, "_post_bot", None)
        if orig is None:
            ok_all = False
            continue
        if _is_wrapped(orig):
            continue

        def _factory(original: Any):
            def _isolated_post_bot(path, payload=None, *rest: Any, **kwargs: Any):
                denied = deny_post_bot_if_isolated(path, payload)
                if denied is not None:
                    return denied
                return original(path, payload, *rest, **kwargs)

            return _isolated_post_bot

        wrapped = _factory(orig)
        _mark(wrapped)
        _save_orig(mod, "_post_bot", orig)
        mod._post_bot = wrapped
    _post_bot_wrapped = ok_all and all(_is_wrapped(getattr(m, "_post_bot", None)) for m in mods)
    return _post_bot_wrapped


def _wrap_journal(*, store_cls: Any = None, store: Any = None, runner: Any = None) -> bool:
    global _journal_wrapped
    targets: List[Tuple[Any, str, Any]] = []
    cls = store_cls
    if cls is None:
        try:
            from gateway.session import SessionStore as cls  # type: ignore
        except Exception:
            cls = None
    if cls is not None and hasattr(cls, "append_to_transcript"):
        targets.append((cls, "append_to_transcript", cls.append_to_transcript))

    instance = store
    if instance is None and runner is not None:
        instance = getattr(runner, "session_store", None)
    if instance is None:
        try:
            from gateway.run import _wolfhouse_gateway_runner as gw_runner  # noqa: WPS433

            instance = getattr(gw_runner, "session_store", None) if gw_runner is not None else None
        except Exception:
            instance = None
    if instance is not None and hasattr(instance, "append_to_transcript"):
        # Instance may already be the class method; wrap instance anyway if distinct.
        inst_fn = instance.append_to_transcript
        if not _is_wrapped(inst_fn):
            targets.append((instance, "append_to_transcript", inst_fn))

    if not targets:
        _journal_wrapped = False
        return False

    wrapped_ok = False
    for owner, attr, orig in targets:
        if orig is None:
            continue
        if _is_wrapped(orig):
            wrapped_ok = True
            continue

        def _factory(original: Any):
            def _isolated_append(*args: Any, **kwargs: Any):
                if deny_journal_if_isolated():
                    return None
                cap = _ISOLATED.get()
                result = original(*args, **kwargs)
                if cap is not None:
                    cap.journal_writes_completed += 1
                return result

            return _isolated_append

        wrapped = _factory(orig)
        _mark(wrapped)
        _save_orig(owner, attr, orig)
        setattr(owner, attr, wrapped)
        wrapped_ok = True

    live = False
    if cls is not None:
        live = _is_wrapped(getattr(cls, "append_to_transcript", None))
    if instance is not None:
        live = live or _is_wrapped(getattr(instance, "append_to_transcript", None))
    _journal_wrapped = bool(wrapped_ok and live)
    return _journal_wrapped


def _wrap_executor_context_propagation() -> bool:
    global _executor_ctx_wrapped, _EXECUTOR_ORIG
    orig = ThreadPoolExecutor.submit
    if _is_wrapped(orig):
        _executor_ctx_wrapped = True
        return True
    _EXECUTOR_ORIG = orig

    def _submit(self, fn, /, *args, **kwargs):  # type: ignore[no-untyped-def]
        ctx = copy_context()

        def _runner():
            return fn(*args, **kwargs)

        return orig(self, ctx.run, _runner)

    _mark(_submit, ctx=True)
    ThreadPoolExecutor.submit = _submit  # type: ignore[method-assign]
    _executor_ctx_wrapped = True
    return True


def _prompt_blob_from_kwargs(api_kwargs: Any) -> str:
    if not isinstance(api_kwargs, dict):
        return str(api_kwargs or "")
    parts: List[str] = []
    for key in ("messages", "input", "instructions", "system"):
        val = api_kwargs.get(key)
        if val:
            parts.append(str(val))
    model = api_kwargs.get("model")
    if model:
        parts.append(str(model))
    return "\n".join(parts)


def _wrap_provider(provider_mod: Any = None, attr: str = "interruptible_api_call") -> bool:
    global _provider_wrapped
    mod = provider_mod
    if mod is None:
        try:
            import agent.chat_completion_helpers as mod  # type: ignore
        except Exception:
            _provider_wrapped = False
            return False
    orig = getattr(mod, attr, None)
    if orig is None:
        _provider_wrapped = False
        return False
    if _is_wrapped(orig):
        _provider_wrapped = True
        return True

    def _wrapped(agent=None, api_kwargs=None, *rest: Any, **kwargs: Any):
        model = None
        blob = ""
        if isinstance(api_kwargs, dict):
            model = api_kwargs.get("model")
            blob = _prompt_blob_from_kwargs(api_kwargs)
        elif isinstance(kwargs.get("api_kwargs"), dict):
            model = kwargs["api_kwargs"].get("model")
            blob = _prompt_blob_from_kwargs(kwargs["api_kwargs"])
        observe_provider_invocation(model, blob)
        if agent is None and api_kwargs is None:
            return orig(*rest, **kwargs)
        return orig(agent, api_kwargs, *rest, **kwargs)

    _mark(_wrapped)
    _save_orig(mod, attr, orig)
    setattr(mod, attr, _wrapped)
    _provider_wrapped = True
    return True


def inspect_live_seams(
    *,
    targets: Optional[IsolationTargets] = None,
    runner: Any = None,
) -> Dict[str, bool]:
    """Inspect live function objects. Sticky globals are not evidence."""
    t = targets or IsolationTargets()
    send_cls = t.whatsapp_adapter_cls
    if send_cls is None:
        try:
            import gateway.platforms.whatsapp_cloud as wh_mod  # type: ignore

            send_cls = getattr(wh_mod, "WhatsAppCloudAdapter", None)
        except Exception:
            send_cls = None
    send_fn = getattr(send_cls, "send", None) if send_cls is not None else None
    extra_ok = True
    if send_cls is not None:
        for name in WHATSAPP_SEND_METHODS:
            fn = getattr(send_cls, name, None)
            if name == "send" and fn is None:
                extra_ok = False
            elif fn is not None and not _is_wrapped(fn):
                extra_ok = False

    plugins_mod = t.plugins_mod
    if plugins_mod is None:
        try:
            import hermes_cli.plugins as plugins_mod  # type: ignore
        except Exception:
            plugins_mod = None
    hook_fn = getattr(plugins_mod, "get_pre_tool_call_block_message", None) if plugins_mod is not None else None

    disp_mod = t.handle_function_call_mod
    if disp_mod is None:
        try:
            import model_tools as disp_mod  # type: ignore
        except Exception:
            disp_mod = None
    disp_fn = getattr(disp_mod, "handle_function_call", None) if disp_mod is not None else None

    post_mods = _iter_post_bot_modules(t.post_bot_mods)
    post_ok = bool(post_mods) and all(_is_wrapped(getattr(m, "_post_bot", None)) for m in post_mods)

    store_cls = t.session_store_cls
    if store_cls is None:
        try:
            from gateway.session import SessionStore as store_cls  # type: ignore
        except Exception:
            store_cls = None
    journal_fn = getattr(store_cls, "append_to_transcript", None) if store_cls is not None else None
    if not _is_wrapped(journal_fn):
        inst = t.session_store
        if inst is None and runner is not None:
            inst = getattr(runner, "session_store", None)
        journal_fn = getattr(inst, "append_to_transcript", None) if inst is not None else journal_fn

    provider_mod = t.provider_mod
    if provider_mod is None:
        try:
            import agent.chat_completion_helpers as provider_mod  # type: ignore
        except Exception:
            provider_mod = None
    provider_fn = (
        getattr(provider_mod, t.provider_attr, None) if provider_mod is not None else None
    )

    return {
        "send_wrapped": _is_wrapped(send_fn),
        "send_methods_wrapped": bool(_is_wrapped(send_fn) and extra_ok),
        "tool_hook_wrapped": _is_wrapped(hook_fn),
        "tool_dispatcher_wrapped": _is_wrapped(disp_fn),
        "post_bot_wrapped": post_ok,
        "journal_wrapped": _is_wrapped(journal_fn),
        "executor_ctx_wrapped": _is_wrapped(getattr(ThreadPoolExecutor, "submit", None)),
        "provider_wrapped": _is_wrapped(provider_fn),
    }


def install_isolation_runtime(
    *,
    runner: Any = None,
    targets: Optional[IsolationTargets] = None,
) -> Dict[str, bool]:
    """Idempotent passthrough wrappers. Safe for concurrent real turns.

    Does not mark isolation ready. Preflight inspects live owners.
    """
    global _installed
    t = targets or IsolationTargets()
    send_ok = _wrap_send_adapter(t.whatsapp_adapter_cls)
    post_ok = _wrap_post_bot(t.post_bot_mods)
    hook_ok = _wrap_pre_tool_call_block(t.plugins_mod)
    disp_ok = _wrap_tool_dispatcher(t.handle_function_call_mod)
    journal_ok = _wrap_journal(store_cls=t.session_store_cls, store=t.session_store, runner=runner)
    exec_ok = _wrap_executor_context_propagation() if t.wrap_executor else _is_wrapped(getattr(ThreadPoolExecutor, "submit", None))
    prov_ok = _wrap_provider(t.provider_mod, t.provider_attr)
    live = inspect_live_seams(targets=t, runner=runner)
    complete = all(live.get(k) for k in REQUIRED_LIVE_SEAMS)
    _installed = complete
    return {
        "installed": complete,
        "send_wrapped": send_ok and live["send_wrapped"],
        "send_methods_wrapped": live["send_methods_wrapped"],
        "post_bot_wrapped": post_ok and live["post_bot_wrapped"],
        "tool_hook_wrapped": hook_ok and live["tool_hook_wrapped"],
        "tool_dispatcher_wrapped": disp_ok and live["tool_dispatcher_wrapped"],
        "journal_wrapped": journal_ok and live["journal_wrapped"],
        "executor_ctx_wrapped": exec_ok and live["executor_ctx_wrapped"],
        "provider_wrapped": prov_ok and live["provider_wrapped"],
        "live": live,
    }


def mark_test_isolation_installed() -> None:
    """Do NOT certify live seams. Flags-only is stale and must fail require_live_seams."""
    global _installed
    _installed = True


def isolation_status(*, targets: Optional[IsolationTargets] = None, runner: Any = None) -> Dict[str, Any]:
    live = inspect_live_seams(targets=targets, runner=runner)
    return {
        "installed": _installed,
        "context_active": _ISOLATED.get() is not None,
        **live,
        "sticky_flags_are_not_evidence": True,
    }


def preflight_isolation_or_abort(
    *,
    require_live_seams: bool = False,
    targets: Optional[IsolationTargets] = None,
    runner: Any = None,
) -> IsolatedTurnCapture:
    """Abort BEFORE any model call if isolation is not active and complete."""
    cap = _ISOLATED.get()
    if cap is None:
        raise IsolationAbort("isolation_context_missing")
    if require_live_seams:
        live = inspect_live_seams(targets=targets, runner=runner)
        missing = [k for k in REQUIRED_LIVE_SEAMS if not live.get(k)]
        if missing:
            raise IsolationAbort("seams_incomplete:" + ",".join(missing))
        if not all(live.get(k) for k in REQUIRED_LIVE_SEAMS):
            raise IsolationAbort("tools_not_isolated")
    elif not _installed:
        raise IsolationAbort("isolation_not_installed")
    cap.isolation_ready = True
    return cap


def reset_isolation_runtime_for_tests() -> None:
    """Restore originals. Test-only. Does not change production send gates."""
    global _installed, _send_wrapped, _send_methods_wrapped, _post_bot_wrapped
    global _tool_hook_wrapped, _tool_dispatcher_wrapped, _journal_wrapped
    global _executor_ctx_wrapped, _provider_wrapped, _EXECUTOR_ORIG
    for owner, attr, orig in reversed(_ORIG_OWNERS):
        try:
            setattr(owner, attr, orig)
        except Exception:
            pass
    _ORIG_OWNERS.clear()
    if _EXECUTOR_ORIG is not None:
        ThreadPoolExecutor.submit = _EXECUTOR_ORIG  # type: ignore[method-assign]
        _EXECUTOR_ORIG = None
    _installed = False
    _send_wrapped = False
    _send_methods_wrapped = False
    _post_bot_wrapped = False
    _tool_hook_wrapped = False
    _tool_dispatcher_wrapped = False
    _journal_wrapped = False
    _executor_ctx_wrapped = False
    _provider_wrapped = False
