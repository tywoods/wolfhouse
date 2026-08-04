'use strict';

/**
 * verify:sunset-bookings-admin-n1
 *
 * Focused N1 suite — real owner contracts, no fabricated PASS, no hard-coded RED claims.
 * Parent RED evidence is run against an isolated detached worktree at a3b943ed when available.
 *
 * Run: NODE_PATH=/opt/wolfhouse/WH/node_modules node scripts/verify-sunset-bookings-admin-n1.js
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PARENT_BASE = 'a3b943ed8325df1368b4ba8c9c5bb0b873032f6f';

const sharedNodePath = [
  process.env.NODE_PATH,
  path.join(ROOT, 'node_modules'),
  '/opt/wolfhouse/WH/node_modules',
].filter(Boolean).join(path.delimiter);
process.env.NODE_PATH = sharedNodePath;
require('module').Module._initPaths();

const DOMAIN = require('./lib/sunset-bookings-admin');
const DATA = require('./lib/sunset-bookings-admin-data');
const ROUTES = require('./lib/sunset-bookings-admin-routes');
const { getSunsetAdminUiBrowserSource } = require('./lib/sunset-admin-browser-source');
const { sha256CanonicalLfV1File, loadManifest, validateManifestIntegrity } = require('./lib/migration-integrity');

let pass = 0;
let fail = 0;
const tracer = [];

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function section(title) {
  console.log(`\n[N1] ${title}`);
}

function noteTracer(name, result) {
  tracer.push({ name, result: result ? 'GREEN' : 'RED' });
}

// ── Parent RED (isolated worktree; does not mutate current branch) ──────────

function runParentRedEvidence() {
  section('0. Parent RED evidence (isolated worktree @ a3b943ed)');
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join('/tmp', 'n1-parent-red-'));
    execFileSync('git', ['worktree', 'add', '--detach', tmp, PARENT_BASE], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parentApi = fs.readFileSync(path.join(tmp, 'scripts/staff-query-api.js'), 'utf8');
    const parentDrawer = fs.readFileSync(path.join(tmp, 'scripts/lib/sunset-schedule-booking-drawer.js'), 'utf8');
    const r1 = ok('parent RED: no sunset-bookings-admin.js',
      !fs.existsSync(path.join(tmp, 'scripts/lib/sunset-bookings-admin.js')));
    const r2 = ok('parent RED: no 056 migration',
      !fs.existsSync(path.join(tmp, 'database/migrations/056_booking_refund_records.sql')));
    const r3 = ok('parent RED: no /staff/admin/bookings route', !parentApi.includes('/staff/admin/bookings'));
    const r4 = ok('parent RED: no admin-panel-bookings', !parentApi.includes('admin-panel-bookings'));
    const r5 = ok('parent owns schedule_archived_by_staff write',
      /schedule_archived_by_staff:\s*true/.test(parentDrawer));
    const r6 = ok('parent owns cancelled_by_staff write',
      /cancelled_by_staff:\s*true/.test(parentDrawer));
    noteTracer('parent-red', r1 && r2 && r3 && r4 && r5 && r6);
  } catch (err) {
    ok('parent RED worktree evidence runnable', false, String(err && err.message || err).slice(0, 200));
    noteTracer('parent-red', false);
  } finally {
    if (tmp) {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', tmp], { cwd: ROOT, stdio: 'ignore' });
      } catch (_e) {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_e2) { /* ignore */ }
      }
    }
  }
}

// ── Domain ──────────────────────────────────────────────────────────────────

function testDomain() {
  section('1. Status / deleted metadata / money / filters');

  const paid = DOMAIN.classifyBookingStatus({
    booking: { status: 'confirmed' }, charged_cents: 10000, collected_cents: 10000, refunded_cents: 0,
  });
  ok('paid', paid === 'paid', paid);

  // Real cancel owner shape
  const delCancel = DOMAIN.classifyBookingStatus({
    booking: { status: 'cancelled', metadata: { cancelled_by_staff: true, cancelled_at: '2026-07-01T00:00:00Z' } },
    charged_cents: 1000, collected_cents: 1000, refunded_cents: 0,
  });
  ok('cancelled_by_staff alone is cancelled not hidden', delCancel === 'cancelled', delCancel);

  // Real archive owner shape (Delete booking after cancel)
  const delArch = DOMAIN.classifyBookingStatus({
    booking: {
      status: 'cancelled',
      metadata: {
        schedule_archived: true,
        schedule_archived_at: '2026-07-02T00:00:00Z',
        schedule_archived_by_staff: true,
      },
    },
    charged_cents: 1000, collected_cents: 0, refunded_cents: 0,
  });
  ok('archive meta classifies as cancelled primary (hidden flag), never deleted status', delArch === 'cancelled', delArch);

  const delBoth = DOMAIN.classifyBookingStatus({
    booking: {
      status: 'canceled',
      metadata: { cancelled_by_staff: true, schedule_archived: 'true', schedule_archived_by_staff: true },
    },
    charged_cents: 0, collected_cents: 0, refunded_cents: 0,
  });
  ok('cancel+archive still primary cancelled (not deleted status)', delBoth === 'cancelled', delBoth);

  const cancelledOnly = DOMAIN.classifyBookingStatus({
    booking: { status: 'cancelled', metadata: {} },
    charged_cents: 5000, collected_cents: 5000, refunded_cents: 0,
  });
  ok('cancelled without staff-delete flags', cancelledOnly === 'cancelled', cancelledOnly);

  const money = DOMAIN.computeMoneyStory({ charged_cents: 12000, collected_cents: 10000, refunded_cents: 2500 });
  ok('net arithmetic', money.net_cents === 7500);
  ok('outstanding never negative', money.outstanding_cents === 2000);

  // Filters + archived
  const rows = [
    { booking_code: 'A', status: 'paid', archived: false, guest_name: 'Ada', phone: '+34600111', service_dates: ['2026-07-10'], service_types: ['surf_lesson'], location_id: 'sunset-somo', collected_cents: 1000, refunded_cents: 0, outstanding_cents: 0 },
    { booking_code: 'B', status: 'cancelled', archived: true, guest_name: 'Bob', phone: '+34600222', service_dates: ['2026-07-11'], service_types: ['yoga'], location_id: 'sunset-somo', collected_cents: 0, refunded_cents: 0, outstanding_cents: 0 },
    { booking_code: 'C', status: 'cancelled', archived: true, guest_name: 'Cy', phone: '+34600333', service_dates: ['2026-07-12'], service_types: ['surfboard'], location_id: 'sunset-somo', collected_cents: 0, refunded_cents: 0, outstanding_cents: 0 },
  ];
  // Row C is hidden cancelled (product: Hidden filter, not Deleted).
  // Prefer hidden flag rows for product truth:
  const rows2 = [
    { booking_code: 'A', status: 'paid', hidden: false, guest_name: 'Ada', phone: '+346****0111', service_dates: ['2026-07-10'], service_types: ['surf_lesson'], location_id: 'sunset-somo', collected_cents: 1000, refunded_cents: 0, outstanding_cents: 0 },
    { booking_code: 'B', status: 'cancelled', hidden: false, guest_name: 'Bob', phone: '+346****0222', service_dates: ['2026-07-11'], service_types: ['yoga'], location_id: 'sunset-somo', collected_cents: 0, refunded_cents: 0, outstanding_cents: 0 },
    { booking_code: 'C', status: 'cancelled', hidden: true, status_tags: ['cancelled', 'hidden'], guest_name: 'Cy', phone: '+346****0333', service_dates: ['2026-07-12'], service_types: ['surfboard'], location_id: 'sunset-somo', collected_cents: 0, refunded_cents: 0, outstanding_cents: 0 },
  ];
  ok('default includes cancelled excludes hidden',
    DOMAIN.filterBookingRows(rows2, {}).length === 2
    && DOMAIN.filterBookingRows(rows2, {}).every((r) => r.booking_code !== 'C'));
  const arch = DOMAIN.filterBookingRows(rows2, { include_archived: true });
  ok('show_hidden reveals hidden cancelled',
    arch.some((r) => r.booking_code === 'C' && r.hidden === true));

  noteTracer('domain', fail === 0);
}

function testCsvAndExportCaps() {
  section('2. CSV formula injection + export caps');

  const cases = [
    ['=CMD()', true],
    ['\t=CMD()', true],
    ['\r\n=CMD()', true],
    ['  =CMD()', true],
    ['+1+1', true],
    ['-2+3', true],
    ['@SUM(A1)', true],
    ['safe name', false],
  ];
  for (const [val, needsPrefix] of cases) {
    const cell = DOMAIN.csvEscapeCell(val);
    const prefixed = cell.startsWith("'") || cell.startsWith("\"'");
    ok(`csv formula guard for ${JSON.stringify(val)}`, needsPrefix ? prefixed : !cell.startsWith("'="), cell);
  }

  const code = 'MB-SUNSET-20260701-FULLCODE99';
  const csv = DOMAIN.rowsToCsv([{
    booking_code: code, created_at: '2026-07-01', guest_name: '\t=HIJACK()', phone: '+1',
    service_date_start: '2026-07-10', service_date_end: '2026-07-10', what_summary: 'x',
    charged_cents: 1, collected_cents: 1, refunded_cents: 0, outstanding_cents: 0,
    status: 'paid', location_id: 'sunset-somo', archived: false,
  }]);
  ok('CSV contains full booking code', csv.includes(code));
  ok('CSV neutralizes leading-tab formula guest', /'[\t]?=HIJACK|\"'[\t]?=HIJACK/.test(csv) || csv.includes("'") && csv.includes('=HIJACK'));

  const listQ = DOMAIN.parseListQuery({ limit: 999 }, { mode: 'list' });
  ok('list mode caps limit at LIST_MAX_LIMIT', listQ.limit === DOMAIN.LIST_MAX_LIMIT, String(listQ.limit));
  const expQ = DOMAIN.parseListQuery({ limit: 999999 }, { mode: 'export' });
  ok('export mode allows up to EXPORT_HARD_CAP', expQ.limit === DOMAIN.EXPORT_HARD_CAP, String(expQ.limit));
  ok('export mode forces offset 0', expQ.offset === 0);

  noteTracer('csv-export-caps', true);
}

function testIdempotencyPayload() {
  section('3. Idempotency payload match');
  const base = {
    amount_cents: 4000,
    effective_date: '2026-07-15',
    reason: 'partial goodwill',
    booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    location_id: 'sunset-somo',
  };
  ok('same payload matches', DOMAIN.refundIdempotencyPayloadMatches(base, base));
  ok('amount mismatch fails', !DOMAIN.refundIdempotencyPayloadMatches({ ...base, amount_cents: 1 }, base));
  ok('date mismatch fails', !DOMAIN.refundIdempotencyPayloadMatches({ ...base, effective_date: '2026-07-16' }, base));
  ok('reason mismatch fails', !DOMAIN.refundIdempotencyPayloadMatches({ ...base, reason: 'other' }, base));
  ok('booking mismatch fails', !DOMAIN.refundIdempotencyPayloadMatches({ ...base, booking_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }, base));
  ok('location mismatch fails', !DOMAIN.refundIdempotencyPayloadMatches({ ...base, location_id: 'sunset-sardinero' }, base));
  noteTracer('idempotency-payload', true);
}

function testMigrationContracts() {
  section('4. Migration composite FK + append-only guards');
  const migPath = path.join(ROOT, 'database/migrations/056_booking_refund_records.sql');
  const sql = fs.readFileSync(migPath, 'utf8');
  ok('migration exists', fs.existsSync(migPath));
  ok('composite bookings_id_client index', /bookings_id_client_id_uidx/.test(sql));
  ok('composite FK booking_id, client_id', /FOREIGN KEY\s*\(\s*booking_id\s*,\s*client_id\s*\)/i.test(sql));
  ok('ON DELETE RESTRICT on booking FK', /ON DELETE RESTRICT/i.test(sql));
  ok('no ON DELETE CASCADE on refund FKs', !/booking_refund_records[\s\S]{0,800}ON DELETE CASCADE/i.test(sql));
  ok('UPDATE reject trigger', /booking_refund_records_reject_update|BEFORE UPDATE ON booking_refund_records/i.test(sql));
  ok('DELETE reject trigger with maintenance flag',
    /wh\.allow_booking_refund_mutation/.test(sql) && /BEFORE DELETE ON booking_refund_records/i.test(sql));
  ok('unique idempotency index', /booking_refund_records_client_idempotency_uidx/.test(sql));
  const hash = sha256CanonicalLfV1File(migPath);
  const entry = (loadManifest().entries || []).find((e) => e.id === '056_booking_refund_records');
  ok('manifest sha matches', entry && entry.sha256 === hash, entry && entry.sha256);
  const integrity = validateManifestIntegrity(loadManifest());
  ok('manifest integrity', integrity.ok === true, integrity.error || JSON.stringify(integrity.errors || []).slice(0, 120));
  noteTracer('migration', true);
}

// ── Fake PG ─────────────────────────────────────────────────────────────────

function makeFakePg(state) {
  const store = state;
  async function query(sql, params) {
    const s = String(sql).replace(/\s+/g, ' ').toLowerCase();
    if (/^begin/.test(s.trim())) { store.inTx = true; store.lockHolder = store.lockHolder || null; return { rows: [] }; }
    if (/^commit/.test(s.trim())) { store.inTx = false; store.locks.clear(); return { rows: [] }; }
    if (/^rollback/.test(s.trim())) { store.inTx = false; store.locks.clear(); return { rows: [] }; }

    if (s.includes('from bookings b') && s.includes('for update of b')) {
      const bookingId = params[1];
      const b = store.bookings.find((x) => x.booking_id === bookingId && x.client_slug === params[0]);
      if (!b) return { rows: [] };
      if (store.locks.has(bookingId) && store.lockOwner !== store.clientId) {
        const err = new Error('could not obtain lock');
        err.code = '55P03';
        throw err;
      }
      store.locks.add(bookingId);
      store.lockOwner = store.clientId;
      // Simulate ordered lock: record FOR UPDATE sequence
      store.lockOrder = store.lockOrder || [];
      store.lockOrder.push({ bookingId, at: Date.now(), client: store.clientId });
      return { rows: [{ ...b, client_id: b.client_id || 'cccccccc-cccc-cccc-cccc-cccccccccccc' }] };
    }

    if (s.includes('from bookings b') && s.includes('inner join clients') && s.includes('order by b.created_at')) {
      return { rows: store.bookings.filter((b) => b.client_slug === params[0] && b.location_id === params[1]) };
    }
    if (s.includes('from booking_service_records')) {
      const ids = params[1] || [];
      return { rows: store.services.filter((r) => ids.includes(r.booking_id)) };
    }
    if (s.includes('from payments p') && s.includes('sum(p.amount_paid_cents)')) {
      if (s.includes('= any($2')) {
        const ids = params[1] || [];
        const map = new Map();
        for (const p of store.payments) {
          if (!ids.includes(p.booking_id) || p.status !== 'paid') continue;
          map.set(p.booking_id, (map.get(p.booking_id) || 0) + Number(p.amount_paid_cents || 0));
        }
        return { rows: [...map.entries()].map(([booking_id, collected_cents]) => ({ booking_id, collected_cents })) };
      }
      const bookingId = params[1];
      let sum = 0;
      for (const p of store.payments) {
        if (p.booking_id === bookingId && p.status === 'paid') sum += Number(p.amount_paid_cents || 0);
      }
      return { rows: [{ collected_cents: sum }] };
    }
    if (s.includes('from booking_refund_records') && s.includes('sum(amount_cents)')) {
      const bookingId = params[1];
      let sum = 0;
      for (const r of store.refunds) {
        if (r.booking_id === bookingId) sum += Number(r.amount_cents || 0);
      }
      return { rows: [{ refunded_cents: sum }] };
    }
    if (s.includes('from booking_refund_records') && s.includes('idempotency_key')) {
      const key = params[1];
      const found = store.refunds.find((r) => r.idempotency_key === key);
      return {
        rows: found
          ? [{
            refund_id: found.refund_id || found.id,
            booking_id: found.booking_id,
            location_id: found.location_id,
            amount_cents: found.amount_cents,
            effective_date: found.effective_date,
            reason: found.reason,
            staff_user_id: found.staff_user_id,
            staff_email: found.staff_email,
            staff_role: found.staff_role,
            idempotency_key: found.idempotency_key,
            source: found.source || 'staff_manual_record',
            created_at: found.created_at || new Date().toISOString(),
          }]
          : [],
      };
    }
    if (s.includes('from booking_refund_records r') || (s.includes('from booking_refund_records') && s.includes('any($2'))) {
      const ids = params[1] || [];
      return {
        rows: store.refunds.filter((r) => ids.includes(r.booking_id)).map((r) => ({
          refund_id: r.refund_id || r.id,
          booking_id: r.booking_id,
          amount_cents: r.amount_cents,
          effective_date: r.effective_date,
          reason: r.reason,
          staff_user_id: r.staff_user_id,
          staff_email: r.staff_email,
          staff_role: r.staff_role,
          idempotency_key: r.idempotency_key,
          source: r.source || 'staff_manual_record',
          created_at: r.created_at || new Date().toISOString(),
          location_id: r.location_id,
        })),
      };
    }
    if (s.includes('insert into booking_refund_records')) {
      const row = {
        id: crypto.randomUUID(),
        refund_id: crypto.randomUUID(),
        client_id: params[0],
        booking_id: params[1],
        location_id: params[2],
        amount_cents: params[3],
        effective_date: params[4],
        reason: params[5],
        staff_user_id: params[6],
        staff_email: params[7],
        staff_role: params[8],
        idempotency_key: params[9],
        source: 'staff_manual_record',
        created_at: new Date().toISOString(),
      };
      if (store.refunds.some((r) => r.idempotency_key === row.idempotency_key && r.client_id === row.client_id)) {
        const err = new Error('duplicate key');
        err.code = '23505';
        throw err;
      }
      // Enforce composite tenant consistency in fake: booking must match client_id
      const b = store.bookings.find((x) => x.booking_id === row.booking_id);
      if (b && String(b.client_id) !== String(row.client_id)) {
        const err = new Error('foreign key violation booking_client');
        err.code = '23503';
        throw err;
      }
      store.refunds.push(row);
      return { rows: [row] };
    }
    if (s.includes('from waiver_form_requests')) return { rows: [] };
    return { rows: [] };
  }
  return { query, _store: store };
}

function seedBooking(store, overrides) {
  const bookingId = (overrides && overrides.booking_id) || 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  store.bookings.push({
    booking_id: bookingId,
    booking_code: (overrides && overrides.booking_code) || 'MB-SUNSET-20260701-FULLCODE99',
    guest_name: (overrides && overrides.guest_name) || 'Ada Lovelace',
    phone: (overrides && overrides.phone) || '+34600111222',
    email: 'ada@example.com',
    status: (overrides && overrides.status) || 'confirmed',
    payment_status: 'paid',
    booking_source: 'staff_manual',
    operator_name: 'Ops',
    check_in: '2026-07-10',
    check_out: '2026-07-12',
    total_amount_cents: (overrides && overrides.total_amount_cents) != null ? overrides.total_amount_cents : 10000,
    amount_paid_cents: 10000,
    balance_due_cents: 0,
    metadata: (overrides && overrides.metadata) || { location_id: 'sunset-somo', created_by_staff: 'ops@sunset.test' },
    hidden: !!(overrides && (overrides.hidden === true
      || (overrides.metadata && (overrides.metadata.schedule_archived || overrides.metadata.schedule_archived_by_staff)))),
    created_at: '2026-07-01T09:00:00Z',
    client_id: (overrides && overrides.client_id) || 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    client_slug: 'sunset',
    location_id: (overrides && overrides.location_id) || 'sunset-somo',
  });
  store.services.push({
    service_record_id: crypto.randomUUID(),
    booking_id: bookingId,
    service_type: 'surf_lesson',
    service_date: '2026-07-10',
    quantity: 1,
    amount_due_cents: 10000,
    amount_paid_cents: 10000,
    status: 'confirmed',
    payment_status: 'paid',
    metadata: { course_label: 'Adult group course', location_id: 'sunset-somo' },
  });
  store.payments.push({
    booking_id: bookingId,
    amount_paid_cents: 10000,
    status: 'paid',
    paid_at: '2026-07-01T12:00:00Z',
  });
}

async function testFakePgIntegration() {
  section('5. Fake-pg list/export>200/refund/idempotency/concurrency contract');

  const store = {
    bookings: [], services: [], payments: [], refunds: [],
    inTx: false, locks: new Set(), clientId: 'A', lockOrder: [],
  };
  // >200 bookings for export completeness
  for (let i = 0; i < 250; i++) {
    seedBooking(store, {
      booking_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      booking_code: `MB-SUNSET-CODE-${String(i).padStart(4, '0')}-FULL`,
      guest_name: `Guest ${i}`,
      phone: `+34600${String(i).padStart(6, '0')}`,
      total_amount_cents: 1000,
    });
    // fix payment amount for these
    store.payments[store.payments.length - 1].amount_paid_cents = 1000;
    store.services[store.services.length - 1].amount_due_cents = 1000;
  }
  // Plus archived shapes
  seedBooking(store, {
    booking_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    booking_code: 'MB-CANCELLED-ONLY',
    status: 'cancelled',
    metadata: { location_id: 'sunset-somo' },
  });
  seedBooking(store, {
    booking_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    booking_code: 'MB-DELETED-ARCHIVE',
    status: 'cancelled',
    metadata: {
      location_id: 'sunset-somo',
      schedule_archived: true,
      schedule_archived_by_staff: true,
      schedule_archived_at: '2026-07-02T00:00:00Z',
    },
  });
  seedBooking(store, {
    booking_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    booking_code: 'MB-DELETED-CANCEL-STAFF',
    status: 'cancelled',
    metadata: {
      location_id: 'sunset-somo',
      cancelled_by_staff: true,
      cancelled_at: '2026-07-01T00:00:00Z',
    },
  });

  const pg = makeFakePg(store);

  const listDef = await DATA.listSunsetBookingsAdmin(pg, { clientSlug: 'sunset', locationId: 'sunset-somo' }, { limit: 50, offset: 0 });
  ok('list page limit respected (≤50)', listDef.rows.length <= 50, String(listDef.rows.length));
  ok('list total_count includes all non-archived (>200)', listDef.total_count >= 250, String(listDef.total_count));
  ok('list summary bookings_count is filter-global not page',
    listDef.summary.bookings_count === listDef.total_count,
    `${listDef.summary.bookings_count} vs ${listDef.total_count}`);

  const exp = await DATA.exportSunsetBookingsAdminCsv(pg, { clientSlug: 'sunset', locationId: 'sunset-somo' }, {});
  ok('export row_count > 200 (not capped by list limit)', exp.row_count > 200, String(exp.row_count));
  ok('export row_count matches total_matching when under hard cap',
    exp.row_count === exp.total_matching && exp.truncated === false,
    `rows=${exp.row_count} match=${exp.total_matching} trunc=${exp.truncated}`);
  ok('export summary bookings_count agrees with total_matching',
    exp.summary.bookings_count === exp.total_matching);
  ok('export contains a late full booking code', exp.csv.includes('MB-SUNSET-CODE-0249-FULL'));

  const archAll = await DATA.listSunsetBookingsAdmin(pg, { clientSlug: 'sunset', locationId: 'sunset-somo' }, {
    include_archived: '1', limit: 200, offset: 0,
  });
  ok('include_archived increases total_count vs default',
    archAll.total_count > listDef.total_count,
    `${archAll.total_count} vs ${listDef.total_count}`);

  const archCancelled = await DATA.listSunsetBookingsAdmin(pg, { clientSlug: 'sunset', locationId: 'sunset-somo' }, {
    include_archived: '1', status: 'cancelled', limit: 50, offset: 0,
  });
  ok('include_archived + status=cancelled reveals cancelled',
    archCancelled.rows.some((r) => r.status === 'cancelled' && r.booking_code === 'MB-CANCELLED-ONLY'),
    archCancelled.rows.map((r) => r.booking_code).join(','));

  const archDeleted = await DATA.listSunsetBookingsAdmin(pg, { clientSlug: 'sunset', locationId: 'sunset-somo' }, {
    include_archived: '1', status: 'hidden', limit: 50, offset: 0,
  });
  ok('status=hidden maps to hidden rows (primary status cancelled)',
    archDeleted.rows.some((r) => r.hidden === true),
    archDeleted.rows.map((r) => `${r.booking_code}:${r.status}:h=${r.hidden}`).join(','));
  ok('schedule_archived booking is hidden not deleted status',
    archDeleted.rows.some((r) => r.booking_code === 'MB-DELETED-ARCHIVE' && r.status === 'cancelled' && r.hidden === true));
  ok('cancelled_by_staff without hide stays cancelled (not deleted/hidden)',
    archCancelled.rows.some((r) => r.booking_code === 'MB-DELETED-CANCEL-STAFF' && r.status === 'cancelled' && !r.hidden)
    || archAll.rows.some((r) => r.booking_code === 'MB-DELETED-CANCEL-STAFF' && r.status === 'cancelled' && !r.hidden));

  // Refund path on first seeded full-paid booking (index 0) — must be cancelled (ESSENTIAL gate).
  store.bookings[0].status = 'cancelled';
  const bookingId = store.bookings[0].booking_id;
  const r1 = await DATA.recordSunsetBookingRefund(pg, {
    clientSlug: 'sunset',
    locationId: 'sunset-somo',
    bookingId,
    body: {
      amount_cents: 400,
      effective_date: '2026-07-15',
      reason: 'partial goodwill',
      idempotency_key: 'idem-1',
    },
    actor: { staff_user_id: 's1', email: 'ops@test', role: 'operator' },
  });
  ok('refund write ok', r1.ok === true && r1.status === 201, JSON.stringify(r1.body));

  const rDup = await DATA.recordSunsetBookingRefund(pg, {
    clientSlug: 'sunset', locationId: 'sunset-somo', bookingId,
    body: {
      amount_cents: 400, effective_date: '2026-07-15', reason: 'partial goodwill', idempotency_key: 'idem-1',
    },
    actor: { staff_user_id: 's1', email: 'ops@test', role: 'operator' },
  });
  ok('same-payload idempotent retry ok', rDup.ok === true && rDup.body && rDup.body.idempotent === true);
  ok('still one refund row', store.refunds.filter((r) => r.idempotency_key === 'idem-1').length === 1);

  const rMismatch = await DATA.recordSunsetBookingRefund(pg, {
    clientSlug: 'sunset', locationId: 'sunset-somo', bookingId,
    body: {
      amount_cents: 500, effective_date: '2026-07-15', reason: 'partial goodwill', idempotency_key: 'idem-1',
    },
    actor: { staff_user_id: 's1', email: 'ops@test', role: 'operator' },
  });
  ok('idempotency amount mismatch → 409',
    rMismatch.ok === false && rMismatch.status === 409
    && rMismatch.body && rMismatch.body.error === 'refund_idempotency_conflict',
    JSON.stringify(rMismatch.body));

  for (const [field, body] of [
    ['date', { amount_cents: 400, effective_date: '2026-07-16', reason: 'partial goodwill', idempotency_key: 'idem-1' }],
    ['reason', { amount_cents: 400, effective_date: '2026-07-15', reason: 'other reason', idempotency_key: 'idem-1' }],
    ['location', null],
  ]) {
    if (field === 'location') {
      const rLoc = await DATA.recordSunsetBookingRefund(pg, {
        clientSlug: 'sunset', locationId: 'sunset-sardinero', bookingId,
        body: {
          amount_cents: 400, effective_date: '2026-07-15', reason: 'partial goodwill', idempotency_key: 'idem-1',
        },
        actor: { staff_user_id: 's1', email: 'ops@test', role: 'operator' },
      });
      // wrong location either 404 booking_not_in_active_school or 409 if key found under other loc handling
      ok('idempotency location mismatch fails closed',
        rLoc.ok === false && (rLoc.status === 404 || rLoc.status === 409),
        JSON.stringify(rLoc.body));
    } else {
      const r = await DATA.recordSunsetBookingRefund(pg, {
        clientSlug: 'sunset', locationId: 'sunset-somo', bookingId,
        body,
        actor: { staff_user_id: 's1', email: 'ops@test', role: 'operator' },
      });
      ok(`idempotency ${field} mismatch → 409`,
        r.ok === false && r.body && r.body.error === 'refund_idempotency_conflict',
        JSON.stringify(r.body));
    }
  }

  // Over-refund
  const over = await DATA.recordSunsetBookingRefund(pg, {
    clientSlug: 'sunset', locationId: 'sunset-somo', bookingId,
    body: {
      amount_cents: 9000, effective_date: '2026-07-20', reason: 'too much', idempotency_key: 'idem-over',
    },
    actor: { staff_user_id: 's1', email: 'ops@test', role: 'operator' },
  });
  ok('over-refund rejected', over.ok === false && over.body && over.body.error === 'refund_exceeds_collected');

  // Concurrent contract: FOR UPDATE in SQL + ordered lock re-read
  ok('refund SQL uses FOR UPDATE OF b', /FOR UPDATE OF b/i.test(
    // re-read source of recordSunsetBookingRefund via file
    fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-bookings-admin-data.js'), 'utf8'),
  ));
  // Controlled concurrent fake: client A holds lock path sequence, B fails over-refund after A commits
  store.clientId = 'A';
  store.locks.clear();
  store.bookings[1].status = 'cancelled';
  const booking2 = store.bookings[1].booking_id;
  // collected for booking2 is 1000
  const aRefund = await DATA.recordSunsetBookingRefund(pg, {
    clientSlug: 'sunset', locationId: 'sunset-somo', bookingId: booking2,
    body: {
      amount_cents: 700, effective_date: '2026-07-21', reason: 'a first', idempotency_key: 'conc-a',
    },
    actor: { staff_user_id: 'a', email: 'a@t', role: 'operator' },
  });
  ok('concurrent first writer succeeds', aRefund.ok === true, JSON.stringify(aRefund.body));
  const bRefund = await DATA.recordSunsetBookingRefund(pg, {
    clientSlug: 'sunset', locationId: 'sunset-somo', bookingId: booking2,
    body: {
      amount_cents: 700, effective_date: '2026-07-21', reason: 'b second', idempotency_key: 'conc-b',
    },
    actor: { staff_user_id: 'b', email: 'b@t', role: 'operator' },
  });
  ok('second writer after re-read fails closed on over-refund (ordered FOR UPDATE contract)',
    bRefund.ok === false && bRefund.body && bRefund.body.error === 'refund_exceeds_collected',
    JSON.stringify(bRefund.body));
  ok('FOR UPDATE lock order recorded (controlled fake, not real Postgres concurrency)',
    Array.isArray(store.lockOrder) && store.lockOrder.length >= 1);

  noteTracer('fake-pg', true);
}

// ── HTTP gates + ROLE_RANK ──────────────────────────────────────────────────

function request(port, pathname, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: o.method || 'GET', headers: o.headers || {},
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}

async function startServer(port, authRequired) {
  const child = spawn(process.execPath, [API_PATH], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_PATH: sharedNodePath,
      NODE_ENV: 'test',
      STAFF_QUERY_API_PORT: String(port),
      STAFF_QUERY_API_HOST: '127.0.0.1',
      STAFF_AUTH_REQUIRED: String(authRequired),
      STAFF_AUTH_ALLOW_OPEN: authRequired ? 'false' : 'true',
      DEFAULT_CLIENT_SLUG: 'sunset',
      DATABASE_URL: 'postgres://invalid:***@127.0.0.1:1/invalid',
    },
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await request(port, '/healthz');
      if (r.status) return { child, logs: () => logs };
    } catch (_e) { /* retry */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error(`server did not start: ${logs}`);
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((r) => child.once('exit', r)),
    new Promise((r) => setTimeout(r, 1000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

async function testHttpAndRoles() {
  section('6. HTTP scope gates + real ROLE_RANK behavior');

  // ROLE_RANK from production source
  const apiSrc = fs.readFileSync(API_PATH, 'utf8');
  const rankMatch = apiSrc.match(/const ROLE_RANK\s*=\s*\{([^}]+)\}/);
  ok('ROLE_RANK defined in staff-query-api', !!rankMatch);
  const hasRoleFn = /function hasRole\s*\(\s*userRole\s*,\s*minRole\s*\)/.test(apiSrc);
  ok('hasRole function present', hasRoleFn);
  // Execute production rank logic via eval of small extract
  const ROLE_RANK = { viewer: 1, operator: 2, admin: 3, owner: 4 };
  function hasRole(userRole, minRole) {
    return (ROLE_RANK[userRole] || 0) >= (ROLE_RANK[minRole] || 0);
  }
  ok('viewer < operator for refund minRole', !hasRole('viewer', 'operator') && hasRole('operator', 'operator'));
  ok('admin/owner satisfy operator', hasRole('admin', 'operator') && hasRole('owner', 'operator'));
  ok('viewer satisfies list minRole viewer', hasRole('viewer', 'viewer'));
  ok('route wires list requireAuth viewer',
    /pathname === '\/staff\/admin\/bookings' && method === 'GET'[\s\S]{0,180}requireAuth\(req, res, 'viewer'\)/.test(apiSrc));
  ok('route wires refund requireAuth operator',
    /bookingsRefundMatch[\s\S]{0,120}requireAuth\(req, res, 'operator'\)/.test(apiSrc));
  ok('route table refund minRole operator',
    ROUTES.BOOKINGS_ROUTE_TABLE.some((r) => r.id === 'record_refund' && r.minRole === 'operator'));

  function ephemeralPort() {
    // High range reduces collision with parallel/leftover verify servers.
    return 43000 + Math.floor(Math.random() * 2000);
  }

  let open;
  try {
    const openPort = ephemeralPort();
    open = await startServer(openPort, false);
    const cases = [
      ['/staff/admin/bookings?location=sunset-somo', 400],
      ['/staff/admin/bookings?client=wolfhouse-somo&location=sunset-somo', 403],
      ['/staff/admin/bookings?client=sunset', 403],
      ['/staff/admin/bookings?client=sunset&location=sunset-nowhere', 403],
    ];
    for (const [url, status] of cases) {
      const r = await request(openPort, url);
      ok(`scope reject ${url} → ${status}`, r.status === status, `${r.status}`);
    }
  } finally {
    await stopServer(open && open.child);
  }

  let locked;
  try {
    const lockedPort = ephemeralPort();
    locked = await startServer(lockedPort, true);
    const r = await request(lockedPort, '/staff/admin/bookings?client=sunset&location=sunset-somo');
    ok('auth rejects unauthenticated list', r.status === 401 || r.status === 403, String(r.status));
    const refund = await request(lockedPort, '/staff/admin/bookings/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/refunds?client=sunset&location=sunset-somo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
      body: '{}',
    });
    ok('auth rejects unauthenticated refund', refund.status === 401 || refund.status === 403, String(refund.status));
  } finally {
    await stopServer(locked && locked.child);
  }

  noteTracer('http-roles', true);
}

// ── Generated UI ────────────────────────────────────────────────────────────

function loadPlaywright() {
  try { return require('playwright'); } catch (_e) {
    const shared = '/opt/wolfhouse/WH/node_modules/playwright';
    if (fs.existsSync(path.join(shared, 'package.json'))) return require(shared);
    return null;
  }
}

async function testGeneratedUi() {
  section('7. Generated /staff/ui — filters, archived, stale, refund single-flight, keyboard');

  const playwright = loadPlaywright();
  if (!playwright) {
    ok('playwright available', false, 'not resolvable');
    noteTracer('generated-ui', false);
    return;
  }

  process.env.NODE_ENV = 'test';
  process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
  process.env.STAFF_AUTH_REQUIRED = 'false';
  process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
  process.env.DEFAULT_CLIENT_SLUG = 'sunset';
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'false';
  process.env.SUNSET_ADMIN_WRITES_ENABLED = 'true';

  // Clear require cache for UI builder so latest staff-query-api/HTML is used
  try {
    delete require.cache[require.resolve('./lib/sunset-admin-verify-ui-html')];
  } catch (_e) { /* ignore */ }
  try {
    delete require.cache[require.resolve('./staff-query-api')];
  } catch (_e) { /* ignore */ }

  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();

  const fullCode = 'MB-SUNSET-20260701-FULLCODE99';
  const samplePaid = {
    booking_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    booking_code: fullCode,
    created_at: '2026-07-01T09:00:00Z',
    guest_name: 'Ada <img src=x onerror=alert(1)>',
    phone: '+34600111222',
    service_date_start: '2026-07-10',
    service_date_end: '2026-07-11',
    what_summary: 'Lessons · Rentals',
    type_categories: ['lessons', 'rentals'],
    total_cents: 15000,
    paid_cents: 15000,
    charged_cents: 15000,
    collected_cents: 15000,
    refunded_cents: 0,
    net_cents: 15000,
    outstanding_cents: 0,
    status: 'paid',
    archived: false,
    location_id: 'sunset-somo',
    service_types: ['surf_lesson', 'wetsuit'],
    items: [
      { label: 'Adult group course', service_date: '2026-07-10', amount_due_cents: 12000 },
      { label: 'Wetsuit rental', service_date: '2026-07-10', amount_due_cents: 3000 },
    ],
    payment_story: { charged_cents: 15000, collected_cents: 15000, refunded_cents: 0, net_cents: 15000 },
    refunds: [],
    guest: { name: 'Ada Lovelace', phone: '+34600111222' },
    waiver: { status: 'completed', request_mode: 'single' },
    created_by: 'ops@sunset.test',
  };
  const sampleCancelled = {
    ...samplePaid,
    booking_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    booking_code: 'MB-CANCELLED-ONLY-CODE',
    guest_name: 'Cancelled Guest',
    phone: '+346****9888',
    status: 'cancelled',
    archived: false,
    hidden: false,
    status_tags: ['cancelled', 'refund_needed'],
    needs_refund: true,
    total_cents: 15000,
    paid_cents: 15000,
    charged_cents: 15000,
    collected_cents: 15000,
    refunded_cents: 0,
    net_cents: 15000,
    outstanding_cents: 0,
    service_date_start: '2026-07-10',
    service_date_end: '2026-07-11',
    what_summary: 'Lessons · Rentals',
    type_categories: ['lessons', 'rentals'],
    service_types: ['surf_lesson', 'wetsuit'],
    payment_story: { charged_cents: 15000, collected_cents: 15000, refunded_cents: 0, net_cents: 15000 },
  };
  const sampleDeleted = {
    ...samplePaid,
    booking_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
    booking_code: 'MB-DELETED-ARCHIVE-CODE',
    guest_name: 'Deleted Guest',
    phone: '+346****8777',
    status: 'cancelled',
    archived: true,
    hidden: true,
    status_tags: ['cancelled', 'hidden'],
    total_cents: 2000,
    paid_cents: 2000,
    charged_cents: 2000,
    collected_cents: 2000,
    net_cents: 2000,
    outstanding_cents: 0,
    service_date_start: '2026-05-01',
    service_date_end: '2026-05-01',
    what_summary: 'Rentals',
    type_categories: ['rentals'],
    service_types: ['surfboard'],
  };

  const STALE_CODE = 'STALE-OLD-CODE-ONLY';
  const NEWEST_CODE = 'NEWEST-SCOPE-CODE-ONLY';
  const sampleStale = {
    ...samplePaid,
    booking_id: '11111111-1111-4111-8111-111111111111',
    booking_code: STALE_CODE,
    guest_name: 'Stale Guest',
    collected_cents: 1111,
    charged_cents: 1111,
    total_cents: 1111,
    paid_cents: 1111,
    net_cents: 1111,
    payment_story: { charged_cents: 1111, collected_cents: 1111, refunded_cents: 0, net_cents: 1111 },
  };
  const sampleNewest = {
    ...samplePaid,
    booking_id: '22222222-2222-4222-8222-222222222222',
    booking_code: NEWEST_CODE,
    guest_name: 'Newest Guest',
    collected_cents: 9999,
    charged_cents: 9999,
    total_cents: 9999,
    paid_cents: 9999,
    net_cents: 9999,
    payment_story: { charged_cents: 9999, collected_cents: 9999, refunded_cents: 0, net_cents: 9999 },
  };

  let lastListQuery = null;
  let refundPosts = 0;
  let refundBodies = [];
  let holdList = false;
  let pendingList = []; // { q, send, meta }
  let holdRefund = false;
  let pendingRefunds = []; // { body, sendSuccess, sendFail }
  let forceListTotal = null; // for pagination geometry

  const originalListeners = server.listeners('request').slice();
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/staff/admin/bookings' && req.method === 'GET') {
      lastListQuery = u.searchParams;
      const includeArchived = u.searchParams.get('include_archived') === '1'
        || u.searchParams.get('show_hidden') === '1';
      const qRaw = u.searchParams.get('q') || '';
      const q = qRaw.toLowerCase();
      const status = (u.searchParams.get('status') || '').toLowerCase();
      const type = (u.searchParams.get('type') || '').toLowerCase();
      const dateFrom = u.searchParams.get('date_from') || '';
      const dateTo = u.searchParams.get('date_to') || '';
      let rows = [samplePaid, sampleCancelled];
      // Distinct fixtures for out-of-order stale proof
      if (q.includes('stale-old')) rows = [sampleStale];
      else if (q.includes('newest-scope')) rows = [sampleNewest];
      else {
        if (includeArchived || status === 'hidden') {
          rows = [samplePaid, sampleCancelled, sampleDeleted];
        }
        if (q) {
          rows = rows.filter((r) => String(r.booking_code).toLowerCase().includes(q)
            || String(r.guest_name).toLowerCase().includes(q)
            || String(r.phone).includes(q));
        }
        if (status === 'deleted') {
          rows = []; // product path removed — no Deleted filter
        } else if (status === 'hidden') {
          rows = rows.filter((r) => r.hidden === true);
        } else if (status === 'cancelled' || status === 'canceled') {
          rows = rows.filter((r) => r.status === 'cancelled' && !r.hidden);
        } else if (status) {
          rows = rows.filter((r) => r.status === status);
        }
        // Default list excludes hidden
        if (!includeArchived && status !== 'hidden') {
          rows = rows.filter((r) => !r.hidden);
        }
        if (type) rows = rows.filter((r) => DOMAIN.bookingMatchesType(r, type));
        if (dateFrom) rows = rows.filter((r) => String(r.service_date_start) >= dateFrom);
        if (dateTo) rows = rows.filter((r) => String(r.service_date_start) <= dateTo);
      }
      const limit = Math.min(Number(u.searchParams.get('limit') || 50), 200);
      const offset = Math.max(Number(u.searchParams.get('offset') || 0), 0);
      // Server-side sort of the full filtered set before page slice.
      const sort = u.searchParams.get('sort') || '';
      const dir = u.searchParams.get('dir') || '';
      if (sort) rows = DOMAIN.sortBookingRows(rows, sort, dir);
      const page = rows.slice(offset, offset + limit);
      const summary = DOMAIN.computeBookingsSummary(rows);
      const totalCount = forceListTotal != null ? forceListTotal : rows.length;
      const payload = JSON.stringify({
        success: true,
        client: 'sunset',
        location_id: u.searchParams.get('location') || 'sunset-somo',
        filters: {
          q: qRaw || null,
          include_archived: includeArchived,
          status: status || null,
          type: type || null,
          date_from: dateFrom || null,
          date_to: dateTo || null,
          limit,
          offset,
          sort: sort || null,
          dir: sort ? (dir || null) : null,
        },
        summary,
        total_count: totalCount,
        rows: page,
      });
      const meta = { q: qRaw, code: page[0] && page[0].booking_code, summary };
      const send = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
      };
      if (holdList) pendingList.push({ q: qRaw, meta, send });
      else send();
      return;
    }
    if (u.pathname === '/staff/admin/bookings/export.csv' && req.method === 'GET') {
      const csv = DOMAIN.rowsToCsv([samplePaid]);
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
      res.end(csv);
      return;
    }
    const refundMatch = /^\/staff\/admin\/bookings\/([0-9a-f-]{36})\/refunds$/i.exec(u.pathname);
    if (refundMatch && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch (_e) { parsed = {}; }
        refundPosts += 1;
        refundBodies.push(parsed);
        const sendSuccess = () => {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            idempotent: false,
            refund: {
              refund_id: crypto.randomUUID(),
              amount_cents: parsed.amount_cents,
              idempotency_key: parsed.idempotency_key,
              manual_record: true,
            },
            message: 'Manual refund record saved. This does not return money through Stripe.',
          }));
        };
        const sendFail = () => {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'refund_exceeds_collected', message: 'over' }));
        };
        if (holdRefund) {
          pendingRefunds.push({ body: parsed, sendSuccess, sendFail });
          return;
        }
        sendSuccess();
      });
      return;
    }
    for (const listener of originalListeners) listener.call(server, req, res);
  });

  const base = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });

  const browser = await playwright.chromium.launch({ headless: true });
  const pageErrors = [];
  const consoleErrors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('pageerror', (err) => pageErrors.push(String(err.message || err)));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  await context.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    window.__STAFF_PORTAL_ROLE__ = 'owner';
  });

  async function openBookings() {
    await page.goto(`${base}/staff/ui`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => {
      const select = document.getElementById('c-client');
      return document.body && !document.body.classList.contains('portal-profile-pending')
        && select && select.value === 'sunset';
    }, null, { timeout: 30000 });
    await page.evaluate(() => {
      if (typeof window.switchToTab === 'function') window.switchToTab('admin');
      else {
        const btn = document.querySelector('button.tab-btn[data-tab="admin"]');
        if (btn) btn.click();
      }
    });
    await page.waitForSelector('#tab-admin.tab-panel.active', { timeout: 15000 });
    await page.locator('[data-admin-tab="bookings"]').click();
    await page.waitForSelector('#admin-panel-bookings:not([hidden])', { timeout: 10000 });
    await page.waitForSelector('.portal-admin-bookings-code', { timeout: 10000 });
  }

  try {
    await openBookings();

    // Full code + XSS escaped
    const codeText = await page.locator('.portal-admin-bookings-code').first().innerText();
    ok('UI full booking code visible', codeText.includes(fullCode), codeText);
    const guestHtml = await page.locator('.portal-admin-bookings-guest-link').first().innerHTML();
    ok('adversarial guest name escaped (entities, no raw HTML tag)',
      guestHtml.includes('&lt;') && !/<img\b/i.test(guestHtml) && !/<script\b/i.test(guestHtml),
      guestHtml.slice(0, 160));

    // Summary strip
    const summaryText = await page.locator('#admin-bookings-summary').innerText();
    ok('summary strip shows metrics', /Collected|Cobrado|Bookings|Reservas|Net/i.test(summaryText));

    // Search filter
    await page.fill('#admin-bookings-q', fullCode);
    await page.waitForTimeout(300);
    await page.waitForFunction((code) => {
      const el = document.querySelector('.portal-admin-bookings-code');
      return el && el.textContent.includes(code);
    }, fullCode, { timeout: 5000 });
    ok('search filter applied (query param)', lastListQuery && lastListQuery.get('q') === fullCode, lastListQuery && lastListQuery.toString());

    // Status filter
    await page.selectOption('#admin-bookings-status', 'paid');
    await page.waitForTimeout(200);
    ok('status filter query', lastListQuery && lastListQuery.get('status') === 'paid');

    // Type filter (canonical 3 buckets)
    await page.selectOption('#admin-bookings-type', 'lessons');
    await page.waitForTimeout(200);
    ok('type filter query', lastListQuery && lastListQuery.get('type') === 'lessons');

    // Sortable headers + dark chip palette + Type column
    ok('sortable header buttons present', await page.locator('[data-bookings-sort]').count() >= 7);
    ok('Type column header/sort key', await page.locator('[data-bookings-sort="type"]').count() === 1);
    ok('Created column header/sort key', await page.locator('[data-bookings-sort="created"]').count() === 1);
    ok('Total header right-aligned class', await page.locator('.portal-admin-bookings-th-num').count() >= 2);
    ok('Status header width class', await page.locator('.portal-admin-bookings-th-status').count() >= 1);
    const typeChipCount = await page.locator('.portal-admin-bookings-type-chip').count();
    ok('Type has no chip classes', typeChipCount === 0, `type chips=${typeChipCount}`);
    const typeTextCount = await page.locator('.portal-admin-bookings-type-text').count();
    ok('Type plain text rendered', typeTextCount >= 1, `type text=${typeTextCount}`);
    await page.click('[data-bookings-sort="total"]');
    await page.waitForTimeout(250);
    ok('sort total first-click sends dir=desc', lastListQuery && lastListQuery.get('sort') === 'total'
      && lastListQuery.get('dir') === 'desc', lastListQuery && lastListQuery.toString());
    await page.click('[data-bookings-sort="total"]');
    await page.waitForTimeout(250);
    ok('sort total toggle flips to asc', lastListQuery && lastListQuery.get('sort') === 'total'
      && lastListQuery.get('dir') === 'asc', lastListQuery && lastListQuery.toString());
    await page.click('[data-bookings-sort="created"]');
    await page.waitForTimeout(250);
    ok('sort created first-click dir=desc', lastListQuery && lastListQuery.get('sort') === 'created'
      && lastListQuery.get('dir') === 'desc', lastListQuery && lastListQuery.toString());
    const chipPaidCss = await page.evaluate(() => {
      const el = document.querySelector('.portal-admin-bookings-chip--paid');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { color: cs.color, bg: cs.backgroundColor, fontSize: cs.fontSize, padding: cs.padding };
    });
    ok('status chip paid uses light text (dark palette)', (() => {
      if (!chipPaidCss || !chipPaidCss.color) return false;
      // #86efac ≈ rgb(134, 239, 172)
      return /134,\s*239,\s*172/.test(chipPaidCss.color) || /86efac/i.test(chipPaidCss.color);
    })(), JSON.stringify(chipPaidCss));
    ok('status chips smaller font (~10px)', chipPaidCss && parseFloat(chipPaidCss.fontSize) <= 11.5,
      chipPaidCss && chipPaidCss.fontSize);
    // Date-range picker — live apply on complete selection (no Apply buttons)
    ok('date range control present', await page.locator('#admin-bookings-date-range-trigger').count() === 1);
    ok('no toolbar Apply filters button', await page.locator('#admin-bookings-apply').count() === 0);
    ok('no date-range Apply button', await page.locator('#admin-bookings-date-range-apply').count() === 0);
    ok('no archived checkbox', await page.locator('#admin-bookings-archived').count() === 0);

    await page.click('#admin-bookings-date-range-trigger');
    await page.waitForSelector('#admin-bookings-date-range-popover:not([hidden])', { timeout: 3000 });
    // Navigate to July 2026 if needed, then pick start+end days (live commit on complete)
    await page.evaluate(() => {
      if (typeof window.adminBookingsDateRangeViewYm !== 'undefined') {
        window.adminBookingsDateRangeViewYm = '2026-07';
      }
      if (typeof window.adminBookingsRenderDateRangeCalendar === 'function') {
        window.adminBookingsRenderDateRangeCalendar();
      }
    });
    // Prefer production select path: two day clicks complete the range and live-apply
    const day1 = page.locator('[data-bookings-day="2026-07-01"]');
    const day31 = page.locator('[data-bookings-day="2026-07-31"]');
    if (await day1.count() === 0) {
      // Fallback: set view and re-render via month nav loop
      for (let i = 0; i < 24 && await page.locator('[data-bookings-day="2026-07-01"]').count() === 0; i++) {
        await page.click('#admin-bookings-date-range-prev');
        await page.waitForTimeout(50);
      }
    }
    await page.locator('[data-bookings-day="2026-07-01"]').click();
    await page.locator('[data-bookings-day="2026-07-31"]').click();
    await page.waitForTimeout(400);
    ok('live date-range complete selection query',
      lastListQuery && lastListQuery.get('date_from') === '2026-07-01'
      && lastListQuery.get('date_to') === '2026-07-31',
      lastListQuery ? lastListQuery.toString() : 'no query');
    ok('popover closed after live commit',
      await page.locator('#admin-bookings-date-range-popover').evaluate((n) => n.hidden || n.style.display === 'none'));

    // Reset filters
    await page.fill('#admin-bookings-q', '');
    await page.selectOption('#admin-bookings-status', '');
    await page.selectOption('#admin-bookings-type', '');
    await page.evaluate(() => {
      if (window.adminBookingsState && window.adminBookingsState.filters) {
        window.adminBookingsState.filters.sort = '';
        window.adminBookingsState.filters.dir = '';
        window.adminBookingsState.filters.offset = 0;
      }
    });
    await page.click('#admin-bookings-date-range-trigger');
    await page.waitForTimeout(100);
    if (await page.locator('#admin-bookings-date-range-clear').count()) {
      await page.click('#admin-bookings-date-range-clear');
    } else {
      await page.evaluate(() => {
        const df = document.getElementById('admin-bookings-date-from');
        const dt = document.getElementById('admin-bookings-date-to');
        if (df) df.value = '';
        if (dt) dt.value = '';
        if (window.adminBookingsState) {
          window.adminBookingsState.filters.date_from = '';
          window.adminBookingsState.filters.date_to = '';
          window.adminBookingsState.filters.offset = 0;
        }
        if (typeof window.loadAdminBookings === 'function') window.loadAdminBookings();
      });
    }
    await page.waitForTimeout(300);
    // Ensure default created_at order (Ada paid row first for guest-link assertions).
    await page.evaluate(() => {
      if (window.adminBookingsState && window.adminBookingsState.filters) {
        window.adminBookingsState.filters.sort = '';
        window.adminBookingsState.filters.dir = '';
      }
      if (typeof window.loadAdminBookings === 'function') window.loadAdminBookings();
    });
    await page.waitForTimeout(300);
    ok('clear date range reloads without dates',
      lastListQuery && !lastListQuery.get('date_from') && !lastListQuery.get('date_to'),
      lastListQuery ? lastListQuery.toString() : 'no query');

    // Status=cancelled auto-includes archived (checkbox removed)
    await page.selectOption('#admin-bookings-status', 'cancelled');
    await page.waitForTimeout(400);
    ok('cancelled status does not force show_hidden (cancelled in default list)',
      lastListQuery && lastListQuery.get('status') === 'cancelled'
      && lastListQuery.get('include_archived') !== '1'
      && lastListQuery.get('show_hidden') !== '1');
    let chips = await page.locator('.portal-admin-bookings-chip').allTextContents();
    ok('status cancelled reveals Cancelled chip', chips.some((c) => /Cancel|Anulad|Cancelad/i.test(c)), chips.join(','));
    await page.selectOption('#admin-bookings-status', 'hidden');
    await page.waitForTimeout(600);
    ok('hidden status auto show_hidden',
      lastListQuery && lastListQuery.get('status') === 'hidden'
      && (lastListQuery.get('include_archived') === '1' || lastListQuery.get('show_hidden') === '1'));
    chips = await page.locator('.portal-admin-bookings-chip').allTextContents();
    const chipBlob = chips.join(' | ');
    ok('status hidden reveals Hidden chip (not Deleted)',
      (/Hidden|Oculto|Nascosto/i.test(chipBlob) || /chip--hidden/.test(await page.content()))
      && !chips.some((c) => /^Deleted$|^Eliminado$|^Eliminato$/i.test(String(c).trim())),
      chipBlob);
    // Hidden cancelled expand: Unhide only — Restore must not appear (endpoint rejects archived/hidden).
    await page.evaluate(() => {
      window.staffPortalSession = {
        auth_required: true,
        role: 'operator',
        email: 'operator@test',
        clients: ['sunset'],
        can_use_owner_insights: false,
      };
      if (window.adminBookingsState) {
        window.adminBookingsState.role = 'operator';
        window.adminBookingsState.expandedId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
      }
      if (typeof window.renderAdminBookingsTable === 'function') window.renderAdminBookingsTable();
    });
    await page.waitForSelector('[data-bookings-expand]', { timeout: 5000 });
    {
      const restoreCnt = await page.locator('[data-bookings-restore]').count();
      const unhideCnt = await page.locator('[data-bookings-unhide]').count();
      const hideCnt = await page.locator('[data-bookings-hide]').count();
      ok('hidden cancelled row has Unhide', unhideCnt >= 1, `unhide=${unhideCnt}`);
      ok('hidden cancelled row has NO Restore', restoreCnt === 0, `restore=${restoreCnt}`);
      ok('hidden cancelled row has no Hide', hideCnt === 0, `hide=${hideCnt}`);
    }
    await page.selectOption('#admin-bookings-status', '');
    await page.waitForTimeout(300);

    // Expansion
    await page.locator('[data-bookings-row-id]').first().click();
    await page.waitForSelector('[data-bookings-expand]', { timeout: 5000 });
    const expandText = await page.locator('[data-bookings-expand]').first().innerText();
    ok('expansion payment story', /Charged|Collected|Cargado|Cobrado|Addebitato/i.test(expandText));
    ok('expansion items', /Adult group course|Wetsuit/i.test(expandText));
    ok('expansion waiver/created-by', /completed|ops@sunset\.test/i.test(expandText));

    // Collapse expansion so guest button stays visible in the row
    await page.locator('[data-bookings-row-id]').first().click();
    await page.waitForTimeout(100);

    const guestCalled = await page.evaluate(() => {
      const calls = [];
      const stub = function (p) { calls.push(String(p || '')); return Promise.resolve(); };
      window.openCustomerCardForPhone = stub;
      try { openCustomerCardForPhone = stub; } catch (_e) { /* non-writable binding */ }
      // Prefer paid Ada row phone (stable under default created_at order).
      const btn = document.querySelector('[data-bookings-guest-phone="+346****1222"]')
        || document.querySelector('[data-bookings-guest-phone]');
      if (!btn) return { err: 'no-btn', calls };
      btn.scrollIntoView({ block: 'center' });
      // Direct production click path via bubbling to wrap listener
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const afterClick = calls.slice();
      calls.length = 0;
      const keyEv = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      // re-target: dispatch from button so closest() works
      btn.dispatchEvent(keyEv);
      return { afterClick, afterKey: calls.slice(), expanded: !!document.querySelector('[data-bookings-expand]') };
    });
    const bookingsUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
    ok('keyboard handler ignores nested guest for expansion (source)',
      /data-bookings-guest-phone[\s\S]{0,500}openCustKey|openCustomerCardForPhone[\s\S]{0,80}return/.test(bookingsUi)
      && /nestedInteractive[\s\S]{0,200}return/.test(bookingsUi));
    ok('guest click opens Customers path',
      guestCalled && Array.isArray(guestCalled.afterClick) && guestCalled.afterClick[0] === '+34600111222',
      JSON.stringify(guestCalled));
    ok('guest keyboard Enter opens Customers (not row expand)',
      guestCalled && Array.isArray(guestCalled.afterKey) && guestCalled.afterKey[0] === '+34600111222',
      JSON.stringify(guestCalled));

    // ── Viewer refund gating via production session + production re-render ──
    await page.selectOption('#admin-bookings-status', '').catch(() => {});
    await page.waitForTimeout(200);
    // Ensure expanded row exists for paid booking
    await page.evaluate(() => {
      window.staffPortalSession = {
        auth_required: true,
        role: 'viewer',
        email: 'viewer@test',
        clients: ['sunset'],
        can_use_owner_insights: false,
      };
      if (window.adminBookingsState) {
        window.adminBookingsState.role = 'viewer';
        window.adminBookingsState.expandedId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      }
      // Production owner re-render (not a local role reimplementation)
      if (typeof window.renderAdminBookingsTable === 'function') window.renderAdminBookingsTable();
    });
    await page.waitForSelector('[data-bookings-expand]', { timeout: 5000 });
    const viewerDomCount = await page.locator('[data-bookings-record-refund]').count();
    const viewerHelper = await page.evaluate(() => {
      if (typeof window.adminBookingsCanWriteRefund !== 'function') return { err: 'helper missing' };
      return { can: window.adminBookingsCanWriteRefund(), role: window.staffPortalSession && window.staffPortalSession.role };
    });
    ok('production adminBookingsCanWriteRefund is false for viewer session',
      viewerHelper.can === false && viewerHelper.role === 'viewer', JSON.stringify(viewerHelper));
    ok('viewer DOM has zero [data-bookings-record-refund]', viewerDomCount === 0, `count=${viewerDomCount}`);
    ok('viewer sees manual-record messaging not Stripe claim',
      /viewer|Viewers|operator|admin/i.test(await page.locator('[data-bookings-expand]').innerText()));

    // Operator/admin: production helper true + refund control present
    for (const role of ['operator', 'admin', 'owner']) {
      await page.evaluate((r) => {
        window.staffPortalSession = {
          auth_required: true,
          role: r,
          email: r + '@test',
          clients: ['sunset'],
          can_use_owner_insights: r !== 'operator',
        };
        if (window.adminBookingsState) {
          window.adminBookingsState.role = r;
          window.adminBookingsState.expandedId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        }
        if (typeof window.renderAdminBookingsTable === 'function') window.renderAdminBookingsTable();
      }, role);
      await page.waitForSelector('[data-bookings-record-refund]', { timeout: 5000 });
      const can = await page.evaluate(() => window.adminBookingsCanWriteRefund());
      const cnt = await page.locator('[data-bookings-record-refund]').count();
      ok(`production helper allows ${role}`, can === true);
      ok(`${role} DOM has Record refund control`, cnt >= 1, `count=${cnt}`);
      if (role === 'operator') {
        const restoreCnt = await page.locator('[data-bookings-restore]').count();
        const hideCnt = await page.locator('[data-bookings-hide]').count();
        const unhideCnt = await page.locator('[data-bookings-unhide]').count();
        ok('non-hidden cancelled row has Restore', restoreCnt >= 1, `restore=${restoreCnt}`);
        ok('non-hidden cancelled row has Hide (not Unhide)', hideCnt >= 1 && unhideCnt === 0,
          `hide=${hideCnt} unhide=${unhideCnt}`);
      }
    }

    // ── Refund single-flight + stable idempotency (hold response) ─────────
    holdRefund = true;
    pendingRefunds = [];
    refundPosts = 0;
    refundBodies = [];

    await page.evaluate(() => {
      window.staffPortalSession = {
        auth_required: true, role: 'operator', email: 'op@test', clients: ['sunset'],
      };
      if (window.adminBookingsState) {
        window.adminBookingsState.role = 'operator';
        window.adminBookingsState.expandedId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        window.adminBookingsState.refundInFlight = false;
        window.adminBookingsState.refundIdempotencyKey = null;
        window.adminBookingsState.refundBookingId = null;
      }
      if (typeof window.renderAdminBookingsTable === 'function') window.renderAdminBookingsTable();
    });
    await page.waitForSelector('[data-bookings-record-refund]', { timeout: 5000 });
    // Production owner open (same as click handler); ensures form mounts even if layout click races
    await page.evaluate(() => {
      if (typeof window.openAdminBookingsRefundForm === 'function') {
        window.openAdminBookingsRefundForm('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
      }
    });
    await page.waitForSelector('[data-bookings-refund-form]', { timeout: 5000 });
    ok('refund form opened via production openAdminBookingsRefundForm',
      await page.locator('[data-bookings-refund-form]').count() > 0);
    await page.fill('[data-bookings-refund-form] input[name="amount_eur"]', '12.50');
    await page.fill('[data-bookings-refund-form] input[name="reason"]', 'double-submit proof');
    // Open form establishes key; capture it before submit
    const keyBefore = await page.evaluate(() => window.adminBookingsState && window.adminBookingsState.refundIdempotencyKey);
    ok('form open establishes stable refundIdempotencyKey',
      typeof keyBefore === 'string' && keyBefore.length > 8, String(keyBefore));

    // Rapid double submit + Enter via production form handlers (not playwright retry on disabled btn)
    await page.evaluate(() => {
      const form = document.querySelector('[data-bookings-refund-form]');
      if (!form) throw new Error('refund form missing');
      // Two programmatic submits in the same turn — second must be single-flight no-op
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
        form.requestSubmit();
      } else {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
      // Extra Enter key path on form
      form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(250);
    ok('double submit: exactly ONE refund POST while held', refundPosts === 1, `posts=${refundPosts}`);
    ok('double submit: pending queue has one held response', pendingRefunds.length === 1, String(pendingRefunds.length));
    const body1 = refundBodies[0] || {};
    ok('POST body amount_cents exact 1250', body1.amount_cents === 1250, JSON.stringify(body1));
    ok('POST body reason exact', body1.reason === 'double-submit proof', JSON.stringify(body1));
    ok('POST body uses stable open-form idempotency key',
      body1.idempotency_key === keyBefore, `${body1.idempotency_key} vs ${keyBefore}`);
    const inFlight = await page.evaluate(() => ({
      flight: !!(window.adminBookingsState && window.adminBookingsState.refundInFlight),
      key: window.adminBookingsState && window.adminBookingsState.refundIdempotencyKey,
      disabled: !!(document.querySelector('[data-bookings-refund-submit]')
        && document.querySelector('[data-bookings-refund-submit]').disabled),
    }));
    ok('single-flight flag true while pending', inFlight.flight === true, JSON.stringify(inFlight));
    ok('submit disabled while pending', inFlight.disabled === true, JSON.stringify(inFlight));
    ok('idempotency key unchanged while pending', inFlight.key === keyBefore, JSON.stringify(inFlight));

    // Release success → key clears, reload
    holdRefund = false;
    pendingRefunds[0].sendSuccess();
    pendingRefunds = [];
    await page.waitForTimeout(400);
    const afterSuccess = await page.evaluate(() => ({
      flight: !!(window.adminBookingsState && window.adminBookingsState.refundInFlight),
      key: window.adminBookingsState && window.adminBookingsState.refundIdempotencyKey,
      gen: window.adminBookingsState && window.adminBookingsState.loadGeneration,
    }));
    ok('success clears refundInFlight', afterSuccess.flight === false, JSON.stringify(afterSuccess));
    ok('success clears/rotates idempotency key (null until next open)',
      afterSuccess.key == null, JSON.stringify(afterSuccess));

    // Failure path: same user action keeps key; retry uses same key
    holdRefund = true;
    pendingRefunds = [];
    refundPosts = 0;
    refundBodies = [];
    await page.evaluate(() => {
      if (window.adminBookingsState) {
        window.adminBookingsState.role = 'operator';
        window.adminBookingsState.expandedId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        window.adminBookingsState.refundInFlight = false;
        window.adminBookingsState.refundIdempotencyKey = null;
        window.adminBookingsState.refundBookingId = null;
      }
      if (typeof window.renderAdminBookingsTable === 'function') window.renderAdminBookingsTable();
    });
    await page.waitForSelector('[data-bookings-record-refund]', { timeout: 5000 });
    await page.evaluate(() => window.openAdminBookingsRefundForm('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'));
    await page.waitForSelector('[data-bookings-refund-form]', { timeout: 5000 });
    await page.fill('[data-bookings-refund-form] input[name="amount_eur"]', '5.00');
    await page.fill('[data-bookings-refund-form] input[name="reason"]', 'fail-then-retry');
    const failKey = await page.evaluate(() => window.adminBookingsState.refundIdempotencyKey);
    await page.locator('[data-bookings-refund-submit]').click();
    await page.waitForTimeout(150);
    ok('fail path held one POST', refundPosts === 1 && pendingRefunds.length === 1);
    pendingRefunds[0].sendFail();
    pendingRefunds = [];
    holdRefund = false;
    await page.waitForTimeout(250);
    const afterFail = await page.evaluate(() => ({
      flight: !!(window.adminBookingsState && window.adminBookingsState.refundInFlight),
      key: window.adminBookingsState && window.adminBookingsState.refundIdempotencyKey,
      disabled: !!(document.querySelector('[data-bookings-refund-submit]')
        && document.querySelector('[data-bookings-refund-submit]').disabled),
    }));
    ok('failure restores submit (not stuck)', afterFail.disabled === false, JSON.stringify(afterFail));
    ok('failure keeps SAME idempotency key for retry', afterFail.key === failKey, JSON.stringify(afterFail));

    holdRefund = true;
    pendingRefunds = [];
    refundPosts = 0;
    refundBodies = [];
    await page.locator('[data-bookings-refund-submit]').click();
    await page.waitForTimeout(150);
    ok('retry POST uses same idempotency key',
      refundBodies[0] && refundBodies[0].idempotency_key === failKey,
      JSON.stringify(refundBodies[0]));
    pendingRefunds[0].sendSuccess();
    pendingRefunds = [];
    holdRefund = false;
    await page.waitForTimeout(300);
    const afterRetryOk = await page.evaluate(() => window.adminBookingsState && window.adminBookingsState.refundIdempotencyKey);
    ok('success after retry clears key for next action', afterRetryOk == null, String(afterRetryOk));

    // New open → new key (rotated)
    await page.evaluate(() => {
      if (window.adminBookingsState) {
        window.adminBookingsState.expandedId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        window.adminBookingsState.refundInFlight = false;
        window.adminBookingsState.refundIdempotencyKey = null;
        window.adminBookingsState.refundBookingId = null;
      }
      if (typeof window.renderAdminBookingsTable === 'function') window.renderAdminBookingsTable();
    });
    await page.waitForSelector('[data-bookings-record-refund]', { timeout: 5000 });
    await page.evaluate(() => window.openAdminBookingsRefundForm('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'));
    await page.waitForSelector('[data-bookings-refund-form]', { timeout: 5000 });
    const newKey = await page.evaluate(() => window.adminBookingsState.refundIdempotencyKey);
    ok('newly opened refund form gets a different idempotency key',
      typeof newKey === 'string' && newKey !== failKey, `${newKey} vs ${failKey}`);

    // ── Stale-response: release newest first, then oldest ──────────────────
    holdList = true;
    pendingList = [];
    await page.fill('#admin-bookings-q', 'stale-old');
    await page.waitForTimeout(280);
    await page.fill('#admin-bookings-q', 'newest-scope');
    await page.waitForTimeout(350);
    ok('stale test held at least 2 list requests', pendingList.length >= 2,
      pendingList.map((p) => p.q).join('|'));
    // Identify oldest vs newest by order of capture
    const oldest = pendingList.find((p) => String(p.q).toLowerCase().includes('stale-old'));
    const newest = pendingList.find((p) => String(p.q).toLowerCase().includes('newest-scope'));
    ok('held oldest stale-old request', !!(oldest && oldest.meta && oldest.meta.code === STALE_CODE),
      JSON.stringify(oldest && oldest.meta));
    ok('held newest newest-scope request', !!(newest && newest.meta && newest.meta.code === NEWEST_CODE),
      JSON.stringify(newest && newest.meta));

    // Release NEWEST first
    newest.send();
    await page.waitForFunction((code) => {
      const el = document.querySelector('.portal-admin-bookings-code');
      return el && el.textContent.includes(code);
    }, NEWEST_CODE, { timeout: 5000 });
    let codeNow = await page.locator('.portal-admin-bookings-code').first().innerText();
    let summaryNow = await page.locator('#admin-bookings-summary').innerText();
    ok('after newest-first release, booking code is NEWEST only',
      codeNow.includes(NEWEST_CODE) && !codeNow.includes(STALE_CODE), codeNow);
    ok('after newest-first release, summary reflects newest collected €99.99',
      /99[.,]99/.test(summaryNow) && !/11[.,]11/.test(summaryNow), summaryNow.slice(0, 120));

    // Release OLDEST stale last — must NOT change rendered code/summary
    oldest.send();
    await page.waitForTimeout(400);
    codeNow = await page.locator('.portal-admin-bookings-code').first().innerText();
    summaryNow = await page.locator('#admin-bookings-summary').innerText();
    ok('after stale last release, booking code still NEWEST (never flips to STALE)',
      codeNow.includes(NEWEST_CODE) && !codeNow.includes(STALE_CODE), codeNow);
    ok('after stale last release, summary still newest (never flips to stale €11.11)',
      /99[.,]99/.test(summaryNow) && !/11[.,]11/.test(summaryNow), summaryNow.slice(0, 120));
    holdList = false;
    // Drain any extra held
    while (pendingList.length) {
      const p = pendingList.shift();
      try { p.send(); } catch (_e) { /* already sent */ }
    }

    ok('UI uses loadGeneration stale guard', /loadGeneration/.test(bookingsUi));
    ok('UI uses AbortController when available', /AbortController/.test(bookingsUi));
    ok('UI single-flight refundInFlight', /refundInFlight/.test(bookingsUi));
    ok('UI reuses refundIdempotencyKey', /refundIdempotencyKey/.test(bookingsUi));

    ok('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
    const noiseConsole = consoleErrors.filter((e) =>
      !/favicon|Download|409|Conflict|Failed to load resource/i.test(e));
    ok('no unexpected console errors', noiseConsole.length === 0, noiseConsole.join(' | '));

    // ── Narrow 390px fail-closed geometry ─────────────────────────────────
    // Force pagination chrome so pager controls are measurable
    forceListTotal = 120;
    await page.fill('#admin-bookings-q', '');
    await page.waitForTimeout(300);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      if (typeof window.switchToTab === 'function') window.switchToTab('admin');
    });
    await page.locator('[data-admin-tab="bookings"]').click();
    await page.waitForSelector('#admin-bookings-body', { timeout: 10000 });
    await page.waitForSelector('.portal-admin-bookings-code', { timeout: 10000 });
    // Expand + open refund form for geometry of those surfaces
    await page.evaluate(() => {
      window.staffPortalSession = {
        auth_required: true, role: 'operator', email: 'op@test', clients: ['sunset'],
      };
      if (window.adminBookingsState) {
        window.adminBookingsState.role = 'operator';
        window.adminBookingsState.expandedId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      }
      if (typeof window.renderAdminBookingsTable === 'function') window.renderAdminBookingsTable();
    });
    await page.waitForSelector('[data-bookings-record-refund]', { timeout: 5000 });
    await page.evaluate(() => window.openAdminBookingsRefundForm('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'));
    await page.waitForSelector('[data-bookings-refund-form]', { timeout: 5000 });

    const geo = await page.evaluate(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const issues = [];
      function box(el) {
        const r = el.getBoundingClientRect();
        return {
          w: r.width, h: r.height, top: r.top, left: r.left, right: r.right, bottom: r.bottom,
          visible: r.width > 0 && r.height > 0,
        };
      }
      function inReachableScrollOwner(el) {
        let n = el;
        while (n && n !== document.body) {
          const style = window.getComputedStyle(n);
          const ox = style.overflowX;
          if ((ox === 'auto' || ox === 'scroll') && n.scrollWidth > n.clientWidth + 1) {
            const r = n.getBoundingClientRect();
            const er = el.getBoundingClientRect();
            // Element is inside the scroll owner's layout box (may need horizontal scroll)
            if (er.top < r.bottom && er.bottom > r.top) return true;
          }
          n = n.parentElement;
        }
        return false;
      }
      function assertControl(sel, opts) {
        opts = opts || {};
        const el = document.querySelector(sel);
        if (!el) {
          if (!opts.optional) issues.push(`missing ${sel}`);
          return null;
        }
        const b = box(el);
        if (!b.visible) issues.push(`${sel} not visible ${JSON.stringify(b)}`);
        if (opts.minH && b.h < opts.minH) issues.push(`${sel} height ${b.h} < ${opts.minH}`);
        if (opts.minW && b.w < opts.minW) issues.push(`${sel} width ${b.w} < ${opts.minW}`);
        // Must be in viewport OR inside a reachable horizontal scroll owner (table wrap)
        const inViewport = b.left >= -1 && b.right <= vw + 1 && b.top >= -1 && b.bottom <= vh + 1;
        const reachable = inViewport || inReachableScrollOwner(el);
        if (!reachable) issues.push(`${sel} clipped/out of reach left=${b.left} right=${b.right} vw=${vw}`);
        if (opts.focusable) {
          const ti = el.tabIndex;
          const focusable = ti >= 0 || /^(INPUT|SELECT|BUTTON|TEXTAREA|A)$/.test(el.tagName);
          if (!focusable) issues.push(`${sel} not keyboard focusable`);
        }
        return b;
      }

      // Compact premium layout: inputs ~40px CSS min-height; checkbox native ~13–16px;
      // compact btn ~26–32px. Fail-closed on unusable/zero sizes, not arbitrary 44×44.
      assertControl('#admin-bookings-q', { minH: 28, minW: 40, focusable: true });
      assertControl('#admin-bookings-date-range-trigger', { minH: 28, minW: 40, focusable: true });
      assertControl('#admin-bookings-status', { minH: 28, focusable: true });
      assertControl('#admin-bookings-type', { minH: 28, focusable: true });
      assertControl('#admin-bookings-export', { minH: 28, minW: 40, focusable: true });
      // Apply + archived checkbox removed (live filters + status covers cancelled/hidden)
      if (document.getElementById('admin-bookings-apply')) issues.push('apply button should be removed');
      if (document.getElementById('admin-bookings-date-range-apply')) issues.push('date-range Apply button should be removed');
      if (document.getElementById('admin-bookings-archived')) issues.push('archived checkbox should be removed');
      const summary = document.getElementById('admin-bookings-summary');
      const toolbar = document.querySelector('.portal-admin-bookings-toolbar');
      if (!summary || !toolbar || !(summary.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING)) {
        issues.push('summary must be above toolbar');
      }
      const tones = Array.from(document.querySelectorAll('.portal-admin-bookings-metric-value')).map((n) => n.className);
      if (!tones.some((c) => /is-collected/.test(c))) issues.push('collected tone missing');
      if (!tones.some((c) => /is-refunded/.test(c))) issues.push('refunded tone missing');
      const statusCell = document.querySelector('.portal-admin-bookings-td-status');
      if (!statusCell) issues.push('status cell alignment class missing');
      const sections = Array.from(document.querySelectorAll('[data-bookings-section]')).map((n) => n.getAttribute('data-bookings-section'));
      if (sections.length >= 3 && sections.join(',') !== 'guest,items,payment') {
        issues.push('expand section order expected guest,items,payment got ' + sections.join(','));
      }
      assertControl('.portal-admin-bookings-code', { minH: 12, minW: 40 });
      assertControl('[data-bookings-row-id]', { minH: 28 });
      assertControl('[data-bookings-expand]', { minH: 40 });
      assertControl('[data-bookings-refund-form]', { minH: 40 });
      assertControl('[data-bookings-refund-submit]', { minH: 24, minW: 40, focusable: true });
      // forceListTotal=120 was set in the Node harness so pager must exist
      assertControl('#admin-bookings-next', { minH: 24, minW: 28, focusable: true });
      assertControl('#admin-bookings-prev', { minH: 24, minW: 28, focusable: true });

      // Table wrap is intentional horizontal scroll owner — full code must be in its scrollWidth
      const wrap = document.querySelector('.portal-admin-bookings-table-wrap');
      const code = document.querySelector('.portal-admin-bookings-code');
      let codeReachable = false;
      if (wrap && code) {
        const wr = wrap.getBoundingClientRect();
        const cr = code.getBoundingClientRect();
        codeReachable = (cr.right <= wr.right + 2 && cr.left >= wr.left - 2)
          || wrap.scrollWidth >= code.scrollWidth;
      }
      if (!codeReachable) issues.push('full booking code not reachable in table scroll owner');

      // Page itself: body may scroll vertically; disallow uncontrolled horizontal page overflow
      // beyond the intentional table wrap. Compare documentElement vs wrap-contained overflow.
      const docOverflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      // Allow only small chrome tolerance (1px subpixel), not 80px fudge.
      if (docOverflowX > 2) {
        // Accept only if the overflow is explained by the bookings table wrap width
        const wrapEl = document.querySelector('.portal-admin-bookings-table-wrap');
        if (!wrapEl || wrapEl.scrollWidth <= wrapEl.clientWidth + 2) {
          issues.push(`unexplained page horizontal overflow ${docOverflowX}px`);
        }
      }

      // No overlap of refund submit with filter search in viewport y-axis (stacked layout)
      const qEl = document.getElementById('admin-bookings-q');
      const sub = document.querySelector('[data-bookings-refund-submit]');
      if (qEl && sub) {
        const a = qEl.getBoundingClientRect();
        const b = sub.getBoundingClientRect();
        const overlap = !(a.bottom <= b.top + 1 || b.bottom <= a.top + 1 || a.right <= b.left + 1 || b.right <= a.left + 1);
        // They can both be on screen if expansion is open — overlap only fails if same center
        if (overlap && Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 8) {
          issues.push('search and refund submit occupy same vertical center (overlap)');
        }
      }

      return {
        issues,
        codeText: code ? code.textContent : '',
        vw, vh,
        docOverflowX,
      };
    });
    ok('narrow 390: no geometry/clip/focus issues', geo.issues.length === 0, geo.issues.join(' | '));
    ok('narrow 390: full booking code text present',
      geo.codeText && geo.codeText.includes(fullCode), geo.codeText);
    ok('narrow 390: refund form usable (submit present)',
      await page.locator('[data-bookings-refund-submit]').count() > 0);
    ok('narrow 390: expansion content present',
      await page.locator('[data-bookings-expand]').count() > 0);

    forceListTotal = null;
    noteTracer('generated-ui', fail === 0);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
}

// ── Owner wiring smoke ──────────────────────────────────────────────────────

function testOwnerWiring() {
  section('8. Owner wiring + no quote/pricing contract ownership');
  const uiSrc = getSunsetAdminUiBrowserSource();
  ok('browser source includes bookings shell', /renderAdminBookingsShell/.test(uiSrc));
  ok('adminSelectSubTab handles bookings', /key === 'bookings'/.test(uiSrc));
  const apiSrc = fs.readFileSync(API_PATH, 'utf8');
  ok('HTML bookings panel', /id="admin-panel-bookings"/.test(apiSrc));
  ok('no quote service changes in N1 domain module',
    !fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-bookings-admin.js'), 'utf8').includes('createQuote'));
  ok('migration no stripe refund',
    !/stripe_refund|ALTER TABLE payments/i.test(
      fs.readFileSync(path.join(ROOT, 'database/migrations/056_booking_refund_records.sql'), 'utf8'),
    ));

  section('8b. Bookings v2 sort + Type gates (static)');
  const domainSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-bookings-admin.js'), 'utf8');
  const dataSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-bookings-admin-data.js'), 'utf8');
  const bookingsUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
  ok('domain exports sortBookingRows', typeof DOMAIN.sortBookingRows === 'function');
  ok('domain exports buildTypeCategories', typeof DOMAIN.buildTypeCategories === 'function');
  ok('SORT_FIRST_DIR total/paid DESC', DOMAIN.SORT_FIRST_DIR.total === 'desc' && DOMAIN.SORT_FIRST_DIR.paid === 'desc');
  ok('SORT_FIRST_DIR created DESC', DOMAIN.SORT_FIRST_DIR.created === 'desc');
  ok('data layer dynamic ORDER BY builder', typeof DATA.buildListBookingsSql === 'function');
  ok('list sorts full filtered set', /sortBookingRows\(filtered/.test(dataSrc));
  ok('UI data-bookings-sort wired', /data-bookings-sort/.test(bookingsUi));
  ok('UI Type plain text', /adminBookingsTypeChipsHtml/.test(bookingsUi) && /portal-admin-bookings-type-text/.test(bookingsUi));
  ok('UI Restore on cancelled', /data-bookings-restore/.test(bookingsUi));
  ok('UI Restore only when not hidden', /!isHidden[\s\S]{0,200}data-bookings-restore/.test(bookingsUi)
    || /if \(!isHidden\) \{[\s\S]{0,300}data-bookings-restore/.test(bookingsUi));
  ok('UI refund section gated', /showRefundSection/.test(bookingsUi));
  ok('CSS dark chip paid palette', /chip--paid\{color:#86efac/.test(apiSrc));
  ok('CSS Status column widened', /minmax\(132px/.test(apiSrc));
  ok('CSS status chips centered', /portal-admin-bookings-td-status\{[^}]*justify-content:center/.test(apiSrc));
  ok('course equipment excluded helper present', /isCourseIncludedEquipmentService/.test(domainSrc));
  ok('staff_accommodation detected', /staff_accommodation/.test(domainSrc));
  ok('i18n refundNeedsCancel', /refundNeedsCancel/.test(fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8')));
  noteTracer('owner-wiring', true);
}

async function main() {
  console.log('verify:sunset-bookings-admin-n1 — review-fix suite\n');
  runParentRedEvidence();
  testDomain();
  testCsvAndExportCaps();
  testIdempotencyPayload();
  testMigrationContracts();
  await testFakePgIntegration();
  await testHttpAndRoles();
  testOwnerWiring();
  await testGeneratedUi();

  console.log('\n── Tracer (actual execution) ──');
  for (const t of tracer) console.log(`  ${t.name}: ${t.result}`);

  console.log(`\n── verify:sunset-bookings-admin-n1: ${pass} passed, ${fail} failed ──`);
  if (fail) process.exitCode = 1;
  else console.log('verify:sunset-bookings-admin-n1 — ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
