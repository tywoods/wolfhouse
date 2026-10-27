'use strict';

/**
 * LUNA-STORMGLASS-SURF-001 — deterministic offline contract.
 * Proves trusted location binding, hourly/time-window coverage, provider-first
 * provenance, typed non-secret outcomes, and the guest tool surface.
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getStormglassForecastLocation,
} = require('./lib/staff-stormglass-config');
const {
  fetchStormglassForecast,
  setStormglassFetchForTests,
  clearStormglassForecastCacheForTests,
  getMadridCalendarYmd,
} = require('./lib/staff-stormglass-forecast');

let passed = 0;
function check(id, fn) {
  try { fn(); passed += 1; } catch (err) { console.error(`FAIL ${id}: ${err.message}`); process.exitCode = 1; }
}

async function main() {
  check('SGS1 wolfhouse binding is explicit Somo', () => {
    assert.deepEqual(getStormglassForecastLocation('wolfhouse-somo'), {
      client_slug: 'wolfhouse-somo', location_id: 'wolfhouse-somo', label: 'Somo',
      timezone: 'Europe/Madrid', lat: 43.463, lng: -3.751,
    });
  });
  check('SGS2 sunset Somo binding remains tenant-specific', () => {
    const location = getStormglassForecastLocation('sunset-somo');
    assert.equal(location.client_slug, 'sunset');
    assert.equal(location.location_id, 'sunset-somo');
    assert.equal(location.label, 'Somo');
  });
  check('SGS3 Sunset Sardinero is never substituted with Somo', () => {
    const location = getStormglassForecastLocation('sunset-sardinero');
    assert.equal(location.label, 'El Sardinero');
    assert.notEqual(location.lat, getStormglassForecastLocation('sunset-somo').lat);
    assert.equal(getStormglassForecastLocation('sunset'), null);
  });

  const oldKey = process.env.STORMGLASS_API_KEY;
  process.env.STORMGLASS_API_KEY = 'offline-test-key';
  const cachePath = path.join(os.tmpdir(), `stormglass-forecast-${process.pid}.json`);
  try { fs.unlinkSync(cachePath); } catch (_) { /* absent */ }
  process.env.STORMGLASS_FORECAST_CACHE_PATH = cachePath;
  clearStormglassForecastCacheForTests();
  const calls = [];
  setStormglassFetchForTests(async (url) => {
    calls.push(new URL(url));
    return { status: 200, body: JSON.stringify({ hours: [{
      time: '2026-10-25T21:00:00+00:00',
      waveHeight: { sg: 1.2 }, windSpeed: { sg: 5 }, airTemperature: { sg: 14 },
      precipitation: { sg: 0.2 }, cloudCover: { sg: 65 }, currentSpeed: { sg: 0.4 },
    }] }) };
  });
  const report = await fetchStormglassForecast({
    locationId: 'sunset-sardinero', date: '2026-10-25', startHour: 22, endHour: 23,
    nowMs: Date.parse('2026-10-24T08:00:00Z'),
  });
  check('SGS4 explicit night window uses Europe/Madrid DST conversion', () => {
    assert.match(calls[0].searchParams.get('start'), /2026-10-25T21:00:00Z/);
    assert.match(calls[0].searchParams.get('end'), /2026-10-25T22:00:00Z/);
  });
  check('SGS5 report is explicitly sourced, timestamped and partial without inventing fields', () => {
    assert.equal(report.source, 'stormglass');
    assert.equal(report.location.label, 'El Sardinero');
    assert.equal(report.coverage, 'partial');
    assert.equal(report.fallback_reason, 'missing_fields');
    assert.equal(report.hourly[0].air_temperature_c, 14);
    assert.equal(report.hourly[0].tide_height_m, null);
    assert.match(report.retrieved_at, /Z$/);
    assert.match(report.validity.start, /Z$/);
  });
  await assert.rejects(
    () => fetchStormglassForecast({ locationId: 'sunset', date: '2026-10-25' }),
    (err) => err && err.code === 'UNSUPPORTED_LOCATION',
  );
  check('SGS6 unbound tenant fails closed rather than forecasting Somo', () => {});
  await assert.rejects(
    () => fetchStormglassForecast({ locationId: 'sunset-somo', date: '2026-12-01', nowMs: Date.parse('2026-10-24T08:00:00Z') }),
    (err) => err && err.code === 'OUT_OF_HORIZON',
  );
  check('SGS7 out-of-horizon is typed', () => {});

  // Regression: the generic forecast is a seven-day, file-backed weather and
  // marine payload. Tide facts come from Stormglass's dedicated tide endpoint,
  // never from weather/point's unsupported tideHeight parameter.
  try { fs.unlinkSync(cachePath); } catch (_) { /* absent */ }
  process.env.STORMGLASS_FORECAST_CACHE_PATH = cachePath;
  clearStormglassForecastCacheForTests();
  const multiCalls = [];
  setStormglassFetchForTests(async (url) => {
    const parsed = new URL(url);
    multiCalls.push(parsed);
    if (parsed.pathname === '/v2/tide/extremes/point') {
      return { status: 200, body: JSON.stringify({ data: [{ time: '2026-10-25T05:00:00+00:00', height: 2.4, type: 'high' }] }) };
    }
    return { status: 200, body: JSON.stringify({ hours: [{ time: '2026-10-25T00:00:00+00:00', waveHeight: { sg: 1.1 }, airTemperature: { sg: 14 } }] }) };
  });
  const multi = await fetchStormglassForecast({
    locationId: 'sunset-sardinero', date: '2026-10-25', days: 3,
    nowMs: Date.parse('2026-10-24T08:00:00Z'),
  });
  check('SGS7a requests up to seven days as one weather/marine range', () => {
    assert.equal(multi.days.length, 3);
    assert.match(multi.validity.end, /2026-10-27T23:00:00Z/);
    assert.equal(multiCalls.filter((call) => call.pathname === '/v2/weather/point').length, 1);
  });
  check('SGS7b uses the dedicated Stormglass tide endpoint', () => {
    const tideCall = multiCalls.find((call) => call.pathname === '/v2/tide/extremes/point');
    assert.ok(tideCall);
    assert.equal(tideCall.searchParams.get('start'), multi.validity.start);
    assert.equal(multi.tides.extremes[0].height_m, 2.4);
  });
  check('SGS7c persists non-secret forecast data and reuses it after memory reset', () => {
    assert.ok(fs.existsSync(cachePath));
    assert.equal(fs.readFileSync(cachePath, 'utf8').includes('offline-test-key'), false);
    clearStormglassForecastCacheForTests();
  });
  const cachedMulti = await fetchStormglassForecast({
    locationId: 'sunset-sardinero', date: '2026-10-25', days: 3,
    nowMs: Date.parse('2026-10-24T08:00:00Z'),
  });
  check('SGS7d file cache survives a process-memory reset and avoids repeat tide fetches', () => {
    assert.equal(cachedMulti.cache_hit, true);
    assert.equal(multiCalls.length, 2);
  });
  // A narrow tonight call must still populate its day-keyed tide cache from 00:00–24:00.
  clearStormglassForecastCacheForTests();
  try { fs.unlinkSync(cachePath); } catch (_) { /* force a tide-cache miss */ }
  const narrowCalls = [];
  setStormglassFetchForTests(async (url) => {
    const parsed = new URL(url); narrowCalls.push(parsed);
    if (parsed.pathname === '/v2/tide/extremes/point') return { status: 503, body: '{}' };
    return { status: 200, body: JSON.stringify({ hours: [{ time: '2026-10-26T18:00:00Z', waveHeight: { sg: 1.1 } }] }) };
  });
  const narrow = await fetchStormglassForecast({ locationId: 'sunset-sardinero', date: '2026-10-26', startHour: 18, endHour: 24, nowMs: Date.parse('2026-10-24T08:00:00Z') });
  const narrowRetry = await fetchStormglassForecast({ locationId: 'sunset-sardinero', date: '2026-10-26', startHour: 18, endHour: 24, nowMs: Date.parse('2026-10-24T08:00:00Z') });
  check('SGS7e day-keyed tides fetch the full day and failures are not cached', () => {
    const tideCalls = narrowCalls.filter((call) => call.pathname === '/v2/tide/extremes/point');
    const weatherCalls = narrowCalls.filter((call) => call.pathname === '/v2/weather/point');
    assert.equal(tideCalls.length, 2);
    assert.equal(weatherCalls.length, 1, 'good weather must not be refetched while tides are down');
    assert.match(tideCalls[0].searchParams.get('start'), /2026-10-25T23:00:00Z/);
    assert.equal(narrow.tides.availability, 'unavailable');
    assert.equal(narrowRetry.tides.availability, 'unavailable');
  });
  clearStormglassForecastCacheForTests();
  try { fs.unlinkSync(cachePath); } catch (_) { /* absent */ }
  const coverCalls = [];
  setStormglassFetchForTests(async (url) => {
    const parsed = new URL(url); coverCalls.push(parsed);
    if (parsed.pathname === '/v2/tide/extremes/point') {
      return { status: 200, body: JSON.stringify({ data: [{ time: '2026-10-25T05:00:00+00:00', height: 2.1, type: 'high' }] }) };
    }
    return { status: 200, body: JSON.stringify({ hours: [{ time: '2026-10-25T00:00:00+00:00', waveHeight: { sg: 1.4 }, airTemperature: { sg: 15 } }] }) };
  });
  const week = await fetchStormglassForecast({
    locationId: 'sunset-sardinero', date: '2026-10-25', days: 7,
    nowMs: Date.parse('2026-10-24T08:00:00Z'),
  });
  for (let days = 1; days <= 6; days += 1) {
    await fetchStormglassForecast({
      locationId: 'sunset-sardinero', date: '2026-10-25', days,
      nowMs: Date.parse('2026-10-24T08:00:00Z'),
    });
  }
  check('SGS7f a 7-day fetch covers later 1-6 day asks without extra provider calls', () => {
    assert.equal(week.days.length, 7);
    assert.equal(coverCalls.filter((call) => call.pathname === '/v2/weather/point').length, 1);
    assert.equal(coverCalls.filter((call) => call.pathname === '/v2/tide/extremes/point').length, 1);
  });
  clearStormglassForecastCacheForTests();
  try { fs.unlinkSync(cachePath); } catch (_) { /* absent */ }
  const outageCalls = [];
  setStormglassFetchForTests(async (url) => {
    const parsed = new URL(url); outageCalls.push(parsed);
    if (parsed.pathname === '/v2/tide/extremes/point') return { status: 503, body: '{}' };
    return { status: 200, body: JSON.stringify({ hours: [{ time: '2026-10-25T00:00:00+00:00', waveHeight: { sg: 1.1 } }] }) };
  });
  for (let i = 0; i < 6; i += 1) {
    await fetchStormglassForecast({
      locationId: 'sunset-sardinero', date: '2026-10-25', days: 1,
      nowMs: Date.parse('2026-10-24T08:00:00Z'),
    });
  }
  check('SGS7g identical asks during a tide outage refetch tides only, not good weather', () => {
    assert.equal(outageCalls.filter((call) => call.pathname === '/v2/weather/point').length, 1);
    assert.equal(outageCalls.filter((call) => call.pathname === '/v2/tide/extremes/point').length, 6);
  });
  const okWeatherTide = async (url, bucket) => {
    const parsed = new URL(url); bucket.push(parsed);
    if (parsed.pathname === '/v2/tide/extremes/point') {
      return { status: 200, body: JSON.stringify({ data: [{ time: '2026-10-25T05:00:00+00:00', height: 2.0, type: 'high' }] }) };
    }
    return { status: 200, body: JSON.stringify({ hours: [{ time: '2026-10-25T00:00:00+00:00', waveHeight: { sg: 1.2 }, airTemperature: { sg: 14 } }] }) };
  };
  clearStormglassForecastCacheForTests();
  try { fs.unlinkSync(cachePath); } catch (_) { /* absent */ }
  const coldWeekCalls = [];
  setStormglassFetchForTests(async (url) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return okWeatherTide(url, coldWeekCalls);
  });
  await Promise.allSettled(Array.from({ length: 6 }, () => fetchStormglassForecast({
    locationId: 'sunset-sardinero', date: '2026-10-25', days: 7,
    nowMs: Date.parse('2026-10-24T08:00:00Z'),
  })));
  check('SGS7h six simultaneous cold week requests stay at or under 10 provider calls', () => {
    assert.ok(coldWeekCalls.length <= 10, `cold weeks used ${coldWeekCalls.length} calls`);
  });
  clearStormglassForecastCacheForTests();
  try { fs.unlinkSync(cachePath); } catch (_) { /* absent */ }
  const twelveOutageCalls = [];
  setStormglassFetchForTests(async (url) => {
    const parsed = new URL(url); twelveOutageCalls.push(parsed);
    if (parsed.pathname === '/v2/tide/extremes/point') return { status: 503, body: '{}' };
    return { status: 200, body: JSON.stringify({ hours: [{ time: '2026-10-25T00:00:00+00:00', waveHeight: { sg: 1.1 } }] }) };
  });
  for (let i = 0; i < 12; i += 1) {
    await fetchStormglassForecast({
      locationId: 'sunset-sardinero', date: '2026-10-25', days: 1,
      nowMs: Date.parse('2026-10-24T08:00:00Z'),
    }).catch(() => {});
  }
  check('SGS7i twelve tide-outage requests stay at or under 10 provider calls', () => {
    assert.ok(twelveOutageCalls.length <= 10, `tide outage used ${twelveOutageCalls.length} calls`);
  });
  clearStormglassForecastCacheForTests();
  try { fs.unlinkSync(cachePath); } catch (_) { /* absent */ }
  const periodCalls = [];
  setStormglassFetchForTests(async (url) => okWeatherTide(url, periodCalls));
  const periodNow = Date.parse('2026-10-24T08:00:00Z');
  for (let i = 0; i < 8; i += 1) {
    const date = new Date(Date.parse('2026-10-24T12:00:00Z') + i * 86400000).toISOString().slice(0, 10);
    await fetchStormglassForecast({
      locationId: 'sunset-sardinero', date, startHour: 18, endHour: 24, nowMs: periodNow,
    }).catch(() => {});
    await fetchStormglassForecast({
      locationId: 'sunset-sardinero', date, startHour: 0, endHour: 24, nowMs: periodNow,
    }).catch(() => {});
  }
  check('SGS7j tonight then explicit 0-24 over 8 periods stays at or under 10 provider calls', () => {
    assert.ok(periodCalls.length <= 10, `tonight+day periods used ${periodCalls.length} calls`);
  });
  clearStormglassForecastCacheForTests();
  try { fs.unlinkSync(cachePath); } catch (_) { /* absent */ }
  const beforeMidnight = Date.parse('2026-10-24T21:59:00Z');
  const afterMidnight = Date.parse('2026-10-24T22:01:00Z');
  let midnightGate;
  const midnightHold = new Promise((resolve) => { midnightGate = resolve; });
  const midnightCalls = [];
  const origNowK = Date.now;
  let wallK = beforeMidnight;
  Date.now = () => wallK;
  setStormglassFetchForTests(async (url) => {
    midnightCalls.push(String(url));
    if (!String(url).includes('43.463')) await midnightHold;
    return okWeatherTide(url, []);
  });
  const inflight = Promise.allSettled(Array.from({ length: 5 }, () => fetchStormglassForecast({
    locationId: 'sunset-sardinero', date: '2026-10-25', days: 7, nowMs: beforeMidnight,
  })));
  const waitStart = origNowK();
  while (midnightCalls.length < 10 && origNowK() - waitStart < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  wallK = afterMidnight;
  const newDay = Promise.allSettled(Array.from({ length: 11 }, () => fetchStormglassForecast({
    locationId: 'wolfhouse-somo', date: '2026-10-25', days: 1, nowMs: afterMidnight,
  })));
  midnightGate();
  await inflight;
  await newDay;
  Date.now = origNowK;
  check('SGS7k in-flight reservations stay on the reserved Madrid day across midnight', () => {
    const newDayCalls = midnightCalls.filter((url) => url.includes('43.463')).length;
    assert.ok(newDayCalls <= 10, `new day used ${newDayCalls} calls`);
    assert.ok(midnightCalls.length <= 20, `cross-midnight used ${midnightCalls.length} calls`);
  });
  clearStormglassForecastCacheForTests();
  try { fs.unlinkSync(cachePath); } catch (_) { /* absent */ }
  const sharedCallsPath = path.join(os.tmpdir(), `stormglass-calls-${process.pid}.log`);
  try { fs.unlinkSync(sharedCallsPath); } catch (_) { /* absent */ }
  fs.writeFileSync(sharedCallsPath, '');
  const workerSrc = [
    'const fs = require("fs");',
    `const { fetchStormglassForecast, setStormglassFetchForTests } = require(${JSON.stringify(path.join(__dirname, 'lib/staff-stormglass-forecast'))});`,
    `process.env.STORMGLASS_API_KEY = "offline-test-key";`,
    `process.env.STORMGLASS_FORECAST_CACHE_PATH = ${JSON.stringify(cachePath)};`,
    `const log = ${JSON.stringify(sharedCallsPath)};`,
    'setStormglassFetchForTests(async (url) => {',
    '  fs.appendFileSync(log, "x\\n");',
    '  if (String(url).includes("tide")) return { status: 503, body: "{}" };',
    '  return { status: 200, body: JSON.stringify({ hours: [{ time: "2026-10-25T00:00:00+00:00", waveHeight: { sg: 1.1 } }] }) };',
    '});',
    '(async () => {',
    '  for (let i = 0; i < 10; i += 1) {',
    '    await fetchStormglassForecast({ locationId: "sunset-sardinero", date: "2026-10-25", days: 1, nowMs: Date.parse("2026-10-24T08:00:00Z") }).catch(() => {});',
    '  }',
    '})();',
  ].join('\n');
  const workerPath = path.join(os.tmpdir(), `stormglass-worker-${process.pid}.js`);
  fs.writeFileSync(workerPath, workerSrc);
  const { spawn } = require('child_process');
  const spawnWorker = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exit ${code}`))));
  });
  await Promise.all([spawnWorker(), spawnWorker()]);
  try { fs.unlinkSync(workerPath); } catch (_) { /* cleanup */ }
  const sharedCount = fs.readFileSync(sharedCallsPath, 'utf8').split('\n').filter(Boolean).length;
  try { fs.unlinkSync(sharedCallsPath); } catch (_) { /* cleanup */ }
  check('SGS7l two processes sharing the cache stay at or under 10 provider calls', () => {
    assert.ok(sharedCount <= 10, `two processes used ${sharedCount} calls`);
  });
  clearStormglassForecastCacheForTests();
  try { fs.unlinkSync(cachePath); } catch (_) { /* absent */ }
  setStormglassFetchForTests(async (url) => {
    if (String(url).includes('tide')) return { status: 503, body: '{}' };
    return { status: 200, body: JSON.stringify({ hours: [{ time: '2026-10-25T00:00:00+00:00', waveHeight: { sg: 1.1 } }] }) };
  });
  for (let i = 0; i < 10; i += 1) {
    await fetchStormglassForecast({
      locationId: 'sunset-sardinero', date: '2026-10-25', days: 1,
      nowMs: Date.parse('2026-10-24T08:00:00Z'),
    }).catch(() => {});
  }
  let limitCode = null;
  try {
    await fetchStormglassForecast({
      locationId: 'wolfhouse-somo', date: '2026-10-25', days: 1,
      nowMs: Date.parse('2026-10-24T08:00:00Z'),
    });
  } catch (err) {
    limitCode = err && err.code;
  }
  check('SGS7m exhausted allowance returns RATE_LIMITED to the forecast caller', () => {
    assert.equal(limitCode, 'RATE_LIMITED');
  });
  clearStormglassForecastCacheForTests();
  try { fs.unlinkSync(cachePath); } catch (_) { /* absent */ }
  let delayedClock = beforeMidnight;
  const afterMidnightCalls = [];
  const origNowN = Date.now;
  Date.now = () => delayedClock;
  setStormglassFetchForTests(async (url) => {
    const href = String(url);
    if (delayedClock >= afterMidnight) afterMidnightCalls.push(href);
    if (!href.includes('/v2/tide/')) delayedClock = afterMidnight;
    if (href.includes('/v2/tide/')) {
      if (href.includes('43.463')) return { status: 503, body: '{}' };
      return { status: 200, body: JSON.stringify({ data: [{ time: '2026-10-25T05:00:00+00:00', height: 2.0, type: 'high' }] }) };
    }
    return { status: 200, body: JSON.stringify({ hours: [{ time: '2026-10-25T00:00:00+00:00', waveHeight: { sg: 1.2 } }] }) };
  });
  await fetchStormglassForecast({
    locationId: 'sunset-sardinero', date: '2026-10-25', days: 1, nowMs: beforeMidnight,
  });
  for (let i = 0; i < 10; i += 1) {
    await fetchStormglassForecast({
      locationId: 'wolfhouse-somo', date: '2026-10-25', days: 1, nowMs: afterMidnight,
    }).catch(() => {});
  }
  check('SGS7n delayed tide after midnight counts against the new Madrid day', () => {
    assert.ok(afterMidnightCalls.length <= 10, `new day used ${afterMidnightCalls.length} calls`);
  });
  Date.now = origNowN;
  clearStormglassForecastCacheForTests();
  try { fs.unlinkSync(cachePath); } catch (_) { /* absent */ }
  setStormglassFetchForTests(async (url) => {
    if (String(url).includes('tide')) return { status: 503, body: '{}' };
    return { status: 200, body: JSON.stringify({ hours: [{ time: '2026-10-25T00:00:00+00:00', waveHeight: { sg: 1.1 } }] }) };
  });
  for (let i = 0; i < 10; i += 1) {
    await fetchStormglassForecast({
      locationId: 'sunset-sardinero', date: '2026-10-25', days: 1,
      nowMs: Date.parse('2026-10-24T08:00:00Z'),
    }).catch(() => {});
  }
  const origReadO = fs.readFileSync;
  fs.readFileSync = function patchedReadO(p, enc) {
    if (String(p).endsWith('.budget.json')) {
      const err = new Error('EIO');
      err.code = 'EIO';
      throw err;
    }
    return origReadO.apply(this, arguments);
  };
  let eioCode = null;
  let eioCalls = 0;
  setStormglassFetchForTests(async (url) => {
    eioCalls += 1;
    if (String(url).includes('tide')) return { status: 503, body: '{}' };
    return { status: 200, body: JSON.stringify({ hours: [{ time: '2026-10-25T00:00:00+00:00', waveHeight: { sg: 1.1 } }] }) };
  });
  try {
    await fetchStormglassForecast({
      locationId: 'wolfhouse-somo', date: '2026-10-25', days: 1,
      nowMs: Date.parse('2026-10-24T08:00:00Z'),
    });
  } catch (err) {
    eioCode = err && err.code;
  }
  fs.readFileSync = origReadO;
  check('SGS7o unreadable ledger fails closed and does not spend more quota', () => {
    assert.equal(eioCode, 'RATE_LIMITED');
    assert.equal(eioCalls, 0);
  });
  clearStormglassForecastCacheForTests();
  try { fs.unlinkSync(cachePath); } catch (_) { /* absent */ }
  const lockPath = `${cachePath}.budget.lock`;
  const budgetFile = `${cachePath}.budget.json`;
  const admitBefore = Date.parse('2026-10-24T21:59:59Z');
  const admitAfter = Date.parse('2026-10-24T22:00:01Z');
  const todayKey = getMadridCalendarYmd('today', admitAfter);
  const clockFile = path.join(os.tmpdir(), `stormglass-clock-${process.pid}`);
  const waiterLog = path.join(os.tmpdir(), `stormglass-waiter-${process.pid}.log`);
  fs.writeFileSync(clockFile, String(admitBefore));
  fs.writeFileSync(waiterLog, '');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const lockFd = fs.openSync(lockPath, 'wx');
  const waiterSrc = [
    `Date.now = () => Number(require('fs').readFileSync(${JSON.stringify(clockFile)}, 'utf8'));`,
    'const fs = require("fs");',
    `const { fetchStormglassForecast, setStormglassFetchForTests } = require(${JSON.stringify(path.join(__dirname, 'lib/staff-stormglass-forecast'))});`,
    'process.env.STORMGLASS_API_KEY = "offline-test-key";',
    `process.env.STORMGLASS_FORECAST_CACHE_PATH = ${JSON.stringify(cachePath)};`,
    `const log = ${JSON.stringify(waiterLog)};`,
    'setStormglassFetchForTests(async () => { fs.appendFileSync(log, "x\\n"); return { status: 200, body: JSON.stringify({ hours: [{ time: "2026-10-25T00:00:00+00:00", waveHeight: { sg: 1.2 } }] }) }; });',
    '(async () => {',
    '  try {',
    `    await fetchStormglassForecast({ locationId: "wolfhouse-somo", date: "2026-10-25", days: 1, nowMs: ${admitBefore} });`,
    '    process.stdout.write("ok\\n");',
    '  } catch (err) {',
    '    process.stdout.write(String(err && err.code || "error") + "\\n");',
    '  }',
    '})();',
  ].join('\n');
  const waiterPath = path.join(os.tmpdir(), `stormglass-waiter-${process.pid}.js`);
  fs.writeFileSync(waiterPath, waiterSrc);
  const waiterChild = spawn(process.execPath, [waiterPath], { stdio: ['ignore', 'pipe', 'inherit'] });
  const waiterCode = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('lock waiter timed out')), 8000);
    waiterChild.stdout.on('data', (chunk) => { out += String(chunk); });
    waiterChild.on('error', (err) => { clearTimeout(timer); reject(err); });
    waiterChild.on('exit', () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
    setTimeout(() => {
      fs.writeFileSync(clockFile, String(admitAfter));
      fs.writeFileSync(budgetFile, JSON.stringify({ version: 1, days: { [todayKey]: { used: 10, reserved: 0 } } }));
      try { fs.closeSync(lockFd); } catch (_) { /* already closed */ }
      try { fs.unlinkSync(lockPath); } catch (_) { /* already released */ }
    }, 150);
  });
  try { fs.unlinkSync(waiterPath); } catch (_) { /* cleanup */ }
  try { fs.unlinkSync(clockFile); } catch (_) { /* cleanup */ }
  const waiterHits = fs.readFileSync(waiterLog, 'utf8').split('\n').filter(Boolean).length;
  try { fs.unlinkSync(waiterLog); } catch (_) { /* cleanup */ }
  check('SGS7p lock waiter picks the Madrid day after admission', () => {
    assert.equal(waiterCode, 'RATE_LIMITED');
    assert.equal(waiterHits, 0, `waiter made ${waiterHits} provider calls`);
  });
  clearStormglassForecastCacheForTests();
  try { fs.unlinkSync(cachePath); } catch (_) { /* absent */ }
  setStormglassFetchForTests(async (url) => {
    if (String(url).includes('tide')) return { status: 503, body: '{}' };
    return { status: 200, body: JSON.stringify({ hours: [{ time: '2026-10-25T00:00:00+00:00', waveHeight: { sg: 1.1 } }] }) };
  });
  for (let i = 0; i < 10; i += 1) {
    await fetchStormglassForecast({
      locationId: 'sunset-sardinero', date: '2026-10-25', days: 1,
      nowMs: Date.parse('2026-10-24T08:00:00Z'),
    }).catch(() => {});
  }
  const origRead = fs.readFileSync;
  const origExists = fs.existsSync;
  fs.readFileSync = function patchedRead(p, enc) {
    if (String(p).endsWith('.budget.json')) {
      const err = new Error('EIO');
      err.code = 'EIO';
      throw err;
    }
    return origRead.apply(this, arguments);
  };
  fs.existsSync = function patchedExists(p) {
    if (String(p).endsWith('.budget.json')) return false;
    return origExists.apply(this, arguments);
  };
  let falseExistsCalls = 0;
  setStormglassFetchForTests(async (url) => {
    falseExistsCalls += 1;
    if (String(url).includes('tide')) return { status: 503, body: '{}' };
    return { status: 200, body: JSON.stringify({ hours: [{ time: '2026-10-25T00:00:00+00:00', waveHeight: { sg: 1.1 } }] }) };
  });
  let falseExistsCode = null;
  try {
    await fetchStormglassForecast({
      locationId: 'wolfhouse-somo', date: '2026-10-25', days: 1,
      nowMs: Date.parse('2026-10-24T08:00:00Z'),
    });
  } catch (err) {
    falseExistsCode = err && err.code;
  }
  fs.readFileSync = origRead;
  fs.existsSync = origExists;
  let spentAfterEio = null;
  try {
    const ledger = JSON.parse(origRead(budgetFile, 'utf8'));
    const slots = Object.values((ledger && ledger.days) || {});
    spentAfterEio = slots.find((slot) => slot && slot.used >= 10) || slots[0];
  } catch (_) { /* missing */ }
  check('SGS7q EIO with false exists fails closed and keeps used:10', () => {
    assert.equal(falseExistsCode, 'RATE_LIMITED');
    assert.equal(falseExistsCalls, 0);
    assert.equal(spentAfterEio && spentAfterEio.used, 10);
  });
  delete process.env.STORMGLASS_FORECAST_CACHE_PATH;
  try { fs.unlinkSync(cachePath); } catch (_) { /* cleanup */ }

  setStormglassFetchForTests(null);
  if (oldKey) process.env.STORMGLASS_API_KEY = oldKey; else delete process.env.STORMGLASS_API_KEY;

  const { runStormglassGuestTurn, factualForecastReply } = require('./lib/luna-stormglass-guest-turn');
  const complete = await runStormglassGuestTurn({
    tenant: 'wolfhouse-somo',
    message: 'how are the waves and is it raining today?',
    lang: 'en',
    intelligenceEnabled: true,
    forecast: {
      coverage: 'complete',
      missing_fields: [],
      location: { label: 'Somo', location_id: 'wolfhouse-somo' },
      source: 'stormglass',
      retrieved_at: '2026-10-24T08:00:00.000Z',
      hourly: [{ precipitation_mm_per_h: 0, wave_height_m: 1.1 }],
    },
  });
  check('SGS8 complete coverage makes zero public-research calls', () => {
    assert.equal(complete.trace.tools[0], 'get_surf_report');
    assert.equal(complete.trace.public_research_calls, 0);
    assert.equal(complete.trace.provenance.source, 'stormglass');
    assert.equal(complete.trace.provenance.retrieved_at, '2026-10-24T08:00:00.000Z');
    assert.equal(complete.trace.coverage, 'complete');
    assert.equal(complete.needs_human, false);
    assert.equal(complete.forecast.hourly[0].precipitation_mm_per_h, 0);
  });
  const partial = await runStormglassGuestTurn({
    tenant: 'sunset',
    locationId: 'sunset-sardinero',
    message: 'llueve en El Sardinero y hay marea?',
    lang: 'es',
    intelligenceEnabled: true,
    booking: { payment_status: 'deposit_paid', balance_due_cents: 4000 },
    forecast: {
      coverage: 'partial',
      missing_fields: ['tide_height_m'],
      location: { label: 'El Sardinero', location_id: 'sunset-sardinero' },
      source: 'stormglass',
      retrieved_at: '2026-10-24T08:00:00.000Z',
      hourly: [{ precipitation_mm_per_h: 0.4, wave_height_m: null }],
    },
  });
  check('SGS9 partial keeps Stormglass facts and researches only the missing field', () => {
    assert.equal(partial.trace.location.label, 'El Sardinero');
    assert.notEqual(partial.trace.location.label, 'Somo');
    assert.deepEqual(partial.trace.public_research_fields, ['tide_height_m']);
    assert.equal(partial.trace.public_research_calls, 1);
    assert.equal(partial.booking_truth.payment_status, 'deposit_paid');
    assert.equal(partial.booking_truth.balance_due_cents, 4000);
    assert.equal(partial.needs_human, false);
  });
  const tideOff = await runStormglassGuestTurn({
    tenant: 'wolfhouse-somo',
    message: 'tide forecast Somo today',
    lang: 'en',
    intelligenceEnabled: false,
    forecast: {
      coverage: 'partial',
      missing_fields: ['tide_height_m'],
      location: { label: 'Somo', location_id: 'wolfhouse-somo' },
      source: 'stormglass',
      retrieved_at: '2026-10-24T08:00:00.000Z',
      hourly: [{ wave_height_m: 1.1, tide_height_m: null }],
    },
  });
  check('SGS9b missing tide remains explicit but Intelligence OFF makes zero fallback calls', () => {
    assert.deepEqual(tideOff.trace.public_research_fields, []);
    assert.equal(tideOff.trace.public_research_calls, 0);
    assert.equal(tideOff.forecast.missing_fields[0], 'tide_height_m');
    assert.equal(tideOff.needs_human, false);
  });
  const quota = await runStormglassGuestTurn({
    tenant: 'sunset',
    locationId: 'sunset-somo',
    message: 'what is the temperature tonight?',
    intelligenceEnabled: false,
    forecastError: { code: 'ENTITLEMENT_DENIED', status: 402 },
  });
  check('SGS10 quota failure is typed and Intelligence OFF does no web fallback', () => {
    assert.equal(quota.trace.outcome, 'ENTITLEMENT_DENIED');
    assert.equal(quota.trace.public_research_calls, 0);
    assert.equal(quota.needs_human, false);
    assert.equal(quota.invented_forecast, false);
  });
  const copyForecast = {
    location: { label: 'Somo', location_id: 'wolfhouse-somo' },
    hourly: [{
      wave_height_m: 1.1,
      precipitation_mm_per_h: 0.2,
      wind_speed_mps: 3,
      air_temperature_c: 18,
      cloud_cover_pct: 40,
      tide_height_m: 1.4,
    }],
  };
  const copyEn = factualForecastReply(copyForecast, 'en');
  const copyEs = factualForecastReply(copyForecast, 'es');
  const copyIt = factualForecastReply(copyForecast, 'it');
  const copyItLocale = factualForecastReply(copyForecast, 'it-IT');
  const copyItEmpty = factualForecastReply({
    location: { label: 'Somo', location_id: 'wolfhouse-somo' },
    hourly: [{}],
  }, 'it');
  check('SGS11 EN/ES/IT forecast copy comes from factualForecastReply', () => {
    assert.equal(
      copyEn,
      'Forecast for Somo: waves 1.1 m, rain 0.2 mm/h, wind 3 m/s, air 18 °C, cloud 40%, tide 1.4 m.',
    );
    assert.equal(
      copyEs,
      'Previsión de Somo: olas 1.1 m, lluvia 0.2 mm/h, viento 3 m/s, aire 18 °C, nubes 40%, marea 1.4 m.',
    );
    assert.equal(
      copyIt,
      'Previsione di Somo: onde 1.1 m, pioggia 0.2 mm/h, vento 3 m/s, aria 18 °C, nuvole 40%, marea 1.4 m.',
    );
    assert.equal(copyItLocale, copyIt);
    assert.match(copyItEmpty, /Previsione di Somo/);
    assert.match(copyItEmpty, /dati insufficienti|senza dati sufficienti/);
    assert.doesNotMatch(copyIt, /Forecast for|waves /);
    assert.doesNotMatch(copyItEmpty, /Forecast for|not enough reported data/);
  });
  console.log(`verify:luna-stormglass-surf-001 ${process.exitCode ? 'FAILED' : 'PASSED'} (${passed} checks)`);
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
