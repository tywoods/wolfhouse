import importlib.util
import json
import os
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parent


def load_plugin():
    plugins = str(ROOT.parent)
    staging = str(ROOT.parents[1])
    for path in (plugins, staging):
        if path not in sys.path:
            sys.path.insert(0, path)
    import wolfhouse_staff_api
    return wolfhouse_staff_api


class DateChangeToolTest(unittest.TestCase):
    def setUp(self):
        self.mod = load_plugin()

    def test_quote_binds_trusted_phone_and_new_dates(self):
        with patch.object(self.mod, "_live_turn_guest_phone", return_value="+34111"), patch.object(self.mod, "_post_bot", return_value={"success": True, "can_move": True, "quote_token": "signed", "quote": {"total_cents": 42000}}) as post:
            result = json.loads(self.mod.quote_booking_date_change({"booking_code": "WH-1", "new_check_in": "2027-06-01", "new_check_out": "2027-06-05", "phone": "+34999"}))
        self.assertTrue(result["success"])
        post.assert_called_once_with("/bookings/date-change-quote", {"booking_code": "WH-1", "new_check_in": "2027-06-01", "new_check_out": "2027-06-05", "guest_phone": "+34111"})

    def test_move_requires_quote_token_and_preserves_same_booking_receipt(self):
        missing = json.loads(self.mod.move_booking_dates({"booking_code": "WH-1", "new_check_in": "2027-06-01", "new_check_out": "2027-06-05"}))
        self.assertEqual(missing["reason_code"], "date_change_quote_required")
        receipt = {"success": True, "write_performed": True, "moved_same_booking": True, "booking": {"booking_id": "b1", "booking_code": "WH-1", "check_in": "2027-06-01", "check_out": "2027-06-05"}}
        with patch.object(self.mod, "_live_turn_guest_phone", return_value="+34111"), patch.object(self.mod, "_post_bot", return_value=receipt):
            moved = json.loads(self.mod.move_booking_dates({"booking_code": "WH-1", "new_check_in": "2027-06-01", "new_check_out": "2027-06-05", "quote_token": "signed"}))
        self.assertTrue(moved["success"])
        self.assertEqual(moved["booking"]["booking_id"], "b1")

    def test_tools_are_registered_for_wolfhouse(self):
        class Ctx:
            def __init__(self): self.names = []
            def register_tool(self, **kwargs): self.names.append(kwargs["name"])
        ctx = Ctx()
        with patch.dict(os.environ, {"LUNA_CLIENT_SLUG": "wolfhouse-somo"}, clear=False):
            self.mod.register(ctx)
        self.assertIn("quote_booking_date_change", ctx.names)
        self.assertIn("move_booking_dates", ctx.names)


if __name__ == "__main__":
    unittest.main()
