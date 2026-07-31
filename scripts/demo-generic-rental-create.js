'use strict';
/**
 * DEMO (not a gate): drive the REAL createSunsetScheduleBooking end-to-end with a
 * simulated Postgres that has a disposable kayak_rental offering + €25 half-day
 * price + stock. Shows the generic-rental create working without an env toggle:
 * 201 + total, idempotent replay, and 409 on same-key quantity change.
 * In-process only — no DB, no network.
 */
const { createSunsetScheduleBooking } = require('./lib/sunset-schedule-booking-writes');

function parseMeta(m) { try { return typeof m === 'string' ? JSON.parse(m) : (m || {}); } catch (_) { return {}; } }

function buildDemoPg() {
  const state = { clientId: '11111111-1111-1111-1111-111111111111', bookings: [], serviceRecords: [], idempotency: new Map() };
  const offering = {
    id: 'ro-1', client_slug: 'sunset', location_id: 'sunset-somo',
    offering_key: 'kayak_rental', label: 'Kayak (DEMO)', group_key: 'sup',
    excludes: '[]', sort_order: 5, active: true, stock_quantity: 10,
  };
  return {
    state,
    query: async (sql, params) => {
      const q = String(sql);
      if (/SELECT id FROM clients WHERE slug/i.test(q)) return { rows: [{ id: state.clientId }] };
      if (/BEGIN|COMMIT|ROLLBACK/i.test(q)) return { rows: [] };
      if (/pg_advisory_xact_lock/i.test(q)) return { rows: [{}] };
      // Generic rental catalog + stock lock rows.
      if (/FROM tenant_rental_offerings/i.test(q)) {
        return { rows: [offering] };
      }
      // tenant_price_rules exists, and has all optional columns.
      if (/to_regclass/i.test(q) && /tenant_price_rules/i.test(q)) return { rows: [{ reg: 'public.tenant_price_rules' }] };
      if (/information_schema\.columns/i.test(q) && params && params[0] === 'tenant_price_rules') return { rows: [{ '?column?': 1 }] };
      // The kayak half-day price row (€25/session).
      if (/FROM tenant_price_rules/i.test(q) && /amount_cents/i.test(q)) {
        return { rows: [{ amount_cents: 2500, currency: 'EUR', item_type: 'rental', item_code: 'kayak_rental__half_day', unit: 'session', location_id: 'sunset-somo' }] };
      }
      // Active stock reservations (none).
      if (/booking_service_records/i.test(q) && /NOT IN \('cancelled'/i.test(q)) {
        return { rows: [], rowCount: 0 };
      }
      // Idempotency lookup.
      if (/metadata->>'idempotency_key'/i.test(q)) {
        const key = params[1]; const clientSlug = params[0];
        const rows = (state.idempotency.get(key) || []).filter((r) => !(r.client_slug && clientSlug && r.client_slug !== clientSlug));
        return { rows: rows.map((row) => ({ ...row, location_id: (row.metadata && row.metadata.location_id) || null, idempotency_intent_fp: (row.metadata && row.metadata.idempotency_intent_fp) || null, idempotency_key: (row.metadata && row.metadata.idempotency_key) || key })) };
      }
      if (/INSERT INTO bookings/i.test(q)) {
        const meta = parseMeta(params[8]);
        const row = { id: `bk-${state.bookings.length + 1}`, booking_code: params[1], metadata: meta };
        state.bookings.push(row);
        return { rows: [{ id: row.id, booking_code: row.booking_code }] };
      }
      if (/INSERT INTO booking_service_records/i.test(q)) {
        // Generic insert: ($1 client,$2 booking,$3 code,$4 guest,$5 service_type,$6 date,
        //  $7 qty,'confirmed',$8 amount_due,0,$9 payment,$10 source,$11 metadata)
        const metaParam = [params[10], params[9]].find((p) => typeof p === 'string' && p.trim().startsWith('{'));
        const meta = parseMeta(metaParam);
        const row = {
          service_record_id: `sr-${state.serviceRecords.length + 1}`, booking_id: params[1], booking_code: params[2],
          guest_name: params[3], service_type: params[4], service_date: params[5], quantity: params[6],
          amount_due_cents: params[7], client_slug: params[0], metadata: meta,
          offering_key: meta.offering_key || null, staff_ui_service_type: meta.staff_ui_service_type || null,
        };
        state.serviceRecords.push(row);
        if (meta.idempotency_key) { const l = state.idempotency.get(meta.idempotency_key) || []; l.push(row); state.idempotency.set(meta.idempotency_key, l); }
        return { rows: [row] };
      }
      if (/COALESCE\(SUM/i.test(q) && /booking_service_records/i.test(q)) return { rows: [{ seats: 0 }] };
      if (/UPDATE\s+booking_service_records/i.test(q) || /UPDATE\s+bookings/i.test(q)) return { rows: [], rowCount: 1 };
      if (/ALTER TABLE|CREATE\s+(TABLE|INDEX)/i.test(q)) return { rows: [] };
      if (/to_regclass/i.test(q)) return { rows: [{ reg: null }] };
      if (/information_schema/i.test(q)) return { rows: [] };
      return { rows: [] };
    },
  };
}

function kayakBody(extra) {
  return Object.assign({
    guest_name: 'Demo Guest', guest_phone: '+34600111222', surfer_count: 2,
    date_from: '2026-08-01', date_to: '2026-08-01', payment_status: 'unpaid',
    rentals: [{ offering_key: 'kayak_rental', duration_key: 'half_day', quantity: 2 }],
  }, extra || {});
}

(async () => {
  // No env flag — catalog membership + price + stock are the gates.
  delete process.env.GENERIC_RENTAL_CREATE_ENABLED;
  const actor = { email: 'ops@sunset.test' };
  const pg = buildDemoPg();

  console.log('\n=== DEMO: generic kayak rental create (catalog-gated, no env flag) ===\n');

  const create = await createSunsetScheduleBooking(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', actor, body: kayakBody({ idempotency_key: 'demo-k1' }) });
  console.log('CREATE  status', create.status);
  console.log('        booking_code', create.body && create.body.booking_code, '| total_cents', create.body && create.body.total_cents, '| source', create.body && create.body.sunset_price_source);
  // The persisted DB row (raw): service_type addon_service; metadata carries identity.
  const dbRow = pg.state.serviceRecords[0];
  console.log('        DB record →', dbRow && JSON.stringify({ service_type: dbRow.service_type, quantity: dbRow.quantity, amount_due_cents: dbRow.amount_due_cents, offering_key: dbRow.metadata.offering_key, item_code: dbRow.metadata.item_code, duration_key: dbRow.metadata.duration_key, unit_cents: dbRow.metadata.unit_cents, location_id: dbRow.metadata.location_id }));
  const uiRow = (create.body && create.body.records || [])[0];
  console.log('        UI view →', uiRow && JSON.stringify({ service_type: uiRow.service_type, quantity: uiRow.quantity }), '(addon_service surfaces as "rental" to staff)');

  const replay = await createSunsetScheduleBooking(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', actor, body: kayakBody({ idempotency_key: 'demo-k1' }) });
  console.log('\nREPLAY  status', replay.status, '(same key, same intent) → booking_code', replay.body && replay.body.booking_code);
  console.log('        same booking as create?', (replay.body && replay.body.booking_code) === (create.body && create.body.booking_code));

  const conflict = await createSunsetScheduleBooking(pg, { clientSlug: 'sunset', locationId: 'sunset-somo', actor, body: kayakBody({ idempotency_key: 'demo-k1', rentals: [{ offering_key: 'kayak_rental', duration_key: 'half_day', quantity: 5 }], surfer_count: 5 }) });
  console.log('\nCONFLICT status', conflict.status, '(same key, quantity 2→5) → error', conflict.body && (conflict.body.error || conflict.body.reason_code));

  const ok = create.status === 201 && create.body.total_cents === 5000
    && dbRow && dbRow.service_type === 'addon_service' && dbRow.amount_due_cents === 5000
    && dbRow.metadata.offering_key === 'kayak_rental' && dbRow.metadata.item_code === 'kayak_rental__half_day'
    && replay.status === 200 && (replay.body.booking_code === create.body.booking_code) && conflict.status === 409;
  console.log('\n=== DEMO RESULT:', ok ? 'WORKS ✓ (201 €50 addon_service · replay 200 same booking · qty-change 409 · no env flag)' : 'unexpected — inspect above', '===\n');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('DEMO ERROR:', e && e.stack || e); process.exit(2); });
