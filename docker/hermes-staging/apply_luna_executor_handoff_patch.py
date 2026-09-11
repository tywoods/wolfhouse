#!/usr/bin/env python3
"""Patch the pinned Hermes Codex normalizer at the executor handoff.

The June stream assembler retains ``response.output_item.done.item`` verbatim.
Mapping-shaped function_call items therefore need mapping access at transport
normalization; otherwise the actual conversation loop observes zero calls.
"""

from pathlib import Path
import hashlib
import importlib.util
import sys

PIN_SHA256 = "bc32d3fbc0cef1a7e7b93d82eb0ec2cac1fcb4342eb22a17d0fed36f2f5d3b7b"
ITEM_OLD = '''    for item in output:
        item_type = getattr(item, "type", None)
        item_status = getattr(item, "status", None)
'''
ITEM_NEW = '''    for item in output:
        # output_item.done payloads are retained verbatim by the stream
        # assembler. Accept SDK objects and mapping-shaped events here.
        item_type = item.get("type") if isinstance(item, dict) else getattr(item, "type", None)
        item_status = item.get("status") if isinstance(item, dict) else getattr(item, "status", None)
'''
FIELDS_OLD = '''            fn_name = getattr(item, "name", "") or ""
            arguments = getattr(item, "arguments", "{}")
            if not isinstance(arguments, str):
                arguments = json.dumps(arguments, ensure_ascii=False)
            raw_call_id = getattr(item, "call_id", None)
            raw_item_id = getattr(item, "id", None)
'''
FIELDS_NEW = '''            fn_name = (item.get("name", "") if isinstance(item, dict) else getattr(item, "name", "")) or ""
            arguments = item.get("arguments", "{}") if isinstance(item, dict) else getattr(item, "arguments", "{}")
            if not isinstance(arguments, str):
                arguments = json.dumps(arguments, ensure_ascii=False)
            raw_call_id = item.get("call_id") if isinstance(item, dict) else getattr(item, "call_id", None)
            raw_item_id = item.get("id") if isinstance(item, dict) else getattr(item, "id", None)
'''


def _once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label} anchor count {count}, expected 1")
    return text.replace(old, new, 1)


def patch_text(text):
    item_marked = ITEM_NEW in text
    fields_marked = FIELDS_NEW in text
    if item_marked != fields_marked:
        raise RuntimeError("executor handoff mixed patch state")
    if item_marked:
        original = _once(text, ITEM_NEW, ITEM_OLD, "item inverse")
        original = _once(original, FIELDS_NEW, FIELDS_OLD, "fields inverse")
    else:
        original = text
    if hashlib.sha256(original.encode()).hexdigest() != PIN_SHA256:
        raise RuntimeError("executor handoff adapter source fingerprint drift")
    candidate = _once(original, ITEM_OLD, ITEM_NEW, "item")
    return _once(candidate, FIELDS_OLD, FIELDS_NEW, "fields")


def target_path():
    spec = importlib.util.find_spec("agent.codex_responses_adapter")
    if spec is None or not spec.origin:
        raise RuntimeError("agent.codex_responses_adapter not found")
    return Path(spec.origin)


def main():
    path = target_path()
    original = path.read_text()
    candidate = patch_text(original)
    compile(candidate, str(path), "exec")
    if candidate != original:
        path.write_text(candidate)
    print(f"executor handoff patch: {'changed' if candidate != original else 'already-applied'} {path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"apply_luna_executor_handoff_patch failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
