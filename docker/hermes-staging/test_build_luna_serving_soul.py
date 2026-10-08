#!/usr/bin/env python3
from pathlib import Path
import importlib.util
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("builder", ROOT / "build_luna_serving_soul.py")
assert spec is not None and spec.loader is not None
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class ServingSoulTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = (ROOT / "SOUL.approved-base.md").read_text(encoding="utf-8")
        cls.full = builder.build_full(cls.base)
        cls.serving = builder.build_serving(cls.full)

    def test_full_is_approved_base_plus_only_recovery(self):
        self.assertEqual(builder.sha256_text(self.base), builder.APPROVED_BASE_SHA256)
        self.assertEqual(self.full.replace("\n" + builder.RECOVERY, "", 1), self.base)
        self.assertEqual(self.full.count(builder.RECOVERY), 1)

    def test_serving_is_exact_full_text_under_configured_limit(self):
        self.assertEqual(self.serving, self.full)
        self.assertLessEqual(len(self.serving), builder.MAX_CHARS)
        self.assertEqual(self.serving, builder.build_serving(self.full))

    def test_no_approved_rule_is_dropped_from_serving_text(self):
        self.assertNotIn("serving projection", self.serving)
        self.assertEqual(self.serving.splitlines(), self.full.splitlines())

    def test_solo_turn_three_never_repeats_consent_or_promises_booking(self):
        rule = builder.RECOVERY
        self.assertIn("Solo turn 3", rule)
        self.assertIn("do not ask the guest to say “yes, book this”", rule)
        self.assertIn("do not tell them the booking or link will be created/sent immediately", rule)
        self.assertIn("promise an unproved retry", rule)

    def test_couple_turn_three_does_not_reconfirm(self):
        rule = builder.RECOVERY
        self.assertIn("Couple turn 3", rule)
        self.assertIn("retain that acceptance", rule)
        self.assertIn("Do not ask them to confirm, accept, or consent again", rule)


if __name__ == "__main__":
    unittest.main()
