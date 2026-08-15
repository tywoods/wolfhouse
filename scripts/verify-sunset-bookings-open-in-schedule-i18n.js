'use strict';

/**
 * Reservas booking-code control — never show raw i18n key in EN or ES.
 * Label + booking code must be localized (aria-label / title).
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { STAFF_PORTAL_STRINGS } = require('./lib/staff-portal-i18n');

const ROOT = path.join(__dirname, '..');
const KEY = 'admin.bookings.openInSchedule';
const CODE = 'SUNSET-20260811-EA783E';

assert.strictEqual(STAFF_PORTAL_STRINGS.en[KEY], 'Open in Schedule', 'EN pack');
assert.strictEqual(STAFF_PORTAL_STRINGS.es[KEY], 'Abrir en Agenda', 'ES pack');

const bookingsSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-bookings-ui.js'), 'utf8');
const labelStart = bookingsSrc.indexOf('function adminBookingsOpenScheduleLabel');
const labelEnd = bookingsSrc.indexOf('var ADMIN_BOOKINGS_SORT_FIRST_DIR');
assert.ok(labelStart > 0 && labelEnd > labelStart, 'helper present');
assert.ok(bookingsSrc.includes("title=\"' + escHtml(openScheduleLabel) + '\""), 'title uses localized label');
assert.ok(bookingsSrc.includes("aria-label=\"' + escHtml(openScheduleLabel) + '\""), 'aria-label uses localized label');
assert.ok(bookingsSrc.includes('adminBookingsOpenScheduleLabel(code)'), 'render calls helper');
assert.ok(!bookingsSrc.includes('inbox-thread'), 'stays off inbox-thread');

function loadHelper(sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(
    bookingsSrc.slice(labelStart, labelEnd) +
      '\nthis.adminBookingsOpenScheduleLabel = adminBookingsOpenScheduleLabel;',
    sandbox
  );
  return sandbox.adminBookingsOpenScheduleLabel;
}

function assertClean(label, where) {
  assert.ok(!/admin\.bookings\./.test(label), where + ' leaked key: ' + label);
  assert.ok(label.indexOf(CODE) >= 0, where + ' missing code: ' + label);
}

// EN via portalT
{
  const box = {
    portalT(key) { return STAFF_PORTAL_STRINGS.en[key] || key; },
    getStaffLocale() { return 'en'; },
  };
  const fn = loadHelper(box);
  const out = fn(CODE);
  assert.strictEqual(out, 'Open in Schedule: ' + CODE, 'EN portalT');
  assertClean(out, 'EN portalT');
}

// ES via portalT
{
  const box = {
    portalT(key) { return STAFF_PORTAL_STRINGS.es[key] || key; },
    getStaffLocale() { return 'es'; },
  };
  const fn = loadHelper(box);
  const out = fn(CODE);
  assert.strictEqual(out, 'Abrir en Agenda: ' + CODE, 'ES portalT');
  assertClean(out, 'ES portalT');
}

// portalT returns raw key → locale-aware fallback (EN)
{
  const box = {
    portalT(key) { return key; },
    getStaffLocale() { return 'en'; },
  };
  const fn = loadHelper(box);
  const out = fn(CODE);
  assert.strictEqual(out, 'Open in Schedule: ' + CODE, 'EN raw-key fallback');
  assertClean(out, 'EN raw-key fallback');
}

// portalT returns raw key → locale-aware fallback (ES)
{
  const box = {
    portalT(key) { return key; },
    getStaffLocale() { return 'es'; },
  };
  const fn = loadHelper(box);
  const out = fn(CODE);
  assert.strictEqual(out, 'Abrir en Agenda: ' + CODE, 'ES raw-key fallback');
  assertClean(out, 'ES raw-key fallback');
}

// portalT missing → window.t pack hit (ES)
{
  const box = {
    window: {
      t(key) { return STAFF_PORTAL_STRINGS.es[key] || key; },
    },
    getStaffLocale() { return 'es'; },
  };
  const fn = loadHelper(box);
  const out = fn(CODE);
  assert.strictEqual(out, 'Abrir en Agenda: ' + CODE, 'ES window.t');
  assertClean(out, 'ES window.t');
}

console.log('PASS Reservas open-in-schedule i18n (EN+ES, no raw key)');
