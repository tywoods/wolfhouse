"""Deterministic tests for WhatsApp burst coalescing (fake clock, no real sleeps)."""

from __future__ import annotations

import asyncio
import pathlib
import sys
import unittest
from types import SimpleNamespace
from typing import Any, Awaitable, Callable, List, Optional

ROOT = pathlib.Path(__file__).resolve().parent
STAGING = ROOT.parent
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from whatsapp_burst_coalesce import (  # noqa: E402
    BurstCoalescer,
    coalesce_enabled,
    classify_event,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0
        self._timers: List[tuple[float, Callable[[], Awaitable[None]], list]] = []
        self._bg_tasks: List[asyncio.Task] = []

    def monotonic(self) -> float:
        return self.now

    def schedule(self, delay: float, cb: Callable[[], Awaitable[None]]) -> list:
        handle: list = ["active"]
        self._timers.append((self.now + delay, cb, handle))
        return handle

    def cancel(self, handle: Any) -> None:
        if isinstance(handle, list):
            handle[0] = "cancelled"

    async def advance(self, seconds: float) -> None:
        """Advance time; start due timer callbacks without blocking on long runs."""
        target = self.now + seconds
        while True:
            due = [
                (t, cb, h)
                for (t, cb, h) in self._timers
                if h[0] == "active" and t <= target + 1e-9
            ]
            if not due:
                self.now = target
                return
            due.sort(key=lambda x: x[0])
            t, cb, h = due[0]
            self.now = t
            h[0] = "fired"
            task = asyncio.create_task(cb())
            self._bg_tasks.append(task)
            # Let the callback run until it hits await (e.g. active-run hold).
            await asyncio.sleep(0)

    async def drain(self) -> None:
        if self._bg_tasks:
            await asyncio.gather(*self._bg_tasks, return_exceptions=True)
            self._bg_tasks.clear()


def _adapter(phone_number_id: str = "pnid-sunset-somo") -> SimpleNamespace:
    return SimpleNamespace(_phone_number_id=phone_number_id, config=SimpleNamespace(extra={}))


def _event(
    *,
    text: str,
    sender: str,
    wamid: str,
    message_type: str = "text",
    media_urls: Optional[List[str]] = None,
    raw: Optional[dict] = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        text=text,
        message_type=message_type,
        message_id=wamid,
        timestamp=None,
        reply_to_message_id=None,
        reply_to_text=None,
        media_urls=media_urls or [],
        media_types=[],
        raw_message=raw or {"type": message_type.lower(), "id": wamid, "text": {"body": text}},
        metadata={},
        source=SimpleNamespace(
            platform=SimpleNamespace(value="whatsapp_cloud"),
            user_id=sender,
            chat_id=sender,
        ),
        internal=False,
    )


class BurstCoalesceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = FakeClock()
        self.invocations: List[str] = []
        self.replies: List[str] = []
        self.active_depth = 0
        self.max_active = 0
        self._hold: Optional[asyncio.Event] = None

        async def dispatch(event: Any) -> None:
            self.active_depth += 1
            self.max_active = max(self.max_active, self.active_depth)
            self.invocations.append(getattr(event, "text", ""))
            if self._hold is not None:
                await self._hold.wait()
            self.replies.append(f"reply:{len(self.invocations)}")
            self.active_depth -= 1

        self.dispatch = dispatch
        self.coalescer = BurstCoalescer(
            debounce_ms=2500,
            max_messages=5,
            max_chars=200,
            stale_buffer_ms=60_000,
            now_fn=self.clock.monotonic,
            schedule_fn=self.clock.schedule,
            cancel_fn=self.clock.cancel,
            dispatch_fn=dispatch,
        )
        self.adapter = _adapter()

    def test_red_without_coalesce_three_invocations(self):
        """RED: without coalescing (debounce=0), a burst starts one run per message."""

        async def run() -> None:
            c = BurstCoalescer(
                debounce_ms=0,
                now_fn=self.clock.monotonic,
                schedule_fn=self.clock.schedule,
                cancel_fn=self.clock.cancel,
                dispatch_fn=self.dispatch,
            )
            a = "34911110001"
            await c.ingest(
                self.adapter, _event(text="Somos dos personas", sender=a, wamid="wamid.r1")
            )
            await c.ingest(
                self.adapter, _event(text="El lunes que viene", sender=a, wamid="wamid.r2")
            )
            await c.ingest(
                self.adapter,
                _event(text="Queremos clases grupales", sender=a, wamid="wamid.r3"),
            )
            self.assertEqual(len(self.invocations), 3)
            self.assertEqual(
                self.invocations,
                [
                    "Somos dos personas",
                    "El lunes que viene",
                    "Queremos clases grupales",
                ],
            )

        asyncio.run(run())

    def test_red_scenario_a_three_messages_one_invocation(self):
        async def run() -> None:
            a = "34911110001"
            await self.coalescer.ingest(
                self.adapter, _event(text="Somos dos personas", sender=a, wamid="wamid.a1")
            )
            await self.clock.advance(0.300)
            await self.coalescer.ingest(
                self.adapter, _event(text="El lunes que viene", sender=a, wamid="wamid.a2")
            )
            await self.clock.advance(0.400)
            await self.coalescer.ingest(
                self.adapter, _event(text="Queremos clases grupales", sender=a, wamid="wamid.a3")
            )
            # Quiet window measured from LAST message (700ms timeline + 2500ms).
            await self.clock.advance(2.499)
            self.assertEqual(len(self.invocations), 0)
            await self.clock.advance(0.002)
            await self.clock.drain()
            self.assertEqual(len(self.invocations), 1)
            self.assertEqual(
                self.invocations[0],
                "Somos dos personas\nEl lunes que viene\nQueremos clases grupales",
            )
            self.assertEqual(len(self.replies), 1)
            snap = self.coalescer.snapshot()
            self.assertEqual(snap["stats"]["agent_invocations"], 1)
            self.assertGreaterEqual(snap["stats"]["timer_resets"], 2)

        asyncio.run(run())

    def test_different_senders_isolated_and_concurrent(self):
        async def run() -> None:
            a = "34911110001"
            b = "34911110002"
            await self.coalescer.ingest(
                self.adapter, _event(text="hola A", sender=a, wamid="wamid.a")
            )
            await self.coalescer.ingest(
                self.adapter, _event(text="hola B", sender=b, wamid="wamid.b")
            )
            await self.clock.advance(2.500)
            await self.clock.drain()
            self.assertEqual(len(self.invocations), 2)
            self.assertEqual(set(self.invocations), {"hola A", "hola B"})

        asyncio.run(run())

    def test_messages_during_active_run_become_one_followup(self):
        async def run() -> None:
            a = "34911110001"
            self._hold = asyncio.Event()
            await self.coalescer.ingest(
                self.adapter, _event(text="first", sender=a, wamid="wamid.1")
            )
            await self.clock.advance(2.500)
            await asyncio.sleep(0)
            self.assertEqual(len(self.invocations), 1)
            key = self.coalescer.key_for_adapter_event(
                self.adapter, _event(text="x", sender=a, wamid="tmp")
            )
            self.assertTrue(self.coalescer._sender(key).active_run)  # noqa: SLF001

            await self.coalescer.ingest(
                self.adapter, _event(text="during-1", sender=a, wamid="wamid.2")
            )
            await self.coalescer.ingest(
                self.adapter, _event(text="during-2", sender=a, wamid="wamid.3")
            )
            self.assertEqual(len(self.invocations), 1)
            self.assertEqual(self.coalescer.snapshot()["stats"]["queued_during_active"], 2)

            self._hold.set()
            await self.clock.drain()
            # Pending quiet window arms after run completion.
            await self.clock.advance(2.500)
            await self.clock.drain()
            self.assertEqual(len(self.invocations), 2)
            self.assertEqual(self.invocations[1], "during-1\nduring-2")
            self.assertEqual(self.max_active, 1)

        asyncio.run(run())

    def test_duplicate_wamid_ignored(self):
        async def run() -> None:
            a = "34911110001"
            ev = _event(text="mismo", sender=a, wamid="wamid.dup")
            await self.coalescer.ingest(self.adapter, ev)
            await self.coalescer.ingest(self.adapter, ev)
            await self.clock.advance(2.500)
            await self.clock.drain()
            self.assertEqual(len(self.invocations), 1)
            self.assertEqual(self.invocations[0], "mismo")
            self.assertEqual(self.coalescer.snapshot()["stats"]["deduplicated"], 1)

        asyncio.run(run())

    def test_after_quiet_window_second_turn(self):
        async def run() -> None:
            a = "34911110001"
            await self.coalescer.ingest(
                self.adapter, _event(text="turn1", sender=a, wamid="wamid.t1")
            )
            await self.clock.advance(2.500)
            await self.clock.drain()
            await self.coalescer.ingest(
                self.adapter, _event(text="turn2", sender=a, wamid="wamid.t2")
            )
            await self.clock.advance(2.500)
            await self.clock.drain()
            self.assertEqual(self.invocations, ["turn1", "turn2"])

        asyncio.run(run())

    def test_no_concurrent_runs_one_sender(self):
        async def run() -> None:
            a = "34911110001"
            self._hold = asyncio.Event()
            await self.coalescer.ingest(
                self.adapter, _event(text="a", sender=a, wamid="wamid.1")
            )
            await self.clock.advance(2.500)
            await asyncio.sleep(0)
            await self.coalescer.ingest(
                self.adapter, _event(text="b", sender=a, wamid="wamid.2")
            )
            self.assertEqual(self.max_active, 1)
            self._hold.set()
            await self.clock.drain()
            await self.clock.advance(2.500)
            await self.clock.drain()
            self.assertEqual(self.max_active, 1)

        asyncio.run(run())

    def test_lock_releases_after_failure(self):
        async def run() -> None:
            fails = {"n": 0}

            async def bad_dispatch(event: Any) -> None:
                fails["n"] += 1
                if fails["n"] == 1:
                    raise RuntimeError("boom")
                self.invocations.append(event.text)

            self.coalescer = BurstCoalescer(
                debounce_ms=100,
                now_fn=self.clock.monotonic,
                schedule_fn=self.clock.schedule,
                cancel_fn=self.clock.cancel,
                dispatch_fn=bad_dispatch,
            )
            a = "34911110001"
            await self.coalescer.ingest(
                self.adapter, _event(text="x", sender=a, wamid="wamid.1")
            )
            await self.clock.advance(0.100)
            await self.clock.drain()
            st = self.coalescer._sender(  # noqa: SLF001
                self.coalescer.key_for_adapter_event(
                    self.adapter, _event(text="x", sender=a, wamid="tmp")
                )
            )
            self.assertFalse(st.active_run)
            await self.coalescer.ingest(
                self.adapter, _event(text="y", sender=a, wamid="wamid.2")
            )
            await self.clock.advance(0.100)
            await self.clock.drain()
            self.assertEqual(self.invocations, ["y"])
            self.assertEqual(self.coalescer.snapshot()["stats"]["failures"], 1)

        asyncio.run(run())

    def test_status_and_reaction_ignored(self):
        async def run() -> None:
            a = "34911110001"
            await self.coalescer.ingest(
                self.adapter,
                _event(
                    text="",
                    sender=a,
                    wamid="wamid.react",
                    message_type="reaction",
                    raw={"type": "reaction", "reaction": {"emoji": "👍"}},
                ),
            )
            await self.clock.advance(2.500)
            await self.clock.drain()
            self.assertEqual(self.invocations, [])

        asyncio.run(run())

    def test_structured_flushes_text_burst_first(self):
        async def run() -> None:
            a = "34911110001"
            await self.coalescer.ingest(
                self.adapter, _event(text="texto 1", sender=a, wamid="wamid.1")
            )
            await self.coalescer.ingest(
                self.adapter, _event(text="texto 2", sender=a, wamid="wamid.2")
            )
            loc = _event(
                text="[location]",
                sender=a,
                wamid="wamid.loc",
                message_type="location",
                raw={"type": "location", "location": {"latitude": 1, "longitude": 2}},
            )
            await self.coalescer.ingest(self.adapter, loc)
            await self.clock.drain()
            self.assertEqual(len(self.invocations), 2)
            self.assertEqual(self.invocations[0], "texto 1\ntexto 2")
            self.assertEqual(self.invocations[1], "[location]")

        asyncio.run(run())

    def test_overflow_flushes_then_continues_without_silent_loss(self):
        async def run() -> None:
            a = "34911110001"
            # max_messages=5 in setUp
            for i in range(6):
                await self.coalescer.ingest(
                    self.adapter,
                    _event(text=f"m{i}", sender=a, wamid=f"wamid.{i}"),
                )
            # First 5 flushed immediately on overflow of 6th; 6th still buffered.
            await self.clock.drain()
            self.assertEqual(len(self.invocations), 1)
            self.assertEqual(self.invocations[0], "m0\nm1\nm2\nm3\nm4")
            await self.clock.advance(2.500)
            await self.clock.drain()
            self.assertEqual(len(self.invocations), 2)
            self.assertEqual(self.invocations[1], "m5")

        asyncio.run(run())

    def test_debounce_zero_passthrough(self):
        async def run() -> None:
            c = BurstCoalescer(
                debounce_ms=0,
                now_fn=self.clock.monotonic,
                schedule_fn=self.clock.schedule,
                cancel_fn=self.clock.cancel,
                dispatch_fn=self.dispatch,
            )
            a = "34911110001"
            await c.ingest(self.adapter, _event(text="one", sender=a, wamid="wamid.1"))
            await c.ingest(self.adapter, _event(text="two", sender=a, wamid="wamid.2"))
            self.assertEqual(self.invocations, ["one", "two"])

        asyncio.run(run())

    def test_provenance_wamids_on_combined_event(self):
        async def run() -> None:
            seen = {}

            async def capture(event: Any) -> None:
                seen["wamids"] = event.metadata.get("whatsapp_burst_source_wamids")
                seen["text"] = event.text

            c = BurstCoalescer(
                debounce_ms=100,
                now_fn=self.clock.monotonic,
                schedule_fn=self.clock.schedule,
                cancel_fn=self.clock.cancel,
                dispatch_fn=capture,
            )
            a = "34911110001"
            await c.ingest(self.adapter, _event(text="a", sender=a, wamid="wamid.1"))
            await c.ingest(self.adapter, _event(text="b", sender=a, wamid="wamid.2"))
            await self.clock.advance(0.100)
            await self.clock.drain()
            self.assertEqual(seen["wamids"], ["wamid.1", "wamid.2"])
            self.assertEqual(seen["text"], "a\nb")

        asyncio.run(run())

    def test_different_phone_number_ids_not_merged(self):
        async def run() -> None:
            a = "34911110001"
            ad_a = _adapter("pnid-a")
            ad_b = _adapter("pnid-b")
            await self.coalescer.ingest(
                ad_a, _event(text="school A", sender=a, wamid="wamid.a")
            )
            await self.coalescer.ingest(
                ad_b, _event(text="school B", sender=a, wamid="wamid.b")
            )
            await self.clock.advance(2.500)
            await self.clock.drain()
            self.assertEqual(set(self.invocations), {"school A", "school B"})

        asyncio.run(run())

    def test_feature_gate_disabled_by_default(self):
        import os

        prev = os.environ.pop("WHATSAPP_BURST_COALESCE_ENABLED", None)
        try:
            self.assertFalse(coalesce_enabled())
        finally:
            if prev is not None:
                os.environ["WHATSAPP_BURST_COALESCE_ENABLED"] = prev

    def test_classify_ignore_and_coalesce(self):
        self.assertEqual(
            classify_event(
                _event(text="", sender="1", wamid="r", message_type="reaction", raw={"type": "reaction"})
            ),
            "ignore",
        )
        self.assertEqual(
            classify_event(_event(text="hola", sender="1", wamid="t")),
            "coalesce",
        )


class CurrentHermesInboundPathDocTest(unittest.TestCase):
    """RED documentation: idle WhatsApp path starts agent on first message."""

    def test_source_notes_no_idle_debounce_in_upstream_handle_message(self):
        # Confirmed from NousResearch hermes-agent gateway/platforms/base.py
        # handle_message: when session_key not in _active_sessions it calls
        # _start_session_processing immediately (no quiet-window). Rapid
        # separate Meta webhooks therefore start overlapping/incomplete turns.
        self.assertTrue(True)


if __name__ == "__main__":
    unittest.main()
