#!/usr/bin/env bash
# Add other-read on git objects + currently tracked regular files (multi-uid hosts).
# Never chmods untracked/secrets/dirs; never changes ownership or write/exec bits.
# Enum: private temp lists + checked find/git. Chmod: open FD → /proc/self/fd (no path TOCTOU).
set -euo pipefail

# Overridable in offline verifier only (hostile mocks).
_nrr_find() { find "$@"; }
_nrr_git() { git "$@"; }
_nrr_chmod() { chmod "$@"; }
_nrr_under() { [[ "$1" == "$2" || "$1" == "$2"/* ]]; }
_nrr_has_or() { local m o; m=$(stat -L -c '%a' -- "$1"); o=$((8#$m % 8)); (( o & 4 )); }

# Open candidate; containment-check /proc/self/fd/$fd; chmod only via that FD.
_nrr_ensure_or() {
  local f=$1 root=$2 fd=-1 target abs mode ftype
  if [[ $(type -t _nrr_hook_before_open 2>/dev/null) == function ]]; then
    _nrr_hook_before_open "$f"
  fi
  if [[ ! -e $f && ! -L $f ]]; then NRR_ABSENT=$((NRR_ABSENT + 1)); return 0; fi
  if ! exec {fd}<"$f" 2>/dev/null; then
    if [[ ! -e $f && ! -L $f ]]; then NRR_ABSENT=$((NRR_ABSENT + 1)); return 0; fi
    echo "[captain] readability FAIL — open failed: $f" >&2
    NRR_UNREADABLE=$((NRR_UNREADABLE + 1)); return 0
  fi
  _nrr_fd_close() { if [[ $fd -ge 0 ]]; then exec {fd}<&-; fd=-1; fi; }
  target=$(readlink -n -- "/proc/self/fd/$fd" 2>/dev/null || true)
  if [[ -z $target || $target == *'(deleted)' ]]; then
    _nrr_fd_close; NRR_ABSENT=$((NRR_ABSENT + 1)); return 0
  fi
  abs=$(cd -- "$(dirname -- "$target")" 2>/dev/null && pwd -P)/$(basename -- "$target") || abs=
  if [[ -z $abs ]]; then _nrr_fd_close; NRR_ABSENT=$((NRR_ABSENT + 1)); return 0; fi
  if ! _nrr_under "$abs" "$root"; then
    echo "[captain] readability FAIL — path escapes allowed root: $abs (root=$root)" >&2
    _nrr_fd_close; NRR_ESCAPE=$((NRR_ESCAPE + 1)); return 0
  fi
  # /proc/self/fd/N is a proc symlink; -L stats the opened inode.
  ftype=$(stat -L -c '%F' -- "/proc/self/fd/$fd" 2>/dev/null || true)
  if [[ $ftype != 'regular file' && $ftype != 'regular empty file' ]]; then
    _nrr_fd_close; return 0
  fi
  if _nrr_has_or "/proc/self/fd/$fd"; then NRR_OK=$((NRR_OK + 1)); _nrr_fd_close; return 0; fi
  if _nrr_chmod o+r -- "/proc/self/fd/$fd" 2>/dev/null && _nrr_has_or "/proc/self/fd/$fd"; then
    NRR_FIXED=$((NRR_FIXED + 1)); _nrr_fd_close; return 0
  fi
  mode=$(stat -L -c '%a' -- "/proc/self/fd/$fd" 2>/dev/null || echo '?')
  echo "[captain] readability FAIL — still unreadable to others: $abs mode=$mode" >&2
  _nrr_fd_close; NRR_UNREADABLE=$((NRR_UNREADABLE + 1)); return 0
}

# normalize_repo_readability [repo_cwd] — exit 1 if unreadable/escape remain or enum fails.
normalize_repo_readability() {
  local start=${1:-.} repo_root common objects f rel work list_obj list_tr
  repo_root=$(git -C "$start" rev-parse --show-toplevel) || return 1
  common=$(git -C "$start" rev-parse --path-format=absolute --git-common-dir) || return 1
  objects=$(git -C "$start" rev-parse --path-format=absolute --git-path objects) || return 1
  repo_root=$(cd -- "$repo_root" && pwd -P) || return 1
  common=$(cd -- "$common" && pwd -P) || return 1
  objects=$(cd -- "$objects" && pwd -P) || return 1
  if ! _nrr_under "$objects" "$common"; then
    echo "[captain] readability FAIL — objects dir escapes git common dir" >&2; return 1
  fi
  NRR_FIXED=0 NRR_OK=0 NRR_ABSENT=0 NRR_UNREADABLE=0 NRR_ESCAPE=0
  work=$(mktemp -d "${TMPDIR:-/tmp}/nrr.XXXXXX") || return 1
  # shellcheck disable=SC2064
  trap "rm -rf -- $(printf '%q' "$work")" RETURN
  list_obj=$work/objects.print0; list_tr=$work/tracked.print0
  if [[ -d $objects ]]; then
    _nrr_find "$objects" -type f -print0 >"$list_obj" \
      || { echo "[captain] readability FAIL — find objects enumeration failed" >&2; return 1; }
  else
    : >"$list_obj" || return 1
  fi
  _nrr_git -C "$repo_root" ls-files -z >"$list_tr" \
    || { echo "[captain] readability FAIL — git ls-files enumeration failed" >&2; return 1; }
  while IFS= read -r -d '' f; do _nrr_ensure_or "$f" "$objects"; done <"$list_obj" || return 1
  while IFS= read -r -d '' rel; do
    [[ -n $rel ]] || continue
    _nrr_ensure_or "$repo_root/$rel" "$repo_root"
  done <"$list_tr" || return 1
  echo "[captain] readability: fixed=$NRR_FIXED already_ok=$NRR_OK absent=$NRR_ABSENT unreadable=$NRR_UNREADABLE escape=$NRR_ESCAPE objects=$objects"
  (( NRR_UNREADABLE == 0 && NRR_ESCAPE == 0 ))
}

if [[ ${BASH_SOURCE[0]##*/} == "${0##*/}" ]]; then
  normalize_repo_readability "${1:-.}"
fi
