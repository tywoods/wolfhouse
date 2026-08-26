"""Invoke openai-codex / gpt-5.6-sol through the installed Hermes composition.

Config.yaml is a gate (must already be Sol) — never provenance. The live
terminal Responses model plus resolve_runtime_provider() for this attempt
are the only accepted provider/model source.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

from wolfhouse.email_draft_contract import MODEL, PROVIDER, AttemptResult
from wolfhouse.email_draft_hermes import ProvenanceError, invoke_installed_hermes

HERMES_HOME = Path(os.environ.get("HERMES_HOME", "/opt/data"))

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
    root = home or HERMES_HOME
    auth = root / "auth.json"
    if auth.is_symlink() or (root / ".auth-shared" / "auth.json").exists():
        raise RuntimeError("isolated_auth_missing")
    if not auth.is_file():
        raise RuntimeError("isolated_auth_missing")
    (root / "config.yaml").write_text(SOL_CONFIG, encoding="utf-8")
    assert_sol_config(root)


def read_config_model_provider(home: Path | None = None) -> tuple[str, str]:
    path = (home or HERMES_HOME) / "config.yaml"
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
    assert_sol_config()
    auth = HERMES_HOME / "auth.json"
    if not auth.is_file() or auth.is_symlink():
        raise RuntimeError("isolated_auth_missing")
    try:
        return invoke_installed_hermes(system, user)
    except ProvenanceError as exc:
        raise RuntimeError(str(exc) or "provenance_unavailable") from exc


InvokeFn = Callable[[str, str], AttemptResult | str]
