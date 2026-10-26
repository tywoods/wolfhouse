import asyncio
import importlib.util
import unittest
import sys
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "runtime" / "simulator_route.py"
BOOTSTRAP_MODULE = Path(__file__).resolve().parents[1] / "bootstrap.py"
SNAPSHOT = {"ok": True, "revision": "staff-revision-1", "choices": [
    {"kind": "accommodation", "code": "package_none", "label": "Accommodation only", "requirements": {}}
]}


class FakeAgent:
    def __init__(self):
        self.calls = []
        self.results = []

    def run_conversation(self, **kwargs):
        self.calls.append(kwargs)
        if self.results and isinstance(self.results[0], BaseException):
            raise self.results.pop(0)
        text = kwargs["user_message"]
        history = list(kwargs.get("conversation_history") or [])
        messages = history + [
            {"role": "user", "content": text},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": f"call-{len(self.calls)}",
                    "type": "function",
                    "function": {"name": "check_availability", "arguments": '{"guests":2}'},
                }],
            },
            {"role": "tool", "tool_call_id": f"call-{len(self.calls)}", "content": '{"ok":true}'},
            {"role": "assistant", "content": f"reply:{text}"},
        ]
        result = {
            "failed": False,
            "error": None,
            "final_response": f"reply:{text}",
            "messages": messages,
        }
        self.results.append(result)
        return result


class FakeAdapter:
    def __init__(self):
        self.agent = FakeAgent()

    def _check_auth(self, request):
        return None

    def _create_agent(self, **kwargs):
        self.agent_kwargs = kwargs
        return self.agent

    def _bind_api_server_session(self, *, session_key):
        self.bound_session_key = session_key
        return []


class FakeRequest:
    def __init__(self, body, headers=None):
        self.body = body
        self.headers = headers or {}

    async def json(self):
        return self.body


class SimulatorRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(MODULE.parents[1]))
        spec = importlib.util.spec_from_file_location("luna_v3_simulator_route", MODULE)
        if spec is None or spec.loader is None:
            raise RuntimeError("unable to load simulator route")
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)
        bootstrap_spec = importlib.util.spec_from_file_location("luna_v3_bootstrap", BOOTSTRAP_MODULE)
        cls.bootstrap = importlib.util.module_from_spec(bootstrap_spec)
        bootstrap_spec.loader.exec_module(cls.bootstrap)

    def test_reserved_phone_gets_request_bound_session_and_reply(self):
        adapter = FakeAdapter()
        admitted = []

        async def admit(session_key, phone, message_digest):
            admitted.append((session_key, phone, message_digest))
            return {"ok": True, "admitted": True, "inbound_event_id": "11111111-1111-4111-8111-111111111111", "capability_snapshot": SNAPSHOT}

        response = asyncio.run(self.module.handle_turn(
            FakeRequest({"thread": "+34 699 901 008", "text": "hello", "allow_writes": False}),
            adapter,
            admit_session=admit,
        ))
        self.assertEqual(response["status"], 200)
        self.assertEqual(response["body"]["reply_text"], "reply:hello")
        self.assertTrue(adapter.bound_session_key.startswith("luna-v3:"))
        self.assertEqual(adapter.agent_kwargs["gateway_session_key"], adapter.bound_session_key)
        self.assertEqual(admitted[0][:2], (
            adapter.bound_session_key,
            self.module._normalize_phone("+34 699 901 008"),
        ))
        self.assertIn("TRUSTED STAFF CAPABILITY SNAPSHOT", adapter.agent_kwargs["ephemeral_system_prompt"])
        self.assertIn("code=package_none", adapter.agent_kwargs["ephemeral_system_prompt"])
        self.assertEqual(adapter.agent.calls[0]["conversation_history"], [])

    def test_follow_up_receives_the_same_sessions_previous_messages(self):
        adapter = FakeAdapter()

        async def admit(_session_key, _phone, _message_digest):
            return {"ok": True, "admitted": True, "inbound_event_id": "11111111-1111-4111-8111-111111111112", "capability_snapshot": SNAPSHOT}

        first = asyncio.run(self.module.handle_turn(
            FakeRequest({"thread": "+34 699 901 009", "text": "price for one?"}),
            adapter,
            admit_session=admit,
        ))
        second = asyncio.run(self.module.handle_turn(
            FakeRequest({"thread": "+34 699 901 009", "text": "and for 2 people?"}),
            adapter,
            admit_session=admit,
        ))

        self.assertEqual(first["status"], 200)
        self.assertEqual(second["status"], 200)
        self.assertEqual(
            adapter.agent.calls[1]["conversation_history"],
            adapter.agent.results[0]["messages"],
        )

    def test_agent_exception_after_staff_write_carries_unresolved_outcome(self):
        adapter = FakeAdapter()
        def fail_after_write(**kwargs):
            adapter.agent.calls.append(kwargs)
            from runtime import trusted_turn_context
            trusted_turn_context.record_operation_evidence("check_quote_book", {
                "ok": True, "state": "offer", "offer_reference": "offer_123456789012345678901234",
            })
            raise RuntimeError("formatter failed")
        adapter.agent.run_conversation = fail_after_write

        async def admit(_session_key, _phone, _message_digest):
            return {"ok": True, "admitted": True, "inbound_event_id": "11111111-1111-4111-8111-111111111119", "capability_snapshot": SNAPSHOT}

        failed = asyncio.run(self.module.handle_turn(
            FakeRequest({"thread": "+34 699 901 019", "text": "book it"}), adapter, admit_session=admit,
        ))
        adapter.agent.run_conversation = FakeAgent().run_conversation
        recovered = asyncio.run(self.module.handle_turn(
            FakeRequest({"thread": "+34 699 901 019", "text": "what happened?"}), adapter, admit_session=admit,
        ))
        self.assertEqual(failed["body"]["code"], "agent_failed_after_staff_write")
        self.assertEqual(recovered["status"], 200)
        self.assertIn("unresolved Staff operation", adapter.agent_kwargs["ephemeral_system_prompt"])

    def test_agent_exception_returns_bounded_502_and_does_not_advance_history(self):
        adapter = FakeAdapter()
        adapter.agent.results.append(RuntimeError("provider exploded with secret details"))

        async def admit(_session_key, _phone, _message_digest):
            return {"ok": True, "admitted": True, "inbound_event_id": "11111111-1111-4111-8111-111111111114", "capability_snapshot": SNAPSHOT}

        failed = asyncio.run(self.module.handle_turn(
            FakeRequest({"thread": "+34 699 901 014", "text": "yes, book it"}), adapter, admit_session=admit,
        ))
        recovered = asyncio.run(self.module.handle_turn(
            FakeRequest({"thread": "+34 699 901 014", "text": "what is the status?"}), adapter, admit_session=admit,
        ))

        self.assertEqual(failed, {"status": 502, "body": {"ok": False, "code": "agent_failed"}})
        self.assertEqual(recovered["status"], 200)
        self.assertEqual(adapter.agent.calls[1]["conversation_history"], [])

    def test_offer_presentation_failure_does_not_commit_half_state(self):
        adapter = FakeAdapter()
        offer_messages = [
            {"role": "user", "content": "book it"},
            {"role": "assistant", "content": None, "tool_calls": [{"id": "offer-call", "type": "function", "function": {"name": "check_quote_book", "arguments": '{"action":"prepare","purpose":"offer"}'}}]},
            {"role": "tool", "tool_call_id": "offer-call", "content": '{"ok":true,"state":"offer","held":true,"booked":false,"offer_reference":"offer_123456789012345678901234","check_in":"2026-11-18","check_out":"2026-11-23","guests":[{"name":"Tom","bed":"R3-B3","package":"package_none"}],"add_ons":[{"code":"wetsuit_soft_top_combo","quantity":1,"dates":["2026-11-18"]}],"quote":{"totalCents":27500,"depositCents":10000,"remainingCents":17500,"currency":"EUR"}}'},
            {"role": "assistant", "content": "Offer ready. Is that OK?"},
        ]

        def offer_result(**kwargs):
            adapter.agent.calls.append(kwargs)
            return {"failed": False, "final_response": "Offer ready. Is that OK?", "messages": offer_messages}

        adapter.agent.run_conversation = offer_result

        async def admit(_session_key, _phone, _message_digest):
            return {"ok": True, "admitted": True, "inbound_event_id": "11111111-1111-4111-8111-111111111115", "capability_snapshot": SNAPSHOT}

        presented_replies = []
        def fail_presentation(_session, _offer, reply, _inbound):
            presented_replies.append(reply)
            raise RuntimeError("staff unavailable")

        declined = []
        def decline_offer(*args):
            declined.append(args)

        original = self.module._record_offer_presented_sync
        original_decline = self.module._decline_offer_sync
        self.module._record_offer_presented_sync = fail_presentation
        self.module._decline_offer_sync = decline_offer
        try:
            failed = asyncio.run(self.module.handle_turn(
                FakeRequest({"thread": "+34 699 901 015", "text": "book it"}), adapter, admit_session=admit,
            ))
        finally:
            self.module._record_offer_presented_sync = original
            self.module._decline_offer_sync = original_decline

        self.assertEqual(failed["status"], 502)
        self.assertEqual(presented_replies, ["Offer ready. Is that OK?"])
        self.assertEqual(len(declined), 1)
        phone = self.module._normalize_phone("+34 699 901 015")
        session_id = "luna-v3-" + self.module.hashlib.sha256(phone.encode()).hexdigest()[:24]
        self.assertNotIn(session_id, self.module._SESSION_HISTORY)
        cleanup = self.module._SESSION_OPERATION_OUTCOMES[session_id]["offer:offer_123456789012345678901234"]
        self.assertEqual((cleanup["status"], cleanup["staff_state"]), ("resolved", "released"))

    def test_failed_cleanup_carries_unknown_operation_into_later_turn(self):
        adapter = FakeAdapter()
        messages = [
            {"role": "user", "content": "book it"},
            {"role": "assistant", "content": None, "tool_calls": [{"id": "offer-call", "type": "function", "function": {"name": "check_quote_book", "arguments": '{"action":"prepare","purpose":"offer"}'}}]},
            {"role": "tool", "tool_call_id": "offer-call", "content": '{"ok":true,"state":"offer","offer_reference":"offer_123456789012345678901234"}'},
            {"role": "assistant", "content": "The total and deposit are shown. Is that OK?"},
        ]
        def offer_result(**kwargs):
            adapter.agent.calls.append(kwargs)
            return {"failed": False, "final_response": messages[-1]["content"], "messages": messages}
        adapter.agent.run_conversation = offer_result
        async def admit(_session_key, _phone, _message_digest):
            return {"ok": True, "admitted": True, "inbound_event_id": "11111111-1111-4111-8111-111111111118", "capability_snapshot": SNAPSHOT}
        original_record = self.module._record_offer_presented_sync
        original_decline = self.module._decline_offer_sync
        self.module._record_offer_presented_sync = lambda *_args: (_ for _ in ()).throw(RuntimeError("presentation failed"))
        self.module._decline_offer_sync = lambda *_args: (_ for _ in ()).throw(RuntimeError("cleanup unknown"))
        try:
            failed = asyncio.run(self.module.handle_turn(FakeRequest({"thread": "+34 699 901 018", "text": "book it"}), adapter, admit_session=admit))
            adapter.agent.run_conversation = FakeAgent().run_conversation
            recovered = asyncio.run(self.module.handle_turn(FakeRequest({"thread": "+34 699 901 018", "text": "status?"}), adapter, admit_session=admit))
        finally:
            self.module._record_offer_presented_sync = original_record
            self.module._decline_offer_sync = original_decline
        self.assertEqual(failed["body"]["code"], "offer_state_unknown")
        self.assertEqual(recovered["status"], 200)
        self.assertIn("unresolved Staff operation", adapter.agent_kwargs["ephemeral_system_prompt"])

    def test_only_matching_operation_evidence_resolves_unknown(self):
        session_id = "luna-v3-operation-ledger"
        offer_identity = "offer:offer_123456789012345678901234"
        self.module._apply_operation_evidence(session_id, [{
            "tool": "check_quote_book", "identity": offer_identity,
            "result": {"outcome": "unknown", "offer_reference": "offer_123456789012345678901234"},
        }])
        self.module._apply_operation_evidence(session_id, [{
            "tool": "check_quote_book", "identity": "call:unrelated-quote",
            "result": {"ok": True, "state": "quote", "call_id": "unrelated-quote"},
        }])
        self.assertEqual(self.module._SESSION_OPERATION_OUTCOMES[session_id][offer_identity]["status"], "unresolved")
        self.module._apply_operation_evidence(session_id, [{
            "tool": "check_quote_book", "identity": offer_identity,
            "result": {"ok": True, "state": "released", "offer_reference": "offer_123456789012345678901234"},
        }])
        resolved = self.module._SESSION_OPERATION_OUTCOMES[session_id][offer_identity]
        self.assertEqual((resolved["status"], resolved["staff_state"]), ("resolved", "released"))

    def test_response_projects_real_tool_calls_and_only_admitted_capability(self):
        adapter = FakeAdapter()

        async def admitted(_session_key, _phone, _message_digest):
            return {"ok": True, "admitted": True, "inbound_event_id": "11111111-1111-4111-8111-111111111113", "capability_snapshot": SNAPSHOT}

        response = asyncio.run(self.module.handle_turn(
            FakeRequest({"thread": "+34 699 901 010", "text": "price for two?"}),
            adapter,
            admit_session=admitted,
        ))
        self.assertEqual(response["body"]["tool_calls"], [{
            "name": "check_availability",
            "args": {"guests": 2},
            "result_summary": {"ok": True},
        }])
        self.assertEqual(response["body"]["effective_capability"], {
            "capability": "wolfhouse_staging_booking_test_link",
            "admitted": True,
            "reasons": [],
            "outcome": "ADMITTED",
        })

        async def refused(_session_key, _phone):
            return {"ok": True, "admitted": False, "reasons": ["not_admitted"]}

        refused_response = asyncio.run(self.module.handle_turn(
            FakeRequest({"thread": "+34 699 901 011", "text": "price?"}),
            adapter,
            admit_session=refused,
        ))
        self.assertEqual(refused_response["status"], 503)
        self.assertNotIn("effective_capability", refused_response["body"])

    def test_rejects_non_reserved_phone_and_caller_write_authority(self):
        adapter = FakeAdapter()
        for body, code in [
            ({"thread": "+34 611 111 111", "text": "hello"}, "clone_phone_out_of_range"),
            ({"thread": "+34 699 901 008", "text": "hello", "allow_writes": True}, "caller_write_authority_denied"),
        ]:
            response = asyncio.run(self.module.handle_turn(FakeRequest(body), adapter))
            self.assertEqual(response["status"], 400)
            self.assertEqual(response["body"]["code"], code)

    def test_full_trace_gate_is_dual_keyed(self):
        request = FakeRequest({}, {"X-Luna-V3-Harness-Trace": "secret"})
        old_mode = self.module.os.environ.get("LUNA_V3_AUTHENTIC_HARNESS")
        old_token = self.module.os.environ.get("LUNA_V3_HARNESS_TRACE_TOKEN")
        try:
            self.module.os.environ["LUNA_V3_HARNESS_TRACE_TOKEN"] = "secret"
            self.module.os.environ.pop("LUNA_V3_AUTHENTIC_HARNESS", None)
            self.assertFalse(self.module._harness_trace_allowed(request))
            self.module.os.environ["LUNA_V3_AUTHENTIC_HARNESS"] = "1"
            self.assertTrue(self.module._harness_trace_allowed(request))
            self.assertFalse(self.module._harness_trace_allowed(FakeRequest({}, {"X-Luna-V3-Harness-Trace": "wrong"})))
        finally:
            for key, value in (("LUNA_V3_AUTHENTIC_HARNESS", old_mode), ("LUNA_V3_HARNESS_TRACE_TOKEN", old_token)):
                if value is None:
                    self.module.os.environ.pop(key, None)
                else:
                    self.module.os.environ[key] = value

    def test_preflight_rejects_every_hermes_transport_activation_input(self):
        base = {
            "HERMES_ROLE": "luna-v3",
            "LUNA_V3_TENANT_ID": "wolfhouse-somo",
        }
        contaminated = {
            "WHATSAPP_ENABLED": "true",
            "TELEGRAM_BOT_TOKEN": "synthetic-token",
            "EMAIL_ADDRESS": "review@example.invalid",
            "EMAIL_PASSWORD": "synthetic-password",
            "EMAIL_IMAP_HOST": "imap.example.invalid",
            "EMAIL_SMTP_HOST": "smtp.example.invalid",
        }
        self.bootstrap.validate_environment({**base, "WHATSAPP_ENABLED": "false"})
        for name, value in contaminated.items():
            with self.subTest(name=name), self.assertRaisesRegex(RuntimeError, name):
                self.bootstrap.validate_environment({**base, name: value})

    def test_preflight_requires_api_server_as_the_only_effective_platform(self):
        class PlatformConfig:
            def __init__(self, enabled):
                self.enabled = enabled

        class GatewayConfig:
            def __init__(self, platforms):
                self.platforms = platforms

        self.bootstrap.validate_effective_platforms(GatewayConfig({
            "api_server": PlatformConfig(True),
            "discord": PlatformConfig(False),
        }))

        contaminated = (
            {"api_server": True, "discord": True},
            {"api_server": True, "sms": True},
            {"api_server": True, "future_transport": True},
        )
        for platforms in contaminated:
            with self.subTest(platforms=platforms), self.assertRaisesRegex(
                RuntimeError, "api_server only"
            ):
                self.bootstrap.validate_effective_platforms(GatewayConfig({
                    name: PlatformConfig(enabled)
                    for name, enabled in platforms.items()
                }))


if __name__ == "__main__":
    unittest.main()
