import unittest
from wolfhouse import output_guard


class DateChangeOutputGuardTest(unittest.TestCase):
    def test_blocks_moved_claim_without_same_booking_receipt(self):
        text, findings = output_guard.guard_reply("Your booking WH-1 has been moved to June 1–5.", guest_lang="en", tool_calls=[])
        self.assertNotIn("has been moved", text)
        self.assertTrue(any(row["kind"] == "unsupported_date_change_claim" for row in findings))

    def test_allows_moved_claim_only_for_same_booking_receipt(self):
        calls = [{"name": "move_booking_dates", "result": {"success": True, "write_performed": True, "moved_same_booking": True, "booking": {"booking_code": "WH-1", "check_in": "2027-06-01", "check_out": "2027-06-05"}}}]
        text, findings = output_guard.guard_reply("Your booking WH-1 has been moved to June 1–5.", guest_lang="en", tool_calls=calls)
        self.assertEqual(text, "Your booking WH-1 has been moved to June 1–5.")
        self.assertFalse(any(row["kind"] == "unsupported_date_change_claim" for row in findings))


if __name__ == "__main__":
    unittest.main()
