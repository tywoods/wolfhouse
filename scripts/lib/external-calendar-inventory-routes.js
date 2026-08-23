'use strict';

/**
 * Calendar Inventory Bridge HTTP handlers.
 * Wolfhouse-somo first. Sunset slugs are always refused.
 * No Google write-back. Live Sheet fetch is optional; missing adapter fail-closes.
 */

const {
  bridgeAvailable,
  clientAllowed,
  probeSheetRows,
  nextConnectionStatus,
} = require('./external-calendar-inventory');
const { applyProbePlan } = require('./external-calendar-inventory-apply');

function refuseClient(slug) {
  if (!clientAllowed(slug)) {
    return { ok: false, status: 403, error: 'calendar_bridge_client_not_allowed' };
  }
  if (!bridgeAvailable(slug)) {
    return { ok: false, status: 403, error: 'calendar_bridge_disabled' };
  }
  return { ok: true };
}

function sanitizeConnection(row) {
  if (!row) return null;
  return {
    id: row.id,
    client_slug: row.client_slug || row.client_id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    spreadsheet_id: row.spreadsheet_id,
    sheet_name: row.sheet_name,
    last_success_at: row.last_success_at,
    last_attempt_at: row.last_attempt_at,
    last_error: row.last_error,
    has_secret: !!row.has_secret,
  };
}

function handleProbeBody(body, maps, occupancy, connectionId) {
  const rows = body && Array.isArray(body.rows) ? body.rows : null;
  if (!rows) {
    return { ok: false, status: 400, error: 'rows_required_for_probe' };
  }
  const plan = probeSheetRows(rows, { maps: maps || {}, occupancy: occupancy || {}, connectionId });
  if (!plan.ok) {
    return {
      ok: false,
      status: 422,
      error: plan.reason,
      keep_last_blocks: true,
      plan,
    };
  }
  const applied = applyProbePlan(plan, { connectionId, occupancy: JSON.parse(JSON.stringify(occupancy || {})) });
  return {
    ok: true,
    dry_run: true,
    keep_last_blocks: true,
    plan,
    preview: {
      created: applied.created.length,
      cancelled: applied.cancelled.length,
      skipped: applied.skipped.length,
    },
    next_status: nextConnectionStatus('pending', plan),
  };
}

module.exports = {
  refuseClient,
  sanitizeConnection,
  handleProbeBody,
};
