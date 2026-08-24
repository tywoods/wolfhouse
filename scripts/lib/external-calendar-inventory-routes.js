'use strict';

const {
  bridgeAvailable,
  clientAllowed,
  probeSheetRows,
  nextConnectionStatus,
  publicErrorCode,
  sanitizeSkipped,
  sanitizeAuditFields,
} = require('./external-calendar-inventory');
const { dtoHasAuthority, loadLockedState, runConnectionSync } = require('./external-calendar-inventory-sync');

function refuseClient(slug) {
  if (!clientAllowed(slug)) {
    return { ok: false, status: 403, error: 'calendar_bridge_client_not_allowed' };
  }
  if (!bridgeAvailable(slug)) {
    return { ok: false, status: 403, error: 'calendar_bridge_disabled' };
  }
  return { ok: true };
}

function requireConnectionId(connectionId) {
  const id = String(connectionId || '').trim();
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
    return { ok: false, status: 400, error: 'connection_id_required' };
  }
  return { ok: true, id };
}

function publicMaps(maps) {
  if (!Array.isArray(maps)) return undefined;
  return maps.map((m) => {
    if (!m || typeof m !== 'object') return { external_unit_key: '', bed_id: null };
    return {
      external_unit_key: typeof m.external_unit_key === 'string' ? m.external_unit_key.slice(0, 80) : '',
      bed_id: typeof m.bed_id === 'string' ? m.bed_id : null,
      bed_code: typeof m.bed_code === 'string' ? m.bed_code.slice(0, 80) : undefined,
    };
  }).map((m) => {
    if (m.bed_code == null) delete m.bed_code;
    return m;
  });
}

function publicConnection(row) {
  if (!row || typeof row !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(row, 'last_error_code')
    || Object.prototype.hasOwnProperty.call(row, 'secret_ref')
    || Object.prototype.hasOwnProperty.call(row, 'last_error_detail')) {
    return sanitizeConnection(row);
  }
  const out = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    spreadsheet_id: row.spreadsheet_id,
    sheet_name: row.sheet_name,
    last_success_at: row.last_success_at,
    last_attempt_at: row.last_attempt_at,
    last_error: row.last_error != null ? publicErrorCode(row.last_error) : undefined,
    poll_seconds: row.poll_seconds,
  };
  if (row.has_secret === true) out.has_secret = true;
  Object.keys(out).forEach((k) => { if (out[k] == null) delete out[k]; });
  return out;
}

function publicResult(result) {
  if (!result || typeof result !== 'object') {
    return { ok: false, status: 500, error: 'calendar_bridge_failed' };
  }
  const rawCode = result.ok ? null : (result.error || result.reason);
  const code = result.ok ? null : publicErrorCode(rawCode);
  const skipped = sanitizeSkipped(result.skipped);
  const out = {
    ok: !!result.ok,
    success: !!result.ok,
    status: typeof result.status === 'number' ? result.status : undefined,
    error: code,
    reason: code,
    keepLastBlocks: result.keepLastBlocks === true,
    wrote: result.wrote === true,
    connections: Array.isArray(result.connections)
      ? result.connections.map(publicConnection)
      : undefined,
    connection: result.connection ? publicConnection(result.connection) : undefined,
    maps: publicMaps(result.maps),
    skipped: skipped.length ? skipped : undefined,
    dry_run: result.dry_run === true,
    empty: result.empty === true,
    deleted: result.deleted === true ? true : undefined,
    write_count: typeof result.write_count === 'number' ? result.write_count : undefined,
    next_status: typeof result.next_status === 'string' ? result.next_status : undefined,
    keep_last_blocks: result.keep_last_blocks === true || result.keepLastBlocks === true,
  };
  Object.keys(out).forEach((k) => { if (out[k] == null) delete out[k]; });
  return out;
}

function rejectCallerAuthority(body) {
  if (dtoHasAuthority(body)) {
    return { ok: false, status: 400, error: 'caller_authority_rejected' };
  }
  return null;
}

function sanitizeConnection(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    spreadsheet_id: row.spreadsheet_id,
    sheet_name: row.sheet_name,
    last_success_at: row.last_success_at,
    last_attempt_at: row.last_attempt_at,
    last_error: row.last_error_code ? publicErrorCode(row.last_error_code) : null,
    has_secret: !!row.secret_ref,
    poll_seconds: row.poll_seconds,
  };
}

async function handleList(pg, clientSlug) {
  const client = await pg.query(`SELECT id FROM clients WHERE slug = $1`, [clientSlug]);
  if (!client.rows[0]) return { ok: false, status: 404, error: 'client_not_found' };
  const r = await pg.query(
    `SELECT c.id, c.name, c.kind, c.status, c.spreadsheet_id, c.sheet_name,
            c.last_success_at, c.last_attempt_at, c.last_error_code, c.poll_seconds,
            s.secret_ref
       FROM external_calendar_connections c
       LEFT JOIN external_calendar_secrets s ON s.connection_id = c.id
      WHERE c.client_id = $1
      ORDER BY c.created_at ASC`,
    [client.rows[0].id]
  );
  return { ok: true, connections: r.rows.map(sanitizeConnection) };
}

async function handleSave(pg, clientSlug, body, actorId) {
  const name = String(body.name || '').trim().slice(0, 120);
  const spreadsheetId = String(body.spreadsheet_id || '').trim();
  const sheetName = String(body.sheet_name || 'inventory').trim().slice(0, 80);
  const secretRef = String(body.secret_ref || '').trim();
  if (!name || spreadsheetId.length < 8) {
    return { ok: false, status: 400, error: 'invalid_connection' };
  }
  if (secretRef && !/^[A-Z][A-Z0-9_]{2,80}$/.test(secretRef)) {
    return { ok: false, status: 400, error: 'secret_ref_invalid' };
  }
  const client = await pg.query(`SELECT id FROM clients WHERE slug = $1`, [clientSlug]);
  if (!client.rows[0]) return { ok: false, status: 404, error: 'client_not_found' };
  const clientId = client.rows[0].id;
  await pg.query('BEGIN');
  try {
    let id = body.id ? String(body.id) : null;
    if (id) {
      const upd = await pg.query(
        `UPDATE external_calendar_connections
            SET name = $2, spreadsheet_id = $3, sheet_name = $4, updated_at = NOW()
          WHERE id = $1::uuid AND client_id = $5
          RETURNING *`,
        [id, name, spreadsheetId, sheetName, clientId]
      );
      if (!upd.rows[0]) {
        await pg.query('ROLLBACK');
        return { ok: false, status: 404, error: 'connection_not_found' };
      }
    } else {
      const ins = await pg.query(
        `INSERT INTO external_calendar_connections (
            client_id, kind, name, status, spreadsheet_id, sheet_name, created_by_staff_id
          ) VALUES ($1,'gsheet',$2,'disabled',$3,$4,$5)
          RETURNING *`,
        [clientId, name, spreadsheetId, sheetName, actorId || null]
      );
      id = ins.rows[0].id;
    }
    if (secretRef) {
      await pg.query(
        `INSERT INTO external_calendar_secrets (connection_id, secret_ref)
         VALUES ($1,$2)
         ON CONFLICT (connection_id) DO UPDATE SET secret_ref = EXCLUDED.secret_ref, updated_at = NOW()`,
        [id, secretRef]
      );
    }
    const row = await pg.query(
      `SELECT c.id, c.name, c.kind, c.status, c.spreadsheet_id, c.sheet_name,
              c.last_success_at, c.last_attempt_at, c.last_error_code, c.poll_seconds,
              s.secret_ref
         FROM external_calendar_connections c
         LEFT JOIN external_calendar_secrets s ON s.connection_id = c.id
        WHERE c.id = $1 AND c.client_id = $2`,
      [id, clientId]
    );
    await pg.query('COMMIT');
    return { ok: true, connection: sanitizeConnection(row.rows[0]) };
  } catch (err) {
    await pg.query('ROLLBACK');
    return { ok: false, status: 500, error: 'save_failed' };
  }
}

async function handleSaveMaps(pg, clientSlug, connectionId, maps) {
  const need = requireConnectionId(connectionId);
  if (!need.ok) return need;
  connectionId = need.id;
  if (!Array.isArray(maps)) return { ok: false, status: 400, error: 'maps_array_required' };
  const client = await pg.query(`SELECT id FROM clients WHERE slug = $1`, [clientSlug]);
  if (!client.rows[0]) return { ok: false, status: 404, error: 'client_not_found' };
  const clientId = client.rows[0].id;
  await pg.query('BEGIN');
  try {
    const conn = await pg.query(
      `SELECT id FROM external_calendar_connections WHERE id = $1::uuid AND client_id = $2 FOR UPDATE`,
      [connectionId, clientId]
    );
    if (!conn.rows[0]) {
      await pg.query('ROLLBACK');
      return { ok: false, status: 404, error: 'connection_not_found' };
    }
    await pg.query(
      `DELETE FROM external_calendar_unit_maps WHERE connection_id = $1 AND client_id = $2`,
      [connectionId, clientId]
    );
    for (const m of maps) {
      const key = String(m.external_unit_key || '').trim();
      const bedId = String(m.bed_id || '').trim();
      if (!key || !bedId) {
        await pg.query('ROLLBACK');
        return { ok: false, status: 400, error: 'invalid_map' };
      }
      const bed = await pg.query(
        `SELECT id FROM beds WHERE id = $1::uuid AND client_id = $2`,
        [bedId, clientId]
      );
      if (!bed.rows[0]) {
        await pg.query('ROLLBACK');
        return { ok: false, status: 400, error: 'bed_not_in_tenant' };
      }
      await pg.query(
        `INSERT INTO external_calendar_unit_maps (connection_id, client_id, external_unit_key, bed_id)
         VALUES ($1,$2,$3,$4::uuid)`,
        [connectionId, clientId, key, bedId]
      );
    }
    await pg.query('COMMIT');
    return { ok: true, count: maps.length };
  } catch (err) {
    await pg.query('ROLLBACK');
    return { ok: false, status: 500, error: 'maps_save_failed' };
  }
}

async function handleEnable(pg, clientSlug, connectionId, enabled) {
  const need = requireConnectionId(connectionId);
  if (!need.ok) return need;
  connectionId = need.id;
  const client = await pg.query(`SELECT id FROM clients WHERE slug = $1`, [clientSlug]);
  if (!client.rows[0]) return { ok: false, status: 404, error: 'client_not_found' };
  const status = enabled ? 'pending' : 'disabled';
  const r = await pg.query(
    `UPDATE external_calendar_connections
        SET status = $3, updated_at = NOW()
      WHERE id = $1::uuid AND client_id = $2
      RETURNING id, status`,
    [connectionId, client.rows[0].id, status]
  );
  if (!r.rows[0]) return { ok: false, status: 404, error: 'connection_not_found' };
  return { ok: true, connection: r.rows[0] };
}

async function handleListMaps(pg, clientSlug, connectionId) {
  const need = requireConnectionId(connectionId);
  if (!need.ok) return need;
  connectionId = need.id;
  const client = await pg.query(`SELECT id FROM clients WHERE slug = $1`, [clientSlug]);
  if (!client.rows[0]) return { ok: false, status: 404, error: 'client_not_found' };
  const r = await pg.query(
    `SELECT m.external_unit_key, m.bed_id, b.bed_code
       FROM external_calendar_unit_maps m
       JOIN beds b ON b.id = m.bed_id AND b.client_id = m.client_id
      WHERE m.connection_id = $1::uuid AND m.client_id = $2`,
    [connectionId, client.rows[0].id]
  );
  return { ok: true, maps: r.rows };
}

async function handleDelete(pg, clientSlug, connectionId, body) {
  const need = requireConnectionId(connectionId);
  if (!need.ok) return need;
  connectionId = need.id;
  const confirmName = String((body && body.confirm_name) || '').trim();
  if (!confirmName) return { ok: false, status: 400, error: 'confirm_name_required' };
  const client = await pg.query(`SELECT id FROM clients WHERE slug = $1`, [clientSlug]);
  if (!client.rows[0]) return { ok: false, status: 404, error: 'client_not_found' };
  const clientId = client.rows[0].id;
  await pg.query('BEGIN');
  try {
    const locked = await pg.query(
      `SELECT c.id, c.client_id, c.name, c.status
         FROM external_calendar_connections c
        WHERE c.id = $1::uuid AND c.client_id = $2
        FOR UPDATE`,
      [connectionId, clientId]
    );
    if (!locked.rows[0]) {
      await pg.query('ROLLBACK');
      return { ok: false, status: 404, error: 'connection_not_found' };
    }
    const conn = locked.rows[0];
    if (conn.status !== 'disabled') {
      await pg.query('ROLLBACK');
      return { ok: false, status: 409, error: 'connection_not_disabled' };
    }
    if (String(conn.name || '').trim() !== confirmName) {
      await pg.query('ROLLBACK');
      return { ok: false, status: 400, error: 'confirm_name_mismatch' };
    }
    await pg.query(
      `DELETE FROM booking_beds bb
        WHERE bb.client_id = $1
          AND bb.assignment_type = 'external_inventory_block'
          AND EXISTS (
            SELECT 1
              FROM bookings bk
             WHERE bk.id = bb.booking_id
               AND bk.client_id = $1
               AND bk.metadata -> 'external_calendar' ->> 'connection_id' = $2
          )`,
      [clientId, String(connectionId)]
    );
    await pg.query(
      `DELETE FROM bookings bk
        WHERE bk.client_id = $1
          AND bk.metadata -> 'external_calendar' ->> 'connection_id' = $2
          AND NOT EXISTS (
            SELECT 1
              FROM booking_beds bb
             WHERE bb.booking_id = bk.id
               AND bb.client_id = bk.client_id
          )`,
      [clientId, String(connectionId)]
    );
    const gone = await pg.query(
      `DELETE FROM external_calendar_connections
        WHERE id = $1::uuid AND client_id = $2 AND status = 'disabled'
        RETURNING id`,
      [connectionId, clientId]
    );
    if (!gone.rows[0]) {
      await pg.query('ROLLBACK');
      return { ok: false, status: 409, error: 'connection_not_disabled' };
    }
    await pg.query('COMMIT');
    return { ok: true, deleted: true, connection: { id: connectionId } };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
    return { ok: false, status: 500, error: 'delete_failed' };
  }
}

async function handleRealProbe(pg, { clientSlug, connectionId, fetchSheet }) {
  const need = requireConnectionId(connectionId);
  if (!need.ok) return need;
  connectionId = need.id;
  const locked = await loadLockedState(pg, { clientSlug, connectionId });
  if (!locked.ok) return { ok: false, status: 404, error: publicErrorCode(locked.reason) };
  const fetched = await fetchSheet(locked.connection);
  if (!fetched.ok) {
    return {
      ok: false,
      status: 422,
      error: publicErrorCode(fetched.reason),
      keep_last_blocks: true,
      next_status: nextConnectionStatus(locked.connection.status, { ok: false }),
    };
  }
  const plan = probeSheetRows(fetched.rows, {
    maps: locked.maps,
    occupancy: locked.occupancy,
    connectionId: locked.connection.id,
  });
  const next = nextConnectionStatus(locked.connection.status, plan);
  if (!plan.ok) {
    return {
      ok: false,
      status: 422,
      error: publicErrorCode(plan.reason),
      keep_last_blocks: true,
      next_status: next,
      skipped: sanitizeSkipped(plan.skipped || []),
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
  handleList,
  handleSave,
  handleSaveMaps,
  handleEnable,
  handleListMaps,
  handleDelete,
  handleRealProbe,
  requireConnectionId,
  publicResult,
  runConnectionSync,
  sanitizeSkipped,
  sanitizeAuditFields,
};
