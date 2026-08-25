#!/usr/bin/env node
'use strict';

/**
 * EMAIL-SEND-COMPLETION vertical 1–2.
 *
 * Reproduce POST draft 404 through the production Staff API router and the
 * cooked Inbox owner. Isolate the exact boundary (gate vs unmatched path vs
 * missing authority vs CAS) and require phase-aware bounded copy.
 *
 * Incident class (log-supported pre-dispatch): Approve & send posts draft
 * first; 404; no approve-send follows. Do not loosen authority.
 */

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const STAFF = path.join(ROOT, 'scripts/staff-query-api.js');
const THREAD = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const ROUTES = path.join(ROOT, 'scripts/lib/staff-email-inbox-routes.js');
const {
  EMAIL_DRAFT_PATH,
  EMAIL_APPROVE_SEND_PATH,
  createStaffEmailInboxRoutes,
  snapshotGateEnv,
  snapshotEmailReplyBody,
} = require('./lib/staff-email-inbox-routes');

const ORIGIN = 'https://staff.sunset.test';
const C = '11111111-1111-4111-8111-111111111111';
const A = '55555555-5555-4555-8555-555555555555';
const V = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BODY = 'Staff reply body for Sunset guest.';
const SESSION = 'email-draft-404-offline-session';

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

try { require.resolve('dotenv'); } catch {
  const c = ['/opt/data/cursor-workspace/WH/node_modules', '/opt/data/wolfhouse-agent/node_modules', path.join(ROOT, 'node_modules')]
    .find((x) => { try { return fs.existsSync(path.join(x, 'dotenv')); } catch { return false; } });
  if (c) {
    process.env.NODE_PATH = c + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
    Module._initPaths();
  }
}

function user() {
  return {
    staff_user_id: A, email: 'op@t', role: 'operator', status: 'active',
    display_name: 'Op', client_id: C, client_slug: 'sunset', session_id: 's1',
  };
}
function enabledEnv(extra) {
  return Object.assign({
    EMAIL_STAFF_EMAIL_DRAFTS_ENABLED: 'true',
    EMAIL_STAFF_OUTBOUND_ENABLED: 'true',
    STAFF_PORTAL_ORIGIN: ORIGIN,
  }, extra || {});
}
function mockReq(body, headers) {
  const { EventEmitter } = require('node:events');
  const ee = new EventEmitter();
  const payload = JSON.stringify(body);
  Object.defineProperty(ee, 'headers', {
    value: Object.assign(Object.create(null), { 'content-type': 'application/json', origin: ORIGIN }, headers || {}),
    enumerable: true, writable: true,
  });
  process.nextTick(() => { ee.emit('data', Buffer.from(payload, 'utf8')); ee.emit('end'); });
  return ee;
}
function captureSend() {
  const calls = [];
  return {
    calls,
    sendJSON(res, status, body) { calls.push({ status, body }); },
  };
}
function dto(o) {
  return Object.assign({ conversation_id: V, message_text: BODY, approval_id: null }, o || {});
}

function loadCopyFns() {
  const src = fs.readFileSync(THREAD, 'utf8');
  const start = src.indexOf('function emailOwnData');
  const end = src.indexOf('function emailParseFetchJson');
  assert.ok(start > 0 && end > start, 'copy helpers present');
  const sandbox = { result: null };
  vm.runInNewContext(`${src.slice(start, end)}\nresult = { emailUiFailureCopy, emailOwnData };`, sandbox);
  return sandbox.result;
}

function clear() {
  for (const k of Object.keys(require.cache)) {
    if (/staff-query-api\.js$|staff-auth-config|staff-portal-clients|pg-connect|staff-email-inbox-routes/.test(k)) {
      delete require.cache[k];
    }
  }
}
function listen(s) {
  return new Promise((r, j) => { s.listen(0, '127.0.0.1', () => r(s.address().port)); s.on('error', j); });
}
function close(s) { return new Promise((r) => s.close(() => r())); }
function request(port, o) {
  return new Promise((resolve, reject) => {
    const payload = o.body == null ? null : Buffer.from(o.body);
    const hdrs = Object.assign({}, o.headers || {});
    if (payload) hdrs['content-length'] = payload.length;
    const req = http.request({
      hostname: '127.0.0.1', port, path: o.path, method: o.method, headers: hdrs,
    }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let body = raw;
        try { body = JSON.parse(raw); } catch { /* raw */ }
        resolve({ status: res.statusCode, body, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function proveProductionRouter() {
  const script = `'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const ROOT = ${JSON.stringify(ROOT)};
const ORIGIN = ${JSON.stringify(ORIGIN)};
const C = ${JSON.stringify(C)};
const A = ${JSON.stringify(A)};
const V = ${JSON.stringify(V)};
const BODY = ${JSON.stringify(BODY)};
const DRAFT = ${JSON.stringify(EMAIL_DRAFT_PATH)};
const SESSION = ${JSON.stringify(SESSION)};
const STAFF = path.join(ROOT, 'scripts/staff-query-api.js');
try { require.resolve('dotenv'); } catch {
  const c = ['/opt/data/cursor-workspace/WH/node_modules','/opt/data/wolfhouse-agent/node_modules',path.join(ROOT,'node_modules')]
    .find((x)=>{ try { return fs.existsSync(path.join(x,'dotenv')); } catch { return false; } });
  if (c) { process.env.NODE_PATH = c + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : ''); Module._initPaths(); }
}
function clear() {
  for (const k of Object.keys(require.cache)) {
    if (/staff-query-api\\.js$|staff-auth-config|staff-portal-clients|pg-connect|staff-email-inbox-routes/.test(k)) delete require.cache[k];
  }
}
function listen(s) { return new Promise((r, j) => { s.listen(0, '127.0.0.1', () => r(s.address().port)); s.on('error', j); }); }
function close(s) { return new Promise((r) => s.close(() => r())); }
function request(port, o) {
  return new Promise((resolve, reject) => {
    const payload = o.body == null ? null : Buffer.from(o.body);
    const hdrs = Object.assign({}, o.headers || {});
    if (payload) hdrs['content-length'] = payload.length;
    const req = http.request({ hostname: '127.0.0.1', port, path: o.path, method: o.method, headers: hdrs }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8'); let body = raw; try { body = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body, raw });
      });
    });
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}
(async () => {
  process.env.NODE_ENV = 'test';
  process.env.STAFF_RUNTIME_PROFILE = 'test';
  process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = '1';
  process.env.STAFF_AUTH_REQUIRED = 'true';
  process.env.STAFF_AUTH_HTTPS = 'false';
  process.env.STAFF_QUERY_API_HOST = '127.0.0.1';
  process.env.STAFF_PORTAL_ORIGIN = ORIGIN;
  delete process.env.EMAIL_STAFF_EMAIL_DRAFTS_ENABLED;
  delete process.env.EMAIL_STAFF_OUTBOUND_ENABLED;
  clear();
  const api = require(STAFF);
  let dbCalls = 0;
  api.setFortress15j3OfflineSeams({
    withPgClient: async (fn) => { dbCalls += 1; return fn({ async query() { return { rows: [] }; } }); },
    resolveSessionUser(req) {
      const raw = String((req.headers && req.headers.cookie) || '');
      if (raw.includes(SESSION)) return { staff_user_id: A, email: 'op@t', role: 'operator', status: 'active', display_name: 'Op', client_id: C, client_slug: 'sunset', session_id: 's1' };
      return null;
    },
    canAccessClient(u, s) { return !!(u && u.client_slug === 'sunset' && s === 'sunset'); },
  });
  const server = api.createStaffQueryApiHttpServer();
  const port = await listen(server);
  try {
    const hdrs = { 'content-type': 'application/json', origin: ORIGIN, cookie: 'luna_staff_session=' + SESSION };
    const body = JSON.stringify({ conversation_id: V, message_text: BODY, approval_id: null });
    let r = await request(port, { method: 'POST', path: '/staff/inbox/' + V + '/draft', headers: hdrs, body });
    assert.equal(r.status, 405);
    assert.equal(dbCalls, 0);
    r = await request(port, { method: 'POST', path: DRAFT, headers: hdrs, body });
    assert.equal(r.status, 404);
    assert.equal(r.body && r.body.error, 'email_drafts_unavailable');
    assert.equal(dbCalls, 0);
    assert.equal(String(r.raw).includes('Authentication required'), false);
    process.env.EMAIL_STAFF_EMAIL_DRAFTS_ENABLED = 'true';
    dbCalls = 0;
    r = await request(port, { method: 'POST', path: DRAFT, headers: hdrs, body });
    assert.equal(r.status, 404);
    assert.equal(r.body && r.body.error, 'not_found');
    assert.ok(dbCalls >= 1);
    console.log('router_boundary_ok');
  } finally {
    await close(server);
    api.setFortress15j3OfflineSeams(null);
    clear();
  }
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });`;
  const { spawnSync } = require('child_process');
  const out = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, NODE_PATH: process.env.NODE_PATH || '/opt/data/cursor-workspace/WH/node_modules' },
  });
  ok(
    'production router: unmatched /staff/inbox/:conversation/draft is 405 (not the cooked path); gate-off POST /staff/inbox/email/draft is 404 email_drafts_unavailable; missing authority stays not_found',
    out.status === 0 && /router_boundary_ok/.test(out.stdout),
    (out.stderr || out.stdout || '').slice(0, 600),
  );
}

function proveCookedOwnerPathsAndCopy() {
  const thread = fs.readFileSync(THREAD, 'utf8');
  const cookedHint = fs.readFileSync(path.join(ROOT, 'scripts/lib/inbox-browser-source.js'), 'utf8');
  ok('cooked Inbox owner posts /staff/inbox/email/draft not conversation-scoped path',
    thread.includes("fetch('/staff/inbox/email/draft'")
    && thread.includes("fetch('/staff/inbox/email/approve-send'")
    && !/\/staff\/inbox\/'\s*\+\s*/.test(thread)
    && cookedHint.includes('inbox-thread.js'));
  ok('Approve & send auto-saves draft first (pre-dispatch)',
    thread.includes('performEmailDraftSave(convId, targetEl, true)'));
  const copy = loadCopyFns();
  const planted = 'SENT token=secret SQL provider';
  ok('phase copy: drafts unavailable',
    copy.emailUiFailureCopy('draft', 404, { success: false, error: 'email_drafts_unavailable' })
      === 'Email drafting is unavailable.');
  ok('phase copy: missing conversation/authority',
    copy.emailUiFailureCopy('draft', 404, { success: false, error: 'not_found' })
      === 'Conversation unavailable');
  ok('phase copy: CAS/conflict reload',
    copy.emailUiFailureCopy('draft', 409, { success: false, error: 'approval_conflict' })
      === 'Conflict — reload and try again');
  ok('phase copy: staff replies disabled',
    copy.emailUiFailureCopy('approve', 503, { success: false, error: 'email_send_disabled' })
      === 'Staff email replies are currently disabled.');
  ok('phase copy: outcome unknown locks',
    copy.emailUiFailureCopy('approve', 503, { success: false, error: 'email_send_outcome_unknown' })
      === 'Send outcome is unknown. Reload this conversation — do not retry.');
  ok('phase copy never leaks planted internals',
    !String(copy.emailUiFailureCopy('draft', 404, { success: false, error: planted })).includes('token')
    && !String(copy.emailUiFailureCopy('draft', 500, { success: false, error: planted })).includes('SQL'));
  ok('404 with unknown error stays conversation unavailable (no leak)',
    copy.emailUiFailureCopy('draft', 404, { success: false, error: planted })
      === 'Conversation unavailable');
}

async function proveOwnerGateAndCasCodes() {
  const sendOff = captureSend();
  let dbHits = 0;
  await createStaffEmailInboxRoutes({
    sendJSON: sendOff.sendJSON,
    withPgClient: async () => { dbHits += 1; throw new Error('no db'); },
    runtimeEnv: {},
  }).handleDraft(mockReq(dto()), {}, user(), snapshotGateEnv({}));
  ok('owner gate-off draft 404 email_drafts_unavailable zero DB',
    sendOff.calls.length === 1
    && sendOff.calls[0].status === 404
    && sendOff.calls[0].body.error === 'email_drafts_unavailable'
    && dbHits === 0);

  const durable = new Map();
  const client = {
    async query(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n === 'BEGIN' || n === 'COMMIT' || n === 'ROLLBACK') return { rows: [] };
      if (/UNION ALL/i.test(n) && /staff_email_reply/.test(n)) return { rows: [] };
      if (/FROM clients cl/.test(n)) {
        return {
          rows: [{
            conversation_id: V, client_id: C, location_id: C, location_key: 'sunset-somo',
            endpoint_id: C, source_inbound_event_id: C, provider: 'microsoft_graph',
            provider_mailbox_id: '11111111-1111-4111-8111-111111111111',
            provider_source_message_id: 'src-1', endpoint_outbound_enabled: true,
            public_address: 'support@example.test', actor_staff_user_id: A,
          }],
        };
      }
      if (/^INSERT INTO tenant_email_reply_approvals/.test(n)) {
        const id = String(params[0]).toLowerCase();
        durable.set(id, { approval_id: id, conversation_id: V, message_text: params[11], state: 'draft' });
        return { rows: [{ approval_id: id, message_text: params[11], conversation_id: V }] };
      }
      if (/SET message_text/.test(n) && /state='draft'/.test(n)) return { rows: [] };
      throw new Error(`unexpected_sql:${n.slice(0, 80)}`);
    },
  };
  const send = captureSend();
  const routes = createStaffEmailInboxRoutes({
    sendJSON: send.sendJSON,
    withPgClient: async (fn) => fn(client),
    runtimeEnv: enabledEnv(),
  });
  const gate = snapshotGateEnv(enabledEnv());
  await routes.handleDraft(mockReq(dto()), {}, user(), gate);
  const ap = send.calls[0] && send.calls[0].body && send.calls[0].body.approval_id;
  send.calls.length = 0;
  await routes.handleDraft(mockReq(dto({ approval_id: ap, message_text: 'cas miss body' })), {}, user(), gate);
  ok('CAS miss is 409 conflict not 404',
    send.calls[0] && send.calls[0].status === 409
    && send.calls[0].body.error === 'approval_conflict');
}

async function proveCookedApproveClickStopsAtDraft404() {
  const thread = fs.readFileSync(THREAD, 'utf8');
  ok('cooked owner does not call approve-send unless draft receipt accepted',
    /if \(accepted\) \{[\s\S]*performEmailApproveSend\(convId, targetEl\)/.test(thread)
    && /showDraftSendStatus\(statusEl, 'error', emailUiFailureCopy\('draft', out\.status, out\.data\)\)/.test(thread));
}

async function main() {
  console.log('verify:email-draft-404-boundary\n');
  ok('draft path remains /staff/inbox/email/draft', EMAIL_DRAFT_PATH === '/staff/inbox/email/draft');
  ok('approve path remains /staff/inbox/email/approve-send', EMAIL_APPROVE_SEND_PATH === '/staff/inbox/email/approve-send');
  proveCookedOwnerPathsAndCopy();
  await proveOwnerGateAndCasCodes();
  await proveCookedApproveClickStopsAtDraft404();
  await proveProductionRouter();
  console.log(`\n── verify:email-draft-404-boundary ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
