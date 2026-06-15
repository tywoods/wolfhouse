#!/usr/bin/env bash
# First-boot setup for Lunabox (Ubuntu 22.04).
# Run as root on the VM after Azure creates it.
set -euo pipefail

REPO_PATH="${REPO_PATH:-/opt/wolfhouse/WH}"
DATA_ORCH="${DATA_ORCH:-/var/lib/hermes-orchestrator}"
DATA_LUNA="${DATA_LUNA:-/var/lib/hermes-luna}"
DATA_SHARED="${DATA_SHARED:-/var/lib/hermes-shared}"
IMAGE="${IMAGE:-whstagingacr.azurecr.io/wh-hermes-staging:latest}"

echo "[provision] installing base packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git gnupg apt-transport-https

echo "[provision] installing docker + compose plugin..."
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin

echo "[provision] installing Caddy (optional TLS)..."
if ! apt-get install -y -qq caddy 2>/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy || echo "WARN: Caddy install failed — use IP-only HTTP for week 1" >&2
fi

echo "[provision] data directories..."
mkdir -p "$DATA_ORCH" "$DATA_LUNA" "$DATA_SHARED"
touch "$DATA_SHARED/auth.json"
# The Hermes container user (uid 10000) owns each bind-mounted HERMES_HOME so it
# can write sessions.json, config.yaml, and the shared auth pool's temp files.
# (Previously only DATA_SHARED was chowned; DATA_LUNA/DATA_ORCH stayed root-owned,
# so the guest agent hit "Permission denied: /opt/data/sessions/sessions.json".)
chown -R 10000:10000 "$DATA_ORCH" "$DATA_LUNA" "$DATA_SHARED"
chmod 750 "$DATA_SHARED"
chmod 600 "$DATA_SHARED/auth.json"

if [ ! -d "$REPO_PATH/.git" ]; then
  echo "[provision] clone Wolfhouse repo to $REPO_PATH (set GIT_REPO_URL if not using default)..."
  mkdir -p "$(dirname "$REPO_PATH")"
  GIT_REPO_URL="${GIT_REPO_URL:-https://github.com/wolfhouse-somo/WH.git}"
  git clone "$GIT_REPO_URL" "$REPO_PATH" || {
    echo "WARN: git clone failed — copy repo manually to $REPO_PATH" >&2
  }
fi

echo "[provision] placeholder env files (fill from Key Vault / deploy script)..."
touch /etc/hermes-orchestrator.env /etc/hermes-luna.env
chmod 600 /etc/hermes-orchestrator.env /etc/hermes-luna.env

echo "[provision] Caddy snippet (edit hostname + enable after DNS)..."
if [ -d /etc/caddy ]; then
  cat > /etc/caddy/hermes-staging.caddy <<'CADDY'
# lunabox.lunafrontdesk.com {
#   reverse_proxy /whatsapp/* localhost:8090
#   reverse_proxy localhost:8642
# }
CADDY
  if [ -f /etc/caddy/caddyfile ] && ! grep -q hermes-staging.caddy /etc/caddy/caddyfile; then
    echo 'import hermes-staging.caddy' >> /etc/caddy/caddyfile
  fi
fi
systemctl enable --now docker
systemctl enable caddy 2>/dev/null || true
systemctl start caddy 2>/dev/null || true

echo "[provision] done."
echo "Next:"
echo "  1. docker pull $IMAGE"
echo "  2. Fill /etc/hermes-orchestrator.env and /etc/hermes-luna.env"
echo "  3. OAuth (shared auth.json):"
echo "     docker run --rm -it -v $DATA_SHARED/auth.json:/opt/data/auth.json $IMAGE hermes auth add openai-codex"
echo "     docker run --rm -it -v $DATA_SHARED/auth.json:/opt/data/auth.json $IMAGE hermes auth add anthropic --type oauth"
echo "  4. docker compose -f $REPO_PATH/docker/hermes-staging/docker-compose.vm.yml up -d"
