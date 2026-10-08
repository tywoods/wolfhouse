#!/usr/bin/env python3
"""Reproducibly compose reviewed admission into the narrow gateway seam."""
from __future__ import annotations

import ast
import importlib.util
import sys
from pathlib import Path

TAG = "# Luna reviewed admission: after capacity, before fresh turn."
ANCHOR = "        self._running_agents[_quick_key] = _AGENT_PENDING_SENTINEL\n"
LEGACY_START = "        # Existing adapter admit on this message identity, before session claim.\n"
LEGACY_END = "        # ── Claim this session before any await ───────────────────────\n"
LIVE_JOURNAL = '"/opt/data/luna-admission/owner.journal"'
OWNER_BLOCK = '''        from gateway.identity_admission_owner import IdentityAdmissionOwner
        self._admission_lock_owner = IdentityAdmissionOwner(
            "/opt/data/luna-admission/owner.journal"
        )
'''
BLOCK = '''        # Luna reviewed admission: after capacity, before fresh turn.
        try:
            from wolfhouse.gateway_admission_integration import admit_gateway_message
            _admitted = admit_gateway_message(self, event, source, _quick_key)
        except Exception:
            self._release_running_agent_state(_quick_key)
            raise
        if _admitted is not True:
            self._release_running_agent_state(_quick_key)
            return None
'''


def _initialize_clean_owner(source: str) -> str:
    tree = ast.parse(source)
    runners = [node for node in tree.body
               if isinstance(node, ast.ClassDef) and node.name == "GatewayRunner"]
    if len(runners) != 1:
        raise RuntimeError("clean gateway runner class missing or ambiguous")
    initializers = [node for node in runners[0].body
                    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and node.name == "__init__"]
    if len(initializers) != 1 or not initializers[0].body:
        raise RuntimeError("clean gateway runner initializer missing or ambiguous")
    body = initializers[0].body
    first = body[0]
    if (isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant)
            and isinstance(first.value.value, str)):
        line_index = first.end_lineno or first.lineno
    else:
        line_index = first.lineno - 1
    lines = source.splitlines(keepends=True)
    lines.insert(line_index, OWNER_BLOCK)
    return "".join(lines)


def compose_source(source: str) -> str:
    if TAG in source:
        if (source.count(TAG) != 1
                or source.count("admit_gateway_message(self, event, source, _quick_key)") != 1
                or LEGACY_START in source or source.count(LIVE_JOURNAL) != 1):
            raise RuntimeError("gateway admission composition is duplicated or malformed")
        compile(source, "<composed-gateway-run>", "exec")
        return source
    legacy_start = source.count(LEGACY_START)
    legacy_end = source.count(LEGACY_END)
    if legacy_start:
        if legacy_start != 1 or legacy_end != 1:
            raise RuntimeError("legacy gateway admission veto missing or ambiguous")
        start = source.index(LEGACY_START)
        end = source.index(LEGACY_END)
        if start >= end or source.count(LIVE_JOURNAL) != 1:
            raise RuntimeError("legacy gateway admission owner is missing or malformed")
        # Replace the LIVE veto; its existing owner and namespace stay untouched.
        source = source[:start] + source[end:]
    elif legacy_end > 1:
        # The capacity comment is normal clean source, but duplicates are not.
        raise RuntimeError("gateway capacity seam is ambiguous")
    elif source.count(LIVE_JOURNAL) == 0:
        # A clean installed gateway has no LIVE owner yet. Initialize that same
        # reviewed owner in GatewayRunner.__init__, never a parallel namespace.
        source = _initialize_clean_owner(source)
    elif source.count(LIVE_JOURNAL) != 1:
        raise RuntimeError("clean gateway admission owner is ambiguous")
    if source.count(ANCHOR) != 1:
        raise RuntimeError("gateway fresh-admission anchor missing or ambiguous")
    result = source.replace(ANCHOR, BLOCK + ANCHOR, 1)
    compile(result, "<composed-gateway-run>", "exec")
    return result


def install(path: Path) -> bool:
    original = path.read_text(encoding="utf-8")
    composed = compose_source(original)
    if composed == original:
        return False
    path.write_text(composed, encoding="utf-8")
    return True


def main() -> int:
    spec = importlib.util.find_spec("gateway.run")
    if spec is None or not spec.origin:
        print("gateway.run not found", file=sys.stderr)
        return 1
    try:
        install(Path(spec.origin))
    except Exception as exc:
        print(f"install_gateway_admission failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
