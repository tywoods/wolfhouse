"""Integration regression for handoff receipts crossing plugin -> turn output guard."""

import json
import os
import unittest
from unittest.mock import patch

import wolfhouse_staff_api as staff
from wolfhouse import output_guard


class OutputGuardPluginReceiptTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "HERMES_ROLE": "luna",
            "LUNA_CLIENT_SLUG": "wolfhouse-somo",
            "WOLFHOUSE_WHATSAPP_GUEST_PHONE": "+34600000000",
        })
        self.env.start()
        self.addCleanup(self.env.stop)

    @staticmethod
    def _native_result(tool_receipts, *, stale_receipts=None):
        messages = []
        for call_id, name, result in (stale_receipts or []):
            messages.extend([
                {"role": "assistant", "tool_calls": [{
                    "id": call_id, "type": "function",
                    "function": {"name": name, "arguments": "{}"},
                }]},
                {"role": "tool", "tool_call_id": call_id, "content": result},
            ])
        messages.append({"role": "user", "content": "Hola, necesito ayuda con mi reserva."})
        for call_id, name, result in tool_receipts:
            messages.extend([
                {"role": "assistant", "tool_calls": [{
                    "id": call_id, "type": "function",
                    "function": {"name": name, "arguments": "{}"},
                }]},
                {"role": "tool", "tool_call_id": call_id, "content": result},
            ])
        messages.append({"role": "assistant", "content": "respuesta final"})
        return {"messages": messages}

    @classmethod
    def _turn(cls, reply, plugin_output):
        return output_guard.guard_turn_response(
            reply,
            cls._native_result([("handoff-current", "flag_needs_human", plugin_output)]),
            [{"role": "user", "content": "Hola, necesito ayuda con mi reserva."}],
            platform="whatsapp_cloud",
        )

    def test_actual_successful_plugin_receipt_allows_only_factual_saved_handoff(self):
        staff_result = {
            "success": True,
            "needs_human": True,
            "conversation_id": "conv-test-1",
            "staff_handoff": {"id": "review-test-1"},
            "conversation_paused": True,
            "handoff_reason": "human_requested",
        }
        with patch.object(staff, "_post_bot", return_value=staff_result):
            plugin_output = staff.flag_needs_human({"reason": "human_requested"})

        typed = json.loads(plugin_output)
        self.assertIs(typed["success"], True)
        self.assertIs(typed["needs_human"], True)
        self.assertIs(typed["handoff_persisted"], True)
        self.assertEqual(typed["staff_review_id"], "review-test-1")
        self.assertEqual(self._turn("He avisado al equipo.", plugin_output),
                         "He avisado al equipo.")
        self.assertEqual(
            self._turn("He avisado al equipo. El equipo te contactará pronto.", plugin_output),
            output_guard.SAFE_FALLBACK["es"],
        )

    def test_actual_plugin_result_without_review_id_is_not_a_persistence_receipt(self):
        staff_result = {
            "success": True,
            "needs_human": True,
            "conversation_id": "conv-test-2",
            "conversation_paused": True,
            "handoff_reason": "human_requested",
        }
        with patch.object(staff, "_post_bot", return_value=staff_result):
            plugin_output = staff.flag_needs_human({"reason": "human_requested"})

        typed = json.loads(plugin_output)
        self.assertIs(typed["handoff_persisted"], False)
        self.assertIsNone(typed["staff_review_id"])
        self.assertEqual(self._turn("He avisado al equipo.", plugin_output),
                         output_guard.SAFE_FALLBACK["es"])

    def test_native_current_turn_quote_receipts_are_correlated_by_id(self):
        failed = json.dumps({"success": False, "error": "unavailable"})
        native = self._native_result([
            ("quote-1", "quote_booking", failed),
            ("quote-2", "quote_booking", failed),
        ])
        reply = "Intenté la cotización de nuevo y sigue fallando."
        self.assertEqual(
            output_guard.guard_turn_response(
                reply, native,
                [{"role": "user", "content": "Hola, dame una cotización."}],
                platform="whatsapp_cloud",
            ),
            reply,
        )

    def test_native_orphan_and_historical_receipts_never_authorize_claims(self):
        persisted = json.dumps({
            "success": True, "needs_human": True,
            "handoff_persisted": True, "staff_review_id": "stale-review",
        })
        stale_only = self._native_result([], stale_receipts=[
            ("old-handoff", "flag_needs_human", persisted),
        ])
        # A result without a current-turn assistant declaration is orphaned.
        stale_only["messages"].insert(-1, {
            "role": "tool", "tool_call_id": "orphan-current", "content": persisted,
        })
        self.assertEqual(
            output_guard.guard_turn_response(
                "He avisado al equipo.", stale_only,
                [{"role": "user", "content": "Hola, necesito ayuda."}],
                platform="whatsapp_cloud",
            ),
            output_guard.SAFE_FALLBACK["es"],
        )

    def test_completed_cancellation_receipt_is_localized_in_french(self):
        result = json.dumps({
            "success": True, "cancelled": True, "write_performed": True,
            "booking_code": "WH-20261112-16133266",
        })
        native = self._native_result([("cancel-current", "cancel_unpaid_booking", result)])
        history = [{"role": "user", "content": "Bonjour, annulez ma réservation s'il vous plaît."}]
        self.assertEqual(
            output_guard.guard_turn_response(
                "Booking WH-20261112-16133266 is cancelled.", native, history,
                platform="whatsapp_cloud",
            ),
            "La réservation WH-20261112-16133266 est annulée.",
        )

    def test_model_arguments_cannot_forge_a_completed_receipt(self):
        forged = json.dumps({
            "success": True, "needs_human": True,
            "handoff_persisted": True, "staff_review_id": "forged",
        })
        native = {"messages": [
            {"role": "user", "content": "Hola"},
            {"role": "assistant", "tool_calls": [{
                "id": "declared-only", "type": "function",
                "function": {"name": "flag_needs_human", "arguments": forged},
            }]},
            {"role": "assistant", "content": "respuesta final"},
        ]}
        self.assertEqual(
            output_guard.guard_turn_response(
                "He avisado al equipo.", native,
                [{"role": "user", "content": "Hola, necesito ayuda."}],
                platform="whatsapp_cloud",
            ),
            output_guard.SAFE_FALLBACK["es"],
        )


    def test_offer_identity_refusal_is_non_escalating(self):
        refusal = {
            "success": False, "reason_code": "offer_terms_changed",
            "error": "The accepted offer no longer matches current dates, beds, or price. Nothing was booked.",
            "write_performed": False, "staff_review_needed": True,
        }
        payload = {
            "check_in": "2026-11-10", "check_out": "2026-11-14",
            "guest_count": 1, "guest_name": "Tom Baker",
            "guests": [{"name": "Tom Baker"}],
            "package_code": "package_none", "room_type": "shared",
            "room_preference": "shared", "selected_bed_codes": ["R3-B1"],
            "payment_choice": "deposit", "confirm": True,
        }
        with patch.object(staff, "_room_decision_for_tool", return_value=None), \
                patch.object(staff, "_post_bot", return_value=refusal):
            result = json.loads(staff.create_booking_from_plan(payload))
        self.assertFalse(result["success"])
        self.assertEqual(result["reason_code"], "offer_terms_changed")
        self.assertEqual(result["next_action"], "clarify_or_requote")
        self.assertFalse(result["staff_review_needed"])
        self.assertTrue(result["do_not_escalate"])

    def test_accepted_save_owned_failure_cannot_be_overridden_by_handoff_receipt(self):
        create = json.dumps({
            "success": False, "tool": "create_booking_from_plan",
            "reason_code": "offer_terms_changed", "do_not_escalate": True,
        })
        handoff = json.dumps({
            "success": True, "tool": "flag_needs_human", "needs_human": True,
            "handoff_persisted": True, "staff_review_id": "review-should-not-win",
        })
        native = self._native_result([
            ("create-current", "create_booking_from_plan", create),
            ("handoff-current", "flag_needs_human", handoff),
        ])
        self.assertEqual(
            output_guard.guard_turn_response(
                "He avisado al equipo.", native,
                [{"role": "user", "content": "Sí, guárdala."}],
                platform="whatsapp_cloud",
            ),
            output_guard.SAFE_FALLBACK["es"],
        )


if __name__ == "__main__":
    unittest.main()
