#!/bin/sh
set -eu
mode=${1:---dry-run}
case "$mode" in --install|--dry-run|--verify|--update-contract) ;; *) echo 'usage: install-luna-routing.sh [--install|--dry-run|--verify|--update-contract]' >&2; exit 2;; esac
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CADDYFILE=${CADDYFILE:-/etc/caddy/Caddyfile}; CADDY_BIN=/usr/bin/caddy
FRAGMENT=/var/lib/luna-routing/luna-number-route.caddy
files='luna-routing-controller.service controller.env.example luna-routing.tmpfiles.conf luna-number-route.caddy caddy-contract.js stage-route-fragment.js'
for f in $files; do [ -f "$base/$f" ] || { echo "missing: $f" >&2; exit 1; }; done
[ -f "$base/../../scripts/luna-number-routing-controller.js" ] || exit 1
# Source/static validation deliberately has no host Caddy dependency.
node --check "$base/caddy-contract.js"; node --check "$base/stage-route-fragment.js"; node --check "$base/../../scripts/luna-number-routing-controller.js"; sh -n "$0"

grep -qx 'User=luna-routing' "$base/luna-routing-controller.service"; grep -qx 'ExecStart=/usr/bin/node /opt/luna-routing/luna-number-routing-controller.js' "$base/luna-routing-controller.service"; grep -qx 'ReadWritePaths=/var/lib/luna-routing' "$base/luna-routing-controller.service"
if [ "$mode" = --dry-run ]; then
  if [ -f "$CADDYFILE" ]; then t=$(mktemp); trap 'rm -f "$t"' EXIT; node "$base/caddy-contract.js" install "$CADDYFILE" "$t"; fi
  echo 'dry-run: source and contract checks passed; no host caddy required'; exit 0
fi
verify() {
  [ -x "$CADDY_BIN" ]; [ ! -e /etc/sudoers.d/luna-routing ]
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
stage=$(mktemp -d); backup=$(mktemp -d); committed=0; mutations_started=0; service_commands_started=0
for p in Caddyfile fragment env controller unit sudoers tmpfiles; do eval dest_$p=; eval backup_$p=; done
rollback_failure=0
rollback_run(){ description=$1; shift; if ! "$@"; then echo "ROLLBACK FAILED: $description" >&2; rollback_failure=1; fi; }
cleanup(){
  rc=$?; trap - EXIT HUP INT TERM
  if [ "$committed" -eq 0 ] && [ "$mutations_started" -eq 1 ]; then
    echo "install failed (status $rc); restoring routing artifacts and runtime state" >&2
    # An enable created wants-links which systemctl can reliably remove only while the new unit
    # file is still present. Stop/disable it before deleting an installation with no prior unit.
    if [ "$service_commands_started" -eq 1 ] && [ "$unit_was_present" -eq 0 ]; then
      rollback_run 'stop newly introduced controller service' /usr/bin/systemctl stop luna-routing-controller.service
      rollback_run 'disable newly introduced controller service' /usr/bin/systemctl disable luna-routing-controller.service
    fi
    for p in Caddyfile fragment env controller unit sudoers tmpfiles; do
      eval src=\"\$backup_$p\"; eval dst=\"\$dest_$p\"
      if [ -e "$src" ]; then rollback_run "restore $dst" cp -a "$src" "$dst"; elif [ -n "$dst" ]; then rollback_run "remove newly installed $dst" rm -f "$dst"; fi
    done
    if [ "$service_commands_started" -eq 1 ]; then
      rollback_run 'daemon-reload restored units' /usr/bin/systemctl daemon-reload
      rollback_run 'reload Caddy from restored configuration' /usr/bin/systemctl reload caddy
      if [ "$unit_was_present" -eq 1 ]; then
        if [ "$unit_was_enabled" -eq 1 ]; then rollback_run 're-enable prior controller service' /usr/bin/systemctl enable luna-routing-controller.service; else rollback_run 'disable newly enabled controller service' /usr/bin/systemctl disable luna-routing-controller.service; fi
        if [ "$unit_was_active" -eq 1 ]; then rollback_run 'restart prior active controller service' /usr/bin/systemctl restart luna-routing-controller.service; else rollback_run 'stop newly started controller service' /usr/bin/systemctl stop luna-routing-controller.service; fi
      fi
    fi
    [ "$rollback_failure" -eq 0 ] || echo 'ROLLBACK INCOMPLETE: manual recovery is required' >&2
  fi
  rm -rf "$stage" "$backup"; exit "$rc"
}
trap cleanup EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
# Build every candidate before mutation.
node "$base/caddy-contract.js" "$([ "$mode" = --update-contract ] && echo update || echo install)" "$CADDYFILE" "$stage/Caddyfile"
# Preserve a canonical live route on reinstall. Refuse unknown content instead of silently
# replacing it with the repository's first-install Wolfhouse seed.
node "$base/stage-route-fragment.js" "$FRAGMENT" "$base/luna-number-route.caddy" "$stage/fragment"
cp "$CONTROLLER_ENV" "$stage/env"; cp "$base/../../scripts/luna-number-routing-controller.js" "$stage/controller"; cp "$base/luna-routing-controller.service" "$stage/unit"; cp "$base/luna-routing.tmpfiles.conf" "$stage/tmpfiles"
# Validation always targets the staged fragment (preserved on reinstall, seeded on first install).
STAGED_CADDYFILE="$stage/Caddyfile" STAGED_FRAGMENT="$stage/fragment" STAGED_VALIDATION="$stage/Caddyfile.validation" node -e '
const fs=require("fs"); const source=fs.readFileSync(process.env.STAGED_CADDYFILE,"utf8");
const canonical="import /var/lib/luna-routing/luna-number-route.caddy";
if (source.split(canonical).length !== 2) throw new Error("candidate must contain one canonical fragment import");
fs.writeFileSync(process.env.STAGED_VALIDATION,source.replace(canonical,`import ${process.env.STAGED_FRAGMENT}`));'
"$CADDY_BIN" validate --config "$stage/Caddyfile.validation" --adapter caddyfile >/dev/null
# Capture both disk and systemd runtime state before the first host mutation.
unit_was_present=0; [ ! -e /etc/systemd/system/luna-routing-controller.service ] || unit_was_present=1
unit_was_enabled=0; /usr/bin/systemctl is-enabled --quiet luna-routing-controller.service >/dev/null 2>&1 && unit_was_enabled=1 || :
unit_was_active=0; /usr/bin/systemctl is-active --quiet luna-routing-controller.service >/dev/null 2>&1 && unit_was_active=1 || :
backup_one(){ eval dest_$1=\"$2\"; eval backup_$1=\"$backup/$1\"; [ ! -e "$2" ] || cp -a "$2" "$backup/$1"; }
backup_one Caddyfile "$CADDYFILE"; backup_one fragment "$FRAGMENT"; backup_one env /etc/luna-routing/controller.env; backup_one controller /opt/luna-routing/luna-number-routing-controller.js; backup_one unit /etc/systemd/system/luna-routing-controller.service; backup_one sudoers /etc/sudoers.d/luna-routing; backup_one tmpfiles /etc/tmpfiles.d/luna-routing.conf
mutations_started=1
getent group luna-routing >/dev/null || groupadd --system luna-routing; getent passwd luna-routing >/dev/null || useradd --system --gid luna-routing --home-dir /var/lib/luna-routing --shell /usr/sbin/nologin luna-routing
install -d -o luna-routing -g luna-routing -m 0750 /var/lib/luna-routing; install -d -o root -g luna-routing -m 0750 /etc/luna-routing; install -d -m 0755 /opt/luna-routing
install -o luna-routing -g luna-routing -m 0640 "$stage/fragment" "$FRAGMENT"; install -o root -g luna-routing -m 0640 "$stage/env" /etc/luna-routing/controller.env; install -m 0755 "$stage/controller" /opt/luna-routing/luna-number-routing-controller.js; install -m 0644 "$stage/unit" /etc/systemd/system/luna-routing-controller.service; rm -f /etc/sudoers.d/luna-routing; install -m 0644 "$stage/tmpfiles" /etc/tmpfiles.d/luna-routing.conf
# The final canonical candidate is valid now that its final fragment has been installed.
"$CADDY_BIN" validate --config "$stage/Caddyfile" --adapter caddyfile >/dev/null
# Root config is intentionally the final filesystem mutation.
uid=$(stat -c %u "$CADDYFILE"); gid=$(stat -c %g "$CADDYFILE"); perm=$(stat -c %a "$CADDYFILE"); install -o "$uid" -g "$gid" -m "$perm" "$stage/Caddyfile" "$CADDYFILE"
service_commands_started=1; /usr/bin/systemctl daemon-reload; /usr/bin/systemctl enable --now luna-routing-controller.service; /usr/bin/systemctl reload caddy; verify
committed=1; echo 'installed and verified'
