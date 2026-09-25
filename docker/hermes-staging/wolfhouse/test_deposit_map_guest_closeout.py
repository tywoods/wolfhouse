"""Offline contract for the Wolfhouse group-payment guest close-out.

This verifies shipped Luna instructions and the tool response field only; it does
not invoke a model or any remote service.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "plugins"))
import wolfhouse_staff_api as plugin


class DepositMapGuestCloseoutTests(unittest.TestCase):
    def test_group_deposit_copy_has_due_window_and_lock_boundary(self):
        soul = (ROOT / "SOUL.md").read_text(encoding="utf-8")
        payment = soul.split("**Step 5 — Payment: full or a link each**")[1].split("**Step 6 — Names**")[0]
        self.assertIn("within a few days", payment)
        self.assertIn("ONE deposit locks the whole group booking", payment)
        self.assertIn("not the lock amount", payment)
        self.assertIn("personal/full-share", payment)

    def test_group_closeout_sends_one_map_after_all_share_links_not_per_guest(self):
        soul = (ROOT / "SOUL.md").read_text(encoding="utf-8")
        payment = soul.split("**Step 9 — Send payment link(s)**")[1].split("## Room preference")[0]
        self.assertIn("once only", payment)
        self.assertIn("after all payment links", payment.lower())
        self.assertIn("under each guest", payment)
        self.assertIn("📍 Here is our Location", payment)

    def test_short_stay_group_closeout_has_the_same_deposit_and_map_boundary(self):
        soul = (ROOT / "SOUL.md").read_text(encoding="utf-8")
        short_stay = soul.split("**Under 7 nights — short stay")[1].split("**7+ nights — weekly package flow**")[0]
        for phrase in (
            "within a few days",
            "locks the whole group booking",
            "not the lock amount",
            "once only",
            "📍 Here is our Location",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, short_stay)

    def test_returned_map_line_is_canonical_and_titled(self):
        self.assertEqual(
            plugin._WOLFHOUSE_GUEST_LOCATION_LINE,
            "📍 Here is our Location: https://maps.app.goo.gl/oPRckhqozVBvXxL16",
        )

    def test_confirmation_uses_the_single_titled_location_line(self):
        confirmation_source = (ROOT.parent.parent / "scripts" / "lib" / "luna-guest-confirmation-personality-copy.js").read_text(encoding="utf-8")
        self.assertIn("location: '📍 Here is our Location'", confirmation_source)


if __name__ == "__main__":
    unittest.main()
