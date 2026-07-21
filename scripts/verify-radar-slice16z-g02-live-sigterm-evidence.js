'use strict';

/**
 * verify:radar-slice16z-g02-live-sigterm-evidence — RADAR Slice 16Z
 *
 * Offline gate: bounded G02 live SIGTERM lifecycle evidence reconciliation
 * with mandatory provenance split:
 *   (A) operator-observed drill transcript contemporaneous facts
 *   (B) later independently recoverable Azure/ACR/LAW read-only facts
 *
 * Rejects wrong SHA/digest/revision/LAW timestamps, duplicate/missing
 * completion, non-ok pool/server, non-SIGTERM signal, secret fields,
 * claimed concurrent restart continuity, historical arrays labelled
 * Azure-derived, missing transcript attribution, fabricated current
 * verification of historical samples, unbounded/revision-lifetime
 * exactly-one LAW cardinality, missing later-record disclosure,
 * drill records outside declared windows, overlapping windows,
 * later records relabelled as drill completions, and G02 proven overclaims.
 * No Azure mutation.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16z-g02-live-sigterm-evidence');

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

function buildPostRestartObservation(kind) {
  const isWh = kind === 'wolfhouse';
  const window = isWh ? locks.WH_SAMPLE_WINDOW : locks.SUNSET_SAMPLE_WINDOW;
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
      sample_count: window.sample_count,
      sample_span_seconds: window.sample_span_seconds,
      last_sample_utc: window.last_sample_utc,
      semantics: window.semantics,
      derivation: window.derivation,
    },
    duration_seconds: locks.OBS_WINDOW_DURATION_S,
    cadence_seconds: locks.OBS_CADENCE_S,
    sample_count: locks.OBS_SAMPLE_COUNT,
    sample_span_seconds: locks.OBS_SAMPLE_SPAN_S,
    samples: samples.map((s) => ({ ...s })),
    public_recovery: {
      source_type: locks.SOURCE_TYPE_A,
      source_ref: locks.SOURCE_REF_A,
      observed_at_semantics: locks.OBSERVED_AT_SEMANTICS_A,
      public_healthz: 200,
      public_readyz: 200,
      note: 'Post-restart recovery samples only — explicitly not concurrent restart continuity or zero-downtime-during-restart proof',
    },
  };
}

function buildClassATenant(kind) {
  const isWh = kind === 'wolfhouse';
  const restart = isWh ? locks.WH_RESTART : locks.SUNSET_RESTART;
  return {
    app: isWh ? locks.WH_APP : locks.SUNSET_APP,
    revision: isWh ? locks.WH_REVISION : locks.SUNSET_REVISION,
    operator_restart: {
      source_type: locks.SOURCE_TYPE_A,
      source_ref: locks.SOURCE_REF_A,
      observed_at_semantics: locks.OBSERVED_AT_SEMANTICS_A,
      started_utc: restart.started_utc,
      ended_utc: restart.ended_utc,
      note: 'Operator-initiated container restart window from drill transcript; not Azure-reconstructible as contemporaneous continuity',
    },
    post_restart_observation: buildPostRestartObservation(kind),
  };
}

function buildAllowlistedRecord() {
  return {
    event: locks.COMPLETION_RECORD.event,
    original_signal: locks.COMPLETION_RECORD.original_signal,
    pool_close_result: locks.COMPLETION_RECORD.pool_close_result,
    server_close_result: locks.COMPLETION_RECORD.server_close_result,
    failure_classes: [],
    completion: true,
  };
}

function buildLawQueryWindow(kind) {
  const isWh = kind === 'wolfhouse';
  const window = isWh ? locks.WH_LAW_QUERY_WINDOW : locks.SUNSET_LAW_QUERY_WINDOW;
  return {
    start_utc: window.start_utc,
    end_utc: window.end_utc,
    start_inclusive: window.start_inclusive,
    end_inclusive: window.end_inclusive,
    semantics: window.semantics,
    derivation: window.derivation,
    source_type: locks.SOURCE_TYPE_B,
    source_ref: locks.SOURCE_REF_LAW_CARDINALITY,
    observed_at: locks.LAW_CARDINALITY_REVERIFY_UTC,
  };
}

function buildLawRevisionLifetimeDisclosure(kind) {
  const isWh = kind === 'wolfhouse';
  const later = isWh
    ? locks.WH_LATER_LAW_RECORDS_AT_REVIEW.map((r) => ({
      TimeGenerated: r.TimeGenerated,
      class: r.class,
      revision: r.revision,
      record: buildAllowlistedRecord(),
    }))
    : [];
  return {
    source_type: locks.SOURCE_TYPE_B,
    source_ref: locks.SOURCE_REF_LAW_CARDINALITY,
    observed_at: locks.LAW_CARDINALITY_REVERIFY_UTC,
    unqualified_exactly_one_per_revision: false,
    revision_lifetime_count_is_one: false,
    may_continue_growing_due_to_scaling_restarts: true,
    known_revision_lifetime_count_at_review: isWh ? 3 : 1,
    claim_limited_to: 'exactly_one_in_declared_drill_query_window',
    known_later_records_at_review: later,
    note: isWh
      ? 'WH target revision has additional valid SIGTERM completions after the drill window (later lifecycle/scaling/restart events). Revision-lifetime count is not one and may continue growing. 16Z claims exactly one only inside the declared WH drill query window.'
      : 'Sunset known later records at review: none in lookback. Revision-lifetime exactly-one is still not claimed as a durable invariant (may grow via scaling/restarts). 16Z claims exactly one only inside the declared Sunset drill query window.',
  };
}

function buildClassBTenant(kind) {
  const isWh = kind === 'wolfhouse';
  const tl = isWh ? locks.WH_TIMELINE_B : locks.SUNSET_TIMELINE_B;
  const law = isWh ? locks.WH_LAW : locks.SUNSET_LAW;
  const lawTime = isWh ? locks.WH_LAW_TIME : locks.SUNSET_LAW_TIME;
  return {
    app: isWh ? locks.WH_APP : locks.SUNSET_APP,
    resource_group: isWh ? locks.WH_RG : locks.SUNSET_RG,
    public_host: isWh ? locks.WH_PUBLIC_HOST : locks.SUNSET_PUBLIC_HOST,
    image: isWh ? locks.WH_IMAGE : locks.SUNSET_IMAGE,
    digest: isWh ? locks.WH_DIGEST : locks.SUNSET_DIGEST,
    revision: isWh ? locks.WH_REVISION : locks.SUNSET_REVISION,
    revision_suffix: isWh ? locks.WH_REVISION_SUFFIX : locks.SUNSET_REVISION_SUFFIX,
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
    law_workspace: {
      ...law,
      source_type: locks.SOURCE_TYPE_B,
      source_ref: locks.SOURCE_REF_B,
      observed_at: locks.INDEPENDENT_VERIFY_UTC,
    },
    law_completion: {
      source_type: locks.SOURCE_TYPE_B,
      source_ref: locks.SOURCE_REF_LAW_CARDINALITY,
      observed_at: locks.LAW_CARDINALITY_REVERIFY_UTC,
      table: locks.LOG_TABLE,
      cardinality_semantics: locks.CARDINALITY_SEMANTICS,
      query_window: buildLawQueryWindow(kind),
      match_count: 1,
      TimeGenerated: lawTime,
      revision: isWh ? locks.WH_REVISION : locks.SUNSET_REVISION,
      record: buildAllowlistedRecord(),
    },
    law_revision_lifetime_disclosure: buildLawRevisionLifetimeDisclosure(kind),
    final_state: {
      source_type: locks.SOURCE_TYPE_B,
      source_ref: locks.SOURCE_REF_B,
      observed_at: locks.INDEPENDENT_VERIFY_UTC,
      observed_at_semantics: locks.OBSERVED_AT_SEMANTICS_B,
      latest_revision: isWh ? locks.WH_REVISION : locks.SUNSET_REVISION,
      latest_ready_revision: isWh ? locks.WH_REVISION : locks.SUNSET_REVISION,
      health_state: 'Healthy',
      running_state: 'RunningAtMaxScale',
      traffic_latest_percent: 100,
      public_healthz: 200,
      public_readyz: 200,
      public_current_note:
        'public_healthz/public_readyz here are independently reverified current values at observed_at — not a recreation of class-A historical post-restart samples',
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
    title: 'Reconcile dual-staging live SIGTERM lifecycle drill evidence (bounded; no overclaims)',
    image_sha_short: locks.IMAGE_SHA_SHORT,
    image_sha_full: locks.IMAGE_SHA_FULL,
    subscription_id: locks.SUBSCRIPTION_ID,
    independent_azure_verify_utc: locks.INDEPENDENT_VERIFY_UTC,
    law_cardinality_reverify_utc: locks.LAW_CARDINALITY_REVERIFY_UTC,
    provenance_limitations: locks.PROVENANCE_LIMITATIONS,
    non_recoverability: locks.NON_RECOVERABILITY,
    observed_facts: {
      A_operator_observed_drill_transcript: {
        source_type: locks.SOURCE_TYPE_A,
        source_ref: locks.SOURCE_REF_A,
        observed_at_semantics: locks.OBSERVED_AT_SEMANTICS_A,
        covers: [
          'operator_restart_windows',
          'post_restart_healthz_readyz_samples_31_approx_2s',
        ],
        explicitly_not_covered: [
          'concurrent_restart_continuity',
          'zero_downtime_during_restart',
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
          'images_and_serving_revisions',
          'revision_create_timelines',
          'law_shutdown_completion_exactly_one_each_in_declared_drill_query_window',
          'law_revision_lifetime_later_records_disclosed',
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
        'dual_staging_sigterm_cleanup_telemetry_law_exactly_one_each_in_declared_drill_query_window',
        'allowlisted_completion_sigterm_pool_ok_server_ok_empty_failures',
        'post_restart_recovery_healthz_readyz_200_both_tenants',
        'exact_sha_95dc363_digests_revisions_healthy_serving',
        'wh_later_sigterm_records_disclosed_revision_lifetime_not_one',
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
          'lifecycle_wired_image_95dc363_deployed_wh_0000519_sunset_0000279',
          'live_sigterm_completion_law_exactly_one_each_tenant_in_declared_drill_query_window',
          'post_restart_recovery_31x_healthz_readyz_200',
          'prior_16X_traffic_shed_retained',
          'prior_16Y_completion_log_source_retained',
        ],
        still_open: [
          'sigint_live_lifecycle',
          'serving_revision_readyz_503_body_path',
          'zero_downtime_during_restart',
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
      if (t && t.post_restart_observation && Array.isArray(t.post_restart_observation.samples)) {
        errors.push(`B.${tenant}.post_restart_observation.samples must not exist (historical arrays are class A only)`);
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
  if (matrix.slice !== locks.SLICE && matrix.slice !== 'RADAR-16Y' && matrix.slice !== 'RADAR-16X' && matrix.slice !== 'RADAR-16AA' && matrix.slice !== 'RADAR-16AB' && matrix.slice !== 'RADAR-16AC' && matrix.slice !== 'RADAR-16AD') {
    errors.push(`slice=${matrix.slice}`);
  }
  if (matrix.slice === locks.SLICE) {
    if (matrix.branch !== locks.BRANCH
      && !['radar/slice-16aa-g02-live-sigint-evidence','radar/slice-16ab-g02-readyz503-evidence','radar/slice-16ac-organic-restart-alert-evidence','radar/slice-16ad-g02-sampled-restart-continuity-evidence'].includes(matrix.branch)) {
      errors.push(`branch=${matrix.branch}`);
    }
    if (matrix.master_basis !== locks.MASTER_BASIS
      && !['c43b4a14d14d5618d99e0e969b4f39784a526722','72d8faf74df27a714482ebdefb8f88870d080306','137b14a0b3efc689ba749340a97ab4e9bc220edc'].includes(matrix.master_basis)) {
      errors.push('master_basis mismatch');
    }
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
    if (!/16Z|SIGTERM|LAW/i.test(String(g02.rationale || ''))) {
      errors.push('G02 rationale missing 16Z/SIGTERM/LAW facts');
    }
    if (!/drill.?query.?window|bounded.?drill|query.?window/i.test(String(g02.rationale || ''))) {
      errors.push('G02 rationale missing bounded drill query window cardinality');
    }
    if (!/later|revision.?lifetime|11:24:48|not one/i.test(String(g02.rationale || ''))) {
      errors.push('G02 rationale missing later-record / revision-lifetime disclosure');
    }
    if (!Array.isArray(g02.gaps) || !g02.gaps.some((g) => (
      /serving.?revision.?readyz.?503|readyz.?=?503|zero.?downtime/i.test(String(g))
    ))) {
      errors.push('G02 gaps must retain serving readyz=503 or zero_downtime open (SIGINT may be closed via 16AA)');
    }
    if (g02.gaps && g02.gaps.some((g) => (
      /SIGTERM\s+live.*not\s+proven|SIGTERM.*live\s+lifecycle.*not\s+proven|SIGTERM live open/i.test(String(g))
    ))) {
      errors.push('G02 gaps still claim SIGTERM live not proven as if open');
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

function observationOk(tenantOrObs) {
  const obs = tenantOrObs && tenantOrObs.post_restart_observation
    ? tenantOrObs.post_restart_observation
    : tenantOrObs;
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
  if (obs.cadence_seconds !== locks.OBS_CADENCE_S) {
    return { ok: false, detail: `cadence ${obs.cadence_seconds}` };
  }
  if (!Array.isArray(obs.samples) || obs.samples.length !== locks.OBS_SAMPLE_COUNT) {
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
    if (s.sample_class !== 'post_restart_recovery_not_concurrent_restart_continuity') {
      return { ok: false, detail: `sample_class=${s.sample_class}` };
    }
    if (s.public_healthz !== 200 || s.public_readyz !== 200) {
      return { ok: false, detail: 'non-200 continuity' };
    }
  }
  if (!obs.public_recovery
    || obs.public_recovery.source_type !== locks.SOURCE_TYPE_A
    || obs.public_recovery.public_healthz !== 200
    || obs.public_recovery.public_readyz !== 200) {
    return { ok: false, detail: 'public_recovery not transcript-attributed 200' };
  }
  return { ok: true };
}

function parseUtcMs(utc) {
  const ms = Date.parse(String(utc || '').replace(
    /\.(\d{3})\d*Z$/,
    '.$1Z',
  ));
  return Number.isFinite(ms) ? ms : NaN;
}

function timeInInclusiveWindow(timeUtc, window) {
  const t = parseUtcMs(timeUtc);
  const start = parseUtcMs(window && window.start_utc);
  const end = parseUtcMs(window && window.end_utc);
  if (![t, start, end].every(Number.isFinite)) return false;
  return t >= start && t <= end;
}

function windowsOverlap(a, b) {
  const a0 = parseUtcMs(a && a.start_utc);
  const a1 = parseUtcMs(a && a.end_utc);
  const b0 = parseUtcMs(b && b.start_utc);
  const b1 = parseUtcMs(b && b.end_utc);
  if (![a0, a1, b0, b1].every(Number.isFinite)) return true;
  return a0 <= b1 && b0 <= a1;
}

function allowlistedRecordOk(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    return { ok: false, detail: 'record missing' };
  }
  const keys = Object.keys(rec).sort();
  const allowed = [...locks.ALLOWED_RECORD_KEYS].sort();
  if (keys.length !== allowed.length || keys.some((k, i) => k !== allowed[i])) {
    return { ok: false, detail: `record keys=${keys.join(',')}` };
  }
  if (rec.event !== locks.COMPLETION_RECORD.event) return { ok: false, detail: 'event' };
  if (rec.original_signal !== locks.COMPLETION_RECORD.original_signal) {
    return { ok: false, detail: `signal=${rec.original_signal}` };
  }
  if (rec.pool_close_result !== locks.COMPLETION_RECORD.pool_close_result) {
    return { ok: false, detail: `pool=${rec.pool_close_result}` };
  }
  if (rec.server_close_result !== locks.COMPLETION_RECORD.server_close_result) {
    return { ok: false, detail: `server=${rec.server_close_result}` };
  }
  if (!Array.isArray(rec.failure_classes) || rec.failure_classes.length !== 0) {
    return { ok: false, detail: 'failure_classes' };
  }
  if (rec.completion !== true) return { ok: false, detail: 'completion' };
  return { ok: true };
}

function lawCompletionOk(tenant, expectedTime, expectedWindow) {
  const lc = tenant && tenant.law_completion;
  if (!lc) return { ok: false, detail: 'missing law_completion' };
  if (lc.cardinality_semantics !== locks.CARDINALITY_SEMANTICS) {
    return { ok: false, detail: `cardinality_semantics=${lc.cardinality_semantics}` };
  }
  if (lc.source_ref !== locks.SOURCE_REF_LAW_CARDINALITY) {
    return { ok: false, detail: 'law_completion source_ref' };
  }
  if (lc.observed_at !== locks.LAW_CARDINALITY_REVERIFY_UTC) {
    return { ok: false, detail: 'law_completion observed_at' };
  }
  if (lc.match_count !== 1) return { ok: false, detail: `match_count=${lc.match_count}` };
  if (lc.TimeGenerated !== expectedTime) {
    return { ok: false, detail: `TimeGenerated=${lc.TimeGenerated}` };
  }
  if (lc.table !== locks.LOG_TABLE) return { ok: false, detail: `table=${lc.table}` };
  const qw = lc.query_window;
  if (!qw || typeof qw !== 'object') return { ok: false, detail: 'missing query_window' };
  if (qw.start_utc !== expectedWindow.start_utc || qw.end_utc !== expectedWindow.end_utc) {
    return { ok: false, detail: 'query_window bounds' };
  }
  if (qw.start_inclusive !== true || qw.end_inclusive !== true) {
    return { ok: false, detail: 'query_window inclusivity' };
  }
  if (qw.semantics !== locks.WH_LAW_QUERY_WINDOW.semantics) {
    return { ok: false, detail: `query_window semantics=${qw.semantics}` };
  }
  if (!qw.derivation || typeof qw.derivation !== 'string') {
    return { ok: false, detail: 'query_window derivation' };
  }
  if (qw.source_type !== locks.SOURCE_TYPE_B || qw.source_ref !== locks.SOURCE_REF_LAW_CARDINALITY) {
    return { ok: false, detail: 'query_window source refs' };
  }
  if (!timeInInclusiveWindow(lc.TimeGenerated, qw)) {
    return { ok: false, detail: 'drill TimeGenerated outside query_window' };
  }
  return allowlistedRecordOk(lc.record);
}

function lawDisclosureOk(tenant, kind) {
  const d = tenant && tenant.law_revision_lifetime_disclosure;
  if (!d) return { ok: false, detail: 'missing law_revision_lifetime_disclosure' };
  if (d.unqualified_exactly_one_per_revision !== false) {
    return { ok: false, detail: 'unqualified_exactly_one_per_revision must be false' };
  }
  if (d.revision_lifetime_count_is_one !== false) {
    return { ok: false, detail: 'revision_lifetime_count_is_one must be false' };
  }
  if (d.may_continue_growing_due_to_scaling_restarts !== true) {
    return { ok: false, detail: 'may_continue_growing missing' };
  }
  if (d.claim_limited_to !== 'exactly_one_in_declared_drill_query_window') {
    return { ok: false, detail: 'claim_limited_to' };
  }
  if (!Array.isArray(d.known_later_records_at_review)) {
    return { ok: false, detail: 'known_later_records_at_review missing' };
  }
  if (kind === 'wolfhouse') {
    if (d.known_revision_lifetime_count_at_review !== 3) {
      return { ok: false, detail: 'WH lifetime count' };
    }
    if (d.known_later_records_at_review.length !== locks.WH_LATER_LAW_RECORDS_AT_REVIEW.length) {
      return { ok: false, detail: 'WH later records length' };
    }
    for (let i = 0; i < locks.WH_LATER_LAW_RECORDS_AT_REVIEW.length; i += 1) {
      const got = d.known_later_records_at_review[i];
      const exp = locks.WH_LATER_LAW_RECORDS_AT_REVIEW[i];
      if (!got || got.TimeGenerated !== exp.TimeGenerated) {
        return { ok: false, detail: `later TimeGenerated[${i}]` };
      }
      if (got.class !== 'later_lifecycle_event_not_16z_drill_completion') {
        return { ok: false, detail: `later class[${i}]` };
      }
      if (timeInInclusiveWindow(got.TimeGenerated, locks.WH_LAW_QUERY_WINDOW)) {
        return { ok: false, detail: `later record[${i}] inside drill window` };
      }
      const rec = allowlistedRecordOk(got.record);
      if (!rec.ok) return { ok: false, detail: `later record[${i}] ${rec.detail}` };
    }
  } else if (d.known_later_records_at_review.length !== 0) {
    return { ok: false, detail: 'Sunset later records must be empty at review' };
  }
  return { ok: true };
}

function lawCardinalityContractOk(ev) {
  const b = ev && ev.observed_facts && ev.observed_facts.B_independently_recoverable_azure_readonly;
  if (!b) return { ok: false, detail: 'missing B' };
  const wh = b.wolfhouse;
  const su = b.sunset;
  const whLaw = lawCompletionOk(wh, locks.WH_LAW_TIME, locks.WH_LAW_QUERY_WINDOW);
  const suLaw = lawCompletionOk(su, locks.SUNSET_LAW_TIME, locks.SUNSET_LAW_QUERY_WINDOW);
  if (!whLaw.ok) return { ok: false, detail: `WH ${whLaw.detail}` };
  if (!suLaw.ok) return { ok: false, detail: `Sunset ${suLaw.detail}` };
  const whDisc = lawDisclosureOk(wh, 'wolfhouse');
  const suDisc = lawDisclosureOk(su, 'sunset');
  if (!whDisc.ok) return { ok: false, detail: `WH disclosure ${whDisc.detail}` };
  if (!suDisc.ok) return { ok: false, detail: `Sunset disclosure ${suDisc.detail}` };
  if (windowsOverlap(wh.law_completion.query_window, su.law_completion.query_window)) {
    return { ok: false, detail: 'drill query windows overlap' };
  }
  // Reject later records being relabelled as the drill completion.
  for (const later of wh.law_revision_lifetime_disclosure.known_later_records_at_review) {
    if (later.TimeGenerated === wh.law_completion.TimeGenerated) {
      return { ok: false, detail: 'later record equals drill TimeGenerated' };
    }
    if (later.class !== 'later_lifecycle_event_not_16z_drill_completion') {
      return { ok: false, detail: `later class=${later.class}` };
    }
    if (/^16z_drill|^drill_completion|relabelled_as_drill/i.test(String(later.class))) {
      return { ok: false, detail: 'later record relabelled as drill completion' };
    }
  }
  if (ev.claims_allowed.includes('law_exactly_one_sigterm_completion_each_tenant')
    && !ev.claims_allowed.includes('law_exactly_one_sigterm_completion_each_tenant_in_declared_drill_query_window')) {
    return { ok: false, detail: 'unbounded/unqualified exactly-one claim present' };
  }
  if (!ev.explicitly_not_claimed.includes('revision_lifetime_exactly_one_sigterm_completion')
    || !ev.explicitly_not_claimed.includes('unbounded_law_cardinality_exactly_one')) {
    return { ok: false, detail: 'missing cardinality exclusions' };
  }
  if (ev.law_cardinality_reverify_utc !== locks.LAW_CARDINALITY_REVERIFY_UTC) {
    return { ok: false, detail: 'law_cardinality_reverify_utc' };
  }
  return { ok: true };
}

function samplesHaveAzureDerivedLabel(tenant) {
  const obs = tenant && tenant.post_restart_observation;
  if (!obs || !Array.isArray(obs.samples)) return false;
  return obs.samples.some((s) => {
    const st = String(s.source_type || '');
    return /azure|independently_reverified|readonly/i.test(st)
      && !/transcript|operator_drill/i.test(st);
  }) || (/azure|independently_reverified/i.test(String(obs.source_type || ''))
    && !/transcript|operator_drill/i.test(String(obs.source_type || '')));
}

function samplesClaimFabricatedCurrentVerify(tenant) {
  const obs = tenant && tenant.post_restart_observation;
  if (!obs || !Array.isArray(obs.samples)) return false;
  return obs.samples.some((s) => (
    Object.prototype.hasOwnProperty.call(s, 'independently_reverified_at')
    || Object.prototype.hasOwnProperty.call(s, 'current_verify_utc')
    || Object.prototype.hasOwnProperty.call(s, 'azure_replay_utc')
    || s.source_type === locks.SOURCE_TYPE_B
  )) || obs.source_type === locks.SOURCE_TYPE_B;
}

function claimsConcurrentContinuity(ev) {
  const a = ev && ev.observed_facts && ev.observed_facts.A_operator_observed_drill_transcript;
  if (!a) return true;
  if (Array.isArray(a.covers) && a.covers.includes('concurrent_restart_continuity')) return true;
  if (Array.isArray(a.explicitly_not_covered)
    && !a.explicitly_not_covered.includes('concurrent_restart_continuity')) {
    return true;
  }
  for (const kind of ['wolfhouse', 'sunset']) {
    const obs = a[kind] && a[kind].post_restart_observation;
    if (!obs || !Array.isArray(obs.samples)) return true;
    if (obs.samples.some((s) => s.sample_class !== 'post_restart_recovery_not_concurrent_restart_continuity')) {
      return true;
    }
  }
  return false;
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
    /\bSIGINT\b.*\blive\s+(proven|closed|complete)\b/i,
    /\blive\s+SIGINT\b.*\bproven\b/i,
    /\bzero\s+downtime\s+during\s+restart\b.*\bproven\b/i,
    /\bconcurrent\s+restart\s+continuity\b.*\bproven\b/i,
  ];
  for (const re of forbidden) {
    if (re.test(text)) hits.push(String(re));
  }
  return hits;
}

function runVerifier() {
  console.log('RADAR 16Z G02 live SIGTERM evidence — offline verifier\n');

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

  ok('C3 HEAD on 16Z branch (tip may advance to 16AA)', currentBranch() === locks.BRANCH || currentBranch() === 'radar/slice-16aa-g02-live-sigint-evidence' || currentBranch() === 'radar/slice-16ab-g02-readyz503-evidence' || currentBranch() === 'radar/slice-16ac-organic-restart-alert-evidence'
    || currentBranch() === 'radar/slice-16ad-g02-sampled-restart-continuity-evidence'
    || currentBranch() === 'radar/slice-16af-g06-capacity-alert-live-evidence' || currentBranch() === 'radar/slice-16ag-g06-bounded-load-harness', currentBranch());

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
      'sigint_live_lifecycle',
    )
    && !evidence.gate_progress_updates.G02_readiness_dependencies.still_open.some(
      (x) => /sigterm/i.test(String(x)),
    ));

  {
    const whObs = observationOk(classATenant(evidence, 'wolfhouse'));
    const suObs = observationOk(classATenant(evidence, 'sunset'));
    ok('C7 31 post-restart samples both tenants class A',
      whObs.ok && suObs.ok, `${whObs.detail}|${suObs.detail}`);
  }

  {
    const b = evidence.observed_facts.B_independently_recoverable_azure_readonly;
    ok('C8 digests + SHA + revisions locked (class B)',
      b.builds.wolfhouse_digest === locks.WH_DIGEST
      && b.builds.sunset_digest === locks.SUNSET_DIGEST
      && evidence.image_sha_full === locks.IMAGE_SHA_FULL
      && b.wolfhouse.revision_suffix === locks.WH_REVISION_SUFFIX
      && b.sunset.revision_suffix === locks.SUNSET_REVISION_SUFFIX
      && b.builds.source_type === locks.SOURCE_TYPE_B
      && b.builds.observed_at === locks.INDEPENDENT_VERIFY_UTC);
  }

  {
    const card = lawCardinalityContractOk(evidence);
    const whLaw = lawCompletionOk(
      classBTenant(evidence, 'wolfhouse'),
      locks.WH_LAW_TIME,
      locks.WH_LAW_QUERY_WINDOW,
    );
    const suLaw = lawCompletionOk(
      classBTenant(evidence, 'sunset'),
      locks.SUNSET_LAW_TIME,
      locks.SUNSET_LAW_QUERY_WINDOW,
    );
    ok('C9 LAW exactly one each in declared drill windows + allowlisted payload + later disclosure',
      card.ok && whLaw.ok && suLaw.ok, `${card.detail}|${whLaw.detail}|${suLaw.detail}`);
  }

  {
    const mv = validateGateMatrix(matrix);
    ok('C10 matrix validation (counts + G02 partial_live_proven)', mv.ok, mv.errors.join(' | '));
  }

  ok('C11 top contract selected_16z + G02 SIGTERM live_proven_via_16Z (tip may be 16AA)',
    (topContract.slice === locks.SLICE || (topContract.slice === 'RADAR-16AA' || topContract.slice === 'RADAR-16AB' || topContract.slice === 'RADAR-16AC' || (topContract.slice === 'RADAR-16AD' || (topContract.slice === 'RADAR-16AF' || topContract.slice === 'RADAR-16AG')) || (topContract.slice === 'RADAR-16AD' || (topContract.slice === 'RADAR-16AF' || topContract.slice === 'RADAR-16AG'))))
    && topContract.selected_16z
    && topContract.selected_16z.outcome_id === locks.OUTCOME_ID
    && topContract.selected_16z.g02_sigterm_live === 'live_proven_via_16Z'
    && topContract.selected_16z.g02_verdict === 'partial'
    && topContract.selected_16y
    && topContract.selected_16x
    && topContract.selected_16w
    && topContract.selected_16w.g02_lifecycle_source === 'closed_via_16W');

  ok('C12 doc mentions 16Z + SIGTERM/LAW drill windows without G02 proven overclaim',
    /16Z|g02.?live.?sigterm/i.test(doc)
    && /SIGTERM/i.test(doc)
    && /LAW|completion/i.test(doc)
    && /partial/i.test(doc)
    && /transcript|provenance|class A|operator-observed/i.test(doc)
    && /independently|class B|Azure read-only|LAW/i.test(doc)
    && /drill.?query.?window|11:15:18Z|bounded/i.test(doc)
    && /11:24:48|later|revision.?lifetime/i.test(doc)
    && !/\bG02\s+proven\b/i.test(doc));

  ok('C13 findings mention 16Z without proven overclaim',
    /16Z/.test(findings)
    && /SIGTERM|sigterm/i.test(findings)
    && /partial/i.test(findings)
    && /drill.?query.?window|11:15:18Z|cardinality/i.test(findings)
    && !/\bG02\s+proven\b/i.test(findings));

  {
    const rt = runtimePathsUnchanged();
    ok('C14 runtime paths unchanged vs master (waived when tip is 16AA evidence)',
      rt.ok || (matrix.slice === 'RADAR-16AA' || matrix.slice === 'RADAR-16AB' || matrix.slice === 'RADAR-16AC' || (matrix.slice === 'RADAR-16AD' || (matrix.slice === 'RADAR-16AF' || matrix.slice === 'RADAR-16AG'))), rt.detail);
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
      && pkg.scripts['verify:radar-slice16z-g02-live-sigterm-evidence']
        === 'node scripts/verify-radar-slice16z-g02-live-sigterm-evidence.js');
  }

  {
    const pv = validateProvenanceSplit(evidence);
    ok('C17 provenance split A/B + limitations + non-recoverability', pv.ok, pv.errors.join(' | '));
  }

  green('claims_and_disposition_locked',
    locks.CLAIMS_ALLOWED.every((c) => evidence.claims_allowed.includes(c))
    && evidence.disposition.proves.length >= 4
    && evidence.disposition.does_not_prove.includes('production')
    && evidence.disposition.does_not_prove.includes('full_G02_proven')
    && evidence.disposition.does_not_prove.includes('concurrent_restart_continuity'));

  green('law_completions_exact_both_tenants',
    lawCardinalityContractOk(evidence).ok
    && lawCompletionOk(
      classBTenant(evidence, 'wolfhouse'),
      locks.WH_LAW_TIME,
      locks.WH_LAW_QUERY_WINDOW,
    ).ok
    && lawCompletionOk(
      classBTenant(evidence, 'sunset'),
      locks.SUNSET_LAW_TIME,
      locks.SUNSET_LAW_QUERY_WINDOW,
    ).ok);

  green('post_restart_sample_class_locked',
    observationOk(classATenant(evidence, 'wolfhouse')).ok
    && observationOk(classATenant(evidence, 'sunset')).ok
    && !claimsConcurrentContinuity(evidence));

  green('class_b_final_healthy_serving',
    classBTenant(evidence, 'wolfhouse').final_state.health_state === 'Healthy'
    && classBTenant(evidence, 'sunset').final_state.health_state === 'Healthy'
    && classBTenant(evidence, 'wolfhouse').final_state.traffic_latest_percent === 100
    && classBTenant(evidence, 'sunset').final_state.traffic_latest_percent === 100
    && classBTenant(evidence, 'wolfhouse').final_state.observed_at === locks.INDEPENDENT_VERIFY_UTC
    && classBTenant(evidence, 'sunset').final_state.probes.length === 3);

  green('live_probe_does_not_rewrite_historical_samples', (() => {
    const after = locks.mergeLiveProbeWithoutRewritingHistorical(evidence, {
      attempted_at_utc: '2026-07-21T99:00:00Z',
      result: 'timeout',
    });
    const rewritten = locks.historicalSamplesRewrittenByLiveProbe(evidence, after);
    const still200 = classATenant(after, 'wolfhouse').post_restart_observation.samples.every(
      (s) => s.public_healthz === 200 && s.public_readyz === 200,
    ) && classATenant(after, 'sunset').post_restart_observation.samples.every(
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
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.revision_suffix = '0000518';
    red('wrong_wh_revision_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.sunset.revision_suffix = '0000278';
    red('wrong_sunset_revision_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.TimeGenerated =
      '2026-07-21T00:00:00.0000000Z';
    red('wrong_wh_law_timestamp_rejected',
      !validateEvidenceExact(bad).ok
      || !lawCompletionOk(
        classBTenant(bad, 'wolfhouse'),
        locks.WH_LAW_TIME,
        locks.WH_LAW_QUERY_WINDOW,
      ).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.sunset.law_completion.TimeGenerated =
      '2026-07-21T00:00:00.0000000Z';
    red('wrong_sunset_law_timestamp_rejected',
      !validateEvidenceExact(bad).ok
      || !lawCompletionOk(
        classBTenant(bad, 'sunset'),
        locks.SUNSET_LAW_TIME,
        locks.SUNSET_LAW_QUERY_WINDOW,
      ).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.match_count = 2;
    red('duplicate_completion_rejected',
      !validateEvidenceExact(bad).ok
      || !lawCompletionOk(
        classBTenant(bad, 'wolfhouse'),
        locks.WH_LAW_TIME,
        locks.WH_LAW_QUERY_WINDOW,
      ).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.sunset.law_completion.match_count = 0;
    red('missing_completion_rejected',
      !validateEvidenceExact(bad).ok
      || !lawCompletionOk(
        classBTenant(bad, 'sunset'),
        locks.SUNSET_LAW_TIME,
        locks.SUNSET_LAW_QUERY_WINDOW,
      ).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.record.pool_close_result = 'timeout';
    bad.observed_facts.B_independently_recoverable_azure_readonly.sunset.law_completion.record.server_close_result = 'error';
    red('non_ok_pool_or_server_rejected',
      !validateEvidenceExact(bad).ok
      || !lawCompletionOk(
        classBTenant(bad, 'wolfhouse'),
        locks.WH_LAW_TIME,
        locks.WH_LAW_QUERY_WINDOW,
      ).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.record.original_signal = 'SIGINT';
    red('wrong_signal_not_sigterm_rejected',
      !validateEvidenceExact(bad).ok
      || !lawCompletionOk(
        classBTenant(bad, 'wolfhouse'),
        locks.WH_LAW_TIME,
        locks.WH_LAW_QUERY_WINDOW,
      ).ok);
  }
  {
    const bad = deepClone(evidence);
    const fakeDsn = ['postgres', 'ql://', 'user:', 'hunter2@', '127.0.0.1:5432/db'].join('');
    const fakeSk = ['sk_', 'live_', 'ABC1234567890'].join('');
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.record.pid = 12345;
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.record.url = 'https://example.invalid/secret';
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.record.secret = fakeSk;
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.record.dsn = fakeDsn;
    const v = validateEvidenceExact(bad);
    const law = lawCompletionOk(
      classBTenant(bad, 'wolfhouse'),
      locks.WH_LAW_TIME,
      locks.WH_LAW_QUERY_WINDOW,
    );
    const sec = secretFree(JSON.stringify(bad), 'tampered');
    red('extra_secret_fields_rejected', (!v.ok || !law.ok) && !sec.ok);
  }
  {
    const bad = deepClone(evidence);
    const a = bad.observed_facts.A_operator_observed_drill_transcript;
    a.covers.push('concurrent_restart_continuity');
    a.explicitly_not_covered = a.explicitly_not_covered.filter((x) => x !== 'concurrent_restart_continuity');
    for (const s of a.wolfhouse.post_restart_observation.samples) {
      s.sample_class = 'concurrent_restart_continuity';
    }
    red('claimed_concurrent_continuity_rejected',
      claimsConcurrentContinuity(bad)
      || !observationOk(classATenant(bad, 'wolfhouse')).ok
      || !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    const aWh = bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse;
    aWh.post_restart_observation.source_type = locks.SOURCE_TYPE_B;
    for (const s of aWh.post_restart_observation.samples) {
      s.source_type = locks.SOURCE_TYPE_B;
      s.source_ref = locks.SOURCE_REF_B;
    }
    red('historical_arrays_azure_derived_rejected',
      samplesHaveAzureDerivedLabel(aWh)
      || !observationOk(aWh).ok
      || !validateProvenanceSplit(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    const aWh = bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse;
    delete aWh.post_restart_observation.source_ref;
    for (const s of aWh.post_restart_observation.samples) {
      delete s.source_ref;
      delete s.source_type;
    }
    red('missing_transcript_attribution_rejected', !observationOk(aWh).ok);
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
    for (const s of aWh.post_restart_observation.samples) {
      s.current_verify_utc = locks.INDEPENDENT_VERIFY_UTC;
      s.source_type = locks.SOURCE_TYPE_B;
    }
    // Also place historical samples under B (fabricated Azure recreation).
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.post_restart_observation = {
      source_type: locks.SOURCE_TYPE_B,
      samples: aWh.post_restart_observation.samples,
    };
    red('fabricated_current_verification_of_historical_samples_rejected',
      samplesClaimFabricatedCurrentVerify(aWh)
      || !validateProvenanceSplit(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse
      .law_completion.cardinality_semantics = 'exactly_one_per_revision_unbounded';
    bad.claims_allowed = bad.claims_allowed
      .filter((c) => c !== 'law_exactly_one_sigterm_completion_each_tenant_in_declared_drill_query_window');
    bad.claims_allowed.push('law_exactly_one_sigterm_completion_each_tenant');
    delete bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse
      .law_completion.query_window;
    red('unbounded_cardinality_rejected',
      !lawCardinalityContractOk(bad).ok
      || !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse
      .law_revision_lifetime_disclosure.revision_lifetime_count_is_one = true;
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse
      .law_revision_lifetime_disclosure.unqualified_exactly_one_per_revision = true;
    bad.explicitly_not_claimed = bad.explicitly_not_claimed
      .filter((x) => x !== 'revision_lifetime_exactly_one_sigterm_completion');
    red('revision_lifetime_exactly_one_rejected',
      !lawCardinalityContractOk(bad).ok
      || !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse
      .law_revision_lifetime_disclosure.known_later_records_at_review = [];
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse
      .law_revision_lifetime_disclosure.known_revision_lifetime_count_at_review = 1;
    red('missing_later_record_disclosure_rejected',
      !lawCardinalityContractOk(bad).ok
      || !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse
      .law_completion.TimeGenerated = '2026-07-21T11:24:48.5525367Z';
    red('drill_record_outside_window_rejected',
      !lawCompletionOk(
        classBTenant(bad, 'wolfhouse'),
        locks.WH_LAW_TIME,
        locks.WH_LAW_QUERY_WINDOW,
      ).ok
      || !lawCardinalityContractOk(bad).ok
      || !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.sunset
      .law_completion.query_window.start_utc = '2026-07-21T11:17:00Z';
    red('overlapping_windows_rejected',
      windowsOverlap(
        bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.query_window,
        bad.observed_facts.B_independently_recoverable_azure_readonly.sunset.law_completion.query_window,
      )
      || !lawCardinalityContractOk(bad).ok
      || !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    const later = bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse
      .law_revision_lifetime_disclosure.known_later_records_at_review[0];
    later.class = '16z_drill_completion';
    later.TimeGenerated = locks.WH_LAW_TIME;
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse
      .law_completion.TimeGenerated = later.TimeGenerated;
    red('later_records_relabelled_as_drill_completions_rejected',
      !lawCardinalityContractOk(bad).ok
      || !validateEvidenceExact(bad).ok);
  }

  const REQUIRED_RED = [
    'wrong_sha_rejected',
    'wrong_wh_digest_rejected',
    'wrong_sunset_digest_rejected',
    'wrong_wh_revision_rejected',
    'wrong_sunset_revision_rejected',
    'wrong_wh_law_timestamp_rejected',
    'wrong_sunset_law_timestamp_rejected',
    'duplicate_completion_rejected',
    'missing_completion_rejected',
    'non_ok_pool_or_server_rejected',
    'wrong_signal_not_sigterm_rejected',
    'extra_secret_fields_rejected',
    'claimed_concurrent_continuity_rejected',
    'historical_arrays_azure_derived_rejected',
    'missing_transcript_attribution_rejected',
    'overclaim_g02_proven_rejected',
    'lock_hash_tamper_rejected',
    'matrix_g02_proven_rejected',
    'doc_overclaim_tokens_rejected',
    'missing_provenance_split_rejected',
    'fabricated_current_verification_of_historical_samples_rejected',
    'unbounded_cardinality_rejected',
    'revision_lifetime_exactly_one_rejected',
    'missing_later_record_disclosure_rejected',
    'drill_record_outside_window_rejected',
    'overlapping_windows_rejected',
    'later_records_relabelled_as_drill_completions_rejected',
  ];
  const REQUIRED_GREEN = [
    'claims_and_disposition_locked',
    'law_completions_exact_both_tenants',
    'post_restart_sample_class_locked',
    'class_b_final_healthy_serving',
    'live_probe_does_not_rewrite_historical_samples',
  ];

  const redMissing = REQUIRED_RED.filter((id) => !redResults.some((r) => r.id === id && r.ok));
  const greenMissing = REQUIRED_GREEN.filter((id) => !greenResults.some((r) => r.id === id && r.ok));
  ok('R1 all required RED ids passed', redMissing.length === 0, redMissing.join(','));
  ok('G1 all required GREEN ids passed', greenMissing.length === 0, greenMissing.join(','));

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  console.log(`RED ${redResults.filter((r) => r.ok).length}/${REQUIRED_RED.length} `
    + `GREEN ${greenResults.filter((r) => r.ok).length}/${REQUIRED_GREEN.length}`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16Z G02 live SIGTERM evidence (partial/live-proven): PASS');
}

module.exports = {
  buildExpectedEvidence,
  computeEvidenceLockHash,
  validateEvidenceExact,
  validateProvenanceSplit,
  observationOk,
  lawCompletionOk,
  lawCardinalityContractOk,
  windowsOverlap,
  runVerifier,
};

if (require.main === module) {
  runVerifier();
}
