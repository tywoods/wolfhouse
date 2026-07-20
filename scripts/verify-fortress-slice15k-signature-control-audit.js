'use strict';

/**
 * verify:fortress-slice15k-signature-control-audit — FORTRESS Slice 15K
 *
 * Read-only reaudit of B01 Meta signature/hub verify and B12 Stripe webhook
 * signature controls. No network, no live DB/Stripe/Meta/Azure, no secret reads.
 * Does not change runtime behavior and does not rewrite 15A historical artifacts.
 *
 * Deterministic: validates committed slice15k-evidence.json; never writes
 * tracked evidence or timestamps (git status must stay clean).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'fortress-tenant-identity');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice15k-contract.json');
const OVERLAY_PATH = path.join(FIXTURE_DIR, 'slice15k-b01-b12-audit-overlay.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice15k-findings.md');
const CONSUMER_PATH = path.join(FIXTURE_DIR, 'slice15k-consumer-matrix.json');
const ATTACK_PATH = path.join(FIXTURE_DIR, 'slice15k-attack-cases.json');
const REMEDIATION_PATH = path.join(FIXTURE_DIR, 'slice15k-b01-remediation-contract.json');
const EVIDENCE_PATH = path.join(FIXTURE_DIR, 'slice15k-evidence.json');
const MATRIX_PATH = path.join(FIXTURE_DIR, 'boundary-matrix.json');
const DOC_PATH = path.join(ROOT, 'docs', 'FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md');

const {
  verifyMetaHubSignature256,
  verifyMetaHubChallenge,
  DEFAULT_META_WHATSAPP_VERIFY_TOKEN,
} = require('./lib/luna-meta-whatsapp-webhook');
const { scanSecretFreeText } = require('./lib/fortress-tenant-identity-boundary');

const MASTER_BASIS = '9a734fa8e989e10800afbdde0ac722187f6db2d5';
const FAKE_APP_SECRET = 'fortress15k_meta_app_secret_SAMPLE_NOT_LIVE';

let pass = 0;
let fail = 0;
const redResults = [];
const greenResults = [];

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
  return passed;
}

function green(id, cond, detail) {
  const passed = ok(`GREEN ${id}`, cond, detail);
  greenResults.push({ id, ok: passed });
  return passed;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
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

console.log('verify:fortress-slice15k-signature-control-audit — FORTRESS Slice 15K\n');

// ── Fixtures ───────────────────────────────────────────────────────────────
ok('F1 contract exists', fs.existsSync(CONTRACT_PATH));
ok('F2 overlay exists', fs.existsSync(OVERLAY_PATH));
ok('F3 findings exists', fs.existsSync(FINDINGS_PATH));
ok('F4 consumer matrix exists', fs.existsSync(CONSUMER_PATH));
ok('F5 attack cases exist', fs.existsSync(ATTACK_PATH));
ok('F6 remediation contract exists', fs.existsSync(REMEDIATION_PATH));

const contract = readJson(CONTRACT_PATH);
const overlay = readJson(OVERLAY_PATH);
const consumer = readJson(CONSUMER_PATH);
const attacks = readJson(ATTACK_PATH);
const remediation = readJson(REMEDIATION_PATH);
const matrix = readJson(MATRIX_PATH);
const findings = readText(FINDINGS_PATH);
const committedEvidence = readJson(EVIDENCE_PATH);
const docText = readText(DOC_PATH);

ok('F7 contract slice 15K + master_basis',
  contract.slice === 'FORTRESS-15K'
  && contract.outcome_id === '15K_signature_control_reaudit'
  && contract.master_basis === MASTER_BASIS
  && contract.live_mutation === false
  && contract.runtime_behavior_changed === false);

ok('F8 overlay preserves historical audit',
  overlay.historical_audit_unchanged === true
  && overlay.live_mutation === false
  && overlay.master_basis === MASTER_BASIS);

ok('F9 historical 15A B01 unproven + B12 runtime-isolated',
  matrix.boundaries.find((b) => b.id === 'B01_meta_whatsapp_signature_ingress').verdict === 'unproven'
  && matrix.boundaries.find((b) => b.id === 'B12_stripe_webhook_signature').verdict === 'proven_isolated_by_runtime');

ok('F10 overlay reaudit verdicts',
  overlay.reaudit.B01_meta_whatsapp_signature_ingress.reaudit_verdict === 'vulnerable'
  && overlay.reaudit.B12_stripe_webhook_signature.reaudit_verdict === 'proven_isolated_by_runtime'
  && contract.reaudit_verdicts.B01_meta_whatsapp_signature_ingress.verdict === 'vulnerable'
  && contract.reaudit_verdicts.B12_stripe_webhook_signature.verdict === 'proven_isolated_by_runtime');

ok('F11 remediation design-only not implemented',
  remediation.status === 'design_only_not_implemented'
  && remediation.next_implementation_slice === 'FORTRESS-15L'
  && remediation.outcome_id === '15L_meta_signature_fail_closed'
  && remediation.live_mutation === false);

ok('F12 findings cite overlay + taxonomy',
  /slice15k-b01-b12-audit-overlay/.test(findings)
  && /vulnerable/.test(findings)
  && /proven_isolated_by_runtime/.test(findings)
  && /15L_meta_signature_fail_closed/.test(findings));

ok('F13 consumer matrix rollup matches contract',
  consumer.boundary_rollup.B01_meta_whatsapp_signature_ingress === 'vulnerable'
  && consumer.boundary_rollup.B12_stripe_webhook_signature === 'proven_isolated_by_runtime'
  && Array.isArray(consumer.control_chain_b01)
  && consumer.control_chain_b01.length >= 6
  && Array.isArray(consumer.control_chain_b12)
  && consumer.control_chain_b12.length >= 5
  && Array.isArray(consumer.config_consumers)
  && consumer.config_consumers.length >= 5);

// ── Secret-free ────────────────────────────────────────────────────────────
console.log('\n── Secret-free scan ──');
for (const rel of [
  'fixtures/fortress-tenant-identity/slice15k-contract.json',
  'fixtures/fortress-tenant-identity/slice15k-b01-b12-audit-overlay.json',
  'fixtures/fortress-tenant-identity/slice15k-consumer-matrix.json',
  'fixtures/fortress-tenant-identity/slice15k-attack-cases.json',
  'fixtures/fortress-tenant-identity/slice15k-b01-remediation-contract.json',
  'fixtures/fortress-tenant-identity/slice15k-findings.md',
  'fixtures/fortress-tenant-identity/slice15k-evidence.json',
  'scripts/verify-fortress-slice15k-signature-control-audit.js',
]) {
  const hits = scanSecretFreeText(readText(path.join(ROOT, rel)));
  ok(`S secret-free ${rel}`, hits.length === 0, hits.join(','));
}

// ── Source loads ───────────────────────────────────────────────────────────
const metaLibSrc = readText(path.join(ROOT, 'scripts/lib/luna-meta-whatsapp-webhook.js'));
const inboundSrc = readText(path.join(ROOT, 'scripts/lib/luna-meta-whatsapp-inbound-process.js'));
const apiSrc = readText(path.join(ROOT, 'scripts/staff-query-api.js'));
const stagingBicep = readText(path.join(ROOT, 'infra/azure/staging/main.bicep'));
const sunsetBicep = readText(path.join(ROOT, 'infra/azure/sunset-staging/main.bicep'));
const envExample = readText(path.join(ROOT, 'infra/.env.example'));
const composeLocal = readText(path.join(ROOT, 'infra/docker-compose.local.yml'));

const metaPostFn = extractFunction(apiSrc, 'handleMetaWhatsAppWebhookPost');
const stripeFn = extractFunction(apiSrc, 'handleStripeWebhook');
const rawBodySample = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');

console.log('\n── B01 Meta signature / hub ──');

red('AC15K_B01_NO_SECRET_SKIP_ADMIT', (() => {
  const r = verifyMetaHubSignature256(rawBodySample, null, {});
  return r.verified === false
    && r.skipped === true
    && /!sigResult\.skipped\s*&&\s*!sigResult\.verified/.test(metaPostFn);
})());

red('AC15K_B01_SECRET_MISSING_HEADER_SKIP_ADMIT', (() => {
  const r = verifyMetaHubSignature256(rawBodySample, null, { META_APP_SECRET: FAKE_APP_SECRET });
  return r.verified === false
    && r.skipped === true
    && r.error === 'missing_signature_header'
    && /!sigResult\.skipped\s*&&\s*!sigResult\.verified/.test(metaPostFn);
})());

red('AC15K_B01_DEFAULT_VERIFY_TOKEN', (() => {
  const hub = verifyMetaHubChallenge({
    'hub.mode': 'subscribe',
    'hub.verify_token': DEFAULT_META_WHATSAPP_VERIFY_TOKEN,
    'hub.challenge': '15k-challenge',
  }, {});
  return hub.ok === true
    && hub.status === 200
    && /DEFAULT_META_WHATSAPP_VERIFY_TOKEN\s*=\s*'wolfhouse_verify_token'/.test(metaLibSrc)
    && /return DEFAULT_META_WHATSAPP_VERIFY_TOKEN/.test(metaLibSrc);
})());

red('AC15K_B01_IAC_NO_META_APP_SECRET',
  !/META_APP_SECRET/.test(stagingBicep)
  && !/META_APP_SECRET/.test(sunsetBicep)
  && /META_WHATSAPP_TOKEN/.test(stagingBicep));

green('AC15K_B01_MISMATCH_REJECT', (() => {
  const r = verifyMetaHubSignature256(
    rawBodySample,
    `sha256=${'00'.repeat(32)}`,
    { META_APP_SECRET: FAKE_APP_SECRET },
  );
  return r.verified === false && r.skipped === false && r.error === 'signature_mismatch';
})());

green('AC15K_B01_VALID_HMAC_ACCEPT', (() => {
  const digest = crypto.createHmac('sha256', FAKE_APP_SECRET).update(rawBodySample).digest('hex');
  const r = verifyMetaHubSignature256(
    rawBodySample,
    `sha256=${digest}`,
    { META_APP_SECRET: FAKE_APP_SECRET },
  );
  return r.verified === true && r.skipped === false;
})());

green('AC15K_B01_HUB_WRONG_TOKEN_403', (() => {
  const hub = verifyMetaHubChallenge({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'wrong_token_SAMPLE',
    'hub.challenge': '15k-challenge',
  }, { META_WHATSAPP_VERIFY_TOKEN: 'expected_token_SAMPLE' });
  return hub.ok === false && hub.status === 403 && hub.error === 'invalid_verify_token';
})());

ok('B01 raw body before signature in handler',
  metaPostFn.indexOf('readBodyRaw') >= 0
  && metaPostFn.indexOf('readBodyRaw') < metaPostFn.indexOf('verifyMetaHubSignature256')
  && metaPostFn.indexOf('verifyMetaHubSignature256') < metaPostFn.indexOf('JSON.parse')
  && metaPostFn.indexOf('verifyMetaHubSignature256') < metaPostFn.indexOf('processMetaWhatsAppWebhookPostEntry'));

ok('B01 timingSafeEqual present in helper',
  /timingSafeEqual/.test(metaLibSrc)
  && /createHmac\('sha256'/.test(metaLibSrc));

ok('B01 PostEntry is post-admit consumer',
  /processMetaWhatsAppWebhookPostEntry/.test(inboundSrc)
  && /processMetaWhatsAppWebhookPostEntry/.test(metaPostFn));

console.log('\n── B12 Stripe webhook signature ──');

green('AC15K_B12_MISSING_SECRET_503',
  /STRIPE_WEBHOOK_SECRET not configured/.test(stripeFn)
  && /no_db_write:\s*true/.test(stripeFn)
  && /sendJSON\(res,\s*503/.test(stripeFn)
  && stripeFn.indexOf('STRIPE_WEBHOOK_SECRET not configured')
    < stripeFn.indexOf('resolveStripeWebhookExpectedClientSlug'));

green('AC15K_B12_RAW_BODY_BEFORE_CONSTRUCT', (() => {
  const iRaw = stripeFn.indexOf('readBodyRaw');
  const iSkip = stripeFn.indexOf('STRIPE_WEBHOOK_SKIP_VERIFY');
  const iConstruct = stripeFn.indexOf('constructEvent');
  return iRaw >= 0 && iSkip > iRaw && iConstruct > iSkip;
})());

green('AC15K_B12_IAC_SKIP_FALSE',
  /name:\s*'STRIPE_WEBHOOK_SKIP_VERIFY',\s*value:\s*'false'/.test(stagingBicep)
  && /name:\s*'STRIPE_WEBHOOK_SKIP_VERIFY',\s*value:\s*'false'/.test(sunsetBicep)
  && /name:\s*'STRIPE_WEBHOOK_SECRET',\s*secretRef:\s*'stripe-webhook-secret'/.test(stagingBicep)
  && /name:\s*'STRIPE_WEBHOOK_SECRET',\s*secretRef:\s*'stripe-webhook-secret'/.test(sunsetBicep)
  && /STRIPE_WEBHOOK_SKIP_VERIFY=false/.test(envExample)
  && /STRIPE_WEBHOOK_SKIP_VERIFY: \$\{STRIPE_WEBHOOK_SKIP_VERIFY:-false\}/.test(composeLocal));

red('AC15K_B12_SKIP_NO_STARTUP_REFUSE', (() => {
  const hasSkip = /STRIPE_WEBHOOK_SKIP_VERIFY\s*===\s*'true'/.test(apiSrc);
  // Executable refuse only — comments saying "Never true in production" do not count.
  const executableRefuse = /if\s*\([^)]*STRIPE_WEBHOOK_SKIP_VERIFY[^)]*\)\s*\{[\s\S]{0,200}(throw new Error|process\.exit\(|refuseStartup)/.test(apiSrc)
    || /if\s*\([^)]*NODE_ENV[^)]*production[^)]*\)[\s\S]{0,160}STRIPE_WEBHOOK_SKIP_VERIFY[\s\S]{0,120}(throw new Error|process\.exit\()/.test(apiSrc);
  return hasSkip && !executableRefuse
    && contract.reaudit_verdicts.B12_stripe_webhook_signature.verdict === 'proven_isolated_by_runtime';
})());

ok('B12 route public POST before auth catch-all',
  /pathname === '\/staff\/stripe\/webhook'/.test(apiSrc)
  && /No session auth — identity via Stripe HMAC/.test(apiSrc));

ok('B12 skip flag not hardcoded true in source',
  !/STRIPE_WEBHOOK_SKIP_VERIFY\s*=\s*['"]true['"]/.test(apiSrc)
  && /STRIPE_WEBHOOK_SKIP_VERIFY === 'true'/.test(apiSrc));

console.log('\n── Historical 15A preservation ──');

green('AC15K_HISTORICAL_15A_UNCHANGED',
  matrix.boundaries.find((b) => b.id === 'B01_meta_whatsapp_signature_ingress').verdict === 'unproven'
  && matrix.boundaries.find((b) => b.id === 'B12_stripe_webhook_signature').verdict === 'proven_isolated_by_runtime'
  && /B01 \| Meta WhatsApp signature \/ hub verify \| `unproven`/.test(docText)
  && /B12 \| Stripe webhook signature \| `proven_isolated_by_runtime`/.test(docText));

ok('Attack case ids covered',
  Array.isArray(attacks.cases)
  && attacks.cases.length >= 12
  && attacks.cases.every((c) => typeof c.id === 'string' && c.color));

ok('Remediation targets B01 only',
  remediation.boundary_id === 'B01_meta_whatsapp_signature_ingress'
  && /missing_signature_header/.test(JSON.stringify(remediation))
  && /META_APP_SECRET/.test(JSON.stringify(remediation)));

// ── Evidence: validate committed artifact; do not rewrite ───────────────────
console.log('\n── Evidence (read-only) ──');
ok('evidence exists (not rewritten by verifier)', fs.existsSync(EVIDENCE_PATH));
ok('evidence slice + master_basis + reaudit verdicts',
  committedEvidence.slice === 'FORTRESS-15K'
  && committedEvidence.master_basis === MASTER_BASIS
  && committedEvidence.live_mutation === false
  && committedEvidence.runtime_behavior_changed === false
  && committedEvidence.reaudit_verdicts
  && committedEvidence.reaudit_verdicts.B01_meta_whatsapp_signature_ingress.verdict === 'vulnerable'
  && committedEvidence.reaudit_verdicts.B12_stripe_webhook_signature.verdict === 'proven_isolated_by_runtime'
  && committedEvidence.remediation_next_gate
    === 'FORTRESS-15L / 15L_meta_signature_fail_closed');

const runRedIds = redResults.map((r) => r.id);
const runGreenIds = greenResults.map((r) => r.id);
const evidenceRedIds = ((committedEvidence.red && committedEvidence.red.cases) || []).map((c) => c.id);
const evidenceGreenIds = ((committedEvidence.green && committedEvidence.green.cases) || []).map((c) => c.id);

ok('evidence RED ids match this run',
  JSON.stringify(runRedIds) === JSON.stringify(evidenceRedIds));
ok('evidence GREEN ids match this run',
  JSON.stringify(runGreenIds) === JSON.stringify(evidenceGreenIds));
ok('all RED/GREEN passed',
  redResults.every((r) => r.ok) && greenResults.every((r) => r.ok));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('OK — Slice 15K signature-control reaudit green (audit only, zero live mutation).');
