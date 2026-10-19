#!/bin/sh
set -eu
mode=${1:---dry-run}
case "$mode" in --install|--dry-run|--verify|--update-contract) ;; *) echo 'usage: install-luna-routing.sh [--install|--dry-run|--verify|--update-contract]' >&2; exit 2;; esac
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CADDYFILE=${CADDYFILE:-/etc/caddy/Caddyfile}; CADDY_BIN=/usr/bin/caddy
NODE_BIN=/usr/bin/node
[ -x "$NODE_BIN" ] || { echo "required Node runtime is missing or not executable: $NODE_BIN" >&2; exit 1; }
node_version=$("$NODE_BIN" --version 2>/dev/null || :)
[ "$node_version" = v22.23.3 ] || { echo "luna-routing requires Node 22.23.3 at /usr/bin/node (found ${node_version:-unreadable} at $NODE_BIN)" >&2; exit 1; }
ROUTING_SITE=${LUNA_ROUTING_SITE:-lunabox.lunafrontdesk.com}
FRAGMENT=/var/lib/luna-routing/luna-number-route.caddy
files='luna-routing-controller.service controller.env.example luna-routing.tmpfiles.conf luna-number-route.caddy caddy-contract.js stage-route-fragment.js validate-controller-env.js validate-systemd-unit.js'
for f in $files; do [ -f "$base/$f" ] || { echo "missing: $f" >&2; exit 1; }; done
[ -f "$base/../../scripts/luna-number-routing-controller.js" ] || exit 1
IDENTITY_SRC="$base/../../scripts/lib/whatsapp-runtime-identity.js"
if [ -f "$IDENTITY_SRC" ]; then "$NODE_BIN" --check "$IDENTITY_SRC"; fi
# Source/static validation deliberately has no host Caddy dependency.
"$NODE_BIN" --check "$base/caddy-contract.js"; "$NODE_BIN" --check "$base/stage-route-fragment.js"; "$NODE_BIN" --check "$base/validate-controller-env.js"; "$NODE_BIN" --check "$base/validate-systemd-unit.js"; "$NODE_BIN" --check "$base/../../scripts/luna-number-routing-controller.js"; sh -n "$0"

grep -qx 'User=luna-routing' "$base/luna-routing-controller.service"; grep -qx 'ExecStart=/usr/bin/node /opt/luna-routing/luna-number-routing-controller.js' "$base/luna-routing-controller.service"; grep -qx 'ReadWritePaths=/var/lib/luna-routing' "$base/luna-routing-controller.service"
if [ "$mode" = --dry-run ]; then
  if [ -f "$CADDYFILE" ]; then t=$(mktemp); trap 'rm -f "$t"' EXIT; "$NODE_BIN" "$base/caddy-contract.js" install "$CADDYFILE" "$t" "$ROUTING_SITE"; fi
  echo 'dry-run: source and contract checks passed; no host caddy required'; exit 0
fi
check_no_unit_overrides() {
  # Uses systemd's type-wide, dash-prefix, full-unit, and complete system lookup rules.
  "$NODE_BIN" "$base/validate-systemd-unit.js"
}
reject_link(){ [ ! -L "$1" ] || { echo "symbolic link is unsupported: $1" >&2; return 1; }; }
check_destination_paths() {
  for path in \
    /var/lib/luna-routing /etc/luna-routing /opt/luna-routing \
    "$FRAGMENT" /etc/luna-routing/controller.env \
    /opt/luna-routing/luna-number-routing-controller.js \
    /etc/systemd/system/luna-routing-controller.service \
    /etc/sudoers.d/luna-routing /etc/tmpfiles.d/luna-routing.conf \
    "$CADDYFILE"
  do reject_link "$path"; done
}
check_effective_unit() {
  fragment=$(/usr/bin/systemctl show --property=FragmentPath --value luna-routing-controller.service)
  dropins=$(/usr/bin/systemctl show --property=DropInPaths --value luna-routing-controller.service)
  environment_files=$(/usr/bin/systemctl show --property=EnvironmentFiles --value luna-routing-controller.service)
  "$NODE_BIN" "$base/validate-systemd-unit.js" --effective "$fragment" "$dropins" "$environment_files"
}
verify() {
  [ -x "$CADDY_BIN" ]; [ ! -e /etc/sudoers.d/luna-routing ]
  check_no_unit_overrides
  check_effective_unit
  "$NODE_BIN" "$base/validate-controller-env.js" /etc/luna-routing/controller.env "$ROUTING_SITE"
  cmp -s "$base/../../scripts/luna-number-routing-controller.js" /opt/luna-routing/luna-number-routing-controller.js
  if [ -f "$IDENTITY_SRC" ]; then cmp -s "$IDENTITY_SRC" /opt/luna-routing/lib/whatsapp-runtime-identity.js; fi
  cmp -s "$base/luna-routing-controller.service" /etc/systemd/system/luna-routing-controller.service
  /usr/bin/systemctl is-active --quiet luna-routing-controller.service
  "$NODE_BIN" "$base/caddy-contract.js" verify "$CADDYFILE" /dev/null "$ROUTING_SITE"
  "$CADDY_BIN" validate --config "$CADDYFILE" --adapter caddyfile >/dev/null
  getent passwd luna-routing >/dev/null; [ "$(id -u luna-routing)" -ne 0 ]
  [ "$(stat -c %U:%G:%a "$FRAGMENT")" = luna-routing:luna-routing:640 ]
  su -s /bin/sh luna-routing -c 'test -r /var/lib/luna-routing/luna-number-route.caddy && test -w /var/lib/luna-routing'
}
[ "$mode" = --verify ] && { verify; echo verified; exit 0; }
[ "$(id -u)" -eq 0 ] || { echo 'install must run as root' >&2; exit 1; }
: "${CONTROLLER_ENV:?set CONTROLLER_ENV}"; [ -f "$CONTROLLER_ENV" ]; [ -x "$CADDY_BIN" ]; [ -f "$CADDYFILE" ]
"$NODE_BIN" "$base/validate-controller-env.js" "$CONTROLLER_ENV" "$ROUTING_SITE"
check_no_unit_overrides
check_destination_paths
/usr/bin/systemctl is-active --quiet caddy || { echo 'staged install requires Caddy to already be active' >&2; exit 1; }
check_existing_dir(){ [ ! -e "$1" ] || { [ -d "$1" ] && [ ! -L "$1" ] && [ "$(stat -c %U:%G:%a "$1")" = "$2" ]; } || { echo "existing directory has unsupported type/ownership/mode: $1" >&2; exit 1; }; }
check_existing_dir /var/lib/luna-routing luna-routing:luna-routing:750
check_existing_dir /etc/luna-routing root:luna-routing:750
check_existing_dir /opt/luna-routing root:root:755
stage=$(mktemp -d); backup=$(mktemp -d); committed=0; mutations_started=0; service_commands_started=0
for p in Caddyfile fragment env controller identity unit sudoers tmpfiles; do eval dest_$p=; eval backup_$p=; done
rollback_failure=0; controller_stop_unconfirmed=0
rollback_run(){ description=$1; shift; if ! "$@"; then echo "ROLLBACK FAILED: $description" >&2; rollback_failure=1; fi; }
cleanup(){
  rc=$?; trap - EXIT HUP INT TERM
  if [ "$committed" -eq 0 ] && [ "$mutations_started" -eq 1 ]; then
    echo "install failed (status $rc); restoring routing artifacts and runtime state" >&2
    # Never replace or remove executable/configuration bytes while a newly started process may
    # still map them. Exact `inactive` output is required; command failure/unknown is unconfirmed.
    if [ "$service_commands_started" -eq 1 ]; then
      if ! /usr/bin/systemctl stop luna-routing-controller.service; then
        echo 'ROLLBACK FAILED: stop controller before artifact restore' >&2
        rollback_failure=1; controller_stop_unconfirmed=1
      else
        controller_state=$(/usr/bin/systemctl is-active luna-routing-controller.service 2>/dev/null || :)
        if [ "$controller_state" != inactive ]; then
          echo "ROLLBACK FAILED: controller inactive confirmation returned ${controller_state:-unavailable}" >&2
          rollback_failure=1; controller_stop_unconfirmed=1
        fi
      fi
    fi
    if [ "$controller_stop_unconfirmed" -eq 1 ]; then
      echo 'controller stop or inactive confirmation failed; retaining controller artifacts and runtime dependencies' >&2
    elif [ "$service_commands_started" -eq 1 ] && [ "$unit_was_present" -eq 0 ]; then
      rollback_run 'disable newly introduced controller service' /usr/bin/systemctl disable luna-routing-controller.service
    fi
    caddyfile_restored=1
    # Caddy restoration is independent. Controller artifacts are touched only after confirmed stop.
    for p in Caddyfile fragment env controller identity unit sudoers tmpfiles; do
      if [ "$p" != Caddyfile ] && [ "$controller_stop_unconfirmed" -ne 0 ]; then continue; fi
      eval src=\"\$backup_$p\"; eval dst=\"\$dest_$p\"
      if [ -e "$src" ]; then
        if ! cp -a "$src" "$dst"; then echo "ROLLBACK FAILED: restore $dst" >&2; rollback_failure=1; [ "$p" != Caddyfile ] || caddyfile_restored=0; fi
      elif [ -n "$dst" ]; then rollback_run "remove newly installed $dst" rm -f "$dst"; fi
    done
    if [ "$caddyfile_restored" -eq 1 ]; then rollback_run 'reload Caddy from restored configuration' /usr/bin/systemctl reload caddy; fi
    if [ "$service_commands_started" -eq 1 ] && [ "$controller_stop_unconfirmed" -eq 0 ]; then
      rollback_run 'daemon-reload restored units' /usr/bin/systemctl daemon-reload
      if [ "$rollback_failure" -eq 0 ] && [ "$unit_was_present" -eq 1 ]; then
        if [ "$unit_was_enabled" -eq 1 ]; then rollback_run 're-enable prior controller service' /usr/bin/systemctl enable luna-routing-controller.service; else rollback_run 'disable newly enabled controller service' /usr/bin/systemctl disable luna-routing-controller.service; fi
        if [ "$rollback_failure" -eq 0 ] && [ "$unit_was_active" -eq 1 ]; then rollback_run 'restart prior active controller service' /usr/bin/systemctl restart luna-routing-controller.service; fi
      fi
    fi
    if [ "$rollback_failure" -ne 0 ]; then
      chmod -R go-rwx "$backup" 2>/dev/null || :
      echo "ROLLBACK INCOMPLETE: manual recovery is required" >&2
      echo "RECOVERY BACKUP PRESERVED: $backup" >&2
    fi
  fi
  rm -rf "$stage"
  [ "$rollback_failure" -ne 0 ] || rm -rf "$backup"
  [ "$rollback_failure" -eq 0 ] || exit 2
  exit "$rc"
}
trap cleanup EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
# Build every candidate before mutation.
"$NODE_BIN" "$base/caddy-contract.js" "$([ "$mode" = --update-contract ] && echo update || echo install)" "$CADDYFILE" "$stage/Caddyfile" "$ROUTING_SITE"
# Preserve a canonical live route on reinstall. Refuse unknown content instead of silently
# replacing it with the repository's first-install Wolfhouse seed.
"$NODE_BIN" "$base/stage-route-fragment.js" "$FRAGMENT" "$base/luna-number-route.caddy" "$stage/fragment"
cp "$CONTROLLER_ENV" "$stage/env"; cp "$base/../../scripts/luna-number-routing-controller.js" "$stage/controller"; cp "$base/luna-routing-controller.service" "$stage/unit"; cp "$base/luna-routing.tmpfiles.conf" "$stage/tmpfiles"
if [ -f "$IDENTITY_SRC" ]; then cp "$IDENTITY_SRC" "$stage/identity"; fi
# Validate the staged fragment in an isolated, non-public wrapper even when the selected
# site's candidate deliberately has no fragment import (France no-send staging).
printf 'http://127.0.0.1:18096 {\n  import %s\n}\n' "$stage/fragment" >"$stage/fragment.validation"
"$CADDY_BIN" validate --config "$stage/fragment.validation" --adapter caddyfile >/dev/null
# Also validate the full staged root candidate. Legacy replaces its canonical import with
# the staged file; France remains import-free and therefore cannot expose the webhook.
STAGED_CADDYFILE="$stage/Caddyfile" STAGED_FRAGMENT="$stage/fragment" STAGED_VALIDATION="$stage/Caddyfile.validation" "$NODE_BIN" -e '
const fs=require("fs"); const source=fs.readFileSync(process.env.STAGED_CADDYFILE,"utf8");
const canonical="import /var/lib/luna-routing/luna-number-route.caddy";
const occurrences=source.split(canonical).length-1;
if (occurrences > 1) throw new Error("candidate must contain at most one canonical fragment import");
fs.writeFileSync(process.env.STAGED_VALIDATION,occurrences === 1 ? source.replace(canonical,`import ${process.env.STAGED_FRAGMENT}`) : source);'
"$CADDY_BIN" validate --config "$stage/Caddyfile.validation" --adapter caddyfile >/dev/null
# Capture both disk and systemd runtime state before the first host mutation.
unit_was_present=0; [ ! -e /etc/systemd/system/luna-routing-controller.service ] || unit_was_present=1
unit_was_enabled=0; /usr/bin/systemctl is-enabled --quiet luna-routing-controller.service >/dev/null 2>&1 && unit_was_enabled=1 || :
unit_was_active=0; /usr/bin/systemctl is-active --quiet luna-routing-controller.service >/dev/null 2>&1 && unit_was_active=1 || :
backup_one(){ eval dest_$1=\"$2\"; eval backup_$1=\"$backup/$1\"; [ ! -e "$2" ] || cp -a "$2" "$backup/$1"; }
backup_one Caddyfile "$CADDYFILE"; backup_one fragment "$FRAGMENT"; backup_one env /etc/luna-routing/controller.env; backup_one controller /opt/luna-routing/luna-number-routing-controller.js; if [ -f "$stage/identity" ]; then backup_one identity /opt/luna-routing/lib/whatsapp-runtime-identity.js; fi; backup_one unit /etc/systemd/system/luna-routing-controller.service; backup_one sudoers /etc/sudoers.d/luna-routing; backup_one tmpfiles /etc/tmpfiles.d/luna-routing.conf
mutations_started=1
getent group luna-routing >/dev/null || groupadd --system luna-routing; getent passwd luna-routing >/dev/null || useradd --system --gid luna-routing --home-dir /var/lib/luna-routing --shell /usr/sbin/nologin luna-routing
install -d -o luna-routing -g luna-routing -m 0750 /var/lib/luna-routing; install -d -o root -g luna-routing -m 0750 /etc/luna-routing; install -d -m 0755 /opt/luna-routing
install -o luna-routing -g luna-routing -m 0640 "$stage/fragment" "$FRAGMENT"; install -o root -g luna-routing -m 0640 "$stage/env" /etc/luna-routing/controller.env; install -m 0755 "$stage/controller" /opt/luna-routing/luna-number-routing-controller.js; if [ -f "$stage/identity" ]; then install -d -m 0755 /opt/luna-routing/lib; install -m 0644 "$stage/identity" /opt/luna-routing/lib/whatsapp-runtime-identity.js; fi; install -m 0644 "$stage/unit" /etc/systemd/system/luna-routing-controller.service; rm -f /etc/sudoers.d/luna-routing; install -m 0644 "$stage/tmpfiles" /etc/tmpfiles.d/luna-routing.conf
# The final canonical candidate is valid now that its final fragment has been installed.
"$CADDY_BIN" validate --config "$stage/Caddyfile" --adapter caddyfile >/dev/null
# Root config is intentionally the final filesystem mutation.
uid=$(stat -c %u "$CADDYFILE"); gid=$(stat -c %g "$CADDYFILE"); perm=$(stat -c %a "$CADDYFILE"); install -o "$uid" -g "$gid" -m "$perm" "$stage/Caddyfile" "$CADDYFILE"
service_commands_started=1; /usr/bin/systemctl daemon-reload; /usr/bin/systemctl enable luna-routing-controller.service; /usr/bin/systemctl restart luna-routing-controller.service; /usr/bin/systemctl reload caddy; verify
committed=1; echo 'installed and verified'
