'use strict';

/**
 * verify:sunset-waiver-luna
 *
 * Offline checks for Sunset Luna waiver invite wiring.
 * Does not apply migrations, deploy, or send WhatsApp.
 *
 * Run:
 *   node scripts/verify-sunset-waiver-luna.js
 *   npm run verify:sunset-waiver-luna
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BOOKING = path.join(ROOT, 'scripts', 'lib', 'sunset-waiver-booking.js');
const STAFF = path.join(ROOT, 'scripts', 'lib', 'sunset-waiver-staff.js');
const TURN = path.join(ROOT, 'scripts', 'lib', 'luna-guest-sunset-school-turn.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const CONFIG = path.join(ROOT, 'config', 'clients', 'sunset.waiver-form.json');
const PKG = path.join(ROOT, 'package.json');

const WH_HOLD = path.join(ROOT, 'scripts', 'lib', 'luna-guest-hold-payment-draft-write.js');
const WH_PLANNER = path.join(ROOT, 'scripts', 'lib', 'luna-guest-frontdesk-planner.js');

let pass = 0;
let fail = 0;
function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail += 1;
  }
}

console.log('\nverify:sunset-waiver-luna — Luna/Sunset waiver booking wiring\n');

const bookingSrc = fs.readFileSync(BOOKING, 'utf8');
const staffSrc = fs.readFileSync(STAFF, 'utf8');
const turnSrc = fs.readFileSync(TURN, 'utf8');
const apiSrc = fs.readFileSync(API, 'utf8');
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));

console.log('[1] legal gate');
assert('confirmed_google_form_copy', cfg._meta.status === 'confirmed_google_form_copy');
assert('needs_legal_copy_confirmation false', cfg._meta.needs_legal_copy_confirmation === false);

console.log('\n[2] ensureWaiverForBooking helper');
assert('ensureWaiverForBooking exported', bookingSrc.includes('function ensureWaiverForBooking'));
assert('calls createOrGetBookingWaiver / createWaiverRequest path',
  bookingSrc.includes('createOrGetBookingWaiver')
  && staffSrc.includes('createWaiverRequest'));
assert('attachLunaWaiverFields', bookingSrc.includes('attachLunaWaiverFields'));
assert('staging default hostname referenced',
  bookingSrc.includes('DEFAULT_STAGING_BASE_URL')
  || bookingSrc.includes('sunset-staging.lunafrontdesk.com'));
assert('no production hostname as active default',
  !bookingSrc.includes("https://sunset.lunafrontdesk.com'")
  && !bookingSrc.includes('https://sunset.lunafrontdesk.com"'));
assert('no live WhatsApp send',
  !/sendWhatsApp|guest-reply-send|whatsapp\.cloud|GraphAPI.*messages/i.test(bookingSrc));

console.log('\n[3] Spanish Luna copy');
const {
  buildLunaWaiverInviteMessage,
  buildLunaWaiverCompletedMessage,
  buildLunaWaiverPendingReminderMessage,
  composeLunaWaiverReply,
  isLessonReadyForGuest,
  attachLunaWaiverFields,
} = require('./lib/sunset-waiver-booking');

const sampleUrl = 'https://sunset-staging.lunafrontdesk.com/forms/waiver/waiv_testluna01';
const invite = buildLunaWaiverInviteMessage({ public_url: sampleUrl, guest_count: 1 });
assert('invite contains /forms/waiver/', invite.includes('/forms/waiver/'));
assert('invite contains staging hostname', invite.includes('sunset-staging.lunafrontdesk.com'));
assert('invite Spanish lead-in', invite.includes('formulario rápido de seguro y responsabilidad'));
assert('invite has link line', invite.includes(sampleUrl));

const multi = buildLunaWaiverInviteMessage({ public_url: sampleUrl, guest_count: 3 });
assert('quantity > 1 adds v1 note', multi.includes('3 alumnos') && multi.includes('formularios por alumno'));

const completed = buildLunaWaiverCompletedMessage();
assert('completed copy', completed.includes('formulario de Sunset está completo'));
assert('completed allows ready wording', /registrado para la clase/i.test(completed));

const reminder = buildLunaWaiverPendingReminderMessage({ public_url: sampleUrl });
assert('pending reminder copy', reminder.includes('Te falta completar') && reminder.includes(sampleUrl));

assert('pending is not lesson-ready', isLessonReadyForGuest('pending') === false);
assert('completed is lesson-ready', isLessonReadyForGuest('completed') === true);

const pendingBody = attachLunaWaiverFields({
  success: true,
  guest_count: 2,
  waiver: { status: 'pending', public_url: sampleUrl },
});
assert('pending reply includes public_url', pendingBody.luna_waiver_message.includes(sampleUrl));
assert('pending lesson_ready false', pendingBody.lesson_ready === false);
assert('pending blocked reason', pendingBody.lesson_ready_blocked_reason === 'waiver_not_completed');
assert('ready wording not in pending invite',
  !/Ya queda registrado para la clase/i.test(pendingBody.luna_waiver_message));

const doneBody = attachLunaWaiverFields({
  success: true,
  guest_count: 1,
  waiver: { status: 'completed', public_url: sampleUrl },
});
assert('completed permits ready wording', /Ya queda registrado para la clase/i.test(doneBody.luna_waiver_message));
assert('completed lesson_ready true', doneBody.lesson_ready === true);

console.log('\n[4] prefill phone/email/name');
assert('staff prefill includes phone', staffSrc.includes('phone:') || staffSrc.includes('phone ='));
assert('staff prefill includes email', /prefill[\s\S]{0,400}email/i.test(staffSrc));
assert('staff prefill includes name', staffSrc.includes('full_name') || staffSrc.includes('guest_name'));
assert('create passes prefillJson', staffSrc.includes('prefillJson: prefill'));
assert('ensure uses createOrGetBookingWaiver (same prefill)', bookingSrc.includes('createOrGetBookingWaiver'));

console.log('\n[5] Luna turn + booking create wiring');
assert('school turn requires sunset-waiver-booking', turnSrc.includes("require('./sunset-waiver-booking')"));
assert('school turn calls ensureWaiverForBookingSoft or ensureWaiverForBooking',
  turnSrc.includes('ensureWaiverForBookingSoft') || turnSrc.includes('ensureWaiverForBooking'));
assert('school turn composes waiver reply', turnSrc.includes('composeLunaWaiverReply'));
assert('school turn gates lesson_ready', turnSrc.includes('lesson_ready'));
assert('no WhatsApp send in school turn',
  !/sendWhatsApp|guest-reply-send/i.test(turnSrc));

assert('API requires sunset-waiver-booking', apiSrc.includes("require('./lib/sunset-waiver-booking')"));
assert('booking create calls ensureWaiverForBookingSoft',
  apiSrc.includes('ensureWaiverForBookingSoft')
  && apiSrc.includes('handleSunsetScheduleBookingCreate'));
const createIdx = apiSrc.indexOf('async function handleSunsetScheduleBookingCreate');
const createChunk = apiSrc.slice(createIdx, createIdx + 3500);
assert('ensure called inside booking create handler',
  createChunk.includes('ensureWaiverForBookingSoft'));
assert('proposed_luna_reply / luna_waiver_message on create',
  createChunk.includes('luna_waiver_message') || createChunk.includes('proposed_luna_reply'));
assert('no WhatsApp send in booking create waiver block',
  !/sendWhatsApp|guest-reply-send/i.test(createChunk));

console.log('\n[6] Wolfhouse isolation');
assert('Wolfhouse hold-write not modified for waiver',
  fs.existsSync(WH_HOLD) && !fs.readFileSync(WH_HOLD, 'utf8').includes('ensureWaiverForBooking'));
assert('Wolfhouse planner not modified for waiver',
  fs.existsSync(WH_PLANNER) && !fs.readFileSync(WH_PLANNER, 'utf8').includes('ensureWaiverForBooking'));
assert('no global multi-tenant waiver in booking helper',
  !bookingSrc.includes('wolfhouse') && bookingSrc.includes("clientSlug: 'sunset'"));

console.log('\n[7] npm script');
assert('verify:sunset-waiver-luna script',
  pkg.scripts && pkg.scripts['verify:sunset-waiver-luna'] === 'node scripts/verify-sunset-waiver-luna.js');

console.log('\n[8] reminder system note');
const hasReminderSystem = /scheduleReminder|waiver_reminder_cron|sendWaiverReminder/i.test(apiSrc + turnSrc + bookingSrc);
if (hasReminderSystem) {
  console.log('  NOTE  automatic reminder system detected — leave TODO; do not auto-send');
  assert('no new live reminder send introduced',
    !/sendWhatsApp[\s\S]{0,200}waiver/i.test(bookingSrc + turnSrc));
} else {
  assert('no automatic waiver reminder system (expected)', !hasReminderSystem);
  console.log('  NOTE  TODO: automatic waiver reminders not implemented (safe)');
}

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  verify:sunset-waiver-luna  (${pass} passed, ${fail} failed)\n`);
process.exit(fail === 0 ? 0 : 1);
