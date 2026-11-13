"""flag_needs_human posts structured booking_code for Inbox handoff_booking_code.

Run: python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_handoff_booking_code.py -v
"""
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

STAGING = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(STAGING), str(STAGING / "plugins")]
import wolfhouse_staff_api as plugin
from wolfhouse import explicit_human_handoff as handoff


class HandoffBookingCodeTests(unittest.TestCase):
    def setUp(self):
        self.posted = []
        env = patch.dict(os.environ, {
            "LUNA_CLIENT_SLUG": "wolfhouse-somo",
            "LUNA_BOT_INTERNAL_TOKEN": "offline-fixture-not-a-credential",
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff.invalid",
            "WOLFHOUSE_WHATSAPP_GUEST_PHONE": "+" + "999" + "000000000001",
        }, clear=False)
        env.start()
        self.addCleanup(env.stop)

        def fake_post(path, payload, **kwargs):
            self.posted.append((path, dict(payload)))
            return {
                "success": True,
                "needs_human": True,
                "conversation_id": "offline-conversation",
                "conversation_paused": True,
                "staff_handoff": {"id": "handoff-1"},
            }

        for guard in (
            patch.object(plugin, "_post_bot", side_effect=fake_post),
            patch("wolfhouse_staff_api.handoff_guest_note.send_before_handoff", return_value=None),
            patch.object(handoff, "persist_ordinary_handoff", side_effect=lambda payload, fn: fn()),
            patch.object(handoff, "ordinary_handoff_phone", return_value="+" + "999" + "000000000001"),
            patch("wolfhouse.luna_intelligence.public_research_failed_this_turn", return_value=False),
        ):
            guard.start()
            self.addCleanup(guard.stop)

    def _flag(self, params):
        return json.loads(plugin.flag_needs_human(params))

    def test_extracts_wh_code_from_reason(self):
        result = self._flag({
            "reason": "complaint: occupant addition unsupported WH-20270920-14052366",
        })
        self.assertTrue(result["success"])
        self.assertEqual(self.posted[0][0], "/conversation/needs-human")
        self.assertEqual(self.posted[0][1]["booking_code"], "WH-20270920-14052366")

    def test_explicit_booking_code_wins(self):
        result = self._flag({
            "reason": "complaint: leftover WH-19990101-00000000",
            "booking_code": "WH-20270920-14052366",
        })
        self.assertTrue(result["success"])
        self.assertEqual(self.posted[0][1]["booking_code"], "WH-20270920-14052366")

    def test_omits_booking_code_when_absent(self):
        result = self._flag({"reason": "complaint: unresolved issue"})
        self.assertTrue(result["success"])
        self.assertNotIn("booking_code", self.posted[0][1])

    def test_saved_receipt_fills_booking_code(self):
        with patch.object(plugin, "_successful_owner_booking_receipt",
                          return_value={"booking_code": "WH-20270920-14052366"}):
            result = self._flag({"reason": "complaint"})
        self.assertTrue(result["success"])
        self.assertEqual(self.posted[0][1]["booking_code"], "WH-20270920-14052366")

    def test_helper_extracts_lunabot_add_guest_reason(self):
        code = plugin._handoff_booking_code(
            {}, "no_bed_for_added_guest WH-20270920-14052366")
        self.assertEqual(code, "WH-20270920-14052366")


if __name__ == "__main__":
    unittest.main()
