"""Booking cleanup Step 2 focused structured clarification and display proofs.

The Staff responses here are synthetic, offline boundary fixtures.  They preserve the
captured Becker argument shape; they are not represented as the unavailable live
response body or as proof of its historical cause.
"""
import json
import os
import re
import subprocess
import sys
import unittest

from wolfhouse import accepted_quote as owner
from wolfhouse_staff_api.test_sim16_jonas_liam_fix import (
    DeterministicRegisteredLoop,
    availability_receipt,
    checked_staff_quote,
    create_recheck_receipt,
    ROOT,
)


class StructuredRoomClarificationTests(unittest.TestCase):
    @staticmethod
    def _run_occupants(body, *, scenario_facts=None, recompute_offer=False):
        script = """
const fs = require('node:fs');
const h = require('./scripts/verify-luna-create-booking-occupants');
const body = JSON.parse(fs.readFileSync(0, 'utf8'));
if (%s) {
  const offers = require('./scripts/lib/luna-front-desk-accommodation-availability-service');
  body.accepted_offer = offers.buildWolfhouseOfferRevision(body.accepted_offer);
}
const facts = JSON.parse(%r);
const options = facts ? {sim23Fixture: h.createSim23Fixture(body, facts)} : {};
h.runPayload(body, options).then(result => process.stdout.write(JSON.stringify(result)));
""" % ("true" if recompute_offer else "false", json.dumps(scenario_facts))
        run = subprocess.run(["node", "-e", script], input=json.dumps(body), text=True,
                             cwd=ROOT, capture_output=True, timeout=90)
        if run.returncode:
            raise AssertionError({"stdout": run.stdout, "stderr": run.stderr})
        return json.loads(run.stdout)

    def test_single_affected_named_guest_is_singular_in_all_languages(self):
        eligibility = {
            "status": "unsure",
            "requested_room_preference": "female_only",
            "affected_guest_indices": [0],
            "reason_code": "room_eligibility_unknown",
            "question_kind": "confirm_room_eligibility",
        }
        plan = {"guests": [{"name": "Emma"}]}
        expected = {
            "en": "Is Emma eligible for the requested women-only room?",
            "es": "¿Puede Emma alojarse en la habitación solicitada solo para mujeres?",
            "fr": "Est-ce que Emma peut séjourner dans la chambre demandée réservée aux femmes ?",
            "de": "Kann Emma im gewünschten Frauenzimmer übernachten?",
        }
        for language, copy in expected.items():
            with self.subTest(language=language):
                self.assertEqual(copy, owner._structured_eligibility_copy(
                    eligibility, plan, language))

    def test_package_preview_failure_is_not_rendered_as_room_refusal(self):
        result = {
            "success": False,
            "tool": "quote_booking",
            "quote_status": "needs_guest_clarification",
            "package_choice_needed": True,
            "next_action": "package_eligibility_unavailable",
            "offer_revision": None,
        }
        package_word = {"en": "package", "es": "paquete", "fr": "forfait", "de": "paket"}
        for language in ("en", "es", "fr", "de"):
            with self.subTest(language=language):
                text = owner._blocked_clarification_copy(result, {}, language)
                self.assertIn(package_word[language], text.casefold())
                self.assertNotEqual(owner._final_copy(language, "refusal"), text)

    def test_genuine_package_policy_ineligibility_is_not_a_selection_prompt(self):
        result = {"success": False, "package_choice_needed": True,
                  "package_eligible": False,
                  "next_action": "offer_accommodation_or_change_dates"}
        controls = {
            "en": ("not eligible", "accommodation-only", "change the dates"),
            "es": ("no cumple", "solo alojamiento", "cambiar las fechas"),
            "fr": ("pas éligible", "hébergement seul", "modifier les dates"),
            "de": ("nicht berechtigt", "nur für die Unterkunft", "Reisedaten ändern"),
        }
        for language, phrases in controls.items():
            text = owner._blocked_clarification_copy(result, {}, language)
            for phrase in phrases:
                self.assertIn(phrase, text)
            self.assertNotEqual(owner._final_copy(language, "refusal"), text)

    def test_package_choice_and_no_stock_renders_inventory_refusal_first(self):
        result = {"success": False, "package_choice_needed": True,
                  "availability_status": "unavailable", "unavailable": True}
        text = owner._blocked_clarification_copy(result, {}, "en")
        self.assertEqual(owner._final_copy("en", "refusal"), text)
        self.assertNotIn("Which package", text)

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

    def test_registered_availability_only_corrected_dates_keep_name(self):
        loop = DeterministicRegisteredLoop(self, "availability-only-date-ack")
        try:
            first = {"check_in": "2026-11-03", "check_out": "2026-11-06",
                     "guest_count": 1, "room_type": "shared",
                     "room_preference": "female_only", "guests": [{"name": "Emma"}]}
            loop.turn("availability-original", "3–6 November for Emma")
            loop.call("check_availability", first,
                      {"/availability-check": self._eligibility_receipt(first)})
            corrected = {**first, "check_in": "2026-11-10", "check_out": "2026-11-13"}
            loop.turn("availability-corrected", "Actually 10–13 November")
            checked = loop.call("check_availability", corrected,
                      {"/availability-check": self._eligibility_receipt(corrected)})
            rendered = owner.finalize_offer_response({"completed": True,
                "final_response": "MODEL DRAFT", "messages": [
                    {"role": "user", "content": "Actually 10–13 November"},
                    {"role": "tool", "content": json.dumps(checked)},
                    {"role": "assistant", "content": "MODEL DRAFT"}]})
            self.assertIn("Tue 10 Nov to Fri 13 Nov", rendered["final_response"])
            self.assertIn("Emma", rendered["final_response"])
            self.assertEqual(rendered["final_response"].count("?"), 1)
        finally:
            loop.close()

    def test_registered_corrected_dates_are_acknowledged_before_eligibility_question(self):
        for checkout_only in (False, True):
            with self.subTest(checkout_only=checkout_only):
                loop = DeterministicRegisteredLoop(self, f"date-ack-{checkout_only}")
                try:
                    start = {"check_in": "2026-11-03", "check_out": "2026-11-06",
                             "guest_count": 1, "room_type": "shared",
                             "room_preference": "female_only", "package_code": "package_none",
                             "payment_choice": "full", "language": "en",
                             "guests": [{"name": "Emma"}]}
                    loop.turn("original", "Emma needs 3–6 November in the women-only dorm; full payment.")
                    first = loop.call("quote_booking", start,
                                      {"/availability-check": self._eligibility_receipt(start)})
                    owner.finalize_offer_response({"completed": True, "final_response": "draft",
                        "messages": [{"role": "tool", "content": json.dumps(first)},
                                     {"role": "assistant", "content": "draft"}]})

                    corrected = {**start, "check_out": "2026-11-07"}
                    if not checkout_only:
                        corrected["check_in"] = "2026-11-04"
                    raw = ("Keep 3 November, but change checkout to 7 November."
                           if checkout_only else "Change the stay to 4–7 November.")
                    loop.turn("corrected", raw)
                    result = loop.call("quote_booking", corrected,
                                       {"/availability-check": self._eligibility_receipt(corrected)})
                    # A registered loop may re-quote the same corrected plan before
                    # its first final response. That retry must not erase the
                    # current-turn date acknowledgement.
                    result = loop.call("quote_booking", corrected,
                                       {"/availability-check": self._eligibility_receipt(corrected)})
                    reply = owner.finalize_offer_response({"completed": True,
                        "final_response": "model date acknowledgement must not be trusted",
                        "messages": [{"role": "user", "content": raw},
                                     {"role": "tool", "content": json.dumps(result)},
                                     {"role": "assistant", "content": "model draft"}]})
                    expected = ("Thanks — I’ve updated the stay to "
                                f"{'Tue 3 Nov' if checkout_only else 'Wed 4 Nov'} to Sat 7 Nov.\n"
                                "Is Emma eligible for the requested women-only room?")
                    self.assertEqual(reply["final_response"], expected)
                    self.assertEqual(reply["messages"][-1]["content"], expected)
                    state = owner._transaction(lambda current, _ingress: dict(current))
                    self.assertEqual((state["plan"]["check_in"], state["plan"]["check_out"]),
                                     (corrected["check_in"], corrected["check_out"]))
                    self.assertEqual(state["completion_plan"]["payment_choice"], "full")
                    self.assertEqual(state["plan"]["room_preference"], "female_only")
                    self.assertFalse(loop.create_dispatches)
                finally:
                    loop.close()

    def test_persisted_blocked_state_prepends_current_turn_date_acknowledgement(self):
        loop = DeterministicRegisteredLoop(self, "persisted-date-ack")
        try:
            corrected = {"check_in": "2026-11-04", "check_out": "2026-11-07",
                         "guest_count": 1, "room_type": "shared",
                         "room_preference": "female_only", "package_code": "package_none",
                         "payment_choice": "full", "language": "en",
                         "guests": [{"name": "Emma"}]}
            raw = "Change the stay to 4–7 November."
            loop.turn("corrected", raw)
            result = loop.call("quote_booking", corrected,
                               {"/availability-check": self._eligibility_receipt(corrected)})
            owner._transaction(lambda state, ingress: state.update(
                quote_date_acknowledgement={
                    "message_id": ingress["MESSAGE_ID"],
                    "check_in": corrected["check_in"],
                    "check_out": corrected["check_out"],
                }))
            reply = owner.finalize_offer_response({"completed": True,
                "final_response": "model draft",
                "messages": [{"role": "user", "content": raw},
                             {"role": "assistant", "content": "model draft"}]})
            expected = ("Thanks — I’ve updated the stay to Wed 4 Nov to Sat 7 Nov.\n"
                        "Is Emma eligible for the requested women-only room?")
            self.assertEqual(reply["final_response"], expected)
            self.assertEqual(reply["messages"][-1]["content"], expected)
        finally:
            loop.close()

    def test_french_singleton_eligibility_is_neutral_for_named_and_unnamed_guests(self):
        for room, name, expected in (
            ("male_only", "Hugo", "Est-ce que Hugo peut séjourner dans la chambre demandée réservée aux hommes ?"),
            ("female_only", "Hugo", "Est-ce que Hugo peut séjourner dans la chambre demandée réservée aux femmes ?"),
            ("male_only", "", "Est-ce que la personne 1 peut séjourner dans la chambre demandée réservée aux hommes ?"),
            ("female_only", "", "Est-ce que la personne 1 peut séjourner dans la chambre demandée réservée aux femmes ?"),
        ):
            eligibility = {"status": "unsure", "requested_room_preference": room,
                           "affected_guest_indices": [0],
                           "question_kind": "confirm_room_eligibility"}
            self.assertEqual(expected, owner._structured_eligibility_copy(
                eligibility, {"guests": [{"name": name}]}, "fr"))

    def test_sim23_five_capture_outcomes_registered_render_create_and_sql(self):
        """Each immutable Sim23 outcome crosses registered quote/create and PGlite."""
        cases = (
            {"label": "lucia", "dates": ("2026-11-09", "2026-11-12"),
             "names": ("Lucía Fernández Ruiz",), "beds": ("R3-B1",), "payment": "deposit",
             "total": 12000, "deposit": 10000, "weekly": 28000, "room": "flexible",
             "preference": "mixed", "language": "es", "gender": "female",
             "turns": ("¡Hola Luna! Soy Lucía, de Sevilla 🇪🇸 Busco 1 cama en el dormitorio mixto del lunes 9 al jueves 12 de noviembre de 2026 (3 noches). Soy mujer y viajo sola. ¿Cuánto cuesta?",
                       "Perfecto. Me llamo Lucía Fernández Ruiz. Prefiero pagar el depósito. ¡Sí, resérvalo!")},
            {"label": "french-group", "dates": ("2026-11-06", "2026-11-08"),
             "names": ("Camille Martin", "Léa Dubois", "Hugo Bernard"),
             "beds": ("R1-B1", "R1-B2", "R1-B3"), "payment": "full",
             "total": 24000, "deposit": 24000, "weekly": 28000, "room": "flexible", "preference": "mixed",
             "language": "fr", "group_gender": "mixed",
             "turns": ("Bonjour ! On est trois amis de Lyon (deux filles et un garçon) et on voudrait 3 lits en dortoir mixte du vendredi 6 au dimanche 8 novembre 2026. C'est combien pour nous trois ?",
                       "Super ! Nos noms : Camille Martin, Léa Dubois et Hugo Bernard. On paie tout d'un coup, paiement complet s'il vous plaît. Oui, réservez !")},
            {"label": "becker", "dates": ("2026-11-23", "2026-11-26"),
             "names": ("Jonas Becker", "Felix Becker"),
             "beds": ("R4-B1", "R4-B2"), "payment": "deposit",
             "total": 24000, "deposit": 20000, "weekly": 28000, "room": "male preferred",
             "preference": "male_only", "language": "de", "gender": "male",
             "turns": ("Hallo Luna! Mein Bruder und ich (zwei Jungs aus München 😄) suchen 2 Betten im Männerschlafsaal, Montag 23. bis Donnerstag 26. November 2026. Was kostet das?",
                       "Klingt gut. Jonas Becker und Felix Becker. Wir zahlen die Anzahlung. Ja, bitte buchen.",
                       "die Anzahlung bitte")},
            {"label": "emma", "dates": ("2026-11-04", "2026-11-07"),
             "names": ("Emma Clarke",), "beds": ("R8-B4",), "payment": "full",
             "total": 12000, "deposit": 10000, "weekly": 28000, "room": "female preferred",
             "preference": "female_only", "gender": "female",
             "turns": ("Hi Luna, Emma from Manchester here. Do you have a girls-only dorm? I'd like 1 bed from Tue 3 Nov to Fri 6 Nov 2026. How much?",
                       "Ugh, sorry, my train changed. Could we do Wed 4 Nov to Sat 7 Nov 2026 instead? Same thing, 1 bed in the women's dorm.",
                       "Perfect, thanks! Emma Clarke, full payment please. Yes, book it.",
                       "yes, I'm female, full payment please",
                       "full payment please")},
            {"label": "raj", "dates": ("2026-11-06", "2026-11-08"),
             "names": ("Raj Patel",), "beds": ("R1-B4",), "payment": "full",
             "total": 8000, "deposit": 8000, "weekly": 28000, "room": "flexible",
             "preference": "room 1", "gender": "male",
             "turns": ("Hey! Raj Patel here, male, stayed with you last year. Could I get a bed in room 1 again if possible, Fri 6 Nov to Sun 8 Nov 2026? I'd pay the deposit. What would it come to?",
                       "Cool, that works. Yes, book it please.")},
        )
        for case in cases:
            with self.subTest(case=case["label"]):
                loop = DeterministicRegisteredLoop(self, f"sim23-{case['label']}")
                try:
                    beds = []
                    for code in case["beds"]:
                        room_code = code.split("-B", 1)[0]
                        beds.append({"bed_code": code, "room_code": room_code,
                                     "room_type": "shared",
                                     "gender_strategy": case["room"],
                                     "selected_selling_mode": "bed"})
                    guests = []
                    for index, name in enumerate(case["names"]):
                        explicit_gender = ((case.get("genders") or ())[index]
                                           if case.get("genders") else case.get("gender"))
                        guests.append({"name": name, **({"explicit_gender": explicit_gender}
                                      if explicit_gender else {})})
                    plan = {"check_in": case["dates"][0], "check_out": case["dates"][1],
                            "guest_count": len(guests), "room_type": "shared",
                            "room_preference": case["preference"],
                            "package_code": "package_none", "payment_choice": case["payment"],
                            "language": case.get("language", "en"), "guests": guests,
                            "guest_name": guests[0]["name"],
                            "selected_bed_codes": list(case["beds"])}
                    if case.get("group_gender") or case.get("gender"):
                        plan["group_gender"] = case.get("group_gender") or case["gender"]
                    raw_quote = checked_staff_quote(
                        plan, beds, total=case["total"], deposit=case["deposit"])
                    turns = case["turns"]
                    loop.turn(f"{case['label']}-initial", turns[0])
                    acceptance_loaded = False
                    if case["label"] in ("lucia", "french-group", "raj"):
                        initial = {"check_in": case["dates"][0],
                                   "check_out": case["dates"][1],
                                   "guest_count": len(case["names"]),
                                   "room_type": "shared",
                                   "room_preference": case["preference"],
                                   "package_code": "package_none",
                                   "selected_bed_codes": list(case["beds"])}
                        if case["label"] == "lucia":
                            initial.update({"guest_name": "Lucía", "guests": [
                                {"name": "Lucía", "explicit_gender": "female"}]})
                        elif case["label"] == "raj":
                            initial.update({"guest_name": "Raj Patel", "guests": [
                                {"name": "Raj Patel", "explicit_gender": "male"}],
                                "payment_choice": "deposit"})
                        self.assertNotIn("payment_choice", initial) if case["label"] != "raj" \
                            else self.assertEqual(initial["payment_choice"], "deposit")
                        if case["label"] == "french-group":
                            self.assertNotIn("guests", initial)
                        initial_quote = checked_staff_quote(
                            initial, beds, total=case["total"], deposit=case["deposit"])
                        first = loop.call("quote_booking", initial, {
                            "/availability-check": availability_receipt(beds),
                            "/booking-preview": initial_quote})
                        self.assertEqual(first["total_cents"], case["total"])
                        loop.turn(f"{case['label']}-accept", turns[-1])
                        acceptance_loaded = True
                    if case["label"] == "becker":
                        initial = {"check_in": case["dates"][0],
                                   "check_out": case["dates"][1], "guest_count": 2,
                                   "room_type": "shared", "room_preference": "male_only",
                                   "group_gender": "male"}
                        blocked = loop.call("quote_booking", initial, {
                            "/package-price-preview": {"success": False,
                                "package_eligible": None, "packages": {},
                                "next_action": "package_eligibility_unavailable"}})
                        self.assertEqual(blocked["quote_status"], "needs_guest_clarification")
                        self.assertEqual(blocked["next_action"], "package_eligibility_unavailable")
                        loop.turn(f"{case['label']}-details", turns[1])
                    elif case["label"] == "emma":
                        initial = {**plan, "check_in": "2026-11-03",
                                   "check_out": "2026-11-06", "guests": [{"name": "Emma"}],
                                   "guest_name": "Emma"}
                        initial.pop("selected_bed_codes", None)
                        initial.pop("group_gender", None)
                        initial.pop("payment_choice", None)
                        for index, (raw, staged) in enumerate((
                            (turns[0], initial),
                            (turns[1], {**initial, "check_in": "2026-11-04",
                                        "check_out": "2026-11-07"}),
                            (turns[2], {**initial, "check_in": "2026-11-04",
                                        "check_out": "2026-11-07",
                                        "guests": [{"name": "Emma Clarke"}],
                                        "guest_name": "Emma Clarke",
                                        "payment_choice": "full"}),
                        )):
                            if index < 2:
                                self.assertNotIn("payment_choice", staged)
                            else:
                                self.assertEqual(staged["payment_choice"], "full")
                            if index:
                                loop.turn(f"{case['label']}-blocked-{index}", raw)
                            blocked = loop.call("quote_booking", staged, {
                                "/availability-check": self._eligibility_receipt(staged)})
                            self.assertEqual(blocked["availability_status"], "eligibility_required")
                        loop.turn(f"{case['label']}-eligibility", turns[3])
                    else:
                        for index, raw in enumerate(turns[1:-1], start=1):
                            loop.turn(f"{case['label']}-continuation-{index}", raw)

                    quoted = loop.call("quote_booking", plan, {
                        "/availability-check": availability_receipt(beds),
                        "/booking-preview": raw_quote})
                    self.assertEqual(plan["payment_choice"], case["payment"])
                    self.assertEqual([guest["name"] for guest in plan["guests"]],
                                     list(case["names"]))
                    if case["label"] == "raj":
                        self.assertEqual(case["total"], case["deposit"])
                    self.assertEqual(quoted["total_cents"], case["total"])
                    self.assertEqual(quoted["deposit_required_cents"], case["deposit"])
                    rendered = loop.present()
                    total_text = (f"€{case['total'] // 100}" if case['total'] % 100 == 0
                                  else f"€{case['total'] / 100:.2f}")
                    self.assertRegex(rendered,
                                     rf"(?<!\d){re.escape(total_text)}(?!\d|[.,]\d)")
                    if case["payment"] == "deposit":
                        deposit_text = (f"€{case['deposit'] // 100}"
                                        if case['deposit'] % 100 == 0
                                        else f"€{case['deposit'] / 100:.2f}")
                        self.assertRegex(rendered,
                                         rf"(?<!\d){re.escape(deposit_text)}(?!\d|[.,]\d)")

                    acceptance = turns[-1]
                    if not acceptance_loaded:
                        loop.turn(f"{case['label']}-accept", acceptance)
                    interpreted = loop.call("interpret_booking_turn", {
                        "action": "accept", "action_evidence": acceptance,
                        "ambiguous": False, "negated": False, "conditional": False,
                        "material_changes": [], "completions": {}}, {})
                    self.assertTrue(interpreted["success"], interpreted)
                    facts = {"weekly_cents": case["weekly"],
                             "deposit_per_guest_cents": case["deposit"] // len(case["names"]),
                             "rooms": [{"room_code": code.split("-B", 1)[0],
                                        "gender_strategy": case["room"]}
                                       for code in case["beds"]]}
                    sql_proofs = []
                    def responses(route, body):
                        if route == "/availability-check":
                            return create_recheck_receipt(beds, body)
                        if route == "/booking-create-from-plan":
                            proof = self._run_occupants(body, scenario_facts=facts)
                            sql_proofs.append(proof)
                            return {**proof["body"], "success": proof["ok"],
                                    "write_performed": proof["ok"]}
                        if route.startswith("/payments/"):
                            return {"success": False, "intentionally_blocked": True,
                                    "reason_code": "offline_payment_link_disabled"}
                        self.fail(f"unexpected route {route}")

                    created = loop.call("create_booking_from_plan", {}, responses)
                    self.assertTrue(created["success"], created)
                    self.assertEqual([event["text"] for event in loop.trace
                                      if event["kind"] == "raw_user"], list(turns))
                    self.assertEqual(len(loop.create_dispatches), 1, loop.trace)
                    sent = loop.create_dispatches[0]
                    self.assertEqual((sent["check_in"], sent["check_out"]), case["dates"])
                    self.assertEqual(sent["selected_bed_codes"], list(case["beds"]))
                    self.assertEqual(sent["payment_choice"], case["payment"])
                    self.assertEqual([guest["name"] for guest in sent["guests"]], list(case["names"]))
                    self.assertEqual(sent["accepted_offer"]["total_cents"], case["total"])
                    self.assertEqual(sent["accepted_offer"]["deposit_required_cents"], case["deposit"])

                    # Generic alternative-input failure continuation: the same DB
                    # facts reject changed accepted money with no booking write.
                    failure_body = json.loads(json.dumps(sent))
                    failure_body["accepted_offer"]["total_cents"] += 1
                    failed = self._run_occupants(
                        failure_body, scenario_facts=facts, recompute_offer=True)
                    self.assertFalse(failed["ok"], failed)
                    self.assertEqual(sum(row["kind"] == "booking_create"
                                         for row in failed["sql_calls"]), 0)

                    # The registered owner completion above returned this real SQL
                    # receipt; it is not a handcrafted success followed by separate SQL.
                    self.assertEqual(len(sql_proofs), 1)
                    proof = sql_proofs[0]
                    self.assertTrue(proof["ok"], proof)
                    self.assertEqual(len(proof["bookings"]), 1, proof)
                    self.assertEqual([row["assigned_bed_code"] for row in proof["occupants"]],
                                     list(case["beds"]))
                    self.assertEqual(sum(row["kind"] == "booking_create"
                                         for row in proof["sql_calls"]), 1)
                    self.assertEqual(proof["network_attempts"], [])
                    self.assertEqual(len(proof["money"]["payments"]), 1, proof)
                    self.assertEqual(proof["money"]["payments"][0]["status"], "draft")
                    final_text = f"Booking {created['booking_code']} created."
                    final = owner.finalize_offer_response({"completed": True,
                        "final_response": final_text,
                        "messages": [{"role": "tool", "content": json.dumps(created)},
                                     {"role": "assistant", "content": final_text}]})
                    self.assertEqual(final["final_response"], final["messages"][-1]["content"])
                    self.assertIn(created["booking_code"], final["final_response"])
                    if case["label"] == "lucia":
                        for label, mutation, detail in (
                            ("price", {"total_cents": case["total"] + 100}, "payment_terms_changed"),
                            ("deposit", {"deposit_required_cents": case["deposit"] + 100}, "payment_terms_changed"),
                        ):
                            changed = json.loads(json.dumps(sent))
                            changed["accepted_offer"].update(mutation)
                            rejected = self._run_occupants(
                                changed, scenario_facts=facts, recompute_offer=True)
                            self.assertFalse(rejected["ok"], {"control": label, "result": rejected})
                            self.assertEqual(rejected["body"]["detail"], detail)
                        changed = json.loads(json.dumps(sent))
                        changed["accepted_offer"]["room_arrangement"][0]["gender_strategy"] = "male_only"
                        rejected = self._run_occupants(
                            changed, scenario_facts=facts, recompute_offer=True)
                        self.assertFalse(rejected["ok"], rejected)
                        self.assertEqual(rejected["body"]["detail"], "room_eligibility_changed")
                finally:
                    loop.close()

    def test_original_shape_quote_keeps_package_and_room_outcomes_distinct(self):
        original = {
            "check_in": "2026-11-18", "check_out": "2026-11-21",
            "guest_count": 2, "room_type": "shared",
            "room_preference": "male_only", "group_gender": "male",
        }
        # Owner suites intentionally reload and wrap the registered module. Run
        # this boundary in an isolated interpreter so unittest order cannot turn
        # the historical-shape witness into a test of another suite's monkeypatch.
        script = """
import json
from unittest.mock import patch
import wolfhouse_staff_api as plugin
params = json.loads(%r)
failed = json.dumps({'success': False, 'tool': 'preview_package_prices',
 'next_action': 'package_eligibility_unavailable', 'package_eligible': None,
 'staff_review_needed': True})
with patch.object(plugin, 'preview_package_prices', return_value=failed):
 print(plugin.quote_booking(params))
""" % json.dumps(original)
        env = os.environ.copy()
        plugin_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "plugins")
        env["PYTHONPATH"] = os.pathsep.join(
            [plugin_dir, env.get("PYTHONPATH", "")]).rstrip(os.pathsep)
        run = subprocess.run([sys.executable, "-c", script], cwd=os.getcwd(), env=env,
                             text=True, capture_output=True, check=True)
        result = json.loads(run.stdout)
        self.assertEqual(result["quote_status"], "needs_guest_clarification")
        self.assertTrue(result["package_choice_needed"])
        self.assertEqual(result["next_action"], "package_eligibility_unavailable")
        self.assertNotIn("unavailable", result)
        self.assertNotIn("room_eligibility", result)

    def test_validated_slot_names_preserve_spelling_accents_compounds_and_duplicates(self):
        plan = {"guests": [{"name": "lucía de la Cruz"}, {"name": "lucía de la Cruz"}]}
        offer = {
            "room_arrangement": [
                {"bed_code": "R1-B1", "room_code": "R1", "gender_strategy": "mixed"},
                {"bed_code": "R1-B2", "room_code": "R1", "gender_strategy": "mixed"},
            ],
            "guest_bed_assignments": [
                {"guest_index": 0, "guest_name": "LUCÍA DE LA CRUZ", "bed_code": "R1-B1"},
                {"guest_index": 1, "guest_name": "LUCÍA DE LA CRUZ", "bed_code": "R1-B2"},
            ],
        }
        self.assertEqual(
            ["lucía de la Cruz and lucía de la Cruz: two beds in the same mixed room."],
            owner._guest_room_lines(plan, offer, "en"),
        )

    def test_mismatched_or_stale_roster_cannot_relabel_authoritative_assignments(self):
        plan = {"guests": [{"name": "Wrong"}, {"name": "Roster"}]}
        offer = {
            "room_arrangement": [
                {"bed_code": "R1-B1", "room_code": "R1", "gender_strategy": "mixed"},
                {"bed_code": "R1-B2", "room_code": "R1", "gender_strategy": "mixed"},
            ],
            "guest_bed_assignments": [
                {"guest_index": 0, "guest_name": "Ana", "bed_code": "R1-B1"},
                {"guest_index": 1, "guest_name": "Bea", "bed_code": "R1-B2"},
            ],
        }
        rendered = "\n".join(owner._guest_room_lines(plan, offer, "en"))
        self.assertIn("Ana and Bea", rendered)
        self.assertNotIn("Wrong", rendered)
        self.assertNotIn("Roster", rendered)

    def test_single_named_room_line_is_natural_and_keeps_truth_bounded(self):
        plan = {"guests": [{"name": "Alex"}]}
        offer = {
            "room_arrangement": [
                {"bed_code": "R1-B1", "room_code": "R1", "gender_strategy": "mixed"},
            ],
            "guest_bed_assignments": [
                {"guest_index": 0, "guest_name": "Alex", "bed_code": "R1-B1"},
            ],
        }
        self.assertEqual(["one bed in a mixed room for Alex."],
                         owner._guest_room_lines(plan, offer, "en"))

    def test_preferred_strategy_remains_neutral_not_exclusive(self):
        for strategy in ("male preferred", "female_preferred"):
            offer = {"room_type": "shared"}
            room = {"gender_strategy": strategy}
            self.assertEqual("shared room", owner._room_kind(offer, room, "en"))


if __name__ == "__main__":
    unittest.main()
