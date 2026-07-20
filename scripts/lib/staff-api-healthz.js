'use strict';

/**
 * Staff API public liveness (RADAR 16K) — minimized /healthz.
 *
 * Contract:
 * - Public body is a stable generic schema only: { status: 'ok', service: 'staff-api' }.
 * - No tenant / product-internal / provider / model / key / config / stage / note fields.
 * - DB-independent static liveness (process up). Must NOT touch Postgres.
 * - HTTP 200; Cache-Control: no-store (via sendJSON).
 * - Authenticated diagnostics remain on existing staff routes
 *   (e.g. GET /staff/ask-luna/ai-status) — not on public /healthz.
 * - /readyz is owned by 16I and must not change here.
 */

const HEALTHZ_PATH = '/healthz';

/** Frozen public liveness body — identical for Wolfhouse and Sunset. */
const HEALTHZ_BODY = Object.freeze({
  status: 'ok',
  service: 'staff-api',
});

const ALLOWED_HEALTHZ_KEYS = Object.freeze(['status', 'service']);

const FORBIDDEN_HEALTHZ_KEYS = Object.freeze([
  'auth_enabled',
  'stage',
  'stormglass',
  'luna_ai',
  'note',
  'tenant',
  'tenant_slug',
  'client',
  'client_slug',
  'provider',
  'model',
  'key_present',
  'key_source',
  'key_fingerprint',
  'key_length',
  'configured',
  'config',
  'openai',
  'anthropic',
  'database',
  'postgres',
  'ready',
  'readyz',
]);

/**
 * Assert a parsed public healthz body matches the frozen generic schema.
 * @param {unknown} body
 * @returns {{ ok: boolean, detail?: string }}
 */
function assertPublicHealthzBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, detail: 'body_not_object' };
  }
  const keys = Object.keys(body).sort();
  const allowed = [...ALLOWED_HEALTHZ_KEYS].sort();
  if (keys.length !== allowed.length || keys.join(',') !== allowed.join(',')) {
    return { ok: false, detail: `unexpected_keys:${keys.join(',')}` };
  }
  for (const k of FORBIDDEN_HEALTHZ_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      return { ok: false, detail: `forbidden_key:${k}` };
    }
  }
  if (body.status !== 'ok') return { ok: false, detail: 'status_not_ok' };
  if (body.service !== 'staff-api') return { ok: false, detail: 'service_not_staff_api' };
  return { ok: true };
}

/**
 * Serve public /healthz (and `/` alias) — no DB, no env introspection of secrets/config.
 * @param {import('http').ServerResponse} res
 * @param {(res: import('http').ServerResponse, status: number, body: object) => void} sendJSON
 */
function handleStaffApiHealthz(res, sendJSON) {
  return sendJSON(res, 200, HEALTHZ_BODY);
}

module.exports = {
  HEALTHZ_PATH,
  HEALTHZ_BODY,
  ALLOWED_HEALTHZ_KEYS,
  FORBIDDEN_HEALTHZ_KEYS,
  assertPublicHealthzBody,
  handleStaffApiHealthz,
};
