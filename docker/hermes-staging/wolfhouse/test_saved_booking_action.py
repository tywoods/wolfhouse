"""EN/ES/IT saved-booking cancel vs date-change vs paid handoff.

Unpaid cancel and date-change must not persist a generic team handoff.
Paid cancel still goes to a human after Staff refuses the unpaid cancel write.
"""
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "plugins")]

from wolfhouse.saved_booking_action import (  # noqa: E402
    bind_guest_turn_text,
    clear_guest_turn_text,
    detect_saved_booking_action,
    note_cancel_unpaid_result,
    note_date_change_result,
    should_persist_handoff,
)


CANCEL_TEXTS = {
    "en": "Please cancel the booking.",
    "es": "cancela la reserva por favor",
    "it": "annulla la prenotazione per favore",
}

POLITE_CANCEL_TEXTS = {
    "en": "Sorry, plans changed - can you cancel my booking please?",
    "en_plans": "I've changed my plans, please cancel",
    "en_can_you": "Can you cancel please?",
    "es": "Han cambiado los planes, ¿puedes cancelar la reserva por favor?",
    "it": "Sono cambiati i piani, puoi annullare per favore?",
}

DATE_CHANGE_TEXTS = {
    "en": "Could you change the booking to 24-26 November?",
    "es": "¿Podría cambiar la reserva al 24-26 de noviembre?",
    "it": "Potresti spostare la prenotazione al 24-26 novembre?",
}


class DetectSavedBookingActionTests(unittest.TestCase):
    def test_cancel_request_is_detected_in_en_es_it(self):
        for lang, text in CANCEL_TEXTS.items():
            self.assertEqual(
                detect_saved_booking_action(text), "cancel", lang,
            )

    def test_polite_and_plans_changed_cancel_is_detected_in_en_es_it(self):
        for lang, text in POLITE_CANCEL_TEXTS.items():
            self.assertEqual(
                detect_saved_booking_action(text), "cancel", lang,
            )

    def test_plans_changed_without_cancel_is_not_a_saved_booking_action(self):
        self.assertIsNone(detect_saved_booking_action("Sorry, plans changed"))
        self.assertIsNone(detect_saved_booking_action("Han cambiado los planes"))
        self.assertIsNone(detect_saved_booking_action("Sono cambiati i piani"))

    def test_date_change_request_is_detected_in_en_es_it(self):
        for lang, text in DATE_CHANGE_TEXTS.items():
            self.assertEqual(
                detect_saved_booking_action(text), "date_change", lang,
            )

    def test_add_on_cancel_is_not_a_saved_booking_cancel(self):
        self.assertIsNone(detect_saved_booking_action("Cancel the shuttle"))
        self.assertIsNone(detect_saved_booking_action("Cancela el traslado"))
        self.assertIsNone(detect_saved_booking_action("Annulla la navetta"))

    def test_human_request_alone_is_not_a_saved_booking_action(self):
        self.assertIsNone(detect_saved_booking_action("I want to speak with a person"))
        self.assertIsNone(detect_saved_booking_action("Quiero hablar con una persona"))
        self.assertIsNone(detect_saved_booking_action("Voglio parlare con una persona"))


class HandoffVsActionTests(unittest.TestCase):
    def tearDown(self):
        clear_guest_turn_text()

    def test_unpaid_cancel_does_not_persist_handoff_before_staff_write(self):
        for lang, text in {**CANCEL_TEXTS, **POLITE_CANCEL_TEXTS}.items():
            bind_guest_turn_text(text)
            allowed, next_action = should_persist_handoff("cancel_or_change_request")
            self.assertFalse(allowed, lang)
            self.assertEqual(next_action, "cancel_unpaid_booking", lang)

    def test_live_inbound_text_gates_handoff_without_explicit_bind(self):
        clear_guest_turn_text()
        from wolfhouse import original_inbound as inbound
        cap = inbound.OriginalInbound(
            POLITE_CANCEL_TEXTS["en"],
            {"PLATFORM": "whatsapp_cloud", "CHAT_ID": "1", "USER_ID": "1", "THREAD_ID": ""},
            "g18",
        )
        token = inbound._current.set(cap)
        try:
            allowed, next_action = should_persist_handoff("human_requested")
        finally:
            inbound._current.reset(token)
        self.assertFalse(allowed)
        self.assertEqual(next_action, "cancel_unpaid_booking")

    def test_date_change_does_not_persist_handoff_before_quote(self):
        for lang, text in DATE_CHANGE_TEXTS.items():
            bind_guest_turn_text(text)
            allowed, next_action = should_persist_handoff("date_change_different_nights")
            self.assertFalse(allowed, lang)
            self.assertEqual(next_action, "quote_booking_date_change", lang)

    def test_paid_cancel_still_goes_to_a_human_after_staff_refusal(self):
        bind_guest_turn_text(CANCEL_TEXTS["es"])
        note_cancel_unpaid_result({
            "success": False,
            "cancelled": False,
            "write_performed": False,
            "staff_review_needed": True,
            "handoff_reason": "paid_cancellation_or_reschedule",
            "blocked_reason": "payment_exists",
        })
        allowed, next_action = should_persist_handoff("paid_cancellation_or_reschedule")
        self.assertTrue(allowed)
        self.assertIsNone(next_action)

    def test_generic_human_request_is_unchanged_without_booking_action(self):
        bind_guest_turn_text("I want to speak with a person")
        allowed, next_action = should_persist_handoff("human_requested")
        self.assertTrue(allowed)
        self.assertIsNone(next_action)


class FlagNeedsHumanPathTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "LUNA_CLIENT_SLUG": "wolfhouse-somo",
            "LUNA_BOT_INTERNAL_TOKEN": "offline-fixture-not-a-credential",
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff.invalid",
            "WOLFHOUSE_WHATSAPP_GUEST_PHONE": "+" + "34" + "900000001",
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(clear_guest_turn_text)

    def test_spanish_cancel_refuses_generic_handoff_until_unpaid_cancel_runs(self):
        import wolfhouse_staff_api as plugin

        bind_guest_turn_text(CANCEL_TEXTS["es"])
        with patch.object(plugin, "_post_bot") as post:
            result = json.loads(plugin.flag_needs_human({"reason": "cancel_or_change_request"}))
        post.assert_not_called()
        self.assertFalse(result.get("success"))
        self.assertFalse(result.get("needs_human"))
        self.assertFalse(result.get("handoff_persisted"))
        self.assertEqual(result.get("next_action"), "cancel_unpaid_booking")
        self.assertTrue(result.get("do_not_escalate"))

    def test_spanish_date_change_refuses_generic_handoff_until_quote_runs(self):
        import wolfhouse_staff_api as plugin

        bind_guest_turn_text(DATE_CHANGE_TEXTS["es"])
        with patch.object(plugin, "_post_bot") as post:
            result = json.loads(plugin.flag_needs_human({"reason": "human_requested"}))
        post.assert_not_called()
        self.assertFalse(result.get("success"))
        self.assertEqual(result.get("next_action"), "quote_booking_date_change")

    def test_english_polite_cancel_refuses_generic_handoff(self):
        import wolfhouse_staff_api as plugin

        bind_guest_turn_text(POLITE_CANCEL_TEXTS["en"])
        with patch.object(plugin, "_post_bot") as post:
            result = json.loads(plugin.flag_needs_human({"reason": "human_requested"}))
        post.assert_not_called()
        self.assertFalse(result.get("success"))
        self.assertEqual(result.get("next_action"), "cancel_unpaid_booking")

    def test_italian_cancel_refuses_generic_handoff(self):
        import wolfhouse_staff_api as plugin

        bind_guest_turn_text(CANCEL_TEXTS["it"])
        with patch.object(plugin, "_post_bot") as post:
            result = json.loads(plugin.flag_needs_human({"reason": "cancel_or_change_request"}))
        post.assert_not_called()
        self.assertEqual(result.get("next_action"), "cancel_unpaid_booking")

    def test_paid_spanish_cancel_persists_handoff_after_staff_refusal(self):
        import wolfhouse_staff_api as plugin

        bind_guest_turn_text(CANCEL_TEXTS["es"])
        note_cancel_unpaid_result({
            "success": False,
            "cancelled": False,
            "write_performed": False,
            "staff_review_needed": True,
            "handoff_reason": "paid_cancellation_or_reschedule",
        })
        with patch.object(plugin, "persist_ordinary_handoff", create=True) as persist, \
             patch.object(plugin, "_post_bot", return_value={
                 "success": True, "needs_human": True,
                 "staff_handoff": {"id": "sr-1"},
             }):
            persist.side_effect = lambda payload, transport: transport()
            result = json.loads(plugin.flag_needs_human({
                "reason": "paid_cancellation_or_reschedule",
            }))
        self.assertTrue(result.get("success"))
        self.assertTrue(result.get("needs_human"))


if __name__ == "__main__":
    unittest.main()
