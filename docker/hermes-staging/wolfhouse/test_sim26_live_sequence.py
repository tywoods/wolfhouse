"""Sim26 immutable-input and registered owner regression witnesses (offline only)."""
import json
from pathlib import Path
import subprocess
import unittest

from wolfhouse_staff_api.test_sim16_jonas_liam_fix import (
    DeterministicRegisteredLoop, availability_receipt, checked_staff_quote,
    create_recheck_receipt,
)

ROOT = Path(__file__).resolve().parents[3]
INPUTS = ROOT / "artifacts/booking-cleanup-step4-slice2/inputs"

# Literal oracle transcribed from the sealed capture.  Keeping this independent
# of the parser is intentional: loading the file and comparing it with values
# derived from that same load would only prove that JSON can be decoded.
LUCIA_RAW_TURNS = [
    "¡Hola Luna! Soy Lucía, de Sevilla 🇪🇸 Busco 1 cama en el dormitorio mixto del lunes 16 al jueves 19 de noviembre de 2026 (3 noches). Soy mujer y viajo sola. ¿Cuánto cuesta?",
    "Perfecto. Me llamo Lucía Fernández Ruiz. Prefiero pagar el depósito. ¡Sí, resérvalo!",
    "el depósito, por favor",
    "el depósito, por favor",
]
SHORT = [{"name": "Lucía", "explicit_gender": "female"}]
FULL = [{"name": "Lucía Fernández Ruiz", "explicit_gender": "female"}]
BASE = {"check_in": "2026-11-16", "check_out": "2026-11-19", "guest_count": 1,
        "room_type": "shared", "room_preference": "mixed"}
LUCIA_CAPTURED_CALLS = [
    [("check_availability", {"client_slug": None, **BASE, "guests": SHORT,
       "guest_name": "Lucía", "room_name_hints": SHORT}),
     ("package_price_preview", {k: BASE[k] for k in ("check_in", "check_out", "guest_count", "room_type")}),
     ("check_availability", {**BASE, "guests": SHORT, "room_name_hints": SHORT}),
     ("quote_booking", {**BASE, "guest_name": "Lucía", "guests": SHORT,
       "package_code": "package_none", "add_ons": [], "catalog_selections": [],
       "source": "agent_luna_whatsapp", "room_name_hints": SHORT,
       "selected_bed_codes": ["R3-B3"]})],
    [("check_availability", {**BASE, "guests": FULL, "room_name_hints": FULL}),
     ("quote_booking", {"add_ons": [], **BASE, "guests": FULL, "payment_choice": "deposit",
       "package_code": "package_none", "language": "es", "catalog_selections": [],
       "source": "agent_luna_whatsapp", "guest_name": "Lucía Fernández Ruiz",
       "room_name_hints": FULL, "selected_bed_codes": ["R3-B3"]}),
     ("create_booking_from_plan", {"add_ons": [], "catalog_selections": [], **BASE,
       "gender_preference": "female", "guests": FULL, "package_code": "package_none",
       "room_name_hints": [{"explicit_gender": "female", "name": "Lucía"}],
       "payment_choice": "deposit", "language": "es"}),
     ("quote_booking", {"add_ons": [], **BASE, "guest_name": "Lucía Fernández Ruiz",
       "guests": FULL, "package_code": "package_none", "payment_choice": "deposit",
       "guest_packages": [], "catalog_selections": [], "selected_bed_codes": ["R3-B3"],
       "language": "es", "per_guest_payment_links": False, "source": "agent_luna_whatsapp",
       "room_name_hints": FULL}),
     ("create_booking_from_plan", {"add_ons": [], "check_in": BASE["check_in"],
       "check_out": BASE["check_out"], "confirm": True, "gender_preference": "female",
       "guest_count": 1, "guest_name": "Lucía Fernández Ruiz",
       "guests": [{"explicit_gender": "female", "name": "Lucía Fernández Ruiz"}],
       "language": "es", "package_code": "package_none", "payment_choice": "deposit",
       "room_preference": "mixed", "room_type": "shared", "selected_bed_codes": ["R3-B3"]})],
    [("quote_booking", {"add_ons": [], **BASE, "guest_packages": [], "guests": FULL,
       "language": "es", "package_code": "package_none", "payment_choice": "deposit",
       "per_guest_payment_links": False, "selected_bed_codes": ["R3-B3"],
       "catalog_selections": [], "source": "agent_luna_whatsapp",
       "guest_name": "Lucía Fernández Ruiz", "room_name_hints": FULL}),
     ("create_booking_from_plan", {"add_ons": [], "catalog_selections": [], **BASE,
       "gender_preference": None, "guest_packages": [], "guests": FULL, "language": "es",
       "package_code": "package_none", "payment_choice": "deposit",
       "per_guest_payment_links": False,
       "room_name_hints": [{"explicit_gender": "female", "name": "Lucía"}],
       "selected_bed_codes": ["R3-B3"]})],
    [],
]
LUCIA_CAPTURED_RESULTS = [
    ["success=True; next_action=ready_for_bot_create", "success=False",
     "success=True; next_action=ready_for_bot_create",
     "success=True; next_action=show_quote; staff_review_needed=False"],
    ["success=True; next_action=ready_for_bot_create",
     "success=True; next_action=ready_for_create_dry_run; staff_review_needed=False",
     "success=False; next_action=clarify_or_requote; error=quote_owner_presented_offer_required; staff_review_needed=False; write_performed=False",
     "success=True; next_action=ready_for_create_dry_run; staff_review_needed=False",
     "success=False; next_action=clarify_or_requote; error=quote_owner_presented_offer_required; staff_review_needed=False; write_performed=False"],
    ["success=True; next_action=ready_for_create_dry_run; staff_review_needed=False",
     "success=False; next_action=clarify_or_requote; error=quote_owner_acceptance_required; staff_review_needed=False; write_performed=False"],
    [],
]


class Sim26LiveSequenceTests(unittest.TestCase):
    def test_lucia_capture_has_all_raw_turns_and_exact_top_level_call_arguments(self):
        rows = [json.loads(line) for line in (INPUTS / "guest1.jsonl").read_text().splitlines()]
        self.assertEqual([row["guest_text"] for row in rows], LUCIA_RAW_TURNS)
        actual = [[(call["name"], call["args"]) for call in row["resp"]["tool_calls"]]
                  for row in rows]
        self.assertEqual(actual, LUCIA_CAPTURED_CALLS)
        self.assertEqual([[call["result_summary"] for call in row["resp"]["tool_calls"]]
                          for row in rows], LUCIA_CAPTURED_RESULTS)
        self.assertEqual([[name for name, _ in calls] for calls in actual], [
            ["check_availability", "package_price_preview", "check_availability", "quote_booking"],
            ["check_availability", "quote_booking", "create_booking_from_plan",
             "quote_booking", "create_booking_from_plan"],
            ["quote_booking", "create_booking_from_plan"], []])
        package_call = rows[0]["resp"]["tool_calls"][1]
        self.assertEqual(package_call["result_summary"], "success=False")
        self.assertIsNone(actual[0][0][1]["client_slug"])
        self.assertNotIn("payment_choice", actual[0][3][1])
        self.assertNotIn("language", actual[0][3][1])
        self.assertEqual(actual[1][2][1]["gender_preference"], "female")
        self.assertIsNone(actual[2][1][1]["gender_preference"])
        for turn, index in ((1, 2), (1, 4), (2, 1)):
            self.assertTrue(actual[turn][index][1], "captured create body must remain populated")
    def test_supplied_inputs_have_approved_hashes(self):
        import hashlib
        expected = {
            "guest1.jsonl": "fac0d54d8c58a93c8bbcc58eb92c2182eeabc7fced5d203799958a5deb8685d9",
            "guest2.jsonl": "ce1d3f46eca5f4ad3ac3ec0c702addbf16b2cc4a3e4c89d07b100d0a0ab46076",
            "guest3.jsonl": "d40c72fc6f9a5038090202e403db7f0d2c1f3d88224145ebcaf5f30f958588b2",
            "guest4.jsonl": "c472a1f4503f368e3dafcba7e38d6e0f04d12471b976531f5cc1d97993c1d70e",
            "guest5.jsonl": "416e296c7e4a3c823819bcf7c47da2a77e034622e3aa46e997accb14fee8e93e",
        }
        for name, digest in expected.items():
            self.assertEqual(hashlib.sha256((INPUTS / name).read_bytes()).hexdigest(), digest)

    def test_lucia_unchanged_offer_first_populated_create_then_retry_reuses_receipt(self):
        loop = DeterministicRegisteredLoop(self, "sim26-lucia-green")
        try:
            beds = [{"bed_code": "R3-B3", "room_code": "R3", "room_type": "shared",
                     "gender_strategy": "flexible", "selected_selling_mode": "bed"}]
            short = [{"name": "Lucía", "explicit_gender": "female"}]
            full = [{"name": "Lucía Fernández Ruiz", "explicit_gender": "female"}]
            first = {"check_in": "2026-11-16", "check_out": "2026-11-19", "guest_count": 1,
                     "room_type": "shared", "room_preference": "mixed", "guests": short,
                     "room_name_hints": short, "package_code": "package_none", "add_ons": [],
                     "catalog_selections": [], "selected_bed_codes": ["R3-B3"], "language": "es"}
            completed = {**first, "guests": full, "room_name_hints": full,
                         "guest_name": full[0]["name"], "payment_choice": "deposit"}
            first_quote = checked_staff_quote(first, beds, total=12000, deposit=10000)
            final_quote = checked_staff_quote(completed, beds, total=12000, deposit=10000)
            loop.turn("turn-1", "Busco una cama del 16 al 19 de noviembre. ¿Cuánto cuesta?")
            loop.call("check_availability", first, {"/availability-check": availability_receipt(beds)})
            loop.call("quote_booking", first, {"/booking-preview": first_quote})
            loop.present()
            loop.turn("turn-2", "Me llamo Lucía Fernández Ruiz. Depósito. ¡Sí, resérvalo!")
            loop.call("check_availability", completed,
                      {"/availability-check": availability_receipt(beds)})
            loop.call("quote_booking", completed, {"/booking-preview": final_quote})
            create = {k: completed[k] for k in ("add_ons", "catalog_selections", "check_in",
                      "check_out", "guest_count", "guests", "language", "package_code",
                      "payment_choice", "room_name_hints", "room_preference", "room_type")}
            create["room_name_hints"] = short
            writes = []
            sql_proofs = []
            def staff(route, body):
                if route == "/booking-preview": return final_quote
                if route == "/availability-check": return create_recheck_receipt(beds, body)
                if route == "/booking-create-from-plan":
                    writes.append(body)
                    run = subprocess.run(
                        ["node", "scripts/verify-luna-create-booking-occupants.js", "--payload"],
                        input=json.dumps(body), text=True, capture_output=True,
                        cwd=ROOT, timeout=90)
                    self.assertEqual(run.returncode, 0, {"stdout": run.stdout, "stderr": run.stderr})
                    proof = json.loads(run.stdout); sql_proofs.append(proof)
                    self.assertTrue(proof["ok"], proof)
                    self.assertEqual(len(proof["bookings"]), 1)
                    self.assertEqual([(r["guest_name"], r["assigned_bed_code"])
                                      for r in proof["occupants"]],
                                     [("Lucía Fernández Ruiz", "R3-B3")])
                    self.assertEqual(len(proof["money"]["payments"]), 1)
                    payment = proof["money"]["payments"][0]
                    self.assertEqual((payment["amount_due_cents"], payment["currency"]),
                                     (10000, "EUR"))
                    self.assertEqual(sum(c["kind"] == "booking_create"
                                         for c in proof["sql_calls"]), 1)
                    self.assertEqual(proof["network_attempts"], [])
                    booking = proof["bookings"][0]
                    return {"success": True, "created": True, "write_performed": True,
                            "booking_id": booking["id"], "booking_code": proof["body"]["booking_code"],
                            "payment_id": payment["id"], "payment_status": "pending",
                            "amount_due_cents": payment["amount_due_cents"], "currency": payment["currency"]}
                if sql_proofs and route == f"/payments/{sql_proofs[0]['money']['payments'][0]['id']}/create-stripe-link":
                    return {"success": True, "booking_id": sql_proofs[0]["bookings"][0]["id"],
                            "booking_code": sql_proofs[0]["body"]["booking_code"],
                            "payment_id": sql_proofs[0]["money"]["payments"][0]["id"],
                            "secure_payment_url": "https://payments.invalid/sim26",
                            "amount_due_cents": 10000, "currency": "EUR", "payment_status": "pending"}
                self.fail(route)
            first_result = loop.call("create_booking_from_plan", create, staff)
            retry = loop.call("create_booking_from_plan", completed, staff)
            self.assertTrue(first_result["success"], first_result)
            self.assertTrue(retry["success"], retry)
            self.assertEqual(len(writes), 1)
            self.assertEqual(len(sql_proofs), 1)
            self.assertEqual(writes[0]["selected_bed_codes"], ["R3-B3"])
            self.assertEqual(writes[0]["guests"], full)
            self.assertEqual(final_quote["total_cents"], 12000)
            self.assertEqual(final_quote["deposit_required_cents"], 10000)
            self.assertEqual(writes[0]["payment_choice"], "deposit")
            self.assertEqual(first_result["booking_code"], retry["booking_code"])
            self.assertEqual(first_result["booking_id"], retry["booking_id"])
            self.assertEqual(first_result["payment_id"], retry["payment_id"])
        finally:
            loop.close()


if __name__ == "__main__":
    unittest.main()
