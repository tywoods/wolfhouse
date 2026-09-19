#!/bin/sh
set -eu
mode=${1:---dry-run}
case "$mode" in --install|--dry-run|--verify) ;; *) echo 'usage: install-luna-routing.sh [--install|--dry-run|--verify]' >&2; exit 2;; esac
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CADDYFILE=${CADDYFILE:-/etc/caddy/Caddyfile}
CADDY_BIN=${CADDY_BIN:-/usr/bin/caddy}
FRAGMENT=/var/lib/luna-routing/luna-number-route.caddy
IMPORT="import $FRAGMENT"
CONTROLLER_PATH=/_internal/luna-routing/v1/routes/meta-whatsapp-verified-webhook
check_source() { [ -f "$1" ] || { echo "missing: $1" >&2; exit 1; }; }
for f in luna-routing-controller.service controller.env.example luna-routing.tmpfiles.conf luna-routing.sudoers luna-number-route.caddy; do check_source "$base/$f"; done
check_source "$base/../../scripts/luna-number-routing-controller.js"
[ "$CADDY_BIN" = /usr/bin/caddy ] && [ -x "$CADDY_BIN" ] || { echo 'CADDY_BIN must be executable /usr/bin/caddy' >&2; exit 1; }
patch_caddy() {
  input=$1 output=$2 fragment_import=$3
  node - "$input" "$output" "$fragment_import" "$CONTROLLER_PATH" <<'NODE'
const fs=require('fs'); const [input,output,fragment,controller]=process.argv.slice(2); const text=fs.readFileSync(input,'utf8');
const anchor=/^(\s*)reverse_proxy\s+\/whatsapp\/\*\s+[^\s{}]+\s*$/gm; const matches=[...text.matchAll(anchor)];
if (matches.length!==1) throw Error('expected exactly one broad /whatsapp/* reverse_proxy anchor');
if (text.includes('import /var/lib/luna-routing/luna-number-route.caddy') || text.includes(controller)) throw Error('partial or duplicate Luna routing contract');
const indent=matches[0][1]; const block=[`${indent}handle ${controller} {`,`${indent}  rewrite * /v1/routes/meta-whatsapp-verified-webhook`,`${indent}  reverse_proxy 127.0.0.1:8096`,`${indent}}`,`${indent}${fragment}`,''].join('\n');
fs.writeFileSync(output,text.slice(0,matches[0].index)+block+text.slice(matches[0].index));
NODE
}
verify() {
  getent passwd luna-routing >/dev/null && [ "$(id -u luna-routing)" -ne 0 ] || { echo 'missing/non-dedicated luna-routing user' >&2; exit 1; }
  getent group luna-routing >/dev/null || { echo 'missing luna-routing group' >&2; exit 1; }
  [ -f "$FRAGMENT" ] && [ "$(stat -c %U:%G:%a "$FRAGMENT")" = luna-routing:luna-routing:640 ] || { echo 'fragment metadata invalid' >&2; exit 1; }
  [ "$(grep -Fxc "$IMPORT" "$CADDYFILE")" -eq 1 ] || { echo 'root import contract invalid' >&2; exit 1; }
  grep -F "handle $CONTROLLER_PATH" "$CADDYFILE" >/dev/null || { echo 'internal controller route missing' >&2; exit 1; }
  /usr/sbin/visudo -cf /etc/sudoers.d/luna-routing >/dev/null
  "$CADDY_BIN" validate --config "$CADDYFILE" --adapter caddyfile >/dev/null
  expected=$(sed -n 's/^LUNA_ROUTING_ROOT_CADDY_SHA256=//p' /etc/luna-routing/controller.env)
  [ "$expected" = "$(sha256sum "$CADDYFILE" | cut -d' ' -f1)" ] || { echo 'root Caddyfile hash contract invalid' >&2; exit 1; }
}
if [ "$mode" = --verify ]; then verify; echo 'verified'; exit 0; fi
check_source "$CADDYFILE"
if grep -Fqx "$IMPORT" "$CADDYFILE"; then
  verify
  echo "$mode: existing installation verified; no changes made"
  exit 0
fi
tmp=$(mktemp); trap 'rm -f "$tmp" "$tmp.validate"' EXIT
patch_caddy "$CADDYFILE" "$tmp" "import $base/luna-number-route.caddy"
"$CADDY_BIN" validate --config "$tmp" --adapter caddyfile >/dev/null
if [ "$mode" = --dry-run ]; then echo "dry-run: validated root patch, fragment, unit, sudoers and controller sources; no changes made"; exit 0; fi
[ "$(id -u)" -eq 0 ] || { echo '--install must run as root' >&2; exit 1; }
: "${CONTROLLER_ENV:?set CONTROLLER_ENV to reviewed controller environment file}"
check_source "$CONTROLLER_ENV"
grep -Eq '^LUNA_ROUTING_CONTROLLER_HMAC_KEY=.{32,}$' "$CONTROLLER_ENV" || { echo 'invalid HMAC key' >&2; exit 1; }
grep -Eq '^LUNA_ROUTING_INGRESS_PROOF_KEY=.{32,}$' "$CONTROLLER_ENV" || { echo 'invalid proof key' >&2; exit 1; }
getent group luna-routing >/dev/null || groupadd --system luna-routing
getent passwd luna-routing >/dev/null || useradd --system --gid luna-routing --home-dir /var/lib/luna-routing --shell /usr/sbin/nologin luna-routing
install -d -o luna-routing -g luna-routing -m 0750 /var/lib/luna-routing
install -d -o root -g luna-routing -m 0750 /etc/luna-routing
install -d -o root -g root -m 0755 /opt/luna-routing
install -o luna-routing -g luna-routing -m 0640 "$base/luna-number-route.caddy" "$FRAGMENT"
# Rebuild with the installed absolute import, validate, then preserve root Caddyfile metadata.
patch_caddy "$CADDYFILE" "$tmp" "$IMPORT"
"$CADDY_BIN" validate --config "$tmp" --adapter caddyfile >/dev/null
backup="$CADDYFILE.luna-routing.$(date -u +%Y%m%dT%H%M%SZ).bak"; cp -a "$CADDYFILE" "$backup"
uid=$(stat -c %u "$CADDYFILE"); gid=$(stat -c %g "$CADDYFILE"); perm=$(stat -c %a "$CADDYFILE")
install -o "$uid" -g "$gid" -m "$perm" "$tmp" "$CADDYFILE"
hash=$(sha256sum "$CADDYFILE" | cut -d' ' -f1)
sed "/^LUNA_ROUTING_CADDY_BIN=/d;/^LUNA_ROUTING_ROOT_CADDY_SHA256=/d" "$CONTROLLER_ENV" > "$tmp.validate"
printf 'LUNA_ROUTING_CADDY_BIN=/usr/bin/caddy\nLUNA_ROUTING_ROOT_CADDY_SHA256=%s\n' "$hash" >> "$tmp.validate"
install -o root -g luna-routing -m 0640 "$tmp.validate" /etc/luna-routing/controller.env
install -o root -g root -m 0755 "$base/../../scripts/luna-number-routing-controller.js" /opt/luna-routing/luna-number-routing-controller.js
install -o root -g root -m 0644 "$base/luna-routing-controller.service" /etc/systemd/system/luna-routing-controller.service
install -o root -g root -m 0440 "$base/luna-routing.sudoers" /etc/sudoers.d/luna-routing
/usr/sbin/visudo -cf /etc/sudoers.d/luna-routing >/dev/null
install -o root -g root -m 0644 "$base/luna-routing.tmpfiles.conf" /etc/tmpfiles.d/luna-routing.conf
/usr/bin/systemctl daemon-reload
/usr/bin/systemctl enable --now luna-routing-controller.service
/usr/bin/systemctl reload caddy
verify
echo "installed and verified (backup: $backup)"
