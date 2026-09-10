"""Closed LR2.1 Sunset case-09 live eval with read-only Staff tools."""

from __future__ import annotations

import importlib
import hashlib
import json
import os
import uuid
from dataclasses import dataclass, field
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
from wolfhouse.luna_responses_provider import (
    item_type_name as _item_type_name,
    normalize_responses_tool_choice,
    responses_tool_choice_wire,
    tool_choice_capture_label as _tool_choice_capture_label,
)
from wolfhouse.staging_guard import assert_staging_environment

GROUP_LESSON_EVAL_PATH = "/whatsapp/v1/internal/luna-group-lesson-live-eval"
GROUP_LESSON_DIAGNOSTIC_PATH = "/whatsapp/v1/internal/luna-group-lesson-named-read-diagnostic"
DIAGNOSTIC_CONTROL_NAME = "named_catalog_read_once"
DIAGNOSTIC_TOOL_NAME = "get_sunset_lesson_catalog"
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
REQUIRED_TOOL_INSTRUCTION_MARKER = "You must successfully complete these read-only tools in this exact order"
CAPTURE_LIMIT = 32
CAPTURE_SCHEMA_VERSION = 2


def _fingerprint(value: Any) -> str:
    """Fingerprint canonical metadata without retaining the payload."""
    encoded = json.dumps(value, ensure_ascii=True, sort_keys=True,
                         separators=(",", ":"), default=str).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


@dataclass
class BoundedMetadataCapture:
    """Bounded no-payload trace populated at provider/executor boundaries."""

    model: Optional[str]
    revisions: Dict[str, Optional[str]]
    instruction_marker: Optional[str] = None
    run_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    calls: list = field(default_factory=list)
    _current_call: Optional[Dict[str, Any]] = field(default=None, init=False, repr=False)
    request: Dict[str, Any] = field(default_factory=lambda: {
        "state": "not-reached", "attempted": None, "sent": None,
        "prompt_fingerprints": None, "tool_names": None,
        "tool_schema_fingerprints": None, "tool_choice": None,
        "tool_choice_wire": None,
    })
    response: Dict[str, Any] = field(default_factory=lambda: {
        "state": "not-reached", "status": None, "finish_reason": None,
        "tool_calls": None, "output_item_types": None,
    })
    executor: Dict[str, Any] = field(default_factory=lambda: {
        "state": "not-reached", "dispositions": None,
    })

    def _contains_instruction_marker(self, value: Any) -> Optional[bool]:
        if not self.instruction_marker:
            return None
        if isinstance(value, str):
            return self.instruction_marker in value
        if isinstance(value, dict):
            return any(self._contains_instruction_marker(item) is True for item in value.values())
        if isinstance(value, (list, tuple)):
            return any(self._contains_instruction_marker(item) is True for item in value)
        return False

    @staticmethod
    def _schema_valid(tool: Any) -> bool:
        if not isinstance(tool, dict):
            return False
        function = tool.get("function") if isinstance(tool.get("function"), dict) else tool
        schema = function.get("parameters", function.get("inputSchema"))
        return (isinstance(function.get("name"), str) and bool(function["name"])
                and isinstance(schema, dict) and schema.get("type") == "object")

    def _ensure_call(self, *, new_request: bool = False) -> Dict[str, Any]:
        if new_request or self._current_call is None:
            if len(self.calls) >= CAPTURE_LIMIT:
                return self.calls[-1]
            index = len(self.calls) + 1
            self._current_call = {
                "call_index": index,
                "correlation_id": f"{self.run_id}:{index}",
                "request": {"state": "not-reached"},
                "response": {"state": "not-reached"},
                "executor": {"state": "not-reached", "dispositions": None},
            }
            self.calls.append(self._current_call)
        return self._current_call

    def observe_request(self, *, attempted: bool, sent: bool, prompts: Any = None,
                        tools: Any = None, tool_choice: Any = None) -> None:
        """Hash prompt/schema values immediately; never retain their payloads."""
        prompt_values = prompts if isinstance(prompts, (list, tuple)) else None
        tool_values = tools if isinstance(tools, (list, tuple)) else None
        names, schemas = [], []
        if tool_values is not None:
            for tool in tool_values[:CAPTURE_LIMIT]:
                if not isinstance(tool, dict):
                    continue
                function = tool.get("function") if isinstance(tool.get("function"), dict) else tool
                names.append(str(function.get("name") or "unknown")[:256])
                schemas.append(_fingerprint(function.get("parameters", function.get("inputSchema"))))
        choice_metadata = _tool_choice_capture_label(tool_choice)
        choice_wire = responses_tool_choice_wire(tool_choice) if tool_choice is not None else None
        new_call = (self._current_call is None
                    or self._current_call["response"].get("state") != "not-reached"
                    or bool(self._current_call["request"].get("sent")))
        call = self._ensure_call(new_request=new_call)
        schema_validity = ([self._schema_valid(tool) for tool in tool_values[:CAPTURE_LIMIT]]
                           if tool_values is not None else None)
        self.request = {
            "state": "observed", "attempted": bool(attempted), "sent": bool(sent),
            "prompt_fingerprints": ([_fingerprint(item) for item in prompt_values[:CAPTURE_LIMIT]]
                                    if prompt_values is not None else None),
            "instruction_marker_present": self._contains_instruction_marker(prompt_values),
            "tool_names": names if tool_values is not None else None,
            "tool_schema_fingerprints": schemas if tool_values is not None else None,
            "tool_schema_validity": schema_validity,
            "schemas_valid": (all(schema_validity) if schema_validity is not None else None),
            "tool_choice": choice_metadata,
            "tool_choice_wire": choice_wire,
        }
        call["request"] = dict(self.request)

    def observe_response(self, *, status: Any, finish_reason: Any = None,
                         tool_calls: Any = None, provider_shape: str = "unknown",
                         completion_category: str = "other",
                         output_item_types: Any = None) -> None:
        calls = None
        if isinstance(tool_calls, (list, tuple)):
            calls = []
            for call in tool_calls[:CAPTURE_LIMIT]:
                if not isinstance(call, dict):
                    continue
                function = call.get("function") if isinstance(call.get("function"), dict) else call
                calls.append({
                    "id": str(call.get("id") or "")[:256] or None,
                    "name": str(function.get("name") or "unknown")[:256],
                    "arg_validation": str(call.get("arg_validation") or "capture-unavailable")[:256],
                })
        type_names = None
        if isinstance(output_item_types, (list, tuple)):
            type_names = [str(item)[:64] for item in output_item_types[:CAPTURE_LIMIT]]
        self.response = {
            "state": "observed-none" if calls == [] else "observed",
            "status": str(status)[:256] if status is not None else None,
            "finish_reason": str(finish_reason)[:256] if finish_reason is not None else None,
            "provider_shape": provider_shape,
            "completion_category": completion_category,
            "output_item_types": type_names,
            "tool_calls": calls,
        }
        call = self._ensure_call()
        call["response"] = dict(self.response)

    @staticmethod
    def _is_clarification(value: Any) -> bool:
        if isinstance(value, str):
            return value.rstrip().endswith("?")
        if isinstance(value, dict):
            return any(BoundedMetadataCapture._is_clarification(item)
                       for key, item in value.items() if key in {"content", "text", "output_text"})
        if isinstance(value, (list, tuple)):
            return any(BoundedMetadataCapture._is_clarification(item) for item in value)
        return False

    def observe_provider_result(self, result: Any) -> None:
        """Reduce OpenAI/Bedrock response shapes without retaining payloads."""
        def get(owner: Any, key: str, default: Any = None) -> Any:
            return owner.get(key, default) if isinstance(owner, dict) else getattr(owner, key, default)

        choices = get(result, "choices")
        finish_reason, calls = None, None
        provider_shape = "unknown"
        completion_category = "other"
        status = get(result, "status")
        if isinstance(choices, (list, tuple)) and choices:
            provider_shape = "chat_completions"
            choice = choices[0]
            finish_reason = get(choice, "finish_reason")
            message = get(choice, "message")
            calls = get(message, "tool_calls") if message is not None else None
            if get(message, "refusal") is not None:
                completion_category = "refusal"
            elif calls:
                completion_category = "tool_calls"
            elif self._is_clarification(get(message, "content")):
                completion_category = "clarification"
            elif get(message, "content") is not None:
                completion_category = "text_only"
        elif isinstance(result, dict) and isinstance(result.get("output"), dict):
            provider_shape = "bedrock_converse"
            finish_reason = result.get("stopReason")
            message = result["output"].get("message", result["output"])
            content = message.get("content") if isinstance(message, dict) else None
            if isinstance(content, list):
                calls = [{"id": use.get("toolUseId"), "function": {"name": use.get("name")},
                          "arg_validation": "capture-unavailable"}
                         for item in content[:CAPTURE_LIMIT]
                         for use in [item.get("toolUse") if isinstance(item, dict) else None]
                         if isinstance(use, dict)]
                completion_category = "tool_calls" if calls else "text_only"
        else:
            output = get(result, "output")
            if isinstance(output, (list, tuple)):
                provider_shape = "openai_responses"
                # OpenAI Responses terminal objects expose completed function
                # calls in output. Retain only identity and validation state.
                finish_reason = status
                calls = []
                output_types = []
                for item in output[:CAPTURE_LIMIT]:
                    item_type = _item_type_name(get(item, "type"))
                    if item_type is not None:
                        output_types.append(item_type)
                    if item_type != "function_call":
                        continue
                    nested = get(item, "function")
                    name = get(item, "name")
                    arguments = get(item, "arguments")
                    if isinstance(nested, dict):
                        if name is None:
                            name = nested.get("name")
                        if arguments is None:
                            arguments = nested.get("arguments")
                    calls.append({
                        "id": get(item, "call_id") or get(item, "id"),
                        "function": {"name": name, "arguments": arguments},
                    })
                content_types = [
                    _item_type_name(get(part, "type"))
                    for item in output[:CAPTURE_LIMIT]
                    for part in ((get(item, "content") or [])
                                 if isinstance(get(item, "content"), (list, tuple)) else [])
                ]
                content_types = [kind for kind in content_types if kind]
                if calls:
                    completion_category = "tool_calls"
                elif "refusal" in output_types or "refusal" in content_types:
                    completion_category = "refusal"
                elif self._is_clarification(output):
                    completion_category = "clarification"
                elif (any(kind in {"message", "output_text"} for kind in output_types)
                      or "output_text" in content_types):
                    completion_category = "text_only"
                else:
                    # Completed/non-message Responses with no extractable
                    # function_call items — Cap LR3.1 sealed empty-tool boundary.
                    completion_category = "empty_tool_calls"
                reduced = None
                if isinstance(calls, (list, tuple)):
                    reduced = []
                    for call in calls[:CAPTURE_LIMIT]:
                        function = get(call, "function", call)
                        arguments = get(function, "arguments")
                        validation = get(call, "arg_validation", "capture-unavailable")
                        if isinstance(arguments, str):
                            try:
                                validation = "valid" if isinstance(json.loads(arguments), dict) else "invalid:not-object"
                            except (TypeError, ValueError):
                                validation = "invalid:json"
                        elif isinstance(arguments, dict):
                            validation = "valid"
                        reduced.append({"id": get(call, "id"), "function": {"name": get(function, "name")},
                                        "arg_validation": validation})
                self.observe_response(
                    status=status or "ok", finish_reason=finish_reason, tool_calls=reduced,
                    provider_shape=provider_shape, completion_category=completion_category,
                    output_item_types=output_types,
                )
                if reduced == []:
                    self.observed_no_executor_calls()
                return
        reduced = None
        if isinstance(calls, (list, tuple)):
            reduced = []
            for call in calls[:CAPTURE_LIMIT]:
                function = get(call, "function", call)
                arguments = get(function, "arguments")
                validation = get(call, "arg_validation", "capture-unavailable")
                if isinstance(arguments, str):
                    try:
                        validation = "valid" if isinstance(json.loads(arguments), dict) else "invalid:not-object"
                    except (TypeError, ValueError):
                        validation = "invalid:json"
                elif isinstance(arguments, dict):
                    validation = "valid"
                reduced.append({"id": get(call, "id"), "function": {"name": get(function, "name")},
                                "arg_validation": validation})
        self.observe_response(
            status=status or "ok", finish_reason=finish_reason, tool_calls=reduced,
            provider_shape=provider_shape, completion_category=completion_category,
        )
        if reduced == []:
            self.observed_no_executor_calls()

    def record_disposition(self, *, call_id: Any, name: Any, disposition: str,
                           reason: Any = None) -> None:
        if disposition not in {"accepted", "rejected", "dispatched", "completed", "failed"}:
            raise ValueError("invalid_executor_disposition")
        call = self._ensure_call()
        call_executor = call["executor"]
        if call_executor["dispositions"] is None:
            call_executor = call["executor"] = {"state": "observed", "dispositions": []}
        provider_call_id = str(call_id or "")[:256] or None
        if provider_call_id is None:
            matching = [item.get("id") for item in (call["response"].get("tool_calls") or [])
                        if item.get("name") == str(name)]
            if len(matching) == 1:
                provider_call_id = matching[0]
        if len(call_executor["dispositions"]) < CAPTURE_LIMIT:
            disposition_record = {
                "id": provider_call_id,
                "provider_call_id": provider_call_id,
                "call_index": call["call_index"],
                "correlation_id": call["correlation_id"],
                "name": str(name or "unknown")[:256],
                "disposition": disposition,
                "reason": str(reason)[:256] if reason is not None else None,
            }
            call_executor["dispositions"].append(disposition_record)
        self.executor = {
            "state": call_executor["state"],
            "dispositions": list(call_executor["dispositions"]),
        }

    def observed_no_executor_calls(self) -> None:
        call = self._ensure_call()
        call["executor"] = {"state": "observed-none", "dispositions": []}
        self.executor = {"state": "observed-none", "dispositions": []}

    def finalize(self, *, model_reached: bool) -> Dict[str, Any]:
        if model_reached:
            for section in (self.request, self.response, self.executor):
                if section["state"] == "not-reached":
                    section["state"] = "capture-unavailable"
            for call in self.calls:
                for key in ("request", "response", "executor"):
                    if call[key]["state"] == "not-reached":
                        call[key]["state"] = "capture-unavailable"
        return {
            "schema_version": CAPTURE_SCHEMA_VERSION, "run_id": self.run_id,
            "revisions": dict(self.revisions), "model": self.model,
            "calls": [{
                "call_index": call["call_index"],
                "correlation_id": call["correlation_id"],
                "request": dict(call["request"]),
                "response": dict(call["response"]),
                "executor": {
                    "state": call["executor"]["state"],
                    "dispositions": (list(call["executor"]["dispositions"])
                                     if isinstance(call["executor"]["dispositions"], list) else None),
                },
            } for call in self.calls],
            "request": dict(self.request), "response": dict(self.response),
            "executor": {"state": self.executor["state"],
                         "dispositions": (list(self.executor["dispositions"])
                                          if isinstance(self.executor["dispositions"], list) else None)},
        }


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
        + ". " + REQUIRED_TOOL_INSTRUCTION_MARKER + " before "
        + "completing the response: " + required_sequence + ". "
        + case["response_contract"] + "\n\nGuest: " + case["guest_text"]
    )


def _abort_counters(cap: IsolatedTurnCapture, *, settled: bool,
                    instrumentation: Optional[BoundedMetadataCapture] = None) -> Dict[str, Any]:
    def count(name: str):
        value = getattr(cap, name, None)
        return value if settled and type(value) is int and 0 <= value <= 2**53 - 1 else None

    def observed(name: str):
        value = getattr(cap, name, None)
        return list(value) if isinstance(value, list) else None

    result = {
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
    if instrumentation is not None:
        result["capture"] = instrumentation.finalize(model_reached=bool(cap.model_called))
    return result


async def run_isolated_group_lesson_eval(*, case_id: str, invoke_turn=None,
                                         require_live_seams: bool = True,
                                         diagnostic_control: Optional[str] = None):
    if diagnostic_control not in (None, DIAGNOSTIC_CONTROL_NAME):
        raise IsolationAbort("diagnostic_control_invalid")
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
    if diagnostic_control == DIAGNOSTIC_CONTROL_NAME:
        cap.diagnostic_tool_choice = DIAGNOSTIC_TOOL_NAME
        cap.diagnostic_tool_choice_remaining = 1
    cap.evidence_kind = "live_gateway" if invoke_turn is None else "test_double"
    instrumentation = BoundedMetadataCapture(
        model=declared or None,
        revisions={"wolfhouse": os.getenv("WOLFHOUSE_REVISION") or None,
                   "hermes": os.getenv("HERMES_REVISION") or None},
        instruction_marker=REQUIRED_TOOL_INSTRUCTION_MARKER,
    )
    cap.metadata_capture = instrumentation
    token = enter_isolated_turn(cap)
    first_abort = None
    try:
        preflight_isolation_or_abort(require_live_seams=require_live_seams)
        reply = await (invoke_turn or default_invoke_live_gateway)(
            _message(case), cap,
            {"case": case, "capture_instrumentation": instrumentation},
        )
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
            "capture": instrumentation.finalize(model_reached=bool(cap.model_called)),
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
            failure.counters = _abort_counters(
                cap, settled=settled, instrumentation=instrumentation,
            )
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

    async def _diagnostic_handle(request):
        denied = _eval_unauthorized(request)
        if denied is not None:
            return denied
        from aiohttp import web
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"ok": False, "error": "invalid_json"}, status=400)
        expected = {"case_id", "diagnostic_control"}
        if (not isinstance(body, dict) or set(body) != expected
                or not isinstance(body.get("case_id"), str)
                or body.get("diagnostic_control") != DIAGNOSTIC_CONTROL_NAME):
            return web.json_response({"ok": False, "error": "caller_override_rejected"}, status=400)
        try:
            canonical = importlib.import_module("wolfhouse.luna_group_lesson_live_eval")
            result = await canonical.run_isolated_group_lesson_eval(
                case_id=str(body.get("case_id") or ""),
                diagnostic_control=DIAGNOSTIC_CONTROL_NAME,
            )
        except IsolationAbort as exc:
            return web.json_response({"ok": False, "status": "BLOCKED", "error": exc.reason,
                                      "counters": exc.counters}, status=503)
        except Exception as exc:
            return web.json_response({"ok": False, "status": "BLOCKED", "error": type(exc).__name__}, status=500)
        return web.json_response(result, status=200)

    app.router.add_get(GROUP_LESSON_EVAL_PATH, _ready)
    app.router.add_post(GROUP_LESSON_EVAL_PATH, _handle)
    app.router.add_post(GROUP_LESSON_DIAGNOSTIC_PATH, _diagnostic_handle)
    setattr(app, "_luna_group_lesson_eval_registered", True)
    return True
