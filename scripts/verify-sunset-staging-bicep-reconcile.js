'use strict';

/**
 * verify:sunset-staging-bicep-reconcile
 *
 * FOUNDATION Slice 2 — deterministic source gate.
 * Asserts main.bicep + parameters.example.json match the live inventory contract
 * for reconciled core fields, with no deployable sanitized placeholders.
 * Does not call Azure.
 *
 * Usage:
 *   node scripts/verify-sunset-staging-bicep-reconcile.js
 *   node scripts/verify-sunset-staging-bicep-reconcile.js --self-test
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BICEP = path.join(ROOT, 'infra/azure/sunset-staging/main.bicep');
const PARAMS = path.join(ROOT, 'infra/azure/sunset-staging/parameters.example.json');
const README = path.join(ROOT, 'infra/azure/sunset-staging/README.md');
const INVENTORY = path.join(
  ROOT,
  'infra/azure/sunset-staging/inventory/live-inventory.normalized.json',
);

const LIVE_IMAGE_TAG = '186307418400581a74f86b096e02bc32a41513b6';

const INGRESS_ROUTING_ENV = Object.freeze([
  {
    env: 'SUNSET_SOMO_WHATSAPP_NUMBER',
    param: 'sunsetSomoWhatsappNumber',
  },
  {
    env: 'SUNSET_SARDINERO_WHATSAPP_NUMBER',
    param: 'sunsetSardineroWhatsappNumber',
  },
  {
    env: 'SUNSET_SOMO_WHATSAPP_PHONE_NUMBER_ID',
    param: 'sunsetSomoWhatsappPhoneNumberId',
  },
  {
    env: 'SUNSET_SARDINERO_WHATSAPP_PHONE_NUMBER_ID',
    param: 'sunsetSardineroWhatsappPhoneNumberId',
  },
  {
    env: 'SUNSET_SOMO_INBOX_EMAIL',
    param: 'sunsetSomoInboxEmail',
  },
  {
    env: 'SUNSET_SARDINERO_INBOX_EMAIL',
    param: 'sunsetSardineroInboxEmail',
  },
]);

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function evaluate(bicepText, paramsObj, readmeText, inventory, label) {
  const errors = [];
  const params = paramsObj && paramsObj.parameters ? paramsObj.parameters : {};
  const val = (name) => (params[name] && params[name].value !== undefined ? params[name].value : undefined);

  // --- Reconciled live contract ---
  if (val('containerAppsLocation') !== 'northeurope') {
    errors.push('params.containerAppsLocation must be northeurope');
  }
  if (val('location') !== 'westeurope') {
    errors.push('params.location must be westeurope');
  }
  if (val('staffApiMinReplicas') !== 1 || val('staffApiMaxReplicas') !== 1) {
    errors.push('params scale must be minReplicas=1 maxReplicas=1');
  }
  if (val('deployContainerApps') !== true || val('deployStaffApi') !== true) {
    errors.push('params deploy flags must be true (represent live app)');
  }
  if (val('deploySchemaObserverJob') !== false) {
    errors.push('params deploySchemaObserverJob must stay false by default (source-only gate)');
  }
  if (val('staffApiImageTag') !== LIVE_IMAGE_TAG) {
    errors.push(`params.staffApiImageTag must be live immutable tag ${LIVE_IMAGE_TAG}`);
  }
  if (val('appDbName') !== 'sunset_staging') {
    errors.push('params.appDbName must be sunset_staging');
  }
  if (val('appNamePrefix') !== 'luna-sunset-staging') {
    errors.push('params.appNamePrefix must be luna-sunset-staging');
  }

  // Example file must stay non-deployable for required secrets/ops stamps
  for (const key of [
    'deploySha',
    'forceRevision',
    'sunsetSomoWhatsappNumber',
    'sunsetSardineroWhatsappNumber',
    'sunsetSomoWhatsappPhoneNumberId',
    'sunsetSardineroWhatsappPhoneNumberId',
    'sunsetSomoInboxEmail',
    'sunsetSardineroInboxEmail',
  ]) {
    const v = String(val(key) || '');
    if (!v.includes('<REQUIRED')) {
      errors.push(`params.example ${key} must be an unmistakable <REQUIRED…> placeholder`);
    }
  }
  if (!String(paramsObj.metadata && paramsObj.metadata.description || '').toLowerCase().includes('non-deployable')) {
    errors.push('params.example metadata must state NON-DEPLOYABLE');
  }

  // Bicep source contracts
  if (!/param containerAppsLocation string = 'northeurope'/.test(bicepText)) {
    errors.push('bicep default containerAppsLocation must be northeurope');
  }
  if (!/param location string = 'westeurope'/.test(bicepText)) {
    errors.push('bicep default location must be westeurope');
  }
  if (!/name: 'STAFF_ACTIONS_ENABLED',\s*value: 'true'/.test(bicepText)) {
    errors.push('bicep must hardcode STAFF_ACTIONS_ENABLED=true');
  }
  if (!/name: 'WHATSAPP_DRY_RUN',\s*value: 'true'/.test(bicepText)) {
    errors.push('bicep must keep WHATSAPP_DRY_RUN=true');
  }
  if (!/name: 'STAFF_AUTH_REQUIRED',\s*value: 'true'/.test(bicepText)) {
    errors.push('bicep must keep STAFF_AUTH_REQUIRED=true');
  }
  if (!/name: 'STRIPE_WEBHOOK_SKIP_VERIFY',\s*value: 'false'/.test(bicepText)) {
    errors.push('bicep must keep STRIPE_WEBHOOK_SKIP_VERIFY=false');
  }
  if (!/minReplicas:\s*staffApiMinReplicas/.test(bicepText)) {
    errors.push('bicep must scale via staffApiMinReplicas (live min=1)');
  }
  if (!/param staffApiImageTag string\b/.test(bicepText)
    || /param staffApiImageTag string = '/.test(bicepText)) {
    errors.push('bicep staffApiImageTag must be required (no baked default tag)');
  }
  if (/param deploySha string\s*=/.test(bicepText) || /param forceRevision string\s*=/.test(bicepText)) {
    errors.push('bicep deploySha/forceRevision must be required (no defaults)');
  }
  if (!/param deploySha string\b/.test(bicepText) || !/param forceRevision string\b/.test(bicepText)) {
    errors.push('bicep must declare deploySha and forceRevision parameters');
  }
  if (!/luna-sunset-staff-api:\$\{staffApiImageTag\}/.test(bicepText)) {
    errors.push('bicep image must be luna-sunset-staff-api:${staffApiImageTag}');
  }
  if (/wh-staff-api:/.test(bicepText) || /whstagingacr\.azurecr\.io\/wh-staff-api/.test(bicepText)) {
    errors.push('bicep must not reference wh-staff-api image');
  }
  if (/'wolfhouse_staging'/.test(bicepText)) {
    errors.push('bicep must not use wolfhouse_staging database');
  }
  if (/name:\s*'luna-bot-internal-token'/.test(bicepText)
    && !/value:\s*lunaBotInternalToken/.test(bicepText)) {
    errors.push('bicep luna-bot-internal-token must stay a secure-param value (manual), not a committed literal');
  }
  if (/luna-sunset-staging-hold-expiry/.test(bicepText)) {
    errors.push('bicep must not claim hold-expiry job');
  }
  if (!/param deploySchemaObserverJob bool = false/.test(bicepText)) {
    errors.push('bicep deploySchemaObserverJob must default false');
  }
  if (!/module schemaObserverJob 'schema-observer-job\.bicep' = if \(deployContainerApps && deploySchemaObserverJob\)/.test(bicepText)) {
    errors.push('bicep schema observer job must be gated by deployContainerApps && deploySchemaObserverJob');
  }
  if (/resource \w+ 'Microsoft\.App\/managedEnvironments\/managedCertificates[^']*' = \{/.test(bicepText)) {
    errors.push('bicep must not create managed certificates (use existing reference only)');
  }

  // Forbidden deployable sanitized / masked literals in Bicep
  if (/\*{2,}/.test(bicepText) || /\*\*\*\*/.test(bicepText)) {
    errors.push('bicep forbids masked **** placeholders as deployable values');
  }
  if (/example\.test/.test(bicepText)) {
    errors.push('bicep forbids example.test as deployed env literal');
  }
  if (/staging_[a-z0-9]+_phone_number_id/.test(bicepText)) {
    errors.push('bicep forbids staging_*_phone_number_id as deployed env literal');
  }
  if (/\+34000000000[12]/.test(bicepText)) {
    errors.push('bicep forbids sanitized WhatsApp number literals');
  }

  // Six ingress-routing env vars must resolve from parameters
  for (const row of INGRESS_ROUTING_ENV) {
    const re = new RegExp(
      `name:\\s*'${row.env}'\\s*,\\s*value:\\s*${row.param}\\b`,
    );
    if (!re.test(bicepText)) {
      errors.push(`bicep ${row.env} must resolve from parameter ${row.param}`);
    }
    if (!new RegExp(`@secure\\(\\)[\\s\\S]{0,120}param ${row.param} string\\b`).test(bicepText)
      && !new RegExp(`param ${row.param} string\\b`).test(bicepText)) {
      errors.push(`bicep missing parameter ${row.param}`);
    }
    if (!new RegExp(`@secure\\(\\)[\\s\\S]{0,200}param ${row.param} string\\b`).test(bicepText)) {
      errors.push(`bicep parameter ${row.param} must be @secure()`);
    }
    if (new RegExp(`param ${row.param} string\\s*=`).test(bicepText)) {
      errors.push(`bicep parameter ${row.param} must have no deployable default`);
    }
  }

  // Inventory alignment
  const staff = inventory && inventory.normalized && inventory.normalized.staffApi;
  if (!staff || staff.scale.minReplicas !== 1 || staff.scale.maxReplicas !== 1) {
    errors.push('inventory staffApi.scale must be 1/1');
  }
  if (!staff || staff.location !== 'northeurope') {
    errors.push('inventory staffApi.location must be northeurope');
  }
  if (!String(staff && staff.image).endsWith(`:${LIVE_IMAGE_TAG}`)) {
    errors.push('inventory image tag must match LIVE_IMAGE_TAG');
  }
  if (!staff || staff.plainEnv.STAFF_ACTIONS_ENABLED !== 'true') {
    errors.push('inventory STAFF_ACTIONS_ENABLED must be true');
  }

  // Runbook documents unmanaged deps + non-deployable example
  const unmanagedNeedles = [
    'hold-expiry',
    'Managed certificate',
    'firewall',
    'luna-bot-internal-token',
    'what-if',
    'NON-DEPLOYABLE',
  ];
  for (const n of unmanagedNeedles) {
    if (!readmeText.toLowerCase().includes(n.toLowerCase())) {
      errors.push(`readme missing unmanaged/what-if note: ${n}`);
    }
  }

  // No secret values in sources
  const blob = `${bicepText}\n${JSON.stringify(paramsObj)}\n${readmeText}`;
  if (/sk_live_[A-Za-z0-9]+/.test(blob) || /sk_test_[A-Za-z0-9]{8,}/.test(blob)) {
    errors.push('secret-looking stripe key in sources');
  }
  if (/postgres(?:ql)?:\/\/[^:\s"'<>]+:(?!<)[^@\s"'<>]+@/.test(blob)) {
    errors.push('postgres connection string with real password shape in sources');
  }

  return {
    label,
    ok: errors.length === 0,
    errors,
  };
}

function printResult(result) {
  console.log(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.label}`);
  if (!result.ok) {
    for (const e of result.errors) console.log(`        - ${e}`);
  }
  return result.ok;
}

function runSelfTest() {
  console.log('verify:sunset-staging-bicep-reconcile — self-test (RED→GREEN)\n');
  const bicep = read(BICEP);
  const params = JSON.parse(read(PARAMS));
  const readme = read(README);
  const inventory = JSON.parse(read(INVENTORY));

  let failed = 0;

  const green = evaluate(bicep, params, readme, inventory, 'green-live-contract');
  if (!printResult(green)) failed += 1;

  const expectFail = (name, mutatedBicep, mutatedParams, needle) => {
    const r = evaluate(mutatedBicep, mutatedParams, readme, inventory, name);
    const ok = !r.ok && r.errors.some((e) => e.includes(needle));
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  self-test ${name} (expect fail / ${needle})`);
    if (!ok) {
      failed += 1;
      console.log(`        errors=${JSON.stringify(r.errors)}`);
    }
  };

  {
    const p = deepClone(params);
    p.parameters.containerAppsLocation.value = 'westeurope';
    expectFail('red-wrong-cae-region', bicep, p, 'containerAppsLocation');
  }
  {
    const p = deepClone(params);
    p.parameters.staffApiMinReplicas.value = 0;
    expectFail('red-scale-min-0', bicep, p, 'scale');
  }
  {
    const badBicep = bicep.replace(
      "name: 'STAFF_ACTIONS_ENABLED', value: 'true'",
      "name: 'STAFF_ACTIONS_ENABLED', value: 'false'",
    );
    expectFail('red-staff-actions-false', badBicep, params, 'STAFF_ACTIONS_ENABLED');
  }
  {
    const p = deepClone(params);
    p.parameters.deployStaffApi.value = false;
    expectFail('red-deploy-flags-false', bicep, p, 'deploy flags');
  }
  {
    const p = deepClone(params);
    p.parameters.staffApiImageTag.value = 'deadbeef';
    expectFail('red-wrong-image-tag', bicep, p, 'staffApiImageTag');
  }

  // RED: masked **** in deployable Bicep
  {
    const bad = bicep.replace(
      'value: sunsetSomoWhatsappNumber',
      "value: '+34********01'",
    );
    expectFail('red-masked-asterisks', bad, params, '****');
  }

  // RED: example.test / staging_*_phone_number_id literals
  {
    const bad = bicep.replace(
      'value: sunsetSomoInboxEmail',
      "value: 'leak@staging.example.test'",
    );
    expectFail('red-example-test-literal', bad, params, 'example.test');
  }
  {
    const bad = bicep.replace(
      'value: sunsetSomoWhatsappPhoneNumberId',
      "value: 'staging_somo_phone_number_id'",
    );
    expectFail('red-staging-phone-id-literal', bad, params, 'staging_*_phone_number_id');
  }

  // RED: operational SHA defaults
  {
    const bad = bicep.replace(
      'param deploySha string',
      "param deploySha string = 'd9e4e88a97b7d22540cdd2aca0a8f12649266e47'",
    );
    expectFail('red-deploy-sha-default', bad, params, 'deploySha/forceRevision must be required');
  }

  // RED: ingress-routing env not from parameters
  {
    const bad = bicep.replace(
      "name: 'SUNSET_SARDINERO_INBOX_EMAIL', value: sunsetSardineroInboxEmail",
      "name: 'SUNSET_SARDINERO_INBOX_EMAIL', value: 'hardcoded@not-from-param.invalid'",
    );
    expectFail('red-ingress-env-not-from-param', bad, params, 'SUNSET_SARDINERO_INBOX_EMAIL must resolve from parameter');
  }

  {
    const p = deepClone(params);
    p.parameters.deploySchemaObserverJob = { value: true };
    expectFail('red-observer-enabled-in-example', bicep, p, 'deploySchemaObserverJob must stay false');
  }
  {
    const bad = `${bicep}\n// luna-sunset-staging-hold-expiry claimed`;
    expectFail('red-hold-expiry-claim', bad, params, 'hold-expiry');
  }

  console.log(`\n── self-test: ${failed ? 'FAILED' : 'PASSED'} ──`);
  return failed === 0;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    process.exit(runSelfTest() ? 0 : 1);
  }

  console.log('verify:sunset-staging-bicep-reconcile — live contract source gate\n');
  const result = evaluate(
    read(BICEP),
    JSON.parse(read(PARAMS)),
    read(README),
    JSON.parse(read(INVENTORY)),
    'main.bicep+parameters.example.json',
  );
  const ok = printResult(result);
  console.log(`\n── verify:sunset-staging-bicep-reconcile: ${ok ? 'ALL CHECKS PASSED' : 'FAILED'} ──`);
  process.exit(ok ? 0 : 1);
}

main();
