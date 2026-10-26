import importlib.util
import json
import sys
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
HERMES_STAGING = ROOT / "docker/hermes-staging"
if str(HERMES_STAGING) not in sys.path:
    sys.path.insert(0, str(HERMES_STAGING))
PLUGIN_PATH = HERMES_STAGING / "plugins/wolfhouse_staff_api/__init__.py"
SOUL_PATH = HERMES_STAGING / "SOUL.md"

from wolfhouse import output_guard


def load_plugin():
    spec = importlib.util.spec_from_file_location("closed_season_contract_plugin", PLUGIN_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ClosedSeasonContractTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plugin = load_plugin()

    def test_availability_projects_staff_closed_season_and_nearest_open_dates(self):
        staff = {
            "success": True,
            "date_rule_ok": False,
            "blockers": ["closed_season"],
            "next_action": "closed_season",
            "nearest_open_dates": {"check_in": "2027-03-01", "check_out": "2027-03-04"},
            "guest_safe_next_action": "Estamos cerrados en esas fechas. La apertura más cercana es del 1 al 4 de marzo de 2027.",
            "selected_bed_codes": ["R9-B1"],
            "available_beds": [{"bed_code": "R9-B1", "room_code": "R9", "room_type": "mixed"}],
        }
        with patch.object(self.plugin, "_post_bot", return_value=staff):
            result = json.loads(self.plugin.check_availability({
                "client_slug": "wolfhouse-somo", "check_in": "2026-12-12",
                "check_out": "2026-12-15", "guest_count": 1,
            }))
        self.assertFalse(result["success"])
        self.assertEqual(result["availability_status"], "closed_season")
        self.assertFalse(result["available"])
        self.assertTrue(result["closed_season"])
        self.assertEqual(result["nearest_open_dates"], staff["nearest_open_dates"])
        self.assertEqual(result["selected_bed_codes"], [])
        self.assertEqual(result["available_beds"], [])
        self.assertFalse(result["staff_review_needed"])

    def test_guard_replaces_closed_season_freeform_with_staff_copy(self):
        tool_calls = [{"name": "check_availability", "result": json.dumps({
            "success": False, "closed_season": True, "availability_status": "closed_season",
            "nearest_open_dates": {"check_in": "2027-03-01", "check_out": "2027-03-04"},
            "guest_safe_next_action": "Estamos cerrados en esas fechas. La apertura más cercana es del 1 al 4 de marzo de 2027.",
        })}]
        text, findings = output_guard.guard_reply(
            "He actualizado la estancia del 19 al 26 de diciembre.",
            tool_calls=tool_calls, guest_lang="es",
        )
        self.assertEqual(text, "Estamos cerrados en esas fechas. La apertura más cercana es del 1 al 4 de marzo de 2027.")
        self.assertIn("closed_season_staff_copy", [f["kind"] for f in findings])

    def test_guard_blocks_availability_claim_without_successful_staff_receipt(self):
        text, findings = output_guard.guard_reply(
            "Sí, tenemos una cama disponible del 12 al 15 de diciembre.",
            tool_calls=[], guest_lang="es",
        )
        self.assertNotIn("tenemos una cama disponible", text.lower())
        self.assertIn("unsupported_availability_claim", [f["kind"] for f in findings])

    def test_soul_forbids_date_changes_and_requires_availability_before_claim(self):
        soul = SOUL_PATH.read_text(encoding="utf-8")
        self.assertIn("Never change the guest's dates unless the guest explicitly asks", soul)
        self.assertIn("before any positive availability claim", soul)


if __name__ == "__main__":
    import unittest
    unittest.main()
