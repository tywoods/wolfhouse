"""Booking cleanup Step 2 focused structured clarification and display proofs.

The Staff responses here are synthetic, offline boundary fixtures.  They preserve the
captured Becker argument shape; they are not represented as the unavailable live
response body or as proof of its historical cause.
"""
import json
import os
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
    def _run_occupants(body, *, sim23_fixture=False, recompute_offer=False):
        script = """
const fs = require('node:fs');
const h = require('./scripts/verify-luna-create-booking-occupants');
const body = JSON.parse(fs.readFileSync(0, 'utf8'));
if (%s) {
  const offers = require('./scripts/lib/luna-front-desk-accommodation-availability-service');
  body.accepted_offer = offers.buildWolfhouseOfferRevision(body.accepted_offer);
}
const options = %s ? {sim23Fixture: h.createSim23Fixture(body)} : {};
h.runPayload(body, options).then(result => process.stdout.write(JSON.stringify(result)));
""" % ("true" if recompute_offer else "false", "true" if sim23_fixture else "false")
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
            "fr": "Emma peut-elle séjourner dans la chambre demandée réservée aux femmes ?",
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

    def test_sim23_five_capture_outcomes_registered_render_create_and_sql(self):
        """Each immutable Sim23 outcome crosses registered quote/create and PGlite."""
        cases = (
            {"label": "lucia", "dates": ("2026-11-04", "2026-11-07"),
             "names": ("Lucía",), "beds": ("R3-B1",), "payment": "deposit",
             "total": 12000, "deposit": 10000, "room": "mixed", "preference": "mixed"},
            {"label": "french-group", "dates": ("2026-11-04", "2026-11-07"),
             "names": ("Camille Laurent", "Hugo Laurent"),
             "beds": ("R3-B1", "R3-B2"), "payment": "full",
             "total": 24000, "deposit": 24000, "room": "mixed", "preference": "mixed",
             "language": "fr"},
            {"label": "becker", "dates": ("2026-11-11", "2026-11-14"),
             "names": ("Jonas Becker", "Felix Becker"),
             "beds": ("R4-B1", "R4-B2"), "payment": "deposit",
             "total": 24000, "deposit": 20000, "room": "male preferred",
             "preference": "male_only", "language": "de", "gender": "male"},
            {"label": "emma", "dates": ("2026-11-04", "2026-11-07"),
             "names": ("Emma Clarke",), "beds": ("R5-B1",), "payment": "full",
             "total": 12000, "deposit": 12000, "room": "female preferred",
             "preference": "female_only", "gender": "female"},
            {"label": "raj", "dates": ("2026-11-20", "2026-11-22"),
             "names": ("Raj Patel",), "beds": ("R1-B4",), "payment": "full",
             "total": 8000, "deposit": 8000, "room": "Flexible",
             "preference": "room 1", "gender": "male"},
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
                    guests = [{"name": name, **({"explicit_gender": case["gender"]}
                               if case.get("gender") else {})} for name in case["names"]]
                    plan = {"check_in": case["dates"][0], "check_out": case["dates"][1],
                            "guest_count": len(guests), "room_type": "shared",
                            "room_preference": case["preference"],
                            "package_code": "package_none", "payment_choice": case["payment"],
                            "language": case.get("language", "en"), "guests": guests,
                            "guest_name": guests[0]["name"],
                            "selected_bed_codes": list(case["beds"])}
                    if case.get("gender"):
                        plan["group_gender"] = case["gender"]
                    raw_quote = checked_staff_quote(
                        plan, beds, total=case["total"], deposit=case["deposit"],
                        full_payment_only=(case["payment"] == "full"))
                    loop.turn(f"{case['label']}-quote", "Quote this exact captured stay")
                    quoted = loop.call("quote_booking", plan, {
                        "/availability-check": availability_receipt(beds),
                        "/booking-preview": raw_quote})
                    self.assertEqual(quoted["total_cents"], case["total"])
                    self.assertEqual(quoted["deposit_required_cents"], case["deposit"])
                    rendered = loop.present()
                    self.assertIn(f"{case['total'] / 100:.2f} EUR", rendered)
                    if case["payment"] == "deposit":
                        self.assertIn(f"{case['deposit'] / 100:.2f} EUR", rendered)

                    acceptance = "Yes, create that exact displayed offer."
                    loop.turn(f"{case['label']}-accept", acceptance)
                    interpreted = loop.call("interpret_booking_turn", {
                        "action": "accept", "action_evidence": acceptance,
                        "ambiguous": False, "negated": False, "conditional": False,
                        "material_changes": [], "completions": {}}, {})
                    self.assertTrue(interpreted["success"], interpreted)
                    def responses(route, body):
                        if route == "/availability-check":
                            return create_recheck_receipt(beds, body)
                        if route == "/booking-create-from-plan":
                            return {"success": True, "created": True, "write_performed": True,
                                    "booking_id": f"sim23-{case['label']}-one"}
                        self.fail(f"unexpected route {route}")
                    created = loop.call("create_booking_from_plan", {}, responses)
                    self.assertTrue(created["success"], created)
                    self.assertEqual(len(loop.create_dispatches), 1, loop.trace)
                    sent = loop.create_dispatches[0]
                    self.assertEqual((sent["check_in"], sent["check_out"]), case["dates"])
                    self.assertEqual(sent["selected_bed_codes"], list(case["beds"]))
                    self.assertEqual(sent["payment_choice"], case["payment"])
                    self.assertEqual([guest["name"] for guest in sent["guests"]], list(case["names"]))
                    self.assertEqual(sent["accepted_offer"]["total_cents"], case["total"])
                    self.assertEqual(sent["accepted_offer"]["deposit_required_cents"], case["deposit"])

                    # Default behavior remains fail-closed. Lucía's capture-derived room label
                    # differs from committed inventory; Raj's matching-room offer isolates price.
                    if case["label"] == "lucia":
                        rejected = self._run_occupants(sent)
                        self.assertFalse(rejected["ok"], rejected)
                        self.assertEqual(rejected["body"]["detail"],
                                         "room_eligibility_changed")
                        self.assertEqual(sum(row["kind"] == "booking_create"
                                             for row in rejected["sql_calls"]), 0)
                    if case["label"] == "raj":
                        changed_price = json.loads(json.dumps(sent))
                        changed_price["accepted_offer"]["total_cents"] += 1
                        rejected = self._run_occupants(changed_price, recompute_offer=True)
                        self.assertFalse(rejected["ok"], rejected)
                        self.assertEqual(rejected["body"]["detail"],
                                         "payment_terms_changed")
                        self.assertEqual(sum(row["kind"] == "booking_create"
                                             for row in rejected["sql_calls"]), 0)

                    # Send the exact registered request, including accepted_offer, through the
                    # ordinary builder/executor in one isolated PGlite operation. The opaque
                    # in-process fixture capability aligns only this test DB's room/price rows.
                    proof = self._run_occupants(sent, sim23_fixture=True)
                    self.assertTrue(proof["ok"], proof)
                    self.assertEqual(len(proof["bookings"]), 1, proof)
                    self.assertEqual([row["assigned_bed_code"] for row in proof["occupants"]],
                                     list(case["beds"]))
                    self.assertEqual(sum(row["kind"] == "booking_create"
                                         for row in proof["sql_calls"]), 1)
                    self.assertEqual(proof["network_attempts"], [])
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
        self.assertEqual(["Alex: one bed in a mixed room."],
                         owner._guest_room_lines(plan, offer, "en"))

    def test_preferred_strategy_remains_neutral_not_exclusive(self):
        for strategy in ("male preferred", "female_preferred"):
            offer = {"room_type": "shared"}
            room = {"gender_strategy": strategy}
            self.assertEqual("shared room", owner._room_kind(offer, room, "en"))


if __name__ == "__main__":
    unittest.main()
