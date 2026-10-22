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
        self.assertIn("⏳ *Remaining balance:* €200", text)
        self.assertIn("🔗 *Payment link:* https://example.invalid/pay/abc", text)
        self.assertNotIn("payment received", text.lower())
        self.assertNotIn("paid", text.lower())
        self.assert_style(text)

    def test_receipt_localizes_spanish_and_german_without_changing_money_truth(self):
        receipt = {"success": True, "booking_code": "WH-2F393C"}
        expected = {
            "es": ("Fabio, ¡tu reserva está guardada! 🌊", "📌 *Reserva:*", "📅 *Fechas:*", "⏳ *Saldo restante:* €200"),
            "de": ("Fabio, deine Buchung ist gespeichert! 🌊", "📌 *Buchung:*", "📅 *Daten:*", "⏳ *Restbetrag:* €200"),
        }
        for language, phrases in expected.items():
            with self.subTest(language=language):
                text = owner._styled_booking_receipt_copy(self.plan, self.offer, receipt, language)
                for phrase in phrases:
                    self.assertIn(phrase, text)
                self.assertEqual(text.count("WH-2F393C"), 1)
                self.assert_style(text)

    def test_unpaid_receipt_uses_current_payment_link_amount_for_due_and_balance(self):
        receipt = {
            "success": True, "booking_code": "WH-2F393C",
            "secure_payment_url": "https://example.invalid/pay/current",
            "amount_due_cents": 15000, "currency": "EUR",
        }
        expected = {
            "en": ("💳 *Due now:* €150", "⏳ *Remaining balance:* €250",
                   "🔗 *Payment link:* https://example.invalid/pay/current"),
            "es": ("💳 *A pagar ahora:* €150", "⏳ *Saldo restante:* €250",
                   "🔗 *Enlace de pago:* https://example.invalid/pay/current"),
        }
        for language, phrases in expected.items():
            with self.subTest(language=language):
                text = owner._styled_booking_receipt_copy(self.plan, self.offer, receipt, language)
                for phrase in phrases:
                    self.assertIn(phrase, text)
                self.assertEqual(text.count("WH-2F393C"), 1)
                self.assertEqual(text.count("https://example.invalid/pay/current"), 1)
                self.assertNotIn("€150.00", text)
                self.assert_style(text)

    def test_solo_quote_names_allocated_room_and_discloses_substitution(self):
        requested = {**self.plan, "room_preference": "room_1"}
        room_one = {**self.offer, "room_arrangement": [
            {"bed_code": "R1-B1", "room_code": "R1", "gender_strategy": "mixed"}],
            "guest_bed_assignments": [{"guest_index": 0, "guest_name": "Fabio", "bed_code": "R1-B1"}]}
        room_three = {**room_one, "room_arrangement": [
            {"bed_code": "R3-B1", "room_code": "R3", "gender_strategy": "mixed"}],
            "guest_bed_assignments": [{"guest_index": 0, "guest_name": "Fabio", "bed_code": "R3-B1"}]}
        direct = owner._styled_quote_copy(requested, room_one, "en", create_ready=True)
        substitute = owner._styled_quote_copy(requested, room_three, "en", create_ready=True)
        self.assertIn("Room 1", direct)
        self.assertIn("Room 1 is not available", substitute)
        self.assertIn("quote is for Room 3", substitute)
        substitute_es = owner._styled_quote_copy(requested, room_three, "es", create_ready=True)
        self.assertIn("Habitación 1 no está disponible", substitute_es)
        self.assertIn("presupuesto es para Habitación 3", substitute_es)

    def test_checked_quote_shows_each_guest_package_and_selected_extras_before_consent(self):
        plan = {**self.plan, "guest_count": 2, "guests": [{"name": "Fabio"}, {"name": "Mia"}],
                "guest_packages": [{"guest_number": None, "package_code": "malibu"},
                                   {"guest_number": None, "package_code": "waimea"}],
                "add_ons": [{"code": "yoga_class", "quantity": 2}]}
        offer = {**self.offer, **plan, "room_arrangement": [
            {"bed_code": "R1-B1", "room_code": "R1", "gender_strategy": "mixed"},
            {"bed_code": "R1-B2", "room_code": "R1", "gender_strategy": "mixed"}],
            "guest_bed_assignments": [
                {"guest_index": 0, "guest_name": "Fabio", "bed_code": "R1-B1"},
                {"guest_index": 1, "guest_name": "Mia", "bed_code": "R1-B2"}]}
        text = owner._styled_quote_copy(plan, offer, "en", create_ready=True)
        self.assertIn("Fabio: Malibu", text)
        self.assertIn("Mia: Waimea", text)
        self.assertIn("Yoga class ×2", text)
        self.assertLess(text.index("Fabio: Malibu"), text.index("Shall I save"))
        text_es = owner._styled_quote_copy(plan, offer, "es", create_ready=True)
        self.assertIn("Fabio: Malibu", text_es)
        self.assertIn("Mia: Waimea", text_es)
        self.assertIn("Clase de yoga ×2", text_es)
        self.assertLess(text_es.index("Fabio: Malibu"), text_es.index("¿Guardo"))

    def test_full_only_and_named_split_amounts_are_explicit_before_consent(self):
        full = {**self.offer, "total_cents": 8000, "payment_link_amount_cents": 8000,
                "payment_choice": "full", "full_payment_only": True}
        self.assertIn("💶 *Total and due now:* €80 (full payment)",
                      owner._styled_quote_copy(self.plan, full, "en", create_ready=True))
        self.assertIn("💶 *Total y a pagar ahora:* €80 (pago completo)",
                      owner._styled_quote_copy(self.plan, full, "es", create_ready=True))
        split_plan = {**self.plan, "guest_count": 2, "guests": [{"name": "Fabio"}, {"name": "Mia"}],
                      "payment_choice": "per_guest", "per_guest_payment_links": True}
        split = {**self.offer, **split_plan, "total_cents": 15000,
                 "payment_link_amount_cents": 15000, "payment_distribution": [
                     {"guest_name": "Fabio", "amount_cents": 7000},
                     {"guest_name": "Mia", "amount_cents": 8000}]}
        split_text = owner._styled_quote_copy(split_plan, split, "en", create_ready=True)
        self.assertIn("Fabio: €70", split_text)
        self.assertIn("Mia: €80", split_text)
        self.assertLess(split_text.index("Fabio: €70"), split_text.index("Shall I save"))
        split_text_es = owner._styled_quote_copy(split_plan, split, "es", create_ready=True)
        self.assertIn("Fabio: €70", split_text_es)
        self.assertIn("Mia: €80", split_text_es)
        self.assertLess(split_text_es.index("Fabio: €70"), split_text_es.index("¿Guardo"))

    def test_split_receipt_due_now_equals_links_sent(self):
        receipt = {"success": True, "booking_code": "WH-SPLIT", "amount_due_cents": 20000,
                   "guest_payment_links": [
                       {"guest_name": "Fabio", "amount_due_cents": 7500, "secure_payment_url": "https://pay.invalid/a"},
                       {"guest_name": "Mia", "amount_due_cents": 7500, "secure_payment_url": "https://pay.invalid/b"},
                       {"guest_name": "Failed link", "amount_due_cents": 5000, "error": "payment_link_timeout"}]}
        text = owner._styled_booking_receipt_copy(
            {**self.plan, "payment_choice": "per_guest"},
            {**self.offer, "total_cents": 15000, "payment_choice": "per_guest"}, receipt, "en")
        self.assertIn("💳 *Due now:* €150", text)
        self.assertNotIn("Due now:* €200", text)
        text_es = owner._styled_booking_receipt_copy(
            {**self.plan, "payment_choice": "per_guest"},
            {**self.offer, "total_cents": 15000, "payment_choice": "per_guest"}, receipt, "es")
        self.assertIn("💳 *A pagar ahora:* €150", text_es)
        self.assertNotIn("A pagar ahora:* €200", text_es)

    def test_malformed_payment_shapes_fail_closed_without_false_copy(self):
        full = {**self.offer, "total_cents": 8000, "payment_link_amount_cents": 6000,
                "payment_choice": "full", "full_payment_only": True}
        full_text = owner._styled_quote_copy(self.plan, full, "en", create_ready=True)
        self.assertNotIn("Total and due now", full_text)
        self.assertIn("Due now:* €60", full_text)
        self.assertIn("Remaining after this payment:* €20", full_text)

        split_plan = {**self.plan, "guest_count": 2,
                      "guests": [{"name": "Fabio"}, {"name": "Mia"}],
                      "payment_choice": "per_guest", "per_guest_payment_links": True}
        duplicate = {**self.offer, **split_plan, "total_cents": 15000,
                     "payment_link_amount_cents": 15000, "payment_distribution": [
                         {"guest_name": "Fabio", "amount_cents": 7000},
                         {"guest_name": "Fabio", "amount_cents": 8000}]}
        self.assertNotIn("Individual payments", owner._styled_quote_copy(
            split_plan, duplicate, "en", create_ready=True))
        mixed_guests = {**duplicate, "payment_distribution": None,
                        "guests": [{"name": "Fabio"}, "bad-row"]}
        self.assertNotIn("Individual payments", owner._styled_quote_copy(
            split_plan, mixed_guests, "en", create_ready=True))
        duplicate_roster = {**duplicate, "payment_distribution": None,
                            "guests": [{"name": "Fabio"}, {"name": " fabio "}]}
        self.assertNotIn("Individual payments", owner._styled_quote_copy(
            split_plan, duplicate_roster, "en", create_ready=True))

        fallback_plan = {**self.plan, "guest_packages": [
            {"guest_index": 0, "package_code": "malibu"}],
            "add_ons": [{"code": "yoga_class", "quantity": 1}]}
        fallback_offer = {**self.offer,
                          "guest_packages": [{"package_code": 123}],
                          "add_ons": [{"code": {"bad": True}}]}
        fallback_text = owner._styled_quote_copy(fallback_plan, fallback_offer, "en", create_ready=True)
        self.assertIn("Malibu", fallback_text)
        self.assertIn("Yoga class", fallback_text)

        receipt = {"booking_code": "WH-MALFORMED", "guest_payment_links": [
            {"amount_due_cents": 7500, "currency": "EUR", "secure_payment_url": "https://pay.invalid/a"},
            {"amount_due_cents": 7500, "currency": "EUR", "secure_payment_url": "   "},
            {"amount_due_cents": 9000, "currency": "USD", "secure_payment_url": "https://pay.invalid/usd"},
            {"amount_due_cents": 5000, "currency": "EUR", "secure_payment_url": "http://pay.invalid/insecure"},
            {"amount_due_cents": 5000, "currency": "EUR", "secure_payment_url": "https://[bad-ipv6"}]}
        receipt_text = owner._styled_booking_receipt_copy(
            split_plan, {**self.offer, "total_cents": 15000}, receipt, "en")
        self.assertIn("Due now:* €75", receipt_text)

    def test_soul_mixed_default_yields_to_explicit_room_preference(self):
        from pathlib import Path
        soul = (Path(__file__).resolve().parents[1] / "SOUL.md").read_text()
        self.assertIn("mixed/shared default never overrides an explicit room preference", soul)


if __name__ == "__main__":
    unittest.main()
