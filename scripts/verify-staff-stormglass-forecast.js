/**
 * Phase 11b.1 — Verifier for GET /staff/surf-forecast (Stormglass backend-only).
 * Phase 11b.1a — UTC Z window bounds for Stormglass requests.
 *
 * Usage:
 *   npm run verify:staff-stormglass-forecast
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const SG_CONFIG = path.join(__dirname, 'lib', 'staff-stormglass-config.js');
const SG_FORECAST = path.join(__dirname, 'lib', 'staff-stormglass-forecast.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg) { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-staff-stormglass-forecast.js  (Phase 11b.1a)\n');

for (const f of [API_FILE, SG_CONFIG, SG_FORECAST, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const forecastSrc = fs.readFileSync(SG_FORECAST, 'utf8');
const configSrc = fs.readFileSync(SG_CONFIG, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

for (const f of [API_FILE, SG_CONFIG, SG_FORECAST]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'ignore' });
    ok(`${path.basename(f)} passes node --check`);
  } catch (_) {
    fail(`${path.basename(f)} passes node --check`);
  }
}

check(
  pkg.scripts && pkg.scripts['verify:staff-stormglass-forecast']
    === 'node scripts/verify-staff-stormglass-forecast.js',
  'package.json verify:staff-stormglass-forecast script',
);

check(apiSrc.includes("pathname === '/staff/surf-forecast'"), 'GET /staff/surf-forecast route exists');
check(/async function handleSurfForecast/.test(apiSrc), 'handleSurfForecast handler defined');
check(/requireAuth[\s\S]{0,200}surf-forecast|surf-forecast[\s\S]{0,200}requireAuth/.test(apiSrc),
  'surf-forecast route uses requireAuth');
check(apiSrc.includes("require('./lib/staff-stormglass-forecast')"), 'API imports staff-stormglass-forecast');
check(apiSrc.includes('fetchSurfForecastForStaff'), 'API delegates to fetchSurfForecastForStaff');

const handlerStart = apiSrc.indexOf('async function handleSurfForecast');
let handlerEnd = -1;
if (handlerStart > -1) {
  let depth = 0;
  let started = false;
  for (let i = handlerStart; i < apiSrc.length; i++) {
    const ch = apiSrc[i];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}' && started) {
      depth--;
      if (depth === 0) {
        handlerEnd = i + 1;
        break;
      }
    }
  }
}
const handlerBlock = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';
check(handlerBlock.length > 0, 'handleSurfForecast block extracted');
check(handlerBlock.includes('503') && handlerBlock.includes('configured:  false'),
  'missing key returns 503 with configured:false');
check(!handlerBlock.includes('withPgClient'), 'handler has no DB client usage');
check(!/INSERT|UPDATE|DELETE/i.test(handlerBlock), 'handler has no SQL writes');
check(!/whatsapp|graph\.facebook\.com/i.test(handlerBlock), 'handler has no WhatsApp calls');
check(!/n8n/i.test(handlerBlock), 'handler has no n8n references');
check(!/stripe/i.test(handlerBlock), 'handler has no Stripe references');
check(!/\bfetch\s*\(/.test(handlerBlock), 'handler has no inline fetch (backend lib only)');

check(forecastSrc.includes('process.env.STORMGLASS_API_KEY'), 'forecast lib reads STORMGLASS_API_KEY from env only');
check(forecastSrc.includes('api.stormglass.io'), 'Stormglass call is in forecast lib (backend-only)');
check(!apiSrc.includes('api.stormglass.io'), 'staff-query-api.js does not call Stormglass URL directly');
check(!forecastSrc.match(/console\.(log|info|warn|error)[\s\S]{0,80}STORMGLASS_API_KEY/i),
  'forecast lib does not log API key');
check(!forecastSrc.match(/return\s*\{[^}]*\bkey\b[^}]*STORMGLASS/i),
  'forecast lib does not return key in responses');

const uiStart = apiSrc.indexOf('function buildUiHtml');
const uiEnd = uiStart > -1 ? apiSrc.indexOf('\nfunction ', uiStart + 1) : -1;
const uiBlock = uiStart > -1 && uiEnd > uiStart ? apiSrc.slice(uiStart, uiEnd) : '';
check(uiBlock.length > 0, 'buildUiHtml block found');
check(!/STORMGLASS/i.test(uiBlock), 'STORMGLASS not in /staff/ui HTML bundle');
check(!/surf-forecast/i.test(uiBlock), 'surf-forecast not in /staff/ui HTML bundle');
check(!/process\.env\.STORMGLASS/i.test(uiBlock), 'env var not exposed in UI JS');

check(configSrc.includes('wolfhouse-somo'), 'wolfhouse-somo spot config present');
check(configSrc.includes('Somo'), 'spot name Somo present');
check(configSrc.includes('lat:') && configSrc.includes('lng:'), 'lat/lng constants in config');

check(forecastSrc.includes('waveHeight'), 'requests waveHeight parameter');
check(forecastSrc.includes('swellHeight'), 'requests swellHeight parameter');
check(forecastSrc.includes('swellPeriod'), 'requests swellPeriod parameter');
check(forecastSrc.includes('swellDirection'), 'requests swellDirection parameter');
check(forecastSrc.includes('windSpeed'), 'requests windSpeed parameter');
check(forecastSrc.includes('windDirection'), 'requests windDirection parameter');
check(forecastSrc.includes('setStormglassFetchForTests'), 'fetch can be stubbed for tests');

check(forecastSrc.includes('Staff should confirm lessons day-by-day'),
  'summary includes staff confirmation caveat');
check(forecastSrc.includes('not auto-cancelled'),
  'caution clarifies lessons are not auto-cancelled');
check(!/cancelled automatically|automatically cancel/i.test(forecastSrc),
  'summary does not imply automatic cancellation');

check(!/T\d{2}:\d{2}:\d{2}\+0[12]:00/.test(forecastSrc),
  'forecast lib does not hardcode +01:00/+02:00 offset windows');
check(forecastSrc.includes('madridLocalToUtcZ'), 'madridLocalToUtcZ helper defined');
check(forecastSrc.includes('Europe/Madrid'), 'uses Europe/Madrid timezone');

const {
  setStormglassFetchForTests,
  fetchSurfForecastForStaff,
  buildStaffSafeForecastSummary,
  aggregateStormglassHours,
  madridLocalToUtcZ,
  getMadridDayWindow,
} = require('./lib/staff-stormglass-forecast');

const UTC_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const summerWindow = getMadridDayWindow('today', Date.parse('2026-06-05T12:00:00Z'));
check(UTC_Z_RE.test(summerWindow.start), 'summer start is UTC Z string');
check(UTC_Z_RE.test(summerWindow.end), 'summer end is UTC Z string');
check(!summerWindow.start.includes('+') && !summerWindow.end.includes('+'),
  'summer window has no numeric offset suffix');
check(summerWindow.start === '2026-06-05T04:00:00Z', 'summer 06:00 Madrid → 04:00 UTC (CEST)');
check(summerWindow.end === '2026-06-05T18:00:00Z', 'summer 20:00 Madrid → 18:00 UTC (CEST)');

const winterWindow = getMadridDayWindow('today', Date.parse('2026-01-15T12:00:00Z'));
check(UTC_Z_RE.test(winterWindow.start), 'winter start is UTC Z string');
check(UTC_Z_RE.test(winterWindow.end), 'winter end is UTC Z string');
check(winterWindow.start === '2026-01-15T05:00:00Z', 'winter 06:00 Madrid → 05:00 UTC (CET)');
check(winterWindow.end === '2026-01-15T19:00:00Z', 'winter 20:00 Madrid → 19:00 UTC (CET)');

check(madridLocalToUtcZ('2026-06-05', 6, 0) === '2026-06-05T04:00:00Z',
  'madridLocalToUtcZ summer CEST offset');
check(madridLocalToUtcZ('2026-01-15', 6, 0) === '2026-01-15T05:00:00Z',
  'madridLocalToUtcZ winter CET offset');

const emptyMetrics = aggregateStormglassHours([]);
check(emptyMetrics.wave_height_m == null, 'empty hours → null wave_height_m');
const unclear = buildStaffSafeForecastSummary(emptyMetrics);
check(unclear.summary.includes('Conditions unclear'), 'empty hours → Conditions unclear summary');
check(unclear.summary.includes('Staff should confirm lessons day-by-day'),
  'empty hours summary still includes staff caveat');

const prevKey = process.env.STORMGLASS_API_KEY;
process.env.STORMGLASS_API_KEY = '  verifier-mock-stormglass-key  ';

let mockCalled = false;
let mockRequestUrl = '';
setStormglassFetchForTests(async (url, init) => {
  mockCalled = true;
  mockRequestUrl = url;
  check(typeof url === 'string' && url.includes('api.stormglass.io/v2/weather/point'),
    'mock fetch receives Stormglass weather point URL');
  const qs = new URL(url, 'https://example.test').searchParams;
  const start = qs.get('start') || '';
  const end = qs.get('end') || '';
  check(UTC_Z_RE.test(start), 'Stormglass start query param is UTC Z');
  check(UTC_Z_RE.test(end), 'Stormglass end query param is UTC Z');
  check(!start.includes('+01:00') && !start.includes('+02:00'), 'start has no +01/+02 offset');
  check(!end.includes('+01:00') && !end.includes('+02:00'), 'end has no +01/+02 offset');
  check(init && init.headers && typeof init.headers.Authorization === 'string',
    'mock fetch uses Authorization header (key not logged)');
  check(init.headers.Authorization === 'verifier-mock-stormglass-key',
    'Authorization uses trimmed env key');
  check(!url.includes('verifier-mock-stormglass-key'), 'API key not appended to URL query');
  return {
    ok: true,
    status: 200,
    json: async () => ({
      hours: [{
        time: '2026-06-05T12:00:00+00:00',
        waveHeight: { sg: 1.2 },
        swellHeight: { sg: 1.0 },
        swellPeriod: { sg: 8 },
        swellDirection: { sg: 280 },
        windSpeed: { sg: 5 },
        windDirection: { sg: 90 },
      }],
    }),
  };
});

(async () => {
  try {
    const result = await fetchSurfForecastForStaff({ clientSlug: 'wolfhouse-somo', day: 'today' });
    check(mockCalled, 'mock fetch used — no real Stormglass API call');
    check(result.success === true, 'mock response success:true');
    check(result.client_slug === 'wolfhouse-somo', 'response client_slug');
    check(result.spot === 'Somo', 'response spot');
    check(result.day === 'today', 'response day');
    check(result.source === 'stormglass', 'response source');
    check(result.read_only === true, 'response read_only');
    check(result.forecast && typeof result.forecast.summary === 'string', 'forecast.summary present');
    check(result.forecast.summary.includes('Staff should confirm lessons day-by-day'),
      'live mock summary includes staff caveat');
    check(result.forecast.wave_height_m != null, 'forecast.wave_height_m present');
    check(result.forecast.swell_height_m != null, 'forecast.swell_height_m present');
    check(result.forecast.swell_period_s != null, 'forecast.swell_period_s present');
    check(result.forecast.wind_speed_mps != null, 'forecast.wind_speed_mps present');
    check(Math.abs(result.forecast.wave_height_m - 1.2) < 0.001, 'mock hourly data maps wave_height_m');
    check(JSON.stringify(result).indexOf('verifier-mock-stormglass-key') === -1,
      'response JSON does not leak API key');

    setStormglassFetchForTests(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hours: [] }),
    }));
    const emptyResult = await fetchSurfForecastForStaff({ clientSlug: 'wolfhouse-somo', day: 'today' });
    check(emptyResult.forecast.summary.includes('Conditions unclear'),
      'all-null upstream hours → Conditions unclear summary');
    check(emptyResult.read_only === true, 'empty upstream response stays read_only');

    const windy = buildStaffSafeForecastSummary({ wave_height_m: 0.5, wind_speed_mps: 8 });
    check(windy.summary.includes('Wind may affect conditions'), 'windy summary mentions wind');
    check(windy.summary.includes('Staff should confirm lessons day-by-day'),
      'windy summary includes staff caveat');
  } catch (err) {
    fail(`mock fetchSurfForecastForStaff threw: ${err.message}`);
  } finally {
    setStormglassFetchForTests(null);
    if (prevKey === undefined) delete process.env.STORMGLASS_API_KEY;
    else process.env.STORMGLASS_API_KEY = prevKey;

    console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
    process.exit(failures > 0 ? 1 : 0);
  }
})();
