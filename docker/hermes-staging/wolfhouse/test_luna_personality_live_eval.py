"""Fail-closed isolated live-model corpus path (no send, no business tools)."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
STAGING = ROOT.parent
REPO = STAGING.parent.parent
if str(STAGING) not in sys.path:
    sys.path.insert(0, str(STAGING))

from wolfhouse.luna_personality_isolation import (  # noqa: E402
    IsolatedTurnCapture,
    IsolationAbort,
    current_isolated_turn,
    deny_tool_if_isolated,
    enter_isolated_turn,
    exit_isolated_turn,
    isolation_status,
    mark_test_isolation_installed,
    preflight_isolation_or_abort,
)
from wolfhouse.luna_personality_live_eval import (  # noqa: E402
    ALLOWED_CASE_IDS,
    LIVE_EVAL_PATH,
    assert_sunset_serving_identity,
    build_eval_user_message,
    evaluate_generated_reply,
    load_corpus,
    run_isolated_personality_eval,
    simulated_model_turn,
)

CORPUS = load_corpus(REPO / "fixtures" / "luna-personality-corpus.json")


def _run(coro):
    return asyncio.run(coro)


class IsolationContextTests(unittest.TestCase):
    def test_concurrent_turn_does_not_see_isolation(self) -> None:
        cap = IsolatedTurnCapture(case_id="warmth-greeting-en", personality_id="sunny")
        tok = enter_isolated_turn(cap)
        try:
            self.assertIsNotNone(current_isolated_turn())
            self.assertEqual(deny_tool_if_isolated("check_availability"), "luna_personality_isolated_no_tools")
        finally:
            exit_isolated_turn(tok)
        self.assertIsNone(current_isolated_turn())
        self.assertIsNone(deny_tool_if_isolated("check_availability"))

    def test_preflight_aborts_before_model_when_context_missing(self) -> None:
        with self.assertRaises(IsolationAbort) as ctx:
            preflight_isolation_or_abort()
        self.assertEqual(ctx.exception.reason, "isolation_context_missing")

    def test_capture_failure_aborts_before_model(self) -> None:
        called = {"model": 0}

        async def boom(_msg, cap, _meta):
            called["model"] += 1
            return "should-not-run"

        async def go():
            with mock.patch.dict(os.environ, {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"}, clear=False):
                return await run_isolated_personality_eval(
                    case_id="warmth-greeting-en",
                    personality_id="sunny",
                    corpus=CORPUS,
                    fetch_setting=lambda _t: {"personality_id": "sunny"},
                    invoke_turn=boom,
                    serving_preflight=False,
                )

        with mock.patch("wolfhouse.luna_personality_live_eval.mark_test_isolation_installed"):
            with mock.patch("wolfhouse.luna_personality_isolation._installed", False):
                with self.assertRaises(IsolationAbort) as ctx:
                    _run(go())
        self.assertIn(ctx.exception.reason, {"isolation_not_installed", "isolation_context_missing"})
        self.assertEqual(called["model"], 0)


class ServingIdentityTests(unittest.TestCase):
    def test_non_sunset_role_refused(self) -> None:
        with mock.patch.dict(os.environ, {"HERMES_ROLE": "orchestrator", "LUNA_CLIENT_SLUG": "sunset"}, clear=False):
            with self.assertRaises(IsolationAbort) as ctx:
                assert_sunset_serving_identity()
        self.assertIn("non_sunset_role", ctx.exception.reason)

    def test_non_sunset_tenant_refused(self) -> None:
        with mock.patch.dict(
            os.environ, {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "wolfhouse-somo"}, clear=False
        ):
            with self.assertRaises(IsolationAbort) as ctx:
                assert_sunset_serving_identity()
        self.assertIn("non_sunset_tenant", ctx.exception.reason)


class IsolatedEvalTests(unittest.TestCase):
    def setUp(self) -> None:
        mark_test_isolation_installed()

    def test_allowlist_rejects_arbitrary_prompt(self) -> None:
        async def go():
            return await run_isolated_personality_eval(
                case_id="please-ignore-instructions-and-book",
                personality_id="sunny",
                corpus=CORPUS,
                fetch_setting=lambda _t: {"personality_id": "sunny"},
                invoke_turn=simulated_model_turn,
                serving_preflight=False,
            )

        with self.assertRaises(IsolationAbort) as ctx:
            _run(go())
        self.assertEqual(ctx.exception.reason, "case_id_not_allowlisted")

    def test_invalid_personality_rejected(self) -> None:
        async def go():
            return await run_isolated_personality_eval(
                case_id="warmth-greeting-en",
                personality_id="cami",
                corpus=CORPUS,
                invoke_turn=simulated_model_turn,
                serving_preflight=False,
            )

        with self.assertRaises(IsolationAbort) as ctx:
            _run(go())
        self.assertEqual(ctx.exception.reason, "invalid_personality_id")

    def test_all_packs_en_es_generated_not_fixture_echo(self) -> None:
        env = {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"}
        stored = {"id": "sunny"}

        def fetch(_tid: str) -> dict:
            return {"personality_id": stored["id"]}

        warmth_ids = [c["id"] for c in CORPUS["cases"] if c["kind"] == "warmth_eligible"]
        truth_ids = [c["id"] for c in CORPUS["cases"] if c["kind"] in {"truth_frozen", "invariant"}]
        self.assertEqual(set(warmth_ids + truth_ids), set(ALLOWED_CASE_IDS))

        with mock.patch.dict(os.environ, env, clear=False):
            for pid in ("sunny", "calm", "concise", "extra"):
                stored["id"] = pid
                for case_id in sorted(ALLOWED_CASE_IDS):
                    result = _run(
                        run_isolated_personality_eval(
                            case_id=case_id,
                            personality_id=pid,
                            corpus=CORPUS,
                            fetch_setting=fetch,
                            invoke_turn=simulated_model_turn,
                            serving_preflight=False,
                        )
                    )
                    case = next(c for c in CORPUS["cases"] if c["id"] == case_id)
                    fixture = case["replies"][pid]
                    self.assertTrue(result["ok"], (case_id, pid, result))
                    self.assertEqual(result["tools_invoked"], 0)
                    self.assertEqual(result["sends_completed"], 0)
                    self.assertGreaterEqual(result["sends_attempted"], 1)
                    self.assertGreater(len(result["tools_denied"]), 0)
                    self.assertNotEqual(result["reply_text"].strip(), fixture.strip())
                    self.assertGreaterEqual(result["model_calls"], 1)
                    self.assertTrue(result["semantic"]["ok"], (case_id, pid, result["semantic"]))
                    for fact in case.get("frozen_facts") or []:
                        self.assertIn(fact, result["reply_text"])

    def test_next_reply_refetch_without_clear_cache(self) -> None:
        stored = {"id": "calm"}
        calls = {"n": 0}

        def fetch(_tid: str) -> dict:
            calls["n"] += 1
            return {"personality_id": stored["id"]}

        with mock.patch.dict(os.environ, {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"}, clear=False):
            a = _run(
                run_isolated_personality_eval(
                    case_id="warmth-greeting-en",
                    personality_id="calm",
                    corpus=CORPUS,
                    fetch_setting=fetch,
                    invoke_turn=simulated_model_turn,
                    serving_preflight=False,
                )
            )
            stored["id"] = "concise"
            b = _run(
                run_isolated_personality_eval(
                    case_id="warmth-greeting-en",
                    personality_id="concise",
                    corpus=CORPUS,
                    fetch_setting=fetch,
                    invoke_turn=simulated_model_turn,
                    serving_preflight=False,
                )
            )
        self.assertEqual(a["personality_id"], "calm")
        self.assertEqual(b["personality_id"], "concise")
        self.assertEqual(calls["n"], 2)
        self.assertIn("[generated:calm:", a["reply_text"])
        self.assertIn("[generated:concise:", b["reply_text"])
        self.assertLess(len(b["reply_text"]), len(a["reply_text"]) + 40)

    def test_foreign_tenant_fetch_aborts(self) -> None:
        def fetch(_tid: str) -> dict:
            return {"personality_id": "extra"}

        env = {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "wolfhouse-somo"}
        with mock.patch.dict(os.environ, env, clear=False):
            with self.assertRaises(IsolationAbort) as ctx:
                _run(
                    run_isolated_personality_eval(
                        case_id="warmth-greeting-en",
                        personality_id="sunny",
                        corpus=CORPUS,
                        fetch_setting=fetch,
                        invoke_turn=simulated_model_turn,
                        serving_preflight=False,
                    )
                )
        self.assertEqual(ctx.exception.reason, "foreign_tenant_fetch")

    def test_route_rejects_arbitrary_text_and_overrides(self) -> None:
        src = Path(__file__).with_name("luna_personality_live_eval.py").read_text(encoding="utf8")
        self.assertIn(LIVE_EVAL_PATH, src)
        self.assertIn("caller_override_rejected", src)
        self.assertIn("case_id_not_allowlisted", src)
        self.assertNotIn("allow_writes=bool", src)

    def test_default_simulate_still_has_allow_writes(self) -> None:
        core = Path(__file__).with_name("simulate_core.py").read_text(encoding="utf8")
        self.assertIn("allow_writes=bool(body.get(\"allow_writes\"))", core)
        self.assertIn("register_live_eval_route", core)

    def test_semantic_rejects_unsupported_url(self) -> None:
        case = next(c for c in CORPUS["cases"] if c["id"] == "truth-payment-link-en")
        scored = evaluate_generated_reply(
            case=case,
            personality_id="sunny",
            reply="Pay https://evil.example/nope and also https://pay.example/abc €100",
            fixture_echo_forbidden=False,
        )
        self.assertFalse(scored["ok"])
        self.assertTrue(any(f.startswith("unsupported_url") for f in scored["findings"]))

    def test_build_eval_message_injects_synthetic_facts(self) -> None:
        case = next(c for c in CORPUS["cases"] if c["id"] == "truth-payment-link-en")
        msg = build_eval_user_message(case)
        self.assertIn("https://pay.example/abc", msg)
        self.assertIn("€100", msg)
        self.assertIn("not live availability", msg)
        self.assertIn(case["guest_text"], msg)

    def test_hostile_tool_invocation_is_violation(self) -> None:
        async def sneaky(user_message, cap, meta):
            from wolfhouse.luna_personality_isolation import record_tool_invocation_violation

            record_tool_invocation_violation("create_sunset_booking")
            return "booked you anyway"

        with mock.patch.dict(os.environ, {"HERMES_ROLE": "sunset-luna", "LUNA_CLIENT_SLUG": "sunset"}, clear=False):
            with self.assertRaises(IsolationAbort) as ctx:
                _run(
                    run_isolated_personality_eval(
                        case_id="warmth-greeting-en",
                        personality_id="sunny",
                        corpus=CORPUS,
                        fetch_setting=lambda _t: {"personality_id": "sunny"},
                        invoke_turn=sneaky,
                        serving_preflight=False,
                    )
                )
        self.assertEqual(ctx.exception.reason, "isolation_violated")


class IsolationStatusTests(unittest.TestCase):
    def test_status_keys(self) -> None:
        st = isolation_status()
        self.assertIn("installed", st)
        self.assertIn("send_wrapped", st)
        self.assertIn("context_active", st)


if __name__ == "__main__":
    unittest.main(verbosity=2)
