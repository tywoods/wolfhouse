#!/usr/bin/env python3
"""Static prompt contracts, not an LLM-response or live-booking proof."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1] / "docker/hermes-staging"


def section(text, start, end):
    return text.split(start, 1)[1].split(end, 1)[0]


class FullStayGuidance(unittest.TestCase):
    def test_shuttle_uses_filtered_includes_in_both_runtime_sources(self):
        guide = (ROOT / "soul-guides/08-shuttle.md").read_text()
        canonical = (ROOT / "SOUL.md").read_text()
        for text in (guide, canonical):
            with self.subTest(source="guide" if text == guide else "canonical"):
                block = section(text, "**Step 4 — Shuttle", "**Step 5 — Payment")
                self.assertIn("current Staff stay-filtered Includes", block)
                self.assertIn("do not mention or proactively offer", block)
                self.assertIn("not a booking-save condition", block)
                self.assertNotIn("Do NOT skip this step for package bookings", block)
                self.assertIn("flight number", block)
                self.assertIn("write_performed:true", block)
        self.assertEqual(section(guide, "**Step 4 — Shuttle", "**Step 5 — Payment"),
                         section(canonical, "**Step 4 — Shuttle", "**Step 5 — Payment"))

    def test_every_full_stay_item_uses_current_default_not_description(self):
        for path in (ROOT / "soul-guides/10-packages-extras.md", ROOT / "SOUL.md"):
            with self.subTest(source=str(path)):
                block = section(path.read_text(), "## Package facts", "When you explain the packages")
                self.assertIn("current `default_nights`", block)
                self.assertIn("every full-stay-only item", block)
                self.assertIn("Description", block)
                self.assertIn("cannot restore an excluded item", block)
                self.assertIn("never hard-code", block)

    def test_quote_and_hard_rules_do_not_require_excluded_shuttle(self):
        for path in (ROOT / "soul-guides/05-quote.md", ROOT / "SOUL.md"):
            self.assertIn("only when current Staff stay-filtered Includes qualify it", path.read_text())
        for path in (ROOT / "soul-guides/14-hard-rules.md", ROOT / "SOUL.md"):
            self.assertIn("shuttle answer only when current Staff stay-filtered Includes qualify it", path.read_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
