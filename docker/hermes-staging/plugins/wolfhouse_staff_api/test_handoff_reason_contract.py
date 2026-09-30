"""P3-3 offline Hermes handoff contract; synthetic HTTP, no Staff DB proof.

Run: python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_handoff_reason_contract.py -v
Real plugin/transport; only HTTP is substituted. Socket tripwires forbid live I/O.
"""
import io
import json
import os
from pathlib import Path
import sys
import unittest
from typing import Any
from unittest.mock import patch
from urllib.parse import urlsplit

STAGING = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(STAGING), str(STAGING / "plugins")]
import wolfhouse_staff_api as plugin
from wolfhouse import explicit_human_handoff as handoff


class HandoffReasonContractTests(unittest.TestCase):
    def setUp(self):
        for guard in (
            patch.dict(os.environ, {
                "LUNA_CLIENT_SLUG": "wolfhouse-somo",
                "LUNA_BOT_INTERNAL_TOKEN": "offline-fixture-not-a-credential",
                "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff.invalid",
                "WOLFHOUSE_WHATSAPP_GUEST_PHONE": "+" + "999" + "000000000001",
                "SUNSET_INGRESS_LOCATION_ID": "sunset-somo",
            }, clear=True),
            patch("socket.socket.connect", side_effect=AssertionError("NETWORK FORBIDDEN")),
            patch("socket.create_connection", side_effect=AssertionError("NETWORK FORBIDDEN")),
        ):
            guard.start()
            self.addCleanup(guard.stop)
        self.calls = []
        self.receipt: Any = {"success": True, "needs_human": True,
                        "conversation_id": "offline-conversation", "conversation_paused": True}
        transport = patch("urllib.request.urlopen", side_effect=self.transport)
        transport.start()
        self.addCleanup(transport.stop)

    def transport(self, request, timeout):
        self.assertEqual(urlsplit(request.full_url).netloc, "staff.invalid")
        self.assertEqual(urlsplit(request.full_url).path, "/staff/bot/conversation/needs-human")
        self.assertEqual(timeout, 25)
        self.calls.append(json.loads(request.data))
        if isinstance(self.receipt, Exception):
            raise self.receipt
        return io.BytesIO(self.receipt if isinstance(self.receipt, bytes)
                          else json.dumps(self.receipt).encode())

    def test_blank_or_nontext_reason_rejected_before_ack_or_persistence(self):
        for tenant in ("wolfhouse-somo", "sunset"):
            os.environ["LUNA_CLIENT_SLUG"] = tenant
            for params in ({}, {"reason": None}, {"reason": ""}, {"reason": " \t\n\u00a0"},
                           {"reason": False}, {"reason": 7}, {"reason": []}, {"reason": {}}):
                with self.subTest(tenant=tenant, params=params), patch.object(
                    handoff, "persist_ordinary_handoff", wraps=handoff.persist_ordinary_handoff
                ) as persist:
                    result = json.loads(plugin.flag_needs_human(params))
                    self.assertFalse(result["success"])
                    self.assertFalse(result["needs_human"])
                    self.assertIn("handoff_reason_required", result["blocked_reasons"])
                    self.assertIsNone(result.get("handoff_reason"))
                    persist.assert_not_called()
                    self.assertEqual(self.calls, [])


    def test_success_retains_submitted_reason_when_staff_omits_reason(self):
        reason = "business_tool_error: payment provider unavailable — revisión necesaria"
        for tenant in ("wolfhouse-somo", "sunset"):
            os.environ["LUNA_CLIENT_SLUG"] = tenant
            for returned in (None, "", " \t", "human_requested: Staff canonical context"):
                with self.subTest(tenant=tenant, returned=returned):
                    self.calls.clear()
                    self.receipt["handoff_reason"] = returned
                    result = json.loads(plugin.flag_needs_human({
                        "reason": "  " + reason + "  ", "client_slug": "untrusted",
                        "conversation_id": "untrusted-id", "phone": "+349****9999",
                    }))
                    self.assertTrue(result["success"])
                    self.assertTrue(result["needs_human"])
                    self.assertEqual(result["handoff_reason"], returned.strip() if returned and returned.strip() else reason)
                    self.assertEqual(len(self.calls), 1)
                    self.assertEqual(self.calls[0]["reason"], reason)
                    self.assertEqual(self.calls[0]["client_slug"], tenant)
                    self.assertEqual(self.calls[0]["phone"], os.environ["WOLFHOUSE_WHATSAPP_GUEST_PHONE"])
                    self.assertNotIn("conversation_id", self.calls[0])


    def test_failed_receipt_never_claims_handoff_persistence(self):
        for receipt in (
            {"success": False, "needs_human": True},
            {"success": True, "needs_human": False},
            {"needs_human": True},
            {"success": "false", "needs_human": True},
            TimeoutError("offline timeout"), b"not json", b"[]",
        ):
            with self.subTest(receipt=repr(receipt)):
                self.calls.clear()
                self.receipt = (dict(receipt, handoff_reason="stale reason", conversation_paused=True)
                                if isinstance(receipt, dict) else receipt)
                result = json.loads(plugin.flag_needs_human({"reason": "complaint: unresolved issue"}))
                self.assertFalse(result["success"])
                self.assertFalse(result["needs_human"])
                self.assertFalse(result["conversation_paused"])
                self.assertIsNone(result.get("handoff_reason"))
                self.assertTrue(result["staff_review_needed"])
                self.assertFalse(result["do_not_escalate"])
                self.assertEqual(len(self.calls), 1)


if __name__ == "__main__":
    unittest.main()
