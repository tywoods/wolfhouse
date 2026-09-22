"""Shared Wolfhouse room eligibility. A name hint is not biological sex.

The Luna model may supply a provisional name interpretation. This module only
validates that hint and decides which room options may be offered or booked.
It does not call a gender API, keep a name dictionary, or store a verified
demographic fact.
"""
from __future__ import annotations

import math
from typing import Any, Dict, Iterable, List, Optional

PROVISIONAL_HINT_THRESHOLD = 0.70
_HINTS = {"male", "female"}
_PRIVATE = {"private", "couple_private", "couple", "private_room"}
_NEUTRAL_PROMPT = "Would a mixed dorm work for you?"
_GROUP_PROMPT = "Is your group all girls, all guys, or a mix?"


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _token(value: Any) -> str:
    return _clean(value).lower().replace("-", "_").replace(" ", "_")


def _valid_confidence(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            value = float(text)
        except ValueError:
            return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < 0 or number > 1:
        return None
    return number


def _hint(value: Any) -> str:
    token = _token(value)
    if token in {"male", "m", "man", "guy", "guys"}:
        return "male"
    if token in {"female", "f", "woman", "girl", "girls"}:
        return "female"
    if token in {"mixed", "mix"}:
        return "mixed"
    return "unknown"


def _explicit(value: Any) -> str:
    hint = _hint(value)
    return hint if hint in {"male", "female", "mixed"} else ""


def _traveler_rows(travelers: Optional[Iterable[Dict[str, Any]]], fallback: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = [row for row in (travelers or []) if isinstance(row, dict)]
    if rows:
        return rows
    if any(fallback.get(key) not in (None, "") for key in ("name", "hint", "confidence", "explicit_gender")):
        return [fallback]
    return []


def _provisional(row: Dict[str, Any]) -> str:
    if row.get("ambiguous") is True:
        return "unknown"
    explicit = _explicit(row.get("explicit_gender") or row.get("explicit_statement"))
    if explicit:
        return explicit
    confidence = _valid_confidence(row.get("confidence"))
    hint = _hint(row.get("hint") or row.get("name_hint"))
    if confidence is None or confidence < PROVISIONAL_HINT_THRESHOLD or hint not in _HINTS:
        return "unknown"
    return hint


def _availability_flags(available: Optional[Dict[str, Any]]) -> Dict[str, bool]:
    data = available if isinstance(available, dict) else {}
    def flag(name: str, default: bool = True) -> bool:
        if name not in data or data.get(name) is None:
            return default
        return bool(data.get(name))
    return {
        "female_only": flag("female_only", flag("girls_room_available", True)),
        "male_only": flag("male_only", True),
        "mixed": flag("mixed", flag("shared", True)),
        "private": flag("private", flag("private_room_available", False)),
    }


def decide_room_eligibility(
    *,
    guest_count: int = 1,
    travelers: Optional[Iterable[Dict[str, Any]]] = None,
    name: str = "",
    hint: Any = None,
    confidence: Any = None,
    ambiguous: bool = False,
    explicit_gender: Any = None,
    room_preference: Any = None,
    private_room_chosen: bool = False,
    available: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Return allowed options and whether one neutral clarification is required."""
    count = max(1, int(guest_count or 1))
    preference = _token(room_preference)
    flags = _availability_flags(available)
    private = private_room_chosen or preference in _PRIVATE
    rows = _traveler_rows(travelers, {
        "name": name,
        "hint": hint,
        "confidence": confidence,
        "ambiguous": ambiguous,
        "explicit_gender": explicit_gender,
    })
    statement = _explicit(explicit_gender)
    if not statement:
        for row in rows:
            statement = _explicit(row.get("explicit_gender") or row.get("explicit_statement"))
            if statement:
                break

    base = {
        "threshold": PROVISIONAL_HINT_THRESHOLD,
        "provisional": statement == "",
        "not_a_verified_demographic": True,
        "resolved_composition": statement or "unknown",
        "clarification_needed": False,
        "clarification_prompt": None,
        "conflict": None,
        "needs_human": False,
        "do_not_escalate": True,
        "allowed_room_preferences": [],
        "excluded_room_preferences": [],
    }

    if private:
        allowed = ["private", "couple_private"] if flags["private"] else ["mixed", "shared"]
        return {
            **base,
            "resolved_composition": statement or "unknown",
            "clarification_needed": False,
            "allowed_room_preferences": allowed,
            "excluded_room_preferences": ["female_only", "male_only"],
            "private_room": True,
        }

    interpreted = [_provisional({**row, "explicit_gender": statement or row.get("explicit_gender")}) for row in rows]
    if statement:
        interpreted = [statement]
    known = [item for item in interpreted if item in _HINTS or item == "mixed"]
    unknown = count > len(rows) or any(item == "unknown" for item in interpreted) or not rows

    conflict = None
    hint_composition = statement
    if not hint_composition and count == 1 and rows:
        hinted = _provisional(rows[0])
        if hinted in _HINTS:
            hint_composition = hinted
    if hint_composition == "male" and preference == "female_only":
        conflict = "female_only_overrides_explicit_male" if statement == "male" else "female_only_conflicts_with_male_hint"
    elif hint_composition == "female" and preference == "male_only":
        conflict = "male_only_overrides_explicit_female" if statement == "female" else "male_only_conflicts_with_female_hint"

    if conflict:
        allowed = _eligible_options("male" if hint_composition == "male" else "female", flags)
        allowed = [item for item in allowed if item not in {"female_only", "male_only"} or item.startswith(hint_composition)]
        return {
            **base,
            "provisional": statement == "",
            "resolved_composition": hint_composition,
            "clarification_needed": True,
            "clarification_prompt": _recovery_prompt(allowed),
            "conflict": conflict,
            "needs_human": False,
            "do_not_escalate": True,
            "allowed_room_preferences": allowed,
            "excluded_room_preferences": ["female_only" if hint_composition == "male" else "male_only"],
        }

    if not statement and (unknown or (count >= 2 and len(known) < count)):
        return {
            **base,
            "resolved_composition": "unknown",
            "clarification_needed": True,
            "clarification_prompt": _NEUTRAL_PROMPT if count == 1 else _GROUP_PROMPT,
            "allowed_room_preferences": [item for item in ("mixed", "shared") if flags["mixed"]],
            "excluded_room_preferences": ["female_only", "male_only"],
        }

    if count >= 2 and not statement:
        hints = [item for item in interpreted if item in _HINTS]
        if len(hints) == count and len(set(hints)) == 1:
            composition = hints[0]
        elif len(hints) == count:
            composition = "mixed"
        else:
            composition = "unknown"
    else:
        composition = statement or (known[0] if known else "unknown")

    if composition == "unknown":
        return {
            **base,
            "clarification_needed": True,
            "clarification_prompt": _NEUTRAL_PROMPT if count == 1 else _GROUP_PROMPT,
            "allowed_room_preferences": [item for item in ("mixed", "shared") if flags["mixed"]],
            "excluded_room_preferences": ["female_only", "male_only"],
        }

    allowed = _eligible_options(composition, flags)
    excluded = [item for item in ("female_only", "male_only", "mixed", "shared") if item not in allowed and item in {"female_only", "male_only"}]
    if composition == "mixed":
        excluded = ["female_only", "male_only"]
    elif composition == "male":
        excluded = ["female_only"]
    elif composition == "female":
        excluded = ["male_only"]
    return {
        **base,
        "provisional": statement == "",
        "resolved_composition": composition,
        "clarification_needed": False,
        "allowed_room_preferences": allowed,
        "excluded_room_preferences": excluded,
    }


def _recovery_prompt(allowed: List[str]) -> str:
    """One neutral re-offer. Never a team handoff and never a sex claim."""
    choices: List[str] = []
    if "mixed" in allowed or "shared" in allowed:
        choices.append("a mixed or shared dorm")
    if "male_only" in allowed:
        choices.append("a guys room")
    if "female_only" in allowed:
        choices.append("a girls room")
    if not choices:
        return _NEUTRAL_PROMPT
    if len(choices) == 1:
        offered = choices[0]
    else:
        offered = ", ".join(choices[:-1]) + " or " + choices[-1]
    return (
        "That room would not work for this booking. "
        + offered[0].upper() + offered[1:]
        + " would — which would you like?"
    )


def _eligible_options(composition: str, flags: Dict[str, bool]) -> List[str]:
    options: List[str] = []
    if composition == "female" and flags["female_only"]:
        options.append("female_only")
    if composition == "male" and flags["male_only"]:
        options.append("male_only")
    if flags["mixed"] and composition in {"male", "female", "mixed"}:
        options.extend(["mixed", "shared"])
    if composition == "female" and not flags["female_only"] and flags["mixed"]:
        options = ["mixed", "shared"]
    if composition == "male" and not flags["mixed"] and flags["male_only"]:
        options = ["male_only"]
    # Deduplicate while preserving order.
    seen = []
    for item in options:
        if item not in seen:
            seen.append(item)
    return seen
