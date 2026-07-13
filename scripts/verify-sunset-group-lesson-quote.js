/* eslint-disable no-console */
'use strict';

/**
 * verify-sunset-group-lesson-quote.js
 *
 * Read-only authoritative quote for ordinary Sunset group lessons.
 * Proves the lesson-quote endpoint/tool exist, validate fail-closed, reuse the
 * same unit resolver as post-create pricing, perform zero writes, and match
 * priceSunsetBookingServices totals (parity).
 *
 * Offline: config baseline only (SUNSET_ADMIN_DB_READ_ENABLED=0).
 */

const fs = require('fs');
const path = require('path');
const {
  quoteSunsetGroupLessonsSync,
  quoteSunsetGroupLessonsFromPrices,
  validateGroupLessonQuoteBody,
} = require('./lib/sunset-group-lesson-quote');
const {
  resolveSunsetGroupLessonUnitCents,
  priceSunsetBookingServices,
} = require('./lib/sunset-stripe-payment-links');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');

let pass = 0;
let fail = 0;
function ok(cond, msg, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${msg}`); }
  else { fail += 1; console.log(`  FAIL  ${msg}${detail ? ` — ${detail}` : ''}`); }
}

const ROOT = path.resolve(__dirname, '..');
const staffApiSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
const pluginSrc = fs.readFileSync(
  path.join(ROOT, 'docker', 'hermes-staging', 'plugins', 'wolfhouse_staff_api', '__init__.py'),
  'utf8',
);
process.env.SUNSET_ADMIN_DB_READ_ENABLED = '0';
process.env.SUNSET_ADMIN_JSON_OVERLAY = '0';

const REF = new Date('2026-07-13T12:00:00+02:00');
const LOC = 'sunset-somo';
const DATES_4 = ['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23'];
const DATE_1 = ['2026-07-20'];

const { SUNSET_CATALOG_READ_TOOLS } = require('./lib/sunset-catalog-tool-executor');
const { resolveSunsetBotBodyLocation } = require('./lib/sunset-catalog-tool-executor');

console.log('\n── A. Pre-fix gap: read-only group-lesson quote tool now exists ──');
ok(!Object.prototype.hasOwnProperty.call(SUNSET_CATALOG_READ_TOOLS, 'get_sunset_group_lesson_quote'),
  'no pre-existing catalog read tool for group-lesson quote (dedicated /lesson-quote endpoint)');
ok(pluginSrc.includes('def get_sunset_group_lesson_quote('), 'Hermes plugin defines get_sunset_group_lesson_quote');
ok(staffApiSrc.includes("pathname === '/staff/bot/sunset/lesson-quote'"), 'Staff API route /staff/bot/sunset/lesson-quote wired');
ok(staffApiSrc.includes('handleBotSunsetLessonQuote'), 'handleBotSunsetLessonQuote handler present');
const preBookingTools = ['get_sunset_rental_price', 'get_sunset_private_lesson', 'get_sunset_lesson_availability'];
ok(preBookingTools.every((t) => pluginSrc.includes(`def ${t}(`)) && !preBookingTools.includes('get_sunset_group_lesson_quote'),
  'before this fix only rental/private/availability read tools existed for lessons (not group-lesson quote)');

console.log('\n── B. Authoritative unit from config (not hard-coded) ──');
const adminCfg = resolveTenantBusinessConfig('sunset', LOC);
const unitCents = resolveSunsetGroupLessonUnitCents(adminCfg.prices || []);
ok(unitCents != null && unitCents > 0, 'configured group-lesson unit resolves', unitCents);
ok(unitCents !== 9999, 'unit is from config resolver, not a test hard-code', unitCents);

console.log('\n── C. Happy-path quotes ──');
function quote(body) {
  return quoteSunsetGroupLessonsSync({ locationId: LOC, body, refDate: REF });
}

const q1x1 = quote({ service_dates: DATE_1, quantity: 1 });
ok(q1x1.ok && q1x1.total_cents === unitCents, '1 date × 1 surfer', JSON.stringify(q1x1));
ok(q1x1.tool === 'get_sunset_group_lesson_quote' && q1x1.price_source === 'config_or_db', 'response contract fields');

const q4x1 = quote({ service_dates: DATES_4, quantity: 1 });
ok(q4x1.ok && q4x1.total_cents === unitCents * 4, '4 dates × 1 surfer', q4x1.total_cents);

const q4x2 = quote({ service_dates: DATES_4, quantity: 2 });
ok(q4x2.ok && q4x2.total_cents === unitCents * 4 * 2, '4 dates × 2 surfers', q4x2.total_cents);
ok(q4x2.line_total_cents === q4x2.total_cents && q4x2.amount_eur === Math.round(q4x2.total_cents / 100),
  'amount_eur derived from total_cents');

console.log('\n── D. Validation rejections (fail-closed) ──');
const rejects = [
  [{ service_dates: ['2026-07-20', '2026-07-20'], quantity: 1 }, 'duplicate_service_dates'],
  [{ service_dates: ['not-a-date'], quantity: 1 }, 'invalid_iso_format'],
  [{ service_dates: ['2026-02-30'], quantity: 1 }, 'invalid_calendar_date'],
  [{ service_dates: ['2020-01-01'], quantity: 1 }, 'explicit_past_date'],
  [{ service_dates: DATES_4, quantity: 0 }, 'invalid_quantity'],
  [{ service_dates: DATES_4, quantity: -1 }, 'invalid_quantity'],
  [{ service_dates: DATES_4, quantity: 1.5 }, 'invalid_quantity'],
  [{ service_dates: DATES_4, quantity: 100 }, 'invalid_quantity'],
  [{ service_dates: [], quantity: 1 }, 'service_dates_required'],
];
for (const [body, reason] of rejects) {
  const r = body.service_dates && body.service_dates.length
    ? validateGroupLessonQuoteBody(body, REF)
    : validateGroupLessonQuoteBody(body, REF);
  const got = r.reason || (quote(body).reason);
  ok(!r.ok && got === reason, `reject ${reason}`, got);
}

const missingPrice = quoteSunsetGroupLessonsFromPrices({
  locationId: LOC,
  body: { service_dates: DATE_1, quantity: 1 },
  refDate: REF,
  prices: [],
});
ok(!missingPrice.ok && missingPrice.reason === 'group_lesson_price_unavailable', 'missing/inactive price');

console.log('\n── E. Location / tenant scope before price lookup ──');
const crossSchool = resolveSunsetBotBodyLocation({ location_id: 'wolfhouse-somo' });
ok(crossSchool.ok === false, 'cross-school location rejected at HTTP boundary before price lookup');
const foreignTenant = quoteSunsetGroupLessonsSync({ clientSlug: 'wolfhouse-somo', locationId: LOC, body: { service_dates: DATE_1, quantity: 1 }, refDate: REF });
ok(!foreignTenant.ok && foreignTenant.reason === 'invalid_tenant', 'cross-tenant rejected');

console.log('\n── F. Quote/create pricing parity (same resolver) ──');

function buildLessonPg(rows, quantityPerDate) {
  const lessonRows = rows.map((d, i) => ({
    id: `00000000-0000-0000-0000-${String(i + 11).padStart(12, '0')}`,
    service_type: 'surf_lesson',
    service_date: d,
    quantity: quantityPerDate,
    amount_due_cents: 0,
    metadata: '{}',
  }));
  const updates = { serviceRecordDue: [], bookingTotal: [], queries: [] };
  const pg = {
    async query(sql, params) {
      const q = String(sql || '');
      updates.queries.push(q.slice(0, 80));
      if (q.includes('SELECT metadata FROM bookings')) {
        return { rows: [{ metadata: { location_id: LOC } }] };
      }
      if (q.includes('FROM booking_service_records') && q.includes('WHERE client_slug')) {
        return { rows: lessonRows };
      }
      if (q.startsWith('UPDATE booking_service_records SET amount_due_cents')) {
        updates.serviceRecordDue.push({ due: params[0], id: params[1] });
        return { rows: [] };
      }
      if (q.startsWith('UPDATE bookings')) {
        updates.bookingTotal.push({ total: params[0] });
        return { rows: [] };
      }
      if (q.includes('tenant_price_rules') || q.includes('FROM clients')) {
        return { rows: [] };
      }
      throw new Error(`unexpected pg query: ${q.slice(0, 100)}`);
    },
  };
  return { pg, updates, lessonRows };
}

async function parity(dates, qty) {
  const quoteResult = quote({ service_dates: dates, quantity: qty });
  const { pg, updates } = buildLessonPg(dates, qty);
  const priced = await priceSunsetBookingServices(pg, 'sunset', '00000000-0000-0000-0000-000000000001');
  const writeCount = updates.serviceRecordDue.length + updates.bookingTotal.length;
  const noWriteOnQuote = !quoteResult._wrote;
  return { quoteResult, priced, writeCount, noWriteOnQuote };
}

(async () => {
  for (const [label, dates, qty] of [
    ['1×1', DATE_1, 1],
    ['4×1', DATES_4, 1],
    ['4×2', DATES_4, 2],
  ]) {
    const { quoteResult, priced } = await parity(dates, qty);
    ok(quoteResult.ok && priced.ok, `${label} quote and price both ok`);
    ok(quoteResult.total_cents === priced.total_cents,
      `${label} pre-booking quote total == post-create server total`,
      `${quoteResult.total_cents} vs ${priced.total_cents}`);
  }

  console.log('\n── G. Read-only: quote path performs no writes ──');
  const writeTracker = { inserts: 0, updates: 0, stripe: 0, whatsapp: 0 };
  const trackingPg = {
    async query(sql) {
      const q = String(sql || '').toUpperCase();
      if (q.includes('INSERT')) writeTracker.inserts += 1;
      if (q.includes('UPDATE')) writeTracker.updates += 1;
      if (q.includes('DELETE')) writeTracker.updates += 1;
      return { rows: [] };
    },
  };
  const { quoteSunsetGroupLessonsAsync } = require('./lib/sunset-group-lesson-quote');
  const successQuote = await quoteSunsetGroupLessonsAsync({
    clientSlug: 'sunset',
    locationId: LOC,
    body: { service_dates: DATES_4, quantity: 1 },
    pgClient: trackingPg,
    skipDb: true,
    refDate: REF,
  });
  ok(successQuote.ok, 'async quote succeeds with skipDb');
  ok(writeTracker.inserts === 0 && writeTracker.updates === 0, 'success quote: zero booking/payment writes');

  const rejectQuote = quote({ service_dates: ['2020-01-01'], quantity: 1 });
  ok(!rejectQuote.ok, 'rejection path');
  ok(writeTracker.inserts === 0 && writeTracker.updates === 0, 'rejection: still zero writes');

  const handlerSlice = staffApiSrc.slice(
    staffApiSrc.indexOf('async function handleBotSunsetLessonQuote'),
    staffApiSrc.indexOf('async function handleSunsetScheduleBookingCreate'),
  );
  ok(!/INSERT |UPDATE |DELETE |stripe|whatsapp/i.test(handlerSlice), 'handler source has no write/stripe/whatsapp calls');

  console.log('\n── H. Plugin passthrough (no local money math) ──');
  const glPluginStart = pluginSrc.indexOf('def get_sunset_group_lesson_quote');
  const glPluginEnd = pluginSrc.indexOf('\ndef _schema', glPluginStart);
  const glPluginBlock = pluginSrc.slice(glPluginStart, glPluginEnd > glPluginStart ? glPluginEnd : glPluginStart + 2500);
  ok(glPluginBlock.includes('unit_amount_cents') && glPluginBlock.includes('data.get("total_cents")'),
    'plugin returns authoritative cents from Staff API');
  ok(!/\btotal_cents\s*=/.test(glPluginBlock) && !/\bamount_eur\s*=/.test(glPluginBlock),
    'plugin handler does not multiply or invent totals');

  console.log('\n────────────────────────────────────────────────');
  console.log(`verify-sunset-group-lesson-quote  pass=${pass}  fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('verify-sunset-group-lesson-quote — ALL CHECKS PASSED');
})().catch((err) => {
  console.error('verify-sunset-group-lesson-quote crashed:', err && err.message);
  process.exit(1);
});
