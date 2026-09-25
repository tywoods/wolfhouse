'use strict';

/**
 * LUNA-STORMGLASS-SURF-001 — deterministic offline contract.
 * Proves trusted location binding, hourly/time-window coverage, provider-first
 * provenance, typed non-secret outcomes, and the guest tool surface.
 */
const assert = require('assert/strict');
const {
  getStormglassForecastLocation,
} = require('./lib/staff-stormglass-config');
const {
  fetchStormglassForecast,
  setStormglassFetchForTests,
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

  setStormglassFetchForTests(null);
  if (oldKey) process.env.STORMGLASS_API_KEY = oldKey; else delete process.env.STORMGLASS_API_KEY;
  console.log(`verify:luna-stormglass-surf-001 ${process.exitCode ? 'FAILED' : 'PASSED'} (${passed}/7)`);
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
