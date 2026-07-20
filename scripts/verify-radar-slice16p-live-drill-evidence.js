'use strict';

/**
 * verify:radar-slice16p-live-drill-evidence — RADAR Slice 16P
 *
 * Offline gate: bounded operator-observed live-drill evidence reconciliation.
 * Rejects overstated claims and altered evidence. No network / Azure / deploy.
 *
 * Blocker fixes:
 * 1) Exact recursive evidence schema (no unknown/missing keys; array length/order/type/value).
 * 2) Canonical SHA-256 over entire evidence object excluding only lock_hash.
 * 3) Real matrix validation shared by GREEN + tamper REDs (never tautological).
 * 4) Field-level JSON / statement-local Markdown overclaim checks (denial cannot mask siblings).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16p-live-drill-evidence');

const RED_MIXED_JSON_REL = 'fixtures/radar-operations/slice16p-red-mixed-overclaim.json';
const RED_MIXED_MD_REL = 'fixtures/radar-operations/slice16p-red-mixed-overclaim.md';

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

/** Stable canonical JSON (sorted object keys; arrays preserve order). */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Entire evidence object excluding only its own lock_hash field. */
function evidenceHashPayload(ev) {
  const clone = deepClone(ev);
  delete clone.lock_hash;
  return clone;
}

function computeEvidenceLockHash(ev) {
  return crypto.createHash('sha256').update(stableStringify(evidenceHashPayload(ev))).digest('hex');
}

function buildExpectedEvidence() {
  return {
    schema_version: 1,
    slice: locks.SLICE,
    outcome_id: locks.OUTCOME_ID,
    gate_ids_touched: [
      'G02_readiness_dependencies',
      'G03_actionable_tenant_aware_alerts',
      'G07_rollback_incident_runbooks',
      'G08_retention_privacy',
      'G09_cost_controls',
    ],
    master_basis: locks.MASTER_BASIS,
    branch: locks.BRANCH,
    audit_only: true,
    live_mutation: false,
    this_slice_deploys: false,
    progress_class: locks.PROGRESS_CLASS,
    title: 'Reconcile operator-observed 16O live-drill evidence (bounded; no overclaims)',
    image_sha_short: locks.IMAGE_SHA_SHORT,
    image_sha_full: locks.IMAGE_SHA_FULL,
    observed_facts: {
      '16o_deploy': {
        image_sha_short: locks.IMAGE_SHA_SHORT,
        wolfhouse_revision: locks.WH_DEPLOY_REV,
        sunset_revision: locks.SUNSET_DEPLOY_REV,
        health_ready_observed: true,
        webhook_generic_responses_observed: [...locks.WEBHOOK_GENERIC],
      },
      rollback_rollforward: {
        wolfhouse: {
          rollback_revision: locks.WH_ROLLBACK_REV,
          rollforward_revision: locks.WH_ROLLFORWARD_REV,
        },
        sunset: {
          rollback_revision: locks.SUNSET_ROLLBACK_REV,
          rollforward_revision: locks.SUNSET_ROLLFORWARD_REV,
        },
        health_readiness_passed_after: true,
        final_image_sha_short: locks.IMAGE_SHA_SHORT,
      },
      action_group_test_notification_api: {
        wolfhouse: { ...locks.AG_WH },
        sunset: { ...locks.AG_SUNSET },
      },
    },
    claims_allowed: [
      '16O_image_sha_594247f_deployed_to_wolfhouse_0000514_and_sunset_0000274',
      'health_and_ready_observed_on_deployed_revisions',
      'malformed_missing_oversize_generic_webhook_responses_observed',
      'rollback_then_rollforward_wolfhouse_0000515_0000516_sunset_0000275_0000276',
      'health_readiness_passed_after_rollforward_final_image_594247f',
      'action_group_test_notification_api_email_status_succeeded_state_complete_both_tenants',
    ],
    explicitly_not_claimed: [...locks.EXPLICITLY_NOT_CLAIMED],
    gate_progress_updates: {
      G02_readiness_dependencies: {
        progress_class: 'partial_live_proven',
        live_proven: [
          'healthy_/healthz_and_/readyz_after_16O_deploy_and_rollforward',
        ],
        still_open: [
          'controlled_dependency_failure_traffic_shed_drill',
          'closeReadinessPool_lifecycle_integration',
        ],
      },
      G03_actionable_tenant_aware_alerts: {
        progress_class: 'partial_live_proven',
        live_proven: [
          'action_group_test_notification_api_Email_Status_Succeeded_state_Complete_both_tenants',
        ],
        still_open: [
          'human_inbox_receipt',
          'organic_metric_alert_firing',
        ],
      },
      G07_rollback_incident_runbooks: {
        progress_class: 'partial_live_proven',
        live_proven: [
          'staff_api_revision_rollback_then_rollforward_both_tenants_health_ready_final_594247f',
        ],
        still_open: [
          'postgres_restore_drill',
          'geo_redundant_backup',
        ],
      },
      G08_retention_privacy: {
        progress_class: 'partial_live_proven',
        live_proven: [
          '16O_deploy_SHA_594247f',
          'malformed_missing_oversize_generic_stripe_webhook_error_bodies',
          'health_ready_observed',
        ],
        still_open: [
          'abrupt_paths',
          'log_retention_pii_redaction_proof',
          'retention_search',
          'sdk_unavailable_missing_secret_live_inject',
        ],
      },
      G09_cost_controls: {
        progress_class: 'partial_live_proven',
        live_proven: [
          'ops_action_group_test_notification_api_Email_Status_Succeeded_state_Complete_both_tenants',
        ],
        still_open: [
          'human_inbox_receipt',
          'budget_resource_live_list_proof',
          'anomaly_detection',
        ],
      },
    },
    gates_unchanged_source_partial: [...locks.SOURCE_PARTIAL_GATES],
  };
}

/**
 * Exact recursive equality: reject unknown/missing properties and wrong
 * array length/order/type/value at every nesting level.
 */
function exactDeepEqual(actual, expected, path) {
  const errors = [];
  const p = path || '$';

  if (expected === null || typeof expected !== 'object') {
    if (actual !== expected) {
      errors.push(`${p}: value mismatch (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    }
    return errors;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      errors.push(`${p}: expected array, got ${typeof actual}`);
      return errors;
    }
    if (actual.length !== expected.length) {
      errors.push(`${p}: array length ${actual.length} !== ${expected.length}`);
    }
    const n = Math.max(actual.length, expected.length);
    for (let i = 0; i < n; i += 1) {
      if (i >= expected.length) {
        errors.push(`${p}[${i}]: unexpected element ${JSON.stringify(actual[i])}`);
      } else if (i >= actual.length) {
        errors.push(`${p}[${i}]: missing element (expected ${JSON.stringify(expected[i])})`);
      } else {
        errors.push(...exactDeepEqual(actual[i], expected[i], `${p}[${i}]`));
      }
    }
    return errors;
  }

  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    errors.push(`${p}: expected object, got ${Array.isArray(actual) ? 'array' : typeof actual}`);
    return errors;
  }

  const expKeys = Object.keys(expected).sort();
  const actKeys = Object.keys(actual).sort();
  for (const k of actKeys) {
    if (!Object.prototype.hasOwnProperty.call(expected, k)) {
      errors.push(`${p}.${k}: unknown property`);
    }
  }
  for (const k of expKeys) {
    if (!Object.prototype.hasOwnProperty.call(actual, k)) {
      errors.push(`${p}.${k}: missing property`);
    } else {
      errors.push(...exactDeepEqual(actual[k], expected[k], `${p}.${k}`));
    }
  }
  return errors;
}

/** Validate evidence against exact expected schema (+ lock_hash format/match). */
function validateEvidenceExact(ev) {
  const errors = [];
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    return { ok: false, errors: ['$: not an object'] };
  }
  const expected = buildExpectedEvidence();
  const withoutHash = deepClone(ev);
  const gotHash = withoutHash.lock_hash;
  delete withoutHash.lock_hash;

  errors.push(...exactDeepEqual(withoutHash, expected, '$'));

  if (typeof gotHash !== 'string' || !/^[0-9a-f]{64}$/.test(gotHash)) {
    errors.push('$.lock_hash: must be 64-char lowercase hex');
  } else {
    const recomputed = computeEvidenceLockHash(ev);
    if (gotHash !== recomputed) {
      errors.push(`$.lock_hash: mismatch (got=${gotHash} expected=${recomputed})`);
    }
  }

  // lock_hash must be the only extra top-level key beyond expected
  const topKeys = Object.keys(ev).sort();
  const allowedTop = [...Object.keys(expected), 'lock_hash'].sort();
  for (const k of topKeys) {
    if (!allowedTop.includes(k)) errors.push(`$.${k}: unknown property`);
  }
  for (const k of allowedTop) {
    if (!Object.prototype.hasOwnProperty.call(ev, k)) errors.push(`$.${k}: missing property`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Real matrix validation used by GREEN and tamper REDs.
 * Returns { ok, errors } — never a tautology over the mutation itself.
 */
function validateGateMatrix(matrix) {
  const errors = [];
  if (!matrix || typeof matrix !== 'object') {
    return { ok: false, errors: ['matrix missing'] };
  }
  // Tip may move to a successor slice (e.g. 16Q); 16P still requires selection + live-proven classes.
  if (matrix.live_mutation !== false) errors.push('live_mutation not false');
  if (!matrix.slice_16p_selection
    || matrix.slice_16p_selection.outcome_id !== locks.OUTCOME_ID) {
    errors.push('slice_16p_selection missing or wrong outcome');
  }

  const counts = matrix.verdict_counts || {};
  if (counts.proven !== 0) errors.push(`proven=${counts.proven} (must be 0)`);
  if (counts.partial !== 9) errors.push(`partial=${counts.partial} (must be 9)`);
  if (counts.absent !== 0) errors.push(`absent=${counts.absent} (must be 0)`);
  if (counts.total !== 9) errors.push(`total=${counts.total} (must be 9)`);

  if (!Array.isArray(matrix.gates) || matrix.gates.length !== 9) {
    errors.push(`gates length ${matrix.gates && matrix.gates.length}`);
  }

  for (const gid of locks.LIVE_PROVEN_GATES) {
    const g = (matrix.gates || []).find((x) => x.id === gid);
    if (!g) {
      errors.push(`${gid} missing`);
      continue;
    }
    if (g.verdict !== 'partial') errors.push(`${gid} verdict=${g.verdict}`);
    if (g.progress_class !== 'partial_live_proven') {
      errors.push(`${gid} progress_class=${g.progress_class}`);
    }
  }

  for (const gid of locks.SOURCE_PARTIAL_GATES) {
    const g = (matrix.gates || []).find((x) => x.id === gid);
    if (!g) {
      errors.push(`${gid} missing`);
      continue;
    }
    if (g.progress_class === 'partial_live_proven' || g.verdict === 'proven') {
      errors.push(`${gid} unexpectedly live-proven/proven`);
    }
  }

  for (const g of matrix.gates || []) {
    if (g.verdict === 'proven') errors.push(`${g.id} verdict proven forbidden`);
  }

  return { ok: errors.length === 0, errors };
}

const DENIAL_FIELD_RE = /(^|\.)(explicitly_not_claimed|still_open|must_not_claim|must_not|gaps|out_of_scope|forbidden_claim|does_not_implement|not_claimed)(\.|$|\[)/i;

const DENIAL_LOCAL_RE = /not claimed|still open|remain(?:s)? open|explicitly_not|does not claim|do not claim|forbidden|out_of_scope|does_not_implement|is not (?:inbox )?proof|not observed|not deploy/i;

// Claim verb must be adjacent to the topic (no cross-list matching into a later "proven").
const POSITIVE_CLAIM_CHECKS = [
  {
    id: 'human_inbox_proven',
    re: /human[_\s-]?inbox[_\s-]?(?:receipt|received)\s+(?:is\s+|was\s+)?(?:proven|live-proven|closed|confirmed|observed)\b/i,
  },
  {
    id: 'organic_alert_proven',
    re: /organic[_\s-]?metric[_\s-]?alert(?:\s+firing)?\s+(?:is\s+|was\s+)?(?:proven|live-proven|fired|firing\s+observed|closed)\b/i,
  },
  {
    id: 'production_done',
    re: /\bproduction[_\s-]+(?:deploy|live|proven|complete|done)\b/i,
  },
  {
    id: 'abrupt_proven',
    re: /abrupt[_\s-]?paths?\s+(?:are\s+|is\s+|was\s+)?(?:proven|live-proven|closed|done)\b/i,
  },
  {
    id: 'retention_search_proven',
    re: /retention[_\s/-]?search\s+(?:is\s+|was\s+)?(?:proven|live-proven|closed|done)\b/i,
  },
  {
    id: 'dependency_failure_proven',
    re: /dependency[_\s-]?failure\s+(?:is\s+|was\s+|drill\s+)?(?:proven|live-proven|closed|done)\b/i,
  },
  {
    id: 'real_pg_proven',
    re: /real[_\s-]?pg[_\s-]?contention\s+(?:is\s+|was\s+)?(?:proven|live-proven|closed|done)\b/i,
  },
  {
    id: 'completion_logging_proven',
    re: /completion[_\s-]?logging\s+(?:is\s+|was\s+)?(?:proven|live-proven|implemented|closed|done)\b/i,
  },
  {
    id: 'verdict_proven',
    re: /"verdict"\s*:\s*"proven"/,
  },
  {
    id: 'proven_count_nonzero',
    re: /"proven"\s*:\s*[1-9]/,
  },
];

const WHOLE_STATEMENT_DENIAL_RE = /^(?:[-*]\s*)?(?:\*\*)?(?:does not (?:implement|claim)|do not claim|explicitly (?:do\s+)?not claim|explicitly_not_claimed|still open|out_of_scope|forbidden)/i;

function isDenialFieldPath(fieldPath) {
  return DENIAL_FIELD_RE.test(fieldPath);
}

function statementHasPositiveClaim(statement) {
  const hits = [];
  const trimmed = String(statement).trim();
  // Whole-statement denial frames (topic lists) are not positive claims.
  // A separate sibling statement/field with a positive claim is still caught elsewhere.
  const wholeDenial = WHOLE_STATEMENT_DENIAL_RE.test(trimmed);
  for (const check of POSITIVE_CLAIM_CHECKS) {
    if (!check.re.test(trimmed)) continue;
    if (check.id === 'verdict_proven' || check.id === 'proven_count_nonzero') {
      hits.push(check.id);
      continue;
    }
    if (check.id === 'production_done') {
      // Allow "production scope/query/RGs/systems/forbidden" non-claims
      if (/production[_\s-]+(?:scope|rgs?|query|systems|forbidden)/i.test(trimmed)
        && !/production[_\s-]+(?:deploy|live|proven|complete|done)/i.test(trimmed)) {
        continue;
      }
      // "production" alone in a denial list is fine; require deploy/live/proven/done adjacency
      if (wholeDenial && !/production[_\s-]+(?:deploy|live|proven|complete|done)/i.test(trimmed)) {
        continue;
      }
    }
    if (wholeDenial) {
      // Denial list naming the topic is OK; only fail if topic+claim-verb adjacency exists
      // (e.g. "does not claim X. X proven" is two statements — second still hits).
      // Within one denial statement, topic+proven adjacency is still an overclaim.
      hits.push(check.id);
      continue;
    }
    // Pure denial of the topic without claim-verb adjacency already failed the regex.
    // Local denial + claim verb on same statement (mixed) → overclaim.
    if (DENIAL_LOCAL_RE.test(trimmed) && check.re.test(trimmed)) {
      hits.push(check.id);
      continue;
    }
    hits.push(check.id);
  }
  return hits;
}

/** Field-level JSON overclaim scan — sibling denial fields never suppress other fields. */
function scanJsonOverclaims(value, fieldPath) {
  const hits = [];
  const fp = fieldPath || '$';

  if (typeof value === 'string') {
    if (isDenialFieldPath(fp)) {
      // Denial/open allowlists may name topics; only fail if the string itself
      // asserts a positive claim verb.
      const local = statementHasPositiveClaim(value);
      // In still_open / explicitly_not_claimed, topic tokens alone are OK;
      // reject only if a positive claim verb appears (e.g. "... proven").
      for (const id of local) {
        if (id === 'verdict_proven' || id === 'proven_count_nonzero') hits.push(`${fp}:${id}`);
        else if (/(?:proven|live-proven|implemented|deploy\s+done|fired|firing\s+observed)/i.test(value)
          && !DENIAL_LOCAL_RE.test(value)) {
          hits.push(`${fp}:${id}`);
        } else if (/(?:proven|live-proven|implemented|deploy\s+done)/i.test(value)
          && DENIAL_LOCAL_RE.test(value)
          && /(?:proven|live-proven|implemented|deploy\s+done)/i.test(value)) {
          // "X remains open" is fine; "X proven" inside still_open is not
          if (!/remain(?:s)?\s+open|not claimed|still open|does not claim/i.test(value)
            || /(?:proven|live-proven|implemented|deploy\s+done)/i.test(value.replace(/remain(?:s)?\s+open|not claimed|still open|does not claim|forbidden/gi, ''))) {
            // If after stripping denial phrases a claim verb remains → hit
            const stripped = value.replace(/remain(?:s)?\s+open|not claimed|still open|does not claim|forbidden|explicitly not claimed/gi, '');
            if (/(?:proven|live-proven|implemented|deploy\s+done|fired)/i.test(stripped)) {
              hits.push(`${fp}:${id}`);
            }
          }
        }
      }
      return hits;
    }
    for (const id of statementHasPositiveClaim(value)) {
      hits.push(`${fp}:${id}`);
    }
    return hits;
  }

  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      hits.push(...scanJsonOverclaims(item, `${fp}[${i}]`));
    });
    return hits;
  }

  if (value && typeof value === 'object') {
    // Structural verdict/proven fields
    if (Object.prototype.hasOwnProperty.call(value, 'verdict') && value.verdict === 'proven') {
      hits.push(`${fp}.verdict:verdict_proven`);
    }
    if (typeof value.proven === 'number' && value.proven > 0) {
      hits.push(`${fp}.proven:proven_count_nonzero`);
    }
    for (const [k, v] of Object.entries(value)) {
      hits.push(...scanJsonOverclaims(v, `${fp}.${k}`));
    }
  }
  return hits;
}

/** Line/statement-local Markdown overclaim scan — denial on line A cannot mask line B. */
function scanMarkdownOverclaims(text, label) {
  const hits = [];
  const lines = String(text).split(/\n/);
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    // Split into statements within the line
    const statements = line.split(/(?<=[.!;])\s+/).map((s) => s.trim()).filter(Boolean);
    const units = statements.length ? statements : [line];
    for (let si = 0; si < units.length; si += 1) {
      const unit = units[si];
      for (const id of statementHasPositiveClaim(unit)) {
        hits.push(`${label}:L${li + 1}S${si + 1}:${id}`);
      }
    }
  }
  return hits;
}

function assertNoOverclaimArtifacts(artifacts) {
  const hits = [];
  for (const art of artifacts) {
    if (art.kind === 'json') {
      hits.push(...scanJsonOverclaims(art.value, art.label));
    } else if (art.kind === 'markdown') {
      hits.push(...scanMarkdownOverclaims(art.text, art.label));
    } else if (art.kind === 'text') {
      hits.push(...scanMarkdownOverclaims(art.text, art.label));
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
const redMixedJson = readJson(RED_MIXED_JSON_REL);
const redMixedMd = readText(RED_MIXED_MD_REL);

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

ok('C3 HEAD on 16P or successor 16Q branch',
  currentBranch() === locks.BRANCH
  || currentBranch() === 'radar/slice-16q-readiness-failure-drill-harness',
  currentBranch());

{
  const v = validateEvidenceExact(evidence);
  ok('C4 evidence exact recursive schema + lock_hash', v.ok, v.errors.slice(0, 8).join(' | '));
}

ok('C5 explicitly_not_claimed complete',
  Array.isArray(evidence.explicitly_not_claimed)
  && locks.EXPLICITLY_NOT_CLAIMED.every((k) => evidence.explicitly_not_claimed.includes(k))
  && evidence.explicitly_not_claimed.length === locks.EXPLICITLY_NOT_CLAIMED.length);

ok('C6 top-level contract retains selected_16p',
  topContract.selected_16p
  && topContract.selected_16p.outcome_id === locks.OUTCOME_ID
  && topContract.live_mutation === false);

ok('C7 gate-matrix retains slice_16p_selection',
  matrix.slice_16p_selection
  && matrix.slice_16p_selection.outcome_id === locks.OUTCOME_ID
  && matrix.live_mutation === false);

{
  const mv = validateGateMatrix(matrix);
  ok('C8 matrix validation (counts + classes)', mv.ok, mv.errors.join(' | '));
  green('matrix_validation_accepts_frozen', mv.ok, mv.errors.join(' | '));
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
  && evidence.observed_facts['16o_deploy'].webhook_generic_responses_observed[0] === 'malformed_signature'
  && evidence.observed_facts['16o_deploy'].webhook_generic_responses_observed[1] === 'missing_signature'
  && evidence.observed_facts['16o_deploy'].webhook_generic_responses_observed[2] === 'oversize_body');
green('ag_email_status_succeeded_complete',
  evidence.observed_facts.action_group_test_notification_api.wolfhouse.email_status === 'Succeeded'
  && evidence.observed_facts.action_group_test_notification_api.wolfhouse.state === 'Complete'
  && evidence.observed_facts.action_group_test_notification_api.sunset.email_status === 'Succeeded'
  && evidence.observed_facts.action_group_test_notification_api.sunset.state === 'Complete');
green('claims_allowed_and_gate_progress_locked',
  Array.isArray(evidence.claims_allowed) && evidence.claims_allowed.length === 6
  && evidence.gate_progress_updates
  && evidence.gate_progress_updates.G02_readiness_dependencies.progress_class === 'partial_live_proven'
  && evidence.gate_progress_updates.G08_retention_privacy.still_open.includes('retention_search'));

// --- RED: exact schema rejects ---
{
  const altered = deepClone(evidence);
  altered.extra_unknown_field = 'nope';
  red('unknown_top_level_property_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  delete altered.claims_allowed;
  red('missing_claims_allowed_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts['16o_deploy'].webhook_generic_responses_observed = [
    'missing_signature',
    'malformed_signature',
    'oversize_body',
  ];
  red('wrong_webhook_array_order_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts['16o_deploy'].webhook_generic_responses_observed.push('abrupt_paths');
  red('wrong_webhook_array_length_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts['16o_deploy'].health_ready_observed = 'yes';
  red('wrong_nested_type_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts['16o_deploy'].wolfhouse_revision = '0000999';
  red('altered_deploy_revision_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.image_sha_short = 'deadbeef';
  altered.observed_facts['16o_deploy'].image_sha_short = 'deadbeef';
  altered.observed_facts.rollback_rollforward.final_image_sha_short = 'deadbeef';
  red('altered_image_sha_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts.action_group_test_notification_api.wolfhouse.email_status = 'Failed';
  red('altered_ag_email_status_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts.action_group_test_notification_api.sunset.sent_utc = '2026-07-20T00:00:00Z';
  red('altered_ag_timestamp_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts.extra_fact = { bogus: true };
  red('unknown_nested_observed_fact_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.claims_allowed = [...altered.claims_allowed, 'human_inbox_receipt'];
  red('altered_claims_allowed_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.gate_progress_updates.G02_readiness_dependencies.progress_class = 'proven';
  red('altered_gate_progress_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.explicitly_not_claimed = altered.explicitly_not_claimed.filter((x) => x !== 'human_inbox_receipt');
  red('missing_not_claimed_human_inbox_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.explicitly_not_claimed = altered.explicitly_not_claimed.filter((x) => x !== 'organic_metric_alert_firing');
  red('missing_not_claimed_organic_alert_rejected', !validateEvidenceExact(altered).ok);
}

// --- RED: lock hash covers entire object incl. claims_allowed + gate_progress_updates ---
{
  const expectedHash = computeEvidenceLockHash(evidence);
  ok('C19 evidence.lock_hash matches full canonical payload',
    evidence.lock_hash === expectedHash,
    `got=${evidence.lock_hash} expected=${expectedHash}`);

  const tamperedHash = deepClone(evidence);
  tamperedHash.lock_hash = '0'.repeat(64);
  red('altered_lock_hash_rejected', !validateEvidenceExact(tamperedHash).ok);

  const extraField = deepClone(evidence);
  extraField.smuggled = true;
  delete extraField.lock_hash;
  extraField.lock_hash = computeEvidenceLockHash(extraField);
  // Even with recomputed hash, unknown property fails schema; also prove hash differs from golden
  red('extra_field_breaks_lock_and_schema',
    !validateEvidenceExact(extraField).ok
    && computeEvidenceLockHash(extraField) !== computeEvidenceLockHash(evidence));

  const claimsTamper = deepClone(evidence);
  claimsTamper.claims_allowed = [...claimsTamper.claims_allowed.slice(0, -1), 'smuggled_claim'];
  red('claims_allowed_changes_lock_hash',
    computeEvidenceLockHash(claimsTamper) !== computeEvidenceLockHash(evidence)
    && !validateEvidenceExact(claimsTamper).ok);

  const progressTamper = deepClone(evidence);
  progressTamper.gate_progress_updates.G03_actionable_tenant_aware_alerts.still_open = [];
  red('gate_progress_changes_lock_hash',
    computeEvidenceLockHash(progressTamper) !== computeEvidenceLockHash(evidence)
    && !validateEvidenceExact(progressTamper).ok);
}

// --- RED: matrix validation must fail on G01/G02 tampers (not tautological) ---
{
  const badG01 = deepClone(matrix);
  const g01 = badG01.gates.find((g) => g.id === 'G01_correlation_structured_logs');
  g01.progress_class = 'partial_live_proven';
  g01.verdict = 'proven';
  badG01.verdict_counts.proven = 1;
  badG01.verdict_counts.partial = 8;
  const v = validateGateMatrix(badG01);
  red('matrix_g01_tamper_fails_validation', v.ok === false, v.errors.join(' | '));
}
{
  const badG02 = deepClone(matrix);
  const g02 = badG02.gates.find((g) => g.id === 'G02_readiness_dependencies');
  g02.progress_class = 'source_partial_progress_only';
  badG02.verdict_counts.partial = 8;
  badG02.verdict_counts.proven = 1;
  const v = validateGateMatrix(badG02);
  red('matrix_g02_counts_class_tamper_fails_validation', v.ok === false, v.errors.join(' | '));
}

// --- RED: structured overclaim — mixed denial + positive must reject ---
{
  const over = {
    verdict: 'proven',
    proven: 1,
    note: 'human inbox receipt proven; organic metric alert firing proven; production deploy done; completion logging implemented',
  };
  const hits = scanJsonOverclaims(over, 'synthetic_overclaim');
  red('overstated_proven_verdict_rejected', hits.some((h) => /verdict_proven|proven_count/.test(h)), hits.join(','));
  red('overstated_human_inbox_rejected', hits.some((h) => /human_inbox/.test(h)), hits.join(','));
  red('overstated_organic_alert_rejected', hits.some((h) => /organic_alert/.test(h)), hits.join(','));
  red('overstated_production_rejected', hits.some((h) => /production/.test(h)), hits.join(','));
  red('overstated_completion_logging_rejected', hits.some((h) => /completion_logging/.test(h)), hits.join(','));
}

{
  const mixedHits = scanJsonOverclaims(redMixedJson, 'red_mixed_json');
  red('mixed_json_denial_does_not_mask_inbox', mixedHits.some((h) => /human_inbox/.test(h)), mixedHits.join(','));
  red('mixed_json_denial_does_not_mask_organic', mixedHits.some((h) => /organic_alert/.test(h)), mixedHits.join(','));
  red('mixed_json_denial_does_not_mask_production', mixedHits.some((h) => /production/.test(h)), mixedHits.join(','));
  red('mixed_json_denial_does_not_mask_retention_search', mixedHits.some((h) => /retention_search/.test(h)), mixedHits.join(','));
  red('mixed_json_denial_does_not_mask_dependency', mixedHits.some((h) => /dependency_failure/.test(h)), mixedHits.join(','));
  red('mixed_json_denial_does_not_mask_pg', mixedHits.some((h) => /real_pg/.test(h)), mixedHits.join(','));
  red('mixed_json_denial_does_not_mask_completion', mixedHits.some((h) => /completion_logging/.test(h)), mixedHits.join(','));
}

{
  const mdHits = scanMarkdownOverclaims(redMixedMd, 'red_mixed_md');
  red('mixed_md_denial_does_not_mask_inbox', mdHits.some((h) => /human_inbox/.test(h)), mdHits.join(','));
  red('mixed_md_denial_does_not_mask_organic', mdHits.some((h) => /organic_alert/.test(h)), mdHits.join(','));
  red('mixed_md_denial_does_not_mask_production', mdHits.some((h) => /production/.test(h)), mdHits.join(','));
  red('mixed_md_denial_does_not_mask_retention_search', mdHits.some((h) => /retention_search/.test(h)), mdHits.join(','));
  red('mixed_md_denial_does_not_mask_dependency', mdHits.some((h) => /dependency_failure/.test(h)), mdHits.join(','));
  red('mixed_md_denial_does_not_mask_pg', mdHits.some((h) => /real_pg/.test(h)), mdHits.join(','));
  red('mixed_md_denial_does_not_mask_completion', mdHits.some((h) => /completion_logging/.test(h)), mdHits.join(','));
}

{
  const hits = assertNoOverclaimArtifacts([
    { kind: 'json', label: 'evidence', value: evidence },
    { kind: 'json', label: 'contract', value: contract },
    { kind: 'json', label: 'matrix', value: matrix },
    { kind: 'json', label: 'topContract', value: topContract },
    { kind: 'markdown', label: 'doc', text: doc },
    { kind: 'markdown', label: 'findings', text: findings },
  ]);
  red('artifacts_reject_overstated_claims', hits.length === 0, hits.join(',') || '(clean)');
}

ok('C15 contract forbids claim tokens listed',
  Array.isArray(contract.forbidden_claim_tokens)
  && contract.forbidden_claim_tokens.length >= 8
  && contract.must_not_claim_as_proven.includes('human_inbox_receipt')
  && contract.must_not_claim_as_proven.includes('organic_metric_alert_firing'));

ok('C16 selected_16p final drill frozen',
  matrix.slice_16p_selection.final_controlled_drill
  && matrix.slice_16p_selection.final_controlled_drill.id === '16P_DRILL_evidence_freeze_no_overclaim');

ok('C20 red mixed overclaim fixtures present',
  redMixedJson && redMixedJson.sibling_positive_claims
  && /human inbox receipt proven/i.test(redMixedMd)
  && /remain(?:s)? open/i.test(redMixedMd));

const requiredRed = [
  'unknown_top_level_property_rejected',
  'missing_claims_allowed_rejected',
  'wrong_webhook_array_order_rejected',
  'wrong_webhook_array_length_rejected',
  'wrong_nested_type_rejected',
  'altered_deploy_revision_rejected',
  'altered_image_sha_rejected',
  'altered_ag_email_status_rejected',
  'altered_ag_timestamp_rejected',
  'unknown_nested_observed_fact_rejected',
  'altered_claims_allowed_rejected',
  'altered_gate_progress_rejected',
  'missing_not_claimed_human_inbox_rejected',
  'missing_not_claimed_organic_alert_rejected',
  'altered_lock_hash_rejected',
  'extra_field_breaks_lock_and_schema',
  'claims_allowed_changes_lock_hash',
  'gate_progress_changes_lock_hash',
  'matrix_g01_tamper_fails_validation',
  'matrix_g02_counts_class_tamper_fails_validation',
  'overstated_proven_verdict_rejected',
  'overstated_human_inbox_rejected',
  'overstated_organic_alert_rejected',
  'overstated_production_rejected',
  'overstated_completion_logging_rejected',
  'mixed_json_denial_does_not_mask_inbox',
  'mixed_json_denial_does_not_mask_organic',
  'mixed_json_denial_does_not_mask_production',
  'mixed_json_denial_does_not_mask_retention_search',
  'mixed_json_denial_does_not_mask_dependency',
  'mixed_json_denial_does_not_mask_pg',
  'mixed_json_denial_does_not_mask_completion',
  'mixed_md_denial_does_not_mask_inbox',
  'mixed_md_denial_does_not_mask_organic',
  'mixed_md_denial_does_not_mask_production',
  'mixed_md_denial_does_not_mask_retention_search',
  'mixed_md_denial_does_not_mask_dependency',
  'mixed_md_denial_does_not_mask_pg',
  'mixed_md_denial_does_not_mask_completion',
  'artifacts_reject_overstated_claims',
];
const requiredGreen = [
  'matrix_validation_accepts_frozen',
  'exact_deploy_revisions',
  'exact_rollback_rollforward',
  'exact_ag_timestamps',
  'webhook_generic_three_only',
  'ag_email_status_succeeded_complete',
  'claims_allowed_and_gate_progress_locked',
];

ok('C17 all required RED cases present',
  requiredRed.every((id) => redResults.some((r) => r.id === id && r.ok)),
  requiredRed.filter((id) => !redResults.some((r) => r.id === id && r.ok)).join(','));
ok('C18 all required GREEN cases present',
  requiredGreen.every((id) => greenResults.some((r) => r.id === id && r.ok)),
  requiredGreen.filter((id) => !greenResults.some((r) => r.id === id && r.ok)).join(','));

console.log(`\nResult: ${pass} passed, ${fail} failed`);
console.log(`RED: ${redResults.filter((r) => r.ok).length}/${redResults.length}  GREEN: ${greenResults.filter((r) => r.ok).length}/${greenResults.length}`);
if (fail > 0) process.exit(1);
console.log('RADAR 16P live-drill evidence reconciliation: PASS');
