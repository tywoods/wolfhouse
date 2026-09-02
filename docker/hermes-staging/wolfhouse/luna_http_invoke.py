"""Sol home + config pin for sunset-luna-http (shared with email-luna pattern).

Isolated openai-codex credential at /opt/data/.hermes/auth.json. Config pins
Sol and declares wolfhouse_staff_api tools. Never shares WhatsApp auth pool.
"""

from __future__ import annotations

import os
from pathlib import Path

from wolfhouse.email_draft_invoke import (
    assert_sol_config,
    pin_sunset_email_hermes_home,
    resolve_sunset_email_hermes_home,
)
from wolfhouse.luna_http_contract import MODEL, PROVIDER

MOUNTED_HOME = Path("/opt/data")
CANONICAL_HERMES_HOME = MOUNTED_HOME / ".hermes"

HTTP_SOL_CONFIG = "\n".join(
    [
        "model:",
        f"  default: {MODEL}",
        f"  provider: {PROVIDER}",
        "agent:",
        "  reasoning_effort: none",
        "toolsets:",
        "  - wolfhouse_staff_api",
        "plugins:",
        "  enabled:",
        "    - wolfhouse-staff-api",
        "memory:",
        "  memory_enabled: false",
        "  user_profile_enabled: false",
        "curator:",
        "  enabled: false",
        "",
    ]
)


def resolve_luna_http_hermes_home() -> Path:
    return resolve_sunset_email_hermes_home()


def pin_luna_http_hermes_home() -> Path:
    return pin_sunset_email_hermes_home()


def ensure_luna_http_sol_home(home: Path | None = None) -> Path:
    """Pin Sol + staff tools config. Refuse shared/symlink auth."""
    root = home if home is not None else pin_luna_http_hermes_home()
    auth = root / "auth.json"
    if auth.is_symlink() or (root / ".auth-shared" / "auth.json").exists():
        raise RuntimeError("isolated_auth_missing")
    if (root.parent / ".auth-shared" / "auth.json").exists():
        raise RuntimeError("isolated_auth_missing")
    if not auth.is_file():
        raise RuntimeError("isolated_auth_missing")
    (root / "config.yaml").write_text(HTTP_SOL_CONFIG, encoding="utf-8")
    assert_sol_config(root)
    # Plugin tree is installed by bootstrap; runtime only asserts when present.
    plugins = root / "plugins" / "wolfhouse_staff_api"
    if plugins.exists() and not plugins.is_dir():
        raise RuntimeError("staff_plugin_missing")
    soul = root / "SOUL.md"
    if soul.exists() and (soul.is_symlink() or not soul.is_file() or soul.stat().st_size < 32):
        raise RuntimeError("soul_missing")
    return root


def soul_and_tools_ready(home: Path | None = None) -> dict[str, bool]:
    root = home if home is not None else resolve_luna_http_hermes_home()
    return {
        "sol_configured": (root / "config.yaml").is_file(),
        "soul_loaded": (root / "SOUL.md").is_file(),
        "tools_loaded": (root / "plugins" / "wolfhouse_staff_api").is_dir()
        or bool(os.environ.get("LUNA_HTTP_ALLOW_MISSING_PLUGIN_TREE")),
    }
