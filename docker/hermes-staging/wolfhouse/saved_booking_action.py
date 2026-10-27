"""Saved-booking guest intent: cancel unpaid vs date-change vs paid handoff.

One owner for EN/ES/IT. A generic team handoff is not the unpaid-cancel or
date-change path. Staff's unpaid-cancel refusal is the only paid-handoff gate.
"""
from __future__ import annotations

from contextvars import ContextVar
import re
from typing import Any, Optional, Tuple

_guest_text: ContextVar[str] = ContextVar("saved_booking_guest_text", default="")
_cancel_unpaid: ContextVar[Optional[dict]] = ContextVar("saved_booking_cancel_unpaid", default=None)
_date_change: ContextVar[Optional[dict]] = ContextVar("saved_booking_date_change", default=None)

_CANCEL_VERB = re.compile(
    r"\b(?:cancel+\w*|anular\w*|anul[ae]\w*|annull\w*|cancell\w*)\b",
    re.I,
)
_BOOKING_NOUN = re.compile(
    r"\b(?:booking|reservation|reserva|prenotazione|estancia|soggiorno)\b",
    re.I,
)
_ADD_ON_NOUN = re.compile(
    r"\b(?:shuttle|traslado|navetta|transfer|breakfast|desayuno|colazione)\b",
    re.I,
)
_DATE_CHANGE_VERB = re.compile(
    r"\b(?:change|cambiar|cambie|muev\w*|mover|reschedule|spost\w*|modific\w*)\b",
    re.I,
)
_DATE_HINT = re.compile(
    r"\b(?:dates?|fechas?|date\b|"
    r"jan(?:uary)?|ene(?:ro)?|gennaio|"
    r"feb(?:ruary|braio)?|"
    r"mar(?:ch|zo|zo)?|"
    r"apr(?:il)?|abr(?:il)?|"
    r"may|mayo|maggio|"
    r"jun(?:e|io)?|giugno|"
    r"jul(?:y)?|jul(?:io)?|luglio|"
    r"aug(?:ust)?|ago(?:sto)?|"
    r"sep(?:t(?:ember)?)?|set(?:tembre)?|"
    r"oct(?:ober)?|oct(?:ubre)?|ottobre|"
    r"nov(?:ember)?|nov(?:iembre)?|novembre|"
    r"dec(?:ember)?|dic(?:iembre|embre)?)\b"
    r"|\b\d{1,2}\s*[-–/]\s*\d{1,2}\b",
    re.I,
)


def bind_guest_turn_text(text: Optional[str]) -> None:
    _guest_text.set(str(text or ""))
    _cancel_unpaid.set(None)
    _date_change.set(None)


def clear_guest_turn_text() -> None:
    _guest_text.set("")
    _cancel_unpaid.set(None)
    _date_change.set(None)


def current_guest_turn_text() -> str:
    return _guest_text.get() or ""


def note_cancel_unpaid_result(result: Optional[dict]) -> None:
    _cancel_unpaid.set(dict(result) if isinstance(result, dict) else None)


def note_date_change_result(result: Optional[dict]) -> None:
    _date_change.set(dict(result) if isinstance(result, dict) else None)


def detect_saved_booking_action(text: Optional[str]) -> Optional[str]:
    raw = str(text or "").strip()
    if not raw:
        return None
    has_booking = bool(_BOOKING_NOUN.search(raw))
    has_addon = bool(_ADD_ON_NOUN.search(raw))
    has_cancel = bool(_CANCEL_VERB.search(raw))
    has_change = bool(_DATE_CHANGE_VERB.search(raw))
    has_date = bool(_DATE_HINT.search(raw))
    if has_change and (has_booking or has_date) and not has_cancel:
        return "date_change"
    if has_cancel and has_booking:
        return "cancel"
    if has_cancel and has_addon and not has_booking:
        return None
    if has_change and has_date:
        return "date_change"
    return None


def _staff_refused_unpaid_cancel(result: Optional[dict]) -> bool:
    if not isinstance(result, dict):
        return False
    if result.get("cancelled") is True or result.get("success") is True:
        return False
    return result.get("staff_review_needed") is True


def _staff_needs_human_for_dates(result: Optional[dict]) -> bool:
    if not isinstance(result, dict):
        return False
    if result.get("success") is True and result.get("write_performed") is True:
        return False
    return result.get("staff_review_needed") is True


def should_persist_handoff(reason: Optional[str] = None) -> Tuple[bool, Optional[str]]:
    """Return (persist?, next_action). Guest intent owns unpaid cancel / date-change."""
    del reason
    intent = detect_saved_booking_action(current_guest_turn_text())
    if intent == "cancel":
        if _staff_refused_unpaid_cancel(_cancel_unpaid.get()):
            return True, None
        return False, "cancel_unpaid_booking"
    if intent == "date_change":
        if _staff_needs_human_for_dates(_date_change.get()):
            return True, None
        return False, "quote_booking_date_change"
    return True, None
