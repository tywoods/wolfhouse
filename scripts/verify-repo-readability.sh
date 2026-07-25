#!/usr/bin/env bash
# Offline verifier: temp repo + linked worktree, 0400 object, 0600 tracked, 0600 untracked secret.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HELPER=$ROOT/scripts/lib/normalize-repo-readability.sh
START=$ROOT/scripts/captain-git-start.sh
DONE=$ROOT/scripts/captain-git-done.sh
PASS=0 FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL  $1${2:+ — $2}"; }
mode_of() { stat -c '%a' -- "$1"; }
has_or() { local m o; m=$(mode_of "$1"); o=$((8#$m % 8)); (( o & 4 )); }

echo "verify:repo-readability (offline)"
[[ -f $HELPER && -f $START && -f $DONE ]] || { echo "missing scripts"; exit 1; }
grep -q normalize-repo-readability "$START" && grep -q normalize_repo_readability "$START" \
  && ok "captain-git-start wires helper" || bad "captain-git-start wires helper"
grep -q normalize-repo-readability "$DONE" && grep -q normalize_repo_readability "$DONE" \
  && ok "captain-git-done wires helper" || bad "captain-git-done wires helper"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
MAIN=$TMP/main; WT=$TMP/wt; mkdir -p "$MAIN"
git -C "$MAIN" init -q -b main
git -C "$MAIN" config user.email v@example.com
git -C "$MAIN" config user.name verify
printf 'tracked body\n' >"$MAIN/tracked file.txt"
git -C "$MAIN" add -- "tracked file.txt"
git -C "$MAIN" commit -q -m init
printf 'SECRET\n' >"$MAIN/.env.secret"
chmod 0600 "$MAIN/.env.secret" "$MAIN/tracked file.txt"
git -C "$MAIN" worktree add -q "$WT" -b wt-branch
[[ -f $WT/tracked\ file.txt ]] && chmod 0600 "$WT/tracked file.txt"
printf 'SECRET-WT\n' >"$WT/.env.secret"; chmod 0600 "$WT/.env.secret"

OBJECTS=$(git -C "$WT" rev-parse --path-format=absolute --git-path objects)
find "$OBJECTS" -type f -exec chmod 0400 {} +
OBJ=$(find "$OBJECTS" -type f | head -1)
[[ -n $OBJ ]] || { echo "no objects"; exit 1; }
OBJ_B=$(mode_of "$OBJ"); TR_B=$(mode_of "$MAIN/tracked file.txt"); SEC_B=$(mode_of "$MAIN/.env.secret")
echo "  setup object=$OBJ_B tracked=$TR_B secret=$SEC_B"

# shellcheck source=lib/normalize-repo-readability.sh
source "$HELPER"
set +e; OUT=$(normalize_repo_readability "$WT" 2>&1); RC=$?; set -e
echo "  helper rc=$RC"; echo "  $OUT"

OBJ_A=$(mode_of "$OBJ"); WT_TR=$WT/tracked\ file.txt; WT_A=$(mode_of "$WT_TR")
MAIN_A=$(mode_of "$MAIN/tracked file.txt")
SEC_A=$(mode_of "$MAIN/.env.secret"); WT_SEC=$(mode_of "$WT/.env.secret")

# D1 — object other-read via linked worktree common dir
(( RC == 0 )) && has_or "$OBJ" && ok "D1 object other-read ($OBJ_B → $OBJ_A)" \
  || bad "D1 object other-read" "rc=$RC mode=$OBJ_A"

# D2 — tracked other-read (active wt only; then main-scoped)
has_or "$WT_TR" && ok "D2 tracked other-read on active wt ($TR_B → $WT_A)" \
  || bad "D2 tracked other-read on active wt" "mode=$WT_A"
[[ $MAIN_A == 600 ]] && ok "D2 sibling worktree tracked left alone" \
  || bad "D2 sibling worktree tracked left alone" "main=$MAIN_A"
normalize_repo_readability "$MAIN" >/dev/null
MAIN_A=$(mode_of "$MAIN/tracked file.txt")
has_or "$MAIN/tracked file.txt" && ok "D2 tracked other-read after main run ($MAIN_A)" \
  || bad "D2 tracked other-read after main run" "mode=$MAIN_A"

# D2.1 — secret untouched + fsck + optional other-uid
SEC_A=$(mode_of "$MAIN/.env.secret"); WT_SEC=$(mode_of "$WT/.env.secret")
[[ $SEC_A == 600 && $WT_SEC == 600 ]] && ok "D2.1 untracked secret remains 0600" \
  || bad "D2.1 untracked secret remains 0600" "main=$SEC_A wt=$WT_SEC"
set +e; FSCK=$(git -C "$WT" fsck --no-dangling 2>&1); FRC=$?; set -e
(( FRC == 0 )) && ok "D2.1 git fsck succeeds" || bad "D2.1 git fsck succeeds" "rc=$FRC $FSCK"
UID_SIM=skipped
if command -v setpriv >/dev/null 2>&1 && setpriv --reuid=65534 --regid=65534 --clear-groups -- true 2>/dev/null; then
  if setpriv --reuid=65534 --regid=65534 --clear-groups -- git -C "$WT" fsck --no-dangling >/dev/null 2>&1 \
     && setpriv --reuid=65534 --regid=65534 --clear-groups -- test -r "$OBJ" \
     && setpriv --reuid=65534 --regid=65534 --clear-groups -- test -r "$WT_TR"; then UID_SIM=pass
  else UID_SIM=fail; fi
fi
case $UID_SIM in
  pass) ok "D2.1 unrelated-uid read+fsck" ;;
  fail) bad "D2.1 unrelated-uid read+fsck" ;;
  *) ok "D2.1 unrelated-uid sim skipped (no capability); o+r proven" ;;
esac

NRR_FIXED=0 NRR_OK=0 NRR_ABSENT=0 NRR_UNREADABLE=0 NRR_ESCAPE=0
_nrr_ensure_or "$MAIN/missing-$$" "$MAIN" || true
(( NRR_ABSENT == 1 )) && ok "absent path tolerated" || bad "absent path tolerated"
echo "escape-test" >"$TMP/escape-file"
NRR_ESCAPE=0
_nrr_ensure_or "$TMP/escape-file" "$MAIN" || true
(( NRR_ESCAPE == 1 )) && [[ $(mode_of "$TMP/escape-file") != *4 ]] || [[ $(mode_of "$TMP/escape-file") == 644 ]]
# escape must not gain o+r from our chmod — file may already be 644 from umask; ensure we didn't touch a 0600 escape
chmod 0600 "$TMP/escape-file"; NRR_ESCAPE=0
_nrr_ensure_or "$TMP/escape-file" "$MAIN" || true
(( NRR_ESCAPE == 1 )) && [[ $(mode_of "$TMP/escape-file") == 600 ]] \
  && ok "fail-closed path escape (no chmod)" || bad "fail-closed path escape" "mode=$(mode_of "$TMP/escape-file") esc=$NRR_ESCAPE"

echo; echo "summary: pass=$PASS fail=$FAIL"
(( FAIL == 0 ))
