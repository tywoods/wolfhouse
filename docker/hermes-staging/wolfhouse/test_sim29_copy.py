"""Sim28/29 immutable chronology plus constructed real-finalizer copy controls.

Historical captures are read-only evidence. Finalizer cases below are explicitly
constructed from their recorded terms; they do not claim scripted model replay.
"""
import json
import os
import unittest
from pathlib import Path

from wolfhouse import accepted_quote as owner


class Sim29CopyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sim28 = cls._load_input_dir("SIM28_INPUT_DIR")
        cls.sim29 = cls._load_input_dir("SIM29_INPUT_DIR")

    @staticmethod
    def _load_input_dir(variable):
        value = os.environ.get(variable)
        if not value:
            raise AssertionError(f"{variable} must point to the immutable capture directory")
        root = Path(value)
        if not root.is_dir():
            raise AssertionError(f"{variable} is not a directory: {root}")
        captures = {}
        for index in range(1, 6):
            path = root / f"guest{index}.jsonl"
            if not path.is_file():
                raise AssertionError(f"missing immutable capture: {path}")
            captures[index] = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        return captures

    def test_original_chronology_and_terms_are_loaded_before_constructed_replay(self):
        emma = self.sim29[4]
        self.assertEqual(5, len(emma))
        self.assertIn("Mon 16 Nov to Thu 19 Nov 2026", emma[0]["guest_text"])
        self.assertIn("Tue 17 Nov to Fri 20 Nov 2026", emma[1]["guest_text"])
        self.assertNotIn("female", emma[2]["guest_text"].casefold())
        self.assertIn("i'm female", emma[3]["guest_text"].casefold())
        self.assertIn("€120", emma[3]["resp"]["reply_text"])
        french = self.sim29[2]
        self.assertIn("Oui, réservez", french[1]["guest_text"])
        self.assertNotIn("€240", french[0]["resp"]["reply_text"])
        self.assertIn("€240", french[1]["resp"]["reply_text"])
        self.assertEqual(5, len(self.sim28))

    def test_constructed_finalizer_has_natural_group_rooms_and_german_group_grammar(self):
        plan = {"check_in": "2026-11-16", "check_out": "2026-11-19", "guest_count": 2,
                "room_type": "shared", "room_preference": "male_only",
                "package_code": "package_none", "payment_choice": "deposit",
                "guests": [{"name": "Jonas Becker"}, {"name": "Felix Becker"}]}
        offer = {**plan, "currency": "EUR", "total_cents": 24000,
                 "deposit_required_cents": 20000, "payment_link_amount_cents": 20000,
                 "room_arrangement": [
                     {"bed_code": "R4-B1", "room_code": "R4", "gender_strategy": "male_only"},
                     {"bed_code": "R4-B2", "room_code": "R4", "gender_strategy": "male_only"}],
                 "guest_bed_assignments": [
                     {"guest_index": 0, "guest_name": "Jonas Becker", "bed_code": "R4-B1"},
                     {"guest_index": 1, "guest_name": "Felix Becker", "bed_code": "R4-B2"}]}
        quote = owner._styled_quote_copy(plan, offer, "de", create_ready=True)
        self.assertIn("Hier ist euer Aufenthalt", quote)
        self.assertIn("Jonas Becker und Felix Becker haben zwei Betten", quote)
        self.assertIn("(Anzahlung)", quote)
        self.assertNotIn("Jonas Becker und Felix Becker:", quote)

    def test_constructed_unpaid_receipts_distinguish_due_now_and_future_remainder(self):
        plan = {"check_in": "2026-11-16", "check_out": "2026-11-19", "guest_count": 1,
                "room_type": "shared", "payment_choice": "deposit",
                "guests": [{"name": "Emma Clarke"}]}
        offer = {**plan, "currency": "EUR", "total_cents": 12001,
                 "payment_link_amount_cents": 10000,
                 "room_arrangement": [{"bed_code": "R5-B1", "room_code": "R5",
                                       "gender_strategy": "female preferred"}],
                 "guest_bed_assignments": [{"guest_index": 0, "guest_name": "Emma Clarke",
                                             "bed_code": "R5-B1"}]}
        receipt = {"booking_code": "WH-CONSTRUCTED", "amount_due_cents": 10000,
                   "currency": "EUR", "secure_payment_url": "https://pay.invalid/emma"}
        text = owner._styled_booking_receipt_copy(plan, offer, receipt, "en")
        self.assertIn("Due now:* €100", text)
        self.assertIn("Remaining after this payment:* €20.01", text)
        self.assertEqual(1, text.count("WH-CONSTRUCTED"))
        self.assertEqual(1, text.count("https://pay.invalid/emma"))
        self.assertNotIn("women-only", text)

        full = owner._styled_booking_receipt_copy(
            {**plan, "payment_choice": "full"}, {**offer, "payment_link_amount_cents": 12001},
            {**receipt, "amount_due_cents": 12001}, "en")
        self.assertNotIn("Remaining after this payment", full)

        missing = owner._styled_booking_receipt_copy(plan, offer,
            {"booking_code": "WH-NO-LINK", "currency": "EUR"}, "en")
        self.assertIn("booking is saved", missing)
        self.assertNotIn("Payment link", missing)
        self.assertNotIn("payment received", missing.casefold())

    def test_constructed_split_links_use_only_usable_link_amounts(self):
        plan = {"check_in": "2026-11-20", "check_out": "2026-11-22", "guest_count": 3,
                "room_type": "shared", "payment_choice": "per_guest",
                "guests": [{"name": "Camille"}, {"name": "Léa"}, {"name": "Hugo"}]}
        offer = {**plan, "currency": "EUR", "total_cents": 24001,
                 "room_arrangement": [
                     {"bed_code": f"R{i}-B1", "room_code": f"R{i}", "gender_strategy": "mixed"}
                     for i in range(1, 4)],
                 "guest_bed_assignments": [
                     {"guest_index": i, "guest_name": row["name"], "bed_code": f"R{i + 1}-B1"}
                     for i, row in enumerate(plan["guests"])]}
        receipt = {"booking_code": "WH-SPLIT-CENTS", "guest_payment_links": [
            {"amount_due_cents": 8000, "currency": "EUR", "secure_payment_url": "https://pay.invalid/a"},
            {"amount_due_cents": 8001, "currency": "EUR", "secure_payment_url": "https://pay.invalid/b"},
            {"amount_due_cents": 8000, "currency": "EUR", "error": "missing_link"}]}
        text = owner._styled_booking_receipt_copy(plan, offer, receipt, "fr")
        self.assertIn("À payer maintenant:* €160.01", text)
        self.assertIn("Reste après ce paiement:* €80", text)
        self.assertIn("Camille, Léa, et Hugo ont des lits dans trois chambres mixtes séparées", text)


if __name__ == "__main__":
    unittest.main()
