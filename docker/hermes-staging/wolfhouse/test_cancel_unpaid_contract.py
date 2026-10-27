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

    def test_list_follow_through_receipt_confirms_cancel_reply(self):
        tool_calls = [{
            "name": "list_my_bookings",
            "result": json.dumps({
                "success": True,
                "bookings": [{"booking_code": "WH-CANCELLED"}],
                "unpaid_cancel_follow_through": {
                    "success": True,
                    "cancelled": True,
                    "write_performed": True,
                    "booking_code": "WH-CANCELLED",
                    "cancellation_status": "cancelled",
                },
            }),
        }]
        text, findings = output_guard.guard_reply(
            "I couldn't cancel that booking.", tool_calls=tool_calls, guest_lang="en"
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

    def _native_guard(self, *, guest_text, reply, tool_result=None, declare_only=False):
        messages = [
            {"role": "user", "content": guest_text},
            {"role": "assistant", "tool_calls": [{
                "id": "cancel-1",
                "type": "function",
                "function": {"name": "cancel_unpaid_booking", "arguments": "{}"},
            }]},
        ]
        if tool_result is not None:
            messages.append({
                "role": "tool",
                "tool_call_id": "cancel-1",
                "content": json.dumps(tool_result),
            })
        self.assertTrue(declare_only or tool_result is not None)
        with patch.dict("os.environ", {"HERMES_ROLE": "luna"}, clear=False):
            return output_guard.guard_turn_response(
                reply, {"messages": messages}, [{"role": "user", "content": guest_text}], "whatsapp"
            )

    def test_native_en_declaration_without_result_cannot_claim_cancelled(self):
        text = self._native_guard(
            guest_text="Please cancel the booking.",
            reply="Booking WH-FRESH is cancelled.",
            declare_only=True,
        )
        self.assertNotIn("is cancelled", text.lower())

    def test_native_es_declaration_without_result_cannot_claim_cancelled(self):
        text = self._native_guard(
            guest_text="Por favor cancela mi reserva.",
            reply="La reserva WH-FRESH está cancelada.",
            declare_only=True,
        )
        self.assertNotIn("está cancelada", text.lower())

    def test_native_it_declaration_without_result_cannot_claim_cancelled(self):
        text = self._native_guard(
            guest_text="Per favore annulla la mia prenotazione.",
            reply="La prenotazione WH-FRESH è annullata.",
            declare_only=True,
        )
        self.assertNotIn("è annullata", text.lower())

    def _assert_native_receipt_wins_over_stale_handoff(self, guest_text, reply, expected):
        text = self._native_guard(
            guest_text=guest_text,
            reply=reply,
            tool_result={
                "success": True,
                "cancelled": True,
                "write_performed": True,
                "booking_code": "WH-DONE",
                "cancellation_status": "cancelled",
            },
        )
        self.assertEqual(text, expected)

    def test_native_en_receipt_wins_over_stale_handoff_draft(self):
        self._assert_native_receipt_wins_over_stale_handoff(
            "Please cancel my booking.",
            "Booking WH-DONE is cancelled. I've passed this to the team.",
            "Booking WH-DONE is cancelled.",
        )

    def test_native_es_receipt_wins_over_stale_handoff_draft(self):
        self._assert_native_receipt_wins_over_stale_handoff(
            "Por favor cancela mi reserva.",
            "La reserva WH-DONE está cancelada. He avisado al equipo.",
            "La reserva WH-DONE está cancelada.",
        )

    def test_native_it_receipt_wins_over_stale_handoff_draft(self):
        self._assert_native_receipt_wins_over_stale_handoff(
            "Per favore annulla la mia prenotazione.",
            "La prenotazione WH-DONE è annullata. I've passed this to the team.",
            "La prenotazione WH-DONE è annullata.",
        )

    def test_clause_negation_does_not_exempt_false_cancellation_confirmations(self):
        """A not-cancelled elsewhere in the draft cannot license a cancelled claim."""
        guests = {
            "en": "Please cancel the booking.",
            "es": "Por favor cancela mi reserva.",
            "it": "Per favore annulla la mia prenotazione.",
        }
        false_confirm = {
            "en": [
                "No problem, your booking is cancelled.",
                "Booking WH-OFFLINE is cancelled. Your transfer is not cancelled.",
            ],
            "es": [
                "No pasa nada, tu reserva está cancelada.",
                "La reserva WH-OFFLINE está cancelada. Tu traslado no está cancelado.",
            ],
            "it": [
                "No problem, la prenotazione è annullata.",
                "La prenotazione WH-OFFLINE è annullata. Your transfer is not cancelled.",
            ],
        }
        staff_refusal = {
            "success": False, "cancelled": False, "write_performed": False,
            "booking_code": "WH-PAID", "blocked_reason": "payment_exists",
        }
        blocked = 0
        for lang, phrases in false_confirm.items():
            for reply in phrases:
                text, findings = output_guard.guard_reply(reply, guest_lang=lang, tool_calls=[])
                self.assertNotRegex(text, r"\\b(?:is cancelled|está cancelada|è annullata)\\b", reply)
                self.assertIn("unsupported_cancellation_claim", [f["kind"] for f in findings])
                blocked += 1
                text = self._native_guard(guest_text=guests[lang], reply=reply, declare_only=True)
                self.assertNotRegex(text.lower(), r"is cancelled|está cancelada|è annullata")
                blocked += 1
                text, findings = output_guard.guard_reply(
                    reply, guest_lang=lang,
                    tool_calls=[{"name": "cancel_unpaid_booking", "result": json.dumps(staff_refusal)}],
                )
                self.assertNotRegex(text, r"\\b(?:is cancelled|está cancelada|è annullata)\\b")
                self.assertIn("unsupported_cancellation_claim", [f["kind"] for f in findings])
                blocked += 1
        self.assertEqual(blocked, 18)

    def test_true_booking_negations_are_preserved_in_en_es_it(self):
        staff_refusal = {
            "success": False, "cancelled": False, "write_performed": False,
            "booking_code": "WH-PAID", "blocked_reason": "payment_exists",
        }
        tool_calls = [{"name": "cancel_unpaid_booking", "result": json.dumps(staff_refusal)}]
        for lang, reply in {
            "en": "Your booking is not cancelled.",
            "es": "Tu reserva no está cancelada.",
            "it": "La tua prenotazione non è annullata.",
        }.items():
            text, findings = output_guard.guard_reply(reply, guest_lang=lang, tool_calls=tool_calls)
            self.assertEqual(text, reply, lang)
            self.assertNotIn("unsupported_cancellation_claim", [f["kind"] for f in findings], lang)

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
