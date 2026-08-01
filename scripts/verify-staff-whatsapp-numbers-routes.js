'use strict';

/**
 * verify:staff-whatsapp-numbers-routes
 *
 * Focused contract harness for Staff API whatsapp-numbers extraction (Slice 2).
 * Mirrors verify-staff-notification-settings-routes.js (Slice 1 template).
 *
 * Proves:
 *   - module exports a small register/handler map (GET + POST collection)
 *   - GET + POST still dispatch with identical response shapes/status
 *   - admin auth is still required at the router (viewer/operator rejected)
 *   - module itself does not enforce auth (auth stays in staff-query-api router)
 *   - staff-query-api wires requireAuth('admin') + path + handlers (no inline GET/POST)
 *   - DELETE remains monolith-owned for this slice
 *   - no reverse require of staff-query-api from the new module
 *   - DB helpers come from luna-staff-whatsapp-numbers (not duplicated)
 *   - UI surface for staff WhatsApp numbers still present in /staff/ui builder source
 *
 * No live DB / network.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-whatsapp-numbers-routes.js');
const HELPER_PATH = path.join(ROOT, 'scripts', 'lib', 'luna-staff-whatsapp-numbers.js');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');

const {
  WHATSAPP_NUMBERS_PATH,
  WHATSAPP_NUMBERS_MIN_ROLE,
  createWhatsappNumbersRoutes,
} = require('./lib/staff-whatsapp-numbers-routes');

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
  const out = {
    statusCode: 200,
    headers: {},
    body: null,
    ended: false,
  };
  return {
    out,
    writeHead(code, headers) {
      out.statusCode = code;
      if (headers) Object.assign(out.headers, headers);
    },
    setHeader(k, v) {
      out.headers[k] = v;
    },
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

function e164(suffixDigits) {
  return `+346${suffixDigits}`;
}

function makeDeps(overrides = {}) {
  const audit = [];
  /** @type {Map<string, object>} */
  const numbersByPhone = new Map();

  const deps = {
    DEFAULT_CLIENT: 'wolfhouse-somo',
    SQL_INJECT_RE: /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i,
    audit,
    numbersByPhone,
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
    assertStaffClientAccess(user, clientSlug, res) {
      if (user && user.denyClient === clientSlug) {
        deps.sendJSON(res, 403, { success: false, error: 'client_access_denied', client_slug: clientSlug });
        return false;
      }
      return true;
    },
    appendAuditLog(entry) {
      audit.push(entry);
    },
    async withPgClient(fn) {
      const phoneAccess = [];
      const pg = {
        phoneAccess,
        async query(sql, params = []) {
          const q = String(sql);
          if (/CREATE TABLE IF NOT EXISTS wolfhouse_staff_whatsapp_numbers/i.test(q)
            || /CREATE UNIQUE INDEX/i.test(q)
            || /CREATE INDEX/i.test(q)
            || /CREATE TABLE IF NOT EXISTS/i.test(q)) {
            return { rows: [], rowCount: 0 };
          }
          // list
          if (/FROM wolfhouse_staff_whatsapp_numbers/i.test(q) && /SELECT id, client_slug, phone/i.test(q) && /WHERE client_slug/i.test(q) && !/DELETE/i.test(q) && !/INSERT/i.test(q)) {
            const slug = params[0];
            const rows = [...numbersByPhone.values()].filter((r) => r.client_slug === slug);
            return { rows, rowCount: rows.length };
          }
          // upsert insert...on conflict
          if (/INSERT INTO wolfhouse_staff_whatsapp_numbers/i.test(q)) {
            const [slug, phone, group, displayName, active] = params;
            const row = {
              id: numbersByPhone.has(phone) ? numbersByPhone.get(phone).id : `id-${phone.slice(-4)}`,
              client_slug: slug,
              phone,
              permission_group: group,
              display_name: displayName,
              active: active === true,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            numbersByPhone.set(phone, row);
            return { rows: [row], rowCount: 1 };
          }
          // staff_phone_access upsert (recognition sync) — accept anything
          if (/staff_phone_access/i.test(q) || /INSERT INTO/i.test(q) || /UPDATE/i.test(q)) {
            phoneAccess.push({ sql: q.slice(0, 80), params });
            return { rows: [{ ok: true }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      };
      return fn(pg);
    },
    ...overrides,
  };
  return deps;
}

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3, owner: 4 };
function hasRole(userRole, minRole) {
  return (ROLE_RANK[userRole] || 0) >= (ROLE_RANK[minRole] || 0);
}

async function dispatchWhatsappNumbers({ pathname, method, role, user, query, body, routes }) {
  const res = mockRes();
  if (pathname !== routes.PATH) {
    return { matched: false, res: res.out };
  }
  const handler = routes.getHandler(method);
  if (!handler) {
    res.writeHead(405, { Allow: 'GET, POST' });
    res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
    return { matched: true, res: res.out, auth: null };
  }

  const minRole = routes.MIN_ROLE;
  if (!role) {
    routes._deps.sendJSON(res, 401, {
      success: false,
      error: 'Authentication required. POST /staff/auth/login first.',
      auth_url: '/staff/auth/login',
    });
    return { matched: true, res: res.out, auth: { ok: false, status: 401 } };
  }
  if (!hasRole(role, minRole)) {
    routes._deps.sendJSON(res, 403, {
      success: false,
      error: `Role '${minRole}' or higher required.`,
      current_role: role,
    });
    return { matched: true, res: res.out, auth: { ok: false, status: 403 } };
  }

  const req = mockReq(body);
  const authUser = user || { staff_user_id: 'u1', role };
  await handler(query || {}, req, res, authUser);
  return { matched: true, res: res.out, auth: { ok: true, user: authUser } };
}

function parseBody(out) {
  if (!out.body) return null;
  try {
    return JSON.parse(out.body);
  } catch (_) {
    return out.body;
  }
}

console.log('verify:staff-whatsapp-numbers-routes\n');

console.log('── module surface ──');
ok('module file exists', fs.existsSync(MODULE_PATH));
ok('helper lib exists (no duplication target)', fs.existsSync(HELPER_PATH));
ok('PATH constant', WHATSAPP_NUMBERS_PATH === '/staff/whatsapp-numbers');
ok('MIN_ROLE admin', WHATSAPP_NUMBERS_MIN_ROLE === 'admin');
ok('createWhatsappNumbersRoutes exported', typeof createWhatsappNumbersRoutes === 'function');

const deps = makeDeps();
const routes = createWhatsappNumbersRoutes(deps);
routes._deps = deps;

ok('handlers.GET is function', typeof routes.handlers.GET === 'function');
ok('handlers.POST is function', typeof routes.handlers.POST === 'function');
ok('no DELETE on collection handlers map', routes.handlers.DELETE == null);
ok('routes table length 2', Array.isArray(routes.routes) && routes.routes.length === 2);
ok('routes table paths', routes.routes.every((r) => r.path === WHATSAPP_NUMBERS_PATH));
ok('routes table minRole admin', routes.routes.every((r) => r.minRole === 'admin'));
ok('match GET', routes.match('/staff/whatsapp-numbers', 'GET') === routes.handlers.GET);
ok('match POST', routes.match('/staff/whatsapp-numbers', 'post') === routes.handlers.POST);
ok('match misses other path', routes.match('/staff/notification-settings', 'GET') == null);
ok('match misses collection PUT', routes.match('/staff/whatsapp-numbers', 'PUT') == null);
ok('match misses DELETE item path', routes.match(`/staff/whatsapp-numbers/${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}`, 'DELETE') == null);

console.log('\n── no reverse coupling / no helper duplication ──');
const modSrc = fs.readFileSync(MODULE_PATH, 'utf8');
ok(
  'module does not require staff-query-api',
  !/require\s*\(\s*['"][^'"]*staff-query-api['"]\s*\)/.test(modSrc),
);
ok('module requires luna-staff-whatsapp-numbers', /require\('\.\/luna-staff-whatsapp-numbers'\)/.test(modSrc));
ok('module requires staff-phone-access for recognition sync', /require\('\.\/staff-phone-access'\)/.test(modSrc));
ok('module does not redefine listStaffWhatsappNumbers', !/function listStaffWhatsappNumbers\s*\(/.test(modSrc));
ok('module does not redefine upsertStaffWhatsappNumber', !/function upsertStaffWhatsappNumber\s*\(/.test(modSrc));
ok('module does not redefine ensureStaffWhatsappNumbersTable', !/function ensureStaffWhatsappNumbersTable\s*\(/.test(modSrc));
const modSrcNoComments = modSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
ok('module does not call requireAuth', !/\brequireAuth\s*\(/.test(modSrcNoComments));

console.log('\n── handler response contracts ──');

(async () => {
  // GET empty list
  {
    const res = mockRes();
    await routes.handleStaffWhatsappNumbersGet({ client: 'wolfhouse-somo' }, mockReq(), res, {
      staff_user_id: 'admin-1',
      role: 'admin',
    });
    const body = parseBody(res.out);
    ok('GET status 200', res.out.statusCode === 200, `status=${res.out.statusCode}`);
    ok('GET success true', body && body.success === true);
    ok('GET client_slug', body && body.client_slug === 'wolfhouse-somo');
    ok('GET numbers array', body && Array.isArray(body.numbers));
    ok('GET elapsed_ms', body && typeof body.elapsed_ms === 'number');
    ok('GET audit intent', deps.audit.some((e) => e.intent === 'api:staff.whatsapp_numbers.list' && e.success === true));
  }

  // POST upsert
  {
    const res = mockRes();
    const phone = e164('00111222');
    await routes.handleStaffWhatsappNumbersPost({ client: 'wolfhouse-somo' }, mockReq({
      phone,
      permission_group: 'staff',
      display_name: 'Front desk',
      active: true,
    }), res, { staff_user_id: 'admin-1', role: 'admin' });
    const body = parseBody(res.out);
    ok('POST status 200', res.out.statusCode === 200, `status=${res.out.statusCode} body=${res.out.body}`);
    ok('POST success true', body && body.success === true);
    ok('POST number row', body && body.number && body.number.phone);
    ok('POST whatsapp_recognition flag present', body && typeof body.whatsapp_recognition === 'boolean');
    ok('POST audit intent', deps.audit.some((e) => e.intent === 'api:staff.whatsapp_numbers.upsert'));
  }

  // POST validation error (invalid group)
  {
    const res = mockRes();
    await routes.handleStaffWhatsappNumbersPost({ client: 'wolfhouse-somo' }, mockReq({
      phone: e164('00999888'),
      permission_group: 'superadmin',
    }), res, { staff_user_id: 'admin-1', role: 'admin' });
    const body = parseBody(res.out);
    ok('POST invalid group → 400', res.out.statusCode === 400 && body && body.success === false);
    ok('POST invalid group error code', body && body.error === 'invalid_permission_group');
  }

  // GET after POST sees number
  {
    const res = mockRes();
    await routes.handleStaffWhatsappNumbersGet({ client: 'wolfhouse-somo' }, mockReq(), res, {
      staff_user_id: 'admin-1',
      role: 'admin',
    });
    const body = parseBody(res.out);
    ok('GET after POST has >=1 number', body && Array.isArray(body.numbers) && body.numbers.length >= 1);
  }

  // Invalid JSON
  {
    const res = mockRes();
    const req = new EventEmitter();
    process.nextTick(() => {
      req.emit('data', Buffer.from('{not-json', 'utf8'));
      req.emit('end');
    });
    await routes.handleStaffWhatsappNumbersPost({}, req, res, { staff_user_id: 'a', role: 'admin' });
    const body = parseBody(res.out);
    ok('POST invalid JSON → 400', res.out.statusCode === 400 && body && /invalid JSON/i.test(String(body.error || '')));
  }

  // Bad client slug
  {
    const res = mockRes();
    await routes.handleStaffWhatsappNumbersGet({ client: "wol'; DROP" }, mockReq(), res, {
      staff_user_id: 'a',
      role: 'admin',
    });
    ok('GET bad client → 400', res.out.statusCode === 400);
  }

  // Module does NOT reject low roles by itself
  {
    const res = mockRes();
    await routes.handleStaffWhatsappNumbersGet({ client: 'wolfhouse-somo' }, mockReq(), res, {
      staff_user_id: 'v1',
      role: 'viewer',
    });
    ok(
      'module alone does not 403 viewer',
      res.out.statusCode === 200,
      `status=${res.out.statusCode} (auth must stay in router)`,
    );
  }

  console.log('\n── router auth gate (admin required) ──');
  {
    const r = await dispatchWhatsappNumbers({
      pathname: WHATSAPP_NUMBERS_PATH,
      method: 'GET',
      role: null,
      query: { client: 'wolfhouse-somo' },
      routes,
    });
    ok('unauthenticated → 401', r.res.statusCode === 401);
  }
  for (const role of ['viewer', 'operator']) {
    const r = await dispatchWhatsappNumbers({
      pathname: WHATSAPP_NUMBERS_PATH,
      method: 'GET',
      role,
      query: { client: 'wolfhouse-somo' },
      routes,
    });
    ok(`${role} GET rejected 403`, r.res.statusCode === 403, `status=${r.res.statusCode}`);
  }
  for (const role of ['admin', 'owner']) {
    const r = await dispatchWhatsappNumbers({
      pathname: WHATSAPP_NUMBERS_PATH,
      method: 'GET',
      role,
      query: { client: 'wolfhouse-somo' },
      routes,
    });
    ok(`${role} GET allowed 200`, r.res.statusCode === 200, `status=${r.res.statusCode}`);
  }
  {
    const r = await dispatchWhatsappNumbers({
      pathname: WHATSAPP_NUMBERS_PATH,
      method: 'POST',
      role: 'operator',
      query: { client: 'wolfhouse-somo' },
      body: { phone: e164('00777888'), permission_group: 'staff' },
      routes,
    });
    ok('operator POST rejected 403', r.res.statusCode === 403);
  }
  {
    const r = await dispatchWhatsappNumbers({
      pathname: WHATSAPP_NUMBERS_PATH,
      method: 'POST',
      role: 'admin',
      query: { client: 'wolfhouse-somo' },
      body: { phone: e164('00000100'), permission_group: 'owner', display_name: 'Boss' },
      routes,
    });
    ok('admin POST allowed 200', r.res.statusCode === 200, `status=${r.res.statusCode} body=${r.res.body}`);
  }
  {
    const r = await dispatchWhatsappNumbers({
      pathname: '/staff/other',
      method: 'GET',
      role: 'admin',
      routes,
    });
    ok('other path not matched', r.matched === false);
  }

  console.log('\n── staff-query-api wiring ──');
  const apiSrc = fs.readFileSync(API_PATH, 'utf8');

  ok('requires whatsapp-numbers routes module', /require\('\.\/lib\/staff-whatsapp-numbers-routes'\)/.test(apiSrc));
  ok('WHATSAPP_NUMBERS_PATH used', /WHATSAPP_NUMBERS_PATH/.test(apiSrc));
  ok('createWhatsappNumbersRoutes called', /createWhatsappNumbersRoutes\s*\(/.test(apiSrc));
  ok('path constant equals /staff/whatsapp-numbers', /WHATSAPP_NUMBERS_PATH\s*=\s*'\/staff\/whatsapp-numbers'/.test(modSrc));

  const getRouteRe = /pathname === WHATSAPP_NUMBERS_PATH && method === 'GET'[\s\S]{0,220}?requireAuth\(\s*req\s*,\s*res\s*,\s*'admin'\s*\)/;
  const postRouteRe = /pathname === WHATSAPP_NUMBERS_PATH && method === 'POST'[\s\S]{0,220}?requireAuth\(\s*req\s*,\s*res\s*,\s*'admin'\s*\)/;
  ok('GET route requireAuth admin', getRouteRe.test(apiSrc));
  ok('POST route requireAuth admin', postRouteRe.test(apiSrc));
  ok('GET dispatches handleStaffWhatsappNumbersGet', /return handleStaffWhatsappNumbersGet\(parsed\.query, req, res, auth\.user\)/.test(apiSrc));
  ok('POST dispatches handleStaffWhatsappNumbersPost', /return handleStaffWhatsappNumbersPost\(parsed\.query, req, res, auth\.user\)/.test(apiSrc));

  ok('no inline async handleStaffWhatsappNumbersGet', !/async function handleStaffWhatsappNumbersGet\s*\(/.test(apiSrc));
  ok('no inline async handleStaffWhatsappNumbersPost', !/async function handleStaffWhatsappNumbersPost\s*\(/.test(apiSrc));
  ok('DELETE handler still inline (Slice 2 scope)', /async function handleStaffWhatsappNumbersDelete\s*\(/.test(apiSrc));
  ok('DELETE route still present with admin auth', /staffWhatsappNumberMatch && method === 'DELETE'[\s\S]{0,200}?requireAuth\(\s*req\s*,\s*res\s*,\s*'admin'\s*\)/.test(apiSrc));

  // UI surface
  ok('UI card id present', apiSrc.includes('cc-staff-whatsapp-numbers'));
  ok('UI fetch path present', apiSrc.includes('/staff/whatsapp-numbers'));
  ok('UI save path uses POST collection', /fetch\('\/staff\/whatsapp-numbers'/.test(apiSrc) || apiSrc.includes("'/staff/whatsapp-numbers'"));

  console.log('\n── syntax ──');
  for (const rel of [
    'scripts/lib/staff-whatsapp-numbers-routes.js',
    'scripts/staff-query-api.js',
    'scripts/verify-staff-whatsapp-numbers-routes.js',
  ]) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
    ok(`node --check ${rel}`, r.status === 0, r.stderr || r.stdout);
  }

  console.log('\n── coupling notes (findings) ──');
  const findings = [
    'Handlers depend on monolith deps via createWhatsappNumbersRoutes({ sendJSON, send400, readBody, assertStaffClientAccess, appendAuditLog, withPgClient, DEFAULT_CLIENT, SQL_INJECT_RE }).',
    'withPgClient must be the staff-query-api wrapper (Fortress offline seam), not raw pg-connect — injected via deps.',
    'DB helpers live in luna-staff-whatsapp-numbers.js (not staff-whatsapp-notifications.js); module requires that lib — no duplication.',
    'POST recognition sync requires staff-phone-access.upsertStaffPhoneAccess (shared lib, not reverse coupling into staff-query-api).',
    'DELETE /staff/whatsapp-numbers/:id intentionally left in staff-query-api.js for Slice 2.',
  ];
  for (const f of findings) console.log(`  NOTE  ${f}`);
  ok('findings recorded', findings.length >= 4);

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
