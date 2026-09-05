#!/usr/bin/env bash
set -euo pipefail
# Run locally after source verification. Only the dedicated design service is changed.
ROOT=$(cd "$(dirname "$0")" && pwd)
SHA=$(git -C "$ROOT" rev-parse HEAD)
REMOTE="/opt/wolfhouse/design-previews/coastal-$SHA"
ssh -o BatchMode=yes lunabox "test ! -e '$REMOTE'; mkdir -p '$REMOTE'"
scp "$ROOT/index.html" "$ROOT/server.cjs" "lunabox:$REMOTE/"
ssh -o BatchMode=yes lunabox "node --check '$REMOTE/server.cjs'; sha256sum '$REMOTE/index.html' '$REMOTE/server.cjs'"
printf '%s\n' "[Service]" "WorkingDirectory=$REMOTE" "ExecStart=" "ExecStart=/usr/bin/node $REMOTE/server.cjs" "EnvironmentFile=" "NoNewPrivileges=yes" "ProtectSystem=strict" "ProtectHome=yes" "PrivateTmp=yes" > "$ROOT/coastal-preview.conf"
scp "$ROOT/coastal-preview.conf" lunabox:/tmp/sunset-coastal-preview.conf
ssh -o BatchMode=yes lunabox 'set -e; test ! -e /etc/systemd/system/design-sandbox.service.d/coastal-preview.conf; sudo -n mkdir -p /etc/systemd/system/design-sandbox.service.d; sudo -n install -m 0644 /tmp/sunset-coastal-preview.conf /etc/systemd/system/design-sandbox.service.d/coastal-preview.conf; sudo -n systemctl daemon-reload; sudo -n systemctl restart design-sandbox; systemctl is-active design-sandbox'
