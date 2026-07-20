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
 *
 * Completeness: derives signature-symbol occurrences from scoped paths, requires
 * every mapped owner, rejects unmapped/stale entries, and executes/binds every
 * attack case by id (not mere ID counts).
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
} = require('./lib/luna-meta-whatsapp-webhook');
const { scanSecretFreeText } = require('./lib/fortress-tenant-identity-boundary');

const MASTER_BASIS = '9a734fa8e989e10800afbdde0ac722187f6db2d5';
const FAKE_APP_SECRET = 'fortress15k_meta_app_secret_SAMPLE_NOT_LIVE';
/** Historical 15K hardcoded default token (removed from runtime by 15L). */
const HISTORICAL_DEFAULT_META_WHATSAPP_VERIFY_TOKEN = 'wolfhouse_verify_token';

const SYMBOLS = [
  'STRIPE_WEBHOOK_SKIP_VERIFY',
  'STRIPE_WEBHOOK_SECRET',
  'META_APP_SECRET',
  'META_WHATSAPP_VERIFY_TOKEN',
  'DEFAULT_META_WHATSAPP_VERIFY_TOKEN',
];

const REMEDIATION_15L_OVERLAY_PATH = path.join(FIXTURE_DIR, 'slice15l-b01-remediation-overlay.json');
const has15lRemediation = fs.existsSync(REMEDIATION_15L_OVERLAY_PATH);
const overlay15l = has15lRemediation ? JSON.parse(fs.readFileSync(REMEDIATION_15L_OVERLAY_PATH, 'utf8')) : null;

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

function lineOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function lineAt(offsets, index) {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (offsets[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Assign service/container context for multi-consumer files. */
function serviceAt(relPath, text, index) {
  const before = text.slice(0, index);
  if (relPath === 'infra/docker-compose.local.yml') {
    const matches = [...before.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)];
    return matches.length ? matches[matches.length - 1][1] : null;
  }
  if (relPath.endsWith('main.bicep')) {
    const matches = [...before.matchAll(/name:\s*'([^']+)'/g)];
    // Prefer nearest container name among known consumers.
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const name = matches[i][1];
      if (
        name === 'staff-api'
        || name === 'n8n-main'
        || name === 'n8n-worker'
        || name === 'luna-sunset-staging-staff-api'
      ) {
        return name;
      }
    }
  }
  return null;
}

function deriveOccurrences(scopedPaths) {
  const occ = [];
  for (const rel of scopedPaths) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const text = readText(abs);
    const offsets = lineOffsets(text);
    for (const symbol of SYMBOLS) {
      const re = new RegExp(symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      let m;
      while ((m = re.exec(text)) !== null) {
        occ.push({
          path: rel,
          symbol,
          line: lineAt(offsets, m.index),
          service: serviceAt(rel, text, m.index),
          kind: 'symbol',
        });
      }
    }
  }
  return occ;
}

function occurrenceKey(o) {
  return `${o.path}|${o.symbol}|${o.service || ''}`;
}

function ownerCoversOccurrence(owner, o) {
  if (owner.path !== o.path) return false;
  if (owner.service != null && owner.service !== o.service) return false;
  if (Array.isArray(owner.symbols) && owner.symbols.includes(o.symbol)) return true;
  return false;
}

function extractServiceBlock(text, serviceName, relPath) {
  if (relPath === 'infra/docker-compose.local.yml') {
    const re = new RegExp(`^ {2}${serviceName}:\\s*$`, 'm');
    const start = text.search(re);
    if (start < 0) return '';
    const rest = text.slice(start + 1);
    const next = rest.search(/^ {2}[a-z0-9-]+:\s*$/m);
    return text.slice(start, next < 0 ? text.length : start + 1 + next);
  }
  if (relPath.endsWith('main.bicep')) {
    const needle = `name: '${serviceName}'`;
    const idx = text.indexOf(needle);
    if (idx < 0) return '';
    // Bounded window after container name (staging Bicep has long corrupted comments).
    return text.slice(idx, idx + 12000);
  }
  return text;
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
  && remediation.live_mutation === false
  && remediation.boundary_id === 'B01_meta_whatsapp_signature_ingress');

ok('F12 findings cite overlay + taxonomy + completeness',
  /slice15k-b01-b12-audit-overlay/.test(findings)
  && /vulnerable/.test(findings)
  && /proven_isolated_by_runtime/.test(findings)
  && /15L_meta_signature_fail_closed/.test(findings)
  && /source_derived_scoped_occurrence_inventory/.test(findings)
  && /n8n-main/.test(findings)
  && /n8n-worker/.test(findings));

ok('F13 consumer matrix rollup matches contract',
  consumer.boundary_rollup.B01_meta_whatsapp_signature_ingress === 'vulnerable'
  && consumer.boundary_rollup.B12_stripe_webhook_signature === 'proven_isolated_by_runtime'
  && Array.isArray(consumer.control_chain_b01)
  && consumer.control_chain_b01.length >= 6
  && Array.isArray(consumer.control_chain_b12)
  && consumer.control_chain_b12.length >= 5
  && Array.isArray(consumer.config_consumers)
  && consumer.config_consumers.length >= 10
  && consumer.signature_config_owners
  && Array.isArray(consumer.signature_config_owners.owners)
  && consumer.signature_config_owners.owners.length >= 14);

ok('F14 completeness method + 15L owner reconciliation',
  contract.completeness_method === 'source_derived_scoped_occurrence_inventory'
  && consumer.signature_config_owners.completeness.method
    === 'source_derived_scoped_occurrence_inventory'
  && consumer.signature_config_owners.completeness.require_every_mapped_owner === true
  && consumer.signature_config_owners.completeness.reject_unmapped_occurrences === true
  && consumer.signature_config_owners.completeness.reject_stale_owners === true
  && consumer.remediation_owner_reconciliation_15l.must_match_remediation_contract === true
  && JSON.stringify(consumer.remediation_owner_reconciliation_15l.owner_files)
    === JSON.stringify(remediation.owner_files));

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

const stagingStaffBlock = extractServiceBlock(stagingBicep, 'staff-api', 'infra/azure/staging/main.bicep');
const stagingN8nMainBlock = extractServiceBlock(stagingBicep, 'n8n-main', 'infra/azure/staging/main.bicep');
const stagingN8nWorkerBlock = extractServiceBlock(stagingBicep, 'n8n-worker', 'infra/azure/staging/main.bicep');
const sunsetStaffBlock = extractServiceBlock(
  sunsetBicep,
  'luna-sunset-staging-staff-api',
  'infra/azure/sunset-staging/main.bicep',
);
const composeN8nBlock = extractServiceBlock(composeLocal, 'n8n', 'infra/docker-compose.local.yml');
const composeWorkerBlock = extractServiceBlock(composeLocal, 'n8n-worker', 'infra/docker-compose.local.yml');

console.log('\n── B01 Meta signature / hub ──');
if (has15lRemediation) {
  ok('15L remediation overlay present (historical 15K RED cases assert remediating posture)',
    overlay15l
    && overlay15l.status === 'remediated'
    && overlay15l.historical_audit_unchanged === true
    && overlay15l.boundary_id === 'B01_meta_whatsapp_signature_ingress');
}

red('AC15K_B01_NO_SECRET_SKIP_ADMIT', (() => {
  if (has15lRemediation) {
    const r = verifyMetaHubSignature256(rawBodySample, null, {});
    return r.verified === false
      && r.skipped === false
      && r.error === 'app_secret_unconfigured'
      && /decideMetaWhatsAppWebhookPostAdmit/.test(metaPostFn)
      && !/!sigResult\.skipped\s*&&\s*!sigResult\.verified/.test(metaPostFn);
  }
  const r = verifyMetaHubSignature256(rawBodySample, null, {});
  return r.verified === false
    && r.skipped === true
    && /!sigResult\.skipped\s*&&\s*!sigResult\.verified/.test(metaPostFn);
})());

red('AC15K_B01_SECRET_MISSING_HEADER_SKIP_ADMIT', (() => {
  if (has15lRemediation) {
    const r = verifyMetaHubSignature256(rawBodySample, null, { META_APP_SECRET: FAKE_APP_SECRET });
    return r.verified === false
      && r.skipped === false
      && r.error === 'missing_signature_header'
      && /decideMetaWhatsAppWebhookPostAdmit/.test(metaPostFn);
  }
  const r = verifyMetaHubSignature256(rawBodySample, null, { META_APP_SECRET: FAKE_APP_SECRET });
  return r.verified === false
    && r.skipped === true
    && r.error === 'missing_signature_header'
    && /!sigResult\.skipped\s*&&\s*!sigResult\.verified/.test(metaPostFn);
})());

red('AC15K_B01_DEFAULT_VERIFY_TOKEN', (() => {
  if (has15lRemediation) {
    const hub = verifyMetaHubChallenge({
      'hub.mode': 'subscribe',
      'hub.verify_token': HISTORICAL_DEFAULT_META_WHATSAPP_VERIFY_TOKEN,
      'hub.challenge': '15k-challenge',
    }, {});
    return hub.ok === false
      && hub.status === 403
      && hub.error === 'verify_token_unconfigured'
      && !/DEFAULT_META_WHATSAPP_VERIFY_TOKEN\s*=/.test(metaLibSrc)
      && !/return DEFAULT_META_WHATSAPP_VERIFY_TOKEN/.test(metaLibSrc);
  }
  const hub = verifyMetaHubChallenge({
    'hub.mode': 'subscribe',
    'hub.verify_token': HISTORICAL_DEFAULT_META_WHATSAPP_VERIFY_TOKEN,
    'hub.challenge': '15k-challenge',
  }, {});
  return hub.ok === true
    && hub.status === 200
    && /DEFAULT_META_WHATSAPP_VERIFY_TOKEN\s*=\s*'wolfhouse_verify_token'/.test(metaLibSrc)
    && /return DEFAULT_META_WHATSAPP_VERIFY_TOKEN/.test(metaLibSrc);
})());

red('AC15K_B01_IAC_NO_META_APP_SECRET',
  has15lRemediation
    ? (/META_APP_SECRET/.test(stagingBicep)
      && /META_APP_SECRET/.test(sunsetBicep)
      && /META_WHATSAPP_VERIFY_TOKEN/.test(stagingBicep)
      && /META_WHATSAPP_VERIFY_TOKEN/.test(sunsetBicep)
      && /secretRef:\s*'meta-app-secret'/.test(stagingStaffBlock)
      && /secretRef:\s*'meta-app-secret'/.test(sunsetStaffBlock)
      && /META_WHATSAPP_TOKEN/.test(stagingBicep))
    : (!/META_APP_SECRET/.test(stagingBicep)
      && !/META_APP_SECRET/.test(sunsetBicep)
      && !/META_WHATSAPP_VERIFY_TOKEN/.test(stagingBicep)
      && !/META_WHATSAPP_VERIFY_TOKEN/.test(sunsetBicep)
      && /META_WHATSAPP_TOKEN/.test(stagingBicep)));

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
  /STRIPE_WEBHOOK_SKIP_VERIFY/.test(stagingStaffBlock)
  && /value:\s*'false'/.test(stagingStaffBlock)
  && /STRIPE_WEBHOOK_SECRET/.test(stagingStaffBlock)
  && /secretRef:\s*'stripe-webhook-secret'/.test(stagingStaffBlock)
  && /STRIPE_WEBHOOK_SKIP_VERIFY/.test(stagingN8nMainBlock)
  && /value:\s*'false'/.test(stagingN8nMainBlock)
  && !/STRIPE_WEBHOOK_SECRET/.test(stagingN8nMainBlock)
  && !/STRIPE_WEBHOOK_SKIP_VERIFY/.test(stagingN8nWorkerBlock)
  && !/STRIPE_WEBHOOK_SECRET/.test(stagingN8nWorkerBlock)
  && /STRIPE_WEBHOOK_SKIP_VERIFY/.test(sunsetStaffBlock)
  && /value:\s*'false'/.test(sunsetStaffBlock)
  && /secretRef:\s*'stripe-webhook-secret'/.test(sunsetStaffBlock)
  && /STRIPE_WEBHOOK_SKIP_VERIFY=false/.test(envExample)
  && /STRIPE_WEBHOOK_SKIP_VERIFY: \$\{STRIPE_WEBHOOK_SKIP_VERIFY:-false\}/.test(composeN8nBlock)
  && /STRIPE_WEBHOOK_SECRET: \$\{STRIPE_WEBHOOK_SECRET\}/.test(composeN8nBlock)
  && /STRIPE_WEBHOOK_SKIP_VERIFY: \$\{STRIPE_WEBHOOK_SKIP_VERIFY:-false\}/.test(composeWorkerBlock)
  && /STRIPE_WEBHOOK_SECRET: \$\{STRIPE_WEBHOOK_SECRET\}/.test(composeWorkerBlock));

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

ok('Remediation targets B01 only',
  remediation.boundary_id === 'B01_meta_whatsapp_signature_ingress'
  && /missing_signature_header/.test(JSON.stringify(remediation))
  && /META_APP_SECRET/.test(JSON.stringify(remediation))
  && !/implement.*STRIPE_WEBHOOK_SKIP_VERIFY.*startup/.test(JSON.stringify(remediation.required_controls || [])));

// ── Source-derived signature config-owner inventory ─────────────────────────
console.log('\n── Signature config-owner inventory (source-derived) ──');

const sco = consumer.signature_config_owners;
const scopedPaths = sco.completeness.scoped_paths;
const owners = sco.owners;
const absentOwners = sco.absent_owners || [];

ok('scoped paths exist on disk',
  scopedPaths.every((p) => fs.existsSync(path.join(ROOT, p))),
  scopedPaths.filter((p) => !fs.existsSync(path.join(ROOT, p))).join(','));

ok('symbols list matches canonical five',
  JSON.stringify(sco.completeness.symbols) === JSON.stringify(SYMBOLS));

ok('consumer implications distinguish staff_api / n8n_main / n8n_worker',
  sco.consumer_implications
  && /Staff API|B01|B12/.test(sco.consumer_implications.staff_api)
  && /n8n-main|legacy/i.test(sco.consumer_implications.n8n_main)
  && /n8n-worker|compose|Azure/i.test(sco.consumer_implications.n8n_worker));

const derived = deriveOccurrences(scopedPaths);

// Hermes default-token uses match_patterns (not META_* symbols).
const hermesOwner = owners.find((o) => o.id === 'OWN_HERMES_DEFAULT_VERIFY_TOKEN');
const hermesText = hermesOwner ? readText(path.join(ROOT, hermesOwner.path)) : '';
const hermesPatternHits = hermesOwner
  ? (hermesOwner.match_patterns || []).filter((pat) => hermesText.includes(pat))
  : [];
ok('Hermes default-token patterns present',
  hermesOwner
  && hermesPatternHits.length === (hermesOwner.match_patterns || []).length,
  hermesPatternHits.join(','));

const coveredKeys = new Set();
const staleOwners = [];
for (const owner of owners) {
  if (owner.id === 'OWN_HERMES_DEFAULT_VERIFY_TOKEN') {
    if (hermesPatternHits.length === 0) staleOwners.push(owner.id);
    continue;
  }
  // FORTRESS 15L removes DEFAULT_META_WHATSAPP_VERIFY_TOKEN from the Meta helper.
  // Historical owner inventory still lists it; when remediated, require remaining Meta symbols only.
  const required = has15lRemediation && owner.id === 'OWN_META_HELPER_RUNTIME'
    ? (owner.symbols || []).filter((sym) => sym !== 'DEFAULT_META_WHATSAPP_VERIFY_TOKEN')
    : (owner.symbols || []);
  const hits = derived.filter((o) => ownerCoversOccurrence(owner, o));
  const missingSyms = required.filter((sym) => !hits.some((h) => h.symbol === sym));
  if (hits.length === 0 || missingSyms.length > 0) {
    staleOwners.push(`${owner.id}[missing:${missingSyms.join('|') || 'all'}]`);
  } else {
    for (const h of hits) coveredKeys.add(occurrenceKey(h));
  }
}

ok('every mapped owner has derived occurrence(s)',
  staleOwners.length === 0,
  staleOwners.join(','));

const unmapped = derived.filter((o) => {
  if (owners.some((owner) => {
    if (owner.id === 'OWN_HERMES_DEFAULT_VERIFY_TOKEN') return false;
    return ownerCoversOccurrence(owner, o);
  })) {
    return false;
  }
  // File-header / comment mentions (service null) are covered when any same-path
  // owner already inventories that symbol for a concrete consumer service.
  if (o.service == null) {
    const samePathOwner = owners.some((owner) =>
      owner.path === o.path
      && Array.isArray(owner.symbols)
      && owner.symbols.includes(o.symbol));
    if (samePathOwner) return false;
  }
  // FORTRESS 15L remediating Meta signature wiring (historical 15K listed these as absent).
  if (has15lRemediation
    && (o.symbol === 'META_APP_SECRET' || o.symbol === 'META_WHATSAPP_VERIFY_TOKEN')
    && (
      (o.path === 'infra/azure/staging/main.bicep' && o.service === 'staff-api')
      || (o.path === 'infra/azure/sunset-staging/main.bicep'
        && o.service === 'luna-sunset-staging-staff-api')
      || (o.path === 'infra/.env.example' && o.service == null)
      || (o.path === 'scripts/staff-query-api.js' && o.service == null)
      || (o.path === 'scripts/lib/luna-meta-whatsapp-webhook.js' && o.service == null)
    )) {
    return false;
  }
  return true;
});

ok('no unmapped derived occurrences',
  unmapped.length === 0,
  unmapped.map((o) => `${o.path}:${o.line}:${o.symbol}@${o.service || '-'}`).join(','));

const absentFails = [];
for (const abs of absentOwners) {
  // 15L remediates Meta signature absences on Staff API Bicep + .env.example.
  if (has15lRemediation && (
    abs.id === 'ABS_STAGING_BICEP_META_SIGNATURE'
    || abs.id === 'ABS_SUNSET_BICEP_META_SIGNATURE'
    || abs.id === 'ABS_ENV_EXAMPLE_META_SIGNATURE'
  )) {
    const text = readText(path.join(ROOT, abs.path));
    const block = abs.service
      ? extractServiceBlock(text, abs.service, abs.path)
      : text;
    const missing = (abs.symbols || []).filter((sym) => !block.includes(sym));
    if (missing.length > 0) {
      absentFails.push(`${abs.id}:remediation_incomplete:${missing.join('|')}`);
    }
    continue;
  }
  const text = readText(path.join(ROOT, abs.path));
  if (abs.service) {
    const block = extractServiceBlock(text, abs.service, abs.path);
    for (const sym of abs.symbols) {
      if (block.includes(sym)) absentFails.push(`${abs.id}:${sym}:present_in_${abs.service}`);
    }
  } else {
    for (const sym of abs.symbols) {
      if (text.includes(sym)) absentFails.push(`${abs.id}:${sym}:present`);
    }
  }
}
ok('absent_owners remain absent in scoped source',
  absentFails.length === 0,
  absentFails.join(','));

ok('config_consumers enumerate staff_api + n8n_main + n8n_worker separately',
  consumer.config_consumers.some((c) => c.consumer === 'staff_api' && /staging/.test(c.path || '') && c.service === 'staff-api')
  && consumer.config_consumers.some((c) => c.consumer === 'n8n_main' && c.service === 'n8n-main')
  && consumer.config_consumers.some((c) => c.consumer === 'n8n_worker' && c.service === 'n8n-worker')
  && consumer.config_consumers.some((c) => c.consumer === 'n8n_main' && c.service === 'n8n')
  && consumer.config_consumers.some((c) => c.consumer === 'n8n_worker' && c.path === 'infra/docker-compose.local.yml'));

// ── Attack case execute/bind (not mere ID counts) ───────────────────────────
console.log('\n── Attack case execute/bind ──');

ok('attack cases array present', Array.isArray(attacks.cases) && attacks.cases.length >= 12);

const unboundAttacks = [];
const colorMismatches = [];
for (const c of attacks.cases) {
  const bound = attackBindings.get(c.id);
  if (!bound) {
    unboundAttacks.push(c.id);
    continue;
  }
  if (bound.color !== c.color) colorMismatches.push(`${c.id}:${c.color}!=${bound.color}`);
  ok(`attack bind ${c.id}`, bound.ok === true && bound.color === c.color,
    bound.ok ? `color ${bound.color}` : 'execution failed');
}
ok('no unbound attack cases', unboundAttacks.length === 0, unboundAttacks.join(','));
ok('no attack color mismatches', colorMismatches.length === 0, colorMismatches.join(','));

const orphanExecutions = [...attackBindings.keys()].filter(
  (id) => !attacks.cases.some((c) => c.id === id),
);
ok('no orphan RED/GREEN executions outside attack-cases',
  orphanExecutions.length === 0,
  orphanExecutions.join(','));

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

ok('evidence notes completeness proof',
  Array.isArray(committedEvidence.notes)
  && committedEvidence.notes.some((n) => /source.derived|config.owner|n8n/i.test(n)));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('OK — Slice 15K signature-control reaudit green (audit only, zero live mutation).');
