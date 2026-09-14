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
        "            except Exception as tool_error:\n                _append_receipt_producer = \"caught_exception\"\n                function_result = json.dumps({\"error\": f\"Context engine tool '{function_name}' failed: {tool_error}\"})\n",
    ),
    (
        "            except Exception as tool_error:\n                function_result = json.dumps({\"error\": f\"Memory tool '{function_name}' failed: {tool_error}\"})\n",
        "            except Exception as tool_error:\n                _append_receipt_producer = \"caught_exception\"\n                function_result = json.dumps({\"error\": f\"Memory tool '{function_name}' failed: {tool_error}\"})\n",
    ),
    (
        "            except Exception as tool_error:\n                function_result = f\"Error executing tool '{function_name}': {tool_error}\"\n",
        "            except Exception as tool_error:\n                _append_receipt_producer = \"caught_exception\"\n                function_result = f\"Error executing tool '{function_name}': {tool_error}\"\n",
    ),
    (
        "        _tool_content = agent._tool_result_content_for_active_model(function_name, function_result)\n        messages.append(make_tool_result_message(function_name, _tool_content, tool_call.id))\n",
        "        _tool_content = agent._tool_result_content_for_active_model(function_name, function_result)\n"
        "        _append_body_message = make_tool_result_message(function_name, _tool_content, tool_call.id)\n"
        "        messages.append(_append_body_message)\n"
        "        try:\n"
        "            from wolfhouse.luna_append_body_receipt import observe_append_body as _observe_append_body\n"
        "            _observe_append_body(_append_body_message, producer=_append_receipt_producer, "
        "response_id=getattr(agent, \"_current_api_request_id\", None))\n"
        "        except BaseException:\n"
        "            pass\n",
    ),
)


def patch_text(source: str) -> str:
    candidate = source
    for old, new in PATCHES:
        expected = 2 if "Error executing tool" in old else 1
        if new in candidate:
            if candidate.count(new) != expected:
                raise RuntimeError("patched hook multiplicity drift")
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
