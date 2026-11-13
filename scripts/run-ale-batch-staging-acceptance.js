#!/usr/bin/env node
'use strict';

/**
 * Ale-batch France Wolfhouse STAGING acceptance runner.
 *
 * Drives Cap #1680 (`scripts/verify-ale-batch-staging.md` @ 28f5b27e) through
 * the existing Live Simulator guest-turn path, then independently reads the
 * saved booking back from Staff. Reserved +999 test phones only.
 *
 *   node scripts/run-ale-batch-staging-acceptance.js --dry-run
 *   node scripts/run-ale-batch-staging-acceptance.js --execute   # staging only
 *
 * Default is --dry-run (no network). --execute is refused against prod hosts.
 *
 * Simulator (same as Crow's Nest / Cap §1):
 *   POST {simulator}/api/live-simulator/guest-turn
 *   { tenant: "wolfhouse", from_phone, text, lang: "en" }
 *
 * Staff readback (Cap §2 R):
 *   GET {staff}/staff/bookings/{code}/context?client=wolfhouse-somo
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const SIMULATOR_PATH = '/api/live-simulator/guest-turn';
const TENANT = 'wolfhouse';
const STAFF_CLIENT = 'wolfhouse-somo';
const DEFAULT_STAFF_ORIGIN = 'https://staff-staging.lunafrontdesk.com';
const STAGING_HOSTS = Object.freeze([
  'staff-staging.lunafrontdesk.com',
  '178.33.91.59',
]);
const PROD_HOST_RE = [
  /(^|\.)admin\.wolf-house\.com$/i,
  /(^|\.)wh\.lunafrontdesk\.com$/i,
  /(^|\.)wolfhouse\.lunafrontdesk\.com$/i,
  /(^|\.)staff\.lunafrontdesk\.com$/i,
  /wolfhouse-prod/i,
  /(^|\.)lunafrontdesk\.com$/i,
];
const STAGING_LUNAFRONTEDGE_RE = /staff-staging\.lunafrontdesk\.com$/i;

const CHECKLIST = Object.freeze([
  {
    id: 'price_before_save',
    cap: 'B / quote',
    title: 'Price shown before save',
    phone_case: '02',
  },
  {
    id: 'no_shall_i_book',
    cap: '§4',
    title: 'Never asks “shall I book” after a clear choice to book',
    phone_case: '02',
  },
  {
    id: 'deposit_or_full_no_early_link',
    cap: 'B',
    title: 'Deposit-or-full asked; no guessed early pay link',
    phone_case: '02',
  },
  {
    id: 'full_stays_full',
    cap: 'B',
    title: 'Full stays full (saved link amount matches full)',
    phone_case: '02',
  },
  {
    id: 'add_guest_always_saves',
    cap: 'A / save',
    title: 'Add-guest / agreed save always inserts a booking',
    phone_case: '01',
  },
  {
    id: 'gina_975_650',
    cap: 'I-GINA',
    title: 'Gina original fixtures €975 total / €650 balance',
    phone_case: null,
    read_only: true,
  },
  {
    id: 'per_day_service_50',
    cap: 'D-S',
    title: 'Per-day Staff Service €50 (5000 cents / 5 nights)',
    phone_case: '04',
  },
  {
    id: 'shuttle_default_nights',
    cap: 'F/G/H',
    title: 'Shuttle only at package default nights or more',
    phone_case: '06',
  },
  {
    id: 'wave_smile_once',
    cap: 'voice',
    title: 'One 🌊😊 pair max per chat',
    phone_case: '01',
  },
  {
    id: 'warm_note_before_needs_human',
    cap: 'A',
    title: 'Warm note before Needs human',
    phone_case: '01',
  },
  {
    id: 'shared_room_not_dorm',
    cap: 'guest copy',
    title: '“shared room”, not “dorm”',
    phone_case: '01',
  },
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
  return digits.length === 15 && digits.startsWith('999');
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

function isStagingHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (STAGING_HOSTS.includes(h)) return true;
  if (STAGING_LUNAFRONTEDGE_RE.test(h)) return true;
  return false;
}

function isProdHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  if (isStagingHost(h)) return false;
  return PROD_HOST_RE.some((re) => re.test(h));
}

function refuseProdOrigin(label, origin) {
  const host = hostnameOf(origin);
  if (!host) {
    return { ok: false, reason: `${label} origin missing` };
  }
  if (isProdHost(host) || /prod/i.test(String(origin))) {
    return { ok: false, reason: `${label} refuses prod host ${host}` };
  }
  if (String(origin).toLowerCase().includes('wolfhouse-prod')) {
    return { ok: false, reason: `${label} refuses wolfhouse-prod tenant/origin` };
  }
  return { ok: true, host };
}

function guestTurnPayload(phone, text, lang) {
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

function countWaveSmilePairs(text) {
  const s = String(text || '');
  const re = /🌊\s*😊|😊\s*🌊/g;
  return (s.match(re) || []).length;
}

function asksShallIBook(text) {
  return /\bshall i (book|save|reserve)\b|\b(guardo|save) (esta |la )?reserva\??/i.test(String(text || ''));
}

function asksDepositOrFull(text) {
  return /\bdeposit\b/i.test(text) && /\bfull\b/i.test(text);
}

function usesDorm(text) {
  return /\bdorm(?:itory)?\b/i.test(String(text || ''));
}

function usesSharedRoom(text) {
  return /\bshared room\b/i.test(String(text || ''));
}

function extractEuroCents(text) {
  const m = String(text || '').match(/€\s*([0-9]+(?:[.,][0-9]{2})?)/);
  if (!m) return null;
  const n = Number(String(m[1]).replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function scoreTranscript(item, turns) {
  const blob = (turns || []).map((t) => String(t && (t.text || t.reply || t) || '')).join('\n');
  switch (item.id) {
    case 'price_before_save':
      return extractEuroCents(blob) != null
        ? { ok: true, detail: 'quoted amount present before save' }
        : { ok: false, detail: 'no € amount in guest-visible turns' };
    case 'no_shall_i_book':
      return asksShallIBook(blob)
        ? { ok: false, detail: 'asked shall-I-book after consent' }
        : { ok: true, detail: 'no extra save-consent gate' };
    case 'deposit_or_full_no_early_link':
      return asksDepositOrFull(blob)
        ? { ok: true, detail: 'asked deposit or full' }
        : { ok: false, detail: 'did not ask deposit or full' };
    case 'wave_smile_once': {
      const n = countWaveSmilePairs(blob);
      return n <= 1
        ? { ok: true, detail: `${n} wave+smile pair(s)` }
        : { ok: false, detail: `${n} wave+smile pairs` };
    }
    case 'shared_room_not_dorm':
      if (usesDorm(blob)) return { ok: false, detail: 'used dorm' };
      if (usesSharedRoom(blob)) return { ok: true, detail: 'shared room' };
      return { ok: true, detail: 'no dorm wording' };
    case 'warm_note_before_needs_human':
      return { ok: null, detail: 'needs live transcript ordering vs handoff' };
    default:
      return { ok: null, detail: 'needs Staff readback' };
  }
}

function scoreStaffReadback(item, ctx) {
  const booking = (ctx && ctx.booking) || {};
  const financials = (ctx && ctx.financials) || {};
  const invoice = Number(financials.invoice_total_cents != null
    ? financials.invoice_total_cents : booking.total_amount_cents);
  const paid = Number(financials.paid_total_cents != null
    ? financials.paid_total_cents : booking.amount_paid_cents);
  const balance = Number(financials.balance_due_cents != null
    ? financials.balance_due_cents : booking.balance_due_cents);
  const payments = ((ctx && ctx.payments && ctx.payments.rows) || []).slice();

  switch (item.id) {
    case 'add_guest_always_saves':
      return booking.booking_id || booking.id
        ? { ok: true, detail: `booking_id ${booking.booking_id || booking.id}` }
        : { ok: false, detail: 'no booking_id on Staff readback' };
    case 'full_stays_full': {
      const active = payments.find((row) => {
        const st = String(row.payment_status || row.status || '').toLowerCase();
        return st === 'checkout_created' || st === 'waiting_payment' || st === 'payment_link_sent';
      });
      const due = Number(active && active.amount_due_cents);
      const total = Number(booking.total_amount_cents);
      if (!active) return { ok: false, detail: 'no active checkout row' };
      if (total && due === total) return { ok: true, detail: `link ${due} matches total` };
      return { ok: false, detail: `link ${due} vs total ${total}` };
    }
    case 'deposit_or_full_no_early_link': {
      const active = payments.filter((row) => {
        const st = String(row.payment_status || '').toLowerCase();
        return st === 'checkout_created' || !!(row.checkout_url && st !== 'draft');
      });
      return active.length === 0
        ? { ok: true, detail: 'no early checkout' }
        : { ok: false, detail: `${active.length} early checkout row(s)` };
    }
    case 'gina_975_650':
      if (invoice === 97500 && balance === 65000 && paid === 32500) {
        return { ok: true, detail: '€975 / paid €325 / balance €650' };
      }
      return { ok: false, detail: `T=${invoice} P=${paid} B=${balance}` };
    case 'per_day_service_50': {
      const svcs = (ctx && ctx.service_records) || [];
      const hit = svcs.find((row) => Number(row.amount_due_cents) === 5000);
      return hit
        ? { ok: true, detail: 'service 5000 cents (€50)' }
        : { ok: false, detail: 'no 5000-cent per-day service row' };
    }
    default:
      return { ok: null, detail: 'not a money/readback row' };
  }
}

function requestJson(method, url, { body, headers, timeoutMs } = {}) {
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
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (_) { json = null; }
        resolve({ status: res.statusCode, json, raw });
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

async function postGuestTurn(origin, phone, text, lang) {
  const url = new URL(SIMULATOR_PATH, origin);
  return requestJson('POST', url, { body: guestTurnPayload(phone, text, lang) });
}

async function getStaffContext(origin, token, bookingCode) {
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

function dryRunSelfChecks(args) {
  const rows = [];
  const fail = (id, detail) => rows.push({ id, verdict: 'FAIL', booking: '—', detail });
  const pass = (id, detail) => rows.push({ id, verdict: 'PASS', booking: '—', detail });

  const phone = reservedPhone(args.runId, '02');
  if (isReservedTestPhone(phone) && phone === `+999${String(args.runId).replace(/\D/g, '').padStart(10, '0').slice(-10)}02`) {
    pass('reserved_phone', phone);
  } else {
    fail('reserved_phone', phone);
  }

  const payload = guestTurnPayload(phone, 'pay together', 'en');
  if (payload.tenant === 'wolfhouse' && payload.from_phone === phone && payload.lang === 'en' && !('messages' in payload) && payload.allow_writes !== true) {
    pass('guest_turn_shape', `${SIMULATOR_PATH} tenant=${payload.tenant}`);
  } else {
    fail('guest_turn_shape', JSON.stringify(payload));
  }

  const staffPath = staffContextPath('WH-EXAMPLE');
  if (staffPath.includes('wolfhouse-somo') && staffPath.includes('/staff/bookings/')) {
    pass('staff_readback_path', staffPath);
  } else {
    fail('staff_readback_path', staffPath);
  }

  const prodHits = [
    'https://admin.wolf-house.com',
    'https://wh.lunafrontdesk.com',
    'https://wolfhouse.lunafrontdesk.com',
    'https://example.com/?tenant=wolfhouse-prod',
  ];
  let refused = 0;
  for (const origin of prodHits) {
    const r = refuseProdOrigin('staff', origin);
    if (!r.ok) refused += 1;
  }
  if (refused === prodHits.length) pass('refuse_prod', `${refused}/${prodHits.length} prod origins refused`);
  else fail('refuse_prod', `only ${refused}/${prodHits.length} refused`);

  const stagingOk = refuseProdOrigin('staff', DEFAULT_STAFF_ORIGIN);
  if (stagingOk.ok && stagingOk.host === 'staff-staging.lunafrontdesk.com') {
    pass('allow_staff_staging', stagingOk.host);
  } else {
    fail('allow_staff_staging', JSON.stringify(stagingOk));
  }

  const gina = scoreStaffReadback(
    CHECKLIST.find((c) => c.id === 'gina_975_650'),
    { financials: { invoice_total_cents: 97500, paid_total_cents: 32500, balance_due_cents: 65000 } },
  );
  if (gina.ok) pass('gina_fixture_math', gina.detail);
  else fail('gina_fixture_math', gina.detail);

  const service = scoreStaffReadback(
    CHECKLIST.find((c) => c.id === 'per_day_service_50'),
    { service_records: [{ amount_due_cents: 5000, quantity: 1 }] },
  );
  if (service.ok) pass('per_day_50_math', service.detail);
  else fail('per_day_50_math', service.detail);

  const noBook = scoreTranscript(
    CHECKLIST.find((c) => c.id === 'no_shall_i_book'),
    [{ text: 'Your stay is €415. I can save it.' }],
  );
  if (noBook.ok) pass('no_shall_i_book_helper', noBook.detail);
  else fail('no_shall_i_book_helper', noBook.detail);

  const extraGate = scoreTranscript(
    CHECKLIST.find((c) => c.id === 'no_shall_i_book'),
    [{ text: 'Shall I book this for you?' }],
  );
  if (extraGate.ok === false) pass('shall_i_book_detected', extraGate.detail);
  else fail('shall_i_book_detected', 'helper missed extra save ask');

  const wave = scoreTranscript(
    CHECKLIST.find((c) => c.id === 'wave_smile_once'),
    [{ text: '🌊😊 welcome' }, { text: 'see you at the beach 🏄' }],
  );
  if (wave.ok) pass('wave_smile_once_helper', wave.detail);
  else fail('wave_smile_once_helper', wave.detail);

  const dorm = scoreTranscript(
    CHECKLIST.find((c) => c.id === 'shared_room_not_dorm'),
    [{ text: 'a bed in a shared room' }],
  );
  if (dorm.ok) pass('shared_room_helper', dorm.detail);
  else fail('shared_room_helper', dorm.detail);

  const dormFail = scoreTranscript(
    CHECKLIST.find((c) => c.id === 'shared_room_not_dorm'),
    [{ text: 'mixed dorm' }],
  );
  if (dormFail.ok === false) pass('dorm_detected', dormFail.detail);
  else fail('dorm_detected', 'helper missed dorm');

  const ids = CHECKLIST.map((c) => c.id);
  const required = [
    'price_before_save', 'no_shall_i_book', 'deposit_or_full_no_early_link',
    'full_stays_full', 'add_guest_always_saves', 'gina_975_650',
    'per_day_service_50', 'shuttle_default_nights', 'wave_smile_once',
    'warm_note_before_needs_human', 'shared_room_not_dorm',
  ];
  const missing = required.filter((id) => !ids.includes(id));
  if (missing.length === 0) pass('checklist_coverage', `${required.length} Chief items`);
  else fail('checklist_coverage', `missing ${missing.join(',')}`);

  return rows;
}

function usage() {
  console.log(`Usage: node scripts/run-ale-batch-staging-acceptance.js [--dry-run|--execute]

Default --dry-run: no network. Validates phones, prod refusal, guest-turn
shape, Staff readback path, and checklist coverage.

--execute talks to France Wolfhouse STAGING only:
  ALE_BATCH_SIMULATOR_ORIGIN   Crow's Nest / live-simulator origin
  ALE_BATCH_STAFF_ORIGIN       default ${DEFAULT_STAFF_ORIGIN}
  ALE_BATCH_STAFF_TOKEN        Staff bearer (never printed)
  ALE_BATCH_RUN_ID             10-digit run id for +999 phones

Refuses prod hosts (admin.wolf-house.com, wh.lunafrontdesk.com, …).
Tenant is always wolfhouse (never wolfhouse-prod). Reserved +999 phones only.
`);
}

async function liveExecute(args) {
  const rows = [];
  for (const item of CHECKLIST) {
    const phone = item.phone_case ? reservedPhone(args.runId, item.phone_case) : null;
    if (!isReservedTestPhone(phone) && phone) {
      rows.push({
        id: item.id, verdict: 'FAIL', booking: phone || '—',
        detail: 'phone is not reserved +999 test identity',
      });
      continue;
    }
    if (item.read_only) {
      rows.push({
        id: item.id, verdict: 'BLOCKED', booking: 'read-only fixture',
        detail: 'Gina/dead-link fixtures need operator-identified staging IDs',
      });
      continue;
    }
    const text = {
      price_before_save: 'Hi, two people, shared room, what is the price for a five-night stay?',
      no_shall_i_book: 'Please save that booking for us.',
      deposit_or_full_no_early_link: 'Pay together.',
      full_stays_full: 'Full ammount.',
      add_guest_always_saves: 'Ada and Bea are women and want the women-only shared room. Cal will take a mixed shared-room bed. Please book it.',
      per_day_service_50: 'Please add one bike desk service for the whole five-night stay.',
      shuttle_default_nights: 'We want the package for those dates.',
      wave_smile_once: 'Hi!',
      warm_note_before_needs_human: 'My card was charged but I got nothing. Please ask your team to help me with the payment.',
      shared_room_not_dorm: 'A bed in a shared room please, not a private.',
    }[item.id] || 'Hello';
    const res = await postGuestTurn(args.simulatorOrigin, phone, text, 'en');
    const reply = (res.json && (res.json.reply || res.json.final_response || res.json.text)) || res.raw || '';
    const scored = scoreTranscript(item, [{ text: reply }]);
    const bookingCode = res.json && (res.json.booking_code || (res.json.booking && res.json.booking.booking_code));
    let staffScore = { ok: null, detail: 'no booking_code yet' };
    if (bookingCode) {
      const ctx = await getStaffContext(args.staffOrigin, args.staffToken, bookingCode);
      staffScore = scoreStaffReadback(item, ctx.json || {});
    }
    const ok = scored.ok === true || staffScore.ok === true;
    const fail = scored.ok === false || staffScore.ok === false;
    rows.push({
      id: item.id,
      verdict: fail ? 'FAIL' : (ok ? 'PASS' : 'BLOCKED'),
      booking: bookingCode || phone,
      detail: [scored.detail, staffScore.detail].filter(Boolean).join('; '),
    });
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
    const sim = refuseProdOrigin('simulator', args.simulatorOrigin);
    const staff = refuseProdOrigin('staff', args.staffOrigin);
    if (!sim.ok || !staff.ok) {
      console.error(`REFUSED: ${(sim.reason || staff.reason)}`);
      process.exit(2);
    }
    if (!isStagingHost(staff.host) && !isStagingHost(sim.host)) {
      console.error(`REFUSED: neither origin is a known Wolfhouse staging host (${sim.host}, ${staff.host})`);
      process.exit(2);
    }
    if (process.env.ALE_BATCH_CONFIRM_STAGING !== 'YES') {
      console.error('REFUSED: live staging requires ALE_BATCH_CONFIRM_STAGING=YES; not calling staging.');
      process.exit(2);
    }
    const liveRows = await liveExecute(args);
    printTable(liveRows);
    const bad = liveRows.filter((r) => r.verdict === 'FAIL').length;
    process.exit(bad === 0 ? 0 : 1);
  }

  console.log('Ale-batch staging acceptance  DRY-RUN (no staging, no prod, no real bookings)');
  console.log(`run_id=${args.runId}  tenant=${TENANT}  staff_client=${STAFF_CLIENT}`);
  console.log('');

  const contract = dryRunSelfChecks(args);
  printTable(contract);
  const contractFail = contract.filter((r) => r.verdict === 'FAIL').length;

  console.log('');
  console.log('Cap #1680 items (live NOT RUN — dry-run only):');
  const live = CHECKLIST.map((item) => ({
    id: item.id,
    verdict: 'NOT RUN',
    booking: item.phone_case ? reservedPhone(args.runId, item.phone_case) : 'read-only fixture',
    detail: `${item.cap}: ${item.title}`,
  }));
  printTable(live);

  const failed = contractFail;
  console.log('');
  console.log(failed === 0
    ? `PASS dry-run contract ${contract.length}/${contract.length}`
    : `FAIL dry-run contract ${contractFail} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  CHECKLIST,
  reservedPhone,
  isReservedTestPhone,
  isProdHost,
  isStagingHost,
  refuseProdOrigin,
  guestTurnPayload,
  staffContextPath,
  countWaveSmilePairs,
  asksShallIBook,
  scoreTranscript,
  scoreStaffReadback,
};
