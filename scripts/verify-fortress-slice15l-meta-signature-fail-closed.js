'use strict';

/**
 * verify:fortress-slice15l-meta-signature-fail-closed — FORTRESS Slice 15L
 *
 * Offline RED/GREEN for Meta WhatsApp hub signature / verify-token fail-closed
 * (closes B01 per 15K remediation contract). No network, no live DB/Stripe/
 * WhatsApp/deploy/KV. Does not rewrite 15A/15K historical artifacts.
 *
 * Route proof uses the real staff-query-api offline listener/router (15J3 harness)
 * — does not reimplement admission logic.
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
const META_WEBHOOK_PATH = '/staff/meta/whatsapp/webhook';

const {
  verifyMetaHubSignature256,
  verifyMetaHubChallenge,
  resolveMetaWhatsAppVerifyToken,
} = require('./lib/luna-meta-whatsapp-webhook');
const {
  validateMetaWhatsAppSignatureConfig,
  decideMetaWhatsAppWebhookPostAdmit,
  classifyRuntimeSignals,
  EXTERNAL_POST_UNAVAILABLE,
  EXTERNAL_POST_FAILED,
  EXTERNAL_GET_FAILED,
} = require('./lib/meta-whatsapp-signature-config');
const { scanSecretFreeText } = require('./lib/fortress-tenant-identity-boundary');
const {
  createFortress15j3OfflineListener,
  listenHarness,
  closeHarness,
  httpRequest,
} = require('./lib/staff-query-api-fortress15j3-offline-harness');

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

function hmacHeader(rawBody, secret) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${digest}`;
}

function externalBodyOk(body, status) {
  if (!body || body.success !== false) return false;
  if (body.preview_only !== true || body.no_write_performed !== true) return false;
  if (status === 503) return body.error === EXTERNAL_POST_UNAVAILABLE;
  if (status === 403) return body.error === EXTERNAL_POST_FAILED;
  return false;
}

function leaksDetailedReason(body) {
  const s = typeof body === 'string' ? body : JSON.stringify(body || {});
  return /app_secret_unconfigured|missing_signature_header|signature_mismatch|invalid_signature_format|verify_token_unconfigured|invalid_verify_token/.test(s);
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
const verifierSrc = readText(__filename);

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

ok('F7 handler wiring: admit before PostEntry; generic external; startup apply',
  /decideMetaWhatsAppWebhookPostAdmit/.test(metaPostFn)
  && /verifyMetaHubSignature256/.test(metaPostFn)
  && metaPostFn.indexOf('verifyMetaHubSignature256') < metaPostFn.indexOf('decideMetaWhatsAppWebhookPostAdmit')
  && metaPostFn.indexOf('decideMetaWhatsAppWebhookPostAdmit') < metaPostFn.indexOf('JSON.parse')
  && metaPostFn.indexOf('decideMetaWhatsAppWebhookPostAdmit') < metaPostFn.indexOf('processMetaWhatsAppWebhookPostEntry')
  && /external_error/.test(metaPostFn)
  && /EXTERNAL_GET_FAILED/.test(metaGetFn)
  && /verifyMetaHubChallenge/.test(metaGetFn)
  && /applyMetaWhatsAppSignatureConfigOrExit/.test(apiSrc)
  && /DEFAULT_META_WHATSAPP_VERIFY_TOKEN/.test(metaLibSrc) === false
  && /return DEFAULT_META_WHATSAPP_VERIFY_TOKEN/.test(metaLibSrc) === false
  && /app_secret_unconfigured/.test(metaLibSrc)
  && /verify_token_unconfigured/.test(metaLibSrc)
  && /classifyRuntimeSignals/.test(sigCfgSrc)
  && /META_WEBHOOK_SKIP_VERIFY/.test(sigCfgSrc));

ok('F8 verifier uses real offline listener — does not duplicate admit gate',
  /createFortress15j3OfflineListener/.test(verifierSrc)
  && /httpRequest/.test(verifierSrc)
  && /listenHarness/.test(verifierSrc)
  && /require\('\.\/lib\/meta-whatsapp-signature-config'\)/.test(verifierSrc)
  && /require\('\.\/lib\/staff-query-api-fortress15j3-offline-harness'\)/.test(verifierSrc)
  && !/processMetaWhatsAppWebhookPostEntry\s*\(/.test(verifierSrc)
  && !/function\s+mirrorMetaPostAdmit/.test(verifierSrc)
  && !/function\s+reimplementMetaAdmit/.test(verifierSrc));

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

console.log('\n── Profile classification + helper RED/GREEN ──');

{
  const eitherNode = validateMetaWhatsAppSignatureConfig({
    NODE_ENV: 'production',
    STAFF_RUNTIME_PROFILE: 'preview',
    META_APP_SECRET: FAKE_APP_SECRET,
    META_WHATSAPP_VERIFY_TOKEN: FAKE_VERIFY_TOKEN,
  });
  red('AC15L_RED_STARTUP_CONTRADICTION_PROD_PREVIEW',
    eitherNode.ok === false
    && eitherNode.stagingOrProduction === true
    && eitherNode.contradictory === true
    && eitherNode.errors.some((e) => /contradictory/i.test(e.message)));

  const eitherProfile = validateMetaWhatsAppSignatureConfig({
    NODE_ENV: 'test',
    STAFF_RUNTIME_PROFILE: 'staging',
    META_WEBHOOK_SKIP_VERIFY: 'true',
  });
  red('AC15L_RED_STARTUP_EITHER_SIGNAL_STAGING',
    eitherProfile.ok === false
    && eitherProfile.stagingOrProduction === true
    && eitherProfile.contradictory === true
    && eitherProfile.errors.some((e) => e.variable === 'META_APP_SECRET')
    && eitherProfile.errors.some((e) => e.variable === 'META_WEBHOOK_SKIP_VERIFY'));

  const localVsCi = validateMetaWhatsAppSignatureConfig({
    NODE_ENV: 'test',
    STAFF_RUNTIME_PROFILE: 'ci',
    META_WEBHOOK_SKIP_VERIFY: 'true',
  });
  red('AC15L_RED_STARTUP_CONTRADICTION_LOCAL_CI',
    localVsCi.ok === false
    && localVsCi.localTestProfile === false
    && localVsCi.contradictory === true
    && localVsCi.errors.some((e) => e.variable === 'META_WEBHOOK_SKIP_VERIFY'));

  const unknownSkip = validateMetaWhatsAppSignatureConfig({
    NODE_ENV: 'preview',
    META_WEBHOOK_SKIP_VERIFY: 'true',
  });
  red('AC15L_RED_STARTUP_UNKNOWN_SKIP_REFUSED',
    unknownSkip.ok === false
    && unknownSkip.unknownProfile === true
    && unknownSkip.localTestProfile === false
    && unknownSkip.errors.some((e) => e.variable === 'META_WEBHOOK_SKIP_VERIFY'));

  const missingSecret = verifyMetaHubSignature256(rawBodySample, null, {});
  const missingAdmit = decideMetaWhatsAppWebhookPostAdmit(missingSecret, {});
  red('AC15L_RED_POST_MISSING_SECRET_503',
    missingSecret.error === 'app_secret_unconfigured'
    && missingAdmit.admit === false
    && missingAdmit.status === 503
    && missingAdmit.error === 'app_secret_unconfigured'
    && missingAdmit.external_error === EXTERNAL_POST_UNAVAILABLE);

  const missingHeader = verifyMetaHubSignature256(rawBodySample, null, { META_APP_SECRET: FAKE_APP_SECRET });
  const missingHeaderAdmit = decideMetaWhatsAppWebhookPostAdmit(missingHeader, {
    META_APP_SECRET: FAKE_APP_SECRET,
  });
  red('AC15L_RED_POST_MISSING_HEADER_403',
    missingHeader.error === 'missing_signature_header'
    && missingHeaderAdmit.status === 403
    && missingHeaderAdmit.external_error === EXTERNAL_POST_FAILED);

  const badHmac = verifyMetaHubSignature256(
    rawBodySample,
    `sha256=${'00'.repeat(32)}`,
    { META_APP_SECRET: FAKE_APP_SECRET },
  );
  const badAdmit = decideMetaWhatsAppWebhookPostAdmit(badHmac, { META_APP_SECRET: FAKE_APP_SECRET });
  red('AC15L_RED_POST_BAD_HMAC_403',
    badHmac.error === 'signature_mismatch'
    && badAdmit.status === 403
    && badAdmit.external_error === EXTERNAL_POST_FAILED);

  const getUnconfigured = verifyMetaHubChallenge({
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
    && startupMissing.stagingOrProduction === true
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

  const validSig = verifyMetaHubSignature256(
    rawBodySample,
    hmacHeader(rawBodySample, FAKE_APP_SECRET),
    { META_APP_SECRET: FAKE_APP_SECRET },
  );
  const validAdmit = decideMetaWhatsAppWebhookPostAdmit(validSig, { META_APP_SECRET: FAKE_APP_SECRET });
  green('AC15L_GREEN_POST_VALID_HMAC_ADMITS',
    validSig.verified === true
    && validAdmit.admit === true
    && validAdmit.skipped === false);

  const getOk = verifyMetaHubChallenge({
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
    STAFF_RUNTIME_PROFILE: 'test',
    META_WEBHOOK_SKIP_VERIFY: 'true',
  });
  const localSkipAdmit = decideMetaWhatsAppWebhookPostAdmit(
    { verified: false, skipped: false, error: 'app_secret_unconfigured' },
    { NODE_ENV: 'test', STAFF_RUNTIME_PROFILE: 'test', META_WEBHOOK_SKIP_VERIFY: 'true' },
  );
  green('AC15L_GREEN_LOCAL_SKIP_EXPLICIT',
    localSkipStartup.ok === true
    && localSkipStartup.localTestProfile === true
    && localSkipAdmit.admit === true
    && localSkipAdmit.skipped === true);

  const consistentLocal = classifyRuntimeSignals({ NODE_ENV: 'development' });
  green('AC15L_GREEN_PROFILE_CONSISTENT_LOCAL',
    consistentLocal.localTestProfile === true
    && consistentLocal.stagingOrProduction === false
    && consistentLocal.contradictory === false);

  green('AC15L_GREEN_HISTORICAL_15A_15K_UNCHANGED',
    matrix.boundaries.find((b) => b.id === 'B01_meta_whatsapp_signature_ingress').verdict === 'unproven'
    && overlay15k.reaudit.B01_meta_whatsapp_signature_ingress.reaudit_verdict === 'vulnerable'
    && design.status === 'design_only_not_implemented'
    && /B01 \| Meta WhatsApp signature \/ hub verify \| `unproven`/.test(doc));
}

ok('malformed signature format rejects via helper',
  verifyMetaHubSignature256(rawBodySample, 'sha1=deadbeef', { META_APP_SECRET: FAKE_APP_SECRET })
    .error === 'invalid_signature_format');

ok('GET mismatch still detailed on helper',
  verifyMetaHubChallenge({
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

(async () => {
  console.log('\n── Real offline listener/router (GET + POST) ──');

  const harnessReject = createFortress15j3OfflineListener({
    env: {
      META_APP_SECRET: FAKE_APP_SECRET,
      META_WHATSAPP_VERIFY_TOKEN: FAKE_VERIFY_TOKEN,
      META_WEBHOOK_SKIP_VERIFY: 'false',
    },
  });
  const portReject = await listenHarness(harnessReject);
  try {
    const missingHeaderRes = await httpRequest(portReject, {
      method: 'POST',
      path: META_WEBHOOK_PATH,
      headers: { 'Content-Type': 'application/json' },
      rawBody: rawBodySample,
    });
    red('AC15L_RED_REAL_LISTENER_POST_REJECT_BEFORE_PG',
      missingHeaderRes.status === 403
      && externalBodyOk(missingHeaderRes.body, 403)
      && !leaksDetailedReason(missingHeaderRes.body)
      && harnessReject.tracking.queries.length === 0
      && harnessReject.tracking.writes.length === 0,
      `status=${missingHeaderRes.status} q=${harnessReject.tracking.queries.length}`);

    const badHmacRes = await httpRequest(portReject, {
      method: 'POST',
      path: META_WEBHOOK_PATH,
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': `sha256=${'ab'.repeat(32)}`,
      },
      rawBody: rawBodySample,
    });
    ok('real listener bad HMAC generic 403 + zero PG',
      badHmacRes.status === 403
      && externalBodyOk(badHmacRes.body, 403)
      && !leaksDetailedReason(badHmacRes.body)
      && harnessReject.tracking.queries.length === 0);

    const getBad = await httpRequest(portReject, {
      method: 'GET',
      path: `${META_WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=15l`,
    });
    ok('real listener GET mismatch generic 403',
      getBad.status === 403
      && getBad.body
      && getBad.body.error === EXTERNAL_GET_FAILED
      && !leaksDetailedReason(getBad.body));
  } finally {
    await closeHarness(harnessReject);
  }

  const harnessNoSecret = createFortress15j3OfflineListener({
    env: {
      META_WHATSAPP_VERIFY_TOKEN: FAKE_VERIFY_TOKEN,
      META_WEBHOOK_SKIP_VERIFY: 'false',
    },
  });
  const portNoSecret = await listenHarness(harnessNoSecret);
  try {
    const noSecretRes = await httpRequest(portNoSecret, {
      method: 'POST',
      path: META_WEBHOOK_PATH,
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': hmacHeader(rawBodySample, FAKE_APP_SECRET),
      },
      rawBody: rawBodySample,
    });
    ok('real listener missing secret generic 503 + zero PG',
      noSecretRes.status === 503
      && externalBodyOk(noSecretRes.body, 503)
      && !leaksDetailedReason(noSecretRes.body)
      && harnessNoSecret.tracking.queries.length === 0
      && harnessNoSecret.tracking.writes.length === 0);

    const getUnconf = await httpRequest(portNoSecret, {
      method: 'GET',
      path: `${META_WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(FAKE_VERIFY_TOKEN)}&hub.challenge=c1`,
    });
    // Token is configured on this harness — prove GET success path separately below.
    ok('real listener GET with token configured returns challenge',
      getUnconf.status === 200
      && getUnconf.bodyRaw === 'c1');
  } finally {
    await closeHarness(harnessNoSecret);
  }

  const harnessGetUnconf = createFortress15j3OfflineListener({
    env: {
      META_APP_SECRET: FAKE_APP_SECRET,
      META_WEBHOOK_SKIP_VERIFY: 'false',
    },
  });
  const portGetUnconf = await listenHarness(harnessGetUnconf);
  try {
    const getUnconfRes = await httpRequest(portGetUnconf, {
      method: 'GET',
      path: `${META_WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=x&hub.challenge=y`,
    });
    ok('real listener GET unconfigured token generic 403',
      getUnconfRes.status === 403
      && getUnconfRes.body
      && getUnconfRes.body.error === EXTERNAL_GET_FAILED
      && !leaksDetailedReason(getUnconfRes.body));
  } finally {
    await closeHarness(harnessGetUnconf);
  }

  const harnessAdmit = createFortress15j3OfflineListener({
    env: {
      META_APP_SECRET: FAKE_APP_SECRET,
      META_WHATSAPP_VERIFY_TOKEN: FAKE_VERIFY_TOKEN,
      META_WEBHOOK_SKIP_VERIFY: 'false',
    },
  });
  const portAdmit = await listenHarness(harnessAdmit);
  try {
    const validRes = await httpRequest(portAdmit, {
      method: 'POST',
      path: META_WEBHOOK_PATH,
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': hmacHeader(rawBodySample, FAKE_APP_SECRET),
      },
      rawBody: rawBodySample,
    });
    const getOkRes = await httpRequest(portAdmit, {
      method: 'GET',
      path: `${META_WEBHOOK_PATH}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(FAKE_VERIFY_TOKEN)}&hub.challenge=15l-real-ok`,
    });
    green('AC15L_GREEN_REAL_LISTENER_GET_POST',
      validRes.status === 200
      && validRes.body
      && validRes.body.success === true
      && getOkRes.status === 200
      && getOkRes.bodyRaw === '15l-real-ok'
      && validRes.body.error !== EXTERNAL_POST_FAILED
      && validRes.body.error !== EXTERNAL_POST_UNAVAILABLE,
      `post=${validRes.status} get=${getOkRes.status}`);

    ok('valid HMAC uses raw bytes (header matches Buffer body)',
      verifyMetaHubSignature256(
        rawBodySample,
        hmacHeader(rawBodySample, FAKE_APP_SECRET),
        { META_APP_SECRET: FAKE_APP_SECRET },
      ).verified === true);
  } finally {
    await closeHarness(harnessAdmit);
  }

  console.log('\n── Attack case bind ──');
  ok('attack cases present', Array.isArray(attacks.cases) && attacks.cases.length >= 14);
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
    && evidence.red.passed === runRedIds.length,
    `run=${runRedIds.join(',')} evidence=${evidenceRedIds.join(',')}`);

  ok('evidence GREEN ids match this run',
    evidenceGreenIds.length === runGreenIds.length
    && evidenceGreenIds.every((id, i) => id === runGreenIds[i])
    && greenResults.every((r) => r.ok)
    && evidence.green.total === runGreenIds.length
    && evidence.green.passed === runGreenIds.length,
    `run=${runGreenIds.join(',')} evidence=${evidenceGreenIds.join(',')}`);

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
