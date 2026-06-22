"""Block gateway-originated system/diagnostic WhatsApp sends on Luna guest channels."""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

logger = logging.getLogger(__name__)

_GUEST_WHATSAPP_PLATFORMS = frozenset({"whatsapp", "whatsapp_cloud"})


def _platform_value(platform: Any) -> str:
    if platform is None:
        return ""
    return str(getattr(platform, "value", platform) or "").strip().lower()


def is_luna_guest_whatsapp(*, platform: Any = None, adapter: Any = None) -> bool:
    if os.getenv("HERMES_ROLE", "").strip().lower() != "luna":
        return False
    if adapter is not None:
        plat = getattr(adapter, "platform", None)
        platform = getattr(plat, "value", plat) or getattr(adapter, "name", "")
    return _platform_value(platform) in _GUEST_WHATSAPP_PLATFORMS


def is_guest_facing_platform(platform: Any) -> bool:
    return is_luna_guest_whatsapp(platform=platform)


def mark_agent_reply_metadata(metadata: Any, platform: Any = None) -> dict:
    if not is_luna_guest_whatsapp(platform=platform):
        return dict(metadata) if isinstance(metadata, dict) else {}
    out = dict(metadata) if isinstance(metadata, dict) else {}
    out["wolfhouse_guest_reply"] = True
    return out


def guest_stt_echo_enabled(*, source: Any = None) -> bool:
    raw = os.getenv("WOLFHOUSE_GUEST_STT_ECHO", "").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    try:
        from hermes_cli.config import load_config

        cfg = load_config() or {}
        wa = ((cfg.get("gateway") or {}).get("platforms") or {}).get("whatsapp_cloud") or {}
        if isinstance(wa, dict) and "stt_echo" in wa:
            return bool(wa.get("stt_echo"))
    except Exception:
        pass
    return False


def stt_dev_hints_enabled() -> bool:
    return os.getenv("WOLFHOUSE_STT_DEV_HINTS", "").strip().lower() in {"1", "true", "yes", "on"}


def suppress_guest_whatsapp_text_send(content: Any, metadata: Any = None) -> bool:
    """Return True when a text send to the guest must be dropped."""
    if not is_luna_guest_whatsapp():
        return False
    meta = metadata if isinstance(metadata, dict) else {}
    if meta.get("wolfhouse_guest_reply"):
        return False
    preview = str(content or "").replace("\n", " ")[:160]
    logger.info("Wolfhouse: suppressed non-agent WhatsApp send: %s", preview)
    return True


def suppress_guest_interactive_send(kind: str) -> bool:
    if not is_luna_guest_whatsapp():
        return False
    logger.info("Wolfhouse: suppressed guest WhatsApp interactive send (%s)", kind)
    return True
