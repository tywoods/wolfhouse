'use strict';

/**
 * verify:native-waiver-rollback
 *
 * Focused regression: production runtime is native hosted Sunset waiver only.
 * External Google Form Admin/runtime surface must be gone. Migration 054 stays
 * in immutable history (table may remain unused).
 *
 * Run:
 *   node scripts/verify-native-waiver-rollback.js
 *   npm run verify:native-waiver-rollback
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const STAFF = path.join(ROOT, 'scripts', 'lib', 'sunset-waiver-staff.js');
const BOOKING = path.join(ROOT, 'scripts', 'lib', 'sunset-waiver-booking.js');
const TURN = path.join(ROOT, 'scripts', 'lib', 'luna-guest-sunset-school-turn.js');
const DRAWER = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-actions.js');
const I18N = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');
const I18N_ES = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es-sunset.js');
const PKG = path.join(ROOT, 'package.json');
const EXT_LIB = path.join(ROOT, 'scripts', 'lib', 'tenant-external-waiver-settings.js');
const EXT_VERIFY = path.join(ROOT, 'scripts', 'verify-tenant-external-waiver-settings.js');
const MIGRATION_054 = path.join(ROOT, 'database', 'migrations', '054_tenant_external_waiver_settings.sql');
const MANIFEST = path.join(ROOT, 'database', 'migrations', 'canonical-manifest.json');

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

function read(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

console.log('\nverify:native-waiver-rollback — native hosted waiver only\n');

const apiSrc = read(API);
const staffSrc = read(STAFF);
const bookingSrc = read(BOOKING);
const turnSrc = read(TURN);
const drawerSrc = read(DRAWER);
const i18nSrc = read(I18N);
const i18nEsSrc = read(I18N_ES);
const pkg = JSON.parse(read(PKG) || '{}');

// ── [1] Production source: no external Admin/runtime surface ──────────────
console.log('[1] production source gates (no external Google Form surface)');

assert('no tenant-external-waiver-settings lib file', !fs.existsSync(EXT_LIB));
assert('no verify-tenant-external-waiver-settings file', !fs.existsSync(EXT_VERIFY));
assert('no npm verify:tenant-external-waiver-settings script',
  !pkg.scripts || !pkg.scripts['verify:tenant-external-waiver-settings']);
assert('npm verify:native-waiver-rollback registered',
  pkg.scripts && pkg.scripts['verify:native-waiver-rollback']
  === 'node scripts/verify-native-waiver-rollback.js');

assert('API does not require tenant-external-waiver-settings',
  !apiSrc.includes("require('./lib/tenant-external-waiver-settings')")
  && !apiSrc.includes('tenant-external-waiver-settings'));
assert('staff module does not require tenant-external-waiver-settings',
  !staffSrc.includes('tenant-external-waiver-settings'));
assert('booking module does not require tenant-external-waiver-settings',
  !bookingSrc.includes('tenant-external-waiver-settings'));

assert('no GET /staff/admin/external-waiver route',
  !/pathname\s*===\s*['"]\/staff\/admin\/external-waiver['"]\s*&&\s*method\s*===\s*['"]GET['"]/.test(apiSrc));
assert('no PUT /staff/admin/external-waiver route',
  !/pathname\s*===\s*['"]\/staff\/admin\/external-waiver['"]\s*&&\s*method\s*===\s*['"]PUT['"]/.test(apiSrc));
assert('no handleExternalWaiverSettings handlers',
  !apiSrc.includes('handleExternalWaiverSettingsGet')
  && !apiSrc.includes('handleExternalWaiverSettingsPut'));
assert('no external_waiver audit intents',
  !/api:staff\.external_waiver\.(get|put)/.test(apiSrc));

assert('no Admin external waiver card',
  !apiSrc.includes('cc-external-waiver-settings')
  && !apiSrc.includes('id="cc-external-waiver"')
  && !apiSrc.includes('Guest Waiver Form'));
assert('no Google Form URL Admin UI',
  !apiSrc.includes('id="ew-url"')
  && !apiSrc.includes('id="ew-enabled"')
  && !/Google Form URL/i.test(apiSrc)
  && !apiSrc.includes('externalWaiverSettingsSave')
  && !apiSrc.includes('externalWaiverSettingsLoad')
  && !apiSrc.includes('externalWaiverSettingsOpen'));

assert('staff has no resolveOfferSafe / applyExternalOffer',
  !staffSrc.includes('resolveOfferSafe')
  && !staffSrc.includes('applyExternalOfferToStatusBody')
  && !staffSrc.includes('resolveWaiverOfferForTenant')
  && !staffSrc.includes('buildExternalWaiverStaffView'));
assert('staff create/get has no external branch semantics',
  !staffSrc.includes("waiver_offer: 'external'")
  && !staffSrc.includes("waiver_mode: 'external'")
  && !staffSrc.includes("waiver_offer: 'none'")
  && !staffSrc.includes('historical_native_waiver'));

assert('booking has no external payload helpers',
  !bookingSrc.includes('isExternalWaiverPayload')
  && !bookingSrc.includes('buildLunaExternalWaiverInviteMessage')
  && !bookingSrc.includes('external_unverified')
  && !bookingSrc.includes('external_waiver_unverified'));

assert('drawer has no external mode UI',
  !drawerSrc.includes('waiverIsExternal')
  && !drawerSrc.includes('external_unverified')
  && !drawerSrc.includes('waiverExternal')
  && !drawerSrc.includes('historical_native_waiver')
  && !drawerSrc.includes('waiver_offer === \'none\''));

assert('Luna turn has no external-unavailable branch',
  !turnSrc.includes("waiver_offer === 'none'")
  && !turnSrc.includes('waiver_unavailable')
  && !turnSrc.includes('link_available === false'));

assert('i18n EN has no external-only keys',
  !i18nSrc.includes('schedule.drawer.waiverExternalUnverified')
  && !i18nSrc.includes('schedule.drawer.waiverExternalHint')
  && !i18nSrc.includes('schedule.drawer.waiverDisabledOrMisconfigured')
  && !i18nSrc.includes('schedule.drawer.waiverHistoricalNative'));
assert('i18n ES has no external-only keys',
  !i18nEsSrc.includes('schedule.drawer.waiverExternalUnverified')
  && !i18nEsSrc.includes('schedule.drawer.waiverExternalHint')
  && !i18nEsSrc.includes('schedule.drawer.waiverDisabledOrMisconfigured')
  && !i18nEsSrc.includes('schedule.drawer.waiverHistoricalNative'));

// Native labels preserved
assert('native waiver drawer keys preserved (EN)',
  i18nSrc.includes('schedule.drawer.waiverCreate')
  && i18nSrc.includes('schedule.drawer.waiverCreateGroup')
  && i18nSrc.includes('schedule.drawer.waiverCopy')
  && i18nSrc.includes('schedule.drawer.waiverPending')
  && i18nSrc.includes('schedule.drawer.waiverCompleted'));

// ── [2] Immutable migration 054 remains ───────────────────────────────────
console.log('\n[2] migration 054 remains immutable (unused table OK)');
assert('054 migration file present', fs.existsSync(MIGRATION_054));
const mig054 = read(MIGRATION_054);
assert('054 creates tenant_external_waiver_settings table',
  /CREATE TABLE IF NOT EXISTS tenant_external_waiver_settings/i.test(mig054));
const manifest = JSON.parse(read(MANIFEST) || '{"entries":[]}');
const entry054 = (manifest.entries || []).find((e) => e.id === '054_tenant_external_waiver_settings');
assert('054 in canonical manifest', !!entry054);
assert('054 checksum present', !!(entry054 && entry054.sha256));

// ── [3] Behavioral: native create / reuse / group / Luna ─────────────────
console.log('\n[3] native create/get/group/Luna behavioral callers');

const staff = require('./lib/sunset-waiver-staff');
const booking = require('./lib/sunset-waiver-booking');
const {
  composeLunaWaiverReply,
  attachLunaWaiverFields,
  isLessonReadyForGuest,
  ensureWaiverForBooking,
  buildLunaWaiverInviteMessage,
} = booking;

const bookingId = '00000000-0000-4000-8000-000000000101';
const groupBookingId = '00000000-0000-4000-8000-000000000202';
let insertCalls = 0;
const createdRequests = new Map();

function baseBookingRow(id, guestCount) {
  return {
    booking_id: id,
    booking_code: guestCount > 1 ? 'SUN-GRP-1' : 'SUN-NAT-1',
    guest_name: guestCount > 1 ? 'Group Lead' : 'Native Guest',
    phone: '+34600111222',
    email: 'guest@example.com',
    customer_id: null,
    guest_count: guestCount,
    check_in: null,
    check_out: null,
    metadata: { location_id: 'el_palmar' },
  };
}

function makeNativePg(opts) {
  const o = opts || {};
  const bid = o.bookingId || bookingId;
  const guestCount = o.guestCount || 1;
  const existing = o.existing || null;
  const submissions = o.submissions || [];
  return {
    async query(sql, params = []) {
      const q = String(sql);
      if (/FROM bookings b/i.test(q)) {
        return { rows: [baseBookingRow(bid, guestCount)] };
      }
      if (/FROM booking_service_records/i.test(q)) {
        return {
          rows: [{
            service_date: '2026-08-01',
            quantity: guestCount,
            metadata: {},
          }],
        };
      }
      if (/INSERT INTO waiver_form_requests/i.test(q)) {
        insertCalls += 1;
        // INSERT columns: $5 public_id, $6 token_hash (see sunset-waiver-model createWaiverRequest)
        const publicId = String(params[4] || params.find((p) => String(p || '').startsWith('waiv_')) || `waiv_${crypto.randomBytes(6).toString('hex')}`);
        const row = {
          id: crypto.randomUUID ? crypto.randomUUID() : '11111111-1111-4111-8111-111111111111',
          tenant_id: 'sunset',
          customer_id: null,
          booking_id: bid,
          participant_key: guestCount > 1 ? null : 'primary',
          public_id: publicId,
          token_hash: String(params[6] || 'hash'),
          status: 'pending',
          request_mode: guestCount > 1 ? 'group' : 'single',
          target_count: guestCount > 1 ? guestCount : null,
          form_type: 'sunset_lesson_waiver',
          form_version: 'sunset_google_form_v1_confirmed',
          sent_to_phone: null,
          sent_to_email: null,
          prefill_json: {},
          metadata: { source: 'verify_native' },
          sent_at: null,
          completed_at: null,
          expires_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        createdRequests.set(bid, row);
        return { rows: [row] };
      }
      if (/FROM waiver_form_requests/i.test(q)) {
        if (existing) return { rows: [existing] };
        if (createdRequests.has(bid)) return { rows: [createdRequests.get(bid)] };
        return { rows: [] };
      }
      if (/COUNT\(\*\)/i.test(q) && /waiver_form_submissions/i.test(q)) {
        return { rows: [{ cnt: submissions.length }] };
      }
      if (/FROM waiver_form_submissions/i.test(q)) {
        return { rows: submissions };
      }
      return { rows: [] };
    },
  };
}

(async () => {
  // Single create
  insertCalls = 0;
  createdRequests.clear();
  const createPg = makeNativePg({ bookingId, guestCount: 1 });
  const created = await staff.createOrGetBookingWaiver(createPg, {
    clientSlug: 'sunset',
    bookingId,
    source: 'verify_native_rollback',
    baseUrl: 'https://sunset-staging.lunafrontdesk.com',
  });
  assert('native create ok', created.ok === true && created.status === 201, JSON.stringify(created && created.body));
  assert('native create inserts waiver_form_requests', insertCalls === 1, `insertCalls=${insertCalls}`);
  assert('native create returns waiv_ public url',
    created.body
    && created.body.waiver
    && /\/forms\/waiver\/waiv_/.test(created.body.waiver.public_url || ''),
    JSON.stringify(created.body && created.body.waiver));
  assert('native create has no external mode fields',
    created.body
    && created.body.waiver_mode == null
    && created.body.waiver_offer == null
    && created.body.link_available == null
    && !(created.body.waiver && created.body.waiver.external === true)
    && !(created.body.waiver && created.body.waiver.status === 'external_unverified'),
    JSON.stringify(created.body));
  assert('native create request_mode single',
    created.body.waiver.request_mode === 'single');

  // Reuse pending
  insertCalls = 0;
  const pendingRow = createdRequests.get(bookingId);
  const reusePg = makeNativePg({ bookingId, guestCount: 1, existing: pendingRow });
  const reused = await staff.createOrGetBookingWaiver(reusePg, {
    clientSlug: 'sunset',
    bookingId,
    baseUrl: 'https://sunset-staging.lunafrontdesk.com',
  });
  assert('native reuse pending ok', reused.ok === true && reused.status === 200, JSON.stringify(reused && reused.body));
  assert('native reuse does not re-insert', insertCalls === 0, `insertCalls=${insertCalls}`);
  assert('native reuse same public_id',
    reused.body && reused.body.waiver && reused.body.waiver.public_id === pendingRow.public_id);
  assert('native reuse created=false', reused.body && reused.body.created === false);

  // Status returns native pending (not external projection)
  const statusPg = makeNativePg({ bookingId, guestCount: 1, existing: pendingRow });
  const status = await staff.getBookingWaiverStatus(statusPg, {
    clientSlug: 'sunset',
    bookingId,
    baseUrl: 'https://sunset-staging.lunafrontdesk.com',
  });
  assert('status ok native', status.ok === true, JSON.stringify(status && status.body));
  assert('status returns native pending waiver',
    status.body && status.body.waiver && status.body.waiver.status === 'pending'
    && /\/forms\/waiver\/waiv_/.test(status.body.waiver.public_url || ''));
  assert('status has no external fields',
    status.body.waiver_offer == null
    && status.body.waiver_mode == null
    && status.body.historical_native_waiver == null
    && status.body.link_available == null);

  // Completed native remains readable
  const completedExisting = {
    ...pendingRow,
    status: 'completed',
    completed_at: '2026-06-01T12:00:00.000Z',
  };
  const completedSub = [{
    id: '88888888-8888-4888-8888-888888888888',
    request_id: completedExisting.id,
    submitted_at: '2026-06-01T12:00:00.000Z',
    respondent_name: 'Native Guest',
    respondent_email: 'guest@example.com',
    respondent_phone: '+34600111222',
    form_version: 'sunset_google_form_v1_confirmed',
    raw_answers_json: { answers: { full_name: { label: 'NOMBRE', value: 'Native Guest' } } },
    form_snapshot_json: {},
  }];
  const completedStatus = await staff.getBookingWaiverStatus(
    makeNativePg({ bookingId, guestCount: 1, existing: completedExisting, submissions: completedSub }),
    { clientSlug: 'sunset', bookingId, baseUrl: 'https://sunset-staging.lunafrontdesk.com' },
  );
  assert('completed native readable',
    completedStatus.ok
    && completedStatus.body
    && completedStatus.body.waiver
    && completedStatus.body.waiver.status === 'completed'
    && completedStatus.body.waiver.submission,
    JSON.stringify(completedStatus && completedStatus.body));

  // Group create
  insertCalls = 0;
  createdRequests.clear();
  const groupCreate = await staff.createOrGetBookingWaiver(
    makeNativePg({ bookingId: groupBookingId, guestCount: 3 }),
    {
      clientSlug: 'sunset',
      bookingId: groupBookingId,
      baseUrl: 'https://sunset-staging.lunafrontdesk.com',
      source: 'verify_native_group',
    },
  );
  assert('group create ok', groupCreate.ok === true, JSON.stringify(groupCreate && groupCreate.body));
  assert('group request_mode group',
    groupCreate.body && groupCreate.body.waiver && groupCreate.body.waiver.request_mode === 'group');
  assert('group target_count 3',
    groupCreate.body.waiver.target_count === 3
    || groupCreate.body.target_count === 3);
  assert('group completed_count starts 0',
    Number(groupCreate.body.waiver.completed_count || groupCreate.body.completed_count || 0) === 0);
  assert('group native waiv_ link',
    /\/forms\/waiver\/waiv_/.test((groupCreate.body.waiver && groupCreate.body.waiver.public_url) || ''));

  // Group progress counting
  const groupRow = createdRequests.get(groupBookingId) || {
    id: '22222222-2222-4222-8222-222222222222',
    public_id: 'waiv_groupnative01',
    token_hash: 'ghash',
    status: 'pending',
    request_mode: 'group',
    target_count: 3,
    form_type: 'sunset_lesson_waiver',
    form_version: 'sunset_google_form_v1_confirmed',
    booking_id: groupBookingId,
    tenant_id: 'sunset',
    participant_key: null,
    prefill_json: {},
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const groupSubs = [
    {
      id: 'a',
      request_id: groupRow.id,
      submitted_at: '2026-06-02T10:00:00.000Z',
      respondent_name: 'A',
      form_version: 'sunset_google_form_v1_confirmed',
      raw_answers_json: {},
      form_snapshot_json: {},
    },
    {
      id: 'b',
      request_id: groupRow.id,
      submitted_at: '2026-06-02T11:00:00.000Z',
      respondent_name: 'B',
      form_version: 'sunset_google_form_v1_confirmed',
      raw_answers_json: {},
      form_snapshot_json: {},
    },
  ];
  const groupStatus = await staff.getBookingWaiverStatus(
    makeNativePg({
      bookingId: groupBookingId,
      guestCount: 3,
      existing: groupRow,
      submissions: groupSubs,
    }),
    { clientSlug: 'sunset', bookingId: groupBookingId, baseUrl: 'https://sunset-staging.lunafrontdesk.com' },
  );
  assert('group status completed_count 2',
    groupStatus.ok
    && groupStatus.body
    && (Number(groupStatus.body.completed_count) === 2
      || Number(groupStatus.body.waiver && groupStatus.body.waiver.completed_count) === 2),
    JSON.stringify(groupStatus && groupStatus.body));
  assert('group status target_count 3',
    Number(groupStatus.body.target_count) === 3
    || Number(groupStatus.body.waiver && groupStatus.body.waiver.target_count) === 3);

  // Luna ensure + invite copy uses native hosted link
  insertCalls = 0;
  createdRequests.clear();
  const lunaEnsure = await ensureWaiverForBooking(
    makeNativePg({ bookingId, guestCount: 1 }),
    bookingId,
    { baseUrl: 'https://sunset-staging.lunafrontdesk.com', source: 'luna_verify' },
  );
  assert('Luna ensureWaiverForBooking ok', lunaEnsure.ok === true, JSON.stringify(lunaEnsure && lunaEnsure.body));
  assert('Luna ensure creates native request', insertCalls === 1);
  assert('Luna ensure luna_waiver_message has waiv_ link',
    lunaEnsure.body
    && typeof lunaEnsure.body.luna_waiver_message === 'string'
    && /\/forms\/waiver\/waiv_/.test(lunaEnsure.body.luna_waiver_message),
    String(lunaEnsure.body && lunaEnsure.body.luna_waiver_message).slice(0, 200));
  assert('Luna ensure lesson_ready false while pending',
    lunaEnsure.body.lesson_ready === false);
  assert('Luna ensure blocked reason waiver_not_completed',
    lunaEnsure.body.lesson_ready_blocked_reason === 'waiver_not_completed');
  assert('Luna ensure no external_unverified lane',
    lunaEnsure.body.waiver_lane !== 'external_unverified'
    && lunaEnsure.body.lesson_ready_blocked_reason !== 'external_waiver_unverified');

  const sampleUrl = 'https://sunset-staging.lunafrontdesk.com/forms/waiver/waiv_nativeonly01';
  const invite = buildLunaWaiverInviteMessage({ public_url: sampleUrl, guest_count: 1 });
  assert('Luna invite is native Spanish copy',
    invite.includes('formulario rápido de seguro') && invite.includes(sampleUrl));
  assert('Luna invite not external Google wording',
    !/Google Form|externo|no confirma por sí solo/i.test(invite));

  const attached = attachLunaWaiverFields({
    success: true,
    guest_count: 1,
    waiver: {
      status: 'pending',
      public_url: sampleUrl,
      request_mode: 'single',
    },
  });
  assert('attachLunaWaiverFields pending native',
    attached.lesson_ready === false
    && attached.waiver_lane === 'pending'
    && attached.luna_waiver_message.includes(sampleUrl));

  const doneAttached = attachLunaWaiverFields({
    success: true,
    guest_count: 1,
    waiver: {
      status: 'completed',
      public_url: sampleUrl,
      request_mode: 'single',
      completed_count: 1,
    },
  });
  assert('attachLunaWaiverFields completed native ready',
    doneAttached.lesson_ready === true
    && doneAttached.waiver_lane === 'completed');

  assert('isLessonReadyForGuest single completed',
    isLessonReadyForGuest({ status: 'completed', request_mode: 'single' }) === true);
  assert('isLessonReadyForGuest group partial false',
    isLessonReadyForGuest({
      status: 'pending',
      request_mode: 'group',
      target_count: 3,
      completed_count: 2,
    }) === false);
  assert('isLessonReadyForGuest group full true',
    isLessonReadyForGuest({
      status: 'completed',
      request_mode: 'group',
      target_count: 3,
      completed_count: 3,
    }) === true);

  const groupInvite = composeLunaWaiverReply({
    guest_count: 3,
    waiver: {
      status: 'pending',
      public_url: sampleUrl,
      request_mode: 'group',
      target_count: 3,
      completed_count: 1,
    },
  }, 'invite');
  assert('group Luna reply uses native group copy + link',
    groupInvite.includes('un solo enlace') && groupInvite.includes(sampleUrl));

  // Drawer render: native create button when no waiver; no external strings
  assert('drawer create button id present', drawerSrc.includes('ps-drawer-waiver-create'));
  assert('drawer uses staff waiver create/status endpoints path',
    drawerSrc.includes('/waiver') || staffSrc.includes('STAFF_BOOKING_WAIVER_RE'));
  assert('staff createOrGetBookingWaiver calls createWaiverRequest directly',
    staffSrc.includes('createWaiverRequest')
    && /async function createOrGetBookingWaiver[\s\S]*createWaiverRequest/m.test(staffSrc));
  assert('staff getBookingWaiverStatus uses getLatestWaiverRequest / buildStaffWaiverView',
    staffSrc.includes('getLatestWaiverRequest')
    && staffSrc.includes('buildStaffWaiverView')
    && /async function getBookingWaiverStatus[\s\S]*buildStaffWaiverView/m.test(staffSrc));
  assert('Luna turn uses ensureWaiverForBookingSoft + composeLunaWaiverReply',
    turnSrc.includes('ensureWaiverForBookingSoft')
    && turnSrc.includes('composeLunaWaiverReply')
    && (
      turnSrc.includes("proposedNextAction = waiverBody.lesson_ready === true")
      || /proposedNextAction\s*=\s*waiverBody\.lesson_ready\s*===\s*true[\s\S]{0,120}'waiver_completed'/.test(turnSrc)
    ));

  // Auth: staff waiver routes still require auth (native path preserved)
  assert('staff waiver routes requireAuth preserved',
    apiSrc.includes('handleStaffBookingWaiverGet')
    && apiSrc.includes('handleStaffBookingWaiverCreate')
    && apiSrc.includes('requireAuth'));

  console.log(`\n── verify:native-waiver-rollback: ${pass} passed, ${fail} failed ──`);
  if (fail) process.exit(1);
  console.log('OK  verify:native-waiver-rollback');
})().catch((err) => {
  console.error('FATAL', err && err.stack || err);
  process.exit(1);
});
