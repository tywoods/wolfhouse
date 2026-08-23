'use strict';

/**
 * Persistent sync: load tenant-scoped DB state, probe, write owned XBLK only.
 * Fail-closed plans perform zero occupancy writes.
 */

const {
  probeSheetRows,
  nextConnectionStatus,
  ASSIGNMENT_TYPE,
  generateOwnerBlockCode,
  buildOwnedBlockMetadata,
  CALENDAR_LEGEND_EN,
} = require('./external-calendar-inventory');

async function loadBridgeState(pg, { clientSlug, connectionId }) {
  const client = await pg.query(
    `SELECT id, slug FROM clients WHERE slug = $1 LIMIT 1`,
    [clientSlug]
  );
  if (!client.rows[0]) return { ok: false, reason: 'client_not_found' };
  const clientId = client.rows[0].id;

  const connRes = connectionId
    ? await pg.query(
      `SELECT c.*, s.secret_ref
         FROM external_calendar_connections c
         LEFT JOIN external_calendar_secrets s ON s.connection_id = c.id
        WHERE c.id = $1::uuid AND c.client_id = $2
        FOR UPDATE`,
      [connectionId, clientId]
    )
    : await pg.query(
      `SELECT c.*, s.secret_ref
         FROM external_calendar_connections c
         LEFT JOIN external_calendar_secrets s ON s.connection_id = c.id
        WHERE c.client_id = $1
        ORDER BY c.created_at ASC
        LIMIT 1
        FOR UPDATE`,
      [clientId]
    );
  const connection = connRes.rows[0] || null;
  if (!connection) return { ok: false, reason: 'connection_not_found', clientId };

  const mapsRes = await pg.query(
    `SELECT m.external_unit_key, m.bed_id, m.id AS map_id
       FROM external_calendar_unit_maps m
       JOIN beds b ON b.id = m.bed_id
      WHERE m.connection_id = $1 AND m.client_id = $2 AND b.client_id = $2`,
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
        AND bk.status::text NOT IN ('cancelled', 'expired')`,
    [clientId]
  );
  const occupancy = {};
  occRes.rows.forEach((r) => {
    const bedId = r.bed_id;
    if (!occupancy[bedId]) occupancy[bedId] = [];
    occupancy[bedId].push({
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

  return { ok: true, clientId, connection, maps, occupancy };
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

async function persistOwnedWrites(pg, { clientId, connection, plan }) {
  const results = [];
  for (const op of plan.writes || []) {
    if (op.action === 'cancel_owned_if_present') {
      const found = await pg.query(
        `SELECT bk.id
           FROM bookings bk
           JOIN booking_beds bb ON bb.booking_id = bk.id
          WHERE bk.client_id = $1
            AND bb.bed_id = $2
            AND bb.assignment_type = $3
            AND bk.metadata->'external_calendar'->>'connection_id' = $4
            AND bk.metadata->'external_calendar'->>'external_uid' = $5
            AND bk.status::text NOT IN ('cancelled', 'expired')`,
        [clientId, op.bed_id, ASSIGNMENT_TYPE, String(connection.id), op.external_uid]
      );
      for (const row of found.rows) {
        await pg.query(
          `UPDATE bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND client_id = $2`,
          [row.id, clientId]
        );
        results.push({ action: 'cancel', booking_id: row.id });
      }
      continue;
    }
    if (op.action === 'insert_owned' || op.action === 'upsert_owned') {
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
        await pg.query(
          `UPDATE bookings
              SET check_in = $2::date, check_out = $3::date, updated_at = NOW()
            WHERE id = $1 AND client_id = $4`,
          [existing.rows[0].id, op.start_date, op.end_date, clientId]
        );
        await pg.query(
          `UPDATE booking_beds
              SET assignment_start_date = $2::date, assignment_end_date = $3::date
            WHERE booking_id = $1 AND client_id = $4`,
          [existing.rows[0].id, op.start_date, op.end_date, clientId]
        );
        results.push({ action: 'upsert', booking_id: existing.rows[0].id });
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
            'assigned', $4::date, $5::date, 1, 'other',
            $6, $7::jsonb
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
          ) VALUES ($1, $2, $3, $4, $5, $6::date, $7::date)`,
        [
          clientId, bookingId, op.bed_id, ASSIGNMENT_TYPE,
          CALENDAR_LEGEND_EN, op.start_date, op.end_date,
        ]
      );
      await pg.query(
        `INSERT INTO external_inventory_events (
            connection_id, client_id, external_uid, period_start, period_end,
            booking_id, status
          ) VALUES ($1, $2, $3, $4::date, $5::date, $6, 'imported')
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
  }
  return results;
}

async function runConnectionSync(pg, args) {
  const loaded = await loadBridgeState(pg, args);
  if (!loaded.ok) {
    return { ok: false, wrote: false, keepLastBlocks: true, reason: loaded.reason };
  }
  const plan = probeSheetRows(args.rows, {
    maps: loaded.maps,
    occupancy: loaded.occupancy,
    connectionId: loaded.connection.id,
  });
  if (!plan.ok || plan.empty) {
    const status = nextConnectionStatus(loaded.connection.status, plan);
    await markAttempt(pg, loaded.connection, {
      last_error: plan.ok ? (plan.empty ? 'empty_sheet' : null) : plan.reason,
      status,
      success: false,
    });
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
    clientId: loaded.clientId,
    connection: loaded.connection,
    plan,
  });
  await markAttempt(pg, loaded.connection, {
    last_error: null,
    status: 'healthy',
    success: true,
  });
  return { ok: true, wrote: persisted.length > 0, persisted, status: 'healthy' };
}

function createSyncScheduler(opts) {
  opts = opts || {};
  const intervalMs = Number(opts.intervalMs || 60000);
  let timer = null;
  async function tick() {
    if (!opts.withPgClient || !opts.listDueConnections) return;
    const due = await opts.listDueConnections();
    for (const item of due || []) {
      try {
        await opts.withPgClient((pg) => opts.syncOne(pg, item));
      } catch (_) { /* fail closed per connection */ }
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
  loadBridgeState,
  persistOwnedWrites,
  runConnectionSync,
  createSyncScheduler,
  markAttempt,
};
