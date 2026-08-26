"""Invoke openai-codex / gpt-5.6-sol through the installed Hermes composition.

Config.yaml is a gate (must already be Sol) — never provenance. Provider is
the actual Codex Responses transport attempt; model is the live terminal
Responses event. Config, env, constants, wrapper args, and client labels
are not accepted as provider/model proof.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

from wolfhouse.email_draft_contract import MODEL, PROVIDER, AttemptResult
from wolfhouse.email_draft_hermes import ProvenanceError, invoke_installed_hermes

MOUNTED_HOME = Path("/opt/data")
CANONICAL_HERMES_HOME = MOUNTED_HOME / ".hermes"


def resolve_sunset_email_hermes_home() -> Path:
    """Return the one durable Hermes home for sunset-email-luna.

    Installed Hermes writes auth.json at get_hermes_home()/auth.json.
    When HERMES_HOME is unset, that is Path.home()/.hermes. Docker image ENV
    and stale YAML used HERMES_HOME=/opt/data (the Azure Files mount), which
    disagrees with auth-add (HOME=/opt/data → /opt/data/.hermes/auth.json).
    Remap the Docker default to /opt/data/.hermes. Unset HERMES_HOME follows
    $HOME/.hermes (HOME=/opt/data in production). Tests may set HERMES_HOME
    to a tmp path; leave those alone. Never copy or symlink a root-level decoy.
    """
    env = (os.environ.get("HERMES_HOME") or "").strip()
    if env == str(MOUNTED_HOME):
        return CANONICAL_HERMES_HOME
    if env:
        return Path(env)
    home = (os.environ.get("HOME") or "").strip()
    if not home or home == "/root":
        return CANONICAL_HERMES_HOME
    return Path(home) / ".hermes"


def pin_sunset_email_hermes_home() -> Path:
    """Export HOME=/opt/data and HERMES_HOME=/opt/data/.hermes for installed Hermes."""
    root = resolve_sunset_email_hermes_home()
    os.environ["HERMES_HOME"] = str(root)
    home = (os.environ.get("HOME") or "").strip()
    if not home or home == "/root":
        os.environ["HOME"] = str(MOUNTED_HOME)
    return root


HERMES_HOME = resolve_sunset_email_hermes_home()

SOL_CONFIG = "\n".join(
    [
        "model:",
        "  default: gpt-5.6-sol",
        "  provider: openai-codex",
        "agent:",
        "  reasoning_effort: none",
        "memory:",
        "  memory_enabled: false",
        "  user_profile_enabled: false",
        "curator:",
        "  enabled: false",
        "",
    ]
)


def ensure_isolated_sol_home(home: Path | None = None) -> None:
    """Pin Sol config for ACA (no s6) and Lunabox. Never a provenance source."""
    root = home if home is not None else pin_sunset_email_hermes_home()
    auth = root / "auth.json"
    if auth.is_symlink() or (root / ".auth-shared" / "auth.json").exists():
        raise RuntimeError("isolated_auth_missing")
    if (root.parent / ".auth-shared" / "auth.json").exists():
        raise RuntimeError("isolated_auth_missing")
    if not auth.is_file():
        raise RuntimeError("isolated_auth_missing")
    (root / "config.yaml").write_text(SOL_CONFIG, encoding="utf-8")
    assert_sol_config(root)


def read_config_model_provider(home: Path | None = None) -> tuple[str, str]:
    path = (home or resolve_sunset_email_hermes_home()) / "config.yaml"
    text = path.read_text(encoding="utf-8")
    model = ""
    provider = ""
    in_model = False
    for raw in text.splitlines():
        line = raw.rstrip()
        if line.startswith("model:"):
            in_model = True
            continue
        if in_model and line and not line.startswith(" ") and not line.startswith("\t"):
            break
        if in_model and line.startswith("  default:"):
            model = line.split(":", 1)[1].strip()
        elif in_model and line.startswith("  provider:"):
            provider = line.split(":", 1)[1].strip()
    return model, provider


def assert_sol_config(home: Path | None = None) -> None:
    model, provider = read_config_model_provider(home)
    if provider != PROVIDER or model != MODEL:
        raise RuntimeError("hermes_sol_config_mismatch")


def default_invoke(system: str, user: str) -> AttemptResult:
    root = pin_sunset_email_hermes_home()
    assert_sol_config(root)
    auth = root / "auth.json"
    if not auth.is_file() or auth.is_symlink():
        raise RuntimeError("isolated_auth_missing")
    try:
        return invoke_installed_hermes(system, user)
    except ProvenanceError as exc:
        raise RuntimeError(str(exc) or "provenance_unavailable") from exc


InvokeFn = Callable[[str, str], AttemptResult | str]
