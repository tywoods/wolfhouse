import json
import os
import sys
import tempfile
import threading
import unittest
from contextvars import Token
from types import ModuleType, SimpleNamespace
from unittest import mock

from wolfhouse import explicit_human_handoff as handoff
from wolfhouse import pause_gate
import wolfhouse_staff_api as staff_api
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
        self.fence_home = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {
            "LUNA_CLIENT_SLUG": "wolfhouse-somo", "HERMES_ROLE": "luna",
            "WOLFHOUSE_CONFIRMATION_FENCE_DB": os.path.join(
                self.fence_home.name, "fences.sqlite3"),
        })
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.fence_home.cleanup()
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

    def test_confirmation_owed_routes_use_exact_staff_contract(self):
        calls = []
        def post(path, payload, **kwargs):
            calls.append((path, payload, kwargs))
            return {"success": True, "owed": []}
        with mock.patch.object(staff_api, "_post_bot", side_effect=post):
            staff_api._confirmation_owed_open(
                conversation_id="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")
            staff_api._confirmation_owed_accepted(
                booking_id="11111111-2222-4333-8444-555555555555",
                provider_message_id="wamid.accepted",
            )
        self.assertEqual(calls, [
            ("/staff/bot/booking-confirmation-owed/open",
             {"conversation_id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"},
             {"require_explicit_success": True}),
            ("/staff/bot/booking-confirmation-owed/accepted",
             {"booking_id": "11111111-2222-4333-8444-555555555555",
              "provider_message_id": "wamid.accepted"},
             {"require_explicit_success": True}),
        ])

    def test_pre_pause_recovery_uses_open_owed_row_and_exact_pause_reference(self):
        disposition = {
            "whatsapp_channel_mode": "auto", "global_paused": False,
            "conversation_paused": True, "agent_paused": True,
            "send_blocked": True, "stage_as_draft": False,
            "pause_source": "bot_pause_states",
            "pause_scope": "conversation",
            "pause_state": {
                "id": "pause-confirmation", "conversation_id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
                "paused_by": "luna_flag_needs_human",
                "pause_reason": "needs_human:saved_booking_confirmation_blocked:provider_send_failed:booking_reference:WH-OPEN",
            },
        }
        owed = {"success": True, "owed": [{
            "booking_id": "11111111-2222-4333-8444-555555555555",
            "booking_code": "WH-OPEN",
            "conversation_id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            "owed_at": "2026-11-01T18:00:00Z", "provider_message_id": None,
        }]}
        event = SimpleNamespace(chat_id="+34600111222")
        with mock.patch.object(pause_gate, "whatsapp_outbound_disposition", return_value=disposition), \
             mock.patch.object(staff_api, "_confirmation_owed_open", return_value=owed):
            recovery = pause_gate.confirmation_recovery_for_event(event)
        self.assertEqual(recovery["booking_id"], "11111111-2222-4333-8444-555555555555")
        self.assertEqual(recovery["pause_state"]["id"], "pause-confirmation")

    def test_recovery_persists_missing_staff_incident_before_admission(self):
        conversation_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        initial = {
            "whatsapp_channel_mode": "auto", "global_paused": False,
            "conversation_paused": False, "agent_paused": False,
            "send_blocked": False, "stage_as_draft": False,
            "conversation_id": conversation_id,
            "pause_source": None, "pause_scope": None, "pause_state": None,
        }
        pause_reason = (
            "needs_human:saved_booking_confirmation_blocked:"
            "confirmation_rewrite_failed:booking_reference:WH-OPEN"
        )
        refreshed = {
            "whatsapp_channel_mode": "auto", "global_paused": False,
            "conversation_paused": True, "agent_paused": True,
            "send_blocked": True, "stage_as_draft": False,
            "conversation_id": conversation_id,
            "pause_source": "bot_pause_states", "pause_scope": "conversation",
            "pause_state": {
                "id": "pause-retried", "conversation_id": conversation_id,
                "paused_by": "luna_flag_needs_human", "pause_reason": pause_reason,
            },
        }
        owed = {"success": True, "owed": [{
            "booking_id": "11111111-2222-4333-8444-555555555555",
            "booking_code": "WH-OPEN", "conversation_id": conversation_id,
            "provider_message_id": None,
        }]}
        persisted = json.dumps({
            "success": True, "needs_human": True, "handoff_persisted": True,
            "staff_review_id": "review-retried", "handoff_reason": pause_reason.removeprefix("needs_human:"),
        })
        with mock.patch.object(pause_gate, "whatsapp_outbound_disposition",
                               side_effect=[initial, refreshed]), \
             mock.patch.object(staff_api, "_confirmation_owed_open", return_value=owed), \
             mock.patch.object(staff_api, "flag_needs_human", return_value=persisted) as flag:
            recovery = pause_gate.confirmation_recovery_for_event(
                SimpleNamespace(chat_id="+346****1222"))
        self.assertEqual(recovery["booking_id"], "11111111-2222-4333-8444-555555555555")
        self.assertEqual(recovery["pause_state"]["id"], "pause-retried")
        self.assertEqual(flag.call_args.args[0]["reason"], pause_reason.removeprefix("needs_human:"))

    def test_provider_acceptance_fence_survives_turn_memory_and_blocks_recovery(self):
        booking_id = "11111111-2222-4333-8444-555555555555"
        self.assertTrue(handoff._confirmation_fence_write(booking_id, "wamid.crash"))
        self.turn.confirmation_provider_pending = None
        self.assertEqual(handoff.confirmation_provider_fence(booking_id), "wamid.crash")
        disposition = {
            "whatsapp_channel_mode": "auto", "global_paused": False,
            "conversation_paused": True, "agent_paused": True,
            "send_blocked": True, "stage_as_draft": False,
            "pause_source": "bot_pause_states", "pause_scope": "conversation",
            "pause_state": {
                "id": "pause-crash", "conversation_id": "conv-crash",
                "paused_by": "luna_flag_needs_human",
                "pause_reason": (
                    "needs_human:saved_booking_confirmation_blocked:provider_send_failed:"
                    "booking_reference:WH-CRASH"
                ),
            },
        }
        opened = {"success": True, "owed": [{
            "booking_id": booking_id, "booking_code": "WH-CRASH",
            "conversation_id": "conv-crash", "provider_message_id": None,
        }]}
        with mock.patch.object(pause_gate, "whatsapp_outbound_disposition",
                               return_value=disposition), \
             mock.patch.object(staff_api, "_confirmation_owed_open", return_value=opened):
            self.assertIsNone(pause_gate.confirmation_recovery_for_event(
                SimpleNamespace(chat_id="+346****1222")))

    def test_open_recovery_send_accept_and_second_inbound_no_duplicate(self):
        conversation_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        booking_id = "11111111-2222-4333-8444-555555555555"
        disposition = {
            "whatsapp_channel_mode": "auto", "global_paused": False,
            "conversation_paused": True, "agent_paused": True,
            "send_blocked": True, "stage_as_draft": False,
            "pause_source": "bot_pause_states", "pause_scope": "conversation",
            "pause_state": {
                "id": "pause-confirmation", "conversation_id": conversation_id,
                "paused_by": "luna_flag_needs_human",
                "pause_reason": (
                    "needs_human:saved_booking_confirmation_blocked:provider_send_failed:"
                    "booking_reference:WH-OPEN"
                ),
            },
        }
        open_unaccepted = {"success": True, "owed": [{
            "booking_id": booking_id, "booking_code": "WH-OPEN",
            "conversation_id": conversation_id, "provider_message_id": None,
        }]}
        with mock.patch.object(pause_gate, "whatsapp_outbound_disposition",
                               return_value=disposition), \
             mock.patch.object(staff_api, "_confirmation_owed_open",
                               return_value=open_unaccepted):
            recovery = pause_gate.confirmation_recovery_for_event(
                SimpleNamespace(chat_id="+34600111222"))
        token = handoff.arm_confirmation_recovery(recovery)
        try:
            self.turn.booking_saved = True
            self.turn.phone = "+34600111222"
            self.turn.booking_receipt = {"booking_id": booking_id, "booking_code": "WH-OPEN"}
            self.assertTrue(handoff.allow_ordinary_handoff_reply(
                "+34600111222", disposition))
            self.assertTrue(handoff.note_saved_confirmation_payload(
                booking_id, "EXACT CONFIRMATION"))
            fake = ModuleType("wolfhouse_staff_api")
            fake._confirmation_owed_accepted = lambda **payload: {
                "success": True, "stamped": True, "cleared": False, **payload,
            }
            with mock.patch.dict(sys.modules, {"wolfhouse_staff_api": fake}):
                self.assertTrue(handoff.acknowledge_saved_confirmation(
                    "wamid.accepted", "EXACT CONFIRMATION"))
        finally:
            handoff.release_confirmation_recovery(token)
        open_accepted = {"success": True, "owed": [{
            "booking_id": booking_id, "booking_code": "WH-OPEN",
            "conversation_id": conversation_id,
            "provider_message_id": "wamid.accepted",
        }]}
        with mock.patch.object(pause_gate, "whatsapp_outbound_disposition",
                               return_value=disposition), \
             mock.patch.object(staff_api, "_confirmation_owed_open",
                               return_value=open_accepted):
            self.assertIsNone(pause_gate.confirmation_recovery_for_event(
                SimpleNamespace(chat_id="+34600111222")))

    def test_armed_recovery_allows_exact_existing_pause_send(self):
        self.turn.booking_saved = True
        self.turn.phone = "+34600111222"
        recovery = {
            "booking_id": "11111111-2222-4333-8444-555555555555",
            "pause_state": {
                "id": "pause-confirmation", "conversation_id": "conv-own",
                "paused_by": "luna_flag_needs_human",
                "pause_reason": "needs_human:saved_booking_confirmation_blocked:provider_send_failed",
                "source": "bot_pause_states", "scope": "conversation",
            },
        }
        disposition = {
            "whatsapp_channel_mode": "auto", "global_paused": False,
            "conversation_paused": True, "agent_paused": True,
            "send_blocked": True, "stage_as_draft": False,
            "pause_source": "bot_pause_states", "pause_scope": "conversation",
            "pause_state": dict(recovery["pause_state"]),
        }
        token = handoff.arm_confirmation_recovery(recovery)
        try:
            self.assertTrue(handoff.allow_ordinary_handoff_reply(
                "+34600111222", disposition))
        finally:
            handoff.release_confirmation_recovery(token)

    def test_confirmation_payload_status_detects_output_guard_replacement(self):
        self.turn.booking_saved = True
        self.turn.booking_receipt = {"booking_id": "booking-1"}
        self.assertTrue(handoff.note_saved_confirmation_payload("booking-1", "EXACT"))
        self.assertTrue(handoff.saved_confirmation_payload_status("EXACT"))
        self.assertFalse(handoff.saved_confirmation_payload_status("SAFE FALLBACK"))

    def test_confirmation_recovery_requires_exact_luna_pause_and_auto_mode(self):
        recovery = {
            "booking_id": "11111111-2222-4333-8444-555555555555",
            "pause_state": {
                "id": "pause-confirmation", "conversation_id": "conv-own",
                "paused_by": "luna_flag_needs_human",
                "pause_reason": "needs_human:saved_booking_confirmation_blocked:provider_send_failed",
                "source": "bot_pause_states", "scope": "conversation",
            },
        }
        exact = {
            "whatsapp_channel_mode": "auto", "global_paused": False,
            "conversation_paused": True, "agent_paused": True,
            "send_blocked": True, "stage_as_draft": False,
            "pause_source": "bot_pause_states",
            "pause_scope": "conversation",
            "pause_state": dict(recovery["pause_state"]),
        }
        cases = (
            (exact, True),
            ({**exact, "whatsapp_channel_mode": "off"}, False),
            ({**exact, "whatsapp_channel_mode": "draft"}, False),
            ({**exact, "global_paused": True, "pause_scope": "global"}, False),
            ({key: value for key, value in exact.items() if key != "global_paused"}, False),
            ({**exact, "global_paused": None}, False),
            ({**exact, "send_blocked": False}, False),
            ({**exact, "agent_paused": False}, False),
            ({**exact, "stage_as_draft": True}, False),
            ({**exact, "pause_state": {**exact["pause_state"], "paused_by": "staff-user"}}, False),
            ({**exact, "pause_state": {**exact["pause_state"], "id": "pause-other"}}, False),
            ({**exact, "pause_state": {**exact["pause_state"], "pause_reason": "human_requested"}}, False),
            ({**exact, "pause_state": {**exact["pause_state"],
                                        "pause_reason": "needs_human:saved_booking_confirmation_blocked:provider_acceptance_stamp_failed"}}, False),
            ({**exact, "pause_state": None}, False),
        )
        for gate, expected in cases:
            with self.subTest(gate=gate):
                self.assertIs(
                    pause_gate.confirmation_recovery_allowed(gate, recovery), expected)
        acceptance_failed = {**recovery, "pause_state": {
            **recovery["pause_state"],
            "pause_reason": "needs_human:saved_booking_confirmation_blocked:provider_acceptance_stamp_failed",
        }}
        self.assertFalse(pause_gate.confirmation_recovery_allowed(
            {**exact, "pause_state": dict(acceptance_failed["pause_state"])},
            acceptance_failed,
        ))

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
            for baseline, created, expected in (
                ({"send_blocked": False, "stage_as_draft": False,
                  "reason": "send", "whatsapp_channel_mode": "auto"}, True, True),
                ({"send_blocked": False, "stage_as_draft": False,
                  "reason": "send", "whatsapp_channel_mode": "auto"}, False, False),
                ({"send_blocked": False, "stage_as_draft": False,
                  "reason": "send", "whatsapp_channel_mode": None}, True, False),
                ({"send_blocked": True, "stage_as_draft": True,
                  "reason": "inbox_channel_mode_draft"}, True, False),
                ({"send_blocked": True, "stage_as_draft": False,
                  "reason": "gate_fail_closed"}, True, False),
            ):
                with self.subTest(baseline=baseline, created=created):
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
                                             "paused_by": "luna_flag_needs_human",
                                             "pause_reason": "needs_human:human_requested",
                                             "created": created,
                                             "existing_staff_owned": not created,
                                             "paused": True,
                                             "idempotent": not created,
                                             "source": "bot_pause_states",
                                         }},
                            )
                        self.assertIs(turn.handoff_pause_created, expected)
                    finally:
                        handoff._ORDINARY_TURN.reset(token)
        self.token = handoff._ORDINARY_TURN.set(self.turn)

    def test_real_block_keeps_confirmation_owed_and_flags_staff_with_reason(self):
        self.turn.booking_saved = True
        self.turn.booking_receipt = {
            "booking_id": "11111111-2222-4333-8444-555555555555",
            "booking_code": "WH-20270310-03802502",
        }
        fake = ModuleType("wolfhouse_staff_api")
        calls = []
        concrete_reason = (
            "saved_booking_confirmation_blocked:inbox_channel_mode_draft:"
            "booking_reference:WH-20270310-03802502"
        )
        fake.flag_needs_human = lambda payload: (
            calls.append(payload) or json.dumps({
                "success": True, "needs_human": True, "handoff_persisted": True,
                "staff_review_id": "review-blocked", "handoff_reason": concrete_reason,
            })
        )
        with mock.patch.dict(sys.modules, {"wolfhouse_staff_api": fake}):
            self.assertTrue(handoff.flag_blocked_saved_confirmation("inbox_channel_mode_draft"))
        self.assertTrue(self.turn.confirmation_owed)
        self.assertEqual(
            calls[0]["reason"],
            "saved_booking_confirmation_blocked:inbox_channel_mode_draft:"
            "booking_reference:WH-20270310-03802502",
        )
        self.assertEqual(calls[0]["booking_id"], "11111111-2222-4333-8444-555555555555")
        self.assertEqual(calls[0]["booking_code"], "WH-20270310-03802502")
        self.assertNotIn("confirmation_delivery_blocked", calls[0])

    def test_provider_acceptance_stamps_exact_booking_without_clearing_debt(self):
        self.turn.booking_saved = True
        self.turn.booking_receipt = {
            "booking_id": "11111111-2222-4333-8444-555555555555",
            "booking_code": "WH-ACCEPT",
        }
        self.assertTrue(handoff.note_saved_confirmation_payload(
            "11111111-2222-4333-8444-555555555555", "EXACT CONFIRMATION"))
        fake = ModuleType("wolfhouse_staff_api")
        calls = []
        def accepted(**payload):
            calls.append(payload)
            return {
                "success": True, "stamped": True, "idempotent": False,
                "cleared": False, **payload,
            }
        setattr(fake, "_confirmation_owed_accepted", accepted)
        with mock.patch.dict(sys.modules, {"wolfhouse_staff_api": fake}):
            self.assertTrue(handoff.acknowledge_saved_confirmation(
                "wamid.accepted", "EXACT CONFIRMATION"))
        self.assertEqual(calls, [{
            "booking_id": "11111111-2222-4333-8444-555555555555",
            "provider_message_id": "wamid.accepted",
        }])

    def test_provider_acceptance_mismatch_is_real_failure_with_exact_cause(self):
        self.turn.booking_saved = True
        self.turn.booking_receipt = {
            "booking_id": "11111111-2222-4333-8444-555555555555",
            "booking_code": "WH-ACCEPT",
        }
        self.assertTrue(handoff.note_saved_confirmation_payload(
            "11111111-2222-4333-8444-555555555555", "EXACT CONFIRMATION"))
        fake = ModuleType("wolfhouse_staff_api")
        setattr(fake, "_confirmation_owed_accepted", lambda **_payload: {
            "success": False, "stamped": False,
            "cause": "provider_message_id_mismatch",
            "stored_provider_message_id": "wamid.A",
        })
        with mock.patch.dict(sys.modules, {"wolfhouse_staff_api": fake}):
            self.assertFalse(handoff.acknowledge_saved_confirmation(
                "wamid.B", "EXACT CONFIRMATION"))
        self.assertEqual(
            self.turn.confirmation_acceptance_failure_cause,
            "provider_acceptance_stamp_failed:provider_message_id_mismatch",
        )
        self.assertEqual(self.turn.confirmation_provider_pending, {
            "booking_id": "11111111-2222-4333-8444-555555555555",
            "provider_message_id": "wamid.B",
        })
        self.assertEqual(
            handoff.confirmation_provider_fence(
                "11111111-2222-4333-8444-555555555555"),
            "wamid.B",
        )

    def test_provider_acceptance_rejects_mismatched_receipt(self):
        self.turn.booking_saved = True
        self.turn.booking_receipt = {"booking_id": "11111111-2222-4333-8444-555555555555"}
        self.assertTrue(handoff.note_saved_confirmation_payload(
            "11111111-2222-4333-8444-555555555555", "EXACT CONFIRMATION"))
        fake = ModuleType("wolfhouse_staff_api")
        setattr(fake, "_confirmation_owed_accepted", lambda **_payload: {
            "success": True, "stamped": True, "cleared": False,
            "booking_id": "99999999-2222-4333-8444-555555555555",
            "provider_message_id": "wamid.accepted",
        })
        with mock.patch.dict(sys.modules, {"wolfhouse_staff_api": fake}):
            self.assertFalse(handoff.acknowledge_saved_confirmation(
                "wamid.accepted", "EXACT CONFIRMATION"))

    def test_unrelated_successful_send_cannot_stamp_confirmation(self):
        self.turn.booking_saved = True
        self.turn.booking_receipt = {"booking_id": "11111111-2222-4333-8444-555555555555"}
        self.assertTrue(handoff.note_saved_confirmation_payload(
            "11111111-2222-4333-8444-555555555555", "EXACT CONFIRMATION"))
        fake = ModuleType("wolfhouse_staff_api")
        calls = []
        fake._confirmation_owed_accepted = lambda **payload: calls.append(payload)
        with mock.patch.dict(sys.modules, {"wolfhouse_staff_api": fake}):
            self.assertIsNone(handoff.acknowledge_saved_confirmation(
                "wamid.unrelated", "UNRELATED MESSAGE"))
        self.assertEqual(calls, [])

    def test_staff_flag_requires_success_and_needs_human(self):
        self.turn.booking_saved = True
        self.turn.booking_receipt = {"booking_id": "11111111-2222-4333-8444-555555555555"}
        fake = ModuleType("wolfhouse_staff_api")
        fake.flag_needs_human = lambda _payload: '{"success":false,"needs_human":true}'
        with mock.patch.dict(sys.modules, {"wolfhouse_staff_api": fake}):
            self.assertFalse(handoff.flag_blocked_saved_confirmation("provider_send_failed"))

    def test_provider_failure_reason_preserves_safe_concrete_cause(self):
        self.assertEqual(
            handoff.saved_confirmation_failure_reason(
                "provider_send_failed", {"error": {"code": 131047, "message": "unsafe"}}),
            "provider_send_failed:meta_code_131047",
        )
        self.assertEqual(
            handoff.saved_confirmation_failure_reason(
                "provider_send_exception", {"error_type": "TimeoutError"}),
            "provider_send_exception:TimeoutError",
        )
        self.assertEqual(
            handoff.saved_confirmation_failure_reason("provider_send_failed", {}),
            "provider_send_failed",
        )

    def test_gateway_routes_raw_provider_cause_to_confirmation_recovery(self):
        source_path = os.path.join(
            os.path.dirname(os.path.dirname(__file__)), "apply_gateway_patches.py")
        with open(source_path, encoding="utf-8") as fh:
            source = fh.read()
        send_source = source.split(
            "async def _patched_whatsapp_cloud_send", 1)[1].split(
            "def install_runtime_whatsapp_patches", 1)[0]
        self.assertIn("saved_confirmation_failure_reason(reason, raw_response)", send_source)
        self.assertIn("flag_blocked_saved_confirmation(_wh_failure_reason)", send_source)
        self.assertIn("acknowledge_saved_confirmation(_wh_mid, content)", send_source)
        self.assertIn("provider_acceptance_stamp_failed", send_source)

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
