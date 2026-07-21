'use strict';

/**
 * verify:radar-slice16ab-g02-readyz503-evidence — RADAR Slice 16AB
 *
 * Offline gate: bounded G02 serving-revision /readyz=503 body-path evidence
 * reconciliation with mandatory provenance split:
 *   (A) operator-observed drill transcript contemporaneous facts
 *   (B) later independently recoverable Azure/ACR/public read-only facts
 *
 * Rejects invented transcript timestamps, Azure-derived historical localhost 503,
 * wrong status/body/revision/replica, non-isolated traffic claims, fail still
 * active, wrong restore/scale, DSN/secret values, concurrent continuity /
 * zero-downtime / production / full G02 overclaims, lock_hash mismatch, and
 * live-probe rewrites of class-A historical facts. No Azure mutation.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const locks = require('./lib/radar-slice16ab-g02-readyz503-evidence');

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

function classAAttribution() {
  return {
    source_type: locks.SOURCE_TYPE_A,
    source_ref: locks.SOURCE_REF_A,
    observed_at: locks.OBSERVED_AT_UNAVAILABLE,
    observed_at_semantics: locks.OBSERVED_AT_SEMANTICS_A,
  };
}

function classBAttribution() {
  return {
    source_type: locks.SOURCE_TYPE_B,
    source_ref: locks.SOURCE_REF_B,
    observed_at: locks.INDEPENDENT_VERIFY_UTC,
  };
}

function buildTrafficIsolation(kind) {
  const isWh = kind === 'wolfhouse';
  return {
    ...classAAttribution(),
    active_revisions_mode_temporary: 'Multiple',
    public_traffic_pin_percent: 100,
    public_traffic_pin_target: 'known_healthy_revision',
    fail_revision_public_traffic_percent: 0,
    fail_scale_min: isWh ? locks.WH_FAIL_MIN : locks.SUNSET_FAIL_MIN,
    fail_scale_max: isWh ? locks.WH_FAIL_MAX : locks.SUNSET_FAIL_MAX,
    semantics: locks.TRAFFIC_ISOLATION_SEMANTICS,
    note: 'Temporary Multiple mode with 100% public traffic pinned to known healthy revision; fail revision isolated at min=1/max=1 with zero public traffic; transcript-only; observed_at unavailable_in_command_transcript',
  };
}

function buildFailRevisionSetup(kind) {
  const isWh = kind === 'wolfhouse';
  return {
    ...classAAttribution(),
    image_sha_full: locks.IMAGE_SHA_FULL,
    image: isWh ? locks.WH_IMAGE : locks.SUNSET_IMAGE,
    database_url_class: locks.DUMMY_DSN_CLASS,
    database_url_value_recorded: locks.DUMMY_DSN_VALUE_RECORDED,
    note: locks.DUMMY_DSN_NOTE,
  };
}

function buildLocalReadyz503(kind) {
  const isWh = kind === 'wolfhouse';
  return {
    ...classAAttribution(),
    method: locks.EXEC_METHOD,
    probe_semantics: locks.EXEC_PROBE_SEMANTICS,
    revision: isWh ? locks.WH_FAIL_REVISION : locks.SUNSET_FAIL_REVISION,
    replica: isWh ? locks.WH_FAIL_REPLICA : locks.SUNSET_FAIL_REPLICA,
    url: locks.LOCAL_READYZ_URL,
    http_method: locks.LOCAL_READYZ_METHOD,
    status: locks.LOCAL_READYZ_STATUS,
    body: { status: locks.LOCAL_READYZ_BODY.status },
    note: 'az containerapp exec into exact fail replica; local Node HTTP GET http://127.0.0.1:3036/readyz returned exact status 503 and body {status:not-ready}; transcript-only; not Azure-reconstructible; observed_at unavailable_in_command_transcript',
  };
}

function buildPublicHealthyReadyzDuringDrill() {
  return {
    ...classAAttribution(),
    public_readyz: 200,
    semantics: 'public_healthy_revision_readyz_stayed_200_not_concurrent_sampled_continuity',
    note: 'Public healthy revision /readyz stayed 200 while fail was isolated; explicitly not concurrent sampled continuity or zero-downtime-during-restart proof; transcript-only',
  };
}

function buildCleanup() {
  return {
    ...classAAttribution(),
    steps: [
      'exited_exec',
      'deactivated_fail_revision',
      'created_healthy_restore_from_original_exact_revision_image',
      'restored_single_mode',
      'restored_100_percent_traffic_to_restore',
    ],
    note: 'Cleanup sequence transcript-only; final Azure state independently verified as class B',
  };
}

function buildClassATenant(kind) {
  const isWh = kind === 'wolfhouse';
  return {
    app: isWh ? locks.WH_APP : locks.SUNSET_APP,
    fail_revision: isWh ? locks.WH_FAIL_REVISION : locks.SUNSET_FAIL_REVISION,
    fail_replica: isWh ? locks.WH_FAIL_REPLICA : locks.SUNSET_FAIL_REPLICA,
    traffic_isolation: buildTrafficIsolation(kind),
    fail_revision_setup: buildFailRevisionSetup(kind),
    local_readyz_503: buildLocalReadyz503(kind),
    public_healthy_readyz_during_drill: buildPublicHealthyReadyzDuringDrill(),
    cleanup: buildCleanup(),
  };
}

function buildFailRevisionFinal(kind) {
  const isWh = kind === 'wolfhouse';
  return {
    ...classBAttribution(),
    revision: isWh ? locks.WH_FAIL_REVISION : locks.SUNSET_FAIL_REVISION,
    active: false,
    running_state: 'Stopped',
    replicas: 0,
    traffic_weight: 0,
    scale_min: isWh ? locks.WH_FAIL_MIN : locks.SUNSET_FAIL_MIN,
    scale_max: isWh ? locks.WH_FAIL_MAX : locks.SUNSET_FAIL_MAX,
    image: isWh ? locks.WH_IMAGE : locks.SUNSET_IMAGE,
    created_time: isWh ? locks.WH_FAIL_CREATED_UTC : locks.SUNSET_FAIL_CREATED_UTC,
    last_active_time: isWh ? locks.WH_FAIL_LAST_ACTIVE_UTC : locks.SUNSET_FAIL_LAST_ACTIVE_UTC,
    replica_list_at_review: [],
    replica_recoverability: 'fail_replica_names_not_recoverable_from_azure_when_stopped_transcript_only',
    database_url_class_present: locks.DUMMY_DSN_CLASS,
    database_url_value_recorded: false,
    note: 'Fail revision inactive/stopped/replicas=0/traffic=0; replica names empty in Azure; DSN value not recorded',
  };
}

function buildRestoreRevisionFinal(kind) {
  const isWh = kind === 'wolfhouse';
  const restoreRev = isWh ? locks.WH_RESTORE_REVISION : locks.SUNSET_RESTORE_REVISION;
  return {
    ...classBAttribution(),
    revision: restoreRev,
    replica: isWh ? locks.WH_RESTORE_REPLICA : locks.SUNSET_RESTORE_REPLICA,
    active: true,
    health_state: 'Healthy',
    running_state: 'RunningAtMaxScale',
    latest_revision: restoreRev,
    latest_ready_revision: restoreRev,
    traffic_weight: 100,
    scale_min: isWh ? locks.WH_RESTORE_MIN : locks.SUNSET_RESTORE_MIN,
    scale_max: isWh ? locks.WH_RESTORE_MAX : locks.SUNSET_RESTORE_MAX,
    image: isWh ? locks.WH_IMAGE : locks.SUNSET_IMAGE,
    created_time: isWh ? locks.WH_RESTORE_CREATED_UTC : locks.SUNSET_RESTORE_CREATED_UTC,
    database_url_binding: 'secretRef_only_value_not_recorded',
    note: 'Healthy restore revision exact SHA; latestReady; 100% traffic; scale locked',
  };
}

function buildAppFinal() {
  return {
    ...classBAttribution(),
    active_revisions_mode: locks.ACTIVE_REVISIONS_MODE_FINAL,
    traffic_latest_percent: 100,
    public_healthz: 200,
    public_readyz: 200,
    public_current_note:
      'public_healthz/public_readyz here are independently reverified current values at observed_at — not a recreation of class-A historical localhost 503 or during-drill public samples',
    probes: locks.PROBE_SUMMARY.map((p) => ({ ...p })),
  };
}

function buildClassBTenant(kind) {
  const isWh = kind === 'wolfhouse';
  return {
    app: isWh ? locks.WH_APP : locks.SUNSET_APP,
    resource_group: isWh ? locks.WH_RG : locks.SUNSET_RG,
    public_host: isWh ? locks.WH_PUBLIC_HOST : locks.SUNSET_PUBLIC_HOST,
    image: isWh ? locks.WH_IMAGE : locks.SUNSET_IMAGE,
    digest: isWh ? locks.WH_DIGEST : locks.SUNSET_DIGEST,
    source_type: locks.SOURCE_TYPE_B,
    source_ref: locks.SOURCE_REF_B,
    observed_at: locks.INDEPENDENT_VERIFY_UTC,
    observed_at_semantics: locks.OBSERVED_AT_SEMANTICS_B,
    fail_revision_final: buildFailRevisionFinal(kind),
    restore_revision_final: buildRestoreRevisionFinal(kind),
    app_final: buildAppFinal(),
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
    title: 'Reconcile dual-staging serving-revision /readyz=503 body-path drill evidence (bounded; no overclaims)',
    image_sha_short: locks.IMAGE_SHA_SHORT,
    image_sha_full: locks.IMAGE_SHA_FULL,
    subscription_id: locks.SUBSCRIPTION_ID,
    independent_azure_verify_utc: locks.INDEPENDENT_VERIFY_UTC,
    provenance_limitations: locks.PROVENANCE_LIMITATIONS,
    non_recoverability: locks.NON_RECOVERABILITY,
    claim_ownership: JSON.parse(JSON.stringify(locks.CLAIM_OWNERSHIP)),
    observed_facts: {
      A_operator_observed_drill_transcript: {
        source_type: locks.SOURCE_TYPE_A,
        source_ref: locks.SOURCE_REF_A,
        observed_at: locks.OBSERVED_AT_UNAVAILABLE,
        observed_at_semantics: locks.OBSERVED_AT_SEMANTICS_A,
        covers: [
          'temporary_multiple_mode_switch',
          'public_traffic_pin_100_percent_known_healthy_revision',
          'isolated_fail_revision_min1_max1_exact_image_dummy_dsn_literal',
          'az_exec_local_readyz_503_not_ready_body',
          'public_healthy_readyz_stayed_200',
          'cleanup_deactivate_fail_restore_single_100',
        ],
        explicitly_not_covered: [
          'concurrent_sampled_continuity',
          'zero_downtime_during_restart',
          'fail_revision_received_public_traffic',
          'organic_metric_alert_firing',
          'production',
          'full_G02_proven',
          'invented_transcript_timestamp',
          'dsn_or_secret_value_disclosure',
          'azure_derived_historical_localhost_503',
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
          'fail_revision_inactive_stopped_replicas_0',
          'restore_revision_healthy_latestReady_100',
          'active_revisions_mode_single',
          'scale_min_max_restore_and_fail_metadata',
          'probes',
          'public_current_healthz_readyz',
        ],
        explicitly_cannot_recreate: [
          'historical_localhost_503_body',
          'historical_traffic_pin_sequence',
          'fail_replica_names_when_stopped',
          'missing_transcript_timestamp',
        ],
        wolfhouse: buildClassBTenant('wolfhouse'),
        sunset: buildClassBTenant('sunset'),
      },
    },
    claims_allowed: [...locks.CLAIMS_ALLOWED],
    explicitly_not_claimed: [...locks.EXPLICITLY_NOT_CLAIMED],
    disposition: {
      proves: [
        'serving_failed_revision_emits_bounded_generic_503_body_both_staging_tenants',
        'exact_local_readyz_status_503_body_status_not_ready',
        'public_healthy_revision_remained_selected_fail_isolated',
        'exact_sha_95dc363_digests_restore_healthy_fail_inactive',
        'observed_at_unavailable_in_command_transcript_disclosed_not_invented',
        'prior_16AA_sigint_16Z_sigterm_16X_traffic_shed_16Y_source_retained',
      ],
      does_not_prove: [
        'concurrent_sampled_continuity',
        'zero_downtime_during_restart',
        'organic_metric_alert_firing',
        'human_inbox_receipt',
        'production',
        'full_G02_proven',
        'any_gate_verdict_proven',
        'fail_revision_received_public_traffic',
        'azure_derived_historical_localhost_503',
        'invented_transcript_timestamp',
      ],
      g02_verdict: 'partial',
      g02_progress_class: 'partial_live_proven',
    },
    gate_progress_updates: {
      G02_readiness_dependencies: {
        progress_class: 'partial_live_proven',
        verdict: 'partial',
        live_proven: [
          'serving_revision_readyz_503_body_path_via_16AB',
          'prior_16AA_sigint_law_and_post_drill_recovery',
          'prior_16Z_sigterm_law_retained',
          'prior_16X_traffic_shed_retained',
          'prior_16Y_completion_log_source_retained',
          'exact_sha_95dc363_restore_healthy_both_tenants',
        ],
        still_open: [
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

function localReadyzOk(tenant, failRevision, failReplica) {
  const lr = tenant && tenant.local_readyz_503;
  if (!lr) return { ok: false, detail: 'missing local_readyz_503' };
  if (lr.source_type !== locks.SOURCE_TYPE_A || lr.source_ref !== locks.SOURCE_REF_A) {
    return { ok: false, detail: 'local_readyz source attribution' };
  }
  if (lr.method !== locks.EXEC_METHOD) return { ok: false, detail: `method=${lr.method}` };
  if (lr.url !== locks.LOCAL_READYZ_URL) return { ok: false, detail: `url=${lr.url}` };
  if (lr.http_method !== locks.LOCAL_READYZ_METHOD) return { ok: false, detail: `http_method=${lr.http_method}` };
  if (lr.status !== locks.LOCAL_READYZ_STATUS) return { ok: false, detail: `status=${lr.status}` };
  if (!lr.body || lr.body.status !== locks.LOCAL_READYZ_BODY.status) {
    return { ok: false, detail: 'body.status' };
  }
  if (Object.keys(lr.body).length !== 1) return { ok: false, detail: 'body extra fields' };
  if (lr.revision !== failRevision) return { ok: false, detail: `revision=${lr.revision}` };
  if (lr.replica !== failReplica) return { ok: false, detail: `replica=${lr.replica}` };
  if (lr.observed_at !== locks.OBSERVED_AT_UNAVAILABLE) {
    return { ok: false, detail: `observed_at=${lr.observed_at}` };
  }
  if (lr.probe_semantics !== locks.EXEC_PROBE_SEMANTICS) {
    return { ok: false, detail: 'probe_semantics' };
  }
  return { ok: true };
}

function trafficIsolationOk(tenant, failMin, failMax) {
  const ti = tenant && tenant.traffic_isolation;
  if (!ti) return { ok: false, detail: 'missing traffic_isolation' };
  if (ti.source_type !== locks.SOURCE_TYPE_A || ti.source_ref !== locks.SOURCE_REF_A) {
    return { ok: false, detail: 'traffic_isolation source attribution' };
  }
  if (ti.active_revisions_mode_temporary !== 'Multiple') {
    return { ok: false, detail: `mode=${ti.active_revisions_mode_temporary}` };
  }
  if (ti.public_traffic_pin_percent !== 100) {
    return { ok: false, detail: `pin_percent=${ti.public_traffic_pin_percent}` };
  }
  if (ti.public_traffic_pin_target !== 'known_healthy_revision') {
    return { ok: false, detail: 'pin_target' };
  }
  if (ti.fail_revision_public_traffic_percent !== 0) {
    return { ok: false, detail: `fail_traffic=${ti.fail_revision_public_traffic_percent}` };
  }
  if (ti.fail_scale_min !== failMin || ti.fail_scale_max !== failMax) {
    return { ok: false, detail: 'fail scale min/max' };
  }
  if (ti.semantics !== locks.TRAFFIC_ISOLATION_SEMANTICS) {
    return { ok: false, detail: 'semantics' };
  }
  if (ti.observed_at !== locks.OBSERVED_AT_UNAVAILABLE) {
    return { ok: false, detail: `observed_at=${ti.observed_at}` };
  }
  return { ok: true };
}

function classBFinalOk(tenant, kind) {
  if (!tenant) return { ok: false, detail: 'tenant missing' };
  const isWh = kind === 'wolfhouse';
  const fail = tenant.fail_revision_final;
  const restore = tenant.restore_revision_final;
  const app = tenant.app_final;
  if (!fail || !restore || !app) return { ok: false, detail: 'missing final blocks' };
  if (fail.active !== false) return { ok: false, detail: 'fail active' };
  if (fail.running_state !== 'Stopped') return { ok: false, detail: `fail running_state=${fail.running_state}` };
  if (fail.replicas !== 0) return { ok: false, detail: `fail replicas=${fail.replicas}` };
  if (fail.traffic_weight !== 0) return { ok: false, detail: `fail traffic=${fail.traffic_weight}` };
  if (restore.health_state !== 'Healthy') return { ok: false, detail: 'restore health' };
  if (restore.latest_ready_revision !== restore.revision) {
    return { ok: false, detail: 'latest_ready_revision' };
  }
  if (restore.traffic_weight !== 100) return { ok: false, detail: 'restore traffic' };
  const expRestoreMin = isWh ? locks.WH_RESTORE_MIN : locks.SUNSET_RESTORE_MIN;
  const expRestoreMax = isWh ? locks.WH_RESTORE_MAX : locks.SUNSET_RESTORE_MAX;
  const expRestoreRev = isWh ? locks.WH_RESTORE_REVISION : locks.SUNSET_RESTORE_REVISION;
  const expFailRev = isWh ? locks.WH_FAIL_REVISION : locks.SUNSET_FAIL_REVISION;
  const expDigest = isWh ? locks.WH_DIGEST : locks.SUNSET_DIGEST;
  const expImage = isWh ? locks.WH_IMAGE : locks.SUNSET_IMAGE;
  if (restore.revision !== expRestoreRev) return { ok: false, detail: 'restore revision' };
  if (fail.revision !== expFailRev) return { ok: false, detail: 'fail revision' };
  if (restore.scale_min !== expRestoreMin || restore.scale_max !== expRestoreMax) {
    return { ok: false, detail: 'restore scale' };
  }
  if (tenant.digest !== expDigest) return { ok: false, detail: 'digest' };
  if (tenant.image !== expImage) return { ok: false, detail: 'image' };
  if (app.active_revisions_mode !== locks.ACTIVE_REVISIONS_MODE_FINAL) {
    return { ok: false, detail: 'app mode' };
  }
  if (app.traffic_latest_percent !== 100) return { ok: false, detail: 'app traffic' };
  if (app.public_healthz !== 200 || app.public_readyz !== 200) {
    return { ok: false, detail: 'public probes' };
  }
  if (!Array.isArray(app.probes) || app.probes.length !== 3) {
    return { ok: false, detail: 'probes length' };
  }
  return { ok: true };
}

function claimOwnershipOk(ev) {
  const co = ev && ev.claim_ownership;
  if (!co || typeof co !== 'object') return { ok: false, detail: 'missing claim_ownership' };
  const expected = locks.CLAIM_OWNERSHIP;
  for (const key of Object.keys(expected)) {
    const got = co[key];
    const exp = expected[key];
    if (!got) return { ok: false, detail: `missing ${key}` };
    if (got.owner_class !== exp.owner_class) return { ok: false, detail: `${key} owner_class` };
    if (got.observation !== exp.observation) return { ok: false, detail: `${key} observation` };
    if (JSON.stringify(got.proves) !== JSON.stringify(exp.proves)) {
      return { ok: false, detail: `${key} proves` };
    }
    if (exp.does_not_prove) {
      if (!Array.isArray(got.does_not_prove)
        || exp.does_not_prove.some((k) => !got.does_not_prove.includes(k))) {
        return { ok: false, detail: `${key} does_not_prove` };
      }
    }
    if (exp.observed_at && got.observed_at !== exp.observed_at) {
      return { ok: false, detail: `${key} observed_at` };
    }
    if (exp.does_not_derive_from && got.does_not_derive_from !== exp.does_not_derive_from) {
      return { ok: false, detail: `${key} does_not_derive_from` };
    }
    if (got.limitation !== exp.limitation) return { ok: false, detail: `${key} limitation` };
  }
  return { ok: true };
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
  if (!/cannot recreate|not Azure-reconstructible|Azure cannot/i.test(String(ev.non_recoverability || ''))) {
    errors.push('non_recoverability must deny Azure recreation of historical facts');
  }
  if (!/unavailable_in_command_transcript/i.test(String(ev.provenance_limitations || ''))) {
    errors.push('provenance_limitations must lock observed_at unavailable_in_command_transcript');
  }
  if (!/localhost 503|historical localhost/i.test(String(ev.non_recoverability || ''))) {
    errors.push('non_recoverability must deny historical localhost 503 recreation');
  }
  const co = claimOwnershipOk(ev);
  if (!co.ok) errors.push(`claim_ownership: ${co.detail}`);
  const a = facts.A_operator_observed_drill_transcript;
  const b = facts.B_independently_recoverable_azure_readonly;
  if (a) {
    if (a.source_type !== locks.SOURCE_TYPE_A) errors.push('A source_type wrong');
    if (a.source_ref !== locks.SOURCE_REF_A) errors.push('A source_ref wrong');
    if (a.observed_at !== locks.OBSERVED_AT_UNAVAILABLE) errors.push('A observed_at wrong');
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
  if (matrix.slice !== locks.SLICE) errors.push(`slice=${matrix.slice}`);
  if (matrix.branch !== locks.BRANCH) errors.push(`branch=${matrix.branch}`);
  if (matrix.master_basis !== locks.MASTER_BASIS) errors.push('master_basis mismatch');
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
    if (!/16AB|readyz.?=?503|serving.?revision/i.test(String(g02.rationale || ''))) {
      errors.push('G02 rationale missing 16AB/readyz=503 facts');
    }
    if (!/unavailable_in_command_transcript/i.test(String(g02.rationale || ''))) {
      errors.push('G02 rationale missing unavailable_in_command_transcript');
    }
    if (!Array.isArray(g02.gaps) || !g02.gaps.some((g) => (
      /zero.?downtime|organic|production/i.test(String(g))
    ))) {
      errors.push('G02 gaps must retain zero_downtime or organic/production open');
    }
    if (g02.gaps && g02.gaps.some((g) => (
      /serving.?revision.?readyz.?503|readyz.?=?503.?body/i.test(String(g))
      && !/not exercised|never became|prior|retained|16AA|16X/i.test(String(g))
    ))) {
      errors.push('G02 gaps still list serving_revision_readyz_503 as open');
    }
  }
  for (const g of matrix.gates || []) {
    if (g.verdict === 'proven') errors.push(`${g.id} falsely proven`);
  }
  return { ok: errors.length === 0, errors };
}

function claimsConcurrentContinuityOrZeroDowntime(ev) {
  const a = ev && ev.observed_facts && ev.observed_facts.A_operator_observed_drill_transcript;
  if (!a) return true;
  if (Array.isArray(a.covers) && (
    a.covers.includes('concurrent_sampled_continuity')
    || a.covers.includes('zero_downtime_during_restart')
  )) return true;
  if (Array.isArray(a.explicitly_not_covered)) {
    if (!a.explicitly_not_covered.includes('concurrent_sampled_continuity')) return true;
    if (!a.explicitly_not_covered.includes('zero_downtime_during_restart')) return true;
  } else {
    return true;
  }
  if (Array.isArray(ev.claims_allowed) && (
    ev.claims_allowed.includes('concurrent_sampled_continuity')
    || ev.claims_allowed.includes('zero_downtime_during_restart')
  )) return true;
  if (ev.disposition && Array.isArray(ev.disposition.proves) && (
    ev.disposition.proves.some((p) => /concurrent_sampled_continuity|zero_downtime_during_restart/i.test(String(p)))
  )) return true;
  const g02 = ev.gate_progress_updates && ev.gate_progress_updates.G02_readiness_dependencies;
  if (g02 && g02.verdict === 'proven') return true;
  return false;
}

function observedAtUnavailableLocked(ev) {
  const a = ev && ev.observed_facts && ev.observed_facts.A_operator_observed_drill_transcript;
  if (!a || a.observed_at !== locks.OBSERVED_AT_UNAVAILABLE) return false;
  for (const kind of ['wolfhouse', 'sunset']) {
    const t = a[kind];
    if (!t) return false;
    for (const block of [
      t.traffic_isolation,
      t.fail_revision_setup,
      t.local_readyz_503,
      t.public_healthy_readyz_during_drill,
      t.cleanup,
    ]) {
      if (!block || block.observed_at !== locks.OBSERVED_AT_UNAVAILABLE) return false;
    }
  }
  return true;
}

function fieldLevelOverclaim(text) {
  const hits = [];
  const forbidden = [
    /\bG02\s+proven\b/i,
    /\bverdict\s*[:=]\s*proven\b/i,
    /\bfull\s+G02\b/i,
    /\bproduction\b/i,
    /\borganic\s+metric\s+alert/i,
    /\bzero\s+downtime\s+during\s+restart\b.*\bproven\b/i,
    /\bconcurrent\s+sampled\s+continuity\b.*\bproven\b/i,
  ];
  for (const re of forbidden) {
    if (re.test(text)) hits.push(String(re));
  }
  return hits;
}

function runVerifier() {
  console.log('RADAR 16AB G02 serving-revision /readyz=503 evidence — offline verifier\n');

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

  ok('C3 HEAD on 16AB branch', currentBranch() === locks.BRANCH, currentBranch());

  {
    const v = validateEvidenceExact(evidence);
    ok('C4 evidence exact recursive schema + lock_hash', v.ok, v.errors.slice(0, 12).join(' | '));
  }

  ok('C5 explicitly_not_claimed complete',
    Array.isArray(evidence.explicitly_not_claimed)
    && locks.EXPLICITLY_NOT_CLAIMED.every((k) => evidence.explicitly_not_claimed.includes(k))
    && evidence.explicitly_not_claimed.length === locks.EXPLICITLY_NOT_CLAIMED.length);

  ok('C6 disposition G02 partial; serving_revision_readyz_503 closed',
    evidence.disposition
    && evidence.disposition.g02_verdict === 'partial'
    && evidence.disposition.g02_progress_class === 'partial_live_proven'
    && evidence.gate_progress_updates.G02_readiness_dependencies.verdict === 'partial'
    && evidence.gate_progress_updates.G02_readiness_dependencies.live_proven.includes(
      'serving_revision_readyz_503_body_path_via_16AB',
    )
    && evidence.gate_progress_updates.G02_readiness_dependencies.still_open.includes(
      'zero_downtime_during_restart',
    )
    && evidence.gate_progress_updates.G02_readiness_dependencies.still_open.includes(
      'organic_metric_alert_firing',
    )
    && evidence.gate_progress_updates.G02_readiness_dependencies.still_open.includes('production')
    && !evidence.gate_progress_updates.G02_readiness_dependencies.still_open.some(
      (x) => /serving_revision_readyz_503|readyz.?503.?body/i.test(String(x)),
    ));

  {
    const whLr = localReadyzOk(classATenant(evidence, 'wolfhouse'), locks.WH_FAIL_REVISION, locks.WH_FAIL_REPLICA);
    const suLr = localReadyzOk(classATenant(evidence, 'sunset'), locks.SUNSET_FAIL_REVISION, locks.SUNSET_FAIL_REPLICA);
    ok('C7 exact local readyz provenance both tenants',
      whLr.ok && suLr.ok, `${whLr.detail || ''} | ${suLr.detail || ''}`);
  }

  {
    const whTi = trafficIsolationOk(classATenant(evidence, 'wolfhouse'), locks.WH_FAIL_MIN, locks.WH_FAIL_MAX);
    const suTi = trafficIsolationOk(classATenant(evidence, 'sunset'), locks.SUNSET_FAIL_MIN, locks.SUNSET_FAIL_MAX);
    ok('C7b traffic isolation: fail public traffic 0, healthy pin 100, Multiple mode',
      whTi.ok && suTi.ok, `${whTi.detail || ''} | ${suTi.detail || ''}`);
  }

  {
    const whB = classBFinalOk(classBTenant(evidence, 'wolfhouse'), 'wolfhouse');
    const suB = classBFinalOk(classBTenant(evidence, 'sunset'), 'sunset');
    ok('C8 class B final: Single mode, restore Healthy/latestReady/100%, fail inactive/Stopped/0',
      whB.ok && suB.ok, `${whB.detail || ''} | ${suB.detail || ''}`);
  }

  ok('C9 no concurrent continuity / zero-downtime proven claims',
    !claimsConcurrentContinuityOrZeroDowntime(evidence));

  {
    const mv = validateGateMatrix(matrix);
    ok('C10 matrix validation (tip=16AB, G02 partial, gaps retain open items)', mv.ok, mv.errors.join(' | '));
  }

  ok('C11 top contract selected_16ab + g02_serving_readyz_503_live',
    topContract.selected_16ab
    && topContract.selected_16ab.outcome_id === locks.OUTCOME_ID
    && topContract.selected_16ab.g02_serving_readyz_503_live === 'live_proven_via_16AB'
    && topContract.selected_16ab.g02_verdict === 'partial'
    && topContract.selected_16aa
    && topContract.selected_16z);

  ok('C12 doc mentions 16AB + readyz=503 + unavailable_in_command_transcript without G02 proven overclaim',
    /16AB|g02.?serving.?readyz.?503/i.test(doc)
    && /readyz.?=?503/i.test(doc)
    && /unavailable_in_command_transcript/i.test(doc)
    && /cannot recreate|not Azure-reconstructible|Azure cannot recreate/i.test(doc)
    && /partial/i.test(doc)
    && /transcript|provenance|class A|operator-observed|az containerapp exec/i.test(doc)
    && /independently|class B|Azure read-only|localhost/i.test(doc)
    && !/\bG02\s+proven\b/i.test(doc));

  ok('C13 findings mention 16AB + readyz=503 without proven overclaim',
    /16AB/.test(findings)
    && /readyz.?=?503/i.test(findings)
    && /unavailable_in_command_transcript/i.test(findings)
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
      && pkg.scripts['verify:radar-slice16ab-g02-readyz503-evidence']
        === 'node scripts/verify-radar-slice16ab-g02-readyz503-evidence.js');
  }

  {
    const pv = validateProvenanceSplit(evidence);
    ok('C17 provenance split A/B + limitations + non-recoverability + claim_ownership',
      pv.ok, pv.errors.join(' | '));
  }

  green('claims_and_disposition_locked',
    locks.CLAIMS_ALLOWED.every((c) => evidence.claims_allowed.includes(c))
    && evidence.disposition.proves.length >= 5
    && evidence.disposition.does_not_prove.includes('production')
    && evidence.disposition.does_not_prove.includes('full_G02_proven')
    && evidence.disposition.does_not_prove.includes('concurrent_sampled_continuity')
    && evidence.disposition.does_not_prove.includes('zero_downtime_during_restart')
    && evidence.disposition.does_not_prove.includes('azure_derived_historical_localhost_503')
    && evidence.disposition.does_not_prove.includes('invented_transcript_timestamp')
    && evidence.disposition.proves.includes('exact_local_readyz_status_503_body_status_not_ready'));

  green('local_readyz_503_exact_both_tenants',
    localReadyzOk(classATenant(evidence, 'wolfhouse'), locks.WH_FAIL_REVISION, locks.WH_FAIL_REPLICA).ok
    && localReadyzOk(classATenant(evidence, 'sunset'), locks.SUNSET_FAIL_REVISION, locks.SUNSET_FAIL_REPLICA).ok);

  green('class_b_final_healthy_serving',
    classBFinalOk(classBTenant(evidence, 'wolfhouse'), 'wolfhouse').ok
    && classBFinalOk(classBTenant(evidence, 'sunset'), 'sunset').ok);

  green('traffic_isolation_locked',
    trafficIsolationOk(classATenant(evidence, 'wolfhouse'), locks.WH_FAIL_MIN, locks.WH_FAIL_MAX).ok
    && trafficIsolationOk(classATenant(evidence, 'sunset'), locks.SUNSET_FAIL_MIN, locks.SUNSET_FAIL_MAX).ok);

  green('observed_at_unavailable_locked', observedAtUnavailableLocked(evidence));

  green('secret_free_owned_artifacts', secretFree(JSON.stringify(evidence), 'evidence').ok);

  green('runtime_paths_unchanged', runtimePathsUnchanged().ok);

  green('package_script_registered',
    (() => {
      const pkg = readJson('package.json');
      return pkg.scripts
        && pkg.scripts['verify:radar-slice16ab-g02-readyz503-evidence']
          === 'node scripts/verify-radar-slice16ab-g02-readyz503-evidence.js';
    })());

  green('live_probe_does_not_rewrite_historical_a', (() => {
    const after = locks.mergeLiveProbeWithoutRewritingHistorical(evidence, {
      attempted_at_utc: '2026-07-21T99:00:00Z',
      result: 'timeout',
    });
    const rewritten = locks.historicalSamplesRewrittenByLiveProbe(evidence, after);
    const still503 = classATenant(after, 'wolfhouse').local_readyz_503.status === 503
      && classATenant(after, 'sunset').local_readyz_503.status === 503;
    return !rewritten && still503;
  })());

  // --- RED battery ---
  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.observed_at = '2026-07-21T12:34:56Z';
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.local_readyz_503.observed_at =
      '2026-07-21T12:34:56Z';
    red('invented_timestamp_rejected',
      !validateEvidenceExact(bad).ok || !observedAtUnavailableLocked(bad));
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.local_readyz_503 =
      deepClone(bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.local_readyz_503);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.local_readyz_503.source_type =
      locks.SOURCE_TYPE_B;
    red('azure_derived_historical_503_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.local_readyz_503.status = 500;
    red('wrong_status_rejected',
      !validateEvidenceExact(bad).ok
      || !localReadyzOk(classATenant(bad, 'wolfhouse'), locks.WH_FAIL_REVISION, locks.WH_FAIL_REPLICA).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.local_readyz_503.body = { status: 'error' };
    red('wrong_body_rejected',
      !validateEvidenceExact(bad).ok
      || !localReadyzOk(classATenant(bad, 'wolfhouse'), locks.WH_FAIL_REVISION, locks.WH_FAIL_REPLICA).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.local_readyz_503.body = {
      status: 'not-ready',
      detail: 'extra',
    };
    red('extra_body_fields_rejected',
      !validateEvidenceExact(bad).ok
      || !localReadyzOk(classATenant(bad, 'wolfhouse'), locks.WH_FAIL_REVISION, locks.WH_FAIL_REPLICA).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.fail_revision = 'wh-staging-staff-api--wrong';
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.local_readyz_503.revision =
      'wh-staging-staff-api--wrong';
    red('wrong_fail_revision_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.fail_replica =
      'wh-staging-staff-api--g02503-deadbeef-dead';
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.local_readyz_503.replica =
      'wh-staging-staff-api--g02503-deadbeef-dead';
    red('wrong_fail_replica_rejected',
      !validateEvidenceExact(bad).ok
      || !localReadyzOk(classATenant(bad, 'wolfhouse'), locks.WH_FAIL_REVISION, locks.WH_FAIL_REPLICA).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.traffic_isolation
      .fail_revision_public_traffic_percent = 50;
    red('non_isolated_traffic_rejected',
      !validateEvidenceExact(bad).ok
      || !trafficIsolationOk(classATenant(bad, 'wolfhouse'), locks.WH_FAIL_MIN, locks.WH_FAIL_MAX).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.A_operator_observed_drill_transcript.covers.push('fail_revision_received_public_traffic');
    bad.observed_facts.A_operator_observed_drill_transcript.explicitly_not_covered =
      bad.observed_facts.A_operator_observed_drill_transcript.explicitly_not_covered
        .filter((x) => x !== 'fail_revision_received_public_traffic');
    red('fail_received_public_traffic_claim_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.fail_revision_final.active = true;
    red('fail_still_active_rejected',
      !validateEvidenceExact(bad).ok
      || !classBFinalOk(classBTenant(bad, 'wolfhouse'), 'wolfhouse').ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.fail_revision_final.replicas = 1;
    red('fail_replicas_positive_rejected',
      !validateEvidenceExact(bad).ok
      || !classBFinalOk(classBTenant(bad, 'wolfhouse'), 'wolfhouse').ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.fail_revision_final.running_state =
      'Running';
    red('fail_not_stopped_rejected',
      !validateEvidenceExact(bad).ok
      || !classBFinalOk(classBTenant(bad, 'wolfhouse'), 'wolfhouse').ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.restore_revision_final.revision =
      'wh-staging-staff-api--wrong';
    red('wrong_restore_revision_rejected',
      !validateEvidenceExact(bad).ok
      || !classBFinalOk(classBTenant(bad, 'wolfhouse'), 'wolfhouse').ok);
  }
  {
    const bad = deepClone(evidence);
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.restore_revision_final.scale_min = 2;
    bad.observed_facts.B_independently_recoverable_azure_readonly.wolfhouse.restore_revision_final.scale_max = 3;
    red('wrong_restore_scale_rejected',
      !validateEvidenceExact(bad).ok
      || !classBFinalOk(classBTenant(bad, 'wolfhouse'), 'wolfhouse').ok);
  }
  {
    const bad = deepClone(evidence);
    const fakeDsn = ['postgres', '://user:pass@host/db'].join('');
    bad.observed_facts.A_operator_observed_drill_transcript.wolfhouse.fail_revision_setup.note =
      `${fakeDsn} used`;
    const sec = secretFree(JSON.stringify(bad), 'tampered');
    red('dsn_secret_rejected', !validateEvidenceExact(bad).ok || !sec.ok);
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
    const bad = deepClone(evidence);
    bad.disposition.proves.push('zero_downtime_during_restart');
    bad.explicitly_not_claimed = bad.explicitly_not_claimed
      .filter((x) => x !== 'zero_downtime_during_restart');
    red('overclaim_zero_downtime_rejected',
      !validateEvidenceExact(bad).ok || claimsConcurrentContinuityOrZeroDowntime(bad));
  }
  {
    const bad = deepClone(evidence);
    bad.disposition.proves.push('concurrent_sampled_continuity');
    bad.explicitly_not_claimed = bad.explicitly_not_claimed
      .filter((x) => x !== 'concurrent_sampled_continuity');
    red('overclaim_concurrent_continuity_rejected',
      !validateEvidenceExact(bad).ok || claimsConcurrentContinuityOrZeroDowntime(bad));
  }
  {
    const bad = deepClone(evidence);
    bad.claims_allowed.push('production');
    bad.explicitly_not_claimed = bad.explicitly_not_claimed.filter((x) => x !== 'production');
    red('overclaim_production_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.disposition.g02_verdict = 'proven';
    bad.disposition.g02_progress_class = 'proven';
    bad.gate_progress_updates.G02_readiness_dependencies.progress_class = 'proven';
    red('overclaim_full_g02_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    bad.lock_hash = '0'.repeat(64);
    red('lock_hash_mismatch_rejected', !validateEvidenceExact(bad).ok);
  }
  {
    const bad = deepClone(evidence);
    const after = locks.mergeLiveProbeWithoutRewritingHistorical(bad, {
      attempted_at_utc: '2026-07-21T99:00:00Z',
      result: 'timeout',
    });
    after.observed_facts.A_operator_observed_drill_transcript.wolfhouse.local_readyz_503.status = 200;
    red('live_probe_rewrites_class_a_rejected',
      locks.historicalSamplesRewrittenByLiveProbe(bad, after));
  }
  {
    const badDoc = `${doc}\n\nG02 proven end-to-end including production.\n`;
    const hits = fieldLevelOverclaim(badDoc);
    red('doc_overclaim_tokens_rejected', hits.length > 0, hits.join(','));
  }

  const requiredReds = [
    'invented_timestamp_rejected',
    'azure_derived_historical_503_rejected',
    'wrong_status_rejected',
    'wrong_body_rejected',
    'extra_body_fields_rejected',
    'wrong_fail_revision_rejected',
    'wrong_fail_replica_rejected',
    'non_isolated_traffic_rejected',
    'fail_received_public_traffic_claim_rejected',
    'fail_still_active_rejected',
    'fail_replicas_positive_rejected',
    'fail_not_stopped_rejected',
    'wrong_restore_revision_rejected',
    'wrong_restore_scale_rejected',
    'dsn_secret_rejected',
    'overclaim_g02_proven_rejected',
    'overclaim_zero_downtime_rejected',
    'overclaim_concurrent_continuity_rejected',
    'overclaim_production_rejected',
    'overclaim_full_g02_rejected',
    'lock_hash_mismatch_rejected',
    'live_probe_rewrites_class_a_rejected',
    'doc_overclaim_tokens_rejected',
  ];
  for (const id of requiredReds) {
    const row = redResults.find((r) => r.id === id);
    ok(`RED-REQUIRED ${id}`, row && row.ok);
  }

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('RADAR 16AB G02 serving-revision /readyz=503 evidence (partial/live-proven): PASS');
}

runVerifier();
