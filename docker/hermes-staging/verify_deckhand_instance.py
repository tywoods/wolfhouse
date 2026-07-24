#!/usr/bin/env python3
"""Static repo checks for the isolated hermes-deckhand Discord worker.

Deckhand is a first-class Hermes staging service: separate container, data dir,
env file, Discord identity, and xAI-only model config. It must not share
sessions/profile with Skipper, Luna, or Sunset, and must not touch Sunset files.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

STAGING = Path(__file__).resolve().parent
REPO_ROOT = STAGING.parent.parent if (STAGING.parent.parent / "AGENTS.md").is_file() else STAGING

SERVICE = "hermes-deckhand"
DECKHAND_ENV = "/etc/hermes-deckhand.env"
DECKHAND_DATA = "/var/lib/hermes-deckhand"
ORCH_ENV = "/etc/hermes-orchestrator.env"
ORCH_DATA = "/var/lib/hermes-orchestrator"
LUNA_ENV = "/etc/hermes-luna.env"
LUNA_DATA = "/var/lib/hermes-luna"
SUNSET_ROOT = REPO_ROOT / "docker" / "hermes-sunset"


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


def extract_role_block(bootstrap_text: str, role: str) -> str:
    """Extract the shell `if [ "$HERMES_ROLE" = "<role>" ]` block body."""
    lines = bootstrap_text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if re.search(rf'HERMES_ROLE"\s*=\s*"{re.escape(role)}"', line) or re.search(
            rf"HERMES_ROLE'\s*=\s*'{re.escape(role)}'", line
        ):
            start = i
            break
        if f'HERMES_ROLE" = "{role}"' in line or f"HERMES_ROLE' = '{role}'" in line:
            start = i
            break
        if f'[ "$HERMES_ROLE" = "{role}" ]' in line:
            start = i
            break
    if start is None:
        return ""
    # Collect until a top-level `fi` that closes this if (depth tracking).
    depth = 0
    block: list[str] = []
    for line in lines[start:]:
        block.append(line)
        stripped = line.strip()
        if stripped.startswith("if ") or stripped.startswith("if\t"):
            depth += 1
        elif stripped == "fi":
            depth -= 1
            if depth == 0:
                break
    return "\n".join(block)


def has_ports_mapping(service_block: str) -> bool:
    """True if the service publishes any host/container port mapping."""
    lines = service_block.splitlines()
    in_ports = False
    for line in lines:
        if re.match(r"^    ports:\s*$", line):
            in_ports = True
            continue
        if in_ports:
            if re.match(r"^    [A-Za-z0-9_]+:\s*", line) and not line.strip().startswith("-"):
                break
            if re.match(r"^  [A-Za-z0-9_-]+:\s*$", line):
                break
            if re.search(r"['\"]?\d+:\d+", line):
                return True
            if line.strip().startswith("-") and ":" in line:
                return True
    return False


def extract_heredoc_yaml(role_block: str) -> str:
    """Return the config.yaml heredoc body from a role block (between <<'EOF' and EOF)."""
    lines = role_block.splitlines()
    collecting = False
    body: list[str] = []
    for line in lines:
        if not collecting:
            if "<<'EOF'" in line or '<<"EOF"' in line or re.search(r"<<EOF\b", line):
                collecting = True
            continue
        if line.strip() == "EOF":
            break
        body.append(line)
    return "\n".join(body)


def main() -> int:
    compose_path = STAGING / "docker-compose.vm.yml"
    overlay_path = STAGING / "99z-wh-vm-post-bootstrap.sh"
    deploy_path = REPO_ROOT / "scripts" / "deploy-staging-hermes-vm.js"
    docs_path = REPO_ROOT / "docs" / "HERMES-AZURE-VM.md"
    sunset_compose = SUNSET_ROOT / "docker-compose.vm.yml"

    for path in (compose_path, overlay_path, deploy_path, docs_path):
        if not path.is_file():
            print(f"FAIL: missing {path}", file=sys.stderr)
            return 1

    compose = read(compose_path)
    overlay = read(overlay_path)
    deploy = read(deploy_path)
    docs = read(docs_path)
    deckhand = extract_service_block(compose, SERVICE)
    deckhand_role = extract_role_block(overlay, "deckhand")
    deckhand_yaml = extract_heredoc_yaml(deckhand_role)
    orch_role = extract_role_block(overlay, "orchestrator")
    seadog_role = extract_role_block(overlay, "seadog")

    # Snapshot sunset compose: Deckhand must not live there.
    sunset_mentions_deckhand = False
    if sunset_compose.is_file():
        sunset_mentions_deckhand = "deckhand" in read(sunset_compose).lower()

    checks = {
        "compose_service_exists": f"  {SERVICE}:" in compose and bool(deckhand),
        "compose_container_name": "container_name: hermes-deckhand" in deckhand,
        "compose_command_gateway_run": re.search(
            r"command:\s*gateway run\b", deckhand
        ) is not None,
        "compose_hermes_role_deckhand": re.search(
            r"HERMES_ROLE:\s*deckhand\b", deckhand
        ) is not None,
        "compose_env_file_deckhand": DECKHAND_ENV in deckhand,
        "compose_env_file_not_orchestrator": ORCH_ENV not in deckhand,
        "compose_env_file_not_luna": LUNA_ENV not in deckhand,
        "compose_data_path_deckhand": DECKHAND_DATA in deckhand,
        "compose_not_mount_orch_home": ORCH_DATA not in deckhand,
        "compose_not_mount_luna_home": LUNA_DATA not in deckhand,
        "compose_no_inbound_ports": bool(deckhand) and not has_ports_mapping(deckhand),
        "compose_shared_auth_mount": "/var/lib/hermes-shared:/opt/data/.auth-shared" in deckhand,
        "compose_repo_ro_mount": "/opt/wolfhouse/WH:/opt/wolfhouse/WH:ro" in deckhand,
        "compose_overlay_ro_mount": (
            "99z-wh-vm-post-bootstrap.sh:/etc/cont-init.d/99z-wh-vm-post-bootstrap:ro"
            in deckhand
        ),
        "compose_timezone_madrid": "GENERIC_TIMEZONE: Europe/Madrid" in deckhand,
        "compose_staff_api_staging": (
            "WOLFHOUSE_STAFF_API_BASE_URL: https://staff-staging.lunafrontdesk.com"
            in deckhand
        ),
        "compose_luna_8090_unchanged": '"8090:8090"' in compose,
        "compose_wolfhouse_luna_8091_unchanged": '"8091:8091"' in compose,
        "overlay_deckhand_role_exists": bool(deckhand_role),
        "overlay_model_grok_45": re.search(
            r"default:\s*grok-4\.5\b", deckhand_yaml
        ) is not None,
        "overlay_provider_xai": re.search(r"provider:\s*xai\b", deckhand_yaml) is not None,
        "overlay_no_anthropic_in_deckhand": "anthropic" not in deckhand_yaml.lower(),
        "overlay_no_openai_fallback_in_deckhand": (
            "openai" not in deckhand_yaml.lower()
            and "fallback_providers" not in deckhand_yaml
        ),
        "overlay_cwd_created": bool(
            re.search(
                r'mkdir\s+-p\b[^\n]*sandbox-repos/WH-deckhand',
                deckhand_role,
            )
        ),
        "overlay_orchestrator_untouched": (
            "openai-codex" in orch_role or "gpt-5" in orch_role
        ) and "xai" not in orch_role.lower(),
        "overlay_seadog_untouched": (
            "openai-codex" in seadog_role or "gpt-5" in seadog_role
        ) and "xai" not in seadog_role.lower(),
        "deploy_writes_deckhand_env": (
            "hermes-deckhand.env" in deploy
            and (
                "discord-deckhand-bot-token" in deploy
                or "DISCORD_DECKHAND_BOT_TOKEN" in deploy
            )
            and ("xai-api-key" in deploy or "XAI_API_KEY" in deploy)
        ),
        "deploy_never_reuses_skipper_discord_kv": (
            "discord-deckhand-bot-token" in deploy
            and not re.search(
                r"deckhand[\s\S]{0,200}kvSecret\(\s*['\"]discord-bot-token['\"]\s*\)",
                deploy,
                re.IGNORECASE,
            )
        ),
        "docs_mention_deckhand_isolation": (
            "hermes-deckhand" in docs
            and "Deckhand" in docs
            and "must not" in docs.lower()
            and "WhatsApp" in docs
        ),
        "sunset_compose_has_no_deckhand": not sunset_mentions_deckhand,
        "no_deckhand_under_sunset_tree": not any(
            "deckhand" in p.name.lower()
            for p in SUNSET_ROOT.rglob("*")
            if p.is_file()
        ) if SUNSET_ROOT.is_dir() else True,
    }

    print(json.dumps(checks, indent=2))
    if all(checks.values()):
        print("ALL OK")
        return 0

    print("FAIL: hermes-deckhand isolation contract", file=sys.stderr)
    for name, ok in checks.items():
        if not ok:
            print(f"FAIL: {name}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
