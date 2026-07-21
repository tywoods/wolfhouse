'use strict';

/**
 * verify:radar-slice16t-e2e-correlation-drill — RADAR Slice 16T
 *
 * Offline RED/GREEN for the staging-only dry-run-default correlation-drill
 * harness. No network, no Azure, no live drill, no secrets.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16t-e2e-correlation-drill');

const FIXED_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-16f000000001';
const OTHER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-16f000000099';

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
  console.log(`  FAIL  ${name}`);
  if (detail) console.log(`        ${detail}`);
  return false;
}

function red(id, cond, detail) {
  redResults.push({ id, ok: !!cond });
  return ok(`RED ${id}`, cond, detail);
}

function green(id, cond, detail) {
  greenResults.push({ id, ok: !!cond });
  return ok(`GREEN ${id}`, cond, detail);
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(readText(rel));
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function currentBranch() {
  return execSync('git rev-parse --abbrev-ref HEAD', {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
}

function runtimePathsUnchanged() {
  try {
    const out = execSync(
      `git diff --name-only ${locks.MASTER_BASIS} -- ${locks.MUST_NOT_MUTATE.join(' ')}`,
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();
    return { ok: out === '', detail: out || '(clean)' };
  } catch (err) {
    return { ok: false, detail: String(err && err.message) };
  }
}

function secretFree(text, label) {
  const patterns = [
    /sk_live_[A-Za-z0-9]+/,
    /sk_test_[A-Za-z0-9]{20,}/,
    /whsec_[A-Za-z0-9]+/,
    /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
    /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  ];
  for (const re of patterns) {
    if (re.test(text)) return { ok: false, detail: `${label} matched ${re}` };
  }
  return { ok: true };
}

function goodHops(correlationId) {
  return locks.BOUNDARY_IDS.map((boundary) => ({
    boundary,
    method: locks.ALLOWLISTED_PROBES[boundary].method,
    path:
      boundary === 'hermes_gateway'
        ? '/whatsapp/webhook'
        : boundary === 'staff_api'
          ? '/healthz'
          : boundary === 'stripe_test_mode'
            ? '/staff/stripe/webhook'
            : '/staff/meta/whatsapp/webhook',
    host: 'staff-staging.lunafrontdesk.com',
    status_code: boundary === 'staff_api' ? 200 : 400,
    status_class: boundary === 'staff_api' ? '2xx' : '4xx',
    response_x_request_id: correlationId,
    completion_request_id: correlationId,
    mutation: false,
    outcome: 'correlation_echoed',
  }));
}

function goodEvidence(overrides) {
  const base = {
    correlation_id: FIXED_ID,
    tenant: 'wolfhouse',
    client_slug: 'wolfhouse-somo',
    resource_group: 'wh-staging-rg',
    staff_app: 'wh-staging-staff-api',
    stripe_mode: 'test',
    subscription_id: locks.SUBSCRIPTION_ID,
    master_basis: locks.MASTER_BASIS,
    image_sha_full: locks.IMAGE_SHA_FULL,
    hops: goodHops(FIXED_ID),
  };
  return Object.assign(base, overrides || {});
}

console.log('RADAR 16T E2E correlation-drill harness — offline verifier\n');

// --- Fixture / contract presence ---
green(
  'contract_present',
  fs.existsSync(path.join(ROOT, locks.CONTRACT_REL)),
);
green(
  'boundary_map_present',
  fs.existsSync(path.join(ROOT, locks.BOUNDARY_MAP_REL)),
);
green(
  'runner_present',
  fs.existsSync(path.join(ROOT, 'scripts/run-radar-slice16t-e2e-correlation-drill.js')),
);
green(
  'lib_present',
  fs.existsSync(path.join(ROOT, 'scripts/lib/radar-slice16t-e2e-correlation-drill.js')),
);

const contract = readJson(locks.CONTRACT_REL);
const boundaryMap = readJson(locks.BOUNDARY_MAP_REL);
const builtMap = locks.buildBoundaryMapFixture();

green(
  'contract_pins',
  contract.slice === locks.SLICE
    && contract.outcome_id === locks.OUTCOME_ID
    && contract.gate_id === locks.GATE_ID
    && contract.progress_class === locks.PROGRESS_CLASS
    && contract.master_basis === locks.MASTER_BASIS
    && contract.branch === locks.BRANCH
    && contract.this_slice_executes_live_drill === false
    && contract.live_mutation === false,
);
green(
  'boundary_map_matches_builder',
  JSON.stringify(boundaryMap) === JSON.stringify(builtMap),
  'fixture drift vs buildBoundaryMapFixture()',
);
green(
  'confirmation_phrase_locked',
  contract.required_hard_locks.confirmation_phrase === locks.CONFIRMATION_PHRASE
    && locks.CONFIRMATION_PHRASE === 'RADAR-16T-CORRELATION-DRILL',
);

// --- Dry-run default ---
const dryWh = locks.buildDryRunPlan({ tenant: 'wolfhouse', correlationId: FIXED_ID });
const drySunset = locks.buildDryRunPlan({ tenant: 'sunset', correlationId: FIXED_ID });
green(
  'dry_run_wolfhouse',
  dryWh.ok
    && dryWh.mode === 'dry-run'
    && dryWh.live_mutation === false
    && dryWh.correlation_id === FIXED_ID
    && dryWh.probes.length === 4
    && dryWh.hard_locks.staff_app === 'wh-staging-staff-api'
    && dryWh.hard_locks.stripe_mode === 'test'
    && dryWh.hard_locks.image_sha_full === locks.IMAGE_SHA_FULL,
);
green(
  'dry_run_sunset',
  drySunset.ok
    && drySunset.tenant === 'sunset'
    && drySunset.hard_locks.staff_app === 'luna-sunset-staging-staff-api'
    && drySunset.hard_locks.hermes_container === 'hermes-sunset-luna'
    && drySunset.hard_locks.client_slug === 'sunset'
    && drySunset.hard_locks.stripe_webhook_client_slug === 'sunset',
);

const applyOk = locks.evaluateApplyGate({
  applyRequested: true,
  confirmation: locks.CONFIRMATION_PHRASE,
  tenant: 'wolfhouse',
  stripeMode: 'test',
  subscriptionId: locks.SUBSCRIPTION_ID,
  imageShaFull: locks.IMAGE_SHA_FULL,
  masterBasis: locks.MASTER_BASIS,
});
green('apply_gate_accepts_exact_confirm', applyOk.ok, JSON.stringify(applyOk.errors));

const evidenceOk = locks.evaluateCorrelationEvidence(goodEvidence());
green(
  'same_id_propagation_accepts_bounded_evidence',
  evidenceOk.ok && evidenceOk.code === 'correlation_preserved',
  JSON.stringify(evidenceOk.errors),
);

// --- RED cases ---
red(
  'wrong_scope_tenant',
  locks.buildDryRunPlan({ tenant: 'production' }).ok === false
    && locks.buildDryRunPlan({ tenant: 'production' }).reason === 'unsupported_tenant',
);

red(
  'wrong_scope_resource_group',
  locks.evaluateCorrelationEvidence(
    goodEvidence({ resource_group: 'wh-production-rg' }),
  ).ok === false
    && locks.evaluateCorrelationEvidence(
      goodEvidence({ resource_group: 'wh-production-rg' }),
    ).errors.includes('wrong_scope_resource_group'),
);

red(
  'production_host',
  locks.evaluateApplyGate({
    applyRequested: true,
    confirmation: locks.CONFIRMATION_PHRASE,
    tenant: 'wolfhouse',
    productionHost: true,
  }).ok === false
    && locks.isProductionHost('hermes.lunafrontdesk.com') === true
    && locks.isProductionHost('staff-staging.lunafrontdesk.com') === false,
);

red(
  'real_stripe_mode',
  locks.evaluateApplyGate({
    applyRequested: true,
    confirmation: locks.CONFIRMATION_PHRASE,
    tenant: 'wolfhouse',
    stripeMode: 'live',
  }).ok === false
    && locks.evaluateCorrelationEvidence(goodEvidence({ stripe_mode: 'live' })).ok === false,
);

red(
  'missing_correlation',
  locks.evaluateCorrelationEvidence(goodEvidence({ correlation_id: null })).ok === false
    && locks.evaluateCorrelationEvidence(goodEvidence({ correlation_id: null })).code
      === 'missing_correlation',
);

{
  const hops = goodHops(FIXED_ID);
  hops[2].response_x_request_id = OTHER_ID;
  const ev = locks.evaluateCorrelationEvidence(goodEvidence({ hops }));
  red(
    'id_substitution',
    ev.ok === false && ev.errors.some((e) => e.startsWith('id_substitution')),
    JSON.stringify(ev.errors),
  );
}

{
  const hops = goodHops(FIXED_ID);
  hops.push(deepClone(hops[0]));
  const ev = locks.evaluateCorrelationEvidence(goodEvidence({ hops }));
  red(
    'duplicate_records',
    ev.ok === false && ev.errors.some((e) => e.startsWith('duplicate_record')),
    JSON.stringify(ev.errors),
  );
}

{
  const hops = goodHops(FIXED_ID);
  hops[0].token = 'secret-value';
  const ev = locks.evaluateCorrelationEvidence(goodEvidence({ hops }));
  red(
    'sensitive_fields',
    ev.ok === false && ev.errors.some((e) => e.startsWith('sensitive_field')),
    JSON.stringify(ev.errors),
  );
}

red(
  'unsupported_ingress',
  locks.evaluateApplyGate({
    applyRequested: true,
    confirmation: locks.CONFIRMATION_PHRASE,
    tenant: 'wolfhouse',
    ingressKind: 'signed_live_guest_message',
  }).ok === false
    && locks.evaluateCorrelationEvidence(
      goodEvidence({
        hops: goodHops(FIXED_ID).map((h, i) =>
          (i === 0 ? Object.assign({}, h, { ingress_kind: 'whatsapp_cloud_send' }) : h)),
      }),
    ).ok === false,
);

red(
  'mutation_capable_path',
  locks.evaluateApplyGate({
    applyRequested: true,
    confirmation: locks.CONFIRMATION_PHRASE,
    tenant: 'wolfhouse',
    mutationPath: '/staff/bot/generate-guest-payment-link',
  }).ok === false
    && locks.evaluateCorrelationEvidence(
      goodEvidence({
        hops: goodHops(FIXED_ID).map((h, i) =>
          (i === 2
            ? Object.assign({}, h, { path: '/staff/guest-simulator-create-hold-draft' })
            : h)),
      }),
    ).ok === false,
);

red(
  'apply_without_confirm',
  locks.evaluateApplyGate({
    applyRequested: true,
    confirmation: 'WRONG',
    tenant: 'wolfhouse',
  }).ok === false,
);

red(
  'apply_flag_required',
  locks.evaluateApplyGate({
    applyRequested: false,
    confirmation: locks.CONFIRMATION_PHRASE,
    tenant: 'wolfhouse',
  }).ok === false,
);

red(
  'missing_boundary_fail_closed',
  locks.evaluateCorrelationEvidence(
    goodEvidence({ hops: goodHops(FIXED_ID).slice(0, 3) }),
  ).ok === false
    && locks.evaluateCorrelationEvidence(
      goodEvidence({ hops: goodHops(FIXED_ID).slice(0, 3) }),
    ).errors.some((e) => e.startsWith('missing_boundary')),
);

// --- Ledger / matrix / findings ---
const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
const findings = readText('fixtures/radar-operations/findings.md');
const ledger = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
const opsContract = readJson('fixtures/radar-operations/contract.json');
const headBranch = currentBranch();

green(
  'matrix_slice_16t',
  matrix.slice === locks.SLICE
    && matrix.branch === locks.BRANCH
    && matrix.master_basis === locks.MASTER_BASIS
    && matrix.live_mutation === false,
);
green(
  'matrix_g01_partial_live_drill_open',
  (() => {
    const g01 = (matrix.gates || []).find((g) => g.id === locks.GATE_ID);
    return (
      g01
      && g01.verdict === 'partial'
      && g01.progress_class === 'partial_live_proven'
      && Array.isArray(g01.gaps)
      && g01.gaps.some((g) => /E2E|end-to-end|correlation drill/i.test(g))
      && /16T|source.partial|harness/i.test(g01.rationale)
    );
  })(),
);
green(
  'matrix_16t_selection',
  matrix.slice_16t_selection
    && matrix.slice_16t_selection.selected === true
    && matrix.slice_16t_selection.outcome_id === locks.OUTCOME_ID
    && matrix.slice_16t_selection.progress_class === locks.PROGRESS_CLASS
    && /live/i.test(String(matrix.slice_16t_selection.does_not_implement || '')),
);
green(
  'ops_contract_16t',
  opsContract.slice === locks.SLICE
    && opsContract.selected_16t
    && opsContract.selected_16t.outcome_id === locks.OUTCOME_ID
    && opsContract.selected_16t.progress_class === locks.PROGRESS_CLASS
    && /open/.test(String(opsContract.correlation_drill || '')),
);
green(
  'ledger_mentions_16t_source_partial',
  /16T_e2e_correlation_drill_harness/.test(ledger)
    && /source.partial/i.test(ledger)
    && /live drill/i.test(ledger)
    && /RADAR-16T-CORRELATION-DRILL/.test(ledger),
);
green(
  'findings_mentions_16t_open_live',
  /16T/.test(findings)
    && /source.partial/i.test(findings)
    && /E2E|end-to-end|correlation drill/i.test(findings),
);
green(
  'branch_pin',
  headBranch === locks.BRANCH || headBranch === 'HEAD',
  `HEAD branch=${headBranch}`,
);

const rt = runtimePathsUnchanged();
green('runtime_paths_unchanged', rt.ok, rt.detail);

const ownedTexts = locks.OWNED_RELS.map((rel) => {
  try {
    return readText(rel);
  } catch (_) {
    return '';
  }
}).join('\n');
const secrets = secretFree(ownedTexts, 'owned_rels');
green('secret_free_owned_artifacts', secrets.ok, secrets.detail);

const pkg = readJson('package.json');
green(
  'package_script',
  pkg.scripts
    && pkg.scripts['verify:radar-slice16t-e2e-correlation-drill']
      === 'node scripts/verify-radar-slice16t-e2e-correlation-drill.js'
    && pkg.scripts['run:radar-slice16t-e2e-correlation-drill']
      === 'node scripts/run-radar-slice16t-e2e-correlation-drill.js',
);

const requiredRed = [
  'wrong_scope_tenant',
  'wrong_scope_resource_group',
  'production_host',
  'real_stripe_mode',
  'missing_correlation',
  'id_substitution',
  'duplicate_records',
  'sensitive_fields',
  'unsupported_ingress',
  'mutation_capable_path',
  'apply_without_confirm',
  'apply_flag_required',
  'missing_boundary_fail_closed',
];
const requiredGreen = [
  'contract_present',
  'boundary_map_present',
  'runner_present',
  'lib_present',
  'contract_pins',
  'boundary_map_matches_builder',
  'confirmation_phrase_locked',
  'dry_run_wolfhouse',
  'dry_run_sunset',
  'apply_gate_accepts_exact_confirm',
  'same_id_propagation_accepts_bounded_evidence',
  'matrix_slice_16t',
  'matrix_g01_partial_live_drill_open',
  'matrix_16t_selection',
  'ops_contract_16t',
  'ledger_mentions_16t_source_partial',
  'findings_mentions_16t_open_live',
  'branch_pin',
  'runtime_paths_unchanged',
  'secret_free_owned_artifacts',
  'package_script',
];

for (const id of requiredRed) {
  const hit = redResults.find((r) => r.id === id);
  ok(`required_red_present:${id}`, hit && hit.ok);
}
for (const id of requiredGreen) {
  const hit = greenResults.find((r) => r.id === id);
  ok(`required_green_present:${id}`, hit && hit.ok);
}

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('RADAR 16T E2E correlation-drill harness: PASS');
