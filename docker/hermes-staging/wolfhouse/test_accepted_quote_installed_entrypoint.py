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
    def __init__(self, entered, release, seen, **_kwargs):
        self.entered, self.release, self.seen = entered, release, seen
        self.chat = SimpleNamespace(completions=_Completions(self))

    def complete(self, request):
        messages = request.get("messages") or []
        self.seen.append(messages)
        text = "\n".join(str(m.get("content") or "") for m in messages if m.get("role") == "user")
        if not self.entered.is_set():
            self.entered.set()
            if not self.release.wait(10):
                raise RuntimeError("model release timeout")
        # A quote request receives a real registered-tool round, then a final.
        if "quote for Ana" in text and not any(m.get("role") == "tool" for m in messages):
            args = {"check_in": "2027-05-11", "check_out": "2027-05-15",
                    "guest_count": 2, "package_code": "package_none",
                    "catalog_selections": [], "guest_name": "Ana"}
            return _Response(_Message(tool_calls=[_ToolCall("quote-ana", "quote_booking", args)]))
        return _Response(_Message(content="Ana turn completed."))


class InstalledEntrypointQueuedPendingEvent(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        plugin_root = Path(__file__).resolve().parents[1] / "plugins"
        hermes_home = Path(self.temp.name) / "home"
        self.env = patch.dict(os.environ, {
            "HERMES_HOME": str(hermes_home),
            "LUNA_CLIENT_SLUG": "wolfhouse-somo", "HERMES_ROLE": "luna",
            "BOT_BOOKING_ENABLED": "true", "WHATSAPP_DRY_RUN": "true",
            "OPENROUTER_API_KEY": "installed-regression-key",
            "GATEWAY_ALLOW_ALL_USERS": "true",
            "HERMES_GATEWAY_BUSY_ACK_ENABLED": "false",
            "HERMES_BUNDLED_PLUGINS": str(plugin_root),
            "WOLFHOUSE_STAFF_API_BASE_URL": "https://staff.invalid",
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
        self.assertTrue(str(Path(runtime.__file__).resolve()).startswith("/opt/hermes/"))
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
        self.runner._session_db = self.runner.session_store._db

        self.staff_calls = []
        def staff(path, payload, **_kwargs):
            self.staff_calls.append((path, dict(payload)))
            return {"success": True, "total_cents": 65000, "currency": "EUR"}
        self.staff_patch = patch.object(self.plugin, "_post_bot", side_effect=staff)
        self.staff_patch.start(); self.addCleanup(self.staff_patch.stop)
        await crowsnest_guest_door.install_live_request_guards()

        self.entered = threading.Event()
        self.release = threading.Event()
        self.model_requests = []
        def client_factory(**kwargs):
            return BlockingModelClient(self.entered, self.release, self.model_requests, **kwargs)
        self.model_patch = patch.object(run_agent, "OpenAI", side_effect=client_factory)
        self.model_patch.start(); self.addCleanup(self.model_patch.stop)


    def event(self, text, ident, phone="+34600111222"):
        scope = crowsnest_guest_door.CrowsnestGuestScope.create(phone)
        return crowsnest_guest_door._make_event(scope, text, message_id=ident)

    async def _wait_thread_event(self, event):
        self.assertTrue(await asyncio.to_thread(event.wait, 10), "model did not enter")

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
            [p for p, _ in self.staff_calls], ["/booking-preview"],
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
