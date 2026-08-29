'use strict';

/**
 * Reservas Partidas (line-item) dates must follow the staff portal locale,
 * not the browser host locale. On sunset ES, "2026-08-11" → Spanish short date
 * (e.g. "11 ago 2026"), never English "Aug 11, 2026".
 *
 * Scope: sunset-admin-bookings-ui.js only.
 * Stay off: inbox-thread, email-settings, Graph/IMAP/SMTP, Auto-send, production.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const bookingsUi = fs.readFileSync(
  path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'),
  'utf8'
);

assert.ok(
  bookingsUi.includes('function adminBookingsLocaleTag'),
  'adminBookingsLocaleTag required'
);
assert.ok(
  bookingsUi.includes('function adminBookingsFormatItemDate'),
  'adminBookingsFormatItemDate required'
);
// Must not fall back to browser-host locale for Partidas.
assert.ok(
  !/adminBookingsFormatItemDate[\s\S]{0,800}toLocaleDateString\(\s*undefined\s*,/.test(bookingsUi),
  'Partidas formatter must not use toLocaleDateString(undefined)'
);
assert.ok(
  !/adminBookingsFormatItemDate[\s\S]{0,900}scheduleFormatDrawerDateDisplay/.test(bookingsUi),
  'Partidas must not delegate to scheduleFormatDrawerDateDisplay (browser locale)'
);
assert.ok(bookingsUi.includes('adminBookingsLocaleTag()'), 'formatter calls locale tag helper');
assert.ok(bookingsUi.includes('getStaffLocale'), 'reads staff portal locale');
assert.ok(!bookingsUi.includes('inbox-thread'), 'stays off inbox-thread');
assert.ok(!bookingsUi.includes('staff-email-luna-draft'), 'stays off email draft');

const ISO = '2026-08-11';
const ISO_TS = '2026-08-11T09:00:00.000Z';

const expectedEn = new Date(Date.UTC(2026, 7, 11, 12, 0, 0)).toLocaleDateString('en-GB', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});
const expectedEs = new Date(Date.UTC(2026, 7, 11, 12, 0, 0)).toLocaleDateString('es-ES', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});

assert.ok(/Aug/i.test(expectedEn), 'en-GB fixture sanity: ' + expectedEn);
assert.ok(/ago/i.test(expectedEs), 'es-ES fixture sanity: ' + expectedEs);
assert.notStrictEqual(expectedEn, expectedEs, 'EN and ES formats must differ');

function loadFormatter(sandbox) {
  const start = bookingsUi.indexOf('function adminBookingsLocaleTag');
  const end = bookingsUi.indexOf('function adminBookingsCleanItemLabel');
  assert.ok(start >= 0 && end > start, 'formatter slice bounds');
  const box = Object.assign({}, sandbox);
  vm.createContext(box);
  vm.runInContext(
    bookingsUi.slice(start, end)
      + '\nthis.adminBookingsLocaleTag = adminBookingsLocaleTag;'
      + '\nthis.adminBookingsFormatItemDate = adminBookingsFormatItemDate;',
    box
  );
  return box;
}

// EN via getStaffLocale — even if a host-locale drawer helper would return English US form.
{
  const box = loadFormatter({
    getStaffLocale() { return 'en'; },
    // Hostile: if still called, would push browser-style English and hide the bug.
    scheduleFormatDrawerDateDisplay() { return 'Aug 11, 2026'; },
  });
  assert.strictEqual(box.adminBookingsLocaleTag(), 'en-GB', 'EN locale tag');
  assert.strictEqual(box.adminBookingsFormatItemDate(ISO), expectedEn, 'EN date-only');
  assert.strictEqual(box.adminBookingsFormatItemDate(ISO_TS), expectedEn, 'EN timestamp stripped');
  assert.ok(!/^\d{4}-\d{2}-\d{2}$/.test(box.adminBookingsFormatItemDate(ISO)), 'not raw ISO');
}

// ES via getStaffLocale — must not stay English when portal is Spanish.
{
  const box = loadFormatter({
    getStaffLocale() { return 'es'; },
    scheduleFormatDrawerDateDisplay() { return 'Aug 11, 2026'; },
  });
  assert.strictEqual(box.adminBookingsLocaleTag(), 'es-ES', 'ES locale tag');
  const out = box.adminBookingsFormatItemDate(ISO);
  assert.strictEqual(out, expectedEs, 'ES Partidas date');
  assert.ok(/ago/i.test(out), 'ES month name present: ' + out);
  assert.ok(!/Aug/i.test(out), 'must not keep English Aug when portal is ES: ' + out);
  assert.notStrictEqual(out, 'Aug 11, 2026', 'must ignore hostile drawer English');
}

// portalLang fallback when getStaffLocale missing.
{
  const box = loadFormatter({ portalLang: 'es' });
  assert.strictEqual(box.adminBookingsLocaleTag(), 'es-ES', 'portalLang ES');
  assert.strictEqual(box.adminBookingsFormatItemDate(ISO), expectedEs, 'portalLang ES date');
}

// Empty / invalid.
{
  const box = loadFormatter({ getStaffLocale() { return 'es'; } });
  assert.strictEqual(box.adminBookingsFormatItemDate(''), '');
  assert.strictEqual(box.adminBookingsFormatItemDate(null), '');
  assert.strictEqual(box.adminBookingsFormatItemDate('not-a-date'), '');
}

// Expansion HTML under ES — Partidas line uses localized date, not raw ISO / English.
{
  const start = bookingsUi.indexOf('function adminBookingsLocaleTag');
  const endHelpers = bookingsUi.indexOf('/** Booking created_at');
  const expStart = bookingsUi.indexOf('function renderAdminBookingsExpansion');
  const expEnd = bookingsUi.indexOf('function openAdminBookingsRefundForm');
  assert.ok(start >= 0 && endHelpers > start && expStart > 0 && expEnd > expStart, 'expand slice');

  const escHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const box = {
    getStaffLocale() { return 'es'; },
    escHtml,
    portalT(k) { return k; },
    adminBookingsFormatEur(cents) {
      const n = Number(cents || 0);
      return '€' + (n / 100).toFixed(2);
    },
    adminBookingsFormatMadridCreated(iso) { return String(iso || '').slice(0, 16).replace('T', ' '); },
    adminBookingsCanWriteRefund() { return false; },
    adminBookingsRowKey(row) { return String((row && row.booking_id) || 'row'); },
    scheduleFormatDrawerDateDisplay() { return 'Aug 11, 2026'; },
  };
  vm.createContext(box);
  vm.runInContext(
    bookingsUi.slice(start, endHelpers)
      + bookingsUi.slice(expStart, expEnd)
      + '\nthis.render = renderAdminBookingsExpansion;'
      + '\nthis.fmt = adminBookingsFormatItemDate;',
    box
  );

  const html = box.render({
    booking_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    guest_name: 'Gary',
    phone: '+34600111222',
    status: 'paid',
    items: [
      {
        label: 'Adult group course',
        service_date: ISO_TS,
        amount_due_cents: 12000,
      },
    ],
    payment_story: { charged_cents: 12000, collected_cents: 12000, refunded_cents: 0, net_cents: 12000 },
    waiver: { status: 'completed' },
    refunds: [],
  });

  assert.ok(html.indexOf('data-bookings-expand=') >= 0, 'expand present');
  assert.ok(html.indexOf('Adult group course · ' + expectedEs) >= 0,
    'ES localized Partidas date in expand HTML, got: ' + html.slice(0, 500));
  assert.ok(html.indexOf('2026-08-11') < 0, 'no raw ISO date in expand');
  assert.ok(html.indexOf('Aug 11') < 0, 'no English Aug in ES expand');
}

console.log('PASS Reservas Partidas dates follow staff locale (EN/ES)');
