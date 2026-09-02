'use strict';

/**
 * BUG-020 — Horario non-today section headers must not say HOY / truncated PREP.
 * Stay off inbox-thread.js, email-settings, Skipper inbound, Salt/Sand palette.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const cockpitSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-day-cockpit-ui.js'), 'utf8');
const dayOpsSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-day-ops-board-ui.js'), 'utf8');
const i18nSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const esSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');

const OTHER_DAY = '2026-08-12';

assert.ok(cockpitSrc.includes('function scheduleCockpitShortDateLabel'));
assert.ok(/scheduleCockpitPrepTitle\(isToday,\s*dateIso/.test(cockpitSrc));
assert.ok(dayOpsSrc.includes('function scheduleHorarioShortDateLabel'));
assert.ok(dayOpsSrc.includes('function scheduleOpsRentalPickupsTitle'));
assert.ok(dayOpsSrc.includes('scheduleRenderRentalPickupsSection(gearGroups, isToday, dateIso)'));
assert.ok(!dayOpsSrc.includes("portalT('schedule.ops.rentalPickupsToday')) + '</span>'"));
assert.ok(i18nSrc.includes("'schedule.cockpit.prepTitleOther'"));
assert.ok(i18nSrc.includes("'schedule.ops.rentalPickupsDay'"));
assert.ok(esSrc.includes("'schedule.cockpit.prepTitleOther'"));
assert.ok(esSrc.includes("'schedule.ops.rentalPickupsDay'"));
assert.ok(!cockpitSrc.includes('inbox-thread.js'));
assert.ok(!dayOpsSrc.includes('staff-email-settings'));

function runCockpitBox(lang) {
  const start = cockpitSrc.indexOf('function scheduleCockpitT');
  const end = cockpitSrc.indexOf('function scheduleCockpitDisplayName');
  const box = {
    portalLang: lang,
    portalT: (k) => k,
  };
  vm.createContext(box);
  vm.runInContext(cockpitSrc.slice(start, end) + '\nthis.scheduleCockpitPrepTitle = scheduleCockpitPrepTitle;', box);
  return box;
}

function runDayOpsBox(lang) {
  const start = dayOpsSrc.indexOf('function scheduleHorarioShortDateLabel');
  const end = dayOpsSrc.indexOf('function scheduleRenderRentalPickupsHeader');
  const box = {
    portalLang: lang,
    portalT: (k) => k,
  };
  vm.createContext(box);
  vm.runInContext(
    dayOpsSrc.slice(start, dayOpsSrc.indexOf('function scheduleRenderRentalPickupLineRow'))
    + '\nthis.scheduleOpsRentalPickupsTitle = scheduleOpsRentalPickupsTitle;',
    box
  );
  return box;
}

const es = require('./lib/staff-portal-i18n-es-sunset');

(function prepTitles() {
  const en = runCockpitBox('en');
  en.portalT = function (key) {
    if (key === 'schedule.cockpit.prepTitle') return "TODAY'S PREP";
    if (key === 'schedule.cockpit.prepTitleOther') return 'PREP FOR {date}';
    return key;
  };
  assert.strictEqual(en.scheduleCockpitPrepTitle(true, OTHER_DAY), "TODAY'S PREP");
  const enOther = en.scheduleCockpitPrepTitle(false, OTHER_DAY);
  assert.ok(enOther.indexOf('PREP FOR') === 0, enOther);
  assert.ok(!/\bHOY\b/i.test(enOther), enOther);
  assert.ok(enOther.indexOf('PREP FOR Aug') >= 0 || enOther.indexOf('PREP FOR') >= 0, enOther);

  const esBox = runCockpitBox('es');
  esBox.portalT = function (key) {
    return Object.prototype.hasOwnProperty.call(es, key) ? es[key] : key;
  };
  assert.strictEqual(esBox.scheduleCockpitPrepTitle(true, OTHER_DAY), 'PREPARACIÓN DE HOY');
  const esOther = esBox.scheduleCockpitPrepTitle(false, OTHER_DAY);
  assert.ok(esOther.indexOf('PREPARACIÓN ·') === 0, esOther);
  assert.ok(esOther.indexOf('HOY') < 0, esOther);
  assert.ok(esOther !== 'PREPARACIÓN' && esOther !== 'PREP', esOther);
})();

(function rentalPickupsTitles() {
  const en = runDayOpsBox('en');
  en.portalT = function (key) {
    if (key === 'schedule.ops.rentalPickupsToday') return 'Rental pickups today';
    if (key === 'schedule.ops.rentalPickupsDay') return 'Rental pickups · {date}';
    return key;
  };
  assert.strictEqual(en.scheduleOpsRentalPickupsTitle(true, OTHER_DAY), 'Rental pickups today');
  const enOther = en.scheduleOpsRentalPickupsTitle(false, OTHER_DAY);
  assert.ok(enOther.indexOf('Rental pickups ·') === 0, enOther);
  assert.ok(enOther.toLowerCase().indexOf('today') < 0, enOther);

  const esBox = runDayOpsBox('es');
  esBox.portalT = function (key) {
    return Object.prototype.hasOwnProperty.call(es, key) ? es[key] : key;
  };
  assert.strictEqual(esBox.scheduleOpsRentalPickupsTitle(true, OTHER_DAY), 'Recogidas de alquiler hoy');
  const esOther = esBox.scheduleOpsRentalPickupsTitle(false, OTHER_DAY);
  assert.ok(esOther.indexOf('Recogidas de alquiler ·') === 0, esOther);
  assert.ok(esOther.indexOf('hoy') < 0, esOther);
})();

console.log('PASS BUG-020 Horario date-aware prep + rental pickup headers');
