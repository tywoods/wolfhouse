/**
 * Phase 11b.2 — Verifier for Staff Ask Luna surf forecast (Stormglass backend).
 *
 * Usage:
 *   npm run verify:staff-ask-luna-surf-forecast
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const SG_FILE = path.join(__dirname, 'lib', 'staff-stormglass-forecast.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg) { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-staff-ask-luna-surf-forecast.js  (Phase 11b.2)\n');

for (const f of [API_FILE, SG_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const sgSrc = fs.readFileSync(SG_FILE, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

for (const f of [API_FILE, SG_FILE]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'ignore' });
    ok(`${path.basename(f)} passes node --check`);
  } catch (_) {
    fail(`${path.basename(f)} passes node --check`);
  }
}

check(
  pkg.scripts && pkg.scripts['verify:staff-ask-luna-surf-forecast']
    === 'node scripts/verify-staff-ask-luna-surf-forecast.js',
  'package.json verify script',
);

console.log('\nA. Intent registration & routing');

check(sgSrc.includes('resolveAskLunaSurfForecastIntentKey'), 'surf forecast intent resolver defined');
check(sgSrc.includes('forecast.surf_today'), 'forecast.surf_today intent key');
check(sgSrc.includes('forecast.surf_tomorrow'), 'forecast.surf_tomorrow intent key');
check(apiSrc.includes('resolveAskLunaSurfForecastIntentKey'), 'API imports surf forecast resolver');
check(apiSrc.includes('surfForecastIntentEarly'), 'surf forecast resolved early in NL intent');
check(apiSrc.includes('fetchSurfForecastForAskLuna'), 'API uses fetchSurfForecastForAskLuna');
check(apiSrc.includes('SURF_FORECAST_TODAY_KEY'), 'API handles SURF_FORECAST_TODAY_KEY');
check(apiSrc.includes('category:           \'forecast\''), 'Ask Luna category forecast');

const surfBlockStart = apiSrc.indexOf('if (intentKey === SURF_FORECAST_TODAY_KEY');
let surfBlockEnd = -1;
if (surfBlockStart > -1) {
  let depth = 0;
  let started = false;
  for (let i = surfBlockStart; i < apiSrc.length; i++) {
    const ch = apiSrc[i];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}' && started) {
      depth--;
      if (depth === 0) {
        surfBlockEnd = i + 1;
        break;
      }
    }
  }
}
const surfBlock = surfBlockStart > -1 && surfBlockEnd > surfBlockStart
  ? apiSrc.slice(surfBlockStart, surfBlockEnd)
  : '';
check(surfBlock.length > 0, 'Ask Luna surf forecast block extracted');
check(!surfBlock.includes('withPgClient'), 'surf forecast Ask Luna path has no DB');
check(!/INSERT|UPDATE|DELETE/i.test(surfBlock), 'surf forecast path has no SQL writes');
check(!/\bn8n\b/i.test(surfBlock), 'surf forecast path has no n8n references');
check(!/\bstripe\b/i.test(surfBlock), 'surf forecast path has no Stripe references');
check(!/graph\.facebook/i.test(surfBlock), 'surf forecast path has no WhatsApp API calls');
check(/sends_whatsapp:\s*false/.test(surfBlock), 'surf forecast sets sends_whatsapp:false');
check(!/\bfetch\s*\(\s*['"]https:\/\/api\.stormglass/i.test(surfBlock),
  'Ask Luna handler does not call Stormglass URL directly');
check(surfBlock.includes('read_only:          true'), 'surf forecast response read_only');
check(surfBlock.includes('no_write_performed: true'), 'surf forecast response no_write_performed');

console.log('\nB. Phrase routing & day parsing');

const {
  resolveAskLunaSurfForecastIntentKey,
  formatAskLunaSurfForecastAnswer,
  fetchSurfForecastForAskLuna,
  setStormglassFetchForTests,
  SURF_FORECAST_TODAY_KEY,
  SURF_FORECAST_TOMORROW_KEY,
  ASK_LUNA_SURF_FORECAST_UNAVAILABLE_ANSWER,
} = require('./lib/staff-stormglass-forecast');
const { REGISTRY_BY_KEY } = require('./lib/staff-query-registry');

const PHRASES = [
  ['How are the waves today?', SURF_FORECAST_TODAY_KEY, 'today'],
  ['How are the waves tomorrow?', SURF_FORECAST_TOMORROW_KEY, 'tomorrow'],
  ['Surf forecast today', SURF_FORECAST_TODAY_KEY, 'today'],
  ['Surf forecast tomorrow', SURF_FORECAST_TOMORROW_KEY, 'tomorrow'],
  ['Wave forecast', SURF_FORECAST_TODAY_KEY, 'today'],
  ['Is the surf good today?', SURF_FORECAST_TODAY_KEY, 'today'],
  ['Is it good for lessons tomorrow?', SURF_FORECAST_TOMORROW_KEY, 'tomorrow'],
  ['Como estan las olas hoy?', SURF_FORECAST_TODAY_KEY, 'today'],
  ['Prevision surf domani', SURF_FORECAST_TOMORROW_KEY, 'tomorrow'],
  ['forecast.surf_today', SURF_FORECAST_TODAY_KEY, 'today'],
  ['forecast.surf_tomorrow', SURF_FORECAST_TOMORROW_KEY, 'tomorrow'],
];

for (const [phrase, expectedKey, expectedDay] of PHRASES) {
  const got = resolveAskLunaSurfForecastIntentKey(phrase, REGISTRY_BY_KEY);
  check(got && got.intentKey === expectedKey, `routes "${phrase}" → ${expectedKey}`);
  check(got && got.extraParams.day === expectedDay, `day=${expectedDay} for "${phrase}"`);
}

const notLessons = resolveAskLunaSurfForecastIntentKey('Who has lessons today?', REGISTRY_BY_KEY);
check(notLessons === null, 'who has lessons today does not route to surf forecast');

console.log('\nC. Success answer format (mocked)');

const prevKey = process.env.STORMGLASS_API_KEY;
process.env.STORMGLASS_API_KEY = ' ask-luna-mock-key ';

setStormglassFetchForTests(async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    hours: [{
      time: '2026-06-05T12:00:00+00:00',
      waveHeight: { sg: 1.2 },
      swellHeight: { sg: 1.0 },
      swellPeriod: { sg: 9 },
      swellDirection: { sg: 300 },
      windSpeed: { sg: 4.5 },
      windDirection: { sg: 90 },
    }],
  }),
}));

(async () => {
  try {
    const success = await fetchSurfForecastForAskLuna({ clientSlug: 'wolfhouse-somo', day: 'today' });
    check(success.ok === true, 'mock forecast ok:true');
    check(success.answer.includes('Surf forecast for Somo today'), 'answer header with spot/day');
    check(success.answer.includes('• Waves: 1.2m'), 'answer includes waves');
    check(success.answer.includes('• Swell: 1.0m @ 9s from 300°'), 'answer includes swell line');
    check(success.answer.includes('• Wind: 4.5 m/s from 90°'), 'answer includes wind line');
    check(success.answer.includes('• Summary:'), 'answer includes summary');
    check(success.answer.includes('Staff should confirm lessons day-by-day'), 'staff caveat in answer');
    check(success.answer.includes('Lessons are not auto-cancelled'), 'not auto-cancelled in answer');
    check(!/cancelled automatically|automatically cancel/i.test(success.answer),
      'success answer has no auto-cancel lesson language');
    check(JSON.stringify(success).indexOf('ask-luna-mock-key') === -1, 'mock success does not leak key');

    setStormglassFetchForTests(async () => ({
      ok: false,
      status: 402,
      json: async () => ({ errors: { key: 'API quota exceeded' } }),
    }));

    const quota = await fetchSurfForecastForAskLuna({ clientSlug: 'wolfhouse-somo', day: 'today' });
    check(quota.ok === false && quota.unavailable === true, '402 mock → unavailable');
    check(
      quota.answer === ASK_LUNA_SURF_FORECAST_UNAVAILABLE_ANSWER,
      '402 mock → standard unavailable answer',
    );
    check(quota.answer.includes('quota/connection failed'), 'unavailable mentions quota/connection');
    check(quota.answer.includes('check conditions manually'), 'unavailable says check manually');
    check(!/looks small|looks moderate|looks big|good surf|bad surf/i.test(quota.answer),
      'unavailable does not judge conditions');

    setStormglassFetchForTests(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hours: [] }),
    }));

    const empty = await fetchSurfForecastForAskLuna({ clientSlug: 'wolfhouse-somo', day: 'today' });
    check(empty.ok === true, 'empty hours still ok (graceful)');
    check(empty.answer.includes('Conditions unclear'), 'empty hours → Conditions unclear in summary');
    check(empty.answer.includes('Staff should confirm lessons day-by-day'), 'empty hours still has staff caveat');

    const formatted = formatAskLunaSurfForecastAnswer({
      spot: 'Somo',
      day: 'today',
      forecast: {
        wave_height_m: 1.2,
        swell_height_m: 1.0,
        swell_period_s: 9,
        swell_direction_deg: 300,
        wind_speed_mps: 4.5,
        wind_direction_deg: 90,
        summary: 'Looks moderate. Wind may affect conditions.',
      },
    });
    check(formatted.includes('• Waves: 1.2m'), 'formatter waves');
    check(formatted.includes('• Staff note:'), 'formatter staff note line');
  } catch (err) {
    fail(`async surf forecast tests threw: ${err.message}`);
  } finally {
    setStormglassFetchForTests(null);
    if (prevKey === undefined) delete process.env.STORMGLASS_API_KEY;
    else process.env.STORMGLASS_API_KEY = prevKey;
  }

  console.log('\nD. Key safety & UI');

  check(sgSrc.includes('process.env.STORMGLASS_API_KEY'), 'key from env in forecast lib only');
  check(!apiSrc.includes('api.stormglass.io'), 'staff-query-api does not embed Stormglass URL');
  check(!sgSrc.match(/FROM\s+conversations|message_log|chat_log/i), 'no chat log queries in forecast lib');

  const uiStart = apiSrc.indexOf('function buildUiHtml');
  const uiEnd = uiStart > -1 ? apiSrc.indexOf('\nfunction ', uiStart + 1) : -1;
  const uiBlock = uiStart > -1 && uiEnd > uiStart ? apiSrc.slice(uiStart, uiEnd) : '';
  check(!/STORMGLASS_API_KEY/i.test(uiBlock), 'STORMGLASS_API_KEY not in /staff/ui');
  check(!/surf-forecast/i.test(uiBlock), 'surf-forecast not wired in UI JS');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})();
