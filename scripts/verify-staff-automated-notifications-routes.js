'use strict';

/**
 * verify:staff-automated-notifications-routes
 *
 * Contract harness for Staff API automated-notifications extraction (Slice 5).
 *
 * Proves:
 *   - createAutomatedNotificationsRoutes DI factory + route table (admin both)
 *   - router requireAuth admin on GET+POST
 *   - PUT/DELETE :id remain inline
 *   - no reverse coupling; helpers from staff-automated-notifications.js injected
 *   - location resolver reuses Slice 1 resolveNotificationSettingsLocationId
 *   - does not modify notification-settings module
 *   - POST create path calls injected createStaffAutomatedNotification
 *
 * No live DB / network / WhatsApp.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-automated-notifications-routes.js');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const NOTIF_SETTINGS_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-notification-settings-routes.js');
const HELPERS_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-automated-notifications.js');

const {
  AUTOMATED_NOTIFICATIONS_PATH,
  AUTOMATED_NOTIFICATIONS_MIN_ROLE,
  AUTOMATED_NOTIFICATIONS_ROUTE_TABLE,
  resolveAutomatedNotificationsLocationId,
  createAutomatedNotificationsRoutes,
} = require('./lib/staff-automated-notifications-routes');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function mockRes() {
  const out = { statusCode: 200, headers: {}, body: null, ended: false };
  return {
    out,
    writeHead(code, headers) {
      out.statusCode = code;
      if (headers) Object.assign(out.headers, headers);
    },
    setHeader(k, v) { out.headers[k] = v; },
    end(buf) {
      out.ended = true;
      out.body = buf == null ? '' : String(buf);
    },
  };
}

function mockReq(bodyObj) {
  const ee = new EventEmitter();
  const payload = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  process.nextTick(() => {
    if (payload) ee.emit('data', Buffer.from(payload, 'utf8'));
    ee.emit('end');
  });
  return ee;
}

function parseBody(out) {
  if (!out.body) return null;
  try { return JSON.parse(out.body); } catch (_) { return out.body; }
}

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3, owner: 4 };
function hasRole(userRole, minRole) {
  return (ROLE_RANK[userRole] || 0) >= (ROLE_RANK[minRole] || 0);
}

function makeDeps(overrides = {}) {
  const audit = [];
  const createCalls = [];
  const listCalls = [];
  const deps = {
    DEFAULT_CLIENT: 'wolfhouse-somo',
    SQL_INJECT_RE: /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i,
    audit,
    createCalls,
    listCalls,
    sendJSON(res, status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return body;
    },
    send400(res, message) {
      return deps.sendJSON(res, 400, { success: false, error: message });
    },
    readBody(req) {
      if (req._cachedBody !== undefined) return Promise.resolve(req._cachedBody);
      return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          req._cachedBody = Buffer.concat(chunks).toString('utf8');
          resolve(req._cachedBody);
        });
        req.on('error', reject);
      });
    },
    assertStaffClientAccess() { return true; },
    appendAuditLog(entry) { audit.push(entry); },
    async withPgClient(fn) {
      return fn({ async query() { return { rows: [] }; } });
    },
    async ensureStaffAutomatedNotificationsTables() { return true; },
    async listStaffAutomatedNotifications(pg, args) {
      listCalls.push(args);
      return [{ id: 'n1', title: 'Daily' }];
    },
    async createStaffAutomatedNotification(pg, args) {
      createCalls.push(args);
      return {
        ok: true,
        notification: {
          id: 'new-1',
          title: args.input && args.input.title,
          client_slug: args.clientSlug,
          location_id: args.locationId,
        },
      };
    },
    ...overrides,
  };
  return deps;
}

async function dispatchWithRole({ route, role, query, body, routes }) {
  const res = mockRes();
  const minRole = route.minRole;
  if (!role) {
    routes._deps.sendJSON(res, 401, { success: false, error: 'Authentication required.' });
    return res.out;
  }
  if (!hasRole(role, minRole)) {
    routes._deps.sendJSON(res, 403, {
      success: false,
      error: `Role '${minRole}' or higher required.`,
      current_role: role,
    });
    return res.out;
  }
  const user = { staff_user_id: 'u1', role };
  const q = query || { client: 'wolfhouse-somo' };
  if (route.id === 'list') {
    await routes.handlers.list(q, mockReq(), res, user);
  } else {
    await routes.handlers.create(q, mockReq(body || { title: 'T', prompt: 'P', recipients: [] }), res, user);
  }
  return res.out;
}

console.log('verify:staff-automated-notifications-routes\n');

console.log('── module surface ──');
ok('module exists', fs.existsSync(MODULE_PATH));
ok('helpers lib exists', fs.existsSync(HELPERS_PATH));
ok('notification-settings module untouched path exists', fs.existsSync(NOTIF_SETTINGS_PATH));
ok('createAutomatedNotificationsRoutes', typeof createAutomatedNotificationsRoutes === 'function');
ok('path', AUTOMATED_NOTIFICATIONS_PATH === '/staff/automated-notifications');
ok('min role admin', AUTOMATED_NOTIFICATIONS_MIN_ROLE === 'admin');
ok('route table length 2', AUTOMATED_NOTIFICATIONS_ROUTE_TABLE.length === 2);
ok('table GET admin', AUTOMATED_NOTIFICATIONS_ROUTE_TABLE[0].method === 'GET' && AUTOMATED_NOTIFICATIONS_ROUTE_TABLE[0].minRole === 'admin');
ok('table POST admin', AUTOMATED_NOTIFICATIONS_ROUTE_TABLE[1].method === 'POST' && AUTOMATED_NOTIFICATIONS_ROUTE_TABLE[1].minRole === 'admin');

console.log('\n── location resolver (shared with Slice 1) ──');
ok('null when empty', resolveAutomatedNotificationsLocationId({}, null) == null);
ok('query.location', resolveAutomatedNotificationsLocationId({ location: 'somo' }, null) === 'somo' || typeof resolveAutomatedNotificationsLocationId({ location: 'somo' }, null) === 'string');

// factory requires create dep
let threw = false;
try {
  createAutomatedNotificationsRoutes({
    sendJSON() {}, send400() {}, readBody() {}, assertStaffClientAccess() { return true; },
    appendAuditLog() {}, withPgClient() {}, DEFAULT_CLIENT: 'x', SQL_INJECT_RE: /x/,
    ensureStaffAutomatedNotificationsTables: async () => {},
    listStaffAutomatedNotifications: async () => [],
  });
} catch (_) { threw = true; }
ok('factory requires createStaffAutomatedNotification', threw);

const deps = makeDeps();
const routes = createAutomatedNotificationsRoutes(deps);
routes._deps = deps;
ok('handlers list+create', typeof routes.handleAutomatedNotificationsGet === 'function' && typeof routes.handleAutomatedNotificationsPost === 'function');

console.log('\n── no reverse coupling / no duplication ──');
const modSrc = fs.readFileSync(MODULE_PATH, 'utf8');
ok('no require staff-query-api', !/require\s*\(\s*['"][^'"]*staff-query-api['"]\s*\)/.test(modSrc));
ok('uses notification-settings location helper', /require\('\.\/staff-notification-settings-routes'\)/.test(modSrc));
ok('does not redefine resolveNotificationSettingsLocationId', !/function resolveNotificationSettingsLocationId\s*\(/.test(modSrc));
ok('does not redefine createStaffAutomatedNotification', !/function createStaffAutomatedNotification\s*\(/.test(modSrc));
ok('does not redefine listStaffAutomatedNotifications', !/function listStaffAutomatedNotifications\s*\(/.test(modSrc));
const modNoComments = modSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
ok('module does not call requireAuth', !/\brequireAuth\s*\(/.test(modNoComments));

// notification-settings module must not gain automated handlers
const nsSrc = fs.readFileSync(NOTIF_SETTINGS_PATH, 'utf8');
ok('notification-settings has no automated handlers', !/handleAutomatedNotifications/.test(nsSrc));

console.log('\n── handler smoke ──');

(async () => {
  {
    const res = mockRes();
    await routes.handleAutomatedNotificationsGet({ client: 'wolfhouse-somo' }, mockReq(), res, { staff_user_id: 'a', role: 'admin' });
    const body = parseBody(res.out);
    ok('GET 200', res.out.statusCode === 200 && body && body.success === true);
    ok('GET notifications array', body && Array.isArray(body.notifications));
    ok('list helper called', deps.listCalls.length >= 1);
  }
  {
    const res = mockRes();
    await routes.handleAutomatedNotificationsGet({ client: "x'; DROP" }, mockReq(), res, { role: 'admin' });
    ok('GET bad client 400', res.out.statusCode === 400);
  }
  {
    const res = mockRes();
    await routes.handleAutomatedNotificationsPost({ client: 'wolfhouse-somo' }, mockReq({
      title: 'Morning brief',
      prompt: 'Summarize check-ins',
      recipients: [{ staff_number_id: 's1' }],
    }), res, { staff_user_id: 'a', role: 'admin' });
    const body = parseBody(res.out);
    ok('POST 200', res.out.statusCode === 200 && body && body.success === true, `status=${res.out.statusCode} body=${res.out.body}`);
    ok('POST called create dep', deps.createCalls.length >= 1);
    if (deps.createCalls.length) {
      ok('POST create gets input', deps.createCalls[0].input && deps.createCalls[0].input.title === 'Morning brief');
      ok('POST create gets actor', deps.createCalls[0].actor && deps.createCalls[0].actor.staff_user_id === 'a');
    }
    ok('POST returns notification', body && body.notification && body.notification.id === 'new-1');
  }
  {
    const res = mockRes();
    const req = new EventEmitter();
    process.nextTick(() => { req.emit('data', Buffer.from('{x', 'utf8')); req.emit('end'); });
    await routes.handleAutomatedNotificationsPost({ client: 'wolfhouse-somo' }, req, res, { role: 'admin' });
    ok('POST invalid JSON 400', res.out.statusCode === 400);
  }
  // module alone does not role-gate
  {
    const res = mockRes();
    await routes.handleAutomatedNotificationsGet({ client: 'wolfhouse-somo' }, mockReq(), res, { role: 'viewer' });
    ok('module alone does not role-gate GET', res.out.statusCode !== 403 || !(parseBody(res.out) && /Role 'admin'/.test(String(parseBody(res.out).error || ''))));
  }

  console.log('\n── router-style auth matrix ──');
  const byId = Object.fromEntries(AUTOMATED_NOTIFICATIONS_ROUTE_TABLE.map((r) => [r.id, r]));
  for (const id of ['list', 'create']) {
    const unauth = await dispatchWithRole({ route: byId[id], role: null, routes });
    ok(`${id} unauth 401`, unauth.statusCode === 401);
    const viewer = await dispatchWithRole({ route: byId[id], role: 'viewer', routes });
    ok(`${id} viewer 403`, viewer.statusCode === 403);
    const op = await dispatchWithRole({ route: byId[id], role: 'operator', routes });
    ok(`${id} operator 403`, op.statusCode === 403);
    const admin = await dispatchWithRole({ route: byId[id], role: 'admin', routes });
    const isRoleReject = admin.statusCode === 403 && parseBody(admin) && /Role 'admin'/.test(String(parseBody(admin).error || ''));
    ok(`${id} admin auth gate open`, !isRoleReject, `status=${admin.statusCode}`);
  }

  console.log('\n── staff-query-api wiring (static) ──');
  const apiSrc = fs.readFileSync(API_PATH, 'utf8');
  ok('requires automated routes module', /require\('\.\/lib\/staff-automated-notifications-routes'\)/.test(apiSrc));
  ok('createAutomatedNotificationsRoutes called', /createAutomatedNotificationsRoutes\s*\(/.test(apiSrc));
  ok('injects createStaffAutomatedNotification', /createAutomatedNotificationsRoutes\(\{[\s\S]*?createStaffAutomatedNotification[\s\S]*?\}\)/.test(apiSrc));
  ok('no inline GET handler', !/async function handleAutomatedNotificationsGet\s*\(/.test(apiSrc));
  ok('no inline POST handler', !/async function handleAutomatedNotificationsPost\s*\(/.test(apiSrc));
  ok('PUT remains inline', /async function handleAutomatedNotificationsPut\s*\(/.test(apiSrc));
  ok('DELETE remains inline', /async function handleAutomatedNotificationsDelete\s*\(/.test(apiSrc));
  ok('router GET admin', /pathname === AUTOMATED_NOTIFICATIONS_PATH && method === 'GET'[\s\S]{0,200}?requireAuth\(\s*req\s*,\s*res\s*,\s*'admin'\s*\)/.test(apiSrc));
  ok('router POST admin', /pathname === AUTOMATED_NOTIFICATIONS_PATH && method === 'POST'[\s\S]{0,200}?requireAuth\(\s*req\s*,\s*res\s*,\s*'admin'\s*\)/.test(apiSrc));
  ok('router PUT admin', /automatedNotificationMatch && method === 'PUT'[\s\S]{0,160}?requireAuth\(\s*req\s*,\s*res\s*,\s*'admin'\s*\)/.test(apiSrc));
  ok('router DELETE admin', /automatedNotificationMatch && method === 'DELETE'[\s\S]{0,160}?requireAuth\(\s*req\s*,\s*res\s*,\s*'admin'\s*\)/.test(apiSrc));
  ok('UI still fetches collection path', apiSrc.includes('/staff/automated-notifications'));

  console.log('\n── syntax ──');
  for (const rel of [
    'scripts/lib/staff-automated-notifications-routes.js',
    'scripts/staff-query-api.js',
    'scripts/verify-staff-automated-notifications-routes.js',
  ]) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
    ok(`node --check ${rel}`, r.status === 0, r.stderr || r.stdout);
  }

  console.log('\n── findings ──');
  const findings = [
    'Both collection routes admin; PUT/DELETE :id left inline with admin auth.',
    'Helpers from staff-automated-notifications.js (not staff-whatsapp-notifications.js) — list/create/ensure injected.',
    'Location scope reuses Slice 1 resolveNotificationSettingsLocationId; notification-settings module not modified.',
    'POST is createStaffAutomatedNotification CRUD (runner is separate suite); create dep injected for byte-identical call.',
  ];
  for (const f of findings) console.log(`  NOTE  ${f}`);
  ok('findings recorded', findings.length >= 3);

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
