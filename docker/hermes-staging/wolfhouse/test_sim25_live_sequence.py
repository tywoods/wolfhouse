"""Offline Sim25 sequence witnesses derived from the supplied masked captures."""
import json
from pathlib import Path
import re
import subprocess
import unittest

from wolfhouse import accepted_quote as owner

from wolfhouse_staff_api.test_sim16_jonas_liam_fix import (
    DeterministicRegisteredLoop, availability_receipt, checked_staff_quote,
    create_recheck_receipt,
)

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "fixtures/booking-cleanup-step4/slice1-cases.json"


class Sim25LiveSequenceTests(unittest.TestCase):
    def test_lucia_exact_captured_owner_chronology_is_executable_and_distinct(self):
        """Execute the captured owner boundary: failed create, re-quote, then retry."""
        fixture = json.loads(FIXTURE.read_text())["lucia"]
        loop = DeterministicRegisteredLoop(self, "sim25-lucia-captured")
        try:
            beds = [{"bed_code": fixture["bed"], "room_code": "R3", "room_type": "shared",
                     "gender_strategy": "mixed", "selected_selling_mode": "bed"}]
            short = [{"name": fixture["short_name"], "explicit_gender": "female"}]
            full = [{"name": fixture["completed_name"], "explicit_gender": "female"}]
            plan = {"check_in": fixture["dates"][0], "check_out": fixture["dates"][1],
                    "guest_count": 1, "room_type": "shared", "room_preference": fixture["room"],
                    "guests": full, "room_name_hints": short, "package_code": "package_none",
                    "add_ons": [], "catalog_selections": [], "selected_bed_codes": [fixture["bed"]],
                    "payment_choice": fixture["payment_choice"], "language": "es"}
            quote = checked_staff_quote(plan, beds, total=fixture["total_cents"],
                                        deposit=fixture["deposit_cents"])
            available = availability_receipt(beds)
            loop.turn("turn-1", fixture["raw_turns"][0])
            loop.call("check_availability", {**plan, "guests": short}, {"/availability-check": available})
            loop.call("check_availability", {**plan, "guests": short}, {"/availability-check": available})
            loop.call("quote_booking", {**plan, "guests": short}, {"/booking-preview": quote})
            loop.present()
            loop.turn("turn-2", fixture["raw_turns"][1])
            loop.call("check_availability", plan, {"/availability-check": available})
            loop.call("quote_booking", plan, {"/booking-preview": quote})
            first = loop.call("create_booking_from_plan", plan, {})
            self.assertFalse(first["success"], first)
            self.assertEqual(loop.create_dispatches, [])
            loop.turn("turn-3", fixture["raw_turns"][2])
            loop.call("quote_booking", plan, {"/booking-preview": quote})
            second = loop.call("create_booking_from_plan", {}, {})
            loop.turn("turn-4", fixture["raw_turns"][3])
            third = loop.call("create_booking_from_plan", {}, {})
            self.assertFalse(second["success"], second)
            self.assertFalse(third["success"], third)
            self.assertEqual(loop.create_dispatches, [])
            executable = [row["tool"] for row in loop.trace if row["kind"] == "tool_call"]
            self.assertEqual(executable, [tool for tool in fixture["captured_tool_order"]
                                          if tool != "package_price_preview"])
            self.assertNotEqual(executable, [tool for tool in fixture["candidate_first_valid_yes_order"]
                                             if tool != "package_price_preview"])
        finally:
            loop.close()

    def test_lucia_isolation_dimensions_execute_independently_and_together(self):
        fixture = json.loads(FIXTURE.read_text())["lucia"]
        names = [name for name in fixture["cause_isolation_dimensions"]
                 if name != "independent_and_combined"]
        cases = [(name, {name}) for name in names] + [("all_together", set(names))]
        for label, enabled in cases:
            with self.subTest(dimension=label):
                loop = DeterministicRegisteredLoop(self, "lucia-isolation-" + label)
                try:
                    beds = [{"bed_code": "R3-B3", "room_code": "R3", "room_type": "shared",
                             "gender_strategy": "mixed", "selected_selling_mode": "bed"}]
                    full = [{"name": fixture["completed_name"], "explicit_gender": "female"}]
                    short = [{"name": fixture["short_name"], "explicit_gender": "female"}]
                    plan = {"check_in": fixture["dates"][0], "check_out": fixture["dates"][1],
                            "guest_count": 1, "room_type": "shared", "room_preference": "mixed",
                            "guests": full,
                            "room_name_hints": short if "stale_short_name_hint" in enabled else full,
                            "package_code": "package_none", "payment_choice": "deposit",
                            "selected_bed_codes": ["R3-B3"], "language": "es"}
                    quote = checked_staff_quote(plan, beds, total=12000, deposit=10000)
                    loop.turn("offer", fixture["raw_turns"][0])
                    loop.call("quote_booking", plan, {"/booking-preview": quote}); loop.present()
                    loop.turn("yes", fixture["raw_turns"][1])
                    if "interpret_booking_turn_absent" not in enabled:
                        loop.interpret("accept", fixture["raw_turns"][1])
                    if "interposed_availability" in enabled:
                        loop.call("check_availability", plan,
                                  {"/availability-check": availability_receipt(beds)})
                    if "fact_equivalent_requote" in enabled:
                        loop.call("quote_booking", plan, {"/booking-preview": quote})
                    sent = plan if "populated_create" in enabled else {}
                    creates = []
                    def responses(route, body):
                        if route == "/booking-preview": return quote
                        if route == "/availability-check": return create_recheck_receipt(beds, body)
                        if route == "/booking-create-from-plan":
                            creates.append(body)
                            return {"success": True, "created": True, "write_performed": True,
                                    "booking_id": "booking", "booking_code": "WH-ISO",
                                    "payment_id": "payment", "payment_status": "pending"}
                        if route == "/payments/payment/create-stripe-link":
                            return {"success": False, "error": "payment_link_timeout"}
                        self.fail(route)
                    result = loop.call("create_booking_from_plan", sent, responses)
                    if label == "all_together":
                        self.assertFalse(result["success"], result)
                        self.assertEqual(result["error"], "quote_owner_presented_offer_required")
                        self.assertEqual(creates, [])
                    else:
                        self.assertTrue(result["success"], result)
                        self.assertEqual(len(creates), 1)
                        self.assertEqual(creates[0]["guests"], full)
                        self.assertEqual(creates[0]["selected_bed_codes"], ["R3-B3"])
                finally:
                    loop.close()

    def test_lucia_captured_order_first_valid_yes_needs_no_interpreter(self):
        """Replay the captured registered argument shapes, including both create forms."""
        loop = DeterministicRegisteredLoop(self, "sim25-lucia")
        try:
            beds = [{"bed_code": "R3-B3", "room_code": "R3", "room_type": "shared",
                     "gender_strategy": "mixed", "selected_selling_mode": "bed"}]
            available = availability_receipt(beds)
            short = [{"name": "Lucía", "explicit_gender": "female"}]
            full = [{"name": "Lucía Fernández Ruiz", "explicit_gender": "female"}]
            first = {"check_in": "2026-11-16", "check_out": "2026-11-19",
                     "guest_count": 1, "room_type": "shared", "room_preference": "mixed",
                     "guests": short, "guest_name": "Lucía", "room_name_hints": short,
                     "package_code": "package_none", "add_ons": [],
                     "catalog_selections": [], "selected_bed_codes": ["R3-B3"],
                     "source": "agent_luna_whatsapp"}
            first_quote = checked_staff_quote(first, beds, total=12000, deposit=10000)
            loop.turn("lucia-1", "¡Hola Luna! Soy Lucía. Busco 1 cama del 16 al 19 de noviembre. ¿Cuánto cuesta?")
            loop.call("check_availability", {key: first[key] for key in (
                "check_in", "check_out", "guest_count", "room_type", "room_preference",
                "guests", "guest_name", "room_name_hints")}, {"/availability-check": available})
            loop.call("check_availability", {key: first[key] for key in (
                "check_in", "check_out", "guest_count", "room_type", "room_preference",
                "guests", "room_name_hints")}, {"/availability-check": available})
            loop.call("quote_booking", first, {"/booking-preview": first_quote})
            shown = loop.present()
            exact_total = re.compile(r"(?<!\d)€120(?!\d|[.,]\d)")
            self.assertEqual(exact_total.findall(shown), ["€120"], shown)
            for adjacent in ("€1200", "€120.99", "€120.00", "1€120", "€1201"):
                self.assertIsNone(exact_total.search(adjacent), adjacent)
            self.assertNotIn("Lucía:", shown)
            self.assertNotIn("check for this booking", shown)

            accepted = {**first, "guests": full, "guest_name": full[0]["name"],
                        "room_name_hints": full, "payment_choice": "deposit",
                        "language": "es"}
            second_quote = checked_staff_quote(accepted, beds, total=12000, deposit=10000)
            raw = "Perfecto. Me llamo Lucía Fernández Ruiz. Prefiero pagar el depósito. ¡Sí, resérvalo!"
            loop.turn("lucia-2", raw)
            loop.call("check_availability", {key: accepted[key] for key in (
                "check_in", "check_out", "guest_count", "room_type", "room_preference",
                "guests", "room_name_hints")}, {"/availability-check": available})
            loop.call("quote_booking", accepted, {"/booking-preview": second_quote})

            create_args = {key: accepted[key] for key in (
                "add_ons", "catalog_selections", "check_in", "check_out", "guest_count",
                "guests", "language", "package_code", "payment_choice", "room_name_hints",
                "room_preference", "room_type")}
            # Captured stale display metadata is same-slot only and cannot rename the occupant.
            create_args["room_name_hints"] = short
            dispatched = []
            def responses(route, body):
                if route == "/booking-preview":
                    return second_quote
                if route == "/availability-check":
                    return create_recheck_receipt(beds, body)
                if route == "/booking-create-from-plan":
                    dispatched.append(body)
                    return {"success": True, "created": True, "write_performed": True,
                            "booking_id": "booking-lucia", "booking_code": "WH-LUCIA",
                            "payment_id": "payment-lucia", "payment_status": "pending"}
                if route == "/payments/payment-lucia/create-stripe-link":
                    return {"success": True, "booking_id": "booking-lucia",
                            "booking_code": "WH-LUCIA", "payment_id": "payment-lucia",
                            "secure_payment_url": "https://payments.invalid/lucia",
                            "amount_due_cents": 10000, "currency": "EUR",
                            "payment_status": "pending"}
                self.fail(route)
            created = loop.call("create_booking_from_plan", create_args, responses)
            self.assertTrue(created["success"], created)
            self.assertEqual(len(dispatched), 1)
            self.assertEqual(dispatched[0]["guests"], full)
            self.assertEqual(dispatched[0]["selected_bed_codes"], ["R3-B3"])
            self.assertEqual([row["tool"] for row in loop.trace if row["kind"] == "tool_call"], [
                "check_availability", "check_availability", "quote_booking",
                "check_availability", "quote_booking", "create_booking_from_plan"])
        finally:
            loop.close()

    def test_supplied_sim23_and_sim25_cases_execute_registered_boundaries(self):
        fixture = json.loads(FIXTURE.read_text())
        self.assertEqual(len(fixture["executable_source_cases"]), 9)
        for case in fixture["executable_source_cases"]:
            with self.subTest(case=case["id"]):
                loop = DeterministicRegisteredLoop(self, case["id"].replace("/", "-"))
                try:
                    names = case["names"]
                    strategy = ("female_only" if case["room"] == "female_only" else
                                "male_only" if case["room"] == "male_only" else "flexible")
                    beds = [{"bed_code": code, "room_code": code.split("-")[0],
                             "room_type": "shared", "gender_strategy": strategy,
                             "selected_selling_mode": "bed"} for code in case["beds"]]
                    guests = [{"name": name} for name in names]
                    plan = {"check_in": case["dates"][0], "check_out": case["dates"][1],
                            "guest_count": len(names), "room_type": "shared",
                            "room_preference": case["room"], "package_code": "package_none",
                            "payment_choice": case["payment"], "selected_bed_codes": case["beds"],
                            "guests": guests, "language": case["language"]}
                    nights = (__import__("datetime").date.fromisoformat(case["dates"][1]) -
                              __import__("datetime").date.fromisoformat(case["dates"][0])).days
                    total = 4000 * nights * len(names)
                    deposit = total if case["payment"] == "full" else min(total, 10000 * len(names))
                    quote = checked_staff_quote(plan, beds, total=total, deposit=deposit)
                    loop.turn("offer", "source-captured request")
                    loop.call("quote_booking", plan, {"/booking-preview": quote})
                    loop.present()
                    loop.turn("accept", "source-captured acceptance")
                    dispatched = []
                    def responses(route, body):
                        if route == "/booking-preview": return quote
                        if route == "/availability-check": return create_recheck_receipt(beds, body)
                        if route == "/booking-create-from-plan":
                            dispatched.append(body)
                            return {"success": True, "created": True, "write_performed": True,
                                    "booking_id": "id-" + case["id"], "booking_code": "WH-SOURCE",
                                    "payment_id": "pay-source", "payment_status": "pending"}
                        if "/create-stripe-link" in route:
                            return {"success": True, "booking_code": "WH-SOURCE",
                                    "payment_id": "pay-source", "secure_payment_url": "https://payments.invalid/source",
                                    "amount_due_cents": deposit, "currency": "EUR", "payment_status": "pending"}
                        self.fail(route)
                    result = loop.call("create_booking_from_plan", {}, responses)
                    self.assertTrue(result["success"], result)
                    self.assertEqual(len(dispatched), 1)
                    self.assertEqual([row["name"] for row in dispatched[0]["guests"]], names)
                    self.assertEqual(dispatched[0]["selected_bed_codes"], case["beds"])
                finally:
                    loop.close()
        self.assertEqual(fixture["availability_only_cases"], ["sim23/guest9", "sim25/guest9"])
        for case_id in fixture["availability_only_cases"]:
            loop = DeterministicRegisteredLoop(self, case_id.replace("/", "-"))
            try:
                loop.turn("availability", "availability only, not booking")
                loop.call("check_availability", {"check_in": "2026-11-06", "check_out": "2026-11-08",
                    "guest_count": 1, "room_type": "shared", "room_preference": "mixed"},
                    {"/availability-check": availability_receipt([{"bed_code":"R1-B1","room_code":"R1",
                     "room_type":"shared","gender_strategy":"flexible","selected_selling_mode":"bed"}])})
                self.assertEqual(loop.create_dispatches, [])
            finally:
                loop.close()

    def test_committed_provenance_hashes_all_supplied_sim23_24_25_sources(self):
        fixture = json.loads(FIXTURE.read_text())
        self.assertEqual({key: len(value) for key, value in fixture["source_matrix"].items()},
                         {"sim23": 8, "sim24": 1, "sim25": 6})
        self.assertTrue(all(len(digest) == 64
            for supplied in fixture["source_matrix"].values()
            for digest in supplied.values()))
        unavailable = fixture["legacy_not_replayable"]
        self.assertEqual((unavailable["count"], unavailable["status"], unavailable["claim"]),
            (25, "unavailable_Captain_approved_nonblocking", "not passes"))
        self.assertEqual(len(unavailable["cases"]), 25)
        self.assertTrue(all(case_id and reason for case_id, reason in unavailable["cases"]))
        self.assertIn("expected_cases.json", unavailable["partial_evidence"])

    def test_exact_raw_baseline_and_cause_isolation_matrix_are_retained(self):
        fixture = json.loads(FIXTURE.read_text())
        lucia = fixture["lucia"]
        self.assertEqual(lucia["raw_turns"][1],
            "Perfecto. Me llamo Lucía Fernández Ruiz. Prefiero pagar el depósito. ¡Sí, resérvalo!")
        self.assertEqual(lucia["raw_turns"][2:], ["el depósito, por favor"] * 4)
        self.assertEqual(lucia["captured_tool_order"], [
            "check_availability", "package_price_preview", "check_availability", "quote_booking",
            "check_availability", "quote_booking", "create_booking_from_plan",
            "quote_booking", "create_booking_from_plan", "create_booking_from_plan"])
        self.assertIn("re-quote occurred between the two turn-2 create attempts",
                      lucia["chronology_note"])
        self.assertEqual(set(lucia["cause_isolation_dimensions"]), {
            "interpret_booking_turn_absent", "interposed_availability", "fact_equivalent_requote",
            "populated_create", "empty_create", "stale_short_name_hint", "corrected_roster",
            "independent_and_combined"})

    def test_material_changes_refusal_reset_unrelated_yes_and_foreign_scope_never_dispatch(self):
        beds = [{"bed_code": "R3-B3", "room_code": "R3", "room_type": "shared",
                 "gender_strategy": "mixed", "selected_selling_mode": "bed"}]
        plan = {"check_in": "2026-11-16", "check_out": "2026-11-19", "guest_count": 1,
                "room_type": "shared", "room_preference": "mixed", "package_code": "package_none",
                "payment_choice": "deposit", "selected_bed_codes": ["R3-B3"],
                "guests": [{"name": "Lucía Fernández Ruiz", "explicit_gender": "female"}]}
        dimensions = {
            "dates": {"check_out": "2026-11-20"}, "room": {"room_preference": "female_only"},
            "bed": {"selected_bed_codes": ["R3-B4"]}, "services": {"add_ons": [{"code": "surf"}]},
            "payment_terms": {"payment_choice": "full"}, "count": {"guest_count": 2},
            "occupant": {"guests": [{"name": "Otra Persona", "explicit_gender": "female"}]},
        }
        for label, change in dimensions.items():
            with self.subTest(label=label):
                loop = DeterministicRegisteredLoop(self, "negative-" + label)
                try:
                    quote = checked_staff_quote(plan, beds, total=12000, deposit=10000)
                    loop.turn("offer", "muéstrame la oferta")
                    loop.call("quote_booking", plan, {"/booking-preview": quote})
                    loop.present()
                    loop.turn("change", "sí, pero con un cambio")
                    result = loop.call("create_booking_from_plan", {**plan, **change}, {})
                    self.assertFalse(result["success"], result)
                    self.assertEqual(loop.create_dispatches, [])
                finally:
                    loop.close()

        for action, raw in (("reject", "No, no reserves"), ("clarify", "Sí, me gusta el precio del bar")):
            loop = DeterministicRegisteredLoop(self, "intent-" + action)
            try:
                quote = checked_staff_quote(plan, beds, total=12000, deposit=10000)
                loop.turn("offer", "oferta")
                loop.call("quote_booking", plan, {"/booking-preview": quote})
                loop.present(); loop.turn("answer", raw)
                loop.interpret(action, raw)
                state = owner._transaction(lambda current, _ingress: dict(current))
                self.assertNotEqual(state.get("status"), "accepted", state)
                self.assertEqual(loop.create_dispatches, [])
            finally:
                loop.close()

        reset = DeterministicRegisteredLoop(self, "reset-negative")
        try:
            quote = checked_staff_quote(plan, beds, total=12000, deposit=10000)
            reset.turn("offer", "oferta"); reset.call("quote_booking", plan, {"/booking-preview": quote}); reset.present()
            reset.db.end_session(reset.agent.session_id, "reset")
            with self.assertRaises(owner.QuoteBoundaryError):
                owner.prepare_create({})
            self.assertEqual(reset.create_dispatches, [])
        finally:
            reset.close()

        foreign = DeterministicRegisteredLoop(self, "foreign-session")
        try:
            foreign.turn("yes", "sí")
            with self.assertRaises(owner.QuoteBoundaryError):
                owner.prepare_create({})
            self.assertEqual(foreign.create_dispatches, [])
        finally:
            foreign.close()

    def test_registered_lucia_boundary_executes_real_pglite_and_asserts_rows(self):
        loop = DeterministicRegisteredLoop(self, "lucia-real-sql")
        try:
            beds = [{"bed_code": "R3-B3", "room_code": "R3", "room_type": "shared",
                     "gender_strategy": "flexible", "selected_selling_mode": "bed"}]
            guests = [{"name": "Lucía Fernández Ruiz", "explicit_gender": "female"}]
            plan = {"check_in": "2026-11-16", "check_out": "2026-11-19", "guest_count": 1,
                    "room_type": "shared", "room_preference": "mixed", "group_gender": "mixed",
                    "package_code": "package_none",
                    "payment_choice": "deposit", "selected_bed_codes": ["R3-B3"], "guests": guests,
                    "language": "es"}
            quote = checked_staff_quote(plan, beds, total=12000, deposit=10000)
            loop.turn("offer", "¿Cuánto cuesta?"); loop.call("quote_booking", plan, {"/booking-preview": quote})
            shown = loop.present()
            self.assertIn("Total: €120 (depósito: €100).", shown)
            self.assertIn("Depósito: €100.", shown)
            self.assertIn("A pagar a la llegada: €20.", shown)
            self.assertNotIn("Lucía Fernández Ruiz:", shown)
            loop.turn("yes", "Perfecto. Me llamo Lucía Fernández Ruiz. Prefiero pagar el depósito. ¡Sí, resérvalo!")
            proof = []
            def responses(route, body):
                if route == "/booking-preview": return quote
                if route == "/availability-check": return create_recheck_receipt(beds, body)
                if route == "/booking-create-from-plan":
                    run = subprocess.run(["node", "scripts/verify-luna-create-booking-occupants.js", "--payload"],
                        input=json.dumps(body), text=True, capture_output=True, cwd=ROOT, timeout=90)
                    self.assertEqual(run.returncode, 0, {"stdout": run.stdout, "stderr": run.stderr})
                    row = json.loads(run.stdout); proof.append(row)
                    self.assertEqual(len(row["bookings"]), 1)
                    self.assertEqual([(r["guest_name"], r["assigned_bed_code"]) for r in row["occupants"]],
                                     [("Lucía Fernández Ruiz", "R3-B3")])
                    self.assertEqual(len(row["money"]["payments"]), 1)
                    payment = row["money"]["payments"][0]
                    self.assertEqual((payment["amount_due_cents"], payment["currency"]), (10000, "EUR"))
                    booking = row["bookings"][0]
                    return {"success": True, "created": True, "write_performed": True,
                            "booking_id": booking["id"], "booking_code": row["body"]["booking_code"],
                            "payment_id": payment["id"], "payment_status": "pending"}
                if "/create-stripe-link" in route:
                    return {"success": True, "booking_id": proof[0]["bookings"][0]["id"],
                            "booking_code": proof[0]["body"]["booking_code"],
                            "payment_id": proof[0]["money"]["payments"][0]["id"],
                            "secure_payment_url": "https://payments.invalid/lucia",
                            "amount_due_cents": 10000, "currency": "EUR", "payment_status": "pending"}
                self.fail(route)
            result = loop.call("create_booking_from_plan", {}, responses)
            self.assertTrue(result["success"], result)
            self.assertEqual(result["payment_status"], "pending")
            self.assertFalse(result["payment_link_created"], "isolated SQL keeps Stripe disabled")
            self.assertNotIn("paid", json.dumps(result).lower())
            self.assertEqual(len(proof), 1)
        finally:
            loop.close()


if __name__ == "__main__":
    unittest.main()
