#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const {
  LIVE_SIMULATOR_ROUTE,
  TENANT_SIMULATE_PATH,
  SUNSET_BOOKING_ONLY_MODE,
  WRITE_DENY_LIST,
  buildTenantRequest,
  normalizePhone,
  resolveTenantRuntime,
  runLiveSimulatorTurn,
  runtimeOriginAllowed,
} = require('./lib/crowsnest/crowsnest-live-simulator');

const { server } = require('./crowsnest-api');
const {
  CROWSNEST_SESSION_COOKIE,
  createCrowsnestSession,
} = require('./lib/crowsnest/crowsnest-auth');

function ok(label, condition) {
  assert.ok(condition, label);
  console.log(`ok - ${label}`);
}

async function listen(app, port = 0) {
  await new Promise((resolve) => app.listen(port, '127.0.0.1', resolve));
  return app.address().port;
}

async function close(app) {
  await new Promise((resolve) => app.close(resolve));
}

function requestJson(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text }; }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  console.log('verify:crowsnest-live-simulator — contract + safety gates\n');

  const wolfPhone = `+49${'1701234567'}`;
  const sunsetPhone = `+34${'600111222'}`;

  ok('route contract is under Crowsnest API', LIVE_SIMULATOR_ROUTE === '/api/live-simulator/guest-turn');
  ok('tenant route shape is capped to /wolfhouse/simulate-guest-turn', TENANT_SIMULATE_PATH === '/wolfhouse/simulate-guest-turn');
  ok('write deny-list names booking writes', WRITE_DENY_LIST.includes('create_booking_from_plan') && WRITE_DENY_LIST.includes('create_payment_link'));
  ok('write deny-list names external sends', WRITE_DENY_LIST.includes('send_whatsapp_message') && WRITE_DENY_LIST.includes('send_sms'));
  ok('server-controlled Sunset booking-only mode is named', SUNSET_BOOKING_ONLY_MODE === 'sunset_booking_only');

  const whRuntime = resolveTenantRuntime('wolfhouse', {});
  const sunsetRuntime = resolveTenantRuntime('sunset', {});
  ok('Wolfhouse declared simulator port is 8090', whRuntime.origin === 'http://127.0.0.1:8090' && whRuntime.url.endsWith(TENANT_SIMULATE_PATH));
  ok('Sunset declared simulator port is 8094', sunsetRuntime.origin === 'http://127.0.0.1:8094' && sunsetRuntime.url.endsWith(TENANT_SIMULATE_PATH));

  ok('phone normalizer preserves selected E.164 digits', normalizePhone(wolfPhone).e164 === wolfPhone);

  const built = buildTenantRequest({
    tenantId: 'sunset',
    fromPhone: sunsetPhone,
    text: 'Hola Luna',
    lang: 'es',
  }, { CROWSNEST_LIVE_SIM_SUNSET_TOKEN: 'server-side-secret' });
  ok('tenant request builds safely', built.ok === true);
  ok('caller phone maps to tenant memory thread', built.payload.thread === sunsetPhone && built.payload.guest_phone === sunsetPhone);
  ok('writes hard disabled even if UI later sends extra fields', built.payload.allow_writes === false);
  ok('Sunset request carries booking-only mode without unrestricted writes', built.payload.simulator_write_mode === SUNSET_BOOKING_ONLY_MODE && built.limitation.booking_writes_enabled === true);
  ok('tenant token is only in server-side header', built.headers['X-Luna-Bot-Token'] === 'server-side-secret' && !JSON.stringify(built.payload).includes('server-side-secret'));

  ok('random runtime hosts still fail closed without allowlist', runtimeOriginAllowed('https://random.invalid', { env: {} }) === false);
  ok('allowed host env permits ACA-to-lunabox runtime host', runtimeOriginAllowed('https://lunabox.lunafrontdesk.com', {
    env: { CROWSNEST_LIVE_SIM_ALLOWED_HOSTS: 'lunabox.lunafrontdesk.com, other.example' },
  }) === true);
  ok('non-http runtime protocols are denied even when host allowlisted', runtimeOriginAllowed('ftp://lunabox.lunafrontdesk.com', {
    env: { CROWSNEST_LIVE_SIM_ALLOWED_HOSTS: 'lunabox.lunafrontdesk.com' },
  }) === false);

  const explicitSunsetRuntime = resolveTenantRuntime('sunset', {
    CROWSNEST_LIVE_SIM_SUNSET_ORIGIN: 'https://lunabox.lunafrontdesk.com',
  });
  ok('explicit tenant origin host is trusted for server-side runtime env', explicitSunsetRuntime.origin_allowed === true && explicitSunsetRuntime.origin === 'https://lunabox.lunafrontdesk.com');

  const unsafe = buildTenantRequest({ tenantId: 'wolfhouse', fromPhone: sunsetPhone, text: 'Hi' }, {
    CROWSNEST_LIVE_SIM_ALLOWED_HOSTS: 'lunabox.lunafrontdesk.com',
    CROWSNEST_LIVE_SIM_WOLFHOUSE_ORIGIN: 'ftp://lunabox.lunafrontdesk.com',
  });
  ok('explicit non-http runtime origins fail closed', unsafe.ok === false && unsafe.code === 'runtime_not_safely_scoped');

  let seenUpstream = null;
  const result = await runLiveSimulatorTurn({
    tenantId: 'wolfhouse',
    fromPhone: wolfPhone,
    text: 'Hello',
  }, {
    env: { CROWSNEST_LIVE_SIM_WOLFHOUSE_TOKEN: 'tok' },
    fetchImpl: async (url, options) => {
      seenUpstream = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          guest_phone: wolfPhone,
          reply_text: 'Hey! 🌊',
          session_id: 'sess-1',
          language_detected: 'en',
          allow_writes: false,
          whatsapp_suppressed: true,
          tool_calls: [{ name: 'create_booking_from_plan', result_summary: { simulate_write_blocked: true } }],
          warnings: ['blocked_booking_write'],
        }),
      };
    },
  });
  ok('proxy posts to declared tenant route', seenUpstream.url === 'http://127.0.0.1:8090/wolfhouse/simulate-guest-turn');
  ok('proxy strips write intent and forwards chosen phone', seenUpstream.body.allow_writes === false && seenUpstream.body.thread === wolfPhone && !seenUpstream.body.simulator_write_mode);
  ok('shaped result exposes memory scope by tenant+phone', result.ok === true && result.memory_scope === `wolfhouse:${wolfPhone}`);
  ok('shaped result exposes visible limitation flag', result.limitation.limitation_flag === 'writes_and_external_sends_disabled');
  ok('shaped result reports suppressed external WhatsApp', result.limitation.tenant_whatsapp_suppressed === true);
  ok('shaped result reports blocked write tools', result.limitation.blocked_write_tools.includes('create_booking_from_plan'));

  let seenSunsetUpstream = null;
  const sunsetResult = await runLiveSimulatorTurn({
    tenantId: 'sunset',
    fromPhone: sunsetPhone,
    text: 'Book it please',
  }, {
    env: { CROWSNEST_LIVE_SIM_SUNSET_TOKEN: 'tok' },
    fetchImpl: async (url, options) => {
      seenSunsetUpstream = { url, options, body: JSON.parse(options.body) };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          guest_phone: sunsetPhone,
          reply_text: 'Done — booking created.',
          allow_writes: false,
          whatsapp_suppressed: true,
          tool_calls: [{
            name: 'create_sunset_booking',
            result_summary: { success: true, write_performed: true, booking_code: 'SUN-123', next_action: null },
            simulate_guard: ['allowed_sunset_booking_only_write_in_simulate'],
          }],
          warnings: ['allowed_sunset_booking_only_write_in_simulate'],
        }),
      };
    },
  });
  ok('Sunset proxy targets declared isolated staging runtime', seenSunsetUpstream.url === 'http://127.0.0.1:8094/wolfhouse/simulate-guest-turn');
  ok('Sunset booking-only mode never flips allow_writes true', seenSunsetUpstream.body.allow_writes === false && seenSunsetUpstream.body.simulator_write_mode === SUNSET_BOOKING_ONLY_MODE);
  ok('Sunset booking-only limitation keeps payments and waivers off', sunsetResult.limitation.booking_writes_enabled === true && sunsetResult.limitation.payments_enabled === false && sunsetResult.limitation.waiver_creation_enabled === false);

  process.env.CROWSNEST_AUTH_REQUIRED = 'true';
  process.env.CROWSNEST_AUTH_USERNAME = 'operator';
  process.env.CROWSNEST_AUTH_PASSWORD = 'secret';
  process.env.CROWSNEST_LIVE_SIM_WOLFHOUSE_ORIGIN = 'http://127.0.0.1:65534';
  const port = await listen(server);
  try {
    const unauth = await requestJson(port, LIVE_SIMULATOR_ROUTE, {
      method: 'POST',
      body: { tenant: 'wolfhouse', from_phone: wolfPhone, text: 'Hi' },
    });
    ok('HTTP route requires authenticated operator', unauth.status === 401);

    const sessionToken = createCrowsnestSession('operator');
    const authed = await requestJson(port, LIVE_SIMULATOR_ROUTE, {
      method: 'POST',
      headers: { Cookie: `${CROWSNEST_SESSION_COOKIE}=${encodeURIComponent(sessionToken)}` },
      body: { tenant: 'wolfhouse', from_phone: wolfPhone, text: 'Hi' },
    });
    ok('authenticated HTTP route reaches server-side proxy path', authed.status === 502 && authed.json.runtime.target_path === TENANT_SIMULATE_PATH);
    ok('HTTP error response still exposes limitation flag', authed.json.limitation.limitation_flag === 'writes_and_external_sends_disabled');
  } finally {
    await close(server);
  }


  const repoRoot = path.resolve(__dirname, '..');
  const guardSrc = fs.readFileSync(path.join(repoRoot, 'docker/hermes-staging/wolfhouse/simulate_write_guards.py'), 'utf8');
  const coreSrc = fs.readFileSync(path.join(repoRoot, 'docker/hermes-staging/wolfhouse/simulate_core.py'), 'utf8');
  const pluginSrc = fs.readFileSync(path.join(repoRoot, 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'), 'utf8');
  ok('booking-only guard reuses existing BOT_BOOKING_ENABLED gate', /booking_only_mode == "sunset_booking_only"[\s\S]*os\.getenv\("BOT_BOOKING_ENABLED"\) == "true"/.test(guardSrc));
  ok('booking-only guard allows only existing sunset booking-create path', /if "sunset\/booking-create" in norm:[\s\S]*allowed_sunset_booking_only_write_in_simulate/.test(guardSrc));
  ok('booking-only guard still blocks Sunset payment and waiver writes', /blocked_sunset_payment_write_in_simulate/.test(guardSrc) && /blocked_sunset_waiver_write_in_simulate/.test(guardSrc));
  ok('simulate route accepts booking-only mode separately from allow_writes', /booking_only_mode=str\(body\.get\("simulator_write_mode"\)/.test(coreSrc) && /allow_writes=bool\(body\.get\("allow_writes"\)\)/.test(coreSrc));
  ok('Sunset booking tool suppresses automatic payment next-action only in simulator booking-only mode', /WOLFHOUSE_SIMULATE_BOOKING_ONLY_WRITES/.test(pluginSrc) && /next_action": \(None if suppress_payment_next_action else "create_sunset_payment_link"\)/.test(pluginSrc));

  console.log('\nverify:crowsnest-live-simulator passed');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
