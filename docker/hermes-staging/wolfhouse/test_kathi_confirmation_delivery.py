import os
import sys
import threading
import unittest
from contextvars import Token
from types import ModuleType, SimpleNamespace
from unittest import mock

from wolfhouse import explicit_human_handoff as handoff
from wolfhouse_staff_api import _extract_booking_write_fields


class KathiConfirmationDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.turn = SimpleNamespace(
            requested=True,
            booking_saved=False,
            booking_created=False,
            booking_receipt=None,
            handoff_pause_created=False,
            confirmation_owed=False,
            tenant="wolfhouse-somo",
            phone="+34900000001",
        )
        self.token = handoff._ORDINARY_TURN.set(self.turn)
        self.env = mock.patch.dict(os.environ, {"LUNA_CLIENT_SLUG": "wolfhouse-somo"})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        handoff._ORDINARY_TURN.reset(self.token)

    def test_recovered_saved_receipt_is_authoritative_without_fresh_write(self):
        handoff.note_successful_booking_create({
            "success": True,
            "write_performed": False,
            "booking_code": "WH-20270310-03802502",
        })
        self.assertTrue(self.turn.booking_saved)
        self.assertEqual(self.turn.booking_receipt["booking_code"], "WH-20270310-03802502")

    def test_same_turn_handoff_pause_is_the_only_pause_exception(self):
        self.turn.handoff_pause_created = True
        self.assertTrue(handoff.allow_ordinary_handoff_reply(
            "+34900000001",
            {"send_blocked": True, "stage_as_draft": False,
             "agent_paused": True, "reason": "paused", "whatsapp_channel_mode": "auto"},
        ))
        for disposition in (
            {"send_blocked": True, "stage_as_draft": True, "reason": "inbox_channel_mode_draft"},
            {"send_blocked": True, "stage_as_draft": False, "reason": "inbox_channel_mode_off"},
            {"send_blocked": True, "stage_as_draft": False, "reason": "gate_fail_closed"},
            {"send_blocked": True, "stage_as_draft": False, "reason": "local_automation_blocked"},
            {"send_blocked": True, "stage_as_draft": False, "reason": "live_send_blocked"},
        ):
            with self.subTest(disposition=disposition):
                self.assertFalse(handoff.allow_ordinary_handoff_reply(
                    "+34900000001", disposition))

    def test_persist_marks_only_a_newly_created_handoff_pause(self):
        handoff._ORDINARY_TURN.reset(self.token)
        base = dict(
            requested=False, booking_saved=False, booking_created=False,
            booking_receipt=None, handoff_pause_created=False,
            confirmation_owed=False, tenant="wolfhouse-somo", phone="+349****0001",
            closed=False, task=SimpleNamespace(cancelling=lambda: False),
            origin="https://staff.invalid", lock=threading.Lock(), result=None,
            ack_attempted=False, ack_sent=False, thread=threading.get_ident(),
            event={}, adapter=None, loop=None,
        )
        with mock.patch.dict(os.environ, {
            "LUNA_CLIENT_SLUG": "wolfhouse-somo",
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff.invalid",
        }), mock.patch(
            "wolfhouse.luna_personality_isolation.deny_tool_if_isolated",
            return_value=None,
        ):
            for baseline, expected in (
                ({"send_blocked": False, "stage_as_draft": False, "reason": "send"}, True),
                ({"send_blocked": True, "stage_as_draft": True,
                  "reason": "inbox_channel_mode_draft"}, False),
                ({"send_blocked": True, "stage_as_draft": False,
                  "reason": "gate_fail_closed"}, False),
            ):
                with self.subTest(baseline=baseline):
                    turn = SimpleNamespace(**base)
                    token = handoff._ORDINARY_TURN.set(turn)
                    try:
                        with mock.patch(
                            "wolfhouse.pause_gate.whatsapp_outbound_disposition",
                            return_value=baseline,
                        ):
                            handoff.persist_ordinary_handoff(
                                {"reason": "human_requested", "phone": "+349****0001"},
                                lambda: {"success": True, "needs_human": True,
                                         "conversation_paused": True},
                            )
                        self.assertIs(turn.handoff_pause_created, expected)
                    finally:
                        handoff._ORDINARY_TURN.reset(token)
        self.token = handoff._ORDINARY_TURN.set(self.turn)

    def test_real_block_keeps_confirmation_owed_and_flags_staff_with_reason(self):
        self.turn.booking_saved = True
        self.turn.booking_receipt = {"booking_code": "WH-20270310-03802502"}
        fake = ModuleType("wolfhouse_staff_api")
        calls = []
        fake.flag_needs_human = lambda payload: (
            calls.append(payload) or '{"success":true,"needs_human":true}'
        )
        with mock.patch.dict(sys.modules, {"wolfhouse_staff_api": fake}):
            self.assertTrue(handoff.flag_blocked_saved_confirmation("inbox_channel_mode_draft"))
        self.assertTrue(self.turn.confirmation_owed)
        self.assertEqual(calls[0]["reason"],
                         "saved_booking_confirmation_blocked:inbox_channel_mode_draft")
        self.assertTrue(calls[0]["confirmation_delivery_blocked"])

    def test_balance_timing_flattens_top_nested_and_recovered_receipts(self):
        shapes = (
            {"balance_due_at": "2027-02-10", "balance_due_timing": "30 days before arrival"},
            {"create_outcome": {"create_response": {
                "booking_code": "WH-RECOVERED",
                "balance_due_at": "2027-02-10",
                "balance_due_timing": "30 days before arrival",
            }}},
            {"create_outcome": {"create_response": {"booking": {
                "booking_code": "WH-NESTED",
                "balance_due_at": "2027-02-10",
                "balance_due_timing": "30 days before arrival",
            }}}},
            {"booking": {
                "booking_code": "WH-BOOKING",
                "balance_due_at": "2027-02-10",
                "balance_due_timing": "30 days before arrival",
            }},
        )
        for receipt in shapes:
            with self.subTest(receipt=receipt):
                fields = _extract_booking_write_fields(receipt)
                self.assertEqual(fields["balance_due_at"], "2027-02-10")
                self.assertEqual(fields["balance_due_timing"], "30 days before arrival")


if __name__ == "__main__":
    unittest.main()
