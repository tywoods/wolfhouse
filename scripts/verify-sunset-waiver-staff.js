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
assert('resolveWaiverRequestParams exported', staffSrc.includes('resolveWaiverRequestParams'));
assert('guest_count > 1 => group mode in staff', staffSrc.includes("requestMode: 'group'") || staffSrc.includes('requestMode: "group"'));
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
const waiverModPath = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-actions.js');
const viewModPath = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-view-ui.js');
const waiverModSrc = fs.existsSync(waiverModPath) ? fs.readFileSync(waiverModPath, 'utf8') : '';
const viewModSrc = fs.existsSync(viewModPath) ? fs.readFileSync(viewModPath, 'utf8') : '';
// Slice 12+ — waiver section title lives in view module; waiver actions in waiver module.
const drawerUiSrc = viewModSrc + '\n' + waiverModSrc + '\n' + apiSrc;
assert('Formulario de inscripción title key or text',
  drawerUiSrc.includes('schedule.drawer.waiverTitle') || drawerUiSrc.includes('Formulario de inscripción'));
assert('Crear enlace', drawerUiSrc.includes('schedule.drawer.waiverCreate') || drawerUiSrc.includes('Crear enlace'));
assert('Copiar enlace waiver', drawerUiSrc.includes('ps-drawer-waiver-copy') || drawerUiSrc.includes('schedule.drawer.waiverCopy'));
assert('group create copy keys', drawerUiSrc.includes('schedule.drawer.waiverCreateGroup') && drawerUiSrc.includes('schedule.drawer.waiverCopyGroup'));
assert('group progress labels', drawerUiSrc.includes('schedule.drawer.waiverGroupLabel') && drawerUiSrc.includes('schedule.drawer.waiverCompletedProgress'));
assert('group helper scheduleWaiverIsGroup', waiverModSrc.includes('function scheduleWaiverIsGroup'));
assert('obsolete v1 note removed', !staffSrc.includes('formularios por alumno') && !apiSrc.includes('formularios por alumno'));
assert('group share note present', staffSrc.includes('Comparte este enlace con el grupo'));
assert('pending/completed states',
  drawerUiSrc.includes('schedule.drawer.waiverPending') && drawerUiSrc.includes('schedule.drawer.waiverCompleted'));
assert('Ver respuestas', drawerUiSrc.includes('schedule.drawer.waiverViewAnswers') || drawerUiSrc.includes('Ver respuestas'));
assert('no WhatsApp send in drawer waiver block',
  !/ps-drawer-waiver[\s\S]{0,400}whatsapp/i.test(waiverModSrc));
assert('i18n EN waiver keys', i18n.includes('schedule.drawer.waiverTitle'));
assert('i18n ES waiver keys', i18nEs.includes('schedule.drawer.waiverTitle') && i18nEs.includes('Formulario de inscripción'));
assert('i18n ES group create', i18nEs.includes('Crear enlace de grupo'));
assert('i18n ES group copy', i18nEs.includes('Copiar enlace de grupo'));

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
const groupParams = staff.resolveWaiverRequestParams(20);
assert('guest_count 20 => group mode', groupParams.requestMode === 'group' && groupParams.targetCount === 20);
const singleParams = staff.resolveWaiverRequestParams(1);
assert('guest_count 1 => single mode', singleParams.requestMode === 'single' && singleParams.targetCount == null);
assert('multi student note', /Comparte este enlace con el grupo/.test(staff.multiStudentNote(2) || ''));
assert('group share note helper', staff.multiStudentNote(20).includes('Cada alumno debe completar el formulario una vez'));
assert('no note for 1', staff.multiStudentNote(1) == null);
const groupIntent = staff.enrichWaiverStatusBody({
  success: true,
  booking_id: '00000000-0000-4000-8000-000000000001',
  guest_count: 20,
  waiver: null,
}, 20);
assert('no-waiver group intent expected_request_mode', groupIntent.expected_request_mode === 'group');
assert('no-waiver group intent target_count', groupIntent.target_count === 20);
assert('no-waiver group intent completed_count', groupIntent.completed_count === 0);
assert('no-waiver group intent remaining_count', groupIntent.remaining_count === 20);
assert('getAllSubmissionsForRequest exported', typeof staff.getAllSubmissionsForRequest === 'function');

const safe = staff.staffSafeWaiver({
  id: 'x',
  public_id: 'waiv_test123abc',
  token_hash: 'SHOULD_NOT_LEAK',
  status: 'pending',
  request_mode: 'group',
  target_count: 20,
  form_type: 'sunset_lesson_waiver',
  form_version: 'sunset_google_form_v1_confirmed',
  created_at: '2026-07-10',
}, null, 'https://sunset-staging.lunafrontdesk.com', {
  request_mode: 'group',
  target_count: 20,
  completed_count: 7,
  remaining_count: 13,
  status: 'pending',
});
assert('safe url staging', safe.public_url === 'https://sunset-staging.lunafrontdesk.com/forms/waiver/waiv_test123abc');
assert('safe has public_id', safe.public_id === 'waiv_test123abc');
assert('safe omits token_hash', !Object.prototype.hasOwnProperty.call(safe, 'token_hash'));
assert('safe group request_mode', safe.request_mode === 'group');
assert('safe target_count', safe.target_count === 20);
assert('safe completed_count', safe.completed_count === 7);
assert('safe remaining_count', safe.remaining_count === 13);
assert('url contains waiv_', /\/forms\/waiver\/waiv_/.test(safe.public_url));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('OK  verify:sunset-waiver-staff');
