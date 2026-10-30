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

GUEST_PAYMENT_FALLBACK: Dict[str, str] = {
    "en": "That guest's payment is confirmed for their own share; the rest of the group remains separate.",
    "es": "El pago de ese huésped está confirmado para su parte; el resto del grupo sigue por separado.",
    "it": "Il pagamento di quell’ospite è confermato per la sua quota; il resto del gruppo rimane separato.",
    "de": "Die Zahlung dieses Gastes ist für den eigenen Anteil bestätigt; der Rest der Gruppe bleibt getrennt.",
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
           "preventivo", "lezione", "dispiace", "periodo", "tua", "sono", "siamo",
           "puoi", "possiamo", "parlare", "italiano", "sì", "va", "bene"),
    "fr": ("bonjour", "merci", "réserver", "réservation", "chambre", "nuits",
           "personnes", "séjour", "voudrais", "pouvez", "prix", "paiement", "parler",
           "français", "oui", "d'accord", "séparément"),
    "es": ("hola", "gracias", "habitación", "reserva", "noches", "tu", "estás",
           "quiero", "entiendo", "español", "háblame", "puedes", "hablar", "sí",
           "vale", "separados", "marea", "mareas"),
    "de": ("hallo", "danke", "zimmer", "buchung", "nächte", "system", "deine", "ist",
           "kannst", "deutsch", "sprechen", "ja", "bitte", "getrennte", "alles", "klar",
           "anzahlung", "zahlen", "möchte", "möchten", "wir", "du"),
    "en": ("the", "you", "your", "and", "for", "hello", "please", "thanks",
           "booking", "room", "ready", "would", "we've", "we're", "english", "speak"),
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
    r"avis(?:ado|é)|avvisat[aoe]|notifiqu[eé]|escal[eé]|envi[eé]|remit[ií]|"
    r"passat[aoe]|inoltrat[aoe]|"
    r"handed\s+(?:this\s+)?over|passed\s+(?:this\s+)?to|loop(?:ing|ed)?\s+in)\b"
    r"[^.?!]{0,100}\b(?:staff|team|equipo|personal|squadra|reception|front\s+desk)\b|"
    r"\b(?:staff|team|equipo|personal|squadra|reception|front\s+desk)\b[^.?!]{0,100}\b"
    r"(?:will\s+(?:get\s+back|contact|follow\s+up|review|check|double-check|sort)|"
    r"(?:is|are)\s+(?:reviewing|checking|looking\s+into)|"
    r"ti\s+contatter[aà]|(?:ti|la|lo)\s+ricontatter[aà])\b",
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
    accepted_save_owned = False
    for call in tool_calls or []:
        if not isinstance(call, dict):
            continue
        name = str(call.get("name") or call.get("tool") or "")
        result = _typed_tool_result(call)
        if (name == "create_booking_from_plan" and result is not None
                and result.get("success") is False
                and result.get("do_not_escalate") is True
                and (result.get("reason_code") in {
                         "offer_terms_changed", "quote_owner_presented_offer_required"}
                     or result.get("error") == "quote_owner_presented_offer_required")):
            accepted_save_owned = True
    if accepted_save_owned:
        return "accepted_save_must_not_handoff"
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


_DATE_CHANGE_CLAIM_RE = re.compile(
    r"(?:"
    r"\b(?:has\s+been\s+moved|moved(?:\s+\S+){0,12}\s+to|changed\s+to|"
    r"se\s+ha\s+cambiado|cambiada\s+a|"
    r"(?:è\s+stata\s+)?spostata(?:\s+\S+){0,12}\s+al?|"
    r"ho\s+spostato|l['’]ho\s+spostata|"
    r"he\s+movido|la\s+he\s+movido|"
    r"verschoben)\b"
    r"|"
    r"\b(?:dates?|fechas?|date)\b.{0,40}\b(?:are\s+now|is\s+now|son\s+ahora|sono\s+ora)\b"
    r")",
    re.IGNORECASE,
)


_DATE_CHANGE_MONTHS = {
    1: ("january", "enero", "gennaio"), 2: ("february", "febrero", "febbraio"),
    3: ("march", "marzo"), 4: ("april", "abril", "aprile"),
    5: ("may", "mayo", "maggio"), 6: ("june", "junio", "giugno"),
    7: ("july", "julio", "luglio"), 8: ("august", "agosto"),
    9: ("september", "septiembre", "settembre"), 10: ("october", "octubre", "ottobre"),
    11: ("november", "noviembre"), 12: ("december", "diciembre", "dicembre"),
}

_MOVE_DEST_RE = re.compile(
    r"(?:has\s+been\s+moved|moved(?:\s+\S+){0,12}\s+to|changed\s+to|"
    r"se\s+ha\s+cambiado|cambiada\s+a|(?:è\s+stata\s+)?spostata(?:\s+\S+){0,12}\s+al?|"
    r"ho\s+spostato|l['’]ho\s+spostata|he\s+movido|la\s+he\s+movido|verschoben|"
    r"(?:dates?|fechas?|date)\b.{0,40}\b(?:are\s+now|is\s+now|son\s+ahora|sono\s+ora))\s*"
    r"([^.!?]*)",
    re.IGNORECASE,
)

_BOOKING_CODE_RE = re.compile(r"\bWH-[A-Z0-9-]+\b", re.IGNORECASE)


def _date_change_reply_matches_receipt(text: str, booking: Dict[str, Any]) -> bool:
    claim = str(text or "")
    code = str(booking.get("booking_code") or "").strip()
    if not code:
        return False
    found_codes = _BOOKING_CODE_RE.findall(claim)
    if found_codes:
        if any(found.upper() != code.upper() for found in found_codes):
            return False
    dates = []
    years = set()
    for field in ("check_in", "check_out"):
        value = str(booking.get(field) or "").strip()
        match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", value)
        if match is None:
            return False
        year, month, day = int(match.group(1)), int(match.group(2)), int(match.group(3))
        years.add(year)
        dates.append((value, month, day))
    dest_match = _MOVE_DEST_RE.search(claim)
    dest = dest_match.group(1) if dest_match else claim
    dest_lower = dest.lower()
    years_in_dest = [int(y) for y in re.findall(r"\b(20\d{2})\b", dest)]
    if years_in_dest and any(year not in years for year in years_in_dest):
        return False
    for iso, month, day in dates:
        month_pattern = "|".join(re.escape(name) for name in _DATE_CHANGE_MONTHS[month])
        if iso.lower() in dest_lower:
            continue
        if re.search(rf"\b(?:{month_pattern})\b", dest_lower) is None:
            return False
        if re.search(rf"(?<!\d)0?{day}(?!\d)", dest_lower) is None:
            return False
    return True


def find_unsupported_date_change_claim(
    text: str, tool_calls: Optional[List[Dict[str, Any]]] = None,
) -> Optional[str]:
    if not _DATE_CHANGE_CLAIM_RE.search(str(text or "")):
        return None
    for call in tool_calls or []:
        if not isinstance(call, dict):
            continue
        if str(call.get("name") or call.get("tool") or "") != "move_booking_dates":
            continue
        result = _typed_tool_result(call)
        booking = result.get("booking") if isinstance(result, dict) else None
        if (isinstance(result, dict) and result.get("success") is True
                and result.get("write_performed") is True
                and result.get("moved_same_booking") is True
                and isinstance(booking, dict)
                and _date_change_reply_matches_receipt(text, booking)):
            return None
    return "same_booking_move_receipt_missing"


_CANCELLATION_CLAIM_RE = re.compile(
    r"\b(?:cancelled|canceled|anulada|anulado|cancelada|cancelado|annullata|annullato|storniert)\b",
    re.IGNORECASE,
)


_NEGATED_CANCELLATION_RE = re.compile(
    r"(?:isn['’]?t|wasn['’]?t|(?<![A-Za-z])(?:not|no|non|kein))(?:\s+(?:está|esta|è|e|ist|been))*\s+$",
    re.IGNORECASE,
)


def _clause_prefix_for_match(text: str, start: int) -> str:
    """Prefix of the same clause as a cancellation word — not the whole draft."""
    boundary = 0
    for index, char in enumerate(text[:start]):
        if char in ".!?;\n":
            boundary = index + 1
        elif char == "," and not text[index + 1:start].strip()[:1].isdigit():
            boundary = index + 1
    return text[boundary:start]


def _has_unnegated_cancellation_claim(text: str) -> bool:
    source = str(text or "")
    for match in _CANCELLATION_CLAIM_RE.finditer(source):
        prefix = _clause_prefix_for_match(source, match.start())
        if _NEGATED_CANCELLATION_RE.search(prefix):
            continue
        return True
    return False


def _cancellation_receipt(tool_calls: Optional[List[Dict[str, Any]]]) -> Optional[Dict[str, Any]]:
    receipts = []
    for call in tool_calls or []:
        if not isinstance(call, dict):
            continue
        name = str(call.get("name") or call.get("tool") or "")
        result = _typed_tool_result(call)
        if not isinstance(result, dict):
            continue
        if name == "cancel_unpaid_booking":
            receipts.append(result)
            continue
        nested = result.get("unpaid_cancel_follow_through")
        if name == "list_my_bookings" and isinstance(nested, dict):
            receipts.append(nested)
    return receipts[-1] if receipts else None


def _confirmed_cancellation_reply(receipt: Dict[str, Any], guest_lang: Optional[str]) -> str:
    code = str(receipt.get("booking_code") or "").strip()
    lang = (guest_lang or "en").lower()
    templates = {
        "es": "La reserva {code} está cancelada.",
        "it": "La prenotazione {code} è annullata.",
        "de": "Die Buchung {code} ist storniert.",
        "fr": "La réservation {code} est annulée.",
        "en": "Booking {code} is cancelled.",
    }
    return templates.get(lang, templates["en"]).format(code=code)


def apply_cancellation_truth(reply_text: str, tool_calls: Optional[List[Dict[str, Any]]],
                             guest_lang: Optional[str]) -> Tuple[str, Optional[Dict[str, Any]]]:
    receipt = _cancellation_receipt(tool_calls)
    confirmed = (
        receipt is not None
        and receipt.get("success") is True
        and receipt.get("cancelled") is True
        and receipt.get("write_performed") is True
        and isinstance(receipt.get("booking_code"), str)
        and bool(receipt["booking_code"].strip())
    )
    if confirmed:
        assert receipt is not None
        return _confirmed_cancellation_reply(receipt, guest_lang), {
            "kind": "confirmed_cancellation_receipt", "severity": "rewrite",
            "detail": receipt["booking_code"],
        }
    if _has_unnegated_cancellation_claim(reply_text):
        return safe_fallback_for(reply_text, guest_lang), {
            "kind": "unsupported_cancellation_claim", "severity": "block",
            "detail": (receipt or {}).get("blocked_reason") or "no_completed_cancellation_receipt",
        }
    return reply_text, None


def apply_guest_payment_truth(reply_text: str, tool_calls: Optional[List[Dict[str, Any]]],
                              guest_lang: Optional[str]) -> Tuple[str, Optional[Dict[str, Any]]]:
    """Render every complete current-turn payment receipt using Staff-owned copy."""
    language = (guest_lang or "en").lower().split("-", 1)[0]
    summaries_by_identity: Dict[str, str] = {}
    detail = None
    for index, call in enumerate(tool_calls or []):
        if not isinstance(call, dict):
            continue
        if str(call.get("name") or call.get("tool") or "") != "get_guest_payment_status":
            continue
        result = _typed_tool_result(call)
        if not isinstance(result, dict) or result.get("success") is not True:
            continue
        if result.get("payment_scope") == "booking_guests":
            detail = result.get("booking_code") or detail
            for row_index, row in enumerate(result.get("guest_payment_statuses") or []):
                if not isinstance(row, dict):
                    continue
                row_summaries = row.get("guest_safe_payment_summaries")
                row_summary = (row_summaries.get(language)
                               if isinstance(row_summaries, dict) else None)
                # A missing balance is unknown, not zero: only Staff-complete
                # personal receipts are safe to render.
                if (isinstance(row.get("amount_paid_cents"), int)
                        and isinstance(row.get("balance_due_cents"), int)
                        and isinstance(row_summary, str) and row_summary.strip()):
                    identity = str(row.get("booking_guest_id") or
                                   row.get("guest_number") or
                                   f"group:{index}:{row_index}")
                    summaries_by_identity[identity] = row_summary.strip()
            continue
        summaries = result.get("guest_safe_payment_summaries")
        summary = summaries.get(language) if isinstance(summaries, dict) else None
        if (result.get("payment_scope") == "guest"
                and isinstance(result.get("amount_paid_cents"), int)
                and isinstance(result.get("balance_due_cents"), int)
                and isinstance(summary, str) and summary.strip()):
            identity = str(result.get("booking_guest_id") or
                           result.get("guest_name") or f"personal:{index}")
            summaries_by_identity[identity] = summary.strip()
            detail = detail or identity

    if not summaries_by_identity:
        return reply_text, None
    factual_reply = _non_payment_reply(str(reply_text or ""), tool_calls)
    rendered = "\n".join(summaries_by_identity.values())
    if factual_reply and factual_reply != rendered:
        rendered = f"{rendered}\n\n{factual_reply}"
    return rendered, {
        "kind": "confirmed_guest_payment_receipt", "severity": "rewrite",
        "detail": detail,
    }



_INTERNAL_ASSIGNMENT_RE = re.compile(
    r"(?<!\w)[a-z][a-z0-9_]*\s*(?:=|:)\s*"
    r"(?:true|false|null|none|[-+]?\d+(?:\.\d+)?|[\[\{])",
    re.IGNORECASE,
)

_INTERNAL_KEY_RE = re.compile(
    r"(?:\{\s*)?[\"']?[a-z][a-z0-9]*_[a-z0-9_]+[\"']?"
    r"(?:\s*(?:=|:)\s*(?:true|false|null|none|[-+]?\d+(?:\.\d+)?|"
    r"[\"'][^\"']*[\"']|\[[^\]]*\]|\{[^{}]*\}))?(?:\s*\})?",
    re.IGNORECASE,
)

# Payment truth belongs exclusively to Staff receipts. Classify claims by the
# financial concepts they express, rather than by one approved/forbidden phrase.
_PAYMENT_CONCEPT_RE = re.compile(
    r"\b(?:pay(?:s|ing|ment|ments|ed)?|paid|owe(?:s|d)?|owing|balance|outstanding|"
    r"deposit|refund(?:ed)?|pag(?:a|ado|ada|ó|ato|ata|amento)|debe|deuda|"
    r"payé|paiement|doit|solde|bezahlt|zahlung|schuldet|restbetrag)\b",
    re.IGNORECASE,
)
_FINANCIAL_QUANTITY_RE = re.compile(
    r"\b(?:amount|total|remainder|remaining|rest|importe|cantidad|restante|"
    r"montant|reste|importo|betrag|restbetrag)\b",
    re.IGNORECASE,
)
_FINANCIAL_VALUE_RE = re.compile(
    r"(?:[€$£]\s*\d|\b\d+(?:[.,]\d+)?\b|"
    r"\b(?:zero|nothing|none|cero|nada|zéro|rien|niente|null|nichts)\b)",
    re.IGNORECASE,
)
_SETTLEMENT_STATE_RE = re.compile(
    r"\b(?:settle(?:d|ment)?|all\s+square|account\s+(?:is\s+)?clear)\b",
    re.IGNORECASE,
)
_RECEIPT_STATE_RE = re.compile(
    r"\b(?:arriv(?:e|ed)|receiv(?:e|ed)|collected|cleared|banked|sent)\b",
    re.IGNORECASE,
)
_GUEST_SHARE_RE = re.compile(
    r"\b(?:due|contribution|share|portion|part|obligation)\b", re.IGNORECASE)
_COMPLETENESS_RE = re.compile(
    r"\b(?:all|full|fully|everything|nothing|none|no\s+(?:more|further)|"
    r"not\s+required|complete(?:ly)?)\b",
    re.IGNORECASE,
)


def _is_model_money_claim(unit: str) -> bool:
    """Return true when prose states money, balance, or paid-status meaning."""
    direct_money = bool(
        _PRICE_RE.search(unit)
        or _PAYMENT_CONCEPT_RE.search(unit)
        or (_FINANCIAL_QUANTITY_RE.search(unit) and _FINANCIAL_VALUE_RE.search(unit))
    )
    settlement_status = bool(
        _SETTLEMENT_STATE_RE.search(unit)
        and (_COMPLETENESS_RE.search(unit) or _FINANCIAL_VALUE_RE.search(unit))
    )
    receipt_status = bool(
        _GUEST_SHARE_RE.search(unit)
        and _RECEIPT_STATE_RE.search(unit)
    )
    contribution_status = bool(
        _GUEST_SHARE_RE.search(unit)
        and _COMPLETENESS_RE.search(unit)
        and re.search(r"\b(?:required|received|arrived|settled)\b", unit, re.IGNORECASE)
    )
    return direct_money or settlement_status or receipt_status or contribution_status


_CLAUSE_SEPARATOR_RE = re.compile(
    r"([;,]|\b(?:and|but|while|whereas|because|since|after|now\s+that|y|et|e|und)\b)",
    re.IGNORECASE,
)
_GROUND_STOPWORDS = {
    "a", "an", "are", "as", "at", "can", "for", "from", "has", "have", "he",
    "her", "his", "i", "in", "is", "it", "my", "of", "on", "our", "she", "the",
    "their", "they", "this", "to", "we", "you", "your", "yes",
}


def _fact_tokens(value: str) -> List[str]:
    return [token for token in re.findall(r"[^\W_]+", value.casefold(), re.UNICODE)
            if len(token) >= 3 and token not in _GROUND_STOPWORDS]


def _semantic_root(token: str) -> str:
    """Normalize inflection without making unrelated words evidence for a claim."""
    token = token.casefold()
    for suffix in ("ments", "ment", "ingly", "edly", "ing", "ies", "ied", "ed", "es", "s"):
        if len(token) > len(suffix) + 3 and token.endswith(suffix):
            token = token[:-len(suffix)]
            break
    return {"boards": "surfboard", "board": "surfboard", "planche": "surfboard",
            "planch": "surfboard", "planches": "surfboard", "inclus": "include",
            "incluse": "include", "incluses": "include", "disponibl": "available",
            "disponible": "available", "disponibles": "available", "includ": "include",
            "included": "include", "covers": "include", "cover": "include",
            "arriv": "arrival"}.get(token, token)


def _semantic_tokens(value: str) -> set:
    return {_semantic_root(token) for token in _fact_tokens(value)}


def _non_payment_facts(tool_calls: Optional[List[Dict[str, Any]]]) -> List[Dict[str, set]]:
    """Build scalar entity/predicate/value facts from successful Staff JSON.

    A container is deliberately not a fact: sibling and parent values must not
    become a token bag that can jointly validate prose.
    """
    facts = []
    for call in tool_calls or []:
        if not isinstance(call, dict):
            continue
        name = str(call.get("name") or call.get("tool") or "")
        if name == "get_guest_payment_status":
            continue
        result = _typed_tool_result(call)
        if not isinstance(result, dict) or result.get("success") is not True:
            continue

        def scalar_fact(entity: set, key: str, item: Any) -> None:
            predicate = _semantic_tokens(key.replace("_", " "))
            scalar = str(item).casefold() if isinstance(item, bool) else str(item)
            fact_value = _semantic_tokens(scalar)
            facts.append({"entity": set(entity), "predicate": predicate,
                          "value": fact_value,
                          "tokens": set(entity) | predicate | fact_value})

        def visit(value: Any, parent_key: str = "", inherited_entity: Optional[set] = None) -> None:
            inherited_entity = set(inherited_entity or ())
            if isinstance(value, dict):
                entity = set(inherited_entity)
                for key in ("guest_name", "name", "code"):
                    if isinstance(value.get(key), str):
                        entity |= _semantic_tokens(value[key])
                for key, item in value.items():
                    if isinstance(item, (str, int, float, bool)):
                        scalar_fact(entity, key, item)
                    elif key != "guest_safe_labels":
                        visit(item, key, entity)
            elif isinstance(value, list):
                scalar_items = [item for item in value
                                if isinstance(item, (str, int, float, bool))]
                if scalar_items:
                    predicate = _semantic_tokens(parent_key.replace("_", " "))
                    item_tokens = set().union(*(_semantic_tokens(str(item))
                                                for item in scalar_items))
                    facts.append({"entity": item_tokens,
                                  "predicate": predicate, "value": item_tokens,
                                  "tokens": predicate | item_tokens,
                                  "aggregate": True})
                for item in value:
                    if not isinstance(item, (str, int, float, bool)):
                        visit(item, parent_key, inherited_entity)

        visit(result)
    return facts


def _claim_frame(unit: str) -> Dict[str, Any]:
    tokens = _semantic_tokens(unit)
    predicates = set()
    if ("include" in tokens or
            re.search(r"\b(?:cover\w*|come\w*\s+with|use|listed|get|available)\b", unit,
                      re.IGNORECASE)):
        predicates.add("include")
    if (_PAYMENT_CONCEPT_RE.search(unit) or _SETTLEMENT_STATE_RE.search(unit)
            or re.search(
                r"\b(?:bill|account|contribution|obligation|invoice)\b|\bzero(?:ed)?\s+out\b",
                unit, re.IGNORECASE)):
        predicates.add("payment")
    if re.search(r"\barriv\w*\b", unit, re.IGNORECASE):
        predicates.add("arrival")
    if (re.search(r"\b(?:free|complimentary)\b", unit, re.IGNORECASE)
            or re.search(r"\bcost\w*\s+(?:nothing|zero)\b", unit, re.IGNORECASE)
            or re.search(r"\b(?:come\w*\s+at\s+)?no\s+charge\b", unit,
                         re.IGNORECASE)):
        predicates.add("free")
    values = {}
    for predicate in predicates:
        if predicate == "include":
            negated = re.search(
                r"\b(?:not|isn't|aren't|no)\b[^.!?]*(?:includ\w*|cover\w*|come\w*\s+with)",
                unit, re.IGNORECASE,
            )
        elif predicate == "free":
            negated = re.search(
                r"\b(?:not|never|neither|isn't|aren't|doesn't|does\s+not|no)\b[^.!?]*"
                r"(?:free|complimentary|no\s+charge|cost\w*\s+(?:nothing|zero))",
                unit, re.IGNORECASE,
            )
        else:
            negated = False
        values[predicate] = "false" if negated else "true"
    return {"tokens": tokens, "predicate": predicates, "value": values}


_SHARED_ASSERTION_RE = re.compile(
    r"^(?P<subjects>.+?)\s+"
    r"(?P<assertion>(?:(?:both|all|each)\s+)?(?:is|are|cost|costs|come|comes|"
    r"do\s+not\s+come|does\s+not\s+come)\s+.+)$",
    re.IGNORECASE,
)
_SUBJECT_CONNECTOR_RE = re.compile(
    r"\s*,\s*|\s+(?:and|plus|along\s+with|nor)\s+", re.IGNORECASE)


def _shared_subject_claims(
        unit: str, facts: List[Dict[str, set]]) -> Optional[List[str]]:
    """Expand coordinated subjects only when every subject maps to one fact entity."""
    match = _SHARED_ASSERTION_RE.fullmatch(unit.strip())
    if match is None:
        return None
    subject_text = re.sub(r"^(?:both|all|each|neither)\s+", "", match.group("subjects"),
                          flags=re.IGNORECASE)
    subjects = [re.sub(r"^(?:both|all|each|neither)\s+", "", subject.strip(),
                       flags=re.IGNORECASE)
                for subject in _SUBJECT_CONNECTOR_RE.split(subject_text)]
    if len(subjects) < 2 or any(not subject for subject in subjects):
        return None
    entities = {frozenset(fact["entity"]) for fact in facts if fact["entity"]}
    for subject in subjects:
        subject_tokens = _semantic_tokens(subject)
        owned = {entity for entity in entities
                 if entity - {"rental"}
                 and (entity - {"rental"}) <= subject_tokens}
        if len(owned) != 1:
            return None
    assertion = re.sub(r"^(?:each\s+)", "", match.group("assertion"),
                       flags=re.IGNORECASE)
    assertion = re.sub(r"^(is|are)\s+(?:both|all|each)\s+", r"\1 ", assertion,
                       flags=re.IGNORECASE)
    if re.match(r"^neither\b", match.group("subjects"), re.IGNORECASE):
        assertion = re.sub(r"^(is|are)\s+", r"\1 never ", assertion,
                           flags=re.IGNORECASE)
    return [f"{subject} {assertion}" for subject in subjects]


def _independently_grounded(
        unit: str, facts: List[Dict[str, set]], *, is_question: bool = False) -> bool:
    """A clause is grounded only when one atomic fact owns its semantic frame."""
    claim = _claim_frame(unit)
    if not claim["tokens"] or not facts:
        return False
    # Unknown predicates are unsupported, including in questions. Presentation
    # cannot turn an unrecognised factual premise into Staff evidence.
    if not claim["predicate"]:
        return False
    # Payment facts are deliberately excluded above, so a mixed payment and
    # inclusion sentence cannot borrow entity words from one fact and a product
    # predicate from another.
    if "payment" in claim["predicate"]:
        return False
    entities = {frozenset(fact["entity"]) for fact in facts if fact["entity"]}
    matches = [(len(claim["tokens"] & (entity - {"rental"})) /
                max(1, len(entity - {"rental"})),
                len(claim["tokens"] & entity), entity)
               for entity in entities if claim["tokens"] & (entity - {"rental"})]
    if not matches:
        return False
    # Resolve the complete named entity before looking at predicates. A generic
    # overlap such as "rental" must not let a wetsuit authorize a surfboard.
    best_coverage, _best_overlap, claimed_entity = max(
        matches, key=lambda item: (item[0], item[1], len(item[2])))
    selected_is_aggregate = any(
        fact.get("aggregate") and frozenset(fact["entity"]) == claimed_entity
        for fact in facts)
    fully_named_entities = {entity for coverage, _overlap, entity in matches
                            if coverage >= 1}
    # One atomic claim may name exactly one entity. If a coordination escaped
    # structural expansion, no best-match fact may authorize its siblings.
    if len(fully_named_entities) != 1 and not selected_is_aggregate:
        return False
    if best_coverage < 1 and not selected_is_aggregate:
        return False
    entity_facts = [fact for fact in facts
                    if frozenset(fact["entity"]) == claimed_entity]

    # Every asserted predicate/value must be supported for that same entity.
    # No predicate may return early and hide a contradictory second assertion.
    for predicate in claim["predicate"]:
        expected = claim["value"].get(predicate, "true")
        supported = False
        for fact in entity_facts:
            fact_predicates = set(fact["predicate"])
            if predicate == "include":
                owns_predicate = ("include" in fact_predicates
                                  or "included" in fact["tokens"]
                                  or "include" in fact["tokens"])
                supported = owns_predicate and (
                    expected in fact["value"]
                    or (fact.get("aggregate") and expected == "true"
                        and bool(claim["tokens"] & fact["value"])))
            elif predicate == "arrival":
                supported = ("arrival" in fact_predicates
                             and bool(claim["tokens"] & fact["value"]))
            else:
                supported = predicate in fact_predicates and expected in fact["value"]
            if supported:
                break
        if not supported:
            return False
    return True


def _non_payment_reply(reply_text: str, tool_calls: Optional[List[Dict[str, Any]]]) -> str:
    """Keep only independently Staff-grounded non-payment clauses beside receipts."""
    source = _INTERNAL_ASSIGNMENT_RE.sub("", str(reply_text or ""))
    source = _INTERNAL_KEY_RE.sub("", source)
    facts = _non_payment_facts(tool_calls)
    rendered_sentences = []
    sentences = [item.strip() for item in
                 re.findall(r"[^\n.!?]+(?:[.!?]+|(?=\n|$))", source) if item.strip()]
    for sentence in sentences:
        terminal = sentence[-1] if sentence[-1:] in ".!?" else ""
        body = sentence[:-1] if terminal else sentence
        original_body = body
        # Expand propositions that share a sentence but not an authority source.
        # This prevents a safe equipment claim from laundering a payment tail,
        # or one supported subject from laundering a coordinated sibling.
        payment_tail = re.match(
            r"^(.*?)(?:\s+(?:after|because|since|now\s+that)\s+)(.+)$",
            body, re.IGNORECASE,
        )
        if payment_tail and (
                _is_model_money_claim(payment_tail.group(2))
                or (_GUEST_SHARE_RE.search(payment_tail.group(2))
                    and (_RECEIPT_STATE_RE.search(payment_tail.group(2))
                         or _COMPLETENESS_RE.search(payment_tail.group(2))))):
            body = payment_tail.group(1).rstrip()
        payment_accompaniment = re.match(r"^(.*?)\s+with\s+(.+)$", body, re.IGNORECASE)
        if payment_accompaniment and "payment" in _claim_frame(
                payment_accompaniment.group(2))["predicate"]:
            body = payment_accompaniment.group(1).rstrip()
        shared_claims = _shared_subject_claims(body, facts)
        if shared_claims is not None:
            # A coordinated assertion is one sentence and is true only when every
            # subject independently owns the shared claim and polarity.
            if all(not _is_model_money_claim(claim)
                   and _independently_grounded(
                       claim, facts, is_question=terminal == "?")
                   for claim in shared_claims):
                rendered_sentences.append(
                    sentence if body == original_body else body + terminal)
            continue
        pieces = _CLAUSE_SEPARATOR_RE.split(body)
        clauses = [pieces[index].strip(" ,;") for index in range(0, len(pieces), 2)]
        safe = [bool(clause)
                and not _is_model_money_claim(clause)
                and not _GUEST_SHARE_RE.search(clause)
                and not find_unsupported_handoff_claim(clause, tool_calls)
                and _independently_grounded(clause, facts, is_question=terminal == "?")
                for clause in clauses]
        # A short discourse marker attached to a grounded clause is presentation,
        # not a second factual claim. Questions may survive when this turn has
        # independent Staff evidence and contain no payment/handoff assertion.
        has_grounded_clause = any(safe)
        for index, clause in enumerate(clauses):
            if (safe[index] or not clause or _is_model_money_claim(clause)
                    or _GUEST_SHARE_RE.search(clause)):
                continue
            if has_grounded_clause and len(_fact_tokens(clause)) <= 1:
                safe[index] = True
        if clauses and all(safe):
            rendered_sentences.append(
                sentence if body == original_body else body + terminal)
            continue
        kept = []
        for index, clause in enumerate(clauses):
            if not safe[index]:
                continue
            if kept and index > 0:
                separator = pieces[(index * 2) - 1].strip()
                kept.append(f", {separator} " if separator not in {",", ";"}
                            else f"{separator} ")
            elif clause:
                clause = clause[:1].upper() + clause[1:]
            kept.append(clause)
        rebuilt = "".join(kept).strip()
        if rebuilt:
            rendered_sentences.append(rebuilt + terminal)
    return " ".join(rendered_sentences).strip()


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


_WHOLE_GROUP_SECURED_RE = re.compile(
    r"\b(?:secur\w*|lock\w*|confirm\w*|complet\w*|cover\w*|paid|pays|paying|"
    r"asegur\w*|bloque\w*|blocc\w*|assicurat\w*|conferm\w*|bezahl\w*|deck\w*|bestätig\w*|abschließ\w*)\b[^.?!]{0,80}"
    r"\b(?:booking|reservation|group|everyone|everybody|reserva|grupo|todos|"
    r"prenotazione|gruppo|tutti|buchung|gruppe|alle)\b|"
    r"\b(?:booking|reservation|group|everyone|everybody|reserva|grupo|todos|"
    r"prenotazione|gruppo|tutti|buchung|gruppe|alle)\b[^.?!]{0,80}\b(?:secur\w*|lock\w*|confirm\w*|"
    r"complet\w*|cover\w*|paid|pays|paying|asegur\w*|bloque\w*|blocc\w*|assicurat\w*|conferm\w*|"
    r"bezahl\w*|deck\w*|bestätig\w*|abschließ\w*)\b",
    re.IGNORECASE,
)


def find_guest_payment_group_overclaim(text: str, tool_calls=None) -> bool:
    """A personal payment receipt never proves that the whole group is secured."""
    if not _WHOLE_GROUP_SECURED_RE.search(str(text or "")):
        return False
    for call in tool_calls or []:
        if not isinstance(call, dict):
            continue
        name = str(call.get("name") or call.get("tool") or "")
        result = _typed_tool_result(call)
        if not isinstance(result, dict) or result.get("success") is not True:
            continue
        if name == "get_guest_payment_status" and result.get("payment_scope") == "guest":
            return True
        if name == "create_guest_payment_link" and (
                result.get("booking_guest_id") or result.get("guest_payment_url")
                or result.get("secure_payment_url")):
            return True
        if name == "create_booking_from_plan" and result.get("guest_payment_links"):
            return True
    return False


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

    date_change_claim = find_unsupported_date_change_claim(reply_text, tool_calls)
    if date_change_claim:
        findings.append({"kind": "unsupported_date_change_claim", "severity": "block",
                         "detail": date_change_claim})
        text = safe_fallback_for(reply_text, guest_lang)

    text, cancellation_finding = apply_cancellation_truth(text, tool_calls, guest_lang)
    if cancellation_finding:
        findings.append(cancellation_finding)
        # A completed Staff receipt is the final cancellation-truth owner.  The
        # canonical confirmation derived above must not be overwritten by stale
        # model draft text (for example an unsupported handoff sentence).
        if cancellation_finding.get("kind") == "confirmed_cancellation_receipt":
            return text, findings

    text, guest_payment_finding = apply_guest_payment_truth(text, tool_calls, guest_lang)
    if guest_payment_finding:
        findings.append(guest_payment_finding)

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

    denial = find_booking_denial_contradiction(text, tool_calls)
    if denial:
        findings.append({"kind": "booking_denial_contradiction", "severity": "block", "detail": denial})
        text = booking_ask_fallback_for(reply_text, guest_lang)

    retry_claim = find_unsupported_retry_claim(text, tool_calls)
    if retry_claim:
        findings.append({"kind": "unsupported_retry_claim", "severity": "block",
                         "detail": retry_claim})
        text = safe_fallback_for(reply_text, guest_lang)

    handoff_claim = find_unsupported_handoff_claim(text, tool_calls)
    if handoff_claim:
        findings.append({"kind": "unsupported_handoff_claim", "severity": "block",
                         "detail": handoff_claim})
        text = safe_fallback_for(reply_text, guest_lang)

    if find_guest_payment_group_overclaim(text, tool_calls):
        findings.append({"kind": "guest_payment_group_overclaim", "severity": "block",
                         "detail": "personal_receipt_does_not_secure_group"})
        language = (guest_lang or "en")[:2]
        text = GUEST_PAYMENT_FALLBACK.get(language, GUEST_PAYMENT_FALLBACK["en"])

    prices = find_unsourced_prices(text, tool_calls)
    if prices:
        findings.append({"kind": "unsourced_price", "severity": "warn", "detail": prices})

    mism = language_mismatch(text, guest_lang)
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
