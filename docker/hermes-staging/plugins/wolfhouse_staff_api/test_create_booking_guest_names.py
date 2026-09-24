"""Offline regressions at the registered Luna create-booking tool boundary.

No model inference is simulated: the structured interpretation of the reported
reply is an explicit fixture. Network is forbidden; API capture is the only seam.
"""
import copy
import json
import os
from pathlib import Path
import sys
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "docker/hermes-staging"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wolfhouse_staff_api as plugin

REPLY = "Tom, Tyler, Koa Kathy"
NAMES = ["Tom", "Tyler", "Koa", "Kathy"]


class Registry:
    def __init__(self):
        self.tools = {}

    def register_tool(self, **tool):
        self.tools[tool["name"]] = tool


class CreateGuestNamesTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"LUNA_CLIENT_SLUG": "wolfhouse-somo"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.network = patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden"))
        self.network.start()
        self.addCleanup(self.network.stop)
        registry = Registry()
        plugin.register(registry)
        self.tool = registry.tools["create_booking_from_plan"]
        self.payload = {
            "client_slug": "wolfhouse-somo", "check_in": "2026-07-06", "check_out": "2026-07-09",
            "guest_count": 4, "guest_name": "Tom", "package_code": "package_none",
            "payment_choice": "full", "group_gender": "mixed", "room_type": "shared",
            "selected_bed_codes": [f"R3-B{i}" for i in range(1, 5)],
        }

    def invoke(self, payload):
        calls = []

        def api(path, body):
            calls.append((path, copy.deepcopy(body)))
            self.assertEqual(path, "/booking-create-from-plan")
            # Not a fabricated successful write: capture the attempted transport only.
            return {"success": False, "write_performed": False, "error": "offline_capture"}

        with patch.object(plugin, "_post_bot", side_effect=api), \
                patch.object(plugin, "_session_guest_phone", return_value="+34900000001"):
            result = json.loads(self.tool["handler"](payload))
        return result, calls

    def test_group_missing_names_does_not_create_numbered_primary_placeholders(self):
        result, calls = self.invoke(self.payload)
        self.assertEqual(calls, [], "must not write Tom (1)..Tom (4) when the names list is omitted")
        self.assertFalse(result["write_performed"])
        self.assertTrue(result["booking_not_created_yet"])
        self.assertEqual(result["next_action"], "complete_guest_names")
        self.assertFalse(result["staff_review_needed"])
        self.assertTrue(result["do_not_escalate"])
        self.assertIn("conversation", result["guidance"])

    def test_decimal_string_count_without_names_fails_closed(self):
        payload = {**self.payload, "guest_count": "4.0"}
        payload.pop("group_gender")
        result, calls = self.invoke(payload)
        self.assertEqual(calls, [], "must not forward a count JS accepts as four unnamed occupants")
        self.assertFalse(result["write_performed"])
        self.assertTrue(result["booking_not_created_yet"])
        self.assertEqual(result["next_action"], "clarify_guest_count")
        self.assertEqual(result["guest_safe_next_action"], "clarify_guest_count")
        self.assertEqual(result["missing_fields"], ["guest_count"])
        self.assertFalse(result["staff_review_needed"])
        self.assertTrue(result["do_not_escalate"])

    def test_invalid_supplied_counts_recover_before_inference_room_policy_or_transport(self):
        invalid_counts = ("4.0", "4people", "4e0", "four", "04", "+4", " 4 ", "٤",
                          "", None, True, False, 0, -1, "0", "-1", 1.5, 4.5,
                          float("inf"), float("-inf"), float("nan"),
                          10 ** 100, 1e100, "9" * 5000, [], {})
        for alias in ("guest_count", "num_guests", "count"):
            for count in invalid_counts:
                for named in (False, True):
                    for room_hint in (False, True):
                        with self.subTest(alias=alias, count=repr(count)[:80], named=named,
                                          room_hint=room_hint):
                            payload = {**self.payload, alias: count}
                            if alias != "guest_count":
                                payload.pop("guest_count")
                            if not room_hint:
                                payload.pop("group_gender")
                            if named:
                                payload["guests"] = NAMES
                            # No availability request either: reject before any transport.
                            payload.pop("selected_bed_codes")
                            result, calls = self.invoke(payload)
                            self.assertEqual(calls, [])
                            self.assertFalse(result["write_performed"])
                            self.assertTrue(result["booking_not_created_yet"])
                            self.assertEqual(result["next_action"], "clarify_guest_count")
                            self.assertFalse(result["staff_review_needed"])
                            self.assertTrue(result["do_not_escalate"])

    def test_valid_integer_counts_and_aliases_keep_names_guard(self):
        for alias in ("guest_count", "num_guests", "count"):
            for count in (4, "4", 4.0):
                for names in (None, NAMES, NAMES[:3]):
                    with self.subTest(alias=alias, count=count, names=names):
                        payload = {**self.payload, alias: count}
                        if alias != "guest_count":
                            payload.pop("guest_count")
                        if names is not None:
                            payload["guests"] = names
                        result, calls = self.invoke(payload)
                        if names == NAMES:
                            self.assertEqual(len(calls), 1)
                            self.assertEqual(calls[0][1]["guest_count"], 4)
                            self.assertEqual(calls[0][1]["guests"], [{"name": n} for n in NAMES])
                        else:
                            self.assertEqual(calls, [])
                            self.assertEqual(result["next_action"], "complete_guest_names")
        _, calls = self.invoke({k: v for k, v in {**self.payload, "guests": NAMES}.items()
                                if k != "guest_count"})
        self.assertEqual(calls[0][1]["guest_count"], 4, "retain inferred party count")

    def test_invalid_alias_cannot_hide_behind_valid_primary_count(self):
        for alias in ("num_guests", "count"):
            with self.subTest(alias=alias):
                result, calls = self.invoke({**self.payload, alias: "4.0", "guests": NAMES})
                self.assertEqual(calls, [])
                self.assertEqual(result["next_action"], "clarify_guest_count")

    def test_incomplete_or_ambiguous_list_never_writes(self):
        for names in ([], ["Tom"], ["Tom", "Tyler", "Koa Kathy"],
                      ["Tom", "Tyler", "Koa", ""], [None] * 4, NAMES + ["Extra"]):
            with self.subTest(names=names):
                result, calls = self.invoke({**self.payload, "guests": names})
                self.assertEqual(calls, [])
                self.assertEqual(result["next_action"], "complete_guest_names")
                self.assertFalse(result["staff_review_needed"])

    def test_invalid_slots_cannot_shrink_an_inferred_party(self):
        payload = {**self.payload, "guests": ["Tom", None, "Koa", "Kathy"]}
        del payload["guest_count"]
        result, calls = self.invoke(payload)
        self.assertEqual(calls, [], "normalization must not drop a person before inferring guest_count")
        self.assertEqual(result["next_action"], "complete_guest_names")

    def test_all_names_preserved_for_every_payment_choice(self):
        for choice in ("full", "full amount", "deposit", "per_guest"):
            for guests in (NAMES, [{"name": n} for n in NAMES], [{"guest_name": n} for n in NAMES]):
                with self.subTest(choice=choice, guests=guests):
                    payload = {**self.payload, "guests": guests, "payment_choice": choice}
                    original = copy.deepcopy(payload)
                    _, calls = self.invoke(payload)
                    self.assertEqual(len(calls), 1)
                    sent = calls[0][1]
                    self.assertEqual(sent["guests"], [{"name": n} for n in NAMES])
                    self.assertEqual(sent["guest_name"], "Tom")
                    self.assertEqual(sent["guest_count"], 4)
                    self.assertEqual(sent["payment_choice"], plugin._normalize_payment_choice(choice))
                    self.assertEqual(payload, original, "do not mutate caller input")

    def test_compound_and_repeated_real_names_are_not_split_or_deduplicated(self):
        names = ["María José", "Jean-Luc", "Alex", "Alex"]
        _, calls = self.invoke({**self.payload, "guests": names})
        self.assertEqual(calls[0][1]["guests"], [{"name": n} for n in names])

    def test_registered_tool_payload_reaches_real_occupant_sql(self):
        # The model's interpretation is fixture input, not claimed live inference.
        # Replay the exact captured body through production command + execute,
        # backed by real in-memory PostgreSQL. No fabricated successful API reply.
        _, calls = self.invoke({**self.payload, "guests": NAMES})
        self.assertEqual(len(calls), 1)
        result = json.loads(subprocess.check_output([
            "node", "scripts/verify-luna-create-booking-occupants.js", "--payload",
        ], input=json.dumps(calls[0][1]), cwd=ROOT, text=True, timeout=60))
        self.assertTrue(result["ok"])
        self.assertEqual([row["guest_name"] for row in result["occupants"]], NAMES)
        self.assertEqual(sorted(row["assigned_bed_code"] for row in result["occupants"]),
                         [f"R3-B{i}" for i in range(1, 5)])
        self.assertEqual(result["contact"]["crm_customer_count"], 1)
        self.assertTrue(result["contact"]["reused_existing_identity"])
        self.assertEqual(result["money"]["payment_choice"], "full")
        self.assertEqual(result["network_attempts"], [])
        print("SQL READBACK:", ", ".join(f"{g['guest_name']}={g['assigned_bed_code']}"
                                        for g in result["occupants"]))

    def test_solo_primary_name_still_works(self):
        _, calls = self.invoke({**self.payload, "guest_count": 1, "group_gender": "male"})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1]["guest_name"], "Tom")

    def test_prompt_and_tool_schema_do_not_tie_occupants_to_payment_choice(self):
        soul = (ROOT / "docker/hermes-staging/SOUL.md").read_text()
        self.assertNotIn("no guests array", soul)
        self.assertNotIn("omit `guests`", soul)
        self.assertNotIn("only for a link each", soul)
        self.assertIn(REPLY, soul)
        schema = self.tool["schema"]["parameters"]["properties"]["guests"]
        self.assertIn("including full payment", schema["description"])
        self.assertEqual(schema["items"]["required"], ["name"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
