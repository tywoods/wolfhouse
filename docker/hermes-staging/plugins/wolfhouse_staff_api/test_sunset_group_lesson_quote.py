"""get_sunset_group_lesson_quote is disabled/unregistered — no POST to Staff API.

Luna offers admin courses (+ private) only, never standalone group lessons.
The stub remains for defense-in-depth but is not in the Hermes tool registry.
"""

from __future__ import annotations

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
    def __init__(self):
        self.calls = []

    def __call__(self, path, payload):
        self.calls.append((path, dict(payload or {})))
        return {"success": True, "total_cents": 99999}


mod = load_module()
fake = FakeBot()
mod._post_bot = fake  # type: ignore[attr-defined]

print("\n== get_sunset_group_lesson_quote disabled/unregistered ==")

# Disabled stub — never POSTs.
out = json.loads(mod.get_sunset_group_lesson_quote({
    "location_id": "sunset-somo",
    "service_dates": ["2026-07-20", "2026-07-21"],
    "quantity": 2,
}))
check("D1 success false", out.get("success") is False, out)
check("D2 disabled flag", out.get("disabled") == "group_lessons_not_offered"
      or out.get("error") == "group_lessons_not_offered", out)
check("D3 no Staff API POST", len(fake.calls) == 0, fake.calls)
check("D4 do_not_escalate", out.get("do_not_escalate") is True, out)

# Empty params also no POST.
fake.calls.clear()
empty = json.loads(mod.get_sunset_group_lesson_quote({}))
check("D5 empty still disabled", empty.get("success") is False)
check("D6 empty no POST", len(fake.calls) == 0, fake.calls)

# Not registered in _sunset_tools.
prev_slug = os.environ.get("LUNA_CLIENT_SLUG")
os.environ["LUNA_CLIENT_SLUG"] = "sunset"
try:
    names = [t[0] for t in mod._sunset_tools()]
    check("D7 not in _sunset_tools()", "get_sunset_group_lesson_quote" not in names, names)
    check(
        "D8 course quote tools present",
        "get_sunset_offering_quote" in names and "get_sunset_lesson_catalog" in names,
        names,
    )
finally:
    if prev_slug is None:
        os.environ.pop("LUNA_CLIENT_SLUG", None)
    else:
        os.environ["LUNA_CLIENT_SLUG"] = prev_slug

# Stub def retained for defense-in-depth.
src = (ROOT / "__init__.py").read_text()
check("D9 stub def kept", "def get_sunset_group_lesson_quote" in src)
check("D10 not in registry tuples", not bool(__import__("re").search(
    r'\(\s*"get_sunset_group_lesson_quote"\s*,', src,
)))

print(f"\n== Summary: {PASSED} passed, {FAILED} failed ==")
sys.exit(1 if FAILED else 0)
