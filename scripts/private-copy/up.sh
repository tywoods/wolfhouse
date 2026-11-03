#!/usr/bin/env bash
# France Wolfhouse staging private-copy launcher. Run on the France host only.
set -euo pipefail

fail() { printf 'private-copy: %s\n' "$*" >&2; exit 1; }
need_root() { [ "${EUID:-$(id -u)}" -eq 0 ] || fail 'run with sudo bash'; }
need_bin() { command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"; }

# Remove inherited outbound supervisor settings by *name*, without ever printing
# their values. The copy gets its own non-live environment label below.
sanitize_copy_env() {
  local file="$1"
  local cleaned="${file}.clean"
  awk -F= '
    $1 !~ /^(SUPERVISOR_EVENTS_ENABLED|LUNA_SUPERVISOR_EVENTS_ENABLED|SUPERVISOR_HALT|SUPERVISOR_WEBHOOK_URL|SUPERVISOR_WEBHOOK_KEY|SUPERVISOR_WEBHOOK_SECRET|SUPERVISOR_WEBHOOK_SIGNING|SUPERVISOR_EVENT_SOURCE_ENVIRONMENT|WHATSAPP_DRY_RUN)$/ { print }
  ' "$file" >"$cleaned"
  cat >>"$cleaned" <<EOF
SUPERVISOR_EVENTS_ENABLED=0
LUNA_SUPERVISOR_EVENTS_ENABLED=false
SUPERVISOR_HALT=1
SUPERVISOR_EVENT_SOURCE_ENVIRONMENT=${COPY_ENVIRONMENT}
WHATSAPP_DRY_RUN=true
EOF
  mv "$cleaned" "$file"
}

# Inspect only environment-variable names. Values, including inherited secrets,
# are never emitted to stdout/stderr by this helper.
assert_private_runtime_env_names() {
  local container="$1"
  local names
  names="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" | cut -d= -f1)"
  for required in SUPERVISOR_EVENTS_ENABLED LUNA_SUPERVISOR_EVENTS_ENABLED SUPERVISOR_HALT SUPERVISOR_EVENT_SOURCE_ENVIRONMENT WHATSAPP_DRY_RUN; do
    printf '%s\n' "$names" | grep -Fxq "$required" || fail "private runtime missing required env name: $required"
  done
  for forbidden in SUPERVISOR_WEBHOOK_URL SUPERVISOR_WEBHOOK_KEY SUPERVISOR_WEBHOOK_SECRET SUPERVISOR_WEBHOOK_SIGNING; do
    ! printf '%s\n' "$names" | grep -Fxq "$forbidden" || fail "private runtime retains forbidden live env name: $forbidden"
  done
}

need_root
need_bin docker
need_bin date
need_bin git

SHA="${1:-}"
[ "$#" -eq 1 ] || fail 'usage: sudo bash up.sh <full-or-short-git-sha>'
printf '%s' "$SHA" | grep -Eq '^[0-9a-fA-F]{7,64}$' || fail 'sha must be 7-64 hexadecimal characters'
REQUESTED_SHA="$(printf '%s' "$SHA" | tr 'A-F' 'a-f')"
SHA="$(git rev-parse --verify "${REQUESTED_SHA}^{commit}" 2>/dev/null)" || fail 'sha does not resolve to a commit in this checkout'
HEAD_SHA="$(git rev-parse HEAD)"
[ "$HEAD_SHA" = "$SHA" ] || fail 'checkout HEAD must exactly equal the requested sha before building'
git diff --quiet && git diff --cached --quiet && [ -z "$(git status --porcelain --untracked-files=all)" ] || fail 'refusing to build from a dirty checkout'
SHA8="${SHA:0:8}"
TAG="${PRIVATE_COPY_TAG:-private}"
printf '%s' "$TAG" | grep -Eq '^[a-z0-9][a-z0-9-]{0,20}$' || fail 'PRIVATE_COPY_TAG must be lowercase letters, digits, or hyphens'
DATE_UTC="$(date -u +%Y%m%d)"
COPY_ENVIRONMENT="wolfhouse-france-staging-${TAG}-${SHA8}-${DATE_UTC}"
printf '%s' "$COPY_ENVIRONMENT" | grep -Eq '^wolfhouse-france-staging-[a-z0-9-]+-[0-9a-f]{8}-[0-9]{8}$' || fail 'generated private environment label is invalid'
DB_NAME="wolfhouse_c${TAG}_${SHA8}_${DATE_UTC}"
printf '%s' "$DB_NAME" | grep -Eq '^wolfhouse_c[a-z0-9-]+_[0-9a-f]{8}_[0-9]{8}$' || fail 'generated database name is not an approved throwaway name'

# These are the exact France staging runtime identities. Do not accept caller
# overrides: a typo must fail rather than selecting a production container.
SOURCE_STAFF_CONTAINER='ovh-wolfhouse-staff'
SOURCE_LUNA_CONTAINER='hermes-luna'
STAFF_CONTAINER="wolfhouse-private-staff-${TAG}-${SHA8}-${DATE_UTC}"
LUNA_CONTAINER="wolfhouse-private-luna-${TAG}-${SHA8}-${DATE_UTC}"
NETWORK="wolfhouse-private-net-${TAG}-${SHA8}-${DATE_UTC}"
STAFF_PORT="${PRIVATE_COPY_STAFF_PORT:-13036}"
LUNA_PORT="${PRIVATE_COPY_LUNA_PORT:-18090}"
printf '%s\n' "$STAFF_PORT" "$LUNA_PORT" | grep -Eq '^[0-9]{2,5}$' || fail 'private ports must be numeric'
[ "$STAFF_PORT" != "$LUNA_PORT" ] || fail 'private Staff and Luna ports must differ'

# Never derive credentials from the shell or print them. The staging Staff
# container is the sole source of its staging-only database URL.
docker container inspect "$SOURCE_STAFF_CONTAINER" >/dev/null 2>&1 || fail "required France staging Staff container is absent: $SOURCE_STAFF_CONTAINER"
docker container inspect "$SOURCE_LUNA_CONTAINER" >/dev/null 2>&1 || fail "required France staging Luna container is absent: $SOURCE_LUNA_CONTAINER"
SOURCE_DB_URL="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$SOURCE_STAFF_CONTAINER" | sed -n 's/^WOLFHOUSE_DATABASE_URL=//p' | head -n 1)"
[ -n "$SOURCE_DB_URL" ] || fail 'France staging Staff has no WOLFHOUSE_DATABASE_URL'
SOURCE_DB_LOWER="$(printf '%s' "$SOURCE_DB_URL" | tr '[:upper:]' '[:lower:]')"
printf '%s' "$SOURCE_DB_LOWER" | grep -Eq '(prod|production|wolfhouse-prod-|wh\.lunafrontdesk\.com)' && fail 'refusing a source database that looks like production'
printf '%s' "$SOURCE_DB_LOWER" | grep -Eq 'postgres(ql)?://' || fail 'source database URL is not PostgreSQL'

for name in "$STAFF_CONTAINER" "$LUNA_CONTAINER" "$NETWORK"; do
  docker inspect "$name" >/dev/null 2>&1 && fail "refusing existing private-copy resource: $name"
done
for port in "$STAFF_PORT" "$LUNA_PORT"; do
  docker ps --format '{{.Ports}}' | grep -Eq "(^|,)0\.0\.0\.0:${port}->|(^|,)127\.0\.0\.1:${port}->|(^|,)\[::\]:${port}->" && fail "port already in use: $port"
done

# A PostgreSQL URI has exactly one database path component here. Preserve query
# options (TLS settings) while replacing only that database with the checked name.
SOURCE_NO_QUERY="${SOURCE_DB_URL%%\?*}"
SOURCE_QUERY=""
case "$SOURCE_DB_URL" in *\?*) SOURCE_QUERY="?${SOURCE_DB_URL#*\?}" ;; esac
SOURCE_BASE="${SOURCE_NO_QUERY%/*}"
[ "$SOURCE_BASE" != "$SOURCE_NO_QUERY" ] && [ -n "$SOURCE_BASE" ] || fail 'source database URL has no database path'
TARGET_DB_URL="${SOURCE_BASE}/${DB_NAME}${SOURCE_QUERY}"
TARGET_DB_LOWER="$(printf '%s' "$TARGET_DB_URL" | tr '[:upper:]' '[:lower:]')"
printf '%s' "$TARGET_DB_LOWER" | grep -Eq '(^|/)wolfhouse_c[a-z0-9-]+_[0-9a-f]{8}_[0-9]{8}(\?|$)' || fail 'target database is not an approved throwaway name'
printf '%s' "$TARGET_DB_LOWER" | grep -Eq '(prod|production|wolfhouse-prod-|wh\.lunafrontdesk\.com)' && fail 'refusing target URL that looks like production'

PG_IMAGE="${PRIVATE_COPY_POSTGRES_IMAGE:-postgres:16-alpine}"
WORKDIR="$(mktemp -d /tmp/wolfhouse-private-copy.XXXXXX)"
STAFF_ENV="$WORKDIR/staff.env"
LUNA_ENV="$WORKDIR/luna.env"
DUMP_FILE="$WORKDIR/staging.dump"
cleanup_failure() {
  status=$?
  rm -f "$STAFF_ENV" "$LUNA_ENV" "${STAFF_ENV}.clean" "${LUNA_ENV}.clean" "$DUMP_FILE"
  rmdir "$WORKDIR" 2>/dev/null || true
  exit "$status"
}
trap cleanup_failure EXIT
umask 077

# Copy runtime environment without showing it. Override database and outbound
# flags explicitly when starting the private containers below.
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$SOURCE_STAFF_CONTAINER" >"$STAFF_ENV"
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$SOURCE_LUNA_CONTAINER" >"$LUNA_ENV"
sanitize_copy_env "$STAFF_ENV"
sanitize_copy_env "$LUNA_ENV"
chmod 600 "$STAFF_ENV" "$LUNA_ENV"

pg() { docker run --rm --network host -v "$WORKDIR:/work:rw" "$PG_IMAGE" "$@"; }

printf 'private-copy: dumping France Wolfhouse staging database to a temporary archive...\n'
pg pg_dump --format=custom --no-owner --no-privileges --file /work/staging.dump "$SOURCE_DB_URL"
[ -s "$DUMP_FILE" ] || fail 'pg_dump produced no archive'

printf 'private-copy: creating throwaway database %s...\n' "$DB_NAME"
pg psql "$SOURCE_DB_URL" --set ON_ERROR_STOP=1 --command "CREATE DATABASE \"$DB_NAME\""

printf 'private-copy: restoring archive (pg_restore errors are fatal)...\n'
pg pg_restore --exit-on-error --no-owner --no-privileges --dbname "$TARGET_DB_URL" /work/staging.dump

# Count the exact key tables. A missing table is an error rather than silently
# skipping proof, because that would make a partial restore look complete.
COUNT_SQL="SELECT 'guests=' || count(*) FROM guests UNION ALL SELECT 'clients=' || count(*) FROM clients UNION ALL SELECT 'customers=' || count(*) FROM customers UNION ALL SELECT 'bookings=' || count(*) FROM bookings UNION ALL SELECT 'conversations=' || count(*) FROM conversations UNION ALL SELECT 'booking_conversation_links=' || count(*) FROM booking_conversation_links UNION ALL SELECT 'rooms=' || count(*) FROM rooms ORDER BY 1;"
SOURCE_COUNTS="$(pg psql "$SOURCE_DB_URL" --tuples-only --no-align --set ON_ERROR_STOP=1 --command "$COUNT_SQL")"
TARGET_COUNTS="$(pg psql "$TARGET_DB_URL" --tuples-only --no-align --set ON_ERROR_STOP=1 --command "$COUNT_SQL")"
[ -n "$SOURCE_COUNTS" ] || fail 'completeness check produced no staging counts'
[ "$SOURCE_COUNTS" = "$TARGET_COUNTS" ] || fail "restored key-table row counts differ from staging; refusing private containers"
printf 'private-copy: completeness counts match (%s).\n' "$(printf '%s' "$SOURCE_COUNTS" | tr '\n' ' ')"

printf 'private-copy: building private images for %s...\n' "$SHA"
docker build --tag "wh-hermes-staging-private:${SHA}" --file docker/hermes-staging/Dockerfile docker/hermes-staging
docker build --tag "wh-staff-api-private:${SHA}" --file Dockerfile .

docker network create "$NETWORK" >/dev/null
docker run --detach --name "$STAFF_CONTAINER" --network "$NETWORK" --network-alias staff-staging.lunafrontdesk.com \
  --publish "127.0.0.1:${STAFF_PORT}:3036" --env-file "$STAFF_ENV" \
  --env "WOLFHOUSE_DATABASE_URL=$TARGET_DB_URL" --env "DATABASE_URL=$TARGET_DB_URL" \
  --env 'STAFF_QUERY_API_PORT=3036' --env 'STAFF_QUERY_API_HOST=0.0.0.0' \
  --env 'WHATSAPP_DRY_RUN=true' --env 'LUNA_AUTO_SEND_ENABLED=false' --env 'STAFF_ACTIONS_ENABLED=false' \
  "wh-staff-api-private:${SHA}" >/dev/null
docker run --detach --name "$LUNA_CONTAINER" --network "$NETWORK" \
  --publish "127.0.0.1:${LUNA_PORT}:8090" --tmpfs /opt/data:mode=700 --env-file "$LUNA_ENV" \
  --env 'HERMES_ROLE=luna' --env 'LUNA_CLIENT_SLUG=wolfhouse-somo' \
  --env 'WOLFHOUSE_STAFF_API_BASE_URL=http://staff-staging.lunafrontdesk.com:3036' \
  --env 'WHATSAPP_DRY_RUN=true' --env 'LUNA_AUTO_SEND_ENABLED=false' \
  "wh-hermes-staging-private:${SHA}" >/dev/null

assert_private_runtime_env_names "$STAFF_CONTAINER"
assert_private_runtime_env_names "$LUNA_CONTAINER"
printf 'private-copy: supervisor webhooks disabled and copy environment isolated by variable name checks.\n'

printf '\nPRIVATE COPY READY\n'
printf 'Database: %s\n' "$DB_NAME"
printf 'Staff:    http://127.0.0.1:%s  (%s)\n' "$STAFF_PORT" "$STAFF_CONTAINER"
printf 'Luna:     http://127.0.0.1:%s  (%s)\n' "$LUNA_PORT" "$LUNA_CONTAINER"
printf 'Cleanup:  sudo bash scripts/private-copy/down.sh %s %s %s\n' "$SHA" "$DATE_UTC" "$TAG"
