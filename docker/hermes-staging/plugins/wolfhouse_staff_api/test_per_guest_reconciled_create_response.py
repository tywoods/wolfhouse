import unittest

from wolfhouse_staff_api import _extract_booking_write_fields, _should_create_split_links


class ReconciledCreateResponsePerGuestTests(unittest.TestCase):
    def test_nested_reconciled_create_response_retains_per_guest_link_intent(self):
        guests = [
            {"booking_guest_id": "guest-1", "guest_number": 1, "guest_name": "One"},
            {"booking_guest_id": "guest-2", "guest_number": 2, "guest_name": "Two"},
            {"booking_guest_id": "guest-3", "guest_number": 3, "guest_name": "Three"},
        ]
        response = {
            "success": True,
            "write_performed": True,
            "create_outcome": {
                "create_response": {
                    "booking_id": "booking-1",
                    "booking_code": "WH-RESTORE",
                    "uses_per_guest_model": True,
                    "booking_guests": guests,
                }
            },
        }

        fields = _extract_booking_write_fields(response)

        self.assertEqual(fields["booking_guests"], guests)
        self.assertTrue(fields["uses_per_guest_model"])
        self.assertTrue(_should_create_split_links(response, fields, split_payment_requested=True))


if __name__ == "__main__":
    unittest.main()
