"""Offline contract: Staff invoice details survive inside the frozen offer revision."""
import copy
import json
import os
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "docker/hermes-staging"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wolfhouse_staff_api as plugin


class QuoteInvoiceAuthorityTests(unittest.TestCase):
    def test_quote_carries_staff_line_items_into_offer_revision(self):
        revision = {
            "check_in": "2026-11-05", "check_out": "2026-11-15", "guest_count": 2,
            "room_type": "shared", "room_preference": "mixed", "package_code": "waimea",
            "payment_choice": "deposit", "availability_checked": True,
            "selected_bed_codes": ["R3-B1", "R3-B2"],
            "room_arrangement": [{"bed_code": "R3-B1", "room_code": "R3"},
                                 {"bed_code": "R3-B2", "room_code": "R3"}],
        }
        per_person = [
            {"guest_number": 1, "package_code": "waimea", "accommodation_cents": 80000,
             "subtotal_cents": 80000},
            {"guest_number": 2, "package_code": "waimea", "accommodation_cents": 80000,
             "subtotal_cents": 80000},
        ]
        included = [{"code": "package_proration", "nights": 10, "guest_count": 2,
                     "unit_cents": 8000, "total_cents": 160000}]

        def api(path, payload, **kwargs):
            if path == "/availability-check":
                return {"success": True, "has_enough_beds": True,
                        "selected_bed_codes": ["R3-B1", "R3-B2"],
                        "available_beds": revision["room_arrangement"]}
            if path == "/booking-preview":
                return {"success": True, "offer_revision": copy.deepcopy(revision),
                        "quote_total_cents": 160000, "deposit_required_cents": 40000,
                        "currency": "EUR", "per_person": copy.deepcopy(per_person),
                        "included_items": copy.deepcopy(included)}
            raise AssertionError(path)

        params = {key: value for key, value in revision.items()
                  if key not in ("availability_checked", "room_arrangement")}
        with patch.dict(os.environ, {"LUNA_CLIENT_SLUG": "wolfhouse-somo"}), \
                patch.object(plugin, "_post_bot", side_effect=api):
            result = json.loads(plugin.quote_booking(params))
        self.assertEqual(result["offer_revision"]["per_person"], per_person)
        self.assertEqual(result["offer_revision"]["included_items"], included)

    def test_quote_preserves_revision_invoice_details_when_not_duplicated_at_top_level(self):
        revision = {
            "check_in": "2026-11-05", "check_out": "2026-11-15", "guest_count": 1,
            "room_type": "shared", "room_preference": "mixed", "package_code": "waimea",
            "payment_choice": "deposit", "availability_checked": True,
            "selected_bed_codes": ["R3-B1"],
            "room_arrangement": [{"bed_code": "R3-B1", "room_code": "R3"}],
            "per_person": [{"guest_number": 1, "accommodation_cents": 80000}],
            "included_items": [{"code": "accommodation_only", "total_cents": 80000}],
        }

        def api(path, payload, **kwargs):
            if path == "/availability-check":
                return {"success": True, "has_enough_beds": True,
                        "selected_bed_codes": ["R3-B1"],
                        "available_beds": revision["room_arrangement"]}
            if path == "/booking-preview":
                return {"success": True, "quote_total_cents": 80000,
                        "deposit_required_cents": 20000, "balance_due_cents": 60000,
                        "offer_revision": copy.deepcopy(revision)}
            raise AssertionError(path)

        params = {key: value for key, value in revision.items()
                  if key not in ("availability_checked", "room_arrangement",
                                 "per_person", "included_items")}
        with patch.dict(os.environ, {"LUNA_CLIENT_SLUG": "wolfhouse-somo"}), \
                patch.object(plugin, "_post_bot", side_effect=api):
            result = json.loads(plugin.quote_booking(params))
        self.assertEqual(result["offer_revision"]["per_person"], revision["per_person"])
        self.assertEqual(result["offer_revision"]["included_items"], revision["included_items"])


if __name__ == "__main__":
    unittest.main()
