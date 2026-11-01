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
        self.assertEqual(len(guests), 3)

    def test_nested_receipt_retains_saved_per_person_and_room_projections(self):
        per_person = [
            {"booking_guest_id": "guest-2", "guest_number": 2,
             "package_code": "package_none", "package_label": "Accommodation only"},
            {"booking_guest_id": "guest-1", "guest_number": 1,
             "package_code": "malibu", "package_label": "Malibu"},
        ]
        guest_rooms = [
            {"booking_guest_id": "guest-1", "guest_number": 1,
             "room_id": "room-arbitrary", "room_name": "The Lighthouse"},
            {"booking_guest_id": "guest-2", "guest_number": 2,
             "room_id": "room-other", "room_name": "Garden Loft"},
        ]
        room_arrangement = [
            {"bed_code": "R1-B1", "room_code": "R1",
             "guest_safe_room_label": "The Lighthouse"},
        ]
        fields = _extract_booking_write_fields({
            "success": True,
            "create_outcome": {"create_response": {
                "booking_id": "booking-1", "booking_code": "WH-SAVED",
                "per_person": per_person, "guest_rooms": guest_rooms,
                "room_arrangement": room_arrangement,
            }},
        })

        self.assertEqual(fields["per_person"], per_person)
        self.assertEqual(fields["guest_rooms"], guest_rooms)
        self.assertEqual(fields["room_arrangement"], room_arrangement)

    def test_roster_without_staff_per_guest_receipt_does_not_create_split_links(self):
        response = {
            "success": True,
            "write_performed": True,
            "booking_guests": [
                {"booking_guest_id": "guest-1", "guest_number": 1},
                {"booking_guest_id": "guest-2", "guest_number": 2},
            ],
        }
        fields = _extract_booking_write_fields(response)

        self.assertIsNone(fields["uses_per_guest_model"])
        self.assertFalse(_should_create_split_links(response, fields, split_payment_requested=True))

    def test_single_guest_without_staff_per_guest_receipt_is_unchanged(self):
        response = {
            "success": True,
            "write_performed": True,
            "booking_guests": [{"booking_guest_id": "guest-1", "guest_number": 1}],
        }
        fields = _extract_booking_write_fields(response)

        self.assertFalse(_should_create_split_links(response, fields, split_payment_requested=True))


if __name__ == "__main__":
    unittest.main()
