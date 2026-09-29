'use strict';
/**
 * Bounded OFFLINE L2 proof. Run: node scripts/verify-luna-payment-failure-handoff-sql.js
 * Python's real payment wrappers -> real flag_needs_human -> urllib stdin bridge
 * -> verbatim Staff handler -> real resolver/pause owners -> isolated PGlite.
 * No server/router/auth bootstrap. Minimal supporting schema, NOT all migrations.
 * resolveAndMarkConversationNeedsHuman has no opts; only its notification
 * dependency is neutralized (not SQL, resolver, pause, or handler). No ack turn
 * or WhatsApp adapter is installed by Python. Notifications/delivery NOT proved.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ROOT = path.resolve(__dirname, '..');
const PYTHON = path.join(ROOT, 'docker/hermes-staging/plugins/wolfhouse_staff_api/test_payment_failure_handoff_sql.py');

if (!process.argv.includes('--bridge')) {
  const { spawnSync } = require('node:child_process');
  const child = spawnSync('python3', [PYTHON, '-v'], {
    cwd: ROOT, stdio: 'inherit', timeout: 120000,
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) =>
      ['PATH', 'HOME', 'LANG', 'NODE_PATH', 'LUNA_PAYMENT_SQL_EVIDENCE'].includes(k))),
  });
  if (child.error) console.error(child.error);
  process.exitCode = child.status === null ? 1 : child.status;
} else {
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}

async function main() {
  const networkAttempts = [];
  const forbidden = name => () => {
    networkAttempts.push(name);
    throw new Error(`NETWORK FORBIDDEN: ${name}`);
  };
  globalThis.fetch = forbidden('fetch');
  for (const moduleName of ['node:http', 'node:https']) {
    const mod = require(moduleName);
    for (const method of ['request', 'get', 'createServer']) mod[method] = forbidden(`${moduleName}.${method}`);
  }
  const net = require('node:net');
  net.connect = net.createConnection = forbidden('net.connect');
  net.Socket.prototype.connect = forbidden('Socket.connect');
  net.Server.prototype.listen = forbidden('Server.listen');
  require('node:tls').connect = forbidden('tls.connect');
  require('node:dgram').createSocket = forbidden('dgram.createSocket');

  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  const notifications = [];
  const sql = [], sqlErrors = [];
  const ownerPath = path.join(__dirname, 'lib/luna-guest-handoff-persist.js');
  const ownerRequire = createRequire(ownerPath);
  const ownerModule = { exports: {} };
  // Load the unmodified owner in a local CommonJS context. Only the outbound
  // notification dependency is replaced; skip_notify cannot pass the resolver.
  const notificationModule = ownerRequire('./staff-whatsapp-notifications');
  vm.runInNewContext(fs.readFileSync(ownerPath, 'utf8'), {
    module: ownerModule, exports: ownerModule.exports, process, console,
    require(name) {
      if (name !== './staff-whatsapp-notifications') return ownerRequire(name);
      return { ...notificationModule, maybeNotifyHumanNeeded: async (_pg, _env, event) => {
        notifications.push(event);
        return { skipped: true, reason: 'offline_notification_boundary' };
      } };
    },
  }, { filename: ownerPath });
  const apiSource = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  // Bound the extraction with the following top-level section; no rewritten body.
  const start = apiSource.indexOf('async function handleBotConversationNeedsHuman(');
  const end = apiSource.indexOf('\n}\n', start) + 2;
  assert(start >= 0 && end > start, 'Staff handler extraction anchors');
  const handlerSource = apiSource.slice(start, end);
  const constant = name => {
    const match = apiSource.match(new RegExp(`^const ${name} = (.+);$`, 'm'));
    assert(match, `missing ${name}`);
    return match[0];
  };
  let unavailable = false;
  const pg = { async query(text, params) {
    assert.match(text.trim(), /^(SELECT|UPDATE|INSERT)\b/i, 'only owner DML/reads');
    sql.push({ text, params });
    try { return await db.query(text, params); }
    catch (error) { sqlErrors.push({ message: error.message, text }); throw error; }
  } };
  const context = {
    readBody: async req => req.rawBody,
    sendJSON: (res, status, body) => Object.assign(res, { status, body }),
    send400: (res, error) => Object.assign(res, { status: 400, body: { success: false, error } }),
    resolveBotHandlerTrustedClientSlug: require('./lib/staff-bot-request-tenant-bind').resolveBotHandlerTrustedClientSlug,
    DEFAULT_CLIENT: 'must-not-default',
    withPgClient: async fn => {
      if (unavailable) throw new Error('offline injected database unavailable');
      return fn(pg);
    },
    resolveAndMarkConversationNeedsHuman: ownerModule.exports.resolveAndMarkConversationNeedsHuman,
  };
  vm.runInNewContext(`${constant('UUID_RE')}\n${constant('UUID_VALIDATE_RE')}\n${constant('SQL_INJECT_RE')}\n${handlerSource}\nthis.handler = handleBotConversationNeedsHuman;`, context);

  try {
    // Deliberately narrow supporting schema. All application queries execute
    // unchanged in PGlite; swallowed SQL errors are separately fatal in Python.
    await db.exec(`
      CREATE TABLE clients (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL);
      CREATE TABLE conversations (
        id uuid PRIMARY KEY, client_id uuid NOT NULL REFERENCES clients(id),
        phone text, display_name text, needs_human boolean NOT NULL DEFAULT false,
        needs_human_transition_id uuid, metadata jsonb DEFAULT '{}'::jsonb,
        updated_at timestamptz DEFAULT now()
      );
      CREATE TABLE staff_handoffs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid REFERENCES clients(id),
        conversation_id uuid REFERENCES conversations(id), phone text, source_channel text,
        reason_code text, summary text, status text, metadata jsonb DEFAULT '{}'::jsonb,
        opened_at timestamptz DEFAULT now()
      );
      CREATE TABLE bot_pause_states (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_slug text,
        guest_phone text, conversation_id text, booking_id uuid, booking_code text,
        paused boolean, pause_reason text, paused_by text, paused_at timestamptz,
        resumed_by text, resumed_at timestamptz, metadata jsonb,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
      );
      INSERT INTO clients VALUES
        ('10000000-0000-4000-8000-000000000001', 'sunset'),
        ('10000000-0000-4000-8000-000000000002', 'wolfhouse-somo');
    `);
    const snapshot = async () => ({
      conversations: (await db.query(`SELECT c.slug, conv.* FROM conversations conv
        JOIN clients c ON c.id=conv.client_id ORDER BY c.slug, conv.phone`)).rows,
      handoffs: (await db.query(`SELECT c.slug, h.* FROM staff_handoffs h
        JOIN clients c ON c.id=h.client_id ORDER BY c.slug, h.id`)).rows,
      pauses: (await db.query('SELECT * FROM bot_pause_states ORDER BY client_slug, id')).rows,
      sql: [...sql], sql_errors: [...sqlErrors],
      suppressed_notifications: [...notifications], network_attempts: [...networkAttempts],
    });
    const lines = require('node:readline').createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      let result;
      try {
        const message = JSON.parse(line);
        if (message.op === 'reset') {
          await db.exec('TRUNCATE staff_handoffs, bot_pause_states, conversations;');
          for (const [index, slug] of ['sunset', 'wolfhouse-somo'].entries()) {
            for (const [offset, phone] of ['+999' + '00000001', '+999' + '00000002'].entries()) {
              await db.query(`INSERT INTO conversations (id, client_id, phone, display_name, metadata)
                SELECT $1::uuid, id, $2, 'Offline synthetic guest', $3::jsonb FROM clients WHERE slug=$4`,
              [`20000000-0000-4000-8000-0000000000${index}${offset}`, phone,
                JSON.stringify({ fixture: `${slug}:${phone}`, preserve_me: true }), slug]);
            }
          }
          unavailable = false;
          notifications.length = sql.length = sqlErrors.length = 0;
          result = await snapshot();
        } else if (message.op === 'snapshot') {
          result = await snapshot();
        } else if (message.op === 'handoff') {
          assert(['sunset', 'wolfhouse-somo'].includes(message.trusted_client), 'explicit synthetic principal required');
          unavailable = message.unavailable === true;
          const res = {};
          await context.handler({ rawBody: message.raw_body,
            _botBoundClientSlug: message.trusted_client }, res, null, 'offline-bound-principal');
          result = res;
        } else throw new Error('Unknown bridge operation');
        assert.equal(networkAttempts.length, 0, 'network tripwire fired');
        process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n');
        process.exitCode = 1;
        break;
      }
    }
  } finally { await db.close(); }
}
