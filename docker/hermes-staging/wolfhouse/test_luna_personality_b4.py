"""Composed pinned-owner B4 regressions; exact-image offline execution only."""
import asyncio
import pathlib
import sys
import threading
import unittest
from unittest import mock
from wolfhouse import luna_personality_isolation as iso

class FallbackAbortTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if hasattr(cls, "agent"):
            return
        ns = {"__name__": "b4_sdk_fixture"}
        source = pathlib.Path("scripts/test_luna_personality_cold_admission.py").read_text()
        fixture = source[:source.index("async def main():")]
        fixture = fixture.replace("import gateway.run as gateway", "import run_agent\nimport gateway.run as gateway")
        exec(compile(fixture, "existing-sdk-fixture", "exec"), ns)
        cls.runner = ns["runner"]
        result = asyncio.run(cls.runner._run_agent_inner("fixture", "", [], ns["source"],
            "fixture-session", session_key="fixture-key"))
        assert result["final_response"] == "fixture ordinary reply"
        cls.agent = iso._iter_effective_agents(runner=cls.runner)[0]
        cls.agent._disable_streaming = True
        global helper
        from agent import chat_completion_helpers as helper

    @classmethod
    def tearDownClass(cls):
        import faulthandler
        faulthandler.cancel_dump_traceback_later()
    def tearDown(self):
        iso.reset_isolation_runtime_for_tests()
    def test_canonical_catch_to_outer_eval_preserves_identity_and_evidence(self):
        from openai.resources.chat.completions import Completions
        from wolfhouse import luna_personality_live_eval as live
        iso.install_isolation_runtime(runner=self.runner)
        cause = iso.IsolationAbort("provider_lifetime_revoked")
        original_cause = cause.__cause__ = ValueError("synthetic cause")
        attempted, callbacks = [], []
        def create(*args, **kwargs):
            attempted.append(1)
            raise cause
        def callback(*args):
            if attempted:
                callbacks.append(1)
                raise AssertionError("typed abort reached canonical error callback")
        async def invoke(message, cap, meta):
            cap.telemetry_producer_suppressed = 7
            return self.agent.run_conversation(message)
        previous = self.agent.thinking_callback
        self.agent.thinking_callback = callback
        try:
            with mock.patch.object(Completions, "create", create):
                try:
                    asyncio.run(live.run_isolated_personality_eval(
                        case_id="warmth-greeting-en", personality_id="sunny", serving_preflight=False,
                        fetch_setting=lambda slug: {"personality_id": "sunny"}, invoke_turn=invoke))
                except BaseException as exc:
                    self.assertIs(exc, cause)
                else:
                    self.fail("typed abort became successful eval")
            self.assertIs(cause.__cause__, original_cause)
            self.assertEqual(attempted, [1])
            self.assertEqual(callbacks, [])
            self.assertEqual(cause.counters["telemetry_producer_suppressed"], 7)
            for field in ("auth_effects", "provider_http_effects", "telemetry_effects"):
                self.assertIsNone(cause.counters[field])
        finally:
            self.agent.thinking_callback = previous
    def test_late_worker_abort_at_outer_eval_settlement_boundary(self):
        from openai.resources.chat.completions import Completions
        from wolfhouse import luna_personality_live_eval as live
        for before_deadline in (True, False):
            with self.subTest(before_deadline=before_deadline):
                iso.install_isolation_runtime(runner=self.runner)
                entered, release, returned, settling = (threading.Event() for _ in range(4))
                workers, controller_results, captures = [], [], []
                cause = iso.IsolationAbort("provider_lifetime_revoked")
                cause.__cause__ = ValueError("synthetic cause")
                def create(*args, **kwargs):
                    workers.append(threading.current_thread())
                    entered.set()
                    if not release.wait(5):
                        raise AssertionError("worker release missing")
                    raise cause
                def interrupt():
                    if entered.wait(2):
                        self.agent._interrupt_requested = True
                    if before_deadline and returned.wait(2) and settling.wait(2):
                        release.set()
                original_settle = iso.settle_isolated_work
                def settle(cap):
                    settling.set()
                    return original_settle(cap, timeout_s=2 if before_deadline else 0)
                async def invoke(message, cap, meta):
                    captures.append(cap)
                    cap.telemetry_producer_suppressed = 7
                    try:
                        return helper.interruptible_api_call(self.agent,
                            {"model": self.agent.model, "messages": []})
                    except InterruptedError as exc:
                        controller_results.append(exc)
                        raise
                    finally:
                        returned.set()
                interrupter = threading.Thread(target=interrupt)
                self.agent._interrupt_requested = False
                interrupter.start()
                try:
                    with mock.patch.object(Completions, "create", create), mock.patch.object(live, "settle_isolated_work", settle):
                        try:
                            asyncio.run(live.run_isolated_personality_eval(
                                case_id="warmth-greeting-en", personality_id="sunny", serving_preflight=False,
                                fetch_setting=lambda slug: {"personality_id": "sunny"}, invoke_turn=invoke))
                        except Exception as exc:
                            failure = exc
                        else:
                            self.fail("cancelled eval became successful")
                    self.assertEqual(len(controller_results), 1)
                    self.assertIsInstance(controller_results[0], InterruptedError)
                    if before_deadline:
                        self.assertIs(failure, cause)
                        self.assertEqual(failure.counters["telemetry_producer_suppressed"], 7)
                    else:
                        self.assertIsInstance(failure, iso.IsolationAbort)
                        self.assertEqual(failure.reason, "provider_work_unsettled")
                        self.assertEqual(failure.counters["counter_snapshot_state"], "partial")
                        snapshot = dict(failure.counters)
                    release.set()
                    for worker in workers:
                        worker.join(2)
                        self.assertFalse(worker.is_alive())
                    if not before_deadline:
                        self.assertEqual(failure.counters, snapshot)
                        self.assertIsNot(failure, cause)
                finally:
                    release.set()
                    interrupter.join(2)
                    for worker in workers:
                        worker.join(2)
                    self.agent._interrupt_requested = False
                    iso.reset_isolation_runtime_for_tests()
    def test_ordinary_fallback_uses_pinned_router_and_sdk_fixture(self):
        import copy
        agent = copy.copy(self.agent)
        agent._fallback_index = 0
        agent._fallback_chain = [{"provider": "custom", "model": "gpt-4o",
            "base_url": "https://fixture.invalid/v1", "api_key": "synthetic-not-a-credential"}]
        agent._fallback_activated = False
        agent._transport_cache = {}
        agent.context_compressor = None
        self.assertTrue(helper.try_activate_fallback(agent, helper.FailoverReason.rate_limit))
        self.assertEqual((agent.model, agent.provider, agent._fallback_index), ("gpt-4o", "custom", 1))
        self.assertTrue(agent._fallback_activated)
        reply = helper.interruptible_api_call(agent, {"model": agent.model, "messages": []})
        self.assertEqual(reply.choices[0].message.content, "fixture ordinary reply")
        agent.client.close()
    def test_primary_worker_and_cleanup_precedence(self):
        from wolfhouse import luna_personality_live_eval as live
        primary, late = iso.IsolationAbort("primary"), iso.IsolationAbort("late")
        async def invoke(message, cap, meta):
            iso.retain_worker_abort(primary)
            iso.retain_worker_abort(late)
            self.assertIs(cap._worker_abort, primary)
            raise primary
        with mock.patch.object(live, "settle_isolated_work", side_effect=iso.IsolationAbort("cleanup_failed")):
            try:
                asyncio.run(live.run_isolated_personality_eval(case_id="warmth-greeting-en",
                    personality_id="sunny", serving_preflight=False,
                    fetch_setting=lambda slug: {"personality_id": "sunny"}, invoke_turn=invoke))
            except iso.IsolationAbort as exc:
                self.assertIs(exc, primary)
                self.assertEqual(exc.cleanup_error, "cleanup_failed")
            else:
                self.fail("primary lost")
    def test_fallback_precedes_all_resource_and_state_access(self):
        class HostileAgent:
            def __getattribute__(self, name):
                raise AssertionError("fallback accessed agent before denial: " + name)
        cap = iso.IsolatedTurnCapture(case_id="fixture", personality_id="balanced", tenant_id="sunset")
        token = iso.enter_isolated_turn(cap)
        try:
            try:
                helper.try_activate_fallback(HostileAgent(), helper.FailoverReason.rate_limit)
            except Exception as exc:
                self.assertIsInstance(exc, iso.IsolationAbort)
                self.assertEqual(exc.reason, "isolated_fallback_denied")
            else:
                self.fail("fallback was not refused")
        finally:
            iso.exit_isolated_turn(token)
    def test_cancelled_worker_retains_typed_error_in_original_handoff(self):
        from openai.resources.chat.completions import Completions
        entered, release = threading.Event(), threading.Event()
        workers, handoffs, results = [], [], []
        cause = iso.IsolationAbort("provider_lifetime_revoked")
        cause.__cause__ = ValueError("synthetic cause")
        def create(*args, **kwargs):
            frame = sys._getframe()
            while frame.f_code.co_name != "_call":
                frame = frame.f_back
            handoffs.append(frame.f_locals["result"])
            workers.append(threading.current_thread())
            entered.set()
            if not release.wait(5):
                raise AssertionError("release missing")
            raise cause
        def invoke():
            try:
                results.append(helper.interruptible_api_call(self.agent,
                    {"model": self.agent.model, "messages": []}))
            except BaseException as exc:
                results.append(exc)
        self.agent._interrupt_requested = False
        controller = threading.Thread(target=invoke)
        with mock.patch.object(Completions, "create", create):
            try:
                controller.start()
                self.assertTrue(entered.wait(2))
                self.agent._interrupt_requested = True
                controller.join(2)
                self.assertFalse(controller.is_alive())
                self.assertIsInstance(results[0], InterruptedError)
                self.agent._interrupt_requested = False
                release.set()
                workers[0].join(2)
                self.assertFalse(workers[0].is_alive())
                self.assertIs(handoffs[0]["error"], cause,
                    "cancelled worker swallowed typed abort after controller returned")
            finally:
                release.set()
                controller.join(2)
                for worker in workers:
                    worker.join(2)
                self.agent._interrupt_requested = False
