"""Regression tests for simulate write guards (Sunset + Wolfhouse)."""

from __future__ import annotations

import json
import os
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
STAGING = ROOT.parent
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))
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

    def test_blocks_sunset_waiver_link(self):
        for path in ("/sunset/waiver-link", "/staff/bot/sunset/waiver-link"):
            _norm, _body, warnings = guard_bot_path_and_payload(
                path,
                {"booking_id": "00000000-0000-0000-0000-000000000001"},
                allow_writes=False,
            )
            self.assertIn("blocked_sunset_waiver_write_in_simulate", warnings)
            self.assertTrue(is_simulate_write_blocked(warnings))

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

    def test_sunset_booking_only_mode_blocks_when_no_booking_gate_enabled(self):
        old_bot = os.environ.get("BOT_BOOKING_ENABLED")
        old_sim = os.environ.get("SUNSET_SIMULATOR_BOOKING_ENABLED")
        try:
            os.environ.pop("BOT_BOOKING_ENABLED", None)
            os.environ.pop("SUNSET_SIMULATOR_BOOKING_ENABLED", None)
            _norm, _body, warnings = guard_bot_path_and_payload(
                "/sunset/booking-create",
                {"guest_confirmed_booking": True},
                allow_writes=False,
                booking_only_mode="sunset_booking_only",
            )
            self.assertIn("blocked_sunset_booking_write_bot_booking_disabled", warnings)
            self.assertTrue(is_simulate_write_blocked(warnings))
        finally:
            if old_bot is None:
                os.environ.pop("BOT_BOOKING_ENABLED", None)
            else:
                os.environ["BOT_BOOKING_ENABLED"] = old_bot
            if old_sim is None:
                os.environ.pop("SUNSET_SIMULATOR_BOOKING_ENABLED", None)
            else:
                os.environ["SUNSET_SIMULATOR_BOOKING_ENABLED"] = old_sim

    def test_sunset_booking_only_mode_allows_when_bot_booking_enabled(self):
        old_bot = os.environ.get("BOT_BOOKING_ENABLED")
        old_sim = os.environ.get("SUNSET_SIMULATOR_BOOKING_ENABLED")
        try:
            os.environ["BOT_BOOKING_ENABLED"] = "true"
            os.environ.pop("SUNSET_SIMULATOR_BOOKING_ENABLED", None)
            norm, body, warnings = guard_bot_path_and_payload(
                "/sunset/booking-create",
                {"guest_confirmed_booking": True},
                allow_writes=False,
                booking_only_mode="sunset_booking_only",
            )
            self.assertIn("sunset/booking-create", norm)
            self.assertIn("allowed_sunset_booking_only_write_in_simulate", warnings)
            self.assertFalse(is_simulate_write_blocked(warnings))
            self.assertIs(body.get("simulator_booking_only_mode"), True)
        finally:
            if old_bot is None:
                os.environ.pop("BOT_BOOKING_ENABLED", None)
            else:
                os.environ["BOT_BOOKING_ENABLED"] = old_bot
            if old_sim is None:
                os.environ.pop("SUNSET_SIMULATOR_BOOKING_ENABLED", None)
            else:
                os.environ["SUNSET_SIMULATOR_BOOKING_ENABLED"] = old_sim

    def test_sunset_booking_only_mode_allows_when_simulator_booking_enabled(self):
        old_bot = os.environ.get("BOT_BOOKING_ENABLED")
        old_sim = os.environ.get("SUNSET_SIMULATOR_BOOKING_ENABLED")
        try:
            os.environ.pop("BOT_BOOKING_ENABLED", None)
            os.environ["SUNSET_SIMULATOR_BOOKING_ENABLED"] = "true"
            norm, body, warnings = guard_bot_path_and_payload(
                "/sunset/booking-create",
                {"guest_confirmed_booking": True},
                allow_writes=False,
                booking_only_mode="sunset_booking_only",
            )
            self.assertIn("sunset/booking-create", norm)
            self.assertIn("allowed_sunset_booking_only_write_in_simulate", warnings)
            self.assertFalse(is_simulate_write_blocked(warnings))
            self.assertIs(body.get("simulator_booking_only_mode"), True)
        finally:
            if old_bot is None:
                os.environ.pop("BOT_BOOKING_ENABLED", None)
            else:
                os.environ["BOT_BOOKING_ENABLED"] = old_bot
            if old_sim is None:
                os.environ.pop("SUNSET_SIMULATOR_BOOKING_ENABLED", None)
            else:
                os.environ["SUNSET_SIMULATOR_BOOKING_ENABLED"] = old_sim

    def test_sunset_booking_only_mode_still_blocks_payment_and_waiver(self):
        old_bot = os.environ.get("BOT_BOOKING_ENABLED")
        old_sim = os.environ.get("SUNSET_SIMULATOR_BOOKING_ENABLED")
        try:
            os.environ.pop("BOT_BOOKING_ENABLED", None)
            os.environ["SUNSET_SIMULATOR_BOOKING_ENABLED"] = "true"
            for path in ("/sunset/payment-link", "/sunset/waiver-link"):
                _norm, _body, warnings = guard_bot_path_and_payload(
                    path,
                    {"booking_id": "bk-1"},
                    allow_writes=False,
                    booking_only_mode="sunset_booking_only",
                )
                self.assertTrue(is_simulate_write_blocked(warnings), (path, warnings))
        finally:
            if old_bot is None:
                os.environ.pop("BOT_BOOKING_ENABLED", None)
            else:
                os.environ["BOT_BOOKING_ENABLED"] = old_bot
            if old_sim is None:
                os.environ.pop("SUNSET_SIMULATOR_BOOKING_ENABLED", None)
            else:
                os.environ["SUNSET_SIMULATOR_BOOKING_ENABLED"] = old_sim


    def test_sunset_isolated_mode_allows_only_scoped_test_flows(self):
        old = os.environ.get("BOT_BOOKING_ENABLED")
        os.environ["BOT_BOOKING_ENABLED"] = "true"
        try:
            for path, warning in (
                ("/sunset/booking-create", "allowed_sunset_isolated_booking"),
                ("/sunset/payment-link", "allowed_sunset_isolated_test_payment"),
                ("/sunset/payment-status", "allowed_sunset_isolated_payment_status"),
                ("/sunset/waiver-link", "allowed_sunset_isolated_waiver"),
            ):
                _norm, body, warnings = guard_bot_path_and_payload(
                    path, {"guest_phone": "+34600001222"}, allow_writes=False,
                    booking_only_mode="sunset_isolated",
                    synthetic_identity="+34600001222",
                )
                self.assertIn(warning, warnings)
                self.assertFalse(is_simulate_write_blocked(warnings))
                self.assertTrue(body.get("simulator_isolated_mode"))
                if path == "/sunset/booking-create":
                    self.assertTrue(body.get("simulator_booking_only_mode"))
            _norm, _body, warnings = guard_bot_path_and_payload(
                "/sunset/payment-link", {"guest_phone": "+34600009999"},
                allow_writes=False, booking_only_mode="sunset_isolated",
                synthetic_identity="+34600001222",
            )
            self.assertTrue(is_simulate_write_blocked(warnings))
            _norm, _body, warnings = guard_bot_path_and_payload(
                "/transfers/save", {}, allow_writes=False,
                booking_only_mode="sunset_isolated", synthetic_identity="+34600001222",
            )
            self.assertNotIn("allowed_sunset_isolated", " ".join(warnings))
        finally:
            if old is None:
                os.environ.pop("BOT_BOOKING_ENABLED", None)
            else:
                os.environ["BOT_BOOKING_ENABLED"] = old


class WrappedPostBotTests(unittest.TestCase):
    def test_wrapped_post_bot_never_calls_orig_for_sunset_writes(self):
        import types

        import wolfhouse.simulate_core as core

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


    def test_wrapped_post_bot_allows_only_sunset_booking_in_booking_only_mode(self):
        import types

        import wolfhouse.simulate_core as core

        old = os.environ.get("BOT_BOOKING_ENABLED")
        os.environ["BOT_BOOKING_ENABLED"] = "true"
        orig_calls = []

        def orig_post_bot(path, payload):
            orig_calls.append((path, payload))
            return {"success": True, "path": path, "booking_code": "SUN-OK"}

        fake_mod = types.ModuleType("wolfhouse_staff_api")
        fake_mod._post_bot = orig_post_bot
        sys.modules["wolfhouse_staff_api"] = fake_mod
        cap = core.SimulateCapture(allow_writes=False, booking_only_mode="sunset_booking_only")
        try:
            core._install_tool_capture(cap)
            result = fake_mod._post_bot("/sunset/booking-create", {"guest_confirmed_booking": True})
            self.assertTrue(result.get("success"))
            self.assertEqual(len(orig_calls), 1)
            self.assertTrue(orig_calls[0][1].get("simulator_booking_only_mode"))

            pay_result = fake_mod._post_bot("/sunset/payment-link", {"booking_id": "bk-1"})
            self.assertTrue(pay_result.get("simulate_write_blocked"))
            self.assertEqual(len(orig_calls), 1)
        finally:
            core._remove_patches(cap)
            sys.modules.pop("wolfhouse_staff_api", None)
            if old is None:
                os.environ.pop("BOT_BOOKING_ENABLED", None)
            else:
                os.environ["BOT_BOOKING_ENABLED"] = old

    def test_synthetic_blocked_result_shape(self):
        blocked = synthetic_blocked_result(
            "/staff/bot/sunset/booking-create",
            ["blocked_sunset_booking_write_in_simulate"],
            allow_writes=False,
        )
        self.assertEqual(blocked["tool"], "create_sunset_booking")
        self.assertIn("Sunset booking writes", blocked["error"])


_OWNED_PAYMENT = "11111111-1111-4111-8111-111111111111"
_FOREIGN_PAYMENT = "22222222-2222-4222-8222-222222222222"
_OWNED_GUEST = "33333333-3333-4333-8333-333333333333"
_APPROVED_STAGING_ENV = {
    "HERMES_ROLE": "luna",
    "LUNA_TENANT_ID": "wolfhouse-somo",
    "LUNA_CLIENT_SLUG": "wolfhouse-somo",
    "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff-staging.lunafrontdesk.com",
    "PUBLIC_PAYMENT_BASE_URL": "https://staff-staging.lunafrontdesk.com",
    "BOT_BOOKING_ENABLED": "true",
    "STRIPE_SECRET_KEY": "sk_test_wolfhouse_staging_fixture",
    "WOLFHOUSE_STRIPE_MODE": "test",
}


class WolfhouseStagingBookingCapabilityTests(unittest.TestCase):
    def _evaluate(self, **overrides):
        from simulate_write_guards import evaluate_wolfhouse_staging_booking_capability

        env = dict(_APPROVED_STAGING_ENV)
        env.update(overrides.pop("env", {}))
        return evaluate_wolfhouse_staging_booking_capability(
            scope_active=overrides.pop("scope_active", True),
            scope_revoked=overrides.pop("scope_revoked", False),
            env=env,
        )

    def test_approved_staging_fixture_admits_narrow_capability(self):
        cap = self._evaluate()
        self.assertEqual(cap["capability"], "wolfhouse_staging_booking_test_link")
        self.assertTrue(cap["admitted"], cap)
        self.assertEqual(cap["reasons"], [])
        self.assertNotIn("sk_test", json.dumps(cap))

    def test_admitted_capability_forwards_create_not_preview(self):
        cap = self._evaluate()
        norm, body, warnings = guard_bot_path_and_payload(
            "/staff/bot/booking-create-from-plan",
            {"confirm": True, "guest_name": "Fred", "allow_writes": True},
            allow_writes=False,
            wolfhouse_capability=cap,
        )
        self.assertIn("booking-create-from-plan", norm)
        self.assertNotIn("booking-preview", norm)
        self.assertIn("allowed_wolfhouse_staging_booking_create", warnings)
        self.assertFalse(is_simulate_write_blocked(warnings))
        self.assertNotIn("allow_writes", body)

    def test_admitted_capability_forwards_owned_test_link_only(self):
        cap = self._evaluate()
        owned, _body, owned_warnings = guard_bot_path_and_payload(
            f"/staff/bot/payments/{_OWNED_PAYMENT}/create-stripe-link",
            {"client_slug": "wolfhouse-somo"},
            allow_writes=False,
            wolfhouse_capability=cap,
            owned_payment_ids={_OWNED_PAYMENT},
        )
        self.assertIn(_OWNED_PAYMENT, owned)
        self.assertIn("allowed_wolfhouse_staging_test_link", owned_warnings)
        self.assertFalse(is_simulate_write_blocked(owned_warnings))

        foreign, _foreign_body, foreign_warnings = guard_bot_path_and_payload(
            f"/staff/bot/payments/{_FOREIGN_PAYMENT}/create-stripe-link",
            {"client_slug": "wolfhouse-somo"},
            allow_writes=False,
            wolfhouse_capability=cap,
            owned_payment_ids={_OWNED_PAYMENT},
        )
        self.assertIn("blocked_foreign_payment_uuid", foreign_warnings)
        self.assertTrue(is_simulate_write_blocked(foreign_warnings))
        self.assertIn(_FOREIGN_PAYMENT, foreign)

        guest, _guest_body, guest_warnings = guard_bot_path_and_payload(
            f"/staff/bot/booking-guests/{_OWNED_GUEST}/create-payment-link",
            {},
            allow_writes=False,
            wolfhouse_capability=cap,
            owned_guest_ids={_OWNED_GUEST},
        )
        self.assertIn("allowed_wolfhouse_staging_guest_test_link", guest_warnings)
        self.assertFalse(is_simulate_write_blocked(guest_warnings))

    def test_admitted_capability_still_denies_unlisted_effects(self):
        cap = self._evaluate()
        for path, needle in (
            ("/staff/bot/transfers/save", "blocked_transfer_not_admitted"),
            ("/staff/bot/payments/pay-1/create-balance-link", "blocked_balance_link_not_admitted"),
            ("/staff/bot/update-contact", "blocked_booking_mutation_in_simulate"),
            ("/staff/bot/sunset/booking-create", "blocked_sunset_booking_write_in_simulate"),
        ):
            _norm, _body, warnings = guard_bot_path_and_payload(
                path, {"confirm": True}, allow_writes=False, wolfhouse_capability=cap,
            )
            self.assertTrue(any(needle in w for w in warnings), (path, warnings))
            self.assertTrue(is_simulate_write_blocked(warnings), (path, warnings))

    def test_production_or_missing_binding_stays_denied(self):
        prod = self._evaluate(env={"WOLFHOUSE_STAFF_API_BASE_URL": "https://staff.lunafrontdesk.com"})
        self.assertFalse(prod["admitted"])
        self.assertIn("staff_destination_not_approved_staging", prod["reasons"])

        missing = self._evaluate(env={"WOLFHOUSE_STAFF_API_BASE_URL": ""})
        self.assertFalse(missing["admitted"])
        self.assertIn("staff_destination_missing", missing["reasons"])

        live = self._evaluate(env={"STRIPE_SECRET_KEY": "sk_live_not_for_sim", "WOLFHOUSE_STRIPE_MODE": "live"})
        self.assertFalse(live["admitted"])
        self.assertIn("live_stripe_key_blocked", live["reasons"])

        no_pay = self._evaluate(env={"PUBLIC_PAYMENT_BASE_URL": ""})
        self.assertFalse(no_pay["admitted"])
        self.assertIn("public_pay_origin_missing", no_pay["reasons"])

        revoked = self._evaluate(scope_revoked=True)
        self.assertFalse(revoked["admitted"])
        self.assertIn("request_scope_revoked", revoked["reasons"])

        no_scope = self._evaluate(scope_active=False)
        self.assertFalse(no_scope["admitted"])
        self.assertIn("simulator_provenance_missing", no_scope["reasons"])

    def test_port_and_node_env_alone_do_not_admit(self):
        cap = self._evaluate(env={
            "WOLFHOUSE_STAFF_API_BASE_URL": "",
            "PUBLIC_PAYMENT_BASE_URL": "",
            "STRIPE_SECRET_KEY": "",
            "BOT_BOOKING_ENABLED": "",
            "NODE_ENV": "development",
            "WHATSAPP_CLOUD_WEBHOOK_PORT": "8090",
        })
        self.assertFalse(cap["admitted"])
        self.assertIn("staff_destination_missing", cap["reasons"])

    def test_unapproved_payload_flag_does_not_bypass_preview(self):
        norm, _body, warnings = guard_bot_path_and_payload(
            "/staff/bot/booking-create-from-plan",
            {"allow_writes": True, "wolfhouse_staging_capability": "wolfhouse_staging_booking_test_link"},
            allow_writes=False,
        )
        self.assertIn("booking-preview", norm)
        self.assertIn("redirected_create_to_booking_preview", warnings)


if __name__ == "__main__":
    unittest.main(verbosity=2)
