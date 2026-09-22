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
  SUNSET_ISOLATED_MODE,
  WRITE_DENY_LIST,
  buildTenantRequest,
  normalizePhone,
  resolveTenantRuntime,
  runLiveSimulatorTurn,
  runtimeOriginAllowed,
} = require('./lib/crowsnest/crowsnest-live-simulator');
const {
  LIVE_SIMULATOR_EMAIL_ROUTE,
  normalizeEmailInput,
  runLiveSimulatorEmail,
} = require('./lib/crowsnest/crowsnest-live-simulator-email');

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
  ok('email route contract is under Crowsnest API', LIVE_SIMULATOR_EMAIL_ROUTE === '/api/live-simulator/email');
  const emailInput = normalizeEmailInput({
    tenantId: 'sunset',
    fromAddress: 'guest@example.com',
    fromDisplayName: 'Test Guest',
    subject: 'Surf lessons',
    bodyText: 'Hi, can you tell me about surf lessons?',
  });
  ok('email input accepts only Sunset and preserves mock inbound fields', emailInput.ok === true
    && emailInput.tenant === 'sunset'
    && emailInput.email.from_address === 'guest@example.com'
    && emailInput.email.subject === 'Surf lessons');
  ok('email input rejects Wolfhouse in v1', normalizeEmailInput({ tenantId: 'wolfhouse', fromAddress: 'guest@example.com', subject: 'Hi', bodyText: 'Hello' }).code === 'email_sunset_only');

  let seenEmailEnvelope;
  const emailResult = await runLiveSimulatorEmail({
    tenantId: 'sunset',
    fromAddress: 'guest@example.com',
    fromDisplayName: 'Test Guest',
    subject: 'Surf lessons',
    bodyText: 'Hi, can you tell me about surf lessons?',
  }, {
    env: { CROWSNEST_ENVIRONMENT: 'staging' },
    authorClient: {
      requestNaturalPlan: async (envelope) => {
        seenEmailEnvelope = envelope;
        return { status: 'ok', planJson: JSON.stringify({ acts: [{ act: 'thank_guest' }, { act: 'ask_clarifying_question', topic: 'lessons' }] }), marker: { runtime: 'hermes-sunset-luna-http' } };
      },
    },
  });
  ok('email simulator reuses same Luna email-author door', seenEmailEnvelope.authority.location_key === 'sunset-somo'
    && seenEmailEnvelope.untrusted_email.from_address === 'guest@example.com'
    && emailResult.runtime === 'hermes-sunset-luna-http');
  ok('email simulator returns draft-only reply with no send or write authority', emailResult.ok === true
    && emailResult.delivery_status === 'not_sent'
    && emailResult.send_allowed === false
    && emailResult.writes_allowed === false
    && /Luna/.test(emailResult.reply_body));
  ok('each mock inbound starts a new email conversation', typeof emailResult.conversation_id === 'string'
    && emailResult.conversation_id !== (await runLiveSimulatorEmail({ tenantId: 'sunset', fromAddress: 'guest@example.com', subject: 'Again', bodyText: 'Hello again' }, { env: { CROWSNEST_ENVIRONMENT: 'staging' }, authorClient: { requestNaturalPlan: async () => ({ status: 'ok', planJson: JSON.stringify({ acts: [{ act: 'acknowledge_message' }] }), marker: { runtime: 'hermes-sunset-luna-http' } }) } })).conversation_id);

  ok('tenant route shape is capped to /wolfhouse/simulate-guest-turn', TENANT_SIMULATE_PATH === '/wolfhouse/simulate-guest-turn');
  ok('write deny-list names booking writes', WRITE_DENY_LIST.includes('create_booking_from_plan') && WRITE_DENY_LIST.includes('create_payment_link'));
  ok('write deny-list names external sends', WRITE_DENY_LIST.includes('send_whatsapp_message') && WRITE_DENY_LIST.includes('send_sms'));
  ok('server-controlled Sunset booking-only mode is named', SUNSET_BOOKING_ONLY_MODE === 'sunset_booking_only');
  ok('server-controlled Sunset isolated mode is named', SUNSET_ISOLATED_MODE === 'sunset_isolated');

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
  ok('caller cannot inject write authority or a live identity', built.payload.allow_writes === false && !built.payload.simulator_write_mode && !built.payload.simulator_synthetic_identity);
  ok('server-owned Sunset door advertises all Staff tool writes', built.limitation.writes_enabled === true && built.limitation.staff_tool_writes_enabled === true && built.limitation.denied_actions.length === 0);
  ok('permanent transport fences remain advertised', built.limitation.whatsapp_sends_enabled === false && built.limitation.sms_sends_enabled === false);
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
  ok('read-only Wolfhouse stays visibly read-only without an admitted capability', result.limitation.capability_admitted === false && result.limitation.writes_enabled === false);

  const stringBlocked = await runLiveSimulatorTurn({
    tenantId: 'wolfhouse',
    fromPhone: wolfPhone,
    text: 'Hello again',
    allow_writes: true,
    wolfhouse_staging_capability: 'wolfhouse_staging_booking_test_link',
  }, {
    env: { CROWSNEST_LIVE_SIM_WOLFHOUSE_TOKEN: 'tok' },
    fetchImpl: async (_url, options) => {
      const forwarded = JSON.parse(options.body);
      if (forwarded.allow_writes !== false || forwarded.wolfhouse_staging_capability) {
        throw new Error('browser must not grant Wolfhouse write authority');
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          reply_text: 'I cannot finish that booking link from this desk yet.',
          allow_writes: false,
          whatsapp_suppressed: true,
          effective_capability: {
            capability: 'wolfhouse_staging_booking_test_link',
            admitted: false,
            reasons: ['staff_destination_not_approved_staging'],
            outcome: 'INTENTIONALLY_BLOCKED',
          },
          tool_calls: [{
            name: 'create_booking_from_plan',
            result_summary: 'success=True; outcome=INTENTIONALLY_BLOCKED; intentional_capability_block=True',
            simulator_guard: ['redirected_create_to_booking_preview'],
          }],
        }),
      };
    },
  });
  ok('string guard summary still names the blocked tool', stringBlocked.limitation.blocked_write_tools.includes('create_booking_from_plan'));
  ok('intentional block reasons survive to the visible limitation', stringBlocked.limitation.capability_admitted === false
    && stringBlocked.limitation.outcome === 'INTENTIONALLY_BLOCKED'
    && stringBlocked.limitation.capability_reasons.includes('staff_destination_not_approved_staging')
    && stringBlocked.limitation.whatsapp_sends_enabled === false
    && stringBlocked.limitation.limitation_flag === 'writes_and_external_sends_disabled');

  const admittedShape = await runLiveSimulatorTurn({
    tenantId: 'wolfhouse',
    fromPhone: wolfPhone,
    text: 'Please book the shared room',
  }, {
    env: { CROWSNEST_LIVE_SIM_WOLFHOUSE_TOKEN: 'tok' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        reply_text: 'Booking created. Payment is still pending.',
        allow_writes: false,
        whatsapp_suppressed: true,
        effective_capability: {
          capability: 'wolfhouse_staging_booking_test_link',
          admitted: true,
          reasons: [],
          outcome: 'ADMITTED',
        },
        tool_calls: [{ name: 'create_booking_from_plan', result_summary: { success: true, write_performed: true } }],
      }),
    }),
  });
  ok('admitted Wolfhouse capability is narrow and still cannot send', admittedShape.limitation.capability_admitted === true
    && admittedShape.limitation.booking_write_mode === 'wolfhouse_staging_booking_test_link'
    && admittedShape.limitation.writes_enabled === false
    && admittedShape.limitation.whatsapp_sends_enabled === false
    && admittedShape.limitation.sms_sends_enabled === false
    && admittedShape.limitation.test_payments_enabled === true);

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
  ok('Sunset protected door keeps authority server-owned', seenSunsetUpstream.body.allow_writes === false && !seenSunsetUpstream.body.simulator_write_mode);
  ok('Sunset protected door permits booking/payment/waiver Staff mutations', sunsetResult.limitation.booking_writes_enabled === true && sunsetResult.limitation.payments_enabled === true && sunsetResult.limitation.waiver_creation_enabled === true);

  ok('email simulator denies missing and production runtime profiles before author invocation',
    (await runLiveSimulatorEmail({ tenantId: 'sunset', fromAddress: 'guest@example.com', subject: 'Hi', bodyText: 'Hello' }, { env: {}, authorClient: { requestNaturalPlan: async () => { throw new Error('must_not_invoke'); } } })).code === 'email_simulator_not_available'
    && (await runLiveSimulatorEmail({ tenantId: 'sunset', fromAddress: 'guest@example.com', subject: 'Hi', bodyText: 'Hello' }, { env: { CROWSNEST_ENVIRONMENT: 'production' }, authorClient: { requestNaturalPlan: async () => { throw new Error('must_not_invoke'); } } })).code === 'email_simulator_not_available');

  process.env.CROWSNEST_AUTH_REQUIRED = 'true';
  process.env.CROWSNEST_ENVIRONMENT = 'staging';
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

    const unauthEmail = await requestJson(port, LIVE_SIMULATOR_EMAIL_ROUTE, {
      method: 'POST',
      body: { tenant: 'sunset', from_address: 'guest@example.com', subject: 'Hi', body_text: 'Hello' },
    });
    ok('email HTTP route requires authenticated operator', unauthEmail.status === 401);
    process.env.CROWSNEST_AUTH_REQUIRED = 'false';
    const authDisabledEmail = await requestJson(port, LIVE_SIMULATOR_EMAIL_ROUTE, {
      method: 'POST',
      body: { tenant: 'sunset', from_address: 'guest@example.com', subject: 'Hi', body_text: 'Hello' },
    });
    ok('email HTTP route stays unavailable when Crowsnest auth is disabled', authDisabledEmail.status === 404 && authDisabledEmail.json.code === 'email_simulator_not_available');
    process.env.CROWSNEST_AUTH_REQUIRED = 'true';
    const authedEmail = await requestJson(port, LIVE_SIMULATOR_EMAIL_ROUTE, {
      method: 'POST',
      headers: { Cookie: `${CROWSNEST_SESSION_COOKIE}=${encodeURIComponent(sessionToken)}` },
      body: { tenant: 'sunset', from_address: 'guest@example.com', subject: 'Hi', body_text: 'Hello' },
    });
    ok('email HTTP route fails closed when same-Luna author is unconfigured', authedEmail.status === 503 && authedEmail.json.code === 'email_author_unavailable');
  } finally {
    await close(server);
  }


  const repoRoot = path.resolve(__dirname, '..');
  const pageSrc = fs.readFileSync(path.join(repoRoot, 'scripts/lib/crowsnest/crowsnest-page.js'), 'utf8');
  ok('Live Simulator UI exposes WhatsApp and Email channel doors', /option value="whatsapp">WhatsApp/.test(pageSrc) && /option value="email">Email/.test(pageSrc));
  ok('channel-specific controls are actually hidden despite grid label styles', /live-simulator-toolbar \[hidden\],\.live-simulator-composer \[hidden\]\{display:none!important\}/.test(pageSrc));
  ok('email UI posts sender, subject, and body to the dedicated route', pageSrc.includes("'/api/live-simulator/email'") && pageSrc.includes('from_address: emailFrom.value') && pageSrc.includes('subject: emailSubject.value') && pageSrc.includes('body_text: draftText'));
  ok('email UI visibly marks replies not sent and new conversation', pageSrc.includes('Email reply · Not sent') && pageSrc.includes('New email conversation') && pageSrc.includes('emailConversationSequence += 1') && pageSrc.includes("Conversation ' + (data.conversation_id"));
  ok('email UI fails closed on every safety-critical author response flag',
    pageSrc.includes("data.delivery_status === 'not_sent'")
      && pageSrc.includes('data.draft_only === true')
      && pageSrc.includes('data.send_allowed === false')
      && pageSrc.includes('data.auto_send_allowed === false')
      && pageSrc.includes('data.writes_allowed === false')
      && pageSrc.includes('data.limitation.inbox_mirror_created === false')
      && pageSrc.includes('data.limitation.graph_enabled === false')
      && pageSrc.includes('data.limitation.gmail_enabled === false')
      && pageSrc.includes('data.limitation.imap_enabled === false')
      && pageSrc.includes('data.limitation.smtp_enabled === false')
      && pageSrc.includes('data.limitation.external_email_transport_enabled === false')
      && pageSrc.includes('data.limitation.booking_writes_enabled === false')
      && pageSrc.includes('data.limitation.payment_writes_enabled === false')
      && pageSrc.includes('data.limitation.waiver_writes_enabled === false')
      && pageSrc.includes('Email simulator rejected an unsafe or malformed reply'));
  ok('email UI states transport and Inbox fences', /Graph, Gmail, IMAP, and SMTP stay off/.test(pageSrc) && /Email creates no Inbox mirror/.test(pageSrc));
  const guardSrc = fs.readFileSync(path.join(repoRoot, 'docker/hermes-staging/wolfhouse/simulate_write_guards.py'), 'utf8');
  const coreSrc = fs.readFileSync(path.join(repoRoot, 'docker/hermes-staging/wolfhouse/simulate_core.py'), 'utf8');
  const pluginSrc = fs.readFileSync(path.join(repoRoot, 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'), 'utf8');
  ok('booking-only guard requires BOT_BOOKING_ENABLED or isolated SUNSET_SIMULATOR_BOOKING_ENABLED gate', /simulator_booking_flag = os\.getenv\("BOT_BOOKING_ENABLED"\) == "true" or os\.getenv\("SUNSET_SIMULATOR_BOOKING_ENABLED"\) == "true"/.test(guardSrc));
  ok('booking-only guard allows only existing sunset booking-create path', /if "sunset\/booking-create" in norm:[\s\S]*allowed_sunset_booking_only_write_in_simulate/.test(guardSrc));
  ok('isolated guard explicitly permits scoped payment/status/waiver paths', /allowed_sunset_isolated_test_payment/.test(guardSrc) && /allowed_sunset_isolated_payment_status/.test(guardSrc) && /allowed_sunset_isolated_waiver/.test(guardSrc));
  ok('isolated booking passes Staff API simulator booking-only flag', /allowed_sunset_isolated_booking[\s\S]*body\["simulator_booking_only_mode"\] = True/.test(guardSrc));
  ok('simulate route owns permanent write denial', /allow_writes=False/.test(coreSrc) && /booking_only_mode=""/.test(coreSrc) && /crowsnest_guest_door_never_accepts_write_authority/.test(coreSrc));
  ok('Sunset booking tool restores payment follow-up in isolated mode', /WOLFHOUSE_SIMULATE_ISOLATED_WRITES/.test(pluginSrc) && /create_sunset_payment_link/.test(pluginSrc));

  console.log('\nverify:crowsnest-live-simulator passed');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
