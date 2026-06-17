'use strict';

/**
 * Stormglass forecast client — mocked upstream + guest surf-report wiring.
 */

const {
  fetchSurfForecastForStaff,
  setStormglassFetchForTests,
  stormglassErrorBodySnippet,
} = require('./lib/staff-stormglass-forecast');
const {
  fetchGuestSurfReportData,
  buildGuestSurfReportReply,
  setGuestSurfReportFetchForTests,
} = require('./lib/luna-guest-surf-report');

let passed = 0;
let failed = 0;

function check(id, ok, msg) {
  if (ok) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAIL ${id}: ${msg}`);
}

function sampleHours() {
  return [{
    time: '2026-06-17T10:00:00+00:00',
    waveHeight: { sg: 0.8 },
    swellHeight: { sg: 0.7 },
    swellPeriod: { sg: 8 },
    swellDirection: { sg: 300 },
    windSpeed: { sg: 4 },
    windDirection: { sg: 50 },
  }];
}

async function main() {
  const savedKey = process.env.STORMGLASS_API_KEY;
  process.env.STORMGLASS_API_KEY = 'test-stormglass-key';

  setStormglassFetchForTests(async () => ({
    status: 200,
    body: JSON.stringify({ hours: sampleHours() }),
  }));

  const payload = await fetchSurfForecastForStaff({ clientSlug: 'wolfhouse-somo', day: 'today' });
  check('SG1', payload.success === true, 'mock success returns forecast');
  check('SG2', payload.forecast && payload.forecast.wave_height_m != null, 'wave height parsed');
  check('SG3', payload.source === 'stormglass', 'stormglass source');

  setStormglassFetchForTests(async () => ({
    status: 402,
    body: JSON.stringify({ errors: 'Daily quota exceeded' }),
  }));

  let quotaErr = null;
  try {
    await fetchSurfForecastForStaff({ clientSlug: 'wolfhouse-somo', day: 'tomorrow' });
  } catch (err) {
    quotaErr = err;
  }
  check('SG4', quotaErr && /HTTP 402/.test(quotaErr.message), 'failure surfaces HTTP status');
  check('SG5', quotaErr && /quota/i.test(quotaErr.message), 'failure surfaces upstream body');
  check('SG6', quotaErr && quotaErr.code === 'UPSTREAM_ERROR', 'upstream error code');

  setStormglassFetchForTests(async () => ({
    status: 200,
    body: JSON.stringify({ hours: sampleHours() }),
  }));
  const data = await fetchGuestSurfReportData({ clientSlug: 'wolfhouse-somo', day: 'today' });
  check('SG7', data.unavailable === false && data.source === 'stormglass', 'guest path live report');
  const reply = buildGuestSurfReportReply({ client_slug: 'wolfhouse-somo', surf_data: data, day: 'today' });
  check('SG8', reply.unavailable === false && /Somo/i.test(reply.reply), 'guest reply uses live data');

  setStormglassFetchForTests(async () => ({
    status: 401,
    body: JSON.stringify({ message: 'Invalid API key' }),
  }));
  const bad = await fetchGuestSurfReportData({ clientSlug: 'wolfhouse-somo', day: 'today' });
  check('SG9', bad.unavailable === true, 'guest path degrades on failure');
  check('SG10', bad.error && /401/.test(bad.error), 'guest path keeps concrete error reason');
  check('SG11', bad.error_code === 'UPSTREAM_ERROR', 'guest path error code');

  check('SG12', stormglassErrorBodySnippet('{"errors":"quota"}') === 'quota', 'error body snippet parse');

  setStormglassFetchForTests(null);
  setGuestSurfReportFetchForTests(null);
  if (savedKey) process.env.STORMGLASS_API_KEY = savedKey;
  else delete process.env.STORMGLASS_API_KEY;

  console.log(`\n── verify:staff-stormglass-forecast ${failed ? 'FAILED' : 'PASSED'} (${passed}/${passed + failed}) ──`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
