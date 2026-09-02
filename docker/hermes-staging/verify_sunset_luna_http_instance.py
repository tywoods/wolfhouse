#!/usr/bin/env python3
"""Static repo checks for hermes-sunset-luna-http (additive; WhatsApp pinned)."""

from __future__ import annotations

import re
import sys
from pathlib import Path

STAGING = Path(__file__).resolve().parent
REPO = STAGING.parent.parent
SUNSET_COMPOSE = REPO / "docker/hermes-sunset/docker-compose.vm.yml"
BOOTSTRAP = STAGING / "bootstrap.sh"
OVERLAY = STAGING / "99z-wh-vm-post-bootstrap.sh"
SERVER = STAGING / "wolfhouse/luna_http_server.py"
OUTBOUND = STAGING / "wolfhouse/luna_http_outbound.py"
ACA_YAML = STAGING / "sunset-luna-http.aca.yaml.example"
DOCS = REPO / "docs/SUNSET-LUNA-HTTP-RUNTIME.md"
CADDY = STAGING / "lunabox-caddyfile.reference"

SUNSET_LUNA_PIN_START = "  hermes-sunset-luna:\n"
SUNSET_LUNA_COMMAND = "    command: gateway run\n"


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


def extract_role(bootstrap: str, role: str) -> str:
    match = re.search(
        rf'(?:el)?if \[ "\$HERMES_ROLE" = "{re.escape(role)}" \]; then\n(.*?)(?=\nelif |\nelse\n)',
        bootstrap,
        re.S,
    )
    return match.group(1) if match else ""


def main() -> int:
    sunset = SUNSET_COMPOSE.read_text(encoding="utf-8")
    bootstrap = BOOTSTRAP.read_text(encoding="utf-8")
    overlay = OVERLAY.read_text(encoding="utf-8")
    server = SERVER.read_text(encoding="utf-8")
    outbound = OUTBOUND.read_text(encoding="utf-8")
    aca = ACA_YAML.read_text(encoding="utf-8")
    docs = DOCS.read_text(encoding="utf-8")
    caddy = CADDY.read_text(encoding="utf-8") if CADDY.is_file() else ""
    http_role = extract_role(bootstrap, "sunset-luna-http")
    sunset_luna = extract_service(sunset, "hermes-sunset-luna")
    http_svc = extract_service(sunset, "hermes-sunset-luna-http")

    checks = {
        "whatsapp_still_gateway_run": SUNSET_LUNA_COMMAND in sunset_luna
        and "HERMES_ROLE: sunset-luna" in sunset_luna
        and "8092" in sunset_luna,
        "http_service_exists": "hermes-sunset-luna-http:" in sunset,
        "http_profile_gated": "sunset-luna-http" in http_svc and "profiles:" in http_svc,
        "http_not_gateway_run": "command: gateway run" not in http_svc,
        "http_python_server": "luna_http_server.py" in http_svc,
        "http_venv_python": "/opt/hermes/.venv/bin/python" in http_svc,
        "http_localhost_port": '"127.0.0.1:8094:8094"' in http_svc,
        "http_isolated_home": "/var/lib/hermes-sunset-luna-http:/opt/data" in http_svc,
        "http_no_shared_auth": "/var/lib/hermes-shared" not in http_svc,
        "http_no_whatsapp_env": "WHATSAPP_CLOUD" not in http_svc,
        "bootstrap_http_role": '"$HERMES_ROLE" = "sunset-luna-http"' in bootstrap,
        "bootstrap_installs_plugins": "install_luna_plugins" in http_role,
        "bootstrap_installs_soul": "install_sunset_luna_http_soul" in http_role,
        "bootstrap_sol_config": "default: gpt-5.6-sol" in bootstrap
        and "write_sunset_luna_http_config" in bootstrap,
        "bootstrap_no_meta_tokens": "WHATSAPP_CLOUD_ACCESS_TOKEN" not in http_role,
        "bootstrap_isolated_auth": "require_isolated_sunset_luna_http_auth" in bootstrap,
        "overlay_skips_http_relink": "sunset-luna-http" in overlay,
        "server_healthz": "/healthz" in server and "sunset-luna-http" in server,
        "server_inbound": "/v1/inbound" in server or "INBOUND_PATH" in server,
        "server_no_graph_client": "graph.facebook.com" not in server
        and "WHATSAPP_CLOUD" not in server,
        "outbound_staff_only": "guest-reply-draft" in outbound
        and "graph.facebook.com" not in outbound
        and "Meta Graph" in outbound,
        "aca_internal": "external: false" in aca
        and "allowInsecure: false" in aca
        and "targetPort: 8094" in aca
        and "environmentId:" in aca
        and "managedEnvironmentId:" not in aca
        and "\n        command:" not in aca
        and "luna_http_server.py" in aca
        and "gateway run" not in aca,
        "docs_defer_meta_cutover": (
            "Later — Meta WhatsApp cutover" in docs
            and "lunabox.lunafrontdesk.com/whatsapp/webhook" in docs
            and "owns live guests" in docs
        ),
        "caddy_whatsapp_untouched": "/whatsapp" in caddy
        and "8094" not in caddy
        and "luna-http" not in caddy.lower(),
    }

    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        print("FAIL sunset-luna-http instance checks:", ", ".join(failed), file=sys.stderr)
        return 1
    print(
        "PASS sunset-luna-http instance: additive HTTP runtime; "
        "WhatsApp gateway block still owns live guests"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
