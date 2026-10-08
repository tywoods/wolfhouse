#!/usr/bin/env python3
"""Transactional image patch for LR3.2 ordinary append-body receipts."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(os.getenv("HERMES_ROOT", "/opt/hermes"))
TAG = "# Wolfhouse LR3.2 append-body receipt hook."

PATCHES = (
    (
        "        _execution_blocked = _block_msg is not None or _guardrail_block_decision is not None\n",
        "        _execution_blocked = _block_msg is not None or _guardrail_block_decision is not None\n"
        "        # Wolfhouse LR3.2 append-body receipt hook.\n"
        "        _append_receipt_producer = (\"local_validation_rejection\" if _execution_blocked else \"executor_return\")\n",
    ),
    (
        "            except Exception as tool_error:\n                function_result = json.dumps({\"error\": f\"Context engine tool '{function_name}' failed: {tool_error}\"})\n",
        "            except Exception as tool_error:\n                _append_receipt_producer = \"caught_exception\"\n                _append_receipt_error_type = type(tool_error).__name__\n                function_result = json.dumps({\"error\": f\"Context engine tool '{function_name}' failed: {tool_error}\"})\n",
    ),
    (
        "            except Exception as tool_error:\n                function_result = json.dumps({\"error\": f\"Memory tool '{function_name}' failed: {tool_error}\"})\n",
        "            except Exception as tool_error:\n                _append_receipt_producer = \"caught_exception\"\n                _append_receipt_error_type = type(tool_error).__name__\n                function_result = json.dumps({\"error\": f\"Memory tool '{function_name}' failed: {tool_error}\"})\n",
    ),
    (
        "            except Exception as tool_error:\n                function_result = f\"Error executing tool '{function_name}': {tool_error}\"\n",
        "            except Exception as tool_error:\n                _append_receipt_producer = \"caught_exception\"\n                _append_receipt_error_type = type(tool_error).__name__\n                function_result = f\"Error executing tool '{function_name}': {tool_error}\"\n",
    ),
    (
        "        _tool_content = agent._tool_result_content_for_active_model(function_name, function_result)\n        messages.append(make_tool_result_message(function_name, _tool_content, tool_call.id))\n",
        "        _tool_content = agent._tool_result_content_for_active_model(function_name, function_result)\n"
        "        _append_receipt_snapshot = None\n"
        "        try:\n"
        "            from wolfhouse.luna_append_body_receipt import (\n"
        "                is_enabled as _append_receipt_enabled,\n"
        "                observe_append_body as _observe_append_body,\n"
        "                snapshot_append_body as _snapshot_append_body,\n"
        "            )\n"
        "            if _append_receipt_enabled():\n"
        "                _append_receipt_snapshot = _snapshot_append_body(_tool_content)\n"
        "        except Exception:\n"
        "            pass\n"
        "        messages.append(make_tool_result_message(function_name, _tool_content, tool_call.id))\n"
        "        if _append_receipt_snapshot is not None:\n"
        "            try:\n"
        "                _observe_append_body(\n"
        "                    _append_receipt_snapshot, call_id=tool_call.id,\n"
        "                    producer=_append_receipt_producer,\n"
        "                    api_request_id=getattr(agent, \"_current_api_request_id\", None),\n"
        "                    response_id=None,\n"
        "                )\n"
        "            except Exception:\n"
        "                pass\n"
        "        try:\n"
        "            from wolfhouse.crowsnest_guest_door import record_tool_attempt as _record_crowsnest_tool_attempt\n"
        "            _record_crowsnest_tool_attempt(\n"
        "                name=function_name, arguments=getattr(tool_call.function, 'arguments', None),\n"
        "                result=_tool_content, call_id=tool_call.id,\n"
        "                api_request_id=getattr(agent, '_current_api_request_id', None),\n"
        "                producer=_append_receipt_producer,\n"
        "                error_type=locals().get('_append_receipt_error_type'),\n"
        "            )\n"
        "        except Exception:\n"
        "            pass\n"
        "        try:\n"
        "            from wolfhouse.luna_call1_failure_envelope import append_result as _lr32_call1_append\n"
        "            _lr32_call1_append(\n"
        "                call_id=tool_call.id,\n"
        "                api_request_id=getattr(agent, \"_current_api_request_id\", None),\n"
        "                response_id=None, value=_tool_content, dispatcher_disposition=None,\n"
        "                producer=_append_receipt_producer,\n"
        "            )\n"
        "        except Exception:\n"
        "            pass\n",
    ),
)


def _legacy_variant(patched: str) -> str:
    """Model the already-installed predecessor without replacing its owner bytes."""
    legacy = patched.replace(
        "                _append_receipt_error_type = type(tool_error).__name__\n", ""
    )
    start = legacy.find(
        "        try:\n"
        "            from wolfhouse.crowsnest_guest_door import record_tool_attempt as _record_crowsnest_tool_attempt\n"
    )
    if start >= 0:
        end_marker = (
            "        try:\n"
            "            from wolfhouse.luna_call1_failure_envelope import append_result as _lr32_call1_append\n"
        )
        end = legacy.find(end_marker, start)
        if end < 0:
            raise RuntimeError("legacy append-body upgrade boundary drift")
        legacy = legacy[:start] + legacy[end:]
    return legacy


def patch_text(source: str) -> str:
    candidate = source
    for old, new in PATCHES:
        expected = 2 if "Error executing tool" in old else 1
        legacy = _legacy_variant(new)
        if candidate.count(new) == expected:
            continue
        if legacy != new and candidate.count(legacy) == expected:
            # Upgrade only the existing receipt-owned fragments. This preserves
            # every unrelated byte in the installed executor.
            candidate = candidate.replace(legacy, new)
            continue
        if candidate.count(old) != expected:
            raise RuntimeError("append-body anchor drift")
        candidate = candidate.replace(old, new)
    if candidate.count(TAG) != 1:
        raise RuntimeError("append-body owner drift")
    compile(candidate, "agent/tool_executor.py", "exec")
    return candidate


def patch_root(root: Path = ROOT) -> None:
    path = root / "agent/tool_executor.py"
    original = path.read_text(encoding="utf-8")
    candidate = patch_text(original)
    if candidate != original:
        path.write_text(candidate, encoding="utf-8")


if __name__ == "__main__":
    patch_root()
