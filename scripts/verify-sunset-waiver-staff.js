'use strict';

/**
 * verify:sunset-waiver-staff
 * Offline checks for staff waiver endpoints + schedule drawer UI.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const STAFF = path.join(ROOT, 'scripts', 'lib', 'sunset-waiver-staff.js');
const CONFIG = path.join(ROOT, 'config', 'clients', 'sunset.waiver-form.json');
const I18N = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');
const I18N_ES = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es-sunset.js');

let pass = 0;
let fail = 0;
function assert(label, condition, detail) {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

console.log('\nverify:sunset-waiver-staff — staff waiver drawer/API offline checks\n');

const apiSrc = fs.readFileSync(API, 'utf8');
const staffSrc = fs.readFileSync(STAFF, 'utf8');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const i18n = fs.readFileSync(I18N, 'utf8');
const i18nEs = fs.readFileSync(I18N_ES, 'utf8');

console.log('[1] config gate');
assert('confirmed_google_form_copy', cfg._meta.status === 'confirmed_google_form_copy');

console.log('\n[2] staff module');
assert('createOrGetBookingWaiver uses createWaiverRequest', staffSrc.includes('createWaiverRequest'));
assert('buildWaiverPublicUrl used', staffSrc.includes('buildWaiverPublicUrl'));
assert('staffSafeWaiver omits token_hash field assignment to response',
  staffSrc.includes('function staffSafeWaiver')
  && !/staffSafeWaiver[\s\S]*token_hash\s*:/.test(staffSrc.slice(staffSrc.indexOf('function staffSafeWaiver'), staffSrc.indexOf('function staffSafeWaiver') + 800)));
assert('prefill builder exported', staffSrc.includes('buildWaiverPrefillFromBooking'));
assert('participant_key primary', staffSrc.includes("participantKey: 'primary'") || staffSrc.includes("participant_key: 'primary'"));
assert('no WhatsApp send', !/whatsapp.*send|sendWhatsApp|guest-reply-send/i.test(staffSrc));
assert('staging default via resolveWaiverPublicBaseUrl', staffSrc.includes('resolveWaiverPublicBaseUrl'));
assert('no production hostname default', !staffSrc.includes("https://sunset.lunafrontdesk.com"));

console.log('\n[3] staff-query-api wiring (auth-protected)');
assert('requires sunset-waiver-staff', apiSrc.includes("require('./lib/sunset-waiver-staff')"));
assert('STAFF_BOOKING_WAIVER_RE used', apiSrc.includes('STAFF_BOOKING_WAIVER_RE'));
assert('waiver GET handler wired', apiSrc.includes('handleStaffBookingWaiverGet'));
assert('waiver POST handler wired', apiSrc.includes('handleStaffBookingWaiverCreate'));
assert('waiver submission GET wired', apiSrc.includes('handleStaffBookingWaiverSubmissionGet'));
const waiverRouteIdx = apiSrc.indexOf('STAFF_BOOKING_WAIVER_RE.exec');
const requireAuthNear = apiSrc.slice(waiverRouteIdx, waiverRouteIdx + 500);
assert('waiver routes call requireAuth', requireAuthNear.includes('requireAuth'));
assert('waiver routes after public waiver hook',
  apiSrc.indexOf('tryHandleSunsetWaiverPublicRoute') < waiverRouteIdx);

console.log('\n[4] drawer UI');
assert('Formulario de inscripción title key or text',
  apiSrc.includes('schedule.drawer.waiverTitle') || apiSrc.includes('Formulario de inscripción'));
assert('Crear enlace', apiSrc.includes('schedule.drawer.waiverCreate') || apiSrc.includes('Crear enlace'));
assert('Copiar enlace waiver', apiSrc.includes('ps-drawer-waiver-copy') || apiSrc.includes('schedule.drawer.waiverCopy'));
assert('pending/completed states',
  apiSrc.includes('schedule.drawer.waiverPending') && apiSrc.includes('schedule.drawer.waiverCompleted'));
assert('Ver respuestas', apiSrc.includes('schedule.drawer.waiverViewAnswers') || apiSrc.includes('Ver respuestas'));
assert('no WhatsApp send in drawer waiver block',
  !/ps-drawer-waiver[\s\S]{0,400}whatsapp/i.test(apiSrc));
assert('i18n EN waiver keys', i18n.includes('schedule.drawer.waiverTitle'));
assert('i18n ES waiver keys', i18nEs.includes('schedule.drawer.waiverTitle') && i18nEs.includes('Formulario de inscripción'));

console.log('\n[5] pure helper unit checks');
const staff = require('./lib/sunset-waiver-staff');
const prefill = staff.buildWaiverPrefillFromBooking(
  { guest_name: 'Ana', phone: '+34600', email: 'a@b.co', booking_code: 'SUNSET-1', metadata: { location_id: 'sunset-somo' } },
  [{ service_date: '2026-07-23', quantity: 2 }, { service_date: '2026-07-24', quantity: 2 }],
  'sunset-somo',
);
assert('prefill includes phone', prefill.phone === '+34600');
assert('prefill includes email', prefill.email === 'a@b.co');
assert('prefill includes name', prefill.full_name === 'Ana' || prefill.guest_name === 'Ana');
assert('prefill lesson days', prefill.lesson_days === '2026-07-23, 2026-07-24');
assert('guest count 2', staff.resolveGuestCount({ guest_count: 2 }, []) === 2);
assert('multi student note', /2 alumnos/.test(staff.multiStudentNote(2) || ''));
assert('no note for 1', staff.multiStudentNote(1) == null);

const safe = staff.staffSafeWaiver({
  id: 'x',
  public_id: 'waiv_test123abc',
  token_hash: 'SHOULD_NOT_LEAK',
  status: 'pending',
  form_type: 'sunset_lesson_waiver',
  form_version: 'sunset_google_form_v1_confirmed',
  created_at: '2026-07-10',
}, null, 'https://sunset-staging.lunafrontdesk.com');
assert('safe url staging', safe.public_url === 'https://sunset-staging.lunafrontdesk.com/forms/waiver/waiv_test123abc');
assert('safe has public_id', safe.public_id === 'waiv_test123abc');
assert('safe omits token_hash', !Object.prototype.hasOwnProperty.call(safe, 'token_hash'));
assert('url contains waiv_', /\/forms\/waiver\/waiv_/.test(safe.public_url));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('OK  verify:sunset-waiver-staff');
