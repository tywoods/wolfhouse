'use strict';

/**
 * verify:sunset-booking-unhide-action
 * Action-level unhide (not source-regex): load/lock signature, location scope,
 * cancelled gate, successful clear of hidden, Bookings UI POST path.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const drawerMod = require('./lib/sunset-schedule-booking-drawer');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra != null ? ` — ${extra}` : ''}`); }
}

const bookingId = '11111111-1111-1111-1111-111111111111';

function makePg(handlers) {
  const log = [];
  return {
    log,
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      log.push({ s, params });
      for (const h of handlers) {
        if (h.match(s)) return h.run(s, params);
      }
      // Default empty for unknown selects
      if (/^begin|^commit|^rollback/i.test(s)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
}

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
          metadata: {
            source: 'staff_manual_schedule',
            staff_manual_schedule: true,
            location_id: 'sunset-somo',
            schedule_archived: true,
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
          metadata: {},
        }],
      }),
    },
    ...extra,
  ];
}

const hiddenCancelled = {
  booking_id: bookingId,
  booking_code: 'SUNSET-HIDE',
  guest_name: 'Hidden',
  status: 'cancelled',
  payment_status: 'paid',
  total_amount_cents: 5000,
  hidden: true,
  metadata: {
    source: 'staff_manual_schedule',
    staff_manual_schedule: true,
    location_id: 'sunset-somo',
    schedule_archived: true,
    schedule_archived_by_staff: true,
  },
};

(async function main() {
  console.log('\nverify:sunset-booking-unhide-action\n');

  // 1) Success path
  let unhideUpdateParams = null;
  let bsrCleared = false;
  const successPg = makePg(baseBundleHandlers(hiddenCancelled, [
    {
      match: (s) => s.includes('UPDATE bookings b SET hidden = false'),
      run: async (_s, params) => {
        unhideUpdateParams = params;
        return { rowCount: 1, rows: [] };
      },
    },
    {
      match: (s) => s.includes('UPDATE booking_service_records') && s.includes("schedule_archived"),
      run: async () => {
        bsrCleared = true;
        return { rowCount: 1, rows: [] };
      },
    },
  ]));
  const okRes = await drawerMod.unhideSunsetScheduleBooking(successPg, {
    clientSlug: 'sunset',
    bookingId,
    locationId: 'sunset-somo',
  });
  ok('success: cancelled+hidden → ok', !!(okRes && okRes.ok === true && okRes.body && okRes.body.hidden === false),
    JSON.stringify(okRes && okRes.body));
  ok('success: load used positional clientSlug (not object)',
    successPg.log.some((e) => e.s.includes('FROM bookings b') && e.s.includes('SELECT b.id::text')
      && Array.isArray(e.params) && e.params[0] === 'sunset' && e.params[1] === bookingId));
  ok('success: UPDATE sets hidden=false', Array.isArray(unhideUpdateParams) && unhideUpdateParams[0] === 'sunset');
  ok('success: COMMIT issued', successPg.log.some((e) => e.s.startsWith('COMMIT')));
  ok('success: BSR archive flag cleared', bsrCleared);

  // 2) Active booking → 409
  const activePg = makePg(baseBundleHandlers({ ...hiddenCancelled, status: 'confirmed', hidden: false, metadata: { location_id: 'sunset-somo' } }));
  const activeRes = await drawerMod.unhideSunsetScheduleBooking(activePg, {
    clientSlug: 'sunset', bookingId, locationId: 'sunset-somo',
  });
  ok('active → 409 booking_not_cancelled',
    activeRes && activeRes.ok === false && activeRes.status === 409
    && activeRes.body && activeRes.body.error === 'booking_not_cancelled',
    JSON.stringify(activeRes && activeRes.body));
  ok('active: no unhide UPDATE', !activePg.log.some((e) => e.s.includes('SET hidden = false')));
  ok('active: ROLLBACK', activePg.log.some((e) => e.s.startsWith('ROLLBACK')));

  // 3) Wrong location → 404, no update
  const wrongLocPg = makePg(baseBundleHandlers(hiddenCancelled));
  const wrongLoc = await drawerMod.unhideSunsetScheduleBooking(wrongLocPg, {
    clientSlug: 'sunset', bookingId, locationId: 'sunset-sardinero',
  });
  ok('wrong location → 404 booking_not_in_active_school',
    wrongLoc && wrongLoc.ok === false && wrongLoc.status === 404
    && wrongLoc.body && wrongLoc.body.error === 'booking_not_in_active_school',
    JSON.stringify(wrongLoc && wrongLoc.body));
  ok('wrong location: no unhide UPDATE', !wrongLocPg.log.some((e) => e.s.includes('SET hidden = false')));

  // 4) Missing booking → 404
  const missPg = makePg([
    { match: (s) => s.startsWith('BEGIN'), run: async () => ({ rows: [] }) },
    { match: (s) => s.startsWith('COMMIT'), run: async () => ({ rows: [] }) },
    { match: (s) => s.startsWith('ROLLBACK'), run: async () => ({ rows: [] }) },
    {
      match: (s) => s.includes('FROM bookings b') && s.includes('SELECT b.id::text'),
      run: async () => ({ rows: [] }),
    },
  ]);
  const miss = await drawerMod.unhideSunsetScheduleBooking(missPg, {
    clientSlug: 'sunset', bookingId, locationId: 'sunset-somo',
  });
  ok('missing booking → 404', miss && miss.ok === false && miss.status === 404,
    JSON.stringify(miss && miss.body));

  // 5) Bookings UI posts unhide and reloads
  const bookingsUi = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
  ok('UI has adminBookingsUnhideBooking', /function adminBookingsUnhideBooking/.test(bookingsUi));
  ok('UI POST /staff/schedule/bookings/unhide',
    /\/staff\/schedule\/bookings\/unhide/.test(bookingsUi)
    && /method:\s*'POST'/.test(bookingsUi));
  ok('UI reloads list after unhide',
    /function adminBookingsUnhideBooking[\s\S]{0,800}loadAdminBookings\s*\(/.test(bookingsUi));
  ok('UI wires data-bookings-unhide click',
    /data-bookings-unhide[\s\S]{0,200}adminBookingsUnhideBooking/.test(bookingsUi));

  // 6) Route requires operator
  const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  const idx = api.indexOf("pathname === '/staff/schedule/bookings/unhide'");
  const block = idx >= 0 ? api.slice(idx, idx + 280) : '';
  ok('route unhide requires operator',
    /requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/.test(block)
    && /handleSunsetScheduleBookingUnhide/.test(block));

  // 7) Source no longer has object-shape load
  const drawerSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-schedule-booking-drawer.js'), 'utf8');
  const unhideFn = (drawerSrc.match(/async function unhideSunsetScheduleBooking[\s\S]*?^async function |async function unhideSunsetScheduleBooking[\s\S]*?^module\.exports/m) || [])[0] || '';
  ok('unhide load is positional',
    /loadSunsetBookingBundle\(\s*pg\s*,\s*clientSlug\s*,\s*bookingId\s*,\s*null\s*,\s*true\s*\)/.test(drawerSrc));
  ok('unhide does not pass object as clientSlug',
    !/loadSunsetBookingBundle\(\s*pg\s*,\s*\{\s*clientSlug/.test(drawerSrc));

  console.log(`\n── verify:sunset-booking-unhide-action: ${pass} passed, ${fail} failed ──`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
