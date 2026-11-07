#!/usr/bin/env python3
"""Splice the diagnostic classifier into a copy of the resident terminal tool.

The target must be the recovered file SHA256
01fde249886999f2ed7de936ac610221214572abf8d0baaff008670d59be7dc1, or a file
this script already patched. Live installs under /opt/hermes and /opt/data
are refused. This script does not execute a terminal command, restart a
gateway, or select an image.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import inspect
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import terminal_gateway_lifecycle_diagnostic as diagnostic  # noqa: E402

MARKER = "wolfhouse_terminal_lifecycle_diagnostic_v1"
EXPECTED_SHA256 = "01fde249886999f2ed7de936ac610221214572abf8d0baaff008670d59be7dc1"
FUNCTION_START = "def _contains_terminal_gateway_lifecycle_command"
NEXT_FUNCTION = "def _rewrite_real_sudo_invocations"
CALL_SITE_OLD = (
    '        if os.environ.get("_HERMES_GATEWAY") == "1":\n'
    "            if _contains_terminal_gateway_lifecycle_command(command):\n"
    "                return json.dumps({\n"
    '                    "output": "",\n'
    '                    "exit_code": 1,\n'
    '                    "error": (\n'
    '                        "Blocked: cannot restart or stop the gateway from inside the "\n'
    '                        "gateway process. The gateway would kill this command before "\n'
    '                        "it could complete (SIGTERM propagates to child processes). "\n'
    "                        \"Run `hermes gateway restart` from a separate shell outside \"\n"
    '                        "the running gateway."\n'
    "                    ),\n"
    '                    "status": "error",\n'
    "                }, ensure_ascii=False)\n"
)


class PatchError(RuntimeError):
    """The resident file is not the expected original or patched shape."""


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def path_is_forbidden(resolved: Path) -> bool:
    text = resolved.as_posix()
    return (
        text == "/opt/hermes" or text.startswith("/opt/hermes/")
        or text == "/opt/data" or text.startswith("/opt/data/")
        or text == "/var/lib/hermes" or text.startswith("/var/lib/hermes/")
        or text.startswith("/var/lib/hermes-")
    )


def assert_target_allowed(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    if path_is_forbidden(resolved):
        raise PatchError(f"refusing live install path: {resolved}")
    if not resolved.is_file():
        raise PatchError(f"terminal tool path is not a file: {resolved}")
    fixture = (
        Path(__file__).resolve().parents[2]
        / "fixtures"
        / "hermes-resident-terminal-tool"
        / "terminal_tool.py"
    )
    if resolved == fixture:
        raise PatchError("refusing to modify the resident evidence fixture")
    return resolved


def replacement_block() -> str:
    names = (
        "_classify_terminal_gateway_lifecycle_command",
        "_contains_terminal_gateway_lifecycle_command",
        "terminal_gateway_guard_error",
    )
    parts = [
        f"LIFECYCLE_DENIAL_ERROR = {diagnostic.LIFECYCLE_DENIAL_ERROR!r}\n",
        f"UNSUPPORTED_DENIAL_ERROR = {diagnostic.UNSUPPORTED_DENIAL_ERROR!r}\n",
    ]
    for name in names:
        parts.append(inspect.getsource(getattr(diagnostic, name)).rstrip() + "\n")
    return "\n".join(parts) + "\n"


def call_site_new() -> str:
    return (
        '        if os.environ.get("_HERMES_GATEWAY") == "1":\n'
        f"            # {MARKER}\n"
        "            # Unconditional: force=True cannot bypass. Unsupported syntax stays denied.\n"
        "            _gateway_guard_error = terminal_gateway_guard_error(command)\n"
        "            if _gateway_guard_error is not None:\n"
        "                return json.dumps({\n"
        '                    "output": "",\n'
        '                    "exit_code": 1,\n'
        '                    "error": _gateway_guard_error,\n'
        '                    "status": "error",\n'
        "                }, ensure_ascii=False)\n"
    )


def _require_once(text: str, needle: str, label: str) -> int:
    count = text.count(needle)
    if count != 1:
        raise PatchError(f"{label} count is {count}, expected 1")
    return text.index(needle)


def validate_patched_source(text: str) -> None:
    if sha256_text(text) == EXPECTED_SHA256:
        raise PatchError("patched source still matches the unpatched resident hash")
    _require_once(text, MARKER, "marker")
    _require_once(text, "def _classify_terminal_gateway_lifecycle_command", "classifier")
    _require_once(text, "def terminal_gateway_guard_error", "guard error helper")
    if diagnostic.LIFECYCLE_DENIAL_ERROR not in text:
        raise PatchError("lifecycle denial text missing")
    if diagnostic.UNSUPPORTED_DENIAL_ERROR not in text:
        raise PatchError("unsupported-syntax denial text missing")
    call = call_site_new()
    _require_once(text, call, "diagnostic call site")
    executable = "\n".join(
        line for line in call.splitlines() if line.strip() and not line.strip().startswith("#")
    )
    if "force" in executable:
        raise PatchError("diagnostic call site consults force")
    force_at = text.index("        if not force:\n", text.index(call))
    if force_at < text.index(call):
        raise PatchError("force check moved ahead of the gateway guard")
    if "\nimport shlex\n" not in text:
        raise PatchError("import shlex missing")
    ast.parse(text)


def patch_text(text: str) -> str:
    if MARKER in text:
        validate_patched_source(text)
        return text
    if sha256_text(text) != EXPECTED_SHA256:
        raise PatchError(
            "refusing to patch: SHA256 is not the recovered resident terminal_tool.py "
            f"({EXPECTED_SHA256})"
        )
    start = _require_once(text, FUNCTION_START, "resident classifier")
    next_at = text.index(NEXT_FUNCTION, start)
    if text[start:next_at].count(FUNCTION_START) != 1:
        raise PatchError("classifier span is not unique")
    updated = text[:start] + replacement_block() + text[next_at:]
    count = updated.count(CALL_SITE_OLD)
    if count != 1:
        raise PatchError(f"resident call site count is {count}, expected 1")
    updated = updated.replace(CALL_SITE_OLD, call_site_new(), 1)
    if "\nimport shlex\n" not in updated:
        import_at = _require_once(updated, "\nimport re\n", "import re")
        updated = updated[: import_at + len("\nimport re\n")] + "import shlex\n" + updated[import_at + len("\nimport re\n") :]
    validate_patched_source(updated)
    return updated


def patch_file(path: Path) -> dict:
    target = assert_target_allowed(path)
    original = target.read_text(encoding="utf-8")
    updated = patch_text(original)
    changed = updated != original
    if changed:
        target.write_text(updated, encoding="utf-8")
    return {"path": str(target), "changed": changed, "sha256": sha256_text(updated)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--terminal-tool", required=True, help="Copy of resident terminal_tool.py to patch")
    parser.add_argument("--check", action="store_true", help="Validate only; do not write")
    args = parser.parse_args(argv)
    try:
        target = assert_target_allowed(Path(args.terminal_tool))
        text = target.read_text(encoding="utf-8")
        if args.check:
            if MARKER in text:
                validate_patched_source(text)
            else:
                patched = patch_text(text)
                if patched == text:
                    raise PatchError("check produced no diagnostic splice")
            print(f"ok check path={target} patched={MARKER in text}")
            return 0
        meta = patch_file(target)
        print(f"ok path={meta['path']} changed={meta['changed']} sha256={meta['sha256']}")
        return 0
    except PatchError as exc:
        print(f"apply_terminal_lifecycle_diagnostic_patch failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
