"""Offline payment/handoff regression: synthetic transport, NOT Staff DB proof.

Run: python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_payment_failure_handoff.py -v
Real wrappers, _post_bot and flag_needs_human; only urllib is replaced.
Socket tripwires and a cleared environment prevent live services/credentials.
"""
from email.message import Message
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "docker/hermes-staging"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wolfhouse_staff_api as plugin


class PaymentFailureHandoffTests(unittest.TestCase):
    def setUp(self):
        env = {
            "LUNA_CLIENT_SLUG": "wolfhouse-somo",
            "LUNA_BOT_INTERNAL_TOKEN": "offline-fixture-not-a-credential",
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff.invalid",
            "WOLFHOUSE_WHATSAPP_GUEST_PHONE": "+34000000001",
            "SUNSET_INGRESS_LOCATION_ID": "sunset-somo",
        }
        for guard in (
            patch.dict(os.environ, env, clear=True),
            patch("socket.socket.connect", side_effect=AssertionError("NETWORK FORBIDDEN")),
            patch("socket.create_connection", side_effect=AssertionError("NETWORK FORBIDDEN")),
        ):
            guard.start()
            self.addCleanup(guard.stop)
        self.calls = []
        self.responses: dict[str, object] = {}
        self.handoff = {"success": True, "needs_human": True,
                        "conversation_id": "offline-conversation", "conversation_paused": False}
        transport = patch("urllib.request.urlopen", side_effect=self.transport)
        transport.start()
        self.addCleanup(transport.stop)

    def transport(self, request, timeout):
        self.assertEqual(urlsplit(request.full_url).netloc, "staff.invalid")
        self.assertEqual(timeout, 25)
        path = urlsplit(request.full_url).path.removeprefix("/staff/bot")
        payload = json.loads(request.data)
        self.calls.append((path, payload))
        response = self.handoff if path == "/conversation/needs-human" else self.responses.get(path)
        if response is None:
            raise AssertionError(f"Unexpected transport call: {path}")
        if isinstance(response, Exception):
            raise response
        return io.BytesIO(response if isinstance(response, bytes) else json.dumps(response).encode())

    def call(self, tool, params, response):
        routes = {
            "create_payment_link": "/payments/p1/create-stripe-link",
            "create_balance_payment_link": "/payments/create-balance-link",
            "create_guest_payment_link": "/booking-guests/g1/create-payment-link",
            "create_sunset_payment_link": "/sunset/payment-link",
        }
        self.calls.clear()
        self.responses[routes[tool]] = response
        os.environ["LUNA_CLIENT_SLUG"] = "sunset" if "sunset" in tool else "wolfhouse-somo"
        return json.loads(getattr(plugin, tool)(params))

    def assert_handoff(self, result, confirmed=True):
        flags = [body for path, body in self.calls if path == "/conversation/needs-human"]
        self.assertEqual(len(flags), 1, self.calls)
        self.assertTrue(flags[0]["reason"].startswith("business_tool_error:"))
        self.assertEqual(flags[0]["phone"], "+34000000001")
        self.assertEqual(flags[0]["client_slug"], os.environ["LUNA_CLIENT_SLUG"])
        self.assertNotIn("conversation_id", flags[0])
        self.assertIs(result["needs_human"], confirmed)
        self.assertIs(result["handoff_confirmed"], confirmed)
        self.assertEqual(result["handoff"]["conversation_paused"], False)
        self.assertNotEqual(result.get("next_action"), "send_secure_payment_link")
        self.assertIsNone(result.get("secure_payment_url"))
        self.assertIsNot(result.get("payment_confirmed"), True)

    LINK_TOOLS = (
        ("create_payment_link", {"payment_id": "p1"}),
        ("create_balance_payment_link", {"booking_code": "OFFLINE"}),
        ("create_guest_payment_link", {"booking_guest_id": "g1"}),
        ("create_sunset_payment_link", {"booking_code": "OFFLINE"}),
    )

    def test_all_link_failures_handoff_without_stale_success_signals(self):
        for tool, params in self.LINK_TOOLS:
            for failure in (
                {"success": False, "error": "provider unavailable"},
                {"success": True},
                {"success": False, "checkout_url": "https://stale.invalid/pay",
                 "payment_short_url": "https://stale.invalid/short", "next_action": "send_secure_payment_link"},
                {"checkout_url": "https://stale.invalid/pay"},
                {"success": "false", "checkout_url": "https://stale.invalid/pay"},
                b"not json", b"[]", TimeoutError("offline timeout"),
                HTTPError("https://staff.invalid", 503, "offline failure", {}, io.BytesIO(b'{}')),
            ):
                with self.subTest(tool=tool, failure=repr(failure)):
                    result = self.call(tool, params, failure)
                    self.assert_handoff(result)
                    self.assertFalse(result["success"])
                    for key in ("checkout_url", "guest_payment_url", "payment_short_url"):
                        self.assertFalse(result.get(key), (key, result))
                    self.assertEqual(len(self.calls), 2, "one payment attempt, one handoff; no retry")

    @staticmethod
    def http_error(status, body):
        return HTTPError("https://staff.invalid", status, "offline error", Message(),
                         io.BytesIO(json.dumps(body).encode()))

    def test_actual_http403_policy_denials_do_not_handoff(self):
        wolfhouse_denials = (
            {"success": False, "stripe_links_enabled": False,
             "error": "Stripe link creation is disabled. Set STRIPE_LINKS_ENABLED=true to enable."},
            {"success": False, "bot_booking_enabled": False,
             "error": "Bot booking is disabled. Set BOT_BOOKING_ENABLED=true to enable."},
        )
        sunset_denials = tuple({"success": False, "error": code} for code in (
            "staff_actions_disabled", "stripe_links_disabled", "payment_provider_not_allowed"))
        for tool, params in self.LINK_TOOLS:
            for body in sunset_denials if "sunset" in tool else wolfhouse_denials:
                with self.subTest(tool=tool, body=body):
                    result = self.call(tool, params, self.http_error(403, body))
                    self.assertEqual(len(self.calls), 1, self.calls)
                    self.assertFalse(result.get("payment_operation_failed"))
                    self.assertFalse(result.get("needs_human"))
                    self.assertFalse(result.get("staff_review_needed"))
                    self.assertTrue(result.get("do_not_escalate"))
                    self.assertEqual(result.get("outcome"), "INTENTIONALLY_BLOCKED")
                    self.assertEqual(result["guest_safe_next_action"], "This payment action is not available here.")
                    self.assertIsNone(result.get("secure_payment_url"))

    def test_http_error_metadata_is_bounded_and_boolean(self):
        route = "/payments/p1/create-stripe-link"
        for value in (False, True, "false", 0, None, {"disabled": True}):
            with self.subTest(value=value):
                self.responses[route] = self.http_error(403, {
                    "success": True, "stripe_links_enabled": value, "bot_booking_enabled": value,
                    "error": "policy test", "checkout_url": "https://stale.invalid/pay",
                    "client_slug": "sunset", "needs_human": True, "disabled": True,
                    "unexpected": {"private": "must not be copied"},
                })
                data = plugin._post_bot(route, {})
                self.assertIs(data["success"], False)
                for key in ("stripe_links_enabled", "bot_booking_enabled"):
                    if isinstance(value, bool):
                        self.assertIs(data.get(key), value)
                    else:
                        self.assertNotIn(key, data)
                for key in ("checkout_url", "client_slug", "needs_human", "disabled", "unexpected"):
                    self.assertNotIn(key, data)

    def test_unknown_http403_is_still_operational_failure(self):
        for tool, params in self.LINK_TOOLS:
            for body in (
                {"error": "forbidden"},
                {"error": "upstream account disabled"},
                {"error": "staff_actions_disabled temporarily"},
                {"error": "forbidden", "stripe_links_enabled": "false", "bot_booking_enabled": 0},
            ):
                with self.subTest(tool=tool, body=body):
                    result = self.call(tool, params, self.http_error(403, body))
                    self.assert_handoff(result)
                    self.assertTrue(result["payment_operation_failed"])
                    self.assertEqual(len(self.calls), 2)

    def test_non_object_http_error_json_enters_genuine_failure_handling(self):
        for tool, params in self.LINK_TOOLS:
            for status in (403, 503):
                for body in ([], ["error"], None, "staff_actions_disabled", 0, True):
                    with self.subTest(tool=tool, status=status, body=body):
                        result = self.call(tool, params, self.http_error(status, body))
                        self.assert_handoff(result)
                        self.assertTrue(result["payment_operation_failed"])
                        self.assertFalse(result["success"])
                        self.assertEqual(len(self.calls), 2)

    def test_http_no_due_and_wrong_id_controls_do_not_handoff(self):
        for tool, params in self.LINK_TOOLS:
            with self.subTest(tool=tool):
                result = self.call(tool, params, self.http_error(422, {"error": "no_payment_due"}))
                self.assertEqual(len(self.calls), 1)
                self.assertFalse(result.get("payment_operation_failed"))
                self.assertFalse(result.get("staff_review_needed"))
        result = self.call("create_payment_link", {"payment_id": "p1"},
                           self.http_error(404, {"error": "payment not found"}))
        self.assertTrue(result["wrong_id_type"])
        self.assertEqual(len(self.calls), 1)

    def test_handoff_failure_never_claims_notified(self):
        for receipt in ({"success": False, "needs_human": True},
                        {"success": True, "needs_human": False},
                        {"needs_human": True},
                        {"success": "false", "needs_human": True},
                        TimeoutError("handoff timeout")):
            with self.subTest(receipt=receipt):
                self.handoff = receipt
                result = self.call("create_sunset_payment_link", {"booking_code": "OFFLINE"},
                                   {"success": False})
                self.assert_handoff(result, confirmed=False)
                self.assertIn("contact reception directly", result["guest_safe_next_action"].lower())
                self.assertIn("can’t promise", result["guest_safe_next_action"])

    def test_missing_trusted_identity_does_not_use_model_phone(self):
        os.environ.pop("WOLFHOUSE_WHATSAPP_GUEST_PHONE")
        result = self.call("create_payment_link", {"payment_id": "p1", "phone": "34999999999"},
                           {"success": False})
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(result["handoff_confirmed"])
        self.assertIn("contact reception directly", result["guest_safe_next_action"].lower())

    def test_link_controls_do_not_request_handoff(self):
        for tool, params in self.LINK_TOOLS:
            for response in (
                {"success": True, "checkout_url": "https://checkout.invalid/pay", "payment_status": "pending"},
                {"success": False, "error": "no_payment_due"},
                {"success": False, "reason": "no_balance_due"},
                {"success": True, "already_paid": True},
                {"success": False, "reason_code": "already_paid"},
                {"success": True, "intentional_capability_block": True, "outcome": "INTENTIONALLY_BLOCKED"},
                {"success": False, "disabled": True},
                {"success": False, "blocked_reasons": ["guest_name_missing"], "safe_next_step": "ask_missing_details"},
            ):
                with self.subTest(tool=tool, response=response):
                    result = self.call(tool, params, response)
                    self.assertEqual(len(self.calls), 1, self.calls)
                    self.assertIsNot(result.get("needs_human"), True)
                    if response.get("checkout_url"):
                        self.assertTrue(result["success"])
                        self.assertEqual(result["secure_payment_url"], response["checkout_url"])
                    else:
                        self.assertNotEqual(result.get("next_action"), "send_secure_payment_link")
                        self.assertFalse(result.get("staff_review_needed"))

    def test_missing_ids_and_wrong_id_type_stay_recoverable(self):
        for tool, _ in self.LINK_TOOLS:
            result = json.loads(getattr(plugin, tool)({}))
            self.assertIsNot(result.get("needs_human"), True)
        self.assertEqual(self.calls, [])
        result = self.call("create_payment_link", {"payment_id": "p1"},
                           {"success": False, "status": 404, "error": "payment not found"})
        self.assertTrue(result["wrong_id_type"])
        self.assertFalse(result["staff_review_needed"])
        self.assertEqual(len(self.calls), 1)

    def booking(self, *, per_guest=False, responses=None):
        guests = [{"booking_guest_id": f"g{n}", "guest_number": n, "guest_name": f"Guest {n}"}
                  for n in (1, 2)]
        self.calls.clear()
        self.responses = {
            "/booking-create-from-plan": {
                "success": True, "write_performed": True,
                "booking_id": "bk1", "booking_code": "OFFLINE", "payment_id": "p1",
                "payment_status": "pending", "uses_per_guest_model": per_guest,
                "booking_guests": guests if per_guest else None,
                "reply_draft": "Your booking is saved; here are all the payment links.",
            },
            **(responses or {}),
        }
        return json.loads(plugin.create_booking_from_plan({
            "check_in": "2026-10-01", "check_out": "2026-10-08",
            "guest_count": 2, "guests": [{"name": g["guest_name"]} for g in guests],
            "guest_name": "Guest 1", "selected_bed_codes": ["M1", "M2"], "room_preference": "mixed",
            "payment_choice": "per_guest" if per_guest else "full", "confirm": True, "package_code": "package_none",
        }))

    def test_inline_whole_failure_preserves_saved_booking_without_retry(self):
        result = self.booking(responses={"/payments/p1/create-stripe-link": {"success": False}})
        self.assert_handoff(result)
        self.assertTrue(result["success"], "booking write succeeded; payment failure is separate")
        self.assertTrue(result["write_performed"])
        self.assertEqual(result["booking_id"], "bk1")
        self.assertEqual(result["payment_status"], "pending")
        self.assertTrue(result["payment_operation_failed"])
        self.assertTrue(result["payment_link_error"])
        self.assertIn("saved", result["guest_safe_next_action"])
        self.assertNotIn("all the payment links", result["reply_draft"])
        self.assertEqual(len(self.calls), 3)

    def test_inline_partial_and_all_failed_links_flag_once_preserve_successful_links(self):
        for first in ({"success": True, "guest_payment_url": "https://checkout.invalid/g1"},
                      {"success": False}):
            with self.subTest(first=first):
                result = self.booking(per_guest=True, responses={
                    "/booking-guests/g1/create-payment-link": first,
                    "/booking-guests/g2/create-payment-link": {
                        "success": False, "guest_payment_url": "https://stale.invalid/g2"},
                })
                self.assert_handoff(result)
                self.assertTrue(result["write_performed"])
                self.assertTrue(result["success"])
                links = result.get("guest_payment_links") or []
                self.assertEqual(len(links), int(first["success"]))
                if links:
                    self.assertEqual(links[0]["secure_payment_url"], first["guest_payment_url"])
                self.assertEqual(len(result["payment_link_failures"]), 1 if links else 2)
                self.assertTrue(all(item["booking_guest_id"] for item in result["payment_link_failures"]))
                self.assertEqual(len(self.calls), 4)
                self.assertNotEqual(result["next_action"], "ask_per_guest_or_whole_payment_link")

    def test_inline_success_and_no_due_or_denied_are_not_handoffs(self):
        for per_guest in (False, True):
            for response in ({"success": True, "checkout_url": "https://checkout.invalid/pay"},
                             {"success": False, "error": "no_payment_due"},
                             {"success": True, "intentional_capability_block": True}):
                with self.subTest(per_guest=per_guest, response=response):
                    result = self.booking(per_guest=per_guest, responses={
                        "/payments/p1/create-stripe-link": response,
                        "/booking-guests/g1/create-payment-link": response,
                        "/booking-guests/g2/create-payment-link": response,
                    })
                    self.assertFalse(result.get("needs_human"))
                    self.assertFalse(result["staff_review_needed"])
                    self.assertEqual(len(self.calls), 3 if per_guest else 2)

    STATUS_TOOLS = (
        ("get_payment_status", "/payments/status"),
        ("get_guest_payment_status", "/booking-guests/payment-status"),
        ("get_sunset_payment_status", "/sunset/payment-status"),
    )

    def test_status_errors_and_explicit_failed_status_do_not_confirm_payment(self):
        for tool, route in self.STATUS_TOOLS:
            for response in (
                {"success": False, "payment_status": "paid", "paid": True, "amount_paid_cents": 100},
                {"paid": True, "payment_status": "paid", "amount_paid_cents": 100},
                {"success": "false", "payment_status": "paid", "paid": True},
                {"success": True, "payment_status": "failed", "paid": True, "amount_paid_cents": 100},
                TimeoutError("status timeout"),
            ):
                with self.subTest(tool=tool, response=response):
                    self.calls.clear()
                    os.environ["LUNA_CLIENT_SLUG"] = "sunset" if "sunset" in tool else "wolfhouse-somo"
                    self.responses[route] = response
                    result = json.loads(getattr(plugin, tool)({"booking_code": "OFFLINE", "guest_number": 1}))
                    self.assert_handoff(result)
                    self.assertFalse(result["payment_confirmed"])
                    self.assertIsNot(result.get("paid"), True)
                    self.assertIsNot(result.get("unpaid"), True, "failed lookup is not unpaid truth")
                    self.assertEqual(len(self.calls), 2)

    def test_failed_latest_receipt_preserves_prior_booking_amounts_not_confirmation(self):
        self.responses["/payments/status"] = {"success": True, "latest_payment": {
            "payment_status": "failed", "booking_payment_status": "deposit_paid",
            "amount_paid_cents": 10000, "balance_due_cents": 30000,
        }}
        result = json.loads(plugin.get_payment_status({"booking_code": "OFFLINE"}))
        self.assert_handoff(result)
        self.assertFalse(result["payment_confirmed"])
        self.assertEqual(result["amount_paid_cents"], 10000)
        self.assertEqual(result["balance_due_cents"], 30000)
        self.assertEqual(result["booking_payment_status"], "deposit_paid")

    def test_paid_and_pending_status_controls_do_not_handoff(self):
        for tool, route in self.STATUS_TOOLS:
            for paid in (True, False):
                with self.subTest(tool=tool, paid=paid):
                    self.calls.clear()
                    os.environ["LUNA_CLIENT_SLUG"] = "sunset" if "sunset" in tool else "wolfhouse-somo"
                    self.responses[route] = {"success": True, "paid": paid,
                        "payment_status": "paid" if paid else "pending", "amount_paid_cents": 100 if paid else 0}
                    result = json.loads(getattr(plugin, tool)({"booking_code": "OFFLINE", "guest_number": 1}))
                    self.assertEqual(result["payment_confirmed"], paid)
                    self.assertEqual(len(self.calls), 1)
                    self.assertIsNot(result.get("needs_human"), True)

    def test_status_missing_identifiers_never_call_transport_or_handoff(self):
        for tool, _ in self.STATUS_TOOLS:
            with self.subTest(tool=tool):
                result = json.loads(getattr(plugin, tool)({}))
                self.assertFalse(result["success"])
                self.assertIsNot(result.get("needs_human"), True)
        self.assertEqual(self.calls, [])

    def test_link_lookup_failures_handoff_without_using_stale_identifiers(self):
        for tool, route, params, response in (
            ("create_payment_link", "/payments/status", {"booking_code": "OFFLINE"},
             {"success": False, "latest_payment": {"payment_id": "stale"}}),
            ("create_guest_payment_link", "/booking-guests/payment-status",
             {"booking_code": "OFFLINE", "guest_number": 1},
             {"success": False, "booking_guest_id": "stale"}),
        ):
            with self.subTest(tool=tool):
                self.calls.clear()
                self.responses[route] = response
                result = json.loads(getattr(plugin, tool)(params))
                self.assert_handoff(result)
                self.assertEqual(len(self.calls), 2, "failed lookup must not mint a checkout")

    def test_inline_failed_guest_lookup_is_not_silently_skipped(self):
        self.responses = {
            "/booking-create-from-plan": {"success": True, "write_performed": True,
                "booking_code": "OFFLINE", "uses_per_guest_model": True,
                "booking_guests": [{"guest_number": 1, "guest_name": "Guest"}]},
            "/booking-guests/payment-status": {"success": False, "booking_guest_id": "stale"},
        }
        result = json.loads(plugin.create_booking_from_plan({
            "check_in": "2026-10-01", "check_out": "2026-10-08", "guest_count": 1,
            "guest_name": "Guest", "selected_bed_codes": ["M1"], "payment_choice": "per_guest",
            "package_code": "package_none", "room_preference": "mixed",
        }))
        self.assert_handoff(result)
        self.assertEqual(len(self.calls), 3)
        self.assertTrue(result["write_performed"])

    def test_failed_link_status_cannot_send_stale_checkout(self):
        for tool, params in self.LINK_TOOLS:
            with self.subTest(tool=tool):
                result = self.call(tool, params, {"success": True, "payment_status": "failed",
                                                "checkout_url": "https://stale.invalid/pay"})
                self.assert_handoff(result)

    def test_server_missing_details_remain_recoverable(self):
        for tool, params in self.LINK_TOOLS:
            for error in ("booking_id_or_code_required", "guest_name_missing", "payment_choice_missing"):
                with self.subTest(tool=tool, error=error):
                    result = self.call(tool, params, {"success": False, "error": error})
                    self.assertEqual(len(self.calls), 1)
                    self.assertIsNot(result.get("needs_human"), True)
                    self.assertFalse(result["staff_review_needed"])

    def test_sunset_failure_requests_real_handoff_with_trusted_identity(self):
        result = self.call("create_sunset_payment_link", {
            "booking_code": "OFFLINE", "client_slug": "wolfhouse-somo",
            "phone": "+34999999999", "conversation_id": "untrusted",
        }, {"success": False, "error": "provider unavailable"})
        self.assert_handoff(result)
        self.assertFalse(result["success"])
        self.assertIn("payment", result["guest_safe_next_action"].lower())


if __name__ == "__main__":
    unittest.main()
