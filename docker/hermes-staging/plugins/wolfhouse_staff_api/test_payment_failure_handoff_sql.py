"""OFFLINE Python -> Staff handler -> real PGlite handoff SQL, no live transports.

Run from the worktree:
  node scripts/verify-luna-payment-failure-handoff-sql.js
Optional LUNA_PAYMENT_SQL_EVIDENCE=/absolute/report.json saves full readbacks.
Payment responses are synthetic transport fixtures, NOT payment execution proof.
The Staff router/auth middleware and ordinary-turn acknowledgement/send adapter
are outside this boundary. The real handler gets a synthetic bound principal.
The real resolver's notification dependency is suppressed; SQL is never mocked.
"""
import hashlib
from email.message import Message
import io
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[4]
BRIDGE = ROOT / "scripts/verify-luna-payment-failure-handoff-sql.js"
PHONE = "+999" + "00000001"
OTHER_PHONE = "+999" + "00000002"
MISSING_PHONE = "+999" + "00000003"
EVIDENCE_PATH = os.environ.get("LUNA_PAYMENT_SQL_EVIDENCE")
NODE = shutil.which("node")
SOURCE_FILES = [Path(__file__), BRIDGE, Path(__file__).with_name("__init__.py"),
                ROOT / "scripts/staff-query-api.js",
                ROOT / "scripts/lib/luna-guest-handoff-persist.js",
                ROOT / "scripts/lib/staff-bot-pause-sql.js",
                ROOT / "scripts/lib/staff-bot-request-tenant-bind.js"]


def source_hashes():
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in SOURCE_FILES}


# Import genuine repository modules, including ordinary handoff (unbound turn)
# and research guard; do not install fake wolfhouse modules in sys.modules.
sys.path.insert(0, str(ROOT / "docker/hermes-staging"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class PaymentFailureHandoffSqlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not NODE:
            raise RuntimeError("Node and @electric-sql/pglite are required; no skip/fake SQL fallback")
        cls.evidence = {"boundary": __doc__, "cases": [], "source_sha256": source_hashes()}
        cls.node = subprocess.Popen(
            [NODE, str(BRIDGE), "--bridge"], cwd=ROOT,
            env={k: v for k, v in os.environ.items() if k in {"PATH", "NODE_PATH", "LANG"}},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        cls.addClassCleanup(cls.close_bridge)

    @classmethod
    def close_bridge(cls):
        assert cls.node.stdin is not None and cls.node.stdout is not None and cls.node.stderr is not None
        cls.node.stdin.close()
        try:
            code = cls.node.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.node.kill()
            cls.node.wait()
            raise AssertionError("SQL bridge did not stop")
        stderr = cls.node.stderr.read()
        cls.node.stdout.close()
        cls.node.stderr.close()
        cls.evidence["bridge_exit_code"] = code
        cls.evidence["bridge_stderr"] = stderr
        cls.evidence["source_sha256_after"] = source_hashes()
        cls.evidence["sources_stable_during_run"] = (
            cls.evidence["source_sha256"] == cls.evidence["source_sha256_after"])
        if EVIDENCE_PATH:
            output = Path(EVIDENCE_PATH)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(cls.evidence, indent=2, default=str) + "\n")
        if code != 0 or stderr:
            raise AssertionError(f"SQL bridge failed: exit={code} stderr={stderr}")
        if not cls.evidence["sources_stable_during_run"]:
            raise AssertionError("Source changed during execution: rerun integrated proof")

    def bridge(self, **message):
        assert self.node.stdin is not None and self.node.stdout is not None
        self.node.stdin.write(json.dumps(message) + "\n")
        self.node.stdin.flush()
        with selectors.DefaultSelector() as selector:
            selector.register(self.node.stdout, selectors.EVENT_READ)
            self.assertTrue(selector.select(timeout=25), "bounded SQL bridge timeout")
        raw = self.node.stdout.readline()
        self.assertTrue(raw, "SQL bridge unexpectedly exited")
        response = json.loads(raw)
        self.assertTrue(response.get("ok"), response)
        return response["result"]

    def setUp(self):
        self.network_attempts = []
        self.transport_violations = []
        def forbid(*args, **kwargs):
            self.network_attempts.append("unexpected network")
            raise AssertionError("NETWORK FORBIDDEN")
        for guard in (
            patch.dict(os.environ, {
                "LUNA_BOT_INTERNAL_TOKEN": "offline-fixture-not-a-credential",
                "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff.invalid",
                "WOLFHOUSE_WHATSAPP_GUEST_PHONE": PHONE,
                "SUNSET_INGRESS_LOCATION_ID": "sunset-somo",
            }, clear=True),
            patch("socket.socket.connect", side_effect=forbid),
            patch("socket.socket.connect_ex", side_effect=forbid),
            patch("socket.socket.bind", side_effect=forbid),
            patch("socket.socket.sendto", side_effect=forbid),
            patch("socket.create_connection", side_effect=forbid),
            patch("http.client.HTTPConnection.connect", side_effect=forbid),
            patch("http.client.HTTPSConnection.connect", side_effect=forbid),
            patch("urllib.request.urlopen", side_effect=self.transport),
        ):
            guard.start()
            self.addCleanup(guard.stop)
        import wolfhouse_staff_api
        from wolfhouse.explicit_human_handoff import ordinary_handoff_phone
        self.plugin = wolfhouse_staff_api
        self.assertEqual(ordinary_handoff_phone(), "", "no ack/send-capable turn installed")

    def begin(self, tenant, mode="failure", unavailable=False):
        self.before = self.bridge(op="reset")
        self.tenant, self.mode, self.unavailable = tenant, mode, unavailable
        self.calls, self.handler_responses = [], []
        os.environ["LUNA_CLIENT_SLUG"] = tenant
        os.environ["WOLFHOUSE_WHATSAPP_GUEST_PHONE"] = PHONE
        self.tool = "create_sunset_payment_link" if tenant == "sunset" else "create_payment_link"
        self.params = {"booking_code": "OFFLINE-SQL", "payment_id": "offline-payment",
                       "client_slug": "wolfhouse-somo" if tenant == "sunset" else "sunset",
                       "phone": OTHER_PHONE, "guest_phone": OTHER_PHONE,
                       "conversation_id": "20000000-0000-4000-8000-000000000011"}

    def transport(self, request, timeout):
        try:
            return self._transport(request, timeout)
        except AssertionError as error:
            # _post_bot catches exceptions: retain a separate fatal ledger so
            # a forbidden request cannot masquerade as the injected failure.
            self.transport_violations.append(str(error))
            raise

    def _transport(self, request, timeout):
        self.assertEqual(urlsplit(request.full_url).netloc, "staff.invalid")
        self.assertEqual(request.method, "POST")
        self.assertEqual(timeout, 25)
        route = urlsplit(request.full_url).path
        payload = json.loads(request.data)
        self.calls.append({"path": route, "payload": payload})
        self.assertEqual(payload["client_slug"], self.tenant)
        if route == "/staff/bot/conversation/needs-human":
            self.assertNotIn("conversation_id", payload)
            self.assertEqual(payload["phone"], os.environ["WOLFHOUSE_WHATSAPP_GUEST_PHONE"])
            self.assertTrue(payload["reason"].startswith("business_tool_error:"), payload)
            response = self.bridge(op="handoff", raw_body=request.data.decode(),
                                   trusted_client=self.tenant, unavailable=self.unavailable)
            self.handler_responses.append(response)
            raw = json.dumps(response["body"]).encode()
            if response["status"] >= 400:
                raise HTTPError(request.full_url, response["status"], "offline Staff handler rejection", Message(), io.BytesIO(raw))
            return io.BytesIO(raw)
        expected = "/staff/bot/sunset/payment-link" if self.tenant == "sunset" else "/staff/bot/payments/offline-payment/create-stripe-link"
        self.assertEqual(route, expected, "all other endpoints forbidden")
        policy_receipts = {
            "stripe_disabled": {"success": False, "stripe_links_enabled": False,
                                "error": "Stripe link creation is disabled. Set STRIPE_LINKS_ENABLED=true to enable."},
            "booking_disabled": {"success": False, "bot_booking_enabled": False,
                                 "error": "Bot booking is disabled. Set BOT_BOOKING_ENABLED=true to enable."},
            "staff_disabled": {"success": False, "error": "staff_actions_disabled"},
            "sunset_stripe_disabled": {"success": False, "error": "stripe_links_disabled"},
            "provider_restricted": {"success": False, "error": "payment_provider_not_allowed"},
        }
        if self.mode in policy_receipts:
            raise HTTPError(request.full_url, 403, "offline explicit policy denial", Message(),
                            io.BytesIO(json.dumps(policy_receipts[self.mode]).encode()))
        if self.mode == "http503":
            raise HTTPError(request.full_url, 503, "offline provider unavailable", Message(),
                            io.BytesIO(b'{"success":false,"error":"provider unavailable"}'))
        if self.mode == "timeout":
            raise TimeoutError("offline payment transport timeout")
        if self.mode == "malformed":
            return io.BytesIO(b"not JSON")
        fixture = {"success": False, "error": "offline provider unavailable"}
        if self.mode == "success":
            fixture = {"success": True, "guest_payment_url": "https://payments.invalid/pay/OFFLINE-SQL",
                       "booking_code": "OFFLINE-SQL", "payment_id": "offline-payment"}
        elif self.mode == "missing_url":
            fixture = {"success": True, "payment_id": "offline-payment"}
        return io.BytesIO(json.dumps(fixture).encode())

    def invoke(self):
        return json.loads(getattr(self.plugin, self.tool)(self.params))

    def snapshot(self, result, label):
        state = self.bridge(op="snapshot")
        record = {"name": f"{self.tenant}/{label}", "tool_result": result,
                  "requests": list(self.calls), "staff_responses": list(self.handler_responses),
                  "before": self.before, "persisted": state,
                  "python_network_attempts": list(self.network_attempts),
                  "transport_violations": list(self.transport_violations), "passed": False}
        self.evidence["cases"].append(record)
        self.assertEqual(self.network_attempts, [])
        self.assertEqual(self.transport_violations, [])
        self.assertEqual(state["network_attempts"], [])
        self.assertEqual(state["sql_errors"], [], "owner-swallowed SQL errors are fatal")
        return state, record

    def assert_persisted(self, state, result):
        target = [r for r in state["conversations"] if r["slug"] == self.tenant and r["phone"] == PHONE][0]
        self.assertTrue(target["needs_human"], "payment failure must reach real Staff SQL")
        self.assertTrue(target["needs_human_transition_id"])
        reason = target["metadata"]["needs_human_reason"]
        self.assertTrue(reason.startswith("business_tool_error:"))
        self.assertEqual(target["metadata"]["luna_handoff_reason"], reason)
        self.assertTrue(target["metadata"]["luna_handoff_at"])
        self.assertTrue(target["metadata"]["preserve_me"])
        unchanged = [r for r in state["conversations"] if r["id"] != target["id"]]
        expected = [r for r in self.before["conversations"] if r["id"] != target["id"]]
        self.assertEqual(unchanged, expected, "same phone in other tenant and model-supplied victim stay untouched")
        self.assertEqual(len(state["handoffs"]), 1)
        handoff = state["handoffs"][0]
        self.assertEqual((handoff["slug"], handoff["conversation_id"], handoff["reason_code"], handoff["status"]),
                         (self.tenant, target["id"], reason, "open"))
        self.assertEqual(handoff["metadata"]["source"], "luna_flag_needs_human")
        self.assertEqual(len(state["pauses"]), 0 if self.tenant == "sunset" else 1)
        if self.tenant != "sunset":
            pause = state["pauses"][0]
            self.assertEqual((pause["client_slug"], pause["conversation_id"], pause["paused"]),
                             (self.tenant, target["id"], True))
            self.assertEqual(pause["pause_reason"], "needs_human:" + reason)
        self.assertEqual(len(state["suppressed_notifications"]), 1)
        self.assertIs(result["success"], False, "handoff must not turn payment failure into payment success")
        self.assertIs(result["needs_human"], True)
        self.assertIs(result["handoff_confirmed"], True)
        self.assertEqual(result["handoff"]["conversation_paused"], self.tenant != "sunset")
        self.assertIsNone(result.get("secure_payment_url"))
        self.assertNotEqual(result.get("next_action"), "send_secure_payment_link")
        self.assertIsNot(result.get("payment_confirmed"), True)
        self.assertTrue(state["sql"], "actual owner SQL must execute")

    def test_01_payment_failure_persists_and_isolates(self):
        for tenant in ("sunset", "wolfhouse-somo"):
            with self.subTest(tenant=tenant):
                self.begin(tenant)
                result = self.invoke()
                state, record = self.snapshot(result, "payment-failure")
                self.assert_persisted(state, result)
                self.assertEqual(len(self.handler_responses), 1)
                record["passed"] = True

    def test_02_success_has_no_handoff_or_sql(self):
        for tenant in ("sunset", "wolfhouse-somo"):
            with self.subTest(tenant=tenant):
                self.begin(tenant, "success")
                result = self.invoke()
                state, record = self.snapshot(result, "success")
                self.assertTrue(result["success"])
                self.assertEqual(result["secure_payment_url"], "https://payments.invalid/pay/OFFLINE-SQL")
                self.assertEqual(self.handler_responses, [])
                self.assertEqual(state, self.before)
                record["passed"] = True

    def test_03_transport_failures_and_missing_url_persist(self):
        for tenant in ("sunset", "wolfhouse-somo"):
            for mode in ("http503", "timeout", "malformed", "missing_url"):
                with self.subTest(tenant=tenant, mode=mode):
                    self.begin(tenant, mode)
                    result = self.invoke()
                    state, record = self.snapshot(result, mode)
                    self.assert_persisted(state, result)
                    self.assertEqual(len(self.handler_responses), 1)
                    record["passed"] = True

    def test_04_missing_conversation_or_database_unavailable_never_confirms(self):
        for tenant in ("sunset", "wolfhouse-somo"):
            for failure in ("conversation_missing", "database_unavailable"):
                with self.subTest(tenant=tenant, failure=failure):
                    self.begin(tenant, unavailable=failure == "database_unavailable")
                    if failure == "conversation_missing":
                        os.environ["WOLFHOUSE_WHATSAPP_GUEST_PHONE"] = MISSING_PHONE
                    result = self.invoke()
                    state, record = self.snapshot(result, failure)
                    self.assertFalse(result["success"])
                    self.assertIs(result["handoff_confirmed"], False)
                    self.assertIs(result["needs_human"], False)
                    self.assertFalse(result["handoff"]["success"])
                    self.assertEqual(self.handler_responses[0]["status"], 404 if failure == "conversation_missing" else 500)
                    for key in ("conversations", "handoffs", "pauses", "suppressed_notifications"):
                        self.assertEqual(state[key], self.before[key])
                    self.assertIsNone(result.get("secure_payment_url"))
                    self.assertNotEqual(result.get("next_action"), "send_secure_payment_link")
                    # Cannot assert model wording; enforce the tool's deterministic
                    # guest-safe action does not claim the handoff happened.
                    guest_copy = result.get("guest_safe_next_action") or ""
                    self.assertNotRegex(guest_copy, r"(?i)I.ve (?:flagged|passed|sent|handed)|team (?:has been|is) notified")
                    self.assertRegex(guest_copy, r"(?i)(?:can[’']t|cannot) promise",
                                     "failed persistence must explicitly withhold a handoff promise")
                    record["passed"] = True

    def test_05_repeated_failure_keeps_one_handoff_transition_and_pause(self):
        for tenant in ("sunset", "wolfhouse-somo"):
            with self.subTest(tenant=tenant):
                self.begin(tenant)
                first = self.invoke()
                initial = self.bridge(op="snapshot")
                second = self.invoke()
                state, record = self.snapshot(second, "repeat")
                self.assert_persisted(state, second)
                self.assertTrue(first["handoff_confirmed"])
                self.assertEqual(state["conversations"], initial["conversations"])
                self.assertEqual(state["handoffs"], initial["handoffs"])
                self.assertEqual(state["pauses"], initial["pauses"])
                self.assertEqual(len(self.handler_responses), 2)
                record["passed"] = True

    def test_06_handler_rejects_cross_tenant_uuid_and_malformed_body(self):
        for tenant in ("sunset", "wolfhouse-somo"):
            with self.subTest(tenant=tenant):
                self.begin(tenant)
                other = next(r for r in self.before["conversations"] if r["slug"] != tenant)
                reply = self.bridge(op="handoff", trusted_client=tenant, raw_body=json.dumps({
                    "client_slug": other["slug"], "conversation_id": other["id"],
                    "reason": "business_tool_error:create_payment_link"}))
                self.assertEqual(reply["status"], 404)
                self.assertFalse(reply["body"]["success"])
                invalid = self.bridge(op="handoff", trusted_client=tenant, raw_body="{broken")
                self.assertEqual(invalid["status"], 400)
                state, record = self.snapshot({"cross_tenant_uuid": reply, "malformed_body": invalid}, "handler-negative-controls")
                for key in ("conversations", "handoffs", "pauses", "suppressed_notifications"):
                    self.assertEqual(state[key], self.before[key])
                record["passed"] = True

    def test_07_actual_policy_denials_leave_handoff_sql_and_state_untouched(self):
        for tenant, modes in (("wolfhouse-somo", ("stripe_disabled", "booking_disabled")),
                              ("sunset", ("staff_disabled", "sunset_stripe_disabled", "provider_restricted"))):
            for mode in modes:
                with self.subTest(tenant=tenant, mode=mode):
                    self.begin(tenant, mode)
                    result = self.invoke()
                    state, record = self.snapshot(result, mode)
                    self.assertEqual(self.handler_responses, [], "policy denial must not request Needs Human")
                    self.assertEqual(state, self.before, "policy denial must not write, pause, or notify")
                    self.assertIs(result.get("do_not_escalate"), True)
                    self.assertIs(result.get("staff_review_needed"), False)
                    self.assertIsNot(result.get("payment_operation_failed"), True)
                    self.assertIsNot(result.get("handoff_confirmed"), True)
                    record["passed"] = True


if __name__ == "__main__":
    unittest.main()
