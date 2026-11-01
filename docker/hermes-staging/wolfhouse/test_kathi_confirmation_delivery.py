import os
import sys
import threading
import unittest
from contextvars import Token
from types import ModuleType, SimpleNamespace
from unittest import mock

from wolfhouse import explicit_human_handoff as handoff
from wolfhouse import pause_gate
from wolfhouse_staff_api import _extract_booking_write_fields


class KathiConfirmationDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.turn = SimpleNamespace(
            requested=True,
            booking_saved=False,
            booking_created=False,
            booking_receipt=None,
            handoff_pause_created=False,
            handoff_pause_identity=None,
            confirmation_owed=False,
            tenant="wolfhouse-somo",
            phone="+34900000001",
        )
        self.token = handoff._ORDINARY_TURN.set(self.turn)
        self.env = mock.patch.dict(os.environ, {
            "LUNA_CLIENT_SLUG": "wolfhouse-somo", "HERMES_ROLE": "luna",
        })
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
        self.turn.handoff_pause_identity = {
            "id": "pause-own", "conversation_id": "conv-own",
            "paused_by": "luna-bot", "pause_reason": "human_requested",
            "source": "bot_pause_states", "scope": "conversation",
        }
        self.assertTrue(handoff.allow_ordinary_handoff_reply(
            "+34900000001",
            {"send_blocked": True, "stage_as_draft": False,
             "agent_paused": True, "reason": "paused", "whatsapp_channel_mode": "auto",
             "pause_source": "bot_pause_states", "pause_scope": "conversation",
             "global_paused": False, "conversation_paused": True,
             "pause_state": {"id": "pause-own", "conversation_id": "conv-own",
                             "paused_by": "luna-bot", "pause_reason": "human_requested"},
             "same_turn_handoff_pause": True},
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

    def test_pause_gate_attaches_runtime_scope_only_to_exact_conversation_pause(self):
        own = {
            "id": "pause-own", "conversation_id": "conv-own",
            "paused_by": "luna-bot", "pause_reason": "human_requested",
            "source": "bot_pause_states", "scope": "conversation",
        }
        token = pause_gate.claim_same_turn_handoff_pause("+34900000001", own)
        try:
            exact = {
                "bot_paused": True, "whatsapp_channel_mode": "auto",
                "source": "bot_pause_states", "effective_scope": "conversation",
                "global_paused": False, "conversation_paused": True,
                "pause_state": {"id": "pause-own", "conversation_id": "conv-own",
                                "paused_by": "luna-bot", "pause_reason": "human_requested"},
            }
            cases = (
                (exact, "+34900000001", True),
                ({**exact, "effective_scope": "global", "global_paused": True,
                  "conversation_paused": False, "source": "bot_pause_states_global"},
                 "+34900000001", False),
                ({**exact, "pause_state": {**exact["pause_state"], "id": "pause-other"}},
                 "+34900000001", False),
                ({**exact, "pause_state": {**exact["pause_state"], "paused_by": "staff-user"}},
                 "+34900000001", False),
                ({**exact, "pause_state": None}, "+34900000001", False),
                ({**exact, "whatsapp_channel_mode": None}, "+34900000001", False),
                (exact, "+34900009999", False),
            )
            for data, phone, expected in cases:
                with self.subTest(data=data, phone=phone):
                    with mock.patch.object(
                        pause_gate, "_lookup_guest_automation_gate",
                        return_value=("key", data, False),
                    ):
                        disposition = pause_gate.whatsapp_outbound_disposition(phone)
                    self.assertIs(disposition.get("same_turn_handoff_pause", False), expected)
        finally:
            pause_gate.release_same_turn_handoff_pause(token)

    def test_persist_marks_only_a_newly_created_handoff_pause(self):
        handoff._ORDINARY_TURN.reset(self.token)
        base = dict(
            requested=False, booking_saved=False, booking_created=False,
            booking_receipt=None, handoff_pause_created=False,
            handoff_pause_identity=None,
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
                ({"send_blocked": False, "stage_as_draft": False,
                  "reason": "send", "whatsapp_channel_mode": "auto"}, True),
                ({"send_blocked": False, "stage_as_draft": False,
                  "reason": "send", "whatsapp_channel_mode": None}, False),
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
                                         "conversation_paused": True,
                                         "conversation_id": "conv-own",
                                         "pause_state": {
                                             "id": "pause-own", "conversation_id": "conv-own",
                                             "paused_by": "luna-bot",
                                             "pause_reason": "human_requested",
                                         }},
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
        self.assertNotIn("confirmation_delivery_blocked", calls[0])

    def test_model_cannot_authorize_confirmation_block_handoff(self):
        self.turn.booking_saved = True
        persisted = []
        result = handoff.persist_ordinary_handoff(
            {"reason": "model_argument", "confirmation_delivery_blocked": True},
            lambda: persisted.append(True),
        )
        self.assertFalse(persisted)
        self.assertTrue(result["saved_booking_confirmation_required"])

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
