"""Request-owned one-runner Crows Nest guest door containment.

Exercises simulator + ordinary turns in one process, including timeout/cancel and
late worker completion. External transport is intercepted; simulator calls must
remain zero while ordinary sessions continue normally.
"""
from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace

from wolfhouse.crowsnest_guest_door import (
    CrowsnestGuestScope,
    _default_mirror,
    install_request_owned_guards,
    run_crowsnest_guest_turn,
)


class _FakeStaff:
    def __init__(self):
        self.calls = []

    def _post_bot(self, path, payload):
        self.calls.append((path, dict(payload or {})))
        return {"success": True, "path": path}

    def _session_guest_phone(self):
        return "+34999999999"


class _FakeWhatsApp:
    class WhatsAppCloudAdapter:
        external_calls = []

        async def send(self, chat_id, content, reply_to=None, metadata=None):
            self.external_calls.append((chat_id, content))
            return SimpleNamespace(success=True, message_id="wamid.real")


class _Runner:
    def __init__(self, staff, adapter):
        self.staff = staff
        self.adapter = adapter
        self.release_late = asyncio.Event()
        self.started_late = asyncio.Event()
        self.sessions = {}

    async def _handle_message(self, event):
        key = event.source.chat_id
        history = self.sessions.setdefault(key, [])
        history.append(event.text)
        if event.text == "late":
            self.started_late.set()
            try:
                await self.release_late.wait()
            except asyncio.CancelledError:
                # Hostile late worker ignores request cancellation and continues.
                await self.release_late.wait()
            await self.adapter.send(event.source.chat_id, "late simulator reply")
            self.staff._post_bot("/sunset/payment-link", {"booking_code": "SIM-LATE"})
            return "late simulator reply"
        if event.text == "ordinary":
            await self.adapter.send(event.source.chat_id, "ordinary reply")
            return "ordinary reply"
        if event.text == "worker-read":
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None,
                self.staff._post_bot,
                "/sunset/catalog",
                {"location_id": "sunset-somo"},
            )
            return f"worker:{result['path']}"
        self.staff._post_bot("/sunset/catalog", {"location_id": "sunset-somo"})
        return "context:" + "|".join(history)


class CrowsnestGuestDoorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.staff = _FakeStaff()
        self.whatsapp = _FakeWhatsApp()
        self.whatsapp.WhatsAppCloudAdapter.external_calls = []
        self.adapter = self.whatsapp.WhatsAppCloudAdapter()
        self.runner = _Runner(self.staff, self.adapter)
        self.mirrored = []
        install_request_owned_guards(self.staff, self.whatsapp)

    async def _mirror(self, *, direction, phone, text, scope):
        self.mirrored.append((direction, phone, text, scope.session_key))
        return {"ok": True, "simulator_synthetic": True}

    async def test_interleaved_simulator_and_ordinary_turns_keep_context_and_transport_isolated(self):
        one, ordinary, two = await asyncio.gather(
            run_crowsnest_guest_turn(
                runner=self.runner, phone="+34600111222", text="first",
                mirror=self._mirror, timeout_sec=1,
            ),
            self.runner._handle_message(SimpleNamespace(
                text="ordinary",
                source=SimpleNamespace(chat_id="34600999888", user_id="34600999888"),
            )),
            run_crowsnest_guest_turn(
                runner=self.runner, phone="+34600111222", text="second",
                mirror=self._mirror, timeout_sec=1,
            ),
        )
        self.assertEqual(ordinary, "ordinary reply")
        self.assertEqual(self.whatsapp.WhatsAppCloudAdapter.external_calls, [("34600999888", "ordinary reply")])
        self.assertTrue(one["reply_text"].startswith("context:"))
        self.assertEqual(two["reply_text"], "context:first|second")
        self.assertNotEqual(one["session_key"], "34600111222")
        self.assertEqual(one["session_key"], two["session_key"])
        self.assertEqual([row[0] for row in self.mirrored], ["inbound", "outbound", "inbound", "outbound"])
        self.assertTrue(all(row[3].startswith("crowsnest-sim:") for row in self.mirrored))

    async def test_timeout_cancel_and_late_completion_never_fall_back_to_external_transport(self):
        phone = "+34" + "600111333"
        task = asyncio.create_task(run_crowsnest_guest_turn(
            runner=self.runner, phone=phone, text="late",
            mirror=self._mirror, timeout_sec=0.01, late_settle_sec=0.01,
        ))
        await asyncio.wait_for(self.runner.started_late.wait(), timeout=1)
        result = await asyncio.wait_for(task, timeout=1)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "turn_timeout")

        ordinary = await self.runner._handle_message(SimpleNamespace(
            text="ordinary",
            source=SimpleNamespace(chat_id="34600777888", user_id="34600777888"),
        ))
        self.assertEqual(ordinary, "ordinary reply")
        self.runner.release_late.set()
        await asyncio.sleep(0.05)

        self.assertEqual(self.whatsapp.WhatsAppCloudAdapter.external_calls, [("34600777888", "ordinary reply")])
        self.assertFalse(any(path == "/sunset/payment-link" for path, _ in self.staff.calls))

    async def test_scope_is_request_owned_and_keeps_transport_suppressed(self):
        scope = CrowsnestGuestScope.create("+34600111444")
        self.assertTrue(scope.session_key.startswith("crowsnest-sim:"))
        result = await run_crowsnest_guest_turn(
            runner=self.runner, phone="+34600111444", text="hello",
            mirror=self._mirror, timeout_sec=1,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["transport_calls"], 0)
        self.assertEqual(result["session_key"], scope.session_key)

    async def test_active_sunset_simulator_scope_forwards_all_staff_tool_writes(self):
        import wolfhouse.crowsnest_guest_door as door

        scope = CrowsnestGuestScope.create("+34" + "600111445")
        token = door._SCOPE.set(scope)
        try:
            results = [
                self.staff._post_bot("/sunset/booking-create", {"guest_confirmed_booking": True}),
                self.staff._post_bot("/sunset/payment-link", {"booking_id": "bk-1"}),
                self.staff._post_bot("/sunset/waiver/register", {"booking_id": "bk-1"}),
                self.staff._post_bot("/booking/contact", {"booking_id": "bk-1", "guest_name": "Tom"}),
            ]
        finally:
            door._SCOPE.reset(token)

        self.assertTrue(all(result["success"] for result in results))
        self.assertEqual(len(self.staff.calls), 4)
        self.assertFalse(any(call.get("simulator_guard") for call in scope.tool_calls))
        self.assertEqual(self.whatsapp.WhatsAppCloudAdapter.external_calls, [])

    async def test_inbox_identity_is_synthetic_and_persistence_is_verified(self):
        import wolfhouse_whatsapp_mirror as mirror_mod

        scope = CrowsnestGuestScope.create("+34" + "600111555")
        self.assertNotEqual(scope.inbox_phone, scope.synthetic_phone)
        self.assertTrue(scope.inbox_phone.startswith("+999"))
        seen = []
        original = mirror_mod._post_mirror_sync
        try:
            mirror_mod._post_mirror_sync = lambda payload: (
                seen.append(payload) or {"ok": True, "thread": {"persisted": False}}
            )
            with self.assertRaisesRegex(RuntimeError, "inbox_persist_unconfirmed"):
                await _default_mirror(
                    direction="outbound", phone=scope.synthetic_phone,
                    text="reply", scope=scope,
                )
            mirror_mod._post_mirror_sync = lambda payload: (
                seen.append(payload) or {"ok": True, "thread": {"persisted": True}}
            )
            await _default_mirror(
                direction="outbound", phone=scope.synthetic_phone,
                text="reply", scope=scope,
            )
        finally:
            mirror_mod._post_mirror_sync = original
        self.assertTrue(all(row["guest_phone"] == scope.inbox_phone for row in seen))
        self.assertTrue(all(row["suppress_approvals"] for row in seen))
        self.assertTrue(all(row["suppress_notifications"] for row in seen))
        self.assertTrue(all(row["open_phone_testing"] is True for row in seen))
        self.assertTrue(all(row["guest_tester_class"] == "Simulator" for row in seen))
        self.assertTrue(all(row["simulator_source_phone"] == scope.synthetic_phone for row in seen))
        self.assertTrue(all(row["guest_phone"] != row["simulator_source_phone"] for row in seen))

    async def test_caller_cancellation_revokes_and_collects_late_worker(self):
        task = asyncio.create_task(run_crowsnest_guest_turn(
            runner=self.runner, phone="+34" + "600111666", text="late",
            mirror=self._mirror, timeout_sec=30,
        ))
        await asyncio.wait_for(self.runner.started_late.wait(), timeout=1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.runner.release_late.set()
        await asyncio.sleep(0.05)
        self.assertEqual(self.whatsapp.WhatsAppCloudAdapter.external_calls, [])
        self.assertFalse(any(path == "/sunset/payment-link" for path, _ in self.staff.calls))

    async def test_request_scope_crosses_executor_queue_without_leaking_to_ordinary_work(self):
        result = await run_crowsnest_guest_turn(
            runner=self.runner, phone="+34600111444", text="worker-read",
            mirror=self._mirror, timeout_sec=1,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["reply_text"], "worker:/staff/bot/sunset/catalog")
        self.assertEqual(result["tool_calls"][0]["name"], "catalog")

        loop = asyncio.get_running_loop()
        ordinary = await loop.run_in_executor(
            None, self.staff._post_bot, "/ordinary", {"value": 1},
        )
        self.assertEqual(ordinary["path"], "/ordinary")

    async def test_tool_session_phone_matches_durable_simulator_inbox_identity(self):
        import wolfhouse.crowsnest_guest_door as door

        scope = CrowsnestGuestScope.create("+34" + "600111777")
        token = door._SCOPE.set(scope)
        try:
            self.assertEqual(self.staff._session_guest_phone(), scope.inbox_phone)
            self.assertTrue(self.staff._session_guest_phone().startswith("+999"))
            self.assertNotEqual(self.staff._session_guest_phone(), scope.synthetic_phone)
        finally:
            door._SCOPE.reset(token)

    async def test_guest_door_accepts_deployed_guard_contract_for_reads_and_handoff(self):
        import wolfhouse.crowsnest_guest_door as door

        original_guard = door.guard_bot_path_and_payload

        def deployed_guard(path, payload, *, allow_writes):
            return original_guard(path, payload, allow_writes=allow_writes)

        door.guard_bot_path_and_payload = deployed_guard
        try:
            scope = CrowsnestGuestScope.create("+34" + "600111888")
            token = door._SCOPE.set(scope)
            try:
                availability = self.staff._post_bot(
                    "/sunset/lesson-availability", {"date": "2026-09-18"}
                )
                handoff = self.staff._post_bot(
                    "/needs-human", {"reason": "guest_requested_human"}
                )
            finally:
                door._SCOPE.reset(token)
        finally:
            door.guard_bot_path_and_payload = original_guard

        self.assertTrue(availability["success"])
        self.assertTrue(handoff["success"])
        self.assertEqual(
            [path for path, _payload in self.staff.calls],
            [
                "/staff/bot/sunset/lesson-availability",
                "/staff/bot/needs-human",
            ],
        )
        self.assertEqual(self.whatsapp.WhatsAppCloudAdapter.external_calls, [])


if __name__ == "__main__":
    unittest.main()
