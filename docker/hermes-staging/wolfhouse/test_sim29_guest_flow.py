"""Sim29 immutable-capture flow controls for the registered Wolfhouse owner.

The JSONL files are historical inputs. Staff responses and the continuation after an
already-presented offer are explicitly constructed offline because those bodies/state
were not captured. No assertion below claims that scripted replay proves model choice.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import sys
import unittest

from wolfhouse import accepted_quote as owner
from wolfhouse_staff_api.test_sim16_jonas_liam_fix import (
    DeterministicRegisteredLoop,
    availability_receipt,
    checked_staff_quote,
    create_recheck_receipt,
)


_EXPECTED_SIM29_GUEST_SHA256 = {
    "guest1.jsonl": "0e103a8e7202a08ea2307042400b9deb0d8f794a77d207c2ff56bc4165a9b0cf",
    "guest2.jsonl": "5259a8c2472c0352ed3292a6cd7b24f8cc1d31d347ba54c731f20742fbabc34e",
    "guest3.jsonl": "10cdc3db4777a24f6b1e71848fcf1176427d61b52ef3ce7e3d628d4033911021",
    "guest4.jsonl": "a101a18b0ff7a2f195119698b08f91394d84f4e4eb8087174c9bbed667961257",
    "guest5.jsonl": "e329258bb1c8b04aefca9dc831017f340c0a417181b1cde0a63f342d9c6072e9",
}


def _required_input_dir(name: str) -> Path:
    raw = os.environ.get(name)
    if not raw:
        raise AssertionError(f"{name} is required; historical inputs must not be skipped")
    path = Path(raw).resolve()
    if not path.is_dir():
        raise AssertionError(f"{name} is not a directory: {path}")
    return path


def _rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _tool_args(row: dict, name: str, occurrence: int = 0) -> dict:
    matches = [call["args"] for call in row["resp"]["tool_calls"] if call["name"] == name]
    return deepcopy(matches[occurrence])


class Sim29GuestFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Both variables are required by the round even though this focused module
        # uses Sim29 chronology; requiring both prevents accidental partial packets.
        cls.sim28 = _required_input_dir("SIM28_INPUT_DIR")
        cls.sim29 = _required_input_dir("SIM29_INPUT_DIR")
        cls.captures = {}
        for filename, expected in _EXPECTED_SIM29_GUEST_SHA256.items():
            path = cls.sim29 / filename
            if not path.is_file():
                raise AssertionError(f"missing historical input: {path}")
            actual = hashlib.sha256(path.read_bytes()).hexdigest()
            if actual != expected:
                raise AssertionError(f"historical input changed: {filename}: {actual}")
            cls.captures[filename] = _rows(path)
        if sorted(cls.captures) != [f"guest{i}.jsonl" for i in range(1, 6)]:
            raise AssertionError("all five Sim29 journeys are required")

    def setUp(self):
        self.loop = None

    def tearDown(self):
        if self.loop is not None:
            self.loop.close()
        # The shared deterministic harness closes (revokes) its owner capability
        # but deliberately leaves the closed ContextVar value in place. This
        # combined required suite continues with unbound plugin tests, so clear
        # that test-only residue instead of making later modules see a stale,
        # closed owner turn.
        owner._current.set(None)
        # install_owner_hook imports this module, and the plugin's compatibility
        # boundary treats its mere presence in sys.modules as an active owner
        # runtime. Remove that harness-only import so the following legacy
        # unbound plugin modules run with the same conditions as on pinned base.
        sys.modules.pop("agent.conversation_loop", None)

    @staticmethod
    def _beds(count: int, room_type: str, room: str) -> list[dict]:
        return [
            {"bed_code": f"{room}-B{i}", "room_code": room,
             "room_type": room_type, "gender_strategy": room_type,
             "selected_selling_mode": "bed"}
            for i in range(1, count + 1)
        ]

    def test_original_chronology_and_complete_tool_arguments_remain_available(self):
        expected_turn_counts = [2, 3, 3, 5, 2]
        self.assertEqual(
            [len(self.captures[f"guest{i}.jsonl"]) for i in range(1, 6)],
            expected_turn_counts,
        )
        self.assertEqual(
            self.captures["guest2.jsonl"][1]["guest_text"],
            "Super ! Nos noms : Camille Martin, Léa Dubois et Hugo Bernard. On paie tout d'un coup, paiement complet s'il vous plaît. Oui, réservez !",
        )
        self.assertEqual(
            self.captures["guest4.jsonl"][2]["guest_text"],
            "Perfect, thanks! Emma Clarke, full payment please. Yes, book it.",
        )
        self.assertEqual(
            self.captures["guest4.jsonl"][3]["guest_text"],
            "yes, I'm female, full payment please",
        )
        for rows in self.captures.values():
            for row in rows:
                self.assertIn("guest_text", row)
                for call in row["resp"]["tool_calls"]:
                    self.assertIsInstance(call["args"], dict)
                    self.assertEqual(json.loads(json.dumps(call["args"])), call["args"])

    def test_emma_name_date_and_payment_turns_stay_pending_until_explicit_answer(self):
        self.loop = DeterministicRegisteredLoop(self, "sim29-emma")
        rows = self.captures["guest4.jsonl"]
        # Constructed Staff inventory: the capture omitted raw Staff bodies/state.
        bed = self._beds(1, "female_only", "R5")
        receipt = {**availability_receipt(bed), "girls_room_available": True}

        corrected = _tool_args(rows[1], "check_availability")
        self.loop.turn("emma-corrected", rows[1]["guest_text"])
        unresolved = self.loop.call("check_availability", corrected,
                                    {"/availability-check": receipt})
        self.assertEqual((corrected["check_in"], corrected["check_out"]),
                         ("2026-11-17", "2026-11-20"))
        self.assertEqual(corrected["guests"], [{"name": "Emma"}])
        self.assertEqual(unresolved["availability_status"], "eligibility_required")
        self.assertEqual(unresolved["reply_draft"], "Can Emma stay in the women-only dorm?")

        # Constructed continuation of the captured name/payment-only turn. Those
        # facts must be carried, but neither is eligibility evidence.
        name_payment_only = {**corrected, "guest_name": "Emma Clarke",
                             "guests": [{"name": "Emma Clarke"}],
                             "payment_choice": "full"}
        self.loop.turn("emma-name-payment", rows[2]["guest_text"])
        still_pending = self.loop.call("check_availability", name_payment_only,
                                       {"/availability-check": receipt})
        self.assertEqual(still_pending["availability_status"], "eligibility_required")
        self.assertEqual(still_pending["reply_draft"],
                         "Can Emma Clarke stay in the women-only dorm?")
        self.assertEqual(self.loop.staff[-1]["body"]["payment_choice"], "full")
        self.assertEqual((self.loop.staff[-1]["body"]["check_in"],
                          self.loop.staff[-1]["body"]["check_out"]),
                         ("2026-11-17", "2026-11-20"))

        answered = _tool_args(rows[3], "check_availability", 0)
        self.loop.turn("emma-answered", rows[3]["guest_text"])
        resolved = self.loop.call("check_availability", answered,
                                  {"/availability-check": receipt})
        self.assertFalse(resolved["room_decision"]["clarification_needed"], resolved)
        self.assertNotEqual(resolved.get("next_action"), "ask_room_eligibility")
        self.assertEqual(answered["guests"][0]["explicit_gender"], "female")
        self.assertEqual((answered["check_in"], answered["check_out"]),
                         ("2026-11-17", "2026-11-20"))

    def test_camille_captured_yes_precedes_price_but_constructed_unchanged_offer_yes_creates_once(self):
        self.loop = DeterministicRegisteredLoop(self, "sim29-camille")
        rows = self.captures["guest2.jsonl"]
        captured = _tool_args(rows[1], "quote_booking")
        self.assertIn("Oui, réservez !", rows[1]["guest_text"])
        self.assertNotIn("€240", rows[0]["resp"]["reply_text"])

        beds = self._beds(3, "mixed", "R1")
        captured["selected_bed_codes"] = [bed["bed_code"] for bed in beds]
        shown = checked_staff_quote(captured, beds, total=24000, deposit=24000,
                                    full_payment_only=True)
        self.loop.turn("camille-first-price", rows[1]["guest_text"])
        quoted = self.loop.call("quote_booking", captured, {
            "/availability-check": availability_receipt(beds),
            "/booking-preview": shown,
        })
        self.assertEqual(quoted["total_cents"], 24000)
        rendered = self.loop.present()
        self.assertIn("€240", rendered)
        self.assertEqual(len(self.loop.create_dispatches), 0,
                         "the pre-price captured yes is not consent to unseen terms")

        # Explicitly constructed continuation after the €240 offer was shown.
        continuation = "Oui, j’accepte cette offre inchangée à 240 € — réservez."
        self.loop.turn("camille-post-offer-yes", continuation)
        decision = self.loop.interpret("accept", continuation)
        self.assertTrue(decision["create_ready"], decision)
        prepared = owner.prepare_create({})

        create_receipt = {"success": True, "created": True, "write_performed": True,
                          "booking_id": "sim29-camille", "booking_code": "SIM29-CAMILLE"}
        def responses(route, body):
            if route == "/availability-check":
                return create_recheck_receipt(beds, body)
            if route == "/booking-create-from-plan":
                return create_receipt
            self.fail(f"unexpected route: {route}")

        first = self.loop.call("create_booking_from_plan", prepared, responses)
        self.assertTrue(first["success"], first)
        self.assertEqual(len(self.loop.create_dispatches), 1)
        self.assertEqual(first["booking_code"], "SIM29-CAMILLE")

        # Same frozen operation retry must return the stored receipt, not dispatch.
        retry = self.loop.call("create_booking_from_plan", prepared, responses)
        self.assertEqual(retry["booking_code"], "SIM29-CAMILLE")
        self.assertEqual(len(self.loop.create_dispatches), 1)

        self.loop.turn("camille-changed-dates", "Oui, mais du 21 au 23 novembre.")
        with self.assertRaises(owner.QuoteBoundaryError):
            owner.prepare_create({"check_in": "2026-11-21", "check_out": "2026-11-23"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
