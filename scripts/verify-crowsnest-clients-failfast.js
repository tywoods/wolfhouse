'use strict';

const assert = require('node:assert/strict');
const { getCrowsnestClients } = require('./lib/crowsnest/crowsnest-clients');
const {
  collectClientConnectionStatuses,
  loadCrowsnestClientsView,
} = require('./lib/crowsnest/crowsnest-client-status');
const {
  STAFF_STATUS_READ_TIMEOUT_MS,
  resolveCrowsnestStaffStatusConfig,
  createCrowsnestStaffStatusReader,
} = require('./lib/crowsnest/crowsnest-staff-status-reader');
const routing = require('./lib/crowsnest/crowsnest-luna-number-routing');

function env() {
  return {
    NODE_ENV: 'staging',
    CROWSNEST_ENVIRONMENT: 'staging',
    CROWSNEST_LUNA_ROUTING_CONTROLLER_URL: 'https://controller.test/_internal/luna-routing/v1/routes/meta-whatsapp-verified-webhook',
    CROWSNEST_LUNA_ROUTING_CONTROLLER_HMAC_KEY: 'k'.repeat(32),
    CROWSNEST_COMMS_DATABASE_URL: 'postgres://audit',
  };
}

function hangUntilAbort(_url, options) {
  return new Promise((_resolve, reject) => {
    const signal = options && options.signal;
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (!signal) {
      fail();
      return;
    }
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

async function raceCode(work, limitMs) {
  return Promise.race([
    work,
    new Promise((resolve) => {
      setTimeout(() => resolve({ code: 'still_hanging' }), limitMs);
    }),
  ]);
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}:`, error);
    process.exitCode = 1;
  }
}

(async () => {
  await test('plain http staff origins are ignored unless they are the two France docker names', () => {
    const token = 't'.repeat(32);
    const config = resolveCrowsnestStaffStatusConfig({
      CROWSNEST_WOLFHOUSE_STAGING_STAFF_ORIGIN: 'http://evil.example:3036',
      CROWSNEST_WOLFHOUSE_STAGING_STATUS_TOKEN: token,
      CROWSNEST_SUNSET_STAGING_STAFF_ORIGIN: 'http://sunset-luna:8095',
      CROWSNEST_SUNSET_STAGING_STATUS_TOKEN: token,
    });
    assert.deepEqual(config.origins, {});
    assert.equal(config.tokens.size, 0);
  });

  await test('unset routing controller URL does not fetch', async () => {
    let calls = 0;
    const transport = async () => {
      calls += 1;
      throw new Error('must not call');
    };
    for (const url of ['', undefined]) {
      const runtime = env();
      if (url === undefined) delete runtime.CROWSNEST_LUNA_ROUTING_CONTROLLER_URL;
      else runtime.CROWSNEST_LUNA_ROUTING_CONTROLLER_URL = url;
      const out = await routing.readLunaNumberRoute({ env: runtime, transport });
      assert.equal(out.code, 'routing_not_configured');
    }
    assert.equal(calls, 0);
  });

  await test('route read uses a short deadline, not the 10s controller wait', async () => {
    assert.equal(routing.ROUTE_READ_TIMEOUT_MS, 2000);
    assert.equal(routing.ROUTE_MUTATION_TIMEOUT_MS, 10000);
    assert.equal(routing.routeControllerTimeoutMs('GET'), 2000);
    assert.equal(routing.routeControllerTimeoutMs('POST'), 10000);
    const started = Date.now();
    const out = await raceCode(routing.readLunaNumberRoute({
      env: env(),
      transport: hangUntilAbort,
      auditStore: { latest: async () => { throw new Error('must not audit'); } },
    }), 3500);
    const elapsed = Date.now() - started;
    assert.equal(out.code, 'routing_controller_unavailable');
    assert.ok(elapsed < 2800, `elapsed ${elapsed}`);
    assert.ok(elapsed >= 1500, `elapsed ${elapsed}`);
  });

  await test('staff status read deadline is 2s and aborts a dead origin', async () => {
    assert.equal(STAFF_STATUS_READ_TIMEOUT_MS, 2000);
    const token = 't'.repeat(32);
    const config = resolveCrowsnestStaffStatusConfig({
      CROWSNEST_SUNSET_STAGING_STAFF_ORIGIN: 'https://sunset-staging.lunafrontdesk.com',
      CROWSNEST_SUNSET_STAGING_STATUS_TOKEN: token,
    });
    const reader = createCrowsnestStaffStatusReader(config, hangUntilAbort);
    const started = Date.now();
    const out = await raceCode(
      reader('https://sunset-staging.lunafrontdesk.com/staff/admin/email-settings?client=sunset').then(
        () => ({ code: 'resolved' }),
        (error) => ({ code: error && error.name === 'AbortError' ? 'aborted' : 'other', error }),
      ),
      3500,
    );
    const elapsed = Date.now() - started;
    assert.equal(out.code, 'aborted');
    assert.ok(elapsed < 2800, `elapsed ${elapsed}`);
    assert.ok(elapsed >= 1500, `elapsed ${elapsed}`);
  });

  await test('client status reads overlap instead of stacking per dead origin', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const calls = [];
    const started = Date.now();
    const statuses = await collectClientConnectionStatuses({
      clients: getCrowsnestClients(),
      readWhatsApp: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 200));
        inFlight -= 1;
        return { configured: true, number_display: 'configured ···0101', route: { client_slug: 'sunset' } };
      },
      staffOrigins: {
        'wolfhouse-somo': { staging: 'https://staff-staging.lunafrontdesk.com' },
        sunset: 'https://sunset-staging.lunafrontdesk.com',
      },
      requestJson: async (url) => {
        calls.push(url);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 200));
        inFlight -= 1;
        if (url.includes('email-settings') && url.includes('client=sunset')) {
          return { endpoints: [{ active: true, binding_status: 'verified', public_address: 'hello@sunsetsurfschool.com' }] };
        }
        if (url.includes('payment-summary')) return { enabled: true, verified: true };
        if (url.includes('luna-status-summary')) {
          return { schema_version: 'staff.luna_status_summary.v1', identity_configured: true, routing_configured: true, paused: false };
        }
        return null;
      },
    });
    const elapsed = Date.now() - started;
    assert.equal(calls.length, 6);
    assert.ok(maxInFlight >= 6, `maxInFlight ${maxInFlight}`);
    assert.ok(elapsed < 500, `elapsed ${elapsed}`);
    assert.equal(statuses['sunset-somo'].staging.Email, 'Connected');
    assert.equal(statuses['sunset-somo'].staging.WhatsApp, 'Connected');
    assert.equal(statuses['wolfhouse-somo'].staging.WhatsApp, 'Not connected');
    assert.equal(statuses['wolfhouse-somo'].live.Email, 'Unknown');
    assert.equal(statuses['sunset-sardinero'].staging.Email, 'Unknown');
  });

  await test('clients page readers run together', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    async function slow(name) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 180));
      inFlight -= 1;
      return name;
    }
    const started = Date.now();
    const loaded = await loadCrowsnestClientsView({
      collectStatuses: () => slow('statuses'),
      collectEvidence: () => slow('evidence'),
      collectDeploy: () => slow('deploy'),
    });
    const elapsed = Date.now() - started;
    assert.equal(maxInFlight, 3);
    assert.ok(elapsed < 400, `elapsed ${elapsed}`);
    assert.equal(loaded.clientStatuses, 'statuses');
    assert.equal(loaded.portalEvidence, 'evidence');
    assert.deepEqual(loaded.deployResult, { ok: true, value: 'deploy' });
    const failed = await loadCrowsnestClientsView({
      collectStatuses: async () => ({ ok: true }),
      collectEvidence: async () => ({ ok: true }),
      collectDeploy: async () => { throw new Error('stamp down'); },
    });
    assert.equal(failed.deployResult.ok, false);
  });

  if (process.exitCode) process.exit(process.exitCode);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
