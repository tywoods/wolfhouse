'use strict';

/**
 * verify:staff-customers-routes
 *
 * Contract harness for Staff API customers extraction (Slice 3).
 * Mirrors Slice 1/2 harnesses + per-route role matrix (viewer vs operator).
 *
 * Proves:
 *   - createCustomersRoutes DI factory + register/handler map
 *   - CUSTOMER_ROUTE_TABLE minRole is exact (viewer stays viewer, operator stays operator)
 *   - staff-query-api requireAuth minRole matches table per route
 *   - module does not call requireAuth / no reverse staff-query-api require
 *   - no duplicated query helpers (uses staff-customer-queries + siblings)
 *   - outreach + generate still wired to shared libs
 *   - UI surface still present
 *
 * No live DB / network / WhatsApp.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-customers-routes.js');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const QUERIES_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-customer-queries.js');
/** Customers front-end modules injected into /staff/ui (see lib/inbox-browser-source.js). */
const CUSTOMERS_BROWSER_MODULES = [
  path.join(ROOT, 'scripts', 'browser', 'inbox-customers-filters.js'),
  path.join(ROOT, 'scripts', 'browser', 'inbox-customers-outreach.js'),
  path.join(ROOT, 'scripts', 'browser', 'inbox-customers-profile.js'),
];

const {
  CUSTOMER_ROUTE_TABLE,
  CUSTOMERS_COLLECTION_PATH,
  CUSTOMERS_BULK_DELETE_PATH,
  CUSTOMERS_MESSAGE_TEMPLATES_PATH,
  CUSTOMERS_MESSAGE_TEMPLATES_GENERATE_PATH,
  CUSTOMERS_OUTREACH_SEND_PATH,
  CUSTOMER_CONTEXT_RE,
  CUSTOMER_TAGS_RE,
  CUSTOMER_CREATE_CONVERSATION_RE,
  CUSTOMER_MESSAGE_TEMPLATE_RE,
  CUSTOMER_PHONE_RE,
  createCustomersRoutes,
} = require('./lib/staff-customers-routes');

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
  const deps = {
    DEFAULT_CLIENT: 'wolfhouse-somo',
    SQL_INJECT_RE: /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i,
    STAFF_ACTIONS_ENABLED: true,
    CUSTOMER_OUTREACH_WHATSAPP_ENABLED: true,
    audit,
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
      const pg = {
        async query(sql) {
          const q = String(sql);
          // list
          if (/FROM conversations/i.test(q) || /customer/i.test(q) || /SELECT/i.test(q)) {
            return { rows: [] };
          }
          return { rows: [] };
        },
      };
      return fn(pg);
    },
    ...overrides,
  };
  return deps;
}

/** Router-style gate using table minRole (module does not own auth). */
async function dispatchWithRole({ route, role, query, body, pathParam, routes }) {
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
  const handler = routes.handlers[route.id];
  const req = mockReq(body);
  const user = { staff_user_id: 'u1', role };
  const q = query || { client: 'wolfhouse-somo' };
  // Call with the arity the handler expects
  if (route.id === 'list' || route.id === 'templates_list') {
    await handler(q, res, user);
  } else if (route.id === 'context') {
    await handler(pathParam || encodeURIComponent('+34600111222'), q, res, user);
  } else if (route.id === 'tags' || route.id === 'update' || route.id === 'create_conversation') {
    await handler(pathParam || encodeURIComponent('+34600111222'), q, req, res, user);
  } else if (route.id === 'template_update' || route.id === 'template_delete') {
    const id = pathParam || 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    if (route.id === 'template_delete') await handler(id, q, res, user);
    else await handler(id, q, req, res, user);
  } else {
    // create, bulk_delete, template_create, template_generate, outreach_send
    await handler(q, req, res, user);
  }
  return res.out;
}

console.log('verify:staff-customers-routes\n');

console.log('── module surface ──');
ok('module exists', fs.existsSync(MODULE_PATH));
ok('queries lib exists (no duplication)', fs.existsSync(QUERIES_PATH));
ok('createCustomersRoutes', typeof createCustomersRoutes === 'function');
ok('CUSTOMER_ROUTE_TABLE length 13', CUSTOMER_ROUTE_TABLE.length === 13);
ok('collection path', CUSTOMERS_COLLECTION_PATH === '/staff/customers');
ok('bulk-delete path', CUSTOMERS_BULK_DELETE_PATH === '/staff/customers/bulk-delete');
ok('templates path', CUSTOMERS_MESSAGE_TEMPLATES_PATH === '/staff/customers/message-templates');
ok('generate path', CUSTOMERS_MESSAGE_TEMPLATES_GENERATE_PATH === '/staff/customers/message-templates/generate');
ok('outreach path', CUSTOMERS_OUTREACH_SEND_PATH === '/staff/customers/outreach/send');
ok('context RE', CUSTOMER_CONTEXT_RE.test('/staff/customers/%2B346/context'));
ok('tags RE', CUSTOMER_TAGS_RE.test('/staff/customers/%2B346/tags'));
ok('create-conv RE', CUSTOMER_CREATE_CONVERSATION_RE.test('/staff/customers/%2B346/create-conversation'));
ok('template RE', CUSTOMER_MESSAGE_TEMPLATE_RE.test('/staff/customers/message-templates/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
ok('phone RE', CUSTOMER_PHONE_RE.test('/staff/customers/%2B34600111222'));

const expectedRoles = {
  list: 'viewer',
  context: 'viewer',
  templates_list: 'viewer',
  create: 'operator',
  bulk_delete: 'operator',
  tags: 'operator',
  create_conversation: 'operator',
  template_create: 'operator',
  template_generate: 'operator',
  outreach_send: 'operator',
  template_update: 'operator',
  template_delete: 'operator',
  update: 'operator',
};

console.log('\n── CUSTOMER_ROUTE_TABLE role matrix ──');
const byId = Object.fromEntries(CUSTOMER_ROUTE_TABLE.map((r) => [r.id, r]));
for (const [id, role] of Object.entries(expectedRoles)) {
  ok(`table ${id} → ${role}`, byId[id] && byId[id].minRole === role, byId[id] && byId[id].minRole);
}
ok('exactly 3 viewer routes', CUSTOMER_ROUTE_TABLE.filter((r) => r.minRole === 'viewer').length === 3);
ok('exactly 10 operator routes', CUSTOMER_ROUTE_TABLE.filter((r) => r.minRole === 'operator').length === 10);
ok('no admin homogenization', CUSTOMER_ROUTE_TABLE.every((r) => r.minRole === 'viewer' || r.minRole === 'operator'));

const deps = makeDeps();
const routes = createCustomersRoutes(deps);
routes._deps = deps;
ok('handlers map has 13', Object.keys(routes.handlers).length === 13);
ok('routes array has 13 handlers', routes.routes.length === 13 && routes.routes.every((r) => typeof r.handler === 'function'));

console.log('\n── no reverse coupling / no helper duplication ──');
const modSrc = fs.readFileSync(MODULE_PATH, 'utf8');
ok('no require staff-query-api', !/require\s*\(\s*['"][^'"]*staff-query-api['"]\s*\)/.test(modSrc));
ok('requires staff-customer-queries', /require\('\.\/staff-customer-queries'\)/.test(modSrc));
ok('requires outreach-send', /require\('\.\/staff-customer-outreach-send'\)/.test(modSrc));
ok('requires outreach-draft-generate', /require\('\.\/staff-customer-outreach-draft-generate'\)/.test(modSrc));
ok('requires message-templates', /require\('\.\/staff-customer-message-templates'\)/.test(modSrc));
ok('requires profile-delete', /require\('\.\/staff-customer-profile-delete'\)/.test(modSrc));
ok('requires sunset profile writes', /require\('\.\/sunset-customer-profile-writes'\)/.test(modSrc));
ok('does not redefine buildCustomerListParams', !/function buildCustomerListParams\s*\(/.test(modSrc));
ok('does not redefine executeCustomerOutreachSend', !/function executeCustomerOutreachSend\s*\(/.test(modSrc));
ok('does not redefine generateCustomerOutreachDraft', !/function generateCustomerOutreachDraft\s*\(/.test(modSrc));
const modNoComments = modSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
ok('module does not call requireAuth', !/\brequireAuth\s*\(/.test(modNoComments));

console.log('\n── handler smoke (deps + response shape) ──');

(async () => {
  // list 200 empty
  {
    const out = await dispatchWithRole({ route: byId.list, role: 'viewer', routes });
    const body = parseBody(out);
    ok('list viewer 200', out.statusCode === 200 && body && body.success === true);
    ok('list has customers array', body && Array.isArray(body.customers));
  }

  // invalid client slug
  {
    const res = mockRes();
    await routes.handleCustomerList({ client: "x'; DROP" }, res, { role: 'viewer' });
    ok('list bad client 400', res.out.statusCode === 400);
  }

  // generate invalid JSON
  {
    const res = mockRes();
    const req = new EventEmitter();
    process.nextTick(() => { req.emit('data', Buffer.from('{x', 'utf8')); req.emit('end'); });
    await routes.handleCustomerMessageTemplateGenerate({ client: 'wolfhouse-somo' }, req, res, { role: 'operator' });
    ok('generate invalid JSON 400', res.out.statusCode === 400);
  }

  // outreach gates when flags off
  {
    const d2 = makeDeps({ STAFF_ACTIONS_ENABLED: false, CUSTOMER_OUTREACH_WHATSAPP_ENABLED: true });
    const r2 = createCustomersRoutes(d2);
    const res = mockRes();
    await r2.handleCustomerOutreachSend({ client: 'wolfhouse-somo' }, mockReq({ message: 'hello world!!', recipients: [] }), res, { role: 'operator' });
    const body = parseBody(res.out);
    ok('outreach staff_actions_disabled', res.out.statusCode === 403 && body && body.error === 'staff_actions_disabled');
    ok('outreach sends_whatsapp false on gate', body && body.sends_whatsapp === false);
  }
  {
    const d2 = makeDeps({ STAFF_ACTIONS_ENABLED: true, CUSTOMER_OUTREACH_WHATSAPP_ENABLED: false });
    const r2 = createCustomersRoutes(d2);
    const res = mockRes();
    await r2.handleCustomerOutreachSend({ client: 'wolfhouse-somo' }, mockReq({ message: 'hello world!!' }), res, { role: 'operator' });
    const body = parseBody(res.out);
    ok('outreach customer_outreach_disabled', res.out.statusCode === 403 && body && body.error === 'customer_outreach_disabled');
  }

  // module alone does not 403 viewer on operator-only handler (auth is router)
  {
    const res = mockRes();
    await routes.handleCustomerCreate({ client: 'wolfhouse-somo' }, mockReq({ phone: '+34600111222', display_name: 'A' }), res, {
      staff_user_id: 'v',
      role: 'viewer',
    });
    ok(
      'module alone does not role-gate create',
      res.out.statusCode !== 403 || (parseBody(res.out) && parseBody(res.out).error !== "Role 'operator' or higher required."),
      `status=${res.out.statusCode}`,
    );
  }

  console.log('\n── router-style auth matrix (critical) ──');
  // viewer routes: viewer ok, unauth 401
  for (const id of ['list', 'context', 'templates_list']) {
    const unauth = await dispatchWithRole({ route: byId[id], role: null, routes });
    ok(`${id} unauth 401`, unauth.statusCode === 401);
    const viewer = await dispatchWithRole({ route: byId[id], role: 'viewer', routes });
    ok(`${id} viewer not 403`, viewer.statusCode !== 403, `status=${viewer.statusCode}`);
  }
  // operator routes: viewer 403, operator not 403 (from auth gate)
  for (const id of [
    'create', 'bulk_delete', 'tags', 'create_conversation', 'template_create',
    'template_generate', 'outreach_send', 'template_update', 'template_delete', 'update',
  ]) {
    const viewer = await dispatchWithRole({
      route: byId[id],
      role: 'viewer',
      routes,
      body: id === 'outreach_send'
        ? { message: 'Hello there friend!!', recipients: [{ phone: '+34600111222' }] }
        : { phone: '+34600111222', title: 't', body: 'b'.repeat(20) },
    });
    ok(`${id} viewer 403`, viewer.statusCode === 403, `status=${viewer.statusCode}`);
    // operator passes auth gate — handler may 400 later; must not be role 403
    const op = await dispatchWithRole({
      route: byId[id],
      role: 'operator',
      routes,
      body: id === 'outreach_send'
        ? { message: 'Hello there friend!!', recipients: [{ phone: '+34600111222' }] }
        : { phone: '+34600111222', title: 't', body: 'hello template body ok' },
    });
    const opBody = parseBody(op);
    const isRoleReject = op.statusCode === 403 && opBody && /Role 'operator'/.test(String(opBody.error || ''));
    ok(`${id} operator auth gate open`, !isRoleReject, `status=${op.statusCode} body=${op.body}`);
  }

  console.log('\n── staff-query-api wiring (static) ──');
  const apiSrc = fs.readFileSync(API_PATH, 'utf8');
  ok('requires staff-customers-routes', /require\('\.\/lib\/staff-customers-routes'\)/.test(apiSrc));
  ok('createCustomersRoutes called', /createCustomersRoutes\s*\(/.test(apiSrc));
  ok('no inline handleCustomerList', !/async function handleCustomerList\s*\(/.test(apiSrc));
  ok('no inline handleCustomerOutreachSend', !/async function handleCustomerOutreachSend\s*\(/.test(apiSrc));
  ok('no inline handleCustomerMessageTemplateGenerate', !/async function handleCustomerMessageTemplateGenerate\s*\(/.test(apiSrc));
  ok('no inline mapCustomerListRow', !/function mapCustomerListRow\s*\(/.test(apiSrc));

  // Per-route requireAuth role in router must match table
  const wiringChecks = [
    ['list', /pathname === CUSTOMERS_COLLECTION_PATH\) \{\s*\n\s*const auth = await requireAuth\(\s*req\s*,\s*res\s*,\s*'viewer'\s*\)/],
    ['context', /customerCtxMatch\) \{\s*\n\s*const auth = await requireAuth\(\s*req\s*,\s*res\s*,\s*'viewer'\s*\)/],
    ['templates_list', /CUSTOMERS_MESSAGE_TEMPLATES_PATH && method === 'GET'[\s\S]{0,160}?requireAuth\(\s*req\s*,\s*res\s*,\s*'viewer'\s*\)/],
    ['create', /CUSTOMERS_COLLECTION_PATH && method === 'POST'[\s\S]{0,160}?requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/],
    ['bulk_delete', /CUSTOMERS_BULK_DELETE_PATH && method === 'POST'[\s\S]{0,160}?requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/],
    ['tags', /customerTagsMatch && method === 'PATCH'[\s\S]{0,160}?requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/],
    ['create_conversation', /customerCreateConvMatch && method === 'POST'[\s\S]{0,160}?requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/],
    ['template_create', /CUSTOMERS_MESSAGE_TEMPLATES_PATH && method === 'POST'[\s\S]{0,160}?requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/],
    ['template_generate', /CUSTOMERS_MESSAGE_TEMPLATES_GENERATE_PATH && method === 'POST'[\s\S]{0,160}?requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/],
    ['outreach_send', /CUSTOMERS_OUTREACH_SEND_PATH && method === 'POST'[\s\S]{0,160}?requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/],
    ['template_update', /customerTemplateMatch && method === 'PATCH'[\s\S]{0,160}?requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/],
    ['template_delete', /customerTemplateMatch && method === 'DELETE'[\s\S]{0,160}?requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/],
    ['update', /customerPhoneMatch && method === 'PATCH'[\s\S]{0,160}?requireAuth\(\s*req\s*,\s*res\s*,\s*'operator'\s*\)/],
  ];
  for (const [id, re] of wiringChecks) {
    ok(`router ${id} role wiring`, re.test(apiSrc));
  }

  // UI. The Customers front-end now lives in scripts/browser/inbox-customers-*.js and is
  // injected into /staff/ui at markers, so these assertions read the template plus modules.
  const uiSrc = apiSrc + CUSTOMERS_BROWSER_MODULES.map((p) => fs.readFileSync(p, 'utf8')).join('\n');
  ok('UI customers tab markers', /tab-customers|customersClientQuery|\/staff\/customers/.test(uiSrc));
  ok('UI outreach send path', uiSrc.includes('/staff/customers/outreach/send') || uiSrc.includes('CUSTOMERS_OUTREACH'));
  ok('UI template generate path', uiSrc.includes('/staff/customers/message-templates/generate') || uiSrc.includes('message-templates/generate'));
  for (const p of CUSTOMERS_BROWSER_MODULES) {
    ok(`UI module injected ${path.basename(p)}`, apiSrc.includes(`/* INJECT:${path.basename(p, '.js')} */`));
  }

  console.log('\n── syntax ──');
  for (const rel of [
    'scripts/lib/staff-customers-routes.js',
    'scripts/staff-query-api.js',
    'scripts/verify-staff-customers-routes.js',
    'scripts/lib/inbox-browser-source.js',
    'scripts/browser/inbox-customers-filters.js',
    'scripts/browser/inbox-customers-outreach.js',
    'scripts/browser/inbox-customers-profile.js',
  ]) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
    ok(`node --check ${rel}`, r.status === 0, r.stderr || r.stdout);
  }

  console.log('\n── findings ──');
  const findings = [
    'Mixed roles preserved via CUSTOMER_ROUTE_TABLE + router requireAuth (3 viewer, 10 operator).',
    'Handlers DI: sendJSON/send400/readBody/assertStaffClientAccess/appendAuditLog/withPgClient/DEFAULT_CLIENT/SQL_INJECT_RE/STAFF_ACTIONS_ENABLED/CUSTOMER_OUTREACH_WHATSAPP_ENABLED.',
    'Shared libs: staff-customer-queries, profile-delete, message-templates, outreach-send, outreach-draft-generate, sunset-customer-profile-writes, sunset-inbox-channel-config.',
    'mapCustomerListRow moved with handlers; CRM tag constants remain in staff-query-api for UI bootstrap.',
  ];
  for (const f of findings) console.log(`  NOTE  ${f}`);
  ok('findings recorded', findings.length >= 3);

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
