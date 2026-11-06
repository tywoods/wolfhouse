"""Constructed Sim24 contract witnesses; captured evidence is only provenance.

These tests do not claim historical Staff response bodies.  They exercise the existing
owner rendering path with offline, constructed receipts derived from the approved cases.
"""
import json
from pathlib import Path
import re
import subprocess
import unittest

from wolfhouse import accepted_quote as owner
from wolfhouse_staff_api.test_sim16_jonas_liam_fix import (
    DeterministicRegisteredLoop, availability_receipt, checked_staff_quote,
    create_recheck_receipt, ROOT,
)


class Sim24CheckedOfferContinuityTests(unittest.TestCase):
    @staticmethod
    def _registered_sql_create(payload, scenario_facts=None):
        script = """
const verify = require('./scripts/verify-luna-create-booking-occupants');
const p = JSON.parse(process.argv[1]);
verify.runPayload(p.payload, { scenarioFacts: p.scenario_facts }).then(
  (result) => process.stdout.write(JSON.stringify(result)),
  (error) => { console.error(error.stack || error); process.exit(1); });
"""
        return json.loads(subprocess.check_output(
            ["node", "-e", script, json.dumps({
                "payload": payload, "scenario_facts": scenario_facts})],
            cwd=ROOT, text=True))

    @staticmethod
    def _eligibility_receipt(plan):
        script = """
const p = JSON.parse(process.argv[1]);
const {buildCanonicalAvailabilityBody:b, mapBotHttpAvailabilityResponse:m,
  AVAILABILITY_CHANNELS:C} = require('./scripts/lib/luna-front-desk-accommodation-availability-service');
const command = {channel:C.BOT_HTTP, clientSlug:'wolfhouse-somo', checkIn:p.check_in,
  checkOut:p.check_out, guestCount:1, roomType:'shared', roomPreference:'female_only',
  transportBody:{guests:p.guests}};
const inventory = {groupGenderResolved:null, allocationReason:null, allocationSplit:false,
  rulesRooming:false, roomOptionFlags:{girls_room_available:true,private_room_available:false},
  selectedBedCodes:[], exactBedValidation:null, selectedRoomCode:null,
  needsClarification:true, clarificationConflict:'room_eligibility_unknown', hasEnoughBeds:true,
  availableCount:2, availableBeds:[], occupiedBedCodes:new Set(), warnings:[], blockers:[],
  roomingHandoff:false, selectedPrivateRoom:false};
process.stdout.write(JSON.stringify(m(b(command, inventory, null))));
"""
        return json.loads(subprocess.check_output(
            ["node", "-e", script, json.dumps(plan)], cwd=ROOT, text=True))

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
                         ["Una cama en una habitación mixta para Lucía Fernández Ruiz."])
        stale = {"guests": [{"name": "Camille Martin"}]}
        self.assertEqual(owner._guest_room_lines(stale, offer, "es"),
                         ["Una cama en una habitación mixta para lucía fernández ruiz."])

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

    def test_name_completed_before_shrink_does_not_revive_retired_slot(self):
        loop = DeterministicRegisteredLoop(self, "sim24-retired-old-completion")
        try:
            beds = [{"bed_code": f"R3-B{index}", "room_code": "R3",
                     "room_type": "shared", "gender_strategy": "mixed",
                     "selected_selling_mode": "bed"} for index in (1, 2)]
            plan = {"check_in": "2026-11-10", "check_out": "2026-11-13",
                    "guest_count": 2, "room_type": "shared",
                    "room_preference": "mixed", "package_code": "package_none",
                    "payment_choice": "full",
                    "guests": [{"name": "Emma"}, {"name": "Liam"}]}
            quote = checked_staff_quote(plan, beds, total=24000, deposit=20000)
            loop.turn("quote", "Rooms for Emma and Liam please.")
            self.assertTrue(loop.call("quote_booking", plan, {
                "/availability-check": availability_receipt(beds),
                "/booking-preview": quote})["success"])
            loop.present()
            raw = "Yes, book it for Emma Clarke and Liam Green."
            loop.turn("accept", raw)
            from copy import deepcopy
            before_diagnostic = owner._read_owner_state(
                lambda state, _ingress: deepcopy(state))
            consent = loop.call("interpret_booking_turn", {
                "action": "accept", "action_evidence": raw,
                "ambiguous": False, "negated": False, "conditional": False,
                "material_changes": [], "completions": {"guests": [
                    {"guest_index": 0, "name": "Emma Clarke", "evidence": "Emma Clarke"},
                    {"guest_index": 1, "name": "Liam Green", "evidence": "Liam Green"},
                ]}}, {})
            self.assertTrue(consent["diagnostic_only"], consent)
            self.assertNotIn("accepted", consent)
            self.assertEqual(owner._read_owner_state(
                lambda state, _ingress: deepcopy(state)), before_diagnostic)
            self.assertEqual(consent["status"], "offered")
            for authority in ("accepted_offer_snapshot", "acceptance_message",
                              "auto_acceptance", "dispatch_pending", "receipt"):
                self.assertNotIn(authority, before_diagnostic)
            rendered_before = [entry for entry in loop.trace
                               if entry["kind"] == "rendered_reply"]
            completed_plan = {**plan, "guests": [
                {"name": "Emma Clarke"}, {"name": "Liam Green"}]}
            completed_quote = checked_staff_quote(
                completed_plan, beds, total=24000, deposit=20000)
            completed = loop.call("quote_booking", completed_plan, {
                "/availability-check": availability_receipt(beds),
                "/booking-preview": completed_quote})
            self.assertTrue(completed["success"], completed)
            completed_state = owner._read_owner_state(
                lambda state, _ingress: deepcopy(state))
            self.assertEqual([guest["name"] for guest in
                              completed_state["plan"]["guests"]],
                             ["Emma Clarke", "Liam Green"])
            self.assertEqual(completed_state["checked_offer"]["guest_bed_assignments"], [
                {"guest_index": 0, "guest_name": "emma clarke", "bed_code": "R3-B1"},
                {"guest_index": 1, "guest_name": "liam green", "bed_code": "R3-B2"}])
            # Names/fingerprint change; every other checked commercial field is equal.
            for key, value in before_diagnostic["checked_offer"].items():
                if key not in ("guest_bed_assignments", "offer_fingerprint"):
                    self.assertEqual(completed_state["checked_offer"][key], value, key)
            self.assertEqual(completed_state["status"], "offered")
            for authority in ("accepted_offer_snapshot", "acceptance_message",
                              "auto_acceptance", "dispatch_pending", "receipt"):
                self.assertNotIn(authority, completed_state)
            self.assertEqual([entry for entry in loop.trace
                              if entry["kind"] == "rendered_reply"], rendered_before)
            self.assertFalse(loop.create_dispatches)

            short = {"check_in": plan["check_in"], "check_out": plan["check_out"],
                     "guest_count": 1, "room_type": "shared",
                     "room_preference": "female_only",
                     "guests": [{"name": "Emma Clarke", "explicit_gender": "female"}]}
            loop.turn("shrink", "Liam is not coming, just Emma now.")
            loop.call("check_availability", short, {
                "/availability-check": availability_receipt(beds[:1])})
            state = owner._transaction(lambda current, _ingress: dict(current))
            self.assertEqual(state["retired_guest_indices"], [1])

            grow = {**short, "guest_count": 2,
                    "guests": [{"name": "Emma Clarke", "explicit_gender": "female"},
                               {"name": "Liam Green"}]}
            unknown = {**availability_receipt(beds),
                       "room_eligibility": {"status": "unsure",
                           "requested_room_preference": "female_only",
                           "affected_guest_indices": [1],
                           "reason_code": "room_eligibility_unknown",
                           "question_kind": "confirm_room_eligibility"}}
            loop.turn("grow", "Another person will join Emma; their details are unknown.")
            result = loop.call("check_availability", grow, {
                "/availability-check": unknown})
            state = owner._transaction(lambda current, _ingress: dict(current))
            reply = owner._structured_eligibility_copy(
                result["room_eligibility"], state["plan"], "en")
            self.assertIn("guest 2", reply)
            self.assertNotIn("Liam Green", reply)
            self.assertFalse(loop.create_dispatches)
        finally:
            loop.close()

    def test_five_sim24_journeys_replay_chronology_create_sql_history_and_one_payment(self):
        from copy import deepcopy
        from types import SimpleNamespace
        from unittest.mock import Mock
        import sys
        # Explicitly authored SCRIPTED MODEL responses, not provider output.
        # Only the unpredictable SQL booking reference is substituted.
        scripted_responses = {
            "guest1": "Lucía Fernández Ruiz, tu reserva {reference} está guardada. Una cama en la habitación compartida R1. Total: €120. Depósito a pagar ahora: €100. Quedan €20 a la salida. Puedes pagar aquí: https://payments.invalid/guest1",
            "guest2": "Camille Martin, Léa Dubois et Hugo Bernard, votre réservation {reference} est enregistrée. Vos lits sont dans la chambre partagée R3. Total : €240. Le paiement intégral de €240 est à régler maintenant : https://payments.invalid/guest2",
            "guest3": "Jonas Becker und Felix Becker, eure Buchung {reference} ist gespeichert. Eure Betten sind im Mehrbettzimmer R2. Gesamtpreis: €240. Die Anzahlung beträgt €200 und ist jetzt fällig. Die restlichen €40 sind bei der Abreise fällig. Hier könnt ihr bezahlen: https://payments.invalid/guest3",
            "guest4": "Emma Clarke, your booking {reference} is saved, with a bed in shared room R5. Total: €120. Full payment of €120 is due now. Please pay here: https://payments.invalid/guest4",
            "guest5": "Raj Patel, your booking {reference} is saved, with a bed in shared room R1. Total: €120. The €100 deposit is due now; the remaining €20 is due at checkout. Please pay here: https://payments.invalid/guest5",
        }
        fixture = json.loads((Path(__file__).parents[3] /
            "fixtures/booking-cleanup-step3/sim24-cases.json").read_text())
        case_meta = {
            "guest1": {"language": "es", "beds": ["R1-B3"], "preference": "mixed",
                "room": "flexible", "gender": "female", "deposit": 10000,
                "turns": [
                    "¡Hola Luna! Soy Lucía, de Sevilla 🇪🇸 Busco 1 cama en el dormitorio mixto del lunes 16 al jueves 19 de noviembre de 2026 (3 noches). Soy mujer y viajo sola. ¿Cuánto cuesta?",
                    "Perfecto. Me llamo Lucía Fernández Ruiz. Prefiero pagar el depósito. ¡Sí, resérvalo!"],
                "first_guests": [{"name": "Lucía", "explicit_gender": "female"}]},
            "guest2": {"language": "fr", "beds": ["R3-B1", "R3-B2", "R3-B3"],
                "preference": "mixed", "room": "flexible", "deposit": 24000,
                "turns": [
                    "Bonjour ! On est trois amis de Lyon (deux filles et un garçon) et on voudrait 3 lits en dortoir mixte du vendredi 13 au dimanche 15 novembre 2026. C'est combien pour nous trois ?",
                    "Super ! Nos noms : Camille Martin, Léa Dubois et Hugo Bernard. On paie tout d'un coup, paiement complet s'il vous plaît. Oui, réservez !",
                    "paiement complet s'il vous plaît"]},
            "guest3": {"language": "de", "beds": ["R2-B1", "R2-B2"],
                "preference": "male_only", "room": "male preferred", "gender": "male",
                "deposit": 20000, "turns": [
                    "Hallo Luna! Mein Bruder und ich (zwei Jungs aus München 😄) suchen 2 Betten im Männerschlafsaal, Montag 23. bis Donnerstag 26. November 2026. Was kostet das?",
                    "Klingt gut. Jonas Becker und Felix Becker. Wir zahlen die Anzahlung. Ja, bitte buchen.",
                    "die Anzahlung bitte"]},
            "guest4": {"language": "en", "beds": ["R5-B1"],
                "preference": "female_only", "room": "female preferred", "gender": "female",
                "deposit": 10000, "initial_dates": ["2026-11-09", "2026-11-12"],
                "turns": [
                    "Hi Luna, Emma from Manchester here. Do you have a girls-only dorm? I'd like 1 bed from Mon 9 Nov to Thu 12 Nov 2026. How much?",
                    "Ugh, sorry, my train changed. Could we do Tue 10 Nov to Fri 13 Nov 2026 instead? Same thing, 1 bed in the women's dorm.",
                    "Perfect, thanks! Emma Clarke, full payment please. Yes, book it.",
                    "yes, I'm female, full payment please",
                    "full payment please"]},
            "guest5": {"language": "en", "beds": ["R1-B2"],
                "preference": "room 1", "room": "flexible", "gender": "male",
                "deposit": 10000, "turns": [
                    "Hey! Raj Patel here, male, stayed with you last year. Could I get a bed in room 1 again if possible, Mon 9 Nov to Thu 12 Nov 2026? I'd pay the deposit. What would it come to?",
                    "Cool, that works. Yes, book it please."]},
        }
        for source in fixture["sources"]:
            label, facts = source["case"], source["facts"]
            meta = case_meta[label]
            dates = facts.get("dates") or facts["corrected_dates"]
            with self.subTest(case=label):
                loop = DeterministicRegisteredLoop(self, "sim24-" + label)
                try:
                    turns_seen = []
                    def turn(index):
                        raw = meta["turns"][index]
                        loop.turn(f"{label}-{index + 1}", raw)
                        loop.db.append_message(session_id=loop.agent.session_id,
                                               role="user", content=raw)
                        turns_seen.append(raw)
                        return raw

                    beds = [{"bed_code": code, "room_code": code.split("-")[0],
                             "room_type": "shared", "gender_strategy": meta["room"],
                             "selected_selling_mode": "bed"} for code in meta["beds"]]
                    guests = [{"name": name, **({"explicit_gender": meta["gender"]}
                               if meta.get("gender") else {})} for name in facts["names"]]
                    plan = {"check_in": dates[0], "check_out": dates[1],
                            "guest_count": facts["party"], "room_type": "shared",
                            "room_preference": meta["preference"],
                            "package_code": facts["package"], "add_ons": facts["services"],
                            "payment_choice": facts["payment"], "guests": guests,
                            "guest_name": facts["names"][0],
                            "selected_bed_codes": meta["beds"], "language": meta["language"]}
                    if meta.get("gender"):
                        plan["group_gender"] = meta["gender"]
                    quote = checked_staff_quote(plan, beds, total=facts["total_cents"],
                                                deposit=meta["deposit"])
                    shown = ""

                    turn(0)
                    if label == "guest1":
                        initial = {**plan, "guests": meta["first_guests"],
                                   "guest_name": "Lucía"}
                        initial.pop("payment_choice")
                        initial_quote = checked_staff_quote(
                            initial, beds, total=facts["total_cents"],
                            deposit=meta["deposit"])
                        first = loop.call("quote_booking", initial, {
                            "/availability-check": availability_receipt(beds),
                            "/booking-preview": initial_quote})
                        self.assertTrue(first["success"], first)
                        shown = loop.present()
                        self.assertIn("€120", shown)
                        deposit_text = (f"€{meta['deposit'] // 100}"
                                        if meta["deposit"] % 100 == 0
                                        else f"€{meta['deposit'] / 100:.2f}")
                        self.assertRegex(
                            shown,
                            rf"(?<!\d){re.escape(deposit_text)}(?!\d|[.,]\d)")
                        self.assertIn("depósito", shown.lower())
                        self.assertIn("el total de €120", shown.lower())
                        turn(1)
                    elif label == "guest2":
                        initial = {key: plan[key] for key in
                                   ("check_in", "check_out", "guest_count", "room_type", "room_preference")}
                        blocked = loop.call("quote_booking", initial, {
                            "/package-price-preview": {"success": False,
                                "package_eligible": False,
                                "next_action": "offer_accommodation_or_change_dates"}})
                        self.assertEqual(blocked["next_action"], "package_eligibility_unavailable")
                        turn(1)
                    elif label == "guest3":
                        initial = {"check_in": dates[0], "check_out": dates[1],
                                   "guest_count": 2, "room_type": "shared",
                                   "room_preference": "male_only", "group_gender": "male"}
                        loop.call("check_availability", initial, {
                            "/availability-check": availability_receipt(beds)})
                        turn(1)
                    elif label == "guest4":
                        initial = {"check_in": meta["initial_dates"][0],
                                   "check_out": meta["initial_dates"][1], "guest_count": 1,
                                   "room_type": "shared", "room_preference": "female_only",
                                   "package_code": "package_none"}
                        for index, staged in enumerate((
                            initial,
                            {**initial, "check_in": dates[0], "check_out": dates[1],
                             "guests": [{"name": "Emma"}], "guest_name": "Emma"},
                            {**initial, "check_in": dates[0], "check_out": dates[1],
                             "guests": [{"name": "Emma Clarke"}], "guest_name": "Emma Clarke",
                             "payment_choice": "full"},
                        )):
                            if index:
                                turn(index)
                            blocked = loop.call("quote_booking", staged, {
                                "/availability-check":
                                    self._eligibility_receipt(staged),
                                "/package-price-preview": {"success": False,
                                    "package_eligible": None,
                                    "next_action": "package_eligibility_unavailable"}})
                            self.assertEqual(blocked["availability_status"], "eligibility_required")
                        turn(3)
                    elif label == "guest5":
                        loop.call("quote_booking", plan, {
                            "/availability-check": availability_receipt(beds),
                            "/booking-preview": quote})
                        shown = loop.present()
                        turn(1)

                    if label not in ("guest1", "guest5"):
                        quoted = loop.call("quote_booking", plan, {
                            "/availability-check": availability_receipt(beds),
                            "/booking-preview": quote})
                        self.assertTrue(quoted["success"], quoted)
                        shown = loop.present()
                    total_text = (f"€{facts['total_cents'] // 100}" if facts['total_cents'] % 100 == 0
                                  else f"€{facts['total_cents'] / 100:.2f}")
                    self.assertRegex(shown, rf"(?<!\d){re.escape(total_text)}(?!\d|[.,]\d)")
                    self.assertEqual(quote["deposit_required_cents"], meta["deposit"])
                    if label == "guest4":
                        self.assertEqual(quote["payment_link_amount_cents"], 12000)
                        turn(4)
                    elif label in ("guest2", "guest3"):
                        turn(2)

                    acceptance = meta["turns"][-1]
                    completions = {}
                    if label == "guest1":
                        completions = {
                            "guests": [{"guest_index": 0,
                                        "name": "Lucía Fernández Ruiz",
                                        "evidence": "Lucía Fernández Ruiz"}],
                            "payment_choice": {"value": "deposit",
                                               "evidence": "depósito"},
                        }
                    interpreted = loop.call("interpret_booking_turn", {
                        "action": "accept", "action_evidence": acceptance,
                        "ambiguous": False, "negated": False, "conditional": False,
                        "material_changes": [], "completions": completions}, {})
                    self.assertTrue(interpreted["success"], interpreted)
                    if label == "guest1":
                        completed = loop.call("quote_booking", plan, {
                            "/availability-check": availability_receipt(beds),
                            "/booking-preview": quote})
                        self.assertTrue(completed["success"], completed)
                        self.assertEqual(
                            [entry["text"] for entry in loop.trace
                             if entry["kind"] == "rendered_reply"],
                            [shown],
                            "completion/revalidation must not render a second offer")

                    scenario = {"weekly_cents": 28000,
                                "deposit_per_guest_cents": meta["deposit"] // facts["party"],
                                "rooms": [{"room_code": code.split("-")[0],
                                           "gender_strategy": meta["room"]}
                                          for code in meta["beds"]]}
                    sql_proofs = []
                    payment_link_ids = []
                    url = "https://payments.invalid/" + label
                    def receipts(route, body):
                        if route == "/availability-check":
                            return create_recheck_receipt(beds, body)
                        if route == "/booking-preview":
                            return quote
                        if route == "/booking-create-from-plan":
                            # This is the transport invoked by the registered owner
                            # dispatch. Its response comes from the real Staff command,
                            # execute path and committed isolated PGlite rows.
                            proof = self._registered_sql_create(
                                body, scenario_facts=scenario)
                            sql_proofs.append(proof)
                            payment_id = proof["money"]["payments"][0]["id"]
                            return {**proof["body"], "success": proof["ok"],
                                    "write_performed": proof["ok"],
                                    "payment_id": payment_id}
                        if route.endswith("/create-stripe-link"):
                            payment_id = route.split("/")[2]
                            self.assertEqual(len(sql_proofs), 1)
                            persisted = sql_proofs[0]["money"]["payments"]
                            self.assertEqual([row["id"] for row in persisted], [payment_id])
                            payment_link_ids.append(payment_id)
                            return {"success": True,
                                    "booking_id": sql_proofs[0]["bookings"][0]["id"],
                                    "booking_code": sql_proofs[0]["body"]["booking_code"],
                                    "payment_id": payment_id,
                                    "guest_payment_url": url,
                                    "amount_due_cents": facts["payment_amount_cents"],
                                    "currency": "EUR", "payment_status": "pending"}
                        self.fail((route, body))

                    created = loop.call("create_booking_from_plan", {}, receipts)
                    self.assertTrue(created["success"], created)
                    self.assertEqual(payment_link_ids,
                                     [sql_proofs[0]["money"]["payments"][0]["id"]])
                    self.assertEqual(len(loop.create_dispatches), 1)
                    self.assertEqual(len(sql_proofs), 1)
                    proof = sql_proofs[0]
                    self.assertEqual([row["guest_name"] for row in proof["occupants"]],
                                     facts["names"])
                    self.assertEqual([row["assigned_bed_code"] for row in proof["occupants"]],
                                     meta["beds"])
                    self.assertEqual(len(proof["bookings"]), 1)
                    self.assertEqual(len(proof["money"]["payments"]), 1)
                    self.assertEqual(sum(row["kind"] == "booking_create"
                                         for row in proof["sql_calls"]), 1)
                    payment_routes = [row for row in loop.staff
                                      if row["route"].startswith("/payments/")]
                    self.assertEqual(len(payment_routes), 1)

                    messages = [{"role": "tool", "name": "create_booking_from_plan",
                                 "content": json.dumps({**created,
                                     "tool": "create_booking_from_plan"})},
                                {"role": "assistant", "content": "untrusted draft"}]
                    # Negative controls preserve the saved receipt and confirmation debt.
                    saved_state = owner._read_owner_state(lambda state, _: deepcopy(state))
                    saved_dispatches = deepcopy(loop.create_dispatches)
                    saved_staff = deepcopy(loop.staff)
                    saved_proofs = deepcopy(sql_proofs)
                    control_results = []
                    for invalid_callback in (None, lambda _facts, _draft: "invalid callback output"):
                        withheld = owner.finalize_offer_response({"completed": True,
                            "final_response": "untrusted draft", "messages": deepcopy(messages)},
                            rewrite_callback=invalid_callback)
                        control_results.append(withheld)
                        self.assertTrue(withheld["completed"])
                        self.assertTrue(withheld["confirmation_withheld"])
                        self.assertIsNone(withheld["final_response"])
                        self.assertIsNone(withheld["messages"][-1]["content"])
                        self.assertEqual(withheld["confirmation_status"]["status"], "owed")
                        debt_state = owner._read_owner_state(lambda state, _: deepcopy(state))
                        self.assertEqual(debt_state["status"], saved_state["status"])
                        self.assertEqual(debt_state["receipt"], saved_state["receipt"])
                        self.assertEqual(debt_state["confirmation_owed"]["reference"], created["booking_code"])
                        self.assertEqual(debt_state["confirmation_owed"]["guest_names"], facts["names"])
                        self.assertEqual(debt_state["confirmation_owed"]["total_cents"], facts["total_cents"])
                        self.assertEqual(debt_state["confirmation_owed"]["amount_due_now_cents"], facts["payment_amount_cents"])
                        self.assertEqual(debt_state["confirmation_owed"]["payment_links"], [url])
                        self.assertEqual(loop.create_dispatches, saved_dispatches)
                        self.assertEqual(loop.staff, saved_staff)
                        self.assertEqual(sql_proofs, saved_proofs)
                        self.assertEqual(payment_link_ids, [proof["money"]["payments"][0]["id"]])
                    model_requests = []
                    scripted_text = scripted_responses[label].format(reference=created["booking_code"])
                    def external_create(**request):
                        model_requests.append(deepcopy(request))
                        return SimpleNamespace(choices=[SimpleNamespace(
                            message=SimpleNamespace(content=scripted_text))])
                    client = SimpleNamespace(chat=SimpleNamespace(
                        completions=SimpleNamespace(create=external_create)))
                    loop.agent.api_mode = "chat_completions"
                    loop.agent.model = "scripted-model-sim24-not-a-provider-run"
                    loop.agent._create_request_openai_client = Mock(return_value=client)
                    loop.agent._close_request_openai_client = Mock()
                    rewrite_inputs = []
                    real_calls = []
                    def observe_calls(frame, event, _arg):
                        if event == "call" and frame.f_code.co_filename == owner.__file__:
                            real_calls.append(frame.f_code.co_name)
                    def rewrite_callback(canonical, draft):
                        rewrite_inputs.append((deepcopy(canonical), draft))
                        return owner._rewrite_saved_confirmation(loop.agent, canonical, draft)
                    prior_profile = sys.getprofile()
                    sys.setprofile(observe_calls)
                    try:
                        final = owner.finalize_offer_response({"completed": True,
                            "final_response": "untrusted draft", "messages": messages},
                            rewrite_callback=rewrite_callback)
                    finally:
                        sys.setprofile(prior_profile)
                    self.assertEqual(len(rewrite_inputs), 1)
                    self.assertEqual(rewrite_inputs[0][1], "untrusted draft")
                    self.assertEqual(len(model_requests), 1)
                    request = model_requests[0]
                    self.assertFalse(request["stream"])
                    self.assertNotIn("tools", request)
                    self.assertNotIn("tool_choice", request)
                    self.assertEqual(request["model"], "scripted-model-sim24-not-a-provider-run")
                    requested = json.loads(request["messages"][1]["content"])
                    self.assertEqual(requested["canonical_saved_booking"], rewrite_inputs[0][0])
                    self.assertEqual(requested["invalid_draft"], "untrusted draft")
                    canonical = requested["canonical_saved_booking"]
                    self.assertEqual(canonical["reference"], created["booking_code"])
                    self.assertEqual(canonical["guest_names"], facts["names"])
                    self.assertEqual(canonical["total_cents"], facts["total_cents"])
                    self.assertEqual(canonical["amount_due_now_cents"], facts["payment_amount_cents"])
                    self.assertEqual(canonical["payment_links"], [url])
                    for function in ("_rewrite_saved_confirmation", "_sendable_saved_confirmation",
                                     "_confirmation_reject_reasons",
                                     "_filled_confirmation_matches_facts"):
                        self.assertIn(function, real_calls)
                    loop.agent._create_request_openai_client.assert_called_once_with(
                        reason="saved-booking-confirmation-rewrite")
                    loop.agent._close_request_openai_client.assert_called_once_with(
                        client, reason="saved-booking-confirmation-rewrite")
                    self.assertEqual(final["final_response"], scripted_text)
                    self.assertEqual(loop.create_dispatches, saved_dispatches)
                    self.assertEqual(loop.staff, saved_staff)
                    self.assertEqual(sql_proofs, saved_proofs)
                    self.assertIn(url, final["final_response"])
                    due_text = (f"€{facts['payment_amount_cents'] // 100}"
                                if facts['payment_amount_cents'] % 100 == 0
                                else f"€{facts['payment_amount_cents'] / 100:.2f}")
                    self.assertRegex(final["final_response"],
                                     rf"(?<!\d){re.escape(due_text)}(?!\d|[.,]\d)")
                    if facts["party"] == 1:
                        self.assertIn(facts["names"][0].split()[0], final["final_response"])
                    else:
                        for name in facts["names"]:
                            self.assertIn(name, final["final_response"])
                    loop.db.append_message(session_id=loop.agent.session_id,
                                           role="assistant", content=final["final_response"])
                    history = loop.db.get_messages(loop.agent.session_id)
                    self.assertGreater(len(history), len(turns_seen))
                    self.assertEqual(history[-1]["content"], final["final_response"])
                    self.assertEqual(final["messages"][-1]["content"],
                                     final["final_response"])
                    self.assertEqual([row["text"] for row in loop.trace
                                      if row["kind"] == "raw_user"], meta["turns"])
                finally:
                    loop.close()


if __name__ == "__main__":
    unittest.main()
