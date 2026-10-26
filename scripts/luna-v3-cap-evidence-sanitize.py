#!/usr/bin/env python3
"""Sanitize Luna v3 Cap evidence without emitting sensitive material."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
from typing import Any

_SENSITIVE_KEY_PARTS = (
    "env", "secret", "password", "passwd", "token", "api_key", "apikey",
    "authorization", "credential",
)
_SK_TOKEN = re.compile(b"s" + b"k-" + rb"[A-Za-z0-9_-]+")


def _normalized_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value).lower()).strip("_")


def _sensitive_key(value: Any) -> bool:
    key = _normalized_key(value)
    return any(part in key for part in _SENSITIVE_KEY_PARTS)


def scrub_structure(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: scrub_structure(child) for key, child in value.items() if not _sensitive_key(key)}
    if isinstance(value, list):
        return [scrub_structure(child) for child in value]
    return value


def sensitive_environment_values() -> list[bytes]:
    values: set[bytes] = set()
    for name, value in os.environ.items():
        if value and (_sensitive_key(name) or name.startswith("CAP_REDACT_")):
            encoded = value.encode("utf-8")
            if len(encoded) >= 4:
                values.add(encoded)
    return sorted(values, key=len, reverse=True)


def scrub_bytes(data: bytes) -> bytes:
    for value in sensitive_environment_values():
        data = data.replace(value, b"[REDACTED]")
    return _SK_TOKEN.sub(b"[REDACTED]", data)


def inspect_command() -> int:
    document = json.load(sys.stdin)
    json.dump(scrub_structure(document), sys.stdout, sort_keys=True, indent=2)
    sys.stdout.write("\n")
    return 0


def log_command() -> int:
    sys.stdout.buffer.write(scrub_bytes(sys.stdin.buffer.read()))
    return 0


def check_command(root: pathlib.Path) -> int:
    if not root.is_dir():
        print("BLOCKED: evidence directory is absent", file=sys.stderr)
        return 2

    exact_values = sensitive_environment_values()
    violations: list[str] = []
    files = sorted(candidate for candidate in root.rglob("*") if candidate.is_file())
    for path in files:
        data = path.read_bytes()
        if _SK_TOKEN.search(data) or any(value in data for value in exact_values):
            violations.append(str(path.relative_to(root)))

    if violations:
        print("BLOCKED: sensitive material detected in evidence files: " + ", ".join(violations), file=sys.stderr)
        return 1
    print(f"PASS: evidence sensitive-data scan ({len(files)} files)")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("inspect")
    subparsers.add_parser("log")
    check_parser = subparsers.add_parser("check")
    check_parser.add_argument("evidence_dir", type=pathlib.Path)
    args = parser.parse_args()
    if args.command == "inspect":
        return inspect_command()
    if args.command == "log":
        return log_command()
    return check_command(args.evidence_dir)


if __name__ == "__main__":
    raise SystemExit(main())
