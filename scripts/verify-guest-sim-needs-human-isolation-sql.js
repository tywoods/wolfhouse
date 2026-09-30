'use strict';
/** Offline handler -> real resolver/pause/handoff SQL -> in-memory PGlite.
 * No server/auth bootstrap or live credentials. Notification boundary is a spy;
 * zero calls proves suppression, not delivery. Supporting schema is bounded.
 * Run: node scripts/verify-guest-sim-needs-human-isolation-sql.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { PGlite } = require('@electric-sql/pglite');
const evidence = { cases: [], network_attempts: [], sql_errors: [] };
const forbidden = name => () => {
  evidence.network_attempts.push(name);
  throw new Error(`NETWORK FORBIDDEN: ${name}`);
};
globalThis.fetch = forbidden('fetch');
for (const name of ['node:http', 'node:https']) {
  for (const method of ['request', 'get', 'createServer']) require(name)[method] = forbidden(`${name}.${method}`);
}
const net = require('node:net');
net.connect = net.createConnection = forbidden('net.connect');
net.Socket.prototype.connect = forbidden('Socket.connect');
net.Server.prototype.listen = forbidden('Server.listen');
require('node:tls').connect = forbidden('tls.connect');
require('node:dgram').createSocket = forbidden('dgram.createSocket');

const SYN = '20000000-0000-4000-8000-000000000001';
const ORD = '20000000-0000-4000-8000-000000000002';
const OTHER = '20000000-0000-4000-8000-000000000003';
const PHONE = '+999' + '123' + '456789012';
const ORD_PHONE = '+34' + '6' + '456789012';
const PAYLOAD = {
  client_slug: 'wolfhouse-somo', phone: PHONE, guest_phone: PHONE,
  simulator_synthetic: true, source_owner: 'crowsnest-guest-door',
  suppress_notifications: true, suppress_approvals: true,
  wolfhouse_staging_capability: 'wolfhouse_staging_booking_test_link',
  reason: 'human_requested',
};
const ENV = {
  DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
  PUBLIC_PAYMENT_BASE_URL: 'https://staff-staging.lunafrontdesk.com',
  STRIPE_SECRET_KEY: 'sk_test_offline_fixture', BOT_BOOKING_ENABLED: 'true',
};
const META = { simulator_synthetic: true, source_owner: 'crowsnest-guest-door', suppress_notifications: true, preserve_me: true };

async function main() {
  const db = new PGlite();
  let sql = [], notifications = [], afterExactLookup = null;
  const isolatedProcess = { env: { ...ENV } };
  const ownerPath = path.join(__dirname, 'lib/luna-guest-handoff-persist.js');
  const ownerRequire = createRequire(ownerPath);
  const ownerModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(ownerPath, 'utf8'), {
    module: ownerModule, exports: ownerModule.exports, process: isolatedProcess, console,
    require(name) {
      if (name !== './staff-whatsapp-notifications') return ownerRequire(name);
      return {
        extractLocationFromMetadata: ownerRequire(name).extractLocationFromMetadata,
        maybeNotifyHumanNeeded: async (_pg, _env, event) => {
          notifications.push(event);
          return { skipped: true, reason: 'offline_notification_boundary' };
        },
      };
    },
  }, { filename: ownerPath });
  const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  const start = api.indexOf('async function handleBotConversationNeedsHuman(');
  const end = api.indexOf('\n}\n', start) + 2;
  assert(start >= 0 && end > start, 'bounded verbatim handler extraction');
  const routeStart = api.indexOf("if (pathname === '/staff/bot/conversation/needs-human')");
  assert(routeStart >= 0, 'actual singular route exists');
  const route = api.slice(routeStart, api.indexOf('\n  }', routeStart) + 4);
  assert(route.includes('dispatchBotRouteBoundToPrincipalTenant'), 'route binds principal tenant');
  assert(route.includes('handleBotConversationNeedsHuman(req, res, user, authMode)'), 'route invokes extracted handler');
  const constants = ['UUID_RE', 'UUID_VALIDATE_RE', 'SQL_INJECT_RE'].map(name => {
    const match = api.match(new RegExp(`^const ${name} = (.+);$`, 'm'));
    assert(match, name);
    return match[0];
  }).join('\n');
  const pg = { async query(text, params) {
    sql.push({ text, params });
    try {
      const result = await db.query(text, params);
      if (afterExactLookup && text.trim().startsWith('SELECT') && text.includes('conv.phone = $2')) {
        const hook = afterExactLookup;
        afterExactLookup = null;
        await hook();
      }
      return result;
    }
    catch (error) { evidence.sql_errors.push({ text, error: error.message }); throw error; }
  } };
  const context = {
    process: isolatedProcess,
    readBody: async req => req.rawBody,
    sendJSON: (res, status, body) => Object.assign(res, { status, body }),
    send400: (res, error) => Object.assign(res, { status: 400, body: { success: false, error } }),
    resolveBotHandlerTrustedClientSlug: require('./lib/staff-bot-request-tenant-bind').resolveBotHandlerTrustedClientSlug,
    DEFAULT_CLIENT: 'must-not-default',
    withPgClient: async fn => fn(pg),
    resolveAndMarkConversationNeedsHuman: ownerModule.exports.resolveAndMarkConversationNeedsHuman,
    getPauseState: require('./lib/staff-bot-pause-sql').getPauseState,
    formatPauseStateRow: require('./lib/staff-bot-pause-sql').formatPauseStateRow,
  };
  vm.runInNewContext(`${constants}\n${api.slice(start, end)}\nthis.handler = handleBotConversationNeedsHuman;`, context);
  const gateStart = api.indexOf('async function checkGuestAutomationPauseState(');
  const gateEnd = api.indexOf('\n}\n', gateStart) + 2;
  assert(gateStart >= 0 && gateEnd > gateStart, 'verbatim effective gate extraction');
  vm.runInNewContext(`${api.slice(gateStart, gateEnd)}\nthis.gate = checkGuestAutomationPauseState;`, context);
  const snapshot = async () => ({
    conversations: (await db.query('SELECT * FROM conversations ORDER BY id')).rows,
    pauses: (await db.query('SELECT * FROM bot_pause_states ORDER BY id')).rows,
    handoffs: (await db.query('SELECT * FROM staff_handoffs ORDER BY id')).rows,
  });
  const call = async (payload = PAYLOAD, trusted = 'wolfhouse-somo') => {
    const res = {};
    await context.handler({ rawBody: JSON.stringify(payload), _botBoundClientSlug: trusted }, res, null, 'offline-bound-principal');
    return JSON.parse(JSON.stringify(res));
  };
  const reset = async () => {
    await db.exec('TRUNCATE staff_handoffs, bot_pause_states, conversations;');
    for (const [id, slug, phone, meta, updated] of [
      [SYN, 'wolfhouse-somo', PHONE, META, '2026-01-01'],
      [ORD, 'wolfhouse-somo', ORD_PHONE, { ordinary: true }, '2026-02-01'],
      [OTHER, 'sunset', PHONE, META, '2026-03-01'],
    ]) {
      await db.query(`INSERT INTO conversations (id, client_id, phone, metadata, updated_at)
        SELECT $1::uuid, id, $2, $3::jsonb, $4::timestamptz FROM clients WHERE slug=$5`,
      [id, phone, JSON.stringify(meta), updated, slug]);
    }
    isolatedProcess.env = { ...ENV };
    sql = []; notifications = []; afterExactLookup = null;
  };
  const test = async (name, fn) => {
    await reset();
    const before = await snapshot();
    const record = { name, before };
    evidence.cases.push(record);
    try {
      await fn(before);
      record.pass = true;
      console.log(`PASS ${name}`);
    } catch (err) {
      record.pass = false; record.error = err.stack;
      console.error(`FAIL ${name}: ${err.message}`);
      process.exitCode = 1;
    } finally {
      record.after = await snapshot(); record.sql = sql; record.notifications = notifications;
    }
  };
  try {
    await db.exec(`
      CREATE TABLE clients (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, settings jsonb DEFAULT '{}'::jsonb);
      CREATE TABLE conversations (
        id uuid PRIMARY KEY, client_id uuid REFERENCES clients(id), phone text, display_name text,
        needs_human boolean NOT NULL DEFAULT false, needs_human_transition_id uuid,
        metadata jsonb DEFAULT '{}'::jsonb, updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE staff_handoffs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid REFERENCES clients(id),
        conversation_id uuid REFERENCES conversations(id), phone text, source_channel text,
        reason_code text, summary text, status text, metadata jsonb DEFAULT '{}'::jsonb,
        opened_at timestamptz DEFAULT now()
      );
      CREATE TABLE bot_pause_states (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_slug text, guest_phone text,
        conversation_id text, booking_id uuid, booking_code text, paused boolean,
        pause_reason text, paused_by text, paused_at timestamptz, resumed_by text,
        resumed_at timestamptz, metadata jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      );
      INSERT INTO clients (id, slug) VALUES
        ('10000000-0000-4000-8000-000000000001', 'wolfhouse-somo'),
        ('10000000-0000-4000-8000-000000000002', 'sunset');
    `);
    await test('exact synthetic row wins over newer ordinary last9 collision', async before => {
      const res = await call();
      assert.equal(res.status, 200);
      assert.equal(res.body.conversation_id, SYN, 'ordinary last9 collision must not win');
      const after = await snapshot();
      assert.deepEqual(after.conversations.filter(r => r.id !== SYN), before.conversations.filter(r => r.id !== SYN));
      assert.equal(after.conversations.find(r => r.id === SYN).needs_human, true);
      assert.equal(after.conversations.find(r => r.id === SYN).metadata.preserve_me, true);
      assert.deepEqual(after.pauses.map(r => [r.conversation_id, r.guest_phone]), [[SYN, PHONE]]);
      assert.deepEqual(after.handoffs.map(r => [r.conversation_id, r.phone]), [[SYN, PHONE]]);
    });
    await test('scoped simulator never calls the notification dispatcher', async () => {
      const first = await call();
      assert.equal(first.status, 200);
      assert.equal(notifications.length, 0, 'suppression must survive handler and resolver');
      const beforeRepeat = await snapshot();
      const second = await call();
      assert.equal(second.status, 200);
      assert.deepEqual(await snapshot(), beforeRepeat, 'repeat is idempotent');
      assert.equal(notifications.length, 0);
    });
    await test('missing synthetic row cannot fall back to ordinary last9', async () => {
      await db.query('DELETE FROM conversations WHERE id=$1::uuid', [SYN]);
      const before = await snapshot();
      const res = await call();
      assert.equal(res.status, 404);
      assert.deepEqual(res.body.blocked_reasons, ['synthetic_conversation_not_found']);
      assert.deepEqual(await snapshot(), before);
      assert.equal(notifications.length, 0);
    });
    await test('identity changed after exact lookup cannot be mutated by UUID', async () => {
      let afterRace;
      afterExactLookup = async () => {
        await db.query("UPDATE conversations SET phone=$2, metadata='{}'::jsonb WHERE id=$1::uuid", [SYN, ORD_PHONE]);
        afterRace = await snapshot();
      };
      const res = await call();
      assert.equal(res.status, 404, 'UPDATE and idempotent read must recheck exact identity');
      assert.deepEqual(await snapshot(), afterRace);
      assert.equal(notifications.length, 0);
    });
    const denied = [
      ['foreign trusted tenant', {}, {}, 'sunset'],
      ['foreign deployment tenant', {}, { DEFAULT_CLIENT_SLUG: 'sunset' }],
      ['missing staging origin', {}, { PUBLIC_PAYMENT_BASE_URL: '' }],
      ['live destination', {}, { PUBLIC_PAYMENT_BASE_URL: 'https://staff.lunafrontdesk.com' }],
      ['live Stripe key', {}, { STRIPE_SECRET_KEY: 'sk_' + 'live_offline_fixture' }],
      ['live Stripe mode overrides test key', {}, { STRIPE_MODE: 'live' }],
      ['conflicting live Stripe mode', {}, { WOLFHOUSE_STRIPE_MODE: 'test', STRIPE_MODE: 'live' }],
      ['missing test payment config', {}, { STRIPE_SECRET_KEY: '' }],
      ['missing capability', { wolfhouse_staging_capability: undefined }],
      ['wrong capability', { wolfhouse_staging_capability: 'wrong' }],
      ['missing simulator provenance', { simulator_synthetic: undefined }],
      ['string simulator provenance', { simulator_synthetic: 'true' }],
      ['wrong source owner', { source_owner: 'model' }],
      ['missing notification suppression', { suppress_notifications: undefined }],
      ['false notification suppression', { suppress_notifications: false }],
      ['live identity', { phone: ORD_PHONE, guest_phone: ORD_PHONE }],
      ['malformed synthetic identity', { phone: PHONE + 'x', guest_phone: PHONE + 'x' }],
      ['short synthetic identity', { phone: '+999123', guest_phone: '+999123' }],
      ['formatted synthetic identity', { phone: ' ' + PHONE, guest_phone: ' ' + PHONE }],
      ['mismatched aliases', { guest_phone: ORD_PHONE }],
      ['ordinary UUID bypass', { conversation_id: ORD }],
      ['malformed UUID must not be discarded', { conversation_id: 'not-a-uuid' }],
    ];
    for (const [name, payload, env, tenant] of denied) {
      await test(`reject ${name} without writes or notifications`, async before => {
        Object.assign(isolatedProcess.env, env);
        const res = await call({ ...PAYLOAD, ...payload }, tenant);
        assert.equal(res.status, 403, JSON.stringify(res));
        assert.deepEqual(await snapshot(), before);
        assert.equal(notifications.length, 0);
        assert.equal(sql.length, 0, 'invalid scope rejected before SQL');
      });
    }
    for (const [name, payload] of [
      ['stripped provenance', { phone: PHONE }],
      ['suppression-only synthetic', { phone: PHONE, suppress_notifications: true }],
      ['stripped provenance UUID override', { phone: PHONE, conversation_id: ORD }],
      ['hidden synthetic alias', { phone: ORD_PHONE, guest_phone: PHONE }],
      ['partial suppression-only scope', { phone: ORD_PHONE, suppress_notifications: true }],
      ['partial approvals-only scope', { phone: ORD_PHONE, suppress_approvals: true }],
    ]) {
      await test(`reject ${name} before SQL`, async before => {
        const res = await call(payload);
        assert.equal(res.status, 403);
        assert.deepEqual(await snapshot(), before);
        assert.equal(notifications.length, 0);
        assert.equal(sql.length, 0);
      });
    }
    await test('ordinary handoff cannot select a newer synthetic suffix row', async () => {
      assert.equal((await call()).status, 200);
      const res = await call({ phone: ORD_PHONE });
      assert.equal(res.status, 200);
      assert.equal(res.body.conversation_id, ORD);
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].conversation_id, ORD);
    });
    await test('unscoped synthetic UUID cannot mutate or dispatch', async before => {
      const res = await call({ conversation_id: SYN });
      assert.equal(res.status, 404);
      assert.deepEqual(await snapshot(), before);
      assert.equal(notifications.length, 0);
    });
    await test('ordinary phone preserves newest last9 resolution and notifications', async before => {
      const res = await call({ phone: '+34 ' + '6456789012', reason: 'human_requested' });
      assert.equal(res.status, 200);
      assert.equal(res.body.conversation_id, ORD);
      assert.equal(res.body.conversation_paused, true);
      const after = await snapshot();
      assert.deepEqual(after.conversations.filter(r => r.id !== ORD), before.conversations.filter(r => r.id !== ORD));
      assert.deepEqual(after.pauses.map(r => r.conversation_id), [ORD]);
      assert.deepEqual(after.handoffs.map(r => r.conversation_id), [ORD]);
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].conversation_id, ORD);
    });
    await test('ordinary UUID priority and malformed UUID phone fallback remain', async () => {
      const first = await call({ conversation_id: ORD, phone: '+44111111111' });
      assert.equal(first.status, 200);
      assert.equal(first.body.conversation_id, ORD);
      const beforeRepeat = await snapshot();
      const second = await call({ conversation_id: 'not-a-uuid', guest_phone: ORD_PHONE });
      assert.equal(second.status, 200);
      assert.equal(second.body.conversation_id, ORD);
      assert.deepEqual(await snapshot(), beforeRepeat);
      assert.equal(notifications.length, 1);
    });
    await test('ordinary Sunset handoff still not coupled to pause', async before => {
      const res = await call({ conversation_id: OTHER }, 'sunset');
      assert.equal(res.status, 200);
      assert.equal(res.body.conversation_id, OTHER);
      assert.equal(res.body.conversation_paused, false);
      const after = await snapshot();
      assert.deepEqual(after.conversations.filter(r => r.id !== OTHER), before.conversations.filter(r => r.id !== OTHER));
      assert.deepEqual(after.pauses, []);
      assert.equal(notifications.length, 1);
    });
    for (const [name, replacement] of [
      ['ordinary metadata', {}],
      ['foreign source owner', { simulator_synthetic: true, source_owner: 'ordinary-import' }],
    ]) {
      await test(`same exact phone with ${name} is not a simulator identity`, async () => {
        await db.query('UPDATE conversations SET metadata=$2::jsonb WHERE id=$1::uuid', [SYN, JSON.stringify(replacement)]);
        const before = await snapshot();
        assert.equal((await call()).status, 404);
        assert.deepEqual(await snapshot(), before);
        assert.equal(notifications.length, 0);
      });
    }
    await test('ordinary pause read cannot inherit synthetic last9 pause', async () => {
      assert.equal((await call()).status, 200);
      const { getPauseState } = require('./lib/staff-bot-pause-sql');
      const ordinary = await getPauseState(pg, { client_slug: 'wolfhouse-somo', guest_phone: ORD_PHONE });
      assert.equal(ordinary.row, null, 'ordinary guest must remain active');
      const synthetic = await getPauseState(pg, { client_slug: 'wolfhouse-somo', guest_phone: PHONE });
      assert.equal(synthetic.row.conversation_id, SYN, 'synthetic guest remains paused');
    });
    await test('synthetic pause read cannot inherit ordinary last9 pause', async () => {
      assert.equal((await call({ conversation_id: ORD })).status, 200);
      const { getPauseState } = require('./lib/staff-bot-pause-sql');
      const synthetic = await getPauseState(pg, { client_slug: 'wolfhouse-somo', guest_phone: PHONE });
      assert.equal(synthetic.row, null);
      const ordinarySuffix = await getPauseState(pg, { client_slug: 'wolfhouse-somo', guest_phone: '+44' + ORD_PHONE.slice(-9) });
      assert.equal(ordinarySuffix.row.conversation_id, ORD, 'ordinary suffix matching remains');
    });
    await test('effective automation gate cannot inherit synthetic Needs Human fallback', async () => {
      assert.equal((await call()).status, 200);
      const ordinary = await context.gate(pg, { client_slug: 'wolfhouse-somo', guest_phone: ORD_PHONE });
      assert.equal(ordinary.bot_paused, false);
      assert.equal(ordinary.live_send_blocked, false);
      assert.equal(ordinary.needs_human, false);
      const synthetic = await context.gate(pg, { client_slug: 'wolfhouse-somo', guest_phone: PHONE });
      assert.equal(synthetic.bot_paused, true);
      await db.exec('TRUNCATE bot_pause_states');
      const fallback = await context.gate(pg, { client_slug: 'wolfhouse-somo', guest_phone: PHONE });
      assert.equal(fallback.needs_human, true);
      assert.equal(fallback.conversation_id, SYN);
    });
    await test('effective synthetic gate cannot inherit ordinary Needs Human fallback', async () => {
      assert.equal((await call({ conversation_id: ORD })).status, 200);
      const synthetic = await context.gate(pg, { client_slug: 'wolfhouse-somo', guest_phone: PHONE });
      assert.equal(synthetic.bot_paused, false);
      assert.equal(synthetic.needs_human, false);
      await db.exec('TRUNCATE bot_pause_states');
      const ordinary = await context.gate(pg, { client_slug: 'wolfhouse-somo', guest_phone: '+44' + ORD_PHONE.slice(-9) });
      assert.equal(ordinary.needs_human, true);
      assert.equal(ordinary.conversation_id, ORD);
    });
    assert.deepEqual(evidence.sql_errors, [], 'no swallowed owner SQL errors');
    assert.deepEqual(evidence.network_attempts, [], 'no network attempted');
  } finally {
    await db.close();
    if (process.env.GUEST_SIM_SQL_EVIDENCE) fs.writeFileSync(process.env.GUEST_SIM_SQL_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n');
  }
}
main().then(() => {
  process.exitCode = evidence.cases.some(test => test.pass !== true) ? 1 : 0;
}).catch(err => { console.error(err.stack); process.exitCode = 1; });
