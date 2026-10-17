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
import urllib.error
from typing import Any
from unittest.mock import patch
from urllib.parse import urlsplit

STAGING = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(STAGING), str(STAGING / "plugins")]
import wolfhouse_staff_api as plugin
from wolfhouse import explicit_human_handoff as handoff


class HandoffReasonContractTests(unittest.TestCase):
    def test_typed_403_handoff_denial_keeps_blocked_reasons(self):
        body = {"success": False, "error": "client_access_denied",
                "reason": "bot_principal_tenant_denied",
                "blocked_reasons": ["tenant_handoff_denied"]}
        error = urllib.error.HTTPError('http://staff/staff/bot/conversation/needs-human',
                                      403, 'Forbidden', {}, io.BytesIO(json.dumps(body).encode()))
        with patch('urllib.request.urlopen', side_effect=error):
            result = plugin._post_bot('/conversation/needs-human', {})
        self.assertEqual(result['status'], 403)
        self.assertEqual(result['blocked_reasons'], ['tenant_handoff_denied'])

    def test_registered_availability_preserves_choice_and_rejects_excluded_selection(self):
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *a, **kw): pass
        registry = Registry()
        plugin.register(registry)
        tool = registry.tools['check_availability']
        args = dict(check_in='2026-11-03', check_out='2026-11-06', guest_count=3,
                    room_type='shared', room_preference='female_only', group_gender='female')
        for key in ('room_preference', 'group_gender', 'guests', 'room_name_hints', 'gender_preference'):
            self.assertIn(key, tool['schema']['parameters']['properties'])
        receipt = dict(success=True, has_enough_beds=True, selected_room_code='M',
                       selected_bed_codes=['M1', 'M2', 'M3'], next_action='ready_for_bot_create',
                       available_beds=[dict(bed_code=f'{prefix}{i}', room_code=prefix, room_type=kind)
                           for prefix, kind in [('M', 'male_only'), ('F', 'female_only')] for i in range(1, 4)])
        with patch.object(plugin, '_post_bot', return_value=receipt) as post:
            result = json.loads(tool['handler'](args))
        self.assertEqual(post.call_args.args[1]['room_preference'], 'female_only')
        self.assertEqual(post.call_args.args[1]['group_gender'], 'female')
        self.assertEqual(result['selected_bed_codes'], [])
        self.assertFalse(result['available'])
        self.assertNotEqual(result['next_action'], 'ready_for_bot_create')
        self.assertFalse(result['staff_review_needed'])

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

    def test_sim9_http_403_preserves_status_without_inventing_missing_conversation(self):
        from urllib.error import HTTPError
        self.receipt = HTTPError('https://staff.invalid', 403, 'Forbidden', {},
                                 io.BytesIO(b'{"error":"tenant_access_denied"}'))
        result = json.loads(plugin.flag_needs_human({'reason': 'complaint: unresolved issue'}))
        self.assertEqual(result.get('status'), 403)
        self.assertEqual(result.get('error'), 'tenant_access_denied')
        self.assertNotIn('conversation_not_found', result['blocked_reasons'])
        self.assertFalse(result['handoff_persisted'])

    def test_tenant_auth_denial_surfaces_subreason_with_explicit_runtime_binding(self):
        from urllib.error import HTTPError
        self.receipt = HTTPError('https://staff.invalid', 403, 'Forbidden', {}, io.BytesIO(
            b'{"success":false,"error":"client_access_denied",'
            b'"reason":"request_tenant_conflict","client_slug":"wolfhouse-somo",'
            b'"requested_client_slug":"stale-alias"}'))
        result = json.loads(plugin.flag_needs_human({'reason': 'complaint'}))
        self.assertEqual(result['tenant_auth_subreason'], 'request_tenant_conflict')
        self.assertEqual(result['error'], 'client_access_denied')
        self.assertEqual(self.calls[0]['client_slug'], 'wolfhouse-somo')

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
