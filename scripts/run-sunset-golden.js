'use strict';

/**
 * Sunset golden fixture runner (review-only).
 *
 * Loads fixtures/sunset-golden via manifest, installs the central no-send
 * guard before any fixture logic, and exercises fixture 09 expectations
 * without WhatsApp, email, booking create, or Stripe/payment-link create.
 *
 * The guard remains effective even when fixture flags are misconfigured
 * (allow_writes:true / whatsapp_suppressed:false).
 *
 * Run:
 *   node scripts/run-sunset-golden.js
 *   node scripts/run-sunset-golden.js --fixture sunset-golden-09-rapid-group-lesson-quote-whatsapp.json
 *   npm run sunset:golden
 */

const fs = require('fs');
const path = require('path');
const {
  BLOCK_REASON,
  evaluateSideEffect,
  evaluateToolCall,
  guardedDispatch,
  guardedToolCall,
} = require('./lib/sunset-golden-no-send-guard');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'sunset-golden');
const MANIFEST_PATH = path.join(FIXTURES_DIR, '_manifest.json');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return true;
  }
  console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  fail += 1;
  return false;
}

function parseArgs(argv) {
  const opts = { fixture: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--fixture') opts.fixture = argv[++i];
  }
  return opts;
}

function loadJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  // Allow a single leading /* ... */ documentation block before JSON object.
  const stripped = raw.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
  return JSON.parse(stripped);
}

function loadManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (!manifest || !Array.isArray(manifest.fixtures)) {
    throw new Error('invalid sunset-golden manifest');
  }
  return manifest;
}

function consolidateRapidMessages(messages) {
  return (messages || [])
    .slice()
    .sort((a, b) => (a.delay_ms || 0) - (b.delay_ms || 0))
    .map((m) => String(m.text || '').trim())
    .filter(Boolean)
    .join('\n');
}

function nextMondayIso(from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const day = d.getUTCDay(); // 0=Sun
  const add = day === 1 ? 7 : (8 - day) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString().slice(0, 10);
}

function nextFourWeekdayMornings() {
  const start = nextMondayIso();
  const dates = [];
  const d = new Date(start + 'T12:00:00Z');
  while (dates.length < 4) {
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 4) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

function runFixture09(fixture) {
  console.log('\n[fixture-09] rapid group lesson quote (guarded review-only)');

  assert('fixture id present', typeof fixture.id === 'string' && fixture.id.length > 0);
  assert('language es', fixture.language === 'es');
  assert('location_id sunset-somo', fixture.location_id === 'sunset-somo');
  assert('debounce_ms 5000', fixture.debounce_ms === 5000);

  const consolidated = consolidateRapidMessages(fixture.messages);
  assert('consolidated input includes group lessons', /clases grupales/i.test(consolidated));
  assert('consolidated input includes quantity cue', /dos personas/i.test(consolidated));
  assert('consolidated input includes morning cue', /mañana/i.test(consolidated));
  assert('four weekday cues present', /lunes|martes|miércoles|jueves/i.test(consolidated));

  const expect = fixture.expectations || {};
  const mustCall = expect.must_call_tools || [];
  assert(
    'expects availability + group quote tools',
    mustCall.includes('get_sunset_lesson_availability')
      && mustCall.includes('get_sunset_group_lesson_quote'),
  );

  // Offline quote via authoritative module with confirmed admin-shaped prices.
  // Baseline unverified_seed is intentionally non-quotable (same as verify:sunset-group-lesson-quote).
  try {
    const { quoteSunsetGroupLessonsFromPrices } = require('./lib/sunset-group-lesson-quote');
    const serviceDates = nextFourWeekdayMornings();
    const qty = (expect.quote_args && expect.quote_args.quantity) || 2;
    const adminSlotId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const adminPrices = [{
      id: 'golden-09-gl',
      category: 'lesson',
      offering_key: `lesson_slot_${adminSlotId}__session`,
      unit: 'session',
      amount: 42,
      amount_cents: 4200,
      active: true,
      source: 'db',
      pricing_status: 'confirmed',
      effective_state: 'db',
    }];
    const quote = quoteSunsetGroupLessonsFromPrices({
      locationId: fixture.location_id || 'sunset-somo',
      body: { quantity: qty, service_dates: serviceDates },
      prices: adminPrices,
      adminCfg: { ok: true, source: 'db', prices: adminPrices },
    });
    const quoteOk = !!(quote && quote.ok === true && quote.tool === 'get_sunset_group_lesson_quote');
    assert(
      'group lesson quote module invoked',
      quoteOk,
      JSON.stringify(quote && (quote.reason || quote.error) || quote).slice(0, 180),
    );
    if (quoteOk) {
      assert('quote quantity matches', quote.quantity === qty);
      assert('quote date_count matches', quote.date_count === ((expect.quote_args && expect.quote_args.service_dates_count) || 4));
      assert('quote total derived from confirmed unit', quote.total_cents === 4200 * qty * quote.date_count);
    }
    for (const key of expect.forbidden_component_keys || []) {
      const comps = (quote && quote.components) || {};
      assert(`quote components avoid ${key}`, !Object.prototype.hasOwnProperty.call(comps, key));
    }
  } catch (err) {
    assert('group lesson quote module available', false, err.message);
  }

  // Central no-send: blocked tools never proceed.
  for (const tool of expect.must_not_call_before_name || ['create_sunset_booking', 'create_sunset_payment_link']) {
    const blocked = guardedToolCall(tool, fixture, () => ({ ok: true, success: true, leaked: true }));
    assert(`${tool} blocked by central guard`, blocked && blocked.blocked === true && blocked.reason === BLOCK_REASON);
  }

  if (expect.create_must_be_blocked_when_allow_writes_false) {
    const createGate = evaluateToolCall('create_sunset_booking', fixture);
    assert('create blocked (fixture allow_writes=false path)', createGate.allowed === false);
  }

  // Explicit proof: flags on the fixture are ignored.
  const misconfigured = Object.assign({}, fixture, {
    allow_writes: true,
    whatsapp_suppressed: false,
    email_suppressed: false,
  });
  assert(
    'booking_create blocked despite allow_writes:true',
    evaluateSideEffect('booking_create', misconfigured).allowed === false,
  );
  assert(
    'payment_link_create blocked despite allow_writes:true',
    evaluateSideEffect('payment_link_create', misconfigured).allowed === false,
  );
  assert(
    'whatsapp_send blocked despite whatsapp_suppressed:false',
    evaluateSideEffect('whatsapp_send', misconfigured).allowed === false,
  );
  assert(
    'email_send blocked despite email_suppressed:false',
    evaluateSideEffect('email_send', misconfigured).allowed === false,
  );

  const dispatchAttempt = guardedDispatch('booking_create', misconfigured, () => ({ created: true }));
  assert('guardedDispatch does not invoke create callback', dispatchAttempt.created !== true && dispatchAttempt.blocked === true);
}

function runAdversarial() {
  console.log('\n[adversarial] central no-send remains effective under misconfiguration');

  const evilFixture = {
    id: 'adversarial-misconfigured',
    allow_writes: true,
    whatsapp_suppressed: false,
    email_suppressed: false,
  };

  const cases = [
    ['booking_create', 'booking_create'],
    ['payment_link_create', 'payment_link_create'],
    ['stripe_checkout_create', 'stripe_checkout_create'],
    ['whatsapp_send', 'whatsapp_send'],
    ['email_send', 'email_send'],
    ['tool:create_sunset_booking', null],
    ['tool:create_sunset_payment_link', null],
    ['tool:send_whatsapp_message', null],
    ['tool:send_email', null],
  ];

  for (const [label, effect] of cases) {
    if (label.startsWith('tool:')) {
      const tool = label.slice(5);
      let called = false;
      const out = guardedToolCall(tool, evilFixture, () => {
        called = true;
        return { ok: true };
      });
      assert(`${label} blocked + callback not run`, out.blocked === true && called === false && out.reason === BLOCK_REASON);
    } else {
      let called = false;
      const out = guardedDispatch(effect, evilFixture, () => {
        called = true;
        return { ok: true };
      });
      assert(`${label} blocked + callback not run`, out.blocked === true && called === false);
    }
  }

  // Read tools remain allowed.
  let readCalled = false;
  const readOut = guardedToolCall('get_sunset_group_lesson_quote', evilFixture, () => {
    readCalled = true;
    return { ok: true, tool: 'get_sunset_group_lesson_quote' };
  });
  assert('read tool get_sunset_group_lesson_quote allowed', readOut.ok === true && readCalled === true);

  let availCalled = false;
  const availOut = guardedToolCall('get_sunset_lesson_availability', evilFixture, () => {
    availCalled = true;
    return { ok: true };
  });
  assert('read tool get_sunset_lesson_availability allowed', availOut.ok === true && availCalled === true);
}

function runStructureListed(manifest, onlyFixture) {
  console.log('\n[structure] listed fixtures');
  const names = onlyFixture ? [onlyFixture] : manifest.fixtures;
  for (const name of names) {
    const filePath = path.join(FIXTURES_DIR, name);
    assert(`${name} exists`, fs.existsSync(filePath), filePath);
    if (!fs.existsSync(filePath)) continue;
    let data;
    try {
      data = loadJson(filePath);
    } catch (err) {
      assert(`${name} valid JSON`, false, err.message);
      continue;
    }
    assert(`${name} valid JSON`, !!data);
    assert(`${name} has identity`, !!(data.id || data.name));
    if (name.includes('sunset-golden-09')) {
      runFixture09(data);
    }
  }
}

function main() {
  const opts = parseArgs(process.argv);
  console.log('run-sunset-golden — central no-send review-only runner\n');

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('manifest missing:', MANIFEST_PATH);
    process.exit(1);
  }

  const manifest = loadManifest();
  assert('manifest tenant_id=sunset', manifest.tenant_id === 'sunset');
  assert('manifest runner wired', typeof manifest.runner === 'string' && manifest.runner.includes('run-sunset-golden'));
  assert('fixture 09 listed', manifest.fixtures.some((n) => String(n).includes('sunset-golden-09')));

  runStructureListed(manifest, opts.fixture);
  if (!opts.fixture || String(opts.fixture).includes('09')) {
    runAdversarial();
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`run-sunset-golden  pass=${pass}  fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main();
