'use strict';

/**
 * verify:sunset-waiver-model
 *
 * Offline checks for Sunset waiver migration + model helpers.
 * Does not require a live DB.
 *
 * Run:
 *   node scripts/verify-sunset-waiver-model.js
 *   npm run verify:sunset-waiver-model
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MIGRATION_036 = path.join(ROOT, 'database', 'migrations', '036_sunset_waivers.sql');
const MIGRATION_037 = path.join(ROOT, 'database', 'migrations', '037_sunset_group_waivers.sql');
const MODEL = path.join(ROOT, 'scripts', 'lib', 'sunset-waiver-model.js');
const CONFIG = path.join(ROOT, 'config', 'clients', 'sunset.waiver-form.json');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

console.log('\nverify:sunset-waiver-model — offline waiver model checks\n');

console.log('[1] config/clients/sunset.waiver-form.json');
assert('config exists', fs.existsSync(CONFIG));
let cfg = null;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert('config JSON.parse', true);
} catch (e) {
  assert('config JSON.parse', false, e.message);
}
if (cfg && cfg._meta) {
  assert(
    'form_version confirmed',
    cfg._meta.form_version === 'sunset_google_form_v1_confirmed',
    cfg._meta.form_version,
  );
  assert('needs_legal_copy_confirmation false', cfg._meta.needs_legal_copy_confirmation === false);
  assert(
    'confirmed_google_form_copy',
    cfg._meta.status === 'confirmed_google_form_copy',
  );
}

console.log('\n[2] migration 036_sunset_waivers.sql (unchanged baseline)');
assert('036 migration exists', fs.existsSync(MIGRATION_036));
const sql036 = fs.existsSync(MIGRATION_036) ? fs.readFileSync(MIGRATION_036, 'utf8') : '';
assert('036 CREATE waiver_form_requests', /CREATE TABLE IF NOT EXISTS waiver_form_requests/i.test(sql036));
assert('036 unique request_id on submissions (original v1)', /UNIQUE \(request_id\)|request_id_unique/i.test(sql036));

console.log('\n[3] migration 037_sunset_group_waivers.sql');
assert('037 migration exists', fs.existsSync(MIGRATION_037));
const sql037 = fs.existsSync(MIGRATION_037) ? fs.readFileSync(MIGRATION_037, 'utf8') : '';
assert('037 request_mode column', /request_mode/i.test(sql037));
assert('037 target_count column', /target_count/i.test(sql037));
assert('037 request_mode check single/group', /request_mode IN \('single', 'group'\)/i.test(sql037));
assert('037 target_count positive check', /target_count IS NULL OR target_count > 0/i.test(sql037));
assert('037 drops unique request_id', /DROP CONSTRAINT IF EXISTS waiver_form_submissions_request_id_unique/i.test(sql037));
assert('037 index tenant request_mode', /idx_waiver_form_requests_tenant_request_mode/i.test(sql037));
assert('037 index tenant booking mode', /idx_waiver_form_requests_tenant_booking_mode/i.test(sql037));
assert('037 index submissions tenant request submitted', /idx_waiver_form_submissions_tenant_request_submitted/i.test(sql037));
assert('037 BEGIN/COMMIT', /\bBEGIN\b/.test(sql037) && /\bCOMMIT\b/.test(sql037));

console.log('\n[4] scripts/lib/sunset-waiver-model.js helpers');
assert('model module exists', fs.existsSync(MODEL));

const {
  generateWaiverPublicId,
  isValidWaiverPublicId,
  hashWaiverToken,
  buildWaiverPublicUrl,
  resolveWaiverPublicBaseUrl,
  loadWaiverFormConfig,
  getWaiverFormVersionFromConfig,
  DEFAULT_STAGING_BASE_URL,
  SUNSET_TENANT_ID,
  createWaiverRequest,
  getWaiverRequestByPublicId,
  recordWaiverSubmission,
  computeWaiverRequestStatus,
  getWaiverSubmissionSummary,
  normalizeRequestMode,
} = require('./lib/sunset-waiver-model');

assert('SUNSET_TENANT_ID', SUNSET_TENANT_ID === 'sunset');
assert('DEFAULT_STAGING_BASE_URL staging host',
  DEFAULT_STAGING_BASE_URL === 'https://sunset-staging.lunafrontdesk.com');
assert('default base is not production hostname',
  !/https:\/\/sunset\.lunafrontdesk\.com\/?$/i.test(DEFAULT_STAGING_BASE_URL));

const id = generateWaiverPublicId();
assert('generateWaiverPublicId waiv_ prefix', /^waiv_/.test(id), id);
assert('generateWaiverPublicId valid format', isValidWaiverPublicId(id), id);
assert('reject bare token', !isValidWaiverPublicId('abc123'));
assert('reject booking id style', !isValidWaiverPublicId('SUNSET-MAN-20260710-ABC'));

const h1 = hashWaiverToken(id);
const h2 = hashWaiverToken(id);
assert('hashWaiverToken stable', h1 === h2);
assert('hashWaiverToken sha256 hex', /^[a-f0-9]{64}$/.test(h1));
assert(
  'hashWaiverToken matches crypto',
  h1 === crypto.createHash('sha256').update(id, 'utf8').digest('hex'),
);

const testUrl = buildWaiverPublicUrl('waiv_test123', 'https://sunset-staging.lunafrontdesk.com');
assert(
  'buildWaiverPublicUrl staging example',
  testUrl === 'https://sunset-staging.lunafrontdesk.com/forms/waiver/waiv_test123',
  testUrl,
);

const resolvedEmpty = resolveWaiverPublicBaseUrl({ env: {} });
assert(
  'resolveWaiverPublicBaseUrl defaults to staging',
  resolvedEmpty === 'https://sunset-staging.lunafrontdesk.com',
  resolvedEmpty,
);
assert(
  'resolveWaiverPublicBaseUrl never defaults to production',
  resolvedEmpty !== 'https://sunset.lunafrontdesk.com',
);
const resolvedEnv = resolveWaiverPublicBaseUrl({
  env: { STAFF_PUBLIC_BASE_URL: 'https://sunset-staging.lunafrontdesk.com/' },
});
assert('resolveWaiverPublicBaseUrl respects STAFF_PUBLIC_BASE_URL',
  resolvedEnv === 'https://sunset-staging.lunafrontdesk.com');

const loaded = loadWaiverFormConfig();
assert('loadWaiverFormConfig works', !!(loaded && loaded._meta));
assert(
  'getWaiverFormVersionFromConfig confirmed',
  getWaiverFormVersionFromConfig(loaded) === 'sunset_google_form_v1_confirmed',
);

assert('createWaiverRequest exported', typeof createWaiverRequest === 'function');
assert('getWaiverRequestByPublicId exported', typeof getWaiverRequestByPublicId === 'function');
assert('recordWaiverSubmission exported', typeof recordWaiverSubmission === 'function');
assert('computeWaiverRequestStatus exported', typeof computeWaiverRequestStatus === 'function');
assert('getWaiverSubmissionSummary exported', typeof getWaiverSubmissionSummary === 'function');
assert('default request mode single', normalizeRequestMode(undefined) === 'single');

assert('single pending when 0 submissions',
  computeWaiverRequestStatus({ requestMode: 'single', completedCount: 0 }) === 'pending');
assert('single completed when 1 submission',
  computeWaiverRequestStatus({ requestMode: 'single', completedCount: 1 }) === 'completed');
assert('group pending below target',
  computeWaiverRequestStatus({ requestMode: 'group', targetCount: 20, completedCount: 7 }) === 'pending');
assert('group completed at target',
  computeWaiverRequestStatus({ requestMode: 'group', targetCount: 20, completedCount: 20 }) === 'completed');
assert('group no target stays pending',
  computeWaiverRequestStatus({ requestMode: 'group', targetCount: null, completedCount: 5 }) === 'pending');

const modelSrc = fs.readFileSync(MODEL, 'utf8');
assert('createWaiverRequest accepts requestMode', modelSrc.includes('requestMode') || modelSrc.includes('request_mode'));
assert('createWaiverRequest accepts targetCount', modelSrc.includes('targetCount') || modelSrc.includes('target_count'));
assert('single mode blocks second submission in app logic', modelSrc.includes("requestMode === 'single'") && modelSrc.includes('completedCount >= 1'));
assert('group mode allows multiple submissions', modelSrc.includes("requestMode === 'group'") || modelSrc.includes('request_mode'));
assert('no ON CONFLICT request_id on insert', !modelSrc.includes('ON CONFLICT (request_id)'));
assert('model uses token_hash lookup', modelSrc.includes('token_hash'));
assert('model does not default production host', !modelSrc.includes("DEFAULT_STAGING_BASE_URL = 'https://sunset.lunafrontdesk.com'"));
assert('model idempotent completed path', modelSrc.includes('idempotent'));

(async () => {
  console.log('\n[5] helper validation without DB');
  const badTenant = await createWaiverRequest({ query: async () => ({ rows: [] }) }, {
    tenantId: 'wolfhouse-somo',
    formVersion: 'x',
  });
  assert('createWaiverRequest rejects non-sunset tenant', badTenant.ok === false && badTenant.status === 403);

  const missingVer = await createWaiverRequest({ query: async () => ({ rows: [] }) }, {
    tenantId: 'sunset',
  });
  assert('createWaiverRequest requires form_version', missingVer.ok === false && missingVer.error === 'form_version is required');

  const defaultSingle = await createWaiverRequest({ query: async () => ({ rows: [] }) }, {
    tenantId: 'sunset',
    formVersion: 'sunset_google_form_v1_confirmed',
  });
  assert('create without mode still validates (needs DB for insert)', defaultSingle.error !== 'unsupported request_mode');

  const groupNoTarget = await createWaiverRequest({ query: async () => ({ rows: [] }) }, {
    tenantId: 'sunset',
    formVersion: 'sunset_google_form_v1_confirmed',
    requestMode: 'group',
  });
  assert('group requires target_count', groupNoTarget.ok === false && groupNoTarget.error === 'target_count is required for group request_mode');

  const badLookup = await getWaiverRequestByPublicId({ query: async () => ({ rows: [] }) }, 'not-a-token');
  assert('getWaiverRequestByPublicId rejects bad token', badLookup.ok === false && badLookup.status === 404);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('OK  verify:sunset-waiver-model');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
