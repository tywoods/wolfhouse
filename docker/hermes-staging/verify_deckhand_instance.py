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
    """Extract one HERMES_ROLE arm (`if`/`elif`) until the next peer branch or closing `fi`."""
    lines = bootstrap_text.splitlines()
    start = None
    for i, line in enumerate(lines):
        if f'[ "$HERMES_ROLE" = "{role}" ]' in line or f"[ '$HERMES_ROLE' = '{role}' ]" in line:
            start = i
            break
    if start is None:
        return ""
    block: list[str] = []
    depth = 0
    started = False
    for line in lines[start:]:
        stripped = line.strip()
        if not started:
            block.append(line)
            depth = 1
            started = True
            continue
        if stripped.startswith("if ") or stripped.startswith("if\t"):
            depth += 1
            block.append(line)
            continue
        if stripped.startswith("elif ") or stripped == "else" or stripped.startswith("else;"):
            if depth == 1:
                break
            block.append(line)
            continue
        if stripped == "fi":
            depth -= 1
            if depth == 0:
                break
            block.append(line)
            continue
        block.append(line)
    return "\n".join(block)


def extract_function_body(script: str, func_name: str) -> str:
    """Extract a POSIX `name() { ... }` function body (best-effort brace match)."""
    marker = f"{func_name}()"
    start = script.find(marker)
    if start < 0:
        return ""
    brace = script.find("{", start)
    if brace < 0:
        return ""
    depth = 0
    for i in range(brace, len(script)):
        ch = script[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return script[brace + 1 : i]
    return ""


def luna_guest_calls_in(block: str) -> bool:
    return any(
        token in block
        for token in (
            "write_luna_config",
            "write_luna_env",
            "install_luna_plugins",
            "apply_patches",
            "STAGING_LUNA_SOUL",
            "WHATSAPP_CLOUD_",
            "LUNA_BOT_INTERNAL_TOKEN",
        )
    )


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


def discord_platform_enabled(yaml_text: str) -> bool:
    """True when gateway.platforms.discord explicitly sets enabled: true."""
    return bool(
        re.search(
            r"gateway:\s*\n"
            r"(?:[ \t]+.*\n)*?"
            r"[ \t]+platforms:\s*\n"
            r"(?:[ \t]+.*\n)*?"
            r"[ \t]+discord:\s*\n"
            r"(?:[ \t]+.*\n)*?"
            r"[ \t]+enabled:\s*true\b",
            yaml_text,
            re.MULTILINE,
        )
    )


def has_whatsapp_config(yaml_text: str) -> bool:
    return bool(re.search(r"whatsapp", yaml_text, re.IGNORECASE))



def main() -> int:
    compose_path = STAGING / "docker-compose.vm.yml"
    overlay_path = STAGING / "99z-wh-vm-post-bootstrap.sh"
    bootstrap_path = STAGING / "bootstrap.sh"
    dockerfile_path = STAGING / "Dockerfile"
    soul_path = STAGING / "deckhand-SOUL.md"
    deploy_path = REPO_ROOT / "scripts" / "deploy-staging-hermes-vm.js"
    docs_path = REPO_ROOT / "docs" / "HERMES-AZURE-VM.md"
    sunset_compose = SUNSET_ROOT / "docker-compose.vm.yml"

    for path in (compose_path, overlay_path, bootstrap_path, deploy_path, docs_path):
        if not path.is_file():
            print(f"FAIL: missing {path}", file=sys.stderr)
            return 1

    compose = read(compose_path)
    overlay = read(overlay_path)
    bootstrap = read(bootstrap_path)
    dockerfile = read(dockerfile_path) if dockerfile_path.is_file() else ""
    deploy = read(deploy_path)
    docs = read(docs_path)
    deckhand = extract_service_block(compose, SERVICE)
    deckhand_role = extract_role_block(overlay, "deckhand")
    deckhand_yaml = extract_heredoc_yaml(deckhand_role)
    bootstrap_deckhand = extract_role_block(bootstrap, "deckhand")
    deckhand_fn = extract_function_body(bootstrap, "write_deckhand_config")
    bootstrap_deckhand_yaml = extract_heredoc_yaml(deckhand_fn)
    orch_role = extract_role_block(overlay, "orchestrator")
    seadog_role = extract_role_block(overlay, "seadog")

    # Snapshot sunset compose: Deckhand must not live there.
    sunset_mentions_deckhand = False
    if sunset_compose.is_file():
        sunset_mentions_deckhand = "deckhand" in read(sunset_compose).lower()

    # Unsafe legacy pattern: orchestrator if/else where the else always runs Luna.
    unsafe_else_luna = bool(
        re.search(
            r'if \[ "\$HERMES_ROLE" = "orchestrator" \]; then'
            r'[\s\S]*?\nelse\n'
            r'[\s\S]*?write_luna_config',
            bootstrap,
        )
    )

    soul_text = read(soul_path) if soul_path.is_file() else ""

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
        "overlay_model_grok_46": re.search(
            r"default:\s*grok-4\.6\b", deckhand_yaml
        ) is not None,
        "overlay_provider_xai_oauth": re.search(
            r"provider:\s*xai-oauth\b", deckhand_yaml
        ) is not None,
        "overlay_xai_reserved_tool_search_disabled_in_both_variants": (
            deckhand_role.count("tool_search:") == 2
            and deckhand_role.count("enabled: off") == 2
        ),
        # Scan the whole role arm (both A2A on/off heredocs), not just the first EOF body.
        "overlay_provider_not_api_key_xai": re.search(
            r"(?m)^\s*provider:\s*xai\s*$", deckhand_role
        ) is None,
        "overlay_discord_explicitly_enabled": discord_platform_enabled(deckhand_yaml),
        "overlay_no_whatsapp_config": not has_whatsapp_config(deckhand_yaml),
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
            and "kvSecret('xai-api-key')" not in deploy
            and "kvSecret(\"xai-api-key\")" not in deploy
            and not re.search(
                r"resolveDeckhandSecrets[\s\S]*?XAI_API_KEY\s*:",
                deploy,
            )
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
        "docs_deckhand_bypasses_luna_bootstrap": (
            "bypass" in docs.lower()
            and "luna guest bootstrap" in docs.lower()
            and "cannot be used as a WhatsApp runtime" in docs
        ),
        "docs_deckhand_uses_xai_oauth": (
            "xai-oauth" in docs
            and re.search(
                r"Deckhand[\s\S]{0,1200}shared.*auth\.json|Deckhand[\s\S]{0,1200}xai-oauth",
                docs,
                re.IGNORECASE,
            )
            is not None
            and "xai-api-key" not in docs.lower()
        ),
        "sunset_compose_has_no_deckhand": not sunset_mentions_deckhand,
        "no_deckhand_under_sunset_tree": not any(
            "deckhand" in p.name.lower()
            for p in SUNSET_ROOT.rglob("*")
            if p.is_file()
        ) if SUNSET_ROOT.is_dir() else True,
        # --- Bootstrap role-dispatch hardening ---
        "bootstrap_explicit_deckhand_role": bool(bootstrap_deckhand),
        "bootstrap_no_unsafe_orchestrator_else_luna": not unsafe_else_luna,
        "bootstrap_deckhand_bypasses_luna_guest_path": (
            bool(bootstrap_deckhand) and not luna_guest_calls_in(bootstrap_deckhand)
        ),
        "bootstrap_deckhand_model_xai_oauth_grok": (
            re.search(r"default:\s*grok-4\.6\b", bootstrap_deckhand_yaml) is not None
            and re.search(r"provider:\s*xai-oauth\b", bootstrap_deckhand_yaml) is not None
            and re.search(r"(?m)^\s*provider:\s*xai\s*$", deckhand_fn) is None
            and "fallback_providers" not in bootstrap_deckhand_yaml
            and "anthropic" not in bootstrap_deckhand_yaml.lower()
            and "openai" not in bootstrap_deckhand_yaml.lower()
            and "whatsapp" not in bootstrap_deckhand_yaml.lower()
        ),
        "bootstrap_deckhand_links_shared_auth": (
            "link_shared_auth" in bootstrap_deckhand
            and not re.search(r"(?m)^\s*[^#\n]*XAI_API_KEY", bootstrap_deckhand)
            and "No link_shared_auth" not in bootstrap_deckhand
        ),
        "bootstrap_deckhand_discord_explicitly_enabled": discord_platform_enabled(
            bootstrap_deckhand_yaml
        ),
        "bootstrap_deckhand_env_no_whatsapp_or_luna_guest": (
            "write_deckhand_env" in bootstrap
            and "WHATSAPP_CLOUD_" not in bootstrap_deckhand
            and "LUNA_BOT_INTERNAL_TOKEN" not in bootstrap_deckhand
            and "write_luna_env" not in bootstrap_deckhand
        ),
        "bootstrap_deckhand_env_no_xai_api_key": (
            "write_deckhand_env" in bootstrap
            and "XAI_API_KEY" not in extract_function_body(bootstrap, "write_deckhand_env")
        ),
        "bootstrap_deckhand_uses_deckhand_soul": (
            (
                "deckhand-SOUL.md" in bootstrap_deckhand
                or "STAGING_DECKHAND_SOUL" in bootstrap_deckhand
            )
            and "STAGING_LUNA_SOUL" not in bootstrap_deckhand
        ),
        "bootstrap_deckhand_no_luna_plugins_or_patches": (
            "install_luna_plugins" not in bootstrap_deckhand
            and "apply_patches" not in bootstrap_deckhand
        ),
        "bootstrap_luna_roles_still_use_luna_path": (
            "write_luna_config" in bootstrap
            and "write_luna_env" in bootstrap
            and "install_luna_plugins" in bootstrap
            and "apply_patches" in bootstrap
            and re.search(
                r'\$HERMES_ROLE" = "luna"|\$HERMES_ROLE" = "sunset-luna"|\$HERMES_ROLE" = "seadog"',
                bootstrap,
            )
            is not None
            and re.search(
                r'\$HERMES_ROLE" = "luna"|\$HERMES_ROLE" = "sunset-luna"|\$HERMES_ROLE" = "seadog"',
                bootstrap,
            )
            is not None
            # All three guest/discord-legacy roles must still reach Luna setup.
            and all(
                f'$HERMES_ROLE" = "{role}"' in bootstrap
                for role in ("luna", "sunset-luna", "seadog")
            )
        ),
        "bootstrap_unknown_roles_fail_closed": bool(
            re.search(
                r'unsupported HERMES_ROLE|unknown HERMES_ROLE|Unknown HERMES_ROLE',
                bootstrap,
                re.IGNORECASE,
            )
        )
        and bool(re.search(r"exit 1", bootstrap)),
        "deckhand_soul_file_exists": soul_path.is_file() and len(soul_text.strip()) > 40,
        "deckhand_soul_role_clarity": (
            "engineering" in soul_text.lower()
            and "Discord" in soul_text
            and "WhatsApp" in soul_text
            and ("never" in soul_text.lower() or "must not" in soul_text.lower())
            and "AGENTS.md" in soul_text
            and "receptionist" in soul_text.lower()
        ),
        "dockerfile_copies_deckhand_soul": "deckhand-SOUL.md" in dockerfile,
        "dockerfile_copies_verify_deckhand": "verify_deckhand_instance.py" in dockerfile,
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
