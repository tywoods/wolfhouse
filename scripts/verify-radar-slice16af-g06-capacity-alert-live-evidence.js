'use strict';

/**
 * verify:radar-slice16af-g06-capacity-alert-live-evidence — RADAR Slice 16AF
 *
 * Offline gate: bounded live dual-staging capacity-pressure alert + scale-truth
 * evidence reconciliation (Azure read-only independently reverified facts).
 *
 * Rejects scope/metric/threshold/action/scale drift, fire/notification/load/
 * autoscale/SLO/backpressure/production/full-G06 overclaims, lock_hash mismatch.
 * No Azure mutation.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16af-g06-capacity-alert-live-evidence');

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

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function evidenceHashPayload(ev) {
  const clone = deepClone(ev);
  delete clone.lock_hash;
  return clone;
}

function computeEvidenceLockHash(ev) {
  return crypto.createHash('sha256').update(stableStringify(evidenceHashPayload(ev))).digest('hex');
}

function secretFree(blob, label) {
  const text = String(blob || '');
  const hits = [];
  if (/["']email_address["']\s*:\s*["'][^"']+@[^"']+["']/.test(text)
    || /["']emailAddress["']\s*:\s*["'][^"']+@[^"']+["']/.test(text)
    || /ops@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text)) {
    hits.push('email_address');
  }
  if (/sk_live_[A-Za-z0-9]+|sk_test_[A-Za-z0-9]+|postgres:\/\/[^"'\s]+|postgresql:\/\/[^"'\s]+|AccountKey=[A-Za-z0-9+\/=]+/i.test(text)) {
    hits.push('secret_like');
  }
  return { ok: hits.length === 0, detail: hits.join(',') || `${label}:clean` };
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function validateEvidenceExact(evidence) {
  const errors = [];
  const expected = readJson(locks.EVIDENCE_REL);
  const withoutHash = deepClone(evidence);
  const gotHash = withoutHash.lock_hash;
  delete withoutHash.lock_hash;
  const expectedNoHash = deepClone(expected);
  delete expectedNoHash.lock_hash;

  if (!/^[0-9a-f]{64}$/.test(String(gotHash || ''))) {
    errors.push('$.lock_hash: must be 64-char lowercase hex');
  } else {
    const recomputed = computeEvidenceLockHash(evidence);
    if (gotHash !== recomputed) {
      errors.push(`$.lock_hash: mismatch (got=${gotHash} expected=${recomputed})`);
    }
  }

  const allowedTop = [...Object.keys(expectedNoHash), 'lock_hash'].sort();
  const gotTop = Object.keys(evidence).sort();
  if (stableStringify(gotTop) !== stableStringify(allowedTop)) {
    errors.push(`top keys mismatch got=${gotTop.join(',')} allowed=${allowedTop.join(',')}`);
  }

  if (!deepEqual(withoutHash, expectedNoHash)) {
    errors.push('evidence payload mismatch vs locked fixture (excluding lock_hash check above)');
  }

  return { ok: errors.length === 0, errors };
}

function factsRoot(ev) {
  return ev && ev.observed_facts
    && ev.observed_facts.azure_monitor_containerapp_readonly_independently_reverified;
}

function tenant(ev, kind) {
  const root = factsRoot(ev);
  return root && root[kind];
}

function alertOk(rule, expect) {
  const errors = [];
  if (!rule) return { ok: false, errors: ['missing rule'] };
  if (rule.name !== expect.name) errors.push('name');
  if (rule.enabled !== true) errors.push('enabled');
  if (rule.severity !== locks.RULE_SEVERITY_INT) errors.push('severity');
  if (rule.severity_label !== locks.SEVERITY_LABEL) errors.push('severity_label');
  if (rule.evaluation_frequency !== locks.EVALUATION_FREQUENCY) errors.push('eval');
  if (rule.window_size !== locks.WINDOW_SIZE) errors.push('window');
  if (rule.metric_name !== expect.metric) errors.push('metric');
  if (rule.metric_namespace !== locks.METRIC_NAMESPACE) errors.push('namespace');
  if (rule.time_aggregation !== locks.TIME_AGGREGATION) errors.push('agg');
  if (rule.operator !== locks.OPERATOR) errors.push('op');
  if (rule.threshold !== locks.THRESHOLD) errors.push('threshold');
  if (rule.criterion_type !== locks.CRITERION_TYPE) errors.push('criterion');
  if (rule.scope_app !== expect.app) errors.push('scope_app');
  if (rule.scope_resource_id !== expect.scope) errors.push('scope_id');
  if (rule.action_group_id !== expect.ag) errors.push('ag');
  return { ok: errors.length === 0, errors };
}

function agOk(t, kind) {
  const errors = [];
  if (!t || !t.action_group) return { ok: false, errors: ['missing ag'] };
  const ag = t.action_group;
  const isWh = kind === 'wolfhouse';
  if (ag.name !== (isWh ? locks.WH_AG_NAME : locks.SUNSET_AG_NAME)) errors.push('name');
  if (ag.resource_id !== (isWh ? locks.WH_AG_ID : locks.SUNSET_AG_ID)) errors.push('id');
  if (ag.enabled !== true) errors.push('enabled');
  if (!ag.email_receiver || ag.email_receiver.name !== locks.RECEIVER_NAME) errors.push('receiver_name');
  if (!ag.email_receiver || ag.email_receiver.status !== locks.RECEIVER_STATUS) errors.push('receiver_status');
  if (!ag.email_receiver || ag.email_receiver.email_address_recorded !== false) {
    errors.push('address_recorded');
  }
  if (ag.email_receiver && Object.prototype.hasOwnProperty.call(ag.email_receiver, 'emailAddress')) {
    errors.push('emailAddress_present');
  }
  if (ag.email_receiver && Object.prototype.hasOwnProperty.call(ag.email_receiver, 'email_address')) {
    errors.push('email_address_present');
  }
  return { ok: errors.length === 0, errors };
}

function scaleOk(t, kind) {
  const errors = [];
  if (!t || !t.scale) return { ok: false, errors: ['missing scale'] };
  const s = t.scale;
  const isWh = kind === 'wolfhouse';
  const min = isWh ? locks.WH_MIN : locks.SUNSET_MIN;
  const max = isWh ? locks.WH_MAX : locks.SUNSET_MAX;
  const rev = isWh ? locks.WH_REVISION : locks.SUNSET_REVISION;
  if (s.minReplicas !== min) errors.push('min');
  if (s.maxReplicas !== max) errors.push('max');
  if (s.rules !== null) errors.push('rules');
  if (s.active_revisions_mode !== locks.ACTIVE_MODE) errors.push('mode');
  if (s.latest_revision_name !== rev) errors.push('latest');
  if (s.latest_ready_revision_name !== rev) errors.push('latestReady');
  if (s.latest_equals_latestReady !== true) errors.push('equals');
  if (!Array.isArray(s.traffic) || s.traffic.length !== 1
    || s.traffic[0].revisionName !== rev || s.traffic[0].weight !== 100) {
    errors.push('traffic');
  }
  return { ok: errors.length === 0, errors };
}

function capacityAlertsOk(ev) {
  const wh = tenant(ev, 'wolfhouse');
  const sun = tenant(ev, 'sunset');
  if (!wh || !sun || !wh.capacity_alerts || !sun.capacity_alerts) {
    return { ok: false, errors: ['missing capacity_alerts'] };
  }
  const checks = [
    alertOk(wh.capacity_alerts.cpu, {
      name: locks.WH_CPU_RULE, metric: 'CpuPercentage', app: locks.WH_APP, scope: locks.WH_APP_SCOPE, ag: locks.WH_AG_ID,
    }),
    alertOk(wh.capacity_alerts.memory, {
      name: locks.WH_MEM_RULE, metric: 'MemoryPercentage', app: locks.WH_APP, scope: locks.WH_APP_SCOPE, ag: locks.WH_AG_ID,
    }),
    alertOk(sun.capacity_alerts.cpu, {
      name: locks.SUNSET_CPU_RULE, metric: 'CpuPercentage', app: locks.SUNSET_APP, scope: locks.SUNSET_APP_SCOPE, ag: locks.SUNSET_AG_ID,
    }),
    alertOk(sun.capacity_alerts.memory, {
      name: locks.SUNSET_MEM_RULE, metric: 'MemoryPercentage', app: locks.SUNSET_APP, scope: locks.SUNSET_APP_SCOPE, ag: locks.SUNSET_AG_ID,
    }),
  ];
  const errors = checks.flatMap((c) => c.errors);
  return { ok: checks.every((c) => c.ok), errors };
}

function validateGateMatrix(matrix) {
  const errors = [];
  if (!matrix || typeof matrix !== 'object') {
    return { ok: false, errors: ['matrix missing'] };
  }
  const tip16ag = (matrix.slice === 'RADAR-16AG' || matrix.slice === 'RADAR-16AH'
    || matrix.slice === 'RADAR-16AI' || matrix.slice === 'RADAR-16AJ' || matrix.slice === 'RADAR-16AK'
    || matrix.slice === 'RADAR-16AL' || matrix.slice === 'RADAR-16AM');
  if (matrix.slice !== locks.SLICE && !tip16ag) errors.push(`slice=${matrix.slice}`);
  if (matrix.branch !== locks.BRANCH
    && !(tip16ag && (matrix.branch === 'radar/slice-16ag-g06-bounded-load-harness'
      || matrix.branch === 'radar/slice-16ah-g06-live-load-correction'
      || matrix.branch === 'radar/slice-16ai-g06-live-load-evidence'
      || matrix.branch === 'radar/slice-16aj-g06-slo-error-budget-source'
      || matrix.branch === 'radar/slice-16ak-g06-backpressure-source'
      || matrix.branch === 'radar/slice-16al-g06-backpressure-wire'
      || matrix.branch === 'radar/slice-16am-g06-backpressure-deploy-evidence'))) {
    errors.push(`branch=${matrix.branch}`);
  }
  if (matrix.master_basis !== locks.MASTER_BASIS
    && !(tip16ag && (matrix.master_basis === '7a283b70d38a4906e6279d82a49c0f6dd2a4994e'
      || matrix.master_basis === '6c24e9456bd42c7fa1b051bb1308aae8f632b293'
      || matrix.master_basis === 'd04b633390bdcacfe3a04eed4796bba4184e29f8'
      || matrix.master_basis === '0994989a3d5d14daa98797fac55083b0c2ea809c'
      || matrix.master_basis === '9fa3626326c0e2bc21f2d37905967d6ff47b7520'
      || matrix.master_basis === '502d762f897432c67bb8b17a8a49bfab01a0787d'
      || matrix.master_basis === '905ff9ff57a75d0b3defc15a16078b47e94e930f'))) {
    errors.push('master_basis mismatch');
  }
  if (matrix.live_mutation !== false) errors.push('live_mutation not false');
  const counts = matrix.verdict_counts || {};
  if (counts.proven !== 0) errors.push(`proven=${counts.proven}`);
  if (counts.partial !== 9) errors.push(`partial=${counts.partial}`);
  if (counts.absent !== 0) errors.push(`absent=${counts.absent}`);

  const g06 = (matrix.gates || []).find((g) => g.id === locks.GATE_ID);
  if (!g06) {
    errors.push('G06 missing');
  } else {
    if (g06.verdict !== 'partial') errors.push('G06 verdict not partial');
    if (g06.progress_class !== 'partial_live_proven') errors.push('G06 progress_class wrong');
    if (!/16AF|capacity.?pressure|CpuPercentage|MemoryPercentage/i.test(String(g06.rationale || ''))) {
      errors.push('G06 rationale missing 16AF capacity facts');
    }
    if (!Array.isArray(g06.gaps) || !g06.gaps.some((g) => /fir|notification/i.test(String(g)))) {
      errors.push('G06 gaps must retain firing/notification open');
    }
    if (!g06.gaps.some((g) => /load|soak/i.test(String(g)))) {
      errors.push('G06 gaps must retain load/soak open');
    }
    if (!g06.gaps.some((g) => /autoscal/i.test(String(g)))) {
      errors.push('G06 gaps must retain autoscaling open');
    }
    if (!g06.gaps.some((g) => /SLO|error.?budget|backpressure/i.test(String(g)))) {
      errors.push('G06 gaps must retain SLO/backpressure open');
    }
    if (g06.gaps.some((g) => /Capacity-pressure alerts not deployed/i.test(String(g)))) {
      errors.push('G06 gaps still claim capacity alerts not deployed');
    }
  }

  for (const g of matrix.gates || []) {
    if (g.verdict === 'proven') errors.push(`${g.id} falsely proven`);
  }
  return { ok: errors.length === 0, errors };
}

function overclaimHits(text) {
  const patterns = [
    /\bcapacity\s+alert\s+fired\b/i,
    /\balert\s+firing\s+proven\b/i,
    /\bnotification\s+delivered\b/i,
    /\bhuman\s+inbox\s+receipt\s+proven\b/i,
    /\binbox\s+delivered\b/i,
    /\bautoscaling\s+proven\b/i,
    /\bload\s+soak\s+proven\b/i,
    /\bcapacity\s+SLO\s+proven\b/i,
    /\berror\s+budget\s+proven\b/i,
    /\bbackpressure\s+proven\b/i,
    /\bfull\s+G06\b/i,
    /\bG06\s+proven\b/i,
    /\bfull_G06_proven\b/i,
    /\bproduction\b(?![^\n]{0,40}\b(forbidden|not|open|still)\b)/i,
  ];
  const hits = [];
  for (const p of patterns) {
    if (p.test(text)) hits.push(String(p));
  }
  return hits;
}

function runVerifier() {
  console.log('RADAR 16AF G06 capacity alert live evidence — offline verifier\n');

  const evidence = readJson(locks.EVIDENCE_REL);
  const sliceContract = readJson(locks.CONTRACT_REL);
  const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
  const topContract = readJson('fixtures/radar-operations/contract.json');
  const doc = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
  const findings = readText('fixtures/radar-operations/findings.md');

  ok('C1 HEAD on 16AF branch (tip may advance to 16AG+/16AM)',
    currentBranch() === locks.BRANCH
    || currentBranch() === 'radar/slice-16ag-g06-bounded-load-harness'
    || currentBranch() === 'radar/slice-16ah-g06-live-load-correction'
    || currentBranch() === 'radar/slice-16ai-g06-live-load-evidence'
    || currentBranch() === 'radar/slice-16aj-g06-slo-error-budget-source'
    || currentBranch() === 'radar/slice-16ak-g06-backpressure-source'
    || currentBranch() === 'radar/slice-16al-g06-backpressure-wire'
    || currentBranch() === 'radar/slice-16am-g06-backpressure-deploy-evidence',
    currentBranch());
  ok('C2 evidence master_basis locked', evidence.master_basis === locks.MASTER_BASIS);
  ok('C3 slice/outcome/branch locked',
    evidence.slice === locks.SLICE
    && evidence.outcome_id === locks.OUTCOME_ID
    && evidence.branch === locks.BRANCH
    && sliceContract.branch === locks.BRANCH);

  {
    const v = validateEvidenceExact(evidence);
    ok('C4 evidence exact recursive schema + lock_hash', v.ok, v.errors.slice(0, 12).join(' | '));
  }

  ok('C5 live_mutation false + audit_only',
    evidence.live_mutation === false
    && evidence.audit_only === true
    && evidence.this_slice_deploys === false);

  ok('C6 disposition keeps G06 partial; deploy closed caveats',
    evidence.disposition.g06_verdict === 'partial'
    && evidence.disposition.g06_progress_class === 'partial_live_proven'
    && evidence.gate_progress_updates.G06_scaling_capacity.verdict === 'partial'
    && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('capacity_alert_firing')
    && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('notification_delivery')
    && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('load_soak_proof')
    && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('autoscaling')
    && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('capacity_slo_error_budget')
    && evidence.gate_progress_updates.G06_scaling_capacity.still_open.includes('backpressure')
    && evidence.gate_progress_updates.G06_scaling_capacity.live_proven.includes(
      'capacity_pressure_alerts_deployed_enabled_via_16AF',
    ));

  green('four_capacity_alerts_exact', capacityAlertsOk(evidence).ok);

  green('action_groups_exact_no_address',
    agOk(tenant(evidence, 'wolfhouse'), 'wolfhouse').ok
    && agOk(tenant(evidence, 'sunset'), 'sunset').ok);

  green('scale_truth_exact',
    scaleOk(tenant(evidence, 'wolfhouse'), 'wolfhouse').ok
    && scaleOk(tenant(evidence, 'sunset'), 'sunset').ok);

  green('inventory_four_names',
    (() => {
      const inv = factsRoot(evidence).capacity_alert_inventory;
      return inv
        && inv.count === 4
        && locks.CAPACITY_ALERT_NAMES.every((n) => inv.names.includes(n));
    })());

  green('claims_and_disposition_locked',
    locks.CLAIMS_ALLOWED.every((c) => evidence.claims_allowed.includes(c))
    && evidence.disposition.does_not_prove.includes('capacity_alert_firing')
    && evidence.disposition.does_not_prove.includes('notification_delivery')
    && evidence.disposition.does_not_prove.includes('autoscaling')
    && evidence.disposition.does_not_prove.includes('full_G06_proven')
    && evidence.explicitly_not_claimed.includes('capacity_alert_firing'));

  {
    const mv = validateGateMatrix(matrix);
    ok('C10 matrix validation (counts + G06 partial deploy closed)', mv.ok, mv.errors.join(' | '));
  }

  ok('C11 top contract selected_16af + capacity_live_deploy live_proven (tip may be 16AG+)',
    topContract.selected_16af
    && topContract.selected_16af.outcome_id === locks.OUTCOME_ID
    && topContract.selected_16af.g06_capacity_alert_deploy === 'live_proven_via_16AF'
    && (topContract.slice === locks.SLICE
      || topContract.slice === 'RADAR-16AG'
      || topContract.slice === 'RADAR-16AH'
      || topContract.slice === 'RADAR-16AI'
      || topContract.slice === 'RADAR-16AJ'
      || topContract.slice === 'RADAR-16AK'
      || topContract.slice === 'RADAR-16AL'
      || topContract.slice === 'RADAR-16AM')
    && (topContract.branch === locks.BRANCH
      || topContract.branch === 'radar/slice-16ag-g06-bounded-load-harness'
      || topContract.branch === 'radar/slice-16ah-g06-live-load-correction'
      || topContract.branch === 'radar/slice-16ai-g06-live-load-evidence'
      || topContract.branch === 'radar/slice-16aj-g06-slo-error-budget-source'
      || topContract.branch === 'radar/slice-16ak-g06-backpressure-source'
      || topContract.branch === 'radar/slice-16al-g06-backpressure-wire'
      || topContract.branch === 'radar/slice-16am-g06-backpressure-deploy-evidence')
    && topContract.selected_16af.g06_verdict === 'partial'
    && /live_proven_via_16AF/i.test(String(topContract.capacity_live_deploy || ''))
    && /open/i.test(String(topContract.capacity_alert_fire || ''))
    && /open/i.test(String(topContract.capacity_load_proof || ''))
    && /open/i.test(String(topContract.capacity_slo || topContract.g06_slo || ''))
    && /open/i.test(String(topContract.capacity_backpressure || '')));

  ok('C12 doc mentions 16AF + capacity deploy + G06 partial + open gaps',
    /16AF|capacity.?alert.?live/i.test(doc)
    && /G06.*partial|partial.*G06/i.test(doc)
    && /fir|notification/i.test(doc)
    && /autoscal|load|soak|SLO|backpressure/i.test(doc)
    && !/\bG06\s+proven\b/i.test(doc)
    && !/\bfull\s+G06\b/i.test(doc));

  ok('C13 findings mention 16AF without overclaim',
    /16AF|capacity.?alert/i.test(findings)
    && /G06/.test(findings)
    && !/\bG06\s+proven\b/i.test(findings)
    && !/\bfull\s+G06\b/i.test(findings));

  {
    const rt = runtimePathsUnchanged();
    ok('C14 runtime paths unchanged vs master', rt.ok, rt.detail);
  }

  {
    const scanRels = locks.OWNED_RELS.filter((rel) => !/verify-radar-slice16af/.test(rel));
    const ownedBlob = scanRels.map((rel) => {
      try { return readText(rel); } catch (_) { return ''; }
    }).join('\n');
    const sec = secretFree(ownedBlob, 'owned');
    ok('C15 secret-free owned artifacts (no receiver address)', sec.ok, sec.detail);
  }

  {
    const pkg = readJson('package.json');
    ok('C16 package script registered',
      pkg.scripts
      && pkg.scripts['verify:radar-slice16af-g06-capacity-alert-live-evidence']
        === 'node scripts/verify-radar-slice16af-g06-capacity-alert-live-evidence.js');
  }

  green('package_script_registered',
    (() => {
      const pkg = readJson('package.json');
      return pkg.scripts
        && pkg.scripts['verify:radar-slice16af-g06-capacity-alert-live-evidence']
          === 'node scripts/verify-radar-slice16af-g06-capacity-alert-live-evidence.js';
    })());

  green('runtime_paths_unchanged', runtimePathsUnchanged().ok);

  green('secret_free_owned_artifacts', secretFree(JSON.stringify(evidence), 'evidence').ok);

  // --- RED battery ---
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_containerapp_readonly_independently_reverified
      .wolfhouse.capacity_alerts.cpu.scope_app = 'wrong-app';
    red('wrong_scope_rejected',
      !validateEvidenceExact(bad).ok
      || !capacityAlertsOk(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_containerapp_readonly_independently_reverified
      .wolfhouse.capacity_alerts.cpu.metric_name = 'RestartCount';
    red('wrong_metric_rejected',
      !validateEvidenceExact(bad).ok
      || !capacityAlertsOk(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_containerapp_readonly_independently_reverified
      .wolfhouse.capacity_alerts.cpu.threshold = 90;
    red('wrong_threshold_rejected',
      !validateEvidenceExact(bad).ok
      || !capacityAlertsOk(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_containerapp_readonly_independently_reverified
      .wolfhouse.capacity_alerts.cpu.action_group_id = locks.SUNSET_AG_ID;
    red('wrong_action_group_rejected',
      !validateEvidenceExact(bad).ok
      || !capacityAlertsOk(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_containerapp_readonly_independently_reverified
      .wolfhouse.scale.minReplicas = 1;
    red('wrong_scale_min_rejected',
      !validateEvidenceExact(bad).ok
      || !scaleOk(tenant(bad, 'wolfhouse'), 'wolfhouse').ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_containerapp_readonly_independently_reverified
      .wolfhouse.scale.rules = [{ name: 'http', http: {} }];
    red('scale_rules_drift_rejected',
      !validateEvidenceExact(bad).ok
      || !scaleOk(tenant(bad, 'wolfhouse'), 'wolfhouse').ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_containerapp_readonly_independently_reverified
      .sunset.scale.latest_ready_revision_name = 'luna-sunset-staging-staff-api--other';
    bad.observed_facts.azure_monitor_containerapp_readonly_independently_reverified
      .sunset.scale.latest_equals_latestReady = false;
    red('latest_latestReady_drift_rejected',
      !validateEvidenceExact(bad).ok
      || !scaleOk(tenant(bad, 'sunset'), 'sunset').ok);
  }
  {
    const bad = deepClone(evidence);
    bad.claims_allowed.push('capacity_alert_firing');
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'capacity_alert_firing');
    bad.disposition.proves.push('capacity_alert_firing');
    red('firing_overclaim_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.claims_allowed.push('notification_delivery');
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'notification_delivery');
    bad.disposition.proves.push('notification_delivery');
    red('notification_overclaim_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.claims_allowed.push('autoscaling');
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'autoscaling');
    bad.disposition.proves.push('autoscaling');
    red('autoscaling_overclaim_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.disposition.g06_verdict = 'proven';
    bad.gate_progress_updates.G06_scaling_capacity.verdict = 'proven';
    bad.gate_progress_updates.G06_scaling_capacity.still_open = [];
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'full_G06_proven');
    red('full_g06_overclaim_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_containerapp_readonly_independently_reverified
      .wolfhouse.action_group.email_receiver.email_address = 'ops@example.com';
    bad.observed_facts.azure_monitor_containerapp_readonly_independently_reverified
      .wolfhouse.action_group.email_receiver.email_address_recorded = true;
    red('invented_email_address_rejected',
      !validateEvidenceExact(bad).ok || !agOk(tenant(bad, 'wolfhouse'), 'wolfhouse').ok);
  }
  {
    const bad = deepClone(evidence);
    bad.lock_hash = '0'.repeat(64);
    red('lock_hash_mismatch_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const badDoc = `${doc}\n\nG06 proven with capacity alert fired and notification delivered.\n`;
    const hits = overclaimHits(badDoc);
    red('doc_overclaim_tokens_detectable', hits.length > 0, hits.join(','));
  }

  const requiredReds = [
    'wrong_scope_rejected',
    'wrong_metric_rejected',
    'wrong_threshold_rejected',
    'wrong_action_group_rejected',
    'wrong_scale_min_rejected',
    'scale_rules_drift_rejected',
    'latest_latestReady_drift_rejected',
    'firing_overclaim_rejected',
    'notification_overclaim_rejected',
    'autoscaling_overclaim_rejected',
    'full_g06_overclaim_rejected',
    'invented_email_address_rejected',
    'lock_hash_mismatch_rejected',
    'doc_overclaim_tokens_detectable',
  ];
  for (const id of requiredReds) {
    const row = redResults.find((r) => r.id === id);
    ok(`RED-required ${id}`, row && row.ok);
  }

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16AF G06 capacity alert live evidence (partial/live-proven): PASS');
}

runVerifier();
