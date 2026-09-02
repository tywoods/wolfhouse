#!/usr/bin/env python3
"""RED/GREEN: 15-person bookings use Staff API remaining-seat capacity.

SUNSET-LUNA-LIVE-TEST-001 defect 2:
  If 15 fits, proceed through the normal booking flow.
  If it does not fit, state the authoritative remaining seats and offer another slot.
  Party size 15 alone must never cause handoff.

Capacity numbers come from the Staff API mock — never hardcoded inventory.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PLUGIN_DIR.parent))
os.environ.setdefault("LUNA_CLIENT_SLUG", "sunset")

import wolfhouse_staff_api as mod  # noqa: E402

passed = 0
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}" + (f" — {detail}" if detail else ""))


class FakeBot:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, path, payload):
        self.calls.append((path, dict(payload or {})))
        for key, resp in self.responses.items():
            if key in path:
                return dict(resp)
        return {"success": True}


def with_fake(responses):
    fake = FakeBot(responses)
    mod._post_bot = fake  # type: ignore[attr-defined]
    return fake


def main() -> int:
    print("\n[A] 15 fits — authoritative has_seats, normal booking, no handoff")
    fake_fit = with_fake({
        "/sunset/lesson-availability": {
            "ok": True,
            "success": True,
            "date": "2026-07-20",
            "location_id": "sunset-somo",
            "capacity_known": True,
            "daily_capacity": 20,
            "seats_booked": 2,
            "seats_available": 18,
            "requested_quantity": 15,
            "has_seats": True,
            "take_request": False,
            "reason": None,
        },
    })
    fit = json.loads(mod.get_sunset_lesson_availability({"date": "2026-07-20", "quantity": 15, "slot_time": "10:00"}))
    check("forwards quantity 15 to Staff API", fake_fit.calls and fake_fit.calls[0][1].get("quantity") == 15, str(fake_fit.calls))
    check("15-fit has_seats true", fit.get("has_seats") is True, str(fit))
    check("15-fit take_request false", fit.get("take_request") is False, str(fit))
    check("15-fit does not escalate", fit.get("do_not_escalate") is True and fit.get("staff_review_needed") is False, str(fit))
    check("15-fit surfaces remaining seats from API", fit.get("seats_available") == 18, str(fit))
    check("15-fit requested_quantity 15", fit.get("requested_quantity") == 15, str(fit))
    action_fit = str(fit.get("guest_safe_next_action") or "")
    check("15-fit does not send team/handoff copy", not action_fit or ("team" not in action_fit.lower() and "human" not in action_fit.lower()), action_fit)

    print("\n[B] 15 does not fit — state remaining seats, offer another slot, no handoff")
    fake_short = with_fake({
        "/sunset/lesson-availability": {
            "ok": True,
            "success": True,
            "date": "2026-07-21",
            "location_id": "sunset-somo",
            "capacity_known": True,
            "daily_capacity": 12,
            "seats_booked": 4,
            "seats_available": 8,
            "requested_quantity": 15,
            "has_seats": False,
            "take_request": True,
            "reason": "insufficient_seats",
        },
    })
    short = json.loads(mod.get_sunset_lesson_availability({"date": "2026-07-21", "quantity": 15, "slot_time": "10:00"}))
    check("shortfall still forwards quantity 15", fake_short.calls and fake_short.calls[0][1].get("quantity") == 15)
    check("shortfall has_seats false", short.get("has_seats") is False, str(short))
    check("shortfall remaining seats from API (8)", short.get("seats_available") == 8, str(short))
    check("shortfall does not escalate", short.get("do_not_escalate") is True and short.get("staff_review_needed") is False, str(short))
    check("shortfall is not a take_request handoff", short.get("take_request") is False, str(short))
    action = str(short.get("guest_safe_next_action") or "")
    check("shortfall copy states remaining seats 8", "8" in action, action)
    check("shortfall copy offers another slot/date", any(w in action.lower() for w in ("another", "other", "different", "otra", "otro")), action)
    check("shortfall copy does not invent a hardcoded cap", "12" not in action and "daily_capacity" not in action.lower(), action)
    check("shortfall copy does not promise a human/team takeover", "human" not in action.lower() and "team will" not in action.lower() and "needs_human" not in action.lower(), action)

    print("\n[B2] Timed class — forwards slot_time so Staff uses Horario leftover")
    fake_slot = with_fake({
        "/sunset/lesson-availability": {
            "ok": True,
            "success": True,
            "date": "2026-09-03",
            "location_id": "sunset-somo",
            "capacity_known": True,
            "scope": "course_slot",
            "course_capacity": 25,
            "daily_capacity": None,
            "seats_booked": 3,
            "seats_available": 22,
            "requested_quantity": 14,
            "has_seats": True,
            "take_request": False,
            "reason": None,
            "slot_time": "10:00",
            "course_id": "curso-matutino",
        },
    })
    timed = json.loads(mod.get_sunset_lesson_availability({
        "date": "2026-09-03",
        "quantity": 14,
        "slot_time": "10:00",
    }))
    check(
        "forwards slot_time 10:00 to Staff API",
        fake_slot.calls and fake_slot.calls[0][1].get("slot_time") == "10:00",
        str(fake_slot.calls),
    )
    check("timed path has_seats true with Horario remaining 22", timed.get("has_seats") is True and timed.get("seats_available") == 22, str(timed))
    check("timed path surfaces course_capacity not daily invent", timed.get("course_capacity") == 25 and timed.get("daily_capacity") is None, str(timed))
    check("timed path surfaces slot_time", timed.get("slot_time") == "10:00", str(timed))

    print("\n[B3] Unspecified time — use joinable-course leftovers, never whole-day capacity")
    fake_unspecified = with_fake({
        "/sunset/joinable-courses": {
            "ok": True,
            "success": True,
            "date": "2026-09-03",
            "location_id": "sunset-somo",
            "courses": [
                {
                    "course_id": "curso-matutino",
                    "label": "Curso Matutino",
                    "capacity": 25,
                    "seats_booked": 3,
                    "seats_remaining": 22,
                    "joinable": True,
                    "schedules": [{"start_time": "10:00", "end_time": "12:00"}],
                },
                {
                    "course_id": "curso-tarde",
                    "label": "Curso Tarde",
                    "capacity": 24,
                    "seats_booked": 9,
                    "seats_remaining": 15,
                    "joinable": True,
                    "schedules": [{"start_time": "16:00", "end_time": "18:00"}],
                },
            ],
        },
        "/sunset/lesson-availability": {
            "ok": True,
            "success": True,
            "scope": "daily",
            "daily_capacity": 24,
            "seats_booked": 41,
            "seats_available": 0,
            "has_seats": False,
            "reason": "no_seats_available",
        },
    })
    unspecified = json.loads(mod.get_sunset_lesson_availability({
        "date": "2026-09-03",
        "quantity": 12,
        "location_id": "sunset-somo",
    }))
    check("unscoped check calls joinable-courses first", bool(fake_unspecified.calls) and "/sunset/joinable-courses" in fake_unspecified.calls[0][0], str(fake_unspecified.calls))
    check("unscoped check never calls daily availability", all("/sunset/lesson-availability" not in call[0] for call in fake_unspecified.calls), str(fake_unspecified.calls))
    check("unscoped check requires course selection", unspecified.get("requires_course_selection") is True, str(unspecified))
    check("unscoped check returns authoritative course choices", [c.get("seats_remaining") for c in unspecified.get("courses", [])] == [22, 15], str(unspecified))
    check("unscoped check cannot claim the date is full", unspecified.get("reason") != "no_seats_available" and unspecified.get("has_seats") is not False, str(unspecified))
    check("unscoped check marks has_fitting_course for qty 12", unspecified.get("has_fitting_course") is True, str(unspecified))
    check("unscoped check sets do_not_claim_date_full", unspecified.get("do_not_claim_date_full") is True, str(unspecified))

    print("\n[C] Party size 15 alone is never a handoff reason")
    soul = (PLUGIN_DIR.parents[2] / "hermes-sunset" / "SOUL.md").read_text(encoding="utf-8")
    check("Sunset SOUL does not hand off for group size alone", "group beyond what you can handle" not in soul)
    check("Sunset SOUL uses remaining seats for oversize parties", "remaining seat" in soul.lower() or "seats left" in soul.lower() or "seats_available" in soul)
    plugin_src = (PLUGIN_DIR / "__init__.py").read_text(encoding="utf-8")
    avail_desc_idx = plugin_src.find('("get_sunset_lesson_availability"')
    avail_desc = plugin_src[avail_desc_idx:avail_desc_idx + 1600] if avail_desc_idx != -1 else ""
    check(
        "tool description: if it fits, book; if not, remaining seats + other slot",
        "remaining" in avail_desc.lower() and "flag_needs_human" in avail_desc and "party size" in avail_desc.lower(),
        avail_desc[:200],
    )
    check(
        "tool description forbids handoff for party size 15 alone",
        "never" in avail_desc.lower() and ("party" in avail_desc.lower() or "quantity" in avail_desc.lower()),
        avail_desc[:200],
    )

    print(f"\ntest_sunset_party_capacity: {passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
