#!/usr/bin/env python3
"""Idempotently wrap the pinned Hermes Codex provider-attempt seam."""
from __future__ import annotations
import importlib.util
import py_compile
import sys
from pathlib import Path

ORIGINAL = '    def _run_codex_stream(self, api_kwargs: dict, client: Any = None, on_first_delta: callable = None):'
RENAMED = '    def _run_codex_stream_without_crowsnest(self, api_kwargs: dict, client: Any = None, on_first_delta: callable = None):'
WRAPPER = '''    def _run_codex_stream(self, api_kwargs: dict, client: Any = None, on_first_delta: callable = None):
        # crowsnest_observe_provider_attempt: guest_reply uses monotonic latency and
        # report_success_daemon/report_failure_daemon inside the fail-open observer.
        import os
        if os.environ.get("HERMES_ROLE") != "sunset-luna" or str(getattr(self, "provider", "")).lower() != "openai-codex":
            return self._run_codex_stream_without_crowsnest(api_kwargs, client, on_first_delta)
        from wolfhouse.crowsnest_ai_usage_reporter import observe_provider_attempt
        return observe_provider_attempt(
            lambda: self._run_codex_stream_without_crowsnest(api_kwargs, client, on_first_delta),
            model=str(getattr(self, "model", "")), env=os.environ,
        )

'''

def patch_file(path: Path):
    original = path.read_text(encoding="utf-8")
    if "crowsnest_observe_provider_attempt" in original:
        py_compile.compile(str(path), doraise=True)
        return {"changed": False, "path": str(path)}
    if original.count(ORIGINAL) != 1:
        raise RuntimeError("run_agent._run_codex_stream anchor not found exactly once")
    patched = original.replace(ORIGINAL, WRAPPER + RENAMED, 1)
    path.write_text(patched, encoding="utf-8")
    try: py_compile.compile(str(path), doraise=True)
    except Exception:
        path.write_text(original, encoding="utf-8"); raise
    return {"changed": True, "path": str(path)}

def main():
    spec=importlib.util.find_spec("run_agent")
    if not spec or not spec.origin:
        print("run_agent module not found", file=sys.stderr); return 1
    try: print(patch_file(Path(spec.origin)))
    except Exception as exc: print(f"apply_crowsnest_ai_usage_patch failed: {exc}", file=sys.stderr); return 1
    return 0
if __name__ == "__main__": raise SystemExit(main())
