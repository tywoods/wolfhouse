"""Per-sender WhatsApp Cloud inbound burst coalescing.

Buffers rapid guest messages for the same conversation key, then flushes one
combined turn after a quiet window. Disabled by default; enable for Sunset
staging via WHATSAPP_BURST_COALESCE_ENABLED=1 and WHATSAPP_BURST_DEBOUNCE_MS.

Design goals (gateway boundary, not SOUL wording):
- Acknowledge Meta webhooks without waiting for the debounce window.
- One active agent run per sender; queue follow-ups while busy.
- Never merge different guests / phone-number IDs / tenants.
- Deduplicate by WhatsApp wamid.
- Preserve chronological guest text and source message IDs.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set

logger = logging.getLogger("wolfhouse.whatsapp_burst")

DEFAULT_DEBOUNCE_MS = 5000
DEFAULT_MAX_MESSAGES = 20
DEFAULT_MAX_CHARS = 8000
DEFAULT_STALE_BUFFER_MS = 120_000
DEFAULT_SEEN_WAMID_CAP = 10_000

# Message kinds we coalesce into one guest turn (text + captions).
_COALESCE_TYPES = frozenset({"text", "TEXT"})
_CAPTION_MEDIA_TYPES = frozenset(
    {"photo", "PHOTO", "video", "VIDEO", "document", "DOCUMENT", "audio", "AUDIO", "voice", "VOICE"}
)
# Structured / interactive — flush any open text burst, then process alone.
_STRUCTURED_TYPES = frozenset(
    {
        "location",
        "LOCATION",
        "interactive",
        "button",
        "contacts",
        "reaction",
        "sticker",
        "STICKER",
    }
)


def _env_int(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def coalesce_enabled() -> bool:
    """Feature gate: off unless explicitly enabled (and debounce > 0)."""
    flag = (os.getenv("WHATSAPP_BURST_COALESCE_ENABLED") or "").strip().lower()
    if flag not in {"1", "true", "yes", "on"}:
        return False
    return debounce_ms() > 0


def debounce_ms() -> int:
    return max(0, _env_int("WHATSAPP_BURST_DEBOUNCE_MS", DEFAULT_DEBOUNCE_MS))


def _diag_include_text() -> bool:
    """Synthetic/test-only: allow raw text in snapshots when explicitly enabled."""
    flag = (os.getenv("WHATSAPP_BURST_DIAG_INCLUDE_TEXT") or "").strip().lower()
    if flag not in {"1", "true", "yes", "on"}:
        return False
    # Require simulate mode so production cannot accidentally retain raw guest text.
    sim = (os.getenv("WOLFHOUSE_SIMULATE_GUEST_TURN") or "").strip()
    return bool(sim)


def max_messages() -> int:
    return max(1, _env_int("WHATSAPP_BURST_MAX_MESSAGES", DEFAULT_MAX_MESSAGES))


def max_chars() -> int:
    return max(1, _env_int("WHATSAPP_BURST_MAX_CHARS", DEFAULT_MAX_CHARS))


def stale_buffer_ms() -> int:
    return max(1_000, _env_int("WHATSAPP_BURST_STALE_BUFFER_MS", DEFAULT_STALE_BUFFER_MS))


def mask_sender_key(key: str) -> str:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
    return f"wa_burst:{digest}"


def _message_type_name(event: Any) -> str:
    mt = getattr(event, "message_type", None)
    if mt is None:
        return "text"
    return str(getattr(mt, "value", mt) or "text")


def _event_text(event: Any) -> str:
    return str(getattr(event, "text", None) or "")


def _event_wamid(event: Any) -> str:
    return str(getattr(event, "message_id", None) or "").strip()


def _is_status_or_empty_reaction(event: Any) -> bool:
    """Statuses never reach here; drop empty reaction-like noise."""
    mt = _message_type_name(event).lower()
    raw = getattr(event, "raw_message", None)
    if isinstance(raw, dict) and str(raw.get("type") or "").lower() == "reaction":
        return True
    if mt == "reaction":
        return True
    return False


def classify_event(event: Any) -> str:
    """Return coalesce | structured | ignore."""
    if _is_status_or_empty_reaction(event):
        return "ignore"
    mt = _message_type_name(event)
    mt_upper = mt.upper()
    text = _event_text(event).strip()
    raw = getattr(event, "raw_message", None)
    raw_type = ""
    if isinstance(raw, dict):
        raw_type = str(raw.get("type") or "").lower()

    if raw_type in {"reaction"} or mt_upper == "REACTION":
        return "ignore"
    if raw_type in {"interactive", "button", "location", "contacts"}:
        return "structured"
    if mt_upper in _STRUCTURED_TYPES or mt in _STRUCTURED_TYPES:
        return "structured"
    if mt_upper in {"TEXT"} or mt in _COALESCE_TYPES:
        return "coalesce"
    if mt_upper in _CAPTION_MEDIA_TYPES or mt in _CAPTION_MEDIA_TYPES:
        # Media with or without caption: treat as structured so we flush text
        # first, then process media as its own turn (preserves binary).
        # Caption-only without media urls still coalesce as text when possible.
        media_urls = getattr(event, "media_urls", None) or []
        if media_urls:
            return "structured"
        if text:
            return "coalesce"
        return "structured"
    if text:
        return "coalesce"
    return "structured"


@dataclass
class SourceMessage:
    text: str
    wamid: str
    timestamp: Any
    message_type: str
    reply_to_message_id: Optional[str] = None
    reply_to_text: Optional[str] = None
    media_urls: List[str] = field(default_factory=list)
    media_types: List[str] = field(default_factory=list)
    raw_message: Any = None
    event: Any = None


@dataclass
class BurstBuffer:
    messages: List[SourceMessage] = field(default_factory=list)
    wamids: Set[str] = field(default_factory=set)
    first_mono: float = 0.0
    last_mono: float = 0.0
    timer_handle: Any = None
    timer_gen: int = 0


@dataclass(frozen=True)
class AdapterDispatch:
    """Immutable adapter+callback binding for one burst owner.

    Never share a mutable global dispatch across adapters — each sender keeps
    the adapter that first accepted its inbound message.
    """
    adapter: Any
    dispatch_fn: Callable[[Any], Awaitable[None]]


@dataclass
class StructuredWork:
    """A non-text inbound that must not be flattened into a text burst."""
    event: Any
    adapter_dispatch: AdapterDispatch


@dataclass
class SenderState:
    key: str
    buffer: Optional[BurstBuffer] = None
    pending: Optional[BurstBuffer] = None
    # Ordered follow-ups while an agent run is active. May mix text bursts
    # (as BurstBuffer pending) and StructuredWork entries.
    structured_queue: List[StructuredWork] = field(default_factory=list)
    adapter_dispatch: Optional[AdapterDispatch] = None
    active_run: bool = False
    active_task: Any = None
    last_activity_mono: float = 0.0


NowFn = Callable[[], float]
ScheduleFn = Callable[[float, Callable[[], Awaitable[None]]], Any]
CancelFn = Callable[[Any], None]


class BurstCoalescer:
    """Per-sender debounce + single-flight agent run for WhatsApp Cloud."""

    def __init__(
        self,
        *,
        debounce_ms: Optional[int] = None,
        max_messages: Optional[int] = None,
        max_chars: Optional[int] = None,
        stale_buffer_ms: Optional[int] = None,
        now_fn: Optional[NowFn] = None,
        schedule_fn: Optional[ScheduleFn] = None,
        cancel_fn: Optional[CancelFn] = None,
        dispatch_fn: Optional[Callable[[Any, Any], Awaitable[None]]] = None,
    ) -> None:
        self._debounce_ms = DEFAULT_DEBOUNCE_MS if debounce_ms is None else max(0, int(debounce_ms))
        self._max_messages = DEFAULT_MAX_MESSAGES if max_messages is None else max(1, int(max_messages))
        self._max_chars = DEFAULT_MAX_CHARS if max_chars is None else max(1, int(max_chars))
        self._stale_buffer_ms = (
            DEFAULT_STALE_BUFFER_MS if stale_buffer_ms is None else max(1_000, int(stale_buffer_ms))
        )
        self._now = now_fn or time.monotonic
        self._schedule = schedule_fn
        self._cancel = cancel_fn
        # Fallback only for unit tests that pass a default dispatch_fn.
        self._default_dispatch_fn = dispatch_fn
        self._senders: Dict[str, SenderState] = {}
        self._seen_wamids: Dict[str, bool] = {}
        self._stats: Dict[str, int] = {
            "agent_invocations": 0,
            "buffered": 0,
            "flushed": 0,
            "deduplicated": 0,
            "queued_during_active": 0,
            "timer_resets": 0,
            "replies": 0,
            "failures": 0,
        }
        self._last_flush_records: List[Dict[str, Any]] = []
        self._loop_tasks: Set[asyncio.Task] = set()

    # ------------------------------------------------------------------ config
    @property
    def debounce_seconds(self) -> float:
        return self._debounce_ms / 1000.0

    def conversation_key(
        self,
        *,
        platform: str,
        phone_number_id: str,
        sender_id: str,
    ) -> str:
        plat = (platform or "whatsapp_cloud").strip().lower() or "whatsapp_cloud"
        pnid = (phone_number_id or "").strip() or "_"
        sender = "".join(ch for ch in str(sender_id or "") if ch.isdigit()) or str(sender_id or "").strip()
        return f"{plat}:{pnid}:{sender}"

    def key_for_adapter_event(self, adapter: Any, event: Any) -> str:
        platform = "whatsapp_cloud"
        source = getattr(event, "source", None)
        if source is not None:
            platform = str(getattr(getattr(source, "platform", None), "value", None) or getattr(source, "platform", None) or platform)
        phone_number_id = str(getattr(adapter, "_phone_number_id", None) or "").strip()
        sender = ""
        if source is not None:
            sender = str(getattr(source, "user_id", None) or getattr(source, "chat_id", None) or "")
        return self.conversation_key(platform=platform, phone_number_id=phone_number_id, sender_id=sender)

    # ------------------------------------------------------------------ logging
    def _log(self, event_name: str, key: str, **fields: Any) -> None:
        payload = {
            "event": event_name,
            "sender_key": mask_sender_key(key),
            **fields,
        }
        # Structured single-line log; never include raw phone or message bodies.
        logger.info("%s", payload)

    # ------------------------------------------------------------------ wamid
    def _remember_wamid(self, wamid: str) -> bool:
        """Return True if wamid is new (should process)."""
        if not wamid:
            return True
        if wamid in self._seen_wamids:
            self._stats["deduplicated"] += 1
            return False
        self._seen_wamids[wamid] = True
        while len(self._seen_wamids) > DEFAULT_SEEN_WAMID_CAP:
            self._seen_wamids.pop(next(iter(self._seen_wamids)))
        return True

    # ------------------------------------------------------------------ buffers
    def _sender(self, key: str) -> SenderState:
        st = self._senders.get(key)
        if st is None:
            st = SenderState(key=key)
            self._senders[key] = st
        return st

    def _combined_char_count(self, buf: BurstBuffer) -> int:
        return sum(len(m.text or "") for m in buf.messages) + max(0, len(buf.messages) - 1)

    def _append_to_buffer(self, buf: BurstBuffer, src: SourceMessage) -> None:
        buf.messages.append(src)
        if src.wamid:
            buf.wamids.add(src.wamid)
        now = self._now()
        if not buf.first_mono:
            buf.first_mono = now
        buf.last_mono = now

    def _make_source(self, event: Any) -> SourceMessage:
        return SourceMessage(
            text=_event_text(event),
            wamid=_event_wamid(event),
            timestamp=getattr(event, "timestamp", None) or datetime.now(),
            message_type=_message_type_name(event),
            reply_to_message_id=getattr(event, "reply_to_message_id", None),
            reply_to_text=getattr(event, "reply_to_text", None),
            media_urls=list(getattr(event, "media_urls", None) or []),
            media_types=list(getattr(event, "media_types", None) or []),
            raw_message=getattr(event, "raw_message", None),
            event=event,
        )

    def combine_events(self, messages: List[SourceMessage]) -> Any:
        """Build one MessageEvent from ordered source messages (preserve text order)."""
        if not messages:
            raise ValueError("no messages to combine")
        if len(messages) == 1:
            only = messages[0].event
            if only is not None:
                meta = dict(getattr(only, "metadata", None) or {})
                meta["whatsapp_burst_source_wamids"] = [m.wamid for m in messages if m.wamid]
                meta["whatsapp_burst_source_count"] = 1
                try:
                    only.metadata = meta
                except Exception:
                    pass
                return only

        base = messages[0].event
        # Preserve exact chronological order; do not summarize or rewrite.
        combined_text = "\n".join(m.text for m in messages)
        all_media_urls: List[str] = []
        all_media_types: List[str] = []
        for m in messages:
            all_media_urls.extend(m.media_urls)
            all_media_types.extend(m.media_types)

        wamids = [m.wamid for m in messages if m.wamid]
        last = messages[-1]
        meta = dict(getattr(base, "metadata", None) or {})
        meta["whatsapp_burst_source_wamids"] = wamids
        meta["whatsapp_burst_source_count"] = len(messages)
        meta["whatsapp_burst_source_timestamps"] = [
            (m.timestamp.isoformat() if hasattr(m.timestamp, "isoformat") else str(m.timestamp))
            for m in messages
        ]
        meta["whatsapp_burst_source_types"] = [m.message_type for m in messages]

        # Mutate the earliest event in place when possible (same object graph).
        if base is not None:
            base.text = combined_text
            base.message_id = last.wamid or getattr(base, "message_id", None)
            if last.reply_to_message_id:
                base.reply_to_message_id = last.reply_to_message_id
            if last.reply_to_text:
                base.reply_to_text = last.reply_to_text
            if all_media_urls:
                base.media_urls = all_media_urls
                base.media_types = all_media_types
            base.metadata = meta
            base.raw_message = {
                "wolfhouse_burst": True,
                "messages": [m.raw_message for m in messages],
                "wamids": wamids,
            }
            return base

        # Fallback lightweight namespace for unit tests without real MessageEvent.
        from types import SimpleNamespace

        return SimpleNamespace(
            text=combined_text,
            message_type=messages[0].message_type,
            source=None,
            message_id=last.wamid,
            metadata=meta,
            media_urls=all_media_urls,
            media_types=all_media_types,
            raw_message={"wolfhouse_burst": True, "wamids": wamids},
            timestamp=last.timestamp,
            reply_to_message_id=last.reply_to_message_id,
            reply_to_text=last.reply_to_text,
            internal=False,
        )

    # ------------------------------------------------------------------ timer
    def _cancel_timer(self, buf: Optional[BurstBuffer]) -> None:
        if buf is None or buf.timer_handle is None:
            return
        handle = buf.timer_handle
        buf.timer_handle = None
        if self._cancel is not None:
            try:
                self._cancel(handle)
                return
            except Exception:
                pass
        # asyncio.Task or Handle
        cancel = getattr(handle, "cancel", None)
        if callable(cancel):
            try:
                cancel()
            except Exception:
                pass

    def _arm_timer(self, key: str, buf: BurstBuffer, *, which: str) -> None:
        self._cancel_timer(buf)
        buf.timer_gen += 1
        gen = buf.timer_gen
        delay = self.debounce_seconds

        async def _fire() -> None:
            if self._schedule is None:
                # Real asyncio path: sleep then flush.
                try:
                    await asyncio.sleep(delay)
                except asyncio.CancelledError:
                    return
            if buf.timer_gen != gen:
                return
            await self._flush(key, which=which, reason="quiet_window")

        if self._schedule is not None:
            # Test/fake clock: schedule_fn(delay_seconds, async_callback)
            buf.timer_handle = self._schedule(delay, _fire)
            return

        task = asyncio.create_task(_fire())
        buf.timer_handle = task
        self._loop_tasks.add(task)
        task.add_done_callback(self._loop_tasks.discard)

    def _resolve_adapter_dispatch(
        self,
        adapter: Any,
        adapter_dispatch: Optional[AdapterDispatch] = None,
    ) -> AdapterDispatch:
        if adapter_dispatch is not None:
            return adapter_dispatch
        if self._default_dispatch_fn is not None:
            # Unit-test default: close over adapter at call time.
            fn = self._default_dispatch_fn
            return AdapterDispatch(adapter=adapter, dispatch_fn=fn)
        raise RuntimeError("adapter_dispatch not configured")

    def _track_task(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)

        def _done(t: asyncio.Task) -> None:
            self._loop_tasks.discard(t)
            if t.cancelled():
                return
            exc = t.exception()
            if exc is not None:
                logger.exception(
                    "%s",
                    {"event": "whatsapp_burst_bg_task_failed", "error": repr(exc)},
                    exc_info=exc,
                )

        self._loop_tasks.add(task)
        task.add_done_callback(_done)
        return task

    def _inline_runs(self) -> bool:
        # Fake-clock unit tests await flush deterministically.
        return self._schedule is not None

    async def _maybe_await_or_spawn(self, coro) -> None:
        if self._inline_runs():
            await coro
        else:
            self._track_task(coro)

    # ------------------------------------------------------------------ public
    async def ingest(
        self,
        adapter: Any,
        event: Any,
        *,
        adapter_dispatch: Optional[AdapterDispatch] = None,
    ) -> Dict[str, Any]:

        """Buffer or immediately schedule one inbound MessageEvent.

        Never awaits a full agent run on the webhook ingest path when using
        real asyncio — agent work is tracked via background tasks.
        """
        ad = self._resolve_adapter_dispatch(adapter, adapter_dispatch)
        if self._debounce_ms <= 0:
            await self._maybe_await_or_spawn(self._dispatch_one(ad, event))
            return {"action": "passthrough"}

        key = self.key_for_adapter_event(adapter, event)
        st = self._sender(key)
        # Preserve the first adapter binding for this sender burst.
        if st.adapter_dispatch is None:
            st.adapter_dispatch = ad
        st.last_activity_mono = self._now()
        kind = classify_event(event)
        wamid = _event_wamid(event)

        if kind == "ignore":
            self._log("whatsapp_burst_ignored", key, reason="status_or_reaction")
            return {"action": "ignored"}

        if wamid and not self._remember_wamid(wamid):
            self._log(
                "whatsapp_burst_deduplicated",
                key,
                wamid_hash=hashlib.sha256(wamid.encode()).hexdigest()[:10],
            )
            return {"action": "deduplicated"}

        if kind == "structured":
            # Never flatten structured events into a text burst.
            if st.active_run:
                st.structured_queue.append(StructuredWork(event=event, adapter_dispatch=ad))
                self._stats["queued_during_active"] += 1
                return {"action": "queued_structured_during_active"}
            if st.buffer and st.buffer.messages:
                await self._flush(key, which="buffer", reason="structured_precedes")
            await self._maybe_await_or_spawn(self._dispatch_one(ad, event))
            return {"action": "structured_direct"}

        # Ordinary text / caption coalesce path
        if st.active_run:
            await self._buffer_message(st, event, target="pending")
            self._stats["queued_during_active"] += 1
            pending = st.pending
            self._log(
                "whatsapp_burst_queued_during_active_run",
                key,
                source_message_count=len(pending.messages) if pending else 0,
                source_wamid_count=len(pending.wamids) if pending else 0,
                active=True,
                pending=True,
            )
            return {"action": "queued_during_active"}

        return await self._buffer_message(st, event, target="buffer")

    async def _buffer_message(self, st: SenderState, event: Any, *, target: str) -> Dict[str, Any]:
        key = st.key
        buf = st.pending if target == "pending" else st.buffer
        if buf is None:
            buf = BurstBuffer()
            if target == "pending":
                st.pending = buf
            else:
                st.buffer = buf

        src = self._make_source(event)
        # Overflow: flush then start a new ordered burst (never silent drop).
        would_msgs = len(buf.messages) + 1
        would_chars = self._combined_char_count(buf) + len(src.text) + (1 if buf.messages else 0)
        if buf.messages and (would_msgs > self._max_messages or would_chars > self._max_chars):
            # Always await flush's buffer handoff; agent run itself may be spawned.
            await self._flush(key, which=target, reason="overflow")
            buf = BurstBuffer()
            if target == "pending":
                st.pending = buf
            else:
                st.buffer = buf

        resetting = bool(buf.messages)
        self._append_to_buffer(buf, src)
        self._stats["buffered"] += 1
        self._log(
            "whatsapp_burst_buffered",
            key,
            source_message_count=len(buf.messages),
            source_wamid_count=len(buf.wamids),
            combined_char_count=self._combined_char_count(buf),
            active=st.active_run,
            pending=(target == "pending"),
        )
        if target == "buffer" or (target == "pending" and not st.active_run):
            if resetting:
                self._stats["timer_resets"] += 1
                self._log(
                    "whatsapp_burst_timer_reset",
                    key,
                    source_message_count=len(buf.messages),
                    wait_ms=self._debounce_ms,
                )
            self._arm_timer(key, buf, which=target)
        elif target == "pending" and st.active_run:
            # Timer arms after active run completes.
            pass
        return {"action": "buffered", "count": len(buf.messages)}

    async def _flush(self, key: str, *, which: str, reason: str) -> None:
        st = self._sender(key)
        buf = st.pending if which == "pending" else st.buffer
        if buf is None or not buf.messages:
            return
        if which == "pending" and st.active_run:
            return
        if which == "buffer" and st.active_run:
            # Should not flush buffer while active; move to pending.
            if st.pending is None:
                st.pending = buf
            else:
                for m in buf.messages:
                    if m.wamid and m.wamid in st.pending.wamids:
                        continue
                    self._append_to_buffer(st.pending, m)
            st.buffer = None
            return

        self._cancel_timer(buf)
        messages = list(buf.messages)
        wait_ms = int(max(0.0, (buf.last_mono - buf.first_mono) * 1000)) if buf.first_mono else 0
        combined_chars = self._combined_char_count(buf)
        if which == "pending":
            st.pending = None
        else:
            st.buffer = None

        combined = self.combine_events(messages)
        self._stats["flushed"] += 1
        self._log(
            "whatsapp_burst_flushed",
            key,
            source_message_count=len(messages),
            source_wamid_count=len([m for m in messages if m.wamid]),
            combined_char_count=combined_chars,
            wait_ms=wait_ms,
            debounce_ms=self._debounce_ms,
            reason=reason,
            active=st.active_run,
            pending=bool(st.pending and st.pending.messages),
        )
        rec = {
            "key": mask_sender_key(key),
            "count": len(messages),
            "wamid_hashes": [
                hashlib.sha256(m.wamid.encode()).hexdigest()[:10]
                for m in messages
                if m.wamid
            ],
            "char_count": combined_chars,
            "reason": reason,
        }
        # Production diagnostics never retain raw guest text.
        if _diag_include_text():
            rec["text"] = "\n".join(m.text for m in messages)
        self._last_flush_records.append(rec)
        ad = st.adapter_dispatch
        if ad is None:
            raise RuntimeError("adapter_dispatch missing on sender state")
        await self._maybe_await_or_spawn(
            self._run_combined(st, combined, adapter_dispatch=ad, source_count=len(messages))
        )

    async def _run_combined(
        self,
        st: SenderState,
        event: Any,
        *,
        adapter_dispatch: AdapterDispatch,
        source_count: int,
    ) -> None:
        st.active_run = True
        self._stats["agent_invocations"] += 1
        failed = False
        try:
            await adapter_dispatch.dispatch_fn(event)
            self._stats["replies"] += 1
        except Exception:
            failed = True
            self._stats["failures"] += 1
            logger.exception(
                "%s",
                {
                    "event": "whatsapp_burst_run_failed",
                    "sender_key": mask_sender_key(st.key),
                    "source_message_count": source_count,
                },
            )
        finally:
            st.active_run = False
            st.active_task = None
            self._log(
                "whatsapp_burst_run_completed",
                st.key,
                source_message_count=source_count,
                failed=failed,
                pending=bool(st.pending and st.pending.messages),
                structured_queued=len(st.structured_queue),
                active=False,
            )
            await self._drain_followups(st)

    async def _dispatch_one(self, adapter_dispatch: AdapterDispatch, event: Any) -> None:
        adapter = adapter_dispatch.adapter
        st = self._sender(self.key_for_adapter_event(adapter, event))
        if st.adapter_dispatch is None:
            st.adapter_dispatch = adapter_dispatch
        st.active_run = True
        self._stats["agent_invocations"] += 1
        try:
            await adapter_dispatch.dispatch_fn(event)
            self._stats["replies"] += 1
        except Exception:
            self._stats["failures"] += 1
            logger.exception(
                "%s",
                {"event": "whatsapp_burst_run_failed", "sender_key": mask_sender_key(st.key)},
            )
        finally:
            st.active_run = False
            await self._drain_followups(st)

    async def _drain_followups(self, st: SenderState) -> None:
        """Preserve ordered TextBurst / StructuredEvent / TextBurst work."""
        # Drain structured queue first in arrival order relative to pending text:
        # process structured_queue entries interspersed by arming pending text
        # after structured items that arrived before the pending buffer filled.
        while st.structured_queue and not st.active_run:
            work = st.structured_queue.pop(0)
            await self._maybe_await_or_spawn(self._dispatch_one(work.adapter_dispatch, work.event))
            if st.active_run or self._inline_runs():
                # Inline mode awaits; loop continues after run completes.
                # Background mode: stop and let run's finally resume.
                if not self._inline_runs():
                    return
        if st.pending and st.pending.messages and not st.active_run:
            self._arm_timer(st.key, st.pending, which="pending")

    async def force_flush_all(self) -> None:
        for key, st in list(self._senders.items()):
            if st.buffer and st.buffer.messages and not st.active_run:
                await self._flush(key, which="buffer", reason="force")
            if st.pending and st.pending.messages and not st.active_run:
                await self._flush(key, which="pending", reason="force")

    def cleanup_stale(self) -> int:
        """Drop idle empty sender states; flush stale open buffers."""
        now = self._now()
        stale_sec = self._stale_buffer_ms / 1000.0
        removed = 0
        for key, st in list(self._senders.items()):
            idle = now - (st.last_activity_mono or 0)
            if st.active_run:
                continue
            if st.buffer and st.buffer.messages and idle >= stale_sec:
                # Deterministic: flush rather than drop guest text.
                try:
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        loop.create_task(self._flush(key, which="buffer", reason="stale"))
                    else:
                        loop.run_until_complete(self._flush(key, which="buffer", reason="stale"))
                except Exception:
                    logger.exception("stale flush failed for %s", mask_sender_key(key))
            if (
                not st.active_run
                and not (st.buffer and st.buffer.messages)
                and not (st.pending and st.pending.messages)
                and idle >= stale_sec
            ):
                self._senders.pop(key, None)
                removed += 1
        return removed

    def snapshot(self, *, include_text: bool = False) -> Dict[str, Any]:
        flushes = list(self._last_flush_records[-10:])
        if not (include_text or _diag_include_text()):
            flushes = [
                {k: v for k, v in rec.items() if k != "text"}
                for rec in flushes
            ]
        return {
            "stats": dict(self._stats),
            "senders": len(self._senders),
            "seen_wamids": len(self._seen_wamids),
            "last_flushes": flushes,
            "debounce_ms": self._debounce_ms,
        }


# ---------------------------------------------------------------------- runtime
_COALESCER: Optional[BurstCoalescer] = None


def get_coalescer() -> Optional[BurstCoalescer]:
    return _COALESCER


def reset_coalescer_for_tests() -> None:
    global _COALESCER
    _COALESCER = None


def _build_runtime_coalescer() -> BurstCoalescer:
    return BurstCoalescer(
        debounce_ms=debounce_ms(),
        max_messages=max_messages(),
        max_chars=max_chars(),
        stale_buffer_ms=stale_buffer_ms(),
    )


async def _coalesced_handle_message(adapter: Any, event: Any, orig: Callable) -> None:
    coalescer = _COALESCER
    if coalescer is None or not coalesce_enabled():
        await orig(adapter, event)
        return

    # Bind adapter immutably for this ingest — never overwrite a global dispatch.
    async def _dispatch(combined_event: Any) -> None:
        # Await the full session task so we hold the per-sender lock for the
        # entire agent run (prevents concurrent runs for one guest).
        await orig(adapter, combined_event)
        session_key = None
        try:
            from gateway.session import build_session_key

            session_key = build_session_key(
                combined_event.source,
                group_sessions_per_user=adapter.config.extra.get("group_sessions_per_user", True),
                thread_sessions_per_user=adapter.config.extra.get("thread_sessions_per_user", False),
            )
        except Exception:
            session_key = None
        task = None
        if session_key:
            task = getattr(adapter, "_session_tasks", {}).get(session_key)
        if task is not None:
            try:
                await task
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "%s",
                    {
                        "event": "whatsapp_burst_session_task_error",
                        "sender_key": mask_sender_key(
                            coalescer.key_for_adapter_event(adapter, combined_event)
                        ),
                    },
                )

    ad = AdapterDispatch(adapter=adapter, dispatch_fn=_dispatch)
    # Ingest returns after buffering / arming timers / spawning runs — does not
    # await the full agent run on the webhook path (real asyncio mode).
    await coalescer.ingest(adapter, event, adapter_dispatch=ad)


def install_whatsapp_burst_coalesce_patch() -> bool:
    """Monkeypatch WhatsAppCloudAdapter.handle_message when feature enabled."""
    global _COALESCER
    if not coalesce_enabled():
        return False
    try:
        import gateway.platforms.whatsapp_cloud as wh_mod
    except Exception:
        return False

    cls = wh_mod.WhatsAppCloudAdapter
    if getattr(cls, "_wolfhouse_burst_coalesce", False):
        return True

    _COALESCER = _build_runtime_coalescer()
    orig = cls.handle_message

    async def _patched_handle_message(self, event):
        return await _coalesced_handle_message(self, event, orig)

    cls.handle_message = _patched_handle_message
    cls._wolfhouse_burst_coalesce = True

    # When enabled, ack Meta immediately after verify+parse — do not hold the
    # HTTP request across agent work. Dispatch still runs on the event loop.
    orig_webhook = cls._handle_webhook

    async def _patched_handle_webhook(self, request):
        # Keep pause-gate / signature behavior from the existing chain; only
        # ensure we don't block on the debounce sleep inside this request.
        # The coalescer's ingest returns immediately after arming a timer.
        return await orig_webhook(self, request)

    # Note: orig_webhook already awaits _dispatch_payload which now only
    # buffers when coalesce is on — so HTTP ack is fast without further change.
    cls._handle_webhook = _patched_handle_webhook
    logger.info(
        "%s",
        {
            "event": "whatsapp_burst_coalesce_installed",
            "debounce_ms": debounce_ms(),
            "max_messages": max_messages(),
            "max_chars": max_chars(),
        },
    )
    return True
