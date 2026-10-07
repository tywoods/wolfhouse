"""Offline registered-handler proof; no live inference, Staff write, or DB proof."""
import copy
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "docker/hermes-staging"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wolfhouse_staff_api as plugin


class Registry:
    def __init__(self):
        self.tools = {}

    def register_tool(self, **tool):
        self.tools[tool["name"]] = tool


class NoGenderAfterPayIntentTests(unittest.TestCase):
    def setUp(self):
        for target in ("urllib.request.urlopen", "socket.socket.connect", "socket.create_connection"):
            tripwire = patch(target, side_effect=AssertionError("network forbidden"))
            mocked = tripwire.start()
            self.addCleanup(tripwire.stop)
            self.addCleanup(mocked.assert_not_called)
        env = patch.dict(os.environ, {"LUNA_CLIENT_SLUG": "wolfhouse-somo"})
        env.start()
        self.addCleanup(env.stop)
        registry = Registry()
        plugin.register(registry)
        self.tools = registry.tools
        self.payload = {
            "client_slug": "wolfhouse-somo", "check_in": "2026-07-06", "check_out": "2026-07-09",
            "guest_count": 2, "guest_name": "Alex", "guests": [{"name": "Alex"}, {"name": "Sam"}],
            "package_code": "package_none", "payment_choice": "full", "room_preference": "mixed",
            "selected_bed_codes": ["SYNTHETIC-B1", "SYNTHETIC-B2"],
        }

    def invoke(self, name, payload, availability=None, preview=None):
        calls = []
        original = copy.deepcopy(payload)

        def transport(path, body):
            calls.append((path, copy.deepcopy(body)))
            if path == "/availability-check":
                if payload.get('selected_bed_codes') and availability is None:
                    # Current authoritative inventory for the accepted neutral choice.
                    calls.pop()  # This helper reports booking/preview attempts, not this read.
                    private = (payload.get('room_preference') or payload.get('room_type')) in {'private', 'private_room', 'couple_private'}
                    return {'success': True, 'has_enough_beds': True, 'available_beds': [
                        {'bed_code': code, 'room_code': 'SYNTHETIC', 'room_type': 'private' if private else 'mixed'}
                        for code in payload['selected_bed_codes']]}
                return availability or {"success": True, "selected_bed_codes": []}
            if path == "/booking-preview":
                return preview if preview is not None else {"success": True, "quote": {"total_cents": 10000, "deposit_required_cents": 3000}}
            self.assertEqual(path, "/booking-create-from-plan")
            # Deliberately not a successful booking/payment: attempted transport only.
            return {"success": False, "write_performed": False, "error": "offline_capture"}

        with patch.object(plugin, "_post_bot", side_effect=transport), \
                patch.object(plugin, "_session_guest_phone", return_value="+34900000000"):
            result = json.loads(self.tools[name]["handler"](payload))
        self.assertEqual(payload, original, "handler must preserve caller input")
        return result, calls

    def test_accepted_mixed_unknown_group_reaches_create_without_inventing_gender(self):
        result, calls = self.invoke("create_booking_from_plan", self.payload)
        self.assertEqual([path for path, _ in calls], ["/booking-create-from-plan"])
        sent = calls[0][1]
        self.assertNotIn("group_gender", sent)
        self.assertEqual(sent['selected_bed_codes'], self.payload['selected_bed_codes'], 'revalidated neutral beds must not be silently dropped')
        self.assertEqual(sent["room_preference"], "mixed")
        self.assertEqual(result["room_decision"]["resolved_composition"], "unknown")
        self.assertFalse(result["room_decision"]["clarification_needed"])
        self.assertEqual(result["room_decision"]["excluded_room_preferences"], ["female_only", "male_only"])
        self.assertFalse(result["write_performed"])


    def test_create_missing_room_eligibility_is_neutral_even_without_payment_field(self):
        for choice in (None, "full", "split", "deposit"):
            for hints in ({}, {"name_hint": "unknown", "name_confidence": 0.1}):
                with self.subTest(choice=choice, hints=hints):
                    payload = {**self.payload, **hints}
                    payload.pop("room_preference")
                    payload.pop("selected_bed_codes")
                    if choice is None:
                        payload.pop("payment_choice")
                    else:
                        payload["payment_choice"] = choice
                    result, calls = self.invoke("create_booking_from_plan", payload)
                    self.assertEqual(calls, [], "unresolved eligibility must stop before transport")
                    self.assertFalse(result["write_performed"])
                    self.assertTrue(result["do_not_escalate"])
                    self.assertFalse(result["staff_review_needed"])
                    self.assertEqual(result["reply_draft"], "Would a mixed dorm work for you?")
                    self.assertEqual(result["room_decision"]["resolved_composition"], "unknown")


    def test_quote_only_recognized_payment_choices_select_neutral_recovery(self):
        for choice in ("full", "full amount", "deposit", "per_guest", "split", "pay on arrival"):
            for hints in ({}, {"name_hint": "unknown"}):
                with self.subTest(choice=choice, hints=hints):
                    payload = {**self.payload, **hints, "payment_choice": choice}
                    payload.pop("room_preference")
                    result, calls = self.invoke("quote_booking", payload)
                    self.assertEqual([path for path, _ in calls], ["/booking-preview"])
                    self.assertEqual(result["reply_draft"], "Would a mixed dorm work for you?")
                    self.assertTrue(result["do_not_escalate"])
                    self.assertFalse(result["staff_review_needed"])
                    self.assertEqual(result["room_decision"]["resolved_composition"], "unknown")
        # The normalizer defaults blank input to deposit; that is NOT payment intent.
        for choice in (None, "", "   ", True, 1, "banana", "not chosen", {}, ["full"]):
            with self.subTest(prepay_choice=choice):
                payload = {**self.payload, "name_hint": "unknown", "payment_choice": choice}
                payload.pop("room_preference")
                result, _ = self.invoke("quote_booking", payload)
                self.assertEqual(result["reply_draft"], "Is your group all girls, all guys, or a mix?")


    def test_private_room_type_does_not_reopen_demographic_intake(self):
        for tool in ("quote_booking", "create_booking_from_plan"):
            for private_type in ("private", "couple_private", "private_room"):
                with self.subTest(tool=tool, room_type=private_type):
                    payload = {**self.payload, "room_type": private_type}
                    payload.pop("room_preference")
                    result, calls = self.invoke(tool, payload)
                    self.assertFalse((result.get("room_decision") or {}).get("clarification_needed", True))
                    self.assertTrue(calls)
                    self.assertNotIn("group_gender", calls[-1][1])


    def test_unavailable_mixed_choice_cannot_create_or_reopen_composition(self):
        for tool in ("quote_booking", "create_booking_from_plan"):
            for preference in ("mixed", "shared"):
                for composition in (None, "mixed", "male", "female"):
                    with self.subTest(tool=tool, preference=preference, composition=composition):
                        payload = {**self.payload, "room_preference": preference,
                                   "available_rooms": {"mixed": False}}
                        if composition:
                            payload["group_gender"] = composition
                        result, calls = self.invoke(tool, payload)
                        self.assertNotIn("/booking-create-from-plan", [p for p, _ in calls])
                        decision = result["room_decision"]
                        self.assertTrue(decision["clarification_needed"])
                        self.assertNotIn("mixed", decision["allowed_room_preferences"])
                        self.assertNotIn("shared", decision["allowed_room_preferences"])
                        self.assertNotEqual(result["reply_draft"], "Would a mixed dorm work for you?")
                        self.assertNotIn("all girls", result["reply_draft"])
                        self.assertFalse(result["needs_human"])
                        self.assertTrue(result["do_not_escalate"])


    def test_fresh_unavailability_stops_create_even_with_accepted_room(self):
        for preference in ("mixed", "shared", "private"):
            for unavailable in ({"has_enough_beds": False}, {"availability_status": "unavailable"}):
                with self.subTest(preference=preference, unavailable=unavailable):
                    payload = {**self.payload, "room_preference": preference,
                               "available_rooms": {"mixed": True, "private": True}}
                    payload.pop("selected_bed_codes")
                    for _ in range(2):
                        result, calls = self.invoke("create_booking_from_plan", payload,
                                                    availability={"success": True, **unavailable})
                        self.assertEqual([p for p, _ in calls], ["/availability-check"])
                        self.assertFalse(result["write_performed"])
                        self.assertTrue(result["do_not_escalate"])
                        self.assertFalse(result["needs_human"])
                        self.assertEqual(result["room_decision"]["resolved_composition"], "unknown")
                        self.assertNotIn("all girls", result["reply_draft"])
                        self.assertNotEqual(result["reply_draft"], "Would a mixed dorm work for you?")

    def test_fresh_room_facts_override_caller_availability(self):
        for tool in ("quote_booking", "create_booking_from_plan"):
            for preference in ("private", "couple_private", "private_room", "female_only"):
                with self.subTest(tool=tool, preference=preference):
                    key = "female_only" if preference == "female_only" else "private"
                    fact = "girls_room_available" if key == "female_only" else "private_room_available"
                    payload = {**self.payload, "room_preference": preference,
                               "available_rooms": {key: True}}
                    payload.pop("selected_bed_codes")
                    if key == "female_only":
                        payload["group_gender"] = "female"  # Explicit statement, not a name inference.
                    snapshot = {"success": True, fact: False}
                    for _ in range(2):
                        result, calls = self.invoke(tool, payload, availability=snapshot, preview=snapshot)
                        self.assertEqual([p for p, _ in calls],
                                         ["/booking-preview" if tool == "quote_booking" else "/availability-check"])
                        decision = result["room_decision"]
                        self.assertTrue(decision["clarification_needed"])
                        self.assertNotIn(preference, decision["allowed_room_preferences"])
                        self.assertEqual(decision["resolved_composition"],
                                         "female" if key == "female_only" else "unknown")
                        self.assertNotIn("all girls", result["reply_draft"])
                        self.assertTrue(result["do_not_escalate"])
                        self.assertFalse(result["staff_review_needed"])
                        if tool == "create_booking_from_plan":
                            self.assertFalse(result["write_performed"])

    def test_availability_description_does_not_schedule_composition_at_create(self):
        description = self.tools["check_availability"]["description"].lower()
        self.assertIn("before quote/payment", description)
        self.assertIn("never after payment intent", description)

    def test_registered_room_descriptions_forbid_late_composition_and_invention(self):
        for tool in ("quote_booking", "create_booking_from_plan"):
            properties = self.tools[tool]["schema"]["parameters"]["properties"]
            description = properties["group_gender"]["description"].lower()
            self.assertIn("never ask after payment intent", description)
            self.assertIn("never invent", description)
            self.assertIn("unknown", description)
            self.assertIn("reuse", properties["room_preference"]["description"].lower())
            self.assertIn("neutral room", self.tools[tool]["description"].lower())

    def test_repeat_safe_choices_preserve_unknown_names_and_payment(self):
        for count in (1, 2, 4):
            for preference in ("mixed", "shared", "private", "couple_private"):
                for choice in ("full", "split", "deposit"):
                    with self.subTest(count=count, preference=preference, choice=choice):
                        names = [{"name": n} for n in ("Alex", "Sam", "Chris", "Robin")[:count]]
                        payload = {**self.payload, "guest_count": count, "guests": names,
                                   "selected_bed_codes": [f'SYNTHETIC-B{i}' for i in range(1, count + 1)],
                                   "room_preference": preference, "payment_choice": choice,
                                   "name_hint": "male", "name_confidence": 0.99, "name_ambiguous": True}
                        for tool in ("quote_booking", "quote_booking", "create_booking_from_plan", "create_booking_from_plan"):
                            result, calls = self.invoke(tool, payload)
                            decision = result["room_decision"]
                            self.assertFalse(decision["clarification_needed"])
                            self.assertIsNone(decision["clarification_prompt"])
                            self.assertEqual(decision["resolved_composition"], "unknown")
                            self.assertEqual(decision["excluded_room_preferences"], ["female_only", "male_only"])
                            self.assertEqual(len(calls), 1)
                            sent = calls[0][1]
                            self.assertNotIn("group_gender", sent)
                            self.assertEqual(sent["guests"], names)
                            self.assertEqual(sent["room_preference"], preference)
                            expected = ("per_guest" if choice == "split" else plugin._normalize_payment_choice(choice)) if tool == "create_booking_from_plan" else choice
                            self.assertEqual(sent["payment_choice"], expected)

    def test_explicit_mismatch_still_blocks_then_safe_choice_can_proceed(self):
        for gender, bad_room in (("male", "female_only"), ("female", "male_only")):
            for tool in ("quote_booking", "create_booking_from_plan"):
                with self.subTest(gender=gender, tool=tool):
                    payload = {**self.payload, "group_gender": gender, "room_preference": bad_room}
                    result, calls = self.invoke(tool, payload)
                    self.assertNotIn("/booking-create-from-plan", [p for p, _ in calls])
                    self.assertTrue(result["room_decision"]["conflict"])
                    self.assertNotIn(bad_room, result["room_decision"]["allowed_room_preferences"])
                    self.assertFalse(result["needs_human"])
                    self.assertTrue(result["do_not_escalate"])
                    self.assertNotIn("all girls", result["reply_draft"])
                    corrected, calls = self.invoke(tool, {**payload, "room_preference": "mixed"})
                    self.assertFalse(corrected["room_decision"]["clarification_needed"])
                    self.assertEqual(corrected["room_decision"]["resolved_composition"], gender)
                    self.assertEqual(calls[-1][1]["group_gender"], gender)

    def test_unknown_gendered_choice_cannot_be_made_eligible_by_payment(self):
        for preference in ("female_only", "male_only"):
            result, calls = self.invoke("create_booking_from_plan", {**self.payload, "room_preference": preference})
            self.assertEqual(calls, [])
            self.assertEqual(result["reply_draft"], "Would a mixed dorm work for you?")
            self.assertEqual(result["room_decision"]["resolved_composition"], "unknown")
            self.assertNotIn(preference, result["room_decision"]["allowed_room_preferences"])

    def test_pre_payment_no_hint_and_solo_controls(self):
        payload = dict(self.payload)
        payload.pop("payment_choice")
        payload.pop("room_preference")
        result, _ = self.invoke("quote_booking", payload)
        self.assertIsNone(result["room_decision"], "ordinary no-hint quote remains unchanged")
        result, _ = self.invoke("quote_booking", {**payload, "guest_count": 1, "name_hint": "unknown"})
        self.assertEqual(result["reply_draft"], "Would a mixed dorm work for you?")
        result, _ = self.invoke("quote_booking", {**payload, "guest_count": 1, "name_hint": "male", "name_confidence": 0.9})
        self.assertTrue(result["room_decision"]["clarification_needed"])
        self.assertEqual(result["room_decision"]["resolved_composition"], "unknown")
        self.assertEqual(result["reply_draft"], "Would a mixed dorm work for you?")


if __name__ == "__main__":
    unittest.main(verbosity=2)
