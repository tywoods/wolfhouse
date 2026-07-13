"""Regression tests for simulate write guards (Sunset + Wolfhouse)."""

from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from simulate_write_guards import (  # noqa: E402
    guard_bot_path_and_payload,
    is_simulate_write_blocked,
    synthetic_blocked_result,
    tool_name_from_path,
)


class GuardPathTests(unittest.TestCase):
    def test_blocks_sunset_booking_create_short_and_full_paths(self):
        for path in ("/sunset/booking-create", "/staff/bot/sunset/booking-create"):
            norm, body, warnings = guard_bot_path_and_payload(
                path,
                {"guest_name": "Mateo Test", "components": {"lesson": {"quantity": 1}}},
                allow_writes=False,
            )
            self.assertIn("blocked_sunset_booking_write_in_simulate", warnings)
            self.assertTrue(is_simulate_write_blocked(warnings))
            self.assertIn("sunset/booking-create", norm)

    def test_blocks_sunset_payment_link_short_and_full_paths(self):
        for path in ("/sunset/payment-link", "/staff/bot/sunset/payment-link"):
            norm, body, warnings = guard_bot_path_and_payload(
                path,
                {"booking_id": "00000000-0000-0000-0000-000000000001"},
                allow_writes=False,
            )
            self.assertIn("blocked_sunset_payment_write_in_simulate", warnings)
            self.assertTrue(is_simulate_write_blocked(warnings))
            self.assertIn("sunset/payment-link", norm)

    def test_allows_sunset_read_only_quote_and_availability(self):
        for path, payload in (
            ("/sunset/lesson-quote", {"service_dates": ["2026-08-03"], "quantity": 1}),
            ("/sunset/lesson-availability", {"date": "2026-08-03"}),
            ("/sunset/rental-price", {"item": "board", "duration": "1 day"}),
            ("/sunset/full-day-addon", {"dates": ["2026-08-03"], "quantity": 1}),
            ("/sunset/private-lesson", {}),
        ):
            norm, body, warnings = guard_bot_path_and_payload(path, payload, allow_writes=False)
            self.assertFalse(is_simulate_write_blocked(warnings), (path, warnings))

    def test_wolfhouse_create_still_redirects_to_preview(self):
        norm, body, warnings = guard_bot_path_and_payload(
            "/staff/bot/booking-create-from-plan",
            {"confirm": True, "plan_id": "p1"},
            allow_writes=False,
        )
        self.assertIn("redirected_create_to_booking_preview", warnings)
        self.assertFalse(is_simulate_write_blocked(warnings))
        self.assertIn("booking-preview", norm)

    def test_wolfhouse_payment_still_blocked(self):
        _, _, warnings = guard_bot_path_and_payload(
            "/staff/bot/payments/create-stripe-link",
            {"payment_id": "pay-1"},
            allow_writes=False,
        )
        self.assertIn("blocked_payment_write_in_simulate", warnings)
        self.assertTrue(is_simulate_write_blocked(warnings))

    def test_allow_writes_true_passes_through(self):
        path = "/sunset/booking-create"
        norm, body, warnings = guard_bot_path_and_payload(path, {"x": 1}, allow_writes=True)
        self.assertEqual(warnings, [])
        self.assertIn("sunset/booking-create", norm)


class WrappedPostBotTests(unittest.TestCase):
    def test_wrapped_post_bot_never_calls_orig_for_sunset_writes(self):
        import types

        spec = importlib.util.spec_from_file_location("simulate_core", ROOT / "simulate_core.py")
        core = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(core)

        orig_calls = []

        def orig_post_bot(path, payload):
            orig_calls.append((path, payload))
            return {"success": True, "path": path}

        fake_mod = types.ModuleType("wolfhouse_staff_api")
        fake_mod._post_bot = orig_post_bot
        sys.modules["wolfhouse_staff_api"] = fake_mod

        cap = core.SimulateCapture(allow_writes=False)
        core._install_tool_capture(cap)

        payload = {
            "guest_confirmed_booking": True,
            "guest_name": "Mateo Guard Test",
            "components": {"lesson": {"quantity": 1}},
            "service_dates": ["2026-08-03"],
        }
        result = fake_mod._post_bot("/sunset/booking-create", payload)
        self.assertFalse(result.get("success"))
        self.assertTrue(result.get("simulate_write_blocked"))
        self.assertFalse(result.get("allow_writes", True))
        self.assertEqual(orig_calls, [])
        self.assertEqual(len(cap.tool_calls), 1)
        self.assertEqual(cap.tool_calls[0]["args"], payload)
        self.assertEqual(cap.tool_calls[0]["name"], "create_sunset_booking")

        pay_result = fake_mod._post_bot("/sunset/payment-link", {"booking_id": "bk-1"})
        self.assertTrue(pay_result.get("simulate_write_blocked"))
        self.assertEqual(orig_calls, [])
        self.assertEqual(len(cap.tool_calls), 2)

        quote_result = fake_mod._post_bot(
            "/sunset/lesson-quote",
            {"service_dates": ["2026-08-03"], "quantity": 1},
        )
        self.assertTrue(quote_result.get("success"))
        self.assertEqual(len(orig_calls), 1)
        self.assertEqual(orig_calls[0][0], "/staff/bot/sunset/lesson-quote")

        core._remove_patches(cap)
        sys.modules.pop("wolfhouse_staff_api", None)

    def test_synthetic_blocked_result_shape(self):
        blocked = synthetic_blocked_result(
            "/staff/bot/sunset/booking-create",
            ["blocked_sunset_booking_write_in_simulate"],
            allow_writes=False,
        )
        self.assertEqual(blocked["tool"], "create_sunset_booking")
        self.assertIn("Sunset booking writes", blocked["error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
