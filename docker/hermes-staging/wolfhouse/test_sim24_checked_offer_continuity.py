"""Constructed Sim24 contract witnesses; captured evidence is only provenance.

These tests do not claim historical Staff response bodies.  They exercise the existing
owner rendering path with offline, constructed receipts derived from the approved cases.
"""
import json
from pathlib import Path
import unittest

from wolfhouse import accepted_quote as owner
from wolfhouse_staff_api.test_sim16_jonas_liam_fix import (
    DeterministicRegisteredLoop, availability_receipt, checked_staff_quote,
    create_recheck_receipt,
)


class Sim24CheckedOfferContinuityTests(unittest.TestCase):
    def test_committed_five_case_fixture_is_loaded(self):
        fixture = json.loads((Path(__file__).parents[3] /
            "fixtures/booking-cleanup-step3/sim24-cases.json").read_text())
        self.assertEqual([case["case"] for case in fixture["sources"]],
                         ["guest1", "guest2", "guest3", "guest4", "guest5"])
        self.assertTrue(all(case["facts"]["create_and_link"]
                            for case in fixture["sources"]))

    def test_trusted_slot_keeps_guest_spelling_without_moving_bed(self):
        plan = {"guests": [{"name": "Lucía Fernández Ruiz"}]}
        offer = {
            "room_type": "shared",
            "guest_bed_assignments": [{"guest_index": 0, "guest_name": "lucía fernández ruiz", "bed_code": "R3-B1"}],
            "room_arrangement": [{"bed_code": "R3-B1", "room_code": "R3", "gender_strategy": "mixed"}],
        }
        self.assertEqual(owner._guest_room_lines(plan, offer, "es"),
                         ["Lucía Fernández Ruiz: una cama en una habitación mixta."])
        stale = {"guests": [{"name": "Camille Martin"}]}
        self.assertEqual(owner._guest_room_lines(stale, offer, "es"),
                         ["lucía fernández ruiz: una cama en una habitación mixta."])

    def test_duplicate_names_do_not_reassign_occupant_slots(self):
        plan = {"guests": [{"name": "Alex"}, {"name": "Alex"}]}
        offer = {"room_type": "shared", "guest_bed_assignments": [
            {"guest_index": 0, "guest_name": "Alex", "bed_code": "R1-B1"},
            {"guest_index": 1, "guest_name": "Alex", "bed_code": "R2-B1"}],
            "room_arrangement": [
                {"bed_code": "R1-B1", "room_code": "R1", "gender_strategy": "mixed"},
                {"bed_code": "R2-B1", "room_code": "R2", "gender_strategy": "mixed"}]}
        lines = owner._guest_room_lines(plan, offer)
        self.assertEqual(len(lines), 1)
        self.assertIn("two separate mixed rooms", lines[0])

    def test_missing_package_selection_explains_staff_backed_options_before_question(self):
        result = {"success": False, "package_choice_needed": True,
                  "next_action": "explain_packages_then_ask_choice",
                  "packages": {"malibu": {"total_cents": 12000, "includes_line": "Breakfast and board hire"},
                               "uluwatu": {"total_cents": 18000, "includes_line": "Breakfast, lessons and board hire"}}}
        text = owner._blocked_clarification_copy(result, {}, "en")
        self.assertIn("Malibu", text)
        self.assertIn("€120", text)
        self.assertIn("Uluwatu", text)
        self.assertIn("€180", text)
        self.assertIn("Breakfast and board hire", text)
        self.assertIn("Breakfast, lessons and board hire", text)
        self.assertEqual(text.count("?"), 1)

    def test_package_outcomes_remain_typed(self):
        unavailable = owner._blocked_clarification_copy({"package_choice_needed": True,
            "next_action": "package_eligibility_unavailable"}, {}, "en")
        ineligible = owner._blocked_clarification_copy({"package_choice_needed": True,
            "package_eligible": False, "next_action": "offer_accommodation_or_change_dates"}, {}, "en")
        self.assertIn("couldn't retrieve", unavailable)
        self.assertIn("not eligible", ineligible)
        self.assertNotEqual(unavailable, ineligible)

    def test_preferred_room_never_renders_as_exclusive(self):
        offer = {"room_type": "shared"}
        self.assertEqual(owner._room_kind(offer, {"gender_strategy": "female preferred"}), "shared room")
        self.assertEqual(owner._room_kind(offer, {"gender_strategy": "male preferred"}), "shared room")
        self.assertEqual(owner._room_kind(offer, {"gender_strategy": "female_only"}), "women's room")
        self.assertEqual(owner._room_kind(offer, {"gender_strategy": "male_only"}), "men's room")
    def test_five_sim24_journeys_execute_registered_create_and_link(self):
        fixture = json.loads((Path(__file__).parents[3] /
            "fixtures/booking-cleanup-step3/sim24-cases.json").read_text())
        case_meta = {
            "guest1": {"language": "es", "beds": ["R1-B3"], "room_preference": "mixed"},
            "guest2": {"language": "fr", "beds": ["R3-B1", "R3-B2", "R3-B3"], "room_preference": "mixed"},
            "guest3": {"language": "de", "beds": ["R2-B1", "R2-B2"], "room_preference": "male_only"},
            "guest4": {"language": "en", "beds": ["R5-B1"], "room_preference": "female_only"},
            "guest5": {"language": "en", "beds": ["R1-B2"], "room_preference": "room 1"},
        }
        headings = {"es": "La reserva", "fr": "La réservation",
                    "de": "Die Buchung", "en": "Booking"}
        for source in fixture["sources"]:
            label = source["case"]
            facts = source["facts"]
            meta = case_meta[label]
            language = meta["language"]
            payment_choice = facts["payment"]
            names = facts["names"]
            dates = facts.get("dates") or facts["corrected_dates"]
            with self.subTest(case=label):
                loop = DeterministicRegisteredLoop(self, "sim24-" + label)
                try:
                    beds = [{"bed_code": code, "room_code": code.split("-")[0],
                             "room_type": "shared", "gender_strategy": "mixed",
                             "selected_selling_mode": "bed"} for code in meta["beds"]]
                    guests = [{"name": name} for name in names]
                    plan = {"check_in": dates[0], "check_out": dates[1],
                            "guest_count": facts["party"], "room_type": "shared",
                            "room_preference": meta["room_preference"],
                            "package_code": facts["package"], "add_ons": facts["services"],
                            "payment_choice": payment_choice, "guests": guests,
                            "guest_name": names[0], "selected_bed_codes": meta["beds"],
                            "language": language}
                    if facts.get("explicit_whole_party"):
                        plan["group_gender"] = facts["explicit_whole_party"]
                        for guest in guests:
                            guest["explicit_gender"] = facts["explicit_whole_party"]
                    # Constructed Staff receipts retain each capture's own dates,
                    # party, complete roster, package/payment selection and turn order.
                    total = facts["total_cents"]
                    amount = facts["payment_amount_cents"]
                    deposit = amount if payment_choice == "deposit" else total
                    quote = checked_staff_quote(plan, beds, total=total, deposit=deposit)
                    loop.turn(label + "-first-priced-offer", "show the captured checked price chronology")
                    self.assertTrue(loop.call("quote_booking", plan, {
                        "/availability-check": availability_receipt(beds),
                        "/booking-preview": quote})["success"])
                    shown = loop.present()
                    for name in names:
                        self.assertIn(name, shown)
                    loop.turn(label + "-post-price-acceptance", "yes, create this exact offer")
                    consent = loop.call("interpret_booking_turn", {
                        "action": "accept", "action_evidence": "yes, create this exact offer",
                        "ambiguous": False, "negated": False, "conditional": False,
                        "material_changes": [], "completions": {}}, {})
                    self.assertTrue(consent["success"], consent)
                    url = "https://payments.invalid/" + label
                    def receipts(route, body):
                        if route == "/availability-check":
                            return create_recheck_receipt(beds, body)
                        if route == "/booking-preview":
                            return quote
                        if route == "/booking-create-from-plan":
                            self.assertEqual(body["check_in"], dates[0])
                            self.assertEqual(body["check_out"], dates[1])
                            self.assertEqual(body["guest_count"], facts["party"])
                            self.assertEqual([row["name"] for row in body["guests"]], names)
                            self.assertEqual(body["package_code"], facts["package"])
                            self.assertEqual(body.get("add_ons") or [], facts["services"])
                            self.assertEqual(body["payment_choice"], payment_choice)
                            return {"success": True, "created": True, "write_performed": True,
                                    "booking_id": "id-" + label, "booking_code": "WH-" + label,
                                    "payment_id": "pay-" + label}
                        if route == "/payments/pay-" + label + "/create-stripe-link":
                            return {"success": True, "booking_id": "id-" + label,
                                    "booking_code": "WH-" + label, "payment_id": "pay-" + label,
                                    "guest_payment_url": url, "amount_due_cents": amount,
                                    "currency": "EUR", "payment_status": "pending"}
                        raise AssertionError((route, body))
                    created = loop.call("create_booking_from_plan", {}, receipts)
                    self.assertTrue(created["success"], created)
                    payment = loop.call("create_payment_link", {"payment_id": "pay-" + label}, receipts)
                    self.assertTrue(payment["success"], payment)
                    messages = [{"role": "user", "content": "yes"},
                                {"role": "tool", "name": "create_booking_from_plan",
                                 "content": json.dumps({**created, "tool": "create_booking_from_plan"})},
                                {"role": "tool", "name": "create_payment_link",
                                 "content": json.dumps({**payment, "tool": "create_payment_link"})},
                                {"role": "assistant", "content": "untrusted draft"}]
                    final = owner.finalize_offer_response({"completed": True,
                        "final_response": "untrusted draft", "messages": messages})
                    self.assertIn(headings[language], final["final_response"])
                    self.assertIn(url, final["final_response"])
                    self.assertIn(f"{amount / 100:.2f} EUR", final["final_response"])
                    for name in names:
                        self.assertIn(name, final["final_response"])
                    self.assertEqual(len(loop.create_dispatches), 1)
                finally:
                    loop.close()


if __name__ == "__main__":
    unittest.main()
