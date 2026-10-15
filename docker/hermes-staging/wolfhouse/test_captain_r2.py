"""Captain-pinned R2a/R2b regressions using the captured receipt shapes."""
from copy import deepcopy
import unittest

from wolfhouse.test_accepted_quote import OwnerHostileTests

OwnerHostileTests.__test__ = False


class CaptainR2Tests(OwnerHostileTests):
    __test__ = True
    def _receipt(self, names, beds, *, total, deposit, full_only=False):
        assignments = [{"guest_index": i, "guest_name": name, "bed_code": bed}
                       for i, (name, bed) in enumerate(zip(names, beds))]
        rooms = [{"bed_code": bed, "room_code": "R5",
                  "gender_strategy": "female preferred"} for bed in beds]
        offer = {
            "v": 1, "offer_revision_version": 1, "client_slug": "wolfhouse-somo",
            "check_in": "2026-10-16" if len(names) == 1 else "2026-11-03",
            "check_out": "2026-10-18" if len(names) == 1 else "2026-11-06",
            "guest_count": len(names), "room_type": "shared",
            "room_preference": "female_only", "package_code": "package_none",
            "currency": "EUR", "total_cents": total,
            "deposit_required_cents": deposit, "payment_choice": "deposit",
            "payment_link_amount_cents": deposit, "availability_checked": True,
            "offer_fingerprint": "captured-r2-receipt", "guest_bed_assignments": assignments,
            "room_arrangement": rooms, "guest_packages": [], "add_ons": [],
            "room_name_hints": [], "payment_distribution": [],
            "per_guest_payment_links": False,
        }
        return {
            "success": True, "total_cents": total, "deposit_required_cents": deposit,
            "currency": "EUR", "full_payment_only": full_only,
            "payment_choice_needed": not full_only, "missing_fields": ["payment_choice"],
            "offer_revision": offer,
            "availability": {"status": "checked", "availability_checked": True,
                             "selected_bed_codes": beds,
                             "guest_bed_assignments": deepcopy(assignments),
                             "room_arrangement": deepcopy(rooms)},
        }

    def _fresh(self, owner):
        self.agent.session_id = owner
        self.db.create_session(owner, source="whatsapp")

    def _accept(self, message, raw, guests, payment=None):
        self.turn(message, raw)
        completions = {"guests": [{"guest_index": i, "name": name, "evidence": name}
                                   for i, name in enumerate(guests)]}
        if payment:
            completions["payment_choice"] = {"value": payment, "evidence": payment}
        return self.ledger.interpret_owner_turn({
            "action": "accept", "action_evidence": raw, "ambiguous": False,
            "negated": False, "conditional": False, "material_changes": [],
            "completions": completions,
        })

    def test_r2a_10309_full_only_is_presentable_not_create_ready_then_revalidated(self):
        self._fresh("captain-r2a-10309")
        plan = {"check_in": "2026-10-16", "check_out": "2026-10-18", "guest_count": 1,
                "guest_name": "Nora", "guests": [{"name": "Nora"}],
                "package_code": "package_none", "room_type": "shared",
                "room_preference": "female_only", "gender_preference": "female"}
        receipt = self._receipt(["nora"], ["R5-B3"], total=8000, deposit=8000,
                                full_only=True)
        self.turn("10309", "What's the price?")
        self.ledger.record_quote(plan, receipt)
        shown = self.ledger.finalize_offer_response({"completed": True,
                                                     "final_response": "model draft"})
        self.assertIn("Full payment required: 80.00 EUR.", shown["final_response"])
        self.assertNotIn("deposit", shown["final_response"].lower())
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    "quote_owner_acceptance_required"):
            self.ledger.prepare_create({})
        raw = "oui parfait, book it for Nora Lefevre"
        accepted = self._accept("10320", raw, ["Nora Lefevre"])
        self.assertTrue(accepted["accepted"])
        self.assertFalse(accepted["create_ready"])
        prepared = self.ledger.prepare_quote({})
        self.assertEqual(prepared["payment_choice"], "full")
        checked = self._receipt(["nora lefevre"], ["R5-B3"], total=8000, deposit=8000)
        checked["payment_choice_needed"] = False
        checked["missing_fields"] = []
        checked["offer_revision"]["payment_choice"] = "full"
        self.ledger.record_quote(prepared, checked)
        created = self.ledger.prepare_create({})
        self.assertEqual(created["payment_choice"], "full")
        self.assertEqual(created["accepted_offer"]["payment_link_amount_cents"], 8000)

    def test_r2b_10345_slots_complete_atomically_and_beds_cannot_change(self):
        self._fresh("captain-r2b-10345")
        plan = {"check_in": "2026-11-03", "check_out": "2026-11-06", "guest_count": 3,
                "guest_name": "Aisha", "package_code": "package_none", "room_type": "shared",
                "room_preference": "female_only", "group_gender": "female"}
        beds = ["R5-B1", "R5-B2", "R5-B3"]
        receipt = self._receipt(["aisha", None, None], beds, total=36000, deposit=30000)
        self.turn("10345", "quote bed-only for the 3 of us")
        self.ledger.record_quote(plan, receipt)
        shown = self.ledger.finalize_offer_response({"completed": True,
                                                     "final_response": "model draft"})
        self.assertIn("3 guests", shown["final_response"])
        raw = "yes take it — Aisha Rahman, Priya Shah, Leila Hassan. deposit"
        names = ["Aisha Rahman", "Priya Shah", "Leila Hassan"]
        accepted = self._accept("10349", raw, names, "deposit")
        self.assertFalse(accepted["create_ready"])
        prepared = self.ledger.prepare_quote({})
        checked = self._receipt([name.casefold() for name in names], beds,
                                total=36000, deposit=30000)
        checked["payment_choice_needed"] = False
        checked["missing_fields"] = []
        self.ledger.record_quote(prepared, checked)
        self.assertEqual(self.ledger.prepare_create({})["selected_bed_codes"], beds)

        changed = deepcopy(checked)
        changed["offer_revision"]["guest_bed_assignments"][1]["bed_code"] = "R5-B4"
        self.assertFalse(self.ledger._completion_revision_matches(
            receipt["offer_revision"], changed["offer_revision"], payment_choice="deposit",
            guest_completions=[{"guest_index": i, "completed_name": name}
                               for i, name in enumerate(names)]))

    def test_r2b_rejects_partial_or_duplicate_anonymous_slot_mapping(self):
        self._fresh("captain-r2b-controls")
        plan = {"check_in": "2026-11-03", "check_out": "2026-11-06", "guest_count": 3,
                "guest_name": "Aisha", "package_code": "package_none", "room_type": "shared",
                "room_preference": "female_only"}
        receipt = self._receipt(["aisha", None, None], ["R5-B1", "R5-B2", "R5-B3"],
                                total=36000, deposit=30000)
        self.turn("r2b-control-offer", "quote")
        self.ledger.record_quote(plan, receipt)
        self.ledger.finalize_offer_response({"completed": True, "final_response": "draft"})
        raw = "book Aisha Rahman and Priya Shah, deposit"
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    "quote_completion_identity_changed"):
            self._accept("r2b-partial", raw, ["Aisha Rahman", "Priya Shah"], "deposit")


if __name__ == "__main__":
    unittest.main()