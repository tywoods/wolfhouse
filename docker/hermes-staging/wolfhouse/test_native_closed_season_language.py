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

from wolfhouse import output_guard


def load_plugin():
    spec = importlib.util.spec_from_file_location("native_closed_season_plugin", PLUGIN_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class NativeClosedSeasonLanguageTests(TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plugin = load_plugin()

    def test_availability_sends_guest_language_to_staff(self):
        calls = []
        staff = {
            "success": True,
            "date_rule_ok": False,
            "blockers": ["closed_season"],
            "next_action": "closed_season",
            "closed_season": True,
            "nearest_open_dates": {"check_in": "2027-03-01", "check_out": "2027-03-04"},
            "guest_safe_next_action": "Im Dezember haben wir geschlossen.",
        }

        def post(path, payload):
            calls.append((path, dict(payload)))
            return staff

        with patch.object(self.plugin, "_post_bot", side_effect=post):
            result = json.loads(self.plugin.check_availability({
                "client_slug": "wolfhouse-somo",
                "check_in": "2026-12-12",
                "check_out": "2026-12-15",
                "guest_count": 1,
                "language": "de-DE",
            }))

        self.assertEqual(calls[0][0], "/availability-check")
        self.assertEqual(calls[0][1]["language"], "de")
        self.assertEqual(result["guest_safe_copy_language"], "de")

    def test_quote_sends_guest_language_to_availability_and_preview(self):
        calls = []

        def post(path, payload):
            calls.append((path, dict(payload)))
            if path == "/availability-check":
                return {
                    "success": True,
                    "has_enough_beds": True,
                    "selected_bed_codes": ["M1"],
                }
            if path == "/booking-preview":
                return {
                    "success": True,
                    "quote_status": "ready",
                    "offer_revision": "de-language-r1",
                    "quote": {"success": True, "total_cents": 10000},
                    "included_items": [],
                }
            self.fail(f"unexpected Staff path {path}")

        with patch.object(self.plugin, "_post_bot", side_effect=post):
            json.loads(self.plugin.quote_booking({
                "client_slug": "wolfhouse-somo",
                "check_in": "2026-12-12",
                "check_out": "2026-12-15",
                "guest_count": 1,
                "package_code": "package_none",
                "language": "de-DE",
            }))

        self.assertEqual([payload["language"] for _, payload in calls], ["de", "de"])

    def test_quote_projects_language_for_closed_season_staff_copy(self):
        staff = {
            "success": False,
            "next_action": "closed_season",
            "closed_season": True,
            "availability_status": "closed_season",
            "nearest_open_dates": {"check_in": "2027-03-01", "check_out": "2027-03-04"},
            "guest_safe_next_action": "Nous sommes fermés en décembre.",
        }
        with patch.object(self.plugin, "_post_bot", return_value=staff):
            result = json.loads(self.plugin.quote_booking({
                "client_slug": "wolfhouse-somo",
                "check_in": "2026-12-12",
                "check_out": "2026-12-15",
                "guest_count": 1,
                "package_code": "package_none",
                "selected_bed_codes": ["M1"],
                "language": "fr-FR",
            }))
        self.assertEqual(result["guest_safe_copy_language"], "fr")
        self.assertEqual(result["nearest_open_dates"], staff["nearest_open_dates"])

    def test_closed_december_staff_copy_matches_each_guest_language(self):
        copies = {
            "de": "Im Dezember haben wir geschlossen. Der nächste offene Zeitraum ist 1.–4. März 2027.",
            "fr": "Nous sommes fermés en décembre. Les prochaines dates ouvertes sont du 1er au 4 mars 2027.",
            "it": "Siamo chiusi a dicembre. Le prossime date disponibili sono dall’1 al 4 marzo 2027.",
            "es": "Estamos cerrados en diciembre. Las próximas fechas abiertas son del 1 al 4 de marzo de 2027.",
            "en": "We are closed in December. The nearest open dates are 1–4 March 2027.",
        }
        for language, staff_copy in copies.items():
            with self.subTest(language=language):
                text, finding = output_guard.apply_availability_truth(
                    "Luna's own localized closed-season reply.",
                    [{"name": "check_availability", "result": {
                        "closed_season": True,
                        "availability_status": "closed_season",
                        "nearest_open_dates": {"check_in": "2027-03-01", "check_out": "2027-03-04"},
                        "guest_safe_next_action": staff_copy,
                        "guest_safe_copy_language": language,
                    }}],
                    language,
                )
                self.assertEqual(text, staff_copy)
                self.assertEqual(finding["kind"], "closed_season_staff_copy")

    def test_guard_keeps_luna_reply_when_staff_copy_language_differs(self):
        luna_reply = "Im Dezember haben wir geschlossen. Möchtest du die nächsten offenen Daten prüfen?"
        for result in ({
            "closed_season": True,
            "availability_status": "closed_season",
            "nearest_open_dates": {"check_in": "2027-03-01", "check_out": "2027-03-04"},
            "guest_safe_next_action": "We are closed in December. The nearest open dates are 1–4 March 2027.",
            "guest_safe_copy_language": "en",
        }, {
            "closed_season": True,
            "availability_status": "closed_season",
            "nearest_open_dates": {"check_in": "2027-03-01", "check_out": "2027-03-04"},
            "guest_safe_next_action": "We are closed in December. The nearest open dates are 1–4 March 2027.",
        }):
            with self.subTest(result=result):
                text, finding = output_guard.apply_availability_truth(
                    luna_reply,
                    [{"name": "check_availability", "result": result}],
                    "de",
                )
                self.assertEqual(text, luna_reply)
                self.assertEqual(finding["kind"], "closed_season_staff_copy_language_mismatch")


if __name__ == "__main__":
    import unittest
    unittest.main()
