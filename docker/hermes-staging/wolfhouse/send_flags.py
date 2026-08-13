"""WhatsApp kill switches for Hermes Luna: ``WHATSAPP_DRY_RUN`` + ``LUNA_AUTO_SEND_ENABLED``.

Both flags already exist on the legacy JS path (32 files under ``scripts/`` read
them) and are fail-closed there. Neither existed anywhere in Hermes, which is what
actually talks to guests on staging — so on the only path that can reach a real
phone, neither flag could stop anything. This module is the missing half.

Semantics are copied from the shipped JS predicates, not re-invented:

  ``WHATSAPP_DRY_RUN``      ``isWhatsappDryRun`` in
                            ``scripts/lib/luna-guest-reply-send-eligibility.js``::

                                String(env.WHATSAPP_DRY_RUN ?? 'true')
                                  .trim().toLowerCase() !== 'false'

                            Only the literal ``false`` turns dry run off. Unset,
                            empty, ``0``, ``off``, ``no`` all mean dry run is ON.

  ``LUNA_AUTO_SEND_ENABLED`` ``collectEnvGateReasons`` in
                            ``scripts/lib/luna-guest-reply-send-route.js``::

                                String(env[key] || '').trim().toLowerCase() === 'true'

                            Only the literal ``true`` opens the gate.

``scripts/verify-hermes-send-flags.js`` runs these two functions for real against
the JS predicates over a shared env matrix, so the two readings cannot drift.

Fail-closed all the way down: an unset flag blocks, an unparseable flag blocks,
and an unexpected error inside this module blocks (``guard_error``). A kill switch
that fails open is not a kill switch.

Blocked reason vocabulary is the one the shipped JS route already emits
(``whatsapp_dry_run_active`` / ``luna_auto_send_not_enabled``), so the Inbox, the
audit log and the container log all name the same event the same way.

Not covered here, deliberately: the staff Inbox "Send" button. It never reaches
this code — it posts to ``POST /staff/inbox/send-reply`` on the Staff API, which
calls the Meta Graph API from Node (``sendLunaWhatsAppMessage``). Hermes only ever
sends Luna's own replies, which is why there is no ``staff_reply`` carve-out here
and no ``send_kind`` to carve out on: the adapter signature is
``send(chat_id, content, reply_to, metadata)``.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

DRY_RUN_ENV = "WHATSAPP_DRY_RUN"
AUTO_SEND_ENV = "LUNA_AUTO_SEND_ENABLED"

DRY_RUN_BLOCKED_REASON = "whatsapp_dry_run_active"
AUTO_SEND_BLOCKED_REASON = "luna_auto_send_not_enabled"
GUARD_ERROR_BLOCKED_REASON = "send_flag_guard_error"

#: Key set on ``SendResult.raw_response`` when a flag suppressed the send. Callers
#: that need to know a send did not happen (e.g. the handoff acknowledgement in
#: ``wolfhouse.explicit_human_handoff``) look for this.
SUPPRESSED_KEY = "suppressed_guest_send_flag"

LOG_EVENT = "guest_send_blocked_by_flag"


def _read(env: Optional[Dict[str, Any]], key: str) -> Optional[str]:
    """Read one flag. Deliberately does not swallow: an env source that cannot be
    read is a guard error, not an absent flag, and the two must not look alike."""
    src = os.environ if env is None else env
    value = src.get(key)
    return None if value is None else str(value)


def whatsapp_dry_run(env: Optional[Dict[str, Any]] = None) -> bool:
    """True when dry run is active, i.e. nothing may be sent to a guest."""
    raw = _read(env, DRY_RUN_ENV)
    if raw is None:
        return True
    return raw.strip().lower() != "false"


def luna_auto_send_enabled(env: Optional[Dict[str, Any]] = None) -> bool:
    """True only for the literal ``true`` (trimmed, case-insensitive)."""
    raw = _read(env, AUTO_SEND_ENV)
    if raw is None:
        return False
    return raw.strip().lower() == "true"


def _flag_state(env: Optional[Dict[str, Any]]) -> Dict[str, bool]:
    return {
        "whatsapp_dry_run": whatsapp_dry_run(env),
        "luna_auto_send_enabled": luna_auto_send_enabled(env),
    }


def _mask(chat_id: Any) -> str:
    """Last 4 digits only — enough to find the thread, not a phone book in the logs."""
    digits = "".join(ch for ch in str(chat_id or "") if ch.isdigit())
    if not digits:
        return "unknown"
    return f"…{digits[-4:]}" if len(digits) > 4 else digits


def _value_note(raw: Optional[str], expected: str) -> str:
    if raw is None:
        return "unset"
    if not raw.strip():
        return "empty"
    return f"not the literal {expected!r}"


def guest_whatsapp_send_flag_block(
    chat_id: Any = None,
    env: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Return a block record when a kill switch forbids this send, else ``None``.

    Order matches the JS ladder in ``scripts/lib/luna-effective-mode.js``:
    ``luna_auto_send_not_enabled`` decides before ``whatsapp_dry_run_active``,
    because the shipped route never reaches the provider (and so never reports
    dry run) while the auto-send gate is shut. Both parsed values are reported
    either way, so an operator who has to flip both flags learns that once.
    """
    try:
        flags = _flag_state(env)
        if not flags["luna_auto_send_enabled"]:
            raw = _read(env, AUTO_SEND_ENV)
            return {
                "blocked_reason": AUTO_SEND_BLOCKED_REASON,
                "flag": AUTO_SEND_ENV,
                "flag_value": raw,
                "flag_note": _value_note(raw, "true"),
                "allow_value": "true",
                "flags": flags,
                "guest": _mask(chat_id),
            }
        if flags["whatsapp_dry_run"]:
            raw = _read(env, DRY_RUN_ENV)
            return {
                "blocked_reason": DRY_RUN_BLOCKED_REASON,
                "flag": DRY_RUN_ENV,
                "flag_value": raw,
                "flag_note": _value_note(raw, "false"),
                "allow_value": "false",
                "flags": flags,
                "guest": _mask(chat_id),
            }
        return None
    except Exception as exc:  # pragma: no cover - defensive, asserted by the gate
        return {
            "blocked_reason": GUARD_ERROR_BLOCKED_REASON,
            "flag": None,
            "flag_value": None,
            "flag_note": f"guard raised {type(exc).__name__}",
            "allow_value": None,
            "flags": {"whatsapp_dry_run": True, "luna_auto_send_enabled": False},
            "guest": _mask(chat_id),
        }


def guard_error_block(exc: Any = None, chat_id: Any = None) -> Dict[str, Any]:
    """Block record for callers that could not even reach the guard (import failure).

    Fail-closed is the whole point: if the kill switch cannot be evaluated, the
    send does not happen.
    """
    return {
        "blocked_reason": GUARD_ERROR_BLOCKED_REASON,
        "flag": None,
        "flag_value": None,
        "flag_note": f"guard unavailable: {type(exc).__name__ if exc is not None else 'unknown'}",
        "allow_value": None,
        "flags": {"whatsapp_dry_run": True, "luna_auto_send_enabled": False},
        "guest": _mask(chat_id),
    }


def describe_flag_block(block: Optional[Dict[str, Any]]) -> str:
    """One line an operator reading ``docker logs hermes-luna`` can act on."""
    if not block:
        return ""
    reason = block.get("blocked_reason")
    if reason == GUARD_ERROR_BLOCKED_REASON:
        return (
            "[wolfhouse] send blocked (send_flag_guard_error) — the WhatsApp kill-switch guard "
            f"could not be evaluated ({block.get('flag_note')}); failing closed, nothing sent"
        )
    flag = block.get("flag")
    allow = block.get("allow_value")
    return (
        f"[wolfhouse] send blocked ({reason}) — {flag} is {block.get('flag_note')}; "
        f"set {flag}={allow} in /etc/hermes-luna.env and restart hermes-luna to allow sends "
        f"(guest {block.get('guest')}, "
        f"WHATSAPP_DRY_RUN={block.get('flags', {}).get('whatsapp_dry_run')}, "
        f"LUNA_AUTO_SEND_ENABLED={block.get('flags', {}).get('luna_auto_send_enabled')})"
    )


def log_flag_block(block: Optional[Dict[str, Any]]) -> str:
    """Log a blocked send the way ``pause_gate`` logs a pause, and return the line.

    A silently dropped message is its own incident, so this is not optional and
    not debug-level: one structured ``logger.warning`` per suppressed send, in the
    same ``{"event": ...}`` shape ``pause_gate.py`` already emits.
    """
    if not block:
        return ""
    line = describe_flag_block(block)
    try:
        logger.warning(
            "%s",
            {
                "event": LOG_EVENT,
                "blocked_reason": block.get("blocked_reason"),
                "flag": block.get("flag"),
                "flag_value": block.get("flag_value"),
                "flag_note": block.get("flag_note"),
                "allow_value": block.get("allow_value"),
                "flags": block.get("flags"),
                "guest": block.get("guest"),
                "sent": False,
            },
        )
    except Exception:
        pass
    return line


def flag_block_raw_response(block: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """``SendResult.raw_response`` payload for a flag-suppressed send."""
    if not block:
        return {}
    return {
        SUPPRESSED_KEY: True,
        "blocked_reason": block.get("blocked_reason"),
        "flag": block.get("flag"),
    }
