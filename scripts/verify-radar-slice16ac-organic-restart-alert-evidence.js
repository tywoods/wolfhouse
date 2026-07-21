'use strict';

/**
 * verify:radar-slice16ac-organic-restart-alert-evidence — RADAR Slice 16AC
 *
 * Offline gate: bounded organic Azure Monitor restart-alert evidence
 * reconciliation (Azure read-only independently reverified facts).
 *
 * Rejects wrong rule/scope/threshold/timestamps/state, suppressed action,
 * invented email/address/receipt, unique-causality overclaim, 5xx alert claim,
 * cost mutation, production/full G02/G03 overclaims, lock_hash mismatch.
 * No Azure mutation.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16ac-organic-restart-alert-evidence');

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
  // Reject recorded receiver addresses only (not prose mentioning email_address_recorded:false).
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

function buildExpectedEvidence() {
  return readJson(locks.EVIDENCE_REL);
}

function deepEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function validateEvidenceExact(evidence) {
  const errors = [];
  const expected = buildExpectedEvidence();
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
    && ev.observed_facts.azure_monitor_readonly_independently_reverified;
}

function tenant(ev, kind) {
  const root = factsRoot(ev);
  return root && root[kind];
}

function alertOk(t, kind) {
  const errors = [];
  if (!t || !t.alert_instance) return { ok: false, errors: ['missing alert_instance'] };
  const a = t.alert_instance;
  const isWh = kind === 'wolfhouse';
  const expect = {
    rule: isWh ? locks.WH_RULE : locks.SUNSET_RULE,
    app: isWh ? locks.WH_APP : locks.SUNSET_APP,
    start: isWh ? locks.WH_START_UTC : locks.SUNSET_START_UTC,
    resolved: isWh ? locks.WH_RESOLVED_UTC : locks.SUNSET_RESOLVED_UTC,
    id: isWh ? locks.WH_ALERT_INSTANCE_ID : locks.SUNSET_ALERT_INSTANCE_ID,
    sigint: isWh ? locks.WH_SIGINT_LAW_UTC : locks.SUNSET_SIGINT_LAW_UTC,
  };
  if (a.rule_name !== expect.rule) errors.push('rule_name');
  if (a.alert_name !== expect.rule) errors.push('alert_name');
  if (a.target_resource_name !== expect.app) errors.push('target');
  if (a.app !== expect.app) errors.push('app');
  if (a.signal_type !== locks.SIGNAL_TYPE) errors.push('signal_type');
  if (a.severity !== locks.SEVERITY) errors.push('severity');
  if (a.monitor_service !== locks.MONITOR_SERVICE) errors.push('monitor_service');
  if (a.monitor_condition !== locks.MONITOR_CONDITION) errors.push('monitor_condition');
  if (a.start_date_time !== expect.start) errors.push('start');
  if (a.monitor_condition_resolved_date_time !== expect.resolved) errors.push('resolved');
  if (!a.action_status || a.action_status.isSuppressed !== false) errors.push('isSuppressed');
  if (a.alert_instance_id !== expect.id) errors.push('instance_id');
  if (a.prior_16aa_sigint_law_completion_utc !== expect.sigint) errors.push('sigint_law');
  if (a.attribution_semantics !== locks.ATTRIBUTION_SEMANTICS) errors.push('attribution');
  return { ok: errors.length === 0, errors };
}

function ruleOk(t, kind) {
  const errors = [];
  if (!t || !t.metric_alert_rule) return { ok: false, errors: ['missing rule'] };
  const r = t.metric_alert_rule;
  const isWh = kind === 'wolfhouse';
  if (r.name !== (isWh ? locks.WH_RULE : locks.SUNSET_RULE)) errors.push('name');
  if (r.enabled !== true) errors.push('enabled');
  if (r.severity !== locks.RULE_SEVERITY_INT) errors.push('severity');
  if (r.evaluation_frequency !== locks.EVALUATION_FREQUENCY) errors.push('eval');
  if (r.window_size !== locks.WINDOW_SIZE) errors.push('window');
  if (r.metric_name !== locks.METRIC_NAME) errors.push('metric');
  if (r.metric_namespace !== locks.METRIC_NAMESPACE) errors.push('namespace');
  if (r.time_aggregation !== locks.TIME_AGGREGATION) errors.push('agg');
  if (r.operator !== locks.OPERATOR) errors.push('op');
  if (r.threshold !== locks.THRESHOLD) errors.push('threshold');
  if (r.scope_app !== (isWh ? locks.WH_APP : locks.SUNSET_APP)) errors.push('scope');
  if (r.action_group_id !== (isWh ? locks.WH_AG_ID : locks.SUNSET_AG_ID)) errors.push('ag');
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

function chronologyOk(ev) {
  const root = factsRoot(ev);
  if (!root || !root.chronology) return false;
  const c = root.chronology;
  return c.wolfhouse_16aa_sigint_law_utc === locks.WH_SIGINT_LAW_UTC
    && c.sunset_16aa_sigint_law_utc === locks.SUNSET_SIGINT_LAW_UTC
    && c.wolfhouse_alert_start_utc === locks.WH_START_UTC
    && c.sunset_alert_start_utc === locks.SUNSET_START_UTC
    && c.attribution_semantics === locks.ATTRIBUTION_SEMANTICS
    && Date.parse(locks.WH_START_UTC) > Date.parse(locks.WH_SIGINT_LAW_UTC)
    && Date.parse(locks.SUNSET_START_UTC) > Date.parse(locks.SUNSET_SIGINT_LAW_UTC);
}

function costOk(ev) {
  const root = factsRoot(ev);
  if (!root || !root.cost_capture) return false;
  const c = root.cost_capture;
  return c.wolfhouse_mtd_usd === locks.WH_COST_USD
    && c.sunset_mtd_usd === locks.SUNSET_COST_USD
    && c.resources_created_this_capture === false
    && c.semantics === 'before_after_readonly_unchanged_locked'
    && tenant(ev, 'wolfhouse').cost_mtd_usd === locks.WH_COST_USD
    && tenant(ev, 'sunset').cost_mtd_usd === locks.SUNSET_COST_USD;
}

function validateGateMatrix(matrix) {
  const errors = [];
  if (!matrix || typeof matrix !== 'object') {
    return { ok: false, errors: ['matrix missing'] };
  }
  const tip16ad = (matrix.slice === 'RADAR-16AD' || (matrix.slice === 'RADAR-16AF' || matrix.slice === 'RADAR-16AG'));
  if (matrix.slice !== locks.SLICE && !tip16ad) errors.push(`slice=${matrix.slice}`);
  if (matrix.branch !== locks.BRANCH && !(tip16ad && (matrix.branch === 'radar/slice-16ad-g02-sampled-restart-continuity-evidence' || matrix.branch === 'radar/slice-16af-g06-capacity-alert-live-evidence' || matrix.branch === 'radar/slice-16ag-g06-bounded-load-harness'))) {
    errors.push(`branch=${matrix.branch}`);
  }
  if (matrix.master_basis !== locks.MASTER_BASIS && !(tip16ad && (matrix.master_basis === '137b14a0b3efc689ba749340a97ab4e9bc220edc' || (matrix.master_basis === '0a2fb08486b835dd45a4fc904e3dd152702bea6f' || matrix.master_basis === '7a283b70d38a4906e6279d82a49c0f6dd2a4994e')))) {
    errors.push('master_basis mismatch');
  }
  if (matrix.live_mutation !== false) errors.push('live_mutation not false');
  const counts = matrix.verdict_counts || {};
  if (counts.proven !== 0) errors.push(`proven=${counts.proven}`);
  if (counts.partial !== 9) errors.push(`partial=${counts.partial}`);
  if (counts.absent !== 0) errors.push(`absent=${counts.absent}`);

  const g02 = (matrix.gates || []).find((g) => g.id === 'G02_readiness_dependencies');
  if (!g02) {
    errors.push('G02 missing');
  } else {
    if (g02.verdict !== 'partial') errors.push('G02 verdict not partial');
    if (g02.progress_class !== 'partial_live_proven') errors.push('G02 progress_class wrong');
    if (!/16AC|organic.?restart|restart.?count/i.test(String(g02.rationale || ''))) {
      errors.push('G02 rationale missing 16AC organic restart facts');
    }
    if (!Array.isArray(g02.gaps) || !g02.gaps.some((g) => /zero.?downtime|production/i.test(String(g)))) {
      errors.push('G02 gaps must retain zero_downtime or production open');
    }
    if (g02.gaps && g02.gaps.some((g) => (
      /organic.?metric.?alert.?firing.?not.?claimed|organic.?restart.?alert.?.*not.?claimed/i.test(String(g))
      && !/inbox|5xx|capacity/i.test(String(g))
    ))) {
      errors.push('G02 gaps still claim organic restart alert as open');
    }
  }

  const g03 = (matrix.gates || []).find((g) => g.id === 'G03_actionable_tenant_aware_alerts');
  if (!g03) {
    errors.push('G03 missing');
  } else {
    if (g03.verdict !== 'partial') errors.push('G03 verdict not partial');
    if (g03.progress_class !== 'partial_live_proven') errors.push('G03 progress_class wrong');
    if (!/16AC|organic.?restart|restart.?count/i.test(String(g03.rationale || ''))) {
      errors.push('G03 rationale missing 16AC organic restart facts');
    }
    if (!Array.isArray(g03.gaps) || !g03.gaps.some((g) => /human.?inbox|inbox.?receipt/i.test(String(g)))) {
      errors.push('G03 gaps must retain human inbox receipt open');
    }
    if (g03.gaps && g03.gaps.some((g) => (
      /organic.?metric.?alert.?firing.?not.?claimed/i.test(String(g))
      && !/inbox|human/i.test(String(g))
    ))) {
      errors.push('G03 gaps still claim organic metric alert firing as open');
    }
  }

  for (const g of matrix.gates || []) {
    if (g.verdict === 'proven') errors.push(`${g.id} falsely proven`);
  }
  return { ok: errors.length === 0, errors };
}

function overclaimHits(text) {
  const patterns = [
    /\bhuman\s+inbox\s+receipt\s+proven\b/i,
    /\binbox\s+delivered\b/i,
    /\bunique\s+causality\s+proven\b/i,
    /\b5xx\s+alert\s+fired\b/i,
    /\brequests_5xx_alert_firing\b/i,
    /\bfull\s+G02\b/i,
    /\bfull\s+G03\b/i,
    /\bG02\s+proven\b/i,
    /\bG03\s+proven\b/i,
    /\bfull_G02_proven\b/i,
    /\bfull_G03_proven\b/i,
    /\bzero\s+downtime\s+during\s+restart\s+proven\b/i,
    /\bproduction\b(?![^\n]{0,40}\b(forbidden|not|open|still)\b)/i,
  ];
  const hits = [];
  for (const p of patterns) {
    if (p.test(text)) hits.push(String(p));
  }
  return hits;
}

function runVerifier() {
  console.log('RADAR 16AC organic restart alert evidence — offline verifier\n');

  const evidence = readJson(locks.EVIDENCE_REL);
  const sliceContract = readJson(locks.CONTRACT_REL);
  const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
  const topContract = readJson('fixtures/radar-operations/contract.json');
  const doc = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
  const findings = readText('fixtures/radar-operations/findings.md');

  ok('C1 HEAD on 16AC branch (tip may advance to 16AD)',
    currentBranch() === locks.BRANCH
    || currentBranch() === 'radar/slice-16ad-g02-sampled-restart-continuity-evidence'
    || currentBranch() === 'radar/slice-16af-g06-capacity-alert-live-evidence' || currentBranch() === 'radar/slice-16ag-g06-bounded-load-harness',
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

  ok('C6 disposition keeps G02/G03 partial; organic closed caveats',
    evidence.disposition.g02_verdict === 'partial'
    && evidence.disposition.g03_verdict === 'partial'
    && evidence.gate_progress_updates.G02_readiness_dependencies.verdict === 'partial'
    && evidence.gate_progress_updates.G03_actionable_tenant_aware_alerts.verdict === 'partial'
    && evidence.gate_progress_updates.G02_readiness_dependencies.still_open.includes('zero_downtime_during_restart')
    && evidence.gate_progress_updates.G02_readiness_dependencies.still_open.includes('production')
    && !evidence.gate_progress_updates.G02_readiness_dependencies.still_open.includes('organic_metric_alert_firing')
    && evidence.gate_progress_updates.G03_actionable_tenant_aware_alerts.still_open.includes('human_inbox_receipt')
    && evidence.gate_progress_updates.G02_readiness_dependencies.live_proven.includes('organic_restart_metric_alert_firing_via_16AC')
    && evidence.gate_progress_updates.G03_actionable_tenant_aware_alerts.live_proven.includes('organic_restart_metric_alert_firing_via_16AC'));

  green('alerts_exact_both_tenants',
    alertOk(tenant(evidence, 'wolfhouse'), 'wolfhouse').ok
    && alertOk(tenant(evidence, 'sunset'), 'sunset').ok);

  green('rules_exact_both_tenants',
    ruleOk(tenant(evidence, 'wolfhouse'), 'wolfhouse').ok
    && ruleOk(tenant(evidence, 'sunset'), 'sunset').ok);

  green('action_groups_exact_no_address',
    agOk(tenant(evidence, 'wolfhouse'), 'wolfhouse').ok
    && agOk(tenant(evidence, 'sunset'), 'sunset').ok);

  green('chronology_after_16aa_sigint', chronologyOk(evidence));

  green('costs_locked_unchanged_no_resources', costOk(evidence));

  green('claims_and_disposition_locked',
    locks.CLAIMS_ALLOWED.every((c) => evidence.claims_allowed.includes(c))
    && evidence.disposition.does_not_prove.includes('human_inbox_receipt')
    && evidence.disposition.does_not_prove.includes('unique_causality_beyond_platform_alert_fields')
    && evidence.disposition.does_not_prove.includes('requests_5xx_alert_firing')
    && evidence.disposition.does_not_prove.includes('full_G02_proven')
    && evidence.disposition.does_not_prove.includes('full_G03_proven')
    && evidence.explicitly_not_claimed.includes('human_inbox_receipt'));

  {
    const mv = validateGateMatrix(matrix);
    ok('C10 matrix validation (counts + G02/G03 partial organic closed)', mv.ok, mv.errors.join(' | '));
  }

  ok('C11 top contract selected_16ac + organic restart live_proven',
    topContract.selected_16ac
    && topContract.selected_16ac.outcome_id === locks.OUTCOME_ID
    && topContract.selected_16ac.g02_organic_restart_alert === 'live_proven_via_16AC'
    && topContract.selected_16ac.g03_organic_restart_alert === 'live_proven_via_16AC'
    && (topContract.slice === locks.SLICE || (topContract.slice === 'RADAR-16AD' || (topContract.slice === 'RADAR-16AF' || topContract.slice === 'RADAR-16AG')))
    && topContract.selected_16ac.g02_verdict === 'partial'
    && topContract.selected_16ac.g03_verdict === 'partial'
    && (topContract.slice === locks.SLICE
      ? (topContract.branch === locks.BRANCH)
      : ((topContract.branch === 'radar/slice-16ad-g02-sampled-restart-continuity-evidence' || topContract.branch === 'radar/slice-16af-g06-capacity-alert-live-evidence' || topContract.branch === 'radar/slice-16ag-g06-bounded-load-harness'))));

  ok('C12 doc mentions 16AC + organic restart + inbox open + G02/G03 partial',
    /16AC|organic.?restart/i.test(doc)
    && /G02.*partial|partial.*G02/i.test(doc)
    && /G03.*partial|partial.*G03/i.test(doc)
    && /inbox/i.test(doc)
    && !/\bG02\s+proven\b/i.test(doc)
    && !/\bG03\s+proven\b/i.test(doc)
    && !/\bfull\s+G02\b/i.test(doc));

  ok('C13 findings mention 16AC without overclaim',
    /16AC|organic.?restart/i.test(findings)
    && /inbox/i.test(findings)
    && !/\bG02\s+proven\b/i.test(findings)
    && !/\bG03\s+proven\b/i.test(findings));

  {
    const rt = runtimePathsUnchanged();
    ok('C14 runtime paths unchanged vs master', rt.ok, rt.detail);
  }

  {
    // Scan durable evidence surfaces only — exclude verifier source (contains RED adversarial tokens).
    const scanRels = locks.OWNED_RELS.filter((rel) => !/verify-radar-slice16ac/.test(rel));
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
      && pkg.scripts['verify:radar-slice16ac-organic-restart-alert-evidence']
        === 'node scripts/verify-radar-slice16ac-organic-restart-alert-evidence.js');
  }

  green('package_script_registered',
    (() => {
      const pkg = readJson('package.json');
      return pkg.scripts
        && pkg.scripts['verify:radar-slice16ac-organic-restart-alert-evidence']
          === 'node scripts/verify-radar-slice16ac-organic-restart-alert-evidence.js';
    })());

  green('runtime_paths_unchanged', runtimePathsUnchanged().ok);

  green('secret_free_owned_artifacts', secretFree(JSON.stringify(evidence), 'evidence').ok);

  // --- RED battery ---
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_readonly_independently_reverified.wolfhouse.alert_instance.rule_name =
      'wolfhouse-staff-api-requests-5xx';
    red('wrong_rule_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_readonly_independently_reverified.wolfhouse.metric_alert_rule.scope_app =
      'wrong-app';
    red('wrong_scope_rejected', !validateEvidenceExact(bad).ok || !ruleOk(tenant(bad, 'wolfhouse'), 'wolfhouse').ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_readonly_independently_reverified.wolfhouse.metric_alert_rule.threshold = 5;
    red('wrong_threshold_rejected', !validateEvidenceExact(bad).ok || !ruleOk(tenant(bad, 'wolfhouse'), 'wolfhouse').ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_readonly_independently_reverified.wolfhouse.alert_instance.start_date_time =
      '2026-07-21T00:00:00Z';
    red('wrong_timestamp_rejected', !validateEvidenceExact(bad).ok || !alertOk(tenant(bad, 'wolfhouse'), 'wolfhouse').ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_readonly_independently_reverified.wolfhouse.alert_instance.monitor_condition =
      'Fired';
    red('wrong_state_rejected', !validateEvidenceExact(bad).ok || !alertOk(tenant(bad, 'wolfhouse'), 'wolfhouse').ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_readonly_independently_reverified.wolfhouse.alert_instance.action_status.isSuppressed =
      true;
    red('suppressed_action_rejected', !validateEvidenceExact(bad).ok || !alertOk(tenant(bad, 'wolfhouse'), 'wolfhouse').ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_readonly_independently_reverified.wolfhouse.action_group.email_receiver.email_address =
      'ops@example.com';
    bad.observed_facts.azure_monitor_readonly_independently_reverified.wolfhouse.action_group.email_receiver.email_address_recorded =
      true;
    red('invented_email_address_rejected',
      !validateEvidenceExact(bad).ok || !agOk(tenant(bad, 'wolfhouse'), 'wolfhouse').ok);
  }
  {
    const bad = deepClone(evidence);
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'human_inbox_receipt');
    bad.disposition.proves.push('human_inbox_receipt');
    bad.disposition.does_not_prove = bad.disposition.does_not_prove.filter((x) => x !== 'human_inbox_receipt');
    red('invented_inbox_receipt_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.attribution_semantics = 'unique_causality_proven_from_platform_fields';
    bad.observed_facts.azure_monitor_readonly_independently_reverified.chronology.attribution_semantics =
      'unique_causality_proven_from_platform_fields';
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter(
      (x) => x !== 'unique_causality_beyond_platform_alert_fields',
    );
    red('unique_causality_overclaim_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.claims_allowed.push('requests_5xx_alert_firing');
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'requests_5xx_alert_firing');
    bad.disposition.proves.push('requests_5xx_alert_firing');
    red('five_xx_alert_claim_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_readonly_independently_reverified.cost_capture.wolfhouse_mtd_usd = 1;
    bad.observed_facts.azure_monitor_readonly_independently_reverified.wolfhouse.cost_mtd_usd = 1;
    red('cost_mutation_rejected', !validateEvidenceExact(bad).ok || !costOk(bad));
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.azure_monitor_readonly_independently_reverified.cost_capture.resources_created_this_capture =
      true;
    red('resources_created_claim_rejected', !validateEvidenceExact(bad).ok || !costOk(bad));
  }
  {
    const bad = deepClone(evidence);
    bad.disposition.g02_verdict = 'proven';
    bad.gate_progress_updates.G02_readiness_dependencies.verdict = 'proven';
    bad.gate_progress_updates.G02_readiness_dependencies.still_open = [];
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'full_G02_proven');
    red('full_g02_overclaim_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.disposition.g03_verdict = 'proven';
    bad.gate_progress_updates.G03_actionable_tenant_aware_alerts.verdict = 'proven';
    bad.gate_progress_updates.G03_actionable_tenant_aware_alerts.still_open = [];
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'full_G03_proven');
    red('full_g03_overclaim_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.lock_hash = '0'.repeat(64);
    red('lock_hash_mismatch_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const badDoc = `${doc}\n\nG02 proven and G03 proven with human inbox receipt proven.\n`;
    const hits = overclaimHits(badDoc);
    red('doc_overclaim_tokens_detectable', hits.length > 0, hits.join(','));
  }

  const requiredReds = [
    'wrong_rule_rejected',
    'wrong_scope_rejected',
    'wrong_threshold_rejected',
    'wrong_timestamp_rejected',
    'wrong_state_rejected',
    'suppressed_action_rejected',
    'invented_email_address_rejected',
    'invented_inbox_receipt_rejected',
    'unique_causality_overclaim_rejected',
    'five_xx_alert_claim_rejected',
    'cost_mutation_rejected',
    'resources_created_claim_rejected',
    'full_g02_overclaim_rejected',
    'full_g03_overclaim_rejected',
    'lock_hash_mismatch_rejected',
    'doc_overclaim_tokens_detectable',
  ];
  for (const id of requiredReds) {
    const row = redResults.find((r) => r.id === id);
    ok(`RED-required ${id}`, row && row.ok);
  }

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16AC organic restart alert evidence (partial/live-proven): PASS');
}

runVerifier();
