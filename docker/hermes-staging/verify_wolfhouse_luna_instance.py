#!/usr/bin/env python3
"""Static repo checks for the isolated hermes-wolfhouse-luna compose instance.

Isolation is by container name, env file, data directory, and webhook port —
not a separate HERMES_ROLE. Run from the repo root or inside the staging image
(after docker-compose.vm.yml is copied beside this script).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

STAGING = Path(__file__).resolve().parent
REPO_ROOT = STAGING.parent.parent if (STAGING.parent.parent / "AGENTS.md").is_file() else STAGING

SERVICE = "hermes-wolfhouse-luna"
LUNA_SERVICE = "hermes-luna"
WOLFHOUSE_ENV = "/etc/hermes-wolfhouse-luna.env"
LUNA_ENV = "/etc/hermes-luna.env"
WOLFHOUSE_DATA = "/var/lib/hermes-wolfhouse-luna"
LUNA_DATA = "/var/lib/hermes-luna"


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

    caddy_sources = caddy_repo_sources()
    caddy_text = "\n".join(read(p) for p in caddy_sources)

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
