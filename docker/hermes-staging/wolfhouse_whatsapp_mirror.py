"""Fire-and-forget mirror of Hermes WhatsApp turns into Staff Portal inbox.

Uses LUNA_CLIENT_SLUG / SUNSET_INGRESS_LOCATION_ID (never hard-code wolfhouse for Sunset).
Posts asynchronously on a bounded background queue so Meta webhooks and Luna replies
are never blocked by Staff API latency.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import queue
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^\s)]+)\)", re.IGNORECASE)

# Safety net only: the trustworthy handoff signal is Luna calling flag_needs_human.
# These sources are the same strings as HANDOFF_PROMISE_PATTERNS in
# scripts/lib/luna-guest-handoff-promise.js; scripts/verify-luna-handoff-promise-detection.js
# fails when the two copies drift or when a corpus phrasing stops matching.
# --- BEGIN LUNA_HANDOFF_PROMISE_PATTERNS ---
_HANDOFF_PROMISE_PATTERN_SOURCES = (
    ("escalate_looping_in", r"(?:loop|looping|looped)\s+in\s+(?:(?:a|an|our|the|my|one\s+of\s+our|one\s+of\s+the)\s+)?(?:[a-z]+\s+){0,2}(?:team|teammate|colleague|human|someone|manager)"),
    ("escalate_connect_you_with_team", r"connect\s+you\s+(?:with|to)\s+(?:(?:a|an|our|the|my|one\s+of\s+our|one\s+of\s+the)\s+)?(?:[a-z]+\s+){0,2}(?:team|teammate|colleague|staff|human|someone|manager)"),
    ("escalate_passing_to_team", r"pass(?:ing|ed|es)?\s+(?:this|it|that|you|your\s+message|your\s+details|your\s+question|your\s+request)?\s*(?:along\s+|on\s+)?to\s+(?:a|an|our|the|my|one\s+of\s+our|one\s+of\s+the)\s+(?:[a-z]+\s+){0,2}(?:team|teammate|colleague|staff|human|manager)"),
    ("escalate_passed_message_along", r"pass(?:ing|ed)\s+your\s+message\s+along"),
    ("escalate_flag_for_team", r"flag\s+(?:this|it|that|your\s+[a-z]+)\s+(?:for|to|with)\s+(?:our\s+|the\s+)?(?:team|staff)"),
    ("escalate_hand_over_to_team", r"hand(?:ing|ed)?\s+(?:this|it|that|you|your\s+[a-z]+)\s+(?:over\s+|off\s+)?to\s+(?:a|an|our|the|my|one\s+of\s+our|one\s+of\s+the)\s+(?:[a-z]+\s+){0,2}(?:team|teammate|colleague|staff|human|manager)"),
    ("escalate_check_with_team", r"(?:I['’]ll|I\s+will|I['’]m\s+going\s+to|let\s+me|going\s+to)\s+(?:just\s+)?(?:check|double[\s-]?check|confirm|run\s+this)\s+(?:this|that|it|these|those)?\s*with\s+(?:our|the)\s+team"),
    ("escalate_delegate_to_person", r"(?:I['’]ll|I\s+will|I['’]m\s+going\s+to|I['’]ve|I\s+have|let\s+me|going\s+to)\s+(?:just\s+)?(?:have|get|ask(?:ed|ing)?)\s+(?:someone|somebody|(?:a|an|our|the|my|one\s+of\s+our|one\s+of\s+the)\s+(?:[a-z]+\s+){0,2}(?:team|teammates?|colleagues?|managers?|owners?|staff)(?:\s+members?)?)(?:\s+from\s+(?:the\s+team|our\s+team|wolf[\s-]?house|the\s+house|sunset|reception|the\s+front\s+desk|the\s+office|the\s+surf\s+school))?\s+(?:to\s+)?(?:check|look|review|double[\s-]?check|sort|confirm|call|contact|handle|come\s+back|get\s+back|take\s+a\s+look|take\s+over|answer|reply)"),
    ("escalate_get_breakdown_from_team", r"(?:let\s+me|I['’]ll|I\s+will)\s+get\s+(?:you\s+)?[^.!?]{0,40}from\s+(?:our|the)\s+team"),
    ("escalate_get_team_to", r"get\s+(?:our|the|my)\s+(?:[a-z]+\s+){0,2}(?:team|colleague|manager)\s+to\s+(?:confirm|check|sort|look|help|answer)"),
    ("escalate_follow_up_with_team", r"(?:I['’]ll|I\s+will|I['’]m\s+going\s+to)\s+follow\s+up\s+with\s+(?:our|the)\s+team"),
    ("escalate_let_team_know", r"(?:I['’]ve|I\s+have|I['’]ll|I\s+will|let\s+me)\s+(?:just\s+)?let\s+(?:our|the)\s+team\s+know"),
    ("escalate_asked_the_team", r"(?:I['’]ve|I\s+have)\s+asked\s+(?:our|the)\s+team"),
    ("escalate_es_te_paso", r"te\s+pas(?:o|ar[eé])\s+con\s+(?:alguien|una\s+persona|el\s+equipo|un\s+compa[nñ]ero)"),
    ("escalate_es_paso_al_equipo", r"pas(?:o|ar|ar[eé])\s+(?:tu\s+mensaje|esto|tu\s+consulta|tu\s+caso)\s+al\s+equipo"),
    ("escalate_it_ti_passo", r"ti\s+pass(?:o|er[oò])\s+(?:al\s+team|allo\s+staff|a\s+un\s+collega|a\s+qualcuno)"),
    ("escalate_it_passo_al_team", r"pass(?:o|er[oò])\s+(?:il\s+tuo\s+messaggio|questo|la\s+tua\s+richiesta)\s+al\s+team"),
    ("human_subject_will_act", r"(?:(?:(?:a|an|our|the|my|one\s+of\s+our|one\s+of\s+the)\s+(?:[a-z]+\s+){0,2})?(?:team|teammates?|colleagues?|managers?|owners?|staff)(?:\s+members?)?|[a-z]+\s+from\s+(?:the\s+team|our\s+team|wolf[\s-]?house|the\s+house|sunset|reception|the\s+front\s+desk|the\s+office|the\s+surf\s+school)|(?:someone|somebody)\s+(?:on|in)\s+(?:the|our)\s+team|reception|the\s+front\s+desk)\s+(?:will|['’]ll|is\s+going\s+to|are\s+going\s+to)\s+(?:need\s+to\s+|have\s+to\s+)?(?:take\s+over|take\s+it\s+from\s+here|jump\s+in|get\s+back\s+to\s+you|come\s+back\s+to\s+you|be\s+in\s+touch|follow\s+up|reach\s+out|contact\s+you|call\s+you\s+back|message\s+you|write\s+to\s+you|review\s+(?:this|it|that|your)|check\s+(?:this|it|that|those|these)|double[\s-]?check|sort\s+(?:this|that|it|those|them|out)|answer\s+you|look\s+into\s+(?:this|it|that)|handle\s+(?:this|it|that)|help\s+(?:you\s+)?with\s+(?:this|that|it|the\s+next\s+step)|confirm\s+the\s+right\s+next\s+step|confirm\s+(?:your|the)\s+(?:booking|payment|balance|refund|cancellation)|send\s+(?:you\s+)?(?:your|the|it|them))"),
    ("human_pronoun_will_act", r"(?:they|someone|somebody|a\s+teammate|a\s+colleague|another\s+teammate)(?:['’]ll|\s+will)\s+(?:take\s+over|take\s+it\s+from\s+here|jump\s+in|get\s+back\s+to\s+you|come\s+back\s+to\s+you|be\s+in\s+touch|follow\s+up|reach\s+out|contact\s+you|sort\s+(?:this|that|it|those|them)\s+out)"),
    ("human_call_you_back", r"(?:will|['’]ll)\s+call\s+you\s+back"),
    ("human_es_will_act", r"(?:el\s+equipo|alguien\s+del\s+equipo|un\s+compa[nñ]ero|una\s+persona\s+del\s+equipo|mis\s+compa[nñ]eros)[^.!?]{0,40}(?:te\s+atender|te\s+atienden|te\s+contactar|te\s+escribir|se\s+pondr|te\s+responder|lo\s+revisar|se\s+encargar)"),
    ("human_it_will_act", r"(?:il\s+team|un\s+collega|qualcuno\s+del\s+team|lo\s+staff|i\s+colleghi)[^.!?]{0,40}(?:ti\s+rispond|ti\s+ricontatt|se\s+ne\s+occup|ti\s+scriver|ti\s+contatter)"),
)
# --- END LUNA_HANDOFF_PROMISE_PATTERNS ---

_HANDOFF_PROMISE_RES = tuple(
    (pattern_id, re.compile(source, re.IGNORECASE))
    for pattern_id, source in _HANDOFF_PROMISE_PATTERN_SOURCES
)
HANDOFF_PROMISE_REASON = "luna_team_review_reply"
_INTERNAL_STATUS_RE = re.compile(
    r"(^|\b)(self.?improvement|skill\s+['\"]?[-\w]+\s+(?:created|saved|updated)|auxiliary\s+|compression\s+|preflight|rate\s+limited)(\b|:)",
    re.IGNORECASE,
)

logger = logging.getLogger("wolfhouse.whatsapp_mirror")

DEFAULT_CLIENT_SLUG = ""  # never invent a tenant; runtime must set LUNA_CLIENT_SLUG
QUEUE_MAXSIZE = 500
MAX_ATTEMPTS = 5
BASE_BACKOFF_SEC = 0.4


def normalize_whatsapp_message_text(text: str) -> str:
    """WhatsApp does not render markdown links — convert to plain label + URL."""
    if not text:
        return text

    def _repl(match: re.Match) -> str:
        label = (match.group(1) or "").strip()
        url = (match.group(2) or "").strip()
        if not url:
            return match.group(0)
        if not label or label == url:
            return url
        return f"{label}: {url}"

    return _MD_LINK_RE.sub(_repl, str(text))


def detects_handoff_promise(text) -> Optional[str]:
    """Pattern id when outbound copy promises a human takeover, else None."""
    raw = str(text or "")
    if not raw.strip():
        return None
    for pattern_id, compiled in _HANDOFF_PROMISE_RES:
        if compiled.search(raw):
            return pattern_id
    return None


def resolve_mirror_client_slug() -> str:
    return (os.getenv("LUNA_CLIENT_SLUG") or "").strip()


def resolve_mirror_location_id(client_slug: Optional[str] = None) -> Optional[str]:
    slug = (client_slug or resolve_mirror_client_slug()).strip().lower()
    loc = (os.getenv("SUNSET_INGRESS_LOCATION_ID") or "").strip()
    if slug == "sunset":
        # Somo runtime must stay on sunset-somo — do not invent Sardinero.
        if loc == "sunset-sardinero":
            return None
        return loc or "sunset-somo"
    return loc or None


def _digits_phone(source) -> str:
    for attr in ("user_id", "chat_id"):
        raw = getattr(source, attr, None)
        if not raw:
            continue
        digits = "".join(ch for ch in str(raw) if ch.isdigit())
        if digits:
            return f"+{digits}"
    return ""


def _phone_hash(phone: str) -> str:
    digits = "".join(ch for ch in str(phone or "") if ch.isdigit())
    if not digits:
        return "none"
    return hashlib.sha256(digits.encode("utf-8")).hexdigest()[:10]


def _wamid_hash(wamid: Optional[str]) -> str:
    raw = str(wamid or "").strip()
    if not raw:
        return "none"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:10]


def is_coalesced_agent_inbound(event) -> bool:
    """True when this event is a burst flush for the agent (already mirrored raw)."""
    if event is None:
        return False
    raw = getattr(event, "raw_message", None)
    if isinstance(raw, dict) and raw.get("wolfhouse_burst") is True:
        return True
    meta = getattr(event, "metadata", None)
    if isinstance(meta, dict):
        wamids = meta.get("whatsapp_burst_source_wamids")
        if isinstance(wamids, (list, tuple)) and len(wamids) >= 1:
            return True
        if int(meta.get("whatsapp_burst_source_count") or 0) >= 1:
            return True
    return False


def _extract_phone_number_id(source, event) -> Optional[str]:
    for obj in (event, source):
        if obj is None:
            continue
        for attr in ("phone_number_id", "_phone_number_id"):
            val = getattr(obj, attr, None)
            if val:
                return str(val).strip()
        meta = getattr(obj, "metadata", None)
        if isinstance(meta, dict) and meta.get("phone_number_id"):
            return str(meta["phone_number_id"]).strip()
        raw = getattr(obj, "raw_message", None)
        if isinstance(raw, dict):
            # Meta webhook nesting varies; keep best-effort only.
            for key in ("phone_number_id",):
                if raw.get(key):
                    return str(raw[key]).strip()
    return None


def _extract_receiving_number(source, event) -> Optional[str]:
    for obj in (event, source):
        if obj is None:
            continue
        for attr in ("receiving_whatsapp_number", "display_phone_number", "whatsapp_number"):
            val = getattr(obj, attr, None)
            if val:
                return str(val).strip()
        meta = getattr(obj, "metadata", None)
        if isinstance(meta, dict):
            for key in ("receiving_whatsapp_number", "display_phone_number", "whatsapp_number"):
                if meta.get(key):
                    return str(meta[key]).strip()
    return None


def _extract_message_type(event) -> Optional[str]:
    if event is None:
        return None
    for attr in ("message_type", "type"):
        val = getattr(event, attr, None)
        if val is None:
            continue
        if hasattr(val, "value"):
            val = getattr(val, "value", val)
        text = str(val).strip()
        if text:
            return text
    return None


def _extract_timestamp(event) -> Optional[str]:
    if event is None:
        return None
    ts = getattr(event, "timestamp", None)
    if ts is None:
        return None
    if hasattr(ts, "isoformat"):
        try:
            return ts.isoformat()
        except Exception:
            pass
    text = str(ts).strip()
    return text or None


def build_mirror_payload(
    source,
    event,
    direction: str,
    text: str,
    wa_id=None,
    contact_name=None,
) -> Optional[Dict[str, Any]]:
    phone = _digits_phone(source)
    msg = (text or "").strip()
    if direction == "outbound":
        msg = normalize_whatsapp_message_text(msg).strip()
        if _INTERNAL_STATUS_RE.search(msg):
            return None
    if not phone or not msg:
        return None

    client_slug = resolve_mirror_client_slug()
    if not client_slug:
        logger.warning(
            "%s",
            {"event": "whatsapp_thread_mirror_skipped", "reason": "missing_luna_client_slug"},
        )
        return None
    payload: Dict[str, Any] = {
        "client_slug": client_slug,
        "guest_phone": phone,
        "direction": direction,
        "message_text": msg[:4000],
    }
    location_id = resolve_mirror_location_id(client_slug)
    if location_id:
        payload["location_id"] = location_id

    if direction == "outbound" and wa_id and detects_handoff_promise(msg):
        payload["needs_human"] = True
        payload["handoff_reason"] = HANDOFF_PROMISE_REASON
    if wa_id:
        payload["whatsapp_message_id"] = str(wa_id)
    if contact_name:
        payload["contact_name"] = str(contact_name)
    phone_number_id = _extract_phone_number_id(source, event)
    if phone_number_id:
        payload["phone_number_id"] = phone_number_id
    receiving = _extract_receiving_number(source, event)
    if receiving:
        payload["receiving_whatsapp_number"] = receiving
    message_type = _extract_message_type(event)
    if message_type:
        payload["message_type"] = message_type
    timestamp = _extract_timestamp(event)
    if timestamp:
        payload["message_timestamp"] = timestamp
    if direction == "outbound" and not wa_id:
        payload["idempotency_key"] = hashlib.sha256(f"{phone}:{msg}".encode("utf-8")).hexdigest()[:32]
    return payload


def _post_mirror_sync(payload: dict) -> None:
    base = (os.getenv("WOLFHOUSE_STAFF_API_BASE_URL") or "https://staff-staging.lunafrontdesk.com").rstrip("/")
    token = os.getenv("LUNA_BOT_INTERNAL_TOKEN") or ""
    if not token:
        logger.warning(
            "%s",
            {
                "event": "whatsapp_thread_mirror_skipped",
                "reason": "missing_bot_token",
                "client_slug": payload.get("client_slug"),
                "direction": payload.get("direction"),
                "wamid_hash": _wamid_hash(payload.get("whatsapp_message_id")),
            },
        )
        return
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/staff/bot/whatsapp-thread-mirror",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Luna-Bot-Token": token,
        },
    )
    with urllib.request.urlopen(req, timeout=8) as res:
        res.read()


class MirrorQueue:
    """Bounded background queue with per-conversation ordering and retries."""

    def __init__(self, maxsize: int = QUEUE_MAXSIZE) -> None:
        self._q: queue.Queue = queue.Queue(maxsize=maxsize)
        self._lock = threading.Lock()
        self._conversation_locks: Dict[str, threading.Lock] = {}
        self._stop = threading.Event()
        self._worker = threading.Thread(target=self._run, name="whatsapp-mirror-queue", daemon=True)
        self._worker.start()
        self.stats = {
            "enqueued": 0,
            "posted": 0,
            "failed": 0,
            "overflow": 0,
            "retries": 0,
        }

    def _conv_lock(self, phone: str) -> threading.Lock:
        key = _phone_hash(phone)
        with self._lock:
            lock = self._conversation_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._conversation_locks[key] = lock
            return lock

    def enqueue(self, payload: dict) -> bool:
        item = {"payload": payload, "attempts": 0}
        try:
            self._q.put_nowait(item)
            self.stats["enqueued"] += 1
            return True
        except queue.Full:
            self.stats["overflow"] += 1
            logger.error(
                "%s",
                {
                    "event": "whatsapp_thread_mirror_queue_overflow",
                    "client_slug": payload.get("client_slug"),
                    "direction": payload.get("direction"),
                    "wamid_hash": _wamid_hash(payload.get("whatsapp_message_id")),
                    "phone_hash": _phone_hash(payload.get("guest_phone")),
                    "queue_max": QUEUE_MAXSIZE,
                },
            )
            return False

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                item = self._q.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                self._deliver(item)
            except Exception:
                logger.exception(
                    "%s",
                    {
                        "event": "whatsapp_thread_mirror_worker_error",
                        "wamid_hash": _wamid_hash((item.get("payload") or {}).get("whatsapp_message_id")),
                    },
                )
            finally:
                self._q.task_done()

    def _deliver(self, item: dict) -> None:
        payload = item.get("payload") or {}
        phone = str(payload.get("guest_phone") or "")
        lock = self._conv_lock(phone)
        with lock:
            attempts = int(item.get("attempts") or 0)
            while True:
                attempts += 1
                item["attempts"] = attempts
                try:
                    _post_mirror_sync(payload)
                    self.stats["posted"] += 1
                    logger.info(
                        "%s",
                        {
                            "event": "whatsapp_thread_mirror_posted",
                            "client_slug": payload.get("client_slug"),
                            "direction": payload.get("direction"),
                            "wamid_hash": _wamid_hash(payload.get("whatsapp_message_id")),
                            "phone_hash": _phone_hash(phone),
                            "attempts": attempts,
                        },
                    )
                    return
                except Exception as exc:
                    transient = isinstance(exc, (urllib.error.URLError, TimeoutError, OSError))
                    if isinstance(exc, urllib.error.HTTPError):
                        transient = exc.code >= 500 or exc.code == 429
                    if (not transient) or attempts >= MAX_ATTEMPTS:
                        self.stats["failed"] += 1
                        logger.error(
                            "%s",
                            {
                                "event": "whatsapp_thread_mirror_failed",
                                "client_slug": payload.get("client_slug"),
                                "direction": payload.get("direction"),
                                "wamid_hash": _wamid_hash(payload.get("whatsapp_message_id")),
                                "phone_hash": _phone_hash(phone),
                                "attempts": attempts,
                                "error_type": type(exc).__name__,
                                "transient": transient,
                            },
                        )
                        return
                    self.stats["retries"] += 1
                    backoff = BASE_BACKOFF_SEC * (2 ** (attempts - 1))
                    logger.warning(
                        "%s",
                        {
                            "event": "whatsapp_thread_mirror_retry",
                            "client_slug": payload.get("client_slug"),
                            "direction": payload.get("direction"),
                            "wamid_hash": _wamid_hash(payload.get("whatsapp_message_id")),
                            "phone_hash": _phone_hash(phone),
                            "attempts": attempts,
                            "backoff_sec": round(backoff, 3),
                            "error_type": type(exc).__name__,
                        },
                    )
                    time.sleep(min(backoff, 8.0))


_MIRROR_QUEUE: Optional[MirrorQueue] = None
_MIRROR_QUEUE_LOCK = threading.Lock()


def get_mirror_queue() -> MirrorQueue:
    global _MIRROR_QUEUE
    with _MIRROR_QUEUE_LOCK:
        if _MIRROR_QUEUE is None:
            _MIRROR_QUEUE = MirrorQueue()
        return _MIRROR_QUEUE


def enqueue_mirror_payload(payload: dict) -> bool:
    if not payload:
        return False
    return get_mirror_queue().enqueue(payload)


def mirror_whatsapp_outbound_after_send(
    chat_id: Any,
    content: Any,
    message_id: Any,
    metadata: Optional[Dict[str, Any]] = None,
) -> None:
    """Mirror a Luna guest reply only after Meta accepted the send (wamid present).

    Pre-send mirroring created Inbox bubbles that looked delivered while kill switches,
    pause, or needs_human blocked the Graph send. Call this from the WhatsApp send patch
    after a real message_id is returned — never from the turn handler.
    """
    try:
        mid = str(message_id or "").strip()
        if not mid:
            return
        phone = _normalize_phone(chat_id)
        msg = normalize_whatsapp_message_text(str(content or "")).strip()
        if not phone or not msg:
            return
        meta = metadata if isinstance(metadata, dict) else {}
        source = type("_WhMirrorSource", (), {"user_id": phone, "chat_id": phone})()
        event = type(
            "_WhMirrorEvent",
            (),
            {
                "metadata": meta,
                "message_id": mid,
                "timestamp": None,
                "message_type": "text",
            },
        )()
        if meta.get("phone_number_id"):
            setattr(event, "phone_number_id", meta.get("phone_number_id"))
        payload = build_mirror_payload(source, event, "outbound", msg, mid, None)
        if not payload:
            return
        enqueue_mirror_payload(payload)
    except Exception:
        logger.exception(
            "%s",
            {
                "event": "whatsapp_thread_mirror_post_send_enqueue_error",
                "wamid_hash": _wamid_hash(message_id),
            },
        )


def _normalize_phone(raw: Any) -> str:
    digits = "".join(ch for ch in str(raw or "") if ch.isdigit())
    if not digits:
        return ""
    return f"+{digits}"


def mirror_whatsapp_thread(source, event, direction, text, wa_id=None, contact_name=None) -> None:
    """Enqueue a staff-inbox mirror. Never raises into the WhatsApp/Luna path."""
    try:
        if direction == "inbound" and is_coalesced_agent_inbound(event):
            logger.info(
                "%s",
                {
                    "event": "whatsapp_thread_mirror_skip_coalesced_inbound",
                    "wamid_hash": _wamid_hash(wa_id or getattr(event, "message_id", None)),
                    "source_count": (getattr(event, "metadata", None) or {}).get(
                        "whatsapp_burst_source_count"
                    ),
                },
            )
            return
        payload = build_mirror_payload(source, event, direction, text, wa_id, contact_name)
        if not payload:
            return
        enqueue_mirror_payload(payload)
    except Exception:
        logger.exception(
            "%s",
            {
                "event": "whatsapp_thread_mirror_enqueue_error",
                "direction": direction,
                "wamid_hash": _wamid_hash(wa_id),
            },
        )


def mirror_raw_inbound(source, event, text=None, wa_id=None, contact_name=None) -> None:
    """Mirror one original inbound WhatsApp message (used by burst coalescer)."""
    try:
        msg = text if text is not None else (getattr(event, "text", None) or "")
        mid = wa_id if wa_id is not None else getattr(event, "message_id", None)
        name = contact_name if contact_name is not None else getattr(source, "user_name", None)
        payload = build_mirror_payload(source, event, "inbound", msg, mid, name)
        if not payload:
            return
        enqueue_mirror_payload(payload)
    except Exception:
        logger.exception(
            "%s",
            {
                "event": "whatsapp_thread_mirror_raw_inbound_error",
                "wamid_hash": _wamid_hash(wa_id or getattr(event, "message_id", None)),
            },
        )
