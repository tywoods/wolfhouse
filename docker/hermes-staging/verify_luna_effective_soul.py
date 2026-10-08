#!/usr/bin/env python3
"""Prove Luna's effective Hermes identity is complete, not merely copied intact."""
from __future__ import annotations
import argparse
import importlib
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOUL = ROOT / "SOUL.md"
BOOTSTRAP = ROOT / "bootstrap.sh"
OBSERVED_OLD_CAP = 65_280


def configured_cap() -> int:
    src = BOOTSTRAP.read_text(encoding="utf-8")
    match_block = re.search(
        r"write_luna_config\(\)\s*\{\s*cat > .*?<<'EOF'\n(?P<body>.*?)\nEOF\n\}",
        src,
        re.S,
    )
    if not match_block:
        raise AssertionError("write_luna_config heredoc not found")
    block = match_block.group("body")
    match = re.search(r"(?m)^context_file_max_chars:\s*(\d+)\s*$", block)
    if not match:
        raise AssertionError("write_luna_config does not pin context_file_max_chars")
    return int(match.group(1))


def omitted_headings(source: str) -> list[str]:
    start = int(OBSERVED_OLD_CAP * 0.7)
    end = len(source) - int(OBSERVED_OLD_CAP * 0.2)
    headings = []
    offset = 0
    fenced = False
    for line in source.splitlines(keepends=True):
        stripped = line.strip()
        if stripped.startswith(("```", "~~~")):
            fenced = not fenced
        elif not fenced and start <= offset < end and re.match(r"#{1,6} \S", stripped):
            headings.append(stripped)
        offset += len(line)
    return headings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes-root", default="/opt/hermes")
    args = parser.parse_args()
    source = SOUL.read_text(encoding="utf-8").strip()
    cap = configured_cap()
    if cap < len(source):
        raise AssertionError(f"configured cap {cap} is below SOUL length {len(source)}")

    hermes_root = str(Path(args.hermes_root).resolve())
    sys.path.insert(0, hermes_root)
    pb = importlib.import_module("agent.prompt_builder")
    old_config = getattr(pb, "_config_readonly")
    try:
        setattr(pb, "_config_readonly", lambda _key: {"context_file_max_chars": cap})
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / "SOUL.md").write_text(source, encoding="utf-8")
            effective = pb.load_soul_md(context_length=272_000, home_override=home)
    finally:
        setattr(pb, "_config_readonly", old_config)

    if not effective:
        raise AssertionError("Hermes load_soul_md returned no effective identity")
    if "[...truncated SOUL.md:" in effective:
        raise AssertionError("effective SOUL still contains Hermes truncation marker")

    dropped = omitted_headings(source)
    missing = [heading for heading in dropped if heading not in effective]
    required = [
        "**Quote failure recovery (hard):**",
        "## Changing an existing booking",
        "## Live booking placement and post-booking continuity",
    ]
    missing_required = [item for item in required if item not in effective]
    if missing or missing_required:
        raise AssertionError({"omitted_headings_missing": missing, "required_missing": missing_required})

    print(f"PASS effective Luna SOUL via Hermes load_soul_md: source={len(source)} effective={len(effective)} cap={cap}")
    print(f"RESTORED headings formerly inside observed 65,280-char omission: {len(dropped)}")
    for heading in dropped:
        print(f"  {heading}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
