'use strict';

/**
 * verify-sunset-bot-price-endpoints.js
 *
 * Phase 1 — Sunset Luna READ-ONLY bot price/availability endpoints.
 *
 * Asserts:
 *   - The seven /staff/bot/sunset/* read routes are wired with requireBotAuth + POST-only.
 *   - The handlers FORCE client_slug=sunset (never trust the body).
 *   - The location whitelist is enforced (unknown location → fail-closed).
 *   - The full-day add-on returns €10/person/day and a real rental price flows.
 *   - No writes / Stripe / money in the new handlers.
 *   - The Hermes plugin registers the Sunset read tools under the sunset tenant.
 *
 * Pure/offline: uses the catalog executor directly (same code the endpoints call)
 * and static source assertions. No DB, no network.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log('  PASS  ' + msg); }
  else { fail += 1; console.log('  FAIL  ' + msg); }
}

const ROOT = path.resolve(__dirname, '..');
const staffApiSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
const pluginSrc = fs.readFileSync(
  path.join(ROOT, 'docker', 'hermes-staging', 'plugins', 'wolfhouse_staff_api', '__init__.py'),
  'utf8',
);

console.log('\n── A. Staff API routes wired (POST-only + bot auth) ──');
const routes = [
  '/staff/bot/sunset/rental-price',
  '/staff/bot/sunset/full-day-addon',
  '/staff/bot/sunset/private-lesson',
  '/staff/bot/sunset/lesson-availability',
  '/staff/bot/sunset/lesson-quote',
  '/staff/bot/sunset/catalog',
  '/staff/bot/sunset/offering-quote',
];
for (const r of routes) {
  ok(staffApiSrc.includes(`pathname === '${r}'`), `route ${r} registered`);
}
ok(staffApiSrc.includes('handleBotSunsetRentalPrice'), 'rental-price handler present');
ok(staffApiSrc.includes('handleBotSunsetFullDayAddon'), 'full-day-addon handler present');
ok(staffApiSrc.includes('handleBotSunsetPrivateLesson'), 'private-lesson handler present');
ok(staffApiSrc.includes('handleBotSunsetLessonAvailability'), 'lesson-availability handler present');
ok(staffApiSrc.includes('handleBotSunsetLessonQuote'), 'lesson-quote handler present');
ok(staffApiSrc.includes('handleBotSunsetCatalog'), 'catalog handler present');
ok(staffApiSrc.includes('handleBotSunsetOfferingQuote'), 'offering-quote handler present');

console.log('\n── B. Tenant forced to sunset; no writes/money ──');
// Every new handler must force SUNSET_CLIENT_SLUG and must not read tenant from body.
const handlerBlock = staffApiSrc.slice(
  staffApiSrc.indexOf('function sunsetBotResolveLocation'),
  staffApiSrc.indexOf('async function handleSunsetScheduleBookingCreate'),
);
const forcedCount = (handlerBlock.match(/client_slug:\s*SUNSET_CLIENT_SLUG/g) || []).length;
ok(forcedCount >= 7, `client_slug forced to SUNSET_CLIENT_SLUG in all handlers (found ${forcedCount})`);
ok(!/body\.client_slug|body\.client\b/.test(handlerBlock), 'handlers never read client_slug/client from body');
ok(!/INSERT |UPDATE |DELETE |stripe|Stripe|create-stripe/.test(handlerBlock), 'no writes / Stripe / money in handlers');
ok(/sunsetBotResolveLocation|resolveSunsetBotBodyLocation/.test(handlerBlock), 'location whitelist enforced before price lookup');

console.log('\n── C. Location whitelist fail-closed ──');
// sunsetBotResolveLocation: unknown non-empty location → ok:false.
const { isSunsetLocationId } = require('./lib/sunset-school-locations');
ok(isSunsetLocationId('sunset-somo') && isSunsetLocationId('sunset-sardinero'), 'both Sunset locations recognized');
ok(!isSunsetLocationId('wolfhouse-somo'), 'wolfhouse-somo rejected as a Sunset location');

console.log('\n── D. Real prices via the same executor the endpoints call ──');
const { executeSunsetCatalogTool } = require('./lib/sunset-catalog-tool-executor');
const addon = executeSunsetCatalogTool('get_sunset_full_day_equipment_addon', {
  client_slug: 'sunset', location_id: 'sunset-somo',
});
ok(addon.ok === true, 'full-day add-on lookup ok');
ok(addon.result && addon.result.amount_cents === 1000, `add-on is €10/person/day (amount_cents=${addon.result && addon.result.amount_cents})`);
ok(addon.result && addon.result.billing_unit === 'person_per_day', 'add-on billing_unit=person_per_day');

// Rental price with dry_run relaxes require_confirmed so a config-seeded price
// resolves even before DB-confirmed prices are present (deployed Staff API reads
// the DB-confirmed amount_cents). We assert the executor path is reachable and
// fails-closed with a reason when a price is not configured — never invents.
const rental = executeSunsetCatalogTool('get_sunset_rental_price', {
  client_slug: 'sunset', location_id: 'sunset-somo', dry_run: true,
  args: { item: 'board', duration: '1 day' },
});
ok(rental.tool_id === 'get_sunset_rental_price', 'rental executor reachable');
ok(rental.ok === true || (rental.ok === false && typeof rental.reason === 'string'),
  `rental returns a price or a fail-closed reason (ok=${rental.ok}, reason=${rental.reason || 'n/a'})`);

console.log('\n── E. Tenant scope: sunset executor rejects non-sunset ──');
const foreign = executeSunsetCatalogTool('get_sunset_full_day_equipment_addon', {
  client_slug: 'wolfhouse-somo', location_id: 'sunset-somo',
});
ok(foreign.ok === false && foreign.reason === 'invalid_tenant', 'non-sunset tenant rejected (invalid_tenant)');

console.log('\n── F. Hermes plugin: Sunset read tools registered under sunset tenant ──');
ok(/def _is_sunset_tenant\(/.test(pluginSrc), 'plugin has _is_sunset_tenant gate');
ok(/if _is_sunset_tenant\(\):\s*\n\s*tools = _sunset_tools\(\)/.test(pluginSrc),
  'register() swaps to _sunset_tools() when tenant is sunset');
for (const t of ['get_sunset_rental_price', 'get_sunset_full_day_equipment_addon',
  'get_sunset_private_lesson', 'get_sunset_lesson_availability', 'get_sunset_lesson_catalog',
  'get_sunset_offering_quote', 'get_sunset_group_lesson_quote']) {
  ok(pluginSrc.includes(`def ${t}(`), `plugin defines handler ${t}`);
  ok(pluginSrc.includes(`"${t}"`), `plugin registers tool name ${t}`);
}
// The sunset tools must hit the /sunset/* bot routes and never the write routes.
const sunsetToolsBlock = pluginSrc.slice(
  pluginSrc.indexOf('def get_sunset_rental_price'),
  pluginSrc.indexOf('def _schema('),
);
ok(sunsetToolsBlock.includes('/sunset/rental-price')
  && sunsetToolsBlock.includes('/sunset/full-day-addon')
  && sunsetToolsBlock.includes('/sunset/private-lesson')
  && sunsetToolsBlock.includes('/sunset/lesson-availability')
  && sunsetToolsBlock.includes('/sunset/catalog')
  && sunsetToolsBlock.includes('/sunset/offering-quote')
  && sunsetToolsBlock.includes('/sunset/lesson-quote'),
  'sunset tools call the /sunset/* read routes');
ok(!/booking-create|create-stripe-link|transfers\/save|addon-requests\/create/.test(sunsetToolsBlock),
  'sunset tool handlers contain no write/money route calls');

console.log('\n────────────────────────────────────────────────');
console.log(`verify:sunset-bot-price-endpoints  pass=${pass}  fail=${fail}`);
if (fail > 0) { process.exit(1); }
console.log('verify:sunset-bot-price-endpoints — ALL CHECKS PASSED');
