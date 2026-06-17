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

import re
from typing import Any, Dict, List, Optional, Tuple

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
        r"\bAPI\b",
        r"\bendpoint\b",
    )
)

# --- localized safe fallbacks -------------------------------------------------
# Warm, guest-safe replacement when a leak is caught. No internals, gives a path
# forward (a human will follow up).
SAFE_FALLBACK: Dict[str, str] = {
    "en": "Let me double-check that with my team and get right back to you! 😊",
    "it": "Lascia che verifichi con il mio team e ti rispondo subito! 😊",
    "de": "Ich kläre das kurz mit meinem Team und melde mich gleich bei dir! 😊",
    "es": "Déjame confirmarlo con mi equipo y te respondo enseguida! 😊",
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
    "it": ("ciao", "grazie", "prego", "prenotazione", "stanza", "notti", "sistema",
           "preventivo", "lezione", "dispiace", "periodo", "tua", "sono", "siamo", "puoi"),
    "es": ("hola", "gracias", "habitación", "reserva", "noches", "sistema", "tu", "estás"),
    "de": ("hallo", "danke", "zimmer", "buchung", "nächte", "system", "deine", "ist"),
    "en": ("the", "you", "your", "and", "for", "hello", "please", "thanks",
           "booking", "room", "ready", "would", "we've", "we're"),
}


def detect_languages(text: str) -> set:
    """All languages with a positive keyword signal in the text (may be empty)."""
    low = f" {str(text or '').lower()} "
    found = set()
    for lang, words in _LANG_HINTS.items():
        if any(f" {w} " in low or f" {w}," in low or f" {w}." in low or f" {w}!" in low for w in words):
            found.add(lang)
    return found


def guess_language(text: str, hint: Optional[str] = None) -> str:
    """Single best-guess language for localization; defaults to 'en'."""
    if hint:
        return hint.lower()[:2]
    found = detect_languages(text)
    for lang in ("it", "es", "de", "en"):   # prefer a non-default signal
        if lang in found:
            return lang
    return "en"


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


# --- orchestrator -------------------------------------------------------------

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

    prices = find_unsourced_prices(reply_text, tool_calls)
    if prices:
        findings.append({"kind": "unsourced_price", "severity": "warn", "detail": prices})

    mism = language_mismatch(reply_text, guest_lang)
    if mism:
        findings.append({"kind": "language_mismatch", "severity": "warn",
                         "detail": {"reply": mism, "guest": guest_lang}})

    return text, findings


# --- real-path adapter (gateway.run turn handler) -----------------------------
# agent_result's exact shape lives in the gateway package (not this repo), so
# parse it DEFENSIVELY across the plausible shapes. Price/language are advisory
# (warn) — wrong parsing only yields noisy logs, never a mangled guest reply —
# so this is safe to ship even with shape uncertainty.

def _tool_calls_from_agent_result(agent_result: Any) -> List[Dict[str, Any]]:
    raw = None
    if agent_result is not None:
        raw = getattr(agent_result, "tool_calls", None)
        if raw is None and isinstance(agent_result, dict):
            raw = agent_result.get("tool_calls") or agent_result.get("tool_results")
    out: List[Dict[str, Any]] = []
    for tc in (raw or []):
        get = tc.get if isinstance(tc, dict) else (lambda k, d=None, _o=tc: getattr(_o, k, d))
        out.append({
            "name": get("name") or get("tool_name") or "",
            "args": get("arguments") or get("args") or {},
            "result_summary": str(get("result_summary") or get("result") or get("output") or ""),
        })
    return out


def _guest_lang_from_history(history: Any) -> Optional[str]:
    try:
        for msg in reversed(list(history or [])):
            role = (msg.get("role") if isinstance(msg, dict) else getattr(msg, "role", "")) or ""
            if str(role).lower() in ("user", "guest", "human"):
                content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", "")
                sig = detect_languages(str(content or ""))
                for lang in ("it", "es", "de", "en"):
                    if lang in sig:
                        return lang
                return None
    except Exception:
        return None
    return None


def guard_turn_response(response: Any, agent_result: Any = None, history: Any = None) -> str:
    """gateway.run adapter: guard the final reply with turn context available.

    Returns the (possibly leak-scrubbed) reply string. Advisory findings are
    printed to stderr for staff/telemetry. Never raises — callers wrap in
    try/except too, but this is the inner safety net.
    """
    try:
        text = str(response or "")
        if not text:
            return response
        guest_lang = _guest_lang_from_history(history)
        tool_calls = _tool_calls_from_agent_result(agent_result)
        safe, findings = guard_reply(text, guest_lang=guest_lang, tool_calls=tool_calls)
        if findings:
            try:
                import sys
                print(f"[wolfhouse] output-guard turn findings: {findings}", file=sys.stderr)
            except Exception:
                pass
        return safe
    except Exception:
        return response
