import importlib.util
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "runtime" / "trusted_turn_context.py"


class BookingStateConstraintTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("trusted_turn_context_under_test", MODULE)
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_quote_is_not_promoted_to_hold(self):
        history = [
            {"role": "assistant", "tool_calls": [{"id": "q1", "function": {"name": "check_quote_book", "arguments": '{"action":"prepare","purpose":"quote"}'}}]},
            {"role": "tool", "tool_call_id": "q1", "content": '{"ok":true,"state":"quote","held":false,"booked":false}'},
        ]
        rendered = self.module.render_booking_state_constraints(history)
        self.assertIn("authoritative_state=quoted", rendered)
        self.assertIn("held=false", rendered)
        self.assertIn("booked=false", rendered)
        self.assertIn("must not describe it as held or booked", rendered)

    def test_offer_and_booking_remain_distinct(self):
        offer = [
            {"role": "assistant", "tool_calls": [{"id": "o1", "function": {"name": "check_quote_book", "arguments": '{"action":"prepare","purpose":"offer"}'}}]},
            {"role": "tool", "tool_call_id": "o1", "content": '{"ok":true,"state":"offer","held":true,"booked":false,"offer_reference":"offer_123456789012345678901234"}'},
        ]
        booked = offer + [
            {"role": "assistant", "tool_calls": [{"id": "b1", "function": {"name": "check_quote_book", "arguments": '{"action":"confirm","offer_reference":"offer_123456789012345678901234"}'}}]},
            {"role": "tool", "tool_call_id": "b1", "content": '{"ok":true,"state":"booked","status":"confirmed"}'},
        ]
        self.assertIn("authoritative_state=held", self.module.render_booking_state_constraints(offer))
        self.assertIn("authoritative_state=booked", self.module.render_booking_state_constraints(booked))

    def test_unresolved_staff_write_overrides_shown_chat_until_confirmed(self):
        history = [{"role": "assistant", "content": "Nothing happened."}]
        text = self.module.render_booking_state_constraints(history, {
            "status": "unresolved", "operation": "offer_prepare", "staff_state": "offer",
        })
        self.assertIn("authoritative_state=unknown", text)
        self.assertIn("unresolved Staff operation", text)
        self.assertNotIn("authoritative_state=held", text)

    def test_missing_or_failed_staff_readback_is_unknown(self):
        rendered = self.module.render_booking_state_constraints([
            {"role": "assistant", "content": "It is held."},
            {"role": "tool", "tool_call_id": "orphan", "content": "not-json"},
        ])
        self.assertIn("authoritative_state=unknown", rendered)
        self.assertIn("cannot verify", rendered)
        self.assertNotIn("authoritative_state=held", rendered)

    def test_quote_then_unreadable_offer_prepare_makes_current_state_uncertain(self):
        ledger = {
            "state:quote": {"kind": "state", "status": "resolved", "staff_state": "quote",
                            "target": "booking-scope:session-a", "sequence": 1},
            "operation:prepare": {"kind": "command", "status": "unresolved", "mutation": True,
                                  "action": "prepare", "target": "booking-scope:session-a", "sequence": 2},
        }
        rendered = self.module.render_booking_state_constraints([], ledger)
        self.assertIn("last_verified_state=quoted", rendered)
        self.assertIn("current_state=unknown", rendered)
        self.assertIn("held=unknown", rendered)
        self.assertNotIn("held=false", rendered)

    def test_held_then_unreadable_confirm_makes_booking_state_uncertain(self):
        target = "offer:offer_123456789012345678901234"
        ledger = {
            "state:offer": {"kind": "state", "status": "resolved", "staff_state": "offer",
                            "target": target, "sequence": 1},
            "operation:confirm": {"kind": "command", "status": "unresolved", "mutation": True,
                                  "action": "confirm", "target": target, "sequence": 2},
        }
        rendered = self.module.render_booking_state_constraints([], ledger)
        self.assertIn("last_verified_state=held", rendered)
        self.assertIn("booked=unknown", rendered)
        self.assertNotIn("booked=false", rendered)


if __name__ == "__main__":
    unittest.main()
