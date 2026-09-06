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

import importlib.util
import inspect
import json
import threading
import uuid
from concurrent.futures.thread import ThreadPoolExecutor
from contextvars import ContextVar, Token, copy_context
from dataclasses import dataclass, field
from datetime import datetime
from types import MethodType, SimpleNamespace
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
    "snapshot_wrapped",
    "mirror_wrapped",
    "executor_ctx_wrapped",
    "thread_ctx_wrapped",
    "provider_wrapped",
    "provider_streaming_wrapped",
    "provider_dispatch_wrapped",
    "turn_entry_wrapped",
)

# Actual helper backends whose SDK create/converse/converse_stream we can observe.
# Unsupported api_mode values fail closed BEFORE dispatch and BEFORE turn entry.
SUPPORTED_PROVIDER_BACKENDS: Tuple[str, ...] = (
    "chat_completions",
    "bedrock_converse",
)

PERSISTENCE_WRITE_METHODS: Tuple[str, ...] = (
    "get_or_create_session",
    "append_to_transcript",
    "_save",
    "update_session",
)

PERSISTENCE_OPTIONAL_WRITE_METHODS: Tuple[str, ...] = (
    "rewrite_transcript",
    "suspend_session",
    "mark_resume_pending",
    "switch_session",
)

# Actual SessionDB write owners, including the shared _execute_write seam.
SQLITE_WRITE_METHODS: Tuple[str, ...] = (
    "create_session",
    "end_session",
    "append_message",
    "update_token_counts",
    "update_session_cwd",
    "update_session_meta",
    "update_session_model",
    "update_system_prompt",
    "reopen_session",
    "_execute_write",
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

# Actual AIAgent snapshot writers. JSON snapshots are independent of SessionDB.
AGENT_SNAPSHOT_METHODS: Tuple[str, ...] = (
    "_persist_session",
    "_save_session_log",
    "_flush_messages_to_session_db",
)

# Alternate / turn-entry owners that can bypass the guarded helper path.
AGENT_TURN_METHODS: Tuple[str, ...] = (
    "run_conversation",
    "chat",
    "_run_codex_app_server_turn",
    "_run_codex_stream",
    "_run_codex_create_stream_fallback",
    "_anthropic_messages_create",
    "switch_model",
)

MIRROR_FUNCTIONS: Tuple[str, ...] = (
    "mirror_whatsapp_thread",
    "enqueue_mirror_payload",
    "get_mirror_queue",
    "_post_mirror_sync",
    "mirror_whatsapp_outbound_after_send",
    "mirror_whatsapp_outbound_as_draft",
    "mirror_raw_inbound",
)

MIRROR_QUEUE_METHODS: Tuple[str, ...] = (
    "enqueue",
    "_deliver",
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
_snapshot_wrapped = False
_mirror_wrapped = False
_executor_ctx_wrapped = False
_thread_ctx_wrapped = False
_provider_wrapped = False
_provider_streaming_wrapped = False
_provider_dispatch_wrapped = False
_turn_entry_wrapped = False

# (owner, attr, original). Tests restore these; production never unwraps.
_ORIG_OWNERS: List[Tuple[Any, str, Any]] = []
_EXECUTOR_ORIG: Optional[Callable[..., Any]] = None
_THREAD_START_ORIG: Optional[Callable[..., Any]] = None
_ACTIVE_TARGETS: Optional[IsolationTargets] = None
_ACTIVE_RUNNER: Any = None


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
    _request_identity: Any = field(default=None, repr=False, compare=False)
    model_called: bool = False
    provider_helper_attempts: int = 0
    # Observed create calls only: returned does not mean stream completion or HTTP success.
    responses_sdk_attempted: int = 0
    responses_sdk_returned: int = 0
    # Capture-local accounting only; never held across parsing or the SDK call.
    _responses_sdk_lock: Any = field(default_factory=threading.Lock, init=False, repr=False, compare=False)
    telemetry_producer_suppressed: int = 0
    _telemetry_producer_lock: Any = field(default_factory=threading.Lock, repr=False, compare=False)
    provider_helper_kind: Optional[str] = None
    isolation_ready: bool = False
    observed_pack_id: Optional[str] = None
    observed_pack_injected: bool = False
    observed_pack_from_provider: bool = False
    setting_source: Optional[str] = None
    setting_fallback: Optional[str] = None
    ephemeral_chat_id: Optional[str] = None
    ephemeral_session_id: Optional[str] = None
    evidence_kind: str = "unspecified"
    interim_send_text: Optional[str] = None
    final_handler_text: Optional[str] = None
    in_flight_threads: List[Any] = field(default_factory=list)
    provider_work_settled: bool = False
    persistence_denied: Dict[str, int] = field(default_factory=dict)
    persistence_effects_completed: List[str] = field(default_factory=list)


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
    provider_streaming_attr: str = "interruptible_streaming_api_call"
    wrap_executor: bool = True
    wrap_thread: bool = True
    session_db: Any = None
    agent_session_db: Any = None
    session_db_cls: Any = None
    whatsapp_adapter: Any = None
    openai_client_factory_owner: Any = None
    bedrock_adapter_mod: Any = None
    agent_cls: Any = None
    mirror_mod: Any = None
    conversation_loop_mod: Any = None
    codex_runtime_mod: Any = None
    atomic_json_mod: Any = None
    atomic_json_attr: str = "atomic_json_write"


class IsolationAbort(RuntimeError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason
        self.cleanup_error: Optional[str] = None
        self.counters: Optional[Dict[str, Optional[int]]] = None


def refuse_unverified_runtime() -> None:
    """No inert canonical route authority exists for this containment slice."""
    if _ISOLATED.get() is not None:
        raise IsolationAbort("runtime_resolution_unverified")


def current_isolated_turn() -> Optional[IsolatedTurnCapture]:
    return _ISOLATED.get()


def deny_telemetry_if_isolated() -> bool:
    """Deny producer admission; this scalar is not an external-effects count."""
    cap = current_isolated_turn()
    if cap is None:
        return False
    try:
        with cap._telemetry_producer_lock:
            cap.telemetry_producer_suppressed = min(cap.telemetry_producer_suppressed + 1, 2**53 - 1)
    except Exception:
        # Diagnostic failure must never reopen the shared producer queue.
        pass
    return True


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
        # Interim/streaming send is not the canonical handler FINAL return.
        cap.interim_send_text = text
    return {"suppressed": True, "raw_response": {ISOLATION_NO_SEND: True}}


def deny_journal_if_isolated(effect: Optional[str] = None) -> bool:
    cap = _ISOLATED.get()
    if cap is None:
        return False
    cap.journal_writes_denied += 1
    if effect:
        cap.persistence_denied[effect] = cap.persistence_denied.get(effect, 0) + 1
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


def observe_provider_helper_attempt(kind: Optional[str] = None, model: Optional[str] = None) -> None:
    """Helper entry/attempt. Not an actual provider dispatch count."""
    cap = _ISOLATED.get()
    if cap is None:
        return
    cap.provider_helper_attempts += 1
    if kind:
        cap.provider_helper_kind = str(kind)
    if model and not cap.model:
        cap.model = str(model)


def observe_provider_invocation(model: Optional[str] = None, prompt_blob: Any = None) -> None:
    """Record one actual SDK/provider call, not helper entry or worker start."""
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


def observe_provider_dispatch(api_kwargs: Any = None, *, model: Optional[str] = None, prompt_blob: Any = None) -> None:
    """Observe the actual create/converse kwargs at the provider call boundary."""
    resolved_model, blob = _extract_provider_model_blob(api_kwargs, {})
    observe_provider_invocation(model or resolved_model, prompt_blob or blob)


def record_model_call(model: Optional[str] = None) -> None:
    """Deprecated alias — production must observe via provider-worker dispatch."""
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
    """Record long-lived originals for test reset. Production never unwraps.

    Do not record ephemeral dynamically exec'd mirror modules, their classes, or
    their functions. Those graphs are discarded by the canonical bootstrap after
    each use; storing them here (or in a weak-key map whose values close over
    the owner via ``__globals__`` / bound methods) would root them for the
    process lifetime.
    """
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


def _send_owner_complete(owner: Any) -> bool:
    if owner is None:
        return False
    send_fn = getattr(owner, "send", None)
    if send_fn is None or not _is_wrapped(send_fn):
        return False
    for name in WHATSAPP_SEND_METHODS:
        fn = getattr(owner, name, None)
        if fn is not None and not _is_wrapped(fn):
            return False
    return True


def _is_already_bound_effective_method(owner: Any, original: Any) -> bool:
    """True when original is an instance-bound callable, not a class descriptor.

    Class functions rely on the descriptor protocol to bind ``self``. Already-bound
    instance methods and functions stored on the instance must not take an extra
    wrapper ``self`` or keyword calls (chat_id=/content=) break.
    """
    if owner is None or isinstance(owner, type) or original is None:
        return False
    if inspect.ismethod(original) and getattr(original, "__self__", None) is owner:
        return True
    if isinstance(original, MethodType):
        return True
    try:
        inst_dict = object.__getattribute__(owner, "__dict__")
    except Exception:
        inst_dict = None
    if not isinstance(inst_dict, dict) or original not in inst_dict.values():
        return False
    return inspect.isfunction(original) or inspect.iscoroutinefunction(original) or callable(original)


def _send_content_from_call(args: Tuple[Any, ...], kwargs: Dict[str, Any]) -> Any:
    if len(args) >= 2:
        return args[1]
    if "content" in kwargs:
        return kwargs.get("content")
    return None


def _refuse_stale_adapter(adapter: Any) -> None:
    """Revalidate at use: unwrapped instance send must not reach delivery."""
    if adapter is None or _ISOLATED.get() is None:
        return
    if not _send_owner_complete(adapter):
        raise IsolationAbort("stale_adapter_send")


class _RevalidatingAdapterMap(dict):
    """runner.adapters proxy: refuse stale instance send before delivery."""

    def get(self, key, default=None):  # type: ignore[no-untyped-def]
        adapter = dict.get(self, key, default)
        _refuse_stale_adapter(adapter)
        return adapter

    def __getitem__(self, key):  # type: ignore[no-untyped-def]
        adapter = dict.__getitem__(self, key)
        _refuse_stale_adapter(adapter)
        return adapter

    def values(self):  # type: ignore[no-untyped-def]
        vals = list(dict.values(self))
        for adapter in vals:
            _refuse_stale_adapter(adapter)
        return vals

    def items(self):  # type: ignore[no-untyped-def]
        pairs = list(dict.items(self))
        for _key, adapter in pairs:
            _refuse_stale_adapter(adapter)
        return pairs


def _platform_key(platform: Any) -> Any:
    return getattr(platform, "value", platform)


def _iter_effective_adapters(*, runner: Any = None, targets: Optional[IsolationTargets] = None) -> List[Any]:
    t = targets or IsolationTargets()
    found: List[Any] = []
    if t.whatsapp_adapter is not None:
        found.append(t.whatsapp_adapter)
    if runner is not None:
        for attr in ("whatsapp_adapter", "adapter"):
            obj = getattr(runner, attr, None)
            if obj is not None:
                found.append(obj)
        adapters = getattr(runner, "adapters", None)
        if isinstance(adapters, dict):
            found.extend(list(dict.values(adapters)))
    return _unique_objs(found)


def _install_adapter_map(runner: Any) -> None:
    if runner is None:
        return
    adapters = getattr(runner, "adapters", None)
    if not isinstance(adapters, dict):
        return
    if isinstance(adapters, _RevalidatingAdapterMap):
        return
    wrapped = _RevalidatingAdapterMap(adapters)
    _save_orig(runner, "adapters", adapters)
    runner.adapters = wrapped
    router = getattr(runner, "delivery_router", None)
    if router is not None and getattr(router, "adapters", None) is adapters:
        _save_orig(router, "adapters", adapters)
        router.adapters = wrapped


def _wrap_send_owner(owner: Any) -> bool:
    if owner is None:
        return False
    wrapped_any = False
    missing_required = False
    for name in WHATSAPP_SEND_METHODS:
        orig = getattr(owner, name, None)
        if orig is None:
            if name == "send":
                missing_required = True
            continue
        if _is_wrapped(orig):
            wrapped_any = True
            continue

        bound = _is_already_bound_effective_method(owner, orig)

        def _factory(method_name: str, original: Any, bound_owner: Any, already_bound: bool):
            if already_bound:
                async def _isolated_send_bound(*args: Any, **kwargs: Any):
                    _refuse_stale_adapter(bound_owner)
                    content = _send_content_from_call(args, kwargs) if method_name == "send" else None
                    captured = capture_send_if_isolated(content)
                    if captured is not None:
                        return _send_result(captured)
                    result = original(*args, **kwargs)
                    if hasattr(result, "__await__"):
                        result = await result
                    cap = _ISOLATED.get()
                    if cap is not None:
                        cap.sends_completed += 1
                    return result

                return _isolated_send_bound

            async def _isolated_send_descriptor(self, *args: Any, **kwargs: Any):
                _refuse_stale_adapter(self)
                content = _send_content_from_call(args, kwargs) if method_name == "send" else None
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

            return _isolated_send_descriptor

        wrapped = _factory(name, orig, owner, bound)
        _mark(wrapped)
        _save_orig(owner, name, orig)
        setattr(owner, name, wrapped)
        wrapped_any = True

    if missing_required:
        return False
    return wrapped_any and _send_owner_complete(owner)


def _discover_whatsapp_adapter_cls(explicit: Any = None) -> Any:
    if explicit is not None:
        return explicit
    try:
        import gateway.platforms.whatsapp_cloud as wh_mod  # type: ignore

        return getattr(wh_mod, "WhatsAppCloudAdapter", None)
    except Exception:
        return None


def _wrap_send_adapter(adapter_cls: Any = None, *, runner: Any = None, targets: Optional[IsolationTargets] = None) -> bool:
    global _send_wrapped, _send_methods_wrapped
    t = targets or IsolationTargets()
    cls = _discover_whatsapp_adapter_cls(adapter_cls if adapter_cls is not None else t.whatsapp_adapter_cls)
    if cls is None and t.whatsapp_adapter is None and runner is None:
        _send_wrapped = False
        _send_methods_wrapped = False
        return False

    wrapped_any = False
    if cls is not None and _wrap_send_owner(cls):
        wrapped_any = True
    _install_adapter_map(runner)
    for owner in _iter_effective_adapters(runner=runner, targets=t):
        if _wrap_send_owner(owner):
            wrapped_any = True

    send_fn = getattr(cls, "send", None) if cls is not None else None
    _send_wrapped = _is_wrapped(send_fn) if cls is not None else bool(_iter_effective_adapters(runner=runner, targets=t))
    extra_ok = True
    owners = []
    if cls is not None:
        owners.append(cls)
    owners.extend(_iter_effective_adapters(runner=runner, targets=t))
    for owner in _unique_objs(owners):
        if not _send_owner_complete(owner):
            extra_ok = False
            break
    _send_methods_wrapped = bool(_send_wrapped and extra_ok and wrapped_any)
    if cls is not None and getattr(cls, "send", None) is None:
        _send_wrapped = False
        _send_methods_wrapped = False
        return False
    return bool(_send_wrapped and _send_methods_wrapped)


def _iter_post_bot_modules(explicit: Sequence[Any] = ()) -> List[Any]:
    found: List[Any] = []
    seen: set = set()
    for mod in explicit:
        if mod is not None and id(mod) not in seen and hasattr(mod, "_post_bot"):
            found.append(mod)
            seen.add(id(mod))
    if explicit:
        # Pinned owners: do not import/scan sys.modules (combined-suite contamination).
        return found
    try:
        import sys
        import importlib
    except Exception:
        return found
    exact = sys.modules.get("wolfhouse_staff_api")
    plugins = sys.modules.get("plugins.wolfhouse_staff_api")
    for loaded in (exact, plugins):
        if loaded and hasattr(loaded, "_post_bot") and id(loaded) not in seen:
            found.append(loaded)
            seen.add(id(loaded))
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


def _resolve_session_store(*, store_cls: Any = None, store: Any = None, runner: Any = None) -> Tuple[Any, Any]:
    cls = store_cls
    if cls is None:
        try:
            from gateway.session import SessionStore as cls  # type: ignore
        except Exception:
            cls = None
    instance = store
    if instance is None and runner is not None:
        instance = getattr(runner, "session_store", None)
    if instance is None:
        try:
            from gateway.run import _wolfhouse_gateway_runner as gw_runner  # noqa: WPS433

            instance = getattr(gw_runner, "session_store", None) if gw_runner is not None else None
        except Exception:
            instance = None
    return cls, instance


def _ephemeral_session_entry(store: Any, source: Any) -> Any:
    cap = _ISOLATED.get()
    try:
        key = store._generate_session_key(source)  # noqa: SLF001
    except Exception:
        digits = (cap.ephemeral_chat_id if cap else uuid.uuid4().hex[:10])
        key = f"ephemeral:whatsapp_cloud:dm:{digits}"
    sid = f"lunaeval_{uuid.uuid4().hex[:12]}"
    now = datetime.now()
    try:
        from gateway.session import SessionEntry  # type: ignore

        entry = SessionEntry(
            session_key=key,
            session_id=sid,
            created_at=now,
            updated_at=now,
            origin=source,
        )
    except Exception:
        entry = SimpleNamespace(
            session_key=key,
            session_id=sid,
            created_at=now,
            updated_at=now,
            origin=source,
            suspended=False,
            resume_pending=False,
            total_tokens=0,
        )
    if cap is not None:
        cap.ephemeral_session_id = sid
    return entry


def _wrap_persistence_method(owner: Any, name: str) -> bool:
    orig = getattr(owner, name, None)
    if orig is None:
        return False
    already_on_instance = False
    if not isinstance(owner, type):
        already_on_instance = name in getattr(owner, "__dict__", {})
    if _is_wrapped(orig) and (isinstance(owner, type) or already_on_instance):
        return True

    def _factory(method_name: str, original: Any, bound_owner: Any):
        def _isolated_persist(*args: Any, **kwargs: Any):
            if deny_journal_if_isolated(method_name):
                if method_name == "get_or_create_session":
                    if isinstance(bound_owner, type):
                        self_obj = args[0] if args else None
                        source = args[1] if len(args) > 1 else kwargs.get("source")
                    else:
                        self_obj = bound_owner
                        source = args[0] if args else kwargs.get("source")
                    return _ephemeral_session_entry(self_obj, source)
                if method_name in {"suspend_session", "mark_resume_pending"}:
                    return False
                return None
            cap = _ISOLATED.get()
            result = original(*args, **kwargs)
            if cap is not None:
                cap.journal_writes_completed += 1
                cap.persistence_effects_completed.append(method_name)
            return result

        return _isolated_persist

    wrapped = _factory(name, orig, owner)
    _mark(wrapped)
    _save_orig(owner, name, orig)
    setattr(owner, name, wrapped)
    return True


def _wrap_sqlite_db(db: Any) -> bool:
    if db is None:
        return True
    ok_all = True
    for name in SQLITE_WRITE_METHODS:
        orig = getattr(db, name, None)
        if orig is None:
            continue
        if _is_wrapped(orig):
            continue

        def _factory(method_name: str, original: Any):
            def _isolated_sqlite(*args: Any, **kwargs: Any):
                if deny_journal_if_isolated(f"sqlite:{method_name}"):
                    return None
                cap = _ISOLATED.get()
                result = original(*args, **kwargs)
                if cap is not None:
                    cap.journal_writes_completed += 1
                    cap.persistence_effects_completed.append(f"sqlite:{method_name}")
                return result

            return _isolated_sqlite

        wrapped = _factory(name, orig)
        _mark(wrapped)
        _save_orig(db, name, orig)
        setattr(db, name, wrapped)
        ok_all = ok_all and _is_wrapped(getattr(db, name, None))
    return ok_all


def _persistence_owner_complete(owner: Any) -> bool:
    if owner is None:
        return False
    for name in PERSISTENCE_WRITE_METHODS:
        fn = getattr(owner, name, None)
        if fn is None or not _is_wrapped(fn):
            return False
    for name in PERSISTENCE_OPTIONAL_WRITE_METHODS:
        fn = getattr(owner, name, None)
        if fn is not None and not _is_wrapped(fn):
            return False
    return True


def _sqlite_owner_complete(db: Any) -> bool:
    if db is None:
        return True
    present = False
    for name in SQLITE_WRITE_METHODS:
        fn = getattr(db, name, None)
        if fn is None:
            continue
        present = True
        if not _is_wrapped(fn):
            return False
    return True if present else True


def _session_db_ready(db: Any) -> bool:
    """Effective SessionDB/store._db must exist and have wrapped write methods."""
    if db is None:
        return False
    present = [name for name in SQLITE_WRITE_METHODS if getattr(db, name, None) is not None]
    if not present:
        return False
    return all(_is_wrapped(getattr(db, name)) for name in present)


def _unique_objs(items: Sequence[Any]) -> List[Any]:
    out: List[Any] = []
    seen: set = set()
    for item in items:
        if item is None:
            continue
        key = id(item)
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def _iter_effective_agents(*, runner: Any = None, targets: Optional[IsolationTargets] = None) -> List[Any]:
    t = targets or IsolationTargets()
    agents: List[Any] = []
    if runner is not None:
        for holder_name in ("_running_agents", "_agent_cache"):
            holder = getattr(runner, holder_name, None)
            if not isinstance(holder, dict):
                continue
            for val in holder.values():
                agent = val[0] if isinstance(val, (tuple, list)) and val else val
                if agent is None or agent is True or agent is False:
                    continue
                if getattr(agent, "_luna_personality_pending_sentinel", False):
                    continue
                agents.append(agent)
    return _unique_objs(agents)


def _iter_effective_session_dbs(*, store: Any = None, runner: Any = None, targets: Optional[IsolationTargets] = None) -> List[Any]:
    t = targets or IsolationTargets()
    dbs: List[Any] = []
    if store is not None:
        dbs.append(getattr(store, "_db", None))
    if t.session_db is not None:
        dbs.append(t.session_db)
    if t.agent_session_db is not None:
        dbs.append(t.agent_session_db)
    if runner is not None:
        dbs.append(getattr(runner, "_session_db", None))
        for agent in _iter_effective_agents(runner=runner, targets=t):
            dbs.append(getattr(agent, "_session_db", None))
    return _unique_objs(dbs)


def _discover_session_db_cls(explicit: Any = None) -> Any:
    if explicit is not None:
        return explicit
    try:
        from hermes_state import SessionDB as cls  # type: ignore

        return cls
    except Exception:
        return None


def _wrap_journal(
    *,
    store_cls: Any = None,
    store: Any = None,
    runner: Any = None,
    targets: Optional[IsolationTargets] = None,
) -> bool:
    global _journal_wrapped
    t = targets or IsolationTargets()
    cls, instance = _resolve_session_store(store_cls=store_cls or t.session_store_cls, store=store or t.session_store, runner=runner)
    wrapped_any = False
    owners: List[Any] = []
    if cls is not None:
        owners.append(cls)
    if instance is not None:
        owners.append(instance)
    if not owners:
        _journal_wrapped = False
        return False

    db_cls = _discover_session_db_cls(t.session_db_cls)
    if db_cls is not None:
        for name in SQLITE_WRITE_METHODS:
            if getattr(db_cls, name, None) is None:
                continue
            if _wrap_persistence_method(db_cls, name):
                wrapped_any = True

    for owner in owners:
        for name in PERSISTENCE_WRITE_METHODS + PERSISTENCE_OPTIONAL_WRITE_METHODS:
            if getattr(owner, name, None) is None:
                continue
            if _wrap_persistence_method(owner, name):
                wrapped_any = True
        db = getattr(owner, "_db", None) if not isinstance(owner, type) else None
        if db is not None:
            if _wrap_sqlite_db(db):
                wrapped_any = True

    for db in _iter_effective_session_dbs(store=instance, runner=runner, targets=t):
        if _wrap_sqlite_db(db):
            wrapped_any = True

    class_ok = _persistence_owner_complete(cls) if cls is not None else False
    inst_ok = True
    if instance is not None:
        inst_ok = _persistence_owner_complete(instance) and _sqlite_owner_complete(getattr(instance, "_db", None))
    dbs_ok = True
    for db in _iter_effective_session_dbs(store=instance, runner=runner, targets=t):
        if not _session_db_ready(db):
            dbs_ok = False
            break
    runner_db_ok = True
    if runner is not None:
        runner_db_ok = _session_db_ready(getattr(runner, "_session_db", None))
    if t.session_db is not None:
        runner_db_ok = runner_db_ok and _session_db_ready(t.session_db)
    if t.agent_session_db is not None:
        runner_db_ok = runner_db_ok and _session_db_ready(t.agent_session_db)
    _journal_wrapped = bool(wrapped_any and class_ok and inst_ok and dbs_ok and runner_db_ok)
    if instance is None and runner is None and t.session_db is None:
        _journal_wrapped = bool(wrapped_any and class_ok)
    return _journal_wrapped


def _discover_agent_cls(explicit: Any = None) -> Any:
    if explicit is not None:
        return explicit
    try:
        from run_agent import AIAgent as cls  # type: ignore

        return cls
    except Exception:
        return None


def _snapshot_owner_complete(owner: Any) -> bool:
    if owner is None:
        return False
    present = False
    for name in AGENT_SNAPSHOT_METHODS:
        fn = getattr(owner, name, None)
        if fn is None:
            continue
        present = True
        if not _is_wrapped(fn):
            return False
    return present


def _wrap_agent_snapshot_owner(owner: Any) -> bool:
    if owner is None:
        return False
    wrapped_any = False
    for name in AGENT_SNAPSHOT_METHODS:
        orig = getattr(owner, name, None)
        if orig is None:
            continue
        already_on_instance = False
        if not isinstance(owner, type):
            already_on_instance = name in getattr(owner, "__dict__", {})
        if _is_wrapped(orig) and (isinstance(owner, type) or already_on_instance):
            wrapped_any = True
            continue

        def _factory(method_name: str, original: Any):
            def _isolated_snapshot(*args: Any, **kwargs: Any):
                if deny_journal_if_isolated(f"snapshot:{method_name}"):
                    return None
                cap = _ISOLATED.get()
                result = original(*args, **kwargs)
                if cap is not None:
                    cap.journal_writes_completed += 1
                    cap.persistence_effects_completed.append(f"snapshot:{method_name}")
                return result

            return _isolated_snapshot

        wrapped = _factory(name, orig)
        _mark(wrapped)
        _save_orig(owner, name, orig)
        setattr(owner, name, wrapped)
        wrapped_any = True
    return wrapped_any


def _discover_atomic_json(*, targets: Optional[IsolationTargets] = None) -> Tuple[Any, str]:
    t = targets or IsolationTargets()
    if t.atomic_json_mod is not None:
        return t.atomic_json_mod, t.atomic_json_attr
    try:
        import utils as mod  # type: ignore

        return mod, "atomic_json_write"
    except Exception:
        return None, "atomic_json_write"


def _wrap_atomic_json_write(*, targets: Optional[IsolationTargets] = None) -> bool:
    mod, attr = _discover_atomic_json(targets=targets)
    if mod is None:
        return False
    orig = getattr(mod, attr, None)
    if orig is None:
        return False
    if _is_wrapped(orig):
        return True

    def _isolated_atomic(*args: Any, **kwargs: Any):
        if deny_journal_if_isolated("atomic_json_write"):
            return None
        cap = _ISOLATED.get()
        result = orig(*args, **kwargs)
        if cap is not None:
            cap.journal_writes_completed += 1
            cap.persistence_effects_completed.append("atomic_json_write")
        return result

    _mark(_isolated_atomic)
    _save_orig(mod, attr, orig)
    setattr(mod, attr, _isolated_atomic)
    return True


def _wrap_snapshots(*, runner: Any = None, targets: Optional[IsolationTargets] = None) -> bool:
    global _snapshot_wrapped
    t = targets or IsolationTargets()
    cls = _discover_agent_cls(t.agent_cls)
    wrapped_any = False
    if cls is not None and _wrap_agent_snapshot_owner(cls):
        wrapped_any = True
    if _wrap_atomic_json_write(targets=t):
        wrapped_any = True
    for agent in _iter_effective_agents(runner=runner, targets=t):
        if _wrap_agent_snapshot_owner(agent):
            wrapped_any = True
    _snapshot_wrapped = _snapshot_owners_live(runner=runner, targets=t)
    return _snapshot_wrapped and wrapped_any


def _snapshot_owners_live(*, runner: Any = None, targets: Optional[IsolationTargets] = None) -> bool:
    t = targets or IsolationTargets()
    cls = _discover_agent_cls(t.agent_cls)
    agents = _iter_effective_agents(runner=runner, targets=t)
    if cls is None and not agents:
        return False
    if cls is not None and not _snapshot_owner_complete(cls):
        return False
    for agent in agents:
        has_snapshot = any(getattr(agent, name, None) is not None for name in AGENT_SNAPSHOT_METHODS)
        if has_snapshot and not _snapshot_owner_complete(agent):
            return False
    mod, attr = _discover_atomic_json(targets=t)
    atomic_fn = getattr(mod, attr, None) if mod is not None else None
    if atomic_fn is not None and not _is_wrapped(atomic_fn):
        return False
    return True


def _discover_mirror_mod(explicit: Any = None) -> Any:
    if explicit is not None:
        return explicit
    try:
        import wolfhouse_whatsapp_mirror as mod  # type: ignore

        return mod
    except Exception:
        try:
            import importlib

            return importlib.import_module("wolfhouse_whatsapp_mirror")
        except Exception:
            return None


def _is_mirror_dynamic_owner(name: Any, location: Any) -> bool:
    name_s = str(name or "")
    loc_s = str(location or "").replace("\\", "/")
    if name_s == "wolfhouse_whatsapp_mirror" or name_s.endswith(".wolfhouse_whatsapp_mirror"):
        return True
    return loc_s.endswith("wolfhouse_whatsapp_mirror.py")


def _wrap_fresh_mirror_module(mod: Any) -> bool:
    """Wrap a dynamically exec'd mirror module. Cached import wrapping is not this path.

    Ephemeral modules are not recorded in _ORIG_OWNERS: the original registry is
    for long-lived owners that tests restore. Wrappers stay on the module while
    a caller retains it; dropping the module must allow GC without a test-only
    reset. Do not store originals in a weak-key map either — function
    ``__globals__`` and bound methods would keep the module alive.
    """
    if mod is None:
        return False
    for name in MIRROR_FUNCTIONS:
        if getattr(mod, name, None) is None:
            continue
        _wrap_mirror_function(mod, name, persist_original=False)
    queue_cls = getattr(mod, "MirrorQueue", None)
    if queue_cls is not None:
        _wrap_mirror_queue_owner(queue_cls, persist_original=False)
    existing = getattr(mod, "_MIRROR_QUEUE", None)
    if existing is not None:
        _wrap_mirror_queue_owner(existing, persist_original=False)
    return _mirror_mod_complete(mod)


def _attach_mirror_exec_wrapper(spec: Any, name: Any, location: Any) -> None:
    if spec is None:
        return
    origin = location if location is not None else getattr(spec, "origin", None)
    spec_name = name if name is not None else getattr(spec, "name", None)
    if not _is_mirror_dynamic_owner(spec_name, origin):
        return
    loader = getattr(spec, "loader", None)
    orig_exec = getattr(loader, "exec_module", None)
    if orig_exec is None or _is_wrapped(orig_exec):
        return

    def exec_module(module: Any) -> None:
        orig_exec(module)
        wrapped = _wrap_fresh_mirror_module(module)
        if _ISOLATED.get() is not None and not wrapped:
            deny_journal_if_isolated("mirror:missing_isolation_owner")
            raise IsolationAbort("missing_isolation_owner")

    _mark(exec_module)
    loader.exec_module = exec_module


def _dynamic_mirror_loader_live() -> bool:
    spec_fn = getattr(importlib.util, "spec_from_file_location", None)
    from_spec = getattr(importlib.util, "module_from_spec", None)
    return _is_wrapped(spec_fn) and _is_wrapped(from_spec)


def _wrap_dynamic_mirror_loader() -> bool:
    """Wrap the actual bootstrap INBOUND_MIRROR loader (spec/module/exec_module).

    apply_gateway_patches.INBOUND_MIRROR does spec_from_file_location +
    module_from_spec + loader.exec_module each turn, creating a fresh module
    object that is not the cached imported wolfhouse_whatsapp_mirror.
    """
    orig_spec = getattr(importlib.util, "spec_from_file_location", None)
    orig_from_spec = getattr(importlib.util, "module_from_spec", None)
    if orig_spec is None or orig_from_spec is None:
        return False
    if _is_wrapped(orig_spec) and _is_wrapped(orig_from_spec):
        return True

    if not _is_wrapped(orig_spec):
        def spec_from_file_location(name, location=None, *args: Any, **kwargs: Any):  # noqa: ANN001
            spec = orig_spec(name, location, *args, **kwargs)
            _attach_mirror_exec_wrapper(spec, name, location)
            return spec

        _mark(spec_from_file_location)
        _save_orig(importlib.util, "spec_from_file_location", orig_spec)
        importlib.util.spec_from_file_location = spec_from_file_location  # type: ignore[method-assign]

    if not _is_wrapped(orig_from_spec):
        def module_from_spec(spec):  # noqa: ANN001
            module = orig_from_spec(spec)
            origin = getattr(spec, "origin", None)
            spec_name = getattr(spec, "name", None)
            _attach_mirror_exec_wrapper(spec, spec_name, origin)
            return module

        _mark(module_from_spec)
        _save_orig(importlib.util, "module_from_spec", orig_from_spec)
        importlib.util.module_from_spec = module_from_spec  # type: ignore[method-assign]

    return _dynamic_mirror_loader_live()


def _wrap_mirror_function(mod: Any, name: str, *, persist_original: bool = True) -> bool:
    orig = getattr(mod, name, None)
    if orig is None:
        return False
    if _is_wrapped(orig):
        return True

    def _factory(method_name: str, original: Any):
        def _isolated_mirror(*args: Any, **kwargs: Any):
            cap = _ISOLATED.get()
            if cap is not None:
                deny_journal_if_isolated(f"mirror:{method_name}")
                if method_name == "get_mirror_queue":
                    raise IsolationAbort("isolated_mirror_queue_denied")
                if method_name == "enqueue_mirror_payload":
                    return False
                if method_name == "mirror_whatsapp_outbound_as_draft":
                    return {"staged": False, "reason": "luna_personality_isolated"}
                if method_name == "_post_mirror_sync":
                    return None
                return None
            return original(*args, **kwargs)

        return _isolated_mirror

    wrapped = _factory(name, orig)
    _mark(wrapped)
    if persist_original:
        _save_orig(mod, name, orig)
    setattr(mod, name, wrapped)
    return True


def _wrap_mirror_queue_owner(owner: Any, *, persist_original: bool = True) -> bool:
    if owner is None:
        return True
    ok_all = True
    for name in MIRROR_QUEUE_METHODS:
        orig = getattr(owner, name, None)
        if orig is None:
            continue
        if _is_wrapped(orig):
            continue

        def _factory(method_name: str, original: Any):
            def _isolated_queue(*args: Any, **kwargs: Any):
                cap = _ISOLATED.get()
                if cap is not None:
                    deny_journal_if_isolated(f"mirror:{method_name}")
                    if method_name == "enqueue":
                        return False
                    return None
                return original(*args, **kwargs)

            return _isolated_queue

        wrapped = _factory(name, orig)
        _mark(wrapped)
        if persist_original:
            _save_orig(owner, name, orig)
        setattr(owner, name, wrapped)
        ok_all = ok_all and _is_wrapped(getattr(owner, name, None))
    return ok_all


def _mirror_mod_complete(mod: Any) -> bool:
    if mod is None:
        return False
    present = False
    for name in MIRROR_FUNCTIONS:
        fn = getattr(mod, name, None)
        if fn is None:
            continue
        present = True
        if not _is_wrapped(fn):
            return False
    queue_cls = getattr(mod, "MirrorQueue", None)
    if queue_cls is not None:
        for name in MIRROR_QUEUE_METHODS:
            fn = getattr(queue_cls, name, None)
            if fn is not None and not _is_wrapped(fn):
                return False
    return present


def _wrap_mirror(*, targets: Optional[IsolationTargets] = None) -> bool:
    global _mirror_wrapped
    t = targets or IsolationTargets()
    mod = _discover_mirror_mod(t.mirror_mod)
    if mod is None:
        _mirror_wrapped = False
        return False
    wrapped_any = False
    for name in MIRROR_FUNCTIONS:
        if getattr(mod, name, None) is None:
            continue
        if _wrap_mirror_function(mod, name):
            wrapped_any = True
    queue_cls = getattr(mod, "MirrorQueue", None)
    if queue_cls is not None and _wrap_mirror_queue_owner(queue_cls):
        wrapped_any = True
    existing = getattr(mod, "_MIRROR_QUEUE", None)
    if existing is not None:
        _wrap_mirror_queue_owner(existing)
    loader_ok = _wrap_dynamic_mirror_loader()
    _mirror_wrapped = bool(wrapped_any and _mirror_mod_complete(mod) and loader_ok)
    return _mirror_wrapped


def effective_api_mode(agent: Any) -> str:
    mode = getattr(agent, "api_mode", None) if agent is not None else None
    text = str(mode or "chat_completions").strip() or "chat_completions"
    return text


def refuse_unsupported_backend(agent: Any = None, *, mode: Optional[str] = None) -> str:
    resolved = str(mode or effective_api_mode(agent) or "chat_completions")
    if resolved not in SUPPORTED_PROVIDER_BACKENDS:
        raise IsolationAbort(f"unsupported_provider_backend:{resolved}")
    return resolved


def _certify_effective_agent_before_turn_prologue(agent: Any) -> None:
    """Certify the effective agent at the actual turn boundary before prologue.

    Canonical ``conversation_loop.run_conversation`` calls ``build_turn_context``
    before the dispatch loop. Cached-runner preflight and later SDK helper
    revalidation are not this boundary. Do not certify by wrapper markers alone:
    the live OpenAI/Bedrock factory objects must be wrapped, and unsupported
    backends still fail closed first.
    """
    refuse_unsupported_backend(agent)
    _assert_dispatch_factories_live(agent)


def _wrap_turn_owner_method(owner: Any, name: str) -> bool:
    orig = getattr(owner, name, None)
    if orig is None:
        return False
    already_on_instance = False
    if not isinstance(owner, type):
        already_on_instance = name in getattr(owner, "__dict__", {})
    if _is_wrapped(orig) and (isinstance(owner, type) or already_on_instance):
        return True

    def _factory(method_name: str, original: Any, bound_owner: Any):
        def _isolated_turn(*args: Any, **kwargs: Any):
            cap = _ISOLATED.get()
            if cap is None:
                return original(*args, **kwargs)
            self_obj = bound_owner if not isinstance(bound_owner, type) else (args[0] if args else None)
            if method_name == "switch_model":
                new_mode = kwargs.get("api_mode")
                if new_mode is None and len(args) >= 5:
                    new_mode = args[4]
                if new_mode:
                    refuse_unsupported_backend(self_obj, mode=str(new_mode))
                raise IsolationAbort("isolated_model_switch_denied")
            refuse_unsupported_backend(self_obj)
            if method_name in {
                "_run_codex_app_server_turn",
                "_run_codex_stream",
                "_run_codex_create_stream_fallback",
                "_anthropic_messages_create",
            }:
                raise IsolationAbort(f"unsupported_turn_owner:{method_name}")
            _certify_effective_agent_before_turn_prologue(self_obj)
            return original(*args, **kwargs)

        return _isolated_turn

    wrapped = _factory(name, orig, owner)
    _mark(wrapped)
    _save_orig(owner, name, orig)
    setattr(owner, name, wrapped)
    return True


def _turn_owner_complete(owner: Any) -> bool:
    if owner is None:
        return False
    present = False
    for name in AGENT_TURN_METHODS:
        fn = getattr(owner, name, None)
        if fn is None:
            continue
        present = True
        if not _is_wrapped(fn):
            return False
    return present


def _discover_conversation_loop(explicit: Any = None) -> Any:
    if explicit is not None:
        return explicit
    try:
        import agent.conversation_loop as mod  # type: ignore

        return mod
    except Exception:
        return None


def _discover_codex_runtime(explicit: Any = None) -> Any:
    if explicit is not None:
        return explicit
    try:
        import agent.codex_runtime as mod  # type: ignore

        return mod
    except Exception:
        return None


def _wrap_module_turn_entry(mod: Any, attr: str) -> bool:
    if mod is None:
        return False
    orig = getattr(mod, attr, None)
    if orig is None:
        return False
    if _is_wrapped(orig):
        return True

    def _isolated_entry(agent=None, *args: Any, **kwargs: Any):
        cap = _ISOLATED.get()
        if cap is None:
            if agent is None:
                return orig(*args, **kwargs)
            return orig(agent, *args, **kwargs)
        refuse_unsupported_backend(agent)
        if attr in {"run_codex_app_server_turn", "run_codex_stream", "run_codex_create_stream_fallback"}:
            raise IsolationAbort(f"unsupported_turn_owner:{attr}")
        _certify_effective_agent_before_turn_prologue(agent)
        if agent is None:
            return orig(*args, **kwargs)
        return orig(agent, *args, **kwargs)

    _mark(_isolated_entry)
    _save_orig(mod, attr, orig)
    setattr(mod, attr, _isolated_entry)
    return True


def _cached_agents_supported(runner: Any) -> bool:
    for agent in _iter_effective_agents(runner=runner):
        mode = effective_api_mode(agent)
        if mode not in SUPPORTED_PROVIDER_BACKENDS:
            return False
    return True


def _wrap_turn_entry(*, runner: Any = None, targets: Optional[IsolationTargets] = None) -> bool:
    global _turn_entry_wrapped
    t = targets or IsolationTargets()
    cls = _discover_agent_cls(t.agent_cls)
    wrapped_any = False
    if cls is not None:
        original_init = getattr(cls, "__init__", None)
        if callable(original_init) and not _is_wrapped(original_init):
            def _isolated_init(self, *args: Any, **kwargs: Any):
                if _ISOLATED.get() is not None:
                    raise IsolationAbort("constructor_boundary_unverified")
                return original_init(self, *args, **kwargs)
            _mark(_isolated_init)
            _save_orig(cls, "__init__", original_init)
            cls.__init__ = _isolated_init
        for name in AGENT_TURN_METHODS:
            if getattr(cls, name, None) is None:
                continue
            if _wrap_turn_owner_method(cls, name):
                wrapped_any = True
    for agent in _iter_effective_agents(runner=runner, targets=t):
        for name in AGENT_TURN_METHODS:
            if getattr(agent, name, None) is None:
                continue
            if _wrap_turn_owner_method(agent, name):
                wrapped_any = True
    loop_mod = _discover_conversation_loop(t.conversation_loop_mod)
    if _wrap_module_turn_entry(loop_mod, "run_conversation"):
        wrapped_any = True
    codex_mod = _discover_codex_runtime(t.codex_runtime_mod)
    for name in ("run_codex_app_server_turn", "run_codex_stream", "run_codex_create_stream_fallback"):
        if _wrap_module_turn_entry(codex_mod, name):
            wrapped_any = True
    if runner is not None:
        orig_handle = getattr(runner, "_handle_message", None)
        if callable(orig_handle) and not _is_wrapped(orig_handle):
            async def _isolated_handle(*args: Any, **kwargs: Any):
                cap = _ISOLATED.get()
                if cap is not None:
                    live = inspect_live_seams(targets=_ACTIVE_TARGETS or t, runner=runner)
                    missing = [k for k in REQUIRED_LIVE_SEAMS if not live.get(k)]
                    if missing:
                        raise IsolationAbort("seams_incomplete:" + ",".join(missing))
                    for agent in _iter_effective_agents(runner=runner, targets=t):
                        refuse_unsupported_backend(agent)
                result = orig_handle(*args, **kwargs)
                if hasattr(result, "__await__"):
                    result = await result
                return result

            _mark(_isolated_handle)
            _save_orig(runner, "_handle_message", orig_handle)
            runner._handle_message = _isolated_handle
            wrapped_any = True
    _turn_entry_wrapped = _turn_entry_live(runner=runner, targets=t)
    return bool(_turn_entry_wrapped and wrapped_any)


def _turn_entry_live(*, runner: Any = None, targets: Optional[IsolationTargets] = None) -> bool:
    t = targets or IsolationTargets()
    cls = _discover_agent_cls(t.agent_cls)
    agents = _iter_effective_agents(runner=runner, targets=t)
    if cls is None and not agents and t.conversation_loop_mod is None and t.codex_runtime_mod is None:
        loop_mod = _discover_conversation_loop(None)
        if loop_mod is None:
            return False
    if cls is not None and not _turn_owner_complete(cls):
        return False
    for agent in agents:
        has_turn = any(getattr(agent, name, None) is not None for name in AGENT_TURN_METHODS)
        if has_turn and not _turn_owner_complete(agent):
            return False
        if effective_api_mode(agent) not in SUPPORTED_PROVIDER_BACKENDS:
            return False
    loop_mod = _discover_conversation_loop(t.conversation_loop_mod)
    if loop_mod is not None:
        fn = getattr(loop_mod, "run_conversation", None)
        if fn is None or not _is_wrapped(fn):
            return False
    codex_mod = _discover_codex_runtime(t.codex_runtime_mod)
    if codex_mod is not None:
        for name in ("run_codex_app_server_turn", "run_codex_stream", "run_codex_create_stream_fallback"):
            fn = getattr(codex_mod, name, None)
            if fn is not None and not _is_wrapped(fn):
                return False
    return True


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


def _wrap_thread_context_propagation() -> bool:
    """Copy isolated ContextVar into threading.Thread workers (provider path)."""
    global _thread_ctx_wrapped, _THREAD_START_ORIG
    orig = threading.Thread.start
    if _is_wrapped(orig):
        _thread_ctx_wrapped = True
        return True
    _THREAD_START_ORIG = orig

    def _start(self):  # type: ignore[no-untyped-def]
        cap = _ISOLATED.get()
        if cap is None:
            return orig(self)
        target = getattr(self, "_target", None)
        if target is None:
            return orig(self)
        ctx = copy_context()
        args = getattr(self, "_args", ()) or ()
        kwargs = dict(getattr(self, "_kwargs", None) or {})

        def _runner(*_a: Any, **_k: Any):
            def _work():
                # Worker start is not SDK dispatch. Observation happens at the
                # actual create/converse boundary. Preserve raw worker context.
                return target(*args, **kwargs)

            return ctx.run(_work)

        self._target = _runner
        self._args = ()
        self._kwargs = {}
        cap.in_flight_threads.append(self)
        return orig(self)

    _mark(_start, ctx=True)
    threading.Thread.start = _start  # type: ignore[method-assign]
    _thread_ctx_wrapped = True
    return True


def settle_isolated_work(cap: Optional[IsolatedTurnCapture], timeout_s: float = 2.0) -> None:
    """Join isolated provider/worker threads. Fail closed if work stays alive."""
    if cap is None:
        return
    unsettled = False
    for thread in list(cap.in_flight_threads or []):
        is_alive = getattr(thread, "is_alive", None)
        join = getattr(thread, "join", None)
        if callable(is_alive) and is_alive():
            if callable(join):
                join(timeout_s)
            if is_alive():
                unsettled = True
    cap.provider_work_settled = not unsettled
    if unsettled:
        raise IsolationAbort("provider_work_unsettled")


def _prompt_blob_from_kwargs(api_kwargs: Any) -> str:
    if not isinstance(api_kwargs, dict):
        return str(api_kwargs or "")
    parts: List[str] = []
    for key in ("messages", "input", "instructions", "system"):
        val = api_kwargs.get(key)
        if not val:
            continue
        if key == "system" and isinstance(val, list):
            for part in val:
                if isinstance(part, dict) and part.get("text"):
                    parts.append(str(part.get("text")))
                else:
                    parts.append(str(part))
        else:
            parts.append(str(val))
    model = api_kwargs.get("model") or api_kwargs.get("modelId")
    if model:
        parts.append(str(model))
    return "\n".join(parts)


def _extract_provider_model_blob(api_kwargs: Any, kwargs: Dict[str, Any]) -> Tuple[Optional[str], str]:
    payload = api_kwargs
    if not isinstance(payload, dict):
        payload = kwargs.get("api_kwargs") if isinstance(kwargs.get("api_kwargs"), dict) else kwargs
    if not isinstance(payload, dict):
        return None, str(api_kwargs or "")
    model = payload.get("model") or payload.get("modelId")
    blob = _prompt_blob_from_kwargs(payload)
    return (str(model) if model else None), blob


def _assert_dispatch_factories_live(agent: Any = None, *, mode: Optional[str] = None, targets: Optional[IsolationTargets] = None) -> None:
    """Revalidate the selected backend's actual factory before helper dispatch."""
    t = targets or _ACTIVE_TARGETS or IsolationTargets()
    resolved = str(mode or effective_api_mode(agent) or "chat_completions")
    if resolved not in SUPPORTED_PROVIDER_BACKENDS:
        raise IsolationAbort(f"unsupported_provider_backend:{resolved}")
    if resolved == "chat_completions":
        factory = None
        if agent is not None:
            factory = getattr(agent, "_create_request_openai_client", None)
        if factory is None:
            owner = t.openai_client_factory_owner or _discover_ai_agent_cls()
            factory = getattr(owner, "_create_request_openai_client", None) if owner is not None else None
        if not _is_wrapped(factory):
            raise IsolationAbort("stale_openai_client_factory")
    elif resolved == "bedrock_converse":
        bedrock_mod = t.bedrock_adapter_mod or _discover_bedrock_mod()
        factory = getattr(bedrock_mod, "_get_bedrock_runtime_client", None) if bedrock_mod is not None else None
        if not _is_wrapped(factory):
            raise IsolationAbort("stale_bedrock_client_factory")


def _wrap_one_provider_helper(mod: Any, attr: str, kind: str) -> bool:
    orig = getattr(mod, attr, None)
    if orig is None:
        return False
    if _is_wrapped(orig):
        return True

    def _wrapped(agent=None, api_kwargs=None, *rest: Any, **kwargs: Any):
        cap = _ISOLATED.get()
        if cap is None:
            if agent is None and api_kwargs is None:
                return orig(*rest, **kwargs)
            return orig(agent, api_kwargs, *rest, **kwargs)
        model, _blob = _extract_provider_model_blob(api_kwargs, kwargs)
        observe_provider_helper_attempt(kind, model)
        mode = refuse_unsupported_backend(agent)
        _assert_dispatch_factories_live(agent, mode=mode)
        if agent is None and api_kwargs is None:
            return orig(*rest, **kwargs)
        return orig(agent, api_kwargs, *rest, **kwargs)

    _mark(_wrapped)
    _save_orig(mod, attr, orig)
    setattr(mod, attr, _wrapped)
    return True


def _wrap_provider(
    provider_mod: Any = None,
    attr: str = "interruptible_api_call",
    streaming_attr: str = "interruptible_streaming_api_call",
) -> Tuple[bool, bool]:
    global _provider_wrapped, _provider_streaming_wrapped
    mod = provider_mod
    if mod is None:
        try:
            import agent.chat_completion_helpers as mod  # type: ignore
        except Exception:
            _provider_wrapped = False
            _provider_streaming_wrapped = False
            return False, False
    nonstream_ok = _wrap_one_provider_helper(mod, attr, "nonstreaming")
    stream_ok = _wrap_one_provider_helper(mod, streaming_attr, "streaming")
    _provider_wrapped = bool(nonstream_ok and _is_wrapped(getattr(mod, attr, None)))
    _provider_streaming_wrapped = bool(stream_ok and _is_wrapped(getattr(mod, streaming_attr, None)))
    return _provider_wrapped, _provider_streaming_wrapped


_REQUEST_ACQUISITION: ContextVar[Any] = ContextVar("luna_request_acquisition", default=None)


def _check_observation_identity(binding: Any) -> None:
    """Binding integrity only, NOT supported runtime or acquisition authority."""
    cap, agent, model, mode = binding
    if agent is None or not isinstance(model, str) or not model:
        raise IsolationAbort("request_identity_missing")
    if (_ISOLATED.get() is not cap or cap._request_identity is not binding
            or getattr(agent, "model", None) != model or effective_api_mode(agent) != mode):
        raise IsolationAbort("request_identity_changed")


def _check_request_identity(binding: Any) -> None:
    _check_observation_identity(binding)
    refuse_unsupported_backend(binding[1])


def _observe_create_call(original: Any, binding: Any = None, *, responses: bool = False) -> Any:
    def create(*args: Any, **kwargs: Any):
        if binding is not None:
            if responses:
                _check_observation_identity(binding)
            else:
                _check_request_identity(binding)
        cap = _ISOLATED.get()
        if cap is not None:
            payload = kwargs if kwargs else (args[0] if args and isinstance(args[0], dict) else {})
            if responses:
                if args or kwargs.get("stream") is not True or kwargs.get("model") != binding[2]:
                    raise IsolationAbort("responses_dispatch_identity_changed")
            observe_provider_dispatch(payload)
            if responses:
                with cap._responses_sdk_lock:
                    cap.responses_sdk_attempted = min(cap.responses_sdk_attempted + 1, 2**53 - 1)
        result = original(*args, **kwargs)
        if responses and cap is not None:
            with cap._responses_sdk_lock:
                cap.responses_sdk_returned = min(cap.responses_sdk_returned + 1, 2**53 - 1)
        return result

    _mark(create)
    create._luna_request_identity = binding
    return create


def _observe_openai_client(client: Any) -> Any:
    cap = _ISOLATED.get()
    if cap is None or client is None:
        return client
    binding = cap._request_identity
    if binding is None:
        raise IsolationAbort("request_identity_missing")
    responses = binding[3] == "codex_responses"
    if responses:
        _check_observation_identity(binding)
    else:
        _check_request_identity(binding)
    try:
        endpoint = client.responses if responses else client.chat.completions
        orig_create = endpoint.create
    except Exception as exc:
        raise IsolationAbort("provider_dispatch_unobservable") from exc
    if _is_wrapped(orig_create):
        if getattr(orig_create, "_luna_request_identity", None) is not binding:
            raise IsolationAbort("request_identity_changed")
        return client
    endpoint.create = _observe_create_call(orig_create, binding, responses=responses)
    return client


def _observe_bedrock_client(client: Any) -> Any:
    cap = _ISOLATED.get()
    if cap is None or client is None:
        return client
    wrapped_any = False
    for name in ("converse", "converse_stream"):
        orig = getattr(client, name, None)
        if orig is None or _is_wrapped(orig):
            if orig is not None and _is_wrapped(orig):
                wrapped_any = True
            continue
        setattr(client, name, _observe_create_call(orig))
        wrapped_any = True
    if not wrapped_any:
        raise IsolationAbort("provider_dispatch_unobservable")
    return client


def _discover_ai_agent_cls() -> Any:
    try:
        from run_agent import AIAgent  # type: ignore

        return AIAgent
    except Exception:
        return None


def _discover_bedrock_mod() -> Any:
    try:
        import agent.bedrock_adapter as mod  # type: ignore

        return mod
    except Exception:
        return None


def _wrap_openai_client_factory(owner: Any, _name: str = "_create_request_openai_client") -> bool:
    if owner is None:
        return False
    orig = getattr(owner, _name, None)
    if orig is None:
        return False
    already_on_instance = False
    if not isinstance(owner, type):
        already_on_instance = _name in getattr(owner, "__dict__", {})
    if _is_wrapped(orig) and (isinstance(owner, type) or already_on_instance):
        return True

    def _wrapped(*args: Any, **kwargs: Any):
        cap = _ISOLATED.get()
        if cap is None:
            return orig(*args, **kwargs)
        agent = (args[0] if args else kwargs.get("self")) if isinstance(owner, type) else owner
        mode = refuse_unsupported_backend(agent)
        model = getattr(agent, "model", None)
        if agent is None or not isinstance(model, str) or not model:
            raise IsolationAbort("request_identity_missing")
        binding = cap._request_identity
        if _name == "_ensure_primary_openai_client":
            if binding is None or _REQUEST_ACQUISITION.get() is not binding:
                raise IsolationAbort("primary_client_acquisition_denied")
        elif binding is None:
            binding = cap._request_identity = (cap, agent, model, mode)
        if binding[1] is not agent:
            raise IsolationAbort("request_identity_changed")
        _check_request_identity(binding)
        token = _REQUEST_ACQUISITION.set(binding)
        try:
            client = orig(*args, **kwargs)
            _check_request_identity(binding)
            return client if _name == "_ensure_primary_openai_client" else _observe_openai_client(client)
        finally:
            _REQUEST_ACQUISITION.reset(token)

    _mark(_wrapped)
    _save_orig(owner, _name, orig)
    setattr(owner, _name, _wrapped)
    if _name == "_create_request_openai_client":
        _wrap_openai_client_factory(owner, "_ensure_primary_openai_client")
    return True


def _wrap_bedrock_client_factory(mod: Any) -> bool:
    if mod is None:
        return False
    orig = getattr(mod, "_get_bedrock_runtime_client", None)
    if orig is None:
        return False
    if _is_wrapped(orig):
        return True

    def _wrapped(*args: Any, **kwargs: Any):
        client = orig(*args, **kwargs)
        return _observe_bedrock_client(client)

    _mark(_wrapped)
    _save_orig(mod, "_get_bedrock_runtime_client", orig)
    setattr(mod, "_get_bedrock_runtime_client", _wrapped)
    return True


def _wrap_provider_dispatch(*, runner: Any = None, targets: Optional[IsolationTargets] = None) -> bool:
    global _provider_dispatch_wrapped
    t = targets or IsolationTargets()
    factory_owner = t.openai_client_factory_owner
    if factory_owner is None:
        factory_owner = t.agent_cls or _discover_ai_agent_cls() or _discover_agent_cls()
    openai_ok = _wrap_openai_client_factory(factory_owner)
    if t.agent_cls is not None and t.agent_cls is not factory_owner:
        openai_ok = _wrap_openai_client_factory(t.agent_cls) or openai_ok
    bedrock_mod = t.bedrock_adapter_mod
    if bedrock_mod is None:
        bedrock_mod = _discover_bedrock_mod()
    bedrock_ok = _wrap_bedrock_client_factory(bedrock_mod)
    for agent in _iter_effective_agents(runner=runner, targets=t):
        if getattr(agent, "_create_request_openai_client", None) is not None:
            openai_ok = _wrap_openai_client_factory(agent) or openai_ok
    _provider_dispatch_wrapped = _provider_dispatch_live(runner=runner, targets=t)
    return bool(_provider_dispatch_wrapped and openai_ok and bedrock_ok)


def _provider_dispatch_live(*, runner: Any = None, targets: Optional[IsolationTargets] = None) -> bool:
    t = targets or IsolationTargets()
    factory_owner = t.openai_client_factory_owner
    if factory_owner is None:
        factory_owner = t.agent_cls or _discover_ai_agent_cls() or _discover_agent_cls()
    factory_fn = getattr(factory_owner, "_create_request_openai_client", None) if factory_owner is not None else None
    if not _is_wrapped(factory_fn):
        return False
    bedrock_mod = t.bedrock_adapter_mod if t.bedrock_adapter_mod is not None else _discover_bedrock_mod()
    bedrock_fn = getattr(bedrock_mod, "_get_bedrock_runtime_client", None) if bedrock_mod is not None else None
    if bedrock_fn is None or not _is_wrapped(bedrock_fn):
        return False
    for agent in _iter_effective_agents(runner=runner, targets=t):
        mode = effective_api_mode(agent)
        if mode not in SUPPORTED_PROVIDER_BACKENDS:
            return False
        inst_factory = getattr(agent, "_create_request_openai_client", None)
        if inst_factory is not None and not _is_wrapped(inst_factory):
            return False
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
    send_owners: List[Any] = []
    if send_cls is not None:
        send_owners.append(send_cls)
    send_owners.extend(_iter_effective_adapters(runner=runner, targets=t))
    for owner in _unique_objs(send_owners):
        if not _send_owner_complete(owner):
            extra_ok = False
            break

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
    inst = t.session_store
    if inst is None and runner is not None:
        inst = getattr(runner, "session_store", None)
    class_persist = _persistence_owner_complete(store_cls) if store_cls is not None else False
    inst_persist = True
    if inst is not None:
        inst_persist = _persistence_owner_complete(inst) and _sqlite_owner_complete(getattr(inst, "_db", None))
    dbs_ok = True
    for db in _iter_effective_session_dbs(store=inst, runner=runner, targets=t):
        if not _session_db_ready(db):
            dbs_ok = False
            break
    runner_db_ok = True
    if runner is not None:
        runner_db_ok = _session_db_ready(getattr(runner, "_session_db", None))
    if t.session_db is not None:
        runner_db_ok = runner_db_ok and _session_db_ready(t.session_db)
    if t.agent_session_db is not None:
        runner_db_ok = runner_db_ok and _session_db_ready(t.agent_session_db)
    if inst is not None:
        journal_ok = class_persist and inst_persist and dbs_ok and runner_db_ok
    else:
        journal_ok = class_persist and dbs_ok and runner_db_ok
        if runner is None and t.session_db is None and t.agent_session_db is None:
            journal_ok = class_persist

    provider_mod = t.provider_mod
    if provider_mod is None:
        try:
            import agent.chat_completion_helpers as provider_mod  # type: ignore
        except Exception:
            provider_mod = None
    provider_fn = (
        getattr(provider_mod, t.provider_attr, None) if provider_mod is not None else None
    )
    streaming_fn = (
        getattr(provider_mod, t.provider_streaming_attr, None) if provider_mod is not None else None
    )
    has_send_owner = send_cls is not None or bool(_iter_effective_adapters(runner=runner, targets=t))
    return {
        "send_wrapped": (_is_wrapped(send_fn) if send_cls is not None else extra_ok) and has_send_owner,
        "send_methods_wrapped": bool(extra_ok and has_send_owner and (send_cls is None or _is_wrapped(send_fn))),
        "tool_hook_wrapped": _is_wrapped(hook_fn),
        "tool_dispatcher_wrapped": _is_wrapped(disp_fn),
        "post_bot_wrapped": post_ok,
        "journal_wrapped": journal_ok,
        "snapshot_wrapped": _snapshot_owners_live(runner=runner, targets=t),
        "mirror_wrapped": (
            _mirror_mod_complete(_discover_mirror_mod(t.mirror_mod))
            and _dynamic_mirror_loader_live()
        ),
        "executor_ctx_wrapped": _is_wrapped(getattr(ThreadPoolExecutor, "submit", None)),
        "thread_ctx_wrapped": _is_wrapped(getattr(threading.Thread, "start", None)),
        "provider_wrapped": _is_wrapped(provider_fn),
        "provider_streaming_wrapped": _is_wrapped(streaming_fn),
        "provider_dispatch_wrapped": _provider_dispatch_live(runner=runner, targets=t),
        "turn_entry_wrapped": _turn_entry_live(runner=runner, targets=t),
    }


def install_isolation_runtime(
    *,
    runner: Any = None,
    targets: Optional[IsolationTargets] = None,
) -> Dict[str, bool]:
    """Idempotent passthrough wrappers. Safe for concurrent real turns.

    Does not mark isolation ready. Preflight inspects live owners.
    """
    global _installed, _ACTIVE_TARGETS, _ACTIVE_RUNNER
    t = targets or IsolationTargets()
    _ACTIVE_TARGETS = t
    _ACTIVE_RUNNER = runner
    send_ok = _wrap_send_adapter(t.whatsapp_adapter_cls, runner=runner, targets=t)
    post_ok = _wrap_post_bot(t.post_bot_mods)
    hook_ok = _wrap_pre_tool_call_block(t.plugins_mod)
    disp_ok = _wrap_tool_dispatcher(t.handle_function_call_mod)
    journal_ok = _wrap_journal(store_cls=t.session_store_cls, store=t.session_store, runner=runner, targets=t)
    snapshot_ok = _wrap_snapshots(runner=runner, targets=t)
    mirror_ok = _wrap_mirror(targets=t)
    exec_ok = _wrap_executor_context_propagation() if t.wrap_executor else _is_wrapped(getattr(ThreadPoolExecutor, "submit", None))
    thread_ok = _wrap_thread_context_propagation() if t.wrap_thread else _is_wrapped(getattr(threading.Thread, "start", None))
    prov_ok, stream_ok = _wrap_provider(t.provider_mod, t.provider_attr, t.provider_streaming_attr)
    dispatch_ok = _wrap_provider_dispatch(runner=runner, targets=t)
    turn_ok = _wrap_turn_entry(runner=runner, targets=t)
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
        "snapshot_wrapped": snapshot_ok and live["snapshot_wrapped"],
        "mirror_wrapped": mirror_ok and live["mirror_wrapped"],
        "executor_ctx_wrapped": exec_ok and live["executor_ctx_wrapped"],
        "thread_ctx_wrapped": thread_ok and live["thread_ctx_wrapped"],
        "provider_wrapped": prov_ok and live["provider_wrapped"],
        "provider_streaming_wrapped": stream_ok and live["provider_streaming_wrapped"],
        "provider_dispatch_wrapped": dispatch_ok and live["provider_dispatch_wrapped"],
        "turn_entry_wrapped": turn_ok and live["turn_entry_wrapped"],
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
    global _snapshot_wrapped, _mirror_wrapped, _turn_entry_wrapped
    global _executor_ctx_wrapped, _thread_ctx_wrapped, _provider_wrapped
    global _provider_streaming_wrapped, _provider_dispatch_wrapped
    global _EXECUTOR_ORIG, _THREAD_START_ORIG, _ACTIVE_TARGETS, _ACTIVE_RUNNER
    for owner, attr, orig in reversed(_ORIG_OWNERS):
        try:
            setattr(owner, attr, orig)
        except Exception:
            pass
    _ORIG_OWNERS.clear()
    if _EXECUTOR_ORIG is not None:
        ThreadPoolExecutor.submit = _EXECUTOR_ORIG  # type: ignore[method-assign]
        _EXECUTOR_ORIG = None
    if _THREAD_START_ORIG is not None:
        threading.Thread.start = _THREAD_START_ORIG  # type: ignore[method-assign]
        _THREAD_START_ORIG = None
    _installed = False
    _send_wrapped = False
    _send_methods_wrapped = False
    _post_bot_wrapped = False
    _tool_hook_wrapped = False
    _tool_dispatcher_wrapped = False
    _journal_wrapped = False
    _snapshot_wrapped = False
    _mirror_wrapped = False
    _turn_entry_wrapped = False
    _executor_ctx_wrapped = False
    _thread_ctx_wrapped = False
    _provider_wrapped = False
    _provider_streaming_wrapped = False
    _provider_dispatch_wrapped = False
    _ACTIVE_TARGETS = None
    _ACTIVE_RUNNER = None
