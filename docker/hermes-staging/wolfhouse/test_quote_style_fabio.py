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
            "es": ("Aquí va el resumen de la estancia 🌊", "📅 *Fechas:*", "🛏️ *Habitación:*", "💶 *Total:* €400", "¿Guardo esta reserva?"),
            "de": ("Dein Aufenthalt in Somo auf einen Blick 🌊", "📅 *Daten:*", "🛏️ *Zimmer:*", "💶 *Gesamt:* €400", "Soll ich diese Buchung speichern?"),
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

    def test_saved_booking_receipt_renders_staff_itemised_invoice(self):
        plan = {**self.plan, "check_out": "2026-11-11", "guest_count": 2,
                "guests": [{"name": "Jack"}, {"name": "Jill"}],
                "guest_packages": [{"guest_number": 1, "package_code": "waimea"},
                                   {"guest_number": 2, "package_code": "waimea"}]}
        offer = {**self.offer, **plan, "total_cents": 175000,
                 "per_person": [
                     {"guest_number": 1, "package_code": "waimea",
                      "accommodation_cents": 80000, "subtotal_cents": 87500},
                     {"guest_number": 2, "package_code": "waimea",
                      "accommodation_cents": 80000, "subtotal_cents": 87500}],
                 "included_items": [
                     {"code": "guest_package_proration", "guest_number": 1,
                      "package_code": "waimea", "nights": 10, "guest_count": 1,
                      "unit_cents": 8000, "total_cents": 80000},
                     {"code": "guest_package_proration", "guest_number": 2,
                      "package_code": "waimea", "nights": 10, "guest_count": 1,
                      "unit_cents": 8000, "total_cents": 80000},
                     {"code": "room_supplement", "nights": 10, "guest_count": 2,
                      "unit_cents": 1000, "total_cents": 10000},
                     {"code": "yoga_class", "quantity": 1,
                      "unit_cents": 5000, "total_cents": 5000}]}
        receipt = {"booking_code": "WH-INVOICE", "amount_due_cents": 40000,
                   "secure_payment_url": "https://example.invalid/pay/invoice"}
        text = owner._styled_booking_receipt_copy(plan, offer, receipt, "en")
        self.assertTrue(text.startswith("Jack, your booking is saved — here's your invoice 🌊"), text)
        self.assertIn("Jack · Waimea · 10 nights × €80 = €800", text)
        self.assertIn("Jill · Waimea · 10 nights × €80 = €800", text)
        self.assertIn("Private room supplement · 10 nights × €10 = €100", text)
        self.assertIn("Yoga class · 1 × €50 = €50", text)
        self.assertIn("💶 *Total:* €1750", text)
        self.assertIn("💳 *Deposit due now:* €400", text)
        self.assertIn("⏳ *Remaining after this payment:* €1350", text)
        self.assertLess(text.index("💶 *Total:*"), text.index("🔗 *Payment link:*"))

    def test_saved_booking_receipt_fails_closed_when_staff_breakdown_is_incomplete(self):
        offer = {**self.offer, "per_person": [
            {"guest_number": 1, "package_code": "package_none",
             "accommodation_cents": 39999, "subtotal_cents": 39999}],
            "included_items": []}
        receipt = {"booking_code": "WH-FALLBACK", "amount_due_cents": 20000,
                   "secure_payment_url": "https://example.invalid/pay/fallback"}
        text = owner._styled_booking_receipt_copy(self.plan, offer, receipt, "en")
        self.assertNotIn("nights ×", text)
        self.assertIn("📅 *Dates:*", text)
        self.assertIn("💶 *Total:* €400", text)

    def test_saved_booking_receipt_fails_closed_when_staff_base_total_is_inconsistent(self):
        offer = {**self.offer,
                 "per_person": [{"guest_number": 1, "package_code": "package_none",
                                  "accommodation_cents": 40000}],
                 "included_items": [{"code": "accommodation_only", "guest_number": 1,
                                      "nights": 8, "unit_cents": 5000,
                                      "total_cents": 39999}]}
        receipt = {"booking_code": "WH-BAD-BASE", "amount_due_cents": 20000,
                   "secure_payment_url": "https://example.invalid/pay/bad-base"}
        text = owner._styled_booking_receipt_copy(self.plan, offer, receipt, "en")
        self.assertNotIn("here's your invoice", text)
        self.assertIn("📅 *Dates:*", text)

    def test_saved_booking_receipt_rejects_unconsumed_duplicate_and_inconsistent_rows(self):
        plan = {**self.plan, "check_out": "2026-11-11", "guest_count": 2,
                "guests": [{"name": "Jack"}, {"name": "Jill"}]}
        valid_people = [
            {"guest_number": 1, "package_code": "waimea",
             "accommodation_cents": 80000, "subtotal_cents": 80000},
            {"guest_number": 2, "package_code": "waimea",
             "accommodation_cents": 80000, "subtotal_cents": 80000},
        ]
        valid_items = [
            {"code": "guest_package_proration", "guest_number": 1, "nights": 10,
             "unit_cents": 8000, "total_cents": 80000},
            {"code": "guest_package_proration", "guest_number": 2, "nights": 10,
             "unit_cents": 8000, "total_cents": 80000},
        ]
        cases = {
            "unknown_guest_extra": valid_items + [
                {"code": "guest_mystery", "guest_number": 3, "nights": 1,
                 "unit_cents": 0, "total_cents": 0}],
            "duplicate_base_line": valid_items + [dict(valid_items[0])],
            "missing_person_base_line": valid_items[:1],
            "malformed_extra": valid_items + ["not-a-row"],
        }
        receipt = {"booking_code": "WH-FALLBACK", "amount_due_cents": 40000}
        for label, items in cases.items():
            with self.subTest(label=label):
                offer = {**self.offer, **plan, "total_cents": 160000,
                         "per_person": valid_people, "included_items": items}
                text = owner._styled_booking_receipt_copy(plan, offer, receipt, "en")
                self.assertNotIn("here's your invoice", text)
                self.assertIn("📅 *Dates:*", text)
        mismatched = [dict(valid_people[0]), {**valid_people[1], "subtotal_cents": 79999}]
        text = owner._styled_booking_receipt_copy(
            plan, {**self.offer, **plan, "total_cents": 160000,
                   "per_person": mismatched, "included_items": valid_items}, receipt, "en")
        self.assertNotIn("here's your invoice", text)
        self.assertIn("📅 *Dates:*", text)

    def test_saved_booking_receipt_rejects_numbered_rows_that_contradict_person(self):
        plan = {**self.plan, "check_out": "2026-11-11", "guest_count": 2,
                "guests": [{"name": "Jack"}, {"name": "Jill"}],
                "guest_packages": [{"guest_number": 1, "package_code": "waimea"},
                                   {"guest_number": 2, "package_code": "waimea"}]}
        people = [
            {"guest_number": 1, "package_code": "waimea",
             "accommodation_cents": 80000, "subtotal_cents": 80000},
            {"guest_number": 2, "package_code": "waimea",
             "accommodation_cents": 80000, "subtotal_cents": 80000},
        ]
        rows = [
            {"code": "guest_package_proration", "guest_number": 1,
             "package_code": "waimea", "nights": 10, "guest_count": 1,
             "unit_cents": 8000, "total_cents": 80000},
            {"code": "guest_package_proration", "guest_number": 2,
             "package_code": "waimea", "nights": 10, "guest_count": 1,
             "unit_cents": 8000, "total_cents": 80000},
        ]
        receipt = {"booking_code": "WH-FALLBACK", "amount_due_cents": 40000}
        cases = {
            "contradictory_guest_count": [dict(rows[0]), {**rows[1], "guest_count": 99}],
            "contradictory_package": [dict(rows[0]), {**rows[1], "package_code": "malibu"}],
        }
        for label, included_items in cases.items():
            with self.subTest(label=label):
                offer = {**self.offer, **plan, "total_cents": 160000,
                         "per_person": people, "included_items": included_items}
                text = owner._styled_booking_receipt_copy(plan, offer, receipt, "en")
                self.assertNotIn("here's your invoice", text)
                self.assertIn("📅 *Dates:*", text)

    def test_private_quote_discloses_staff_supplement_before_approval(self):
        plan = {**self.plan, "room_type": "private", "room_preference": "couple_private"}
        offer = {**self.offer, **plan, "total_cents": 172500,
                 "included_items": [
                     {"code": "accommodation_only", "guest_number": 1, "nights": 8,
                      "unit_cents": 20000, "total_cents": 160000},
                     {"code": "room_supplement", "quantity": 1,
                      "unit_cents": 12500, "total_cents": 12500}]}
        text = owner._styled_quote_copy(plan, offer, "en", create_ready=True)
        self.assertIn("Private room supplement", text)
        self.assertIn("€125", text)
        self.assertIn("💶 *Total:* €1725", text)
        self.assertLess(text.index("€125"), text.index("Shall I save"))

    def test_itemised_per_guest_payment_uses_generic_due_label(self):
        plan = {**self.plan, "payment_choice": "per_guest"}
        offer = {**self.offer, **plan,
                 "per_person": [{"guest_number": 1, "package_code": "package_none",
                                  "accommodation_cents": 40000}],
                 "included_items": [{"code": "accommodation_only", "guest_number": 1,
                                      "nights": 8, "unit_cents": 5000,
                                      "total_cents": 40000}]}
        receipt = {"booking_code": "WH-SPLIT", "amount_due_cents": 20000,
                   "secure_payment_url": "https://example.invalid/pay/split"}
        text = owner._styled_booking_receipt_copy(plan, offer, receipt, "en")
        self.assertIn("💳 *Due now:* €200", text)
        self.assertNotIn("Deposit due now", text)

    def test_receipt_localizes_spanish_and_german_without_changing_money_truth(self):
        receipt = {"success": True, "booking_code": "WH-2F393C"}
        expected = {
            "es": ("Fabio, hemos registrado tu reserva. 🌊", "📌 *Reserva:*", "📅 *Fechas:*", "⏳ *Pendiente después de este pago:* €200"),
            "de": ("Fabio, deine Buchung ist bei uns eingetragen! 🌊", "📌 *Buchung:*", "📅 *Daten:*", "⏳ *Danach noch offen:* €200"),
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
            "en": ("💳 *Due now:* €150", "⏳ *Remaining after this payment:* €250",
                   "🔗 *Payment link:* https://example.invalid/pay/current"),
            "es": ("💳 *A pagar ahora:* €150", "⏳ *Pendiente después de este pago:* €250",
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

    def test_german_group_quote_uses_group_address_and_capitalized_anzahlung(self):
        plan = {**self.plan, "guest_count": 2,
                "guests": [{"name": "Jonas"}, {"name": "Felix"}]}
        offer = {**self.offer, **plan, "room_arrangement": [
            {"bed_code": "R4-B1", "room_code": "R4", "gender_strategy": "male_only"},
            {"bed_code": "R4-B2", "room_code": "R4", "gender_strategy": "male_only"}],
            "guest_bed_assignments": [
                {"guest_index": 0, "guest_name": "Jonas", "bed_code": "R4-B1"},
                {"guest_index": 1, "guest_name": "Felix", "bed_code": "R4-B2"}]}
        text = owner._styled_quote_copy(plan, offer, "de", create_ready=True)
        self.assertTrue(text.startswith("Euer Aufenthalt in Somo auf einen Blick 🌊"), text)
        self.assertIn("Jonas und Felix haben zwei Betten", text)
        self.assertIn("Soll ich eure Buchung speichern?", text)
        provisional = owner._styled_quote_copy(plan, offer, "de", create_ready=False)
        self.assertIn("Möchtet ihr zusammen bezahlen", provisional)
        self.assertIn("oder getrennt", provisional)
        self.assertNotIn("Was möchtest du?", provisional)
        self.assertNotIn("Jonas und Felix:", text)

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
        facts = owner._quote_authoring_facts(self.plan, self.offer, "en")
        self.assertEqual(facts['rooms'], self.offer['room_arrangement'])
        self.assertEqual(facts['room_assignments'], self.offer['guest_bed_assignments'])

    def test_soul_private_room_requires_guest_approval_after_requote(self):
        private = {**self.offer, "room_type": "private", "offer_revision_version": "rev-2"}
        facts = owner._quote_authoring_facts(
            {**self.plan, "room_type": "private"}, private, "en",
            create_ready=True, updated=True)
        self.assertTrue(facts['create_ready'])
        self.assertTrue(facts['updated_quote'])
        self.assertEqual(facts['quote_revision_version'], "rev-2")


if __name__ == "__main__":
    unittest.main()
