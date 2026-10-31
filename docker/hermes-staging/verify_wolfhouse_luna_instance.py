#!/usr/bin/env python3
"""Static repo checks for the isolated hermes-wolfhouse-luna compose instance.

Isolation is by container name, env file, data directory, and webhook port —
not a separate HERMES_ROLE. Run from the repo root or inside the staging image
(after docker-compose.vm.yml is copied beside this script).
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

STAGING = Path(__file__).resolve().parent
REPO_ROOT = STAGING.parent.parent if (STAGING.parent.parent / "AGENTS.md").is_file() else STAGING

SERVICE = "hermes-wolfhouse-luna"
LUNA_SERVICE = "hermes-luna"
WOLFHOUSE_ENV = "/etc/hermes-wolfhouse-luna.env"
LUNA_ENV = "/etc/hermes-luna.env"
WOLFHOUSE_DATA = "/var/lib/hermes-wolfhouse-luna"
LUNA_DATA = "/var/lib/hermes-luna"

BASE_LUNA_MODEL = """model:
  default: gpt-5.5
  provider: openai-codex
fallback_providers:
  - provider: anthropic
    model: anthropic/claude-sonnet-4-6
toolsets:
  - wolfhouse_staff_api
"""


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def extract_service_block(compose_text: str, service: str) -> str:
    lines = compose_text.splitlines()
    in_services = False
    block: list[str] = []
    collecting = False
    for line in lines:
        if line.startswith("services:"):
            in_services = True
            continue
        if not in_services:
            continue
        if re.match(rf"^  {re.escape(service)}:\s*$", line):
            collecting = True
            block = [line]
            continue
        if collecting:
            if re.match(r"^  [A-Za-z0-9_-]+:\s*$", line):
                break
            block.append(line)
    return "\n".join(block)


def contains_whatsapp_routing_to_8091(text: str) -> bool:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        lower = stripped.lower()
        if "reverse_proxy" not in lower:
            continue
        if "/whatsapp" in lower and "8091" in stripped:
            return True
    return False


def caddy_repo_sources() -> list[Path]:
    paths = [
        REPO_ROOT / "scripts" / "_lunabox-caddyfile",
        STAGING / "lunabox-caddyfile.reference",
        REPO_ROOT / "docs" / "HERMES-AZURE-VM.md",
    ]
    return [p for p in paths if p.is_file()]


def run_pin(pin_fn: str, role: str, slug: str, tenant: str, xai: bool) -> str:
    with tempfile.TemporaryDirectory() as td:
        home = Path(td)
        (home / "config.yaml").write_text(BASE_LUNA_MODEL, encoding="utf-8")
        env = os.environ.copy()
        env["HERMES_HOME"] = str(home)
        env["HERMES_ROLE"] = role
        env["LUNA_CLIENT_SLUG"] = slug
        env["LUNA_TENANT_ID"] = tenant
        if xai:
            env["XAI_API_KEY"] = "not-a-real-key"
        else:
            env.pop("XAI_API_KEY", None)
        script = pin_fn + "\npin_wolfhouse_luna_boot_model\n"
        subprocess.run(["bash", "-c", script], check=True, env=env, cwd=td)
        return (home / "config.yaml").read_text(encoding="utf-8")


def main() -> int:
    compose_path = STAGING / "docker-compose.vm.yml"
    bootstrap_path = STAGING / "bootstrap.sh"
    if not compose_path.is_file():
        print(f"FAIL: missing {compose_path}", file=sys.stderr)
        return 1
    if not bootstrap_path.is_file():
        print(f"FAIL: missing {bootstrap_path}", file=sys.stderr)
        return 1

    compose = read(compose_path)
    bootstrap = read(bootstrap_path)
    wolfhouse = extract_service_block(compose, SERVICE)
    luna = extract_service_block(compose, LUNA_SERVICE)
    luna_config = bootstrap[
        bootstrap.index("write_luna_config() {") : bootstrap.index("write_orchestrator_config() {")
    ]
    luna_env = bootstrap[
        bootstrap.index("write_luna_env() {") : bootstrap.index("pin_wolfhouse_luna_boot_model() {")
    ]
    pin_fn = bootstrap[
        bootstrap.index("pin_wolfhouse_luna_boot_model() {") : bootstrap.index("write_orchestrator_env() {")
    ]

    caddy_sources = caddy_repo_sources()
    caddy_text = "\n".join(read(p) for p in caddy_sources)

    sunset_pinned = run_pin(pin_fn, "sunset-luna", "sunset", "sunset", True)
    seadog_pinned = run_pin(pin_fn, "seadog", "", "", True)
    wolf_no_key = run_pin(pin_fn, "luna", "wolfhouse-somo", "wolfhouse-somo", False)
    wolf_with_key = run_pin(pin_fn, "luna", "wolfhouse-somo", "wolfhouse-somo", True)

    checks = {
        "compose_service_exists": f"  {SERVICE}:" in compose,
        "compose_container_name": "container_name: hermes-wolfhouse-luna" in wolfhouse,
        "compose_hermes_role_luna": re.search(
            r"HERMES_ROLE:\s*luna\b", wolfhouse
        ) is not None,
        "compose_env_file_wolfhouse": WOLFHOUSE_ENV in wolfhouse,
        "compose_env_file_not_luna": LUNA_ENV not in wolfhouse,
        "compose_data_path_wolfhouse": WOLFHOUSE_DATA in wolfhouse,
        "compose_not_mount_luna_home": LUNA_DATA not in wolfhouse,
        "compose_ports_8091": '"8091:8091"' in wolfhouse,
        "compose_webhook_port_env_8091": re.search(
            r'WHATSAPP_CLOUD_WEBHOOK_PORT:\s*"8091"', wolfhouse
        ) is not None,
        "compose_no_port_8090": "8090" not in wolfhouse,
        "bootstrap_webhook_port_from_env": (
            '_luna_webhook_port="${WHATSAPP_CLOUD_WEBHOOK_PORT:-8090}"' in bootstrap
            and "printf 'WHATSAPP_CLOUD_WEBHOOK_PORT=8090\\n'" not in bootstrap
        ),
        "caddy_whatsapp_not_to_8091": (
            bool(caddy_sources) and not contains_whatsapp_routing_to_8091(caddy_text)
        ),
        "luna_service_unchanged_8090": '"8090:8090"' in luna,
        "luna_service_unchanged_env": LUNA_ENV in luna and WOLFHOUSE_ENV not in luna,
        "luna_service_unchanged_data": LUNA_DATA in luna and WOLFHOUSE_DATA not in luna,
        "shared_luna_config_stays_gpt55_anthropic": (
            "default: gpt-5.5" in luna_config
            and "provider: anthropic" in luna_config
            and "anthropic/claude-sonnet-4-6" in luna_config
            and "grok-4.7" not in luna_config
            and "default: gpt-6.1-sol" not in luna_config
        ),
        "sunset_sed_still_gpt55_to_sol": (
            "sed -i 's/^  default: gpt-5\\.5$/  default: gpt-5.6-sol/'" in bootstrap
        ),
        "wolfhouse_pin_gated_role_and_tenant": (
            '[ "${HERMES_ROLE:-}" = "luna" ]' in pin_fn
            and "wolfhouse-somo" in pin_fn
            and "pin_wolfhouse_luna_boot_model" in bootstrap
            and bootstrap.find("write_luna_config")
            < bootstrap.find("pin_wolfhouse_luna_boot_model")
        ),
        "grok_fallback_only_when_xai_key": (
            '[ -n "${XAI_API_KEY:-}" ]' in pin_fn
            and "provider: xai" in pin_fn
            and "model: grok-4.7" in pin_fn
        ),
        "luna_env_persists_xai_key": "XAI_API_KEY" in luna_env,
        "sunset_config_unchanged_from_base": (
            "default: gpt-5.5" in sunset_pinned
            and "anthropic/claude-sonnet-4-6" in sunset_pinned
            and "grok-4.7" not in sunset_pinned
            and "gpt-6.1-sol" not in sunset_pinned
        ),
        "seadog_config_unchanged_from_base": (
            "default: gpt-5.5" in seadog_pinned
            and "anthropic/claude-sonnet-4-6" in seadog_pinned
            and "grok-4.7" not in seadog_pinned
        ),
        "wolfhouse_no_key_no_fallback": (
            "default: gpt-6.1-sol" in wolf_no_key
            and "fallback_providers:" not in wolf_no_key
            and "grok-4.7" not in wolf_no_key
            and "anthropic/claude-sonnet-4-6" not in wolf_no_key
        ),
        "wolfhouse_with_key_grok_fallback": (
            "default: gpt-6.1-sol" in wolf_with_key
            and "provider: xai" in wolf_with_key
            and "model: grok-4.7" in wolf_with_key
            and "anthropic/claude-sonnet-4-6" not in wolf_with_key
        ),
    }

    print(json.dumps(checks, indent=2))
    if all(checks.values()):
        print("ALL OK")
        return 0

    print("FAIL: isolated Wolfhouse Luna instance checks", file=sys.stderr)
    for name, ok in checks.items():
        if not ok:
            print(f"FAIL: {name}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
