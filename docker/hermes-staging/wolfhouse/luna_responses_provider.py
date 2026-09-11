"""Responses API request/response adapter helpers (offline + isolation).

Cap LR3.1-NAMED-READ-DIAG-RESULT-001 / LR3.2 tip after #953 / post-#956:

- Capture label ``function:TOOL`` is not a valid Responses ``tool_choice`` string.
  Canonical wire is ``{"type":"function","name":TOOL}``. Chat nested
  ``{"type":"function","function":{"name":TOOL}}`` is accepted and normalized.
- Chat Completions tool schemas must become flat Responses tools before the wire;
  already-flat tools must not be silently dropped.
- Hermes June-pin ``_consume_codex_event_stream`` assembles only from
  ``response.output_item.done`` and ignores ``response.completed.response.output``.
  When the provider places ``function_call`` items only on the terminal output,
  those calls are lost before executable normalization. Recovery merges terminal
  native items into the assembled response without dispatching tools.
- Post-#956 live still sealed ``empty_tool_calls`` with ``output_item_types=[]``.
  Labels alone cannot say WHERE the call disappeared. Wire-to-native boundary
  records + offline replay discriminate native-empty vs adapter-drop before any
  further repair/deploy.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.parse import urlparse

UNSUPPORTED_TOOL_CHOICE_LABEL_PREFIX = "function:"
_INCOMPLETE_ITEM_STATUSES = frozenset({"queued", "in_progress", "incomplete"})
PROVIDER_EMPTY_WITH_WIRE_OK = "provider_empty_with_wire_ok"
BOUNDARY_RECORD_SCHEMA_VERSION = 1
# Sealed post-#956 live (digest sha256:f74d9e5d… / master 39c9f014): wire OK +
# completed + tool_calls=[] + output_item_types=[]. Offline adapter recovers when
# native function_call is present; sealed capture lacked stream event types and
# assembled/terminal split, so observation_incomplete remains unfalsified from
# sealed alone. Do not keep repairing extraction until a boundary record proves
# adapter-drop.
COMPATIBILITY_BLOCKER_ID = (
    "lr32_post956_native_empty_or_observation_incomplete"
)
COMPATIBILITY_BLOCKER_MISSING_EVIDENCE = (
    "native_stream_event_types",
    "terminal_output_item_types",
    "assembled_output_item_types",
    "normalized_call_count",
    "boundary_verdict",
)
DIRECT_COMPARE_FLAG = "LUNA_LR32_BOUNDARY_DIRECT_COMPARE"


def item_type_name(value: Any) -> Optional[str]:
    """Normalize Responses/Chat item discriminators (str, Enum.value, etc.)."""
    if value is None:
        return None
    raw = getattr(value, "value", value)
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


def _field(owner: Any, key: str, default: Any = None) -> Any:
    if isinstance(owner, dict):
        return owner.get(key, default)
    return getattr(owner, key, default)


def responses_tool_choice_wire(tool_choice: Any) -> str:
    """Classify tool_choice wire shape without retaining payloads."""
    if tool_choice is None:
        return "absent"
    if isinstance(tool_choice, str):
        if tool_choice in {"auto", "none", "required"}:
            return "option"
        if (tool_choice.startswith(UNSUPPORTED_TOOL_CHOICE_LABEL_PREFIX)
                and len(tool_choice) > len(UNSUPPORTED_TOOL_CHOICE_LABEL_PREFIX)):
            return "unsupported_label"
        return "other_string"
    if isinstance(tool_choice, dict):
        if tool_choice.get("type") == "function" and isinstance(tool_choice.get("name"), str):
            return "responses_function"
        nested = tool_choice.get("function")
        if (tool_choice.get("type") == "function" and isinstance(nested, dict)
                and isinstance(nested.get("name"), str)):
            return "chat_function"
        return "other_object"
    return "unsupported"


def normalize_responses_tool_choice(tool_choice: Any) -> Any:
    """Return Responses-canonical tool_choice or raise ValueError if unsupported."""
    wire = responses_tool_choice_wire(tool_choice)
    if wire == "responses_function":
        return {"type": "function", "name": str(tool_choice["name"])}
    if wire == "chat_function":
        return {"type": "function", "name": str(tool_choice["function"]["name"])}
    if wire == "option":
        return tool_choice
    if wire == "absent":
        return None
    if wire == "unsupported_label":
        raise ValueError("unsupported_tool_choice_label")
    raise ValueError(f"unsupported_tool_choice_wire:{wire}")


def tool_choice_capture_label(tool_choice: Any) -> Optional[str]:
    """Metadata-only label; never send this string as Responses tool_choice."""
    wire = responses_tool_choice_wire(tool_choice)
    if wire in {"option", "other_string", "unsupported_label"}:
        return str(tool_choice)[:256]
    if wire == "responses_function":
        return "function:" + str(tool_choice["name"])[:128]
    if wire == "chat_function":
        return "function:" + str(tool_choice["function"]["name"])[:128]
    if isinstance(tool_choice, dict) and tool_choice:
        choice_type = next(iter(tool_choice), "unknown")
        selected = tool_choice.get(choice_type)
        selected_name = selected.get("name") if isinstance(selected, dict) else None
        return str(choice_type)[:128] + ((":" + str(selected_name)[:128]) if selected_name else "")
    return None


def responses_tool_schema_wire(tool: Any) -> str:
    """Classify one tool schema shape for wire discrimination."""
    if not isinstance(tool, dict):
        return "unsupported"
    if tool.get("type") != "function":
        return "other"
    if isinstance(tool.get("name"), str) and tool["name"].strip():
        params = tool.get("parameters")
        if isinstance(params, dict):
            return "responses_function"
        return "responses_function_invalid_params"
    nested = tool.get("function")
    if isinstance(nested, dict) and isinstance(nested.get("name"), str) and nested["name"].strip():
        params = nested.get("parameters", nested.get("inputSchema"))
        if isinstance(params, dict):
            return "chat_function"
        return "chat_function_invalid_params"
    return "other"


def normalize_responses_tools(tools: Any) -> Optional[List[Dict[str, Any]]]:
    """Return Responses-flat tool schemas; accept Chat nested or already-flat.

    Hermes ``_responses_tools`` only reads ``item["function"]`` and silently drops
    already-flat Responses tools. This helper preserves flat tools and converts
    Chat nested schemas so the wire always carries ``name`` + ``parameters``.
    """
    if tools is None:
        return None
    if not isinstance(tools, (list, tuple)):
        raise ValueError("responses_tools_not_list")
    converted: List[Dict[str, Any]] = []
    for index, tool in enumerate(tools):
        wire = responses_tool_schema_wire(tool)
        if wire == "responses_function":
            converted.append({
                "type": "function",
                "name": str(tool["name"]).strip(),
                "description": str(tool.get("description") or ""),
                "strict": bool(tool.get("strict", False)),
                "parameters": tool["parameters"],
            })
            continue
        if wire == "chat_function":
            nested = tool["function"]
            converted.append({
                "type": "function",
                "name": str(nested["name"]).strip(),
                "description": str(nested.get("description") or ""),
                "strict": bool(nested.get("strict", False)),
                "parameters": nested.get("parameters", nested.get("inputSchema")),
            })
            continue
        raise ValueError(f"unsupported_responses_tool_wire:{wire}:{index}")
    return converted or None


def native_output_item_types(output: Any) -> List[str]:
    """Bounded type names from a native Responses ``output`` list."""
    if not isinstance(output, (list, tuple)):
        return []
    names: List[str] = []
    for item in output:
        kind = item_type_name(_field(item, "type"))
        if kind:
            names.append(kind[:64])
    return names


def _coerce_arguments(value: Any) -> str:
    if isinstance(value, str):
        return value
    if value is None:
        return "{}"
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return "{}"


def extract_native_function_call_items(output: Any) -> List[Any]:
    """Select native ``function_call`` items (dict or object; Enum type ok).

    Incomplete statuses are excluded — they must remain failures until completed.
    """
    if not isinstance(output, (list, tuple)):
        return []
    selected: List[Any] = []
    for item in output:
        if item_type_name(_field(item, "type")) != "function_call":
            continue
        status = item_type_name(_field(item, "status"))
        if status in _INCOMPLETE_ITEM_STATUSES:
            continue
        selected.append(item)
    return selected


def normalize_function_call_to_executable(item: Any, *, index: int = 0) -> Dict[str, Any]:
    """Normalize one native function_call into an executable descriptor (no dispatch).

    Executable shape matches what the tool dispatcher consumes: name + arguments
    string, plus stable id/call_id for pairing. Raises ValueError when the item
    cannot become an executable call.
    """
    if item_type_name(_field(item, "type")) != "function_call":
        raise ValueError("not_a_function_call")
    status = item_type_name(_field(item, "status"))
    if status in _INCOMPLETE_ITEM_STATUSES:
        raise ValueError("incomplete_function_call")
    nested = _field(item, "function")
    name = _field(item, "name")
    arguments = _field(item, "arguments")
    if isinstance(nested, dict):
        if name is None:
            name = nested.get("name")
        if arguments is None:
            arguments = nested.get("arguments")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("function_call_missing_name")
    call_id = _field(item, "call_id") or _field(item, "id") or f"call_synthetic_{index}"
    call_id = str(call_id).strip() or f"call_synthetic_{index}"
    args_text = _coerce_arguments(arguments)
    try:
        parsed = json.loads(args_text) if args_text else {}
    except (TypeError, ValueError) as exc:
        raise ValueError("function_call_invalid_arguments_json") from exc
    if not isinstance(parsed, dict):
        raise ValueError("function_call_arguments_not_object")
    return {
        "id": call_id,
        "call_id": call_id,
        "type": "function",
        "name": name.strip(),
        "arguments": args_text,
        "function": {"name": name.strip(), "arguments": args_text},
    }


def normalize_output_to_executable_calls(output: Any) -> List[Dict[str, Any]]:
    """Normalize all completed native function_call items to executable descriptors.

    Items that cannot become executables are skipped (caller uses native type lists
    + empty result to classify ``lost_normalization``). Never dispatches tools.
    """
    calls: List[Dict[str, Any]] = []
    for index, item in enumerate(extract_native_function_call_items(output)):
        try:
            calls.append(normalize_function_call_to_executable(item, index=index))
        except ValueError:
            continue
    return calls


def function_call_item_as_namespace(item: Any, *, index: int = 0) -> SimpleNamespace:
    """Materialize a native function_call as a SimpleNamespace for Hermes normalize."""
    executable = normalize_function_call_to_executable(item, index=index)
    return SimpleNamespace(
        type="function_call",
        id=executable["id"],
        call_id=executable["call_id"],
        name=executable["name"],
        arguments=executable["arguments"],
        status="completed",
    )


def merge_terminal_function_calls_into_assembled(
    assembled: Any, terminal_response: Any,
) -> Tuple[Any, Dict[str, Any]]:
    """Recover terminal ``function_call`` items dropped by done-only stream assembly.

    Returns ``(assembled_or_merged, evidence)`` where evidence is metadata-only.
    Does not dispatch tools. Refusal / incomplete / empty terminal outputs leave
    the assembled response unchanged and record why.
    """
    evidence: Dict[str, Any] = {
        "terminal_output_item_types": [],
        "assembled_output_item_types": [],
        "recovered_function_calls": 0,
        "recovery": "none",
    }
    if assembled is None:
        evidence["recovery"] = "assembled_absent"
        return assembled, evidence
    assembled_output = _field(assembled, "output")
    evidence["assembled_output_item_types"] = native_output_item_types(assembled_output)
    if normalize_output_to_executable_calls(assembled_output):
        evidence["recovery"] = "assembled_already_has_calls"
        return assembled, evidence
    if terminal_response is None:
        evidence["recovery"] = "terminal_absent"
        return assembled, evidence
    terminal_output = _field(terminal_response, "output")
    evidence["terminal_output_item_types"] = native_output_item_types(terminal_output)
    terminal_types = evidence["terminal_output_item_types"]
    if "refusal" in terminal_types:
        evidence["recovery"] = "terminal_refusal"
        return assembled, evidence
    status = item_type_name(_field(terminal_response, "status"))
    if status in _INCOMPLETE_ITEM_STATUSES:
        evidence["recovery"] = "terminal_incomplete"
        return assembled, evidence
    recovered_items = extract_native_function_call_items(terminal_output)
    if not recovered_items:
        evidence["recovery"] = "terminal_empty_or_non_call"
        return assembled, evidence
    namespaces = []
    for index, item in enumerate(recovered_items):
        try:
            namespaces.append(function_call_item_as_namespace(item, index=index))
        except ValueError:
            continue
    if not namespaces:
        evidence["recovery"] = "recovery_normalization_failed"
        return assembled, evidence
    # Prove the real normalization path: recovered native items must become
    # executable descriptors before they are attached to the assembled response.
    executables = normalize_output_to_executable_calls(namespaces)
    if not executables:
        evidence["recovery"] = "recovery_normalization_failed"
        return assembled, evidence
    base = list(assembled_output) if isinstance(assembled_output, (list, tuple)) else []
    merged_output = base + namespaces
    if isinstance(assembled, dict):
        merged = dict(assembled)
        merged["output"] = merged_output
    else:
        merged = SimpleNamespace(**{
            key: _field(assembled, key)
            for key in ("output_text", "usage", "status", "id", "model",
                        "incomplete_details", "error", "terminal_event_type")
            if _field(assembled, key, "__missing__") != "__missing__"
        })
        merged.output = merged_output
    evidence["recovered_function_calls"] = len(executables)
    evidence["recovery"] = "terminal_function_calls_merged"
    evidence["executable_names"] = [call["name"] for call in executables]
    return merged, evidence


def classify_empty_tool_boundary(
    *,
    tool_choice_wire: Optional[str],
    tools_wire: Sequence[str],
    native_item_types: Sequence[str],
    executable_calls: Sequence[Any],
) -> str:
    """Distinguish lost-normalization vs genuine provider empty when tools are offered."""
    if executable_calls:
        return "tool_calls"
    if "refusal" in native_item_types:
        return "refusal"
    if any(kind in _INCOMPLETE_ITEM_STATUSES for kind in native_item_types):
        return "incomplete"
    named_or_auto = tool_choice_wire in {"responses_function", "option"}
    tools_ok = bool(tools_wire) and all(
        kind in {"responses_function", "chat_function"} for kind in tools_wire
    )
    if named_or_auto and tools_ok and not native_item_types:
        return PROVIDER_EMPTY_WITH_WIRE_OK
    if "function_call" in native_item_types and not executable_calls:
        return "lost_normalization"
    return "empty_tool_calls"


def redact_endpoint_identity(base_url: Any) -> Optional[str]:
    """Host + path only; never retain query, fragment, credentials, or guest payloads."""
    if not isinstance(base_url, str) or not base_url.strip():
        return None
    try:
        parsed = urlparse(base_url.strip())
    except ValueError:
        return "unparseable"
    host = (parsed.hostname or "").lower()[:253]
    if not host:
        return "missing_host"
    path = (parsed.path or "").rstrip("/")[:128] or "/"
    scheme = (parsed.scheme or "https").lower()[:16]
    return f"{scheme}://{host}{path}"


def _bounded_type_list(values: Any, *, limit: int = 32) -> List[str]:
    if not isinstance(values, (list, tuple)):
        return []
    out: List[str] = []
    for item in values[:limit]:
        name = item_type_name(item) if not isinstance(item, str) else str(item).strip()
        if name:
            out.append(name[:64])
    return out


def discriminate_wire_to_native(
    *,
    tool_choice_wire: Optional[str],
    tools_wire: Sequence[str],
    streaming: bool,
    native_stream_event_types: Sequence[str],
    terminal_status: Optional[str],
    terminal_output_item_types: Sequence[str],
    assembled_output_item_types: Sequence[str],
    normalized_call_count: int,
    recovery: Optional[str] = None,
) -> str:
    """Return a boundary verdict: where the call is relative to wire → native → normalize.

    Capture labels alone are insufficient — this requires event/item type lists and
    a normalized call count from the real adapter path (still no tool dispatch).
    """
    if normalized_call_count > 0:
        if recovery == "terminal_function_calls_merged":
            return "adapter_drop_recovered"
        return "native_calls_present"
    terminal = item_type_name(terminal_status)
    stream_types = _bounded_type_list(native_stream_event_types)
    terminal_types = _bounded_type_list(terminal_output_item_types)
    assembled_types = _bounded_type_list(assembled_output_item_types)
    if streaming and not stream_types and terminal is None:
        return "observation_incomplete"
    if "function_call" in terminal_types or "function_call" in assembled_types:
        return "lost_normalization"
    if any(kind in {"response.failed", "response.incomplete"} for kind in stream_types):
        return "terminal_not_completed"
    if terminal in _INCOMPLETE_ITEM_STATUSES:
        return "terminal_incomplete"
    category = classify_empty_tool_boundary(
        tool_choice_wire=tool_choice_wire,
        tools_wire=tools_wire,
        native_item_types=terminal_types or assembled_types,
        executable_calls=[],
    )
    if category == PROVIDER_EMPTY_WITH_WIRE_OK:
        # Wire admitted + completed/empty native → provider empty (or still-missing
        # observation fields if stream types never recorded — callers must attach them).
        if streaming and "response.completed" not in stream_types and terminal is None:
            return "observation_incomplete"
        return PROVIDER_EMPTY_WITH_WIRE_OK
    return category


def build_wire_to_native_boundary_record(
    *,
    api_mode: Optional[str],
    model: Optional[str],
    endpoint: Any = None,
    streaming: bool,
    tool_choice: Any = None,
    tools: Any = None,
    tool_choice_wire: Optional[str] = None,
    tools_wire: Optional[Sequence[str]] = None,
    native_stream_event_types: Sequence[str] = (),
    terminal_status: Optional[str] = None,
    terminal_output_item_types: Sequence[str] = (),
    assembled_output_item_types: Sequence[str] = (),
    normalized_call_count: int = 0,
    recovery: Optional[str] = None,
    executable_names: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """Build a redacted wire→native boundary record (no credentials / guest payloads)."""
    if tool_choice_wire is None and tool_choice is not None:
        tool_choice_wire = responses_tool_choice_wire(tool_choice)
    if tools_wire is None and isinstance(tools, (list, tuple)):
        tools_wire = [responses_tool_schema_wire(tool) for tool in tools[:32]]
    tools_wire_list = list(tools_wire or [])
    choice_label = tool_choice_capture_label(tool_choice) if tool_choice is not None else None
    if choice_label is None and tool_choice_wire == "responses_function":
        choice_label = "function:(wire-only)"
    stream_types = _bounded_type_list(native_stream_event_types)
    terminal_types = _bounded_type_list(terminal_output_item_types)
    assembled_types = _bounded_type_list(assembled_output_item_types)
    count = max(0, int(normalized_call_count))
    verdict = discriminate_wire_to_native(
        tool_choice_wire=tool_choice_wire,
        tools_wire=tools_wire_list,
        streaming=bool(streaming),
        native_stream_event_types=stream_types,
        terminal_status=terminal_status,
        terminal_output_item_types=terminal_types,
        assembled_output_item_types=assembled_types,
        normalized_call_count=count,
        recovery=recovery,
    )
    record: Dict[str, Any] = {
        "schema_version": BOUNDARY_RECORD_SCHEMA_VERSION,
        "transport": {
            "api_mode": str(api_mode)[:64] if api_mode is not None else None,
            "model": str(model)[:128] if model is not None else None,
            "endpoint": redact_endpoint_identity(endpoint),
            "streaming": bool(streaming),
        },
        "request_wire": {
            "tool_choice_label": choice_label[:256] if choice_label else None,
            "tool_choice_wire": tool_choice_wire,
            "tools_wire": tools_wire_list[:32],
            "tools_count": len(tools_wire_list),
        },
        "native_response": {
            "stream_event_types": stream_types,
            "terminal_status": item_type_name(terminal_status),
            "terminal_output_item_types": terminal_types,
            "assembled_output_item_types": assembled_types,
        },
        "normalization": {
            "normalized_call_count": count,
            "executable_names": [str(name)[:128] for name in (executable_names or [])[:32]],
            "recovery": recovery or "none",
        },
        "boundary_verdict": verdict,
    }
    if verdict == PROVIDER_EMPTY_WITH_WIRE_OK:
        record["compatibility_blocker"] = {
            "id": COMPATIBILITY_BLOCKER_ID,
            "missing_evidence_if_observation_unproven": list(
                COMPATIBILITY_BLOCKER_MISSING_EVIDENCE
            ),
            "guidance": (
                "Native empty despite valid named/auto wire — investigate endpoint/"
                "proxy tool_choice support/enforcement; do not keep repairing extraction."
            ),
        }
    return record


def replay_native_through_adapter(
    *,
    assembled: Any,
    terminal_response: Any,
    tool_choice_wire: str,
    tools_wire: Sequence[str],
    api_mode: str = "codex_responses",
    model: str = "gpt-5.6-sol",
    endpoint: Optional[str] = None,
    streaming: bool = True,
    native_stream_event_types: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """Offline replay: feed native terminal/assembled through the deployed adapter.

    Returns ``{merged, evidence, boundary_record, boundary_verdict}`` without
    dispatching tools. Discriminates:
    - native function_call present, normalized absent → lost_normalization / repair
    - native genuinely empty with wire OK → provider_empty_with_wire_ok (blocker)
    """
    merged, evidence = merge_terminal_function_calls_into_assembled(
        assembled, terminal_response,
    )
    executables = normalize_output_to_executable_calls(_field(merged, "output"))
    if native_stream_event_types is None:
        # Synthetic default only when the caller omitted stream evidence entirely.
        stream_types = ["response.completed"] if streaming else []
    else:
        stream_types = list(native_stream_event_types)
    terminal_status = item_type_name(_field(terminal_response, "status"))
    record = build_wire_to_native_boundary_record(
        api_mode=api_mode,
        model=model,
        endpoint=endpoint,
        streaming=streaming,
        tool_choice_wire=tool_choice_wire,
        tools_wire=tools_wire,
        native_stream_event_types=stream_types,
        terminal_status=terminal_status,
        terminal_output_item_types=evidence.get("terminal_output_item_types") or [],
        assembled_output_item_types=native_output_item_types(_field(merged, "output")),
        normalized_call_count=len(executables),
        recovery=evidence.get("recovery"),
        executable_names=[call["name"] for call in executables],
    )
    return {
        "merged": merged,
        "evidence": evidence,
        "executables": executables,
        "boundary_record": record,
        "boundary_verdict": record["boundary_verdict"],
    }


def load_boundary_fixture(path: Any) -> Dict[str, Any]:
    """Load one redacted boundary fixture JSON (offline only)."""
    raw = Path(path).read_text(encoding="utf-8")
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get("schema") != "luna-lr32-wire-to-native":
        raise ValueError("boundary_fixture_schema_invalid")
    return data


def replay_boundary_fixture(path: Any) -> Dict[str, Any]:
    """Replay a fixture through the adapter and return discrimination result."""
    fixture = load_boundary_fixture(path)
    assembled = fixture.get("assembled") or {"output": [], "status": "completed"}
    request = fixture.get("request_wire") or {}
    transport = fixture.get("transport") or {}
    stream_types = list(fixture.get("native_stream_event_types") or [])
    expected = fixture.get("expected_boundary_verdict")

    if "terminal_response" in fixture and fixture.get("terminal_response") is None:
        # Explicit null terminal — do not invent a completed empty response.
        record = build_wire_to_native_boundary_record(
            api_mode=str(transport.get("api_mode") or "codex_responses"),
            model=str(transport.get("model") or "gpt-5.6-sol"),
            endpoint=transport.get("endpoint"),
            streaming=bool(transport.get("streaming", True)),
            tool_choice_wire=str(request.get("tool_choice_wire") or "absent"),
            tools_wire=list(request.get("tools_wire") or []),
            native_stream_event_types=stream_types,
            terminal_status=None,
            terminal_output_item_types=[],
            assembled_output_item_types=native_output_item_types(
                assembled.get("output") if isinstance(assembled, dict)
                else _field(assembled, "output")
            ),
            normalized_call_count=0,
            recovery="terminal_absent",
        )
        return {
            "merged": assembled,
            "evidence": {"recovery": "terminal_absent"},
            "executables": [],
            "boundary_record": record,
            "boundary_verdict": record["boundary_verdict"],
            "fixture_id": fixture.get("id"),
            "expected_boundary_verdict": expected,
            "matches_expected": expected is None or expected == record["boundary_verdict"],
        }

    terminal = fixture.get("terminal_response")
    if terminal is None:
        terminal = {"status": "completed", "output": []}
    result = replay_native_through_adapter(
        assembled=assembled,
        terminal_response=terminal,
        tool_choice_wire=str(request.get("tool_choice_wire") or "absent"),
        tools_wire=list(request.get("tools_wire") or []),
        api_mode=str(transport.get("api_mode") or "codex_responses"),
        model=str(transport.get("model") or "gpt-5.6-sol"),
        endpoint=transport.get("endpoint"),
        streaming=bool(transport.get("streaming", True)),
        native_stream_event_types=stream_types,
    )
    # Prefer pre-merge assembled types when merge left assembled unchanged but
    # native function_call items were un-normalizable (lost_normalization).
    if not result["executables"]:
        terminal_types = native_output_item_types(_field(terminal, "output"))
        assembled_types = native_output_item_types(_field(assembled, "output"))
        if "function_call" in terminal_types or "function_call" in assembled_types:
            result["boundary_record"] = build_wire_to_native_boundary_record(
                api_mode=str(transport.get("api_mode") or "codex_responses"),
                model=str(transport.get("model") or "gpt-5.6-sol"),
                endpoint=transport.get("endpoint"),
                streaming=bool(transport.get("streaming", True)),
                tool_choice_wire=str(request.get("tool_choice_wire") or "absent"),
                tools_wire=list(request.get("tools_wire") or []),
                native_stream_event_types=stream_types,
                terminal_status=item_type_name(_field(terminal, "status")),
                terminal_output_item_types=terminal_types,
                assembled_output_item_types=assembled_types,
                normalized_call_count=0,
                recovery=result["evidence"].get("recovery"),
            )
            result["boundary_verdict"] = result["boundary_record"]["boundary_verdict"]
    result["fixture_id"] = fixture.get("id")
    result["expected_boundary_verdict"] = expected
    result["matches_expected"] = (expected is None
                                  or expected == result["boundary_verdict"])
    return result


def direct_compare_enabled() -> bool:
    """Bounded no-tool-dispatch direct-client compare (off by default).

    Cap: only when existing evidence cannot discriminate. Stops at native response —
    no follow-up auto turn, model swap, credential/routing change, or retry-until-green.
    """
    return os.getenv(DIRECT_COMPARE_FLAG, "").strip() in {"1", "true", "yes"}


def design_direct_compare_probe(
    *,
    model: str,
    api_mode: str,
    endpoint: Any,
    tool_choice: Any,
    tools: Sequence[Any],
) -> Dict[str, Any]:
    """Describe (or refuse) a bounded adapter-vs-direct probe; never sends by itself."""
    record = build_wire_to_native_boundary_record(
        api_mode=api_mode,
        model=model,
        endpoint=endpoint,
        streaming=True,
        tool_choice=tool_choice,
        tools=list(tools),
        native_stream_event_types=[],
        terminal_status=None,
        terminal_output_item_types=[],
        assembled_output_item_types=[],
        normalized_call_count=0,
    )
    return {
        "enabled": direct_compare_enabled(),
        "flag": DIRECT_COMPARE_FLAG,
        "stop_at": "native_response",
        "disallowed": [
            "follow_up_auto_turn",
            "model_swap",
            "credential_or_routing_change",
            "retry_until_green",
            "tool_dispatch",
        ],
        "preflight_boundary_record": record,
        "note": (
            "Compare current adapter vs minimal direct client to the same configured "
            "endpoint/model; retain only redacted boundary records from each leg."
        ),
    }
