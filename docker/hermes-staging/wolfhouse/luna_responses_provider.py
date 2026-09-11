"""Responses API request/response adapter helpers (offline + isolation).

Cap LR3.1-NAMED-READ-DIAG-RESULT-001 / LR3.2 tip after #953:

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
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any, Dict, List, Optional, Sequence, Tuple

UNSUPPORTED_TOOL_CHOICE_LABEL_PREFIX = "function:"
_INCOMPLETE_ITEM_STATUSES = frozenset({"queued", "in_progress", "incomplete"})
PROVIDER_EMPTY_WITH_WIRE_OK = "provider_empty_with_wire_ok"


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
    """Normalize all completed native function_call items to executable descriptors."""
    calls: List[Dict[str, Any]] = []
    for index, item in enumerate(extract_native_function_call_items(output)):
        calls.append(normalize_function_call_to_executable(item, index=index))
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
    namespaces = [
        function_call_item_as_namespace(item, index=index)
        for index, item in enumerate(recovered_items)
    ]
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
