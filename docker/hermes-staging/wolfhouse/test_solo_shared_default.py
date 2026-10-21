"""Offline regressions for default solo shared placement.

No network, Staff write, payment, or booking-create path is exercised here.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "docker/hermes-staging"))
sys.path.insert(0, str(ROOT / "docker/hermes-staging/plugins"))

import wolfhouse_staff_api as plugin
from wolfhouse import accepted_quote as owner
from wolfhouse.room_eligibility_policy import decide_room_eligibility
from wolfhouse_staff_api.test_sim16_jonas_liam_fix import DeterministicRegisteredLoop


class Registry:
    def __init__(self):
        self.tools = {}

    def register_tool(self, **tool):
        self.tools[tool["name"]] = tool


class SoloSharedDefaultTests(unittest.TestCase):
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
        self.base = {
            "client_slug": "wolfhouse-somo",
            "check_in": "2027-07-05",
            "check_out": "2027-07-08",
            "guest_count": 1,
            "package_code": "package_none",
            "guest_name": "Fabio",
            "guests": [{"name": "Fabio"}],
        }
        self.mixed_bed = {
            "bed_code": "M1", "room_code": "MIX", "room_type": "mixed",
        }

    def test_policy_defaults_unknown_solo_to_available_shared_without_gender_claim(self):
        decision = decide_room_eligibility(
            guest_count=1,
            name="Fabio",
            available={"mixed": True, "female_only": True},
        )
        self.assertFalse(decision["clarification_needed"])
        self.assertIsNone(decision["clarification_prompt"])
        self.assertEqual(decision["resolved_composition"], "unknown")
        self.assertEqual(decision["allowed_room_preferences"], ["mixed", "shared"])
        self.assertEqual(decision["excluded_room_preferences"], ["female_only", "male_only"])

    def test_registered_quote_defaults_unknown_and_explicit_male_solos_to_mixed(self):
        availability = {
            "success": True,
            "has_enough_beds": True,
            "selected_room_code": "MIX",
            "selected_bed_codes": ["M1"],
            "available_beds": [self.mixed_bed],
        }
        preview = {
            "success": True,
            "offer_revision": "solo-mixed-r1",
            "quote_status": "ready",
            "quote": {
                "total_cents": 12000,
                "deposit_required_cents": 3000,
                "balance_due_cents": 12000,
            },
        }
        for explicit_gender in (None, "male"):
            with self.subTest(explicit_gender=explicit_gender):
                payload = dict(self.base)
                if explicit_gender:
                    payload["explicit_gender"] = explicit_gender
                calls = []

                def transport(path, body):
                    calls.append((path, dict(body)))
                    return availability if path == "/availability-check" else preview

                with patch.object(plugin, "_post_bot", side_effect=transport):
                    result = json.loads(self.tools["quote_booking"]["handler"](payload))

                self.assertEqual([path for path, _ in calls],
                                 ["/availability-check", "/booking-preview"])
                for _, sent in calls:
                    self.assertEqual(sent["room_preference"], "mixed")
                    self.assertNotIn("name_hint", sent)
                    if explicit_gender is None:
                        self.assertNotIn("group_gender", sent)
                self.assertTrue(result["success"], result)
                self.assertEqual(result["quote_status"], "ready")
                self.assertNotEqual(result.get("reply_draft"),
                                    "Would a mixed dorm work for you?")
                self.assertFalse(result["room_decision"]["clarification_needed"])

    def test_default_helper_preserves_female_private_specific_and_group_requests(self):
        cases = (
            {"guest_count": 1, "guests": [{"name": "A", "explicit_gender": "female"}]},
            {"guest_count": 1, "explicit_gender": "female"},
            {"guest_count": 1, "room_type": "private"},
            {"guest_count": 1, "room_type": "double"},
            {"guest_count": 1, "room_type": "matrimonial"},
            {"guest_count": 1, "room_preference": "room 3"},
            {"guest_count": 1, "gender_preference": "female"},
            {"guest_count": 1, "gender_preference": "girls"},
            {"guest_count": 1, "gender_preference": "private"},
            {"guest_count": 1, "gender_preference": "room 3"},
            {"guest_count": 1, "group_gender": "girls"},
            {"guest_count": 2, "guests": [{"name": "A"}, {"name": "B"}]},
        )
        for original in cases:
            with self.subTest(original=original):
                payload = json.loads(json.dumps(original))
                plugin._default_solo_shared_placement(payload)
                self.assertEqual(payload, original)

    def test_registered_z_guest_level_female_aliases_survive_normalization(self):
        for alias in ("girl", "girls", "woman", "women", "female", "f"):
            with self.subTest(alias=alias):
                loop = DeterministicRegisteredLoop(self, session=f"solo-alias-{alias}")
                try:
                    loop.turn("alias", f"The guest explicitly said {alias}.")

                    def staff(route, body):
                        self.assertEqual(body["guests"],
                                         [{"name": "Guest", "explicit_gender": "female"}])
                        self.assertNotEqual(body.get("room_preference"), "mixed")
                        return {
                            "success": True, "has_enough_beds": True,
                            "available_beds": [], "selected_bed_codes": [],
                        }

                    loop.call("check_availability", {
                        "check_in": "2026-11-02", "check_out": "2026-11-05",
                        "guest_count": 1, "room_type": "shared",
                        "guests": [{"name": "Guest", "explicit_gender": alias}],
                    }, staff)
                finally:
                    loop.close()

    def test_current_explicit_room_request_supersedes_established_mixed_choice(self):
        cases = (
            ({"room_type": "private"}, "room_type", "private"),
            ({"room_type": "double"}, "room_type", "double"),
            ({"room_type": "matrimonial"}, "room_type", "matrimonial"),
            ({"gender_preference": "female"}, "gender_preference", "female"),
            ({"gender_preference": "girls"}, "gender_preference", "girls"),
            ({"gender_preference": "Room 3"}, "gender_preference", "Room 3"),
            ({"group_gender": "girls"}, "group_gender", "girls"),
        )
        for index, (request, key, expected) in enumerate(cases):
            with self.subTest(request=request):
                loop = DeterministicRegisteredLoop(self, session=f"solo-new-choice-{index}")
                try:
                    def staff(route, body):
                        self.assertEqual(route, "/availability-check")
                        return {
                            "success": True, "has_enough_beds": True,
                            "selected_room_code": "R1", "selected_bed_codes": ["R1-B1"],
                            "available_beds": [{
                                "bed_code": "R1-B1", "room_code": "R1",
                                "room_type": body.get("room_type", "shared"),
                                "selected_selling_mode": "bed",
                            }],
                        }

                    loop.turn("mixed", "One ordinary mixed dorm bed, please.")
                    loop.call("check_availability", {
                        "check_in": "2026-11-02", "check_out": "2026-11-05",
                        "guest_count": 1, "room_type": "shared",
                        "room_preference": "mixed", "guests": [{"name": "Alex"}],
                    }, staff)
                    self.assertEqual(owner._transaction(
                        lambda current, ingress: current.copy())["plan"]["room_preference"], "mixed")

                    loop.turn("new-choice", f"Actually, I explicitly want {expected}.")
                    loop.call("check_availability", {
                        "guest_count": 1, **request,
                    }, staff)
                    sent = loop.staff[-1]["body"]
                    self.assertEqual(sent[key], expected)
                    self.assertNotEqual(sent.get("room_preference"), "mixed")
                finally:
                    loop.close()

    def test_sparse_follow_up_preserves_established_female_only_choice(self):
        loop = DeterministicRegisteredLoop(self, session="solo-retained-room")
        try:
            def staff(route, body):
                self.assertEqual(route, "/availability-check")
                preference = body.get("room_preference")
                room_type = "female_only" if preference == "female_only" else "mixed"
                return {
                    "success": True,
                    "has_enough_beds": True,
                    "selected_room_code": "R1",
                    "selected_bed_codes": ["R1-B1"],
                    "available_beds": [{
                        "bed_code": "R1-B1", "room_code": "R1",
                        "room_type": room_type, "selected_selling_mode": "bed",
                    }],
                }

            loop.turn("selected", "I am female; one bed in the women-only dorm please.")
            loop.call("check_availability", {
                "check_in": "2026-11-02", "check_out": "2026-11-05",
                "guest_count": 1, "room_type": "shared",
                "room_preference": "female_only",
                "guests": [{"name": "Emma", "explicit_gender": "female"}],
            }, staff)
            loop.turn("date-change", "Same women-only dorm, but November 3 to 6 please.")
            loop.call("check_availability", {
                "check_in": "2026-11-03", "check_out": "2026-11-06",
                "guest_count": 1, "room_type": "shared",
            }, staff)
            loop.turn("sparse", "Still the same choice, please.")
            loop.call("check_availability", {
                "guest_count": 1, "room_type": "shared",
            }, staff)
            state = owner._transaction(lambda current, ingress: current.copy())
            self.assertEqual(loop.staff[-1]["body"]["room_preference"], "female_only")
            self.assertNotIn("check_in", loop.staff[-1]["body"])
            self.assertNotIn("check_out", loop.staff[-1]["body"])
            self.assertEqual(state["plan"]["room_preference"], "female_only")
            self.assertEqual(state["plan"]["check_in"], "2026-11-03")
            self.assertEqual(state["plan"]["check_out"], "2026-11-06")
            self.assertEqual(state["plan"]["guests"],
                             [{"name": "Emma", "explicit_gender": "female"}])
        finally:
            loop.close()

    def test_sim27_comparison_stays_separate_from_emmas_real_selection(self):
        """Chronological fixture; Staff response bodies below are synthetic."""
        loop = DeterministicRegisteredLoop(self, session="sim27-comparison-emma")
        try:
            def synthetic_staff(route, body):
                self.assertEqual(route, "/availability-check")
                requested = body.get("room_preference") or "mixed"
                room_type = requested if requested in {"female_only", "male_only"} else "mixed"
                response = {
                    "success": True, "has_enough_beds": True,
                    "selected_room_code": "R8", "selected_bed_codes": ["R8-B1"],
                    "available_beds": [{
                        "bed_code": "R8-B1", "room_code": "R8",
                        "room_type": room_type, "selected_selling_mode": "bed",
                    }],
                    "synthetic_fixture_body": True,
                }
                if requested in {"female_only", "male_only"}:
                    response["room_eligibility"] = {
                        "status": "unsure", "affected_guest_indices": [0],
                        "requested_room_preference": requested,
                        "reason_code": "room_eligibility_unknown",
                        "question_kind": "room_eligibility",
                    }
                    response["blockers"] = ["room_eligibility_unknown"]
                return response

            loop.turn("compare-1", (
                "Hi! Just checking availability, no booking yet: for Mon 2 Nov to Thu 5 Nov 2026, "
                "do you have free beds in the mixed dorm, the women-only dorm, the men-only dorm, "
                "and is Room 1 free? Also same question for Fri 6 Nov to Sun 8 Nov 2026."
            ))
            loop.turn("compare-2", (
                "Just 1 person for each, I only want to know which of those have at least 2-3 "
                "free beds on each date range."
            ))
            comparisons = []
            for check_in, check_out in (("2026-11-02", "2026-11-05"),
                                        ("2026-11-06", "2026-11-08")):
                for preference in ("mixed", "female_only", "male_only", "Room 1"):
                    comparisons.append(loop.call("check_availability", {
                        "check_in": check_in, "check_out": check_out,
                        "guest_count": 1, "room_type": "shared",
                        "room_preference": preference,
                        "availability_intent": "comparison",
                    }, synthetic_staff))
            state = owner._transaction(lambda current, ingress: current.copy())
            self.assertIsNone(state.get("plan"), "a comparison must not select a stay or room")
            self.assertTrue(all(not result["room_decision"]["clarification_needed"]
                                for result in comparisons))
            self.assertTrue(all(result.get("availability_status") != "eligibility_required"
                                for result in comparisons))
            self.assertTrue(all(result.get("next_action") != "ask_room_eligibility"
                                for result in comparisons))

            loop.turn("emma-choice", (
                "Hi Luna, Emma from Manchester here. Do you have a girls-only dorm? "
                "I'd like 1 bed from Mon 2 Nov to Thu 5 Nov 2026. How much?"
            ))
            selected = loop.call("check_availability", {
                "check_in": "2026-11-02", "check_out": "2026-11-05",
                "guest_count": 1, "room_type": "shared",
                "room_preference": "female_only", "guests": [{"name": "Emma"}],
                "payment_choice": "full",
            }, synthetic_staff)
            self.assertTrue(selected["room_decision"]["clarification_needed"],
                            "Emma's name must not establish eligibility")
            self.assertEqual(selected.get("availability_status"), "eligibility_required", selected)
            chosen = owner._transaction(lambda current, ingress: current.copy())["plan"]
            self.assertEqual(chosen["room_preference"], "female_only")
            self.assertEqual(chosen["check_in"], "2026-11-02")
            self.assertEqual(chosen["check_out"], "2026-11-05")
            self.assertEqual(chosen["guests"], [{"name": "Emma"}])
            self.assertEqual(chosen["payment_choice"], "full")
        finally:
            loop.close()

    def test_z_explicit_selection_intent_overrides_legacy_comparison_text(self):
        loop = DeterministicRegisteredLoop(self, session="solo-explicit-selection")
        try:
            loop.turn("selection", "I said no booking yet before, but now I select Room 3.")
            self.assertFalse(plugin._availability_is_comparison_turn({
                "availability_intent": "selection",
            }))
            self.assertTrue(plugin._availability_is_comparison_turn({
                "availability_intent": "comparison",
            }))
        finally:
            loop.close()

    def test_no_mixed_stock_remains_truthful_and_does_not_quote(self):
        sold_out = {
            "success": True,
            "has_enough_beds": False,
            "availability_status": "unavailable",
            "selected_bed_codes": [],
            "available_beds": [],
        }
        with patch.object(plugin, "_post_bot", return_value=sold_out) as transport:
            result = json.loads(self.tools["quote_booking"]["handler"](dict(self.base)))
        transport.assert_called_once()
        self.assertEqual(transport.call_args.args[0], "/availability-check")
        self.assertEqual(transport.call_args.args[1]["room_preference"], "mixed")
        self.assertFalse(result["success"])
        self.assertTrue(result["unavailable"])
        self.assertIsNone(result["total_cents"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
