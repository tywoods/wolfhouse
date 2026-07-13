"""Tests for get_sunset_group_lesson_quote — authoritative Staff API passthrough."""

import importlib.util
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent
PASSED = 0
FAILED = 0


def check(label, cond):
    global PASSED, FAILED
    if cond:
        PASSED += 1
        print(f"  PASS  {label}")
    else:
        FAILED += 1
        print(f"  FAIL  {label}")


def load_module():
    spec = importlib.util.spec_from_file_location("wolfhouse_staff_api", ROOT / "__init__.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def with_fake(responses):
    calls = []

    class Response:
        def __init__(self, body):
            self._body = body

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def read(self):
            return json.dumps(self._body).encode()

    def urlopen(req, timeout=0):
        path = req.full_url.split("/staff/bot")[-1]
        calls.append((path, json.loads(req.data)))
        body = responses.get(path, {"success": False, "reason": "not_mocked"})
        return Response(body)

    mod = load_module()
    import urllib.request

    prev = urllib.request.urlopen
    urllib.request.urlopen = urlopen
    return mod, calls, prev


mod = load_module()

# Requires service_dates
empty = json.loads(mod.get_sunset_group_lesson_quote({}))
check("Q1 requires service_dates", empty.get("success") is False and empty.get("error") == "service_dates_required")

# Passthrough — no local multiplication
quote_body = {
    "ok": True,
    "success": True,
    "tool": "get_sunset_group_lesson_quote",
    "location_id": "sunset-somo",
    "service_dates": ["2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23"],
    "quantity": 1,
    "date_count": 4,
    "unit_amount_cents": 3000,
    "line_total_cents": 12000,
    "total_cents": 12000,
    "amount_eur": 120,
    "currency": "EUR",
    "price_source": "config_or_db",
}
mod2, calls, prev_urlopen = with_fake({"/sunset/lesson-quote": quote_body})
try:
    result = json.loads(mod2.get_sunset_group_lesson_quote({
        "location_id": "sunset-somo",
        "service_dates": quote_body["service_dates"],
        "quantity": 1,
    }))
    check("Q2 hits /sunset/lesson-quote", any("/sunset/lesson-quote" in c[0] for c in calls))
    check("Q3 passthrough total_cents", result.get("total_cents") == 12000)
    check("Q4 passthrough unit_amount_cents", result.get("unit_amount_cents") == 3000)
    check("Q5 passthrough price_source", result.get("price_source") == "config_or_db")
    posted = next(c[1] for c in calls if "/sunset/lesson-quote" in c[0])
    check("Q6 posts service_dates and quantity", posted.get("service_dates") == quote_body["service_dates"] and posted.get("quantity") == 1)
finally:
    import urllib.request
    urllib.request.urlopen = prev_urlopen

# Read-only — no write routes
mod3, wcalls, prev2 = with_fake({"/sunset/lesson-quote": quote_body})
try:
    json.loads(mod3.get_sunset_group_lesson_quote({"service_dates": ["2026-07-20"], "quantity": 1}))
    check("Q7 read-only (no booking-create)", not any("booking-create" in c[0] for c in wcalls))
    check("Q8 read-only (no payment-link)", not any("payment-link" in c[0] for c in wcalls))
finally:
    import urllib.request
    urllib.request.urlopen = prev2

# Tool registered in sunset read set
prev_slug = os.environ.get("LUNA_CLIENT_SLUG")
os.environ["LUNA_CLIENT_SLUG"] = "sunset"
try:
    names = [t[0] for t in mod._sunset_tools()]
    check("Q9 in _sunset_tools()", "get_sunset_group_lesson_quote" in names)
    check("Q10 fifth read tool", len(names) == 5)
finally:
    if prev_slug is None:
        os.environ.pop("LUNA_CLIENT_SLUG", None)
    else:
        os.environ["LUNA_CLIENT_SLUG"] = prev_slug

print(f"\n== Summary: {PASSED} passed, {FAILED} failed ==")
sys.exit(1 if FAILED else 0)
