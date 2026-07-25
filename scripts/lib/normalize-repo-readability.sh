#!/usr/bin/env bash
# Add other-read on git objects + currently tracked regular files (multi-uid hosts).
# Never chmods untracked/secrets/dirs; never changes ownership or write/exec bits.
set -euo pipefail

_nrr_abs() {
  local p=$1 d b
  [[ -e "$p" || -L "$p" ]] || { printf '%s\n' ""; return 0; }
  d=$(cd -- "$(dirname -- "$p")" && pwd -P) || return 1
  b=$(basename -- "$p")
  printf '%s\n' "$d/$b"
}

_nrr_under() { [[ "$1" == "$2" || "$1" == "$2"/* ]]; }

_nrr_has_or() {
  local m other; m=$(stat -c '%a' -- "$1"); other=$((8#$m % 8)); (( other & 4 ))
}

_nrr_ensure_or() {
  local f=$1 root=$2 abs
  abs=$(_nrr_abs "$f") || return 1
  if [[ -z "$abs" ]]; then NRR_ABSENT=$((NRR_ABSENT + 1)); return 0; fi
  if ! _nrr_under "$abs" "$root"; then
    echo "[captain] readability FAIL — path escapes allowed root: $abs (root=$root)" >&2
    NRR_ESCAPE=$((NRR_ESCAPE + 1)); return 0
  fi
  [[ -L "$abs" || ! -f "$abs" ]] && return 0
  if _nrr_has_or "$abs"; then NRR_OK=$((NRR_OK + 1)); return 0; fi
  if chmod o+r -- "$abs" 2>/dev/null && _nrr_has_or "$abs"; then
    NRR_FIXED=$((NRR_FIXED + 1)); return 0
  fi
  echo "[captain] readability FAIL — still unreadable to others: $abs mode=$(stat -c '%a' -- "$abs")" >&2
  NRR_UNREADABLE=$((NRR_UNREADABLE + 1))
}

# normalize_repo_readability [repo_cwd] — exit 1 if unreadable/escape remain.
normalize_repo_readability() {
  local start=${1:-.} repo_root common objects f rel abs
  repo_root=$(git -C "$start" rev-parse --show-toplevel) || return 1
  common=$(git -C "$start" rev-parse --path-format=absolute --git-common-dir) || return 1
  objects=$(git -C "$start" rev-parse --path-format=absolute --git-path objects) || return 1
  repo_root=$(cd -- "$repo_root" && pwd -P)
  common=$(cd -- "$common" && pwd -P)
  objects=$(cd -- "$objects" && pwd -P)
  if ! _nrr_under "$objects" "$common"; then
    echo "[captain] readability FAIL — objects dir escapes git common dir" >&2
    return 1
  fi
  NRR_FIXED=0 NRR_OK=0 NRR_ABSENT=0 NRR_UNREADABLE=0 NRR_ESCAPE=0
  if [[ -d $objects ]]; then
    while IFS= read -r -d '' f; do
      _nrr_ensure_or "$f" "$objects" || true
    done < <(find "$objects" -type f -print0 2>/dev/null || true)
  fi
  while IFS= read -r -d '' rel; do
    [[ -n $rel ]] || continue
    _nrr_ensure_or "$repo_root/$rel" "$repo_root" || true
  done < <(git -C "$repo_root" ls-files -z)
  echo "[captain] readability: fixed=$NRR_FIXED already_ok=$NRR_OK absent=$NRR_ABSENT unreadable=$NRR_UNREADABLE escape=$NRR_ESCAPE objects=$objects"
  (( NRR_UNREADABLE == 0 && NRR_ESCAPE == 0 ))
}

if [[ ${BASH_SOURCE[0]##*/} == "${0##*/}" ]]; then
  normalize_repo_readability "${1:-.}"
fi
