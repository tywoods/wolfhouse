"""Responses API tool_choice wire discrimination (offline / capture helpers).

Cap LR3.1-NAMED-READ-DIAG-RESULT-001 recorded capture metadata
``function:TOOL`` for a named catalog read. That label is not a valid Responses
``tool_choice`` string. Canonical Responses wire form is the flat object
``{"type":"function","name":TOOL}``. Chat Completions nested
``{"type":"function","function":{"name":TOOL}}`` is accepted on input and
normalized to the flat form before SDK dispatch.
"""

from __future__ import annotations

from typing import Any, Optional

UNSUPPORTED_TOOL_CHOICE_LABEL_PREFIX = "function:"


def item_type_name(value: Any) -> Optional[str]:
    """Normalize Responses/Chat item discriminators (str, Enum.value, etc.)."""
    if value is None:
        return None
    raw = getattr(value, "value", value)
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


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
