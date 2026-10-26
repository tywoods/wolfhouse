#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly POSTGRES_IMAGE='postgres:16.4-alpine@sha256:f5aa7cac1dc299a77761ada5a5cf9c6ef4064bc85c89fed49c587dd2381d6f05'
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly ROOT
OUT_INPUT="${ARTIFACT_DIR:-artifacts/rendered-reply-matrix}"
[[ "$OUT_INPUT" == /* ]] && OUT="$OUT_INPUT" || OUT="$ROOT/$OUT_INPUT"
readonly OUT
readonly SHA="${CANDIDATE_SHA:-}"
readonly DB_NAME="luna_owner_test_cap_${SHA:0:12}"
readonly NAME="cap-${SHA:0:12}-$$"
readonly NETWORK="$NAME" PG="$NAME-pg" STAFF="$NAME-staff" HERMES="$NAME-hermes"
cleaning=0
cleanup() {
  local status=$?
  (( cleaning == 0 )) || return
  cleaning=1
  trap - EXIT INT TERM
  mkdir -p "$OUT/logs"
  local container
  for container in "$STAFF" "$HERMES" "$PG"; do
    docker logs "$container" >"$OUT/logs/$container.log" 2>&1 || true
    docker inspect "$container" >"$OUT/runtime/$container.inspect.json" 2>/dev/null || true
  done
  docker rm -f "$STAFF" "$HERMES" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker run --rm -v "$OUT:/proof" --entrypoint chmod "cap-staff:$SHA" -R a+rX /proof >/dev/null 2>&1 || true
  chmod -R u+rwX,go+rX "$OUT" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT INT TERM
cd "$ROOT"

[[ -n "$SHA" && "$SHA" == "$(git rev-parse HEAD)" ]] || { echo 'BLOCKED: exact candidate SHA mismatch' >&2; exit 2; }
[[ -n "${OPENAI_API_KEY:-}" ]] || { echo 'BLOCKED: OPENAI_API_KEY is required' >&2; exit 2; }
[[ -z "${MODEL_API_KEY:-}" && -z "${ANTHROPIC_API_KEY:-}" ]] || { echo 'BLOCKED: alternate model credential present' >&2; exit 2; }
mkdir -p "$OUT/logs" "$OUT/runtime"
staff_token="$(openssl rand -hex 32)"
simulator_token="$(openssl rand -hex 32)"
trace_token="$(openssl rand -hex 32)"
pg_password="$(openssl rand -hex 24)"
docker network create "$NETWORK" >"$OUT/runtime/network-id.txt"
docker run -d --name "$PG" --network "$NETWORK" --network-alias postgres \
  -e POSTGRES_USER=cap -e POSTGRES_PASSWORD="$pg_password" -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 --health-cmd="pg_isready -U cap -d postgres" \
  --health-interval=2s --health-timeout=2s --health-retries=45 "$POSTGRES_IMAGE" >"$OUT/runtime/postgres-container-id.txt"
for _ in $(seq 1 90); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$PG" 2>/dev/null || true)" == healthy ]] && break
  sleep 1
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$PG")" == healthy ]] || { echo 'BLOCKED: PostgreSQL health timeout' >&2; exit 1; }
pg_port="$(docker port "$PG" 5432/tcp | perl -ne 'print $1 if /^127\.0\.0\.1:(\d+)$/' )"
[[ "$pg_port" =~ ^[0-9]+$ ]] || { echo 'BLOCKED: PostgreSQL is not loopback-published' >&2; exit 1; }
owner_key="$(openssl rand -hex 32)"
owner_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
[[ "$owner_port" =~ ^[0-9]+$ ]] || { echo 'BLOCKED: owner fixture port unavailable' >&2; exit 1; }

docker build --pull=false --label "org.opencontainers.image.revision=$SHA" -t "cap-staff:$SHA" -f Dockerfile . >"$OUT/logs/build-staff.log" 2>&1
docker run --rm --network host -v "$OUT:/proof" \
  -e NODE_ENV=test -e NODE_PATH=/app/node_modules -e LUNA_OWNER_TEST_RUN=true \
  -e LUNA_OWNER_ADMIN_URL="postgres://cap:${pg_password}@127.0.0.1:${pg_port}/postgres" \
  -e LUNA_OWNER_DB="$DB_NAME" -e LUNA_OWNER_PORT="$owner_port" -e LUNA_OWNER_OUTPUT=/proof/owner \
  -e LUNA_OWNER_RECEIPT_ISSUER_KEY="$owner_key" \
  -e WHATSAPP_ENABLED=false -e LUNA_V3_EXTERNAL_SEND_ENABLED=false -e LUNA_V3_STAFF_ALERTS_ENABLED=false \
  "cap-staff:$SHA" node scripts/run-luna-v3-r7-real-owner.js >"$OUT/logs/fresh-owner-fixture.log" 2>&1
docker run --rm -v "$OUT:/proof" --entrypoint chmod "cap-staff:$SHA" -R a+rX /proof
export LUNA_OWNER_RECEIPT_VERIFIER_KEY="$owner_key"
export LUNA_MATRIX_FIXTURE_METADATA="$OUT/owner/matrix-fixture.json"
LUNA_MATRIX_FIXTURE_SHA256="$(sha256sum "$LUNA_MATRIX_FIXTURE_METADATA" | cut -d' ' -f1)"
export LUNA_MATRIX_FIXTURE_SHA256
cp "$OUT/owner/migration-lineage.json" "$OUT/runtime/migration-lineage.json"

docker build --pull=false --label "org.opencontainers.image.revision=$SHA" -t "cap-hermes:$SHA" docker/hermes-luna-v3 >"$OUT/logs/build-hermes.log" 2>&1
docker image inspect "cap-staff:$SHA" "cap-hermes:$SHA" >"$OUT/image-inspect.json"
staff_id="$(docker image inspect -f '{{.Id}}' "cap-staff:$SHA")"
hermes_id="$(docker image inspect -f '{{.Id}}' "cap-hermes:$SHA")"
base_digest="${POSTGRES_IMAGE##*@}"
instruction_hash="$(sha256sum docker/hermes-luna-v3/SOUL.md docker/hermes-luna-v3/instructions/* | sha256sum | cut -d' ' -f1)"
plugin_hash="$(sha256sum docker/hermes-luna-v3/plugins/luna_v3_staff_api/__init__.py | cut -d' ' -f1)"
contract_hash="$(sha256sum docker/hermes-luna-v3/contracts/check_quote_book.schema.json | cut -d' ' -f1)"
printf '{"candidate_sha":"%s","staff_image_id":"%s","hermes_image_id":"%s","postgres_base_digest":"%s","instruction_sha256":"%s","plugin_sha256":"%s","contract_sha256":"%s"}\n' \
  "$SHA" "$staff_id" "$hermes_id" "$base_digest" "$instruction_hash" "$plugin_hash" "$contract_hash" >"$OUT/runtime/pins.json"

docker run -d --name "$STAFF" --network "$NETWORK" --network-alias staff -p 127.0.0.1::3036 \
  -e NODE_ENV=test -e STAFF_QUERY_API_HOST=0.0.0.0 -e STAFF_QUERY_API_PORT=3036 \
  -e STAFF_AUTH_REQUIRED=true -e STAFF_AUTH_HTTPS=false -e LUNA_BOT_INTERNAL_TOKEN="$staff_token" \
  -e LUNA_BOT_CLIENT_SLUG=wolfhouse-somo -e DEFAULT_CLIENT_SLUG=wolfhouse-somo -e LUNA_V3_TEST_WRITES=true \
  -e WOLFHOUSE_DATABASE_URL="postgres://cap:${pg_password}@postgres:5432/$DB_NAME" \
  -e WHATSAPP_ENABLED=false -e LUNA_V3_EXTERNAL_SEND_ENABLED=false -e LUNA_V3_STAFF_ALERTS_ENABLED=false \
  "cap-staff:$SHA" >"$OUT/runtime/staff-container-id.txt"
staff_port="$(docker port "$STAFF" 3036/tcp | perl -ne 'print $1 if /^127\.0\.0\.1:(\d+)$/' )"
[[ "$staff_port" =~ ^[0-9]+$ ]] || { echo 'BLOCKED: Staff is not loopback-published' >&2; exit 1; }
for _ in $(seq 1 120); do curl -fsS "http://127.0.0.1:$staff_port/healthz" >"$OUT/runtime/staff-health.json" 2>/dev/null && break; sleep 1; done
curl -fsS "http://127.0.0.1:$staff_port/healthz" >/dev/null

docker run -d --name "$HERMES" --network "$NETWORK" -p 127.0.0.1::8090 \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" -e HERMES_MODEL_PROVIDER=openai-codex -e HERMES_MODEL=gpt-6.1-sol -e HERMES_REASONING_EFFORT=low -e HERMES_FALLBACK_MODEL= \
  -e API_SERVER_ENABLED=true -e API_SERVER_HOST=0.0.0.0 -e API_SERVER_PORT=8090 -e API_SERVER_KEY="$simulator_token" \
  -e LUNA_V3_AUTHENTIC_HARNESS=1 -e LUNA_V3_HARNESS_TRACE_TOKEN="$trace_token" -e LUNA_V3_HARNESS_TIMEOUT_SECONDS=0.01 \
  -e LUNA_V3_TENANT_ID=wolfhouse-somo -e LUNA_V3_STAFF_API_BASE_URL=http://staff:3036 -e LUNA_V3_STAFF_API_TOKEN="$staff_token" \
  -e LUNA_V3_EXTERNAL_SEND_ENABLED=false -e LUNA_V3_STAFF_ALERTS_ENABLED=false -e WHATSAPP_ENABLED=false \
  -e LUNA_V3_IMAGE_DIGEST="$hermes_id" -e LUNA_V3_BASE_IMAGE_DIGEST="$base_digest" -e LUNA_V3_INSTRUCTION_SHA256="$instruction_hash" \
  -e LUNA_V3_PLUGIN_SHA256="$plugin_hash" -e LUNA_V3_CONTRACT_SHA256="$contract_hash" -e LUNA_V3_CANDIDATE_SHA="$SHA" \
  "cap-hermes:$SHA" >"$OUT/runtime/hermes-container-id.txt"
simulator_port="$(docker port "$HERMES" 8090/tcp | perl -ne 'print $1 if /^127\.0\.0\.1:(\d+)$/' )"
[[ "$simulator_port" =~ ^[0-9]+$ ]] || { echo 'BLOCKED: Hermes is not loopback-published' >&2; exit 1; }
printf -v auth_header 'Authorization: Bearer %s' "$simulator_token"
for _ in $(seq 1 180); do curl -fsS -H "$auth_header" "http://127.0.0.1:$simulator_port/health" >"$OUT/runtime/hermes-health.json" 2>/dev/null && break; sleep 1; done
curl -fsS -H "$auth_header" "http://127.0.0.1:$simulator_port/health" >/dev/null

export LUNA_MATRIX_CANDIDATE_SHA="$SHA" LUNA_MATRIX_SIMULATOR_URL="http://127.0.0.1:$simulator_port" LUNA_MATRIX_SIMULATOR_TOKEN="$simulator_token"
: "${LUNA_MATRIX_FIXTURE_METADATA:?BLOCKED: owner-custodied LUNA_MATRIX_FIXTURE_METADATA is required}"
export LUNA_V3_HARNESS_TRACE_TOKEN="$trace_token" LUNA_MATRIX_OUTPUT="$OUT/matrix"
: "${LUNA_MATRIX_FIXTURE_SHA256:?BLOCKED: owner-supplied LUNA_MATRIX_FIXTURE_SHA256 is required}"
export HERMES_MODEL_PROVIDER=openai-codex HERMES_MODEL=gpt-6.1-sol HERMES_REASONING_EFFORT=low HERMES_FALLBACK_MODEL=
python3 scripts/run-luna-v3-rendered-reply-matrix.py
find "$OUT" -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >"$OUT/SHA256SUMS"
