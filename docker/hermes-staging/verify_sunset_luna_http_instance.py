#!/usr/bin/env python3
"""Static repo checks for hermes-sunset-luna-http (additive; WhatsApp pinned)."""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
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


def exact_chain(aca: str, secret: str, vault_name: str, env_name: str) -> bool:
    secret_block = (
        f"      - name: {secret}\n"
        f"        keyVaultUrl: https://luna-sunset-staging-kv.vault.azure.net/secrets/{vault_name}\n"
        "        identity: <identity-id>"
    )
    env_block = f"          - name: {env_name}\n            secretRef: {secret}"
    return secret_block in aca and env_block in aca


def isolated_auth_harness(bootstrap: str) -> bool:
    match = re.search(r"(require_isolated_sunset_luna_http_auth\(\) \{.*?\n\})", bootstrap, re.S)
    if not match:
        return False
    function = match.group(1)
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        home = root / ".hermes"
        home.mkdir()

        def run() -> int:
            return subprocess.run(
                ["sh", "-c", f"set -eu\n{function}\nrequire_isolated_sunset_luna_http_auth\n"],
                env={"HOME": str(root), "HERMES_HOME": str(home), "PATH": "/usr/bin:/bin"},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
            ).returncode

        missing_rejected = run() != 0
        target = root / "credential"
        target.write_text("{}", encoding="utf-8")
        (home / "auth.json").symlink_to(target)
        symlink_rejected = run() != 0
        (home / "auth.json").unlink()
        (home / "auth.json").write_text("{}", encoding="utf-8")
        (root / ".auth-shared").mkdir()
        (root / ".auth-shared/auth.json").write_text("{}", encoding="utf-8")
        shared_rejected = run() != 0
        (root / ".auth-shared/auth.json").unlink()
        isolated_accepted = run() == 0
    return missing_rejected and symlink_rejected and shared_rejected and isolated_accepted


def main() -> int:
    sunset = SUNSET_COMPOSE.read_text(encoding="utf-8")
    bootstrap = BOOTSTRAP.read_text(encoding="utf-8")
    overlay = OVERLAY.read_text(encoding="utf-8")
    server = SERVER.read_text(encoding="utf-8")
    outbound = OUTBOUND.read_text(encoding="utf-8")
    aca = ACA_YAML.read_text(encoding="utf-8")
    docs = DOCS.read_text(encoding="utf-8")
    caddy = CADDY.read_text(encoding="utf-8") if CADDY.is_file() else ""
    sunset_luna = extract_service(sunset, "hermes-sunset-luna")
    http_svc = extract_service(sunset, "hermes-sunset-luna-http")
    branch_match = re.search(
        r'elif \[ "\$HERMES_ROLE" = "luna" \].*?(?=\nelif \[ "\$HERMES_ROLE" = "sunset-email-luna")',
        bootstrap,
        re.S,
    )
    gateway_branch = branch_match.group(0) if branch_match else ""
    pause_gate = (STAGING / "wolfhouse/pause_gate.py").read_text(encoding="utf-8")
    gateway_patches = (STAGING / "apply_gateway_patches.py").read_text(encoding="utf-8")

    checks = {
        "whatsapp_still_gateway_run": SUNSET_LUNA_COMMAND in sunset_luna
        and "HERMES_ROLE: sunset-luna" in sunset_luna
        and "8092" in sunset_luna,
        "http_service_exists": "hermes-sunset-luna-http:" in sunset,
        "http_profile_gated": "sunset-luna-http" in http_svc and "profiles:" in http_svc,
        "http_reuses_gateway": "command: gateway run" in http_svc,
        "http_reuses_sunset_role": "HERMES_ROLE: sunset-luna" in http_svc,
        "http_localhost_port": '"127.0.0.1:8094:8094"' in http_svc,
        "http_isolated_home": "/var/lib/hermes-sunset-luna-http:/opt/data" in http_svc,
        "http_no_shared_auth": "/var/lib/hermes-shared" not in http_svc,
        "http_isolated_mode": 'SUNSET_LUNA_REQUIRE_ISOLATED_AUTH: "true"' in http_svc,
        "gateway_installs_plugins": "install_luna_plugins" in gateway_branch,
        "gateway_installs_sunset_soul": 'cp "$SUNSET_LUNA_SOUL" "$HERMES_HOME/SOUL.md"' in gateway_branch,
        "gateway_sol": "gpt-5.6-sol" in gateway_branch and "sed -i" in gateway_branch,
        "gateway_applies_existing_patches": "apply_patches" in gateway_branch,
        "isolated_auth_before_setup": (
            "require_isolated_sunset_luna_http_auth" in gateway_branch
            and gateway_branch.index("require_isolated_sunset_luna_http_auth")
            < gateway_branch.index("write_luna_config")
        ),
        "isolated_mode_never_links_shared": 'SUNSET_LUNA_REQUIRE_ISOLATED_AUTH:-}" != "true"' in gateway_branch,
        "isolated_auth_runtime_contract": isolated_auth_harness(bootstrap),
        "aca_internal": "external: false" in aca
        and "allowInsecure: false" in aca
        and "targetPort: 8094" in aca
        and "environmentId:" in aca
        and "managedEnvironmentId:" not in aca
        and "\n        command:" not in aca,
        "aca_reuses_gateway_owner": "\n          - gateway\n          - run\n" in aca
        and "value: sunset-luna" in aca,
        "aca_isolated_mode": "- name: SUNSET_LUNA_REQUIRE_ISOLATED_AUTH\n            value: 'true'" in aca,
        "aca_canonical_phone_chain": exact_chain(
            aca, "whatsapp-cloud-phone-number-id", "sunset-somo-whatsapp-phone-number-id",
            "WHATSAPP_CLOUD_PHONE_NUMBER_ID",
        ),
        "aca_somo_route_chain": exact_chain(
            aca, "sunset-somo-phone-number-id", "sunset-somo-whatsapp-phone-number-id",
            "SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID",
        ),
        "aca_sardinero_route_chain": exact_chain(
            aca, "sunset-sardinero-phone-number-id", "sunset-sardinero-whatsapp-phone-number-id",
            "SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID",
        ),
        "aca_access_token_chain": exact_chain(
            aca, "whatsapp-cloud-access-token", "meta-whatsapp-token",
            "WHATSAPP_CLOUD_ACCESS_TOKEN",
        ),
        "aca_app_secret_chain": exact_chain(
            aca, "whatsapp-cloud-app-secret", "meta-app-secret",
            "WHATSAPP_CLOUD_APP_SECRET",
        ),
        "aca_verify_token_chain": exact_chain(
            aca, "whatsapp-cloud-verify-token", "meta-whatsapp-verify-token",
            "WHATSAPP_CLOUD_VERIFY_TOKEN",
        ),
        "aca_dry_run_chain": exact_chain(
            aca, "whatsapp-dry-run", "whatsapp-dry-run", "WHATSAPP_DRY_RUN",
        ),
        "aca_auto_send_chain": exact_chain(
            aca, "luna-auto-send-enabled", "luna-auto-send-enabled",
            "LUNA_AUTO_SEND_ENABLED",
        ),
        "configured_gateway_pause_gate": (
            "from wolfhouse.pause_gate import whatsapp_outbound_disposition" in gateway_patches
            and "check-guest-automation-gate" in pause_gate
        ),
        "needs_human_advisory_owner": (
            'payload.get("needs_human")' not in pause_gate
            and "Sunset so it does not set ``bot_paused``" in pause_gate
        ),
        "docs_no_cutover": "not deployed or cut over" in docs,
        "caddy_whatsapp_untouched": "/whatsapp" in caddy
        and "8094" not in caddy
        and "luna-http" not in caddy.lower(),
    }

    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        print("FAIL sunset-luna-http instance checks:", ", ".join(failed), file=sys.stderr)
        return 1
    print(
        "PASS sunset-luna-http carry: canonical Sunset gateway owner on staging port 8094"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
