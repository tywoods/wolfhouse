'use strict';

/**
 * Crowsnest AI-usage reporter ("the observer") — Slice B, per
 * docs/architecture/crowsnest-ai-usage-runtime-attribution.md.
 *
 * Runs INSIDE a tenant AI runtime (first live source: Sunset Luna/Hermes staging).
 * After a provider call it takes the safe technical facts (model / usage tokens /
 * latency / cost or error_code), normalizes them through the shared adapter into a
 * crowsnest.ai_usage.v1 receipt, and PUSHES it to the Crowsnest ingest endpoint.
 * Crowsnest never reads the tenant runtime (Model A).
 *
 * Hard invariants (why this module is deliberately dull):
 *   - Trusted identity (client_slug, tenant_id, source_service) comes ONLY from
 *     server-owned config; it is never taken from the per-call runtime facts, the
 *     provider response, prompts, URLs, or request bodies. Config wins on merge.
 *   - Opt-in: with no ingest URL/token configured the reporter is a silent no-op.
 *   - It NEVER throws into the caller. A missing/invalid identity, malformed
 *     receipt, unsupported provider data, or a network/ledger failure returns a
 *     result object and must not alter the guest-facing response.
 *   - Each provider-call attempt gets a fresh opaque event_id; a retried delivery
 *     of the same receipt reuses that id (pass it back in). No prompt/message-
 *     derived idempotency key is ever used.
 *
 * Config (env):
 *   CROWSNEST_AI_USAGE_INGEST_URL      e.g. https://crowsnest.lunafrontdesk.com/api/ai-usage
 *   CROWSNEST_AI_USAGE_INGEST_TOKEN    bearer token (matches the endpoint's)
 *   CROWSNEST_AI_USAGE_CLIENT_SLUG     trusted client_slug this observer reports as
 *   CROWSNEST_AI_USAGE_TENANT_ID       trusted tenant_id this observer reports as
 *   CROWSNEST_AI_USAGE_SOURCE_SERVICE  (optional) defaults to 'hermes'
 */

const crypto = require('crypto');
const {
  adaptCrowsnestAiUsageSuccess,
  adaptCrowsnestAiUsageFailure,
} = require('./lib/crowsnest/crowsnest-ai-usage-adapter');

const DEFAULT_SOURCE_SERVICE = 'hermes';

/** Fresh opaque event id (contract SAFE_ID: starts alnum, [A-Za-z0-9._:-], <=128). */
function newEventId() {
  return `evt_${crypto.randomBytes(16).toString('hex')}`;
}

function toIsoZ(value) {
  const d = value == null ? new Date() : (value instanceof Date ? value : new Date(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Read server-owned config. Returns { enabled, ... }. `enabled` is false (a
 * silent no-op) whenever the ingest URL/token or trusted identity are missing —
 * never throws, because this runs inline in the guest path.
 */
function readReporterConfig(env = process.env) {
  const cfg = {
    ingestUrl: String(env.CROWSNEST_AI_USAGE_INGEST_URL || '').trim(),
    ingestToken: String(env.CROWSNEST_AI_USAGE_INGEST_TOKEN || '').trim(),
    clientSlug: String(env.CROWSNEST_AI_USAGE_CLIENT_SLUG || '').trim(),
    tenantId: String(env.CROWSNEST_AI_USAGE_TENANT_ID || '').trim(),
    sourceService: String(env.CROWSNEST_AI_USAGE_SOURCE_SERVICE || '').trim() || DEFAULT_SOURCE_SERVICE,
  };
  cfg.enabled = Boolean(cfg.ingestUrl && cfg.ingestToken && cfg.clientSlug && cfg.tenantId);
  return cfg;
}

async function postEvent({ url, token, event, fetchImpl }) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('no fetch implementation available');
  const resp = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(event),
  });
  let body = null;
  try { body = await resp.json(); } catch { /* ignore non-JSON bodies */ }
  return { status: resp.status, body };
}

/**
 * Merge server-owned identity over caller-supplied runtime facts. Identity keys
 * (client_slug, tenant_id, source_service) always come from config so the caller
 * can never spoof attribution. event_id / occurred_at default here if absent.
 */
function buildAdapterInput(facts, cfg) {
  const f = (facts && typeof facts === 'object') ? facts : {};
  return {
    ...f,
    client_slug: cfg.clientSlug,
    tenant_id: cfg.tenantId,
    source_service: cfg.sourceService,
    event_id: f.event_id || newEventId(),
    occurred_at: f.occurred_at || toIsoZ(new Date()),
  };
}

/**
 * Report one attempt. `outcome` is 'succeeded' | 'failed'. Runtime facts:
 *   succeeded: { provider, operation, response, latency_ms, occurred_at?, event_id?, cost? }
 *   failed:    { provider, operation, model, error_code, latency_ms, occurred_at?, event_id? }
 * Returns a result object; never throws.
 */
async function report(outcome, facts, env = process.env, deps = {}) {
  try {
    const cfg = deps.config || readReporterConfig(env);
    if (!cfg.enabled) return { ok: false, skipped: true, reason: 'not_configured' };

    const input = buildAdapterInput(facts, cfg);
    const adapted = outcome === 'failed'
      ? adaptCrowsnestAiUsageFailure(input)
      : adaptCrowsnestAiUsageSuccess(input);
    if (!adapted.ok) {
      return { ok: false, skipped: true, reason: 'invalid_event', errors: adapted.errors, event_id: input.event_id };
    }

    const res = await postEvent({
      url: cfg.ingestUrl,
      token: cfg.ingestToken,
      event: adapted.event,
      fetchImpl: deps.fetchImpl,
    });
    return { ok: res.status === 200, status: res.status, event: adapted.event, body: res.body };
  } catch (err) {
    // Opt-in observer: swallow everything so a reporting fault can never break
    // the guest-facing response.
    return { ok: false, skipped: true, reason: 'reporter_error', error: err && err.message };
  }
}

function reportSuccess(facts, env = process.env, deps = {}) {
  return report('succeeded', facts, env, deps);
}

function reportFailure(facts, env = process.env, deps = {}) {
  return report('failed', facts, env, deps);
}

module.exports = {
  DEFAULT_SOURCE_SERVICE,
  newEventId,
  toIsoZ,
  readReporterConfig,
  buildAdapterInput,
  postEvent,
  report,
  reportSuccess,
  reportFailure,
};
