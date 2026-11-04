#!/usr/bin/env node
'use strict';

const assert = require('assert');
const child = require('child_process');
const fs = require('fs');
const path = require('path');

const scriptsDir = __dirname;
const upPath = path.join(scriptsDir, 'private-copy', 'up.sh');
const downPath = path.join(scriptsDir, 'private-copy', 'down.sh');
const readmePath = path.join(scriptsDir, 'private-copy', 'README.md');
const up = fs.readFileSync(upPath, 'utf8');
const down = fs.readFileSync(downPath, 'utf8');
const readme = fs.readFileSync(readmePath, 'utf8');

for (const file of [upPath, downPath]) {
  child.execFileSync('bash', ['-n', file], { stdio: 'pipe' });
}

function mustContain(source, needle, label) {
  assert.ok(source.includes(needle), `${label}: missing ${needle}`);
}
function mustNotContain(source, needle, label) {
  assert.ok(!source.includes(needle), `${label}: forbidden ${needle}`);
}
function mustAppearBefore(source, first, second, label) {
  assert.ok(source.indexOf(first) !== -1 && source.indexOf(first) < source.indexOf(second), label);
}

// Exercise the real shell sanitizer/value gate against an inert env fixture.
// It never invokes Docker and never prints the fixture values.
const fixtureDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'private-copy-contract-'));
try {
  const preludeEnd = up.indexOf('\nneed_root\n');
  assert.ok(preludeEnd > 0, 'up helper prelude boundary exists');
  const helperPath = path.join(fixtureDir, 'helpers.sh');
  const envPath = path.join(fixtureDir, 'staff.env');
  fs.writeFileSync(helperPath, up.slice(0, preludeEnd + 1), { mode: 0o700 });
  fs.writeFileSync(envPath, [
    'SUPERVISOR_WEBHOOK_URL=https://example.invalid',
    'SUPERVISOR_WEBHOOK_SECRET=fixture-only',
    'WOLFHOUSE_HERMES_BASE_URL=http://live.invalid:8090',
    'WOLFHOUSE_HERMES_GUEST_FRESH_START_URL=http://live.invalid/fresh',
    'WOLFHOUSE_HERMES_GUEST_SESSION_KEY_RESET_URL=http://live.invalid/reset',
    'WOLFHOUSE_STAFF_API_BASE_URL=http://live.invalid:3036',
    'WHATSAPP_DRY_RUN=false',
  ].join('\n') + '\n', { mode: 0o600 });
  const shellHelper = JSON.stringify(helperPath);
  const shellEnv = JSON.stringify(envPath);
  const base = `COPY_ENVIRONMENT=wolfhouse-france-staging-test; LUNA_CONTAINER=private-luna; source ${shellHelper}; sanitize_copy_env ${shellEnv} staff; assert_private_env_file_safety ${shellEnv} staff`;
  child.execFileSync('bash', ['-c', `set -euo pipefail; ${base}`], { stdio: 'pipe' });
  fs.appendFileSync(envPath, 'WHATSAPP_DRY_RUN=false\n');
  assert.throws(() => child.execFileSync('bash', ['-c', `set -euo pipefail; COPY_ENVIRONMENT=wolfhouse-france-staging-test; LUNA_CONTAINER=private-luna; source ${shellHelper}; assert_private_env_file_safety ${shellEnv} staff`], { stdio: 'pipe' }), /private env safety value invalid: WHATSAPP_DRY_RUN/);
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

mustContain(up, "SOURCE_STAFF_CONTAINER='ovh-wolfhouse-staff'", 'up source identity');
mustContain(up, "SOURCE_LUNA_CONTAINER='hermes-luna'", 'up Luna identity');
mustContain(up, 'checkout HEAD must exactly equal the requested sha before building', 'up exact source commit guard');
mustContain(up, "git status --porcelain --untracked-files=all", 'up clean source guard');
mustContain(up, 'wolfhouse_c${TAG}_${SHA8}_${DATE_UTC}', 'up throwaway database name');
mustContain(up, 'pg_restore --exit-on-error', 'up restore fails closed');
mustContain(up, "SELECT 'guests=' || count(*) FROM guests", 'up guest count check');
mustContain(up, "SELECT 'booking_conversation_links=' || count(*)", 'up booking/chat link count check');
mustContain(up, 'restored key-table row counts differ from staging', 'up mismatch refusal');
mustContain(up, 'wh-hermes-staging-private:${SHA}', 'up Luna private tag');
mustContain(up, 'wh-staff-api-private:${SHA}', 'up Staff private tag');
mustContain(up, '--publish "127.0.0.1:${STAFF_PORT}:3036"', 'up Staff loopback port');
mustContain(up, '--publish "127.0.0.1:${LUNA_PORT}:8090"', 'up Luna loopback port');
mustContain(up, 'sanitize_copy_env()', 'up strips inherited supervisor and live-peer variables');
mustContain(up, 'assert_private_env_file_safety()', 'up checks effective safety values before startup');
mustContain(up, 'effective safety values verified before private resource creation', 'up announces pre-start safety gate');
mustAppearBefore(up, 'assert_private_env_file_safety "$STAFF_ENV" staff', 'pg pg_dump', 'up checks Staff safety before database copy');
mustAppearBefore(up, 'assert_private_env_file_safety "$LUNA_ENV" luna', 'pg pg_dump', 'up checks Luna safety before database copy');
mustContain(up, 'SUPERVISOR_EVENTS_ENABLED=0', 'up supervisor events off');
mustContain(up, 'LUNA_SUPERVISOR_EVENTS_ENABLED=false', 'up Luna supervisor events off');
mustContain(up, 'SUPERVISOR_HALT=1', 'up supervisor halt on');
mustContain(up, 'WHATSAPP_DRY_RUN=true', 'up WhatsApp dry run');
mustContain(up, 'LUNA_AUTO_SEND_ENABLED=false', 'up auto-send off');
mustContain(up, 'SUPERVISOR_EVENT_SOURCE_ENVIRONMENT=${COPY_ENVIRONMENT}', 'up isolated supervisor environment label');
mustContain(up, 'COPY_ENVIRONMENT="wolfhouse-france-staging-${TAG}-${SHA8}-${DATE_UTC}"', 'up copy-specific environment label');
mustContain(up, 'WOLFHOUSE_HERMES_BASE_URL=http://${LUNA_CONTAINER}:8090', 'up points Staff at private Luna');
mustContain(up, 'WOLFHOUSE_STAFF_API_BASE_URL=http://staff-staging.lunafrontdesk.com:3036', 'up points Luna at private Staff');
for (const key of [
  'SUPERVISOR_WEBHOOK_URL', 'SUPERVISOR_WEBHOOK_KEY', 'SUPERVISOR_WEBHOOK_SECRET', 'SUPERVISOR_WEBHOOK_SIGNING',
  'WOLFHOUSE_HERMES_GUEST_FRESH_START_URL', 'WOLFHOUSE_HERMES_GUEST_SESSION_KEY_RESET_URL',
]) {
  mustContain(up, key, `up strips and rejects ${key}`);
}
mustContain(up, 'private env safety value invalid: $key', 'up fails closed on a wrong effective safety value');
mustContain(up, 'cleanup_owned_private_run()', 'up owns rejected-run cleanup');
mustContain(up, 'PRIVATE_DB_CREATED=1', 'up tracks only its created private database');
mustContain(up, 'private throwaway database already exists; refusing to claim or delete it', 'up never claims a pre-existing private database');
mustContain(up, 'run rejected; removing only this run private resources', 'up announces rejected-run cleanup');
mustNotContain(up, "--env 'WOLFHOUSE_STAFF_API_BASE_URL=", 'up does not override sanitized Luna Staff target after validation');
mustNotContain(up, "--env 'WHATSAPP_DRY_RUN=", 'up does not override validated dry-run value after validation');
mustNotContain(up, 'docker prune', 'up destructive Docker command');
mustNotContain(up, 'docker restart', 'up live restart');
mustNotContain(up, 'curl ', 'up external HTTP call');

mustContain(down, 'DROP DATABASE IF EXISTS', 'down database removal');
mustContain(down, '^wolfhouse_c[a-z0-9-]+_[0-9a-f]{8}_[0-9]{8}$', 'down database prefix refusal');
mustContain(down, '^wolfhouse-private-(staff|luna|net)-', 'down resource prefix refusal');
mustContain(down, "SOURCE_STAFF_CONTAINER='ovh-wolfhouse-staff'", 'down source identity');
mustNotContain(down, 'docker prune', 'down destructive Docker command');
mustNotContain(down, 'docker restart', 'down live restart');
mustNotContain(down, 'curl ', 'down external HTTP call');

mustContain(readme, 'Skip should diff this helper', 'README working-script caveat');
console.log('private-copy script contract: PASS');
