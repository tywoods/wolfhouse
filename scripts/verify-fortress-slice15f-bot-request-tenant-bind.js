'use strict';

/**
 * verify:fortress-slice15f-bot-request-tenant-bind — FORTRESS Slice 15F
 *
 * Offline RED/GREEN tests for generic /staff/bot/* request tenant bind to the
 * authenticated bot principal (closes B07). No network, no live DB/Stripe/
 * WhatsApp/deploy. Does not rewrite tracked evidence.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'fortress-tenant-identity');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice15f-contract.json');
const OVERLAY_PATH = path.join(FIXTURE_DIR, 'slice15f-b07-remediation-overlay.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice15f-findings.md');
const EVIDENCE_PATH = path.join(FIXTURE_DIR, 'slice15f-evidence.json');
const MATRIX_PATH = path.join(FIXTURE_DIR, 'boundary-matrix.json');
const ATTACK_PATH = path.join(FIXTURE_DIR, 'attack-cases.json');
const DOC_PATH = path.join(ROOT, 'docs', 'FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md');

const {
  resolveStaffBotRequestEffectiveTenant,
  dispatchStaffBotRouteWithPrincipalRequestTenant,
  collectStaffBotRequestTenantAliases,
} = require('./lib/staff-bot-request-tenant-bind');
const {
  buildStaffBotAuthPrincipal,
  BOT_STAFF_USER_ID,
} = require('./lib/staff-bot-principal-tenant-config');
const {
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

function botUser(slug) {
  return buildStaffBotAuthPrincipal(
    { LUNA_BOT_CLIENT_SLUG: slug },
    { knownClientSlugs: BASELINE },
  ).user;
}

function runPrincipalDispatch(user, body, query) {
  let handlerCalls = 0;
  let denied = null;
  let sawEffective = null;
  const out = dispatchStaffBotRouteWithPrincipalRequestTenant({
    user,
    authMode: 'bot_token',
    body: body || {},
    query: query || {},
    staffAuthRequired: true,
    canAccessClient: userCanAccessClient,
    onDenied: (gate) => { denied = gate; },
    handler: ({ effectiveClientSlug }) => {
      handlerCalls += 1;
      sawEffective = effectiveClientSlug;
      return { effectiveClientSlug };
    },
  });
  return { out, handlerCalls, denied, sawEffective };
}

console.log('verify:fortress-slice15f-bot-request-tenant-bind — FORTRESS Slice 15F\n');

console.log('── Artifacts ──');
const contract = readJson(CONTRACT_PATH);
const overlay = readJson(OVERLAY_PATH);
const findings = fs.readFileSync(FINDINGS_PATH, 'utf8');
const matrix = readJson(MATRIX_PATH);
const attacks = readJson(ATTACK_PATH);
const doc = fs.readFileSync(DOC_PATH, 'utf8');
const staffApi = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
const bindSrc = fs.readFileSync(
  path.join(ROOT, 'scripts', 'lib', 'staff-bot-request-tenant-bind.js'),
  'utf8',
);
const committedEvidence = readJson(EVIDENCE_PATH);

ok('contract slice 15F + B07',
  contract.slice === 'FORTRESS-15F'
  && contract.boundary_id === 'B07_staff_bot_body_client_slug'
  && contract.outcome_id === '15F_staff_bot_request_tenant_bind'
  && contract.live_mutation === false);
ok('overlay remediated B07 historical untouched',
  overlay.boundary_id === 'B07_staff_bot_body_client_slug'
  && overlay.status === 'remediated'
  && overlay.historical_audit_unchanged === true
  && Array.isArray(overlay.historical_artifacts)
  && overlay.historical_artifacts.includes('fixtures/fortress-tenant-identity/boundary-matrix.json'));
ok('findings cite B07 + principal bind',
  /B07/.test(findings) && /principal/.test(findings) && /dispatchBotRouteBoundToPrincipalTenant/.test(findings));
ok('historical matrix still marks B07 vulnerable',
  (matrix.boundaries || []).some((b) => b.id === 'B07_staff_bot_body_client_slug' && b.verdict === 'vulnerable'));
ok('historical attack cases retained for B07',
  (attacks.cases || []).some((c) => c.id === 'AC_BOT_TRUST_BODY_CROSS_TENANT' && c.color === 'RED'));
ok('historical doc still cites B07 vulnerable',
  /B07/.test(doc) && /vulnerable/.test(doc));
ok('bind module has no hardcoded tenant slug literals',
  !/wolfhouse-somo/.test(bindSrc)
  && !/'sunset'/.test(bindSrc)
  && !/"sunset"/.test(bindSrc));

const inventory = (contract.guarded_route_inventory && contract.guarded_route_inventory.routes) || [];
ok('guarded inventory has 40 generic principal-bind routes',
  inventory.length === 40
  && inventory.every((r) => r.policy === 'principal_request_bind'
    && String(r.path).startsWith('/staff/bot/')
    && !String(r.path).includes('/sunset/')));

console.log('\n── Resolve RED/GREEN ──');

const botWh = botUser(TENANT_WH);
const botSu = botUser(TENANT_SU);

red('conflict_body_client_slug', (() => {
  const r = resolveStaffBotRequestEffectiveTenant({
    authMode: 'bot_token',
    user: botWh,
    body: { client_slug: TENANT_SU },
    query: {},
  });
  return !r.ok
    && r.reason === 'request_tenant_conflict'
    && r.invoke_handler === false
    && r.effective_client_slug === TENANT_WH
    && r.requested_client_slug === TENANT_SU;
})());

red('conflict_body_client_alias', (() => {
  const r = resolveStaffBotRequestEffectiveTenant({
    authMode: 'bot_token',
    user: botWh,
    body: { client: TENANT_SU },
    query: {},
  });
  return !r.ok && r.reason === 'request_tenant_conflict' && r.invoke_handler === false;
})());

red('conflict_query_client', (() => {
  const r = resolveStaffBotRequestEffectiveTenant({
    authMode: 'bot_token',
    user: botSu,
    body: {},
    query: { client: TENANT_WH },
  });
  return !r.ok && r.reason === 'request_tenant_conflict' && r.requested_client_slug === TENANT_WH;
})());

red('empty_body_client_slug', (() => {
  const r = resolveStaffBotRequestEffectiveTenant({
    authMode: 'bot_token',
    user: botWh,
    body: { client_slug: '' },
    query: {},
  });
  return !r.ok && r.reason === 'empty_request_tenant_alias' && r.invoke_handler === false;
})());

red('empty_query_client', (() => {
  const r = resolveStaffBotRequestEffectiveTenant({
    authMode: 'bot_token',
    user: botWh,
    body: {},
    query: { client: '   ' },
  });
  return !r.ok && r.reason === 'empty_request_tenant_alias';
})());

red('conflicting_aliases', (() => {
  const r = resolveStaffBotRequestEffectiveTenant({
    authMode: 'bot_token',
    user: botWh,
    body: { client_slug: TENANT_WH, client: TENANT_SU },
    query: {},
  });
  return !r.ok && r.reason === 'conflicting_request_tenant_aliases' && r.invoke_handler === false;
})());

green('omission_uses_principal', (() => {
  const r = resolveStaffBotRequestEffectiveTenant({
    authMode: 'bot_token',
    user: botWh,
    body: { check_in: '2026-08-01' },
    query: {},
  });
  return r.ok
    && r.effective_client_slug === TENANT_WH
    && r.reason === 'principal_tenant_omission'
    && collectStaffBotRequestTenantAliases({ check_in: '2026-08-01' }, {}).length === 0;
})());

green('matching_body_client_slug', (() => {
  const r = resolveStaffBotRequestEffectiveTenant({
    authMode: 'bot_token',
    user: botSu,
    body: { client_slug: TENANT_SU },
    query: {},
  });
  return r.ok
    && r.effective_client_slug === TENANT_SU
    && r.reason === 'principal_tenant_matched';
})());

green('matching_client_alias', (() => {
  const r = resolveStaffBotRequestEffectiveTenant({
    authMode: 'bot_token',
    user: botWh,
    body: { client: TENANT_WH },
    query: {},
  });
  return r.ok && r.effective_client_slug === TENANT_WH && r.reason === 'principal_tenant_matched';
})());

green('force_tenant_sunset_preserved', (() => {
  const r = resolveStaffBotRequestEffectiveTenant({
    authMode: 'bot_token',
    user: botSu,
    body: { client_slug: TENANT_WH },
    query: {},
    forceTenantSlug: TENANT_SU,
  });
  return r.ok
    && r.effective_client_slug === TENANT_SU
    && r.reason === 'force_tenant'
    && r.source === 'path_force';
})());

green('session_request_preserved', (() => {
  const sessionUser = {
    role: 'operator',
    staff_user_id: '11111111-1111-1111-1111-111111111111',
    email: 'fortress-15f-session-sample@example.com',
    client_slug: TENANT_WH,
  };
  const r = resolveStaffBotRequestEffectiveTenant({
    authMode: 'session',
    user: sessionUser,
    body: { client_slug: TENANT_SU },
    query: {},
  });
  return r.ok
    && r.effective_client_slug === TENANT_SU
    && r.reason === 'session_request_tenant'
    && sessionUser.staff_user_id !== BOT_STAFF_USER_ID;
})());

console.log('\n── Route dispatch RED/GREEN ──');

red('route_inventory_conflict_zero_handler', (() => {
  return inventory.every((route) => {
    const { out, handlerCalls, denied } = runPrincipalDispatch(
      botWh,
      { client_slug: TENANT_SU },
      {},
    );
    return out.ok === false
      && out.handler_called === false
      && handlerCalls === 0
      && denied
      && denied.reason === 'request_tenant_conflict'
      && route.path.startsWith('/staff/bot/');
  });
})());

green('guarded_inventory_wired', (() => {
  const callSites = (staffApi.match(/return dispatchBotRouteBoundToPrincipalTenant\(/g) || []).length;
  const sunsetSites = (staffApi.match(/return dispatchBotRouteWithEffectiveTenant\(auth, res, SUNSET_CLIENT_SLUG/g) || []).length;
  const hasHelper = /resolveBotHandlerTrustedClientSlug/.test(staffApi);
  const hasModule = /staff-bot-request-tenant-bind/.test(staffApi);
  // Every inventory handler name appears near a BoundToPrincipal dispatch
  const allHandlersPresent = inventory.every((r) => staffApi.includes(r.handler));
  return callSites === inventory.length
    && sunsetSites === 12
    && hasHelper
    && hasModule
    && allHandlersPresent;
})());

ok('matching dispatch invokes handler with principal', (() => {
  const { out, handlerCalls, sawEffective } = runPrincipalDispatch(botWh, {}, {});
  return out.ok === true
    && out.handler_called === true
    && handlerCalls === 1
    && sawEffective === TENANT_WH;
})());

console.log('\n── Static wiring ──');
ok('HTTP wrapper + pin + 403 reason surface',
  /async function dispatchBotRouteBoundToPrincipalTenant/.test(staffApi)
  && /pinStaffBotRequestEffectiveTenant/.test(staffApi)
  && /request_tenant_conflict/.test(staffApi)
  && /empty_request_tenant_alias/.test(bindSrc));
ok('pause routes remain requireAuth (staff session preserved)', (() => {
  const pauseStateIdx = staffApi.indexOf("pathname === '/staff/bot/pause-state'");
  const pauseIdx = staffApi.indexOf("pathname === '/staff/bot/pause'");
  if (pauseStateIdx < 0 || pauseIdx < 0) return false;
  const pauseStateBlock = staffApi.slice(pauseStateIdx, pauseStateIdx + 450);
  const pauseBlock = staffApi.slice(pauseIdx, pauseIdx + 450);
  return /requireAuth\(req, res, 'viewer'\)/.test(pauseStateBlock)
    && /requireAuth\(req, res, 'operator'\)/.test(pauseBlock)
    && !/dispatchBotRouteBoundToPrincipalTenant/.test(pauseStateBlock)
    && !/requireBotAuth/.test(pauseStateBlock);
})());
ok('committed evidence counts match',
  committedEvidence.guarded_route_count === inventory.length
  && committedEvidence.red.total === 7
  && committedEvidence.green.total === 6);

console.log('\n── Secret-free scan ──');
const secretScanTargets = [
  FINDINGS_PATH,
  CONTRACT_PATH,
  OVERLAY_PATH,
  EVIDENCE_PATH,
  path.join(ROOT, 'scripts', 'lib', 'staff-bot-request-tenant-bind.js'),
];
let secretHits = 0;
for (const p of secretScanTargets) {
  const text = fs.readFileSync(p, 'utf8');
  const hits = scanSecretFreeText(text, path.relative(ROOT, p));
  secretHits += hits.length;
}
ok('secret-free artifacts', secretHits === 0, `hits=${secretHits}`);

console.log(`\n── Summary: pass=${pass} fail=${fail} ──`);
if (fail > 0) process.exit(1);
console.log('OK fortress-slice15f-bot-request-tenant-bind');
