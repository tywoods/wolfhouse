#!/usr/bin/env python3
"""Static repo checks for hermes-sunset-email-luna (MAIL-MVP-007)."""

from __future__ import annotations

import re
import sys
from pathlib import Path

STAGING = Path(__file__).resolve().parent
REPO = STAGING.parent.parent
SUNSET_COMPOSE = REPO / "docker/hermes-sunset/docker-compose.vm.yml"
STAGING_COMPOSE = STAGING / "docker-compose.vm.yml"
BOOTSTRAP = STAGING / "bootstrap.sh"
OVERLAY = STAGING / "99z-wh-vm-post-bootstrap.sh"
SERVER = STAGING / "wolfhouse/email_draft_server.py"

SUNSET_LUNA_PIN = """  hermes-sunset-luna:
    image: ${HERMES_IMAGE:?HERMES_IMAGE must be set to whstagingacr.azurecr.io/wh-hermes-staging:<full-master-sha>}
    container_name: hermes-sunset-luna
    restart: unless-stopped
    command: gateway run
    ports:
      - "8092:8092"
    volumes:
      - /var/lib/hermes-sunset-luna:/opt/data
      - /var/lib/hermes-shared:/opt/data/.auth-shared
      - /opt/wolfhouse/WH/docker/hermes-sunset/SOUL.md:/etc/hermes-sunset/SOUL.md:ro
    environment:
      HERMES_HOME: /opt/data
      HERMES_ROLE: sunset-luna
      LUNA_TENANT_ID: sunset
      LUNA_CLIENT_SLUG: sunset
      LUNA_ALLOWED_LOCATION_IDS: sunset-somo
      # This WhatsApp runtime is bound to Somo; Sardinero will use a separate number/runtime.
      SUNSET_INGRESS_LOCATION_ID: sunset-somo
      GENERIC_TIMEZONE: Europe/Madrid
      WHATSAPP_CLOUD_WEBHOOK_PORT: "8092"
      # Coalesce rapid guest WhatsApp bursts (quiet window) before agent run.
      WHATSAPP_BURST_COALESCE_ENABLED: "true"
      WHATSAPP_BURST_DEBOUNCE_MS: "5000"
      WHATSAPP_BURST_MAX_MESSAGES: "20"
      WHATSAPP_BURST_MAX_CHARS: "8000"
      # Crowsnest AI-usage values, including the token, come only from the
      # protected env_file below. Do not add empty environment entries here:
      # Compose environment values override env_file values.
    env_file:
      - /etc/hermes-sunset-luna.env
"""

WOLFHOUSE_LUNA_PIN = """  hermes-luna:
    image: ${HERMES_IMAGE:?HERMES_IMAGE must be set to whstagingacr.azurecr.io/wh-hermes-staging:<full-master-sha>}
    container_name: hermes-luna
    restart: unless-stopped
    command: gateway run
    ports:
      - "8090:8090"
    volumes:
      - /var/lib/hermes-luna:/opt/data
      - /var/lib/hermes-shared:/opt/data/.auth-shared
      - /opt/wolfhouse/WH/docker/hermes-staging/99z-wh-vm-post-bootstrap.sh:/etc/cont-init.d/99z-wh-vm-post-bootstrap:ro
    environment:
      HERMES_HOME: /opt/data
      HERMES_ROLE: luna
      LUNA_CLIENT_SLUG: wolfhouse-somo
      HERMES_DASHBOARD: "0"
      GENERIC_TIMEZONE: Europe/Madrid
      WOLFHOUSE_STAFF_API_BASE_URL: https://staff-staging.lunafrontdesk.com
    env_file:
      - /etc/hermes-luna.env
"""


def extract_service(compose: str, name: str) -> str:
    lines = compose.splitlines()
    block: list[str] = []
    collecting = False
    for line in lines:
        if re.match(rf"^  {re.escape(name)}:\s*$", line):
            collecting = True
            block = [line]
            continue
        if collecting:
            if re.match(r"^  [A-Za-z0-9_-]+:\s*$", line):
                break
            block.append(line)
    while block and (not block[-1].strip() or block[-1].lstrip().startswith("#")):
        block.pop()
    return "\n".join(block).rstrip() + "\n"


def main() -> int:
    sunset = SUNSET_COMPOSE.read_text(encoding="utf-8")
    staging = STAGING_COMPOSE.read_text(encoding="utf-8")
    bootstrap = BOOTSTRAP.read_text(encoding="utf-8")
    overlay = OVERLAY.read_text(encoding="utf-8")
    server = SERVER.read_text(encoding="utf-8")

    sunset_luna = extract_service(sunset, "hermes-sunset-luna")
    wolfhouse_luna = extract_service(staging, "hermes-luna")
    email = extract_service(sunset, "hermes-sunset-email-luna")

    checks = {
        "sunset_luna_block_unchanged": sunset_luna == SUNSET_LUNA_PIN,
        "wolfhouse_luna_block_unchanged": wolfhouse_luna == WOLFHOUSE_LUNA_PIN,
        "email_service_exists": "hermes-sunset-email-luna:" in sunset,
        "email_role": "HERMES_ROLE: sunset-email-luna" in email,
        "email_isolated_home": "/var/lib/hermes-sunset-email-luna:/opt/data" in email,
        "email_canonical_hermes_home": "HERMES_HOME: /opt/data/.hermes" in email
        and "HOME: /opt/data" in email
        and "HERMES_HOME: /opt/data\n" not in email,
        "email_no_shared_auth": "/var/lib/hermes-shared" not in email,
        "email_localhost_port": '"127.0.0.1:8093:8093"' in email,
        "email_not_staff_path": "Staff API in Azure reaches" in sunset,
        "email_not_gateway_run": "command: gateway run" not in email,
        "email_python_server": "email_draft_server.py" in email,
        "email_venv_python": "/opt/hermes/.venv/bin/python" in email
        and "command: python " not in email,
        "email_profile_gated": "sunset-email-luna" in email,
        "email_no_whatsapp_port": "WHATSAPP_CLOUD" not in email,
        "email_no_discord": "DISCORD" not in email,
        "bootstrap_email_role": '"$HERMES_ROLE" = "sunset-email-luna"' in bootstrap,
        "bootstrap_sol_config": "default: gpt-5.6-sol" in bootstrap
        and "write_sunset_email_luna_config" in bootstrap,
        "bootstrap_no_plugins": "install_luna_plugins" not in extract_role(bootstrap),
        "bootstrap_no_link_shared": "link_shared_auth" not in extract_role(bootstrap),
        "bootstrap_isolated_auth": "require_isolated_sunset_email_auth" in bootstrap
        and "materialize_isolated_sunset_email_auth_from_secret" not in bootstrap
        and "HERMES_SUNSET_EMAIL_AUTH_JSON_B64" not in bootstrap
        and "chmod 0600" in bootstrap
        and "EMAIL_LUNA_HERMES_SOL_RESPONSE_HMAC_SECRET" in bootstrap
        and 'HERMES_HOME="${HOME}/.hermes"' in bootstrap
        and ".hermes/auth.json" in bootstrap,
        "bootstrap_skip_role_for_auth": "HERMES_SKIP_ROLE_BOOTSTRAP" in bootstrap,
        "wolfhouse_still_gpt55": "default: gpt-5.5" in bootstrap,
        "sunset_whatsapp_still_sol_sed": "default: gpt-5.6-sol" in bootstrap
        and "sed -i" in bootstrap,
        "overlay_skips_email_relink": 'HERMES_ROLE" = "sunset-email-luna"' in overlay,
        "server_no_whatsapp_env": "WHATSAPP_CLOUD" not in server,
        "server_no_discord_env": "DISCORD_BOT" not in server,
        "server_no_booking_tool": "create_sunset_booking" not in server,
        "server_live_attempt_provenance": "bind_attempt_provenance" in server
        and "server_provenance" not in server,
        "invoke_not_guessed_cli": "hermes chat --no-stream" not in (STAGING / "wolfhouse/email_draft_invoke.py").read_text(encoding="utf-8"),
        "no_staff_model_flip_in_compose": "LUNA_AI_MODEL=gpt-5.6-sol" not in sunset
        and "LUNA_AI_MODEL=gpt-5.6-sol" not in staging,
        "aca_yaml_internal": "external: false" in (STAGING / "sunset-email-luna.aca.yaml.example").read_text(encoding="utf-8")
        and "allowInsecure: false" in (STAGING / "sunset-email-luna.aca.yaml.example").read_text(encoding="utf-8")
        and "/opt/hermes/.venv/bin/python" in (STAGING / "sunset-email-luna.aca.yaml.example").read_text(encoding="utf-8")
        and "environmentId:" in (STAGING / "sunset-email-luna.aca.yaml.example").read_text(encoding="utf-8")
        and "managedEnvironmentId:" not in (STAGING / "sunset-email-luna.aca.yaml.example").read_text(encoding="utf-8")
        and "storageType: AzureFile" in (STAGING / "sunset-email-luna.aca.yaml.example").read_text(encoding="utf-8")
        and "storageName: hermes-sunset-email-luna-home" in (STAGING / "sunset-email-luna.aca.yaml.example").read_text(encoding="utf-8")
        and "HERMES_SUNSET_EMAIL_AUTH_JSON_B64" not in (STAGING / "sunset-email-luna.aca.yaml.example").read_text(encoding="utf-8")
        and "\n        command:" not in (STAGING / "sunset-email-luna.aca.yaml.example").read_text(encoding="utf-8")
        and "value: /opt/data/.hermes" in (STAGING / "sunset-email-luna.aca.yaml.example").read_text(encoding="utf-8")
        and "- name: HOME" in (STAGING / "sunset-email-luna.aca.yaml.example").read_text(encoding="utf-8"),
        "runbook_https_staff_path": "EMAIL_LUNA_HERMES_SOL_TLS_PIN" in (REPO / "docs/MAIL-MVP-007-SUNSET-EMAIL-SOL-RUNBOOK.md").read_text(encoding="utf-8")
        and "lunabox-reachability-as-operator-directs" not in (REPO / "docs/MAIL-MVP-007-SUNSET-EMAIL-SOL-RUNBOOK.md").read_text(encoding="utf-8")
        and "--command python" not in (REPO / "docs/MAIL-MVP-007-SUNSET-EMAIL-SOL-RUNBOOK.md").read_text(encoding="utf-8")
        and "--bind-env-vars" not in (REPO / "docs/MAIL-MVP-007-SUNSET-EMAIL-SOL-RUNBOOK.md").read_text(encoding="utf-8")
        and "containerapp env storage set" in (REPO / "docs/MAIL-MVP-007-SUNSET-EMAIL-SOL-RUNBOOK.md").read_text(encoding="utf-8")
        and "lunasunsetemailst" in (REPO / "docs/MAIL-MVP-007-SUNSET-EMAIL-SOL-RUNBOOK.md").read_text(encoding="utf-8"),
    }
    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        print("FAIL sunset-email-luna instance checks:", ", ".join(failed), file=sys.stderr)
        if sunset_luna != SUNSET_LUNA_PIN:
            print("--- sunset-luna got ---", file=sys.stderr)
            print(sunset_luna, file=sys.stderr)
        if wolfhouse_luna != WOLFHOUSE_LUNA_PIN:
            print("--- hermes-luna got ---", file=sys.stderr)
            print(wolfhouse_luna, file=sys.stderr)
        return 1
    print("PASS sunset-email-luna instance: isolated draft service; WhatsApp/Wolfhouse blocks pinned")
    return 0


def extract_role(bootstrap: str) -> str:
    match = re.search(
        r'elif \[ "\$HERMES_ROLE" = "sunset-email-luna" \]; then\n(.*?)(?=\nelif |\nelse\n)',
        bootstrap,
        re.S,
    )
    return match.group(1) if match else ""


if __name__ == "__main__":
    raise SystemExit(main())
