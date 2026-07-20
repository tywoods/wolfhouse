'use strict';

/**
 * verify:fortress-slice15e-bot-principal-tenant-bind — FORTRESS Slice 15E
 *
 * Offline RED/GREEN tests for authoritative Staff API bot-token principal
 * tenant binding (closes B06). No network, no live DB/Stripe/WhatsApp/deploy.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'fortress-tenant-identity');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice15e-contract.json');
const OVERLAY_PATH = path.join(FIXTURE_DIR, 'slice15e-b06-remediation-overlay.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice15e-findings.md');
const EVIDENCE_PATH = path.join(FIXTURE_DIR, 'slice15e-evidence.json');
const MATRIX_PATH = path.join(FIXTURE_DIR, 'boundary-matrix.json');
const ATTACK_PATH = path.join(FIXTURE_DIR, 'attack-cases.json');
const DOC_PATH = path.join(ROOT, 'docs', 'FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md');

const {
  resolveStaffBotPrincipalClientSlug,
  buildStaffBotAuthPrincipal,
  BOT_STAFF_USER_ID,
} = require('./lib/staff-bot-principal-tenant-config');
const {
  getAccessibleClientSlugs,
  userCanAccessClient,
  listBaselineClients,
} = require('./lib/staff-portal-clients');
const { scanSecretFreeText } = require('./lib/fortress-tenant-identity-boundary');

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

const TENANT_WH = 'wolfhouse-somo';
const TENANT_SU = 'sunset';
const BASELINE = listBaselineClients().map((c) => c.slug);

console.log('verify:fortress-slice15e-bot-principal-tenant-bind — FORTRESS Slice 15E\n');

// ── Artifacts ───────────────────────────────────────────────────────────────
console.log('── Artifacts ──');
const contract = readJson(CONTRACT_PATH);
const overlay = readJson(OVERLAY_PATH);
const findings = fs.readFileSync(FINDINGS_PATH, 'utf8');
const matrix = readJson(MATRIX_PATH);
const attacks = readJson(ATTACK_PATH);
const doc = fs.readFileSync(DOC_PATH, 'utf8');
const staffApi = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
const portalClients = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-portal-clients.js'), 'utf8');
const botConfigSrc = fs.readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'staff-bot-principal-tenant-config.js'),
  'utf8',
);

ok('contract slice 15E + B06',
  contract.slice === 'FORTRESS-15E'
  && contract.boundary_id === 'B06_staff_bot_auth_principal'
  && contract.outcome_id === '15E_staff_bot_auth_principal_tenant_bind'
  && contract.live_mutation === false);
ok('overlay remediated B06 historical untouched',
  overlay.boundary_id === 'B06_staff_bot_auth_principal'
  && overlay.status === 'remediated'
  && overlay.historical_audit_unchanged === true
  && Array.isArray(overlay.historical_artifacts)
  && overlay.historical_artifacts.includes('fixtures/fortress-tenant-identity/boundary-matrix.json'));
ok('findings cite B06 + B07 residual',
  /B06/.test(findings) && /B07/.test(findings) && /LUNA_BOT_CLIENT_SLUG/.test(findings));
ok('historical matrix still marks B06 vulnerable',
  (matrix.boundaries || []).some((b) => b.id === 'B06_staff_bot_auth_principal' && b.verdict === 'vulnerable'));
ok('historical attack case AC_BOT_ACL_EMAILLESS retained',
  (attacks.cases || []).some((c) => c.id === 'AC_BOT_ACL_EMAILLESS_ALL_CLIENTS' && c.color === 'RED'));
ok('historical doc still cites B06 vulnerable',
  /B06/.test(doc) && /vulnerable/.test(doc));
ok('config module has no hardcoded tenant slug literals',
  !/wolfhouse-somo/.test(botConfigSrc)
  && !/'sunset'/.test(botConfigSrc)
  && !/"sunset"/.test(botConfigSrc));

// ── Config RED/GREEN ────────────────────────────────────────────────────────
console.log('\n── Config resolve ──');

red('missing_runtime_slug', (() => {
  const r = resolveStaffBotPrincipalClientSlug({});
  return !r.ok && r.reason === 'missing_runtime_client_slug' && r.client_slug == null;
})());

red('conflicting_runtime_slugs', (() => {
  const r = resolveStaffBotPrincipalClientSlug({
    LUNA_BOT_CLIENT_SLUG: TENANT_WH,
    DEFAULT_CLIENT_SLUG: TENANT_SU,
  });
  return !r.ok && r.reason === 'conflicting_runtime_client_slugs';
})());

red('invalid_runtime_slug', (() => {
  const r = resolveStaffBotPrincipalClientSlug({
    LUNA_BOT_CLIENT_SLUG: 'NOT A SLUG!!',
  });
  return !r.ok && r.reason === 'invalid_runtime_client_slug';
})());

red('unknown_runtime_slug', (() => {
  const r = buildStaffBotAuthPrincipal(
    { LUNA_BOT_CLIENT_SLUG: 'tenant-not-in-baseline-sample' },
    { knownClientSlugs: BASELINE },
  );
  return !r.ok && r.reason === 'unknown_runtime_client_slug' && r.user == null;
})());

green('luna_bot_client_slug', (() => {
  const r = resolveStaffBotPrincipalClientSlug({ LUNA_BOT_CLIENT_SLUG: TENANT_SU });
  return r.ok && r.client_slug === TENANT_SU && r.source === 'LUNA_BOT_CLIENT_SLUG';
})());

green('default_client_slug_compat', (() => {
  const r = resolveStaffBotPrincipalClientSlug({ DEFAULT_CLIENT_SLUG: TENANT_WH });
  return r.ok && r.client_slug === TENANT_WH && r.source === 'DEFAULT_CLIENT_SLUG';
})());

// ── ACL RED/GREEN ───────────────────────────────────────────────────────────
console.log('\n── Bot principal ACL ──');

red('unbound_bot_acl_empty', (() => {
  const slugs = getAccessibleClientSlugs({
    role: 'operator',
    staff_user_id: BOT_STAFF_USER_ID,
  });
  return Array.isArray(slugs)
    && slugs.length === 0
    && !slugs.includes(TENANT_WH)
    && !slugs.includes(TENANT_SU);
})());

const botWh = buildStaffBotAuthPrincipal(
  { LUNA_BOT_CLIENT_SLUG: TENANT_WH },
  { knownClientSlugs: BASELINE },
).user;
const botSu = buildStaffBotAuthPrincipal(
  { LUNA_BOT_CLIENT_SLUG: TENANT_SU },
  { knownClientSlugs: BASELINE },
).user;

red('bot_wolfhouse_denied_sunset', (() => {
  const slugs = getAccessibleClientSlugs(botWh);
  return userCanAccessClient(botWh, TENANT_WH)
    && !userCanAccessClient(botWh, TENANT_SU)
    && slugs.length === 1
    && slugs[0] === TENANT_WH;
})());

red('bot_sunset_denied_wolfhouse', (() => {
  const slugs = getAccessibleClientSlugs(botSu);
  return userCanAccessClient(botSu, TENANT_SU)
    && !userCanAccessClient(botSu, TENANT_WH)
    && slugs.length === 1
    && slugs[0] === TENANT_SU;
})());

green('bot_wolfhouse_allows_wolfhouse', userCanAccessClient(botWh, TENANT_WH));
green('bot_sunset_allows_sunset', userCanAccessClient(botSu, TENANT_SU));

green('staff_session_email_acl_preserved', (() => {
  // Session-shaped user: has email + login client_slug. Must not be forced to
  // single-tenant solely because client_slug is present (bot-only bind path).
  const accessPath = path.join(ROOT, 'config', 'clients', 'staff-portal-access.json');
  const cfg = JSON.parse(fs.readFileSync(accessPath, 'utf8'));
  const allEmails = (cfg.all_clients_emails || []).map((e) => String(e).toLowerCase());
  const sampleEmail = allEmails[0] || 'fortress-15e-session-sample@example.com';
  const sessionUser = {
    role: 'operator',
    staff_user_id: '11111111-1111-1111-1111-111111111111',
    email: sampleEmail,
    client_slug: TENANT_WH,
  };
  const slugs = getAccessibleClientSlugs(sessionUser);
  if (allEmails.includes(sampleEmail)) {
    return slugs.includes(TENANT_WH) && slugs.includes(TENANT_SU) && slugs.length >= 2;
  }
  // If fixture has no all-clients email, explicit map or empty is still non-bot behavior.
  return !sessionUser.staff_user_id.includes('luna-bot')
    && Array.isArray(slugs);
})());

// ── Static requireBotAuth bind ──────────────────────────────────────────────
console.log('\n── requireBotAuth static ──');
green('requireBotAuth_static_bind', (() => {
  const hasBuild = /buildStaffBotAuthPrincipal\s*\(/.test(staffApi);
  const has503 = /bot_principal_tenant_unconfigured/.test(staffApi);
  const hasClientSlugOnPrincipal = /principal\.user/.test(staffApi)
    && /auth_mode:\s*'bot_token'/.test(staffApi);
  const noLegacyUnboundReturn = !/user:\s*\{\s*role:\s*'operator',\s*staff_user_id:\s*'luna-bot-internal'\s*\}/.test(staffApi);
  const botAclGuard = /staff_user_id === 'luna-bot-internal'/.test(portalClients)
    || /staff_user_id === "luna-bot-internal"/.test(portalClients);
  return hasBuild && has503 && hasClientSlugOnPrincipal && noLegacyUnboundReturn && botAclGuard;
})());

ok('owner files present',
  fs.existsSync(path.join(ROOT, 'scripts/lib/staff-bot-principal-tenant-config.js'))
  && /FORTRESS 15E/.test(staffApi)
  && /FORTRESS 15E/.test(portalClients));

ok('B07 out of scope — DEFAULT_CLIENT hardcoded still present (unchanged)',
  /const DEFAULT_CLIENT\s*=\s*'wolfhouse-somo'/.test(staffApi)
  && /body\.client_slug \|\| DEFAULT_CLIENT/.test(staffApi));

// ── Secret-free scan on new artifacts ───────────────────────────────────────
console.log('\n── Secret-free ──');
const scanTargets = [
  botConfigSrc,
  findings,
  JSON.stringify(contract),
  JSON.stringify(overlay),
];
let secretHits = 0;
for (const text of scanTargets) {
  const hits = scanSecretFreeText(text);
  secretHits += (hits && hits.length) || 0;
}
ok('secret-free scan clean on 15E artifacts', secretHits === 0, `hits=${secretHits}`);

// ── Evidence write ──────────────────────────────────────────────────────────
const evidence = {
  schema_version: 1,
  slice: 'FORTRESS-15E',
  generated_at: new Date().toISOString(),
  master_basis: contract.master_basis,
  live_mutation: false,
  red: {
    total: redResults.length,
    passed: redResults.filter((r) => r.ok).length,
    cases: redResults,
  },
  green: {
    total: greenResults.length,
    passed: greenResults.filter((r) => r.ok).length,
    cases: greenResults,
  },
  pass,
  fail,
  gates_note: 'offline only; zero live Stripe/DB/payment/deploy/guest/WhatsApp mutation',
  residual_b07: contract.residual_risk,
};
fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
ok('evidence written', fs.existsSync(EVIDENCE_PATH));

ok('RED floor', redResults.length >= 6 && redResults.every((r) => r.ok));
ok('GREEN floor', greenResults.length >= 5 && greenResults.every((r) => r.ok));

console.log(`\n── fortress-slice15e: ${pass} passed, ${fail} failed ──`);
if (fail > 0) process.exit(1);
console.log('OK — Slice 15E bot principal tenant bind (offline, zero live mutation).');
process.exit(0);
