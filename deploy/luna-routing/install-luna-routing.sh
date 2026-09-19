#!/bin/sh
set -eu
mode=${1:---dry-run}
case "$mode" in --install|--dry-run|--verify|--update-contract) ;; *) echo 'usage: install-luna-routing.sh [--install|--dry-run|--verify|--update-contract]' >&2; exit 2;; esac
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CADDYFILE=${CADDYFILE:-/etc/caddy/Caddyfile}; CADDY_BIN=/usr/bin/caddy
FRAGMENT=/var/lib/luna-routing/luna-number-route.caddy
files='luna-routing-controller.service controller.env.example luna-routing.tmpfiles.conf luna-routing.sudoers luna-number-route.caddy caddy-contract.js'
for f in $files; do [ -f "$base/$f" ] || { echo "missing: $f" >&2; exit 1; }; done
[ -f "$base/../../scripts/luna-number-routing-controller.js" ] || exit 1
# Source/static validation deliberately has no host Caddy dependency.
node --check "$base/caddy-contract.js"; node --check "$base/../../scripts/luna-number-routing-controller.js"; sh -n "$0"
[ "$(cat "$base/luna-routing.sudoers")" = 'luna-routing ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy' ] || { echo 'sudoers rule is not exact' >&2; exit 1; }
grep -qx 'User=luna-routing' "$base/luna-routing-controller.service"; grep -qx 'ExecStart=/usr/bin/node /opt/luna-routing/luna-number-routing-controller.js' "$base/luna-routing-controller.service"; grep -qx 'ReadWritePaths=/var/lib/luna-routing' "$base/luna-routing-controller.service"
command -v visudo >/dev/null 2>&1 && visudo -cf "$base/luna-routing.sudoers" >/dev/null || :
if [ "$mode" = --dry-run ]; then
  if [ -f "$CADDYFILE" ]; then t=$(mktemp); trap 'rm -f "$t"' EXIT; node "$base/caddy-contract.js" install "$CADDYFILE" "$t"; fi
  echo 'dry-run: source and contract checks passed; no host caddy required'; exit 0
fi
verify() {
  [ -x "$CADDY_BIN" ]; /usr/sbin/visudo -cf /etc/sudoers.d/luna-routing >/dev/null
  node "$base/caddy-contract.js" verify "$CADDYFILE"
  "$CADDY_BIN" validate --config "$CADDYFILE" --adapter caddyfile >/dev/null
  getent passwd luna-routing >/dev/null; [ "$(id -u luna-routing)" -ne 0 ]
  [ "$(stat -c %U:%G:%a "$FRAGMENT")" = luna-routing:luna-routing:640 ]
  su -s /bin/sh luna-routing -c 'test -r /var/lib/luna-routing/luna-number-route.caddy && test -w /var/lib/luna-routing'
}
[ "$mode" = --verify ] && { verify; echo verified; exit 0; }
[ "$(id -u)" -eq 0 ] || { echo 'install must run as root' >&2; exit 1; }
: "${CONTROLLER_ENV:?set CONTROLLER_ENV}"; [ -f "$CONTROLLER_ENV" ]; [ -x "$CADDY_BIN" ]; [ -f "$CADDYFILE" ]
grep -Eq '^LUNA_ROUTING_CONTROLLER_HMAC_KEY=.{32,}$' "$CONTROLLER_ENV"; grep -Eq '^LUNA_ROUTING_INGRESS_PROOF_KEY=.{32,}$' "$CONTROLLER_ENV"
stage=$(mktemp -d); backup=$(mktemp -d); committed=0
for p in Caddyfile fragment env controller unit sudoers tmpfiles; do eval dest_$p=; eval backup_$p=; done
cleanup(){ rc=$?; if [ "$committed" -eq 0 ]; then for p in Caddyfile fragment env controller unit sudoers tmpfiles; do eval src=\"\$backup_$p\"; eval dst=\"\$dest_$p\"; if [ -e "$src" ]; then cp -a "$src" "$dst"; elif [ -n "$dst" ]; then rm -f "$dst"; fi; done; fi; rm -rf "$stage" "$backup"; exit "$rc"; }; trap cleanup EXIT HUP INT TERM
# Build every candidate before mutation.
node "$base/caddy-contract.js" "$([ "$mode" = --update-contract ] && echo update || echo install)" "$CADDYFILE" "$stage/Caddyfile"
cp "$base/luna-number-route.caddy" "$stage/fragment"; cp "$CONTROLLER_ENV" "$stage/env"; cp "$base/../../scripts/luna-number-routing-controller.js" "$stage/controller"; cp "$base/luna-routing-controller.service" "$stage/unit"; cp "$base/luna-routing.sudoers" "$stage/sudoers"; cp "$base/luna-routing.tmpfiles.conf" "$stage/tmpfiles"
"$CADDY_BIN" validate --config "$stage/Caddyfile" --adapter caddyfile >/dev/null; /usr/sbin/visudo -cf "$stage/sudoers" >/dev/null
getent group luna-routing >/dev/null || groupadd --system luna-routing; getent passwd luna-routing >/dev/null || useradd --system --gid luna-routing --home-dir /var/lib/luna-routing --shell /usr/sbin/nologin luna-routing
install -d -o luna-routing -g luna-routing -m 0750 /var/lib/luna-routing; install -d -o root -g luna-routing -m 0750 /etc/luna-routing; install -d -m 0755 /opt/luna-routing
backup_one(){ eval dest_$1=\"$2\"; eval backup_$1=\"$backup/$1\"; [ ! -e "$2" ] || cp -a "$2" "$backup/$1"; }
backup_one Caddyfile "$CADDYFILE"; backup_one fragment "$FRAGMENT"; backup_one env /etc/luna-routing/controller.env; backup_one controller /opt/luna-routing/luna-number-routing-controller.js; backup_one unit /etc/systemd/system/luna-routing-controller.service; backup_one sudoers /etc/sudoers.d/luna-routing; backup_one tmpfiles /etc/tmpfiles.d/luna-routing.conf
install -o luna-routing -g luna-routing -m 0640 "$stage/fragment" "$FRAGMENT"; install -o root -g luna-routing -m 0640 "$stage/env" /etc/luna-routing/controller.env; install -m 0755 "$stage/controller" /opt/luna-routing/luna-number-routing-controller.js; install -m 0644 "$stage/unit" /etc/systemd/system/luna-routing-controller.service; install -m 0440 "$stage/sudoers" /etc/sudoers.d/luna-routing; install -m 0644 "$stage/tmpfiles" /etc/tmpfiles.d/luna-routing.conf
# Root config is intentionally the final filesystem mutation.
uid=$(stat -c %u "$CADDYFILE"); gid=$(stat -c %g "$CADDYFILE"); perm=$(stat -c %a "$CADDYFILE"); install -o "$uid" -g "$gid" -m "$perm" "$stage/Caddyfile" "$CADDYFILE"
/usr/bin/systemctl daemon-reload; /usr/bin/systemctl enable --now luna-routing-controller.service; /usr/bin/systemctl reload caddy; verify
committed=1; echo 'installed and verified'
