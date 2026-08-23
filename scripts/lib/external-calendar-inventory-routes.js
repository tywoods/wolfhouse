'use strict';

/**
 * Calendar Inventory Bridge HTTP helpers.
 * Wolfhouse-somo first. Sunset slugs always refused.
 * maps / occupancy / connection_id are never caller authority.
 */

const {
  bridgeAvailable,
  clientAllowed,
  probeSheetRows,
  nextConnectionStatus,
} = require('./external-calendar-inventory');

function refuseClient(slug) {
  if (!clientAllowed(slug)) {
    return { ok: false, status: 403, error: 'calendar_bridge_client_not_allowed' };
  }
  if (!bridgeAvailable(slug)) {
    return { ok: false, status: 403, error: 'calendar_bridge_disabled' };
  }
  return { ok: true };
}

function rejectCallerAuthority(body) {
  if (!body || typeof body !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(body, 'maps')
    || Object.prototype.hasOwnProperty.call(body, 'occupancy')
    || Object.prototype.hasOwnProperty.call(body, 'connection_id')) {
    return { ok: false, status: 400, error: 'caller_authority_rejected' };
  }
  return null;
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

/**
 * Probe using DB-loaded maps/occupancy/connection only.
 * body.rows may be used by tests; live path loads rows from the Sheet adapter.
 */
function handleProbeFromState(body, dbState) {
  const banned = rejectCallerAuthority(body);
  if (banned) return banned;
  if (!dbState || !dbState.ok) {
    return { ok: false, status: 404, error: (dbState && dbState.reason) || 'connection_not_found' };
  }
  const rows = body && Array.isArray(body.rows) ? body.rows : dbState.rows;
  if (!rows) {
    return { ok: false, status: 400, error: 'rows_required_for_probe' };
  }
  const plan = probeSheetRows(rows, {
    maps: dbState.maps || {},
    occupancy: dbState.occupancy || {},
    connectionId: dbState.connection && dbState.connection.id,
  });
  const next = nextConnectionStatus(dbState.connection && dbState.connection.status, plan);
  if (!plan.ok) {
    return {
      ok: false,
      status: 422,
      error: plan.reason,
      keep_last_blocks: true,
      next_status: next,
      skipped: plan.skipped || [],
    };
  }
  return {
    ok: true,
    dry_run: true,
    keep_last_blocks: true,
    next_status: next,
    empty: !!plan.empty,
    write_count: (plan.writes || []).length,
  };
}

module.exports = {
  refuseClient,
  rejectCallerAuthority,
  sanitizeConnection,
  handleProbeFromState,
};
