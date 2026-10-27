import importlib.util
import io
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch
from urllib.error import HTTPError


ROOT = Path(__file__).resolve().parents[3]
HERMES_STAGING = ROOT / "docker/hermes-staging"
if str(HERMES_STAGING) not in sys.path:
    sys.path.insert(0, str(HERMES_STAGING))
PLUGIN_PATH = HERMES_STAGING / "plugins/wolfhouse_staff_api/__init__.py"
SOUL_PATH = ROOT / "docker/hermes-staging/SOUL.md"

from wolfhouse import output_guard


def load_plugin():
    spec = importlib.util.spec_from_file_location("cancel_unpaid_contract_plugin", PLUGIN_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class CancelUnpaidContractTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plugin = load_plugin()

    def test_http_409_preserves_staff_cancellation_refusal_reason(self):
        body = json.dumps({
            "success": False,
            "cancelled": False,
            "write_performed": False,
            "staff_review_needed": True,
            "handoff_reason": "paid_or_unknown_cancellation",
            "blocked_reason": "payment_exists",
            "guest_safe_next_action": "I’ll ask the team to help with this cancellation.",
        }).encode()
        error = HTTPError(
            "https://staff.test/staff/bot/bookings/cancel-unpaid",
            409,
            "Conflict",
            {},
            io.BytesIO(body),
        )
        with patch.object(self.plugin, "_base_url", return_value="https://staff.test"), \
             patch.object(self.plugin, "_bot_token", return_value="token"), \
             patch.object(self.plugin, "_trusted_client_slug", return_value="wolfhouse-somo"), \
             patch("wolfhouse.crowsnest_guest_door.staff_transport_denial", return_value=None), \
             patch.object(self.plugin, "_session_guest_phone", return_value="+34600000000"), \
             patch.object(self.plugin.urllib.request, "urlopen", side_effect=error):
            result = self.plugin._post_bot(
                "/bookings/cancel-unpaid",
                {"booking_code": "WH-PAID"},
            )

        self.assertEqual(result["blocked_reason"], "payment_exists")
        self.assertEqual(result["handoff_reason"], "paid_or_unknown_cancellation")
        self.assertFalse(result["cancelled"])
        self.assertFalse(result["write_performed"])
        self.assertTrue(result["staff_review_needed"])

    def test_tool_result_projects_confirmed_booking_code_and_staff_refusal(self):
        with patch.object(self.plugin, "_live_turn_guest_phone", return_value="+34600000000"):
            with patch.object(self.plugin, "_post_bot", return_value={
                "success": True,
                "cancelled": True,
                "write_performed": True,
                "booking": {"booking_code": "WH-CANCELLED", "status": "cancelled"},
            }):
                success = json.loads(self.plugin.cancel_unpaid_booking({"booking_code": "WH-CANCELLED"}))
            with patch.object(self.plugin, "_post_bot", return_value={
                "success": False,
                "cancelled": False,
                "write_performed": False,
                "blocked_reason": "payment_exists",
                "handoff_reason": "paid_or_unknown_cancellation",
                "staff_review_needed": True,
            }):
                refusal = json.loads(self.plugin.cancel_unpaid_booking({"booking_code": "WH-PAID"}))

        self.assertEqual(success["booking_code"], "WH-CANCELLED")
        self.assertEqual(success["cancellation_status"], "cancelled")
        self.assertEqual(success["blocked_reason"], None)
        self.assertEqual(refusal["booking_code"], "WH-PAID")
        self.assertEqual(refusal["blocked_reason"], "payment_exists")
        self.assertEqual(refusal["handoff_reason"], "paid_or_unknown_cancellation")

    def test_confirmed_cancel_reply_is_derived_from_staff_receipt(self):
        tool_calls = [{
            "name": "cancel_unpaid_booking",
            "result": json.dumps({
                "success": True,
                "cancelled": True,
                "write_performed": True,
                "booking_code": "WH-CANCELLED",
                "cancellation_status": "cancelled",
            }),
        }]
        text, findings = output_guard.guard_reply(
            "I've sorted that out.", tool_calls=tool_calls, guest_lang="en"
        )
        self.assertEqual(text, "Booking WH-CANCELLED is cancelled.")
        self.assertIn("confirmed_cancellation_receipt", [finding["kind"] for finding in findings])

    def test_unconfirmed_cancel_claim_is_blocked(self):
        tool_calls = [{
            "name": "cancel_unpaid_booking",
            "result": json.dumps({
                "success": False,
                "cancelled": False,
                "write_performed": False,
                "booking_code": "WH-PAID",
                "blocked_reason": "payment_exists",
            }),
        }]
        text, findings = output_guard.guard_reply(
            "Booking WH-PAID is cancelled.", tool_calls=tool_calls, guest_lang="en"
        )
        self.assertNotIn("is cancelled", text)
        self.assertIn("unsupported_cancellation_claim", [finding["kind"] for finding in findings])

    def test_truthful_not_cancelled_reply_is_preserved(self):
        tool_calls = [{
            "name": "cancel_unpaid_booking",
            "result": json.dumps({
                "success": False,
                "cancelled": False,
                "write_performed": False,
                "booking_code": "WH-PAID",
                "blocked_reason": "payment_exists",
            }),
        }]
        reply = "Booking WH-PAID is not cancelled."
        text, findings = output_guard.guard_reply(reply, tool_calls=tool_calls, guest_lang="en")
        self.assertEqual(text, reply)
        self.assertNotIn("unsupported_cancellation_claim", [finding["kind"] for finding in findings])

    def test_instructions_require_staff_write_even_when_an_unpaid_link_exists(self):
        soul = SOUL_PATH.read_text(encoding="utf-8")
        self.assertIn("A payment link or pending checkout is not proof that payment was made", soul)
        self.assertIn("must call `cancel_unpaid_booking`", soul)

        captured = []
        ctx = SimpleNamespace(
            register_tool=lambda **kwargs: captured.append(kwargs),
            register_hook=lambda *args, **kwargs: None,
        )
        with patch.object(self.plugin, "_trusted_client_slug", return_value="wolfhouse-somo"), \
             patch.object(self.plugin, "_is_sunset_tenant", return_value=False):
            self.plugin.register(ctx)
        description = next(t["description"] for t in captured if t["name"] == "cancel_unpaid_booking")
        self.assertIn("MUST call this tool", description)
        self.assertIn("payment link", description)
        self.assertIn("Staff decides", description)


if __name__ == "__main__":
    import unittest
    unittest.main()
