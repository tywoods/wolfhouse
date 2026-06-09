'use strict';

/**
 * Stage 27test-s — Structured server-side logging for review dry-run 500s.
 * Logs to stderr only; never returns stack traces to clients.
 */

const ERROR_MARKER = 'LUNA_REVIEW_DRY_RUN_ERROR';

function maskGuestPhone(phone) {
  const s = String(phone || '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length <= 4) return `***${digits}`;
  return `***${digits.slice(-4)}`;
}

function headerValue(req, name) {
  const h = (req && req.headers) || {};
  const key = String(name).toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (String(k).toLowerCase() === key) {
      return String(Array.isArray(v) ? v[0] : v).trim();
    }
  }
  return '';
}

function extractReviewDryRunCorrelation(req, body) {
  const src = body || {};
  return {
    correlation_id: headerValue(req, 'x-luna-correlation-id') || headerValue(req, 'x-request-id') || null,
    run_id: src.torture_run_id || src.run_id || headerValue(req, 'x-luna-run-id') || null,
    fixture_id: src.fixture_id || headerValue(req, 'x-luna-fixture-id') || null,
  };
}

function logReviewDryRunError(opts) {
  const o = opts || {};
  const err = o.error;
  const entry = {
    marker: ERROR_MARKER,
    endpoint: o.endpoint || null,
    correlation_id: o.correlation_id || null,
    run_id: o.run_id || null,
    fixture_id: o.fixture_id || null,
    client_slug: o.client_slug || null,
    channel: o.channel || null,
    guest_phone_masked: maskGuestPhone(o.guest_phone),
    message_length: o.message_length != null ? o.message_length : null,
    error_name: err && err.name ? err.name : 'Error',
    error_message: err && err.message ? err.message : String(err || 'unknown'),
    error_stack: err && err.stack ? err.stack : null,
    elapsed_ms: o.elapsed_ms != null ? o.elapsed_ms : null,
  };
  console.error(JSON.stringify(entry));
}

function buildSafeReviewDryRun500Body(fields) {
  const f = fields || {};
  return {
    success: false,
    dry_run: true,
    sends_whatsapp: false,
    live_send_blocked: true,
    error: f.error || 'review dry-run failed',
    auth_mode: f.auth_mode,
    elapsed_ms: f.elapsed_ms,
  };
}

module.exports = {
  ERROR_MARKER,
  maskGuestPhone,
  extractReviewDryRunCorrelation,
  logReviewDryRunError,
  buildSafeReviewDryRun500Body,
};
