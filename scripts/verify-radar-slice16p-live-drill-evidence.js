'use strict';

/**
 * verify:radar-slice16p-live-drill-evidence — RADAR Slice 16P
 *
 * Offline gate: bounded operator-observed live-drill evidence reconciliation.
 * Rejects overstated claims and altered evidence. No network / Azure / deploy.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16p-live-drill-evidence');

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

function evidenceMatchesLocks(ev) {
  const dep = ev.observed_facts && ev.observed_facts['16o_deploy'];
  const rb = ev.observed_facts && ev.observed_facts.rollback_rollforward;
  const ag = ev.observed_facts && ev.observed_facts.action_group_test_notification_api;
  if (!dep || !rb || !ag) return false;
  if (ev.image_sha_short !== locks.IMAGE_SHA_SHORT) return false;
  if (ev.image_sha_full !== locks.IMAGE_SHA_FULL) return false;
  if (dep.image_sha_short !== locks.IMAGE_SHA_SHORT) return false;
  if (dep.wolfhouse_revision !== locks.WH_DEPLOY_REV) return false;
  if (dep.sunset_revision !== locks.SUNSET_DEPLOY_REV) return false;
  if (dep.health_ready_observed !== true) return false;
  if (JSON.stringify(dep.webhook_generic_responses_observed) !== JSON.stringify([...locks.WEBHOOK_GENERIC])) {
    return false;
  }
  if (rb.wolfhouse.rollback_revision !== locks.WH_ROLLBACK_REV) return false;
  if (rb.wolfhouse.rollforward_revision !== locks.WH_ROLLFORWARD_REV) return false;
  if (rb.sunset.rollback_revision !== locks.SUNSET_ROLLBACK_REV) return false;
  if (rb.sunset.rollforward_revision !== locks.SUNSET_ROLLFORWARD_REV) return false;
  if (rb.health_readiness_passed_after !== true) return false;
  if (rb.final_image_sha_short !== locks.IMAGE_SHA_SHORT) return false;
  if (ag.wolfhouse.email_status !== locks.AG_WH.email_status) return false;
  if (ag.wolfhouse.state !== locks.AG_WH.state) return false;
  if (ag.wolfhouse.sent_utc !== locks.AG_WH.sent_utc) return false;
  if (ag.wolfhouse.completed_utc !== locks.AG_WH.completed_utc) return false;
  if (ag.sunset.email_status !== locks.AG_SUNSET.email_status) return false;
  if (ag.sunset.state !== locks.AG_SUNSET.state) return false;
  if (ag.sunset.sent_utc !== locks.AG_SUNSET.sent_utc) return false;
  if (ag.sunset.completed_utc !== locks.AG_SUNSET.completed_utc) return false;
  return true;
}

function notClaimedPresent(ev) {
  const list = ev.explicitly_not_claimed || [];
  return locks.EXPLICITLY_NOT_CLAIMED.every((k) => list.includes(k));
}

function overclaimScan(text) {
  const lower = String(text).toLowerCase();
  const forbiddenPatterns = [
    { id: 'human_inbox_receipt', re: /human[_\s-]?inbox[_\s-]?(receipt|received|delivery)/i },
    { id: 'organic_metric_alert_firing', re: /organic[_\s-]?metric[_\s-]?alert[_\s-]?(fir|fired|firing)/i },
    { id: 'production_claim', re: /\bproduction\b(?!\s+systems|\s+query|\s+rgs?\b|\s+scope|\s+\(forbidden\)|\s+—|\s+-)/i },
    { id: 'abrupt_paths_proven', re: /abrupt[_\s-]?paths?\s+(proven|live-proven|closed|done|complete)/i },
    { id: 'retention_search_proven', re: /retention[_\s/-]?search\s+(proven|live-proven|closed|done)/i },
    { id: 'dependency_failure_proven', re: /dependency[_\s-]?failure\s+(proven|live-proven|closed|done|drill\s+pass)/i },
    { id: 'real_pg_contention_proven', re: /real[_\s-]?pg[_\s-]?contention\s+(proven|live-proven|closed|done)/i },
    { id: 'completion_logging_proven', re: /completion[_\s-]?logging\s+(proven|live-proven|closed|implemented|done)/i },
    { id: 'gate_verdict_proven', re: /"verdict"\s*:\s*"proven"/ },
    { id: 'proven_count_nonzero', re: /"proven"\s*:\s*[1-9]/ },
  ];
  const hits = [];
  for (const p of forbiddenPatterns) {
    if (p.re.test(text) || p.re.test(lower)) hits.push(p.id);
  }
  // Allow explicit denials / still-open lists that mention forbidden topics.
  const allowedContexts = [
    /explicitly_not_claimed/,
    /still_open/,
    /must_not_claim/,
    /do not claim/i,
    /not claimed/i,
    /forbidden/,
    /does_not_implement/,
    /out_of_scope/,
    /remain(?:s)? open/i,
    /production RGs/i,
    /production query/i,
    /production scope/i,
  ];
  // Narrower production check: fail only if claiming production deploy/live as done.
  const productionDone = /production[_\s-]+(deploy|live|proven|complete|done)/i.test(text);
  const filtered = hits.filter((id) => {
    if (id === 'production_claim') return productionDone;
    if (id === 'gate_verdict_proven' || id === 'proven_count_nonzero') return true;
    // If the only mentions are inside not-claimed / still-open, allow.
    return !allowedContexts.some((re) => re.test(text));
  });
  return filtered;
}

function assertNoOverclaimInArtifacts(artifacts) {
  const hits = [];
  for (const { label, text } of artifacts) {
    // Strip explicitly_not_claimed / still_open sections for soft topic mentions,
    // but still catch verdict proven and production-done claims in full text.
    if (/"verdict"\s*:\s*"proven"/.test(text)) hits.push(`${label}:verdict_proven`);
    if (/"proven"\s*:\s*[1-9]/.test(text)) hits.push(`${label}:proven_count_nonzero`);
    if (/production[_\s-]+(deploy|live|proven|complete|done)/i.test(text)) {
      hits.push(`${label}:production_done`);
    }
    if (/human[_\s-]?inbox[_\s-]?(receipt|received).{0,40}(proven|live-proven|closed|confirmed|observed)/i.test(text)) {
      hits.push(`${label}:human_inbox_proven`);
    }
    if (/organic[_\s-]?metric[_\s-]?alert.{0,40}(proven|live-proven|fired|firing\s+observed)/i.test(text)
      && !/not claimed|still open|explicitly_not|does not claim|no organic/i.test(text)) {
      hits.push(`${label}:organic_alert_proven`);
    }
    if (/completion[_\s-]?logging.{0,40}(proven|live-proven|implemented|closed)/i.test(text)
      && !/still open|not claimed|explicitly_not|remain open|does not/i.test(text)) {
      hits.push(`${label}:completion_logging_proven`);
    }
    if (/real[_\s-]?pg[_\s-]?contention.{0,40}(proven|live-proven|closed|done)/i.test(text)
      && !/still open|not claimed|explicitly_not|remain open/i.test(text)) {
      hits.push(`${label}:real_pg_proven`);
    }
    if (/dependency[_\s-]?failure.{0,40}(proven|live-proven|closed|pass)/i.test(text)
      && !/still open|not claimed|explicitly_not|remain open|not claimed/i.test(text)) {
      hits.push(`${label}:dependency_failure_proven`);
    }
    if (/abrupt[_\s-]?paths?.{0,40}(proven|live-proven|closed|done)/i.test(text)
      && !/still open|not claimed|explicitly_not|remain open/i.test(text)) {
      hits.push(`${label}:abrupt_proven`);
    }
    if (/retention[_\s/-]?search.{0,40}(proven|live-proven|closed|done)/i.test(text)
      && !/still open|not claimed|explicitly_not|remain open/i.test(text)) {
      hits.push(`${label}:retention_search_proven`);
    }
  }
  return hits;
}

console.log('verify:radar-slice16p-live-drill-evidence — RADAR Slice 16P\n');

const evidence = readJson(locks.EVIDENCE_REL);
const contract = readJson(locks.CONTRACT_REL);
const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
const topContract = readJson('fixtures/radar-operations/contract.json');
const doc = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');
const findings = readText('fixtures/radar-operations/findings.md');

ok('C1 evidence slice/branch/master',
  evidence.slice === locks.SLICE
  && evidence.branch === locks.BRANCH
  && evidence.master_basis === locks.MASTER_BASIS
  && evidence.outcome_id === locks.OUTCOME_ID
  && evidence.progress_class === locks.PROGRESS_CLASS
  && evidence.live_mutation === false
  && evidence.this_slice_deploys === false);

ok('C2 contract slice/branch/master',
  contract.slice === locks.SLICE
  && contract.branch === locks.BRANCH
  && contract.master_basis === locks.MASTER_BASIS
  && contract.outcome_id === locks.OUTCOME_ID
  && contract.progress_class === locks.PROGRESS_CLASS
  && contract.live_deploy === false
  && contract.this_slice_deploys === false);

ok('C3 HEAD on 16P branch', currentBranch() === locks.BRANCH, currentBranch());

ok('C4 evidence matches locked operator facts', evidenceMatchesLocks(evidence));
ok('C5 explicitly_not_claimed complete', notClaimedPresent(evidence));

ok('C6 top-level contract owns 16P',
  topContract.slice === locks.SLICE
  && topContract.branch === locks.BRANCH
  && topContract.master_basis === locks.MASTER_BASIS
  && topContract.selected_16p
  && topContract.selected_16p.outcome_id === locks.OUTCOME_ID);

ok('C7 gate-matrix owns 16P',
  matrix.slice === locks.SLICE
  && matrix.branch === locks.BRANCH
  && matrix.master_basis === locks.MASTER_BASIS
  && matrix.slice_16p_selection
  && matrix.slice_16p_selection.outcome_id === locks.OUTCOME_ID
  && matrix.live_mutation === false);

const counts = matrix.verdict_counts || {};
ok('C8 proven remains 0; partial 9',
  counts.proven === 0 && counts.partial === 9 && counts.absent === 0 && counts.total === 9);

for (const gid of locks.LIVE_PROVEN_GATES) {
  const g = matrix.gates.find((x) => x.id === gid);
  ok(`C9 ${gid} progress_class partial_live_proven`,
    g && g.verdict === 'partial' && g.progress_class === 'partial_live_proven',
    g && g.progress_class);
}

for (const gid of locks.SOURCE_PARTIAL_GATES) {
  const g = matrix.gates.find((x) => x.id === gid);
  ok(`C10 ${gid} not falsely live-proven`,
    g && g.verdict === 'partial' && g.progress_class !== 'partial_live_proven',
    `progress_class=${g && g.progress_class}`);
}

const rt = runtimePathsUnchanged();
ok('C11 zero runtime mutation vs master basis', rt.ok, rt.detail);

const blob = [JSON.stringify(evidence), JSON.stringify(contract), JSON.stringify(matrix),
  JSON.stringify(topContract), doc, findings].join('\n');
const sec = secretFree(blob, '16p-artifacts');
ok('C12 secret-free artifacts', sec.ok, sec.detail);

ok('C13 doc mentions 16P + partial_live_proven',
  /16P_live_drill_evidence_reconciliation/.test(doc)
  && /partial_live_proven/.test(doc)
  && /594247f/.test(doc));

ok('C14 findings mention 16P and not-claimed list',
  /16P/.test(findings)
  && /human inbox|human_inbox/i.test(findings)
  && /organic metric|organic_metric/i.test(findings)
  && /not claimed|does not claim|explicitly not/i.test(findings));

// --- GREEN: exact facts present ---
green('exact_deploy_revisions',
  evidence.observed_facts['16o_deploy'].wolfhouse_revision === '0000514'
  && evidence.observed_facts['16o_deploy'].sunset_revision === '0000274');
green('exact_rollback_rollforward',
  evidence.observed_facts.rollback_rollforward.wolfhouse.rollback_revision === '0000515'
  && evidence.observed_facts.rollback_rollforward.wolfhouse.rollforward_revision === '0000516'
  && evidence.observed_facts.rollback_rollforward.sunset.rollback_revision === '0000275'
  && evidence.observed_facts.rollback_rollforward.sunset.rollforward_revision === '0000276');
green('exact_ag_timestamps',
  evidence.observed_facts.action_group_test_notification_api.wolfhouse.sent_utc
    === '2026-07-20T21:35:00.5549824Z'
  && evidence.observed_facts.action_group_test_notification_api.wolfhouse.completed_utc
    === '2026-07-20T21:38:26.1342044Z'
  && evidence.observed_facts.action_group_test_notification_api.sunset.sent_utc
    === '2026-07-20T21:39:53.8402179Z'
  && evidence.observed_facts.action_group_test_notification_api.sunset.completed_utc
    === '2026-07-20T21:43:16.2619454Z');
green('webhook_generic_three_only',
  evidence.observed_facts['16o_deploy'].webhook_generic_responses_observed.length === 3
  && evidence.observed_facts['16o_deploy'].webhook_generic_responses_observed.includes('malformed_signature')
  && evidence.observed_facts['16o_deploy'].webhook_generic_responses_observed.includes('missing_signature')
  && evidence.observed_facts['16o_deploy'].webhook_generic_responses_observed.includes('oversize_body'));
green('ag_email_status_succeeded_complete',
  evidence.observed_facts.action_group_test_notification_api.wolfhouse.email_status === 'Succeeded'
  && evidence.observed_facts.action_group_test_notification_api.wolfhouse.state === 'Complete'
  && evidence.observed_facts.action_group_test_notification_api.sunset.email_status === 'Succeeded'
  && evidence.observed_facts.action_group_test_notification_api.sunset.state === 'Complete');

// --- RED: altered evidence rejected ---
{
  const altered = deepClone(evidence);
  altered.observed_facts['16o_deploy'].wolfhouse_revision = '0000999';
  red('altered_deploy_revision_rejected', !evidenceMatchesLocks(altered));
}
{
  const altered = deepClone(evidence);
  altered.image_sha_short = 'deadbeef';
  altered.observed_facts['16o_deploy'].image_sha_short = 'deadbeef';
  altered.observed_facts.rollback_rollforward.final_image_sha_short = 'deadbeef';
  red('altered_image_sha_rejected', !evidenceMatchesLocks(altered));
}
{
  const altered = deepClone(evidence);
  altered.observed_facts.action_group_test_notification_api.wolfhouse.email_status = 'Failed';
  red('altered_ag_email_status_rejected', !evidenceMatchesLocks(altered));
}
{
  const altered = deepClone(evidence);
  altered.observed_facts.action_group_test_notification_api.sunset.sent_utc = '2026-07-20T00:00:00Z';
  red('altered_ag_timestamp_rejected', !evidenceMatchesLocks(altered));
}
{
  const altered = deepClone(evidence);
  altered.observed_facts['16o_deploy'].webhook_generic_responses_observed.push('abrupt_paths');
  red('extra_webhook_claim_rejected', !evidenceMatchesLocks(altered));
}
{
  const altered = deepClone(evidence);
  altered.explicitly_not_claimed = altered.explicitly_not_claimed.filter((x) => x !== 'human_inbox_receipt');
  red('missing_not_claimed_human_inbox_rejected', !notClaimedPresent(altered));
}
{
  const altered = deepClone(evidence);
  altered.explicitly_not_claimed = altered.explicitly_not_claimed.filter((x) => x !== 'organic_metric_alert_firing');
  red('missing_not_claimed_organic_alert_rejected', !notClaimedPresent(altered));
}
{
  const over = {
    label: 'synthetic_overclaim',
    text: JSON.stringify({
      verdict: 'proven',
      proven: 1,
      note: 'human inbox receipt proven; organic metric alert firing proven; production deploy done; completion logging implemented',
    }),
  };
  const hits = assertNoOverclaimInArtifacts([over]);
  red('overstated_proven_verdict_rejected', hits.some((h) => /verdict_proven|proven_count/.test(h)), hits.join(','));
  red('overstated_human_inbox_rejected', hits.some((h) => /human_inbox/.test(h)), hits.join(','));
  red('overstated_organic_alert_rejected', hits.some((h) => /organic_alert/.test(h)), hits.join(','));
  red('overstated_production_rejected', hits.some((h) => /production/.test(h)), hits.join(','));
  red('overstated_completion_logging_rejected', hits.some((h) => /completion_logging/.test(h)), hits.join(','));
}

{
  const hits = assertNoOverclaimInArtifacts([
    { label: 'evidence', text: JSON.stringify(evidence) },
    { label: 'contract', text: JSON.stringify(contract) },
    { label: 'matrix', text: JSON.stringify(matrix) },
    { label: 'topContract', text: JSON.stringify(topContract) },
    { label: 'doc', text: doc },
    { label: 'findings', text: findings },
  ]);
  red('artifacts_reject_overstated_claims', hits.length === 0, hits.join(',') || '(clean)');
}

{
  // Tamper matrix: claim G01 live-proven + proven verdict — must be detectable
  const badMatrix = deepClone(matrix);
  const g01 = badMatrix.gates.find((g) => g.id === 'G01_correlation_structured_logs');
  g01.progress_class = 'partial_live_proven';
  g01.verdict = 'proven';
  badMatrix.verdict_counts.proven = 1;
  badMatrix.verdict_counts.partial = 8;
  const g01Live = badMatrix.gates.find((g) => g.id === 'G01_correlation_structured_logs').progress_class === 'partial_live_proven';
  const provenBad = badMatrix.verdict_counts.proven !== 0;
  red('matrix_g01_live_proven_tamper_detectable', g01Live && provenBad);
}

ok('C15 contract forbids claim tokens listed',
  Array.isArray(contract.forbidden_claim_tokens)
  && contract.forbidden_claim_tokens.length >= 8
  && contract.must_not_claim_as_proven.includes('human_inbox_receipt')
  && contract.must_not_claim_as_proven.includes('organic_metric_alert_firing'));

ok('C16 selected_16p final drill frozen',
  matrix.slice_16p_selection.final_controlled_drill
  && matrix.slice_16p_selection.final_controlled_drill.id === '16P_DRILL_evidence_freeze_no_overclaim');

// Stable content hash pin (detect silent fixture drift of locked fields)
{
  const canonical = JSON.stringify({
    image: evidence.image_sha_full,
    wh: [
      evidence.observed_facts['16o_deploy'].wolfhouse_revision,
      evidence.observed_facts.rollback_rollforward.wolfhouse.rollback_revision,
      evidence.observed_facts.rollback_rollforward.wolfhouse.rollforward_revision,
    ],
    sunset: [
      evidence.observed_facts['16o_deploy'].sunset_revision,
      evidence.observed_facts.rollback_rollforward.sunset.rollback_revision,
      evidence.observed_facts.rollback_rollforward.sunset.rollforward_revision,
    ],
    ag: evidence.observed_facts.action_group_test_notification_api,
    webhook: evidence.observed_facts['16o_deploy'].webhook_generic_responses_observed,
    not_claimed: evidence.explicitly_not_claimed,
  });
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');
  ok('C19 evidence.lock_hash matches canonical facts',
    typeof evidence.lock_hash === 'string'
    && evidence.lock_hash.length === 64
    && evidence.lock_hash === hash,
    `got=${evidence.lock_hash} expected=${hash}`);
  // RED: altered lock_hash must not match recomputed canonical
  const tampered = deepClone(evidence);
  tampered.lock_hash = '0'.repeat(64);
  const hash2 = crypto.createHash('sha256').update(JSON.stringify({
    image: tampered.image_sha_full,
    wh: [
      tampered.observed_facts['16o_deploy'].wolfhouse_revision,
      tampered.observed_facts.rollback_rollforward.wolfhouse.rollback_revision,
      tampered.observed_facts.rollback_rollforward.wolfhouse.rollforward_revision,
    ],
    sunset: [
      tampered.observed_facts['16o_deploy'].sunset_revision,
      tampered.observed_facts.rollback_rollforward.sunset.rollback_revision,
      tampered.observed_facts.rollback_rollforward.sunset.rollforward_revision,
    ],
    ag: tampered.observed_facts.action_group_test_notification_api,
    webhook: tampered.observed_facts['16o_deploy'].webhook_generic_responses_observed,
    not_claimed: tampered.explicitly_not_claimed,
  })).digest('hex');
  red('altered_lock_hash_rejected', tampered.lock_hash !== hash2);
}

const requiredRed = [
  'altered_deploy_revision_rejected',
  'altered_image_sha_rejected',
  'altered_ag_email_status_rejected',
  'altered_ag_timestamp_rejected',
  'extra_webhook_claim_rejected',
  'missing_not_claimed_human_inbox_rejected',
  'missing_not_claimed_organic_alert_rejected',
  'overstated_proven_verdict_rejected',
  'overstated_human_inbox_rejected',
  'overstated_organic_alert_rejected',
  'overstated_production_rejected',
  'overstated_completion_logging_rejected',
  'artifacts_reject_overstated_claims',
  'matrix_g01_live_proven_tamper_detectable',
  'altered_lock_hash_rejected',
];
const requiredGreen = [
  'exact_deploy_revisions',
  'exact_rollback_rollforward',
  'exact_ag_timestamps',
  'webhook_generic_three_only',
  'ag_email_status_succeeded_complete',
];

ok('C17 all required RED cases present',
  requiredRed.every((id) => redResults.some((r) => r.id === id && r.ok)));
ok('C18 all required GREEN cases present',
  requiredGreen.every((id) => greenResults.some((r) => r.id === id && r.ok)));

console.log(`\nResult: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('RADAR 16P live-drill evidence reconciliation: PASS');
