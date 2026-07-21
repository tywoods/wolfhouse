'use strict';

/**
 * verify:radar-slice16aa-g02-live-sigint-evidence — RADAR Slice 16AA
 *
 * Offline gate: bounded G02 live SIGINT lifecycle evidence reconciliation
 * with mandatory provenance split:
 *   (A) operator-observed drill transcript contemporaneous facts
 *   (B) later independently recoverable Azure/ACR/LAW read-only facts
 *
 * Rejects wrong SHA/digest/revision/replica/LAW timestamps, duplicate/missing
 * completion, non-ok pool/server, non-SIGINT signal, secret fields,
 * missing exact command provenance, treating exit 137 as application failure,
 * claiming exit 137 proves application/Node native exit status, shell code,
 * signal encoding, or ACA restart reason, claimed concurrent restart continuity,
 * unbounded/revision-lifetime exactly-one LAW cardinality, missing other-record
 * disclosure, drill records outside declared windows, interior-overlapping
 * windows, other records relabelled as drill completions, and G02 proven
 * overclaims. Exit 137 is transport/process-termination disconnect only; LAW
 * (not 137) owns SIGINT + pool/server cleanup evidence.
 * No Azure mutation.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16aa-g02-live-sigint-evidence');

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

function buildAllowlistedRecord(signal) {
  const base = signal === 'SIGTERM' ? locks.SIGTERM_COMPLETION_RECORD : locks.COMPLETION_RECORD;
  return {
    event: base.event,
    original_signal: base.original_signal,
    pool_close_result: base.pool_close_result,
    server_close_result: base.server_close_result,
    failure_classes: [],
    completion: true,
  };
}

function buildLawQueryWindow(kind) {
  const window = kind === 'wolfhouse' ? locks.WH_LAW_QUERY_WINDOW : locks.SUNSET_LAW_QUERY_WINDOW;
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

function buildOtherRecords(kind) {
  const src = kind === 'wolfhouse'
    ? locks.WH_OTHER_LAW_RECORDS_AT_REVIEW
    : locks.SUNSET_OTHER_LAW_RECORDS_AT_REVIEW;
  return src.map((r) => ({
    TimeGenerated: r.TimeGenerated,
    class: r.class,
    revision: r.revision,
    record: buildAllowlistedRecord(r.record.original_signal),
  }));
}

function buildClassATenant(kind) {
  const isWh = kind === 'wolfhouse';
  return {
    app: isWh ? locks.WH_APP : locks.SUNSET_APP,
    revision: isWh ? locks.WH_REVISION : locks.SUNSET_REVISION,
    replica: isWh ? locks.WH_REPLICA : locks.SUNSET_REPLICA,
    operator_sigint_exec: {
      source_type: locks.SOURCE_TYPE_A,
      source_ref: locks.SOURCE_REF_A,
      observed_at_semantics: locks.OBSERVED_AT_SEMANTICS_A,
      method: locks.EXEC_METHOD,
      revision: isWh ? locks.WH_REVISION : locks.SUNSET_REVISION,
      replica: isWh ? locks.WH_REPLICA : locks.SUNSET_REPLICA,
      command: locks.EXEC_COMMAND,
      command_argv: [...locks.EXEC_COMMAND_ARGV],
      disconnect: {
        class: locks.EXEC_DISCONNECT_CLASS,
        exit_code: locks.EXEC_EXIT_CODE,
        semantics: locks.EXEC_DISCONNECT_SEMANTICS,
        treated_as_application_failure: false,
        proves: locks.EXEC_DISCONNECT_PROVES,
        does_not_prove: [...locks.EXEC_DISCONNECT_DOES_NOT_PROVE],
        note: locks.EXEC_DISCONNECT_NOTE,
      },
      note: 'Operator az containerapp exec into exact target replica then kill -INT 1; ClusterExecFailure exit 137 is az containerapp exec transport/process-termination disconnect only (not app/Node native exit, shell code, signal encoding, or ACA restart reason); transcript-derived only, not Azure-reconstructible',
    },
    post_drill_recovery: {
      source_type: locks.SOURCE_TYPE_A,
      source_ref: locks.SOURCE_REF_A,
      observed_at_semantics: locks.OBSERVED_AT_SEMANTICS_A,
      public_readyz: 200,
      semantics: 'post_drill_recovery_not_concurrent_restart_continuity',
      note: 'Post-drill public /readyz=200 only — explicitly not concurrent restart continuity or zero-downtime-during-restart proof; not Azure-reconstructible',
    },
  };
}

function buildClassBTenant(kind) {
  const isWh = kind === 'wolfhouse';
  const tl = isWh ? locks.WH_TIMELINE_B : locks.SUNSET_TIMELINE_B;
  const law = isWh ? locks.WH_LAW : locks.SUNSET_LAW;
  const lawTime = isWh ? locks.WH_LAW_TIME : locks.SUNSET_LAW_TIME;
  const other = buildOtherRecords(kind);
  const lifetimeCount = isWh
    ? locks.WH_REVISION_LIFETIME_COUNT_AT_REVIEW
    : locks.SUNSET_REVISION_LIFETIME_COUNT_AT_REVIEW;
  return {
    app: isWh ? locks.WH_APP : locks.SUNSET_APP,
    resource_group: isWh ? locks.WH_RG : locks.SUNSET_RG,
    public_host: isWh ? locks.WH_PUBLIC_HOST : locks.SUNSET_PUBLIC_HOST,
    image: isWh ? locks.WH_IMAGE : locks.SUNSET_IMAGE,
    digest: isWh ? locks.WH_DIGEST : locks.SUNSET_DIGEST,
    revision: isWh ? locks.WH_REVISION : locks.SUNSET_REVISION,
    revision_suffix: isWh ? locks.WH_REVISION_SUFFIX : locks.SUNSET_REVISION_SUFFIX,
    replica: isWh ? locks.WH_REPLICA : locks.SUNSET_REPLICA,
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
      record: buildAllowlistedRecord('SIGINT'),
    },
    law_revision_lifetime_disclosure: {
      source_type: locks.SOURCE_TYPE_B,
      source_ref: locks.SOURCE_REF_LAW_CARDINALITY,
      observed_at: locks.LAW_CARDINALITY_REVERIFY_UTC,
      unqualified_exactly_one_per_revision: false,
      revision_lifetime_count_is_one: false,
      may_continue_growing_due_to_scaling_restarts: true,
      known_revision_lifetime_count_at_review: lifetimeCount,
      claim_limited_to: 'exactly_one_in_declared_drill_query_window',
      known_other_records_at_review: other,
      note: isWh
        ? 'WH target revision has other valid shutdown completions outside the SIGINT drill window (prior SIGTERM lifecycle events). Revision-lifetime count is not one and may continue growing. 16AA claims exactly one only inside the declared WH drill query window; disclosed count is review-time snapshot only.'
        : 'Sunset target revision has other valid shutdown completions outside the SIGINT drill window (prior SIGTERM). Revision-lifetime exactly-one is still not claimed as a durable invariant (may grow via scaling/restarts). 16AA claims exactly one only inside the declared Sunset drill query window; disclosed count is review-time snapshot only.',
    },
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
        'public_healthz/public_readyz here are independently reverified current values at observed_at — not a recreation of class-A post-drill /readyz observation',
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
    title: 'Reconcile dual-staging live SIGINT lifecycle drill evidence (bounded; no overclaims)',
    image_sha_short: locks.IMAGE_SHA_SHORT,
    image_sha_full: locks.IMAGE_SHA_FULL,
    subscription_id: locks.SUBSCRIPTION_ID,
    independent_azure_verify_utc: locks.INDEPENDENT_VERIFY_UTC,
    law_cardinality_reverify_utc: locks.LAW_CARDINALITY_REVERIFY_UTC,
    provenance_limitations: locks.PROVENANCE_LIMITATIONS,
    non_recoverability: locks.NON_RECOVERABILITY,
    claim_ownership: JSON.parse(JSON.stringify(locks.CLAIM_OWNERSHIP)),
    observed_facts: {
      A_operator_observed_drill_transcript: {
        source_type: locks.SOURCE_TYPE_A,
        source_ref: locks.SOURCE_REF_A,
        observed_at_semantics: locks.OBSERVED_AT_SEMANTICS_A,
        covers: [
          'operator_az_containerapp_exec_kill_int_1',
          'exact_replica_targets',
          'cluster_exec_failure_exit_137_transport_process_termination_disconnect',
          'post_drill_public_readyz_200',
        ],
        explicitly_not_covered: [
          'concurrent_restart_continuity',
          'zero_downtime_during_restart',
          'serving_revision_readyz_503_body_path',
          'exit_137_as_application_failure',
          'exit_137_proves_application_native_exit_status',
          'exit_137_proves_node_process_exit_status',
          'exit_137_proves_shell_exit_code',
          'exit_137_proves_signal_encoding',
          'exit_137_proves_aca_restart_reason',
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
          'current_replicas',
          'revision_create_timelines',
          'law_shutdown_completion_exactly_one_each_in_declared_drill_query_window',
          'law_revision_lifetime_other_records_disclosed',
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
        'dual_staging_sigint_cleanup_telemetry_law_exactly_one_each_in_declared_drill_query_window',
        'allowlisted_completion_sigint_pool_ok_server_ok_empty_failures',
        'law_not_exit_137_owns_sigint_pool_server_cleanup_evidence',
        'post_drill_recovery_readyz_200_both_tenants',
        'exact_sha_95dc363_digests_revisions_replicas_healthy_serving',
        'other_revision_lifetime_records_disclosed_revision_lifetime_not_one',
        'exit_137_az_exec_transport_disconnect_only_not_app_exit_or_aca_reason',
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
          'live_sigint_completion_law_exactly_one_each_tenant_in_declared_drill_query_window',
          'post_drill_recovery_readyz_200',
          'prior_16Z_sigterm_law_retained',
          'prior_16X_traffic_shed_retained',
          'prior_16Y_completion_log_source_retained',
        ],
        still_open: [
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
    errors.push('non_recoverability must deny Azure recreation of historical facts');
  }
  if (!/transport\/process-termination disconnect/i.test(String(ev.provenance_limitations || ''))) {
    errors.push('provenance_limitations must state exit 137 is transport/process-termination disconnect only');
  }
  if (!/Independent LAW allowlisted record/i.test(String(ev.provenance_limitations || ''))) {
    errors.push('provenance_limitations must assign SIGINT cleanup evidence to LAW not 137');
  }
  const co = claimOwnershipOk(ev);
  if (!co.ok) errors.push(`claim_ownership: ${co.detail}`);
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
  }
  return { ok: errors.length === 0, errors };
}

function validateGateMatrix(matrix) {
  const errors = [];
  if (!matrix || typeof matrix !== 'object') {
    return { ok: false, errors: ['matrix missing'] };
  }
  const tip16ab = matrix.slice === 'RADAR-16AB' || matrix.slice === 'RADAR-16AC' || (matrix.slice === 'RADAR-16AD' || (matrix.slice === 'RADAR-16AF' || matrix.slice === 'RADAR-16AG'));
  const tip16ac = matrix.slice === 'RADAR-16AC' || (matrix.slice === 'RADAR-16AD' || (matrix.slice === 'RADAR-16AF' || matrix.slice === 'RADAR-16AG'));
  const tip16ad = (matrix.slice === 'RADAR-16AD' || (matrix.slice === 'RADAR-16AF' || matrix.slice === 'RADAR-16AG'));
  if (matrix.slice !== locks.SLICE && !tip16ab && !tip16ac) {
    errors.push(`slice=${matrix.slice}`);
  }
  if (matrix.branch !== locks.BRANCH && matrix.branch !== 'radar/slice-16ab-g02-readyz503-evidence' && matrix.branch !== 'radar/slice-16ac-organic-restart-alert-evidence' && matrix.branch !== 'radar/slice-16ad-g02-sampled-restart-continuity-evidence') {
    errors.push(`branch=${matrix.branch}`);
  }
  if (matrix.master_basis !== locks.MASTER_BASIS
    && matrix.master_basis !== 'c43b4a14d14d5618d99e0e969b4f39784a526722'
    && matrix.master_basis !== '72d8faf74df27a714482ebdefb8f88870d080306'
    && matrix.master_basis !== '137b14a0b3efc689ba749340a97ab4e9bc220edc') {
    errors.push('master_basis mismatch');
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
    if (!/16AA|SIGINT|LAW/i.test(String(g02.rationale || ''))) {
      errors.push('G02 rationale missing 16AA/SIGINT/LAW facts');
    }
    // Tip 16AB may summarize prior SIGINT without repeating exit-137 ownership text.
    if (!tip16ab && !tip16ac) {
      if (!/transport\/process-termination disconnect/i.test(String(g02.rationale || ''))) {
        errors.push('G02 rationale missing exit137 transport/process-termination disconnect semantics');
      }
      if (!/not 137|Independent LAW allowlisted record/i.test(String(g02.rationale || ''))) {
        errors.push('G02 rationale missing LAW-not-137 SIGINT cleanup ownership');
      }
      if (!/drill.?query.?window|bounded.?drill|query.?window|12:08:00/i.test(String(g02.rationale || ''))) {
        errors.push('G02 rationale missing bounded drill query window cardinality');
      }
      if (!/other|revision.?lifetime|11:16:20|not one/i.test(String(g02.rationale || ''))) {
        errors.push('G02 rationale missing other-record / revision-lifetime disclosure');
      }
    }
    if (!Array.isArray(g02.gaps) || !g02.gaps.some((g) => (
      /serving.?revision.?readyz.?503|readyz.?=?503|zero.?downtime|organic|production/i.test(String(g))
    ))) {
      errors.push('G02 gaps must retain serving readyz=503 or zero_downtime/organic/production open');
    }
    if (g02.gaps && g02.gaps.some((g) => (
      /SIGINT\s+live.*not\s+proven|SIGINT.*live\s+lifecycle.*not\s+proven|SIGINT live open/i.test(String(g))
    ))) {
      errors.push('G02 gaps still claim SIGINT live not proven as if open');
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

function parseUtcMs(utc) {
  const ms = Date.parse(String(utc || '').replace(/\.(\d{3})\d*Z$/, '.$1Z'));
  return Number.isFinite(ms) ? ms : NaN;
}

function timeInInclusiveWindow(timeUtc, window) {
  const t = parseUtcMs(timeUtc);
  const start = parseUtcMs(window && window.start_utc);
  const end = parseUtcMs(window && window.end_utc);
  if (![t, start, end].every(Number.isFinite)) return false;
  return t >= start && t <= end;
}

/** Interiors overlap (endpoint-adjacent windows are allowed). */
function interiorsOverlap(a, b) {
  const a0 = parseUtcMs(a && a.start_utc);
  const a1 = parseUtcMs(a && a.end_utc);
  const b0 = parseUtcMs(b && b.start_utc);
  const b1 = parseUtcMs(b && b.end_utc);
  if (![a0, a1, b0, b1].every(Number.isFinite)) return true;
  return a0 < b1 && b0 < a1;
}

function allowlistedRecordOk(rec, expectedSignal) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
    return { ok: false, detail: 'record missing' };
  }
  const keys = Object.keys(rec).sort();
  const allowed = [...locks.ALLOWED_RECORD_KEYS].sort();
  if (keys.length !== allowed.length || keys.some((k, i) => k !== allowed[i])) {
    return { ok: false, detail: `record keys=${keys.join(',')}` };
  }
  if (rec.event !== locks.COMPLETION_RECORD.event) return { ok: false, detail: 'event' };
  if (rec.original_signal !== expectedSignal) {
    return { ok: false, detail: `signal=${rec.original_signal}` };
  }
  if (rec.pool_close_result !== 'ok') return { ok: false, detail: `pool=${rec.pool_close_result}` };
  if (rec.server_close_result !== 'ok') return { ok: false, detail: `server=${rec.server_close_result}` };
  if (!Array.isArray(rec.failure_classes) || rec.failure_classes.length !== 0) {
    return { ok: false, detail: 'failure_classes' };
  }
  if (rec.completion !== true) return { ok: false, detail: 'completion' };
  return { ok: true };
}

function commandProvenanceOk(tenant, expectedReplica, expectedRevision) {
  const exec = tenant && tenant.operator_sigint_exec;
  if (!exec) return { ok: false, detail: 'missing operator_sigint_exec' };
  if (exec.source_type !== locks.SOURCE_TYPE_A || exec.source_ref !== locks.SOURCE_REF_A) {
    return { ok: false, detail: 'exec source attribution' };
  }
  if (exec.method !== locks.EXEC_METHOD) return { ok: false, detail: `method=${exec.method}` };
  if (exec.command !== locks.EXEC_COMMAND) return { ok: false, detail: `command=${exec.command}` };
  if (!Array.isArray(exec.command_argv)
    || exec.command_argv.length !== locks.EXEC_COMMAND_ARGV.length
    || exec.command_argv.some((v, i) => v !== locks.EXEC_COMMAND_ARGV[i])) {
    return { ok: false, detail: 'command_argv' };
  }
  if (exec.replica !== expectedReplica) return { ok: false, detail: `replica=${exec.replica}` };
  if (exec.revision !== expectedRevision) return { ok: false, detail: `revision=${exec.revision}` };
  if (tenant.replica !== expectedReplica) return { ok: false, detail: 'tenant.replica' };
  if (tenant.revision !== expectedRevision) return { ok: false, detail: 'tenant.revision' };
  const d = exec.disconnect;
  if (!d || d.class !== locks.EXEC_DISCONNECT_CLASS) {
    return { ok: false, detail: 'disconnect class' };
  }
  if (d.exit_code !== locks.EXEC_EXIT_CODE) return { ok: false, detail: `exit_code=${d.exit_code}` };
  if (d.semantics !== locks.EXEC_DISCONNECT_SEMANTICS) {
    return { ok: false, detail: 'disconnect semantics' };
  }
  if (d.proves !== locks.EXEC_DISCONNECT_PROVES) {
    return { ok: false, detail: 'disconnect proves' };
  }
  if (!Array.isArray(d.does_not_prove)
    || d.does_not_prove.length !== locks.EXEC_DISCONNECT_DOES_NOT_PROVE.length
    || locks.EXEC_DISCONNECT_DOES_NOT_PROVE.some((k) => !d.does_not_prove.includes(k))) {
    return { ok: false, detail: 'disconnect does_not_prove incomplete' };
  }
  if (d.treated_as_application_failure !== false) {
    return { ok: false, detail: 'exit 137 treated as application failure' };
  }
  if (d.note !== locks.EXEC_DISCONNECT_NOTE) {
    return { ok: false, detail: 'disconnect note mismatch' };
  }
  if (exit137OverclaimText(d.note) || exit137OverclaimText(exec.note || '')) {
    return { ok: false, detail: 'exit 137 overclaim text in disconnect/exec note' };
  }
  const recovery = tenant.post_drill_recovery;
  if (!recovery || recovery.public_readyz !== 200) {
    return { ok: false, detail: 'post_drill_recovery readyz' };
  }
  if (recovery.semantics !== 'post_drill_recovery_not_concurrent_restart_continuity') {
    return { ok: false, detail: 'recovery semantics' };
  }
  if (recovery.source_type !== locks.SOURCE_TYPE_A) {
    return { ok: false, detail: 'recovery source_type' };
  }
  return { ok: true };
}

function lawCompletionOk(tenant, expectedTime, expectedWindow) {
  const lc = tenant && tenant.law_completion;
  if (!lc) return { ok: false, detail: 'missing law_completion' };
  if (lc.cardinality_semantics !== locks.CARDINALITY_SEMANTICS) {
    return { ok: false, detail: `cardinality_semantics=${lc.cardinality_semantics}` };
  }
  if (lc.match_count !== 1) return { ok: false, detail: `match_count=${lc.match_count}` };
  if (lc.TimeGenerated !== expectedTime) {
    return { ok: false, detail: `TimeGenerated=${lc.TimeGenerated}` };
  }
  const qw = lc.query_window;
  if (!qw || qw.start_utc !== expectedWindow.start_utc || qw.end_utc !== expectedWindow.end_utc) {
    return { ok: false, detail: 'query_window bounds' };
  }
  if (qw.start_inclusive !== true || qw.end_inclusive !== true) {
    return { ok: false, detail: 'query_window inclusivity' };
  }
  if (!timeInInclusiveWindow(lc.TimeGenerated, qw)) {
    return { ok: false, detail: 'drill TimeGenerated outside query_window' };
  }
  return allowlistedRecordOk(lc.record, 'SIGINT');
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
  if (!Array.isArray(d.known_other_records_at_review)) {
    return { ok: false, detail: 'known_other_records_at_review missing' };
  }
  const expected = kind === 'wolfhouse'
    ? locks.WH_OTHER_LAW_RECORDS_AT_REVIEW
    : locks.SUNSET_OTHER_LAW_RECORDS_AT_REVIEW;
  const expectedCount = kind === 'wolfhouse'
    ? locks.WH_REVISION_LIFETIME_COUNT_AT_REVIEW
    : locks.SUNSET_REVISION_LIFETIME_COUNT_AT_REVIEW;
  if (d.known_revision_lifetime_count_at_review !== expectedCount) {
    return { ok: false, detail: 'lifetime count at review' };
  }
  if (d.known_other_records_at_review.length !== expected.length) {
    return { ok: false, detail: 'other records length' };
  }
  const window = kind === 'wolfhouse' ? locks.WH_LAW_QUERY_WINDOW : locks.SUNSET_LAW_QUERY_WINDOW;
  for (let i = 0; i < expected.length; i += 1) {
    const got = d.known_other_records_at_review[i];
    const exp = expected[i];
    if (!got || got.TimeGenerated !== exp.TimeGenerated) {
      return { ok: false, detail: `other TimeGenerated[${i}]` };
    }
    if (got.class !== 'revision_lifetime_record_not_16aa_drill_completion') {
      return { ok: false, detail: `other class[${i}]` };
    }
    if (timeInInclusiveWindow(got.TimeGenerated, window)) {
      return { ok: false, detail: `other record[${i}] inside drill window` };
    }
    const rec = allowlistedRecordOk(got.record, exp.record.original_signal);
    if (!rec.ok) return { ok: false, detail: `other record[${i}] ${rec.detail}` };
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
  if (interiorsOverlap(wh.law_completion.query_window, su.law_completion.query_window)) {
    return { ok: false, detail: 'drill query window interiors overlap' };
  }
  for (const other of wh.law_revision_lifetime_disclosure.known_other_records_at_review) {
    if (other.TimeGenerated === wh.law_completion.TimeGenerated) {
      return { ok: false, detail: 'other record equals drill TimeGenerated' };
    }
    if (/^16aa_drill|^drill_completion|relabelled_as_drill/i.test(String(other.class))) {
      return { ok: false, detail: 'other record relabelled as drill completion' };
    }
  }
  if (ev.claims_allowed.includes('law_exactly_one_sigint_completion_each_tenant')
    && !ev.claims_allowed.includes('law_exactly_one_sigint_completion_each_tenant_in_declared_drill_query_window')) {
    return { ok: false, detail: 'unbounded/unqualified exactly-one claim present' };
  }
  if (!ev.explicitly_not_claimed.includes('revision_lifetime_exactly_one_sigint_completion')
    || !ev.explicitly_not_claimed.includes('unbounded_law_cardinality_exactly_one')
    || !ev.explicitly_not_claimed.includes('exit_137_as_application_failure')
    || !ev.explicitly_not_claimed.includes('exit_137_proves_application_native_exit_status')
    || !ev.explicitly_not_claimed.includes('exit_137_proves_node_process_exit_status')
    || !ev.explicitly_not_claimed.includes('exit_137_proves_shell_exit_code')
    || !ev.explicitly_not_claimed.includes('exit_137_proves_signal_encoding')
    || !ev.explicitly_not_claimed.includes('exit_137_proves_aca_restart_reason')) {
    return { ok: false, detail: 'missing cardinality/exit137 exclusions' };
  }
  return { ok: true };
}

function exit137OverclaimText(text) {
  const s = String(text || '');
  const patterns = [
    /exit\s*137\s+(proves|is\s+proof\s+of|means|equals|encodes)\s+(the\s+)?(application|app|node|native)\s+(exit|status|code)/i,
    /exit\s*137\s+(proves|is\s+proof\s+of).{0,80}(native\s+exit|signal\s+encoding|shell\s+(exit\s+)?code|aca\s+restart\s+reason|node\s+(process\s+)?(exit|status))/i,
    /exit\s*137\s+(is|was|equals|constitutes)\s+(an?\s+)?(application|app)\s+failure\b/i,
    /exit\s*137\s+(proves|is\s+proof\s+of).{0,60}(native\s+signal\s+exit|signal\s+exit\s+semantics)/i,
    /ClusterExecFailure.{0,40}exit\s*137.{0,60}(proves|is\s+proof\s+of).{0,40}(restart\s+reason|native\s+exit|shell\s+code|node\s+status|application\s+exit)/i,
    /treating\s+ClusterExecFailure\s+exit\s*137\s+as\s+application\s+failure\s+is\s+correct/i,
  ];
  return patterns.some((re) => re.test(s));
}

function claimOwnershipOk(ev) {
  const co = ev && ev.claim_ownership;
  if (!co || typeof co !== 'object') return { ok: false, detail: 'missing claim_ownership' };
  const expected = locks.CLAIM_OWNERSHIP;
  const e137 = co.exit_137_cluster_exec_failure;
  const law = co.law_allowlisted_sigint_completion;
  if (!e137 || !law) return { ok: false, detail: 'claim_ownership keys' };
  if (e137.owner_class !== expected.exit_137_cluster_exec_failure.owner_class) {
    return { ok: false, detail: 'exit137 owner_class' };
  }
  if (e137.proves !== expected.exit_137_cluster_exec_failure.proves) {
    return { ok: false, detail: 'exit137 proves' };
  }
  if (e137.semantics !== expected.exit_137_cluster_exec_failure.semantics) {
    return { ok: false, detail: 'exit137 semantics' };
  }
  if (!Array.isArray(e137.does_not_prove)
    || expected.exit_137_cluster_exec_failure.does_not_prove.some((k) => !e137.does_not_prove.includes(k))) {
    return { ok: false, detail: 'exit137 does_not_prove' };
  }
  if (law.owner_class !== expected.law_allowlisted_sigint_completion.owner_class) {
    return { ok: false, detail: 'law owner_class' };
  }
  if (law.does_not_derive_from !== 'exit_137') {
    return { ok: false, detail: 'law must not derive from exit_137' };
  }
  if (!Array.isArray(law.proves)
    || !law.proves.includes('lifecycle_received_original_signal_SIGINT')
    || !law.proves.includes('pool_close_result_ok')
    || !law.proves.includes('server_close_result_ok')) {
    return { ok: false, detail: 'law proves incomplete' };
  }
  if (exit137OverclaimText(e137.limitation) || exit137OverclaimText(law.limitation)) {
    return { ok: false, detail: 'claim_ownership overclaim text' };
  }
  if (!/transport\/process-termination disconnect/i.test(String(e137.limitation || ''))) {
    return { ok: false, detail: 'exit137 limitation missing transport wording' };
  }
  if (!/not\s+137|not ClusterExecFailure exit 137/i.test(String(law.limitation || ''))) {
    return { ok: false, detail: 'law limitation must say not 137' };
  }
  return { ok: true };
}

function exit137ProvenanceOk(ev) {
  const co = claimOwnershipOk(ev);
  if (!co.ok) return co;
  if (!/transport\/process-termination disconnect/i.test(String(ev.provenance_limitations || ''))) {
    return { ok: false, detail: 'provenance_limitations missing transport wording' };
  }
  if (!/not proof of the application or Node process exact native exit status/i.test(
    String(ev.provenance_limitations || ''),
  )) {
    return { ok: false, detail: 'provenance_limitations missing native-exit exclusion' };
  }
  if (!/Independent LAW allowlisted record/i.test(String(ev.provenance_limitations || ''))) {
    return { ok: false, detail: 'provenance_limitations missing LAW ownership' };
  }
  for (const kind of ['wolfhouse', 'sunset']) {
    const cmd = commandProvenanceOk(
      classATenant(ev, kind),
      kind === 'wolfhouse' ? locks.WH_REPLICA : locks.SUNSET_REPLICA,
      kind === 'wolfhouse' ? locks.WH_REVISION : locks.SUNSET_REVISION,
    );
    if (!cmd.ok) return { ok: false, detail: `${kind} ${cmd.detail}` };
  }
  if (!ev.claims_allowed.includes('exit_137_az_exec_transport_disconnect_only_not_app_exit_or_aca_reason')
    || !ev.claims_allowed.includes('law_not_exit_137_owns_sigint_pool_server_cleanup_evidence')) {
    return { ok: false, detail: 'missing exit137/LAW claim ownership tokens' };
  }
  if (ev.claims_allowed.includes('exit_137_proves_aca_restart_reason')
    || ev.claims_allowed.includes('exit_137_proves_application_native_exit_status')
    || ev.disposition.proves.includes('exit_137_proves_node_process_exit_status')) {
    return { ok: false, detail: 'forbidden exit137 prove claims present' };
  }
  return { ok: true };
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
    const recovery = a[kind] && a[kind].post_drill_recovery;
    if (!recovery || recovery.semantics !== 'post_drill_recovery_not_concurrent_restart_continuity') {
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
    /\bzero\s+downtime\s+during\s+restart\b.*\bproven\b/i,
    /\bconcurrent\s+restart\s+continuity\b.*\bproven\b/i,
    /\breadyz\s*=?\s*503\b.*\bproven\b/i,
  ];
  for (const re of forbidden) {
    if (re.test(text)) hits.push(String(re));
  }
  return hits;
}

function runVerifier() {
  console.log('RADAR 16AA G02 live SIGINT evidence — offline verifier\n');

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

  ok('C3 HEAD on 16AA branch (tip may advance to 16AB/16AC/16AD)',
    currentBranch() === locks.BRANCH
    || currentBranch() === 'radar/slice-16ab-g02-readyz503-evidence'
    || currentBranch() === 'radar/slice-16ac-organic-restart-alert-evidence'
    || currentBranch() === 'radar/slice-16ad-g02-sampled-restart-continuity-evidence'
    || currentBranch() === 'radar/slice-16af-g06-capacity-alert-live-evidence' || currentBranch() === 'radar/slice-16ag-g06-bounded-load-harness',
    currentBranch());

  {
    const v = validateEvidenceExact(evidence);
    ok('C4 evidence exact recursive schema + lock_hash', v.ok, v.errors.slice(0, 12).join(' | '));
  }

  ok('C5 explicitly_not_claimed complete',
    Array.isArray(evidence.explicitly_not_claimed)
    && locks.EXPLICITLY_NOT_CLAIMED.every((k) => evidence.explicitly_not_claimed.includes(k))
    && evidence.explicitly_not_claimed.length === locks.EXPLICITLY_NOT_CLAIMED.length);

  ok('C6 disposition keeps G02 partial; SIGINT closed',
    evidence.disposition
    && evidence.disposition.g02_verdict === 'partial'
    && evidence.disposition.g02_progress_class === 'partial_live_proven'
    && evidence.gate_progress_updates.G02_readiness_dependencies.verdict === 'partial'
    && !evidence.gate_progress_updates.G02_readiness_dependencies.still_open.some(
      (x) => /sigint/i.test(String(x)),
    )
    && evidence.gate_progress_updates.G02_readiness_dependencies.still_open.includes(
      'serving_revision_readyz_503_body_path',
    ));

  {
    const whCmd = commandProvenanceOk(classATenant(evidence, 'wolfhouse'), locks.WH_REPLICA, locks.WH_REVISION);
    const suCmd = commandProvenanceOk(classATenant(evidence, 'sunset'), locks.SUNSET_REPLICA, locks.SUNSET_REVISION);
    ok('C7 exact command provenance + replicas + exit137 transport-only',
      whCmd.ok && suCmd.ok, `${whCmd.detail || ''} | ${suCmd.detail || ''}`);
  }

  {
    const e137 = exit137ProvenanceOk(evidence);
    ok('C7b exit137 claim ownership + LAW-not-137 SIGINT cleanup ownership', e137.ok, e137.detail);
  }

  {
    const lc = lawCardinalityContractOk(evidence);
    ok('C8 LAW cardinality + disclosure locked', lc.ok, lc.detail);
  }

  ok('C9 no concurrent continuity claim', !claimsConcurrentContinuity(evidence));

  {
    const mv = validateGateMatrix(matrix);
    ok('C10 matrix validation (counts + G02 partial_live_proven)', mv.ok, mv.errors.join(' | '));
  }

  ok('C11 top contract selected_16aa + G02 SIGINT live_proven_via_16AA (tip may be 16AB/16AC)',
    (topContract.slice === locks.SLICE || topContract.slice === 'RADAR-16AB' || topContract.slice === 'RADAR-16AC' || (topContract.slice === 'RADAR-16AD' || (topContract.slice === 'RADAR-16AF' || topContract.slice === 'RADAR-16AG')))
    && topContract.selected_16aa
    && topContract.selected_16aa.outcome_id === locks.OUTCOME_ID
    && topContract.selected_16aa.g02_sigint_live === 'live_proven_via_16AA'
    && topContract.selected_16aa.g02_verdict === 'partial'
    && topContract.selected_16z
    && topContract.selected_16z.g02_sigterm_live === 'live_proven_via_16Z'
    && topContract.selected_16z.g02_sigint_live === 'live_proven_via_16AA');

  ok('C12 doc mentions 16AA + SIGINT/LAW drill windows without G02 proven overclaim',
    /16AA|g02.?live.?sigint/i.test(doc)
    && /SIGINT/i.test(doc)
    && /LAW|completion/i.test(doc)
    && /partial/i.test(doc)
    && /transcript|provenance|class A|operator-observed|az containerapp exec/i.test(doc)
    && /independently|class B|Azure read-only|LAW/i.test(doc)
    && /12:08:00|drill.?query.?window|bounded/i.test(doc)
    && /other|revision.?lifetime|11:16:20/i.test(doc)
    && /exit\s*137|ClusterExecFailure/i.test(doc)
    && /transport\/process-termination disconnect/i.test(doc)
    && /not proof of.{0,80}(native exit|Node process|shell code|signal encoding|ACA restart reason)/i.test(doc)
    && /Independent LAW allowlisted record|LAW allowlisted record.{0,40}not 137/i.test(doc)
    && !/\bG02\s+proven\b/i.test(doc)
    && !exit137OverclaimText(doc));

  ok('C13 findings mention 16AA without proven overclaim',
    /16AA/.test(findings)
    && /SIGINT|sigint/i.test(findings)
    && /partial/i.test(findings)
    && /12:08:00|drill.?query.?window|cardinality/i.test(findings)
    && /transport\/process-termination disconnect|transport.?disconnect/i.test(findings)
    && !/\bG02\s+proven\b/i.test(findings)
    && !exit137OverclaimText(findings));

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
      && pkg.scripts['verify:radar-slice16aa-g02-live-sigint-evidence']
        === 'node scripts/verify-radar-slice16aa-g02-live-sigint-evidence.js');
  }

  {
    const pv = validateProvenanceSplit(evidence);
    ok('C17 provenance split A/B + limitations + non-recoverability', pv.ok, pv.errors.join(' | '));
  }

  green('claims_and_disposition_locked',
    locks.CLAIMS_ALLOWED.every((c) => evidence.claims_allowed.includes(c))
    && evidence.disposition.proves.length >= 5
    && evidence.disposition.does_not_prove.includes('production')
    && evidence.disposition.does_not_prove.includes('full_G02_proven')
    && evidence.disposition.does_not_prove.includes('concurrent_restart_continuity')
    && evidence.disposition.does_not_prove.includes('exit_137_as_application_failure')
    && evidence.disposition.does_not_prove.includes('exit_137_proves_application_native_exit_status')
    && evidence.disposition.does_not_prove.includes('exit_137_proves_node_process_exit_status')
    && evidence.disposition.does_not_prove.includes('exit_137_proves_shell_exit_code')
    && evidence.disposition.does_not_prove.includes('exit_137_proves_signal_encoding')
    && evidence.disposition.does_not_prove.includes('exit_137_proves_aca_restart_reason')
    && evidence.disposition.proves.includes('law_not_exit_137_owns_sigint_pool_server_cleanup_evidence')
    && evidence.disposition.proves.includes('exit_137_az_exec_transport_disconnect_only_not_app_exit_or_aca_reason'));

  green('law_completions_exact_both_tenants',
    lawCardinalityContractOk(evidence).ok
    && lawCompletionOk(classBTenant(evidence, 'wolfhouse'), locks.WH_LAW_TIME, locks.WH_LAW_QUERY_WINDOW).ok
    && lawCompletionOk(classBTenant(evidence, 'sunset'), locks.SUNSET_LAW_TIME, locks.SUNSET_LAW_QUERY_WINDOW).ok);

  green('command_provenance_and_replicas_locked',
    commandProvenanceOk(classATenant(evidence, 'wolfhouse'), locks.WH_REPLICA, locks.WH_REVISION).ok
    && commandProvenanceOk(classATenant(evidence, 'sunset'), locks.SUNSET_REPLICA, locks.SUNSET_REVISION).ok
    && classBTenant(evidence, 'wolfhouse').replica === locks.WH_REPLICA
    && classBTenant(evidence, 'sunset').replica === locks.SUNSET_REPLICA);

  green('class_b_final_healthy_serving',
    classBTenant(evidence, 'wolfhouse').final_state.health_state === 'Healthy'
    && classBTenant(evidence, 'sunset').final_state.health_state === 'Healthy'
    && classBTenant(evidence, 'wolfhouse').final_state.traffic_latest_percent === 100
    && classBTenant(evidence, 'sunset').final_state.traffic_latest_percent === 100
    && classBTenant(evidence, 'wolfhouse').final_state.observed_at === locks.INDEPENDENT_VERIFY_UTC
    && classBTenant(evidence, 'sunset').final_state.probes.length === 3);

  green('live_probe_does_not_rewrite_historical_a', (() => {
    const after = locks.mergeLiveProbeWithoutRewritingHistorical(evidence, {
      attempted_at_utc: '2026-07-21T99:00:00Z',
      result: 'timeout',
    });
    const rewritten = locks.historicalSamplesRewrittenByLiveProbe(evidence, after);
    const still200 = classATenant(after, 'wolfhouse').post_drill_recovery.public_readyz === 200
      && classATenant(after, 'sunset').post_drill_recovery.public_readyz === 200;
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
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.revision_suffix = '0000518';
    red('wrong_wh_revision_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.replica =
      'wh-staging-staff-api--0000519-deadbeef-dead';
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.operator_sigint_exec.replica =
      'wh-staging-staff-api--0000519-deadbeef-dead';
    red('wrong_replica_rejected',
      !validateEvidenceExact(bad).ok
      || !commandProvenanceOk(classATenant(bad, 'wolfhouse'), locks.WH_REPLICA, locks.WH_REVISION).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.TimeGenerated =
      '2026-07-21T12:08:00.0000000Z';
    red('wrong_law_time_rejected',
      !validateEvidenceExact(bad).ok
      || !lawCompletionOk(classBTenant(bad, 'wolfhouse'), locks.WH_LAW_TIME, locks.WH_LAW_QUERY_WINDOW).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.record.original_signal = 'SIGTERM';
    red('non_sigint_signal_rejected',
      !allowlistedRecordOk(
        bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.record,
        'SIGINT',
      ).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.record.pool_close_result = 'error';
    red('non_ok_pool_rejected',
      !allowlistedRecordOk(
        bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.record,
        'SIGINT',
      ).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.match_count = 2;
    red('unbounded_cardinality_rejected',
      !lawCardinalityContractOk(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    delete bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.operator_sigint_exec.command;
    red('missing_command_provenance_rejected',
      !validateEvidenceExact(bad).ok
      || !commandProvenanceOk(classATenant(bad, 'wolfhouse'), locks.WH_REPLICA, locks.WH_REVISION).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.operator_sigint_exec.disconnect
      .treated_as_application_failure = true;
    red('exit137_as_app_failure_rejected',
      !validateEvidenceExact(bad).ok
      || !commandProvenanceOk(classATenant(bad, 'wolfhouse'), locks.WH_REPLICA, locks.WH_REVISION).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.operator_sigint_exec.disconnect
      .note = 'ClusterExecFailure exit 137 proves application exit code/status 137';
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.operator_sigint_exec.disconnect
      .proves = 'application_native_exit_status';
    red('exit137_proves_app_exit_status_rejected',
      !validateEvidenceExact(bad).ok
      || !commandProvenanceOk(classATenant(bad, 'wolfhouse'), locks.WH_REPLICA, locks.WH_REVISION).ok
      || exit137OverclaimText(
        bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.operator_sigint_exec.disconnect.note,
      )
      || !exit137ProvenanceOk(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.operator_sigint_exec.disconnect
      .note = 'ClusterExecFailure exit 137 proves the application shell exit code was exactly 137';
    bad.claim_ownership.exit_137_cluster_exec_failure.proves = 'application_shell_exit_code_137';
    red('exit137_proves_shell_exit_code_rejected',
      !validateEvidenceExact(bad).ok
      || exit137OverclaimText(
        bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.operator_sigint_exec.disconnect.note,
      )
      || !claimOwnershipOk(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.operator_sigint_exec.disconnect
      .note = 'exit 137 proves native signal exit semantics for SIGINT';
    bad.claim_ownership.exit_137_cluster_exec_failure.does_not_prove =
      bad.claim_ownership.exit_137_cluster_exec_failure.does_not_prove
        .filter((x) => x !== 'signal_encoding');
    red('exit137_proves_native_signal_exit_rejected',
      !validateEvidenceExact(bad).ok
      || exit137OverclaimText(
        bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.operator_sigint_exec.disconnect.note,
      )
      || !claimOwnershipOk(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.operator_sigint_exec.disconnect
      .note = 'exit 137 proves Node process exit status';
    bad.disposition.proves.push('exit_137_proves_node_process_exit_status');
    bad.explicitly_not_claimed = bad.explicitly_not_claimed
      .filter((x) => x !== 'exit_137_proves_node_process_exit_status');
    red('exit137_proves_node_status_rejected',
      !validateEvidenceExact(bad).ok
      || exit137OverclaimText(
        bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.operator_sigint_exec.disconnect.note,
      )
      || !exit137ProvenanceOk(bad).ok
      || !lawCardinalityContractOk(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.operator_sigint_exec.disconnect
      .note = 'ClusterExecFailure exit 137 proves ACA restart reason';
    bad.claims_allowed = [...bad.claims_allowed, 'exit_137_proves_aca_restart_reason'];
    bad.claim_ownership.exit_137_cluster_exec_failure.proves = 'aca_restart_reason';
    red('exit137_proves_aca_restart_reason_rejected',
      !validateEvidenceExact(bad).ok
      || exit137OverclaimText(
        bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.operator_sigint_exec.disconnect.note,
      )
      || !exit137ProvenanceOk(bad).ok
      || !claimOwnershipOk(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.covers.push('concurrent_restart_continuity');
    bad.observed_facts.A_operator_observed_drill_transcript.explicitly_not_covered =
      bad.observed_facts.A_operator_observed_drill_transcript.explicitly_not_covered
        .filter((x) => x !== 'concurrent_restart_continuity');
    red('concurrent_continuity_claim_rejected',
      claimsConcurrentContinuity(bad) && !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    const fakeSk = ['sk_', 'live_', 'ABCDEFG1234567890'].join('');
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.law_completion.record.api_key = fakeSk;
    const sec = secretFree(JSON.stringify(bad), 'tampered');
    red('secret_fields_rejected', !validateEvidenceExact(bad).ok || !sec.ok);
  }
  {
    const bad = deepClone(evidence);
    bad.gate_progress_updates.G02_readiness_dependencies.verdict = 'proven';
    bad.gate_progress_updates.G02_readiness_dependencies.still_open = [];
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'full_G02_proven');
    bad.disposition.g02_verdict = 'proven';
    bad.disposition.does_not_prove = bad.disposition.does_not_prove.filter((x) => x !== 'full_G02_proven');
    red('overclaim_g02_proven_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const badDoc = `${doc}\n\nG02 proven end-to-end including production.\n`;
    const hits = fieldLevelOverclaim(badDoc);
    red('doc_overclaim_tokens_rejected', hits.length > 0, hits.join(','));
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse
      .law_revision_lifetime_disclosure.unqualified_exactly_one_per_revision = true;
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse
      .law_revision_lifetime_disclosure.revision_lifetime_count_is_one = true;
    red('lifetime_cardinality_claim_rejected', !lawCardinalityContractOk(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse
      .law_revision_lifetime_disclosure.known_other_records_at_review = [];
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse
      .law_revision_lifetime_disclosure.known_revision_lifetime_count_at_review = 1;
    red('missing_other_disclosure_rejected', !lawDisclosureOk(classBTenant(bad, 'wolfhouse'), 'wolfhouse').ok);
  }

  const requiredReds = [
    'wrong_sha_rejected',
    'wrong_wh_digest_rejected',
    'wrong_wh_revision_rejected',
    'wrong_replica_rejected',
    'wrong_law_time_rejected',
    'non_sigint_signal_rejected',
    'non_ok_pool_rejected',
    'unbounded_cardinality_rejected',
    'missing_command_provenance_rejected',
    'exit137_as_app_failure_rejected',
    'exit137_proves_app_exit_status_rejected',
    'exit137_proves_shell_exit_code_rejected',
    'exit137_proves_native_signal_exit_rejected',
    'exit137_proves_node_status_rejected',
    'exit137_proves_aca_restart_reason_rejected',
    'concurrent_continuity_claim_rejected',
    'secret_fields_rejected',
    'overclaim_g02_proven_rejected',
    'doc_overclaim_tokens_rejected',
    'lifetime_cardinality_claim_rejected',
    'missing_other_disclosure_rejected',
  ];
  for (const id of requiredReds) {
    const row = redResults.find((r) => r.id === id);
    ok(`RED-REQUIRED ${id}`, row && row.ok);
  }

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16AA G02 live SIGINT evidence (partial/live-proven): PASS');
}

runVerifier();
