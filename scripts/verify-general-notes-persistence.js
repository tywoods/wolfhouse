'use strict';
// Actual Staff router/auth + real tenant-house-notes SQL in isolated disk PGlite.
// No listener, production credentials, model, guest transport, or model-reply claim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const OUT = path.resolve(process.argv[2] || 'artifacts/general-notes-persistence');

async function createHarness(out = OUT) {
  fs.mkdirSync(out, { recursive: true });
  for (const k of Object.keys(process.env)) {
    if (/^(STAFF_|LUNA_|STRIPE_|BOT_|META_|WHATSAPP_|PG|DATABASE_)/.test(k)) delete process.env[k];
  }
  const token = ['offline', 'general', 'notes', 'fixture', 'only'].join('-');
  Object.assign(process.env, {
    NODE_ENV: 'test', STAFF_RUNTIME_PROFILE: 'test',
    STAFF_API_FORTRESS_OFFLINE_LISTENER: '1', STAFF_AUTH_REQUIRED: 'true',
    STAFF_AUTH_HTTPS: 'false', DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
    LUNA_BOT_CLIENT_SLUG: 'wolfhouse-somo', LUNA_BOT_INTERNAL_TOKEN: token,
    STAFF_ACTIONS_ENABLED: 'false', BOT_BOOKING_ENABLED: 'false',
    STRIPE_LINKS_ENABLED: 'false', WHATSAPP_SEND_ENABLED: 'false',
  });
  const network = [], sql = [], calls = [];
  const deny = name => () => { network.push(name); throw new Error('NETWORK FORBIDDEN: ' + name); };
  globalThis.fetch = deny('fetch');
  for (const name of ['node:http', 'node:https']) {
    for (const method of ['request', 'get']) require(name)[method] = deny(name + '.' + method);
  }
  require('node:net').Socket.prototype.connect = deny('Socket.connect');
  require('node:net').Server.prototype.listen = deny('Server.listen');
  require('node:tls').connect = deny('tls.connect');
  require('node:dgram').createSocket = deny('dgram.createSocket');
  const dbPath = path.join(out, 'isolated-sql-' + randomUUID());
  let db = new PGlite(dbPath), session = null, failDb = false;
  const api = require('./staff-query-api');
  assert.equal(api.server.listening, false);
  // Authenticated-session seam, not a login/session-storage proof. Email-less
  // fixture owner follows existing unrestricted offline staff ACL semantics.
  const owner = { staff_user_id: '10000000-0000-4000-8000-000000000001', role: 'owner' };
  api.setFortress15j3OfflineSeams({
    resolveSessionUser: () => session,
    withPgClient: async fn => {
      if (failDb) throw new Error('offline injected SQL outage');
      return fn({ query: async (text, args) => {
        assert.match(text.trim(), /^(CREATE TABLE IF NOT EXISTS tenant_house_notes|SELECT|INSERT INTO tenant_house_notes)\b/i);
        sql.push({ text, args });
        return db.query(text, args);
      } });
    },
  });
  async function route(p) {
    assert(['/staff/admin/house-notes', '/staff/bot/house-info'].includes(p.path.split('?')[0]));
    session = p.session === 'owner' ? owner : p.session === 'viewer' ? { ...owner, role: 'viewer' }
      : p.session === 'denied' ? { ...owner, email: 'denied-notes-fixture@example.invalid' } : null;
    const raw = typeof p.body === 'string' ? p.body : JSON.stringify(p.body || {});
    const req = Readable.from([Buffer.from(raw)]);
    Object.assign(req, { method: p.method || 'POST', url: p.path, headers: { 'content-type': 'application/json' } });
    if (p.bot) req.headers['x-luna-bot-token'] = p.bot === 'valid' ? token : 'wrong-offline-token';
    const before = sql.length;
    let endResponse;
    const ended = new Promise(resolve => { endResponse = resolve; });
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; },
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
      end(rawBody) { this.body = JSON.parse(rawBody.toString()); this.writableEnded = true; endResponse(); },
    };
    await api.router(req, res); await ended;
    const result = { name: p.name, status: res.statusCode, body: res.body, sql_count: sql.length - before, request_bytes: Buffer.byteLength(raw) };
    calls.push(result); assert.equal(network.length, 0);
    return result;
  }
  return {
    route, async reopen() { await db.close(); db = new PGlite(dbPath); },
    outage(value) { failDb = value; },
    async snapshot() { return { rows: (await db.query('SELECT * FROM tenant_house_notes ORDER BY client_slug')).rows, sql, calls, network_attempts: network, listening: api.server.listening }; },
    async close() { api.setFortress15j3OfflineSeams(null); await db.close(); },
  };
}

async function main() {
  const h = await createHarness();
  const report = { notice: 'OFFLINE SYNTHETIC router/auth/SQL proof only; not model reply or live acceptance.', checks: [] };
  const check = (name, value) => { report.checks.push({ name, pass: !!value }); assert(value, name); console.log('PASS', name); };
  const endpoint = '/staff/admin/house-notes?client=wolfhouse-somo';
  const save = notes => h.route({ path: endpoint, session: 'owner', body: { notes } });
  const get = () => h.route({ path: endpoint, method: 'GET', session: 'owner' });
  try {
    const first = 'OFFLINE SYNTHETIC: Patio Azul opens at 08:17.\nCafé and towels.';
    check('ordinary save', (await save(first)).status === 200);
    await h.reopen(); check('disk close/reopen persists exact content', (await get()).body.notes === first);
    // Raw UTF-8 and JSON-escaped encodings must obey the text limit, not a lower byte cap.
    for (const [name, notes, escaped] of [
      ['ASCII limit', 'a'.repeat(8000), false],
      ['accented limit', 'é'.repeat(8000), false],
      ['supplementary-plane limit', '🟦'.repeat(4000), false],
      ['escaped BMP limit', '字'.repeat(8000), true],
      ['quote/backslash limit', '\\"'.repeat(4000), false],
    ]) {
      const body = escaped ? '{"notes":"' + '\\u5b57'.repeat(8000) + '"}' : { notes };
      const result = await h.route({ name, path: endpoint, session: 'owner', body });
      check(name + ' accepted', result.status === 200);
      check(name + ' saved exactly', (await get()).body.notes === notes);
      const bot = await h.route({ path: '/staff/bot/house-info', bot: 'valid' });
      check(name + ' reaches bot reader', bot.status === 200 && bot.body.notes === notes && bot.body.has_notes);
    }
    const second = 'OFFLINE SYNTHETIC: Patio Azul now opens at 09:43.';
    await save(second);
    for (const notes of ['x'.repeat(8001), '🟦'.repeat(4000) + 'x']) {
      check('over text limit rejected', (await save(notes)).status === 400);
      check('rejection preserves last saved value', (await get()).body.notes === second);
    }
    for (const [name, options, status] of [
      ['malformed JSON', { session: 'owner', body: '{broken' }, 400],
      ['over transport cap', { session: 'owner', body: { notes: 'x'.repeat(65536) } }, 400],
      ['anonymous GET', { method: 'GET' }, 401],
      ['anonymous POST', { body: { notes: 'bad' } }, 401],
      ['viewer POST', { session: 'viewer', body: { notes: 'bad' } }, 403],
      ['unadmitted email', { session: 'denied', body: { notes: 'bad' } }, 403],
    ]) {
      const r = await h.route({ path: endpoint, ...options });
      check(name + ' denied before SQL', r.status === status && r.sql_count === 0);
    }
    for (const [name, options, status] of [
      ['missing bot', {}, 401], ['wrong bot', { bot: 'wrong' }, 401],
      ['cross-tenant bot', { bot: 'valid', body: { client_slug: 'sunset' } }, 403],
    ]) {
      const r = await h.route({ path: '/staff/bot/house-info', ...options });
      check(name + ' denied before SQL', r.status === status && r.sql_count === 0);
    }
    await save(' \n ');
    check('staff whitespace preserved', (await get()).body.notes === ' \n ');
    const empty = await h.route({ path: '/staff/bot/house-info', bot: 'valid' });
    check('bot whitespace becomes successful empty', empty.body.success && !empty.body.has_notes && empty.body.notes === '');
    await save(second); h.outage(true);
    check('save outage fails', (await save('must not persist')).status === 500);
    check('read outage is not empty success', (await h.route({ path: '/staff/bot/house-info', bot: 'valid' })).status === 500);
    h.outage(false); check('outage preserves saved notes', (await get()).body.notes === second);
    report.passed = true;
  } finally {
    report.snapshot = await h.snapshot(); await h.close();
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
module.exports = { createHarness };
if (require.main === module) main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
