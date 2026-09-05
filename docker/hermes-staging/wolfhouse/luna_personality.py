"""Luna Personality — WhatsApp-only closed style packs for the same Luna.

Resolve once per guest turn at the trusted gateway boundary and inject one
short server-owned pack into the in-memory SOUL/authoring prompt. Each new
turn fetches the authoritative tenant setting again so a Staff PUT is visible
on the next reply. Within-turn reuse is the bound ContextVar, not a TTL cache.
Never accept style text from API, DB, guest, or caller. Failures default to
sunny and must not block the reply.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from contextvars import ContextVar
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlparse

PRODUCT_NAME = "Luna Personality"
CHANNEL = "whatsapp"
SETTINGS_KEY = "luna_personality"
DEFAULT_PERSONALITY_ID = "sunny"
CLOSED_PERSONALITY_IDS = ("sunny", "calm", "concise", "extra")
GUEST_WHATSAPP_LUNA_ROLES = frozenset({"luna", "sunset-luna"})
FETCH_TIMEOUT_S = 0.8
INJECTION_MARK = "Luna Personality this turn:"
ALLOWED_STAFF_ORIGINS = frozenset({"https://sunset-staging.lunafrontdesk.com"})
STAFF_BOT_PERSONALITY_PATH = "/staff/bot/luna-personality"

PACKS: Dict[str, Dict[str, str]] = {
    "sunny": {
        "id": "sunny",
        "instruction": (
            "Luna Personality this turn: sunny (DEFAULT — current live Wolf-House tone). "
            "Upbeat playful surf-host warmth. Light emoji (usually 0–2, tasteful emoji, never a wall). "
            "Friendly, human WhatsApp cadence. One clear next step. "
            "Wording/cadence/warmth/emoji only. Never change facts, prices, availability, open spots, "
            "permissions, tool choice or results, identity, booking/payment state, URLs, confirmations, "
            "handoff decisions, or language."
        ),
    },
    "calm": {
        "id": "calm",
        "instruction": (
            "Luna Personality this turn: calm. "
            "Patient, reassuring, low-key. Soft warmth, fewer emoji, no hype, no elongated openers. "
            "Steady WhatsApp cadence. One clear next step. "
            "Wording/cadence/warmth/emoji only. Never change facts, prices, availability, open spots, "
            "permissions, tool choice or results, identity, booking/payment state, URLs, confirmations, "
            "handoff decisions, or language."
        ),
    },
    "concise": {
        "id": "concise",
        "instruction": (
            "Luna Personality this turn: concise. "
            "Friendly but short. Tight sentences, minimal emoji, no extra cheer. "
            "Keep the same next step in fewer words. "
            "Wording/cadence/warmth/emoji only. Never change facts, prices, availability, open spots, "
            "permissions, tool choice or results, identity, booking/payment state, URLs, confirmations, "
            "handoff decisions, or language."
        ),
    },
    "extra": {
        "id": "extra",
        "instruction": (
            "Luna Personality this turn: extra. "
            "Ultra bright, over-the-top friendly surf-host energy. More emoji than sunny, still readable. "
            "Celebratory cadence without inventing facts. "
            "Wording/cadence/warmth/emoji only. Never change facts, prices, availability, open spots, "
            "permissions, tool choice or results, identity, booking/payment state, URLs, confirmations, "
            "handoff decisions, or language."
        ),
    },
}

COMPOSER_OWNED_STATES = frozenset(
    {
        "stripe_test_link_created",
        "payment_link_sent",
        "payment_received_preview_ready",
        "confirmation_sent_ack",
        "safe_handoff",
    }
)

_bound: ContextVar[Optional[Dict[str, Any]]] = ContextVar("luna_personality_bound", default=None)
_soul_patch_installed = False


def is_closed_id(value: Any) -> bool:
    return str(value or "").strip().lower() in CLOSED_PERSONALITY_IDS


def normalize_stored_id(value: Any) -> Dict[str, str]:
    raw = str(value or "").strip().lower()
    if not raw:
        return {"id": DEFAULT_PERSONALITY_ID, "source": "default"}
    if raw in CLOSED_PERSONALITY_IDS:
        return {"id": raw, "source": "stored"}
    return {"id": DEFAULT_PERSONALITY_ID, "source": "invalid_fallback"}


def get_personality_pack(personality_id: Any) -> Dict[str, str]:
    key = str(personality_id or "").strip().lower()
    if key not in PACKS:
        key = DEFAULT_PERSONALITY_ID
    return PACKS[key]


def personality_observability(
    *,
    tenant_id: Optional[str],
    channel: str,
    personality_id: str,
    source: Optional[str],
    fallback_reason: Optional[str],
) -> Dict[str, Optional[str]]:
    return {
        "tenant_id": tenant_id,
        "channel": channel,
        "personality_id": personality_id if is_closed_id(personality_id) else DEFAULT_PERSONALITY_ID,
        "source": source,
        "fallback_reason": fallback_reason,
    }


def _platform_name(source: Any) -> str:
    plat = getattr(source, "platform", None)
    return str(getattr(plat, "value", plat or "")).strip().lower()


def _tenant_id() -> str:
    return (os.getenv("LUNA_CLIENT_SLUG") or os.getenv("LUNA_BOT_CLIENT_SLUG") or "").strip()


def _sunny(tenant_id: str, channel: str, reason: Optional[str], applied: bool) -> Dict[str, Any]:
    pack = get_personality_pack(DEFAULT_PERSONALITY_ID)
    return {
        "applied": applied,
        "pack": pack if applied else None,
        "observability": personality_observability(
            tenant_id=tenant_id or None,
            channel=channel,
            personality_id=DEFAULT_PERSONALITY_ID,
            source="default",
            fallback_reason=reason,
        ),
    }


def parse_exact_staff_origin(url: str) -> str:
    """Exact allowlisted Staff origin. Substring hosts, HTTP, userinfo, ports, paths fail."""
    from wolfhouse.luna_personality_isolation import IsolationAbort

    raw = str(url or "").strip()
    parsed = urlparse(raw)
    if parsed.scheme != "https":
        raise IsolationAbort("staff_origin_not_https")
    if parsed.username or parsed.password:
        raise IsolationAbort("staff_origin_userinfo_forbidden")
    host = (parsed.hostname or "").lower()
    if parsed.port:
        raise IsolationAbort("staff_origin_port_forbidden")
    origin = f"{parsed.scheme}://{host}"
    if origin not in ALLOWED_STAFF_ORIGINS:
        raise IsolationAbort(f"staff_origin_not_allowlisted:{host or 'empty'}")
    if parsed.path not in ("", "/"):
        raise IsolationAbort("staff_origin_path_forbidden")
    if parsed.query or parsed.fragment:
        raise IsolationAbort("staff_origin_query_forbidden")
    return origin


def canonical_bot_auth_headers(token: str) -> Dict[str, str]:
    """Headers requireBotAuth accepts on /staff/bot/* (no Staff cookies).

    Staff API must use the same LUNA_BOT_INTERNAL_TOKEN as this runtime.
    Bot principal tenant is Staff-side LUNA_BOT_CLIENT_SLUG (preferred) or
    DEFAULT_CLIENT_SLUG — for Sunset that value must be ``sunset``. Do not
    rotate tokens here; a mismatch is HTTP 401 from requireBotAuth, and a
    missing runtime slug is HTTP 503 bot_principal_tenant_unconfigured.
    """
    return {"X-Luna-Bot-Token": str(token or "").strip(), "Accept": "application/json"}


def default_fetch_setting(_tenant_id: str) -> Dict[str, Any]:
    base = (os.getenv("WOLFHOUSE_STAFF_API_BASE_URL") or "").rstrip("/")
    token = (os.getenv("LUNA_BOT_INTERNAL_TOKEN") or "").strip()
    if not base or not token:
        raise RuntimeError("setting_unavailable")
    origin = parse_exact_staff_origin(base)
    req = urllib.request.Request(
        f"{origin}{STAFF_BOT_PERSONALITY_PATH}",
        method="GET",
        headers=canonical_bot_auth_headers(token),
    )
    with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as res:
        body = res.read().decode("utf-8") if res else "{}"
    parsed = json.loads(body or "{}")
    return parsed if isinstance(parsed, dict) else {}


def clear_personality_cache() -> None:
    """No-op. Cross-turn result caching would hide a Staff PUT from the next reply."""
    return None


def should_rebuild_cached_agent(role: Optional[str], platform: Optional[str]) -> bool:
    """Evict the cached Hermes agent for guest-Luna WhatsApp roles only."""
    r = str(role or "").strip()
    p = str(getattr(platform, "value", platform) or "").strip().lower()
    return r in GUEST_WHATSAPP_LUNA_ROLES and p in {"whatsapp", "whatsapp_cloud"}


def resolve_whatsapp_personality_once(
    *,
    tenant_id: Optional[str] = None,
    channel: str = CHANNEL,
    fetch_setting: Optional[Callable[[str], Dict[str, Any]]] = None,
    now: Optional[float] = None,
) -> Dict[str, Any]:
    ch = (channel or CHANNEL).strip().lower() or CHANNEL
    tid = (tenant_id if tenant_id is not None else _tenant_id()).strip()
    if ch != CHANNEL:
        return _sunny(tid, ch, "not_whatsapp", applied=False)
    fetcher = fetch_setting or default_fetch_setting
    from wolfhouse.luna_personality_isolation import IsolationAbort, current_isolated_turn

    try:
        raw = fetcher(tid)
        stored = None
        if isinstance(raw, dict):
            stored = raw.get("personality_id")
            if stored is None:
                stored = raw.get(SETTINGS_KEY)
        normalized = normalize_stored_id(stored)
        pack = get_personality_pack(normalized["id"])
        fallback = None if normalized["source"] == "stored" else normalized["source"]
        if current_isolated_turn() is not None and fallback:
            raise IsolationAbort(f"setting_fallback:{fallback}")
        return {
            "applied": True,
            "pack": pack,
            "observability": personality_observability(
                tenant_id=tid or None,
                channel=ch,
                personality_id=pack["id"],
                source=normalized["source"],
                fallback_reason=fallback,
            ),
        }
    except IsolationAbort as exc:
        if current_isolated_turn() is not None:
            raise
        return _sunny(tid, ch, exc.reason, applied=True)
    except Exception as exc:
        reason = "setting_timeout" if "timed out" in str(exc).lower() or "timeout" in str(exc).lower() else "setting_failure"
        if current_isolated_turn() is not None:
            raise IsolationAbort(f"setting_fallback:{reason}") from exc
        return _sunny(tid, ch, reason, applied=True)


def should_freeze_personality_style(composer_state: Optional[str]) -> bool:
    return str(composer_state or "").strip() in COMPOSER_OWNED_STATES


def inject_personality_pack_once(
    system_prompt: str,
    pack: Optional[Dict[str, str]],
    *,
    channel: str = CHANNEL,
    composer_state: Optional[str] = None,
    already_injected: bool = False,
) -> Dict[str, Any]:
    text = system_prompt if isinstance(system_prompt, str) else str(system_prompt or "")
    ch = (channel or CHANNEL).strip().lower() or CHANNEL
    if already_injected or INJECTION_MARK in text:
        return {"system_prompt": text, "injected": False, "injection_count": 0}
    if ch != CHANNEL or not pack or not pack.get("instruction"):
        return {"system_prompt": text, "injected": False, "injection_count": 0}
    if should_freeze_personality_style(composer_state):
        return {"system_prompt": text, "injected": False, "injection_count": 0}
    injected_prompt = f"{text}\n\n{pack['instruction']}"
    try:
        from wolfhouse.luna_personality_isolation import record_consumed_pack

        record_consumed_pack(pack.get("id"), injected=True)
    except Exception:
        pass
    return {
        "system_prompt": injected_prompt,
        "injected": True,
        "injection_count": 1,
    }


def bind_whatsapp_turn_personality(source: Any, fetch_setting: Optional[Callable[[str], Dict[str, Any]]] = None) -> Dict[str, Any]:
    channel = _platform_name(source) or CHANNEL
    if channel not in {"whatsapp", "whatsapp_cloud"}:
        bound = _sunny(_tenant_id(), channel, "not_whatsapp", applied=False)
        _bound.set(bound)
        return bound
    bound = resolve_whatsapp_personality_once(channel=CHANNEL, fetch_setting=fetch_setting)
    _bound.set(bound)
    try:
        from wolfhouse.luna_personality_isolation import record_consumed_pack

        pack = bound.get("pack") or {}
        obs = bound.get("observability") or {}
        record_consumed_pack(
            pack.get("id"),
            injected=False,
            source=obs.get("source"),
            fallback=obs.get("fallback_reason"),
        )
    except Exception:
        pass
    return bound


def get_bound_personality() -> Optional[Dict[str, Any]]:
    return _bound.get()


def clear_bound_personality() -> None:
    _bound.set(None)


def apply_personality_to_soul_text(soul_text: str) -> str:
    bound = get_bound_personality() or {}
    if not bound.get("applied"):
        return soul_text
    result = inject_personality_pack_once(soul_text, bound.get("pack"), channel=CHANNEL)
    return result["system_prompt"]


def install_soul_append_runtime_patch() -> bool:
    """Append the bound pack when SOUL.md is read in-memory. Idempotent."""
    global _soul_patch_installed
    if _soul_patch_installed:
        return True
    from pathlib import Path

    orig = Path.read_text

    def _read_text(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        text = orig(self, *args, **kwargs)
        try:
            if getattr(self, "name", "") == "SOUL.md":
                return apply_personality_to_soul_text(text)
        except Exception:
            return text
        return text

    Path.read_text = _read_text  # type: ignore[method-assign]
    _soul_patch_installed = True
    return True
