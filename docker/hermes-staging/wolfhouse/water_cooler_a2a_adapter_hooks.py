"""Inert Water-cooler A2A adapter seams (not activated).

These hooks are the only repository-owned call targets injected by
``apply_water_cooler_a2a_adapter_patch.py`` into the Hermes Discord adapter.

Default behaviour is fail-closed / inert:

- ``a2a_allow_mention_bypass`` always returns False (no mention exemption).
- ``a2a_pre_dispatch_intercept`` always returns False (no model intercept).

Future activation may call the pure policy / runtime bridge here. It must
never globally change ``require_mention``, free-response channels, or
``DISCORD_ALLOW_BOTS``. Not wired for production enablement in this slice.
"""

from __future__ import annotations

from typing import Any, Optional


def a2a_allow_mention_bypass(
    *,
    channel_id: str,
    content: str,
    author_is_bot: bool,
) -> bool:
    """Narrow mention-bypass seam for a future A2A admission path.

    Returns True only when a later activation admits a Water-cooler protocol
    message that ordinary ``require_mention`` would otherwise drop.

    Currently always False (inactive). Does not read ambient env, does not
    widen free-response channels, and does not broaden bot admission.
    """
    # Parameters reserved for a later, explicit activation. Keep names so the
    # injected adapter call site stays stable.
    _ = (channel_id, content, author_is_bot)
    return False


def a2a_pre_dispatch_intercept(
    event: Any,
    *,
    adapter: Any = None,
) -> bool:
    """Pre-model-dispatch seam for a future A2A runtime bridge.

    Returns True when the event was fully handled / suppressed and must not
    reach the agent model. Currently always False (inactive).

    Placement contract: called after MessageEvent construction and before
    ``handle_message`` / text-batch enqueue (model dispatch).
    """
    _ = (event, adapter)
    return False


def is_a2a_adapter_hooks_active() -> bool:
    """Explicit activation probe — always False until a later enablement slice."""
    return False


__all__ = [
    "a2a_allow_mention_bypass",
    "a2a_pre_dispatch_intercept",
    "is_a2a_adapter_hooks_active",
]
