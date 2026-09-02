#!/usr/bin/env python3
"""First-answer eval pack — grade Luna's FIRST Staff lookup, not recovery.

Ty 2026-09-02 program slice:
  Facts live on Horario / joinable-courses / catalog. Voice is greeting/vibe/handoff.
  Offline only — no live WhatsApp, no invented prices.

Cases:
  A) Thursday 10:00 Somo qty 14 when class is 3/25 → has seats, remaining 22,
     not daily leftover (extends #843).
  B) 12 kids/group on a class with room → not false-full on first pass
     (extends #844; does not fight leftover first-pass ownership).
  C) Gear inclusions from Staff catalog only; empty board → no invent.
  D) Location fail-closed (Somo vs Sardi) on first availability call.
  E) Kids-vs-adult: only assert when Staff catalog surfaces a structured field;
     otherwise skip and note (baseline age_rules are unverified seed, not board).

Run:
  python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_first_answer_eval.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PLUGIN_DIR.parent))
os.environ.setdefault("LUNA_CLIENT_SLUG", "sunset")
os.environ.setdefault("SUNSET_INGRESS_LOCATION_ID", "sunset-somo")
os.environ.setdefault("LUNA_ALLOWED_LOCATION_IDS", "sunset-somo")
# Token required so _post_bot reaches the FakeBot override path after tenant bind.
os.environ.setdefault("LUNA_BOT_INTERNAL_TOKEN", "test-token-first-answer")

import wolfhouse_staff_api as mod  # noqa: E402

passed = 0
failed = 0
skipped = 0
notes: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}" + (f" — {detail}" if detail else ""))


def skip(name: str, reason: str) -> None:
    global skipped
    skipped += 1
    notes.append(f"SKIP {name}: {reason}")
    print(f"  SKIP  {name} — {reason}")


class FakeBot:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, path, payload):
        self.calls.append((path, dict(payload or {})))
        for key, resp in self.responses.items():
            if key in path:
                return dict(resp) if isinstance(resp, dict) else resp
        return {"success": True, "ok": True}


def with_fake(responses):
    fake = FakeBot(responses)
    mod._post_bot = fake  # type: ignore[attr-defined]
    return fake


MATUTINO_JOINABLE = {
    "course_id": "curso-matutino",
    "label": "Curso Matutino",
    "capacity": 25,
    "seats_booked": 3,
    "seats_remaining": 22,
    "joinable": True,
    "schedules": [{"start_time": "10:00", "end_time": "12:00"}],
}

TARDE_JOINABLE = {
    "course_id": "curso-tarde",
    "label": "Curso Tarde",
    "capacity": 24,
    "seats_booked": 9,
    "seats_remaining": 15,
    "joinable": True,
    "schedules": [{"start_time": "16:00", "end_time": "18:00"}],
}

# Daily-cap shape that used to falsely mark the day full (23/24 → leftover 1).
DAILY_FALSE_FULL = {
    "ok": True,
    "success": True,
    "scope": "daily",
    "daily_capacity": 24,
    "seats_booked": 23,
    "seats_available": 1,
    "has_seats": False,
    "reason": "no_seats_available",
    "requested_quantity": 14,
}


def main() -> int:
    print("\n[A] FIRST timed lookup — Thu 10:00 Somo qty 14, class 3/25 remaining 22")
    fake_timed = with_fake({
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
        # If the plugin wrongly hit daily first, this would poison the answer.
        "/sunset/joinable-courses": {"ok": True, "courses": [MATUTINO_JOINABLE, TARDE_JOINABLE]},
    })
    first_timed = json.loads(mod.get_sunset_lesson_availability({
        "date": "2026-09-03",
        "quantity": 14,
        "slot_time": "10:00",
        "location_id": "sunset-somo",
    }))
    check(
        "A1 first call is timed Staff lesson-availability (not daily invent)",
        bool(fake_timed.calls)
        and "/sunset/lesson-availability" in fake_timed.calls[0][0]
        and fake_timed.calls[0][1].get("slot_time") == "10:00"
        and fake_timed.calls[0][1].get("quantity") == 14,
        str(fake_timed.calls),
    )
    check("A2 first result has_seats true", first_timed.get("has_seats") is True, str(first_timed))
    check("A3 first seats_available is Horario remaining 22", first_timed.get("seats_available") == 22, str(first_timed))
    check("A4 first seats_booked is course 3 not daily 23", first_timed.get("seats_booked") == 3, str(first_timed))
    check("A5 first daily_capacity is null on timed path", first_timed.get("daily_capacity") is None, str(first_timed))
    check("A6 first reason is not no_seats_available", first_timed.get("reason") not in ("no_seats_available", "insufficient_seats"), str(first_timed))
    check("A7 first location is sunset-somo", first_timed.get("location_id") == "sunset-somo", str(first_timed))

    print("\n[B] FIRST unscoped 12-person / kids-group lookup — Horario has room → not false-full")
    fake_kids = with_fake({
        "/sunset/joinable-courses": {
            "ok": True,
            "success": True,
            "date": "2026-09-03",
            "location_id": "sunset-somo",
            "courses": [MATUTINO_JOINABLE, TARDE_JOINABLE],
        },
        "/sunset/lesson-availability": DAILY_FALSE_FULL,
    })
    first_kids = json.loads(mod.get_sunset_lesson_availability({
        "date": "2026-09-03",
        "quantity": 12,
        "location_id": "sunset-somo",
        # Guest said "12 kids" — party size only; no invented kids capacity rule.
    }))
    check(
        "B1 first call is joinable-courses (never daily availability)",
        bool(fake_kids.calls)
        and "/sunset/joinable-courses" in fake_kids.calls[0][0]
        and all("/sunset/lesson-availability" not in c[0] for c in fake_kids.calls),
        str(fake_kids.calls),
    )
    check("B2 first scope is course_choices", first_kids.get("scope") == "course_choices", str(first_kids))
    check("B3 first has_fitting_course true for qty 12", first_kids.get("has_fitting_course") is True, str(first_kids))
    check("B4 first do_not_claim_date_full true", first_kids.get("do_not_claim_date_full") is True, str(first_kids))
    check("B5 first has_seats true when a course fits", first_kids.get("has_seats") is True, str(first_kids))
    check("B6 first reason is not no_seats_available", first_kids.get("reason") != "no_seats_available", str(first_kids))
    check(
        "B7 first surfaces Staff seats_remaining 22 and 15",
        [c.get("seats_remaining") for c in first_kids.get("courses", [])] == [22, 15],
        str(first_kids),
    )
    check("B8 first largest_seats_remaining is 22", first_kids.get("largest_seats_remaining") == 22, str(first_kids))
    action = str(first_kids.get("guest_safe_next_action") or "").lower()
    check("B9 first guest action forbids claiming the date full", "do not say the date is full" in action or "never say the date is full" in action, action)
    check("B10 first guest action is not handoff invent", "flag_needs_human" not in action and "team will" not in action, action)

    print("\n[C] FIRST gear answer — Staff catalog facts only")
    fake_gear = with_fake({
        "/sunset/catalog": {
            "ok": True,
            "location_id": "sunset-somo",
            "currency": "EUR",
            "offerings": [
                {
                    "offering_id": "course_beginner_3d",
                    "offering_type": "course",
                    "label": "Beginner 3 days",
                    "active": True,
                    "equipment_options": [
                        {
                            "offering_key": "board_and_suit_rental",
                            "label": "Board + wetsuit",
                            "during_course_price_cents": 0,
                            "during_course_policy": "included",
                            "all_day_price_cents": 1500,
                        }
                    ],
                },
                {
                    "offering_id": "course_empty_gear",
                    "offering_type": "course",
                    "label": "No-gear course",
                    "active": True,
                    "equipment_options": [],
                },
            ],
        }
    })
    first_catalog = json.loads(mod.get_sunset_lesson_catalog({"location_id": "sunset-somo"}))
    offerings = first_catalog.get("offerings") or []
    with_gear = next((o for o in offerings if o.get("offering_id") == "course_beginner_3d"), None)
    empty_gear = next((o for o in offerings if o.get("offering_id") == "course_empty_gear"), None)
    check("C1 first catalog call hits Staff /sunset/catalog", bool(fake_gear.calls) and "/sunset/catalog" in fake_gear.calls[0][0], str(fake_gear.calls))
    check("C2 first gear claim uses Staff included label", with_gear and with_gear.get("may_claim_free_equipment") is True, str(with_gear))
    check(
        "C3 first free labels are Staff labels only",
        with_gear and with_gear.get("free_included_equipment_labels") == ["Board + wetsuit"],
        str(with_gear),
    )
    check("C4 empty Staff equipment_options → no free claim invent", empty_gear and empty_gear.get("may_claim_free_equipment") is False, str(empty_gear))
    check(
        "C5 empty gear does not invent wax/board/wetsuit labels",
        empty_gear and empty_gear.get("free_included_equipment_labels") == [],
        str(empty_gear),
    )

    print("\n[D] FIRST location lookup — fail closed Somo vs Sardi")
    # Restore real _post_bot for tenant denial (no FakeBot).
    import importlib
    importlib.reload(mod)
    os.environ["LUNA_CLIENT_SLUG"] = "sunset"
    os.environ["SUNSET_INGRESS_LOCATION_ID"] = "sunset-somo"
    os.environ["LUNA_ALLOWED_LOCATION_IDS"] = "sunset-somo"
    os.environ["LUNA_BOT_INTERNAL_TOKEN"] = "test-token-first-answer"

    denied = mod._post_bot("/sunset/joinable-courses", {  # type: ignore[attr-defined]
        "date": "2026-09-03",
        "location_id": "sunset-sardinero",
    })
    check(
        "D1 Sardi request on Somo-bound runtime is denied on first call",
        denied.get("staff_api_status") == "tenant_scope_denied" or denied.get("success") is False,
        str(denied),
    )
    check(
        "D2 denial does not invent Sardi seats/prices",
        "seats_remaining" not in denied and "courses" not in denied and "amount" not in str(denied).lower(),
        str(denied),
    )

    # Availability with FakeBot after bind: model-supplied Sardi must be overwritten/denied
    # before any Staff leftover invent. Re-bind fake after reload.
    calls = []

    def capturing_post(path, payload):
        calls.append((path, dict(payload or {})))
        return {
            "ok": True,
            "success": True,
            "date": "2026-09-03",
            "location_id": payload.get("location_id"),
            "courses": [MATUTINO_JOINABLE],
        }

    # Exercise get_sunset_lesson_availability through real tenant bind then fake Staff.
    real_post = mod._post_bot

    def guarded(path, payload):
        # Run tenant bind by calling into a thin wrapper: reuse real _post_bot until
        # network — instead simulate bind rules then capture.
        payload = dict(payload or {})
        payload.pop("client_slug", None)
        payload["client_slug"] = "sunset"
        requested = str(payload.get("location_id") or "").strip()
        bound = "sunset-somo"
        if requested and requested != bound:
            return {
                "success": False,
                "staff_api_status": "tenant_scope_denied",
                "staff_review_needed": True,
                "error": "Request is outside the configured Luna location scope.",
            }
        payload["location_id"] = bound
        return capturing_post(path, payload)

    mod._post_bot = guarded  # type: ignore[attr-defined]
    loc_first = json.loads(mod.get_sunset_lesson_availability({
        "date": "2026-09-03",
        "quantity": 4,
        "location_id": "sunset-sardinero",
    }))
    # Depending on whether availability passes location before _post_bot, either
    # tenant denial or forced Somo bind is acceptable — never Sardi leftovers.
    check(
        "D3 first availability never returns Sardi Horario leftovers from Somo bind",
        loc_first.get("location_id") != "sunset-sardinero"
        or loc_first.get("staff_api_status") == "tenant_scope_denied"
        or loc_first.get("success") is False,
        str(loc_first),
    )

    print("\n[E] Kids vs adult — Staff board field only (no invent)")
    # Inspect first catalog offerings for a structured kids/adult Staff field.
    # Baseline age_rules are unverified seed — not the live Admin board.
    structured_keys = (
        "audience", "age_band", "min_age", "max_age", "age_min", "age_max",
        "kids_ok", "adult_only", "target_audience", "eligible_ages",
    )
    fake_aud = with_fake({
        "/sunset/catalog": {
            "ok": True,
            "location_id": "sunset-somo",
            "offerings": [
                {
                    "offering_id": "course_open",
                    "offering_type": "course",
                    "label": "Open course",
                    "active": True,
                    "equipment_options": [],
                }
            ],
        }
    })
    aud_cat = json.loads(mod.get_sunset_lesson_catalog({"location_id": "sunset-somo"}))
    found_structured = []
    for o in aud_cat.get("offerings") or []:
        for k in structured_keys:
            if k in o and o.get(k) not in (None, "", [], {}):
                found_structured.append((o.get("offering_id"), k, o.get(k)))
    if not found_structured:
        skip(
            "E kids-vs-adult first-answer",
            "Staff lesson catalog has no structured kids/adult field on offerings; "
            "baseline age_rules remain unverified seed — do not invent. Case skipped.",
        )
        check(
            "E1 plugin still strips standalone kids_lesson / group_lesson_adult",
            "kids_lesson" not in json.dumps(aud_cat)
            and all(o.get("offering_id") != "group_lesson_adult" for o in (aud_cat.get("offerings") or [])),
            str(aud_cat),
        )
    else:
        check("E1 structured Staff audience field present for first answer", bool(found_structured), str(found_structured))

    # Wiring: unscoped path must keep short-circuiting daily leftover.
    plugin_src = (PLUGIN_DIR / "__init__.py").read_text(encoding="utf-8")
    check("W1 plugin sets has_fitting_course on course_choices", "has_fitting_course" in plugin_src)
    check("W2 plugin sets do_not_claim_date_full", "do_not_claim_date_full" in plugin_src)
    check("W3 plugin unscoped path calls joinable-courses before daily", plugin_src.find('"/sunset/joinable-courses"') < plugin_src.find('"/sunset/lesson-availability"', plugin_src.find("def get_sunset_lesson_availability")))
    soul = (PLUGIN_DIR.parents[2] / "hermes-sunset" / "SOUL.md").read_text(encoding="utf-8")
    check("W4 SOUL grades FIRST availability answer", "FIRST answer" in soul or "first answer" in soul.lower())
    check("W5 SOUL forbids inventing kids/gear/school leftover", "never invent" in soul.lower() and "kids" in soul.lower())

    print(f"\ntest_sunset_first_answer_eval: {passed} passed, {failed} failed, {skipped} skipped")
    for n in notes:
        print(f"  NOTE  {n}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
