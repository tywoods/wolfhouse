#!/usr/bin/env node
'use strict';

/**
 * verify-sunset-whatsapp-silence
 *
 * Pins the 2026-08-30 Sunset staging silence diagnosis:
 *   - Meta phone_number_id ending …3109 routes to sunset-somo when mapped as SOMO
 *   - unknown ids still fail closed
 *   - unset LUNA_AUTO_SEND_ENABLED / WHATSAPP_DRY_RUN block guest sends (auto first)
 *   - SUNSET_SOMO_WHATSAPP_NUMBER is not required for Hermes tenant routing
 *   - Inbox Draft|Auto does not flip LUNA_AUTO_SEND_ENABLED
 *   - Sunset operator log line names /etc/hermes-sunset-luna.env
 *
 * Offline only. No Docker, no secrets, no deploy.
 *
 * Run: node scripts/verify-sunset-whatsapp-silence.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { resolveSunsetPhoneNumberId } = require('./lib/sunset-hermes-tenant-router');
const {
  resolveSunsetLocationFromPhoneNumberId,
  resolveSunsetLocationFromWhatsAppNumber,
} = require('./lib/sunset-inbox-channel-config');

const SOMO_PHONE_NUMBER_ID = '1152900101233109'; // public staging Meta id (last-4 …3109)
const SOMO_E164_DIGITS = '34663439419';
const SARDI_PLACEHOLDER_ID = 'PLACEHOLDER_SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID';

function ok(name, cond, detail) {
  assert.ok(cond, detail ? `${name}: ${detail}` : name);
  console.log(`  PASS  ${name}`);
}

console.log('[1] Tenant routing — …3109 → sunset-somo; unknown fail-closed');
const routeEnv = {
  SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID: SOMO_PHONE_NUMBER_ID,
  SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID: SARDI_PLACEHOLDER_ID,
};
ok(
  'Hermes router maps …3109 to sunset-somo',
  resolveSunsetPhoneNumberId(SOMO_PHONE_NUMBER_ID, routeEnv).location_id === 'sunset-somo',
);
ok(
  'Inbox channel config maps …3109 to sunset-somo',
  resolveSunsetLocationFromPhoneNumberId(SOMO_PHONE_NUMBER_ID, routeEnv).location_id === 'sunset-somo',
);
assert.throws(
  () => resolveSunsetPhoneNumberId('0000000000000000', routeEnv),
  /unknown Sunset phone_number_id/,
);
ok('unknown phone_number_id still fail-closes', true);

console.log('[2] NUMBER env optional for routing (live UNSET is not the silence cause)');
ok(
  'without SUNSET_SOMO_WHATSAPP_NUMBER, phone_number_id still resolves',
  resolveSunsetLocationFromPhoneNumberId(SOMO_PHONE_NUMBER_ID, routeEnv).location_id === 'sunset-somo',
);
ok(
  'unset NUMBER does not invent a whatsapp_number match',
  resolveSunsetLocationFromWhatsAppNumber(SOMO_E164_DIGITS, routeEnv) === null,
);
const withNumber = {
  ...routeEnv,
  SUNSET_SOMO_WHATSAPP_NUMBER: `+${SOMO_E164_DIGITS}`,
};
ok(
  'when NUMBER is set, E.164 digits map to sunset-somo',
  resolveSunsetLocationFromWhatsAppNumber(SOMO_E164_DIGITS, withNumber).location_id === 'sunset-somo',
);

console.log('[3] Kill switches — live unset matrix (Python send_flags)');
const py = `
import importlib.util, json, os
from pathlib import Path
p = Path(${JSON.stringify(path.join(ROOT, 'docker/hermes-staging/wolfhouse/send_flags.py'))})
spec = importlib.util.spec_from_file_location('send_flags', p)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
# Match live /etc/hermes-sunset-luna.env: both kill switches UNSET
empty = mod.guest_whatsapp_send_flag_block('+34600000999', {})
assert empty and empty['blocked_reason'] == mod.AUTO_SEND_BLOCKED_REASON
assert empty['flags'] == {'whatsapp_dry_run': True, 'luna_auto_send_enabled': False}
# Open auto only → dry run still blocks
dry = mod.guest_whatsapp_send_flag_block('+34600000999', {'LUNA_AUTO_SEND_ENABLED': 'true'})
assert dry and dry['blocked_reason'] == mod.DRY_RUN_BLOCKED_REASON
# Both open → no block
assert mod.guest_whatsapp_send_flag_block(
  '+34600000999',
  {'LUNA_AUTO_SEND_ENABLED': 'true', 'WHATSAPP_DRY_RUN': 'false'},
) is None
os.environ['HERMES_ROLE'] = 'sunset-luna'
line = mod.describe_flag_block(empty)
assert '/etc/hermes-sunset-luna.env' in line
assert 'hermes-sunset-luna' in line
assert '/etc/hermes-luna.env' not in line
print(json.dumps({'ok': True}))
`;
const pyOut = execFileSync('python3', ['-c', py], { encoding: 'utf8' }).trim();
ok('live unset env → luna_auto_send_not_enabled first', JSON.parse(pyOut).ok === true);

console.log('[4] Python sunset_tenant_routing — …3109 without NUMBER env');
const pyRoute = `
import importlib.util, json, os
from unittest import mock
from pathlib import Path
p = Path(${JSON.stringify(path.join(ROOT, 'docker/hermes-staging/sunset_tenant_routing.py'))})
spec = importlib.util.spec_from_file_location('sunset_tenant_routing', p)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
env = {
  'HERMES_ROLE': 'sunset-luna',
  'SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID': ${JSON.stringify(SOMO_PHONE_NUMBER_ID)},
  'SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID': ${JSON.stringify(SARDI_PLACEHOLDER_ID)},
}
with mock.patch.dict(os.environ, env, clear=True):
  loc = mod.resolve_location({'metadata': {'phone_number_id': ${JSON.stringify(SOMO_PHONE_NUMBER_ID)}}})
  assert loc == 'sunset-somo'
  try:
    mod.resolve_location({'metadata': {'phone_number_id': '0000000000000000'}})
    raise SystemExit('expected TenantRoutingError')
  except mod.TenantRoutingError:
    pass
print(json.dumps({'ok': True}))
`;
const pyRouteOut = execFileSync('python3', ['-c', pyRoute], { encoding: 'utf8' }).trim();
ok('Python resolve_location …3109 → sunset-somo; unknown fails', JSON.parse(pyRouteOut).ok === true);

console.log('[5] Docs + compose pins; Inbox Auto does not own the kill switch');
const killDoc = fs.readFileSync(path.join(ROOT, 'docs/LUNA-SEND-KILL-SWITCH.md'), 'utf8');
const silenceDoc = fs.readFileSync(
  path.join(ROOT, 'docs/sunset/SUNSET-STAGING-WHATSAPP-SILENCE.md'),
  'utf8',
);
const compose = fs.readFileSync(
  path.join(ROOT, 'docker/hermes-sunset/docker-compose.vm.yml'),
  'utf8',
);
const autonomy = fs.readFileSync(path.join(ROOT, 'scripts/verify-autonomy-ui-001.js'), 'utf8');
ok('kill-switch doc has Sunset Lunabox section', /Sunset staging on Lunabox/.test(killDoc));
ok('kill-switch doc names hermes-sunset-luna.env', /hermes-sunset-luna\.env/.test(killDoc));
ok('silence runbook names both kill switches', /WHATSAPP_DRY_RUN=false/.test(silenceDoc)
  && /LUNA_AUTO_SEND_ENABLED=true/.test(silenceDoc));
ok(
  'silence runbook says NUMBER is optional for Hermes send',
  /Optional[\s\S]{0,120}SUNSET_SOMO_WHATSAPP_NUMBER[\s\S]{0,80}Hermes/i.test(silenceDoc)
    || /not\*\* required for Hermes/i.test(silenceDoc)
    || /NUMBER[\s\S]{0,40}not[\s\S]{0,20}required/i.test(silenceDoc),
);
ok('Sunset compose comments kill switches', /WHATSAPP_DRY_RUN=false/.test(compose)
  && /LUNA_AUTO_SEND_ENABLED=true/.test(compose)
  && /hermes-sunset-luna\.env/.test(compose));
ok(
  'autonomy UI gate still forbids flipping LUNA_AUTO_SEND_ENABLED',
  /Do not flip or require LUNA_AUTO_SEND_ENABLED/.test(autonomy),
);

console.log('\nPASS sunset WhatsApp silence: …3109 routes; kill switches explain live silence; Inbox Auto is not the env toggle');
