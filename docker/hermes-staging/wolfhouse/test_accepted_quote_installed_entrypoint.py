"""Installed-entrypoint regression for queued WhatsApp pending-event ownership.

This deliberately drives the patched, installed GatewayRunner.  The only external
boundaries replaced are the model client and Staff HTTP transport; agent creation,
conversation loop, executor, dispatcher, and the registered quote_booking handler
remain real.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.platforms.base import MessageEvent, MessageType
from gateway.platforms.whatsapp_cloud import WhatsAppCloudAdapter
from gateway.session import SessionSource
from wolfhouse import accepted_quote, crowsnest_guest_door, original_inbound


class _Message:
    def __init__(self, *, content=None, tool_calls=None):
        self.content = content
        self.tool_calls = tool_calls
        self.reasoning = None
        self.reasoning_content = None
        self.reasoning_details = None

    def model_dump(self, **_kwargs):
        out = {"role": "assistant", "content": self.content}
        if self.tool_calls:
            out["tool_calls"] = [call.model_dump() for call in self.tool_calls]
        return out


class _ToolCall:
    def __init__(self, ident, name, arguments):
        self.id = ident
        self.type = "function"
        self.function = SimpleNamespace(name=name, arguments=json.dumps(arguments))

    def model_dump(self, **_kwargs):
        return {"id": self.id, "type": "function", "function": {
            "name": self.function.name, "arguments": self.function.arguments}}


class _Response:
    def __init__(self, message):
        self.message = message
        self.choices = [SimpleNamespace(message=message, finish_reason=(
            "tool_calls" if message.tool_calls else "stop"))]
        self.usage = SimpleNamespace(prompt_tokens=10, completion_tokens=5, total_tokens=15)
        self.model = "installed-regression-model"

    def __iter__(self):
        tool_deltas = []
        for index, call in enumerate(self.message.tool_calls or []):
            tool_deltas.append(SimpleNamespace(
                index=index, id=call.id, type="function", function=call.function,
            ))
        delta = SimpleNamespace(
            role="assistant", content=self.message.content,
            reasoning=None, reasoning_content=None, tool_calls=tool_deltas,
        )
        yield SimpleNamespace(
            choices=[SimpleNamespace(
                delta=delta,
                finish_reason="tool_calls" if tool_deltas else "stop",
            )],
            model=self.model,
            usage=None,
        )
        yield SimpleNamespace(choices=[], model=self.model, usage=self.usage)

    def model_dump(self, **_kwargs):
        return {}


class _Completions:
    def __init__(self, owner):
        self.owner = owner

    def create(self, **kwargs):
        return self.owner.complete(kwargs)


class BlockingModelClient:
    """OpenAI-compatible deterministic client; first turn blocks for queueing."""
    adversarial_readback = False
    chained_readback = False
    def __init__(self, entered, release, seen, **_kwargs):
        self.entered, self.release, self.seen = entered, release, seen
        self.chat = SimpleNamespace(completions=_Completions(self))

    def complete(self, request):
        messages = request.get("messages") or []
        self.seen.append(messages)
        text = "\n".join(str(m.get("content") or "") for m in messages if m.get("role") == "user")
        latest_user_index = max((i for i, m in enumerate(messages) if m.get("role") == "user"), default=-1)
        latest = str(messages[latest_user_index].get("content") or "") if latest_user_index >= 0 else ""
        tool_messages = [m for m in messages[latest_user_index + 1:] if m.get("role") == "tool"]
        last_tool = json.loads(tool_messages[-1]["content"]) if tool_messages else None
        if not self.entered.is_set():
            self.entered.set()
            if not self.release.wait(10):
                raise RuntimeError("model release timeout")
        france_args = {"check_in": "2027-05-20", "check_out": "2027-05-23",
                       "guest_count": 1, "room_type": "shared", "room_preference": "mixed",
                       "package_code": "package_none", "catalog_selections": [],
                       "payment_choice": "deposit", "guest_name": "Test Unpaid Alpha",
                       "guests": [{"name": "Test Unpaid Alpha"}]}
        if latest.startswith("Hi, I need accommodation only for one adult from 20 May 2027"):
            return _Response(_Message(content=(
                "Hi Test Unpaid Alpha! We have availability for one adult from 20–23 May 2027, "
                "accommodation only. Would you be happy with a mixed shared room?")))
        if "Yes, please create this booking now." in latest and not tool_messages:
            return _Response(_Message(tool_calls=[_ToolCall(
                "france-create", "create_booking_from_plan", france_args)]))
        if "I accept the quote and choose the 100 euro deposit option." in latest and not tool_messages:
            return _Response(_Message(tool_calls=[_ToolCall(
                "france-requote", "quote_booking", france_args)]))
        if "A mixed shared room is fine." in latest and not tool_messages:
            return _Response(_Message(tool_calls=[_ToolCall(
                "france-quote", "quote_booking", france_args)]))
        if last_tool and last_tool.get("tool") == "create_booking_from_plan" and last_tool.get("success"):
            return _Response(_Message(content="Booking ALPHA-1330 created."))
        if (last_tool and last_tool.get("tool") == "quote_booking"
                and ("A mixed shared room is fine." in text
                     or "I accept the quote and choose the 100 euro deposit option." in text)):
            return _Response(_Message(content=(
                "Your accommodation-only quote for 20–23 May 2027 is €120 total. "
                "Deposit: €100. Shall I create this booking?")))
        # A quote request receives a real registered-tool round, then a final.
        if "mixed accommodation-only option" in text and not any(
                m.get("role") == "tool" for m in messages):
            args = {"check_in": "2027-05-10", "check_out": "2027-05-12",
                    "guest_count": 1, "room_type": "shared", "room_preference": "mixed",
                    "package_code": "package_none", "catalog_selections": [],
                    "payment_choice": "deposit", "guest_name": "Alex",
                    "guests": [{"name": "Alex"}]}
            return _Response(_Message(tool_calls=[_ToolCall("quote-alex", "quote_booking", args)]))
        if "quote for Ana" in text and not any(m.get("role") == "tool" for m in messages):
            args = {"check_in": "2027-05-11", "check_out": "2027-05-15",
                    "guest_count": 2, "package_code": "package_none",
                    "catalog_selections": [], "guest_name": "Ana"}
            return _Response(_Message(tool_calls=[_ToolCall("quote-ana", "quote_booking", args)]))
        booking_args = {"check_in": "2027-06-10", "check_out": "2027-06-12",
                        "guest_count": 1, "room_type": "shared", "room_preference": "mixed",
                        "package_code": "package_none", "catalog_selections": [],
                        "payment_choice": "deposit", "guest_name": "Casey",
                        "guests": [{"name": "Casey"}]}
        if "Prepare Casey's cancellable booking" in latest and tool_messages:
            return _Response(_Message(content="Casey's 10–12 June 2027 mixed shared stay is €650 total; deposit selected. Shall I book it?"))
        if "Prepare Casey's cancellable booking" in latest and not tool_messages:
            return _Response(_Message(tool_calls=[_ToolCall("quote-casey", "quote_booking", booking_args)]))
        if latest.startswith("I accept the quote.") and not tool_messages:
            return _Response(_Message(tool_calls=[_ToolCall("create-casey", "create_booking_from_plan", booking_args)]))
        if ("Show my saved unpaid bookings" in latest or "Show me my booking" in latest
                or "Check my booking again" in latest) and not tool_messages:
            return _Response(_Message(tool_calls=[_ToolCall("list-casey", "list_my_bookings", {})]))
        for marker, code in (("Cancel CASEY-100", "CASEY-100"), ("Cancel PAID-200", "PAID-200"),
                             ("Cancel FOREIGN-300", "FOREIGN-300")):
            if marker in latest and not tool_messages:
                return _Response(_Message(tool_calls=[_ToolCall(
                    "cancel-" + code, "cancel_unpaid_booking", {"booking_code": code})]))
        if "Which of my bookings can I cancel?" in latest and not tool_messages:
            return _Response(_Message(tool_calls=[_ToolCall("list-many", "list_my_bookings", {})]))
        if "Find the booking you just created" in latest and not tool_messages:
            return _Response(_Message(tool_calls=[_ToolCall("list-empty", "list_my_bookings", {})]))
        if last_tool and last_tool.get("tool") == "quote_booking":
            return _Response(_Message(content="Casey's 10–12 June 2027 mixed shared stay is €650 total; deposit selected. Shall I book it?"))
        if last_tool and last_tool.get("tool") == "cancel_unpaid_booking" and not last_tool.get("cancelled"):
            if not any(json.loads(m["content"]).get("tool") == "flag_needs_human" for m in tool_messages):
                return _Response(_Message(
                    content="I couldn't cancel that booking. A teammate will take over.",
                    tool_calls=[_ToolCall("handoff-cancel", "flag_needs_human",
                        {"reason": "paid_cancellation_or_reschedule"})]))
            return _Response(_Message(content="I couldn't cancel that booking. A teammate will take over."))
        if last_tool and last_tool.get("tool") == "cancel_unpaid_booking":
            return _Response(_Message(content="Your booking was cancelled."))
        if last_tool and last_tool.get("tool") == "get_payment_status" and self.adversarial_readback:
            return _Response(_Message(content=(
                "Sorry, your booking was not created. Please try booking again."
            )))
        if last_tool and last_tool.get("tool") == "list_my_bookings":
            if self.adversarial_readback and self.chained_readback:
                return _Response(_Message(tool_calls=[_ToolCall(
                    "payment-alpha", "get_payment_status", {"booking_code": "ALPHA-1330"})]))
            if self.adversarial_readback:
                return _Response(_Message(content=(
                    "Sorry, your booking was not created. Please try booking again."
                )))
            if last_tool.get("lookup_status") == "unavailable":
                receipt = last_tool.get("prior_create_receipt") or {}
                ref = receipt.get("booking_code")
                return _Response(_Message(content=(
                    "I can't verify the booking details right now. "
                    + (("The successful create receipt for " + ref + " still stands; ") if ref else "")
                    + "I won't recreate it or claim it failed.")))
            rows = last_tool.get("bookings") or []
            if len(rows) > 1:
                return _Response(_Message(content="Which booking should I cancel: " + ", ".join(r["booking_code"] for r in rows) + "?"))
            if not rows:
                return _Response(_Message(content="I can't find the saved booking yet."))
            return _Response(_Message(content="Saved unpaid booking: " + rows[0]["booking_code"]))
        return _Response(_Message(content="Ana turn completed."))


class InstalledEntrypointQueuedPendingEvent(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        BlockingModelClient.adversarial_readback = False
        BlockingModelClient.chained_readback = False
        self.addCleanup(setattr, BlockingModelClient, "adversarial_readback", False)
        self.addCleanup(setattr, BlockingModelClient, "chained_readback", False)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        plugin_root = Path(__file__).resolve().parents[1] / "plugins"
        hermes_home = Path(self.temp.name) / "home"
        self.env = patch.dict(os.environ, {
            "HERMES_HOME": str(hermes_home),
            "LUNA_CLIENT_SLUG": "wolfhouse-somo", "HERMES_ROLE": "luna",
            "LUNA_TENANT_ID": "wolfhouse-somo",
            "BOT_BOOKING_ENABLED": "true", "WHATSAPP_DRY_RUN": "true",
            "OPENROUTER_API_KEY": "installed-regression-key",
            "GATEWAY_ALLOW_ALL_USERS": "true",
            "HERMES_GATEWAY_BUSY_ACK_ENABLED": "false",
            "HERMES_BUNDLED_PLUGINS": str(plugin_root),
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff-staging.lunafrontdesk.com",
            "PUBLIC_PAYMENT_BASE_URL": "https://staff-staging.lunafrontdesk.com",
            "STRIPE_MODE": "test",
            "LUNA_BOT_INTERNAL_TOKEN": "installed-regression-token",
        })
        self.env.start(); self.addCleanup(self.env.stop)
        hermes_home.mkdir(parents=True)
        (hermes_home / "logs").mkdir()
        (hermes_home / "config.yaml").write_text(json.dumps({
            "plugins": {"enabled": ["wolfhouse-staff-api"]},
            "platform_toolsets": {"whatsapp_cloud": ["wolfhouse_staff_api"]},
        }), encoding="utf-8")

        # Use Hermes' global discovery path, not a private PluginManager. The
        # platform toolset resolver reads metadata from this singleton when it
        # snapshots the installed agent's tools.
        from hermes_cli.plugins import discover_plugins, get_plugin_manager
        discover_plugins(force=True)
        manager = get_plugin_manager()
        matches = [item for item in manager._plugins.values()
                   if item.manifest.name == "wolfhouse-staff-api"]
        self.assertEqual(len(matches), 1, sorted(manager._plugins))
        loaded = matches[0]
        self.assertFalse(loaded.error, loaded.error)
        self.plugin = loaded.module

        import gateway.run as runtime
        self.runtime = runtime
        self.assertTrue(str(Path(runtime.__file__).resolve()).startswith(
            str(Path(os.getenv("HERMES_INSTALL_ROOT") or "/opt/hermes").resolve()) + "/"))
        self.assertTrue(original_inbound.gateway_runtime_ready(runtime.GatewayRunner))
        cfg = GatewayConfig(
            platforms={Platform.WHATSAPP_CLOUD: PlatformConfig(
                enabled=True, extra={"phone_number_id": "test", "access_token": "test",
                                     "dm_policy": "open"})},
            sessions_dir=Path(self.temp.name) / "sessions",
            unauthorized_dm_behavior="ignore",
        )
        from tools.registry import registry
        self.registry = registry
        self.assertIs(self.registry._tools["quote_booking"].handler, self.registry._tools["quote_booking"].handler)
        self.assertEqual(self.registry._tools["quote_booking"].name, "quote_booking")
        self.create_handler = self.registry._tools["create_booking_from_plan"].handler
        self.handler_globals = self.create_handler.__globals__
        for name in ("list_my_bookings", "cancel_unpaid_booking"):
            self.assertIs(self.registry._tools[name].handler.__globals__, self.handler_globals)

        import run_agent
        self.run_agent = run_agent
        self.runner = runtime.GatewayRunner(cfg)
        self.runner._busy_input_mode = "queue"
        self.runner._busy_text_mode = "queue"
        adapter = WhatsAppCloudAdapter(cfg.platforms[Platform.WHATSAPP_CLOUD])
        adapter.set_message_handler(self.runner._handle_message)
        adapter.set_busy_session_handler(self.runner._handle_active_session_busy_message)
        adapter._busy_text_mode = "interrupt"
        self.adapter = adapter
        self.runner.adapters[Platform.WHATSAPP_CLOUD] = adapter
        self.runner.delivery_router.adapters = self.runner.adapters


        self.staff_calls = []
        self.saved_bookings = []
        self.list_response_mode = "ok"
        def staff(path, payload, **_kwargs):
            self.staff_calls.append((path, dict(payload)))
            route = path.removeprefix("/staff/bot")
            if route == "/availability-check":
                bed = "R1-B1" if payload.get("check_in") == "2027-05-20" else "R3-B1"
                room = "R1" if bed == "R1-B1" else "R3"
                return {"success": True, "has_enough_beds": True,
                        "selected_bed_codes": [bed],
                        "available_beds": [{"bed_code": bed, "room_code": room,
                                            "room_type": "mixed", "gender_strategy": "flexible"}]}
            if route == "/booking-preview" and payload.get("guest_name") == "Test Unpaid Alpha":
                offer = {"v": 1, "client_slug": "wolfhouse-somo",
                         "check_in": "2027-05-20", "check_out": "2027-05-23",
                         "guest_count": 1, "guest_bed_assignments": [{
                             "guest_index": 0, "guest_name": "test unpaid alpha", "bed_code": "R1-B1"}],
                         "room_arrangement": [{"bed_code": "R1-B1", "room_code": "R1",
                                               "gender_strategy": "flexible"}],
                         "room_type": "shared", "room_preference": "mixed",
                         "gender_preference": None, "package_code": "package_none",
                         "guest_packages": [], "add_ons": [], "total_cents": 12000,
                         "deposit_required_cents": 10000, "payment_link_amount_cents": 10000,
                         "currency": "EUR", "payment_choice": "deposit",
                         "per_guest_payment_links": False, "payment_distribution": [],
                         "availability_checked": True, "offer_revision_version": 1,
                         "offer_fingerprint": "9fe256211e9ed1a8a412c942cea16218bc623bea74a8e47493c740754965f414"}
                return {"success": True, "total_cents": 12000,
                        "deposit_required_cents": 10000, "payment_choice_needed": False,
                        "currency": "EUR", "offer_revision": offer,
                        "availability": {"status": "checked", "availability_checked": True,
                            "selected_bed_codes": ["R1-B1"],
                            "guest_bed_assignments": offer["guest_bed_assignments"],
                            "room_arrangement": offer["room_arrangement"],
                            "check_in": "2027-05-20", "check_out": "2027-05-23",
                            "guest_count": 1, "room_type": "shared"}}
            if route == "/booking-create-from-plan":
                code = "ALPHA-1330" if payload.get("guest_name") == "Test Unpaid Alpha" else "CASEY-100"
                row = {"booking_code": code, "check_in": payload.get("check_in", "2027-06-10"),
                       "check_out": payload.get("check_out", "2027-06-12"),
                       "guest_count": 1, "guest_name": payload.get("guest_name", "Casey"),
                       "status": "pending", "payment_status": "unpaid",
                       "phone": payload.get("phone"),
                       "client_slug": payload.get("client_slug") or "wolfhouse-somo"}
                self.saved_bookings[:] = [row]
                return {"success": True, "write_performed": True, "booking_code": code,
                        "booking_id": code.lower() + "-id", "payment_status": "unpaid"}
            if route == "/bookings/by-phone":
                if self.list_response_mode == "malformed":
                    return {"success": True, "count": 0}
                if self.list_response_mode == "error":
                    return {"success": False, "staff_api_status": "http_error", "status": 503,
                            "error": "booking lookup failed: replica unavailable"}
                rows = [row for row in self.saved_bookings
                        if (not row.get("phone") or row.get("phone") == payload.get("phone"))
                        and (row.get("client_slug") or "wolfhouse-somo") == (payload.get("client_slug") or "wolfhouse-somo")]
                return {"success": True, "count": len(rows), "bookings": rows}
            if route == "/bookings/cancel-unpaid":
                code = payload.get("booking_code")
                if code == "CASEY-100":
                    self.saved_bookings.clear()
                    return {"success": True, "cancelled": True, "write_performed": True,
                            "booking": {"booking_code": code}}
                return {"success": False, "cancelled": False, "write_performed": False,
                        "blocked_reason": "payment_exists" if code == "PAID-200" else "owner_mismatch",
                        "staff_review_needed": True}
            if route == "/conversation/needs-human":
                return {"success": True, "needs_human": True, "conversation_paused": False,
                        "staff_handoff": {"id": "review-cancel"}}
            return {"success": True, "total_cents": 65000, "currency": "EUR"}
        self.guard_calls = []
        real_request_guard = crowsnest_guest_door.guard_bot_path_and_payload
        def observed_request_guard(path, payload, **kwargs):
            self.guard_calls.append((path, dict(payload or {}), dict(kwargs)))
            return real_request_guard(path, payload, **kwargs)
        self.guard_patch = patch.object(
            crowsnest_guest_door, "guard_bot_path_and_payload",
            side_effect=observed_request_guard)
        self.guard_patch.start(); self.addCleanup(self.guard_patch.stop)
        # Plugin discovery can reload the manifest module after the global registry
        # has retained handlers from the prior installed module. Bind the real
        # registered handlers' transport dictionary to the real request guard, and
        # mock only the captured Staff transport below that guard.
        original_post = self.handler_globals["_post_bot"]
        original_phone = self.handler_globals["_session_guest_phone"]
        staff_boundary = SimpleNamespace(_post_bot=staff, _session_guest_phone=original_phone)
        import gateway.platforms.whatsapp_cloud as whatsapp_module
        crowsnest_guest_door._ensure_quote_owner_hook()
        crowsnest_guest_door.install_request_owned_guards(staff_boundary, whatsapp_module)
        self.handler_globals["_post_bot"] = staff_boundary._post_bot
        self.handler_globals["_session_guest_phone"] = staff_boundary._session_guest_phone
        self.addCleanup(self.handler_globals.__setitem__, "_post_bot", original_post)
        self.addCleanup(self.handler_globals.__setitem__, "_session_guest_phone", original_phone)

        self.entered = threading.Event()
        self.release = threading.Event()
        self.model_requests = []
        def client_factory(**kwargs):
            return BlockingModelClient(self.entered, self.release, self.model_requests, **kwargs)
        self.model_patch = patch.object(run_agent, "OpenAI", side_effect=client_factory)
        self.model_patch.start(); self.addCleanup(self.model_patch.stop)
        import agent.agent_runtime_helpers as runtime_helpers
        self.runtime_helpers_patch = patch.object(
            runtime_helpers, "_ra", return_value=run_agent)
        self.runtime_helpers_patch.start(); self.addCleanup(self.runtime_helpers_patch.stop)


    def event(self, text, ident, phone="+34600111222"):
        scope = crowsnest_guest_door.CrowsnestGuestScope.create(phone)
        return crowsnest_guest_door._make_event(scope, text, message_id=ident)

    async def _wait_thread_event(self, event):
        self.assertTrue(await asyncio.to_thread(event.wait, 10), "model did not enter")

    async def test_z_exact_france_failed_transcript_creates_once_and_replays_idempotently(self):
        """Replay the failed turns through real ingress/registry/guard; only Staff transport is intercepted."""
        self.release.set()
        phone = "+34900001330"

        async def turn(text, ident):
            result = await crowsnest_guest_door.run_crowsnest_guest_turn(
                runner=self.runner, phone=phone, text=text, message_id=ident,
                mirror=lambda **_kwargs: None, timeout_sec=20)
            self.assertTrue(result["ok"], result)
            return result

        await turn(
            "Hi, I need accommodation only for one adult from 20 May 2027 to 23 May 2027. "
            "My name is Test Unpaid Alpha.", "france-live-01")
        await turn("A mixed shared room is fine.", "france-live-02")
        await turn("I accept the quote and choose the 100 euro deposit option.", "france-live-03")
        created = await turn("Yes, please create this booking now.", "france-live-04")
        self.assertIn("ALPHA-1330", created["reply_text"], {
            "created": created, "staff_calls": self.staff_calls,
            "model_requests": self.model_requests[-3:]})
        create_calls = [(path, body) for path, body in self.staff_calls
                        if path == "/staff/bot/booking-create-from-plan"]
        self.assertEqual(len(create_calls), 1, self.staff_calls)
        self.assertIn("/staff/bot/booking-create-from-plan", [p for p, _, _ in self.guard_calls])
        self.assertIs(self.registry._tools["create_booking_from_plan"].handler,
                      self.create_handler)

        replay = await turn("Yes, please create this booking now.", "france-live-05")
        self.assertIn("ALPHA-1330", replay["reply_text"], replay)
        self.assertEqual(len([(path, body) for path, body in self.staff_calls
                              if path == "/staff/bot/booking-create-from-plan"]), 1,
                         self.staff_calls)

        listed = await turn("Show me my booking.", "france-live-list-01")
        self.assertIn("ALPHA-1330", listed["reply_text"], listed)
        self.assertEqual(len([(path, body) for path, body in self.staff_calls
                              if path == "/staff/bot/booking-create-from-plan"]), 1,
                         self.staff_calls)
        last_request = self.model_requests[-1]
        list_tools = [json.loads(item["content"]) for item in last_request
                      if item.get("role") == "tool" and "list_my_bookings" in item.get("content", "")]
        self.assertTrue(list_tools, last_request)
        self.assertEqual(list_tools[-1]["lookup_status"], "found")
        self.assertEqual(list_tools[-1]["prior_create_receipt"]["booking_code"], "ALPHA-1330")

        BlockingModelClient.adversarial_readback = True
        self.saved_bookings.clear()
        for mode, ident in (("ok", "france-live-list-empty"),
                            ("malformed", "france-live-list-malformed"),
                            ("error", "france-live-list-error")):
            self.list_response_mode = mode
            unavailable = await turn("Check my booking again.", ident)
            self.assertIn("ALPHA-1330", unavailable["reply_text"], unavailable)
            self.assertIn("created successfully earlier", unavailable["reply_text"], unavailable)
            self.assertIn("can't verify its current details", unavailable["reply_text"], unavailable)
            self.assertNotIn("not created", unavailable["reply_text"].lower(), unavailable)
            self.assertEqual(len([(path, body) for path, body in self.staff_calls
                                  if path == "/staff/bot/booking-create-from-plan"]), 1,
                             self.staff_calls)

        BlockingModelClient.chained_readback = True
        for mode, ident in (("ok", "france-live-chain-empty"),
                            ("malformed", "france-live-chain-malformed"),
                            ("error", "france-live-chain-error")):
            self.list_response_mode = mode
            unavailable = await turn("Check my booking again.", ident)
            self.assertIn("ALPHA-1330", unavailable["reply_text"], unavailable)
            self.assertIn("created successfully earlier", unavailable["reply_text"], unavailable)
            self.assertIn("can't verify its current details", unavailable["reply_text"], unavailable)
            self.assertNotIn("not created", unavailable["reply_text"].lower(), unavailable)
            final_request = self.model_requests[-1]
            latest_user = max(index for index, item in enumerate(final_request)
                              if item.get("role") == "user")
            current_tools = [json.loads(item["content"])["tool"]
                             for item in final_request[latest_user + 1:]
                             if item.get("role") == "tool"]
            self.assertEqual(current_tools,
                             ["list_my_bookings", "get_payment_status"])
            self.assertEqual(len([(path, body) for path, body in self.staff_calls
                                  if path == "/staff/bot/booking-create-from-plan"]), 1,
                             self.staff_calls)

        self.list_response_mode = "ok"
        wrong_owner = await crowsnest_guest_door.run_crowsnest_guest_turn(
            runner=self.runner, phone="+" + "34" + "9" * 9, text="Show me my booking.",
            message_id="france-live-list-wrong-owner", mirror=lambda **_kwargs: None,
            timeout_sec=20)
        self.assertTrue(wrong_owner["ok"], wrong_owner)
        self.assertNotIn("ALPHA-1330", wrong_owner["reply_text"], wrong_owner)
        self.assertIn("not created", wrong_owner["reply_text"].lower(), wrong_owner)


    async def test_new_simulator_session_accepts_mixed_accommodation_only_for_deposit_quote(self):
        """A reused simulator lane must reopen its ended DB row before quote ownership."""
        self.release.set()
        mirror = lambda **_kwargs: None
        offered = await crowsnest_guest_door.run_crowsnest_guest_turn(
            runner=self.runner, phone="+34999001326",
            text="Offer Alex a mixed shared-room accommodation-only option.",
            message_id="alex-offer-0001", mirror=mirror, timeout_sec=20)
        self.assertTrue(offered["ok"], offered)
        # The live gateway closes the SQLite row after a completed turn while
        # retaining the same SessionStore lane for the next guest message.
        entry = self.runner.session_store.get_or_create_session(
            crowsnest_guest_door._make_event(
                crowsnest_guest_door.CrowsnestGuestScope.create("+34999001326"),
                "probe", message_id="alex-probe-0003").source)
        self.runner.session_store._db.end_session(entry.session_id, "agent_close")
        quoted = await crowsnest_guest_door.run_crowsnest_guest_turn(
            runner=self.runner, phone="+34999001326",
            text="Yes, the mixed accommodation-only option. What is the exact total and deposit?",
            message_id="alex-accept-0002", mirror=mirror, timeout_sec=20)
        self.assertTrue(quoted["ok"], quoted)
        self.assertEqual([path for path, _ in self.staff_calls], ["/staff/bot/booking-preview"])
        self.assertEqual(self.staff_calls[0][1]["room_preference"], "mixed")
        self.assertEqual(self.staff_calls[0][1]["package_code"], "package_none")
        self.assertEqual(self.staff_calls[0][1]["payment_choice"], "deposit")

    async def test_sqlite_unavailable_allows_ordinary_turn_without_booking_authority(self):
        """Hermes' supported JSONL fallback must keep ordinary messages working."""
        self.release.set()
        self.runner._session_db = None
        self.runner.session_store._db = None
        result = await crowsnest_guest_door.run_crowsnest_guest_turn(
            runner=self.runner, phone="+999000000009", text="Hello there",
            message_id="fallback-regression-0001", mirror=lambda **_kwargs: None,
            timeout_sec=20)
        self.assertTrue(result["ok"], result)
        self.assertEqual(self.staff_calls, [])
        self.assertEqual(result["transport_calls"], 0)

    async def test_ordinary_entrypoint_create_list_select_cancel_and_fail_closed_variants(self):
        self.release.set()
        # Live-turn owner binding/revocation has a dedicated exact-handler suite.
        # Keep this flow test focused on the ordinary model/registry/Staff path.
        owner_patch = patch.dict(
            self.handler_globals, {"_live_turn_guest_phone": lambda: "+349****1777"})
        owner_patch.start(); self.addCleanup(owner_patch.stop)

        async def turn(text, ident):
            phone = "+34900001777"
            result = await crowsnest_guest_door.run_crowsnest_guest_turn(
                runner=self.runner, phone=phone, text=text, message_id=ident,
                mirror=lambda **_kwargs: None, timeout_sec=20)
            self.assertTrue(result["ok"], result)
            return result

        await turn("Prepare Casey's cancellable booking quote.", "cancel-flow-01")
        # Exercise the registered create handler and the request-owned guard. Only
        # the Staff transport beneath that guard is synthetic in this regression.
        created = await turn("I accept the quote.", "cancel-flow-02")
        self.assertIs(
            self.registry._tools["create_booking_from_plan"].handler,
            self.create_handler,
        )
        self.assertIn("/staff/bot/booking-create-from-plan", [p for p, _ in self.staff_calls], {
            "created": created, "last_model_request": self.model_requests[-1] if self.model_requests else None,
        })
        self.assertIn("/staff/bot/booking-create-from-plan", [p for p, _, _ in self.guard_calls])
        self.assertEqual(self.saved_bookings[0]["payment_status"], "unpaid")
        listed = await turn("Show my saved unpaid bookings.", "cancel-flow-03")
        self.assertIn("CASEY-100", listed["reply_text"])
        cancelled = await turn("Cancel CASEY-100 explicitly.", "cancel-flow-04")
        self.assertIn("was cancelled", cancelled["reply_text"], {
            "result": cancelled, "model_messages": self.model_requests[-1] if self.model_requests else None,
        })
        cancel_calls = [(p, body) for p, body in self.staff_calls
                        if p == "/staff/bot/bookings/cancel-unpaid"]
        self.assertEqual(cancel_calls[-1][1]["booking_code"], "CASEY-100")
        self.assertIn("/staff/bot/bookings/cancel-unpaid", [p for p, _, _ in self.guard_calls])

        before = len(cancel_calls)
        self.saved_bookings[:] = [
            {"booking_code": "ONE-1", "check_in": "2027-07-01", "check_out": "2027-07-02", "payment_status": "unpaid"},
            {"booking_code": "TWO-2", "check_in": "2027-08-01", "check_out": "2027-08-02", "payment_status": "unpaid"},
        ]
        ambiguous = await turn("Which of my bookings can I cancel?", "cancel-flow-05")
        self.assertIn("Which booking", ambiguous["reply_text"])
        self.assertEqual(len([p for p, _ in self.staff_calls
                              if p == "/staff/bot/bookings/cancel-unpaid"]), before)
        refused = await turn("Cancel PAID-200 explicitly.", "cancel-flow-06")
        refusal_copy = [str(m.get("content") or "") for request in self.model_requests
                        for m in request if m.get("role") == "assistant"]
        self.assertTrue(any("couldn't cancel" in text for text in refusal_copy), refusal_copy)
        self.assertFalse(any("was cancelled" in text for text in refusal_copy[-2:]), refusal_copy[-2:])
        self.assertIn("/staff/bot/conversation/needs-human", [p for p, _ in self.staff_calls])
        foreign = await turn("Cancel FOREIGN-300 explicitly.", "cancel-flow-07")
        self.assertNotIn("was cancelled", foreign["reply_text"])
        foreign_calls = [body for path, body in self.staff_calls
                         if path == "/staff/bot/bookings/cancel-unpaid"
                         and body.get("booking_code") == "FOREIGN-300"]
        self.assertEqual(len(foreign_calls), 1)
        self.assertNotEqual(foreign_calls[0].get("phone"), "+34999999999")
        self.saved_bookings.clear()
        empty = await turn("Find the booking you just created.", "cancel-flow-08")
        self.assertNotIn("only quoted", empty["reply_text"].lower())
        self.assertIn("created successfully earlier", empty["reply_text"].lower())
        self.assertIn("can't verify its current details", empty["reply_text"].lower())

    async def test_real_entrypoint_queues_ana_and_fails_closed_for_bad_owners(self):
        mirror = lambda **_kwargs: None
        first = asyncio.create_task(crowsnest_guest_door.run_crowsnest_guest_turn(
            runner=self.runner, phone="+34600111222", text="Hi, is there space in May?",
            message_id="ana-entry-0001", mirror=mirror, timeout_sec=20))
        await self._wait_thread_event(self.entered)

        # Enter through the real adapter active-session split.  This bypasses
        # _handle_message, reaches the decorated busy handler, and queues the
        # adapter-owned pending event before the recursive runner drain.
        queued = self.event("Please quote for Ana and one friend.", "ana-queue-0003")
        foreign = self.event("Unrelated foreign-session chatter.", "ana-foreign-004", "+34600009999")
        from gateway.session import build_session_key
        adapter_key = build_session_key(
            queued.source, group_sessions_per_user=True,
            thread_sessions_per_user=False)
        self.adapter._active_sessions[adapter_key] = asyncio.Event()
        self.adapter._session_tasks[adapter_key] = first
        await self.adapter.handle_message(queued)
        self.assertIsNotNone(getattr(
            queued, original_inbound._QUEUE_SNAPSHOT_ATTR, None))
        await self.runner._handle_message(foreign)
        self.release.set()
        first_result = await first
        self.assertTrue(first_result["ok"], first_result)

        # The real drain recursion must execute the queued Ana event through the
        # exact registry handler and Staff boundary.
        for _ in range(200):
            if self.staff_calls:
                break
            await asyncio.sleep(.01)
        self.assertEqual(
            [p for p, _ in self.staff_calls], ["/staff/bot/booking-preview"],
            {"model_requests": self.model_requests, "first_result": first_result,
             "staff_calls": self.staff_calls},
        )
        self.assertEqual(self.staff_calls[0][1]["guest_name"], "Ana")

        # Foreign session activity cannot ride Ana's owner; it gets its own turn
        # and therefore cannot add a second Ana Staff call.
        self.assertEqual(len(self.staff_calls), 1)
        self.assertIsNone(original_inbound._current.get())
        self.assertIsNone(accepted_quote._current.get())

        # Stale/replayed queued message IDs fail closed at the owner ledger.
        stale = self.event("Please quote for Ana and one friend.", "ana-queue-0003")
        await self.runner._handle_message(stale)
        self.assertEqual(len(self.staff_calls), 1)

        # Cancellation closes the entrypoint-owned inbound capability, including
        # copied executor context; releasing the worker cannot resurrect it.
        entered2, release2 = threading.Event(), threading.Event()
        self.entered, self.release = entered2, release2
        loop = asyncio.get_running_loop()
        prior_factory = loop.get_task_factory()
        late_errors = []

        def task_factory(loop, coro, **kwargs):
            task = asyncio.Task(coro, loop=loop, **kwargs)
            def consume(done):
                if not done.cancelled() and done.exception() is not None:
                    late_errors.append(done.exception())
            task.add_done_callback(consume)
            return task

        loop.set_task_factory(task_factory)
        cancelled = asyncio.create_task(crowsnest_guest_door.run_crowsnest_guest_turn(
            runner=self.runner, phone="+34600111333", text="Please quote for Ana and one friend.",
            message_id="ana-cancel-004", mirror=mirror, timeout_sec=20))
        await self._wait_thread_event(entered2)
        cancelled.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await cancelled
        release2.set()
        for _ in range(500):
            if not crowsnest_guest_door._ACTIVE_SCOPES:
                break
            await asyncio.sleep(.01)
        self.assertFalse(crowsnest_guest_door._ACTIVE_SCOPES)
        await asyncio.sleep(0)
        loop.set_task_factory(prior_factory)
        self.assertEqual(len(late_errors), 1, late_errors)
        self.assertIsInstance(late_errors[0], accepted_quote.QuoteBoundaryError)
        self.assertEqual(str(late_errors[0]), 'quote_owner_turn_closed')
        self.assertEqual(len(self.staff_calls), 1)
        self.assertIsNone(original_inbound._current.get())
        self.assertIsNone(accepted_quote._current.get())


if __name__ == "__main__":
    unittest.main()
