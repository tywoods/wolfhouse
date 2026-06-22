#!/usr/bin/env python3
"""Static gate for Hermes STT staging patches (no container required)."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PATCHES = ROOT / "apply_stt_patches.py"
UPSTREAM = ROOT / "_upstream_transcription_tools.py"
CONFIG_UPSTREAM = ROOT / "_upstream_config.py"


def fail(msg: str) -> None:
    print(f"FAIL  {msg}", file=sys.stderr)
    raise SystemExit(1)


def ok(msg: str) -> None:
    print(f"PASS  {msg}")


def main() -> int:
    src = PATCHES.read_text(encoding="utf-8")
    ok("apply_stt_patches.py present")
    for needle in (
        'STT_PROVIDER',
        'env_provider = os.getenv("STT_PROVIDER"',
        '"stt", "tts", "voice"',
        "Wolfhouse: preserve/seed stt block",
    ):
        if needle not in src:
            fail(f"missing patch marker: {needle}")
    ok("patch markers present")

    if UPSTREAM.exists():
        sample = UPSTREAM.read_text(encoding="utf-8")
        if 'explicit = "provider" in stt_config' not in sample:
            fail("upstream transcription_tools anchor missing")
        ok("upstream transcription_tools anchor available")

    bootstrap = (ROOT / "bootstrap.sh").read_text(encoding="utf-8")
    if "apply_stt_patches.py" not in bootstrap:
        fail("bootstrap.sh does not invoke apply_stt_patches.py")
    if "stt:" not in bootstrap:
        fail("bootstrap Luna config missing stt block")
    ok("bootstrap wired")

    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    if "apply_stt_patches.py" not in dockerfile:
        fail("Dockerfile does not bake STT patches")
    ok("Dockerfile wired")

    print("\nverify_stt_patches PASSED\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
