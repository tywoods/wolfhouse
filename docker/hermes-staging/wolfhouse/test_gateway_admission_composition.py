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

        source = '''\nclass GatewayRunner:\n    def __init__(self):\n        self._admission_lock_owner = IdentityAdmissionOwner(\n            "/opt/data/luna-admission/owner.journal"\n        )\n\n    async def _handle_message(self, event):\n        source = event.source\n        _quick_key = "session"\n        # Existing adapter admit on this message identity, before session claim.\n        _legacy = True\n        if _legacy:\n            return None\n\n        # ── Claim this session before any await ───────────────────────\n        _active_session_lease, _limit_message = self._claim_active_session_slot(\n            _quick_key,\n            source,\n        )\n        if _limit_message is not None:\n            return _limit_message\n        if _active_session_lease is not None:\n            if not hasattr(self, "_active_session_leases"):\n                self._active_session_leases = {}\n            self._active_session_leases[_quick_key] = _active_session_lease\n        self._running_agents[_quick_key] = _AGENT_PENDING_SENTINEL\n'''
        composed = compose_source(source)
        claim = composed.index("self._claim_active_session_slot")
        admission = composed.index("admit_gateway_message")
        sentinel = composed.index("self._running_agents[_quick_key]")
        self.assertLess(claim, admission)
        self.assertLess(admission, sentinel)
        self.assertNotIn("Existing adapter admit on this message identity", composed)
        self.assertIn("/opt/data/luna-admission/owner.journal", composed)
        self.assertIn("self._release_running_agent_state(_quick_key)", composed)
        self.assertEqual(compose_source(composed), composed)

    def test_clean_source_initializes_same_owner_without_legacy_markers(self):
        from install_gateway_admission import compose_source

        source = '''
class GatewayRunner:
    def __init__(self):
        self._running_agents = {}

    async def _handle_message(self, event):
        source = event.source
        _quick_key = "session"
        self._running_agents[_quick_key] = _AGENT_PENDING_SENTINEL
'''
        composed = compose_source(source)
        self.assertEqual(composed.count('/opt/data/luna-admission/owner.journal'), 1)
        self.assertIn('from gateway.identity_admission_owner import IdentityAdmissionOwner', composed)
        self.assertLess(composed.index('self._admission_lock_owner = IdentityAdmissionOwner'),
                        composed.index('self._running_agents = {}'))
        self.assertEqual(compose_source(composed), composed)

    def test_fresh_message_admits_once_and_completed_exact_replay_uses_first_yes_owner(self):
        import fcntl
        import os
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
            runner._admission_lock_owner = admission_owner.IdentityAdmissionOwner(
                str(Path(tmp) / "owner.journal"))
            admission._arm_exact_first_yes_retry = lambda **kw: calls.append(kw) or True
            self.assertTrue(admission.admit_gateway_message(runner, Event(), Event.source, "session-1"))
            journal = runner._admission_lock_owner._journal_path(
                ("whatsapp", "chat-1", "wamid-1"))
            held = os.open(journal, os.O_RDWR)
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                self.assertFalse(admission.admit_gateway_message(
                    runner, Event(), Event.source, "session-1"))
                self.assertEqual(calls, [], 'locked custody must refuse recovery')
            finally:
                fcntl.flock(held, fcntl.LOCK_UN)
                os.close(held)
            self.assertTrue(admission.admit_gateway_message(runner, Event(), Event.source, "session-1"))
            runner._admission_lock_owner._release_inner()
            runner._admission_lock_owner._anchor._journal.close()
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
            runner._admission_lock_owner = admission_owner.IdentityAdmissionOwner(
                str(Path(tmp) / "owner.journal"))
            admission._arm_exact_first_yes_retry = lambda **kw: probes.append(kw) or False
            self.assertTrue(admission.admit_gateway_message(runner, Event("same"), Event.source, "s"))
            self.assertFalse(admission.admit_gateway_message(runner, Event("same"), Event.source, "s"))
            self.assertTrue(admission.admit_gateway_message(runner, Event("unrelated"), Event.source, "s"))
            runner._admission_lock_owner._release_inner()
            runner._admission_lock_owner._anchor._journal.close()
        self.assertEqual([call["message_id"] for call in probes], ["same"])

    def test_active_and_uncertain_admission_states_never_reach_recovery(self):
        import gateway.identity_admission_owner as admission_owner
        from wolfhouse import gateway_admission_integration as admission

        class Source:
            platform = type("Platform", (), {"value": "whatsapp"})()
            chat_id = "chat-unsafe"
        class Event:
            source = Source()
            message_id = "unsafe"
            text = "yes"
        probes = []
        admission._arm_exact_first_yes_retry = lambda **kw: probes.append(kw) or True
        admission_owner._ADAPTER_PATH = str(STAGING / "proposed_admission_lock_adapter.py")
        for status in ("ACTIVE", "UNCERTAIN_DENY"):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as tmp:
                owner = admission_owner.IdentityAdmissionOwner(str(Path(tmp) / "owner.journal"))
                owner.execution_identity = ("whatsapp", "chat-unsafe", "unsafe")
                inner = owner._ensure_inner()
                inner._journal.db.execute(
                    "UPDATE owner SET status=?, generation=1 WHERE id=1", (status,))
                runner = type("Runner", (), {"_admission_lock_owner": owner})()
                self.assertFalse(admission.admit_gateway_message(runner, Event(), Event.source, "s"))
                owner._release_inner()
                runner._admission_lock_owner._anchor._journal.close()
        with tempfile.TemporaryDirectory() as tmp:
            owner = admission_owner.IdentityAdmissionOwner(str(Path(tmp) / "owner.journal"))
            owner.execution_identity = ("whatsapp", "chat-unsafe", "unsafe")
            inner = owner._ensure_inner()
            inner._journal.db.execute("DROP TABLE owner")
            runner = type("Runner", (), {"_admission_lock_owner": owner})()
            self.assertFalse(admission.admit_gateway_message(runner, Event(), Event.source, "s"))
            owner._release_inner()
            runner._admission_lock_owner._anchor._journal.close()
        self.assertEqual(probes, [])

    def test_exact_retry_fence_is_task_local_once_only_and_never_caller_controlled(self):
        from wolfhouse.accepted_quote import (
            _arm_exact_gateway_retry_for_owner,
            _consume_exact_gateway_retry,
        )
        frozen = {
            "session_key": "session-3",
            "session_id": "sid-3",
            "identity": ("whatsapp", "chat-3", "mid-3"),
            "message_id": "mid-3",
            "raw_digest": "frozen-digest",
            "scope_digest": "scope-digest",
            "operation_key": "luna-owner-operation",
            "epoch": 7,
        }
        self.assertTrue(_arm_exact_gateway_retry_for_owner(frozen))
        from contextvars import copy_context
        first = copy_context()
        second = copy_context()
        self.assertEqual(first.run(_consume_exact_gateway_retry), ('claimed', frozen))
        self.assertEqual(second.run(_consume_exact_gateway_retry), ('spent', None))
        self.assertEqual(_consume_exact_gateway_retry(), ('spent', None))

    def test_spent_or_refused_retry_never_reaches_model_or_owner_mutation(self):
        import sys
        import types
        from contextvars import copy_context
        from unittest.mock import patch
        from wolfhouse import accepted_quote as ledger

        calls = []
        conversation = types.ModuleType('agent.conversation_loop')
        conversation.run_conversation = lambda *args, **kwargs: calls.append('model') or {
            'completed': True, 'final_response': 'model'}
        agent_module = types.ModuleType('agent')
        agent_module.conversation_loop = conversation
        frozen = {
            "session_key": "session-3", "session_id": "sid-3",
            "identity": ("whatsapp", "chat-3", "mid-3"), "message_id": "mid-3",
            "raw_digest": "frozen-digest", "scope_digest": "scope-digest",
            "operation_key": "luna-owner-operation", "epoch": 7,
        }
        with patch.dict(sys.modules, {
                'agent': agent_module, 'agent.conversation_loop': conversation}):
            ledger.install_owner_hook()
            self.assertTrue(ledger._arm_exact_gateway_retry_for_owner(frozen))
            first = copy_context()
            spent = copy_context()
            self.assertEqual(first.run(ledger._consume_exact_gateway_retry), ('claimed', frozen))
            response = spent.run(conversation.run_conversation, object(), 'thanks')
            self.assertEqual(response['api_calls'], 0)
            self.assertEqual(calls, [])

            self.assertTrue(ledger._arm_exact_gateway_retry_for_owner(frozen))
            with patch.object(ledger, '_prevalidate_exact_gateway_retry', return_value=False), \
                    patch.object(ledger, 'observe_owner_turn', side_effect=AssertionError('mutated')):
                refused = conversation.run_conversation(object(), 'thanks')
            self.assertEqual(refused['api_calls'], 0)
            self.assertEqual(calls, [])

    def test_first_yes_owner_allows_only_completed_or_interrupted_exact_operation(self):
        from wolfhouse.accepted_quote import (
            exact_gateway_recovery_capability,
            recovery_capability_matches,
            recovery_capability_precheck,
            supports_exact_gateway_retry,
        )
        import hashlib
        import json
        from contextlib import nullcontext

        raw = "yes"
        base = {
            "version": 1,
            "scope": {"PLATFORM": "whatsapp", "CHAT_ID": "chat-3", "KEY": "session-3", "ID": "sid-3"},
            "incarnation": "start",
            "epoch": 7,
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
        frozen = exact_gateway_recovery_capability(**kwargs)
        self.assertIsInstance(frozen, dict)
        self.assertTrue(recovery_capability_precheck(
            frozen, base, session_key="session-3", session_id="sid-3",
            identity=("whatsapp", "chat-3", "mid-3"), raw=raw))
        replacement = json.loads(json.dumps(base))
        replacement["plan"] = {"selected_bed_codes": ["OTHER"]}
        self.assertFalse(recovery_capability_precheck(
            frozen, replacement, session_key="session-3", session_id="sid-3",
            identity=("whatsapp", "chat-3", "mid-3"), raw=raw))
        self.assertEqual(replacement["status"], "accepted",
                         'precheck must not mutate replacement authorization')
        observed = json.loads(json.dumps(base))
        observed["epoch"] += 1
        self.assertTrue(recovery_capability_matches(
            frozen, observed, session_key="session-3", session_id="sid-3",
            identity=("whatsapp", "chat-3", "mid-3"), raw=raw))
        changed_operation = json.loads(json.dumps(observed))
        changed_operation["plan"] = {"selected_bed_codes": ["OTHER"]}
        self.assertFalse(recovery_capability_matches(
            frozen, changed_operation, session_key="session-3", session_id="sid-3",
            identity=("whatsapp", "chat-3", "mid-3"), raw=raw))
        changed_scope = json.loads(json.dumps(observed))
        changed_scope["scope"]["USER_ID"] = "different-user"
        self.assertFalse(recovery_capability_matches(
            frozen, changed_scope, session_key="session-3", session_id="sid-3",
            identity=("whatsapp", "chat-3", "mid-3"), raw=raw))
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
