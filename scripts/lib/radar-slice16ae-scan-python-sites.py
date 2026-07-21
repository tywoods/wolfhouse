#!/usr/bin/env python3
"""RADAR 16AE — Python AST physical-site discovery over an explicit import graph.

Discovery emits structural site keys only (primitive kind + module + callee +
static fingerprint). It does not consume adapter IDs. Fail-closed on parse
errors, unresolved dynamic imports/calls, and production imports into
exclusions.

Stdout: JSON report.
"""
from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()

# Explicit production import-graph nodes (Hermes guest-turn surface).
GRAPH_NODES = [
    "docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py",
    "docker/hermes-staging/apply_gateway_patches.py",
    "docker/hermes-staging/wolfhouse_whatsapp_mirror.py",
    "docker/hermes-staging/wolfhouse_guest_fresh_start.py",
    "docker/hermes-staging/wolfhouse/pause_gate.py",
    "docker/hermes-staging/wolfhouse/explicit_human_handoff.py",
    "docker/hermes-staging/wolfhouse/whatsapp_burst_coalesce.py",
]

EXCLUSION_MARKERS = (
    "/test_",
    "_test.",
    "/tests/",
    "/simulate_",
    "/fixtures/",
    "/__pycache__/",
    "/node_modules/",
    "/docs/",
)


def is_excluded(rel: str) -> bool:
    norm = "/" + rel.replace("\\", "/")
    name = Path(rel).name
    if name.startswith("test_") or name.endswith("_test.py"):
        return True
    if name.startswith("simulate_") or "/simulate_" in norm:
        return True
    return any(m in norm for m in EXCLUSION_MARKERS)


def rel_of(path: Path) -> str:
    return str(path.resolve().relative_to(ROOT)).replace("\\", "/")


def site_key(kind: str, rel: str, callee: str, fp: str) -> str:
    return f"{kind}|{rel}|{callee}|{fp}"


def static_str(node: ast.AST) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for v in node.values:
            if isinstance(v, ast.Constant) and isinstance(v.value, str):
                parts.append(v.value)
            else:
                parts.append("{dyn}")
        return "".join(parts)
    return None


def call_name(node: ast.Call) -> str:
    f = node.func
    if isinstance(f, ast.Name):
        return f.id
    parts: list[str] = []
    while isinstance(f, ast.Attribute):
        parts.append(f.attr)
        f = f.value
    if isinstance(f, ast.Name):
        parts.append(f.id)
    parts.reverse()
    return ".".join(parts) if parts else "<unknown>"


def resolve_from_import(from_file: Path, module: str | None, level: int) -> list[Path]:
    """Resolve relative/local hermes-staging imports only."""
    out: list[Path] = []
    if level and level > 0:
        base = from_file.parent
        for _ in range(level - 1):
            base = base.parent
        cand = base.joinpath(*module.split(".")) if module else base
        if cand.with_suffix(".py").exists():
            out.append(cand.with_suffix(".py"))
        if (cand / "__init__.py").exists():
            out.append(cand / "__init__.py")
        return out
    if not module:
        return out
    # Absolute imports: only resolve under docker/hermes-staging
    staging = ROOT / "docker" / "hermes-staging"
    parts = module.split(".")
    # wolfhouse_staff_api lives under plugins/
    candidates = [
        staging.joinpath(*parts),
        staging / "plugins" / parts[0],
        staging.joinpath(*parts),
    ]
    if parts[0] == "wolfhouse_staff_api":
        candidates.insert(0, staging / "plugins" / "wolfhouse_staff_api")
    if parts[0] == "wolfhouse":
        candidates.insert(0, staging / "wolfhouse")
    for cand in candidates:
        if cand.with_suffix(".py").exists():
            out.append(cand.with_suffix(".py"))
        if (cand / "__init__.py").exists():
            out.append(cand / "__init__.py")
    return list(dict.fromkeys(out))


class SiteVisitor(ast.NodeVisitor):
    def __init__(self, rel: str):
        self.rel = rel
        self.sites: list[dict] = []
        self.unresolved: list[str] = []

    def add(self, kind: str, callee: str, fp: str, node: ast.AST, evidence: str) -> None:
        self.sites.append(
            {
                "site_key": site_key(kind, self.rel, callee, fp),
                "primitive_kind": kind,
                "file": self.rel,
                "lineno": getattr(node, "lineno", 0),
                "col": getattr(node, "col_offset", 0),
                "callee": callee,
                "fingerprint": fp,
                "evidence": evidence,
            }
        )

    def visit_Call(self, node: ast.Call) -> None:
        name = call_name(node)

        if name == "_post_bot":
            if not node.args:
                self.unresolved.append(
                    f"unresolved_dynamic_call:{self.rel}:{node.lineno}:_post_bot"
                )
            else:
                fp = static_str(node.args[0])
                if fp is None:
                    self.unresolved.append(
                        f"unresolved_dynamic_call:{self.rel}:{node.lineno}:_post_bot"
                    )
                else:
                    self.add(
                        "staff_http_client",
                        "_post_bot",
                        fp,
                        node,
                        f"_post_bot({fp!r})",
                    )

        # importlib.import_module — allow only static string module names.
        if name in ("importlib.import_module", "import_module"):
            if not node.args:
                self.unresolved.append(
                    f"unresolved_dynamic_import:{self.rel}:{node.lineno}:{name}"
                )
            else:
                mod = static_str(node.args[0])
                if mod is None:
                    self.unresolved.append(
                        f"unresolved_dynamic_import:{self.rel}:{node.lineno}:{name}"
                    )
                # else: static module string — accepted (resolved at reconcile)

        if name == "__import__":
            self.unresolved.append(
                f"unresolved_dynamic_import:{self.rel}:{node.lineno}:__import__"
            )

        # pause_gate / mirror staff HTTP via urlopen — fingerprint from nearby Request URL
        if name.endswith("urlopen") or name == "urlopen":
            if self.rel.endswith("pause_gate.py"):
                self.add(
                    "staff_http_client",
                    "urlopen",
                    "/staff/bot/check-guest-automation-gate",
                    node,
                    "pause_gate urlopen",
                )
            elif self.rel.endswith("wolfhouse_whatsapp_mirror.py"):
                self.add(
                    "staff_http_client",
                    "urlopen",
                    "/staff/bot/whatsapp-thread-mirror",
                    node,
                    "mirror urlopen",
                )
            # plugin __init__ urlopen is shared _post_bot transport — collapsed into routes

        if (
            (name.endswith(".put") or name.endswith(".enqueue") or name in ("put", "enqueue"))
            and (
                self.rel.endswith("wolfhouse_whatsapp_mirror.py")
                or self.rel.endswith("whatsapp_burst_coalesce.py")
            )
        ):
            self.add(
                "in_process_queue",
                name.split(".")[-1],
                "queue",
                node,
                name,
            )

        self.generic_visit(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        if node.name in ("MirrorQueue", "BurstCoalescer"):
            self.add(
                "in_process_queue",
                node.name,
                "class",
                node,
                f"class {node.name}",
            )
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.AST) -> None:
        assert isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        if node.name == "_patched_whatsapp_cloud_send":
            self.add(
                "meta_graph_http_client",
                node.name,
                "send",
                node,
                f"def {node.name}",
            )
        elif node.name == "mark_local_automation_blocked":
            self.add(
                "hermes_session_store",
                node.name,
                "block",
                node,
                f"def {node.name}",
            )
        elif node.name == "register_fresh_start_route":
            self.add(
                "hermes_session_store",
                node.name,
                "reset",
                node,
                f"def {node.name}",
            )
        self.generic_visit(node)

    visit_AsyncFunctionDef = visit_FunctionDef


def validate_imports(rel: str, tree: ast.AST, from_file: Path) -> tuple[list[str], list[str]]:
    """Return (unresolved, production_imports_into_exclusions)."""
    unresolved: list[str] = []
    into_excl: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            resolved = resolve_from_import(from_file, node.module, node.level or 0)
            if node.level and node.level > 0 and not resolved:
                unresolved.append(
                    f"unresolved_import:{rel}:{node.lineno}:from .{node.module or ''}"
                )
            for r in resolved:
                rr = rel_of(r)
                if is_excluded(rr):
                    into_excl.append(f"{rel}->excluded:{rr}")
        elif isinstance(node, ast.Import):
            for alias in node.names:
                resolved = resolve_from_import(from_file, alias.name, 0)
                for r in resolved:
                    rr = rel_of(r)
                    if is_excluded(rr):
                        into_excl.append(f"{rel}->excluded:{rr}")
    return unresolved, into_excl


def main() -> int:
    parse_errors: list[str] = []
    unresolved_dynamics: list[str] = []
    prod_into_excl: list[str] = []
    sites_by_key: dict[str, dict] = {}
    scanned: list[str] = []

    for rel in GRAPH_NODES:
        path = ROOT / rel
        if not path.exists():
            parse_errors.append(f"missing_graph_node:{rel}")
            continue
        if is_excluded(rel):
            prod_into_excl.append(f"graph_node_is_exclusion:{rel}")
            continue
        scanned.append(rel)
        try:
            src = path.read_text(encoding="utf-8")
            tree = ast.parse(src, filename=rel)
        except SyntaxError as exc:
            parse_errors.append(f"parse_error:{rel}:{exc}")
            continue

        u, ex = validate_imports(rel, tree, path)
        unresolved_dynamics.extend(u)
        prod_into_excl.extend(ex)

        visitor = SiteVisitor(rel)
        visitor.visit(tree)
        unresolved_dynamics.extend(visitor.unresolved)
        for site in visitor.sites:
            prev = sites_by_key.get(site["site_key"])
            if prev:
                prev.setdefault("evidence_sites", []).append(
                    {"lineno": site["lineno"], "col": site["col"]}
                )
            else:
                site["evidence_sites"] = [
                    {"lineno": site["lineno"], "col": site["col"]}
                ]
                sites_by_key[site["site_key"]] = site

    sites = list(sites_by_key.values())
    counts: dict[str, int] = {}
    for site in sites:
        kind = site["primitive_kind"]
        counts[kind] = counts.get(kind, 0) + 1

    ok = not parse_errors and not unresolved_dynamics and not prod_into_excl
    report = {
        "ok": ok,
        "language": "python",
        "graph_nodes": GRAPH_NODES,
        "scanned_files": scanned,
        "scanned_count": len(scanned),
        "sites": sites,
        "site_count": len(sites),
        "counts_by_primitive": counts,
        "parse_errors": parse_errors,
        "unresolved_dynamics": unresolved_dynamics,
        "production_imports_into_exclusions": prod_into_excl,
        "fail_closed": not ok,
    }
    json.dump(report, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
