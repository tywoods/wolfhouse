#!/usr/bin/env python3
"""Idempotent Discord adapter patch: bot/webhook wake watch-list seam.

Inserts a narrow admit before ``DISCORD_ALLOW_BOTS`` rejection so configured
thread+author webhook posts can start a Hermes turn without @mention and
without setting ``DISCORD_ALLOW_BOTS=all``.

Safe defaults: the injected call is a no-op unless
``DISCORD_BOT_WAKE_CHANNELS`` and ``DISCORD_BOT_WAKE_AUTHORS`` are set.
Preserves Water-cooler A2A admission-shape anchors.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Dict, Tuple

MARKER = "wolfhouse_discord_bot_wake_v1"

# Unique live-adapter anchors (must each appear exactly once).
ANCHOR_ALLOW_BOTS_ASSIGN = (
    '                    allow_bots = os.getenv("DISCORD_ALLOW_BOTS", "none").lower().strip()\n'
    '                    if allow_bots == "none":\n'
    "                        return"
)

# Keep surrounding comment/mentions shape intact for A2A patcher compatibility.
ANCHOR_ALLOW_BOTS_COMMENT = (
    "                # Bot message filtering (DISCORD_ALLOW_BOTS):\n"
    '                #   "none"     — ignore all other bots (default)\n'
    '                #   "mentions" — accept bot messages only when they @mention us\n'
    '                #   "all"      — accept all bot messages'
)

ANCHOR_ALLOW_BOTS_MENTIONS = (
    '                    elif allow_bots == "mentions":\n'
    "                        if not self._client.user or self._client.user not in message.mentions:\n"
    "                            return"
)

REPLACEMENT = (
    '                    allow_bots = os.getenv("DISCORD_ALLOW_BOTS", "none").lower().strip()\n'
    f"                    # {MARKER}\n"
    "                    # Narrow watch-list admit (thread/channel + author).\n"
    "                    # Does NOT set DISCORD_ALLOW_BOTS=all. Inactive until\n"
    "                    # DISCORD_BOT_WAKE_CHANNELS + DISCORD_BOT_WAKE_AUTHORS are set.\n"
    "                    try:\n"
    "                        from wolfhouse.discord_bot_wake import (\n"
    "                            bot_wake_admit as _wh_bot_wake,\n"
    "                        )\n"
    "                        if _wh_bot_wake(message):\n"
    '                            allow_bots = "all"\n'
    "                    except Exception:\n"
    "                        pass\n"
    '                    if allow_bots == "none":\n'
    "                        return"
)

DEFAULT_LIVE_ADAPTER = Path("/opt/hermes/plugins/platforms/discord/adapter.py")


class AdapterPatchError(RuntimeError):
    """Raised when anchors are missing, ambiguous, or the patch is corrupted."""


def _count(source: str, needle: str) -> int:
    return source.count(needle)


def validate_unpatched_shape(source: str) -> None:
    if not isinstance(source, str) or not source:
        raise AdapterPatchError("adapter source missing or empty")
    if MARKER in source:
        raise AdapterPatchError("adapter already has bot-wake marker (use patched validator)")
    for label, anchor in (
        ("allow_bots_assign", ANCHOR_ALLOW_BOTS_ASSIGN),
        ("allow_bots_comment", ANCHOR_ALLOW_BOTS_COMMENT),
        ("allow_bots_mentions", ANCHOR_ALLOW_BOTS_MENTIONS),
    ):
        n = _count(source, anchor)
        if n == 0:
            raise AdapterPatchError(f"admission shape anchor missing: {label}")
        if n != 1:
            raise AdapterPatchError(f"admission shape anchor ambiguous: {label} (count={n})")


def validate_patched_source(source: str) -> None:
    if _count(source, MARKER) != 1:
        raise AdapterPatchError("patch corruption: marker count")
    if "bot_wake_admit as _wh_bot_wake" not in source:
        raise AdapterPatchError("patch corruption: bot_wake import missing")
    if 'allow_bots = "all"' not in source:
        raise AdapterPatchError("patch corruption: watch-list promote missing")
    # Residual A2A-compatible anchors must remain unique.
    if _count(source, ANCHOR_ALLOW_BOTS_COMMENT) != 1:
        raise AdapterPatchError("patch corruption: allow_bots comment anchor")
    if _count(source, ANCHOR_ALLOW_BOTS_MENTIONS) != 1:
        raise AdapterPatchError("patch corruption: allow_bots mentions anchor")
    # Original bare none-return assign block must be gone.
    if ANCHOR_ALLOW_BOTS_ASSIGN in source:
        raise AdapterPatchError("patch corruption: bare allow_bots assign still present")


def patch_adapter_source(source: str) -> Tuple[str, Dict[str, object]]:
    if not isinstance(source, str):
        raise AdapterPatchError("adapter source must be str")
    if MARKER in source:
        validate_patched_source(source)
        compile(source, "<discord-adapter-bot-wake-patched>", "exec")
        return source, {"changed": False, "markers": [MARKER]}

    validate_unpatched_shape(source)
    n = _count(source, ANCHOR_ALLOW_BOTS_ASSIGN)
    if n != 1:
        raise AdapterPatchError(f"allow_bots_assign ambiguous (count={n})")
    patched = source.replace(ANCHOR_ALLOW_BOTS_ASSIGN, REPLACEMENT, 1)
    validate_patched_source(patched)
    compile(patched, "<discord-adapter-bot-wake-patched>", "exec")
    return patched, {"changed": True, "markers": [MARKER]}


def patch_adapter_file(path: Path) -> Dict[str, object]:
    path = Path(path)
    if not path.is_file():
        raise AdapterPatchError(f"adapter file not found: {path}")
    original = path.read_text(encoding="utf-8")
    patched, meta = patch_adapter_source(original)
    if meta.get("changed"):
        path.write_text(patched, encoding="utf-8")
    return {"path": str(path), **meta}


def resolve_adapter_path(explicit: str | None = None) -> Path:
    import os

    if explicit:
        return Path(explicit)
    env_raw = (os.getenv("HERMES_DISCORD_ADAPTER_PATH") or "").strip()
    if env_raw:
        env_path = Path(env_raw)
        if env_path.is_file():
            return env_path
    candidates = [
        DEFAULT_LIVE_ADAPTER,
        Path("/opt/hermes/hermes_agent/plugins/platforms/discord/adapter.py"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise AdapterPatchError(
        "discord adapter.py not found (expected /opt/hermes/plugins/platforms/discord/adapter.py)"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Apply Discord bot-wake adapter patch")
    parser.add_argument("--adapter", default="", help="Path to discord adapter.py")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate only; do not write",
    )
    args = parser.parse_args(argv)

    try:
        path = Path(args.adapter) if args.adapter else resolve_adapter_path()
        source = path.read_text(encoding="utf-8")
        if args.check:
            if MARKER in source:
                validate_patched_source(source)
            else:
                validate_unpatched_shape(source)
            print(f"ok check path={path} patched={MARKER in source}")
            return 0
        meta = patch_adapter_file(path)
        print(f"ok path={meta['path']} changed={meta['changed']}")
        return 0
    except AdapterPatchError as exc:
        print(f"apply_discord_bot_wake_patch failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"apply_discord_bot_wake_patch failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
