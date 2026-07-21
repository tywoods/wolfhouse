'use strict';

/**
 * verify:radar-slice16x-g02-live-evidence — RADAR Slice 16X
 *
 * Offline gate: bounded G02 lifecycle-deploy + dependency-failure traffic-shed
 * evidence reconciliation with mandatory provenance split:
 *   (A) operator-observed drill transcript contemporaneous facts
 *   (B) later independently recoverable Azure read-only facts
 *
 * Rejects wrong SHA/digest/revision, secret values, missing 90s observations,
 * failed revision becoming ready, non-200 public continuity, active failed
 * revision, wrong restored secretRef, overclaims, historical arrays labelled
 * Azure-derived, missing transcript attribution, fabricated current
 * verification of historical samples, and live-timeout rewrites of A.
 * No Azure mutation.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16x-g02-live-evidence');

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
    /postgres(?:ql)?:\/\/[^\s"'\\]+/i,
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

function buildObservationBlock(kind) {
  const isWh = kind === 'wolfhouse';
  const window = isWh ? locks.WH_OBSERVATION_WINDOW : locks.SUNSET_OBSERVATION_WINDOW;
  const samples = isWh ? locks.WH_OBSERVATION_SAMPLES : locks.SUNSET_OBSERVATION_SAMPLES;
  return {
    source_type: locks.SOURCE_TYPE_A,
    source_ref: locks.SOURCE_REF_A,
    observed_at_semantics: locks.OBSERVED_AT_SEMANTICS_A,
    observation_window: {
      start_utc: window.start_utc,
      end_utc: window.end_utc,
      duration_seconds: window.duration_seconds,
      cadence_seconds: window.cadence_seconds,
      derivation: window.derivation,
    },
    duration_seconds: locks.OBS_DURATION_S,
    cadence_seconds: locks.OBS_CADENCE_S,
    sample_count: locks.OBS_SAMPLE_COUNT,
    samples: samples.map((s) => ({ ...s })),
    public_continuity: {
      source_type: locks.SOURCE_TYPE_A,
      source_ref: locks.SOURCE_REF_A,
      observed_at_semantics: locks.OBSERVED_AT_SEMANTICS_A,
      public_healthz: 200,
      public_readyz: 200,
      note: 'Every sample public_healthz/public_readyz is transcript-derived contemporaneous observation; not Azure-reconstructible',
    },
  };
}

function buildClassATenant(kind) {
  const isWh = kind === 'wolfhouse';
  return {
    app: isWh ? locks.WH_APP : locks.SUNSET_APP,
    fail_revision: isWh ? locks.WH_FAIL_REV : locks.SUNSET_FAIL_REV,
    prior_serving_revision: isWh ? locks.WH_BASE_REV : locks.SUNSET_BASE_REV,
    fail_env: {
      WOLFHOUSE_DATABASE_URL: {
        kind: 'literal_unreachable_dsn_redacted',
        host_redacted: '127.0.0.1',
        secretRef: null,
        source_type: locks.SOURCE_TYPE_A,
        source_ref: locks.SOURCE_REF_A,
      },
    },
    fail_scale_min_replicas: 1,
    observation: buildObservationBlock(kind),
  };
}

function buildClassBTenant(kind) {
  const isWh = kind === 'wolfhouse';
  const tl = isWh ? locks.WH_TIMELINE : locks.SUNSET_TIMELINE;
  return {
    app: isWh ? locks.WH_APP : locks.SUNSET_APP,
    resource_group: isWh ? locks.WH_RG : locks.SUNSET_RG,
    public_host: isWh ? locks.WH_PUBLIC_HOST : locks.SUNSET_PUBLIC_HOST,
    image: isWh ? locks.WH_IMAGE : locks.SUNSET_IMAGE,
    digest: isWh ? locks.WH_DIGEST : locks.SUNSET_DIGEST,
    base_revision: isWh ? locks.WH_BASE_REV : locks.SUNSET_BASE_REV,
    base_revision_suffix: isWh ? locks.WH_BASE_SUFFIX : locks.SUNSET_BASE_SUFFIX,
    fail_revision: isWh ? locks.WH_FAIL_REV : locks.SUNSET_FAIL_REV,
    restore_revision: isWh ? locks.WH_RESTORE_REV : locks.SUNSET_RESTORE_REV,
    restored_secret_ref: isWh ? locks.WH_SECRET_REF : locks.SUNSET_SECRET_REF,
    source_type: locks.SOURCE_TYPE_B,
    source_ref: locks.SOURCE_REF_B,
    observed_at: locks.INDEPENDENT_VERIFY_UTC,
    observed_at_semantics: locks.OBSERVED_AT_SEMANTICS_B,
    timeline: {
      ...tl,
      source_type: locks.SOURCE_TYPE_B,
      source_ref: locks.SOURCE_REF_B,
      observed_at: locks.INDEPENDENT_VERIFY_UTC,
    },
    final_state: {
      source_type: locks.SOURCE_TYPE_B,
      source_ref: locks.SOURCE_REF_B,
      observed_at: locks.INDEPENDENT_VERIFY_UTC,
      observed_at_semantics: locks.OBSERVED_AT_SEMANTICS_B,
      latest_revision: isWh ? locks.WH_RESTORE_REV : locks.SUNSET_RESTORE_REV,
      latest_ready_revision: isWh ? locks.WH_RESTORE_REV : locks.SUNSET_RESTORE_REV,
      health_state: 'Healthy',
      traffic_latest_percent: 100,
      fail_revision_active: false,
      database_secret_ref: isWh ? locks.WH_SECRET_REF : locks.SUNSET_SECRET_REF,
      public_healthz: 200,
      public_readyz: 200,
      public_current_note:
        'public_healthz/public_readyz here are independently reverified current values at observed_at — not a recreation of class-A historical samples',
      probes: locks.PROBE_SUMMARY.map((p) => ({ ...p })),
    },
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
    title: 'Reconcile dual-staging G02 lifecycle deploy + dependency-failure traffic-shed drill (bounded; no overclaims)',
    image_sha_short: locks.IMAGE_SHA_SHORT,
    image_sha_full: locks.IMAGE_SHA_FULL,
    subscription_id: locks.SUBSCRIPTION_ID,
    independent_azure_verify_utc: locks.INDEPENDENT_VERIFY_UTC,
    provenance_limitations: locks.PROVENANCE_LIMITATIONS,
    non_recoverability: locks.NON_RECOVERABILITY,
    observed_facts: {
      A_operator_observed_drill_transcript: {
        source_type: locks.SOURCE_TYPE_A,
        source_ref: locks.SOURCE_REF_A,
        observed_at_semantics: locks.OBSERVED_AT_SEMANTICS_A,
        covers: [
          'fail_observation_samples_0_90s_5s',
          'public_healthz_readyz_continuity_during_fail',
          'fail_env_literal_unreachable_dsn_intent',
          'fail_scale_min_replicas',
        ],
        wolfhouse: buildClassATenant('wolfhouse'),
        sunset: buildClassATenant('sunset'),
      },
      B_independently_recoverable_azure_readonly: {
        source_type: locks.SOURCE_TYPE_B,
        source_ref: locks.SOURCE_REF_B,
        observed_at: locks.INDEPENDENT_VERIFY_UTC,
        observed_at_semantics: locks.OBSERVED_AT_SEMANTICS_B,
        covers: [
          'acr_digests',
          'images_and_base_restore_revisions',
          'revision_create_timelines',
          'final_revision_ready_health_traffic_secretRef',
          'probes',
          'public_current_healthz_readyz',
        ],
        builds: {
          source_type: locks.SOURCE_TYPE_B,
          source_ref: locks.SOURCE_REF_B,
          observed_at: locks.INDEPENDENT_VERIFY_UTC,
          wolfhouse_digest: locks.WH_DIGEST,
          sunset_digest: locks.SUNSET_DIGEST,
          image_sha_full: locks.IMAGE_SHA_FULL,
        },
        wolfhouse: buildClassBTenant('wolfhouse'),
        sunset: buildClassBTenant('sunset'),
      },
    },
    claims_allowed: [...locks.CLAIMS_ALLOWED],
    explicitly_not_claimed: [...locks.EXPLICITLY_NOT_CLAIMED],
    disposition: {
      proves: [
        'dual_staging_lifecycle_image_deploy_exact_sha_2dcda08',
        'controlled_dependency_failure_traffic_shed_g02fail_activating_never_latest_ready',
        'public_healthz_readyz_200_continuity_on_prior_revision',
        'exact_sha_g02restore_secretRef_healthy_100pct_latest_traffic',
        'failed_revision_deactivated',
      ],
      does_not_prove: [...locks.EXPLICITLY_NOT_CLAIMED],
      g02_verdict: 'partial',
      g02_progress_class: 'partial_live_proven',
    },
    gate_progress_updates: {
      G02_readiness_dependencies: {
        progress_class: 'partial_live_proven',
        verdict: 'partial',
        live_proven: [
          'lifecycle_wired_image_2dcda08_deployed_wh_0000518_sunset_0000278',
          'controlled_dependency_failure_traffic_shed_g02fail_activating_90s_never_latest_ready',
          'prior_revision_public_healthz_readyz_200_continuity',
          'g02restore_exact_sha_secretRef_healthy_latestReady_100pct',
          'failed_revision_deactivated',
        ],
        still_open: [
          'sigterm_sigint_closeReadinessPool_live_lifecycle_behavior',
          'serving_revision_readyz_503_body_path',
          'organic_metric_alert_firing',
          'production',
        ],
      },
    },
    gates_unchanged: [
      'G01_correlation_structured_logs',
      'G03_actionable_tenant_aware_alerts',
      'G04_webhook_payment_worker_backlog',
      'G05_retry_replay_safety',
      'G06_scaling_capacity',
      'G07_rollback_incident_runbooks',
      'G08_retention_privacy',
      'G09_cost_controls',
    ],
  };
}

function exactDeepEqual(actual, expected, pathPrefix) {
  const errors = [];
  const p = pathPrefix || '$';

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

function validateProvenanceSplit(ev) {
  const errors = [];
  const facts = ev && ev.observed_facts;
  if (!facts || typeof facts !== 'object') {
    return { ok: false, errors: ['observed_facts missing'] };
  }
  if (!facts.A_operator_observed_drill_transcript) {
    errors.push('missing A_operator_observed_drill_transcript');
  }
  if (!facts.B_independently_recoverable_azure_readonly) {
    errors.push('missing B_independently_recoverable_azure_readonly');
  }
  if (!ev.provenance_limitations || typeof ev.provenance_limitations !== 'string') {
    errors.push('missing provenance_limitations');
  }
  if (!ev.non_recoverability || typeof ev.non_recoverability !== 'string') {
    errors.push('missing non_recoverability');
  }
  if (!/cannot recreate|not Azure-reconstructible|cannot.*replay/i.test(String(ev.non_recoverability || ''))) {
    errors.push('non_recoverability must deny Azure recreation of historical samples');
  }

  const a = facts.A_operator_observed_drill_transcript;
  const b = facts.B_independently_recoverable_azure_readonly;
  if (a) {
    if (a.source_type !== locks.SOURCE_TYPE_A) errors.push('A source_type wrong');
    if (a.source_ref !== locks.SOURCE_REF_A) errors.push('A source_ref wrong');
    if (a.observed_at_semantics !== locks.OBSERVED_AT_SEMANTICS_A) {
      errors.push('A observed_at_semantics wrong');
    }
  }
  if (b) {
    if (b.source_type !== locks.SOURCE_TYPE_B) errors.push('B source_type wrong');
    if (b.source_ref !== locks.SOURCE_REF_B) errors.push('B source_ref wrong');
    if (b.observed_at !== locks.INDEPENDENT_VERIFY_UTC) errors.push('B observed_at wrong');
    if (b.observed_at_semantics !== locks.OBSERVED_AT_SEMANTICS_B) {
      errors.push('B observed_at_semantics wrong');
    }
  }

  // Historical sample arrays must not live under B or carry Azure source_type.
  if (b && (b.wolfhouse || b.sunset)) {
    for (const tenant of ['wolfhouse', 'sunset']) {
      const t = b[tenant];
      if (t && t.observation && Array.isArray(t.observation.samples)) {
        errors.push(`B.${tenant}.observation.samples must not exist (historical arrays are class A only)`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateGateMatrix(matrix) {
  const errors = [];
  if (!matrix || typeof matrix !== 'object') {
    return { ok: false, errors: ['matrix missing'] };
  }
  if (matrix.slice !== locks.SLICE && matrix.slice !== 'RADAR-16W') {
    errors.push(`slice=${matrix.slice}`);
  }
  if (matrix.slice === locks.SLICE) {
    if (matrix.branch !== locks.BRANCH) errors.push(`branch=${matrix.branch}`);
    if (matrix.master_basis !== locks.MASTER_BASIS) errors.push('master_basis mismatch');
  }
  if (matrix.live_mutation !== false) errors.push('live_mutation not false');

  const counts = matrix.verdict_counts || {};
  if (counts.proven !== 0) errors.push(`proven=${counts.proven} (must be 0)`);
  if (counts.partial !== 9) errors.push(`partial=${counts.partial} (must be 9)`);
  if (counts.absent !== 0) errors.push(`absent=${counts.absent}`);

  const g02 = (matrix.gates || []).find((g) => g.id === 'G02_readiness_dependencies');
  if (!g02) {
    errors.push('G02 missing');
  } else {
    if (g02.verdict !== 'partial') errors.push('G02 verdict not partial');
    if (g02.progress_class !== 'partial_live_proven') errors.push('G02 progress_class wrong');
    if (!/16X|traffic.?shed|g02fail|2dcda08/i.test(String(g02.rationale || ''))) {
      errors.push('G02 rationale missing 16X drill deploy facts');
    }
    if (!Array.isArray(g02.gaps) || !g02.gaps.some((g) => /SIGTERM|lifecycle.?live|closeReadinessPool.?live/i.test(String(g)))) {
      errors.push('G02 gaps must retain SIGTERM/live lifecycle open');
    }
    if (g02.gaps && g02.gaps.some((g) => /dependency.failure.*not executed|traffic.shed.*not executed/i.test(String(g)))) {
      errors.push('G02 gaps still claim traffic-shed drill not executed');
    }
  }

  for (const g of matrix.gates || []) {
    if (g.verdict === 'proven') errors.push(`${g.id} falsely proven`);
  }

  return { ok: errors.length === 0, errors };
}

function classATenant(ev, kind) {
  return ev.observed_facts
    && ev.observed_facts.A_operator_observed_drill_transcript
    && ev.observed_facts.A_operator_observed_drill_transcript[kind];
}

function classBTenant(ev, kind) {
  return ev.observed_facts
    && ev.observed_facts.B_independently_recoverable_azure_readonly
    && ev.observed_facts.B_independently_recoverable_azure_readonly[kind];
}

function observationOk(tenant) {
  const obs = tenant && tenant.observation;
  if (!obs) return { ok: false, detail: 'missing observation' };
  if (obs.source_type !== locks.SOURCE_TYPE_A) {
    return { ok: false, detail: `observation source_type=${obs.source_type}` };
  }
  if (obs.source_ref !== locks.SOURCE_REF_A) {
    return { ok: false, detail: 'observation missing transcript source_ref' };
  }
  if (!obs.observation_window
    || !obs.observation_window.start_utc
    || !obs.observation_window.end_utc
    || !obs.observation_window.derivation) {
    return { ok: false, detail: 'missing observation_window' };
  }
  if (obs.duration_seconds < locks.OBS_DURATION_S) {
    return { ok: false, detail: `duration ${obs.duration_seconds}` };
  }
  if (obs.cadence_seconds !== locks.OBS_CADENCE_S) {
    return { ok: false, detail: `cadence ${obs.cadence_seconds}` };
  }
  if (!Array.isArray(obs.samples) || obs.samples.length < locks.OBS_SAMPLE_COUNT) {
    return { ok: false, detail: `samples ${obs.samples && obs.samples.length}` };
  }
  if (obs.sample_count !== obs.samples.length) {
    return { ok: false, detail: 'sample_count mismatch' };
  }
  for (const s of obs.samples) {
    if (s.source_type !== locks.SOURCE_TYPE_A) {
      return { ok: false, detail: `sample source_type=${s.source_type}` };
    }
    if (s.source_ref !== locks.SOURCE_REF_A) {
      return { ok: false, detail: 'sample missing transcript source_ref' };
    }
    if (s.fail_running_state !== 'Activating') return { ok: false, detail: 'not Activating' };
    if (s.fail_was_latest_ready !== false) return { ok: false, detail: 'became latestReady' };
    if (s.public_healthz !== 200 || s.public_readyz !== 200) {
      return { ok: false, detail: 'non-200 continuity' };
    }
  }
  if (!obs.public_continuity
    || obs.public_continuity.source_type !== locks.SOURCE_TYPE_A
    || obs.public_continuity.public_healthz !== 200
    || obs.public_continuity.public_readyz !== 200) {
    return { ok: false, detail: 'public_continuity not transcript-attributed 200' };
  }
  return { ok: true };
}

function samplesHaveAzureDerivedLabel(tenant) {
  const obs = tenant && tenant.observation;
  if (!obs || !Array.isArray(obs.samples)) return false;
  return obs.samples.some((s) => {
    const st = String(s.source_type || '');
    return /azure|independently_reverified|readonly/i.test(st)
      && !/transcript|operator_drill/i.test(st);
  }) || /azure|independently_reverified/i.test(String(obs.source_type || ''))
    && !/transcript|operator_drill/i.test(String(obs.source_type || ''));
}

function samplesClaimFabricatedCurrentVerify(tenant) {
  const obs = tenant && tenant.observation;
  if (!obs || !Array.isArray(obs.samples)) return false;
  return obs.samples.some((s) => (
    Object.prototype.hasOwnProperty.call(s, 'independently_reverified_at')
    || Object.prototype.hasOwnProperty.call(s, 'current_verify_utc')
    || Object.prototype.hasOwnProperty.call(s, 'azure_replay_utc')
    || s.source_type === locks.SOURCE_TYPE_B
  )) || obs.source_type === locks.SOURCE_TYPE_B;
}

function fieldLevelOverclaim(text) {
  const hits = [];
  const forbidden = [
    /\bG02\s+proven\b/i,
    /\bverdict\s*[:=]\s*proven\b/i,
    /\bfull\s+G02\b/i,
    /\bproduction\b/i,
    /\borganic\s+metric\s+alert/i,
    /\bhuman\s+inbox\b/i,
    /\bSIGTERM\b.*\blive\s+(proven|closed|complete)\b/i,
    /\blive\s+SIGTERM\b.*\bproven\b/i,
  ];
  for (const re of forbidden) {
    if (re.test(text)) hits.push(String(re));
  }
  return hits;
}

function runVerifier() {
console.log('RADAR 16X G02 live evidence — offline verifier\n');

const evidence = readJson(locks.EVIDENCE_REL);
const contract = readJson(locks.CONTRACT_REL);
const matrix = readJson('fixtures/radar-operations/gate-matrix.json');
const topContract = readJson('fixtures/radar-operations/contract.json');
const findings = readText('fixtures/radar-operations/findings.md');
const doc = readText('docs/RADAR-OPERATIONS-GATE-LEDGER.md');

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

ok('C3 HEAD on 16X branch', currentBranch() === locks.BRANCH, currentBranch());

{
  const v = validateEvidenceExact(evidence);
  ok('C4 evidence exact recursive schema + lock_hash', v.ok, v.errors.slice(0, 12).join(' | '));
}

ok('C5 explicitly_not_claimed complete',
  Array.isArray(evidence.explicitly_not_claimed)
  && locks.EXPLICITLY_NOT_CLAIMED.every((k) => evidence.explicitly_not_claimed.includes(k))
  && evidence.explicitly_not_claimed.length === locks.EXPLICITLY_NOT_CLAIMED.length);

ok('C6 disposition keeps G02 partial',
  evidence.disposition
  && evidence.disposition.g02_verdict === 'partial'
  && evidence.disposition.g02_progress_class === 'partial_live_proven'
  && evidence.gate_progress_updates.G02_readiness_dependencies.verdict === 'partial'
  && evidence.gate_progress_updates.G02_readiness_dependencies.still_open.includes(
    'sigterm_sigint_closeReadinessPool_live_lifecycle_behavior',
  ));

{
  const whObs = observationOk(classATenant(evidence, 'wolfhouse'));
  const suObs = observationOk(classATenant(evidence, 'sunset'));
  ok('C7 90s/5s observation series both tenants (class A transcript)', whObs.ok && suObs.ok, `${whObs.detail}|${suObs.detail}`);
}

{
  const b = evidence.observed_facts.B_independently_recoverable_azure_readonly;
  ok('C8 digests + SHA + base revisions locked (class B)',
    b.builds.wolfhouse_digest === locks.WH_DIGEST
    && b.builds.sunset_digest === locks.SUNSET_DIGEST
    && evidence.image_sha_full === locks.IMAGE_SHA_FULL
    && b.wolfhouse.base_revision_suffix === locks.WH_BASE_SUFFIX
    && b.sunset.base_revision_suffix === locks.SUNSET_BASE_SUFFIX
    && b.builds.source_type === locks.SOURCE_TYPE_B
    && b.builds.observed_at === locks.INDEPENDENT_VERIFY_UTC);
}

{
  const wh = classBTenant(evidence, 'wolfhouse');
  const su = classBTenant(evidence, 'sunset');
  ok('C9 final secretRef + inactive fail + 100% traffic (class B)',
    wh.final_state.database_secret_ref === locks.WH_SECRET_REF
    && su.final_state.database_secret_ref === locks.SUNSET_SECRET_REF
    && wh.final_state.fail_revision_active === false
    && su.final_state.fail_revision_active === false
    && wh.final_state.traffic_latest_percent === 100
    && su.final_state.traffic_latest_percent === 100
    && wh.final_state.latest_ready_revision === locks.WH_RESTORE_REV
    && su.final_state.latest_ready_revision === locks.SUNSET_RESTORE_REV
    && wh.final_state.source_type === locks.SOURCE_TYPE_B
    && wh.final_state.observed_at === locks.INDEPENDENT_VERIFY_UTC
    && su.final_state.observed_at === locks.INDEPENDENT_VERIFY_UTC);
}

{
  const mv = validateGateMatrix(matrix);
  ok('C10 matrix validation (counts + G02 partial_live_proven)', mv.ok, mv.errors.join(' | '));
}

ok('C11 top contract selected_16x + G02 drill live_proven',
  topContract.slice === locks.SLICE
  && topContract.selected_16x
  && topContract.selected_16x.outcome_id === locks.OUTCOME_ID
  && topContract.selected_16x.g02_dependency_failure_drill === 'live_proven_via_16X'
  && topContract.selected_16x.g02_verdict === 'partial'
  && topContract.selected_16w
  && topContract.selected_16w.g02_lifecycle_source === 'closed_via_16W');

ok('C12 doc mentions 16X + G02 partial + traffic shed + provenance split',
  /16X|g02.?live.?evidence/i.test(doc)
  && /partial/i.test(doc)
  && /traffic.?shed|g02fail|Activating/i.test(doc)
  && /SIGTERM|lifecycle.?live/i.test(doc)
  && /transcript|provenance|class A|operator-observed/i.test(doc)
  && /independently|class B|Azure read-only/i.test(doc)
  && !/\bG02\s+proven\b/i.test(doc));

ok('C13 findings mention 16X drill without proven overclaim',
  /16X/.test(findings)
  && /traffic.?shed|g02fail|2dcda08/i.test(findings)
  && /partial/i.test(findings)
  && !/\bG02\s+proven\b/i.test(findings));

{
  const rt = runtimePathsUnchanged();
  ok('C14 runtime paths unchanged vs master', rt.ok, rt.detail);
}

{
  const ownedBlob = locks.OWNED_RELS.map((rel) => {
    try { return readText(rel); } catch (_) { return ''; }
  }).join('\n');
  const sec = secretFree(ownedBlob, 'owned');
  ok('C15 secret-free owned artifacts (no DSN/secret values)', sec.ok, sec.detail);
}

{
  const pkg = readJson('package.json');
  ok('C16 package script registered',
    pkg.scripts
    && pkg.scripts['verify:radar-slice16x-g02-live-evidence']
      === 'node scripts/verify-radar-slice16x-g02-live-evidence.js');
}

{
  const pv = validateProvenanceSplit(evidence);
  ok('C17 provenance split A/B + limitations + non-recoverability', pv.ok, pv.errors.join(' | '));
}

green('claims_and_disposition_locked',
  locks.CLAIMS_ALLOWED.every((c) => evidence.claims_allowed.includes(c))
  && evidence.disposition.proves.length >= 5
  && evidence.disposition.does_not_prove.includes('production')
  && evidence.disposition.does_not_prove.includes('full_G02_proven'));

green('fail_env_redacted_not_secretRef',
  classATenant(evidence, 'wolfhouse').fail_env.WOLFHOUSE_DATABASE_URL.secretRef === null
  && classATenant(evidence, 'sunset').fail_env.WOLFHOUSE_DATABASE_URL.secretRef === null
  && classATenant(evidence, 'wolfhouse').fail_env.WOLFHOUSE_DATABASE_URL.host_redacted === '127.0.0.1'
  && classATenant(evidence, 'sunset').fail_env.WOLFHOUSE_DATABASE_URL.host_redacted === '127.0.0.1'
  && classATenant(evidence, 'wolfhouse').fail_scale_min_replicas === 1
  && classATenant(evidence, 'sunset').fail_scale_min_replicas === 1);

green('timeline_fail_to_restore_ge_90s', (() => {
  const whFail = Date.parse(locks.WH_TIMELINE.fail_revision_created_utc);
  const whRestore = Date.parse(locks.WH_TIMELINE.restore_revision_created_utc);
  const suFail = Date.parse(locks.SUNSET_TIMELINE.fail_revision_created_utc);
  const suRestore = Date.parse(locks.SUNSET_TIMELINE.restore_revision_created_utc);
  return (whRestore - whFail) >= 90000 && (suRestore - suFail) >= 90000;
})());

green('class_b_final_and_probes_reverified_at_utc',
  classBTenant(evidence, 'wolfhouse').final_state.observed_at === locks.INDEPENDENT_VERIFY_UTC
  && classBTenant(evidence, 'sunset').final_state.observed_at === locks.INDEPENDENT_VERIFY_UTC
  && classBTenant(evidence, 'wolfhouse').final_state.probes.length === 3
  && classBTenant(evidence, 'sunset').final_state.probes.length === 3);

green('live_timeout_does_not_rewrite_historical_200', (() => {
  const after = locks.mergeLiveProbeWithoutRewritingHistorical(evidence, {
    attempted_at_utc: '2026-07-21T99:00:00Z',
    result: 'timeout',
  });
  const rewritten = locks.historicalSamplesRewrittenByLiveProbe(evidence, after);
  const still200 = classATenant(after, 'wolfhouse').observation.samples.every(
    (s) => s.public_healthz === 200 && s.public_readyz === 200,
  ) && classATenant(after, 'sunset').observation.samples.every(
    (s) => s.public_healthz === 200 && s.public_readyz === 200,
  );
  return !rewritten && still200;
})());

// --- RED battery ---
{
  const bad = deepClone(evidence);
  bad.image_sha_full = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  red('wrong_sha_rejected', !validateEvidenceExact(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.B_independently_recoverable_azure_readonly.builds.wolfhouse_digest =
    'sha256:0000000000000000000000000000000000000000000000000000000000000000';
  red('wrong_wh_digest_rejected', !validateEvidenceExact(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.B_independently_recoverable_azure_readonly.builds.sunset_digest =
    'sha256:1111111111111111111111111111111111111111111111111111111111111111';
  red('wrong_sunset_digest_rejected', !validateEvidenceExact(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.base_revision_suffix = '0000517';
  red('wrong_wh_revision_rejected', !validateEvidenceExact(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.B_independently_recoverable_azure_readonly.sunset.base_revision_suffix = '0000277';
  red('wrong_sunset_revision_rejected', !validateEvidenceExact(bad).ok);
}
{
  const bad = deepClone(evidence);
  const fakeDsn = ['postgres', 'ql://', 'user:', 'hunter2@', '127.0.0.1:5432/db'].join('');
  bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.fail_env.WOLFHOUSE_DATABASE_URL = {
    kind: 'secret_value',
    value: fakeDsn,
    secretRef: null,
  };
  const v = validateEvidenceExact(bad);
  const sec = secretFree(JSON.stringify(bad), 'tampered');
  red('secret_values_rejected', !v.ok && !sec.ok);
}
{
  const bad = deepClone(evidence);
  const aWh = bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse;
  aWh.observation.samples = aWh.observation.samples.slice(0, 5);
  aWh.observation.sample_count = 5;
  aWh.observation.duration_seconds = 20;
  red('missing_90s_observations_rejected', !validateEvidenceExact(bad).ok || !observationOk(aWh).ok);
}
{
  const bad = deepClone(evidence);
  for (const s of bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.observation.samples) {
    s.fail_was_latest_ready = true;
    s.fail_running_state = 'RunningAtMaxScale';
  }
  red('failed_revision_became_ready_rejected',
    !observationOk(bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse).ok);
}
{
  const bad = deepClone(evidence);
  for (const s of bad.observed_facts.A_operator_observed_drill_transcript.sunset.observation.samples) {
    s.public_healthz = 503;
    s.public_readyz = 503;
  }
  red('non_200_public_continuity_rejected',
    !observationOk(bad.observed_facts.A_operator_observed_drill_transcript.sunset).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.final_state.fail_revision_active = true;
  red('active_failed_revision_rejected', !validateEvidenceExact(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.final_state.database_secret_ref = 'wrong-secret';
  bad.observed_facts.B_independently_recoverable_azure_readonly.sunset.final_state.database_secret_ref = 'wolfhouse-database-url';
  red('wrong_restored_secretRef_rejected', !validateEvidenceExact(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.disposition.g02_verdict = 'proven';
  bad.gate_progress_updates.G02_readiness_dependencies.verdict = 'proven';
  bad.gate_progress_updates.G02_readiness_dependencies.still_open = [];
  bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'full_G02_proven');
  red('overclaim_g02_proven_rejected', !validateEvidenceExact(bad).ok);
}
{
  const bad = deepClone(evidence);
  bad.lock_hash = '0'.repeat(64);
  red('lock_hash_tamper_rejected', !validateEvidenceExact(bad).ok);
}
{
  const badMatrix = deepClone(matrix);
  const g02 = badMatrix.gates.find((g) => g.id === 'G02_readiness_dependencies');
  g02.verdict = 'proven';
  badMatrix.verdict_counts.proven = 1;
  badMatrix.verdict_counts.partial = 8;
  red('matrix_g02_proven_rejected', !validateGateMatrix(badMatrix).ok);
}
{
  const badDoc = `${doc}\n\nG02 proven end-to-end including production.\n`;
  const hits = fieldLevelOverclaim(badDoc);
  red('doc_overclaim_tokens_rejected', hits.length > 0, hits.join(','));
}
{
  const bad = deepClone(evidence);
  delete bad.observed_facts.A_operator_observed_drill_transcript;
  delete bad.provenance_limitations;
  delete bad.non_recoverability;
  const pv = validateProvenanceSplit(bad);
  red('missing_provenance_split_rejected', !pv.ok);
}
{
  const bad = deepClone(evidence);
  const aWh = bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse;
  aWh.observation.source_type = locks.SOURCE_TYPE_B;
  for (const s of aWh.observation.samples) {
    s.source_type = locks.SOURCE_TYPE_B;
    s.source_ref = locks.SOURCE_REF_B;
  }
  red('historical_arrays_azure_derived_label_rejected',
    samplesHaveAzureDerivedLabel(aWh)
    || !observationOk(aWh).ok
    || !validateProvenanceSplit(bad).ok);
}
{
  const bad = deepClone(evidence);
  const aWh = bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse;
  delete aWh.observation.source_ref;
  for (const s of aWh.observation.samples) {
    delete s.source_ref;
    delete s.source_type;
  }
  red('missing_transcript_attribution_rejected', !observationOk(aWh).ok);
}
{
  const bad = deepClone(evidence);
  const aWh = bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse;
  for (const s of aWh.observation.samples) {
    s.current_verify_utc = locks.INDEPENDENT_VERIFY_UTC;
    s.source_type = locks.SOURCE_TYPE_B;
  }
  // Also place historical samples under B (fabricated Azure recreation).
  bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.observation = {
    source_type: locks.SOURCE_TYPE_B,
    samples: aWh.observation.samples,
  };
  red('fabricated_current_verification_of_historical_samples_rejected',
    samplesClaimFabricatedCurrentVerify(aWh)
    || !validateProvenanceSplit(bad).ok);
}
{
  const bad = deepClone(evidence);
  // Simulate a buggy merge that rewrites historical 200s from a live timeout.
  const after = locks.mergeLiveProbeWithoutRewritingHistorical(bad, {
    attempted_at_utc: '2026-07-21T12:00:00Z',
    result: 'timeout',
  });
  // Force a bad rewrite as the RED subject.
  for (const s of after.observed_facts.A_operator_observed_drill_transcript.wolfhouse.observation.samples) {
    s.public_healthz = null;
    s.public_readyz = null;
    s.note = 'cleared because live probe timed out';
  }
  red('live_timeout_rewrite_of_historical_200_rejected',
    locks.historicalSamplesRewrittenByLiveProbe(evidence, after)
    || !observationOk(after.observed_facts.A_operator_observed_drill_transcript.wolfhouse).ok);
}

const REQUIRED_RED = [
  'wrong_sha_rejected',
  'wrong_wh_digest_rejected',
  'wrong_sunset_digest_rejected',
  'wrong_wh_revision_rejected',
  'wrong_sunset_revision_rejected',
  'secret_values_rejected',
  'missing_90s_observations_rejected',
  'failed_revision_became_ready_rejected',
  'non_200_public_continuity_rejected',
  'active_failed_revision_rejected',
  'wrong_restored_secretRef_rejected',
  'overclaim_g02_proven_rejected',
  'lock_hash_tamper_rejected',
  'matrix_g02_proven_rejected',
  'doc_overclaim_tokens_rejected',
  'missing_provenance_split_rejected',
  'historical_arrays_azure_derived_label_rejected',
  'missing_transcript_attribution_rejected',
  'fabricated_current_verification_of_historical_samples_rejected',
  'live_timeout_rewrite_of_historical_200_rejected',
];
const REQUIRED_GREEN = [
  'claims_and_disposition_locked',
  'fail_env_redacted_not_secretRef',
  'timeline_fail_to_restore_ge_90s',
  'class_b_final_and_probes_reverified_at_utc',
  'live_timeout_does_not_rewrite_historical_200',
];

const redMissing = REQUIRED_RED.filter((id) => !redResults.some((r) => r.id === id && r.ok));
const greenMissing = REQUIRED_GREEN.filter((id) => !greenResults.some((r) => r.id === id && r.ok));
ok('R1 all required RED ids passed', redMissing.length === 0, redMissing.join(','));
ok('G1 all required GREEN ids passed', greenMissing.length === 0, greenMissing.join(','));

console.log(`\nResult: ${pass} passed, ${fail} failed`);
console.log(`RED ${redResults.filter((r) => r.ok).length}/${REQUIRED_RED.length} `
  + `GREEN ${greenResults.filter((r) => r.ok).length}/${REQUIRED_GREEN.length}`);
if (fail > 0) process.exit(1);
console.log('RADAR 16X G02 live evidence (partial/live-proven): PASS');
}

module.exports = {
  buildExpectedEvidence,
  computeEvidenceLockHash,
  validateEvidenceExact,
  validateProvenanceSplit,
  observationOk,
  runVerifier,
};

if (require.main === module) {
  runVerifier();
}
