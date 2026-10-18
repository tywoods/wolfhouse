#!/usr/bin/env bash
set -u -o pipefail
umask 077
[[ ${1:-} == --execute ]] || { printf 'usage: %s --execute (reviewed bundle only)\n' "$0" >&2; exit 2; }
readonly SITE=whatsapp-staging.lunafrontdesk.com NODE_VERSION=22.23.3-1nodesource1 NODE_SHA=31eef6210cb50f9031afb59e7f1ed741d40db5d39f0894372b19444f33c4996e
readonly BUNDLE=$(cd -- "$(dirname -- "$0")" && pwd)
: "${TX:?reviewed transfer directory required}" "${SOURCE_ARCHIVE:?}" "${SOURCE_SHA256:?}" "${SOURCE_COMMIT:?}" "${DEB:?}" "${RELEASE:?previously absent release path required}"
PHASE=preflight COMMITTED=0 ROLLING_BACK=0 MUTATED=0 BACKUP= CONTROLLER_STOP_UNCONFIRMED=0
ROLLBACK_ERRORS=() WRITTEN_CADDY=()
safe_command(){ printf '%q ' "$@"; }
die(){ local rc=${1:-1}; shift||true; printf 'STUCK — phase=%s — %s\n' "$PHASE" "$*" >&2; exit "$rc"; }
must(){ "$@" || { local rc=$?; die "$rc" "$(safe_command "$@") — exit $rc"; }; }
require(){ "$@" || die 1 "assertion failed: $(safe_command "$@")"; }
rb_error(){ ROLLBACK_ERRORS+=("$*"); printf 'ROLLBACK FAILED — %s\n' "$*" >&2; }
regular_nolink(){ [[ -f $1 && ! -L $1 ]]; }
atomic_restore(){ node "$BUNDLE/caddy-import-inventory.cjs" --restore "$1" "$2"; }
controller_inactive(){ [[ $(/usr/bin/systemctl is-active luna-routing-controller.service 2>/dev/null || :) == inactive ]]; }
backup_controller(){
  mkdir -p "$BACKUP/controller/files"; : >"$BACKUP/controller/manifest"
  local i=0 p
  for p in /var/lib/luna-routing/luna-number-route.caddy /etc/luna-routing/controller.env /opt/luna-routing/luna-number-routing-controller.js /etc/systemd/system/luna-routing-controller.service /etc/sudoers.d/luna-routing /etc/tmpfiles.d/luna-routing.conf; do
    [[ ! -L $p ]]||return 1
    if [[ -e $p ]];then cp -a "$p" "$BACKUP/controller/files/$i"||return 1; printf 'PRESENT\t%s\t%s\n' "$i" "$p">>"$BACKUP/controller/manifest";else printf 'ABSENT\t-\t%s\n' "$p">>"$BACKUP/controller/manifest";fi; ((i+=1))
  done
}
rollback_controller(){
  if (( CONTROLLER_STARTED )); then /usr/bin/systemctl stop luna-routing-controller.service || CONTROLLER_STOP_UNCONFIRMED=1; controller_inactive || CONTROLLER_STOP_UNCONFIRMED=1; fi
  if (( CONTROLLER_STOP_UNCONFIRMED )); then printf 'controller stop unconfirmed; retaining controller files/backups/release/Node/runtime dependencies\n' >&2; return 1; fi
  local state slot dest
  while IFS=$'\t' read -r state slot dest; do [[ ! -L $dest ]]||return 1; if [[ $state == PRESENT ]];then cp -a "$BACKUP/controller/files/$slot" "$dest"||return 1;else rm -f "$dest"||return 1;fi; done <"$BACKUP/controller/manifest"
  /usr/bin/systemctl daemon-reload
}
rollback_caddy(){
  local row src dst
  for row in "${WRITTEN_CADDY[@]}"; do src=$BACKUP/caddy-tree/$row; dst=/etc/caddy/$row; atomic_restore "$src" "$dst" || return 1; done
  /usr/bin/caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null || return 1
  /usr/bin/systemctl reload caddy || return 1
  node "$BUNDLE/caddy-import-inventory.cjs" /etc/caddy/Caddyfile /etc/caddy "$BACKUP/after-restore.json" || return 1
  node "$BUNDLE/verify-inventory.cjs" "$BACKUP/restore-content.json" "$BACKUP/after-restore.json" "${WRITTEN_CADDY[@]}"
}
rollback_release(){ (( CONTROLLER_STOP_UNCONFIRMED )) && return 1; [[ ! -e $RELEASE ]] || { [[ ! -L $RELEASE && $(stat -c '%d:%i' "$RELEASE") == "$RELEASE_ID" ]] || return 1; rm -rf --one-file-system "$RELEASE"; }; }
rollback_node(){ (( CONTROLLER_STOP_UNCONFIRMED )) && return 1; (( NODE_INSTALLED )) || return 0; apt-get purge -y nodejs && timeout 120 apt-get update; }
rollback_secret_and_temp(){ (( CONTROLLER_STOP_UNCONFIRMED )) || rm -rf --one-file-system "$TX/work"; }
verify_full_baseline(){
  node "$BUNDLE/check-luna-caddy-json.cjs" snapshot-protected /var/lib/caddy/.config/caddy/autosave.json >"$BACKUP/protected.rollback"||return 1
  [[ $(docker inspect --format '{{.Id}} {{.Config.Image}} {{.State.Running}}' "$CROWSNEST_ID") == "$CROWSNEST_BASE" ]] && cmp -s "$BACKUP/protected.before" "$BACKUP/protected.rollback"
}
rollback_all(){ rollback_controller||rb_error 'controller/router artifact restoration failed'; rollback_caddy||rb_error 'Caddy/import/active-state restoration failed'; rollback_release||rb_error 'release restoration failed'; rollback_node||rb_error 'Node/package/repository restoration failed'; rollback_secret_and_temp||rb_error 'secret/temp restoration failed'; verify_full_baseline||rb_error 'full baseline verification failed'; ((${#ROLLBACK_ERRORS[@]}==0)); }
on_exit(){ local rc=$?; trap - EXIT HUP INT TERM; ((COMMITTED==1))&&exit "$rc"; ((rc!=0))||rc=1; ((MUTATED==1))||{ printf 'STUCK — phase=%s — no host mutation occurred\n' "$PHASE" >&2; exit "$rc"; }; ROLLING_BACK=1; rollback_all||true; if((${#ROLLBACK_ERRORS[@]}));then printf 'ROLLBACK INCOMPLETE — %s — backup=%s\n' "$(IFS='; ';printf '%s' "${ROLLBACK_ERRORS[*]}")" "$BACKUP" >&2;exit 2;fi;printf 'ROLLBACK — failed phase=%s; full pre-job baseline restored and verified.\n' "$PHASE" >&2;exit "$rc"; }
trap on_exit EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
CONTROLLER_STARTED=0 NODE_INSTALLED=0 RELEASE_ID= INSTALLER=
exec 9>/run/lock/luna-routing-deploy.lock; must flock -n 9
(( EUID == 0 ))||die 1 'root required'; for x in bash flock sha256sum stat cp mv curl caddy docker dpkg-query apt-get tar timeout node;do command -v "$x">/dev/null||die 1 "missing tool $x";done
regular_nolink "$SOURCE_ARCHIVE"||die 1 'source archive is not regular'; regular_nolink "$DEB"||die 1 'Node package is not regular'; require sha256sum -c "$BUNDLE/SUMS.txt"; [[ $(sha256sum "$SOURCE_ARCHIVE"|cut -d' ' -f1) == "$SOURCE_SHA256" ]]||die 1 'source archive hash mismatch'; [[ $(sha256sum "$DEB"|cut -d' ' -f1) == "$NODE_SHA" ]]||die 1 'Node package hash mismatch'
[[ -f /root/luna-routing.env && ! -L /root/luna-routing.env && $(stat -c '%u:%a' /root/luna-routing.env) == 0:600 ]]||die 1 'secret metadata invalid'
node_state=$(dpkg-query -W -f='${Status} ${Version}\n' nodejs 2>/dev/null||:); [[ -z $node_state || $node_state == "install ok installed $NODE_VERSION" ]]||die 1 'unexpected pre-existing Node package'
[[ ! -e $RELEASE ]]||die 1 'release path already exists'
BACKUP=$(mktemp -d /var/backups/luna-routing-r4.XXXXXX); MUTATED=1
PHASE=inventory
node "$BUNDLE/caddy-import-inventory.cjs" /etc/caddy/Caddyfile /etc/caddy "$BACKUP/prewrite.identity.json"; cp "$BACKUP/prewrite.identity.json" "$BACKUP/restore-content.json"
mkdir "$BACKUP/caddy-tree"; cp -a /etc/caddy/Caddyfile "$BACKUP/caddy-tree/Caddyfile"; WRITTEN_CADDY=(Caddyfile)
backup_controller||die 1 'controller artifact inventory failed'
CROWSNEST_ID=$(docker ps --filter name=crowsnest --format '{{.ID}}'|head -n1); [[ -n $CROWSNEST_ID ]]||die 1 'Crow’s Nest not running'; CROWSNEST_BASE=$(docker inspect --format '{{.Id}} {{.Config.Image}} {{.State.Running}}' "$CROWSNEST_ID")
node "$BUNDLE/check-luna-caddy-json.cjs" snapshot-protected /var/lib/caddy/.config/caddy/autosave.json >"$BACKUP/protected.before"
PHASE=node
if [[ -z $node_state ]];then apt-get -s install "$DEB">"$BACKUP/apt.sim"; node "$BUNDLE/parse-apt-simulation.cjs" "$BACKUP/apt.sim"; must apt-get install -y "$DEB"; NODE_INSTALLED=1;fi
[[ $(/usr/bin/node --version) == v22.23.3 ]]||die 1 'Node runtime mismatch'
PHASE=source
mkdir "$TX/work"; tar -xf "$SOURCE_ARCHIVE" -C "$TX/work"; src="$TX/work/source"; [[ $(<"$src/SOURCE_COMMIT") == "$SOURCE_COMMIT" ]]||die 1 'source commit mismatch'; must node "$src/scripts/verify-luna-routing-deployment.js"; must mv "$src" "$RELEASE"; RELEASE_ID=$(stat -c '%d:%i' "$RELEASE"); INSTALLER="$RELEASE/deploy/luna-routing/install-luna-routing.sh"
LUNA_ROUTING_SITE=$SITE CADDYFILE=/etc/caddy/Caddyfile "$INSTALLER" --dry-run
PHASE=prewrite
node "$BUNDLE/caddy-import-inventory.cjs" /etc/caddy/Caddyfile /etc/caddy "$BACKUP/prewrite.now.json"; cmp -s "$BACKUP/prewrite.identity.json" "$BACKUP/prewrite.now.json"||die 1 'Caddy imports drifted'
PHASE=install
CONTROLLER_STARTED=1; LUNA_ROUTING_SITE=$SITE CONTROLLER_ENV=/root/luna-routing.env "$INSTALLER" --install
PHASE=acceptance
curl --fail --silent --show-error --max-time 8 http://127.0.0.1:8096/v1/routes/meta-whatsapp-verified-webhook -o /dev/null && die 1 'unauthenticated local request unexpectedly succeeded' || :
node "$BUNDLE/check-luna-caddy-json.cjs" verify-inactive /var/lib/caddy/.config/caddy/autosave.json
node "$BUNDLE/check-luna-caddy-json.cjs" snapshot-protected /var/lib/caddy/.config/caddy/autosave.json >"$BACKUP/protected.after"; cmp -s "$BACKUP/protected.before" "$BACKUP/protected.after"||die 1 'protected Caddy context drifted'
[[ $(docker inspect --format '{{.Id}} {{.Config.Image}} {{.State.Running}}' "$CROWSNEST_ID") == "$CROWSNEST_BASE" ]]||die 1 'Crow’s Nest drifted'
COMMITTED=1; printf 'HOLD — France TEST controller installed inactive; activation remains HOLD.\n'
