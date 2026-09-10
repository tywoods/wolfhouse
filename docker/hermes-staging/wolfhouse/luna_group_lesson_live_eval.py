"""Closed LR2.1 Sunset case-09 live eval with read-only Staff tools."""

from __future__ import annotations

import importlib
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from wolfhouse.luna_personality_isolation import (
    IsolatedTurnCapture,
    IsolationAbort,
    enter_isolated_turn,
    exit_isolated_turn,
    install_isolation_runtime,
    mark_test_isolation_installed,
    preflight_isolation_or_abort,
    settle_isolated_work,
)
from wolfhouse.luna_personality_live_eval import (
    _eval_unauthorized,
    assert_sunset_serving_identity,
    default_invoke_live_gateway,
    live_sunset_eval_identity,
    serving_eval_readiness,
)
from wolfhouse.staging_guard import assert_staging_environment

GROUP_LESSON_EVAL_PATH = "/whatsapp/v1/internal/luna-group-lesson-live-eval"
CORPUS_FILENAME = "luna-group-lesson-live-corpus.json"
CORPUS_SHA256 = "0f48e31cb007f90e3596f7d0b973e6962c562d6f46b49243df40ca109cd53cf4"
INSTALLED_CORPUS_PATH = Path("/etc/hermes-staging/fixtures") / CORPUS_FILENAME
REPO_MOUNT_CORPUS_PATH = Path("/opt/wolfhouse/WH/fixtures") / CORPUS_FILENAME
ALLOWED_CASE_IDS = frozenset({"sunset-group-lesson-09-es"})
EXPECTED_MODEL = "gpt-5.6-sol"
READ_ONLY_TOOL_ALLOWLIST = frozenset({
    "get_sunset_lesson_catalog",
    "get_sunset_lesson_availability",
    "get_sunset_offering_quote",
})
# Exact internal endpoints reached by the three tools above. No arbitrary Staff
# GET/POST is admitted; the existing _post_bot transport remains the owner.
READ_ONLY_STAFF_PATHS = frozenset({
    "/sunset/catalog",
    "/sunset/joinable-courses",
    "/sunset/lesson-availability",
    "/sunset/offering-quote",
})
REQUIRED_CASE_09_TOOL_SEQUENCE = (
    "get_sunset_lesson_catalog",
    "get_sunset_lesson_availability",
    "get_sunset_offering_quote",
)
REQUIRED_CASE_09_STAFF_PATHS = frozenset(READ_ONLY_STAFF_PATHS)


def corpus_candidates(*, here: Optional[Path] = None):
    module = (here or Path(__file__)).resolve()
    candidates = [module.parents[1] / "fixtures" / CORPUS_FILENAME]
    if len(module.parents) > 3:
        candidates.append(module.parents[3] / "fixtures" / CORPUS_FILENAME)
    candidates.extend((REPO_MOUNT_CORPUS_PATH, INSTALLED_CORPUS_PATH))
    return list(dict.fromkeys(candidates))


def load_group_lesson_corpus(path: Optional[Path] = None) -> Dict[str, Any]:
    target = path
    if target is None:
        target = next((p for p in corpus_candidates() if p.is_file()), corpus_candidates()[0])
    raw = target.read_bytes()
    if hashlib.sha256(raw).hexdigest() != CORPUS_SHA256:
        raise IsolationAbort("corpus_not_closed")
    corpus = json.loads(raw.decode("utf-8"))
    ids = [item.get("id") for item in corpus.get("cases") or []]
    if ids != ["sunset-group-lesson-09-es"]:
        raise IsolationAbort("corpus_not_closed")
    return corpus


def _case(case_id: str) -> Dict[str, Any]:
    if case_id not in ALLOWED_CASE_IDS:
        raise IsolationAbort("case_id_not_allowlisted")
    return load_group_lesson_corpus()["cases"][0]


def _message(case: Dict[str, Any]) -> str:
    required_sequence = " -> ".join(REQUIRED_CASE_09_TOOL_SEQUENCE)
    return (
        "Closed Sunset staging LR3.2 evaluation. You may call only these read-only tools: "
        + ", ".join(sorted(READ_ONLY_TOOL_ALLOWLIST))
        + ". You must successfully complete these read-only tools in this exact order before "
        + "completing the response: " + required_sequence + ". "
        + case["response_contract"] + "\n\nGuest: " + case["guest_text"]
    )


def _abort_counters(cap: IsolatedTurnCapture, *, settled: bool) -> Dict[str, Any]:
    def count(name: str):
        value = getattr(cap, name, None)
        return value if settled and type(value) is int and 0 <= value <= 2**53 - 1 else None

    def observed(name: str):
        value = getattr(cap, name, None)
        return list(value) if isinstance(value, list) else None

    return {
        "read_tools_invoked": observed("read_tools_invoked"),
        "read_tools_completed": observed("read_tools_completed"),
        "read_staff_paths_invoked": observed("read_staff_paths_invoked"),
        "read_staff_paths_completed": observed("read_staff_paths_completed"),
        "required_tool_sequence": list(REQUIRED_CASE_09_TOOL_SEQUENCE),
        "required_staff_paths": sorted(REQUIRED_CASE_09_STAFF_PATHS),
        "tools_invoked_prohibited": count("tools_invoked"),
        "sends_attempted": count("sends_attempted"),
        "sends_completed": count("sends_completed"),
        "journal_writes_completed": count("journal_writes_completed"),
        "persistence_effects_completed": observed("persistence_effects_completed"),
        "model_calls": count("model_calls"),
        "counter_snapshot_state": "settled_tracked_work" if settled else "partial",
    }


async def run_isolated_group_lesson_eval(*, case_id: str, invoke_turn=None, require_live_seams: bool = True):
    case = _case(str(case_id or "").strip())
    assert_staging_environment()
    identity = assert_sunset_serving_identity(require_home=require_live_seams, require_staff_origin=True)
    declared = (os.getenv("HERMES_MODEL") or os.getenv("LLM_MODEL") or "").strip()
    if declared != EXPECTED_MODEL:
        raise IsolationAbort("model_declaration_mismatch")

    if invoke_turn is None or require_live_seams:
        install_isolation_runtime()
    else:
        mark_test_isolation_installed()
    cap = IsolatedTurnCapture(case_id=case["id"], personality_id="sunny", tenant_id="sunset")
    cap.read_only_tool_allowlist = READ_ONLY_TOOL_ALLOWLIST
    cap.read_only_staff_paths = READ_ONLY_STAFF_PATHS
    cap.evidence_kind = "live_gateway" if invoke_turn is None else "test_double"
    token = enter_isolated_turn(cap)
    first_abort = None
    try:
        preflight_isolation_or_abort(require_live_seams=require_live_seams)
        reply = await (invoke_turn or default_invoke_live_gateway)(_message(case), cap, {"case": case})
        cap.final_handler_text = str(reply or "").strip()
        settle_isolated_work(cap)
        if cap.model_calls < 1 or not cap.model_called:
            raise IsolationAbort("model_not_invoked")
        if cap.model != EXPECTED_MODEL:
            raise IsolationAbort("consumed_model_mismatch")
        if (cap.tools_invoked or cap.sends_completed or cap.journal_writes_completed
                or cap.persistence_effects_completed):
            raise IsolationAbort("isolation_violated")
        if any(name not in READ_ONLY_TOOL_ALLOWLIST for name in cap.read_tools_invoked):
            raise IsolationAbort("tool_allowlist_violated")
        if any(path not in READ_ONLY_STAFF_PATHS for path in cap.read_staff_paths_invoked):
            raise IsolationAbort("staff_path_allowlist_violated")
        if tuple(cap.read_tools_completed) != REQUIRED_CASE_09_TOOL_SEQUENCE:
            raise IsolationAbort("required_tool_sequence_incomplete")
        if (len(cap.read_staff_paths_completed) != len(REQUIRED_CASE_09_STAFF_PATHS)
                or set(cap.read_staff_paths_completed) != REQUIRED_CASE_09_STAFF_PATHS):
            raise IsolationAbort("required_staff_reads_incomplete")

        # Current isolation owner can prove exact calls and effects, but does not
        # capture authoritative tool result bodies. Therefore it must not label a
        # generated factual answer grounded. Fail closed instead of faking success.
        return {
            "ok": False,
            "status": "BLOCKED",
            "error": "authoritative_read_result_unobservable",
            "case_id": case["id"],
            "reply_text": "BLOCKED: authoritative Sunset read results could not be verified.",
            "generated_reply_withheld": bool(cap.final_handler_text),
            "read_tools_invoked": list(cap.read_tools_invoked),
            "read_staff_paths_invoked": list(cap.read_staff_paths_invoked),
            "read_tools_completed": list(cap.read_tools_completed),
            "read_staff_paths_completed": list(cap.read_staff_paths_completed),
            "tool_allowlist": sorted(READ_ONLY_TOOL_ALLOWLIST),
            "tools_denied": list(cap.tools_denied),
            "tools_invoked_prohibited": cap.tools_invoked,
            "sends_attempted": cap.sends_attempted,
            "sends_completed": cap.sends_completed,
            "journal_writes_completed": cap.journal_writes_completed,
            "persistence_effects_completed": list(cap.persistence_effects_completed),
            "model": cap.model,
            "model_calls": cap.model_calls,
            "serving_identity": identity,
        }
    except IsolationAbort as exc:
        first_abort = exc
        raise
    finally:
        settle_abort = None
        settled = False
        try:
            settle_isolated_work(cap)
            settled = True
        except IsolationAbort as exc:
            settle_abort = exc
        except Exception:
            settle_abort = IsolationAbort("cleanup_failed")
        finally:
            exit_isolated_turn(token)
        failure = first_abort or settle_abort
        if failure is not None:
            failure.counters = _abort_counters(cap, settled=settled)
            if first_abort is None:
                raise failure


def register_group_lesson_eval_route(app) -> bool:
    if live_sunset_eval_identity() is None:
        return False
    if getattr(app, "_luna_group_lesson_eval_registered", False):
        return True

    async def _ready(request):
        denied = _eval_unauthorized(request)
        if denied is not None:
            return denied
        from aiohttp import web
        result = serving_eval_readiness()
        result.update(route=GROUP_LESSON_EVAL_PATH, case_ids=sorted(ALLOWED_CASE_IDS),
                      tool_allowlist=sorted(READ_ONLY_TOOL_ALLOWLIST), model=EXPECTED_MODEL)
        return web.json_response(result, status=200 if result.get("ready") else 503)

    async def _handle(request):
        denied = _eval_unauthorized(request)
        if denied is not None:
            return denied
        from aiohttp import web
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)
        if set(body) != {"case_id"} or not isinstance(body.get("case_id"), str):
            return web.json_response({"ok": False, "error": "caller_override_rejected"}, status=400)
        try:
            canonical = importlib.import_module("wolfhouse.luna_group_lesson_live_eval")
            result = await canonical.run_isolated_group_lesson_eval(case_id=str(body.get("case_id") or ""))
        except IsolationAbort as exc:
            return web.json_response({"ok": False, "status": "BLOCKED", "error": exc.reason,
                                      "counters": exc.counters}, status=503)
        except Exception as exc:
            return web.json_response({"ok": False, "status": "BLOCKED", "error": type(exc).__name__}, status=500)
        return web.json_response(result, status=200)

    app.router.add_get(GROUP_LESSON_EVAL_PATH, _ready)
    app.router.add_post(GROUP_LESSON_EVAL_PATH, _handle)
    setattr(app, "_luna_group_lesson_eval_registered", True)
    return True
