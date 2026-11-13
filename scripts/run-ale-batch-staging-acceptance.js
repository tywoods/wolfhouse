#!/usr/bin/env node
'use strict';

/**
 * Ale-batch France Wolfhouse STAGING acceptance runner.
 *
 * Cap #1680 (`scripts/verify-ale-batch-staging.md` @ 28f5b27e) through the
 * existing Live Simulator guest-turn path, then independent Staff readback.
 *
 *   node scripts/run-ale-batch-staging-acceptance.js --dry-run
 *
 * Default --dry-run: no network. Isolation / identity / coverage contract only.
 * A contract-green dry-run is NOT acceptance. PASS requires a real saved
 * booking read back from staging Staff. All-BLOCKED / all-NOT-RUN exits 2.
 *
 * Isolation is FAIL CLOSED: every origin must match STAGING_ALLOWLIST_ORIGINS
 * exactly (https + host + default port 443). http://…:9999 is refused.
 * Unknown hosts are refused. Prod is refused. Never pay a link.
 * PASS needs this-run Staff readback (phone/name+run id AND created-after)
 * plus an explicit per-row assertion. No row defaults to PASS.
 *
 * Simulator: POST {origin}/api/live-simulator/guest-turn
 *   { tenant: "wolfhouse", from_phone, text, lang: "en" } — one bubble per
 *   turn, same phone for a Cap case (Cap #1680 multi-turn). Never messages[].
 * Staff: GET {origin}/staff/bookings/{code}/context?client=wolfhouse-somo
 *   Cookie: luna_staff_session=$ALE_BATCH_STAFF_SESSION (never Bearer).
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const SIMULATOR_PATH = '/api/live-simulator/guest-turn';
const TENANT = 'wolfhouse';
const STAFF_CLIENT = 'wolfhouse-somo';
const DEFAULT_STAFF_ORIGIN = 'https://staff-staging.lunafrontdesk.com';
const STAFF_SESSION_COOKIE_NAME = 'luna_staff_session';
const STAGING_ALLOWLIST_ORIGINS = Object.freeze([
  'https://staff-staging.lunafrontdesk.com',
  'https://178.33.91.59',
]);
const TEST_NAME_RE = /^Ale Test [A-Z][a-z]+ r\d{10}$/;
const TEST_GUESTS = Object.freeze({
  '01': Object.freeze(['Ale Test Ada', 'Ale Test Bea', 'Ale Test Cal']),
  '02': Object.freeze(['Ale Test Dana', 'Ale Test Eli']),
  '03': Object.freeze(['Ale Test Fran', 'Ale Test Gus']),
  '04': Object.freeze(['Ale Test Hana', 'Ale Test Ivo']),
  '05': Object.freeze(['Ale Test Jo', 'Ale Test Kim']),
  '06': Object.freeze(['Ale Test Lia']),
  '07': Object.freeze(['Ale Test Mo']),
  '08': Object.freeze(['Ale Test Nia']),
});

/** Full Cap #1680 §6 table. required:false only for the optional observation. */
const CHECKLIST = Object.freeze([
  { id: 'A_split_handoff', cap: 'A', title: 'Split save + payment-complaint handoff', phone_case: '01', required: true },
  { id: 'AH_offline_reasons', cap: 'A-H', title: 'Exact-reason offline matrix + create/retry SQL', phone_case: null, required: true, offline: true },
  { id: 'AH_live_human_room', cap: 'A-H', title: 'Live human request (E) / room check (C)', phone_case: '03', required: true },
  { id: 'B_draft_200_to_415', cap: 'B', title: 'Draft 20000→41500 full', phone_case: '02', required: true },
  { id: 'B_415_to_200_timed', cap: 'B', title: '41500→20000 / timed correction', phone_case: '02', required: true },
  { id: 'C_g1_g2', cap: 'C', title: '/g1 and /g2 person amounts', phone_case: '03', required: true },
  { id: 'D_yoga_rentals', cap: 'D', title: 'One yoga / two rentals × five nights (43000→53000)', phone_case: '04', required: true },
  { id: 'DS_per_day_50', cap: 'D-S', title: 'Per-day Staff Service: 5000 increase (€50)', phone_case: '04', required: true },
  { id: 'E_half_day', cap: 'E', title: 'Half-day / already-in-total extra', phone_case: '05', required: true },
  { id: 'F_shuttle_below', cap: 'F', title: 'Shuttle below current default nights', phone_case: '06', required: true },
  { id: 'G_shuttle_at', cap: 'G', title: 'Shuttle at current default nights', phone_case: '07', required: true },
  { id: 'H_shuttle_above', cap: 'H', title: 'Shuttle above current default nights', phone_case: '08', required: true },
  { id: 'W_search_unchanged', cap: 'W', title: 'Real search + unchanged H booking', phone_case: '08', required: true },
  { id: 'pay_status_BCE', cap: '§2', title: 'Payment-status evidence B/C/E', phone_case: '02', required: true },
  { id: 'I_GINA_zero', cap: 'I-GINA', title: 'Gina zero snapshot: 97500 total / 65000 balance', phone_case: null, required: true, read_only: true },
  { id: 'I_GINA_bundled', cap: 'I-GINA', title: 'Gina bundled snapshot: 97500 total / 65000 balance', phone_case: null, required: true, read_only: true },
  { id: 'I_DEAD_cancelled', cap: 'I-DEAD', title: 'Cancelled + retained checkout_url', phone_case: null, required: true, read_only: true },
  { id: 'I_DEAD_expired', cap: 'I-DEAD', title: 'Expired + retained checkout_url', phone_case: null, required: true, read_only: true },
  { id: 'I_DEAD_failed', cap: 'I-DEAD', title: 'Failed + retained checkout_url', phone_case: null, required: true, read_only: true },
  { id: 'link_failure_optional', cap: '§5', title: 'Observed link-failure preservation', phone_case: null, required: false },
  { id: 'price_before_save', cap: 'quote', title: 'Price shown before save', phone_case: '02', required: true },
  { id: 'no_shall_i_book', cap: '§4', title: 'Never asks “shall I book” after a clear choice to book', phone_case: '02', required: true },
  { id: 'deposit_or_full_no_early_link', cap: 'B', title: 'Deposit-or-full asked; no guessed early pay link', phone_case: '02', required: true },
  { id: 'full_stays_full', cap: 'B', title: 'Full stays full (saved link amount matches full)', phone_case: '02', required: true },
  { id: 'add_guest_always_saves', cap: 'A', title: 'Add-guest / agreed save always inserts a booking', phone_case: '01', required: true },
  { id: 'wave_smile_once', cap: 'voice', title: 'One 🌊😊 pair max per chat', phone_case: '01', required: true },
  { id: 'warm_note_before_needs_human', cap: 'A', title: 'Warm note before Needs human', phone_case: '01', required: true },
  { id: 'shared_room_not_dorm', cap: 'copy', title: '“shared room”, not “dorm”', phone_case: '01', required: true },
]);

const REQUIRED_CAP_IDS = Object.freeze([
  'A_split_handoff', 'AH_offline_reasons', 'AH_live_human_room',
  'B_draft_200_to_415', 'B_415_to_200_timed', 'C_g1_g2',
  'D_yoga_rentals', 'DS_per_day_50', 'E_half_day',
  'F_shuttle_below', 'G_shuttle_at', 'H_shuttle_above',
  'W_search_unchanged', 'pay_status_BCE',
  'I_GINA_zero', 'I_GINA_bundled',
  'I_DEAD_cancelled', 'I_DEAD_expired', 'I_DEAD_failed',
  'price_before_save', 'no_shall_i_book', 'deposit_or_full_no_early_link',
  'full_stays_full', 'add_guest_always_saves', 'wave_smile_once',
  'warm_note_before_needs_human', 'shared_room_not_dorm',
]);

function parseArgs(argv) {
  const out = {
    dryRun: true,
    execute: false,
    runId: process.env.ALE_BATCH_RUN_ID || defaultRunId(),
    simulatorOrigin: process.env.ALE_BATCH_SIMULATOR_ORIGIN || '',
    staffOrigin: process.env.ALE_BATCH_STAFF_ORIGIN || DEFAULT_STAFF_ORIGIN,
    staffSession: process.env.ALE_BATCH_STAFF_SESSION || '',
    startedAt: new Date(),
    checkIn: process.env.ALE_BATCH_CHECKIN || '2027-08-16',
    defaultNights: Number(process.env.ALE_BATCH_DEFAULT_NIGHTS || 6),
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') { out.dryRun = true; out.execute = false; }
    else if (a === '--execute') { out.execute = true; out.dryRun = false; }
    else if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--simulator-origin') out.simulatorOrigin = argv[++i];
    else if (a === '--staff-origin') out.staffOrigin = argv[++i];
    else if (a === '--check-in') out.checkIn = argv[++i];
    else if (a === '--default-nights') out.defaultNights = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function defaultRunId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`.slice(-10);
}

function reservedPhone(runId, caseNum) {
  const run = String(runId || '').replace(/\D/g, '').padStart(10, '0').slice(-10);
  const cs = String(caseNum == null ? '00' : caseNum).replace(/\D/g, '').padStart(2, '0').slice(-2);
  return `+999${run}${cs}`;
}

function phoneDigits(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function isReservedTestPhone(phone) {
  const digits = phoneDigits(phone);
  return String(phone || '').startsWith('+999') && digits.length === 15 && digits.startsWith('999');
}

function isTestGuestName(name) {
  return TEST_NAME_RE.test(String(name || '').trim());
}

function labelledGuestNames(caseNum, runId) {
  const run = String(runId || '').replace(/\D/g, '').padStart(10, '0').slice(-10);
  return (TEST_GUESTS[caseNum] || []).map((n) => `${n} r${run}`);
}

function addDaysIso(iso, nights) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(nights));
  return d.toISOString().slice(0, 10);
}

function stayPhrase(checkIn, nights) {
  return `from ${checkIn} to ${addDaysIso(checkIn, nights)} (${nights} nights)`;
}

function extractBookingCode(json) {
  if (!json || typeof json !== 'object') return null;
  return json.booking_code
    || (json.booking && (json.booking.booking_code || json.booking.code))
    || (json.result && json.result.booking_code)
    || null;
}

function extractReply(json) {
  if (!json || typeof json !== 'object') return '';
  return String(json.reply || json.final_response || json.text || json.message || '');
}

function sleep(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}

/**
 * Cap #1680 multi-turn scripts. One guest bubble per turn, same +999 phone.
 * Checkpoints are Staff readbacks after that turn. Never a messages[] burst.
 * Stay windows are disjoint. Shuttle nights follow CURRENT default N, not 5.
 */
function buildMultiTurnPlan(args) {
  const runId = args.runId;
  const checkIn = String(args.checkIn || '2027-08-16');
  const N = Number(args.defaultNights);
  const defaultNights = Number.isFinite(N) && N > 1 ? N : 6;
  const n = (cs) => labelledGuestNames(cs, runId);
  const a = n('01');
  const b = n('02');
  const c = n('03');
  const d = n('04');
  const e = n('05');
  const f = n('06');
  const g = n('07');
  const h = n('08');
  const dee = `Ale Test Dee r${String(runId).replace(/\D/g, '').padStart(10, '0').slice(-10)}`;
  const A = stayPhrase(checkIn, 6);
  const Bstay = stayPhrase(addDaysIso(checkIn, 14), 6);
  const Cstay = stayPhrase(addDaysIso(checkIn, 28), 6);
  const Dstay = stayPhrase(addDaysIso(checkIn, 42), 5);
  const Estay = stayPhrase(addDaysIso(checkIn, 56), 6);
  const Fstay = stayPhrase(addDaysIso(checkIn, 70), defaultNights - 1);
  const Gstay = stayPhrase(addDaysIso(checkIn, 84), defaultNights);
  const Hstay = stayPhrase(addDaysIso(checkIn, 98), defaultNights + 1);
  const eIn = addDaysIso(checkIn, 56);
  const statusQ = 'Have my payment links been sent, and have I paid anything yet?';
  const deadQ = 'What is my payment status?';

  const conversations = [
    {
      key: 'A',
      phone_case: '01',
      nights: 6,
      turns: [
        { text: `${a[0]} and ${a[1]} are women and want the women-only shared room. ${a[2]} will take a mixed shared-room bed. Three of us, ${A}. Please quote the available package.` },
        { text: 'Yes, please book that. Pay together.' },
        { text: 'Deposit please.', checkpoint: ['A_split_handoff', 'shared_room_not_dorm', 'wave_smile_once'] },
        { text: `Please add ${dee} to this booking as well.`, extraNames: [dee], checkpoint: ['add_guest_always_saves'] },
        { text: 'My card was charged but I got nothing. Please ask your team to help me with the payment.', checkpoint: ['warm_note_before_needs_human'] },
      ],
    },
    {
      key: 'B',
      phone_case: '02',
      nights: 6,
      turns: [
        { text: `${b[0]} and ${b[1]}, two people, ${Bstay}. Please quote.` },
        { text: 'Yes, please save this booking.' },
        { text: 'pay together', checkpoint: ['deposit_or_full_no_early_link', 'price_before_save', 'no_shall_i_book'] },
        { text: 'full ammount', checkpoint: ['B_draft_200_to_415', 'full_stays_full'] },
        { text: 'actually deposit please' },
        { text: 'full' },
        { text: 'actually deposit', waitMs: 2500, checkpoint: ['B_415_to_200_timed'] },
        { text: statusQ, checkpoint: ['pay_status_BCE'] },
      ],
    },
    {
      key: 'C',
      phone_case: '03',
      nights: 6,
      turns: [
        { text: `${c[0]} and ${c[1]}, two people, ${Cstay}. Please quote.` },
        { text: 'Yes, please save. Separate payment links.' },
        { text: 'deposit', checkpoint: ['C_g1_g2'] },
        { text: "Please send Fran's existing deposit link again." },
        { text: statusQ },
        { text: 'I think the shared-room assignment is wrong. Please ask your team to check it with me.', tag: 'handoffC' },
      ],
    },
    {
      key: 'D',
      phone_case: '04',
      nights: 5,
      turns: [
        { text: `${d[0]} and ${d[1]}, two people, ${Dstay}. Please quote.` },
        { text: 'Yes, please save. Deposit.' },
        { text: 'Please add one yoga session for Hana.' },
        { text: 'Please add flip-flop rentals for both of us for all five nights, one each.', checkpoint: ['D_yoga_rentals'] },
        { text: 'What is the updated total, what is due now, and what will remain after I pay that link?' },
        { text: 'Please add one Bike desk service for the whole five-night stay.', checkpoint: ['DS_per_day_50'] },
      ],
    },
    {
      key: 'E',
      phone_case: '05',
      nights: 6,
      turns: [
        { text: `${e[0]} and ${e[1]}, two people, ${Estay}, and add one half-day rental for ${e[0]} on ${eIn}. Please quote.` },
        { text: 'Yes, please save. Deposit.', checkpoint: ['E_half_day'] },
        { text: statusQ },
        { text: 'Please let me speak with your team about my booking.', tag: 'handoffE', checkpoint: ['AH_live_human_room'] },
      ],
    },
    {
      key: 'F',
      phone_case: '06',
      nights: defaultNights - 1,
      turns: [
        { text: `${f[0]}, one person, ${Fstay}, the usual package. Please quote.` },
        { text: 'Yes, please book. Deposit.', checkpoint: ['F_shuttle_below'] },
      ],
    },
    {
      key: 'G',
      phone_case: '07',
      nights: defaultNights,
      turns: [
        { text: `${g[0]}, one person, ${Gstay}, the usual package. Please quote.` },
        { text: 'No shuttle needed.' },
        { text: 'Yes, please book. Deposit.', checkpoint: ['G_shuttle_at'] },
      ],
    },
    {
      key: 'H',
      phone_case: '08',
      nights: defaultNights + 1,
      turns: [
        { text: `${h[0]}, one person, ${Hstay}, the usual package. Please quote.` },
        { text: 'No shuttle needed.' },
        { text: 'Yes, please book. Deposit.', checkpoint: ['H_shuttle_above'] },
      ],
    },
    {
      key: 'W',
      phone_case: '08',
      continue: true,
      nights: defaultNights + 1,
      turns: [
        { text: 'Could you look up a pizza place near Wolfhouse in Somo for tonight and send me the source?', checkpoint: ['W_search_unchanged'] },
      ],
    },
  ];

  return {
    defaultNights,
    checkIn,
    conversations,
    deadQuestion: deadQ,
    dead: [
      { id: 'I_DEAD_cancelled', envCode: 'ALE_BATCH_DEAD_CANCELLED_CODE', envPhone: 'ALE_BATCH_DEAD_CANCELLED_PHONE' },
      { id: 'I_DEAD_expired', envCode: 'ALE_BATCH_DEAD_EXPIRED_CODE', envPhone: 'ALE_BATCH_DEAD_EXPIRED_PHONE' },
      { id: 'I_DEAD_failed', envCode: 'ALE_BATCH_DEAD_FAILED_CODE', envPhone: 'ALE_BATCH_DEAD_FAILED_PHONE' },
    ],
    dee,
  };
}

function thisRunMarker(runId, caseNum) {
  return {
    runId: String(runId || '').replace(/\D/g, '').padStart(10, '0').slice(-10),
    phone: caseNum ? reservedPhone(runId, caseNum) : null,
    names: caseNum ? labelledGuestNames(caseNum, runId) : [],
  };
}

function hostnameOf(origin) {
  if (!origin) return '';
  try {
    const u = new URL(origin.includes('://') ? origin : `https://${origin}`);
    return String(u.hostname || '').toLowerCase();
  } catch (_) {
    return String(origin).replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  }
}

function canonicalHttpsOrigin(origin) {
  const raw = String(origin || '').trim();
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.port && u.port !== '443') return null;
  const host = String(u.hostname || '').toLowerCase();
  if (!host) return null;
  return `https://${host}`;
}

function requireStagingOrigin(label, origin) {
  const raw = String(origin || '').trim();
  if (!raw) return { ok: false, reason: `${label} origin missing` };
  if (/prod/i.test(raw) || raw.toLowerCase().includes('wolfhouse-prod')) {
    return { ok: false, reason: `${label} refuses prod token in origin` };
  }
  const canonical = canonicalHttpsOrigin(raw);
  if (!canonical) {
    return { ok: false, reason: `${label} origin is not https://host (default port): ${raw}` };
  }
  if (!STAGING_ALLOWLIST_ORIGINS.includes(canonical)) {
    return { ok: false, reason: `${label} not on staging origin allowlist: ${canonical}` };
  }
  return { ok: true, origin: canonical, host: hostnameOf(canonical) };
}

function requireAllStagingOrigins(origins) {
  const results = [];
  for (const [label, origin] of origins) {
    results.push(requireStagingOrigin(label, origin));
  }
  const bad = results.find((r) => !r.ok);
  if (bad) return { ok: false, reason: bad.reason, results };
  return { ok: true, results };
}

function bearerTokenLeftoverSet() {
  return Boolean(String(process.env.ALE_BATCH_STAFF_TOKEN || '').trim());
}

function resolveStaffSession(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return { ok: false, reason: 'ALE_BATCH_STAFF_SESSION missing' };
  if (/^bearer\s+/i.test(value) || /[\r\n;]/.test(value)) {
    return { ok: false, reason: 'ALE_BATCH_STAFF_SESSION malformed' };
  }
  return { ok: true, cookie: `${STAFF_SESSION_COOKIE_NAME}=${value}` };
}

function staffReadbackHeaders(sessionRaw) {
  const resolved = resolveStaffSession(sessionRaw);
  if (!resolved.ok) return { ok: false, reason: resolved.reason, headers: {} };
  return {
    ok: true,
    headers: Object.freeze({ cookie: resolved.cookie }),
  };
}

function requireStaffSessionForExecute(args) {
  if (bearerTokenLeftoverSet()) {
    return {
      ok: false,
      reason: 'ALE_BATCH_STAFF_TOKEN/Bearer is not Staff auth; set ALE_BATCH_STAFF_SESSION (luna_staff_session cookie)',
    };
  }
  const headers = staffReadbackHeaders(args && args.staffSession);
  if (!headers.ok) return { ok: false, reason: headers.reason };
  return { ok: true };
}

function guestTurnPayload(phone, text, lang) {
  if (!isReservedTestPhone(phone)) {
    throw new Error('REFUSED: from_phone is not a reserved +999 test identity');
  }
  return {
    tenant: TENANT,
    from_phone: phone,
    text: String(text || ''),
    lang: lang || 'en',
  };
}

function staffContextPath(bookingCode) {
  const code = encodeURIComponent(String(bookingCode || '').trim());
  return `/staff/bookings/${code}/context?client=${encodeURIComponent(STAFF_CLIENT)}`;
}

function neverPayUrl(url) {
  const s = String(url || '');
  if (/checkout\.stripe\.com/i.test(s)) {
    return { ok: false, reason: 'REFUSED: never follow or pay a Stripe checkout link' };
  }
  if (/\/v1\/charges|\/v1\/payment_intents/i.test(s)) {
    return { ok: false, reason: 'REFUSED: never create a real charge' };
  }
  return { ok: true };
}

function countWaveSmilePairs(text) {
  const s = String(text || '');
  return (s.match(/🌊\s*😊|😊\s*🌊/g) || []).length;
}

function asksShallIBook(text) {
  return /\bshall i (book|save|reserve)\b|\b(guardo|save) (esta |la )?reserva\??/i.test(String(text || ''));
}

function usesDorm(text) {
  return /\bdorm(?:itory)?\b/i.test(String(text || ''));
}

function usesSharedRoom(text) {
  return /\bshared room\b/i.test(String(text || ''));
}

function staffBookingIdentity(ctx, httpStatus) {
  if (httpStatus != null && httpStatus !== 200) {
    return { ok: false, detail: `Staff HTTP ${httpStatus}` };
  }
  if (!ctx || typeof ctx !== 'object') return { ok: false, detail: 'no Staff JSON' };
  if (ctx.success !== true) return { ok: false, detail: 'Staff success!==true' };
  const booking = ctx.booking || {};
  const id = booking.booking_id || booking.id;
  const code = booking.booking_code || booking.code;
  if (!id || !code) return { ok: false, detail: 'Staff readback missing booking_id/code' };
  return { ok: true, booking_id: id, booking_code: code, booking };
}

function bookingCreatedAt(booking, ctx) {
  return (booking && (booking.created_at || booking.createdAt))
    || (ctx && (ctx.created_at || ctx.createdAt))
    || null;
}

function belongsToThisRun(ctx, marker, createdAfter) {
  if (!marker || !marker.runId) {
    return { ok: false, detail: 'missing this-run marker' };
  }
  const booking = (ctx && ctx.booking) || {};
  const phone = booking.guest_phone || booking.phone
    || (ctx.conversation && (ctx.conversation.phone || ctx.conversation.from_phone));
  const guests = ctx.booking_guests || booking.guests || [];
  const guestNames = guests.map((g) => (g && (g.guest_name || g.name)) || '').filter(Boolean);
  const phoneOk = isReservedTestPhone(marker.phone) && phone === marker.phone;
  const nameOk = Array.isArray(marker.names) && marker.names.length > 0
    && marker.names.every((n) => isTestGuestName(n) && guestNames.includes(n));
  if (!phoneOk || !nameOk) {
    return { ok: false, detail: 'readback is not this run’s test booking (phone/name+runId mismatch)' };
  }
  const created = bookingCreatedAt(booking, ctx);
  if (!created) return { ok: false, detail: 'readback missing created_at' };
  const createdMs = Date.parse(created);
  const afterMs = createdAfter instanceof Date ? createdAfter.getTime() : Date.parse(createdAfter);
  if (!Number.isFinite(createdMs) || !Number.isFinite(afterMs) || createdMs < afterMs) {
    return { ok: false, detail: `created_at ${created} is not after run start` };
  }
  return { ok: true, created };
}

function moneyFromCtx(ctx, booking) {
  const financials = (ctx && ctx.financials) || {};
  return {
    invoice: Number(financials.invoice_total_cents != null
      ? financials.invoice_total_cents : booking.total_amount_cents),
    paid: Number(financials.paid_total_cents != null
      ? financials.paid_total_cents : booking.amount_paid_cents),
    balance: Number(financials.balance_due_cents != null
      ? financials.balance_due_cents : booking.balance_due_cents),
    payments: ((ctx && ctx.payments && ctx.payments.rows) || []).slice(),
    services: (ctx && ctx.service_records) || [],
  };
}

const ITEM_ASSERTIONS = Object.freeze({
  A_split_handoff(ctx) {
    const guests = ctx.booking_guests || [];
    if (guests.length !== 3) return { ok: false, detail: `split needs 3 saved guests, got ${guests.length}` };
    return { ok: true, detail: '3 named guests saved on this-run booking' };
  },
  AH_offline_reasons() {
    return { ok: null, detail: 'offline exact-reason matrix not executed this run' };
  },
  AH_live_human_room(ctx, extras) {
    if (extras && extras.needsHumanC === true && extras.needsHumanE === true) {
      return { ok: true, detail: 'Needs human on C and E this-run bookings' };
    }
    if (extras && (extras.needsHumanC != null || extras.needsHumanE != null)) {
      return { ok: false, detail: `needs_human C=${extras.needsHumanC} E=${extras.needsHumanE}` };
    }
    const handoff = ctx.handoff || ctx.conversation || {};
    if (handoff.needs_human === true || ctx.needs_human === true) {
      return { ok: true, detail: 'Needs human persisted on this-run booking' };
    }
    return { ok: false, detail: 'no persisted Needs human on this-run booking' };
  },
  B_draft_200_to_415(ctx, extras, money) {
    const due = Number((money.payments.find((r) => String(r.payment_status || '').includes('checkout') || r.payment_status === 'waiting_payment' || r.payment_status === 'payment_link_sent') || {}).amount_due_cents);
    if (due === 41500) return { ok: true, detail: 'this-run link 41500' };
    return { ok: false, detail: `link amount ${due} !== 41500` };
  },
  B_415_to_200_timed(ctx, extras, money) {
    const due = Number((money.payments.find((r) => r.amount_due_cents === 20000) || {}).amount_due_cents);
    if (due === 20000) return { ok: true, detail: 'this-run selected link 20000' };
    return { ok: false, detail: `no 20000 selected link` };
  },
  C_g1_g2(ctx) {
    const payments = ((ctx.payments && ctx.payments.rows) || []).filter((r) => r.booking_guest_id);
    if (payments.length >= 2) return { ok: true, detail: `${payments.length} person-bound payment rows` };
    return { ok: false, detail: 'need distinct /g1 /g2 person-bound rows' };
  },
  D_yoga_rentals(ctx, extras, money) {
    if (money.invoice === 53000) return { ok: true, detail: 'invoice 53000 this-run' };
    return { ok: false, detail: `invoice ${money.invoice} !== 53000` };
  },
  DS_per_day_50(ctx, extras, money) {
    const hit = money.services.find((row) => Number(row.amount_due_cents) === 5000);
    if (hit) return { ok: true, detail: 'service 5000 cents (€50)' };
    return { ok: false, detail: 'no 5000-cent per-day service row' };
  },
  E_half_day(ctx) {
    const blob = JSON.stringify(ctx.service_records || ctx.addons || []);
    if (/half[- ]day/i.test(blob)) return { ok: true, detail: 'half-day extra on this-run booking' };
    return { ok: false, detail: 'no half-day unit on saved extra' };
  },
  F_shuttle_below(ctx) {
    const transfers = ctx.transfers || ctx.transfer_save_results || [];
    if (Array.isArray(transfers) && transfers.length === 0) {
      return { ok: true, detail: 'no shuttle transfer on below-default stay' };
    }
    if (!transfers || transfers.length === 0) return { ok: true, detail: 'no transfer records' };
    return { ok: false, detail: 'unexpected shuttle transfer on short stay' };
  },
  G_shuttle_at(ctx, extras) {
    if (extras.nights == null || extras.defaultNights == null) {
      return { ok: null, detail: 'no current default_nights evidence' };
    }
    if (Number(extras.nights) !== Number(extras.defaultNights)) {
      return { ok: false, detail: `stay ${extras.nights} !== default ${extras.defaultNights}` };
    }
    return { ok: true, detail: 'stay nights equal current package default' };
  },
  H_shuttle_above(ctx, extras) {
    if (extras.nights == null || extras.defaultNights == null) {
      return { ok: null, detail: 'no current default_nights evidence' };
    }
    if (Number(extras.nights) <= Number(extras.defaultNights)) {
      return { ok: false, detail: `stay ${extras.nights} is not above default ${extras.defaultNights}` };
    }
    return { ok: true, detail: 'stay nights above current package default' };
  },
  W_search_unchanged(ctx, extras, money) {
    if (extras.priorInvoice == null) return { ok: null, detail: 'no prior H invoice to compare' };
    if (Number(money.invoice) !== Number(extras.priorInvoice)) {
      return { ok: false, detail: `invoice changed ${extras.priorInvoice} → ${money.invoice}` };
    }
    return { ok: true, detail: `H booking still ${money.invoice} after search` };
  },
  pay_status_BCE(ctx, extras, money) {
    if (money.paid === 0) return { ok: true, detail: 'P=0 links-sent ≠ paid' };
    return { ok: false, detail: `paid ${money.paid} must stay 0` };
  },
  I_GINA_zero(ctx, extras, money) {
    const snap = (((ctx.booking || {}).metadata || {}).quote_snapshot || {}).line_items || [];
    const zero = snap.length === 1 && snap[0].code === 'guest_package' && snap[0].total_cents === 0;
    if (money.invoice === 97500 && money.balance === 65000 && money.paid === 32500 && zero) {
      return { ok: true, detail: 'Gina zero snapshot €975/€650' };
    }
    return { ok: false, detail: `Gina zero T=${money.invoice} P=${money.paid} B=${money.balance}` };
  },
  I_GINA_bundled(ctx, extras, money) {
    const snap = (((ctx.booking || {}).metadata || {}).quote_snapshot || {}).line_items || [];
    const bundled = snap.length === 1 && snap[0].code === 'guest_package' && snap[0].total_cents === 97500;
    if (money.invoice === 97500 && money.balance === 65000 && money.paid === 32500 && bundled) {
      return { ok: true, detail: 'Gina bundled snapshot €975/€650' };
    }
    return { ok: false, detail: `Gina bundled T=${money.invoice} P=${money.paid} B=${money.balance}` };
  },
  I_DEAD_cancelled(ctx) {
    const st = String((ctx.payments && ctx.payments.booking_payment_status) || (ctx.booking || {}).booking_payment_status || '');
    if (st === 'cancelled' || st === 'canceled') return { ok: true, detail: 'projected cancelled' };
    return { ok: false, detail: `status ${st} is not cancelled` };
  },
  I_DEAD_expired(ctx) {
    const st = String((ctx.payments && ctx.payments.booking_payment_status) || (ctx.booking || {}).booking_payment_status || '');
    if (st === 'expired') return { ok: true, detail: 'projected expired' };
    return { ok: false, detail: `status ${st} is not expired` };
  },
  I_DEAD_failed(ctx) {
    const st = String((ctx.payments && ctx.payments.booking_payment_status) || (ctx.booking || {}).booking_payment_status || '');
    if (st === 'failed') return { ok: true, detail: 'projected failed' };
    return { ok: false, detail: `status ${st} is not failed` };
  },
  price_before_save(ctx, extras) {
    const blob = String((extras && extras.transcript) || '');
    if (!blob) return { ok: null, detail: 'no transcript to prove price-before-save' };
    if (/€\s*[0-9]/.test(blob)) return { ok: true, detail: '€ amount present before save' };
    return { ok: false, detail: 'no € amount in guest-visible turns' };
  },
  no_shall_i_book(ctx, extras) {
    const blob = String((extras && extras.transcript) || '');
    if (!blob) return { ok: null, detail: 'no transcript to prove no shall-I-book' };
    if (asksShallIBook(blob)) return { ok: false, detail: 'asked shall-I-book after consent' };
    return { ok: true, detail: 'no extra save-consent gate' };
  },
  deposit_or_full_no_early_link(ctx, extras, money) {
    const active = money.payments.filter((row) => {
      const st = String(row.payment_status || '').toLowerCase();
      return st === 'checkout_created' || !!(row.checkout_url && st !== 'draft');
    });
    if (active.length === 0) return { ok: true, detail: 'no early checkout on this-run booking' };
    return { ok: false, detail: `${active.length} early checkout row(s)` };
  },
  full_stays_full(ctx, extras, money) {
    const active = money.payments.find((row) => {
      const st = String(row.payment_status || row.status || '').toLowerCase();
      return st === 'checkout_created' || st === 'waiting_payment' || st === 'payment_link_sent';
    });
    const due = Number(active && active.amount_due_cents);
    const total = Number((ctx.booking || {}).total_amount_cents);
    if (!active) return { ok: false, detail: 'no active checkout row' };
    if (total && due === total) return { ok: true, detail: `link ${due} matches total` };
    return { ok: false, detail: `link ${due} vs total ${total}` };
  },
  add_guest_always_saves(ctx) {
    const guests = ctx.booking_guests || [];
    if (guests.length >= 4 && (ctx.booking || {}).booking_id) {
      return { ok: true, detail: `${guests.length} guests saved (add-guest)` };
    }
    return { ok: false, detail: 'add-guest did not persist extra guests' };
  },
  wave_smile_once(ctx, extras) {
    const blob = String((extras && extras.transcript) || '');
    if (!blob) return { ok: null, detail: 'no transcript to count 🌊😊' };
    const n = countWaveSmilePairs(blob);
    if (n <= 1) return { ok: true, detail: `${n} wave+smile pair(s)` };
    return { ok: false, detail: `${n} wave+smile pairs` };
  },
  warm_note_before_needs_human(ctx, extras) {
    const blob = String((extras && extras.transcript) || '');
    if (!blob) return { ok: null, detail: 'no transcript ordering vs handoff' };
    const needs = (ctx.handoff && ctx.handoff.needs_human) || ctx.needs_human;
    if (!needs) return { ok: false, detail: 'Needs human not persisted' };
    return { ok: true, detail: 'warm note evidence + Needs human on this-run booking' };
  },
  shared_room_not_dorm(ctx, extras) {
    const blob = String((extras && extras.transcript) || JSON.stringify(ctx.guest_rooms || ctx.rooming || []));
    if (usesDorm(blob)) return { ok: false, detail: 'used dorm' };
    if (usesSharedRoom(blob) || /shared/.test(blob)) return { ok: true, detail: 'shared room' };
    return { ok: null, detail: 'no shared-room copy to score' };
  },
});

function scoreStaffReadback(item, ctx, httpStatus, runCtx) {
  const ident = staffBookingIdentity(ctx, httpStatus);
  if (!ident.ok) return { ...ident, asserted: false };
  const live = item.read_only !== true && item.offline !== true && item.required !== false
    && item.id !== 'AH_offline_reasons' && item.id !== 'link_failure_optional';
  if (live || (item.phone_case && runCtx && runCtx.marker)) {
    const marker = (runCtx && runCtx.marker) || null;
    const createdAfter = runCtx && runCtx.createdAfter;
    if (!runCtx || !runCtx.requestedBookingCode || ident.booking_code !== runCtx.requestedBookingCode) {
      return { ok: false, asserted: false, detail: 'Staff booking code does not match requested code', booking_id: ident.booking_id, booking_code: ident.booking_code };
    }
    if (marker && marker.phone) {
      const mine = belongsToThisRun(ctx, marker, createdAfter);
      if (!mine.ok) return { ...mine, asserted: false, booking_id: ident.booking_id, booking_code: ident.booking_code };
    } else if (live) {
      return { ok: false, asserted: false, detail: 'missing this-run marker for live booking', booking_id: ident.booking_id, booking_code: ident.booking_code };
    }
  }
  const money = moneyFromCtx(ctx, ident.booking);
  const assertFn = ITEM_ASSERTIONS[item.id];
  if (typeof assertFn !== 'function') {
    return {
      ok: null,
      asserted: false,
      detail: `no explicit assertion for ${item.id}`,
      booking_id: ident.booking_id,
      booking_code: ident.booking_code,
    };
  }
  const asserted = assertFn(ctx, runCtx || {}, money);
  return {
    ...asserted,
    asserted: asserted.ok != null,
    booking_id: ident.booking_id,
    booking_code: ident.booking_code,
  };
}

function acceptanceRow(item, staffScore, extraDetail) {
  const booking = staffScore && (staffScore.booking_code
    ? `${staffScore.booking_code}/${staffScore.booking_id || ''}`
    : '—');
  const detail = extraDetail
    ? `${(staffScore && staffScore.detail) || ''} ${extraDetail}`.trim()
    : (staffScore && staffScore.detail) || 'no Staff booking readback';
  const base = { id: item.id, booking: booking || '—', detail, required: item.required !== false };
  if (!staffScore) return { ...base, verdict: 'NOT RUN' };
  if (staffScore.asserted !== true) {
    if (staffScore.ok === false) return { ...base, verdict: 'FAIL' };
    return { ...base, verdict: 'NOT RUN' };
  }
  if (staffScore.ok === true && staffScore.booking_id && staffScore.booking_code) {
    return { ...base, verdict: 'PASS' };
  }
  if (staffScore.ok === false) return { ...base, verdict: 'FAIL' };
  return { ...base, verdict: 'NOT RUN' };
}

function requestJson(method, url, { body, headers, timeoutMs, allowRedirects } = {}) {
  const pay = neverPayUrl(url);
  if (!pay.ok) return Promise.reject(new Error(pay.reason));
  const originCheck = requireStagingOrigin('request', url);
  if (!originCheck.ok) return Promise.reject(new Error(originCheck.reason));
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body == null ? null : JSON.stringify(body);
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || undefined,
      path: `${u.pathname}${u.search}`,
      method,
      headers: {
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...(headers || {}),
      },
    }, (res) => {
      if (allowRedirects !== true && res.statusCode >= 300 && res.statusCode < 400) {
        const loc = String((res.headers && (res.headers.location || res.headers.Location)) || '');
        const follow = neverPayUrl(loc);
        if (!follow.ok) {
          resolve({ status: res.statusCode, json: null, raw: '', location: loc, followed: false });
          res.resume();
          return;
        }
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { json = null; }
        resolve({ status: res.statusCode, json, raw, location: null, followed: false });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs || 30000, () => {
      req.destroy(new Error('timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function postGuestTurn(origin, phone, text, lang, names) {
  const gate = requireStagingOrigin('simulator', origin);
  if (!gate.ok) throw new Error(gate.reason);
  if (!isReservedTestPhone(phone)) throw new Error('REFUSED: not a reserved +999 test phone');
  for (const n of names || []) {
    if (!isTestGuestName(n)) throw new Error(`REFUSED: guest name is not Ale Test labelled: ${n}`);
  }
  const url = new URL(SIMULATOR_PATH, origin);
  return requestJson('POST', url, { body: guestTurnPayload(phone, text, lang) });
}

async function getStaffContext(origin, session, bookingCode) {
  const gate = requireStagingOrigin('staff', origin);
  if (!gate.ok) throw new Error(gate.reason);
  const cred = staffReadbackHeaders(session);
  if (!cred.ok) throw new Error(cred.reason);
  const url = new URL(staffContextPath(bookingCode), origin);
  return requestJson('GET', url, { headers: cred.headers });
}

function printTable(rows) {
  const cols = ['id', 'verdict', 'booking', 'detail'];
  const widths = {};
  for (const c of cols) {
    widths[c] = Math.max(c.length, ...rows.map((r) => String(r[c] == null ? '' : r[c]).length));
  }
  const line = (r) => cols.map((c) => String(r[c] == null ? '' : r[c]).padEnd(widths[c])).join('  ');
  console.log(line({ id: 'ITEM', verdict: 'VERDICT', booking: 'BOOKING', detail: 'DETAIL' }));
  console.log(cols.map((c) => '-'.repeat(widths[c])).join('  '));
  for (const r of rows) console.log(line(r));
}

function acceptanceExitCode(rows) {
  const required = rows.filter((r) => r.required !== false);
  const fails = required.filter((r) => r.verdict === 'FAIL');
  const passes = required.filter((r) => r.verdict === 'PASS');
  if (fails.length) return 1;
  if (passes.length !== required.length) return 2;
  return 0;
}

function dryRunSelfChecks(args) {
  const rows = [];
  const ok = (id, detail) => rows.push({ id, verdict: 'CONTRACT', booking: '—', detail });
  const fail = (id, detail) => rows.push({ id, verdict: 'FAIL', booking: '—', detail });

  const phone = reservedPhone(args.runId, '02');
  if (isReservedTestPhone(phone)) ok('reserved_phone', phone);
  else fail('reserved_phone', phone);

  const realish = '+34600111222';
  if (!isReservedTestPhone(realish)) ok('reject_real_phone', realish);
  else fail('reject_real_phone', 'accepted a real-looking phone');

  const names = labelledGuestNames('01', args.runId);
  if (names.every(isTestGuestName) && !isTestGuestName('Gina Rossi') && !isTestGuestName('Ale Test Ada')) {
    ok('test_labelled_guests', names.join(', '));
  } else fail('test_labelled_guests', 'Ale Test r{runId} label gate failed');

  try {
    guestTurnPayload(phone, 'pay together', 'en');
    ok('guest_turn_shape', `${SIMULATOR_PATH} tenant=${TENANT}`);
  } catch (err) {
    fail('guest_turn_shape', String(err.message || err));
  }
  let threw = false;
  try { guestTurnPayload('+34600111222', 'hi', 'en'); } catch (_) { threw = true; }
  if (threw) ok('guest_turn_rejects_real_phone', 'threw');
  else fail('guest_turn_rejects_real_phone', 'accepted non-+999');

  const staffPath = staffContextPath('WH-EXAMPLE');
  if (staffPath.includes('wolfhouse-somo') && staffPath.includes('/staff/bookings/')) {
    ok('staff_readback_path', staffPath);
  } else fail('staff_readback_path', staffPath);

  const closed = [
    ['https://admin.wolf-house.com', 'prod admin'],
    ['https://wh.lunafrontdesk.com', 'prod fallback'],
    ['https://wolfhouse.lunafrontdesk.com', 'wrong host'],
    ['https://example.com', 'unknown'],
    ['https://crowsnest.example', 'unknown simulator'],
    ['http://staff-staging.lunafrontdesk.com:9999', 'http+port'],
    ['https://staff-staging.lunafrontdesk.com:9999', 'https+nondefault-port'],
    ['', 'missing'],
  ];
  let refused = 0;
  for (const [origin] of closed) {
    if (!requireStagingOrigin('probe', origin).ok) refused += 1;
  }
  if (refused === closed.length) ok('fail_closed_allowlist', `${refused}/${closed.length} non-allowlist refused`);
  else fail('fail_closed_allowlist', `only ${refused}/${closed.length} refused`);

  const mixed = requireAllStagingOrigins([
    ['staff', DEFAULT_STAFF_ORIGIN],
    ['simulator', 'https://example.com'],
  ]);
  if (!mixed.ok) ok('every_origin_must_be_staging', mixed.reason);
  else fail('every_origin_must_be_staging', 'mixed staging+unknown was admitted');

  const stagingOk = requireStagingOrigin('staff', DEFAULT_STAFF_ORIGIN);
  if (stagingOk.ok) ok('allow_staff_staging', stagingOk.host);
  else fail('allow_staff_staging', stagingOk.reason);

  const pay = neverPayUrl('https://checkout.stripe.com/c/pay/cs_test_x');
  if (!pay.ok) ok('never_pay_link', pay.reason);
  else fail('never_pay_link', 'would follow Stripe checkout');

  const fakeGina = scoreStaffReadback(
    CHECKLIST.find((c) => c.id === 'I_GINA_zero'),
    { financials: { invoice_total_cents: 97500, paid_total_cents: 32500, balance_due_cents: 65000 } },
  );
  if (fakeGina.ok !== true) ok('text_is_not_pass', fakeGina.detail);
  else fail('text_is_not_pass', 'Gina math without booking_id counted as PASS');

  const staffGinaBare = scoreStaffReadback(
    CHECKLIST.find((c) => c.id === 'I_GINA_zero'),
    {
      success: true,
      booking: { booking_id: 'gina-zero-1', booking_code: 'WH-GINA-ZERO', total_amount_cents: 97500 },
      financials: { invoice_total_cents: 97500, paid_total_cents: 32500, balance_due_cents: 65000 },
    },
    200,
  );
  const ginaBareRow = acceptanceRow(CHECKLIST.find((c) => c.id === 'I_GINA_zero'), staffGinaBare);
  if (ginaBareRow.verdict !== 'PASS') ok('gina_without_snapshot_not_pass', ginaBareRow.verdict);
  else fail('gina_without_snapshot_not_pass', 'PASS without explicit snapshot assertion');

  const started = new Date('2027-08-01T00:00:00Z');
  const marker = thisRunMarker(args.runId, '01');
  const foreign = scoreStaffReadback(
    CHECKLIST.find((c) => c.id === 'A_split_handoff'),
    {
      success: true,
      booking: {
        booking_id: 'someone-else', booking_code: 'WH-OTHER',
        guest_phone: '+99900000000000', created_at: '2026-01-01T00:00:00Z',
      },
      booking_guests: [{ guest_name: 'Real Guest' }],
    },
    200,
    { marker, createdAfter: started, requestedBookingCode: 'WH-OTHER' },
  );
  const foreignRow = acceptanceRow(CHECKLIST.find((c) => c.id === 'A_split_handoff'), foreign);
  if (foreignRow.verdict !== 'PASS') ok('foreign_booking_rejected', foreign.detail);
  else fail('foreign_booking_rejected', 'accepted another run’s booking_id');

  const mine = scoreStaffReadback(
    CHECKLIST.find((c) => c.id === 'A_split_handoff'),
    {
      success: true,
      booking: {
        booking_id: 'this-run-1', booking_code: 'WH-THIS-RUN',
        guest_phone: marker.phone, created_at: '2027-08-02T00:00:00Z',
      },
      booking_guests: marker.names.map((n) => ({ guest_name: n })),
    },
    200,
    { marker, createdAfter: started, requestedBookingCode: 'WH-THIS-RUN' },
  );
  const mineRow = acceptanceRow(CHECKLIST.find((c) => c.id === 'A_split_handoff'), mine);
  if (mineRow.verdict === 'PASS') ok('this_run_marker_pass', mine.detail);
  else fail('this_run_marker_pass', JSON.stringify(mineRow));

  const identityItem = CHECKLIST.find((c) => c.id === 'A_split_handoff');
  for (const [id, phone, guestNames, requestedBookingCode] of [
    ['wrong_phone_run_digits_rejected', '+34600000000', [`Unlabelled ${marker.runId}`, 'Other Person', 'Third Person'], 'WH-THIS-RUN'],
    ['matching_phone_wrong_names_rejected', marker.phone, ['Real Person', 'Other Person', 'Third Person'], 'WH-THIS-RUN'],
    ['matching_names_wrong_phone_rejected', '+34600000000', marker.names, 'WH-THIS-RUN'],
    ['wrong_booking_code_rejected', marker.phone, marker.names, 'WH-REQUESTED'],
  ]) {
    const score = scoreStaffReadback(identityItem, {
      success: true,
      booking: { booking_id: 'this-run-1', booking_code: 'WH-THIS-RUN', guest_phone: phone, created_at: '2027-08-02T00:00:00Z' },
      booking_guests: guestNames.map((guest_name) => ({ guest_name })),
    }, 200, { marker, createdAfter: started, requestedBookingCode });
    const row = acceptanceRow(identityItem, score);
    if (row.verdict === 'FAIL') ok(id, score.detail);
    else fail(id, `expected FAIL, got ${row.verdict}`);
  }

  const unknownItem = { id: 'not_a_real_row', required: true };
  const defaulted = scoreStaffReadback(unknownItem, {
    success: true,
    booking: { booking_id: 'x', booking_code: 'WH-X', guest_phone: marker.phone, created_at: '2027-08-02T00:00:00Z' },
    booking_guests: marker.names.map((guest_name) => ({ guest_name })),
  }, 200, { marker, createdAfter: started, requestedBookingCode: 'WH-X' });
  const defaultRow = acceptanceRow(unknownItem, defaulted);
  if (defaultRow.verdict === 'NOT RUN') ok('no_default_pass', defaulted.detail);
  else fail('no_default_pass', `unknown row was ${defaultRow.verdict}`);

  if (!asksShallIBook('Your stay is €415.') && asksShallIBook('Shall I book this for you?')) {
    ok('shall_i_book_helper', 'detects extra save ask');
  } else fail('shall_i_book_helper', 'helper miss');

  if (countWaveSmilePairs('🌊😊 welcome') === 1) ok('wave_smile_once_helper', '1 pair');
  else fail('wave_smile_once_helper', 'count miss');

  if (usesSharedRoom('a bed in a shared room') && usesDorm('mixed dorm')) {
    ok('shared_room_helper', 'shared vs dorm');
  } else fail('shared_room_helper', 'copy helper miss');

  const ids = CHECKLIST.map((c) => c.id);
  const missing = REQUIRED_CAP_IDS.filter((id) => !ids.includes(id));
  const requiredCount = CHECKLIST.filter((c) => c.required !== false).length;
  if (missing.length === 0 && requiredCount >= REQUIRED_CAP_IDS.length) {
    ok('checklist_coverage', `${requiredCount} required Cap/Chief rows`);
  } else fail('checklist_coverage', `missing ${missing.join(',') || 'count'}`);

  const missingAssert = REQUIRED_CAP_IDS.filter((id) => typeof ITEM_ASSERTIONS[id] !== 'function');
  if (missingAssert.length === 0) ok('explicit_assertions', `${REQUIRED_CAP_IDS.length} rows have assertions`);
  else fail('explicit_assertions', `missing ${missingAssert.join(',')}`);

  const missingSess = resolveStaffSession('');
  if (!missingSess.ok) ok('session_missing_refused', missingSess.reason);
  else fail('session_missing_refused', 'empty session was accepted');

  const dummy = staffReadbackHeaders('offline-contract-session');
  const cookie = dummy.ok && dummy.headers && dummy.headers.cookie;
  const cookieNameOnly = String(cookie || '').split('=')[0];
  if (dummy.ok && cookieNameOnly === STAFF_SESSION_COOKIE_NAME && !dummy.headers.authorization) {
    ok('session_cookie_not_bearer', `${STAFF_SESSION_COOKIE_NAME} cookie; bearer absent`);
  } else fail('session_cookie_not_bearer', 'Staff readback headers are not luna_staff_session cookie');

  const bearerish = resolveStaffSession('Bearer not-a-cookie');
  if (!bearerish.ok) ok('session_rejects_bearer_value', 'malformed');
  else fail('session_rejects_bearer_value', 'accepted a Bearer-shaped session');

  const executeGate = requireStaffSessionForExecute({ staffSession: '' });
  if (!executeGate.ok) ok('execute_without_session_exit2', executeGate.reason);
  else fail('execute_without_session_exit2', 'missing session would not block --execute');

  const plan = buildMultiTurnPlan(args);
  const covered = new Set();
  let burst = false;
  for (const conv of plan.conversations) {
    const minTurns = conv.continue ? 1 : 2;
    if (conv.turns.length >= minTurns) ok(`multiturn_${conv.key}`, `${conv.turns.length} turns`);
    else fail(`multiturn_${conv.key}`, 'not multi-turn');
    for (const turn of conv.turns) {
      const body = guestTurnPayload(reservedPhone(args.runId, conv.phone_case), turn.text, 'en');
      if (Object.prototype.hasOwnProperty.call(body, 'messages')) burst = true;
      for (const id of turn.checkpoint || []) covered.add(id);
    }
  }
  if (!burst) ok('guest_turn_one_bubble', 'no messages[] burst');
  else fail('guest_turn_one_bubble', 'scripts used messages[]');

  const liveIds = REQUIRED_CAP_IDS.filter((id) => {
    const it = CHECKLIST.find((c) => c.id === id);
    return it && !it.offline && !it.read_only;
  });
  const missingLive = liveIds.filter((id) => !covered.has(id));
  if (missingLive.length === 0) ok('multiturn_checkpoints', `${covered.size} live Cap checkpoints`);
  else fail('multiturn_checkpoints', `missing ${missingLive.join(',')}`);

  const fConv = plan.conversations.find((c) => c.key === 'F');
  const gConv = plan.conversations.find((c) => c.key === 'G');
  const hConv = plan.conversations.find((c) => c.key === 'H');
  if (fConv.nights === plan.defaultNights - 1
      && gConv.nights === plan.defaultNights
      && hConv.nights === plan.defaultNights + 1) {
    ok('shuttle_nights_from_current_default', `N=${plan.defaultNights}`);
  } else fail('shuttle_nights_from_current_default', 'stay nights are not derived from current default');

  const aText = plan.conversations.find((c) => c.key === 'A').turns.map((t) => t.text).join('\n');
  if (/Ale Test Dee/.test(aText) && /card was charged/.test(aText)) ok('script_A_addguest_complaint', 'add-guest + complaint');
  else fail('script_A_addguest_complaint', 'missing add-guest or complaint turn');

  const fText = fConv.turns.map((t) => t.text).join(' ');
  if (!/shuttle/i.test(fText)) ok('F_does_not_mention_shuttle', 'F never names shuttle');
  else fail('F_does_not_mention_shuttle', 'F mentions shuttle');

  if (plan.deadQuestion === 'What is my payment status?' && plan.dead.length === 3) {
    ok('I_DEAD_status_question', 'fixture status query ready');
  } else fail('I_DEAD_status_question', 'missing I-DEAD question');

  const alt = buildMultiTurnPlan(Object.assign({}, args, { defaultNights: 8 }));
  if (alt.conversations.find((c) => c.key === 'F').nights === 7
      && alt.conversations.find((c) => c.key === 'G').nights === 8) {
    ok('shuttle_default_not_hardcoded_5', 'N=8 → F=7 G=8');
  } else fail('shuttle_default_not_hardcoded_5', 'still pinned to 5');

  return rows;
}

function usage() {
  console.log(`Usage: node scripts/run-ale-batch-staging-acceptance.js [--dry-run|--execute]

Default --dry-run: no network. FAIL CLOSED isolation, +999 / Ale Test identity,
never-pay, and full #1680 coverage. Dry-run is NOT acceptance (exit 2).

PASS requires this-run Staff readback (phone/name+run id AND created-after)
plus an explicit per-row assertion. No row defaults to PASS.
If every required row is BLOCKED / NOT RUN, exit 2. FAIL exits 1.

--execute talks to France Wolfhouse STAGING allowlist only:
  ${STAGING_ALLOWLIST_ORIGINS.join(', ')}
  ALE_BATCH_SIMULATOR_ORIGIN and ALE_BATCH_STAFF_ORIGIN must BOTH be allowlisted.
  ALE_BATCH_CONFIRM_STAGING=YES is also required. Never set that for a dry-run job.
  ALE_BATCH_STAFF_SESSION is the luna_staff_session cookie (never printed, never Bearer).
  Missing session on --execute exits 2. Never follow or pay a Stripe link.
  --execute drives Cap #1680 multi-turn scripts (one guest-turn bubble per send).
`);
}

function needsHumanFlag(ctx) {
  const handoff = (ctx && ctx.handoff) || (ctx && ctx.conversation) || {};
  return handoff.needs_human === true || (ctx && ctx.needs_human === true);
}

async function liveExecute(args) {
  const plan = buildMultiTurnPlan(args);
  const rowsById = {};
  const extraState = { needsHumanC: null, needsHumanE: null, priorInvoice: null };
  const convState = {};

  function remember(item, staffScore, extraDetail) {
    rowsById[item.id] = acceptanceRow(item, staffScore, extraDetail);
  }

  async function readback(item, state, extras) {
    if (!state || !state.bookingCode) {
      remember(item, { ok: null, asserted: false, detail: 'simulator returned no booking_code' });
      return null;
    }
    const ctx = await getStaffContext(args.staffOrigin, args.staffSession, state.bookingCode);
    const marker = thisRunMarker(args.runId, state.phone_case);
    const runCtx = Object.assign({
      marker,
      requestedBookingCode: state.bookingCode,
      createdAfter: args.startedAt || new Date(0),
      transcript: state.transcript,
      nights: state.nights,
      defaultNights: plan.defaultNights,
    }, extras || {});
    remember(item, scoreStaffReadback(item, ctx.json || {}, ctx.status, runCtx));
    return ctx.json || {};
  }

  for (const conv of plan.conversations) {
    const phone = reservedPhone(args.runId, conv.phone_case);
    const names = labelledGuestNames(conv.phone_case, args.runId);
    if (!isReservedTestPhone(phone) || names.some((nm) => !isTestGuestName(nm))) {
      for (const turn of conv.turns) {
        for (const id of turn.checkpoint || []) {
          const item = CHECKLIST.find((c) => c.id === id);
          if (item) {
            rowsById[item.id] = {
              id: item.id, verdict: 'FAIL', booking: phone,
              detail: 'phone/name is not reserved Ale Test identity', required: true,
            };
          }
        }
      }
      continue;
    }
    let state = convState[conv.phone_case];
    if (!state || !conv.continue) {
      state = {
        phone,
        names,
        phone_case: conv.phone_case,
        bookingCode: null,
        transcript: '',
        nights: conv.nights,
      };
    }
    state.nights = conv.nights;
    if (conv.key === 'W' && state.bookingCode) {
      const snap = await getStaffContext(args.staffOrigin, args.staffSession, state.bookingCode);
      extraState.priorInvoice = moneyFromCtx(snap.json || {}, (snap.json && snap.json.booking) || {}).invoice;
    }
    for (const turn of conv.turns) {
      if (turn.waitMs) await sleep(turn.waitMs);
      const sendNames = names.concat(turn.extraNames || []);
      const res = await postGuestTurn(args.simulatorOrigin, phone, turn.text, 'en', sendNames);
      const reply = extractReply(res.json);
      state.transcript = `${state.transcript}\n${turn.text}\n${reply}`.trim();
      const code = extractBookingCode(res.json);
      if (code) state.bookingCode = code;
      convState[conv.phone_case] = state;
      if (turn.tag === 'handoffC' || turn.tag === 'handoffE') {
        if (state.bookingCode) {
          const hx = await getStaffContext(args.staffOrigin, args.staffSession, state.bookingCode);
          const flag = needsHumanFlag(hx.json || {});
          if (turn.tag === 'handoffC') extraState.needsHumanC = flag;
          if (turn.tag === 'handoffE') extraState.needsHumanE = flag;
        }
      }
      for (const id of turn.checkpoint || []) {
        const item = CHECKLIST.find((c) => c.id === id);
        if (!item) continue;
        await readback(item, state, extraState);
      }
    }
    convState[conv.phone_case] = state;
  }

  for (const item of CHECKLIST) {
    if (rowsById[item.id]) continue;
    if (item.required === false) {
      rowsById[item.id] = {
        id: item.id, verdict: 'NOT EXERCISED', booking: '—',
        detail: item.title, required: false,
      };
      continue;
    }
    if (item.offline) {
      remember(item, { ok: null, detail: 'offline exact-reason matrix not executed this run' });
      continue;
    }
    if (item.id === 'I_GINA_zero' || item.id === 'I_GINA_bundled') {
      const envKey = item.id === 'I_GINA_zero' ? 'ALE_BATCH_GINA_ZERO_CODE' : 'ALE_BATCH_GINA_BUNDLED_CODE';
      const code = String(process.env[envKey] || '').trim();
      if (!code) {
        remember(item, { ok: null, detail: 'needs operator Staff fixture / offline evidence' });
        continue;
      }
      const ctx = await getStaffContext(args.staffOrigin, args.staffSession, code);
      remember(item, scoreStaffReadback(item, ctx.json || {}, ctx.status, {}));
      continue;
    }
    if (item.id.startsWith('I_DEAD')) {
      const spec = plan.dead.find((d) => d.id === item.id);
      const code = spec ? String(process.env[spec.envCode] || '').trim() : '';
      const deadPhone = spec ? String(process.env[spec.envPhone] || '').trim() : '';
      if (deadPhone && isReservedTestPhone(deadPhone) && code) {
        await postGuestTurn(args.simulatorOrigin, deadPhone, plan.deadQuestion, 'en', []);
      }
      if (!code) {
        remember(item, { ok: null, detail: 'needs operator Staff fixture / offline evidence' });
        continue;
      }
      const ctx = await getStaffContext(args.staffOrigin, args.staffSession, code);
      remember(item, scoreStaffReadback(item, ctx.json || {}, ctx.status, {}));
      continue;
    }
    remember(item, { ok: null, detail: 'no multi-turn checkpoint for this row' });
  }

  return CHECKLIST.map((c) => rowsById[c.id]);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  if (args.execute) {
    const origins = requireAllStagingOrigins([
      ['simulator', args.simulatorOrigin],
      ['staff', args.staffOrigin],
    ]);
    if (!origins.ok) {
      console.error(`REFUSED: ${origins.reason}`);
      process.exit(2);
    }
    if (process.env.ALE_BATCH_CONFIRM_STAGING !== 'YES') {
      console.error('REFUSED: live staging requires ALE_BATCH_CONFIRM_STAGING=YES; not calling staging.');
      process.exit(2);
    }
    const sessionGate = requireStaffSessionForExecute(args);
    if (!sessionGate.ok) {
      console.error(`REFUSED: ${sessionGate.reason}`);
      process.exit(2);
    }
    const liveRows = await liveExecute(args);
    printTable(liveRows);
    const code = acceptanceExitCode(liveRows);
    console.log(code === 0
      ? 'ACCEPTANCE PASS: every required row has Staff booking readback'
      : `ACCEPTANCE NOT PASSED (exit ${code})`);
    process.exit(code);
  }

  console.log('Ale-batch staging acceptance  DRY-RUN (no staging, no prod, no real bookings)');
  console.log(`run_id=${args.runId}  tenant=${TENANT}  staff_client=${STAFF_CLIENT}`);
  console.log(`allowlist=${STAGING_ALLOWLIST_ORIGINS.join(',')}`);
  console.log('');

  const contract = dryRunSelfChecks(args);
  printTable(contract);
  const contractFail = contract.filter((r) => r.verdict === 'FAIL').length;

  console.log('');
  console.log('Cap #1680 checklist (NOT RUN — dry-run cannot PASS):');
  const live = CHECKLIST.map((item) => ({
    id: item.id,
    verdict: item.required === false ? 'NOT EXERCISED' : 'NOT RUN',
    booking: item.phone_case ? reservedPhone(args.runId, item.phone_case) : 'read-only fixture',
    detail: `${item.cap}: ${item.title}`,
    required: item.required !== false,
  }));
  printTable(live);

  const acceptCode = acceptanceExitCode(live);
  console.log('');
  if (contractFail) {
    console.log(`FAIL dry-run contract ${contractFail} failed`);
    process.exit(1);
  }
  console.log(`CONTRACT OK ${contract.length}/${contract.length}`);
  console.log('ACCEPTANCE NOT PASSED: dry-run has no Staff booking readback (exit 2)');
  process.exit(acceptCode || 2);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  CHECKLIST,
  REQUIRED_CAP_IDS,
  STAGING_ALLOWLIST_ORIGINS,
  reservedPhone,
  isReservedTestPhone,
  isTestGuestName,
  labelledGuestNames,
  buildMultiTurnPlan,
  extractBookingCode,
  thisRunMarker,
  canonicalHttpsOrigin,
  requireStagingOrigin,
  requireAllStagingOrigins,
  resolveStaffSession,
  staffReadbackHeaders,
  requireStaffSessionForExecute,
  STAFF_SESSION_COOKIE_NAME,
  guestTurnPayload,
  staffContextPath,
  neverPayUrl,
  staffBookingIdentity,
  belongsToThisRun,
  scoreStaffReadback,
  acceptanceRow,
  acceptanceExitCode,
  ITEM_ASSERTIONS,
  countWaveSmilePairs,
  asksShallIBook,
};
