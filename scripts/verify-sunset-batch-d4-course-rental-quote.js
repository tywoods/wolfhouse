'use strict';

/**
 * verify:sunset-batch-d4-course-rental-quote
 * D4: Group Course on, none selected + standalone rental → rentals still quote;
 * Create blocked with clear course gate message.
 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra !== undefined ? `  (${extra})` : ''}`); }
}

const portalSrc = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-schedule-portal-module.js'), 'utf8');
const i18n = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const es = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');

ok('helper schedulePortalPayloadForQuote present', /function schedulePortalPayloadForQuote/.test(portalSrc));
ok('helper schedulePortalCourseSelectionIncomplete present', /function schedulePortalCourseSelectionIncomplete/.test(portalSrc));
ok('soft path allows courseSelectionRequired', /courseSelectionRequired/.test(portalSrc));
ok('courseOrTurnOff message key wired', /schedule\.create\.courseOrTurnOff/.test(portalSrc));
ok('i18n EN courseOrTurnOff', /schedule\.create\.courseOrTurnOff/.test(i18n));
ok('i18n ES courseOrTurnOff', /schedule\.create\.courseOrTurnOff/.test(es));
ok('quote path strips incomplete course', /schedulePortalPayloadForQuote\(payload\)/.test(portalSrc));
ok('create submit still requires selected course', /schedulePortalGetSelectedCreateCourseId/.test(portalSrc)
  && /ps-create-comp-course/.test(portalSrc));

// Offline behavioral: validate + payload strip
const sandbox = {
  console,
  portalT: (k) => {
    if (k === 'schedule.create.courseOrTurnOff') return 'Select a course or turn off Group Course';
    if (k === 'schedule.create.courseRequired') return 'Select a course or turn off Group Course';
    return k;
  },
  escHtml: (s) => String(s == null ? '' : s),
  el: () => null,
  scheduleReadCreateSurferCount: () => 1,
  schedulePortalIsValidCreatePhone: () => true,
  schedulePortalHasSellableIntent: null, // filled after eval
  schedulePortalCanonicalDateIso: (d) => String(d || '').slice(0, 10),
  schedulePortalMadridTodayIso: () => '2026-08-10',
  schedulePortalInclusiveDateCount: () => 1,
  schedulePortalValidatePrivateLessonCreate: () => ({ ok: true }),
  module: { exports: {} },
  exports: {},
};
vm.createContext(sandbox);
// Load only the functions we need by evaluating the file (browser style)
vm.runInContext(portalSrc + '\nthis._v = {\n'
  + '  validate: schedulePortalValidateCreatePayload,\n'
  + '  forQuote: schedulePortalPayloadForQuote,\n'
  + '  incomplete: schedulePortalCourseSelectionIncomplete,\n'
  + '  render: schedulePortalRenderCreateQuotePreview,\n'
  + '};\n', sandbox);

const v = sandbox._v;
const payload = {
  guest_name: 'Test Guest',
  guest_phone: '+34123456789',
  date_from: '2026-08-15',
  date_to: '2026-08-15',
  components: {
    course: { course_id: '', selected_courses: [], quantity: 1 },
  },
  rentals: [{ offering_key: 'board_rental', duration_key: '2h', quantity: 1 }],
  surfer_count: 1,
};

const hard = v.validate(payload, { soft: false });
ok('hard create blocked when course incomplete', hard.ok === false);
ok('hard error is courseOrTurnOff', hard.errorKey === 'schedule.create.courseOrTurnOff');

const soft = v.validate(payload, { soft: true });
ok('soft validate ok with rentals + incomplete course', soft.ok === true);
ok('soft flags courseSelectionRequired', soft.courseSelectionRequired === true);

const stripped = v.forQuote(payload);
ok('quote payload removes incomplete course', !stripped.components || !stripped.components.course);
ok('quote payload keeps rentals', Array.isArray(stripped.rentals) && stripped.rentals.length === 1);
ok('quote payload clears course_equipment', Array.isArray(stripped.course_equipment) && stripped.course_equipment.length === 0);

const softOnlyCourse = v.validate({
  guest_name: 'x',
  guest_phone: '+34123456789',
  date_from: '2026-08-15',
  date_to: '2026-08-15',
  components: { course: { course_id: '', selected_courses: [] } },
  rentals: [],
}, { soft: true });
ok('soft course-only shows courseOrTurnOff (not silent idle)', softOnlyCourse.ok === false
  && softOnlyCourse.errorKey === 'schedule.create.courseOrTurnOff');

// Render gate message
const box = { innerHTML: '', style: { display: 'none' }, setAttribute() {} };
sandbox.el = (id) => (id === 'ps-create-quote-preview' ? box : null);
sandbox.schedulePortalQuoteState = null;
sandbox.schedulePortalQuotePriceBlocked = false;
sandbox.schedulePortalSyncCreateSubmitEnabled = () => {};
// re-bind render with el
vm.runInContext('this._render = schedulePortalRenderCreateQuotePreview;', sandbox);
sandbox._render({ ok: false, softInvalid: true, errorKey: 'schedule.create.courseOrTurnOff' });
ok('soft gate paints course message', /Select a course or turn off Group Course/.test(box.innerHTML));
ok('soft gate visible', box.style.display === 'block');
ok('soft gate marks course-required status', /course-required/.test(box.innerHTML));

// Successful rental quote + course gate note
box.innerHTML = '';
sandbox._render({
  ok: true,
  courseSelectionRequired: true,
  body: { total_cents: 3500 },
  intent_key: 'x',
});
ok('ok quote still shows total with course gate', /35\.00|3500|Quoted total|quoteTotal/i.test(box.innerHTML));
ok('ok quote shows course gate note', /Select a course or turn off Group Course/.test(box.innerHTML));

console.log(`\n── verify:sunset-batch-d4-course-rental-quote: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
