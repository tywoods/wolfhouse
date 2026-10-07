"""Offline preservation regressions for reconciled live-only behavior."""
from pathlib import Path
import asyncio
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from wolfhouse import crowsnest_guest_door as door
from wolfhouse import simulate_core as core

ROOT = Path(__file__).resolve().parents[1]
SOUL = ROOT / "SOUL.md"
PLUGIN = ROOT / "plugins" / "wolfhouse_staff_api" / "__init__.py"
PASS4_SOURCE_ONLY = (
    "gateway/admission_lock_owner.py",
    "gateway/identity_admission_owner.py",
    "gateway/terminal_operation_journal.py",
    "proposed_admission_lock_adapter.py",
)


class LivePreservation(unittest.IsolatedAsyncioTestCase):
    def test_soul_preserves_safe_live_rules_and_atomic_owner_rules(self):
        text = SOUL.read_text()
        for phrase in (
            "**Past dates (hard):**",
            "**Per-guest payment-link labels:**",
            "**Full names in individual guest records:**",
            "**Accepted unchanged priced offer:**",
            "**Revalidation preserves consent; operation claims require evidence:**",
        ):
            self.assertIn(phrase, text)
        self.assertIn("preserve the selected catalog activity in `catalog_selections`", text)
        self.assertNotIn("create_booking_from_plan using the **camp dates**", text)
        self.assertIn("**After pay intent, never ask gender or group composition**", text)

    def test_security_and_owner_regressions_remain_rejected(self):
        plugin = PLUGIN.read_text()
        for phrase in (
            "staff_transport_denial",
            "booking_create_refused",
            '"availability": data.get("availability")',
            '"offer_revision": data.get("offer_revision")',
            "_catalog_selection_refusal",
            "dispatch_recovery",
            "split_payment_requested",
            "_quote_owner_handler",
            "accepted_quote.install_owner_hook",
            "returned Admin package_min_nights",
        ):
            self.assertIn(phrase, plugin)
        self.assertNotIn("malibu, uluwatu, waimea for 7+ nights", plugin)

    def test_pass4_proposed_modules_are_not_shipped(self):
        for relative in PASS4_SOURCE_ONLY:
            self.assertFalse((ROOT / relative).exists(), relative)

    def test_stable_message_identity_is_validated_and_forwarded(self):
        self.assertEqual(door._stable_sim_message_id("wamid.live-123"), "wamid.live-123")
        self.assertTrue(door._stable_sim_message_id(None).startswith("crowsnest.sim."))
        with self.assertRaisesRegex(ValueError, "invalid_message_id"):
            door._stable_sim_message_id("bad id")

    async def test_authenticated_simulate_route_forwards_message_identity_fail_closed(self):
        routes = {}
        core.register_simulate_route(SimpleNamespace(router=SimpleNamespace(add_post=lambda p, f: routes.update({p: f}))))
        dispatch = AsyncMock(return_value={"ok": True})
        web = SimpleNamespace(json_response=lambda data, status=200: (status, data))

        async def request_json():
            return {"thread": "sim:ordinary", "text": "hello", "message_id": "wamid.live-123"}

        request = SimpleNamespace(headers={"X-Luna-Bot-Token": "offline"}, json=request_json)
        with patch.dict(sys.modules, {"aiohttp": SimpleNamespace(web=web)}), patch.dict(os.environ, {"LUNA_BOT_INTERNAL_TOKEN": "offline"}), patch.object(core, "run_simulated_turn", dispatch):
            response = await routes[core.SIMULATE_PATH](request)
            self.assertEqual(response[0], 200)
            self.assertEqual(dispatch.call_args.kwargs["message_id"], "wamid.live-123")
            self.assertFalse(dispatch.call_args.kwargs["allow_writes"])

            malformed = SimpleNamespace(
                headers={"X-Luna-Bot-Token": "offline"},
                json=AsyncMock(return_value={"thread": "15555550123", "text": "hi", "message_id": "bad id"}),
            )
            rejected = await routes[core.SIMULATE_PATH](malformed)
            self.assertEqual(rejected[0], 400)
            self.assertEqual(dispatch.call_count, 1)


if __name__ == "__main__":
    unittest.main()
