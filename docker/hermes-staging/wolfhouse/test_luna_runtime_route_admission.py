import unittest
from types import SimpleNamespace

from wolfhouse import luna_personality_isolation as iso


class RuntimeRouteAdmissionTests(unittest.TestCase):
    def tearDown(self):
        iso._RUNTIME_ROUTE.set(None)
        iso._ACTIVE_RUNNER = None

    def test_non_sunset_tenant_fails_closed(self):
        agent = SimpleNamespace(api_mode="chat_completions")
        runner = SimpleNamespace(_agent_cache={"fixture": agent})
        source = SimpleNamespace(platform=SimpleNamespace(value="local"), chat_id="fixture", user_id="fixture")
        cap = iso.IsolatedTurnCapture(case_id="case", personality_id="balanced", tenant_id="other")
        iso._ACTIVE_RUNNER = runner
        token = iso.enter_isolated_turn(cap)
        try:
            with self.assertRaisesRegex(iso.IsolationAbort, "runtime_resolution_unverified"):
                iso._issue_runtime_route_admission(cap, SimpleNamespace(source=source), runner)
        finally:
            iso.exit_isolated_turn(token)

    def test_descriptor_rejects_missing_malformed_cross_owner_and_tampering(self):
        agent = SimpleNamespace(api_mode="chat_completions")
        runner = SimpleNamespace(_agent_cache={"fixture": agent})
        source = SimpleNamespace(platform=SimpleNamespace(value="local"), chat_id="fixture", user_id="fixture")
        event = SimpleNamespace(source=source)
        cap = iso.IsolatedTurnCapture(case_id="case", personality_id="balanced", tenant_id="sunset")
        iso._ACTIVE_RUNNER = runner
        token = iso.enter_isolated_turn(cap)
        try:
            with self.assertRaisesRegex(iso.IsolationAbort, "runtime_resolution_unverified"):
                iso.refuse_unverified_runtime()
            admission_token = iso._issue_runtime_route_admission(cap, event, runner)
            admission = iso._RUNTIME_ROUTE.get()
            source.chat_id = "cross-route"
            with self.assertRaisesRegex(iso.IsolationAbort, "runtime_resolution_unverified"):
                iso.refuse_unverified_runtime()
            source.chat_id = "fixture"
            admission.digest = b"tampered"
            with self.assertRaisesRegex(iso.IsolationAbort, "runtime_resolution_unverified"):
                iso.refuse_unverified_runtime()
            iso._RUNTIME_ROUTE.reset(admission_token)
        finally:
            iso.exit_isolated_turn(token)

    def test_descriptor_rejects_cross_capture_runtime_and_stale_copy(self):
        agent = SimpleNamespace(api_mode="chat_completions")
        runner = SimpleNamespace(_agent_cache={"fixture": agent})
        source = SimpleNamespace(platform=SimpleNamespace(value="local"), chat_id="fixture", user_id="fixture")
        cap = iso.IsolatedTurnCapture(case_id="case", personality_id="balanced", tenant_id="sunset")
        iso._ACTIVE_RUNNER = runner
        token = iso.enter_isolated_turn(cap)
        admission_token = iso._issue_runtime_route_admission(cap, SimpleNamespace(source=source), runner)
        stale = iso._RUNTIME_ROUTE.get()
        try:
            runner._agent_cache["fixture"] = SimpleNamespace(api_mode="chat_completions")
            with self.assertRaisesRegex(iso.IsolationAbort, "runtime_resolution_unverified"):
                iso.refuse_unverified_runtime()
        finally:
            iso._RUNTIME_ROUTE.reset(admission_token)
            iso.exit_isolated_turn(token)
        other = iso.IsolatedTurnCapture(case_id="other", personality_id="balanced", tenant_id="sunset")
        token = iso.enter_isolated_turn(other)
        copied_token = iso._RUNTIME_ROUTE.set(stale)
        try:
            with self.assertRaisesRegex(iso.IsolationAbort, "runtime_resolution_unverified"):
                iso.refuse_unverified_runtime()
        finally:
            iso._RUNTIME_ROUTE.reset(copied_token)
            iso.exit_isolated_turn(token)

    def test_ordinary_turn_is_unchanged(self):
        iso.refuse_unverified_runtime()

    def test_trusted_descriptor_admits_semantic_retry_then_one_way_execution(self):
        agent = SimpleNamespace(api_mode="chat_completions")
        runner = SimpleNamespace(_agent_cache={"fixture": agent})
        source = SimpleNamespace(platform=SimpleNamespace(value="local"), chat_id="fixture", user_id="fixture")
        event = SimpleNamespace(source=source)
        cap = iso.IsolatedTurnCapture(case_id="case", personality_id="balanced", tenant_id="sunset")
        iso._ACTIVE_RUNNER = runner
        token = iso.enter_isolated_turn(cap)
        admission_token = iso._issue_runtime_route_admission(cap, event, runner)
        try:
            runner._agent_cache["lazy"] = SimpleNamespace(api_mode="chat_completions")
            iso.refuse_unverified_runtime(iso.RUNTIME_RESOLUTION_STAGE)
            iso.refuse_unverified_runtime(iso.RUNTIME_RESOLUTION_STAGE)
            runner._agent_cache["later"] = SimpleNamespace(api_mode="chat_completions")
            iso.refuse_unverified_runtime(iso.AGENT_EXECUTION_STAGE)
            with self.assertRaisesRegex(iso.IsolationAbort, "runtime_resolution_unverified"):
                iso.refuse_unverified_runtime(iso.AGENT_EXECUTION_STAGE)
            with self.assertRaisesRegex(iso.IsolationAbort, "runtime_resolution_unverified"):
                iso.refuse_unverified_runtime(iso.RUNTIME_RESOLUTION_STAGE)
        finally:
            iso._RUNTIME_ROUTE.reset(admission_token)
            iso.exit_isolated_turn(token)

    def test_descriptor_rejects_unknown_skipped_and_copied_stage(self):
        agent = SimpleNamespace(api_mode="chat_completions")
        runner = SimpleNamespace(_agent_cache={"fixture": agent})
        source = SimpleNamespace(platform=SimpleNamespace(value="local"), chat_id="fixture", user_id="fixture")
        cap = iso.IsolatedTurnCapture(case_id="case", personality_id="balanced", tenant_id="sunset")
        iso._ACTIVE_RUNNER = runner
        token = iso.enter_isolated_turn(cap)
        admission_token = iso._issue_runtime_route_admission(cap, SimpleNamespace(source=source), runner)
        try:
            for stage in ("unknown", iso.AGENT_EXECUTION_STAGE):
                with self.assertRaisesRegex(iso.IsolationAbort, "runtime_resolution_unverified"):
                    iso.refuse_unverified_runtime(stage)
            copied = iso._RuntimeRouteAdmission(**vars(iso._RUNTIME_ROUTE.get()))
            copied_token = iso._RUNTIME_ROUTE.set(copied)
            try:
                with self.assertRaisesRegex(iso.IsolationAbort, "runtime_resolution_unverified"):
                    iso.refuse_unverified_runtime(iso.RUNTIME_RESOLUTION_STAGE)
            finally:
                iso._RUNTIME_ROUTE.reset(copied_token)
        finally:
            iso._RUNTIME_ROUTE.reset(admission_token)
            iso.exit_isolated_turn(token)


if __name__ == "__main__":
    unittest.main()
