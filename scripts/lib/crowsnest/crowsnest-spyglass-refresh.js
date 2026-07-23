'use strict';

/**
 * Crowsnest Spyglass Refresh all — Slice A domain contract.
 *
 * Fixed client allowlist + server-owned configured targets + injected job-start
 * transport. Pure domain module: no environment reads, no network client, no
 * cloud CLI, no cloud SDK, no database driver, no tenant database access.
 *
 * Statuses are honest coverage labels only:
 *   started | not_configured | unavailable
 * Never claims every client refreshed / metrics refreshed.
 *
 * Slice B will supply a server-side identity-based cloud Job-start adapter; this
 * module stays transport-agnostic.
 */

const SCHEMA_VERSION = 'crowsnest.spyglass.refresh.v1';

/** Strict fixed Spyglass client allowlist (server-owned; never browser-submitted). */
const FIXED_CLIENT_ALLOWLIST = Object.freeze([
  'wolfhouse-somo',
  'sunset-somo',
  'sunset-sardinero',
]);

const REFRESH_STATUSES = Object.freeze(['started', 'not_configured', 'unavailable']);

/**
 * Known Sunset Somo staging manual reporter job. Callers may include this in
 * configuredTargets. Wolfhouse has a manual job in Azure but must NOT be
 * auto-assumed configured until explicit runtime config.
 */
const SUNSET_SOMO_STAGING_TARGET = Object.freeze({
  client_id: 'sunset-somo',
  job_name: 'sunset-somo-stg-cn-metrics',
});

const TARGET_KEYS = Object.freeze(['client_id', 'job_name']);
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function isPlainObject(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isSafeId(value) {
  return typeof value === 'string' && value === value.trim() && SAFE_ID_RE.test(value);
}

/**
 * Keep only allowlisted, closed-shape targets. Off-allowlist and malformed
 * entries are dropped (never invoked).
 */
function normalizeConfiguredTargets(configuredTargets) {
  if (!Array.isArray(configuredTargets)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of configuredTargets) {
    if (!isPlainObject(raw)) continue;
    const keys = Object.keys(raw);
    if (keys.some((k) => !TARGET_KEYS.includes(k))) continue;
    const clientId = raw.client_id;
    const jobName = raw.job_name;
    if (!isSafeId(clientId) || !isSafeId(jobName)) continue;
    if (!FIXED_CLIENT_ALLOWLIST.includes(clientId)) continue;
    if (seen.has(clientId)) continue;
    seen.add(clientId);
    out.push(Object.freeze({ client_id: clientId, job_name: jobName }));
  }
  return out;
}

function createUnavailableJobStartTransport(reasonCode = 'job_start_not_wired') {
  const code = String(reasonCode || 'job_start_not_wired');
  return async function unavailableJobStart() {
    return { ok: false, code };
  };
}

/**
 * Request a fresh report from every fixed allowlisted client that has a
 * server-owned configured target. Browser body fields are ignored.
 *
 * @param {object} options
 * @param {Array<{client_id:string, job_name:string}>} [options.configuredTargets]
 * @param {(target:{client_id:string, job_name:string}) => Promise<{ok:boolean}>} options.startJob
 * @param {unknown} [options.browserBody] Ignored — present so callers can prove browser input cannot steer targets.
 */
async function requestSpyglassRefreshAll(options = {}) {
  const startJob = options && options.startJob;
  // browserBody intentionally unread — browser must not submit resource names/client IDs.
  void options.browserBody;

  const configured = normalizeConfiguredTargets(options.configuredTargets);
  const byClient = new Map(configured.map((t) => [t.client_id, t]));

  const results = [];
  for (const clientId of FIXED_CLIENT_ALLOWLIST) {
    const target = byClient.get(clientId);
    if (!target) {
      results.push(Object.freeze({ client_id: clientId, status: 'not_configured' }));
      continue;
    }
    if (typeof startJob !== 'function') {
      results.push(Object.freeze({ client_id: clientId, status: 'unavailable' }));
      continue;
    }
    try {
      const outcome = await startJob(target);
      if (outcome && outcome.ok === true) {
        results.push(Object.freeze({ client_id: clientId, status: 'started' }));
      } else {
        results.push(Object.freeze({ client_id: clientId, status: 'unavailable' }));
      }
    } catch {
      // Never surface raw errors, job IDs, ARM payloads, DSNs, or tokens.
      results.push(Object.freeze({ client_id: clientId, status: 'unavailable' }));
    }
  }

  const coverage = Object.freeze({
    started: results.filter((r) => r.status === 'started').length,
    not_configured: results.filter((r) => r.status === 'not_configured').length,
    unavailable: results.filter((r) => r.status === 'unavailable').length,
    total: results.length,
  });

  return Object.freeze({
    ok: true,
    schema_version: SCHEMA_VERSION,
    results: Object.freeze(results.slice()),
    coverage,
    // Product rule: never claim every client refreshed (even if every status were started).
    all_clients_refreshed: false,
    all_refreshed: false,
  });
}

module.exports = {
  SCHEMA_VERSION,
  FIXED_CLIENT_ALLOWLIST,
  REFRESH_STATUSES,
  SUNSET_SOMO_STAGING_TARGET,
  normalizeConfiguredTargets,
  createUnavailableJobStartTransport,
  requestSpyglassRefreshAll,
};
