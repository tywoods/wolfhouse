'use strict';

/**
 * verify:sunset-schedule-booking-lifecycle
 *
 * Cancelled tag, Restore, Delete wording, finance audit classification.
 * Run: node scripts/verify-sunset-schedule-booking-lifecycle.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const STAFF_API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const ACTIONS = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-actions.js');
const VIEW = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const DAY_OPS = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-day-ops-board-ui.js');
const DRAWER = path.join(ROOT, 'scripts', 'lib', 'sunset-schedule-booking-drawer.js');
const FINANCE_DATA = path.join(ROOT, 'scripts', 'lib', 'sunset-finance-data.js');
const MIG_UP = path.join(ROOT, 'database', 'migrations', '053_payment_finance_exclusion.sql');
const MIG_DOWN = path.join(ROOT, 'database', 'migrations', '053_payment_finance_exclusion_down.sql');
const MANIFEST = path.join(ROOT, 'database', 'migrations', 'canonical-manifest.json');

let pass = 0;
let fail = 0;
const failures = [];
function ok(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else {
    const msg = detail ? ` — ${detail}` : '';
    console.error(`  FAIL  ${label}${msg}`);
    fail += 1;
    failures.push(label + msg);
  }
}

function extractRouteBlock(src, pathnameLiteral, methodLiteral) {
  const needle = `pathname === '${pathnameLiteral}' && method === '${methodLiteral}'`;
  const idx = src.indexOf(needle);
  if (idx < 0) return null;
  const next = src.indexOf('\n  if (pathname ===', idx + needle.length);
  const end = next > idx ? next : idx + 320;
  return src.slice(idx, end);
}

function sha256CanonicalLf(buf) {
  const text = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

console.log('\nverify:sunset-schedule-booking-lifecycle\n');

const apiSrc = fs.readFileSync(STAFF_API, 'utf8');
const actionsSrc = fs.readFileSync(ACTIONS, 'utf8');
const viewSrc = fs.readFileSync(VIEW, 'utf8');
const dayOpsSrc = fs.readFileSync(DAY_OPS, 'utf8');
const drawerSrc = fs.readFileSync(DRAWER, 'utf8');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');
const en = STAFF_PORTAL_STRINGS.en;
const es = STAFF_PORTAL_STRINGS.es;
const drawerMod = require('./lib/sunset-schedule-booking-drawer');
const financeData = require('./lib/sunset-finance-data');

console.log('[1] Real router auth matrix');
const cancelBlock = extractRouteBlock(apiSrc, '/staff/schedule/bookings/cancel', 'POST');
const restoreBlock = extractRouteBlock(apiSrc, '/staff/schedule/bookings/restore', 'POST');
const deleteBlock = extractRouteBlock(apiSrc, '/staff/schedule/bookings', 'DELETE');
ok('POST cancel route present', !!cancelBlock);
ok('POST restore route present', !!restoreBlock);
ok('DELETE route present', !!deleteBlock);
ok('cancel requires operator auth', !!(cancelBlock && /requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/.test(cancelBlock) && /if\s*\(\s*!auth\.ok\s*\)\s*return/.test(cancelBlock)));
ok('restore requires operator auth', !!(restoreBlock && /requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/.test(restoreBlock) && /if\s*\(\s*!auth\.ok\s*\)\s*return/.test(restoreBlock)));
ok('delete requires operator auth', !!(deleteBlock && /requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/.test(deleteBlock)));
ok('auth matrix: unauth/viewer blocked (operator only)',
  !!(cancelBlock && restoreBlock && !/'viewer'/.test(cancelBlock) && !/'viewer'/.test(restoreBlock)));

console.log('\n[2] Delete wording + Restore i18n');
ok('Delete booking label', en['schedule.drawer.deleteBooking'] === 'Delete booking');
ok('Delete confirm mentions delete', /Delete this (cancelled )?booking/i.test(String(en['schedule.drawer.deleteBookingConfirm'] || '')));
ok('Delete failed copy', /Could not delete booking/i.test(String(en['schedule.drawer.deleteBookingFailed'] || '')));
ok('Restore booking label', en['schedule.drawer.restoreBooking'] === 'Restore booking');
ok('Restore confirm present', !!en['schedule.drawer.restoreBookingConfirm']);
ok('Restore failed present', !!en['schedule.drawer.restoreBookingFailed']);
ok('Cancelled status tag', en['schedule.status.cancelled'] === 'Cancelled');
ok('ES restore present', /[Rr]estaur/.test(String(es['schedule.drawer.restoreBooking'] || '')));
ok('view uses Delete booking key', viewSrc.includes("portalT('schedule.drawer.deleteBooking')") && !viewSrc.includes("portalT('schedule.drawer.removeFromSchedule')"));
ok('actions use Delete booking confirm/fail keys',
  actionsSrc.includes("portalT('schedule.drawer.deleteBookingConfirm')")
  && actionsSrc.includes("portalT('schedule.drawer.deleteBookingFailed')")
  && !actionsSrc.includes("portalT('schedule.drawer.removeFromSchedule"));

console.log('\n[3] Cancelled tag + grey CSS');
ok('status.is-cancelled CSS', /\.portal-schedule-status\.is-cancelled\s*\{/.test(apiSrc));
ok('ops-row.is-cancelled grey styling', /\.portal-schedule-ops-row\.is-cancelled/.test(apiSrc) && /opacity:\s*0\.5/.test(apiSrc));
ok('dark theme cancelled status CSS',
  /\[data-theme="dark"\][\s\S]{0,120}\.portal-schedule-status\.is-cancelled/.test(apiSrc)
  || /\[data-theme="dark"\]\s*\.portal-schedule-status\.is-cancelled/.test(apiSrc));
ok('badge prefers Cancelled over Paid/Unpaid',
  /function scheduleRenderStatusBadgeHtml\(group, opts\)\{[\s\S]{0,900}is-cancelled[\s\S]{0,200}schedule\.status\.cancelled/.test(apiSrc));

console.log('\n[4] Drawer Active / Cancelled lifecycle');
ok('view has restore button', viewSrc.includes('ps-drawer-restore-booking'));
ok('view has cancel + delete ids', viewSrc.includes('ps-drawer-cancel-booking') && viewSrc.includes('ps-drawer-delete-booking'));
ok('restore non-red class', viewSrc.includes('portal-schedule-restore-booking-btn'));
ok('delete stays red class', viewSrc.includes('portal-schedule-delete-booking-btn'));
ok('canRestoreBooking present', /canRestoreBooking/.test(actionsSrc));
ok('restore posts /restore', actionsSrc.includes('/staff/schedule/bookings/restore'));
const deleteFn = (actionsSrc.match(/function deleteBookingFromDrawer\(\) \{[\s\S]*?\n  \}\n\n  function wireDeleteBooking/) || [])[0] || '';
ok('no Active→cancel redirect inside deleteBookingFromDrawer',
  !!deleteFn && !/cancelBookingFromDrawer/.test(deleteFn) && /Never permit direct Active/.test(deleteFn));
ok('DELETE handler has no cancel fallback', !/cancel_before_archive[\s\S]{0,180}cancelSunsetScheduleBooking/.test(apiSrc));
ok('restoreSunsetScheduleBooking exported', typeof drawerMod.restoreSunsetScheduleBooking === 'function');

console.log('\n[5] Generated /staff/ui labels/classes/CSS');
ok('cooked Restore booking',
  apiSrc.includes("getStaffPortalI18nBootstrapScript")
  && (en['schedule.drawer.restoreBooking'] === 'Restore booking')
  && require('./lib/staff-portal-i18n').getStaffPortalI18nBootstrapScript().includes('Restore booking'));
ok('cooked Delete booking', apiSrc.includes('Delete booking') || apiSrc.includes('schedule.drawer.deleteBooking'));
ok('cooked restore CSS non-red',
  /\.portal-schedule-restore-booking-btn/.test(apiSrc)
  && !/\.portal-schedule-restore-booking-btn\{[^}]*#9C4A42/.test(apiSrc));

console.log('\n[6] Finance audit + migration');
const paySql = String(financeData.PAYMENTS_SQL || '');
ok('PAYMENTS_SQL excludes finance_exclusion', /finance_exclusion/.test(paySql));
ok('migration 053 up exists', fs.existsSync(MIG_UP));
ok('migration 053 down exists', fs.existsSync(MIG_DOWN));
if (fs.existsSync(MIG_UP) && fs.existsSync(MIG_DOWN) && fs.existsSync(MANIFEST)) {
  const upBuf = fs.readFileSync(MIG_UP);
  const up = upBuf.toString('utf8');
  const down = fs.readFileSync(MIG_DOWN, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const entry = (manifest.entries || []).find((e) => e.id === '053_payment_finance_exclusion');
  ok('manifest lists 053', !!entry);
  ok('053 has CHECK + INDEX', /CHECK|CONSTRAINT/i.test(up) && /INDEX/i.test(up));
  ok('053 down reversible', /DROP|ALTER/i.test(down));
  if (entry) ok('053 manifest sha matches', entry.sha256 === sha256CanonicalLf(upBuf));
}
ok('archive classifies payments; never DELETE payments',
  /finance_exclusion/.test(drawerSrc) && !/DELETE FROM payments/i.test(drawerSrc));
ok('no Stripe refunds.create in drawer lifecycle', !/refunds\.create|stripe\.refunds/.test(drawerSrc));

function makePg(handlers) {
  const log = [];
  return {
    log,
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      log.push({ s, params });
      for (const h of handlers) {
        if (h.match(s, params)) return h.run(sql, params, s);
      }
      throw new Error('unexpected sql: ' + s.slice(0, 240));
    },
  };
}

const bookingId = '11111111-1111-1111-1111-111111111111';
const cancelledBooking = {
  booking_id: bookingId,
  booking_code: 'SUNSET-CXL',
  guest_name: 'Ghost',
  status: 'cancelled',
  payment_status: 'paid',
  total_amount_cents: 5000,
  metadata: {
    source: 'staff_manual_schedule',
    staff_manual_schedule: true,
    location_id: 'sunset-somo',
    cancelled_by_staff: true,
    payment_link_invalidated: true,
    sunset_stripe_link_stale: true,
  },
};

function baseBundleHandlers(bookingRow, extra = []) {
  return [
    { match: (s) => s.startsWith('BEGIN'), run: async () => ({ rows: [] }) },
    { match: (s) => s.startsWith('COMMIT'), run: async () => ({ rows: [] }) },
    { match: (s) => s.startsWith('ROLLBACK'), run: async () => ({ rows: [] }) },
    {
      match: (s) => s.includes('FROM bookings b') && s.includes('SELECT b.id::text'),
      run: async () => ({ rows: [bookingRow] }),
    },
    {
      match: (s) => s.includes('FROM booking_service_records') && s.includes('SELECT id::text'),
      run: async () => ({
        rows: [{
          service_record_id: '22222222-2222-2222-2222-222222222222',
          service_type: 'surf_lesson',
          service_date: '2026-08-10',
          quantity: 1,
          status: 'cancelled',
          amount_due_cents: 5000,
          location_id: 'sunset-somo',
          metadata_source: 'staff_manual_schedule',
          staff_manual_schedule: 'true',
          metadata: {
            source: 'staff_manual_schedule',
            staff_manual_schedule: true,
            location_id: 'sunset-somo',
            component: 'course',
            course_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            course_label: 'Course A',
          },
        }],
      }),
    },
    {
      match: (s) => s.includes('FROM payments p') && s.includes('checkout_url IS NOT NULL') && !s.includes('UPDATE'),
      run: async () => ({ rows: [] }),
    },
    {
      match: (s) => s.includes('SUM') && s.includes('amount_paid_cents'),
      run: async () => ({ rows: [{ paid_total: 5000 }] }),
    },
    {
      match: (s) => s.includes("status = 'paid'") && s.includes('SELECT p.id::text AS payment_id'),
      run: async () => ({
        rows: [{
          payment_id: 'paid1',
          payment_status: 'paid',
          amount_paid_cents: 5000,
          amount_due_cents: 5000,
          currency: 'eur',
          stripe_payment_intent_id: 'pi_x',
          metadata: {},
        }],
      }),
    },
    ...extra,
  ];
}

console.log('\n[7] Restore / Delete behavioral (fake pg)');

(async function runAsync() {
  if (typeof drawerMod.restoreSunsetScheduleBooking === 'function') {
    const restoreExtra = [
      {
        match: (s) => /information_schema|CREATE TABLE IF NOT EXISTS tenant_surf_pack|CREATE INDEX IF NOT EXISTS idx_tenant_surf_pack/i.test(s),
        run: async () => ({ rows: [{ exists: true, column_name: 'location_id' }] }),
      },
      {
        match: (s) => s.includes('FROM tenant_surf_pack_rules'),
        run: async () => ({
          rows: [{
            id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            label: 'Course A',
            config_json: {
              group_size: 8,
              schedules: ['0930_1130'],
              weekly: 'daily',
              beaches: ['somo'],
              price_tiers: [{ key: '1_day', label: '1 day', hours: 2, amount_cents: 5000 }],
            },
          }],
        }),
      },
      {
        match: (s) => s.includes('AS seats') && s.includes('booking_service_records'),
        run: async () => ({ rows: [{ seats: 0 }] }),
      },
      {
        match: (s) => s.includes('UPDATE booking_service_records') && s.includes("'confirmed'"),
        run: async () => ({ rowCount: 1, rows: [] }),
      },
      {
        match: (s) => s.includes('UPDATE bookings') && /status\s*=/.test(s),
        run: async () => ({ rowCount: 1, rows: [] }),
      },
    ];
    const pg = makePg(baseBundleHandlers(cancelledBooking, restoreExtra));
    let restoreResult;
    try {
      restoreResult = await drawerMod.restoreSunsetScheduleBooking(pg, {
        clientSlug: 'sunset', bookingId, locationId: 'sunset-somo',
      });
    } catch (err) {
      restoreResult = { ok: false, body: { error: String(err.message || err) } };
    }
    ok('restore success', !!(restoreResult && restoreResult.ok === true), restoreResult && restoreResult.body && restoreResult.body.error);
    ok('restore does not clear invalidated payment links',
      !pg.log.some((e) => /payment_link_invalidated['"]?\s*:\s*false/.test(JSON.stringify(e.params || []))));
    ok('restore does not invent checkout_url',
      !pg.log.some((e) => /UPDATE payments/i.test(e.s) && /checkout_url\s*=(?!\s*NULL)/i.test(e.s)));

    const busyPg = makePg(baseBundleHandlers(cancelledBooking, [{
      match: (s) => s.includes('FROM bookings b') && s.includes('SELECT b.id::text'),
      run: async () => {
        const e = new Error('could not obtain lock on row in relation "bookings"');
        e.code = '55P03';
        throw e;
      },
    }]));
    const busy = await drawerMod.restoreSunsetScheduleBooking(busyPg, {
      clientSlug: 'sunset', bookingId, locationId: 'sunset-somo',
    }).catch((err) => ({ ok: false, body: { error: String(err.message) } }));
    ok('restore lock conflict fails closed', busy && busy.ok === false);
    ok('restore lock conflict no BSR restore mutation',
      !busyPg.log.some((e) => e.s.includes('UPDATE booking_service_records') && e.s.includes("'confirmed'")));
    ok('restore lock conflict no commit', !busyPg.log.some((e) => e.s.startsWith('COMMIT')));

    const archPg = makePg(baseBundleHandlers({
      ...cancelledBooking,
      metadata: { ...cancelledBooking.metadata, schedule_archived: true },
    }));
    const arch = await drawerMod.restoreSunsetScheduleBooking(archPg, {
      clientSlug: 'sunset', bookingId, locationId: 'sunset-somo',
    }).catch((err) => ({ ok: false, body: { error: String(err.message) } }));
    ok('restore rejects archived', arch && arch.ok === false);

    const activePg = makePg(baseBundleHandlers({ ...cancelledBooking, status: 'confirmed' }));
    const active = await drawerMod.restoreSunsetScheduleBooking(activePg, {
      clientSlug: 'sunset', bookingId, locationId: 'sunset-somo',
    }).catch((err) => ({ ok: false, body: { error: String(err.message) } }));
    ok('restore rejects active', active && active.ok === false);
  } else {
    ['restore success', 'restore does not clear invalidated payment links', 'restore does not invent checkout_url',
      'restore lock conflict fails closed', 'restore lock conflict no BSR restore mutation',
      'restore lock conflict no commit', 'restore rejects archived', 'restore rejects active']
      .forEach((l) => ok(l, false, 'restoreSunsetScheduleBooking missing'));
  }

  if (typeof drawerMod.archiveSunsetScheduleBooking === 'function') {
    const classifyLog = [];
    const archPg = makePg(baseBundleHandlers(cancelledBooking, [
      {
        match: (s) => s.includes('UPDATE bookings b SET metadata') && s.includes('FROM clients c'),
        run: async (_sql, params) => {
          classifyLog.push({ kind: 'archive_booking', params });
          return { rowCount: 1, rows: [] };
        },
      },
      {
        match: (s) => s.includes('UPDATE booking_service_records') && s.includes('metadata = COALESCE(metadata'),
        run: async () => ({ rowCount: 1, rows: [] }),
      },
      {
        match: (s) => s.includes('UPDATE payments') && s.includes('finance_exclusion'),
        run: async (_sql, params) => {
          classifyLog.push({ kind: 'classify_payment', params });
          return { rowCount: 1, rows: [] };
        },
      },
    ]));
    archPg.query = ((orig) => async (sql, params) => {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      if (s.includes('SUM') && s.includes('amount_paid_cents')) return { rows: [{ paid_total: 2500 }] };
      return orig(sql, params);
    })(archPg.query.bind(archPg));

    const archived = await drawerMod.archiveSunsetScheduleBooking(archPg, {
      clientSlug: 'sunset', bookingId, locationId: 'sunset-somo',
    });
    ok('delete/archive after cancel succeeds', !!(archived && archived.ok));
    ok('delete classifies payments',
      classifyLog.length > 0
      || archPg.log.some((e) => /finance_exclusion|payment_capture_class|partial|full/.test(e.s + JSON.stringify(e.params || []))));
    ok('delete never DELETE FROM payments', !archPg.log.some((e) => /DELETE FROM payments/i.test(e.s)));
    ok('delete never DELETE FROM payment_events', !archPg.log.some((e) => /DELETE FROM payment_events/i.test(e.s)));

    const activeDel = await drawerMod.archiveSunsetScheduleBooking(
      makePg(baseBundleHandlers({ ...cancelledBooking, status: 'confirmed' })),
      { clientSlug: 'sunset', bookingId, locationId: 'sunset-somo' },
    );
    ok('delete only after cancellation',
      activeDel && activeDel.ok === false
      && activeDel.body && activeDel.body.error === 'cancel_before_archive');
  } else {
    ['delete/archive after cancel succeeds', 'delete classifies payments',
      'delete never DELETE FROM payments', 'delete never DELETE FROM payment_events',
      'delete only after cancellation'].forEach((l) => ok(l, false));
  }

  console.log('\n[8] Active vs Cancelled badges / chips');
  const badgeFnMatch = apiSrc.match(/function scheduleRenderStatusBadgeHtml\(group, opts\)\{[\s\S]*?\n\}/);
  ok('badge function extractable', !!badgeFnMatch);
  if (badgeFnMatch) {
    const portalT = (k) => ({
      'schedule.status.paid': 'Paid',
      'schedule.status.unpaid': 'Unpaid',
      'schedule.status.cancelled': 'Cancelled',
      'schedule.status.waiverSigned': 'Waiver',
      'schedule.drawer.needsReply': 'Needs reply',
    }[k] || k);
    const escHtml = (s) => String(s);
    // eslint-disable-next-line no-new-func
    const render = new Function('portalT', 'escHtml', `${badgeFnMatch[0]}; return scheduleRenderStatusBadgeHtml;`)(portalT, escHtml);
    const activePaid = render({ payment_status: 'paid' });
    const activeUnpaid = render({ payment_status: 'unpaid' });
    const cancelled = render({
      payment_status: 'paid', booking_status: 'cancelled', schedule_ghost: true, _isCancelled: true,
    });
    ok('active Paid', /is-paid/.test(activePaid) && /Paid/.test(activePaid));
    ok('active Unpaid', /is-unpaid/.test(activeUnpaid) && /Unpaid/.test(activeUnpaid));
    ok('cancelled Cancelled tag', /is-cancelled/.test(cancelled) && /Cancelled/.test(cancelled));
    ok('cancelled hides Paid/Unpaid', !/is-paid/.test(cancelled) && !/is-unpaid/.test(cancelled));
  } else {
    ['active Paid', 'active Unpaid', 'cancelled Cancelled tag', 'cancelled hides Paid/Unpaid']
      .forEach((l) => ok(l, false));
  }
  ok('Staff/Luna chip preserved separately', dayOpsSrc.includes('portal-schedule-src-chip') && dayOpsSrc.includes('scheduleDayOpsRowStatusHtml'));
  ok('cancelled rows stay clickable', /data-ps-booking-id/.test(dayOpsSrc) && /is-cancelled/.test(dayOpsSrc));
  ok('ghost grouping not reimplemented in actions', !actionsSrc.includes("slot_key: 'cancelled-ghosts'"));

  console.log(`\n── verify:sunset-schedule-booking-lifecycle ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  if (fail) {
    console.error('RED failures:');
    failures.forEach((f) => console.error('  -', f));
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
