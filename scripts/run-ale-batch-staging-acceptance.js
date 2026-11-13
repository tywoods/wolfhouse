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
 * Isolation is FAIL CLOSED: every origin must be on STAGING_ALLOWLIST.
 * Unknown hosts are refused. Prod is refused. Never pay a link.
 *
 * Simulator: POST {origin}/api/live-simulator/guest-turn
 *   { tenant: "wolfhouse", from_phone, text, lang: "en" }
 * Staff: GET {origin}/staff/bookings/{code}/context?client=wolfhouse-somo
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const SIMULATOR_PATH = '/api/live-simulator/guest-turn';
const TENANT = 'wolfhouse';
const STAFF_CLIENT = 'wolfhouse-somo';
const DEFAULT_STAFF_ORIGIN = 'https://staff-staging.lunafrontdesk.com';
const STAGING_ALLOWLIST = Object.freeze([
  'staff-staging.lunafrontdesk.com',
  '178.33.91.59',
]);
const TEST_NAME_RE = /^Ale Test [A-Z][a-z]+$/;
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
    staffToken: process.env.ALE_BATCH_STAFF_TOKEN || '',
    help: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') { out.dryRun = true; out.execute = false; }
    else if (a === '--execute') { out.execute = true; out.dryRun = false; }
    else if (a === '--run-id') out.runId = argv[++i];
    else if (a === '--simulator-origin') out.simulatorOrigin = argv[++i];
    else if (a === '--staff-origin') out.staffOrigin = argv[++i];
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

function hostnameOf(origin) {
  if (!origin) return '';
  try {
    const u = new URL(origin.includes('://') ? origin : `https://${origin}`);
    return String(u.hostname || '').toLowerCase();
  } catch (_) {
    return String(origin).replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  }
}

function isAllowlistedStagingHost(host) {
  const h = String(host || '').toLowerCase();
  return STAGING_ALLOWLIST.includes(h);
}

function requireStagingOrigin(label, origin) {
  const raw = String(origin || '').trim();
  if (!raw) return { ok: false, reason: `${label} origin missing` };
  if (/prod/i.test(raw) || raw.toLowerCase().includes('wolfhouse-prod')) {
    return { ok: false, reason: `${label} refuses prod token in origin` };
  }
  const host = hostnameOf(raw);
  if (!host) return { ok: false, reason: `${label} origin missing host` };
  if (!isAllowlistedStagingHost(host)) {
    return { ok: false, reason: `${label} not on staging allowlist: ${host}` };
  }
  return { ok: true, host };
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

function scoreStaffReadback(item, ctx, httpStatus) {
  const ident = staffBookingIdentity(ctx, httpStatus);
  if (!ident.ok) return ident;
  const booking = ident.booking;
  const financials = (ctx && ctx.financials) || {};
  const invoice = Number(financials.invoice_total_cents != null
    ? financials.invoice_total_cents : booking.total_amount_cents);
  const paid = Number(financials.paid_total_cents != null
    ? financials.paid_total_cents : booking.amount_paid_cents);
  const balance = Number(financials.balance_due_cents != null
    ? financials.balance_due_cents : booking.balance_due_cents);
  const payments = ((ctx && ctx.payments && ctx.payments.rows) || []).slice();

  const money = { invoice, paid, balance, booking_id: ident.booking_id, booking_code: ident.booking_code };

  switch (item.id) {
    case 'I_GINA_zero':
    case 'I_GINA_bundled':
    case 'gina_975_650':
      if (invoice === 97500 && balance === 65000 && paid === 32500) {
        return { ok: true, detail: '€975 / paid €325 / balance €650', ...money };
      }
      return { ok: false, detail: `T=${invoice} P=${paid} B=${balance}`, ...money };
    case 'DS_per_day_50':
    case 'per_day_service_50': {
      const svcs = (ctx && ctx.service_records) || [];
      const hit = svcs.find((row) => Number(row.amount_due_cents) === 5000);
      return hit
        ? { ok: true, detail: 'service 5000 cents (€50)', ...money }
        : { ok: false, detail: 'no 5000-cent per-day service row', ...money };
    }
    case 'full_stays_full':
    case 'B_draft_200_to_415': {
      const active = payments.find((row) => {
        const st = String(row.payment_status || row.status || '').toLowerCase();
        return st === 'checkout_created' || st === 'waiting_payment' || st === 'payment_link_sent';
      });
      const due = Number(active && active.amount_due_cents);
      const total = Number(booking.total_amount_cents);
      if (!active) return { ok: false, detail: 'no active checkout row', ...money };
      if (total && due === total) return { ok: true, detail: `link ${due} matches total`, ...money };
      return { ok: false, detail: `link ${due} vs total ${total}`, ...money };
    }
    case 'add_guest_always_saves':
    case 'A_split_handoff':
      return { ok: true, detail: `saved ${ident.booking_code}`, ...money };
    default:
      return { ok: true, detail: `Staff readback ${ident.booking_code}`, ...money };
  }
}

function acceptanceRow(item, staffScore, extraDetail) {
  const booking = staffScore && (staffScore.booking_code
    ? `${staffScore.booking_code}/${staffScore.booking_id || ''}`
    : '—');
  if (!staffScore || staffScore.ok !== true || !staffScore.booking_id || !staffScore.booking_code) {
    const detail = (staffScore && staffScore.detail) || 'no Staff booking readback';
    return {
      id: item.id,
      verdict: staffScore && staffScore.ok === false ? 'FAIL' : 'BLOCKED',
      booking: booking || '—',
      detail: extraDetail ? `${detail}; ${extraDetail}` : detail,
      required: item.required !== false,
    };
  }
  return {
    id: item.id,
    verdict: 'PASS',
    booking,
    detail: extraDetail ? `${staffScore.detail}; ${extraDetail}` : staffScore.detail,
    required: item.required !== false,
  };
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

async function getStaffContext(origin, token, bookingCode) {
  const gate = requireStagingOrigin('staff', origin);
  if (!gate.ok) throw new Error(gate.reason);
  const url = new URL(staffContextPath(bookingCode), origin);
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return requestJson('GET', url, { headers });
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

  const names = TEST_GUESTS['01'];
  if (names.every(isTestGuestName) && !isTestGuestName('Gina Rossi')) {
    ok('test_labelled_guests', names.join(', '));
  } else fail('test_labelled_guests', 'Ale Test label gate failed');

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

  const staffGina = scoreStaffReadback(
    CHECKLIST.find((c) => c.id === 'I_GINA_zero'),
    {
      success: true,
      booking: { booking_id: 'gina-zero-1', booking_code: 'WH-GINA-ZERO', total_amount_cents: 97500 },
      financials: { invoice_total_cents: 97500, paid_total_cents: 32500, balance_due_cents: 65000 },
    },
    200,
  );
  const ginaRow = acceptanceRow(CHECKLIST.find((c) => c.id === 'I_GINA_zero'), staffGina);
  if (ginaRow.verdict === 'PASS' && staffGina.booking_id) ok('gina_staff_pass_needs_id', ginaRow.detail);
  else fail('gina_staff_pass_needs_id', JSON.stringify(ginaRow));

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

  return rows;
}

function usage() {
  console.log(`Usage: node scripts/run-ale-batch-staging-acceptance.js [--dry-run|--execute]

Default --dry-run: no network. FAIL CLOSED isolation, +999 / Ale Test identity,
never-pay, and full #1680 coverage. Dry-run is NOT acceptance (exit 2).

PASS requires independent Staff readback of a real saved booking_id/code.
If every required row is BLOCKED / NOT RUN, exit 2. FAIL exits 1.

--execute talks to France Wolfhouse STAGING allowlist only:
  ${STAGING_ALLOWLIST.join(', ')}
  ALE_BATCH_SIMULATOR_ORIGIN and ALE_BATCH_STAFF_ORIGIN must BOTH be allowlisted.
  ALE_BATCH_CONFIRM_STAGING=YES is also required. Never set that for a dry-run job.
  ALE_BATCH_STAFF_TOKEN is never printed. Never follow or pay a Stripe link.
`);
}

async function liveExecute(args) {
  const rows = [];
  for (const item of CHECKLIST) {
    if (item.required === false) {
      rows.push({
        id: item.id, verdict: 'NOT EXERCISED', booking: '—',
        detail: item.title, required: false,
      });
      continue;
    }
    const phone = item.phone_case ? reservedPhone(args.runId, item.phone_case) : null;
    const names = item.phone_case ? (TEST_GUESTS[item.phone_case] || []) : [];
    if (phone && !isReservedTestPhone(phone)) {
      rows.push({
        id: item.id, verdict: 'FAIL', booking: phone,
        detail: 'phone is not reserved +999 test identity', required: true,
      });
      continue;
    }
    if (names.some((n) => !isTestGuestName(n))) {
      rows.push({
        id: item.id, verdict: 'FAIL', booking: phone || '—',
        detail: 'guest names are not Ale Test labelled', required: true,
      });
      continue;
    }
    if (item.offline || item.read_only || !phone) {
      rows.push(acceptanceRow(item, { ok: null, detail: 'needs operator Staff fixture / offline evidence' }));
      continue;
    }
    const text = `${names.join(', ')} — reserved test booking, do not charge. ${item.title}`;
    const res = await postGuestTurn(args.simulatorOrigin, phone, text, 'en', names);
    const bookingCode = res.json && (res.json.booking_code || (res.json.booking && res.json.booking.booking_code));
    if (!bookingCode) {
      rows.push(acceptanceRow(item, { ok: null, detail: 'simulator returned no booking_code' }));
      continue;
    }
    const ctx = await getStaffContext(args.staffOrigin, args.staffToken, bookingCode);
    const staffScore = scoreStaffReadback(item, ctx.json || {}, ctx.status);
    rows.push(acceptanceRow(item, staffScore));
  }
  return rows;
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
  console.log(`allowlist=${STAGING_ALLOWLIST.join(',')}`);
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
  STAGING_ALLOWLIST,
  reservedPhone,
  isReservedTestPhone,
  isTestGuestName,
  isAllowlistedStagingHost,
  requireStagingOrigin,
  requireAllStagingOrigins,
  guestTurnPayload,
  staffContextPath,
  neverPayUrl,
  staffBookingIdentity,
  scoreStaffReadback,
  acceptanceRow,
  acceptanceExitCode,
  countWaveSmilePairs,
  asksShallIBook,
};
