#!/usr/bin/env bash
# Removes only resources created by scripts/private-copy/up.sh.
set -euo pipefail

fail() { printf 'private-copy: %s\n' "$*" >&2; exit 1; }
need_root() { [ "${EUID:-$(id -u)}" -eq 0 ] || fail 'run with sudo bash'; }
need_bin() { command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"; }

need_root
need_bin docker

SHA="${1:-}"
DATE_UTC="${2:-}"
TAG="${3:-private}"
[ "$#" -eq 3 ] || fail 'usage: sudo bash down.sh <full-or-short-git-sha> <YYYYMMDD> <tag>'
printf '%s' "$SHA" | grep -Eq '^[0-9a-fA-F]{7,64}$' || fail 'sha must be 7-64 hexadecimal characters'
printf '%s' "$DATE_UTC" | grep -Eq '^[0-9]{8}$' || fail 'date must be YYYYMMDD'
printf '%s' "$TAG" | grep -Eq '^[a-z0-9][a-z0-9-]{0,20}$' || fail 'tag must be lowercase letters, digits, or hyphens'
SHA="$(printf '%s' "$SHA" | tr 'A-F' 'a-f')"
SHA8="${SHA:0:8}"
DB_NAME="wolfhouse_c${TAG}_${SHA8}_${DATE_UTC}"
printf '%s' "$DB_NAME" | grep -Eq '^wolfhouse_c[a-z0-9-]+_[0-9a-f]{8}_[0-9]{8}$' || fail 'refusing a database outside the private-copy throwaway prefix'

STAFF_CONTAINER="wolfhouse-private-staff-${TAG}-${SHA8}-${DATE_UTC}"
LUNA_CONTAINER="wolfhouse-private-luna-${TAG}-${SHA8}-${DATE_UTC}"
NETWORK="wolfhouse-private-net-${TAG}-${SHA8}-${DATE_UTC}"
SOURCE_STAFF_CONTAINER='ovh-wolfhouse-staff'

# Defense in depth: down must never receive a database URL from argv or env.
docker container inspect "$SOURCE_STAFF_CONTAINER" >/dev/null 2>&1 || fail "required France staging Staff container is absent: $SOURCE_STAFF_CONTAINER"
SOURCE_DB_URL="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$SOURCE_STAFF_CONTAINER" | sed -n 's/^WOLFHOUSE_DATABASE_URL=//p' | head -n 1)"
[ -n "$SOURCE_DB_URL" ] || fail 'France staging Staff has no WOLFHOUSE_DATABASE_URL'
SOURCE_DB_LOWER="$(printf '%s' "$SOURCE_DB_URL" | tr '[:upper:]' '[:lower:]')"
printf '%s' "$SOURCE_DB_LOWER" | grep -Eq '(prod|production|wolfhouse-prod-|wh\.lunafrontdesk\.com)' && fail 'refusing a source database that looks like production'

SOURCE_NO_QUERY="${SOURCE_DB_URL%%\?*}"
SOURCE_QUERY=""
case "$SOURCE_DB_URL" in *\?*) SOURCE_QUERY="?${SOURCE_DB_URL#*\?}" ;; esac
SOURCE_BASE="${SOURCE_NO_QUERY%/*}"
[ "$SOURCE_BASE" != "$SOURCE_NO_QUERY" ] && [ -n "$SOURCE_BASE" ] || fail 'source database URL has no database path'
TARGET_DB_URL="${SOURCE_BASE}/${DB_NAME}${SOURCE_QUERY}"
TARGET_DB_LOWER="$(printf '%s' "$TARGET_DB_URL" | tr '[:upper:]' '[:lower:]')"
printf '%s' "$TARGET_DB_LOWER" | grep -Eq '(^|/)wolfhouse_c[a-z0-9-]+_[0-9a-f]{8}_[0-9]{8}(\?|$)' || fail 'refusing a target database outside the private-copy throwaway prefix'
printf '%s' "$TARGET_DB_LOWER" | grep -Eq '(prod|production|wolfhouse-prod-|wh\.lunafrontdesk\.com)' && fail 'refusing target URL that looks like production'

# Literal names are derived locally and checked once more before removal.
for resource in "$STAFF_CONTAINER" "$LUNA_CONTAINER" "$NETWORK"; do
  printf '%s' "$resource" | grep -Eq '^wolfhouse-private-(staff|luna|net)-[a-z0-9-]+-[0-9a-f]{8}-[0-9]{8}$' || fail "refusing unsafe resource name: $resource"
done

for container in "$LUNA_CONTAINER" "$STAFF_CONTAINER"; do
  if docker container inspect "$container" >/dev/null 2>&1; then
    actual="$(docker inspect --format '{{.Name}}' "$container" | sed 's#^/##')"
    [ "$actual" = "$container" ] || fail "container identity mismatch: $container"
    docker rm --force "$container" >/dev/null
    printf 'private-copy: removed container %s\n' "$container"
  fi
done
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  docker network rm "$NETWORK" >/dev/null
  printf 'private-copy: removed network %s\n' "$NETWORK"
fi

PG_IMAGE="${PRIVATE_COPY_POSTGRES_IMAGE:-postgres:16-alpine}"
docker run --rm --network host "$PG_IMAGE" psql "$SOURCE_DB_URL" --set ON_ERROR_STOP=1 --command "DROP DATABASE IF EXISTS \"$DB_NAME\""
printf 'private-copy: removed throwaway database %s\n' "$DB_NAME"
