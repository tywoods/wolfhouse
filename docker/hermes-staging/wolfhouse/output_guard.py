"""Luna output-guard — last-line defense on the guest-facing reply text.

Step 3 of the robustness plan. Luna is a non-deterministic agent; even with SOUL
rules she occasionally (1) leaks backend/tool mechanics to a guest ("il sistema
non mi ha restituito…"), (2) states a price that no tool actually returned
(fabricated quote), or (3) replies in the wrong language. These are pure,
side-effect-free detectors so they can be unit-tested without the container and
reused by BOTH egress paths:

  * real WhatsApp send  (apply_gateway_patches.py :: _patched_whatsapp_cloud_send)
  * simulate-guest-turn (simulate_core.py return dict)  ← also what the golden
    suite asserts on.

ENFORCEMENT (this increment):
  * LEAK  -> hard: replace the whole reply with a warm, localized fallback so the
    guest never sees internals, and surface a finding for staff.
  * PRICE / LANGUAGE -> advisory findings (returned, logged, asserted by the
    golden suite). Hard-enforcing these on the real path needs the guest-language
    + tool-result context threaded down to the send layer (turn-handler hook) —
    tracked as the next increment.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple

def format_reply_text(text, language=None):
    """Guest prose typography/terminology; preserve URLs, code and escapes."""
    italian = str(language or '').lower().startswith('it')
    if not isinstance(text, str) or ('**' not in text and not italian):
        return text
    literal = re.compile(
        r'(`+)[\s\S]*?(?:\1(?!`)|$)|(~{3,})[\s\S]*?(?:\2(?!~)|$)'
        r'|(?:[a-z][a-z0-9+.-]*://|www\.)[^\s<>]+|\\[^\r\n]', re.IGNORECASE)
    def prose(value):
        if italian:
            value = re.sub(r'\bswell\b', lambda m: 'Onda lunga' if m[0][0].isupper() else 'onda lunga',
                           value, flags=re.IGNORECASE)
        return re.sub(r'(?<![\w*\\])\*\*(?=\S)([^*\n]*?\S)\*\*(?![\w*])',
                      lambda match: '*' + match.group(1) + '*', value)
    parts = []
    cursor = 0
    for match in literal.finditer(text):
        parts.extend((prose(text[cursor:match.start()]), match.group(0)))
        cursor = match.end()
    parts.append(prose(text[cursor:]))
    return ''.join(parts)


# --- leak phrases -------------------------------------------------------------
# Guest-facing references to Luna's own tooling / backend / the "system". A
# hospitality booking assistant should never say any of these to a guest. Kept in
# sync with LEAK_PHRASES in scripts/luna-golden-conversations.js (the test mirror)
# and expanded with phrases caught in live forensics (BUG E, off-season handoff).
LEAK_PATTERNS: Tuple[re.Pattern, ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"il\s+sistema",                      # "il sistema richiede/non mi ha…"
        r"\bthe\s+system\b",
        r"\bel\s+sistema\b",
        r"\bdas\s+system\b",
        r"preventivo\s+che\s+mi\s+(?:arriva|ritorna)",   # "the quote that comes to me"
        r"non\s+mi\s+ha\s+restituito",        # "(the system) didn't return to me…"
        r"\bquote\s+tool\b",
        r"\bthe\s+tool\b",
        r"\btool\s+call\b",
        r"\bbacken[dt]\b",
        r"\bplugin\b",
        r"\bstaff[-_\s]?query\b",
        r"verifica\s+manuale",                # "manual verification" (off-season leak)
        r"\bauthoritative\s+total\b",           # internal quote/booking field label
        r"\bAPI\b",
        r"\bendpoint\b",
    )
)

# --- localized safe fallbacks -------------------------------------------------
# Warm, guest-safe replacement when a leak is caught. No internals and no
# unsupported claim that staff were notified or will follow up.
SAFE_FALLBACK: Dict[str, str] = {
    "en": "I couldn't verify that just now. Give me a moment and please ask me again.",
    "it": "Non sono riuscita a verificarlo in questo momento. Dammi un attimo e riprova, per favore.",
    "de": "Ich konnte das gerade nicht verlässlich prüfen. Gib mir einen Moment und frag bitte noch einmal.",
    "es": "No he podido confirmarlo ahora mismo. Dame un momento y vuelve a preguntarme, por favor.",
}

# Ask — never deny — when tool truth already shows a booking (Hernan contradiction).
BOOKING_ASK_FALLBACK: Dict[str, str] = {
    "en": "I want to double-check what's already booked for this number — one moment.",
    "it": "Controllo cosa risulta già prenotato su questo numero — un attimo.",
    "es": "Déjame comprobar qué reservas hay ya a tu nombre — un momento.",
    "de": "Ich prüfe kurz, was auf dieser Nummer schon gebucht ist — einen Moment.",
}

# --- provider / API error scrub (graceful degradation) ------------------------
# When every model provider fails (outage, quota, expired token), the gateway can
# surface a raw API error as the "reply" — a guest must NEVER see that. Detect the
# raw-error shape and replace it with a warm "tiny hiccup" message. These patterns
# are specific to API/provider error payloads; a real Luna reply never contains them.
PROVIDER_ERROR_PATTERNS: Tuple[re.Pattern, ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"error\s+code:\s*\d{3}",             # "Error code: 400"
        r"invalid_request_error",
        r"rate_limit_error|rate.limited|usage limit has been reached|quota\s+exhausted",
        r"'?type'?\s*:\s*'?error'?",          # {'type': 'error'
        r"request_id'?\s*:\s*'?req_",         # 'request_id': 'req_...'
        r"\b(bad_?request|authentication|permission|not_found|overloaded)_error\b",
        r"claude\.ai/settings/usage|chatgpt\.com/backend-api",
        r"\bhttp\s*[45]\d{2}\b",              # "HTTP 400" / "HTTP 503"
        r"\b(BadRequestError|RateLimitError|APIError|AuthenticationError)\b",
    )
)

# Warm, language-localized "I'll be right back" for a provider outage. Distinct
# from SAFE_FALLBACK: here Luna literally can't think, so it's "give me a moment",
# not "I'll check with my team".
OUTAGE_FALLBACK: Dict[str, str] = {
    "en": "Oops, I'm having a tiny tech hiccup on my end 🌊 give me a moment and I'll be right back with you! 😊",
    "it": "Ops, sto avendo un piccolo problema tecnico 🌊 dammi un attimo e torno subito da te! 😊",
    "de": "Ups, bei mir hakt's gerade kurz technisch 🌊 gib mir einen Moment, ich bin gleich wieder da! 😊",
    "es": "¡Vaya! Tengo un pequeño problema técnico 🌊 dame un momento y enseguida vuelvo contigo 😊",
}


def is_provider_error(text: str) -> bool:
    s = str(text or "")
    return any(p.search(s) for p in PROVIDER_ERROR_PATTERNS)


def outage_fallback_for(text: str, guest_lang: Optional[str] = None) -> str:
    lang = (guest_lang or guess_language(text))[:2]
    return OUTAGE_FALLBACK.get(lang, OUTAGE_FALLBACK["en"])

# Cheap language signal from the text itself (mirrors simulate_core._detect_language)
# so the real send path — which has only the content string — can still localize.
# English is detected POSITIVELY (common function words) so a non-English guest
# receiving an English reply is caught, not silently passed.
_LANG_HINTS = {
    "it": ("ciao", "grazie", "prego", "prenotazione", "stanza", "notti",
           "preventivo", "lezione", "dispiace", "periodo", "tua", "sono", "siamo", "puoi"),
    "fr": ("bonjour", "merci", "réserver", "réservation", "chambre", "nuits",
           "personnes", "séjour", "voudrais", "pouvez", "prix", "paiement"),
    "es": ("hola", "gracias", "habitación", "reserva", "noches", "tu", "estás",
           "quiero", "entiendo", "español", "háblame", "puedes", "marea", "mareas"),
    "de": ("hallo", "danke", "zimmer", "buchung", "nächte", "system", "deine", "ist"),
    "en": ("the", "you", "your", "and", "for", "hello", "please", "thanks",
           "booking", "room", "ready", "would", "we've", "we're"),
}


def _language_scores(text: str) -> Dict[str, int]:
    low = str(text or "").lower()
    return {
        lang: sum(1 for word in words
                  if re.search(rf"(?<!\w){re.escape(word)}(?!\w)", low))
        for lang, words in _LANG_HINTS.items()
    }


def detect_languages(text: str) -> set:
    """All languages with a positive keyword signal in the text (may be empty)."""
    return {lang for lang, score in _language_scores(text).items() if score > 0}


def guess_language(text: str, hint: Optional[str] = None) -> str:
    """Single best-guess language for localization; defaults to 'en'."""
    if hint:
        return hint.lower()[:2]
    scores = _language_scores(text)
    top = max(scores.values(), default=0)
    winners = [lang for lang, score in scores.items() if score == top and score > 0]
    return winners[0] if len(winners) == 1 else "en"


def safe_fallback_for(text: str, guest_lang: Optional[str] = None) -> str:
    lang = (guest_lang or guess_language(text))[:2]
    return SAFE_FALLBACK.get(lang, SAFE_FALLBACK["en"])


# --- detectors (pure) ---------------------------------------------------------

def find_leaks(text: str) -> List[str]:
    """Return the leak phrases present in the reply (empty == clean)."""
    s = str(text or "")
    hits: List[str] = []
    for pat in LEAK_PATTERNS:
        m = pat.search(s)
        if m:
            hits.append(m.group(0).strip())
    return hits


_PRICE_RE = re.compile(r"(?:€|eur\b|euro\b)\s*([0-9][0-9.,]*)|([0-9][0-9.,]*)\s*(?:€|eur\b|euro\b)", re.IGNORECASE)

_NOTHING_BOOKED_RE = re.compile(
    r"nothing is booked|nothing'?s booked|no booking yet|"
    r"nada est[aá] reservad|no hay reserva|no tienes reserva|"
    r"todav[ií]a no (?:hay|tiene) reserva",
    re.IGNORECASE,
)


def _tool_result_blob(tc: Dict[str, Any]) -> str:
    import json

    parts = [str(tc.get("name") or tc.get("tool") or "")]
    for key in ("result_summary", "result", "output", "args"):
        val = tc.get(key)
        if val is None:
            continue
        if isinstance(val, str):
            parts.append(val)
            continue
        try:
            parts.append(json.dumps(val, default=str, ensure_ascii=False))
        except Exception:
            parts.append(str(val))
    return " ".join(parts)


def _tool_result_dict(tc: Dict[str, Any]) -> Dict[str, Any]:
    import json

    for key in ("result", "output", "result_summary"):
        value = (tc or {}).get(key)
        if isinstance(value, dict):
            return value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
            except (TypeError, ValueError):
                continue
            if isinstance(parsed, dict):
                return parsed
    return {}


def apply_availability_truth(
    text: str,
    tool_calls: Optional[List[Dict[str, Any]]] = None,
    guest_lang: Optional[str] = None,
) -> Tuple[str, Optional[Dict[str, Any]]]:
    """Prefer Staff's authoritative closed-season copy without parsing model prose."""
    for tc in tool_calls or []:
        name = str((tc or {}).get("name") or (tc or {}).get("tool") or "")
        if name not in {"check_availability", "quote_booking"}:
            continue
        result = _tool_result_dict(tc if isinstance(tc, dict) else {})
        if result.get("closed_season") is True or result.get("availability_status") == "closed_season":
            staff_copy = str(result.get("guest_safe_next_action") or result.get("reply_draft") or "").strip()
            if staff_copy:
                return staff_copy, {"kind": "closed_season_staff_copy", "severity": "block"}
    return text, None


def _parse_tool_success(blob: str) -> bool:
    low = blob.lower()
    if '"success": false' in low or "'success': false" in low or "success=false" in low:
        return False
    return '"success": true' in low or "'success': true" in low or "success=true" in low or "success=true" in low.replace(" ", "")


def find_booking_denial_contradiction(
    text: str,
    tool_calls: Optional[List[Dict[str, Any]]] = None,
) -> Optional[str]:
    """Block 'nothing is booked' when create/list truth already shows bookings.

    take_request copy is allowed when there is no successful create and no
    list rows. Unclear list (success false) also blocks a denial — ask instead.
    """
    if not _NOTHING_BOOKED_RE.search(str(text or "")):
        return None
    has_create = False
    has_list_rows = False
    list_unclear = False
    for tc in tool_calls or []:
        name = str((tc or {}).get("name") or (tc or {}).get("tool") or "")
        blob = _tool_result_blob(tc if isinstance(tc, dict) else {})
        low = blob.lower()
        if name == "create_sunset_booking" and _parse_tool_success(blob):
            has_create = True
        if name == "list_sunset_bookings":
            if _parse_tool_success(blob):
                if re.search(r'"count"\s*:\s*[1-9]', blob) or re.search(
                    r"count=([1-9]\d*)", low
                ):
                    has_list_rows = True
                if re.search(r'"booking_code"\s*:', blob):
                    has_list_rows = True
            else:
                if "success" in low:
                    list_unclear = True
                elif "error" in low or "failed" in low:
                    list_unclear = True
    if has_create:
        return "deny_after_create"
    if has_list_rows:
        return "deny_after_list_rows"
    if list_unclear:
        return "deny_while_list_unclear"
    return None


def booking_ask_fallback_for(text: str, guest_lang: Optional[str] = None) -> str:
    lang = (guest_lang or guess_language(text))[:2]
    return BOOKING_ASK_FALLBACK.get(lang, BOOKING_ASK_FALLBACK["en"])


_RETRY_CLAIM_RE = re.compile(
    r"\b(?:i\s+(?:tried|checked|ran)[^.?!]{0,80}\b(?:again|twice)|"
    r"i\s+retried\b|i\s+made\s+another\s+attempt\b|"
    r"(?:lo\s+he\s+intentado|(?:lo\s+)?intent[eé])[^.?!]{0,80}\bde\s+nuevo|"
    r"volv[ií]\s+a\s+intentarlo|ho\s+riprovato)\b",
    re.IGNORECASE,
)


_RETRY_TOOL_HINTS = (
    (re.compile(r"\b(?:quot(?:e|ed|ing)|cotizaci[oó]n|presupuesto)\b", re.IGNORECASE), {"quote_booking", "preview_package_prices"}),
    (re.compile(r"\bavailab(?:ility|le)\b", re.IGNORECASE), {"check_availability", "get_availability"}),
    (re.compile(r"\bpay(?:ment|link)?\b", re.IGNORECASE), {"create_payment_link", "create_test_payment_link"}),
    (re.compile(r"\bbook(?:ing|ed)?\b", re.IGNORECASE), {"create_booking_from_plan", "create_sunset_booking"}),
)


def find_unsupported_retry_claim(
    text: str,
    tool_calls: Optional[List[Dict[str, Any]]] = None,
) -> Optional[str]:
    """Require two recorded attempts for the operation the reply claims retried."""
    claim = str(text or "")
    if not _RETRY_CLAIM_RE.search(claim):
        return None
    calls_by_name: Dict[str, List[str]] = {}
    for call in tool_calls or []:
        if not isinstance(call, dict):
            continue
        name = str(call.get("name") or call.get("tool") or "").strip()
        if name:
            calls_by_name.setdefault(name, []).append(_tool_result_blob(call))
    hinted = next((names for pattern, names in _RETRY_TOOL_HINTS if pattern.search(claim)), None)
    candidates = hinted or set()
    repeated = [(name, calls_by_name.get(name, [])) for name in candidates
                if len(calls_by_name.get(name, [])) >= 2]
    if not repeated:
        return "no_matching_repeated_tool_attempt"
    if re.search(r"\b(?:still\s+(?:did(?:n['’]?t)?\s+work|failed)|again\s+failed|"
                 r"(?:but\s+)?it\s+failed|sigue\s+fallando|volvi[oó]\s+a\s+fallar)\b", claim, re.IGNORECASE):
        for _, results in repeated:
            last = results[-1].lower().replace(" ", "")
            if '"success":true' in last or "'success':true" in last or "success=true" in last:
                return "claimed_retry_failure_after_success"
    return None


_HANDOFF_CLAIM_RE = re.compile(
    r"\b(?:flagged|notified|told|asked|contacted|escalated|sent|forwarded|referred|"
    r"avis(?:ado|é)|notifiqu[eé]|escal[eé]|envi[eé]|remit[ií]|"
    r"handed\s+(?:this\s+)?over|passed\s+(?:this\s+)?to|loop(?:ing|ed)?\s+in)\b"
    r"[^.?!]{0,100}\b(?:staff|team|equipo|personal)\b|"
    r"\b(?:staff|team|equipo|personal)\b[^.?!]{0,100}\b"
    r"(?:will\s+(?:get\s+back|contact|follow\s+up|review|check|double-check|sort)|"
    r"(?:is|are)\s+(?:reviewing|checking|looking\s+into))\b",
    re.IGNORECASE,
)


_FUTURE_STAFF_PROMISE_RE = re.compile(
    r"\b(?:staff|team|equipo|personal|they|someone)\b[^.?!]{0,50}\b"
    r"(?:will|(?:is|are)\s+going\s+to)\s+"
    r"(?:get\s+back|contact|follow\s+up|review|check|double-check|sort|look\s+into)\b|"
    r"\b(?:they['’]ll\s+(?:get\s+back|contact|follow\s+up|review|check|double-check|sort|look\s+into))\b|"
    r"\b(?:equipo|personal|alguien)\b[^.?!]{0,50}\b"
    r"(?:te\s+contactar[aá]|se\s+pondr[aá]\s+en\s+contacto|revisar[aá]|comprobar[aá]|te\s+responder[aá])\b|"
    r"\b(?:you(?:['’]ll|\s+will)\s+(?:hear\s+back|be\s+contacted))\b",
    re.IGNORECASE,
)


def _typed_tool_result(call: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    # Only the actual tool result is authoritative. ``result_summary`` is
    # display/audit text and must never mint a persisted-handoff receipt.
    value = call.get("result")
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def find_unsupported_handoff_claim(
    text: str,
    tool_calls: Optional[List[Dict[str, Any]]] = None,
) -> Optional[str]:
    """Require a receipt for a handoff; never infer a future staff action."""
    claim = str(text or "")
    if _FUTURE_STAFF_PROMISE_RE.search(claim):
        return "unsupported_future_staff_action"
    if not _HANDOFF_CLAIM_RE.search(claim):
        return None
    for call in tool_calls or []:
        if not isinstance(call, dict):
            continue
        name = str(call.get("name") or call.get("tool") or "")
        if name not in {"flag_needs_human", "request_human_help"}:
            continue
        result = _typed_tool_result(call)
        if (result is not None
                and result.get("success") is True
                and result.get("needs_human") is True
                and result.get("handoff_persisted") is True
                and isinstance(result.get("staff_review_id"), str)
                and bool(result["staff_review_id"].strip())):
            return None
    return "handoff_not_persisted"


_CANCELLATION_CLAIM_RE = re.compile(
    r"\b(?:cancelled|canceled|anulada|anulado|cancelada|cancelado|annullata|annullato|storniert)\b",
    re.IGNORECASE,
)


_NEGATED_CANCELLATION_RE = re.compile(
    r"\b(?:not|isn['’]?t|wasn['’]?t|no)\b.{0,28}\b(?:cancelled|canceled|anulada|anulado|cancelada|cancelado|annullata|annullato|storniert)\b",
    re.IGNORECASE,
)


def _cancellation_receipt(tool_calls: Optional[List[Dict[str, Any]]]) -> Optional[Dict[str, Any]]:
    receipts = []
    for call in tool_calls or []:
        if not isinstance(call, dict):
            continue
        if str(call.get("name") or call.get("tool") or "") != "cancel_unpaid_booking":
            continue
        result = _typed_tool_result(call)
        if isinstance(result, dict):
            receipts.append(result)
    return receipts[-1] if receipts else None


def _confirmed_cancellation_reply(receipt: Dict[str, Any], guest_lang: Optional[str]) -> str:
    code = str(receipt.get("booking_code") or "").strip()
    lang = (guest_lang or "en").lower()
    templates = {
        "es": "La reserva {code} está cancelada.",
        "it": "La prenotazione {code} è annullata.",
        "de": "Die Buchung {code} ist storniert.",
        "en": "Booking {code} is cancelled.",
    }
    return templates.get(lang, templates["en"]).format(code=code)


def apply_cancellation_truth(reply_text: str, tool_calls: Optional[List[Dict[str, Any]]],
                             guest_lang: Optional[str]) -> Tuple[str, Optional[Dict[str, Any]]]:
    receipt = _cancellation_receipt(tool_calls)
    if receipt is None:
        return reply_text, None
    confirmed = (
        receipt.get("success") is True
        and receipt.get("cancelled") is True
        and receipt.get("write_performed") is True
        and isinstance(receipt.get("booking_code"), str)
        and bool(receipt["booking_code"].strip())
    )
    if confirmed:
        return _confirmed_cancellation_reply(receipt, guest_lang), {
            "kind": "confirmed_cancellation_receipt", "severity": "rewrite",
            "detail": receipt["booking_code"],
        }
    if (_CANCELLATION_CLAIM_RE.search(str(reply_text or ""))
            and not _NEGATED_CANCELLATION_RE.search(str(reply_text or ""))):
        code = str(receipt.get("booking_code") or "").strip()
        safe = f"Booking {code} is not cancelled." if code else "The booking is not cancelled."
        return safe, {
            "kind": "unsupported_cancellation_claim", "severity": "block",
            "detail": receipt.get("blocked_reason") or "unconfirmed",
        }
    return reply_text, None



def _digits(s: str) -> str:
    return re.sub(r"\D", "", str(s or ""))


def find_unsourced_prices(text: str, tool_calls: Optional[List[Dict[str, Any]]]) -> List[str]:
    """Prices stated in the reply that don't appear in ANY tool call/result.

    Conservative: a € amount in the reply is only flagged when its digit-run is
    absent from the JSON of every tool call (args + result_summary). If no pricing
    tool ran at all, any € amount is unsourced (classic fabricated quote).
    """
    import json

    blob = ""
    for tc in (tool_calls or []):
        try:
            blob += json.dumps(tc, default=str, ensure_ascii=False)
        except Exception:
            blob += str(tc)
    blob_digits = _digits(blob)

    unsourced: List[str] = []
    for m in _PRICE_RE.finditer(str(text or "")):
        raw = m.group(1) or m.group(2) or ""
        d = _digits(raw)
        if not d:
            continue
        # tolerate cents formatting: a reply "€140" should match a tool "14000" cents
        if d in blob_digits or (d + "00") in blob_digits:
            continue
        unsourced.append(m.group(0).strip())
    return unsourced


_SUBSTANTIAL_MIN = 25  # don't language-check tiny acks ("ok!", "👍")


def language_mismatch(text: str, guest_lang: Optional[str]) -> Optional[str]:
    """Return the reply's language if it clearly differs from the guest's.

    Conservative against false positives: only fires when the reply has a positive
    signal for SOME language but NONE for the guest's language (so a code-switched
    reply that still contains guest-language words passes, and an ambiguous reply
    with no signal at all is never flagged).
    """
    if not guest_lang:
        return None
    s = str(text or "").strip()
    if len(s) < _SUBSTANTIAL_MIN:
        return None
    want = guest_lang.lower()[:2]
    signals = detect_languages(s)
    if not signals or want in signals:
        return None
    return sorted(signals)[0]


# --- platform / role gating ---------------------------------------------------

def _hermes_role() -> str:
    return (os.getenv("HERMES_ROLE") or "luna").strip().lower()


def should_apply_guest_output_guard(*, platform: Any = None) -> bool:
    """Guest leak scrubbing applies only on Luna WhatsApp, never on orchestrator."""
    if _hermes_role() == "orchestrator":
        return False
    if platform is not None:
        try:
            from wolfhouse.guest_send_guard import is_guest_facing_platform

            return is_guest_facing_platform(platform)
        except Exception:
            return False
    # Turn-handler tests and legacy callers without platform: Luna container only.
    return _hermes_role() == "luna"


def orchestrator_debug_error(raw: str, *, kind: str) -> str:
    preview = str(raw or "").strip().replace("\n", " ")[:500]
    return f"[wolfhouse-orchestrator] {kind}: {preview}"


def _model_meta_from_agent_result(agent_result: Any) -> Dict[str, Any]:
    """Best-effort provider/model fields from gateway agent_result (shape varies)."""
    meta: Dict[str, Any] = {}
    if agent_result is None:
        return meta
    keys = (
        "model",
        "provider",
        "model_provider",
        "active_provider",
        "fallback_used",
        "used_fallback",
        "fallback_reason",
        "compression_applied",
        "context_compressed",
        "memory_loaded",
        "system_memory_loaded",
    )
    for key in keys:
        val = None
        if isinstance(agent_result, dict):
            val = agent_result.get(key)
        else:
            val = getattr(agent_result, key, None)
        if val is not None:
            meta[key] = val
    return meta


def _log_guard_decision(**fields: Any) -> None:
    try:
        import json
        import sys

        print(f"[wolfhouse] output-guard decision: {json.dumps(fields, default=str)}", file=sys.stderr)
    except Exception:
        pass


def guard_reply(
    reply_text: str,
    *,
    guest_lang: Optional[str] = None,
    tool_calls: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[str, List[Dict[str, Any]]]:
    """Return (safe_text, findings).

    PROVIDER_ERROR and LEAK are enforced (reply replaced with a localized
    fallback). PRICE and LANGUAGE are returned as advisory findings.
    """
    findings: List[Dict[str, Any]] = []
    text = str(reply_text or "")

    text, availability_finding = apply_availability_truth(text, tool_calls, guest_lang)
    if availability_finding:
        findings.append(availability_finding)

    text, cancellation_finding = apply_cancellation_truth(text, tool_calls, guest_lang)
    if cancellation_finding:
        findings.append(cancellation_finding)

    # Provider/API error has top priority: a raw error must never reach a guest,
    # and an error payload can also trip leak patterns ("API", "endpoint"), so
    # short-circuit to the warm outage message.
    if is_provider_error(text):
        findings.append({"kind": "provider_error", "severity": "block", "detail": text[:160]})
        return outage_fallback_for(reply_text, guest_lang), findings

    leaks = find_leaks(text)
    if leaks:
        findings.append({"kind": "leak", "severity": "block", "detail": leaks})
        text = safe_fallback_for(reply_text, guest_lang)

    denial = find_booking_denial_contradiction(reply_text, tool_calls)
    if denial:
        findings.append({"kind": "booking_denial_contradiction", "severity": "block", "detail": denial})
        text = booking_ask_fallback_for(reply_text, guest_lang)

    retry_claim = find_unsupported_retry_claim(reply_text, tool_calls)
    if retry_claim:
        findings.append({"kind": "unsupported_retry_claim", "severity": "block",
                         "detail": retry_claim})
        text = safe_fallback_for(reply_text, guest_lang)

    handoff_claim = find_unsupported_handoff_claim(reply_text, tool_calls)
    if handoff_claim:
        findings.append({"kind": "unsupported_handoff_claim", "severity": "block",
                         "detail": handoff_claim})
        text = safe_fallback_for(reply_text, guest_lang)

    prices = find_unsourced_prices(reply_text, tool_calls)
    if prices:
        findings.append({"kind": "unsourced_price", "severity": "warn", "detail": prices})

    mism = language_mismatch(reply_text, guest_lang)
    if mism:
        findings.append({"kind": "language_mismatch", "severity": "warn",
                         "detail": {"reply": mism, "guest": guest_lang}})

    return format_reply_text(text, guest_lang), findings


# --- real-path adapter (gateway.run turn handler) -----------------------------
# agent_result's exact shape lives in the gateway package (not this repo), so
# parse it DEFENSIVELY across the plausible shapes. Price/language are advisory
# (warn) — wrong parsing only yields noisy logs, never a mangled guest reply —
# so this is safe to ship even with shape uncertainty.

def _obj_get(value: Any, key: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


def _native_current_turn_tool_calls(messages: Any) -> List[Dict[str, Any]]:
    """Join completed current-turn tool results to assistant declarations by ID.

    Names come only from assistant tool-call declarations and results only from
    later role=tool messages carrying the same ID. The finalizer includes the
    full session transcript, so the last user message is the authority boundary.
    Orphans, duplicate IDs, declarations without results, and prior-turn rows
    are ignored fail-closed.
    """
    rows = list(messages or [])
    boundary = -1
    for index in range(len(rows) - 1, -1, -1):
        if str(_obj_get(rows[index], "role", "")).lower() == "user":
            boundary = index
            break
    if boundary < 0:
        return []

    declarations: Dict[str, List[Tuple[int, str]]] = {}
    results: Dict[str, List[Tuple[int, Any]]] = {}
    current_rows = rows[boundary + 1:]
    for index, message in enumerate(current_rows):
        role = str(_obj_get(message, "role", "")).lower()
        if role == "assistant":
            for call in (_obj_get(message, "tool_calls", None) or []):
                call_id = str(_obj_get(call, "id", "") or "").strip()
                function = _obj_get(call, "function", None)
                name = str(_obj_get(function, "name", "") or "").strip()
                if call_id and name:
                    declarations.setdefault(call_id, []).append((index, name))
        elif role == "tool":
            call_id = str(_obj_get(message, "tool_call_id", "") or "").strip()
            if call_id:
                results.setdefault(call_id, []).append(
                    (index, _obj_get(message, "content", None)))

    completed: List[Dict[str, Any]] = []
    for call_id, declared in declarations.items():
        matched_results = results.get(call_id, [])
        if len(declared) != 1 or len(matched_results) != 1:
            continue
        declaration_index, name = declared[0]
        result_index, result = matched_results[0]
        if result_index <= declaration_index or result is None:
            continue
        if isinstance(result, str) and result.strip().lower().startswith("[result "):
            continue
        completed.append({
            "name": name,
            "args": {},
            "result": result,
            "result_summary": str(result or ""),
            "tool_call_id": call_id,
            "_result_index": result_index,
        })
    completed.sort(key=lambda receipt: receipt["_result_index"])
    for receipt in completed:
        receipt.pop("_result_index", None)
    return completed


def _tool_calls_from_agent_result(agent_result: Any) -> List[Dict[str, Any]]:
    messages = _obj_get(agent_result, "messages", None) if agent_result is not None else None
    if messages is not None:
        return _native_current_turn_tool_calls(messages)

    raw = None
    if agent_result is not None:
        raw = getattr(agent_result, "tool_calls", None)
        if raw is None and isinstance(agent_result, dict):
            raw = agent_result.get("tool_calls") or agent_result.get("tool_results")
    out: List[Dict[str, Any]] = []
    for tc in (raw or []):
        get = tc.get if isinstance(tc, dict) else (lambda k, d=None, _o=tc: getattr(_o, k, d))
        result = get("result") or get("output")
        out.append({
            "name": get("name") or get("tool_name") or "",
            "args": get("arguments") or get("args") or {},
            "result": result,
            "result_summary": str(get("result_summary") or result or ""),
        })
    return out


def _guest_lang_from_history(history: Any) -> Optional[str]:
    try:
        for msg in reversed(list(history or [])):
            role = (msg.get("role") if isinstance(msg, dict) else getattr(msg, "role", "")) or ""
            if str(role).lower() in ("user", "guest", "human"):
                content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", "")
                raw = str(content or "").strip()
                scores = _language_scores(raw)
                sig = {lang for lang, score in scores.items() if score > 0}
                if len(sig) == 1:
                    return next(iter(sig))
                # Only short/weak acknowledgments are allowed to defer to an
                # older resolved locale. Substantive mixed-signal messages use
                # their uniquely strongest language (for example Spanish copy
                # containing the product name "Booking").
                if len(raw) >= _SUBSTANTIAL_MIN and sig:
                    top = max(scores.values())
                    winners = [lang for lang, score in scores.items() if score == top]
                    if top > 0 and len(winners) == 1:
                        return winners[0]
                continue
    except Exception:
        return None
    return None


def guard_turn_response(
    response: Any,
    agent_result: Any = None,
    history: Any = None,
    platform: Any = None,
    current_user: Any = None,
) -> str:
    """gateway.run adapter: guard the final reply with turn context available.

    Returns the (possibly leak-scrubbed) reply string. Advisory findings are
    printed to stderr for staff/telemetry. Never raises — callers wrap in
    try/except too, but this is the inner safety net.

    Guest leak/outage fallbacks run only on Luna WhatsApp. Orchestrator /
    operator channels pass every reply through byte-for-byte. Provider-shaped
    text is legitimate in technical status reports and must not be flattened or
    truncated by this guest-only defense.
    """
    try:
        text = str(response or "")
        if not text:
            return response

        guest_guard = should_apply_guest_output_guard(platform=platform)
        model_meta = _model_meta_from_agent_result(agent_result)

        if not guest_guard:
            _log_guard_decision(
                guest_guard=False,
                hermes_role=_hermes_role(),
                platform=str(getattr(platform, "value", platform) or ""),
                action="passthrough",
                fallback_used=False,
                model_meta=model_meta,
            )
            return response

        guest_lang = _guest_lang_from_history(
            [*(history or []), {'role': 'user', 'content': current_user}]
            if isinstance(current_user, str) else history)
        tool_calls = _tool_calls_from_agent_result(agent_result)
        safe, findings = guard_reply(text, guest_lang=guest_lang, tool_calls=tool_calls)
        if findings:
            block_kinds = [f.get("kind") for f in findings if f.get("severity") == "block"]
            _log_guard_decision(
                guest_guard=True,
                hermes_role=_hermes_role(),
                platform=str(getattr(platform, "value", platform) or ""),
                action="guest_scrub" if safe != text else "guest_advisory",
                fallback_used=safe != text,
                fallback_reason=block_kinds or None,
                guest_lang=guest_lang,
                model_meta=model_meta,
                findings=findings,
            )
        return safe
    except Exception:
        return response
