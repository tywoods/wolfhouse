'use strict';

/**
 * verify:radar-slice16s-request-log-live-evidence — RADAR Slice 16S
 *
 * Offline gate: bounded dual-staging 16R delivery/search/retention evidence.
 * Rejects altered/missing/extra keys, match_count!=1, wrong SHA/image/revision/
 * app/workspace/customerId/retention/table/timestamp/schema, sensitive fields,
 * and overclaims. No network / Azure / deploy.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16s-request-log-live-evidence');

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

function evidenceHashPayload(ev) {
  const clone = deepClone(ev);
  delete clone.lock_hash;
  return clone;
}

function computeEvidenceLockHash(ev) {
  return crypto.createHash('sha256').update(stableStringify(evidenceHashPayload(ev))).digest('hex');
}

function wolfhouseRecord() {
  return {
    event: locks.COMPLETION_FIELDS.event,
    request_id: locks.WH_REQUEST_ID,
    method: locks.COMPLETION_FIELDS.method,
    route: locks.COMPLETION_FIELDS.route,
    status_code: locks.COMPLETION_FIELDS.status_code,
    status_class: locks.COMPLETION_FIELDS.status_class,
    duration_ms: locks.COMPLETION_FIELDS.duration_ms,
    outcome: locks.COMPLETION_FIELDS.outcome,
  };
}

function sunsetRecord() {
  return {
    event: locks.COMPLETION_FIELDS.event,
    request_id: locks.SUNSET_REQUEST_ID,
    tenant_slug: locks.SUNSET_TENANT,
    method: locks.COMPLETION_FIELDS.method,
    route: locks.COMPLETION_FIELDS.route,
    status_code: locks.COMPLETION_FIELDS.status_code,
    status_class: locks.COMPLETION_FIELDS.status_class,
    duration_ms: locks.COMPLETION_FIELDS.duration_ms,
    outcome: locks.COMPLETION_FIELDS.outcome,
  };
}

function buildExpectedEvidence() {
  return {
    schema_version: 1,
    slice: locks.SLICE,
    outcome_id: locks.OUTCOME_ID,
    gate_ids_touched: [locks.GATE_ID],
    master_basis: locks.MASTER_BASIS,
    branch: locks.BRANCH,
    audit_only: true,
    live_mutation: false,
    this_slice_deploys: false,
    progress_class: locks.PROGRESS_CLASS,
    title: 'Reconcile dual-staging 16R completion-log delivery/search/retention evidence (bounded; no overclaims)',
    image_sha_short: locks.IMAGE_SHA_SHORT,
    image_sha_full: locks.IMAGE_SHA_FULL,
    observed_facts: {
      deploy: {
        image_sha_full: locks.IMAGE_SHA_FULL,
        image_sha_short: locks.IMAGE_SHA_SHORT,
        wolfhouse: {
          app: locks.WH_APP,
          revision: locks.WH_REVISION,
          revision_suffix: locks.WH_REVISION_SUFFIX,
          latest_equals_latest_ready: true,
          public_healthz_status: 200,
        },
        sunset: {
          app: locks.SUNSET_APP,
          revision: locks.SUNSET_REVISION,
          revision_suffix: locks.SUNSET_REVISION_SUFFIX,
          latest_equals_latest_ready: true,
          public_healthz_status: 200,
        },
      },
      aca_env_logging: {
        logs_destination: locks.LOGS_DESTINATION,
      },
      law_workspaces: {
        wolfhouse: { ...locks.WH_LAW },
        sunset: { ...locks.SUNSET_LAW },
      },
      completion_search: {
        table: locks.LOG_TABLE,
        query_by: 'request_id',
        wolfhouse: {
          request_id: locks.WH_REQUEST_ID,
          match_count: locks.MATCH_COUNT,
          TimeGenerated: locks.WH_TIME_GENERATED,
          record: wolfhouseRecord(),
        },
        sunset: {
          request_id: locks.SUNSET_REQUEST_ID,
          tenant_slug: locks.SUNSET_TENANT,
          match_count: locks.MATCH_COUNT,
          TimeGenerated: locks.SUNSET_TIME_GENERATED,
          record: sunsetRecord(),
        },
      },
    },
    claims_allowed: [
      'exact_sha_1bf9695_images_latest_equals_latest_ready_both_tenants',
      'wolfhouse_revision_wh_staging_staff_api_0000517',
      'sunset_revision_luna_sunset_staging_staff_api_0000277',
      'public_healthz_200_both_tenants',
      'aca_env_logs_destination_log_analytics',
      'law_workspaces_customer_ids_and_retention_30',
      'container_app_console_logs_cl_search_by_request_id_match_count_1',
      'bounded_completion_healthz_200_2xx_duration_5_completed',
    ],
    explicitly_not_claimed: [...locks.EXPLICITLY_NOT_CLAIMED],
    gate_progress_updates: {
      G01_correlation_structured_logs: {
        progress_class: 'partial_live_proven',
        verdict: 'partial',
        live_proven: [
          'exact_sha_1bf9695_deployed_wh_0000517_sunset_0000277',
          'aca_env_logs_destination_log_analytics',
          'law_delivery_ContainerAppConsoleLogs_CL',
          'search_by_supplied_request_id_match_count_1_both_tenants',
          'retention_30_both_workspaces',
          'bounded_completion_fields_healthz_200_2xx_duration_5_completed',
        ],
        still_open: [
          'end_to_end_Meta_Hermes_Staff_API_Stripe_correlation_drill',
        ],
      },
    },
    gates_unchanged: [...locks.GATES_UNCHANGED],
  };
}

function exactDeepEqual(actual, expected, pathLabel) {
  const errors = [];
  const p = pathLabel || '$';

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

function collectObjectKeys(value, out) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v) => collectObjectKeys(v, out));
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    out.add(k);
    collectObjectKeys(v, out);
  }
}

function evidenceHasSensitiveKeys(ev) {
  const keys = new Set();
  collectObjectKeys(ev, keys);
  return locks.SENSITIVE_FORBIDDEN_KEYS.filter((k) => keys.has(k));
}

function validateGateMatrix(matrix) {
  const errors = [];
  if (!matrix || typeof matrix !== 'object') {
    return { ok: false, errors: ['matrix missing'] };
  }
  // Tip may advance (e.g. RADAR-16T); 16S selection + evidence remain authoritative here.
  const tipOk = matrix.slice === locks.SLICE || matrix.slice === 'RADAR-16T';
  if (!tipOk) errors.push(`slice=${matrix.slice}`);
  const branchOk = matrix.branch === locks.BRANCH
    || matrix.branch === 'radar/slice-16t-e2e-correlation-drill';
  if (!branchOk) errors.push(`branch=${matrix.branch}`);
  const basisOk = matrix.master_basis === locks.MASTER_BASIS
    || matrix.master_basis === '87121456db90a9f80ff8b3679596bc49c235cbfc';
  if (!basisOk) errors.push('master_basis mismatch');
  if (matrix.live_mutation !== false) errors.push('live_mutation not false');

  const counts = matrix.verdict_counts || {};
  if (counts.proven !== 0) errors.push(`proven=${counts.proven} (must be 0)`);
  if (counts.partial !== 9) errors.push(`partial=${counts.partial} (must be 9)`);
  if (counts.absent !== 0) errors.push(`absent=${counts.absent} (must be 0)`);
  if (counts.total !== 9) errors.push(`total=${counts.total} (must be 9)`);

  if (!Array.isArray(matrix.gates) || matrix.gates.length !== 9) {
    errors.push(`gates length ${matrix.gates && matrix.gates.length}`);
  }

  const g01 = (matrix.gates || []).find((x) => x.id === locks.GATE_ID);
  if (!g01) {
    errors.push('G01 missing');
  } else {
    if (g01.verdict !== 'partial') errors.push(`G01 verdict=${g01.verdict}`);
    if (g01.progress_class !== 'partial_live_proven') {
      errors.push(`G01 progress_class=${g01.progress_class}`);
    }
    if (!Array.isArray(g01.gaps) || g01.gaps.length !== 1) {
      errors.push(`G01 gaps length ${g01.gaps && g01.gaps.length}`);
    } else if (!/Meta.*Hermes.*Staff.*Stripe|end-to-end/i.test(g01.gaps[0])) {
      errors.push(`G01 gaps[0]=${g01.gaps[0]}`);
    }
  }

  for (const gid of locks.GATES_UNCHANGED) {
    const g = (matrix.gates || []).find((x) => x.id === gid);
    if (!g) {
      errors.push(`${gid} missing`);
      continue;
    }
    if (g.verdict === 'proven') errors.push(`${gid} falsely proven`);
  }

  for (const g of matrix.gates || []) {
    if (g.verdict === 'proven') errors.push(`${g.id} verdict proven forbidden`);
  }

  return { ok: errors.length === 0, errors };
}

const DENIAL_FIELD_RE = /(^|\.)(explicitly_not_claimed|still_open|must_not_claim|must_not|gaps|out_of_scope|forbidden_claim|does_not_implement|not_claimed)(\.|$|\[)/i;
const DENIAL_LOCAL_RE = /not claimed|still open|remain(?:s)? open|explicitly_not|does not claim|do not claim|forbidden|out_of_scope|does_not_implement|is not (?:inbox )?proof|not observed|not deploy/i;

const POSITIVE_CLAIM_CHECKS = [
  {
    id: 'e2e_drill_proven',
    re: /end[_\s-]?to[_\s-]?end(?:\s+Meta)?[_\s→>-]*(?:Hermes)?[_\s→>-]*(?:Staff)?[_\s→>-]*(?:Stripe)?[_\s-]?(?:correlation\s+)?drill\s+(?:is\s+|was\s+)?(?:proven|live-proven|closed|done)\b/i,
  },
  {
    id: 'g01_proven',
    re: /G01[_\s-]?(?:correlation)?[_\s-]?(?:structured\s+logs)?\s+(?:is\s+|was\s+)?(?:proven|fully\s+proven|closed)\b/i,
  },
  {
    id: 'verdict_proven',
    re: /"verdict"\s*:\s*"proven"/,
  },
  {
    id: 'proven_count_nonzero',
    re: /"proven"\s*:\s*[1-9]/,
  },
  {
    id: 'production_done',
    re: /\bproduction[_\s-]+(?:deploy|live|proven|complete|done)\b/i,
  },
  {
    id: 'concurrent_isolation_proven',
    re: /concurrent[_\s-]?isolation\s+(?:is\s+|was\s+)?(?:proven|live-proven|closed|done)\b/i,
  },
  {
    id: 'abort_error_proven',
    re: /abort[_\s/-]?error(?:\s+outcomes?)?\s+(?:is\s+|was\s+|are\s+)?(?:proven|live-proven|closed|done)\b/i,
  },
];

const WHOLE_STATEMENT_DENIAL_RE = /^(?:[-*]\s*)?(?:\*\*)?(?:does not (?:implement|claim)|do not claim|explicitly (?:do\s+)?not claim|explicitly_not_claimed|still open|out_of_scope|forbidden)/i;

function isDenialFieldPath(fieldPath) {
  return DENIAL_FIELD_RE.test(fieldPath);
}

function statementHasPositiveClaim(statement) {
  const hits = [];
  const trimmed = String(statement).trim();
  const wholeDenial = WHOLE_STATEMENT_DENIAL_RE.test(trimmed);
  for (const check of POSITIVE_CLAIM_CHECKS) {
    if (!check.re.test(trimmed)) continue;
    if (check.id === 'verdict_proven' || check.id === 'proven_count_nonzero') {
      hits.push(check.id);
      continue;
    }
    if (check.id === 'production_done') {
      if (/production[_\s-]+(?:scope|rgs?|query|systems|forbidden)/i.test(trimmed)
        && !/production[_\s-]+(?:deploy|live|proven|complete|done)/i.test(trimmed)) {
        continue;
      }
      if (wholeDenial && !/production[_\s-]+(?:deploy|live|proven|complete|done)/i.test(trimmed)) {
        continue;
      }
    }
    hits.push(check.id);
  }
  return hits;
}

function scanJsonOverclaims(value, fieldPath) {
  const hits = [];
  const fp = fieldPath || '$';

  if (typeof value === 'string') {
    if (isDenialFieldPath(fp)) {
      for (const id of statementHasPositiveClaim(value)) {
        if (id === 'verdict_proven' || id === 'proven_count_nonzero') hits.push(`${fp}:${id}`);
        else {
          const stripped = value.replace(/remain(?:s)?\s+open|not claimed|still open|does not claim|forbidden|explicitly not claimed/gi, '');
          if (/(?:proven|live-proven|implemented|deploy\s+done|closed|done)/i.test(stripped)
            && !DENIAL_LOCAL_RE.test(value.replace(/(?:proven|live-proven|closed|done)/gi, ''))) {
            hits.push(`${fp}:${id}`);
          } else if (/(?:proven|live-proven|closed|done)/i.test(stripped) && /(?:proven|live-proven)/i.test(value)
            && !/remain(?:s)?\s+open|still open|not claimed|does not claim/i.test(value)) {
            hits.push(`${fp}:${id}`);
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

function scanMarkdownOverclaims(text, label) {
  const hits = [];
  const lines = String(text).split(/\n/);
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
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

console.log('verify:radar-slice16s-request-log-live-evidence — RADAR Slice 16S\n');

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

ok('C3 16S contract branch frozen (tip may advance to 16T)',
  contract.branch === locks.BRANCH
  && (currentBranch() === locks.BRANCH
    || currentBranch() === 'radar/slice-16t-e2e-correlation-drill'),
  currentBranch());

{
  const v = validateEvidenceExact(evidence);
  ok('C4 evidence exact recursive schema + lock_hash', v.ok, v.errors.slice(0, 8).join(' | '));
}

ok('C5 explicitly_not_claimed complete',
  Array.isArray(evidence.explicitly_not_claimed)
  && locks.EXPLICITLY_NOT_CLAIMED.every((k) => evidence.explicitly_not_claimed.includes(k))
  && evidence.explicitly_not_claimed.length === locks.EXPLICITLY_NOT_CLAIMED.length);

ok('C6 top-level contract retains selected_16s (tip may be 16T)',
  (topContract.slice === locks.SLICE || topContract.slice === 'RADAR-16T')
  && topContract.selected_16s
  && topContract.selected_16s.outcome_id === locks.OUTCOME_ID
  && topContract.selected_16s.progress_class === locks.PROGRESS_CLASS);

ok('C7 gate-matrix retains slice_16s_selection (tip may be 16T)',
  (matrix.slice === locks.SLICE || matrix.slice === 'RADAR-16T')
  && matrix.slice_16s_selection
  && matrix.slice_16s_selection.outcome_id === locks.OUTCOME_ID
  && matrix.live_mutation === false);

{
  const mv = validateGateMatrix(matrix);
  ok('C8 matrix validation (counts + G01 partial_live_proven)', mv.ok, mv.errors.join(' | '));
  green('matrix_validation_accepts_frozen', mv.ok, mv.errors.join(' | '));
}

const rt = runtimePathsUnchanged();
ok('C9 zero runtime mutation vs master basis', rt.ok, rt.detail);

const blob = [JSON.stringify(evidence), JSON.stringify(contract), JSON.stringify(matrix),
  JSON.stringify(topContract), doc, findings].join('\n');
const sec = secretFree(blob, '16s-artifacts');
ok('C10 secret-free artifacts', sec.ok, sec.detail);

ok('C11 doc mentions 16S + G01 partial_live_proven + E2E still open',
  /16S_request_completion_log_live_evidence/.test(doc)
  && /partial_live_proven/.test(doc)
  && /1bf9695/.test(doc)
  && /Meta.*Hermes|end-to-end/i.test(doc));

ok('C12 findings mention 16S and remaining E2E',
  /16S/.test(findings)
  && /1bf9695|0000517|0000277/.test(findings)
  && /Meta.*Hermes|end-to-end/i.test(findings)
  && /not claim|still open|remain/i.test(findings));

{
  const sensitive = evidenceHasSensitiveKeys(evidence);
  ok('C13 evidence has no sensitive field keys', sensitive.length === 0, sensitive.join(','));
}

// --- GREEN: exact facts ---
green('exact_sha_and_revisions',
  evidence.image_sha_full === locks.IMAGE_SHA_FULL
  && evidence.observed_facts.deploy.wolfhouse.revision === locks.WH_REVISION
  && evidence.observed_facts.deploy.sunset.revision === locks.SUNSET_REVISION
  && evidence.observed_facts.deploy.wolfhouse.app === locks.WH_APP
  && evidence.observed_facts.deploy.sunset.app === locks.SUNSET_APP);

green('exact_request_ids_and_timestamps',
  evidence.observed_facts.completion_search.wolfhouse.request_id === locks.WH_REQUEST_ID
  && evidence.observed_facts.completion_search.wolfhouse.TimeGenerated === locks.WH_TIME_GENERATED
  && evidence.observed_facts.completion_search.sunset.request_id === locks.SUNSET_REQUEST_ID
  && evidence.observed_facts.completion_search.sunset.TimeGenerated === locks.SUNSET_TIME_GENERATED
  && evidence.observed_facts.completion_search.sunset.tenant_slug === locks.SUNSET_TENANT);

green('exact_match_count_one_both',
  evidence.observed_facts.completion_search.wolfhouse.match_count === 1
  && evidence.observed_facts.completion_search.sunset.match_count === 1);

green('exact_bounded_completion_schema',
  evidence.observed_facts.completion_search.wolfhouse.record.route === '/healthz'
  && evidence.observed_facts.completion_search.wolfhouse.record.status_code === 200
  && evidence.observed_facts.completion_search.wolfhouse.record.status_class === '2xx'
  && evidence.observed_facts.completion_search.wolfhouse.record.duration_ms === 5
  && evidence.observed_facts.completion_search.wolfhouse.record.outcome === 'completed'
  && evidence.observed_facts.completion_search.table === locks.LOG_TABLE);

green('exact_law_workspace_retention',
  evidence.observed_facts.law_workspaces.wolfhouse.customer_id === locks.WH_LAW.customer_id
  && evidence.observed_facts.law_workspaces.wolfhouse.workspace_name === locks.WH_LAW.workspace_name
  && evidence.observed_facts.law_workspaces.wolfhouse.retention_days === 30
  && evidence.observed_facts.law_workspaces.sunset.customer_id === locks.SUNSET_LAW.customer_id
  && evidence.observed_facts.law_workspaces.sunset.workspace_name === locks.SUNSET_LAW.workspace_name
  && evidence.observed_facts.law_workspaces.sunset.retention_days === 30
  && evidence.observed_facts.aca_env_logging.logs_destination === 'log-analytics');

green('g01_partial_not_proven_e2e_open',
  evidence.gate_progress_updates.G01_correlation_structured_logs.progress_class === 'partial_live_proven'
  && evidence.gate_progress_updates.G01_correlation_structured_logs.verdict === 'partial'
  && evidence.gate_progress_updates.G01_correlation_structured_logs.still_open.length === 1
  && /end_to_end_Meta_Hermes_Staff_API_Stripe_correlation_drill/.test(
    evidence.gate_progress_updates.G01_correlation_structured_logs.still_open[0]));

// --- RED: schema ---
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
  altered.observed_facts.completion_search.wolfhouse.match_count = 2;
  red('duplicate_match_count_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts.completion_search.sunset.match_count = 0;
  red('zero_match_count_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.image_sha_full = '0'.repeat(40);
  altered.observed_facts.deploy.image_sha_full = '0'.repeat(40);
  red('wrong_sha_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts.deploy.wolfhouse.revision = 'wh-staging-staff-api--0000999';
  red('wrong_revision_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts.deploy.wolfhouse.app = 'other-app';
  red('wrong_app_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts.law_workspaces.wolfhouse.workspace_name = 'wrong-logs';
  red('wrong_workspace_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts.law_workspaces.sunset.customer_id = '00000000-0000-4000-8000-000000000000';
  red('wrong_customer_id_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts.law_workspaces.wolfhouse.retention_days = 90;
  red('wrong_retention_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts.completion_search.table = 'AppTraces';
  red('wrong_table_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts.completion_search.wolfhouse.TimeGenerated = '2026-01-01T00:00:00.0000000Z';
  red('wrong_timestamp_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts.completion_search.wolfhouse.record.status_code = 500;
  altered.observed_facts.completion_search.wolfhouse.record.status_class = '5xx';
  red('wrong_completion_schema_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.observed_facts.completion_search.wolfhouse.record.headers = { 'x-request-id': 'leak' };
  red('sensitive_headers_rejected',
    !validateEvidenceExact(altered).ok
    || evidenceHasSensitiveKeys(altered).includes('headers'));
}
{
  const altered = deepClone(evidence);
  altered.observed_facts.completion_search.extra = { body: 'leak' };
  red('extra_nested_key_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.gate_progress_updates.G01_correlation_structured_logs.verdict = 'proven';
  altered.gate_progress_updates.G01_correlation_structured_logs.still_open = [];
  red('g01_overclaim_proven_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.explicitly_not_claimed = altered.explicitly_not_claimed
    .filter((x) => x !== 'end_to_end_meta_hermes_staff_stripe_correlation_drill');
  red('missing_not_claimed_e2e_rejected', !validateEvidenceExact(altered).ok);
}
{
  const altered = deepClone(evidence);
  altered.lock_hash = '0'.repeat(64);
  red('altered_lock_hash_rejected', !validateEvidenceExact(altered).ok);
}
{
  const claimsTamper = deepClone(evidence);
  claimsTamper.claims_allowed = [...claimsTamper.claims_allowed.slice(0, -1), 'smuggled_claim'];
  red('claims_allowed_changes_lock_hash',
    computeEvidenceLockHash(claimsTamper) !== computeEvidenceLockHash(evidence)
    && !validateEvidenceExact(claimsTamper).ok);
}

// --- RED: matrix ---
{
  const badG01 = deepClone(matrix);
  const g01 = badG01.gates.find((g) => g.id === locks.GATE_ID);
  g01.verdict = 'proven';
  g01.progress_class = 'proven';
  g01.gaps = [];
  badG01.verdict_counts.proven = 1;
  badG01.verdict_counts.partial = 8;
  const v = validateGateMatrix(badG01);
  red('matrix_g01_proven_tamper_fails', v.ok === false, v.errors.join(' | '));
}
{
  const badOther = deepClone(matrix);
  const g02 = badOther.gates.find((g) => g.id === 'G02_readiness_dependencies');
  g02.verdict = 'proven';
  badOther.verdict_counts.proven = 1;
  badOther.verdict_counts.partial = 8;
  const v = validateGateMatrix(badOther);
  red('matrix_other_gate_proven_tamper_fails', v.ok === false, v.errors.join(' | '));
}

// --- RED: overclaim scans ---
{
  const over = {
    verdict: 'proven',
    proven: 1,
    note: 'G01 correlation structured logs proven; end-to-end Meta Hermes Staff Stripe correlation drill proven; production deploy done',
  };
  const hits = scanJsonOverclaims(over, 'synthetic_overclaim');
  red('overstated_proven_verdict_rejected', hits.some((h) => /verdict_proven|proven_count/.test(h)), hits.join(','));
  red('overstated_g01_proven_rejected', hits.some((h) => /g01_proven/.test(h)), hits.join(','));
  red('overstated_e2e_rejected', hits.some((h) => /e2e_drill/.test(h)), hits.join(','));
  red('overstated_production_rejected', hits.some((h) => /production/.test(h)), hits.join(','));
}

{
  const hits = [
    ...scanJsonOverclaims(evidence, 'evidence'),
    ...scanJsonOverclaims(contract, 'contract'),
    ...scanMarkdownOverclaims(doc, 'doc'),
    ...scanMarkdownOverclaims(findings, 'findings'),
  ];
  // Matrix/topContract carry historical aspirational pass_rules ("… isolation proven");
  // only enforce structural no-proven-verdict / proven-count on those objects.
  const structural = [
    ...scanJsonOverclaims(
      { verdict_counts: matrix.verdict_counts, gates: (matrix.gates || []).map((g) => ({ id: g.id, verdict: g.verdict })) },
      'matrix_structural',
    ),
    ...scanJsonOverclaims(
      { expected_verdict_counts: topContract.expected_verdict_counts, selected_16s: topContract.selected_16s },
      'topContract_structural',
    ),
    ...scanJsonOverclaims(matrix.slice_16s_selection || {}, 'slice_16s_selection'),
    ...scanJsonOverclaims(
      (matrix.gates || []).find((g) => g.id === locks.GATE_ID) || {},
      'g01_gate',
    ),
  ];
  const allHits = [...hits, ...structural];
  red('artifacts_reject_overstated_claims', allHits.length === 0, allHits.join(',') || '(clean)');
}

ok('C14 contract forbids E2E/proven overclaim tokens',
  Array.isArray(contract.must_not_claim_as_proven)
  && contract.must_not_claim_as_proven.includes('end_to_end_meta_hermes_staff_stripe_correlation_drill')
  && contract.must_not_claim_as_proven.includes('any_gate_verdict_proven')
  && contract.verdict_policy.proven === 0);

ok('C15 npm script registered',
  /verify:radar-slice16s-request-log-live-evidence/.test(readText('package.json')));

ok('C19 evidence.lock_hash matches full canonical payload',
  evidence.lock_hash === computeEvidenceLockHash(evidence),
  `got=${evidence.lock_hash}`);

const REQUIRED_RED = [
  'unknown_top_level_property_rejected',
  'missing_claims_allowed_rejected',
  'duplicate_match_count_rejected',
  'zero_match_count_rejected',
  'wrong_sha_rejected',
  'wrong_revision_rejected',
  'wrong_app_rejected',
  'wrong_workspace_rejected',
  'wrong_customer_id_rejected',
  'wrong_retention_rejected',
  'wrong_table_rejected',
  'wrong_timestamp_rejected',
  'wrong_completion_schema_rejected',
  'sensitive_headers_rejected',
  'extra_nested_key_rejected',
  'g01_overclaim_proven_rejected',
  'missing_not_claimed_e2e_rejected',
  'altered_lock_hash_rejected',
  'claims_allowed_changes_lock_hash',
  'matrix_g01_proven_tamper_fails',
  'matrix_other_gate_proven_tamper_fails',
  'overstated_proven_verdict_rejected',
  'overstated_g01_proven_rejected',
  'overstated_e2e_rejected',
  'overstated_production_rejected',
  'artifacts_reject_overstated_claims',
];

const REQUIRED_GREEN = [
  'matrix_validation_accepts_frozen',
  'exact_sha_and_revisions',
  'exact_request_ids_and_timestamps',
  'exact_match_count_one_both',
  'exact_bounded_completion_schema',
  'exact_law_workspace_retention',
  'g01_partial_not_proven_e2e_open',
];

ok('R1 all required RED ids passed',
  REQUIRED_RED.every((id) => redResults.some((r) => r.id === id && r.ok)),
  REQUIRED_RED.filter((id) => !redResults.some((r) => r.id === id && r.ok)).join(','));
ok('G1 all required GREEN ids passed',
  REQUIRED_GREEN.every((id) => greenResults.some((r) => r.id === id && r.ok)),
  REQUIRED_GREEN.filter((id) => !greenResults.some((r) => r.id === id && r.ok)).join(','));

console.log(`\nRED: ${redResults.filter((r) => r.ok).length}/${REQUIRED_RED.length}  `
  + `GREEN: ${greenResults.filter((r) => r.ok).length}/${REQUIRED_GREEN.length}`);
console.log(`Result: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('RADAR 16S request completion log live evidence: PASS');

module.exports = {
  buildExpectedEvidence,
  computeEvidenceLockHash,
  validateEvidenceExact,
  validateGateMatrix,
};
