#!/usr/bin/env python3
"""Backport trusted HERMES_HOME/SOUL loading while preserving project-context blocking."""
from __future__ import annotations
import argparse
from pathlib import Path

OLD_DEF = '''def _scan_context_content(content: str, filename: str) -> str:
'''
NEW_DEF = '''def _scan_context_content(content: str, filename: str, *, user_authored: bool = False) -> str:
'''
OLD_FINDINGS = '''    if findings:
        logger.warning("Context file %s blocked: %s", filename, ", ".join(findings))
        return f"[BLOCKED: {filename} contained potential prompt injection ({', '.join(findings)}). Content not loaded.]"

    return content
'''
NEW_FINDINGS = '''    if findings and user_authored:
        logger.warning(
            "Context file %s matched injection pattern(s) %s; loaded anyway because it is the "
            "user's own file in HERMES_HOME — review it if you did not write that text",
            filename, ", ".join(findings),
        )
        return content
    if findings:
        logger.warning("Context file %s blocked: %s", filename, ", ".join(findings))
        return f"[BLOCKED: {filename} contained potential prompt injection ({', '.join(findings)}). Content not loaded.]"

    return content
'''
OLD_CALL = '''        content = _scan_context_content(content, "SOUL.md")
'''
NEW_CALL = '''        content = _scan_context_content(content, "SOUL.md", user_authored=True)
'''


def patch_text(source: str) -> str:
    candidate = source
    for old, new in ((OLD_DEF, NEW_DEF), (OLD_FINDINGS, NEW_FINDINGS), (OLD_CALL, NEW_CALL)):
        if new in candidate:
            if candidate.count(new) != 1:
                raise RuntimeError("Luna SOUL trust patch multiplicity drift")
            continue
        if candidate.count(old) != 1:
            raise RuntimeError("Luna SOUL trust patch anchor drift")
        candidate = candidate.replace(old, new)
    return candidate


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", default="/opt/hermes/agent/prompt_builder.py")
    args = parser.parse_args()
    target = Path(args.target)
    source = target.read_text(encoding="utf-8")
    candidate = patch_text(source)
    compile(candidate, str(target), "exec")
    if candidate != source:
        target.write_text(candidate, encoding="utf-8")
    if patch_text(candidate) != candidate:
        raise RuntimeError("Luna SOUL trust patch is not idempotent")
    print("PASS Luna trusted-SOUL loader patch")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
