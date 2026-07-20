'use strict';

/**
 * verify:fortress-slice15l-meta-signature-fail-closed — FORTRESS Slice 15L
 *
 * Offline RED/GREEN for Meta WhatsApp hub signature / verify-token fail-closed
 * (closes B01 per 15K remediation contract). No network, no live DB/Stripe/
 * WhatsApp/deploy/KV. Does not rewrite 15A/15K historical artifacts.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'fortress-tenant-identity');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice15l-contract.json');
const OVERLAY_PATH = path.join(FIXTURE_DIR, 'slice15l-b01-remediation-overlay.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice15l-findings.md');
const EVIDENCE_PATH = path.join(FIXTURE_DIR, 'slice15l-evidence.json');
const ATTACK_PATH = path.join(FIXTURE_DIR, 'slice15l-attack-cases.json');
const DESIGN_PATH = path.join(FIXTURE_DIR, 'slice15k-b01-remediation-contract.json');
const MATRIX_PATH = path.join(FIXTURE_DIR, 'boundary-matrix.json');
const OVERLAY_15K_PATH = path.join(FIXTURE_DIR, 'slice15k-b01-b12-audit-overlay.json');
const EVIDENCE_15K_PATH = path.join(FIXTURE_DIR, 'slice15k-evidence.json');
const DOC_PATH = path.join(ROOT, 'docs', 'FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md');

const MASTER_BASIS = 'f703f3e07d3cd9214c661f169c23c7d5d5370709';
const FAKE_APP_SECRET = 'fortress15l_meta_app_secret_SAMPLE_NOT_LIVE';
const FAKE_VERIFY_TOKEN = 'fortress15l_verify_token_SAMPLE_NOT_LIVE';

const {
  verifyMetaHubSignature256,
  verifyMetaHubChallenge,
  resolveMetaWhatsAppVerifyToken,
} = require('./lib/luna-meta-whatsapp-webhook');
const {
  validateMetaWhatsAppSignatureConfig,
  decideMetaWhatsAppWebhookPostAdmit,
} = require('./lib/meta-whatsapp-signature-config');
const { scanSecretFreeText } = require('./lib/fortress-tenant-identity-boundary');

let pass = 0;
let fail = 0;
const redResults = [];
const greenResults = [];
const attackBindings = new Map();

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  return false;
}

function red(id, cond, detail) {
  const passed = ok(`RED ${id}`, cond, detail);
  redResults.push({ id, ok: passed });
  attackBindings.set(id, { color: 'RED', ok: passed });
  return passed;
}

function green(id, cond, detail) {
  const passed = ok(`GREEN ${id}`, cond, detail);
  greenResults.push({ id, ok: passed });
  attackBindings.set(id, { color: 'GREEN', ok: passed });
  return passed;
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

function readJson(p) {
  return JSON.parse(readText(p));
}

function extractFunction(src, name) {
  const startRe = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const start = src.search(startRe);
  if (start < 0) return '';
  const after = src.slice(start);
  const endMatchers = [
    /\nasync function /,
    /\nfunction [a-zA-Z]/,
    /\nmodule\.exports/,
    /\n\/\/ ─{10,}/,
  ];
  let end = after.length;
  for (const re of endMatchers) {
    const m = after.slice(1).search(re);
    if (m >= 0) end = Math.min(end, m + 1);
  }
  return after.slice(0, end);
}

function extractServiceBlock(src, serviceName) {
  const markers = [
    new RegExp(`name:\\s*'${serviceName}'`),
    new RegExp(`name:\\s*"${serviceName}"`),
  ];
  let start = -1;
  for (const re of markers) {
    const m = src.search(re);
    if (m >= 0) {
      start = m;
      break;
    }
  }
  if (start < 0) return '';
  const after = src.slice(start);
  const nextResource = after.slice(1).search(/\nresource\s+/);
  return nextResource >= 0 ? after.slice(0, nextResource + 1) : after;
}

/**
 * Route-level POST harness mirroring handleMetaWhatsAppWebhookPost admit gate:
 * signature → decide → optional PostEntry stub. Never touches live PG.
 */
async function runMetaPostRoute(opts = {}) {
  const env = opts.env || {};
  const rawBody = opts.rawBody != null
    ? opts.rawBody
    : Buffer.from('{"object":"whatsapp_business_account","entry":[]}');
  const sigHeader = Object.prototype.hasOwnProperty.call(opts, 'sigHeader')
    ? opts.sigHeader
    : null;

  let postEntryCalled = false;
  let acquiredPg = false;

  const sigResult = verifyMetaHubSignature256(rawBody, sigHeader, env);
  const admit = decideMetaWhatsAppWebhookPostAdmit(sigResult, env);
  if (!admit.admit) {
    return {
      status: admit.status,
      body: {
        success: false,
        error: admit.error,
        preview_only: true,
        no_write_performed: true,
      },
      sigResult,
      admit,
      postEntryCalled,
      acquired_pg: acquiredPg,
    };
  }

  postEntryCalled = true;
  if (typeof opts.processEntry === 'function') {
    const processed = await opts.processEntry({
      rawBody,
      sigResult,
      admit,
      env,
    });
    acquiredPg = !!(processed && processed.acquired_pg);
    return {
      status: 200,
      body: processed && processed.response ? processed.response : { success: true },
      sigResult,
      admit,
      postEntryCalled,
      acquired_pg: acquiredPg,
      processed,
    };
  }

  return {
    status: 200,
    body: { success: true },
    sigResult,
    admit,
    postEntryCalled,
    acquired_pg: false,
  };
}

function runMetaGetRoute(query, env) {
  return verifyMetaHubChallenge(query, env);
}

function hmacHeader(rawBody, secret) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${digest}`;
}

console.log('verify:fortress-slice15l-meta-signature-fail-closed — FORTRESS Slice 15L\n');

const contract = readJson(CONTRACT_PATH);
const overlay = readJson(OVERLAY_PATH);
const findings = readText(FINDINGS_PATH);
const attacks = readJson(ATTACK_PATH);
const design = readJson(DESIGN_PATH);
const matrix = readJson(MATRIX_PATH);
const overlay15k = readJson(OVERLAY_15K_PATH);
const evidence15k = readJson(EVIDENCE_15K_PATH);
const doc = readText(DOC_PATH);
const metaLibSrc = readText(path.join(ROOT, 'scripts/lib/luna-meta-whatsapp-webhook.js'));
const sigCfgSrc = readText(path.join(ROOT, 'scripts/lib/meta-whatsapp-signature-config.js'));
const apiSrc = readText(path.join(ROOT, 'scripts/staff-query-api.js'));
const stagingBicep = readText(path.join(ROOT, 'infra/azure/staging/main.bicep'));
const sunsetBicep = readText(path.join(ROOT, 'infra/azure/sunset-staging/main.bicep'));
const envExample = readText(path.join(ROOT, 'infra/.env.example'));

const metaPostFn = extractFunction(apiSrc, 'handleMetaWhatsAppWebhookPost');
const metaGetFn = extractFunction(apiSrc, 'handleMetaWhatsAppWebhookGet');
const stagingStaff = extractServiceBlock(stagingBicep, 'staff-api');
const sunsetStaff = extractServiceBlock(sunsetBicep, 'luna-sunset-staging-staff-api');
const rawBodySample = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');

ok('F1 contract 15L + master_basis + outcome',
  contract.slice === 'FORTRESS-15L'
  && contract.outcome_id === '15L_meta_signature_fail_closed'
  && contract.master_basis === MASTER_BASIS
  && contract.live_mutation === false
  && contract.status === 'implemented'
  && Array.isArray(contract.guarded_routes)
  && contract.guarded_routes.length === 2);

ok('F2 overlay remediated historical untouched',
  overlay.boundary_id === 'B01_meta_whatsapp_signature_ingress'
  && overlay.status === 'remediated'
  && overlay.historical_audit_unchanged === true
  && overlay.live_mutation === false
  && Array.isArray(overlay.historical_artifacts)
  && overlay.historical_artifacts.includes('fixtures/fortress-tenant-identity/boundary-matrix.json')
  && overlay.historical_artifacts.includes('fixtures/fortress-tenant-identity/slice15k-b01-b12-audit-overlay.json')
  && overlay.activation_gap
  && overlay.activation_gap.deploy_performed === false
  && overlay.activation_gap.kv_secrets_mounted === false);

ok('F3 design freeze still design_only_not_implemented',
  design.status === 'design_only_not_implemented'
  && design.next_implementation_slice === 'FORTRESS-15L'
  && design.outcome_id === '15L_meta_signature_fail_closed');

ok('F4 findings cite routes + activation gap + historical',
  /\/staff\/meta\/whatsapp\/webhook/.test(findings)
  && /Activation gap/i.test(findings)
  && /15K/.test(findings)
  && /unproven/.test(findings));

ok('F5 historical 15A B01 still unproven',
  matrix.boundaries.find((b) => b.id === 'B01_meta_whatsapp_signature_ingress').verdict === 'unproven'
  && /B01 \| Meta WhatsApp signature \/ hub verify \| `unproven`/.test(doc));

ok('F6 historical 15K overlay still vulnerable',
  overlay15k.reaudit.B01_meta_whatsapp_signature_ingress.reaudit_verdict === 'vulnerable'
  && evidence15k.reaudit_verdicts.B01_meta_whatsapp_signature_ingress.verdict === 'vulnerable'
  && evidence15k.remediation_next_gate === 'FORTRESS-15L / 15L_meta_signature_fail_closed');

ok('F7 handler wiring: admit before PostEntry; startup apply present',
  /decideMetaWhatsAppWebhookPostAdmit/.test(metaPostFn)
  && /verifyMetaHubSignature256/.test(metaPostFn)
  && metaPostFn.indexOf('verifyMetaHubSignature256') < metaPostFn.indexOf('decideMetaWhatsAppWebhookPostAdmit')
  && metaPostFn.indexOf('decideMetaWhatsAppWebhookPostAdmit') < metaPostFn.indexOf('JSON.parse')
  && metaPostFn.indexOf('decideMetaWhatsAppWebhookPostAdmit') < metaPostFn.indexOf('processMetaWhatsAppWebhookPostEntry')
  && /verifyMetaHubChallenge/.test(metaGetFn)
  && /applyMetaWhatsAppSignatureConfigOrExit/.test(apiSrc)
  && /DEFAULT_META_WHATSAPP_VERIFY_TOKEN/.test(metaLibSrc) === false
  && /return DEFAULT_META_WHATSAPP_VERIFY_TOKEN/.test(metaLibSrc) === false
  && /app_secret_unconfigured/.test(metaLibSrc)
  && /verify_token_unconfigured/.test(metaLibSrc)
  && /META_WEBHOOK_SKIP_VERIFY/.test(sigCfgSrc));

console.log('\n── Secret-free scan ──');
for (const rel of [
  'fixtures/fortress-tenant-identity/slice15l-contract.json',
  'fixtures/fortress-tenant-identity/slice15l-b01-remediation-overlay.json',
  'fixtures/fortress-tenant-identity/slice15l-attack-cases.json',
  'fixtures/fortress-tenant-identity/slice15l-findings.md',
  'scripts/lib/meta-whatsapp-signature-config.js',
  'scripts/verify-fortress-slice15l-meta-signature-fail-closed.js',
]) {
  const hits = scanSecretFreeText(readText(path.join(ROOT, rel)));
  ok(`S secret-free ${rel}`, hits.length === 0, hits.join(','));
}

console.log('\n── Route-level RED/GREEN ──');

(async () => {
  const missingSecret = await runMetaPostRoute({
    env: {},
    rawBody: rawBodySample,
    sigHeader: null,
    processEntry: async () => {
      throw new Error('PostEntry must not run when secret missing');
    },
  });
  red('AC15L_RED_POST_MISSING_SECRET_503',
    missingSecret.status === 503
    && missingSecret.body.error === 'app_secret_unconfigured'
    && missingSecret.body.no_write_performed === true
    && missingSecret.postEntryCalled === false
    && missingSecret.acquired_pg === false
    && missingSecret.sigResult.skipped === false
    && missingSecret.sigResult.verified === false);

  const missingHeader = await runMetaPostRoute({
    env: { META_APP_SECRET: FAKE_APP_SECRET },
    rawBody: rawBodySample,
    sigHeader: null,
    processEntry: async () => {
      throw new Error('PostEntry must not run when header missing');
    },
  });
  red('AC15L_RED_POST_MISSING_HEADER_403',
    missingHeader.status === 403
    && missingHeader.body.error === 'missing_signature_header'
    && missingHeader.postEntryCalled === false
    && missingHeader.acquired_pg === false
    && missingHeader.sigResult.skipped === false);

  const badHmac = await runMetaPostRoute({
    env: { META_APP_SECRET: FAKE_APP_SECRET },
    rawBody: rawBodySample,
    sigHeader: `sha256=${'00'.repeat(32)}`,
    processEntry: async () => {
      throw new Error('PostEntry must not run on HMAC mismatch');
    },
  });
  red('AC15L_RED_POST_BAD_HMAC_403',
    badHmac.status === 403
    && badHmac.body.error === 'signature_mismatch'
    && badHmac.postEntryCalled === false
    && badHmac.acquired_pg === false);

  const getUnconfigured = runMetaGetRoute({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'anything',
    'hub.challenge': '15l-challenge',
  }, { NODE_ENV: 'staging' });
  red('AC15L_RED_GET_UNCONFIGURED_TOKEN_403',
    getUnconfigured.ok === false
    && getUnconfigured.status === 403
    && getUnconfigured.error === 'verify_token_unconfigured'
    && resolveMetaWhatsAppVerifyToken({}) === '');

  const startupMissing = validateMetaWhatsAppSignatureConfig({
    NODE_ENV: 'staging',
    META_WHATSAPP_VERIFY_TOKEN: FAKE_VERIFY_TOKEN,
  });
  red('AC15L_RED_STARTUP_STAGING_MISSING_SECRET',
    startupMissing.ok === false
    && startupMissing.errors.some((e) => e.variable === 'META_APP_SECRET'));

  const startupSkip = validateMetaWhatsAppSignatureConfig({
    NODE_ENV: 'production',
    META_APP_SECRET: FAKE_APP_SECRET,
    META_WHATSAPP_VERIFY_TOKEN: FAKE_VERIFY_TOKEN,
    META_WEBHOOK_SKIP_VERIFY: 'true',
  });
  red('AC15L_RED_STARTUP_STAGING_SKIP_REFUSED',
    startupSkip.ok === false
    && startupSkip.errors.some((e) => e.variable === 'META_WEBHOOK_SKIP_VERIFY'));

  let greenEntryCalled = false;
  const valid = await runMetaPostRoute({
    env: { META_APP_SECRET: FAKE_APP_SECRET },
    rawBody: rawBodySample,
    sigHeader: hmacHeader(rawBodySample, FAKE_APP_SECRET),
    processEntry: async () => {
      greenEntryCalled = true;
      return { acquired_pg: false, response: { success: true, admitted: true } };
    },
  });
  green('AC15L_GREEN_POST_VALID_HMAC_ADMITS',
    valid.status === 200
    && valid.admit.admit === true
    && valid.sigResult.verified === true
    && valid.postEntryCalled === true
    && greenEntryCalled === true);

  const getOk = runMetaGetRoute({
    'hub.mode': 'subscribe',
    'hub.verify_token': FAKE_VERIFY_TOKEN,
    'hub.challenge': '15l-challenge-ok',
  }, { META_WHATSAPP_VERIFY_TOKEN: FAKE_VERIFY_TOKEN });
  green('AC15L_GREEN_GET_MATCHING_TOKEN',
    getOk.ok === true
    && getOk.status === 200
    && getOk.challenge === '15l-challenge-ok');

  green('AC15L_GREEN_IAC_SECRET_REFS',
    /META_APP_SECRET/.test(stagingStaff)
    && /secretRef:\s*'meta-app-secret'/.test(stagingStaff)
    && /META_WHATSAPP_VERIFY_TOKEN/.test(stagingStaff)
    && /secretRef:\s*'meta-whatsapp-verify-token'/.test(stagingStaff)
    && /META_WEBHOOK_SKIP_VERIFY/.test(stagingStaff)
    && /value:\s*'false'/.test(stagingStaff)
    && /META_APP_SECRET/.test(sunsetStaff)
    && /secretRef:\s*'meta-app-secret'/.test(sunsetStaff)
    && /META_WHATSAPP_VERIFY_TOKEN/.test(sunsetStaff)
    && /secretRef:\s*'meta-whatsapp-verify-token'/.test(sunsetStaff)
    && /META_WEBHOOK_SKIP_VERIFY/.test(sunsetStaff)
    && /^# META_APP_SECRET=$/m.test(envExample)
    && /^# META_WHATSAPP_VERIFY_TOKEN=$/m.test(envExample)
    && /META_WEBHOOK_SKIP_VERIFY=false/.test(envExample)
    && !/EAA[A-Za-z0-9]{20,}/.test(stagingBicep)
    && !/EAA[A-Za-z0-9]{20,}/.test(sunsetBicep));

  const localSkipStartup = validateMetaWhatsAppSignatureConfig({
    NODE_ENV: 'test',
    META_WEBHOOK_SKIP_VERIFY: 'true',
  });
  const localSkipAdmit = decideMetaWhatsAppWebhookPostAdmit(
    { verified: false, skipped: false, error: 'app_secret_unconfigured' },
    { NODE_ENV: 'test', META_WEBHOOK_SKIP_VERIFY: 'true' },
  );
  green('AC15L_GREEN_LOCAL_SKIP_EXPLICIT',
    localSkipStartup.ok === true
    && localSkipAdmit.admit === true
    && localSkipAdmit.skipped === true);

  green('AC15L_GREEN_HISTORICAL_15A_15K_UNCHANGED',
    matrix.boundaries.find((b) => b.id === 'B01_meta_whatsapp_signature_ingress').verdict === 'unproven'
    && overlay15k.reaudit.B01_meta_whatsapp_signature_ingress.reaudit_verdict === 'vulnerable'
    && design.status === 'design_only_not_implemented'
    && /B01 \| Meta WhatsApp signature \/ hub verify \| `unproven`/.test(doc));

  // Malformed header (not sha256=) also 403 before PostEntry
  const malformed = await runMetaPostRoute({
    env: { META_APP_SECRET: FAKE_APP_SECRET },
    rawBody: rawBodySample,
    sigHeader: 'sha1=deadbeef',
  });
  ok('malformed signature format rejects 403 before PostEntry',
    malformed.status === 403
    && malformed.body.error === 'invalid_signature_format'
    && malformed.postEntryCalled === false);

  ok('GET mismatch still 403',
    runMetaGetRoute({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong',
      'hub.challenge': 'x',
    }, { META_WHATSAPP_VERIFY_TOKEN: FAKE_VERIFY_TOKEN }).error === 'invalid_verify_token');

  ok('B02 default-off env key untouched in this slice',
    !/META_WHATSAPP_INGRESS_AUTHORITY\s*=\s*['"]1['"]/.test(stagingStaff)
    && !/META_WHATSAPP_INGRESS_AUTHORITY\s*=\s*['"]1['"]/.test(sunsetStaff));

  ok('B12 Stripe skip pin preserved on Staff API',
    /STRIPE_WEBHOOK_SKIP_VERIFY/.test(stagingStaff)
    && /value:\s*'false'/.test(stagingStaff)
    && /STRIPE_WEBHOOK_SKIP_VERIFY/.test(sunsetStaff));

  console.log('\n── Attack case bind ──');
  ok('attack cases present', Array.isArray(attacks.cases) && attacks.cases.length >= 11);
  const unbound = [];
  const colorMismatch = [];
  for (const c of attacks.cases) {
    const bound = attackBindings.get(c.id);
    if (!bound) {
      unbound.push(c.id);
      continue;
    }
    if (bound.color !== c.color) colorMismatch.push(`${c.id}:${c.color}!=${bound.color}`);
    ok(`attack bind ${c.id}`, bound.ok === true && bound.color === c.color);
  }
  ok('no unbound attack cases', unbound.length === 0, unbound.join(','));
  ok('no attack color mismatches', colorMismatch.length === 0, colorMismatch.join(','));

  console.log('\n── Evidence (read-only validate) ──');
  ok('evidence exists', fs.existsSync(EVIDENCE_PATH));
  const evidence = readJson(EVIDENCE_PATH);
  ok('evidence slice + master + status',
    evidence.slice === 'FORTRESS-15L'
    && evidence.master_basis === MASTER_BASIS
    && evidence.live_mutation === false
    && evidence.outcome_id === '15L_meta_signature_fail_closed'
    && evidence.status === 'remediated');

  const runRedIds = redResults.map((r) => r.id);
  const runGreenIds = greenResults.map((r) => r.id);
  const evidenceRedIds = ((evidence.red && evidence.red.cases) || []).map((c) => c.id);
  const evidenceGreenIds = ((evidence.green && evidence.green.cases) || []).map((c) => c.id);

  ok('evidence RED ids match this run',
    evidenceRedIds.length === runRedIds.length
    && evidenceRedIds.every((id, i) => id === runRedIds[i])
    && redResults.every((r) => r.ok)
    && evidence.red.total === runRedIds.length
    && evidence.red.passed === runRedIds.length);

  ok('evidence GREEN ids match this run',
    evidenceGreenIds.length === runGreenIds.length
    && evidenceGreenIds.every((id, i) => id === runGreenIds[i])
    && greenResults.every((r) => r.ok)
    && evidence.green.total === runGreenIds.length
    && evidence.green.passed === runGreenIds.length);

  ok('verifier does not rewrite tracked evidence', (() => {
    const src = fs.readFileSync(__filename, 'utf8');
    return !(src.match(/writeFileSync\s*\(\s*EVIDENCE_PATH/g) || []).length;
  })());

  console.log(`\n── Summary: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) process.exit(1);
  console.log('verify:fortress-slice15l-meta-signature-fail-closed — ALL CHECKS PASSED');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
