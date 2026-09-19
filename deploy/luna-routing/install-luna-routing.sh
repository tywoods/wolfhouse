#!/bin/sh
set -eu
mode=${1:---dry-run}
case "$mode" in --dry-run|--verify) ;; *) echo 'usage: install-luna-routing.sh [--dry-run|--verify]' >&2; exit 2;; esac
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
check() { [ -e "$1" ] || { echo "missing: $1" >&2; exit 1; }; }
for f in luna-routing-controller.service controller.env.example luna-routing.tmpfiles.conf luna-routing.sudoers; do check "$base/$f"; done
if [ "$mode" = --verify ]; then
  getent passwd luna-routing >/dev/null || { echo 'missing luna-routing user' >&2; exit 1; }
  [ "$(id -u luna-routing)" -ne 0 ] || { echo 'luna-routing must not be root' >&2; exit 1; }
  [ -d /var/lib/luna-routing ] && [ -f /etc/luna-routing/tls/controller.key ] || { echo 'state/TLS paths missing' >&2; exit 1; }
  [ "$(stat -c %a /etc/luna-routing/tls/controller.key)" = 640 ] || { echo 'TLS key must be mode 0640' >&2; exit 1; }
fi
printf '%s: contract files valid; no changes made\n' "$mode"
