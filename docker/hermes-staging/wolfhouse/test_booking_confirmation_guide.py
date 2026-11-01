from pathlib import Path
import unittest


SOUL = Path(__file__).resolve().parents[1] / "SOUL.md"


class BookingConfirmationGuideTests(unittest.TestCase):
    def guide(self):
        text = SOUL.read_text(encoding="utf-8")
        start = text.index("## Booking confirmation guide")
        end = text.index("**After pay intent", start)
        return text[start:end]

    def test_guide_has_required_booking_fact_contract(self):
        guide = self.guide().lower()
        for required in (
            "booking reference",
            "every guest's name",
            "check-in and check-out dates",
            "number of nights",
            "private or shared",
            "package",
            "total",
            "amount due now",
            "remains owed",
            "payment link",
        ):
            with self.subTest(required=required):
                self.assertIn(required, guide)
        self.assertIn("saved-booking facts returned by the tool", guide)
        self.assertIn("re-fetch the saved booking", guide)
        self.assertIn("same complete saved facts and authoring context", guide)
        self.assertIn("backup model receives those same facts", guide)

    def test_guide_is_not_a_confirmation_template(self):
        guide = self.guide().lower()
        self.assertIn("guide", guide)
        self.assertIn("not a template", guide)
        self.assertIn("do not reuse example sentences", guide)
        self.assertNotIn("shall i save", guide)
        self.assertNotIn("booking confirmed!", guide)

    def test_layout_follows_staff_style_without_fixed_copy(self):
        guide = self.guide().lower()
        self.assertIn("for the **extra** style", guide)
        self.assertIn("every line starting with a fitting emoji", guide)
        self.assertIn("luna chooses the emojis", guide)
        self.assertIn("calendar for dates", guide)
        self.assertIn("bed for room", guide)
        self.assertIn("money for total or payment amount", guide)
        self.assertIn("link for the payment url", guide)
        self.assertIn("every other style", guide)
        self.assertIn("plain short lines or plain bullets with no emoji bullets", guide)
        self.assertIn("no guest-facing wording", guide)

    def test_payment_choice_is_the_single_consent_and_same_turn_confirmation(self):
        text = SOUL.read_text(encoding="utf-8").lower()
        self.assertIn("the guest's deposit-or-full selection", text)
        self.assertIn("same reply in which the guest selects deposit or full", text)
        self.assertIn("never ask whether luna should save", text)
        self.assertIn("never send a second confirmation", text)


if __name__ == "__main__":
    unittest.main()
