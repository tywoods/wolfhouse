"""Final Luna v3 startup admission, after Hermes loads retained dotenv state."""

from __future__ import annotations

import os
from importlib.util import find_spec
from pathlib import Path
import sys

from bootstrap import validate_effective_platforms, validate_environment


def validate_final_startup_config() -> None:
    """Load startup dotenv state, then enforce Luna's environment and API-only gates."""
    from hermes_cli.config import get_hermes_home
    from hermes_cli.env_loader import load_hermes_dotenv

    home = Path(get_hermes_home())
    gateway_spec = find_spec("gateway.run")
    if gateway_spec is None or gateway_spec.origin is None:
        raise RuntimeError("cannot locate the Hermes gateway package")
    project_env = Path(gateway_spec.origin).resolve().parents[1] / ".env"
    load_hermes_dotenv(hermes_home=home, project_env=project_env)
    validate_environment()
    validate_effective_platforms()


def main() -> int:
    try:
        validate_final_startup_config()
    except Exception as exc:
        print(f"refusing Luna v3 startup: {exc}", file=sys.stderr)
        return 1

    if "--validate-only" in sys.argv[1:]:
        return 0

    os.execvp("hermes", ["hermes", "gateway", "run"])
    return 127


if __name__ == "__main__":
    raise SystemExit(main())
