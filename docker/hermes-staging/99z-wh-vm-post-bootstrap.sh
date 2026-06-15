#!/bin/sh
# VM overlay: shared auth.json symlink only.
#
# Luna's model config (Codex gpt-5.5 primary, Anthropic Claude fallback) is now
# baked into the image by 99-wh-staging-bootstrap (bootstrap.sh) — this overlay
# no longer writes config.yaml. It only points the per-container auth.json at the
# shared OAuth credential pool so both containers (luna + orchestrator) reuse the
# same ChatGPT/Anthropic logins.
set -eu

if [ -d /run/s6/container_environment ]; then
  for _envf in /run/s6/container_environment/*; do
    [ -f "$_envf" ] || continue
    _name="$(basename "$_envf")"
    export "$_name=$(cat "$_envf")"
  done
fi

HERMES_HOME="${HERMES_HOME:-/opt/data}"

if [ -f "$HERMES_HOME/.auth-shared/auth.json" ]; then
  rm -f "$HERMES_HOME/auth.json"
  ln -sf ".auth-shared/auth.json" "$HERMES_HOME/auth.json"
  chown -h hermes:hermes "$HERMES_HOME/auth.json" 2>/dev/null || true
fi
