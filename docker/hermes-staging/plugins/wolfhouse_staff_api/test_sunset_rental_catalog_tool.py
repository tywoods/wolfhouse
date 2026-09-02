"""Luna catalog-driven v2 — rental catalog tool surface.

Asserts:
  (a) get_sunset_rental_catalog returns configured rental items and reflects a newly-added item
  (b) no hardcoded item/duration rental menus remain in registered sunset tool descriptions
  (c) hermes-sunset SOUL references only tools that are actually registered for sunset

Run:
  python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_sunset_rental_catalog_tool.py
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
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, path, payload):
        self.calls.append((path, dict(payload or {})))
        for key, value in self.responses.items():
            if key in path:
                return value if not callable(value) else value(path, payload)
        return {"ok": False, "reason": "unmocked"}


print("\ntest_sunset_rental_catalog_tool\n")

base_offerings = [
    {
        "offering_id": "board_rental__half_day",
        "offering_type": "rental",
        "item_code": "board_rental__half_day",
        "tier_key": "half_day",
        "label": "Surfboard half day",
        "active": True,
    },
    {
        "offering_id": "wetsuit_rental__1_day",
        "offering_type": "rental",
        "item_code": "wetsuit_rental__1_day",
        "tier_key": "1_day",
        "label": "Wetsuit 1 day",
        "active": True,
    },
    {
        "offering_id": "course_abc",
        "offering_type": "course",
        "label": "4-day course",
        "active": True,
    },
    {
        "offering_id": "full_day_equipment_addon",
        "offering_type": "addon",
        "label": "Rest of day gear",
        "active": True,
    },
]

# [a1] catalogs configured rentals only
fake = FakeBot({
    "/sunset/catalog": {
        "ok": True,
        "location_id": "sunset-somo",
        "currency": "EUR",
        "source": "admin",
        "offerings": list(base_offerings),
    }
})
mod._post_bot = fake  # type: ignore[attr-defined]
out = json.loads(mod.get_sunset_rental_catalog({"location_id": "sunset-somo"}))
check("[a1] success", out.get("success") is True, out)
check("[a1] hits /sunset/catalog", any("/sunset/catalog" in p for p, _ in fake.calls), fake.calls)
items = out.get("items") or []
item_keys = {i.get("item") for i in items if isinstance(i, dict)}
check("[a1] board_rental present", "board_rental" in item_keys, items)
check("[a1] wetsuit_rental present", "wetsuit_rental" in item_keys, items)
check("[a1] course excluded", "course_abc" not in item_keys and not any("course" == i.get("item") for i in items), items)
check("[a1] full-day addon excluded", not any("full_day" in str(i.get("item") or "") for i in items), items)
board = next((i for i in items if i.get("item") == "board_rental"), {})
check("[a1] board durations from catalog", "half_day" in (board.get("durations") or []), board)

# [a2] newly-added foil_board_rental appears
fake2 = FakeBot({
    "/sunset/catalog": {
        "ok": True,
        "location_id": "sunset-somo",
        "offerings": base_offerings + [
            {
                "offering_id": "foil_board_rental__1_day",
                "offering_type": "rental",
                "item_code": "foil_board_rental__1_day",
                "tier_key": "1_day",
                "label": "Foil board 1 day",
                "active": True,
            }
        ],
    }
})
mod._post_bot = fake2  # type: ignore[attr-defined]
out2 = json.loads(mod.get_sunset_rental_catalog({}))
keys2 = {i.get("item") for i in (out2.get("items") or [])}
check("[a2] newly-added foil_board_rental offered", "foil_board_rental" in keys2, out2.get("items"))
foil = next((i for i in out2.get("items") or [] if i.get("item") == "foil_board_rental"), {})
check("[a2] foil duration 1_day", "1_day" in (foil.get("durations") or []), foil)

# [a3] removed item not offered
fake3 = FakeBot({
    "/sunset/catalog": {
        "ok": True,
        "offerings": [o for o in base_offerings if "wetsuit" not in str(o.get("item_code") or "")],
    }
})
mod._post_bot = fake3  # type: ignore[attr-defined]
out3 = json.loads(mod.get_sunset_rental_catalog({}))
keys3 = {i.get("item") for i in (out3.get("items") or [])}
check("[a3] removed wetsuit not offered", "wetsuit_rental" not in keys3, out3.get("items"))

# [a4] SAME-DESK-001: disabled rental never offered even if Staff API leaked it
fake4 = FakeBot({
    "/sunset/catalog": {
        "ok": True,
        "location_id": "sunset-somo",
        "offerings": [
            {
                "offering_id": "kayak_rental__1_day",
                "offering_type": "rental",
                "item_code": "kayak_rental__1_day",
                "tier_key": "1_day",
                "label": "Kayak Pro",
                "active": True,
                "unit_amount_cents": 4500,
            },
            {
                "offering_id": "board_rental__1_day",
                "offering_type": "rental",
                "item_code": "board_rental__1_day",
                "tier_key": "1_day",
                "label": "Old Board",
                "active": False,
                "unit_amount_cents": 1500,
            },
        ],
    }
})
mod._post_bot = fake4  # type: ignore[attr-defined]
out4 = json.loads(mod.get_sunset_rental_catalog({}))
keys4 = {i.get("item") for i in (out4.get("items") or [])}
check("[a4] live kayak offered", "kayak_rental" in keys4, out4.get("items"))
check("[a4] disabled board_rental excluded", "board_rental" not in keys4, out4.get("items"))

# [a5] SAME-DESK-001: disabled course never offered from lesson catalog
fake5 = FakeBot({
    "/sunset/catalog": {
        "ok": True,
        "location_id": "sunset-somo",
        "offerings": [
            {
                "offering_id": "surf_pack_live__1_week",
                "offering_type": "course",
                "course_id": "live-course",
                "label": "Weekend Intensive",
                "active": True,
                "unit_amount_cents": 19900,
            },
            {
                "offering_id": "surf_pack_dead__1_week",
                "offering_type": "course",
                "course_id": "dead-course",
                "label": "Old Kids Camp",
                "active": False,
                "unit_amount_cents": 13000,
            },
        ],
    }
})
mod._post_bot = fake5  # type: ignore[attr-defined]
out5 = json.loads(mod.get_sunset_lesson_catalog({}))
off5 = out5.get("offerings") or []
check("[a5] live course offered", any(o.get("course_id") == "live-course" for o in off5), off5)
check("[a5] disabled course excluded", not any(
    o.get("course_id") == "dead-course" or "old kids" in str(o.get("label") or "").lower()
    for o in off5
), off5)

# [a6] SAME-DESK-001: serialized inactive flags (false/"false"/0/"0") never offered
for raw, name in ((False, "false-bool"), ("false", "false-str"), (0, "zero-int"), ("0", "zero-str")):
    fake_inactive = FakeBot({
        "/sunset/catalog": {
            "ok": True,
            "location_id": "sunset-somo",
            "offerings": [
                {
                    "offering_id": "kayak_rental__1_day",
                    "offering_type": "rental",
                    "item_code": "kayak_rental__1_day",
                    "tier_key": "1_day",
                    "label": "Kayak Pro",
                    "active": True,
                    "unit_amount_cents": 4500,
                },
                {
                    "offering_id": "board_rental__1_day",
                    "offering_type": "rental",
                    "item_code": "board_rental__1_day",
                    "tier_key": "1_day",
                    "label": "Old Board",
                    "active": raw,
                    "unit_amount_cents": 1500,
                },
            ],
        }
    })
    mod._post_bot = fake_inactive  # type: ignore[attr-defined]
    out_inactive = json.loads(mod.get_sunset_rental_catalog({}))
    keys_inactive = {i.get("item") for i in (out_inactive.get("items") or [])}
    check(f"[a6] {name} live kayak offered", "kayak_rental" in keys_inactive, out_inactive.get("items"))
    check(f"[a6] {name} board_rental excluded", "board_rental" not in keys_inactive, out_inactive.get("items"))

# [b] no hardcoded item/duration menus in registered sunset tool descriptions/schemas
prev = os.environ.get("LUNA_CLIENT_SLUG")
os.environ["LUNA_CLIENT_SLUG"] = "sunset"
try:
    read_tools = list(mod._sunset_tools())
    write_tools = list(mod._sunset_write_tools())
finally:
    if prev is None:
        os.environ.pop("LUNA_CLIENT_SLUG", None)
    else:
        os.environ["LUNA_CLIENT_SLUG"] = prev

registered_names = {t[0] for t in read_tools + write_tools}
check("[b0] get_sunset_rental_catalog registered", "get_sunset_rental_catalog" in registered_names, sorted(registered_names))

# Only scan tool *descriptions* and JSON schema property descriptions (what the model reads).
menu_patterns = [
    r"board\s*/\s*wetsuit",
    r"board\+suit bundle",
    r"board, wetsuit, board\+suit",
    r"1 hour, half day, 1 day, 2 days, 5 days, 7 days",
    r"1 hour, half day",
    r"\bSUP\b.*\bduration\b|\bduration\b.*\bSUP\b",
]
violations = []
for name, desc, _handler, props, _req in read_tools + write_tools:
    blob = desc or ""
    if isinstance(props, dict):
        for pkey, pval in props.items():
            if isinstance(pval, dict):
                blob += "\n" + str(pval.get("description") or "")
    for pat in menu_patterns:
        if re.search(pat, blob, re.I):
            violations.append((name, pat, blob[:160]))

check("[b1] no hardcoded rental item/duration menus in tool schemas", not violations, violations)

# get_sunset_rental_price schema must be generic
price_tool = next(t for t in read_tools if t[0] == "get_sunset_rental_price")
price_desc = price_tool[1] + " " + json.dumps(price_tool[3])
check("[b2] rental_price points at catalog selection", "catalog" in price_desc.lower(), price_desc[:200])
check("[b3] rental_price schema has no fixed board/SUP menu", not re.search(r"board / wetsuit|SUP", price_desc), price_desc[:200])

# [c] SOUL references only registered tools
soul = (ROOT / "docker/hermes-sunset/SOUL.md").read_text(encoding="utf-8")
check("[c0] SOUL drops admin_config_snapshot", "get_sunset_admin_config_snapshot" not in soul)
check("[c1] SOUL names rental catalog tool", "get_sunset_rental_catalog" in soul)
check("[c2] SOUL does not name unregistered group_lesson_quote", "get_sunset_group_lesson_quote" not in soul)

# Bold tool mentions like **get_sunset_...**
soul_tools = set(re.findall(r"\*\*(get_sunset_[a-z0-9_]+|flag_needs_human|create_sunset_[a-z0-9_]+|list_sunset_bookings)\*\*", soul))
# also bare backticks
soul_tools |= set(re.findall(r"`(get_sunset_[a-z0-9_]+|flag_needs_human|create_sunset_[a-z0-9_]+|list_sunset_bookings)`", soul))
unknown = sorted(t for t in soul_tools if t not in registered_names)
check("[c3] SOUL tools ⊆ registered sunset tools", not unknown, {"unknown": unknown, "registered": sorted(registered_names), "soul": sorted(soul_tools)})

print(f"\nResults: {PASSED} passed, {FAILED} failed")
sys.exit(1 if FAILED else 0)
