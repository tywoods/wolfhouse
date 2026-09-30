"""Offline ordinary dispatch -> real payment tool -> real handoff lifecycle.

Only urllib and the adapter's send boundary are synthetic; this proves notice
content/order and correction, NOT WhatsApp provider delivery or real Staff SQL.
"""
import asyncio
from email.message import Message
import io
import json
import os
from pathlib import Path
import re
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[4]
sys.path[:0] = [str(ROOT / "docker/hermes-staging"), str(Path(__file__).resolve().parents[1])]
import wolfhouse_staff_api as plugin
from wolfhouse import explicit_human_handoff as handoff


class PaymentFailureOrdinaryHandoffTests(unittest.TestCase):
    def soul_payment_report_reason(self, tenant):
        directory = "hermes-sunset" if tenant == "sunset" else "hermes-staging"
        soul = (ROOT / "docker" / directory / "SOUL.md").read_text()
        paragraph = next(line for line in soul.splitlines()
                         if line.startswith("**Payment failure — honest human help (hard):**"))
        instruction = paragraph.split("If the guest says their payment failed or their card was declined,", 1)[1]
        self.assertIn("read payment status for the known booking", instruction)
        self.assertIn("Unless tool truth resolves the issue as already paid/no amount due", instruction)
        reasons = re.findall(r"call \*\*flag_needs_human\*\* with reason `([^`]+)`", instruction)
        self.assertEqual(len(reasons), 1, "Exercise the exact, unambiguous SOUL-prescribed reason")
        return reasons[0]

    def run_case(self, tenant, receipt, message="The payment link failed", *,
                 soul_report=False, cancel=False, nonpayment_reason=None):
        timeline, sent, violations = [], [], []
        phone = "99900000001"
        reason = self.soul_payment_report_reason(tenant) if soul_report else nonpayment_reason
        workers = []
        ack_started, ack_release = asyncio.Event(), asyncio.Event()
        def forbidden(*args, **kwargs):
            violations.append("unexpected network")
            raise AssertionError("NETWORK FORBIDDEN")
        def transport(request, timeout):
            if urlsplit(request.full_url).netloc != "staff.invalid":
                return forbidden()
            path = urlsplit(request.full_url).path
            if path.endswith("/conversation/needs-human"):
                payload = json.loads(request.data)
                if payload.get("client_slug") != tenant or payload.get("phone") != "+" + phone:
                    violations.append("handoff identity mismatch")
                self.assertEqual(payload["client_slug"], tenant)
                self.assertEqual(payload["phone"], "+" + phone)
                self.assertNotIn("conversation_id", payload)
                if reason is not None:
                    self.assertEqual(payload["reason"], reason)
                timeline.append("persist")
                data = receipt
            elif path.endswith(("/payment-status", "/payments/status")) and soul_report:
                timeline.append("payment_status_pending")
                data = {"success": True, "payment_status": "pending", "paid": False}
            elif path.endswith(("/create-stripe-link", "/sunset/payment-link")):
                timeline.append("payment_attempt")
                data = {"success": False, "error": "offline injected payment failure"}
            else:
                return forbidden()
            if isinstance(data, Exception):
                raise data
            return io.BytesIO(json.dumps(data).encode())
        class Adapter:
            async def send(self, chat_id, content, **kwargs):
                sent.append((chat_id, content))
                timeline.append("notice")
                if cancel:
                    ack_started.set()
                    await ack_release.wait()
                return SimpleNamespace(success=True, message_id="offline-notice")
        def worker():
            if soul_report:
                fn = plugin.get_sunset_payment_status if tenant == "sunset" else plugin.get_payment_status
                status = json.loads(fn({"booking_code": "OFFLINE"}))
                self.assertIs(status["success"], True)
                self.assertIs(status["payment_confirmed"], False)
                self.assertEqual(timeline, ["payment_status_pending"])
            if reason is not None:
                return json.loads(plugin.flag_needs_human({
                    "reason": reason, "phone": "34999999999", "client_slug": "other",
                    "conversation_id": "other-conversation",
                }))
            fn = plugin.create_sunset_payment_link if tenant == "sunset" else plugin.create_payment_link
            params = {"payment_id": "offline-id", "booking_code": "OFFLINE", "phone": "other-phone"}
            return json.loads(fn(params))
        async def dispatch(event):
            work = asyncio.create_task(asyncio.to_thread(worker))
            workers.append(work)
            result = await asyncio.shield(work)
            self.assertTrue(handoff.suppress_ordinary_handoff_reply(phone))
            return result
        async def run():
            event = SimpleNamespace(text=message, source=SimpleNamespace(chat_id=phone))
            task = asyncio.create_task(handoff.dispatch_with_handoff_notice(
                event, SimpleNamespace(adapter=Adapter(), dispatch_fn=dispatch)))
            try:
                if cancel:
                    await asyncio.wait_for(ack_started.wait(), 2)
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                    ack_release.set()
                    return await asyncio.wait_for(asyncio.shield(workers[0]), 2)
                return await asyncio.wait_for(asyncio.shield(task), 3)
            finally:
                ack_release.set()
                if not task.done():
                    task.cancel()
                await asyncio.wait_for(asyncio.gather(task, *workers, return_exceptions=True), 3)
        env = {"LUNA_CLIENT_SLUG": tenant, "HERMES_ROLE": "sunset-luna" if tenant == "sunset" else "luna",
               "LUNA_BOT_INTERNAL_TOKEN": "offline-fixture", "SUNSET_INGRESS_LOCATION_ID": "sunset-somo",
               "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff.invalid"}
        with patch.dict(os.environ, env, clear=True), patch("urllib.request.urlopen", side_effect=transport), \
             patch("socket.socket.connect", side_effect=forbidden), patch("socket.create_connection", side_effect=forbidden):
            handoff.clear_local_automation_blocked(phone)
            try:
                result = asyncio.run(run())
                self.assertFalse(violations)
                self.assertTrue(all(target == phone for target, _ in sent))
                if reason is not None:
                    self.assertEqual(handoff.is_local_automation_blocked(phone), not result["success"])
                return result, timeline, [text for _, text in sent]
            finally:
                handoff.clear_local_automation_blocked(phone)

    def test_soul_reported_payment_notice_before_successful_persist(self):
        for tenant in ("wolfhouse-somo", "sunset"):
            for message, expected in (
                ("My payment failed; the card was declined",
                 "The payment issue you reported is still unresolved. I’m asking the team to help."),
                ("El pago falló",
                 "El problema de pago que comentas sigue sin resolverse. Estoy pidiendo ayuda al equipo."),
                ("Vorrei aiuto con il pagamento",
                 "Il problema di pagamento che hai segnalato non è ancora risolto. Sto chiedendo aiuto al team."),
            ):
                with self.subTest(tenant=tenant, message=message):
                    result, timeline, sent = self.run_case(
                        tenant, {"success": True, "needs_human": True}, message, soul_report=True)
                    self.assertIs(result["success"], True)
                    self.assertIs(result["needs_human"], True)
                    self.assertIs(result["ack_sent"], True)
                    self.assertEqual(timeline, ["payment_status_pending", "notice", "persist"])
                    self.assertEqual(sent, [expected])

    def test_soul_reported_payment_notice_with_failed_or_malformed_persistence(self):
        for tenant in ("wolfhouse-somo", "sunset"):
            for receipt in ({"success": False, "needs_human": False},
                            {"success": True, "needs_human": "false"},
                            {"success": True, "needs_human": 1},
                            {"success": "true", "needs_human": True},
                            {"success": 1, "needs_human": True},
                            {"success": True, "needs_human": False},
                            {}, [], None, False, "unavailable"):
                with self.subTest(tenant=tenant, receipt=receipt):
                    result, timeline, sent = self.run_case(
                        tenant, receipt, "My payment failed; the card was declined", soul_report=True)
                    self.assertIs(result["success"], False)
                    self.assertIs(result["failure_notice_sent"], True)
                    self.assertIs(result["local_fail_closed"], True)
                    self.assertIs(result["needs_operator_reconciliation"], True)
                    self.assertEqual(timeline, ["payment_status_pending", "notice", "persist", "notice"])
                    self.assertEqual(sent[0], "The payment issue you reported is still unresolved. I’m asking the team to help.")
                    self.assertIn("couldn’t confirm the handoff", sent[1])
                    self.assertIn("contact reception directly", sent[1])

    def test_soul_reported_payment_late_notice_receipt_cannot_persist_after_cancellation(self):
        for tenant in ("wolfhouse-somo", "sunset"):
            with self.subTest(tenant=tenant):
                result, timeline, sent = self.run_case(
                    tenant, {"success": True, "needs_human": True},
                    "My payment failed; the card was declined", soul_report=True, cancel=True)
                self.assertIs(result["success"], False)
                self.assertEqual(result["error"], "handoff_scope_closed")
                self.assertIs(result["ack_sent"], True)
                self.assertIs(result["local_fail_closed"], True)
                self.assertIs(result["needs_operator_reconciliation"], True)
                self.assertEqual(timeline, ["payment_status_pending", "notice"])
                self.assertEqual(sent, ["The payment issue you reported is still unresolved. I’m asking the team to help."])

    def test_plain_nonpayment_business_error_preserves_generic_ordinary_notice(self):
        for tenant in ("wolfhouse-somo", "sunset"):
            with self.subTest(tenant=tenant):
                result, timeline, sent = self.run_case(
                    tenant, {"success": True, "needs_human": True}, "My booking details are wrong",
                    nonpayment_reason="business_tool_error")
                self.assertIs(result["success"], True)
                self.assertEqual(timeline, ["notice", "persist"])
                self.assertEqual(sent, ["Of course — I’m looping in a teammate now and they’ll take over from here."])

    def test_payment_notice_explains_failed_step_before_persist_without_claiming_success(self):
        for tenant in ("wolfhouse-somo", "sunset"):
            with self.subTest(tenant=tenant):
                result, timeline, sent = self.run_case(tenant, {"success": True, "needs_human": True})
                self.assertIs(result["handoff_confirmed"], True)
                self.assertEqual(timeline, ["payment_attempt", "notice", "persist"])
                self.assertEqual(sent, ["I couldn’t complete the payment step. I’m asking the team to help."])
                self.assertNotIn("they’ll take over", sent[0])

    def test_malformed_or_failed_receipt_corrects_notice_before_suppressing_final(self):
        for tenant in ("wolfhouse-somo", "sunset"):
            for receipt in ({"success": True, "needs_human": "false"},
                            {"success": True, "needs_human": 1},
                            {"success": "true", "needs_human": True},
                            {"success": 1, "needs_human": True},
                            {"success": True, "needs_human": False},
                            {"success": False, "needs_human": False}):
                with self.subTest(tenant=tenant, receipt=receipt):
                    result, timeline, sent = self.run_case(tenant, receipt)
                    self.assertIs(result["handoff_confirmed"], False)
                    # Failed receipts must not expose a confirmed persistence signal.
                    self.assertIs(result["handoff"]["needs_human"], False)
                    self.assertIsNone(result["handoff"].get("handoff_reason"))
                    self.assertIs(result["handoff"].get("failure_notice_sent"), True)
                    self.assertEqual(timeline, ["payment_attempt", "notice", "persist", "notice"])
                    self.assertIn("couldn’t confirm the handoff", sent[-1])
                    self.assertIn("contact reception directly", sent[-1])

    def test_persist_transport_errors_correct_notice_before_final_suppression(self):
        for tenant in ("wolfhouse-somo", "sunset"):
            for body in ([], None, "unavailable", False):
                with self.subTest(tenant=tenant, body=body):
                    receipt = HTTPError("https://staff.invalid", 503, "offline error", Message(),
                                        io.BytesIO(json.dumps(body).encode()))
                    result, timeline, sent = self.run_case(tenant, receipt)
                    self.assertFalse(result["handoff_confirmed"])
                    self.assertFalse(result["handoff"]["needs_human"])
                    self.assertTrue(result["handoff"]["failure_notice_sent"])
                    self.assertEqual(timeline, ["payment_attempt", "notice", "persist", "notice"])
                    self.assertIn("couldn’t confirm the handoff", sent[-1])
                    self.assertIn("contact reception directly", sent[-1])

    def test_payment_notice_language_and_existing_human_ack_are_preserved(self):
        for message, expected in (
            ("El pago falló", "No he podido completar el paso de pago. Estoy pidiendo ayuda al equipo."),
            ("Vorrei aiuto con il pagamento", "Non sono riuscita a completare il passaggio di pagamento. Sto chiedendo aiuto al team."),
        ):
            with self.subTest(message=message):
                _, _, sent = self.run_case("sunset", {"success": True, "needs_human": True}, message)
                self.assertEqual(sent, [expected])
        self.assertEqual(handoff.acknowledgement_for("Can I speak to a human?"),
                         "Of course — I’m looping in a teammate now and they’ll take over from here.")


if __name__ == "__main__":
    unittest.main()
