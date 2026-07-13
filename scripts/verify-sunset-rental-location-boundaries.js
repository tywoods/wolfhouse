'use strict';

/**
 * verify:sunset-rental-location-boundaries
 *
 * End-to-end Sunset rental location contract across:
 *   Level 2 — executeSunsetCatalogToolAsync (ctx vs args precedence)
 *   Level 3 — resolveSunsetBotBodyLocation (HTTP body aliases)
 *
 * Level 1 (lookupSunsetRentalPriceAsync) lives in verify-sunset-rental-db-precedence.js.
 *
 * Run:
 *   node scripts/verify-sunset-rental-location-boundaries.js
 */

const {
  executeSunsetCatalogToolAsync,
  resolveSunsetBotBodyLocation,
} = require('./lib/sunset-catalog-tool-executor');

let pass = 0;
let fail = 0;
function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

const TOOL_ITEM = 'board+suit bundle';
const TOOL_DURATION = 'half day';
const SOMO = 'sunset-somo';
const SARDI = 'sunset-sardinero';
const SOMO_CENTS = 2000;
const SARDI_CENTS = 1000;

function makeLoadRuleSpy() {
  let calls = 0;
  const fn = async (params) => {
    calls += 1;
    const amounts = { [SOMO]: SOMO_CENTS, [SARDI]: SARDI_CENTS };
    const amt = amounts[params.locationId];
    if (amt == null) return { status: 'not_found' };
    return {
      status: 'found',
      amount_cents: amt,
      currency: 'EUR',
      location_id: params.locationId,
      item_type: 'rental',
      item_code: 'board_and_suit_rental__half_day',
      unit: 'session',
    };
  };
  fn.callCount = () => calls;
  return fn;
}

function assertFailClosed(label, result, loadRule, expectedReason) {
  assert(`${label} → ${expectedReason}`, result.ok === false && result.reason === expectedReason, JSON.stringify(result));
  assert(`${label} → no amount`, result.amount_cents == null && !(result.result && result.result.amount_cents), JSON.stringify(result));
  assert(`${label} → zero loadRule calls`, loadRule.callCount() === 0, String(loadRule.callCount()));
  assert(`${label} → not labeled sunset-somo`, result.location_id !== SOMO && !(result.result && result.result.location_id === SOMO), JSON.stringify(result));
}

async function runExecutorCase(label, ctx, expectedReason) {
  const loadRule = makeLoadRuleSpy();
  const result = await executeSunsetCatalogToolAsync('get_sunset_rental_price', {
    ...ctx,
    client_slug: 'sunset',
    loadRule,
    args: { item: TOOL_ITEM, duration: TOOL_DURATION, ...(ctx.args || {}) },
  });
  assertFailClosed(label, result, loadRule, expectedReason);
}

async function main() {
  console.log('\nverify:sunset-rental-location-boundaries — ctx/args + HTTP alias contract\n');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';

  console.log('[L2] executeSunsetCatalogToolAsync — omission and valid locations');
  const loadOmit = makeLoadRuleSpy();
  const omitted = await executeSunsetCatalogToolAsync('get_sunset_rental_price', {
    client_slug: 'sunset',
    loadRule: loadOmit,
    args: { item: TOOL_ITEM, duration: TOOL_DURATION },
  });
  assert('neither ctx nor args location_id → Somo default',
    omitted.ok === true && omitted.location_id === SOMO && omitted.result.amount_cents === SOMO_CENTS,
    JSON.stringify(omitted));
  assert('omitted location issues one loadRule call', loadOmit.callCount() === 1, String(loadOmit.callCount()));

  for (const [label, ctx] of [
    ['ctx valid Somo', { location_id: SOMO }],
    ['ctx valid Sardinero', { location_id: SARDI }],
    ['args valid Somo when ctx omitted', { args: { location_id: SOMO } }],
    ['args valid Sardinero when ctx omitted', { args: { location_id: SARDI } }],
  ]) {
    const loadRule = makeLoadRuleSpy();
    const result = await executeSunsetCatalogToolAsync('get_sunset_rental_price', {
      client_slug: 'sunset',
      loadRule,
      ...ctx,
      args: { item: TOOL_ITEM, duration: TOOL_DURATION, ...(ctx.args || {}) },
    });
    const expectedLoc = ctx.location_id || (ctx.args && ctx.args.location_id);
    const expectedCents = expectedLoc === SARDI ? SARDI_CENTS : SOMO_CENTS;
    assert(`${label} → found`, result.ok === true && result.location_id === expectedLoc && result.result.amount_cents === expectedCents, JSON.stringify(result));
    assert(`${label} → one loadRule call`, loadRule.callCount() === 1, String(loadRule.callCount()));
  }

  console.log('\n[L2] executeSunsetCatalogToolAsync — explicit invalid ctx/args');
  for (const [label, ctx] of [
    ['ctx explicit null', { location_id: null }],
    ['ctx explicit undefined own property', { location_id: undefined }],
    ['ctx explicit empty string', { location_id: '' }],
    ['ctx explicit whitespace', { location_id: '   ' }],
    ['ctx explicit typo', { location_id: 'sunset-sardienro' }],
    ['args explicit null', { args: { location_id: null } }],
    ['args explicit undefined own property', { args: { location_id: undefined } }],
    ['args explicit empty string', { args: { location_id: '' } }],
    ['args explicit whitespace', { args: { location_id: '   ' } }],
    ['args explicit typo', { args: { location_id: 'sunset-sardienro' } }],
  ]) {
    await runExecutorCase(label, ctx, 'unknown_location');
  }

  console.log('\n[L2] executeSunsetCatalogToolAsync — ctx vs args precedence');
  await runExecutorCase('valid ctx Somo + valid args Sardinero', { location_id: SOMO, args: { location_id: SARDI } }, 'location_scope_mismatch');
  await runExecutorCase('valid ctx Sardinero + valid args Somo', { location_id: SARDI, args: { location_id: SOMO } }, 'location_scope_mismatch');

  const loadSame = makeLoadRuleSpy();
  const sameBoth = await executeSunsetCatalogToolAsync('get_sunset_rental_price', {
    client_slug: 'sunset',
    location_id: SOMO,
    loadRule: loadSame,
    args: { item: TOOL_ITEM, duration: TOOL_DURATION, location_id: SOMO },
  });
  assert('same valid location in ctx and args → one lookup', sameBoth.ok === true && sameBoth.location_id === SOMO, JSON.stringify(sameBoth));
  assert('same valid location → one loadRule call', loadSame.callCount() === 1, String(loadSame.callCount()));

  const loadNorm = makeLoadRuleSpy();
  const normBoth = await executeSunsetCatalogToolAsync('get_sunset_rental_price', {
    client_slug: 'sunset',
    location_id: '  SUNSET-SOMO  ',
    loadRule: loadNorm,
    args: { item: TOOL_ITEM, duration: TOOL_DURATION, location_id: 'sunset-somo' },
  });
  assert('normalized equivalents in ctx and args → found', normBoth.ok === true && normBoth.location_id === SOMO, JSON.stringify(normBoth));
  assert('normalized equivalents → one loadRule call', loadNorm.callCount() === 1, String(loadNorm.callCount()));

  console.log('\n[L3] resolveSunsetBotBodyLocation — HTTP body aliases');
  const omitBody = resolveSunsetBotBodyLocation({ item: TOOL_ITEM });
  assert('body omits both location_id and location → Somo default',
    omitBody.ok === true && omitBody.location_id === SOMO, JSON.stringify(omitBody));

  for (const [label, body] of [
    ['explicit location_id null', { location_id: null }],
    ['explicit location_id undefined own property', { location_id: undefined }],
    ['explicit location_id empty', { location_id: '' }],
    ['explicit location_id whitespace', { location_id: '   ' }],
    ['explicit location_id typo', { location_id: 'sunset-sardienro' }],
    ['explicit location null', { location: null }],
    ['explicit location undefined own property', { location: undefined }],
    ['explicit location empty', { location: '' }],
    ['explicit location whitespace', { location: '   ' }],
    ['explicit location typo', { location: 'sunset-sardienro' }],
  ]) {
    const res = resolveSunsetBotBodyLocation(body);
    assert(`${label} → rejected`, res.ok === false, JSON.stringify(res));
    assert(`${label} → not labeled sunset-somo`, res.location_id !== SOMO, JSON.stringify(res));
  }

  const somoId = resolveSunsetBotBodyLocation({ location_id: SOMO });
  assert('valid location_id Somo', somoId.ok === true && somoId.location_id === SOMO, JSON.stringify(somoId));
  const sardiLoc = resolveSunsetBotBodyLocation({ location: SARDI });
  assert('valid location alias Sardinero', sardiLoc.ok === true && sardiLoc.location_id === SARDI, JSON.stringify(sardiLoc));

  const bothEqual = resolveSunsetBotBodyLocation({ location_id: SOMO, location: '  SUNSET-SOMO  ' });
  assert('both aliases valid and equal → accepted', bothEqual.ok === true && bothEqual.location_id === SOMO, JSON.stringify(bothEqual));

  const bothDiff = resolveSunsetBotBodyLocation({ location_id: SOMO, location: SARDI });
  assert('both aliases valid but different → rejected', bothDiff.ok === false, JSON.stringify(bothDiff));
  assert('conflicting aliases not labeled Somo', bothDiff.location_id !== SOMO, JSON.stringify(bothDiff));

  console.log(`\n── verify:sunset-rental-location-boundaries ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass}/${pass + fail}) ──\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
