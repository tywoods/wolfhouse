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
mustContain(up, "--env 'WHATSAPP_DRY_RUN=true'", 'up WhatsApp dry run');
mustContain(up, 'sanitize_copy_env()', 'up strips inherited supervisor webhook variables');
mustContain(up, 'SUPERVISOR_EVENTS_ENABLED=0', 'up supervisor events off');
mustContain(up, 'LUNA_SUPERVISOR_EVENTS_ENABLED=false', 'up Luna supervisor events off');
mustContain(up, 'SUPERVISOR_HALT=1', 'up supervisor halt on');
mustContain(up, 'SUPERVISOR_EVENT_SOURCE_ENVIRONMENT=${COPY_ENVIRONMENT}', 'up isolated supervisor environment label');
mustContain(up, 'COPY_ENVIRONMENT="wolfhouse-france-staging-${TAG}-${SHA8}-${DATE_UTC}"', 'up copy-specific environment label');
mustContain(up, 'assert_private_runtime_env_names "$STAFF_CONTAINER"', 'up Staff supervisor env readback');
mustContain(up, 'assert_private_runtime_env_names "$LUNA_CONTAINER"', 'up Luna supervisor env readback');
for (const key of ['SUPERVISOR_WEBHOOK_URL', 'SUPERVISOR_WEBHOOK_KEY', 'SUPERVISOR_WEBHOOK_SECRET', 'SUPERVISOR_WEBHOOK_SIGNING']) {
  mustContain(up, key, `up names and removes ${key}`);
}
mustContain(up, 'private runtime retains forbidden live env name: $forbidden', 'up rejects retained webhook env name');
mustContain(up, "--env 'LUNA_AUTO_SEND_ENABLED=false'", 'up auto-send off');
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
