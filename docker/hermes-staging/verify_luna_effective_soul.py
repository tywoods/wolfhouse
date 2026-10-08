#!/usr/bin/env python3
"""Prove Luna's effective Hermes identity using genuine isolated config loading."""
from __future__ import annotations

import argparse
import importlib
import importlib.util
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOUL = ROOT / "SOUL.md"
BOOTSTRAP = ROOT / "bootstrap.sh"
EXPECTED_CAP = 200_000
OBSERVED_OLD_CAP = 65_280


def luna_config_writer_source() -> str:
    source = BOOTSTRAP.read_text(encoding="utf-8")
    match = re.search(
        r"(?ms)^(write_luna_config\(\)\s*\{\n.*?^\})\s*$",
        source,
    )
    if not match:
        raise AssertionError("write_luna_config function not found")
    return match.group(1)


def write_luna_config(home: Path) -> None:
    """Run the real bootstrap writer function, without executing bootstrap."""
    env = os.environ.copy()
    env["HOME"] = str(home)
    env["HERMES_HOME"] = str(home)
    script = "set -eu\n" + luna_config_writer_source() + "\nwrite_luna_config\n"
    subprocess.run(["/bin/sh", "-c", script], cwd=ROOT, env=env, check=True)


def resolved_cap(config_module) -> int:
    config = config_module.load_config()
    cap = config.get("context_file_max_chars")
    if cap != EXPECTED_CAP:
        raise AssertionError(
            f"resolved Luna context_file_max_chars must be {EXPECTED_CAP}, got {cap!r}"
        )
    return cap


def validate_effective(source: str, effective: str, cap: int) -> None:
    if cap < len(source):
        raise AssertionError(f"configured cap {cap} is below SOUL length {len(source)}")
    if not effective:
        raise AssertionError("Hermes load_soul_md returned no effective identity")
    if "[...truncated SOUL.md:" in effective:
        raise AssertionError("effective SOUL still contains Hermes truncation marker")
    if effective != source:
        raise AssertionError(
            f"effective SOUL differs from source: source={len(source)} effective={len(effective)}"
        )


def omitted_headings(source: str) -> list[str]:
    start = int(OBSERVED_OLD_CAP * 0.7)
    end = len(source) - int(OBSERVED_OLD_CAP * 0.2)
    headings: list[str] = []
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


def assert_required_sections(source: str, effective: str) -> int:
    dropped = omitted_headings(source)
    missing = [heading for heading in dropped if heading not in effective]
    required = [
        "## Quote, payment choice, and language (repair rules)",
        "**Per-guest payment-link labels:**",
        "## When first choice is unavailable — quote the alternative immediately",
        "## After a quote — keep the same beds when booking",
        "## Room arrangement and accepted-offer continuity",
        "## Revalidation preserves consent; operation claims require evidence",
        "### Accepted consent survives unchanged revalidation",
        "**Quote failure recovery (hard):**",
    ]
    missing_required = [item for item in required if item not in effective]
    if missing or missing_required:
        raise AssertionError(
            {"omitted_headings_missing": missing, "required_missing": missing_required}
        )
    return len(dropped)


def assert_rejected(label: str, operation) -> None:
    try:
        operation()
    except (AssertionError, FileNotFoundError, KeyError, TypeError, ValueError):
        return
    raise AssertionError(f"negative control unexpectedly passed: {label}")


def import_prompt_builder(hermes_root: str, prompt_builder_file: str | None):
    sys.path.insert(0, hermes_root)
    if prompt_builder_file:
        spec = importlib.util.spec_from_file_location("agent.prompt_builder", prompt_builder_file)
        if spec is None or spec.loader is None:
            raise AssertionError("could not load patched prompt_builder")
        module = importlib.util.module_from_spec(spec)
        sys.modules["agent.prompt_builder"] = module
        spec.loader.exec_module(module)
        return module
    return importlib.import_module("agent.prompt_builder")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hermes-root", default="/opt/hermes")
    parser.add_argument("--prompt-builder-file")
    args = parser.parse_args()
    source = SOUL.read_text(encoding="utf-8").strip()

    old_home = os.environ.get("HOME")
    old_hermes_home = os.environ.get("HERMES_HOME")
    sys.dont_write_bytecode = True
    with tempfile.TemporaryDirectory(prefix="luna-effective-soul-") as directory:
        isolation_root = Path(directory).resolve()
        isolated_home = isolation_root / "home"
        isolated_home.mkdir()
        os.environ["HOME"] = str(isolated_home)
        os.environ["HERMES_HOME"] = str(isolated_home)

        outside_writes: list[tuple[str, str]] = []

        def audit_write(event: str, args: tuple) -> None:
            mutating = event in {
                "os.mkdir", "os.chmod", "os.remove", "os.rename", "os.replace",
                "os.rmdir", "os.symlink", "os.link", "os.truncate",
            }
            if event == "open" and len(args) >= 3:
                mode = args[1] or ""
                flags = args[2] or 0
                mutating = any(char in mode for char in "wax+") or bool(
                    flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)
                )
            if not mutating or not args or not isinstance(args[0], (str, bytes, os.PathLike)):
                return
            target = Path(os.fsdecode(args[0]))
            if not target.is_absolute():
                target = (Path.cwd() / target).resolve()
            else:
                target = target.resolve()
            if target != isolation_root and isolation_root not in target.parents:
                outside_writes.append((event, str(target)))

        sys.addaudithook(audit_write)

        # HERMES_HOME is set before importing any Hermes module. The real bootstrap
        # config writer and genuine config loader must both resolve this same home.
        pb = import_prompt_builder(str(Path(args.hermes_root).resolve()), args.prompt_builder_file)
        config_module = importlib.import_module("hermes_cli.config")
        write_luna_config(isolated_home)
        (isolated_home / "SOUL.md").write_text(source, encoding="utf-8")

        cap = resolved_cap(config_module)
        effective = pb.load_soul_md(context_length=272_000)
        validate_effective(source, effective, cap)
        restored_count = assert_required_sections(source, effective)

        # Negative control 1: missing config must fail the explicit resolved-cap gate.
        config_path = isolated_home / "config.yaml"
        config_text = config_path.read_text(encoding="utf-8")
        config_path.unlink()
        assert_rejected("missing config", lambda: resolved_cap(config_module))

        # Negative control 2: a real config with the observed wrong cap must fail.
        config_path.write_text(
            config_text.replace(
                "context_file_max_chars: 200000",
                f"context_file_max_chars: {OBSERVED_OLD_CAP}",
                1,
            ),
            encoding="utf-8",
        )
        assert_rejected("wrong-cap config", lambda: resolved_cap(config_module))

        # All paths used by the writer and loader resolve beneath the isolated
        # HERMES_HOME; ambient HOME is deliberately the same isolated directory.
        config_module.ensure_hermes_home()
        resolved_paths = [
            isolated_home,
            config_path.resolve(),
            (isolated_home / "SOUL.md").resolve(),
            Path(config_module.get_hermes_home()).resolve(),
        ]
        outside = [path for path in resolved_paths if path != isolated_home and isolation_root not in path.parents]
        if outside:
            raise AssertionError(f"write resolved outside isolated HERMES_HOME: {outside}")
        if outside_writes:
            raise AssertionError(f"writes observed outside isolated HERMES_HOME: {outside_writes}")
        print("PASS no writes resolved outside isolated HERMES_HOME")

    if old_home is None:
        os.environ.pop("HOME", None)
    else:
        os.environ["HOME"] = old_home
    if old_hermes_home is None:
        os.environ.pop("HERMES_HOME", None)
    else:
        os.environ["HERMES_HOME"] = old_hermes_home

    print(
        f"PASS effective Luna SOUL via genuine Hermes config/load_soul_md: "
        f"source={len(source)} effective={len(effective)} cap={cap}"
    )
    print(f"PASS negative controls: missing config, wrong-cap config ({OBSERVED_OLD_CAP})")
    print(f"RESTORED headings formerly inside observed 65,280-char omission: {restored_count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
