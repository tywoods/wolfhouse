"""Regressions for SKIP-RERUN1101-LUNA-20261101T0905 (offline only)."""
import copy
import json
import unittest
from unittest.mock import patch

import wolfhouse_staff_api as plugin
from wolfhouse import accepted_quote as owner


class LunaRootFixes1101(unittest.TestCase):
    def test_ineligible_requested_room_stops_date_widening_and_exposes_inventory_alternatives(self):
        params = {"check_in": "2027-06-01", "check_out": "2027-06-04", "guest_count": 2,
                  "room_type": "private", "room_preference": "private", "keep_together": True,
                  "guests": [{"name": "A"}, {"name": "B"}]}
        receipt = {"success": True, "has_enough_beds": False,
                   "allocation_reason": "private_room_requires_exactly_two_guests",
                   "ineligible_reason": "private_room_requires_exactly_two_guests",
                   "room_options": {"mixed_available": True, "private_available": False},
                   "nearest_open_candidate": {"check_in": "2027-06-08", "check_out": "2027-06-11"},
                   "selected_bed_codes": [], "available_beds": []}
        with patch.object(plugin, "_post_bot", return_value=receipt):
            result = json.loads(plugin.check_availability(params))
        self.assertEqual(result["ineligible_reason"], receipt["ineligible_reason"])
        self.assertFalse(result["date_widening_allowed"])
        self.assertFalse(result["alternative_dates_are_unverified_candidates"])
        self.assertEqual(result["honest_room_alternatives"], {"mixed_available": True, "private_available": False})

    def test_private_two_person_selection_remains_protected(self):
        params = {"check_in": "2027-06-01", "check_out": "2027-06-04", "guest_count": 2,
                  "room_type": "private", "room_preference": "private", "keep_together": True,
                  "guests": [{"name": "A"}, {"name": "B"}]}
        receipt = {"success": True, "has_enough_beds": True, "selected_room_code": "P1",
                   "selected_bed_codes": ["P1-B1", "P1-B2"], "available_beds": [
                       {"bed_code": "P1-B1", "room_code": "P1", "room_type": "female_only", "selected_selling_mode": "private"},
                       {"bed_code": "P1-B2", "room_code": "P1", "room_type": "female_only", "selected_selling_mode": "private"}]}
        with patch.object(plugin, "_post_bot", return_value=receipt):
            result = json.loads(plugin.check_availability(params))
        self.assertTrue(result["available"])
        self.assertEqual(result["selected_bed_codes"], ["P1-B1", "P1-B2"])
        self.assertEqual(result["selected_room_description"], "private")

    def test_transfer_outcomes_retain_request_status_and_staff_reason(self):
        pending = {"direction": "arrival", "airport": "BIO", "flight_number": "VY123",
                   "scheduled_at": "2027-06-01T12:00:00Z", "guest_count": 2}
        staff = {"success": False, "write_performed": False, "status": "blocked",
                 "reason_code": "transfer_window_closed", "error": "No driver window"}
        with patch.object(plugin, "_post_bot", return_value=staff):
            result = plugin._auto_save_pending_transfers(
                {"client_slug": "wolfhouse-somo", "pending_transfers": [pending]}, "id", "WH-1")
        self.assertEqual(result[0]["requested_transfer"], pending)
        self.assertEqual(result[0]["status"], "blocked")
        self.assertEqual(result[0]["reason_code"], "transfer_window_closed")
        self.assertEqual(result[0]["error"], "No driver window")

    def test_names_keep_explicit_display_spelling_and_never_borrow_surname(self):
        payload = {"guest_count": 3, "guest_name": "LUKAS",
                   "guests": ["LUKAS", "Nina Becker", "jan becker"]}
        plugin._normalize_guests_payload(payload)
        self.assertEqual(payload["guest_name"], "LUKAS")
        self.assertEqual(payload["guests"], [
            {"name": "LUKAS"}, {"name": "Nina Becker"}, {"name": "jan becker"}])

    def test_model_authoring_context_separates_tier_distribution_and_public_room(self):
        plan = {"language": "de", "register": "Sie", "payment_choice": "full",
                "payment_link_distribution": "separate", "guest_count": 2,
                "guests": [{"name": "Léa"}, {"name": "Mia"}]}
        offer = {**plan, "currency": "EUR", "total_cents": 16000,
                 "payment_link_amount_cents": 16000,
                 "public_room_label": "Privatzimmer für zwei Personen",
                 "payment_distribution": [{"guest_name": "Léa", "amount_due_cents": 7000},
                                          {"guest_name": "Mia", "amount_due_cents": 9000}]}
        facts = owner._quote_authoring_facts(plan, offer)
        self.assertEqual(facts["room_label"], "Privatzimmer für zwei Personen")
        self.assertEqual(facts["language"], "de")
        self.assertEqual(facts["register"], "Sie")
        self.assertEqual(facts["payment_tier"], "full")
        self.assertEqual(facts["payment_distribution"], "separate")
        self.assertEqual(facts["per_person_due_now"], [
            {"guest_name": "Léa", "amount_due_cents": 7000},
            {"guest_name": "Mia", "amount_due_cents": 9000}])
        self.assertNotIn("room_code", json.dumps(facts))


if __name__ == "__main__":
    unittest.main(verbosity=2)
