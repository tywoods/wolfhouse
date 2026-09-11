"""Transactional, idempotent image patch for the three LR3.2 live-loop owners."""
from __future__ import annotations
import os
from pathlib import Path

ROOT = Path(os.getenv("HERMES_ROOT", "/opt/hermes"))
HOOK_TAG = "# Wolfhouse LR3.2 live-loop trace hook."

def _fail_open(body: str, indent: str) -> str:
    lines = [
        f"{indent}try:",
        f"{indent}    from wolfhouse.luna_live_loop_trace import observe_conversation_branch as _observe_live_branch",
        f"{indent}except BaseException:",
        f"{indent}    _observe_live_branch = None",
    ]
    if body:
        lines.extend(body.splitlines())
    return "\n".join(lines) + "\n"

PATCHES = (
    ("agent/codex_runtime.py",
     '        if event_type == "response.output_item.done":\n            done_item = _event_field(event, "item")\n            if done_item is not None:\n',
     '        if event_type == "response.output_item.done":\n            done_item = _event_field(event, "item")\n            # Wolfhouse LR3.2 live-loop trace hook.\n            try:\n                from wolfhouse.luna_live_loop_trace import observe_output_item_done\n                observe_output_item_done(done_item, _event_field(event, "response_id"))\n            except BaseException:\n                pass\n            if done_item is not None:\n'),
    ("agent/codex_responses_adapter.py",
     '    else:\n        finish_reason = "stop"\n    return assistant_message, finish_reason\n',
     '    else:\n        finish_reason = "stop"\n    # Wolfhouse LR3.2 live-loop trace hook.\n    try:\n        from wolfhouse.luna_live_loop_trace import observe_normalized_return\n        observe_normalized_return(response, assistant_message, finish_reason)\n    except BaseException:\n        pass\n    return assistant_message, finish_reason\n'),
    ("agent/conversation_loop.py",
     '            # Check for tool calls\n            if assistant_message.tool_calls:\n',
     '            # Check for tool calls\n            # Wolfhouse LR3.2 live-loop trace hook.\n' + _fail_open(
       '            if assistant_message.tool_calls:\n'
       '                if _observe_live_branch is not None:\n'
       '                    try:\n'
       '                        _observe_live_branch(assistant_message.tool_calls, messages, branch="tool_selection_true", reason="tool_calls_present", predicate=True)\n'
       '                    except BaseException:\n'
       '                        pass', '            ')),
    ("agent/conversation_loop.py",
     '            else:\n                # No tool calls - this is the final response\n',
     '            else:\n                if _observe_live_branch is not None:\n                    try:\n                        _observe_live_branch(None, messages, branch="tool_selection_false", reason="tool_calls_absent", predicate=False)\n                    except BaseException:\n                        pass\n                # No tool calls - this is the final response\n'),
    ("agent/conversation_loop.py",
     '                        agent._persist_session(messages, conversation_history)\n                        return {\n                            "final_response": None,\n                            "messages": messages,\n                            "api_calls": api_call_count,\n                            "completed": False,\n                            "partial": True,\n                            "error": f"Model generated invalid tool call: {invalid_preview}"\n',
     '                        agent._persist_session(messages, conversation_history)\n                        if _observe_live_branch is not None:\n                            try:\n                                _observe_live_branch(next(tc for tc in assistant_message.tool_calls if tc.function.name == invalid_name), messages, branch="invalid_name_early_return", reason="retry_limit", predicate=True)\n                            except BaseException:\n                                pass\n                        return {\n                            "final_response": None,\n                            "messages": messages,\n                            "api_calls": api_call_count,\n                            "completed": False,\n                            "partial": True,\n                            "error": f"Model generated invalid tool call: {invalid_preview}"\n'),
    ("agent/conversation_loop.py",
     '                            "content": content,\n                        })\n                    continue\n                # Reset retry counter on successful tool call validation\n',
     '                            "content": content,\n                        })\n                    if _observe_live_branch is not None:\n                        try:\n                            _observe_live_branch(next(tc for tc in assistant_message.tool_calls if tc.function.name == invalid_name), messages, branch="invalid_name_retry", reason="unknown_tool", predicate=True)\n                        except BaseException:\n                            pass\n                    continue\n                # Reset retry counter on successful tool call validation\n'),
    ("agent/conversation_loop.py",
     '                        agent._persist_session(messages, conversation_history)\n                        return {\n                            "final_response": None,\n                            "messages": messages,\n                            "api_calls": api_call_count,\n                            "completed": False,\n                            "partial": True,\n                            "error": "Response truncated due to output length limit",\n',
     '                        agent._persist_session(messages, conversation_history)\n                        if _observe_live_branch is not None:\n                            try:\n                                _observe_live_branch(next(tc for tc in assistant_message.tool_calls if tc.function.name in {n for n, _ in invalid_json_args} and not (tc.function.arguments or "").rstrip().endswith(("}", "]"))), messages, branch="invalid_json_early_return", reason="truncated_arguments", predicate=True)\n                            except BaseException:\n                                pass\n                        return {\n                            "final_response": None,\n                            "messages": messages,\n                            "api_calls": api_call_count,\n                            "completed": False,\n                            "partial": True,\n                            "error": "Response truncated due to output length limit",\n'),
    ("agent/conversation_loop.py",
     "                        # Don't add anything to messages, just retry the API call\n                        continue\n                    else:\n",
     "                        # Don't add anything to messages, just retry the API call\n                        if _observe_live_branch is not None:\n                            try:\n                                _observe_live_branch(next(tc for tc in assistant_message.tool_calls if tc.function.name == tool_name), messages, branch=\"invalid_json_retry\", reason=\"malformed_arguments\", predicate=True)\n                            except BaseException:\n                                pass\n                        continue\n                    else:\n"),
    ("agent/conversation_loop.py",
     '                                "content": tool_result,\n                            })\n                        continue\n                \n                # Reset retry counter on successful JSON validation\n',
     '                                "content": tool_result,\n                            })\n                        if _observe_live_branch is not None:\n                            try:\n                                _observe_live_branch(next(tc for tc in assistant_message.tool_calls if tc.function.name == tool_name), messages, branch="invalid_json_recovery", reason="recovery_results_appended", predicate=True)\n                            except BaseException:\n                                pass\n                        continue\n                \n                # Reset retry counter on successful JSON validation\n'),
    ("agent/conversation_loop.py",
     '                # Continue loop for next response\n                continue\n            \n            else:\n',
     '                # Continue loop for next response\n                if _observe_live_branch is not None:\n                    try:\n                        _observe_live_branch(assistant_message.tool_calls, messages, branch="post_dispatch_continue", reason="tool_results_appended", predicate=True)\n                    except BaseException:\n                        pass\n                continue\n            \n            else:\n'),
)

def patch_root(root: Path = ROOT) -> None:
    originals: dict[Path, str] = {}
    candidates: dict[Path, str] = {}
    for relative, anchor, replacement in PATCHES:
        path = root / relative
        disk_source = path.read_text(encoding="utf-8")
        originals.setdefault(path, disk_source)
        source = candidates.get(path, disk_source)
        if replacement in source:
            if source.count(replacement) != 1:
                raise RuntimeError(f"patched hook multiplicity drift: {relative}")
            candidates[path] = source
            continue
        if source.count(anchor) != 1:
            raise RuntimeError(f"anchor drift: {relative}")
        candidates[path] = source.replace(anchor, replacement, 1)
    if len(candidates) != 3 or sum(text.count(HOOK_TAG) for text in candidates.values()) != 3:
        raise RuntimeError("owner or hook count drift")
    for path, text in candidates.items():
        compile(text, str(path), "exec")
    written: list[Path] = []
    try:
        for path, text in candidates.items():
            if text != originals[path]:
                written.append(path)
                path.write_text(text, encoding="utf-8")
    except BaseException:
        for path in written:
            path.write_text(originals[path], encoding="utf-8")
        raise

def main() -> None:
    patch_root()

if __name__ == "__main__":
    main()
