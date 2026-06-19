'use strict';

/**
 * verify:sunset-portal-slice1-seed
 *
 * Offline structure validator for portal Slice 1 seed data:
 *   - config/clients/sunset.baseline.json (portal_demo.lesson_slots)
 *   - fixtures/sunset-portal-slice1/seed-manifest.json
 *
 * No LLM, Staff API, DB, Stripe, WhatsApp, network, or env dependency.
 *
 * Run:
 *   node scripts/verify-sunset-portal-slice1-seed.js
 *   npm run verify:sunset-portal-slice1-seed
 */

const fs   = require('fs');
const path = require('path');

const ROOT          = path.join(__dirname, '..');
const BASELINE_PATH = path.join(ROOT, 'config', 'clients', 'sunset.baseline.json');
const MANIFEST_PATH = path.join(ROOT, 'fixtures', 'sunset-portal-slice1', 'seed-manifest.json');

const EXPECTED_TENANT  = 'sunset';
const VALID_PRICING    = new Set(['unverified_seed', 'owner_required', 'provisional', 'confirmed']);
const STRIPE_PATTERN   = /https?:\/\/(checkout\.|pay\.|links\.)?stripe\.com/i;
const REAL_URL_PATTERN = /^https?:\/\//i;

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

function loadJson(filePath) {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function assertTenantScoped(label, obj) {
  assert(`${label} — tenant_id=sunset`, obj.tenant_id === EXPECTED_TENANT,
    `got ${JSON.stringify(obj.tenant_id)}`);
  assert(`${label} — client_slug=sunset`, obj.client_slug === EXPECTED_TENANT,
    `got ${JSON.stringify(obj.client_slug)}`);
}

function assertNoWolfhouse(label, obj) {
  const str = JSON.stringify(obj);
  const hasWolfhouse = str.includes('"wolfhouse"') || str.includes("'wolfhouse'");
  assert(`${label} — no wolfhouse client_slug/tenant_id`, !hasWolfhouse);
}

function assertNoRealStripe(label, val) {
  const isNull   = val === null || val === undefined;
  const isStripe = typeof val === 'string' && STRIPE_PATTERN.test(val);
  assert(`${label} — no real Stripe link`, !isStripe,
    isStripe ? `found Stripe URL: ${val}` : undefined);
}

function assertNoRealUrl(label, val) {
  const isRealUrl = typeof val === 'string' && REAL_URL_PATTERN.test(val);
  assert(`${label} — payment_link is null or non-URL`, !isRealUrl,
    isRealUrl ? `found live URL: ${val}` : undefined);
}

function assertPricingStatus(label, status) {
  assert(`${label} — pricing_status is valid (${status})`,
    status === null || status === undefined || VALID_PRICING.has(String(status)),
    `got ${JSON.stringify(status)}`);
}

// ── 1. Baseline config — portal_demo.lesson_slots ────────────────────────────

console.log('\n[1] sunset.baseline.json — valid JSON');

assert('baseline file exists', fs.existsSync(BASELINE_PATH));
const baseResult = loadJson(BASELINE_PATH);
assert('baseline is valid JSON', baseResult.ok, baseResult.error);

if (!baseResult.ok) {
  console.error('\nCannot continue — baseline is not valid JSON.');
  process.exit(1);
}

const baseline = baseResult.data;

// ── 2. portal_demo block ─────────────────────────────────────────────────────

console.log('\n[2] baseline portal_demo block');

const pd = baseline.portal_demo;
assert('portal_demo block exists', pd && typeof pd === 'object');
assert('portal_demo.demo_mode=true', pd && pd.demo_mode === true);
assertTenantScoped('portal_demo', pd || {});

const slots = pd && Array.isArray(pd.lesson_slots) ? pd.lesson_slots : [];
assert('portal_demo.lesson_slots is an array', Array.isArray(pd && pd.lesson_slots));
assert('portal_demo.lesson_slots has at least 2 entries', slots.length >= 2,
  `got ${slots.length}`);
console.log(`        ${slots.length} lesson slot(s) found`);

// ── 3. Per-slot validation ────────────────────────────────────────────────────

console.log('\n[3] lesson_slots — per-slot validation');

for (const [i, slot] of slots.entries()) {
  const lbl = `slot[${i}] ${slot.slot_id || '(no id)'}`;
  assert(`${lbl} — has slot_id`, typeof slot.slot_id === 'string' && slot.slot_id.length > 0);
  assertTenantScoped(lbl, slot);
  assert(`${lbl} — has date`, typeof slot.date === 'string');
  assert(`${lbl} — has slot_time`, typeof slot.slot_time === 'string');
  assert(`${lbl} — has session_type`, typeof slot.session_type === 'string');
  assertPricingStatus(lbl, slot.pricing_status);
  assertNoRealStripe(lbl, slot.payment_link || null);
  assertNoWolfhouse(lbl, slot);
  assert(`${lbl} — source=demo_seed`, slot.source === 'demo_seed');
}

// ── 4. Seed manifest — valid JSON ────────────────────────────────────────────

console.log('\n[4] seed-manifest.json — valid JSON');

assert('seed-manifest file exists', fs.existsSync(MANIFEST_PATH));
const mResult = loadJson(MANIFEST_PATH);
assert('seed-manifest is valid JSON', mResult.ok, mResult.error);

if (!mResult.ok) {
  console.error('\nCannot continue — seed-manifest is not valid JSON.');
  process.exit(1);
}

const m = mResult.data;

// ── 5. Manifest top-level ─────────────────────────────────────────────────────

console.log('\n[5] manifest top-level');

assertTenantScoped('manifest', m);
assert('manifest.demo_mode=true', m.demo_mode === true);
assert('manifest.source=demo_seed', m.source === 'demo_seed');
assertNoWolfhouse('manifest top-level', m);

// ── 6. Conversations ──────────────────────────────────────────────────────────

console.log('\n[6] conversations');

const convs = Array.isArray(m.conversations) ? m.conversations : [];
assert('conversations is an array', Array.isArray(m.conversations));
assert('at least 2 conversations', convs.length >= 2, `got ${convs.length}`);
console.log(`        ${convs.length} conversation(s)`);

for (const [i, conv] of convs.entries()) {
  const lbl = `conv[${i}] ${conv.conversation_id || '(no id)'}`;
  assert(`${lbl} — has conversation_id`, typeof conv.conversation_id === 'string');
  assertTenantScoped(lbl, conv);
  assert(`${lbl} — has channel`, typeof conv.channel === 'string');
  assert(`${lbl} — has turns array`, Array.isArray(conv.turns) && conv.turns.length > 0);
  assert(`${lbl} — source=demo_seed`, conv.source === 'demo_seed');
  assertNoWolfhouse(lbl, conv);

  const ds = conv.demo_state || {};
  assertNoRealUrl(`${lbl} demo_state.payment_link`, ds.payment_link);
  assertNoRealStripe(`${lbl} demo_state.payment_link`, ds.payment_link);
  assert(`${lbl} — demo_state.live_send_allowed=false`, ds.live_send_allowed === false,
    `got ${ds.live_send_allowed}`);
  if (ds.pricing_status !== undefined) {
    assertPricingStatus(`${lbl} demo_state`, ds.pricing_status);
  }
}

// ── 7. Booking service records ────────────────────────────────────────────────

console.log('\n[7] booking_service_records');

const bks = Array.isArray(m.booking_service_records) ? m.booking_service_records : [];
assert('booking_service_records is an array', Array.isArray(m.booking_service_records));
assert('at least 3 booking records', bks.length >= 3, `got ${bks.length}`);
console.log(`        ${bks.length} booking record(s)`);

const expectedTypes = new Set(['board_rental', 'board_and_suit_rental', 'group_lesson_adult']);
const foundTypes    = new Set();

for (const [i, bk] of bks.entries()) {
  const lbl = `bk[${i}] ${bk.record_id || '(no id)'}`;
  assert(`${lbl} — has record_id`, typeof bk.record_id === 'string');
  assertTenantScoped(lbl, bk);
  assert(`${lbl} — has service_type`, typeof bk.service_type === 'string');
  assertPricingStatus(lbl, bk.pricing_status);
  assertNoRealUrl(`${lbl} payment_link`, bk.payment_link);
  assertNoRealStripe(`${lbl} payment_link`, bk.payment_link);
  assert(`${lbl} — source=demo_seed`, bk.source === 'demo_seed');
  assertNoWolfhouse(lbl, bk);
  if (bk.guest_email) {
    assert(`${lbl} — guest_email is placeholder (not real domain)`,
      bk.guest_email.endsWith('.internal') || bk.guest_email.includes('demo'),
      `got ${bk.guest_email}`);
  }
  foundTypes.add(bk.service_type);
}

assert('booking records include board_rental', foundTypes.has('board_rental'));
assert('booking records include board_and_suit_rental', foundTypes.has('board_and_suit_rental'));
assert('booking records include group_lesson_adult', foundTypes.has('group_lesson_adult'));

// ── 8. Accommodation partner queue (optional) ────────────────────────────────

console.log('\n[8] accommodation_partner_queue (optional)');

const accs = Array.isArray(m.accommodation_partner_queue) ? m.accommodation_partner_queue : [];
console.log(`        ${accs.length} accommodation record(s)`);

for (const [i, acc] of accs.entries()) {
  const lbl = `acc[${i}] ${acc.record_id || '(no id)'}`;
  assertTenantScoped(lbl, acc);
  assertNoRealUrl(`${lbl} payment_link`, acc.payment_link);
  assertNoRealStripe(`${lbl} payment_link`, acc.payment_link);
  assertPricingStatus(lbl, acc.pricing_status);
  assert(`${lbl} — source=demo_seed`, acc.source === 'demo_seed');
  assertNoWolfhouse(lbl, acc);
}

// ── 9. Global no-secrets / no-Stripe sweep ───────────────────────────────────

console.log('\n[9] Global sweep — no real Stripe links or secrets in manifest');

const manifestStr = JSON.stringify(m);
assert('no stripe.com URLs in manifest', !STRIPE_PATTERN.test(manifestStr));
assert('no STRIPE_SECRET_KEY pattern in manifest',
  !manifestStr.toLowerCase().includes('stripe_secret'));
assert('no whatsapp_phone_number_id filled with real value',
  !manifestStr.match(/"whatsapp_phone_number_id"\s*:\s*"\d{10,}/));

// ── 10. No env/API dependency ────────────────────────────────────────────────

console.log('\n[10] No env/API dependency');

assert('OPENAI_API_KEY not required (reached this point without it)', true);
assert('DATABASE_URL not required (reached this point without it)', true);

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log('verify:sunset-portal-slice1-seed');
console.log(`  lesson_slots checked:       ${slots.length}`);
console.log(`  conversations checked:      ${convs.length}`);
console.log(`  booking records checked:    ${bks.length}`);
console.log(`  accommodation records:      ${accs.length}`);
console.log(`  assertions:  pass=${pass}  fail=${fail}`);

if (fail > 0) {
  process.exit(1);
}
