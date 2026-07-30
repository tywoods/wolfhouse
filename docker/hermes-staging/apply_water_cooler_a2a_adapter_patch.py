#!/usr/bin/env python3
"""Fail-closed, idempotent patcher for Water-cooler A2A Discord seams.

Patches the Hermes Discord adapter
(``plugins/platforms/discord/adapter.py`` / live path
``/opt/hermes/plugins/platforms/discord/adapter.py``) with two gated seams:

1. Narrow mention-bypass seam inside ``_handle_message`` require_mention
   gating — admits a valid human TASK / protocol message without globally
   changing ``require_mention``, free-response channels, or
   ``DISCORD_ALLOW_BOTS``.
2. Pre-model-dispatch intercept after ``MessageEvent`` construction and
   before ``handle_message`` / text-batch enqueue. Passes the raw Discord
   ``message`` object explicitly so policy can read author/bot/channel/id/
   content/timestamp without guessing MessageEvent attributes.

Default is off: not invoked by ``apply_gateway_patches.py`` or Dockerfile.
Bootstrap calls this only when ``HERMES_ROLE`` is ``seadog`` or ``deckhand``
**and** ``WATER_COOLER_A2A_ENABLED=true``. Otherwise adapter.py is never
touched. Explicit ``--apply`` remains available for tests.

Fail-closed rules:
- Require unique admission-shape anchors from the live adapter.
- Reject unknown / ambiguous / partial / corrupted source without writing.
- Idempotent re-apply when already correctly patched.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

# ---------------------------------------------------------------------------
# Markers (post-patch identity)
# ---------------------------------------------------------------------------

MARKER_MENTION_BYPASS = "wolfhouse_water_cooler_a2a_mention_bypass_v2"
MARKER_PRE_DISPATCH = "wolfhouse_water_cooler_a2a_pre_dispatch_v1"

# ---------------------------------------------------------------------------
# Live-adapter admission-shape anchors (must each appear exactly once)
# ---------------------------------------------------------------------------

ANCHOR_SELF_IGNORE = (
    "                # Always ignore our own messages\n"
    "                if message.author == self._client.user:\n"
    "                    return"
)

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

ANCHOR_HANDLE_MESSAGE_CALL = (
    "                await self._handle_message(message, role_authorized=_role_authorized)"
)

ANCHOR_REQUIRE_MENTION = (
    "            if require_mention and not is_free_channel and not in_bot_thread:\n"
    "                if self._client.user not in message.mentions and not mention_prefix:\n"
    "                    return\n"
)

ANCHOR_PRE_DISPATCH = (
    "        if msg_type == MessageType.TEXT and self._text_batch_delay_seconds > 0:\n"
    "            self._enqueue_text_event(event)\n"
    "        else:\n"
    "            await self.handle_message(event)\n"
)

# Additional shape markers (presence + uniqueness) for free/mention routing.
ANCHOR_FREE_RESPONSE_HELPER = "def _discord_free_response_channels(self)"
ANCHOR_REQUIRE_MENTION_HELPER = "def _discord_require_mention(self)"
ANCHOR_HANDLE_MESSAGE_DEF = (
    "    async def _handle_message(self, message: DiscordMessage, role_authorized: bool = False) -> None:"
)

ADMISSION_SHAPE_ANCHORS: Tuple[Tuple[str, str], ...] = (
    ("self_ignore", ANCHOR_SELF_IGNORE),
    ("allow_bots_comment", ANCHOR_ALLOW_BOTS_COMMENT),
    ("allow_bots_mentions", ANCHOR_ALLOW_BOTS_MENTIONS),
    ("handle_message_call", ANCHOR_HANDLE_MESSAGE_CALL),
    ("require_mention_gate", ANCHOR_REQUIRE_MENTION),
    ("pre_dispatch", ANCHOR_PRE_DISPATCH),
    ("free_response_helper", ANCHOR_FREE_RESPONSE_HELPER),
    ("require_mention_helper", ANCHOR_REQUIRE_MENTION_HELPER),
    ("handle_message_def", ANCHOR_HANDLE_MESSAGE_DEF),
)

# ---------------------------------------------------------------------------
# Patch replacements
# ---------------------------------------------------------------------------

REQUIRE_MENTION_REPLACEMENT = (
    "            if require_mention and not is_free_channel and not in_bot_thread:\n"
    "                if self._client.user not in message.mentions and not mention_prefix:\n"
    "                    # wolfhouse_water_cooler_a2a_mention_bypass_v2\n"
    "                    # Narrow A2A-only seam (Navigation thread under Water-cooler).\n"
    "                    # Does NOT change require_mention defaults, free_response_channels,\n"
    "                    # or DISCORD_ALLOW_BOTS. Inactive until\n"
    "                    # water_cooler_a2a_adapter_hooks.a2a_allow_mention_bypass returns True.\n"
    "                    try:\n"
    "                        from wolfhouse.water_cooler_a2a_adapter_hooks import (\n"
    "                            a2a_allow_mention_bypass as _wh_a2a_mb,\n"
    "                        )\n"
    "                        if _wh_a2a_mb(\n"
    '                            channel_id=str(getattr(message.channel, "id", "") or ""),\n'
    '                            parent_channel_id=str(getattr(message.channel, "parent_id", "") or ""),\n'
    '                            content=(raw_content if isinstance(raw_content, str) else "") or "",\n'
    '                            author_is_bot=bool(getattr(message.author, "bot", False)),\n'
    "                        ):\n"
    "                            pass\n"
    "                        else:\n"
    "                            return\n"
    "                    except Exception:\n"
    "                        return\n"
)

PRE_DISPATCH_REPLACEMENT = (
    "        # wolfhouse_water_cooler_a2a_pre_dispatch_v1\n"
    "        # Placement: after MessageEvent construction, before model dispatch.\n"
    "        # Pass raw Discord message explicitly (author/bot/channel/id/content/\n"
    "        # timestamp) — do not guess MessageEvent attributes. Gated hooks\n"
    "        # return True when fully handled/suppressed.\n"
    "        try:\n"
    "            from wolfhouse.water_cooler_a2a_adapter_hooks import (\n"
    "                a2a_pre_dispatch_intercept as _wh_a2a_pd,\n"
    "            )\n"
    "            if _wh_a2a_pd(event, adapter=self, message=message):\n"
    "                return\n"
    "        except Exception:\n"
    "            pass\n"
    "\n"
    "        if msg_type == MessageType.TEXT and self._text_batch_delay_seconds > 0:\n"
    "            self._enqueue_text_event(event)\n"
    "        else:\n"
    "            await self.handle_message(event)\n"
)


class AdapterPatchError(RuntimeError):
    """Raised when anchors are missing, ambiguous, or the patch is corrupted."""


def _count(source: str, needle: str) -> int:
    return source.count(needle)


def validate_admission_shape(source: str) -> None:
    """Require the captured live-adapter admission shape (unique anchors).

    Does not modify source. Raises :class:`AdapterPatchError` on any mismatch.
    """
    if not isinstance(source, str) or not source:
        raise AdapterPatchError("adapter source missing or empty")

    for label, anchor in ADMISSION_SHAPE_ANCHORS:
        n = _count(source, anchor)
        if n == 0:
            raise AdapterPatchError(f"admission shape anchor missing: {label}")
        if n != 1:
            raise AdapterPatchError(f"admission shape anchor ambiguous: {label} (count={n})")

    # Ordering contract: self-ignore → allow-bots → handle_message call →
    # require_mention gate → pre-dispatch (model dispatch).
    positions = [source.index(a) for _, a in ADMISSION_SHAPE_ANCHORS[:6]]
    if positions != sorted(positions):
        raise AdapterPatchError("admission shape anchor order invalid")


def validate_patched_source(source: str) -> None:
    """Validate a fully patched adapter (markers + residual anchors)."""
    if _count(source, MARKER_MENTION_BYPASS) != 1:
        raise AdapterPatchError("patch corruption: mention bypass marker")
    if _count(source, MARKER_PRE_DISPATCH) != 1:
        raise AdapterPatchError("patch corruption: pre-dispatch marker")
    if _count(source, "a2a_allow_mention_bypass as _wh_a2a_mb") != 1:
        raise AdapterPatchError("patch corruption: mention bypass import")
    if _count(source, "a2a_pre_dispatch_intercept as _wh_a2a_pd") != 1:
        raise AdapterPatchError("patch corruption: pre-dispatch import")
    if _count(source, "message=message") < 1:
        raise AdapterPatchError("patch corruption: raw message not passed to pre-dispatch")
    if 'parent_channel_id=str(getattr(message.channel, "parent_id", "") or "")' not in source:
        raise AdapterPatchError("patch corruption: parent_channel_id not passed to mention bypass")

    # Unpatched require_mention bare return must be gone; patched form present.
    if ANCHOR_REQUIRE_MENTION in source:
        raise AdapterPatchError("patch corruption: bare require_mention gate still present")
    if "a2a_allow_mention_bypass" not in source:
        raise AdapterPatchError("patch corruption: mention bypass seam missing")

    # Pre-dispatch: model dispatch block remains, with marker before it.
    if _count(source, ANCHOR_PRE_DISPATCH) != 1:
        raise AdapterPatchError("patch corruption: model dispatch block missing")
    pre_idx = source.index(MARKER_PRE_DISPATCH)
    disp_idx = source.index(ANCHOR_PRE_DISPATCH)
    if pre_idx > disp_idx:
        raise AdapterPatchError("patch corruption: pre-dispatch not before model dispatch")

    # Residual admission anchors (still unique) excluding the replaced gate.
    residual = (
        ("self_ignore", ANCHOR_SELF_IGNORE),
        ("allow_bots_comment", ANCHOR_ALLOW_BOTS_COMMENT),
        ("allow_bots_mentions", ANCHOR_ALLOW_BOTS_MENTIONS),
        ("handle_message_call", ANCHOR_HANDLE_MESSAGE_CALL),
        ("pre_dispatch", ANCHOR_PRE_DISPATCH),
        ("free_response_helper", ANCHOR_FREE_RESPONSE_HELPER),
        ("require_mention_helper", ANCHOR_REQUIRE_MENTION_HELPER),
        ("handle_message_def", ANCHOR_HANDLE_MESSAGE_DEF),
    )
    for label, anchor in residual:
        n = _count(source, anchor)
        if n != 1:
            raise AdapterPatchError(f"patch corruption: residual anchor {label} (count={n})")


def _replace_once(source: str, anchor: str, replacement: str, label: str) -> str:
    n = _count(source, anchor)
    if n == 0:
        raise AdapterPatchError(f"{label} anchor missing")
    if n != 1:
        raise AdapterPatchError(f"{label} anchor ambiguous (count={n})")
    return source.replace(anchor, replacement, 1)


def patch_adapter_source(source: str) -> Tuple[str, Dict[str, object]]:
    """Apply A2A seams to adapter source text. Never writes files.

    Returns ``(new_source, meta)`` where meta includes ``changed`` bool.
    On any validation failure raises :class:`AdapterPatchError` and the
    caller must not write the original file.
    """
    if not isinstance(source, str):
        raise AdapterPatchError("adapter source must be str")

    has_mention = MARKER_MENTION_BYPASS in source
    has_pre = MARKER_PRE_DISPATCH in source

    if has_mention or has_pre:
        if not (has_mention and has_pre):
            raise AdapterPatchError("patch corruption: partial markers")
        validate_patched_source(source)
        compile(source, "<discord-adapter-a2a-patched>", "exec")
        return source, {"changed": False, "markers": [MARKER_MENTION_BYPASS, MARKER_PRE_DISPATCH]}

    # Unpatched path: full admission-shape validation first (no mutation yet).
    validate_admission_shape(source)

    patched = _replace_once(
        source,
        ANCHOR_REQUIRE_MENTION,
        REQUIRE_MENTION_REPLACEMENT,
        "require_mention_gate",
    )
    patched = _replace_once(
        patched,
        ANCHOR_PRE_DISPATCH,
        PRE_DISPATCH_REPLACEMENT,
        "pre_dispatch",
    )
    validate_patched_source(patched)
    compile(patched, "<discord-adapter-a2a-patched>", "exec")
    return patched, {"changed": True, "markers": [MARKER_MENTION_BYPASS, MARKER_PRE_DISPATCH]}


def patch_adapter_file(path: Path) -> Dict[str, object]:
    """Read → patch → validate → write only on success. Fail-closed on error."""
    path = Path(path)
    if not path.is_file():
        raise AdapterPatchError(f"adapter path not found: {path}")
    original = path.read_text(encoding="utf-8")
    try:
        patched, meta = patch_adapter_source(original)
    except AdapterPatchError:
        # Do not write on failure.
        raise
    if not meta.get("changed"):
        return {"changed": False, "path": str(path), **{k: v for k, v in meta.items() if k != "changed"}}
    # Write only after full validation succeeded inside patch_adapter_source.
    path.write_text(patched, encoding="utf-8")
    # Re-read verify
    on_disk = path.read_text(encoding="utf-8")
    try:
        validate_patched_source(on_disk)
    except AdapterPatchError:
        # Best-effort restore
        path.write_text(original, encoding="utf-8")
        raise AdapterPatchError("post-write validation failed; restored original")
    return {"changed": True, "path": str(path), **{k: v for k, v in meta.items() if k != "changed"}}


def default_live_adapter_path() -> Path:
    return Path("/opt/hermes/plugins/platforms/discord/adapter.py")


def main(argv: Sequence[str] | None = None) -> int:
    """CLI is opt-in. Default exit refuses automatic apply without --apply.

    Bootstrap activation invokes ``patch_adapter_file`` directly after the
    role+enable gate — this CLI remains explicit-only so image builds never
    patch by accident.
    """
    parser = argparse.ArgumentParser(
        description="Water-cooler A2A Discord adapter patch (opt-in; not default)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually apply the patch (required; refused by default)",
    )
    parser.add_argument(
        "--adapter",
        type=Path,
        default=None,
        help="Path to discord adapter.py (default: live Hermes path if present)",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Validate admission shape only; do not write",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    adapter = args.adapter
    if adapter is None:
        adapter = default_live_adapter_path()

    if args.check:
        try:
            src = Path(adapter).read_text(encoding="utf-8")
            if MARKER_MENTION_BYPASS in src or MARKER_PRE_DISPATCH in src:
                validate_patched_source(src)
                print({"ok": True, "state": "patched", "path": str(adapter)})
            else:
                validate_admission_shape(src)
                print({"ok": True, "state": "unpatched_valid", "path": str(adapter)})
            return 0
        except Exception as exc:
            print(f"apply_water_cooler_a2a_adapter_patch check failed: {exc}", file=sys.stderr)
            return 1

    if not args.apply:
        print(
            "apply_water_cooler_a2a_adapter_patch: refusing automatic apply "
            "(gated bootstrap uses patch_adapter_file after role+enable check; "
            "pass --apply to run this CLI explicitly)",
            file=sys.stderr,
        )
        return 2

    try:
        result = patch_adapter_file(Path(adapter))
        print(result)
        return 0
    except Exception as exc:
        print(f"apply_water_cooler_a2a_adapter_patch failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
