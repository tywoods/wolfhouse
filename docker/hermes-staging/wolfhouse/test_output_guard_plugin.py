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
    def _turn(reply, plugin_output):
        return output_guard.guard_turn_response(
            reply,
            {"tool_calls": [{"name": "flag_needs_human", "result": plugin_output}]},
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


if __name__ == "__main__":
    unittest.main()
