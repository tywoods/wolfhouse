"""Ty-approved warm quote and saved-booking receipt style contracts."""
import unittest

from wolfhouse import accepted_quote as owner


class QuoteStyleFabioTests(unittest.TestCase):
    def setUp(self):
        self.plan = {
            "check_in": "2026-11-01", "check_out": "2026-11-09", "guest_count": 1,
            "room_type": "shared", "guests": [{"name": "Fabio"}],
            "package_code": "package_none", "payment_choice": "deposit",
        }
        self.offer = {
            **self.plan, "currency": "EUR", "total_cents": 40000,
            "deposit_required_cents": 20000, "payment_link_amount_cents": 20000,
            "room_arrangement": [{"bed_code": "M1", "room_code": "M", "gender_strategy": "mixed"}],
            "guest_bed_assignments": [{"guest_index": 0, "guest_name": "Fabio", "bed_code": "M1"}],
            "guest_packages": [], "add_ons": [], "per_guest_payment_links": [],
        }

    def assert_style(self, text):
        self.assertNotIn("**", text)
        self.assertNotIn("#", text)
        self.assertNotIn(".00", text)
        self.assertNotIn("created successfully", text.lower())
        self.assertNotIn("availability checked", text.lower())
        self.assertNotIn("check for this booking", text.lower())
        for line in text.splitlines():
            if line.startswith(("📌", "📅", "🛏️", "👥", "🏄", "💶", "💳", "⏳", "✅", "🔗")):
                self.assertRegex(line, r"^\S+ \*[^*]+:\* .+")

    def test_provisional_quote_en_uses_warm_emoji_layout_and_one_payment_choice(self):
        quote = {**self.offer, "payment_choice_needed": True}
        text = owner._styled_quote_copy(self.plan, quote, "en", create_ready=False)
        self.assertTrue(text.startswith("Here's your stay 🌊\n"), text)
        self.assertIn("📅 *Dates:* Sun 1 Nov – Mon 9 Nov · 1 guest", text)
        self.assertIn("🛏️ *Room:* A bed in our mixed shared room", text)
        self.assertIn("💶 *Total:* €400", text)
        self.assertEqual(text.count("Which would you like?"), 1)
        self.assertIn("pay a €200 deposit now or the full €400", text)
        self.assertEqual(text.count("Fabio"), 0)
        self.assert_style(text)

    def test_checked_quote_is_localized_in_english_spanish_and_german(self):
        expected = {
            "en": ("Here's your stay 🌊", "📅 *Dates:*", "🛏️ *Room:*", "💶 *Total:* €400", "Shall I save this booking?"),
            "es": ("Aquí tienes tu estancia 🌊", "📅 *Fechas:*", "🛏️ *Habitación:*", "💶 *Total:* €400", "¿Guardo esta reserva?"),
            "de": ("Hier ist dein Aufenthalt 🌊", "📅 *Daten:*", "🛏️ *Zimmer:*", "💶 *Gesamt:* €400", "Soll ich diese Buchung speichern?"),
        }
        for language, phrases in expected.items():
            with self.subTest(language=language):
                text = owner._styled_quote_copy(self.plan, self.offer, language, create_ready=True)
                for phrase in phrases:
                    self.assertIn(phrase, text)
                self.assertEqual(text.count("🛏️"), 1)
                self.assert_style(text)

    def test_saved_booking_receipt_distinguishes_saved_link_and_payment(self):
        receipt = {
            "success": True, "booking_code": "WH-2F393C",
            "secure_payment_url": "https://example.invalid/pay/abc",
            "amount_due_cents": 20000, "currency": "EUR",
        }
        text = owner._styled_booking_receipt_copy(self.plan, self.offer, receipt, "en")
        self.assertTrue(text.startswith("Fabio, your booking is saved! 🌊"), text)
        self.assertEqual(text.count("WH-2F393C"), 1)
        self.assertIn("📌 *Booking:* WH-2F393C", text)
        self.assertIn("💶 *Total:* €400", text)
        self.assertIn("💳 *Due now:* €200", text)
        self.assertIn("⏳ *Remaining after this payment:* €200", text)
        self.assertIn("🔗 *Payment link:* https://example.invalid/pay/abc", text)
        self.assertNotIn("payment received", text.lower())
        self.assertNotIn("paid", text.lower())
        self.assert_style(text)

    def test_receipt_localizes_spanish_and_german_without_changing_money_truth(self):
        receipt = {"success": True, "booking_code": "WH-2F393C"}
        expected = {
            "es": ("Fabio, ¡tu reserva está guardada! 🌊", "📌 *Reserva:*", "📅 *Fechas:*", "⏳ *Pendiente después de este pago:* €200"),
            "de": ("Fabio, deine Buchung ist gespeichert! 🌊", "📌 *Buchung:*", "📅 *Daten:*", "⏳ *Danach noch offen:* €200"),
        }
        for language, phrases in expected.items():
            with self.subTest(language=language):
                text = owner._styled_booking_receipt_copy(self.plan, self.offer, receipt, language)
                for phrase in phrases:
                    self.assertIn(phrase, text)
                self.assertEqual(text.count("WH-2F393C"), 1)
                self.assert_style(text)


if __name__ == "__main__":
    unittest.main()
