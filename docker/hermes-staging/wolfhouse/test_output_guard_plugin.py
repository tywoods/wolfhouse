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


if __name__ == "__main__":
    unittest.main()
