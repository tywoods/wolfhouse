/**
 * Stage 37b — Cami welcome + confirmation copy verifier.
 *
 * Usage:
 *   npm run verify:stage37b-welcome-confirmation-copy
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PERSONALITY_CONFIG = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.personalities.json');
const BASELINE_CONFIG = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.baseline.json');
const LESSON_MOD = path.join(__dirname, 'lib', 'luna-guest-lesson-schedule-config.js');
const CONF_PERSONALITY = path.join(__dirname, 'lib', 'luna-guest-confirmation-personality-copy.js');
const PLAYBOOK = path.join(__dirname, 'lib', 'luna-client-messaging-playbook.js');
const PREVIEW = path.join(__dirname, 'lib', 'luna-booking-confirmation-preview.js');
const PREVIEW_DRY = path.join(__dirname, 'lib', 'luna-guest-confirmation-preview-dry-run.js');
const SEND_MOD = path.join(__dirname, 'lib', 'luna-guest-confirmation-send-go-no-go.js');
const TRUTH_MOD = path.join(__dirname, 'lib', 'luna-guest-stripe-payment-truth-apply.js');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const PERSONALITY_LOADER = path.join(__dirname, 'lib', 'luna-guest-personality-config.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage37b-welcome-confirmation-copy';
const MAPS_LINK = 'https://maps.app.goo.gl/oPRckhqozVBvXxL16';

const {
  buildWelcomeReply,
  resolveActivePersonality,
} = require('./lib/luna-guest-personality-config');
const {
  composeLunaGuestReply,
} = require('./lib/luna-guest-reply-composer');
const {
  buildConfirmationPreviewFromPlaybook,
} = require('./lib/luna-client-messaging-playbook');
const {
  loadLessonScheduleConfig,
  bookingDraftIncludesSurfLessons,
  buildLessonScheduleGuestSection,
} = require('./lib/luna-guest-lesson-schedule-config');
const {
  runGuestConfirmationPreviewDryRun,
} = require('./lib/luna-guest-confirmation-preview-dry-run');
const {
  messageHasBedLeak,
  passesConfirmationStyleContract,
} = require('./lib/luna-guest-confirmation-copy-style');
const { isForbiddenGuestCopy } = require('./lib/luna-guest-reply-style-contract');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage37b-welcome-confirmation-copy.js  (Stage 37b)\n`);

section('A. Files + package');

check('A1', fs.existsSync(LESSON_MOD), 'lesson schedule config module exists');
check('A2', fs.existsSync(CONF_PERSONALITY), 'confirmation personality copy module exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A3', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const playbookSrc = fs.readFileSync(PLAYBOOK, 'utf8');
const previewSrc = fs.readFileSync(PREVIEW, 'utf8');
const previewDrySrc = fs.readFileSync(PREVIEW_DRY, 'utf8');
const sendSrc = fs.readFileSync(SEND_MOD, 'utf8');
const truthSrc = fs.readFileSync(TRUTH_MOD, 'utf8');
const composerSrc = fs.readFileSync(COMPOSER, 'utf8');

section('B. Personality config rules');

const personalityFile = JSON.parse(fs.readFileSync(PERSONALITY_CONFIG, 'utf8'));
const cami = personalityFile.personalities && personalityFile.personalities.cami;
check('B1', personalityFile.assistant_name === 'Luna', 'Luna name unchanged');
check('B2', cami && cami.welcome_style_rules && cami.welcome_style_rules.length >= 4, 'welcome rules expanded');
check('B3', cami && cami.confirmation_style_rules.some((r) => /maps|Google/i.test(r)), 'maps link guidance in rules');
check('B4', cami && cami.lesson_schedule_copy_guidance, 'lesson schedule copy guidance');
check('B5', cami && cami.wolfhouse_family_phrases, 'Wolfhouse family phrase guidance');
check('B6', cami && cami.confirmation_max_chars_guidance, 'max confirmation length guidance');

section('C. Lesson schedule config');

const lessonCfg = loadLessonScheduleConfig('wolfhouse-somo');
check('C1', lessonCfg.daily_slots && lessonCfg.daily_slots.length >= 2, 'two daily lesson slots configured');
check('C2', lessonCfg.maps_link === MAPS_LINK, 'maps link in lesson/confirmation config');
check('C3', /low season/i.test(lessonCfg.low_season_caveat), 'low-season caveat exists');
check('C4', bookingDraftIncludesSurfLessons({ package_code: 'malibu' }), 'malibu package includes lessons');
check('C5', !bookingDraftIncludesSurfLessons({ package_code: 'accommodation_only' }), 'accommodation-only excludes lessons');

const lessonSection = buildLessonScheduleGuestSection('wolfhouse-somo', 'en', { includes_surf_lessons: true });
check('C6', lessonSection && /08:30/.test(lessonSection), 'lesson section mentions first group time');
check('C7', lessonSection && /confirm your exact group/i.test(lessonSection), 'no exact group promised');
check('C8', lessonSection && /low season/i.test(lessonSection), 'lesson section mentions low season');

section('D. Welcome copy');

const welcomeGeneric = buildWelcomeReply('wolfhouse-somo', 'en', {});
check('D1', welcomeGeneric && /Luna/.test(welcomeGeneric), 'welcome keeps Luna name');
check('D2', welcomeGeneric && /Wolfhouse/.test(welcomeGeneric), 'welcome mentions Wolfhouse');
check('D3', welcomeGeneric && /So happy|Heyyy/i.test(welcomeGeneric), 'welcome sounds warm');
check('D4', !isForbiddenGuestCopy(welcomeGeneric), 'welcome no forbidden terms');

const welcomeBooking = buildWelcomeReply('wolfhouse-somo', 'en', { bookingIntent: true });
check('D5', welcomeBooking && /dates/i.test(welcomeBooking), 'booking-intent welcome asks dates');

const greeting = composeLunaGuestReply({
  client_slug: 'wolfhouse-somo',
  message_text: 'hi',
  payload: {
    gate: { gate_status: 'allowed_dry_run' },
    result: { greeting_only: true, message_lane: 'general_question', detected_language: 'en' },
    quote: {},
    availability: {},
    payment_choice: {},
  },
  allow_leading_intro: true,
});
check('D6', greeting && greeting.covered && greeting.personality_id === 'cami', 'composer greeting uses Cami');

section('E. Confirmation copy (playbook path)');

const shortStayDraft = {
  booking_code: 'WH-G27-CAMI37B',
  guest_name: 'Alex',
  amount_paid_cents: 10000,
  balance_due_cents: 8000,
  room_number: 'R1',
  gate_code: '2684#',
};
const shortPreview = buildConfirmationPreviewFromPlaybook('wolfhouse-somo', 'en', shortStayDraft);
check('E1', shortPreview.ok && shortPreview.message, 'short-stay confirmation builds');
check('E2', shortPreview.message && /Wolfhouse family/i.test(shortPreview.message), 'Wolfhouse family tone');
check('E3', shortPreview.message && shortPreview.message.includes(MAPS_LINK), 'Google Maps link included');
check('E4', shortPreview.message && shortPreview.message.includes('WH-G27-CAMI37B'), 'booking code included');
check('E5', shortPreview.message && shortPreview.message.includes('€100'), 'paid amount included');
check('E6', shortPreview.message && shortPreview.message.includes('€80'), 'balance due included');
check('E7', shortPreview.message && shortPreview.message.includes('2684#'), 'gate code included');
check('E8', shortPreview.message && /Room:\s*R1/i.test(shortPreview.message), 'room label included');
check('E9', !messageHasBedLeak(shortPreview.message), 'no bed number leak');
check('E10', !/Surf lesson rhythm/i.test(shortPreview.message), 'no lesson section without lessons');

const lessonDraft = {
  ...shortStayDraft,
  booking_code: 'WH-G27-CAMI37L',
  package_code: 'malibu',
  includes_surf_lessons: true,
};
const lessonPreview = buildConfirmationPreviewFromPlaybook('wolfhouse-somo', 'en', lessonDraft);
check('E11', lessonPreview.message && /Surf lesson rhythm/i.test(lessonPreview.message), 'lesson section when package has lessons');
check('E12', lessonPreview.message && !/your group is/i.test(lessonPreview.message), 'no invented group assignment');

section('F. Dry-run preview integration');

(async () => {
  const dryOut = await runGuestConfirmationPreviewDryRun({
    client_slug: 'wolfhouse-somo',
    booking_code: shortStayDraft.booking_code,
    confirmation_draft: shortStayDraft,
    payment_status: 'deposit_paid',
  }, { use_fixture_pg: true });

  const msg = dryOut.proposed_confirmation_message || '';
  check('F1', dryOut.confirmation_preview_ready === true, 'dry-run preview ready');
  check('F2', msg.includes(MAPS_LINK), 'dry-run maps link');
  const style = passesConfirmationStyleContract(msg, {
    booking_code: shortStayDraft.booking_code,
    amount_paid_cents: 10000,
    balance_due_cents: 8000,
  });
  check('F3', style.ok, `style contract ok (${style.reasons.join(', ') || 'ok'})`);

  section('G. Single preview path + safety');

  check('G1', playbookSrc.includes('buildCamiConfirmationPreview'), 'playbook delegates to personality confirmation');
  check('G2', !previewDrySrc.match(/function\s+buildConfirmationPreview\b/), 'no second confirmation generator in dry-run');
  check('G3', previewSrc.includes('getLunaBookingConfirmationPreview'), 'still uses existing preview helper');
  check('G4', sendSrc.includes('getLunaBookingConfirmationPreview'), 'send still reuses preview');
  check('G5', !truthSrc.includes('buildCamiConfirmationPreview'), 'payment truth unchanged');
  check('G6', !composerSrc.includes('sendWhatsApp') && !composerSrc.includes('graph.facebook.com'), 'no WhatsApp send');
  check('G7', !composerSrc.includes('stripe.checkout.sessions.create'), 'no Stripe create in composer');
  check('G8', !playbookSrc.match(/\bn8n\.(activate|trigger)/i), 'no n8n activation');
  check('G9', !isForbiddenGuestCopy(msg), 'confirmation no forbidden internal phrases');

  const baseline = JSON.parse(fs.readFileSync(BASELINE_CONFIG, 'utf8'));
  check('G10', baseline.confirmation && baseline.confirmation.maps_link === MAPS_LINK, 'baseline maps_link configured');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
