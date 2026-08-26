"""Invoke openai-codex / gpt-5.6-sol through the local Hermes runtime.

Fails closed when Hermes internals or isolated auth.json are missing.
Never uses api.openai.com Chat Completions (cannot host gpt-5.6-sol).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Callable

from wolfhouse.email_draft_contract import BAKED_SYSTEM, MODEL, PROVIDER, parse_acts_payload

HERMES_HOME = Path(os.environ.get("HERMES_HOME", "/opt/data"))


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


def _cli_invoke(system: str, user: str) -> str:
    """Best-effort Hermes CLI JSON completion. Fail closed on any miss."""
    prompt = f"{system}\n\n{user}\n"
    candidates = (
        ["hermes", "chat", "--no-stream", "--json"],
        [sys.executable, "-m", "hermes", "chat", "--no-stream", "--json"],
    )
    last_error = "hermes_invoke_unavailable"
    for cmd in candidates:
        try:
            completed = subprocess.run(
                cmd,
                input=prompt,
                text=True,
                capture_output=True,
                timeout=20,
                check=False,
                env={**os.environ, "HERMES_HOME": str(HERMES_HOME)},
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
            last_error = type(exc).__name__
            continue
        if completed.returncode != 0:
            last_error = f"exit_{completed.returncode}"
            continue
        text = (completed.stdout or "").strip()
        if not text:
            last_error = "empty_stdout"
            continue
        if parse_acts_payload(text):
            return text
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            last_error = "non_json"
            continue
        if isinstance(parsed, dict) and "acts" in parsed:
            dumped = json.dumps({"acts": parsed["acts"]}, separators=(",", ":"))
            if parse_acts_payload(dumped):
                return dumped
        content = parsed.get("content") if isinstance(parsed, dict) else None
        if isinstance(content, str) and parse_acts_payload(content):
            return content
        last_error = "unparsed_cli"
    raise RuntimeError(last_error)


def default_invoke(system: str, user: str) -> str:
    assert_sol_config()
    auth = HERMES_HOME / "auth.json"
    if not auth.is_file() or auth.is_symlink():
        raise RuntimeError("isolated_auth_missing")
    return _cli_invoke(system, user)


InvokeFn = Callable[[str, str], str]
