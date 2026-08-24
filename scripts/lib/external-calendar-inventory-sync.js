'use strict';

/**
 * One-transaction owner-schedule sync.
 * Fetch happens outside the lock. Writes are BEGIN..COMMIT on one client.
 */

const {
  probeSheetRows,
  nextConnectionStatus,
  ASSIGNMENT_TYPE,
  generateOwnerBlockCode,
  buildOwnedBlockMetadata,
  CALENDAR_LEGEND_EN,
} = require('./external-calendar-inventory');

const FORBIDDEN_DTO = ['rows', 'occupancy', 'connection_id', 'credentials', 'secret', 'private_key', 'access_token'];

function dtoHasAuthority(body) {
  if (!body || typeof body !== 'object') return false;
  return FORBIDDEN_DTO.some((k) => Object.prototype.hasOwnProperty.call(body, k));
}

async function loadLockedState(pg, { clientSlug, connectionId }) {
  const client = await pg.query(`SELECT id, slug FROM clients WHERE slug = $1 LIMIT 1`, [clientSlug]);
  if (!client.rows[0]) return { ok: false, reason: 'client_not_found' };
  const clientId = client.rows[0].id;

  const connRes = connectionId
    ? await pg.query(
      `SELECT c.id, c.client_id, c.kind, c.name, c.status, c.spreadsheet_id, c.sheet_name,
              c.poll_seconds, c.stale_after, c.last_success_at, c.last_attempt_at, c.last_error,
              s.secret_ref
         FROM external_calendar_connections c
         LEFT JOIN external_calendar_secrets s ON s.connection_id = c.id
        WHERE c.id = $1::uuid AND c.client_id = $2
        FOR UPDATE OF c`,
      [connectionId, clientId]
    )
    : await pg.query(
      `SELECT c.id, c.client_id, c.kind, c.name, c.status, c.spreadsheet_id, c.sheet_name,
              c.poll_seconds, c.stale_after, c.last_success_at, c.last_attempt_at, c.last_error,
              s.secret_ref
         FROM external_calendar_connections c
         LEFT JOIN external_calendar_secrets s ON s.connection_id = c.id
        WHERE c.client_id = $1
        ORDER BY c.created_at ASC
        LIMIT 1
        FOR UPDATE OF c`,
      [clientId]
    );
  const connection = connRes.rows[0] || null;
  if (!connection) return { ok: false, reason: 'connection_not_found', clientId };

  const mapsRes = await pg.query(
    `SELECT m.id AS map_id, m.external_unit_key, m.bed_id
       FROM external_calendar_unit_maps m
       JOIN beds b ON b.id = m.bed_id AND b.client_id = m.client_id
      WHERE m.connection_id = $1 AND m.client_id = $2`,
    [connection.id, clientId]
  );
  const maps = {};
  mapsRes.rows.forEach((r) => { maps[r.external_unit_key] = r.bed_id; });

  const occRes = await pg.query(
    `SELECT bb.bed_id, bb.assignment_type, bb.assignment_start_date, bb.assignment_end_date,
            bb.booking_id, bk.status, bk.metadata
       FROM booking_beds bb
       JOIN bookings bk ON bk.id = bb.booking_id
      WHERE bb.client_id = $1
        AND bk.client_id = $1
        AND bk.status::text NOT IN ('cancelled', 'expired')`,
    [clientId]
  );
  const occupancy = {};
  occRes.rows.forEach((r) => {
    if (!occupancy[r.bed_id]) occupancy[r.bed_id] = [];
    occupancy[r.bed_id].push({
      assignment_type: r.assignment_type,
      assignment_start_date: r.assignment_start_date,
      assignment_end_date: r.assignment_end_date,
      booking_id: r.booking_id,
      status: r.status,
      metadata: r.metadata,
      external_uid: r.metadata && r.metadata.external_calendar
        ? r.metadata.external_calendar.external_uid : null,
    });
  });
  return { ok: true, clientId, connection, maps, occupancy, mapRows: mapsRes.rows };
}

async function persistOwnedWrites(pg, { clientId, connection, plan }) {
  const results = [];
  for (const op of plan.writes || []) {
    if (op.action === 'cancel_owned_if_present') {
      const found = await pg.query(
        `SELECT bk.id
           FROM bookings bk
          WHERE bk.client_id = $1
            AND bk.metadata->'external_calendar'->>'connection_id' = $2
            AND bk.metadata->'external_calendar'->>'external_uid' = $3
            AND bk.status::text NOT IN ('cancelled', 'expired')`,
        [clientId, String(connection.id), op.external_uid]
      );
      for (const row of found.rows) {
        await pg.query(
          `UPDATE bookings SET status = 'cancelled', updated_at = NOW()
            WHERE id = $1 AND client_id = $2`,
          [row.id, clientId]
        );
        await pg.query(
          `UPDATE external_inventory_events
              SET status = 'tombstoned', booking_id = $1, updated_at = NOW()
            WHERE connection_id = $2 AND client_id = $3 AND external_uid = $4`,
          [row.id, connection.id, clientId, op.external_uid]
        );
        results.push({ action: 'cancel', booking_id: row.id });
      }
      continue;
    }
    if (op.action !== 'insert_owned' && op.action !== 'upsert_owned') continue;

    const existing = await pg.query(
      `SELECT bk.id
         FROM bookings bk
        WHERE bk.client_id = $1
          AND bk.metadata->'external_calendar'->>'connection_id' = $2
          AND bk.metadata->'external_calendar'->>'external_uid' = $3
          AND bk.status::text NOT IN ('cancelled', 'expired')
        LIMIT 1`,
      [clientId, String(connection.id), op.external_uid]
    );
    const meta = buildOwnedBlockMetadata(connection.id, op.external_uid);
    if (existing.rows[0]) {
      const bookingId = existing.rows[0].id;
      await pg.query(
        `UPDATE bookings
            SET check_in = $2::date, check_out = $3::date, updated_at = NOW(),
                metadata = $4::jsonb
          WHERE id = $1 AND client_id = $5`,
        [bookingId, op.start_date, op.end_date, JSON.stringify(meta), clientId]
      );
      await pg.query(
        `UPDATE booking_beds
            SET assignment_start_date = $2::date,
                assignment_end_date = $3::date,
                bed_id = $4
          WHERE booking_id = $1 AND client_id = $5 AND assignment_type = $6`,
        [bookingId, op.start_date, op.end_date, op.bed_id, clientId, ASSIGNMENT_TYPE]
      );
      await pg.query(
        `INSERT INTO external_inventory_events (
            connection_id, client_id, external_uid, period_start, period_end,
            booking_id, status
          ) VALUES ($1,$2,$3,$4::date,$5::date,$6,'imported')
          ON CONFLICT (connection_id, external_uid) DO UPDATE
            SET period_start = EXCLUDED.period_start,
                period_end = EXCLUDED.period_end,
                booking_id = EXCLUDED.booking_id,
                status = 'imported',
                updated_at = NOW()`,
        [connection.id, clientId, op.external_uid, op.start_date, op.end_date, bookingId]
      );
      results.push({ action: 'upsert', booking_id: bookingId });
      continue;
    }

    const bookingCode = generateOwnerBlockCode(op.start_date);
    const ins = await pg.query(
      `INSERT INTO bookings (
          client_id, booking_code, guest_name, phone, status, payment_status,
          assignment_status, check_in, check_out, guest_count, booking_source,
          staff_notes, metadata
        ) VALUES (
          $1, $2, $3, 'owner-schedule', 'blocked', 'not_requested',
          'assigned', $4::date, $5::date, 1, 'other', $6, $7::jsonb
        ) RETURNING id`,
      [
        clientId, bookingCode, CALENDAR_LEGEND_EN,
        op.start_date, op.end_date,
        'Owner schedule block from Google Sheet',
        JSON.stringify(meta),
      ]
    );
    const bookingId = ins.rows[0].id;
    await pg.query(
      `INSERT INTO booking_beds (
          client_id, booking_id, bed_id, assignment_type, assignment_notes,
          assignment_start_date, assignment_end_date
        ) VALUES ($1,$2,$3,$4,$5,$6::date,$7::date)`,
      [clientId, bookingId, op.bed_id, ASSIGNMENT_TYPE, CALENDAR_LEGEND_EN, op.start_date, op.end_date]
    );
    await pg.query(
      `INSERT INTO external_inventory_events (
          connection_id, client_id, external_uid, period_start, period_end,
          booking_id, status
        ) VALUES ($1,$2,$3,$4::date,$5::date,$6,'imported')
        ON CONFLICT (connection_id, external_uid) DO UPDATE
          SET period_start = EXCLUDED.period_start,
              period_end = EXCLUDED.period_end,
              booking_id = EXCLUDED.booking_id,
              status = 'imported',
              updated_at = NOW()`,
      [connection.id, clientId, op.external_uid, op.start_date, op.end_date, bookingId]
    );
    results.push({ action: 'insert', booking_id: bookingId });
  }
  return results;
}

async function markAttempt(pg, connection, patch) {
  await pg.query(
    `UPDATE external_calendar_connections
        SET last_attempt_at = NOW(),
            last_error = $2,
            status = $3,
            last_success_at = CASE WHEN $4 THEN NOW() ELSE last_success_at END,
            updated_at = NOW()
      WHERE id = $1`,
    [connection.id, patch.last_error || null, patch.status, patch.success === true]
  );
}

/**
 * @param {object} args.fetchSheet - required owner; tests inject this.
 */
async function runConnectionSync(pg, args) {
  const fetched = args.fetched;
  if (!fetched) {
    return { ok: false, wrote: false, keepLastBlocks: true, reason: 'sheet_fetch_required' };
  }
  if (!fetched.ok) {
    await pg.query('BEGIN');
    try {
      const locked = await loadLockedState(pg, args);
      if (locked.ok) {
        const status = nextConnectionStatus(locked.connection.status, { ok: false, reason: fetched.reason });
        await markAttempt(pg, locked.connection, {
          last_error: fetched.reason,
          status,
          success: false,
        });
      }
      await pg.query('COMMIT');
      return { ok: false, wrote: false, keepLastBlocks: true, reason: fetched.reason };
    } catch (err) {
      await pg.query('ROLLBACK');
      throw err;
    }
  }

  await pg.query('BEGIN');
  try {
    const locked = await loadLockedState(pg, args);
    if (!locked.ok) {
      await pg.query('ROLLBACK');
      return { ok: false, wrote: false, keepLastBlocks: true, reason: locked.reason };
    }
    const plan = probeSheetRows(fetched.rows, {
      maps: locked.maps,
      occupancy: locked.occupancy,
      connectionId: locked.connection.id,
    });
    if (!plan.ok || plan.empty) {
      const status = nextConnectionStatus(locked.connection.status, plan);
      await markAttempt(pg, locked.connection, {
        last_error: plan.ok ? (plan.empty ? 'empty_sheet' : null) : plan.reason,
        status,
        success: false,
      });
      await pg.query('COMMIT');
      return {
        ok: plan.ok === true,
        wrote: false,
        keepLastBlocks: true,
        reason: plan.empty ? 'empty_sheet' : plan.reason,
        status,
        skipped: plan.skipped || [],
      };
    }
    const persisted = await persistOwnedWrites(pg, {
      clientId: locked.clientId,
      connection: locked.connection,
      plan,
    });
    await markAttempt(pg, locked.connection, { last_error: null, status: 'healthy', success: true });
    await pg.query('COMMIT');
    return { ok: true, wrote: persisted.length > 0, persisted, status: 'healthy' };
  } catch (err) {
    try { await pg.query('ROLLBACK'); } catch (_) { /* ignore */ }
    return { ok: false, wrote: false, keepLastBlocks: true, reason: 'sync_rollback', error: String(err && err.message || err) };
  }
}

function listDueSql() {
  return `
    SELECT c.id, cl.slug AS client_slug
      FROM external_calendar_connections c
      JOIN clients cl ON cl.id = c.client_id
     WHERE c.kind = 'gsheet'
       AND cl.slug = 'wolfhouse-somo'
       AND c.status IN ('pending','healthy','stale')
       AND (
         c.last_attempt_at IS NULL
         OR c.last_attempt_at + (c.poll_seconds * interval '1 second') <= NOW()
         OR (c.last_success_at IS NOT NULL AND c.last_success_at + c.stale_after <= NOW() AND c.status = 'healthy')
       )`;
}

function createSyncScheduler(opts) {
  opts = opts || {};
  const intervalMs = Number(opts.intervalMs || 60000);
  let timer = null;
  async function tick() {
    if (!opts.withPgClient) return;
    const due = opts.listDueConnections
      ? await opts.listDueConnections()
      : await opts.withPgClient(async (pg) => (await pg.query(listDueSql())).rows);
    for (const item of due || []) {
      try {
        await opts.withPgClient(async (pg) => {
          const fetched = await opts.fetchSheet(item);
          return runConnectionSync(pg, {
            clientSlug: item.client_slug,
            connectionId: item.id,
            fetched,
          });
        });
      } catch (_) { /* per-connection fail closed */ }
    }
  }
  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}

module.exports = {
  dtoHasAuthority,
  FORBIDDEN_DTO,
  loadLockedState,
  persistOwnedWrites,
  runConnectionSync,
  createSyncScheduler,
  listDueSql,
  markAttempt,
};
