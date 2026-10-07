"""Host-only acceptance for narrow gateway admission composition."""
import tempfile
import unittest
from pathlib import Path

STAGING = Path(__file__).resolve().parents[1]


class GatewayAdmissionCompositionTests(unittest.TestCase):
    def test_reviewed_modules_and_reproducible_installer_are_packaged(self):
        expected = (
            STAGING / "proposed_admission_lock_adapter.py",
            STAGING / "gateway" / "admission_lock_owner.py",
            STAGING / "gateway" / "identity_admission_owner.py",
            STAGING / "gateway" / "terminal_operation_journal.py",
            STAGING / "install_gateway_admission.py",
            STAGING / "wolfhouse" / "gateway_admission_integration.py",
        )
        self.assertTrue(all(path.is_file() for path in expected), expected)
        dockerfile = (STAGING / "Dockerfile").read_text()
        bootstrap = (STAGING / "bootstrap.sh").read_text()
        self.assertIn("install_gateway_admission.py", dockerfile)
        self.assertIn("install_gateway_admission.py", bootstrap)

    def test_composed_source_claims_capacity_before_admitting_and_releases_refusal(self):
        from install_gateway_admission import compose_source

        source = '''\nclass GatewayRunner:\n    async def _handle_message(self, event):\n        source = event.source\n        _quick_key = "session"\n        _active_session_lease, _limit_message = self._claim_active_session_slot(\n            _quick_key,\n            source,\n        )\n        if _limit_message is not None:\n            return _limit_message\n        if _active_session_lease is not None:\n            if not hasattr(self, "_active_session_leases"):\n                self._active_session_leases = {}\n            self._active_session_leases[_quick_key] = _active_session_lease\n        self._running_agents[_quick_key] = _AGENT_PENDING_SENTINEL\n'''
        composed = compose_source(source)
        claim = composed.index("self._claim_active_session_slot")
        admission = composed.index("admit_gateway_message")
        sentinel = composed.index("self._running_agents[_quick_key]")
        self.assertLess(claim, admission)
        self.assertLess(admission, sentinel)
        self.assertIn("self._release_running_agent_state(_quick_key)", composed)
        self.assertEqual(compose_source(composed), composed)

    def test_fresh_message_admits_once_and_completed_exact_replay_uses_first_yes_owner(self):
        import gateway.identity_admission_owner as admission_owner
        from wolfhouse import gateway_admission_integration as admission

        class Source:
            platform = type("Platform", (), {"value": "whatsapp"})()
            chat_id = "chat-1"
        class Event:
            source = Source()
            message_id = "wamid-1"
            text = "yes"
        runner = type("Runner", (), {})()
        calls = []
        with tempfile.TemporaryDirectory() as tmp:
            admission_owner._ADAPTER_PATH = str(STAGING / "proposed_admission_lock_adapter.py")
            admission._JOURNAL_PATH = str(Path(tmp) / "admission.journal")
            admission._arm_exact_first_yes_retry = lambda **kw: calls.append(kw) or True
            self.assertTrue(admission.admit_gateway_message(runner, Event(), Event.source, "session-1"))
            self.assertTrue(admission.admit_gateway_message(runner, Event(), Event.source, "session-1"))
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["message_id"], "wamid-1")
        self.assertEqual(calls[0]["raw"], "yes")
        self.assertEqual(calls[0]["identity"], ("whatsapp", "chat-1", "wamid-1"))

    def test_changed_or_stale_replay_is_refused_while_unrelated_fresh_message_is_unaffected(self):
        import gateway.identity_admission_owner as admission_owner
        from wolfhouse import gateway_admission_integration as admission

        class Source:
            platform = type("Platform", (), {"value": "whatsapp"})()
            chat_id = "chat-2"
        class Event:
            source = Source()
            text = "yes"
            def __init__(self, message_id): self.message_id = message_id
        runner = type("Runner", (), {})()
        probes = []
        with tempfile.TemporaryDirectory() as tmp:
            admission_owner._ADAPTER_PATH = str(STAGING / "proposed_admission_lock_adapter.py")
            admission._JOURNAL_PATH = str(Path(tmp) / "admission.journal")
            admission._arm_exact_first_yes_retry = lambda **kw: probes.append(kw) or False
            self.assertTrue(admission.admit_gateway_message(runner, Event("same"), Event.source, "s"))
            self.assertFalse(admission.admit_gateway_message(runner, Event("same"), Event.source, "s"))
            self.assertTrue(admission.admit_gateway_message(runner, Event("unrelated"), Event.source, "s"))
        self.assertEqual([call["message_id"] for call in probes], ["same"])

    def test_exact_retry_fence_is_task_local_once_only_and_never_caller_controlled(self):
        from wolfhouse.accepted_quote import (
            _arm_exact_gateway_retry_for_owner,
            _consume_exact_gateway_retry,
        )
        frozen = {
            "session_key": "session-3",
            "identity": ("whatsapp", "chat-3", "mid-3"),
            "message_id": "mid-3",
            "raw_digest": "frozen-digest",
        }
        self.assertTrue(_arm_exact_gateway_retry_for_owner(frozen))
        self.assertEqual(_consume_exact_gateway_retry(), frozen)
        self.assertIsNone(_consume_exact_gateway_retry())

    def test_first_yes_owner_allows_only_completed_or_interrupted_exact_operation(self):
        from wolfhouse.accepted_quote import supports_exact_gateway_retry
        import hashlib
        import json
        from contextlib import nullcontext

        raw = "yes"
        base = {
            "version": 1,
            "scope": {"PLATFORM": "whatsapp", "CHAT_ID": "chat-3", "KEY": "session-3", "ID": "sid-3"},
            "incarnation": "start",
            "seen": ["mid-3"],
            "status": "accepted",
            "plan": {},
            "quote": {"success": True, "total_cents": 100},
            "checked_offer": {"offer_fingerprint": "frozen"},
            "auto_acceptance": True,
            "acceptance_message": "mid-3",
            "acceptance_raw_digest": hashlib.sha256(raw.encode()).hexdigest(),
            "receipt": {"booking_id": "B1"},
        }
        class Cursor:
            def __init__(self, state): self.state = state
            def fetchall(self): return [(json.dumps(self.state),)]
        class Connection:
            def __init__(self, state): self.state = state
            def execute(self, *args): return Cursor(self.state)
        class DB:
            def __init__(self, state): self._lock, self._conn = nullcontext(), Connection(state)
        entry = type("Entry", (), {"session_id": "sid-3"})()
        runner = type("Runner", (), {
            "_session_db": DB(base),
            "session_store": type("Store", (), {"_entries": {"session-3": entry}})(),
        })()
        kwargs = dict(runner=runner, session_key="session-3",
                      identity=("whatsapp", "chat-3", "mid-3"), message_id="mid-3", raw=raw)
        self.assertTrue(supports_exact_gateway_retry(**kwargs))
        interrupted = dict(base, receipt=None, dispatch_pending=True)
        runner._session_db = DB(interrupted)
        self.assertTrue(supports_exact_gateway_retry(**kwargs))
        for changed in (dict(kwargs, raw="yes please"), dict(kwargs, message_id="other"),
                        dict(kwargs, identity=("whatsapp", "chat-3", "other"))):
            self.assertFalse(supports_exact_gateway_retry(**changed))

    def test_contact_substep_never_blindly_retries_a_maybe_started_write(self):
        from wolfhouse.accepted_quote import _contact_transition
        state = {"receipt": {"booking_code": "UNIT-1"}}
        identity = {"email": "alex@example.test", "booking_code": "UNIT-1"}
        pending = _contact_transition(state, "ensure", identity=identity)
        self.assertEqual(pending["status"], "pending")
        started = _contact_transition(state, "begin", identity=identity)
        self.assertTrue(started["perform"])
        self.assertEqual(started["contact"]["status"], "unknown")
        replay = _contact_transition(state, "begin", identity=identity)
        self.assertFalse(replay["perform"])
        self.assertEqual(replay["contact"]["status"], "unknown")
        completed = _contact_transition(state, "complete", identity=identity,
                                        outcome={"outcome": "saved", "saved": True})
        self.assertEqual(completed["status"], "completed")
        self.assertEqual(completed["outcome"]["outcome"], "saved")


if __name__ == "__main__":
    unittest.main(verbosity=2)
