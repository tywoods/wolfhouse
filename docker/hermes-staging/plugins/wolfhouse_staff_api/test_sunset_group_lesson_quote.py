"""Tests for get_sunset_group_lesson_quote — authoritative Staff API passthrough."""

import importlib.util
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
PASSED = 0
FAILED = 0


def check(label, cond, detail=None):
    global PASSED, FAILED
    if cond:
        PASSED += 1
        print(f"  PASS  {label}")
    else:
        FAILED += 1
        msg = f"  FAIL  {label}"
        if detail is not None:
            msg += f" — {detail}"
        print(msg)


def load_module():
    spec = importlib.util.spec_from_file_location("wolfhouse_staff_api", ROOT / "__init__.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeBot:
    """Records every _post_bot call and returns canned responses by path."""

    def __init__(self, responses):
        self.responses = dict(responses or {})
        self.calls = []

    def __call__(self, path, payload):
        self.calls.append((path, dict(payload or {})))
        for key, resp in self.responses.items():
            if key in path:
                return dict(resp)
        return {"success": False, "reason": "unexpected_bot_path", "unexpected_path": path}

    def called(self, fragment):
        return any(fragment in path for path, _ in self.calls)

    def body_for(self, fragment):
        for path, body in self.calls:
            if fragment in path:
                return body
        return None


def with_fake(mod, responses):
    fake = FakeBot(responses)
    mod._post_bot = fake  # type: ignore[attr-defined]
    return fake


mod = load_module()

QUOTE_PATH = "/sunset/lesson-quote"
SERVICE_DATES = ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23"]
QUOTE_BODY = {
    "ok": True,
    "success": True,
    "tool": "get_sunset_group_lesson_quote",
    "location_id": "sunset-somo",
    "service_dates": SERVICE_DATES,
    "quantity": 1,
    "date_count": 4,
    "unit_amount_cents": 3000,
    "line_total_cents": 12000,
    "total_cents": 12000,
    "amount_eur": 120,
    "currency": "EUR",
    "price_source": "config_or_db",
}

print("\n== get_sunset_group_lesson_quote plugin tests ==")

# Missing service_dates — local validation, no POST.
no_post_fake = FakeBot({QUOTE_PATH: QUOTE_BODY})
mod._post_bot = no_post_fake  # type: ignore[attr-defined]
empty = json.loads(mod.get_sunset_group_lesson_quote({}))
check("Q1 requires service_dates", empty.get("success") is False and empty.get("error") == "service_dates_required")
check("Q2 no POST when service_dates missing", len(no_post_fake.calls) == 0, no_post_fake.calls)

# Valid request — exact route + payload passthrough.
quote_fake = with_fake(mod, {QUOTE_PATH: QUOTE_BODY})
result = json.loads(mod.get_sunset_group_lesson_quote({
    "location_id": "sunset-somo",
    "service_dates": SERVICE_DATES,
    "quantity": 1,
}))
check("Q3 calls /sunset/lesson-quote", quote_fake.called(QUOTE_PATH), quote_fake.calls)
check("Q4 exactly one bot POST", len(quote_fake.calls) == 1, len(quote_fake.calls))
posted = quote_fake.body_for(QUOTE_PATH)
check("Q5 posts service_dates", posted is not None and posted.get("service_dates") == SERVICE_DATES, posted)
check("Q6 posts quantity", posted is not None and posted.get("quantity") == 1, posted)
check("Q7 posts location_id", posted is not None and posted.get("location_id") == "sunset-somo", posted)
check("Q8 passthrough total_cents", result.get("total_cents") == QUOTE_BODY["total_cents"])
check("Q9 passthrough unit_amount_cents", result.get("unit_amount_cents") == QUOTE_BODY["unit_amount_cents"])
check("Q10 passthrough line_total_cents", result.get("line_total_cents") == QUOTE_BODY["line_total_cents"])
check("Q11 passthrough amount_eur", result.get("amount_eur") == QUOTE_BODY["amount_eur"])
check("Q12 passthrough currency", result.get("currency") == QUOTE_BODY["currency"])
check("Q13 passthrough price_source", result.get("price_source") == QUOTE_BODY["price_source"])
check("Q14 passthrough service_dates", result.get("service_dates") == SERVICE_DATES)
check("Q15 passthrough quantity", result.get("quantity") == QUOTE_BODY["quantity"])
check(
    "Q16 no local money multiplication (matches Staff API response verbatim)",
    result.get("total_cents") == QUOTE_BODY["total_cents"]
    and result.get("line_total_cents") == QUOTE_BODY["line_total_cents"]
    and result.get("amount_eur") == QUOTE_BODY["amount_eur"],
    result,
)

# Failure response from Staff API.
fail_fake = with_fake(mod, {QUOTE_PATH: {"success": False, "reason": "group_lesson_price_unavailable"}})
failed = json.loads(mod.get_sunset_group_lesson_quote({"service_dates": ["2026-07-20"], "quantity": 1}))
check("Q17 failure stays success:false", failed.get("success") is False)
check("Q18 failure reason passthrough", failed.get("reason") == "group_lesson_price_unavailable")

# Read-only — never hits write/money routes.
readonly_fake = with_fake(mod, {QUOTE_PATH: QUOTE_BODY})
json.loads(mod.get_sunset_group_lesson_quote({"service_dates": ["2026-07-20"], "quantity": 1}))
write_fragments = ("booking-create", "payment-link", "create-stripe", "addon-requests", "transfers")
check("Q19 read-only (no booking-create)", not readonly_fake.called("booking-create"))
check("Q20 read-only (no payment-link)", not readonly_fake.called("payment-link"))
check("Q21 read-only (no other write routes)", not any(
    any(w in path for w in write_fragments) for path, _ in readonly_fake.calls
), readonly_fake.calls)

# Sunset read toolset registration.
prev_slug = os.environ.get("LUNA_CLIENT_SLUG")
os.environ["LUNA_CLIENT_SLUG"] = "sunset"
try:
    names = [t[0] for t in mod._sunset_tools()]
    check("Q22 in _sunset_tools()", "get_sunset_group_lesson_quote" in names)
    check(
        "Q23 Sunset read tools include catalog + offering quote + group quote",
        set([
            "get_sunset_rental_price",
            "get_sunset_full_day_equipment_addon",
            "get_sunset_private_lesson",
            "get_sunset_lesson_availability",
            "get_sunset_lesson_catalog",
            "get_sunset_offering_quote",
            "get_sunset_group_lesson_quote",
        ]).issubset(set(names))
        and len(names) >= 7,
        names,
    )
finally:
    if prev_slug is None:
        os.environ.pop("LUNA_CLIENT_SLUG", None)
    else:
        os.environ["LUNA_CLIENT_SLUG"] = prev_slug

print(f"\n== Summary: {PASSED} passed, {FAILED} failed ==")
sys.exit(1 if FAILED else 0)
