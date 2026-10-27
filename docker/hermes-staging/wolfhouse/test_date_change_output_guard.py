import unittest
from wolfhouse import output_guard


class DateChangeOutputGuardTest(unittest.TestCase):
    def test_blocks_moved_claim_without_same_booking_receipt(self):
        text, findings = output_guard.guard_reply("Your booking WH-1 has been moved to June 1–5.", guest_lang="en", tool_calls=[])
        self.assertNotIn("has been moved", text)
        self.assertTrue(any(row["kind"] == "unsupported_date_change_claim" for row in findings))

    def test_allows_moved_claim_only_for_same_booking_receipt(self):
        calls = [{"name": "move_booking_dates", "result": {"success": True, "write_performed": True, "moved_same_booking": True, "booking": {"booking_code": "WH-1", "check_in": "2027-06-01", "check_out": "2027-06-05"}}}]
        text, findings = output_guard.guard_reply("Your booking WH-1 has been moved to June 1–5.", guest_lang="en", tool_calls=calls)
        self.assertEqual(text, "Your booking WH-1 has been moved to June 1–5.")
        self.assertFalse(any(row["kind"] == "unsupported_date_change_claim" for row in findings))

    def test_blocks_receipt_for_another_booking_in_all_languages(self):
        calls = [{"name": "move_booking_dates", "result": {"success": True, "write_performed": True, "moved_same_booking": True, "booking": {"booking_code": "WH-OTHER", "check_in": "2027-04-02", "check_out": "2027-04-09"}}}]
        for lang, text in (("en", "Your booking WH-E2E has been moved to April 2–9."), ("es", "Tu reserva WH-E2E se ha cambiado al 2–9 de abril."), ("it", "La prenotazione WH-E2E è stata spostata al 2–9 aprile.")):
            with self.subTest(lang=lang):
                guarded, findings = output_guard.guard_reply(text, guest_lang=lang, tool_calls=calls)
                self.assertNotEqual(guarded, text)
                self.assertTrue(any(row["kind"] == "unsupported_date_change_claim" for row in findings))

    def test_blocks_wrong_dates_in_all_languages(self):
        calls = [{"name": "move_booking_dates", "result": {"success": True, "write_performed": True, "moved_same_booking": True, "booking": {"booking_code": "WH-E2E", "check_in": "2027-04-02", "check_out": "2027-04-09"}}}]
        for lang, text in (("en", "Your booking WH-E2E has been moved to July 1–5."), ("es", "Tu reserva WH-E2E se ha cambiado al 1–5 de julio."), ("it", "La prenotazione WH-E2E è stata spostata al 1–5 luglio.")):
            with self.subTest(lang=lang):
                guarded, findings = output_guard.guard_reply(text, guest_lang=lang, tool_calls=calls)
                self.assertNotEqual(guarded, text)
                self.assertTrue(any(row["kind"] == "unsupported_date_change_claim" for row in findings))

    def test_blocks_wrong_year_another_booking_and_old_dates_beside_wrong_new(self):
        receipt = {"success": True, "write_performed": True, "moved_same_booking": True, "booking": {"booking_code": "WH-1", "check_in": "2027-06-01", "check_out": "2027-06-05"}}
        calls = [{"name": "move_booking_dates", "result": receipt}]
        cases = [
            ("en", "Your booking WH-1 has been moved to June 1–5, 2026."),
            ("es", "Tu reserva WH-1 se ha cambiado al 1–5 de junio de 2026."),
            ("it", "La prenotazione WH-1 è stata spostata al 1–5 giugno 2026."),
            ("en", "Your booking WH-OTHER has been moved to June 1–5."),
            ("es", "Tu reserva WH-OTHER se ha cambiado al 1–5 de junio."),
            ("it", "La prenotazione WH-OTHER è stata spostata al 1–5 giugno."),
            ("en", "Your booking WH-1 (2027-06-01 to 2027-06-05) has been moved to July 1–5."),
            ("es", "Tu reserva WH-1 (2027-06-01 a 2027-06-05) se ha cambiado al 1–5 de julio."),
            ("it", "La prenotazione WH-1 (2027-06-01–2027-06-05) è stata spostata al 1–5 luglio."),
        ]
        for lang, text in cases:
            with self.subTest(lang=lang, text=text):
                guarded, findings = output_guard.guard_reply(text, guest_lang=lang, tool_calls=calls)
                self.assertNotEqual(guarded, text)
                self.assertTrue(any(row["kind"] == "unsupported_date_change_claim" for row in findings))


if __name__ == "__main__":
    unittest.main()
