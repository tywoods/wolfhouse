"""Luna Sunset Slice 2 — course inclusions + full-day structural upsell.

(a) lesson catalog / offering quote surface catalog equipment_options truth
    (free during-course when price 0; never invent wax/board when empty)
(b) full-day accept path maps full_day_equipment_addon → structured extension;
    notes-only rest-of-day is rejected
(c) SOUL ⊆ registered tools; no fixed inclusion lists in tool schemas

Run:
  python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_course_equipment_s2.py
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import wolfhouse_staff_api as mod  # noqa: E402

PASSED = 0
FAILED = 0
ROOT = Path(__file__).resolve().parents[4]


def check(name, cond, detail=""):
    global PASSED, FAILED
    if cond:
        PASSED += 1
        print("  PASS  " + name)
    else:
        FAILED += 1
        extra = (" - " + str(detail)) if detail not in ("", None) else ""
        print("  FAIL  " + name + extra)


class FakeBot:
    def __init__(self, responses=None):
        self.responses = responses or {}
        self.calls = []

    def __call__(self, path, payload):
        self.calls.append((path, dict(payload or {})))
        for key, value in self.responses.items():
            if key in path:
                return value(path, payload) if callable(value) else value
        return {"ok": False, "reason": "unmocked"}


print("\ntest_sunset_course_equipment_s2\n")

# ── (a) guest equipment truth ──────────────────────────────────────────────
truth_free = mod._project_guest_equipment_truth({
    "equipment_options": [
        {
            "offering_key": "board_and_suit_rental",
            "label": "Board + suit",
            "during_course_price_cents": 0,
            "all_day_price_cents": 1000,
        },
        {
            "offering_key": "surfboard",
            "label": "Surfboard only",
            "during_course_price_cents": 500,
            "all_day_price_cents": 1500,
        },
    ]
})
check("[a1] free during-course from 0€ option", truth_free["may_claim_free_during_course_gear"] is True, truth_free)
check(
    "[a1] free label is catalog label not wax",
    any(r.get("label") == "Board + suit" for r in truth_free["free_during_course"]),
    truth_free,
)
check(
    "[a1] never invents wax",
    not any("wax" in str(r.get("label") or "").lower() for r in truth_free["free_during_course"]),
    truth_free,
)
check(
    "[a1] paid option listed",
    any(r.get("offering_key") == "surfboard" for r in truth_free["paid_or_upgrade_options"]),
    truth_free,
)

truth_empty = mod._project_guest_equipment_truth({"equipment_options": []})
check("[a2] empty options → no free claim", truth_empty["may_claim_free_during_course_gear"] is False, truth_empty)
check("[a2] empty free list", truth_empty["free_during_course"] == [], truth_empty)

# Catalog tool attaches truth
fake = FakeBot({
    "/sunset/catalog": {
        "ok": True,
        "location_id": "sunset-somo",
        "currency": "EUR",
        "offerings": [
            {
                "offering_id": "course_beginner_3d",
                "offering_type": "course",
                "label": "Beginner 3 days",
                "equipment_options": [
                    {
                        "offering_key": "board_and_suit_rental",
                        "label": "Board + wetsuit",
                        "during_course_price_cents": 0,
                        "all_day_price_cents": 1000,
                    }
                ],
            },
            {
                "offering_id": "course_bare",
                "offering_type": "course",
                "label": "Bare course",
                "equipment_options": [],
            },
            {
                "offering_id": "board_rental__1_day",
                "offering_type": "rental",
                "label": "Board 1d",
            },
        ],
    }
})
mod._post_bot = fake  # type: ignore[attr-defined]
cat = json.loads(mod.get_sunset_lesson_catalog({"location_id": "sunset-somo"}))
check("[a3] catalog success", cat.get("success") is True, cat)
offs = {o.get("offering_id"): o for o in (cat.get("offerings") or []) if isinstance(o, dict)}
# rental rows filtered? lesson catalog keeps non-group_lesson; rentals may still appear - OK
beginner = offs.get("course_beginner_3d") or {}
bare = offs.get("course_bare") or {}
check("[a3] beginner may_claim_free_equipment", beginner.get("may_claim_free_equipment") is True, beginner)
check(
    "[a3] beginner free labels from catalog",
    "Board + wetsuit" in (beginner.get("free_included_equipment_labels") or []),
    beginner,
)
check("[a3] bare course no free claim", bare.get("may_claim_free_equipment") is False, bare)
check(
    "[a3] bare free labels empty",
    (bare.get("free_included_equipment_labels") or []) == [],
    bare,
)

# Offering quote attaches truth
fake_q = FakeBot({
    "/sunset/offering-quote": {
        "ok": True,
        "success": True,
        "offering_id": "course_beginner_3d",
        "total_cents": 12000,
        "equipment_options": [
            {
                "offering_key": "board_and_suit_rental",
                "label": "Board + wetsuit",
                "during_course_price_cents": 0,
                "all_day_price_cents": 1000,
            }
        ],
        "course_equipment": None,
        "line_items": [],
        "quote_provenance": {"quote_fingerprint": "fp1"},
    }
})
mod._post_bot = fake_q  # type: ignore[attr-defined]
q = json.loads(mod.get_sunset_offering_quote({"offering_id": "course_beginner_3d"}))
check("[a4] quote success", q.get("success") is True, q)
check("[a4] quote may_claim_free_equipment", q.get("may_claim_free_equipment") is True, q)
check(
    "[a4] quote free labels",
    "Board + wetsuit" in (q.get("free_included_equipment_labels") or []),
    q,
)

# ── (b) full-day structured path ───────────────────────────────────────────
fake_c = FakeBot({
    "/sunset/booking-create": {
        "success": True,
        "booking_id": "bk-fd-1",
        "booking_code": "SUN-FD-1",
        "total_cents": 4000,
        "currency": "EUR",
        "location_id": "sunset-somo",
    }
})
mod._post_bot = fake_c  # type: ignore[attr-defined]
out = json.loads(
    mod.create_sunset_booking(
        {
            "guest_name": "Full Day Guest",
            "guest_confirmed_booking": True,
            "location_id": "sunset-somo",
            "service_dates": ["2026-08-12"],
            "components": {
                "lesson": {"quantity": 1, "time_preference": "morning"},
                "full_day_equipment_addon": {"quantity": 1},
            },
        }
    )
)
check("[b1] full-day create succeeds", out.get("success") is True, out)
body = fake_c.calls[0][1] if fake_c.calls else {}
ext = (body.get("components") or {}).get("full_day_equipment_extension")
check(
    "[b2] addon mapped to structured extension",
    isinstance(ext, dict) and ext.get("enabled") is True and "2026-08-12" in (ext.get("dates") or {}),
    body,
)
check(
    "[b2] alias not left on wire",
    "full_day_equipment_addon" not in (body.get("components") or {}),
    body,
)

# notes-only rest-of-day rejected
fake_c.calls.clear()
out_notes = json.loads(
    mod.create_sunset_booking(
        {
            "guest_name": "Notes Guest",
            "guest_confirmed_booking": True,
            "location_id": "sunset-somo",
            "service_dates": ["2026-08-12"],
            "components": {"lesson": {"quantity": 1, "time_preference": "morning"}},
            "notes": "Please add rest of the day gear",
        }
    )
)
check(
    "[b3] notes-only rest-of-day rejected",
    out_notes.get("success") is False
    and out_notes.get("error") == "equipment_must_use_structured_fields",
    out_notes,
)
check("[b3] no booking-create for notes-only", not any("booking-create" in p for p, _ in fake_c.calls), fake_c.calls)

# ── (c) SOUL + schema hygiene ──────────────────────────────────────────────
soul = (ROOT / "docker/hermes-sunset/SOUL.md").read_text(encoding="utf-8")
check("[c1] SOUL forbids inventing wax/board when empty", "never invent wax" in soul.lower() or "never invent wax, board" in soul.lower())
check("[c2] SOUL full-day structural create", "full_day_equipment_addon" in soul)
check("[c3] SOUL may_claim_free_equipment", "may_claim_free_equipment" in soul)
check("[c4] SOUL no hardcoded wax inclusion fact", not re.search(r"wax are included|board, wetsuit and wax", soul, re.I))

prev = os.environ.get("LUNA_CLIENT_SLUG")
os.environ["LUNA_CLIENT_SLUG"] = "sunset"
try:
    names = {t[0] for t in list(mod._sunset_tools()) + list(mod._sunset_write_tools())}
finally:
    if prev is None:
        os.environ.pop("LUNA_CLIENT_SLUG", None)
    else:
        os.environ["LUNA_CLIENT_SLUG"] = prev

soul_tools = set(re.findall(r"\*\*(get_sunset_[a-z0-9_]+|flag_needs_human|create_sunset_[a-z0-9_]+)\*\*", soul))
soul_tools |= set(re.findall(r"`(get_sunset_[a-z0-9_]+|flag_needs_human|create_sunset_[a-z0-9_]+)`", soul))
unknown = sorted(t for t in soul_tools if t not in names)
check("[c5] SOUL tools ⊆ registered", not unknown, {"unknown": unknown, "soul": sorted(soul_tools)})

# tool schema ban on fixed inclusion menus
violations = []
for name, desc, _h, props, _r in list(mod._sunset_tools()) + list(mod._sunset_write_tools()):
    blob = desc or ""
    if isinstance(props, dict):
        for pv in props.values():
            if isinstance(pv, dict):
                blob += "\n" + str(pv.get("description") or "")
    if re.search(r"board, wetsuit and wax|board / wetsuit / board\+suit|1 hour, half day, 1 day, 2 days, 5 days, 7 days", blob, re.I):
        violations.append(name)
check("[c6] no hardcoded inclusion/duration menus in schemas", not violations, violations)

print(f"\nResults: {PASSED} passed, {FAILED} failed")
sys.exit(1 if FAILED else 0)
