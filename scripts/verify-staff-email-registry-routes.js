'use strict';

/**
 * verify:staff-email-registry-routes — Luna email Slice 1C-beta offline gate.
 *
 * Focused DI-mock route verifier for the admin-only READ API over the empty
 * email registry (tenant_locations + tenant_channel_endpoints).
 *
 * Proves:
 *   - extracted DI route module surface + GET-only handlers
 *   - admin minRole wiring (viewer/operator denied at router; owner inherits)
 *   - tenant ACL isolation (cross-client denied before DB list)
 *   - requested-tenant admin_db_read via injected authorizeAuthenticatedStaffRoute
 *     (multi-client: home A enabled + requested B disabled → 403, zero UUID/list)
 *   - query/body client_id cannot alter scoped client UUID
 *   - repository receives only resolved authenticated client UUID
 *   - strict include_inactive parsing (true|false|omit)
 *   - DTO allowlists; secret_ref redacted; secret_ref_present boolean
 *   - capabilities fail-closed (exact eight booleans; hostile keys → 500)
 *   - no raw rows / no created_by/updated_by/client_id in responses
 *   - db_error sanitized (no raw PG leakage)
 *   - no err.message / raw secret substrings in logs or audit
 *   - no writes / activation / provider SDK / live DSN
 *   - staff-query-api wiring (requireAuth admin + authorize inject + handlers)
 *
 * No live DB / network / provider connectivity.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const MODULE_REL = 'scripts/lib/staff-email-registry-routes.js';
const MODULE_PATH = path.join(ROOT, MODULE_REL);
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC_PATH = path.join(ROOT, 'docs', 'EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const REGISTRY_PATH = path.join(ROOT, 'scripts', 'lib', 'email-tenant-channel-registry.js');
const VERIFY_REL = 'scripts/verify-staff-email-registry-routes.js';

const CLIENT_A_SLUG = 'tenant-a';
const CLIENT_B_SLUG = 'tenant-b';
const CLIENT_A_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIENT_B_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECRET_REF = 'kv:luna-support-email-credentials';

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

function parseBody(out) {
  if (!out || !out.body) return null;
  try {
    return JSON.parse(out.body);
  } catch (_) {
    return out.body;
  }
}

const ROLE_RANK = { viewer: 1, operator: 2, admin: 3, owner: 4 };
function hasRole(userRole, minRole) {
  return (ROLE_RANK[userRole] || 0) >= (ROLE_RANK[minRole] || 0);
}

function looksLikeEmbeddedSecret(text) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) return 'pem';
  if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text)) return 'jwt';
  if (/(?:^|[^\\])password\s*=\s*['"][^'"\n]{8,}['"]/im.test(text)) return 'password_assign';
  if (/(?:^|[^\\])api[_-]?key\s*=\s*['"][A-Za-z0-9]{16,}['"]/im.test(text)) return 'api_key_assign';
  if (/(?:^|[^'"`\\\[])sk-[A-Za-z0-9]{20,}/.test(text)) return 'sk_token';
  return null;
}

function sampleLocationRow(overrides) {
  return Object.assign({
    id: '11111111-1111-4111-8111-111111111111',
    client_id: CLIENT_A_UUID,
    location_id: 'beach-house',
    display_name: 'Beach House',
    active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    created_by: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    updated_by: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    unexpected_column: 'should-not-leak',
  }, overrides || {});
}

function sampleEndpointRow(overrides) {
  return Object.assign({
    id: '22222222-2222-4222-8222-222222222222',
    client_id: CLIENT_A_UUID,
    location_id: 'beach-house',
    channel: 'email',
    provider: 'microsoft_graph',
    public_address: 'support@example.com',
    secret_ref: SECRET_REF,
    provider_resource_id: 'mailbox-1',
    capabilities: {
      push_notifications: false,
      provider_threads: false,
      remote_drafts: false,
      reply: false,
      reply_all: false,
      forward: false,
      attachments_metadata: false,
      delivery_events: false,
    },
    inbound_enabled: false,
    outbound_enabled: false,
    default_automation_mode: 'off',
    active: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    created_by: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    updated_by: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    unexpected_column: 'should-not-leak',
  }, overrides || {});
}

function makeDeps(overrides) {
  const audit = [];
  const listCalls = [];
  const authzCalls = [];
  const slugLookups = [];
  const slugToUuid = {
    [CLIENT_A_SLUG]: CLIENT_A_UUID,
    [CLIENT_B_SLUG]: CLIENT_B_UUID,
    'wolfhouse-somo': CLIENT_A_UUID,
  };
  const locationsByClient = {
    [CLIENT_A_UUID]: [sampleLocationRow()],
    [CLIENT_B_UUID]: [sampleLocationRow({
      id: '33333333-3333-4333-8333-333333333333',
      client_id: CLIENT_B_UUID,
      location_id: 'mountain-camp',
      display_name: 'Mountain Camp',
    })],
  };
  const endpointsByClient = {
    [CLIENT_A_UUID]: [sampleEndpointRow()],
    [CLIENT_B_UUID]: [sampleEndpointRow({
      id: '44444444-4444-4444-8444-444444444444',
      client_id: CLIENT_B_UUID,
      location_id: 'mountain-camp',
      public_address: 'b@example.com',
      secret_ref: null,
    })],
  };

  // Per-tenant admin_db_read matrix for multi-client tests (overridable).
  const adminDbReadBySlug = {
    [CLIENT_A_SLUG]: true,
    [CLIENT_B_SLUG]: true,
    'wolfhouse-somo': true,
  };

  const deps = {
    DEFAULT_CLIENT: 'wolfhouse-somo',
    SQL_INJECT_RE: /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i,
    audit,
    listCalls,
    authzCalls,
    slugLookups,
    adminDbReadBySlug,
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
      if (user && Array.isArray(user.allowed_clients) && !user.allowed_clients.includes(clientSlug)) {
        deps.sendJSON(res, 403, {
          success: false,
          error: 'client_access_denied',
          client_slug: clientSlug,
        });
        return false;
      }
      if (user && user.denyClient === clientSlug) {
        deps.sendJSON(res, 403, {
          success: false,
          error: 'client_access_denied',
          client_slug: clientSlug,
        });
        return false;
      }
      return true;
    },
    // Mirrors authorizeAuthenticatedStaffRoute shape for admin GET paths.
    authorizeAuthenticatedStaffRoute(opts) {
      const o = opts && typeof opts === 'object' ? opts : {};
      const clientSlug = String(o.clientSlug || '').trim();
      const method = String(o.method || 'GET').toUpperCase();
      const pathname = String(o.pathname || '');
      authzCalls.push({
        clientSlug,
        method,
        pathname,
        hasEnv: o.env != null && typeof o.env === 'object',
      });
      if (!clientSlug) {
        return {
          ok: false,
          status: 403,
          body: {
            success: false,
            error: 'tenant_route_forbidden',
            reason_code: 'unresolved_tenant_scope',
          },
        };
      }
      // Process-level reserved tenants (no new exception list in routes — authorizer decides).
      if (/^wolfhouse/i.test(clientSlug) || clientSlug === 'sunset' || clientSlug === 'wh') {
        return { ok: true, mode: 'process_level', client_slug: clientSlug };
      }
      const allowed = deps.adminDbReadBySlug[clientSlug] !== false;
      if (!allowed) {
        return {
          ok: false,
          status: 403,
          body: {
            success: false,
            error: 'tenant_route_forbidden',
            reason_code: 'admin_db_read_disabled',
            admin_db_read: false,
            client_slug: clientSlug,
          },
        };
      }
      if (method === 'GET' && /^\/staff\/admin(\/|$)/i.test(pathname)) {
        return { ok: true, mode: 'admin_read', client_slug: clientSlug };
      }
      return { ok: true, mode: 'read', client_slug: clientSlug };
    },
    appendAuditLog(entry) {
      audit.push(entry);
    },
    async withPgClient(fn) {
      const pg = {
        async query(sql, params) {
          const q = String(sql || '');
          if (/FROM\s+clients\s+WHERE\s+slug\s*=\s*\$1/i.test(q)) {
            const slug = params && params[0];
            slugLookups.push(slug);
            const id = slugToUuid[slug];
            if (!id) return { rows: [], rowCount: 0 };
            return { rows: [{ client_id: id, id }], rowCount: 1 };
          }
          throw new Error('unexpected pg query in mock: ' + q.slice(0, 120));
        },
      };
      return fn(pg);
    },
    async listTenantLocations(args, listDeps) {
      listCalls.push({ fn: 'listTenantLocations', args: { ...args }, depsKeys: Object.keys(listDeps || {}) });
      if (args && args._forceDbError) return { ok: false, error: 'db_error' };
      const rows = locationsByClient[args.clientId] || [];
      const filtered = args.includeInactive === false ? rows.filter((r) => r.active) : rows;
      return { ok: true, value: filtered.map((r) => ({ ...r })) };
    },
    async listTenantChannelEndpoints(args, listDeps) {
      listCalls.push({ fn: 'listTenantChannelEndpoints', args: { ...args }, depsKeys: Object.keys(listDeps || {}) });
      if (args && args._forceDbError) return { ok: false, error: 'db_error' };
      const rows = endpointsByClient[args.clientId] || [];
      const filtered = args.includeInactive === false ? rows.filter((r) => r.active) : rows;
      return { ok: true, value: filtered.map((r) => ({ ...r })) };
    },
    ...overrides,
  };
  return deps;
}

/**
 * Thin dispatch matching staff-query-api router contract:
 * requireAuth(minRole) then handler. Auth is outside the module.
 */
async function dispatchEmailRegistry({ pathname, method, role, user, query, routes }) {
  const res = mockRes();
  const match = routes.match(pathname, method);
  if (!match) {
    // Path known but wrong method → 405
    if (
      pathname === routes.LOCATIONS_PATH
      || pathname === routes.ENDPOINTS_PATH
    ) {
      res.writeHead(405, { Allow: 'GET' });
      res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
      return { matched: true, res: res.out, auth: null, methodDenied: true };
    }
    return { matched: false, res: res.out };
  }

  const minRole = match.minRole || routes.MIN_ROLE;
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

  const authUser = user || { staff_user_id: 'u1', role, allowed_clients: [CLIENT_A_SLUG, 'wolfhouse-somo'] };
  await match.handler(query || {}, mockReq(), res, authUser);
  return { matched: true, res: res.out, auth: { ok: true, user: authUser } };
}

console.log('verify:staff-email-registry-routes — Slice 1C-beta offline\n');

// ── Module presence (RED until implemented) ─────────────────────────────────
console.log('── module surface ──');
ok('module file exists', fs.existsSync(MODULE_PATH), MODULE_REL);

let createEmailRegistryRoutes;
let EMAIL_REGISTRY_LOCATIONS_PATH;
let EMAIL_REGISTRY_ENDPOINTS_PATH;
let EMAIL_REGISTRY_MIN_ROLE;
let parseEmailRegistryIncludeInactive;
let modLoadError = null;

if (fs.existsSync(MODULE_PATH)) {
  try {
    const mod = require('./lib/staff-email-registry-routes');
    createEmailRegistryRoutes = mod.createEmailRegistryRoutes;
    EMAIL_REGISTRY_LOCATIONS_PATH = mod.EMAIL_REGISTRY_LOCATIONS_PATH;
    EMAIL_REGISTRY_ENDPOINTS_PATH = mod.EMAIL_REGISTRY_ENDPOINTS_PATH;
    EMAIL_REGISTRY_MIN_ROLE = mod.EMAIL_REGISTRY_MIN_ROLE;
    parseEmailRegistryIncludeInactive = mod.parseEmailRegistryIncludeInactive;
  } catch (err) {
    modLoadError = err;
  }
}

ok('module loads', !modLoadError, modLoadError && modLoadError.message);
ok('createEmailRegistryRoutes exported', typeof createEmailRegistryRoutes === 'function');
ok(
  'locations path under /staff/admin/',
  typeof EMAIL_REGISTRY_LOCATIONS_PATH === 'string'
    && /^\/staff\/admin\//.test(EMAIL_REGISTRY_LOCATIONS_PATH),
  String(EMAIL_REGISTRY_LOCATIONS_PATH),
);
ok(
  'endpoints path under /staff/admin/',
  typeof EMAIL_REGISTRY_ENDPOINTS_PATH === 'string'
    && /^\/staff\/admin\//.test(EMAIL_REGISTRY_ENDPOINTS_PATH),
  String(EMAIL_REGISTRY_ENDPOINTS_PATH),
);
ok('MIN_ROLE admin', EMAIL_REGISTRY_MIN_ROLE === 'admin');
ok('parseEmailRegistryIncludeInactive exported', typeof parseEmailRegistryIncludeInactive === 'function');

// Expected path constants (documented contract)
const EXPECTED_LOCATIONS = '/staff/admin/email-registry/locations';
const EXPECTED_ENDPOINTS = '/staff/admin/email-registry/channel-endpoints';
ok('locations path exact', EMAIL_REGISTRY_LOCATIONS_PATH === EXPECTED_LOCATIONS, String(EMAIL_REGISTRY_LOCATIONS_PATH));
ok('endpoints path exact', EMAIL_REGISTRY_ENDPOINTS_PATH === EXPECTED_ENDPOINTS, String(EMAIL_REGISTRY_ENDPOINTS_PATH));

(async () => {
  if (typeof createEmailRegistryRoutes !== 'function') {
    console.log('\n── RED: module missing — remaining handler tests skipped ──');
    console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`);
    process.exit(1);
  }

  const deps = makeDeps();
  const routes = createEmailRegistryRoutes(deps);
  routes._deps = deps;

  ok('handlers.GET locations is function', typeof routes.handleLocationsGet === 'function');
  ok('handlers.GET endpoints is function', typeof routes.handleChannelEndpointsGet === 'function');
  ok('routes table is array', Array.isArray(routes.routes) && routes.routes.length === 2);
  ok('routes GET only', routes.routes.every((r) => r.method === 'GET'));
  ok('routes minRole admin', routes.routes.every((r) => r.minRole === 'admin'));
  ok('match locations GET', routes.match(EXPECTED_LOCATIONS, 'GET') != null);
  ok('match endpoints GET', routes.match(EXPECTED_ENDPOINTS, 'GET') != null);
  ok('match locations POST null', routes.match(EXPECTED_LOCATIONS, 'POST') == null);
  ok('match endpoints PATCH null', routes.match(EXPECTED_ENDPOINTS, 'PATCH') == null);
  ok('match endpoints DELETE null', routes.match(EXPECTED_ENDPOINTS, 'DELETE') == null);
  ok('match other path null', routes.match('/staff/admin/config', 'GET') == null);

  // ── include_inactive strict parse ─────────────────────────────────────────
  console.log('\n── include_inactive parsing ──');
  {
    const omit = parseEmailRegistryIncludeInactive({});
    ok('omit → ok default all (admin inventory)', omit && omit.ok === true && omit.value === true);
    const t = parseEmailRegistryIncludeInactive({ include_inactive: 'true' });
    ok('true → ok true', t && t.ok === true && t.value === true);
    const f = parseEmailRegistryIncludeInactive({ include_inactive: 'false' });
    ok('false → ok false', f && f.ok === true && f.value === false);
    for (const bad of ['1', '0', 'yes', 'no', 'TRUE', 'False', 'maybe', ' true ']) {
      // only exact lowercase true|false accepted after trim? — contract: strict true|false
      const r = parseEmailRegistryIncludeInactive({ include_inactive: bad });
      if (bad === 'true' || bad === 'false') {
        ok(`strict accepts ${JSON.stringify(bad)}`, r.ok === true);
      } else if (String(bad).trim().toLowerCase() === 'true' || String(bad).trim().toLowerCase() === 'false') {
        // allow case-insensitive exact tokens after trim is acceptable if documented
        ok(`parse handles ${JSON.stringify(bad)}`, r.ok === true || r.ok === false);
      } else {
        ok(`invalid ${JSON.stringify(bad)} → fail`, r && r.ok === false);
      }
    }
    // Explicit invalids that must fail
    for (const bad of ['1', 'yes', 'no', 'maybe', 'active']) {
      const r = parseEmailRegistryIncludeInactive({ include_inactive: bad });
      ok(`reject ${JSON.stringify(bad)}`, r && r.ok === false);
    }
  }

  // ── Locations GET happy path + DTO allowlist ──────────────────────────────
  console.log('\n── locations GET DTO ──');
  {
    deps.listCalls.length = 0;
    deps.audit.length = 0;
    const res = mockRes();
    await routes.handleLocationsGet(
      { client: CLIENT_A_SLUG },
      mockReq(),
      res,
      { staff_user_id: 'admin-1', role: 'admin', allowed_clients: [CLIENT_A_SLUG] },
    );
    const body = parseBody(res.out);
    ok('locations status 200', res.out.statusCode === 200, `status=${res.out.statusCode} body=${res.out.body}`);
    ok('locations success', body && body.success === true);
    ok('locations array', body && Array.isArray(body.locations));
    ok('locations count 1', body && body.locations && body.locations.length === 1);
    const loc = body && body.locations && body.locations[0];
    const locKeys = loc ? Object.keys(loc).sort() : [];
    const expectedLocKeys = ['active', 'created_at', 'display_name', 'id', 'location_id', 'updated_at'].sort();
    ok('locations DTO keys exact', JSON.stringify(locKeys) === JSON.stringify(expectedLocKeys), JSON.stringify(locKeys));
    ok('locations no client_id', loc && loc.client_id === undefined);
    ok('locations no created_by', loc && loc.created_by === undefined);
    ok('locations no updated_by', loc && loc.updated_by === undefined);
    ok('locations no unexpected_column', loc && loc.unexpected_column === undefined);
    ok('locations list call once', deps.listCalls.filter((c) => c.fn === 'listTenantLocations').length === 1);
    const call = deps.listCalls.find((c) => c.fn === 'listTenantLocations');
    ok('locations repo clientId is resolved UUID', call && call.args.clientId === CLIENT_A_UUID, JSON.stringify(call && call.args));
    ok('locations repo includeInactive default true', call && call.args.includeInactive === true);
    ok('locations repo gets db dep', call && call.depsKeys.includes('db'));
    ok('locations audit success', deps.audit.some((e) => e.intent === 'api:admin.email_registry.locations.list' && e.success === true));
    ok('locations no secret_ref in response', !/secret_ref/.test(res.out.body || ''));
  }

  // ── Endpoints GET DTO redaction ───────────────────────────────────────────
  console.log('\n── endpoints GET DTO redaction ──');
  {
    deps.listCalls.length = 0;
    deps.audit.length = 0;
    const res = mockRes();
    await routes.handleChannelEndpointsGet(
      { client: CLIENT_A_SLUG },
      mockReq(),
      res,
      { staff_user_id: 'admin-1', role: 'admin', allowed_clients: [CLIENT_A_SLUG] },
    );
    const body = parseBody(res.out);
    ok('endpoints status 200', res.out.statusCode === 200, `status=${res.out.statusCode} body=${res.out.body}`);
    ok('endpoints success', body && body.success === true);
    ok('endpoints array', body && Array.isArray(body.endpoints));
    ok('endpoints count 1', body && body.endpoints && body.endpoints.length === 1);
    const ep = body && body.endpoints && body.endpoints[0];
    const epKeys = ep ? Object.keys(ep).sort() : [];
    const expectedEpKeys = [
      'active',
      'capabilities',
      'channel',
      'created_at',
      'default_automation_mode',
      'id',
      'inbound_enabled',
      'location_id',
      'outbound_enabled',
      'provider',
      'provider_resource_id',
      'public_address',
      'secret_ref_present',
      'updated_at',
    ].sort();
    ok('endpoints DTO keys exact', JSON.stringify(epKeys) === JSON.stringify(expectedEpKeys), JSON.stringify(epKeys));
    ok('secret_ref_present true when secret_ref set', ep && ep.secret_ref_present === true);
    ok('secret_ref omitted', ep && !Object.prototype.hasOwnProperty.call(ep, 'secret_ref'));
    ok('response body has no secret_ref key', !/"secret_ref"\s*:/.test(res.out.body || ''));
    ok('response body does not embed secret value', !(res.out.body || '').includes(SECRET_REF));
    ok('no created_by', ep && ep.created_by === undefined);
    ok('no updated_by', ep && ep.updated_by === undefined);
    ok('no client_id', ep && ep.client_id === undefined);
    ok('no unexpected_column', ep && ep.unexpected_column === undefined);
    const call = deps.listCalls.find((c) => c.fn === 'listTenantChannelEndpoints');
    ok('endpoints repo clientId UUID', call && call.args.clientId === CLIENT_A_UUID);
    ok('endpoints repo includeInactive default true', call && call.args.includeInactive === true);
    ok('endpoints audit', deps.audit.some((e) => e.intent === 'api:admin.email_registry.channel_endpoints.list' && e.success === true));
  }

  // secret_ref_present false when null/empty
  {
    const deps2 = makeDeps({
      async listTenantChannelEndpoints(args) {
        deps2.listCalls.push({ fn: 'listTenantChannelEndpoints', args: { ...args }, depsKeys: ['db'] });
        return {
          ok: true,
          value: [sampleEndpointRow({ secret_ref: null })],
        };
      },
    });
    deps2.listCalls = [];
    const routes2 = createEmailRegistryRoutes(deps2);
    const res = mockRes();
    await routes2.handleChannelEndpointsGet(
      { client: CLIENT_A_SLUG },
      mockReq(),
      res,
      { staff_user_id: 'a', role: 'admin', allowed_clients: [CLIENT_A_SLUG] },
    );
    const body = parseBody(res.out);
    const ep = body && body.endpoints && body.endpoints[0];
    ok('secret_ref_present false when null', ep && ep.secret_ref_present === false);
    ok('still no secret_ref key', ep && !Object.prototype.hasOwnProperty.call(ep, 'secret_ref'));
  }

  // ── include_inactive query → handler ──────────────────────────────────────
  console.log('\n── include_inactive handler ──');
  {
    deps.listCalls.length = 0;
    const res = mockRes();
    await routes.handleLocationsGet(
      { client: CLIENT_A_SLUG, include_inactive: 'false' },
      mockReq(),
      res,
      { staff_user_id: 'a', role: 'admin', allowed_clients: [CLIENT_A_SLUG] },
    );
    ok('include_inactive=false → 200', res.out.statusCode === 200);
    const call = deps.listCalls.find((c) => c.fn === 'listTenantLocations');
    ok('repo includeInactive false', call && call.args.includeInactive === false);
  }
  {
    const res = mockRes();
    await routes.handleLocationsGet(
      { client: CLIENT_A_SLUG, include_inactive: 'yes' },
      mockReq(),
      res,
      { staff_user_id: 'a', role: 'admin', allowed_clients: [CLIENT_A_SLUG] },
    );
    const body = parseBody(res.out);
    ok('invalid include_inactive → 400', res.out.statusCode === 400, `status=${res.out.statusCode}`);
    ok('invalid include_inactive message', body && /include_inactive/i.test(String(body.error || '')));
    ok('invalid include_inactive no SQL leak', !/SELECT|FROM tenant/i.test(res.out.body || ''));
  }

  // ── Auth metadata (router gate) ───────────────────────────────────────────
  console.log('\n── router auth gate (admin required) ──');
  {
    const r = await dispatchEmailRegistry({
      pathname: EXPECTED_LOCATIONS,
      method: 'GET',
      role: null,
      query: { client: CLIENT_A_SLUG },
      routes,
    });
    ok('unauthenticated → 401', r.res.statusCode === 401);
  }
  for (const role of ['viewer', 'operator']) {
    const r = await dispatchEmailRegistry({
      pathname: EXPECTED_LOCATIONS,
      method: 'GET',
      role,
      query: { client: CLIENT_A_SLUG },
      routes,
    });
    ok(`${role} locations denied 403`, r.res.statusCode === 403, `status=${r.res.statusCode}`);
  }
  for (const role of ['viewer', 'operator']) {
    const r = await dispatchEmailRegistry({
      pathname: EXPECTED_ENDPOINTS,
      method: 'GET',
      role,
      query: { client: CLIENT_A_SLUG },
      routes,
    });
    ok(`${role} endpoints denied 403`, r.res.statusCode === 403, `status=${r.res.statusCode}`);
  }
  for (const role of ['admin', 'owner']) {
    const r = await dispatchEmailRegistry({
      pathname: EXPECTED_LOCATIONS,
      method: 'GET',
      role,
      query: { client: CLIENT_A_SLUG },
      user: { staff_user_id: 'x', role, allowed_clients: [CLIENT_A_SLUG] },
      routes,
    });
    ok(`${role} locations allowed 200`, r.res.statusCode === 200, `status=${r.res.statusCode}`);
  }

  // Module itself does NOT 403 viewer (auth is router-side)
  {
    const res = mockRes();
    await routes.handleLocationsGet(
      { client: CLIENT_A_SLUG },
      mockReq(),
      res,
      { staff_user_id: 'v1', role: 'viewer', allowed_clients: [CLIENT_A_SLUG] },
    );
    ok(
      'module alone does not 403 viewer',
      res.out.statusCode === 200,
      `status=${res.out.statusCode} (auth must stay in router)`,
    );
  }

  // ── Tenant isolation ──────────────────────────────────────────────────────
  console.log('\n── tenant isolation ──');
  {
    deps.listCalls.length = 0;
    const res = mockRes();
    await routes.handleLocationsGet(
      { client: CLIENT_B_SLUG },
      mockReq(),
      res,
      { staff_user_id: 'a', role: 'admin', allowed_clients: [CLIENT_A_SLUG], denyClient: CLIENT_B_SLUG },
    );
    const body = parseBody(res.out);
    ok('cross-client slug → 403', res.out.statusCode === 403, `status=${res.out.statusCode}`);
    ok('cross-client error client_access_denied', body && body.error === 'client_access_denied');
    ok('cross-client no list call', deps.listCalls.length === 0, `calls=${deps.listCalls.length}`);
  }

  // client_id in query/body cannot alter scope
  {
    deps.listCalls.length = 0;
    const res = mockRes();
    await routes.handleChannelEndpointsGet(
      { client: CLIENT_A_SLUG, client_id: CLIENT_B_UUID },
      mockReq({ client_id: CLIENT_B_UUID, client: CLIENT_B_SLUG }),
      res,
      { staff_user_id: 'a', role: 'admin', allowed_clients: [CLIENT_A_SLUG] },
    );
    ok('query client_id ignored status 200', res.out.statusCode === 200, `status=${res.out.statusCode}`);
    const call = deps.listCalls.find((c) => c.fn === 'listTenantChannelEndpoints');
    ok(
      'repo still scoped to A UUID not B',
      call && call.args.clientId === CLIENT_A_UUID,
      JSON.stringify(call && call.args),
    );
    ok('repo never received B UUID', !deps.listCalls.some((c) => c.args.clientId === CLIENT_B_UUID));
    const body = parseBody(res.out);
    const ep = body && body.endpoints && body.endpoints[0];
    ok('tenant A rows only (location beach-house)', ep && ep.location_id === 'beach-house');
    ok('tenant A never sees B address', !(res.out.body || '').includes('b@example.com'));
    ok('tenant A never sees B location mountain-camp', !(res.out.body || '').includes('mountain-camp'));
  }

  // ── Requested-tenant admin_db_read (BLOCKER) ──────────────────────────────
  console.log('\n── requested-tenant admin_db_read ──');
  {
    const depsAuthz = makeDeps();
    depsAuthz.adminDbReadBySlug[CLIENT_A_SLUG] = true;
    depsAuthz.adminDbReadBySlug[CLIENT_B_SLUG] = false; // B disabled
    const routesAuthz = createEmailRegistryRoutes(depsAuthz);
    const multiAdmin = {
      staff_user_id: 'multi-1',
      role: 'admin',
      client_slug: CLIENT_A_SLUG, // home tenant A
      allowed_clients: [CLIENT_A_SLUG, CLIENT_B_SLUG],
    };

    depsAuthz.listCalls.length = 0;
    depsAuthz.slugLookups.length = 0;
    depsAuthz.authzCalls.length = 0;
    const resDeny = mockRes();
    await routesAuthz.handleLocationsGet(
      { client: CLIENT_B_SLUG },
      mockReq(),
      resDeny,
      multiAdmin,
    );
    const bodyDeny = parseBody(resDeny.out);
    ok('multi-client B admin_db_read=false → 403', resDeny.out.statusCode === 403, `status=${resDeny.out.statusCode} body=${resDeny.out.body}`);
    ok(
      'deny reason_code admin_db_read_disabled',
      bodyDeny && bodyDeny.reason_code === 'admin_db_read_disabled',
      JSON.stringify(bodyDeny),
    );
    ok('deny error tenant_route_forbidden', bodyDeny && bodyDeny.error === 'tenant_route_forbidden');
    ok('deny zero list queries', depsAuthz.listCalls.length === 0, `listCalls=${depsAuthz.listCalls.length}`);
    ok('deny zero UUID lookups', depsAuthz.slugLookups.length === 0, `slugLookups=${JSON.stringify(depsAuthz.slugLookups)}`);
    ok(
      'authz called for requested B (not only home A)',
      depsAuthz.authzCalls.some((c) => c.clientSlug === CLIENT_B_SLUG),
      JSON.stringify(depsAuthz.authzCalls),
    );
    ok(
      'authz pathname is locations path',
      depsAuthz.authzCalls.some((c) => c.pathname === EXPECTED_LOCATIONS && c.method === 'GET'),
      JSON.stringify(depsAuthz.authzCalls),
    );
    ok(
      'authz receives runtime env object',
      depsAuthz.authzCalls.every((c) => c.hasEnv === true),
    );

    // Endpoints path same deny
    depsAuthz.listCalls.length = 0;
    depsAuthz.slugLookups.length = 0;
    const resDenyEp = mockRes();
    await routesAuthz.handleChannelEndpointsGet(
      { client: CLIENT_B_SLUG },
      mockReq(),
      resDenyEp,
      multiAdmin,
    );
    const bodyDenyEp = parseBody(resDenyEp.out);
    ok('multi-client B endpoints → 403', resDenyEp.out.statusCode === 403);
    ok(
      'endpoints deny reason admin_db_read_disabled',
      bodyDenyEp && bodyDenyEp.reason_code === 'admin_db_read_disabled',
    );
    ok('endpoints deny zero list/UUID', depsAuthz.listCalls.length === 0 && depsAuthz.slugLookups.length === 0);

    // B enabled → allowed; repository receives only B UUID
    depsAuthz.adminDbReadBySlug[CLIENT_B_SLUG] = true;
    depsAuthz.listCalls.length = 0;
    depsAuthz.slugLookups.length = 0;
    depsAuthz.authzCalls.length = 0;
    const resAllow = mockRes();
    await routesAuthz.handleChannelEndpointsGet(
      { client: CLIENT_B_SLUG },
      mockReq(),
      resAllow,
      multiAdmin,
    );
    const bodyAllow = parseBody(resAllow.out);
    ok('multi-client B enabled → 200', resAllow.out.statusCode === 200, `status=${resAllow.out.statusCode}`);
    ok('B enabled success', bodyAllow && bodyAllow.success === true);
    const callB = depsAuthz.listCalls.find((c) => c.fn === 'listTenantChannelEndpoints');
    ok('repo receives only B UUID', callB && callB.args.clientId === CLIENT_B_UUID, JSON.stringify(callB && callB.args));
    ok('repo never received A UUID for B request', !depsAuthz.listCalls.some((c) => c.args.clientId === CLIENT_A_UUID));
    ok('authz for B before list', depsAuthz.authzCalls.some((c) => c.clientSlug === CLIENT_B_SLUG && c.pathname === EXPECTED_ENDPOINTS));

    // Home A still works while B disabled (ACL + A admin_db_read)
    depsAuthz.adminDbReadBySlug[CLIENT_B_SLUG] = false;
    depsAuthz.listCalls.length = 0;
    const resA = mockRes();
    await routesAuthz.handleLocationsGet(
      { client: CLIENT_A_SLUG },
      mockReq(),
      resA,
      multiAdmin,
    );
    ok('home A still allowed while B disabled', resA.out.statusCode === 200);

    // Real authorizer: process-level reserved tenants retain existing behavior (no new exception list in routes)
    {
      const tbc = require('./lib/tenant-business-config');
      const depsReal = makeDeps({
        authorizeAuthenticatedStaffRoute: tbc.authorizeAuthenticatedStaffRoute,
        runtimeEnv: {
          SUNSET_ADMIN_DB_READ_ENABLED: 'true',
          STAFF_ACTIONS_ENABLED: 'false',
        },
      });
      const routesReal = createEmailRegistryRoutes(depsReal);
      depsReal.listCalls.length = 0;
      const resReserved = mockRes();
      await routesReal.handleLocationsGet(
        { client: 'wolfhouse-somo' },
        mockReq(),
        resReserved,
        { staff_user_id: 'a', role: 'admin', allowed_clients: ['wolfhouse-somo'] },
      );
      ok(
        'reserved wolfhouse-somo uses process_level authorizer path (200)',
        resReserved.out.statusCode === 200,
        `status=${resReserved.out.statusCode} body=${resReserved.out.body}`,
      );
      // Real authorizer: generic tenant with admin_db_read false in runtime config
      const tenantCfg = {
        version: 1,
        tenant_slug: CLIENT_B_SLUG,
        permissions: {
          admin_db_read: false,
          admin_writes: false,
          stripe_links: false,
          staff_actions: false,
          whatsapp_dry_run: true,
        },
        locations: [
          { location_id: `${CLIENT_B_SLUG}-main`, display_name: 'Main', channel_slot: 1 },
        ],
      };
      const depsRealB = makeDeps({
        authorizeAuthenticatedStaffRoute: tbc.authorizeAuthenticatedStaffRoute,
        runtimeEnv: {
          SUNSET_ADMIN_DB_READ_ENABLED: 'true', // process on, tenant B off
          TENANT_RUNTIME_CONFIG_JSON: JSON.stringify(tenantCfg),
        },
      });
      const routesRealB = createEmailRegistryRoutes(depsRealB);
      depsRealB.listCalls.length = 0;
      depsRealB.slugLookups.length = 0;
      const resRealB = mockRes();
      await routesRealB.handleLocationsGet(
        { client: CLIENT_B_SLUG },
        mockReq(),
        resRealB,
        { staff_user_id: 'a', role: 'admin', allowed_clients: [CLIENT_A_SLUG, CLIENT_B_SLUG], client_slug: CLIENT_A_SLUG },
      );
      const bodyRealB = parseBody(resRealB.out);
      ok('real authorizer B admin_db_read=false → 403', resRealB.out.statusCode === 403, `status=${resRealB.out.statusCode}`);
      ok(
        'real authorizer reason admin_db_read_disabled',
        bodyRealB && bodyRealB.reason_code === 'admin_db_read_disabled',
        JSON.stringify(bodyRealB),
      );
      ok('real authorizer zero UUID/list', depsRealB.listCalls.length === 0 && depsRealB.slugLookups.length === 0);
    }

    // Factory requires authorizer inject
    {
      let threw = false;
      try {
        const bad = makeDeps();
        delete bad.authorizeAuthenticatedStaffRoute;
        createEmailRegistryRoutes(bad);
      } catch (_) {
        threw = true;
      }
      ok('factory requires authorizeAuthenticatedStaffRoute', threw);
    }
  }

  // ── Fail-closed capabilities DTO (BLOCKER) ────────────────────────────────
  console.log('\n── capabilities fail-closed DTO ──');
  {
    const EXPECTED_CAP_KEYS = [
      'push_notifications',
      'provider_threads',
      'remote_drafts',
      'reply',
      'reply_all',
      'forward',
      'attachments_metadata',
      'delivery_events',
    ].sort();

    // Valid → exactly eight booleans
    {
      const res = mockRes();
      await routes.handleChannelEndpointsGet(
        { client: CLIENT_A_SLUG },
        mockReq(),
        res,
        { staff_user_id: 'a', role: 'admin', allowed_clients: [CLIENT_A_SLUG] },
      );
      const body = parseBody(res.out);
      const ep = body && body.endpoints && body.endpoints[0];
      const caps = ep && ep.capabilities;
      const capKeys = caps ? Object.keys(caps).sort() : [];
      ok('valid capabilities status 200', res.out.statusCode === 200);
      ok('valid capabilities exactly eight keys', capKeys.length === 8 && JSON.stringify(capKeys) === JSON.stringify(EXPECTED_CAP_KEYS), JSON.stringify(capKeys));
      ok(
        'valid capabilities all boolean',
        caps && EXPECTED_CAP_KEYS.every((k) => caps[k] === true || caps[k] === false),
      );
      ok('valid capabilities no nested/extra', caps && !Object.prototype.hasOwnProperty.call(caps, 'secret_ref') && !Object.prototype.hasOwnProperty.call(caps, 'nested'));
    }

    // Hostile capabilities must not leak; sanitized 500
    {
      const hostile = {
        secret_ref: 'kv:LEAK',
        created_by: 'AUDIT',
        nested: { client_id: 'TENANT' },
      };
      const depsHostile = makeDeps({
        async listTenantChannelEndpoints(args) {
          depsHostile.listCalls.push({ fn: 'listTenantChannelEndpoints', args: { ...args }, depsKeys: ['db'] });
          return {
            ok: true,
            value: [sampleEndpointRow({ capabilities: hostile })],
          };
        },
      });
      depsHostile.listCalls = [];
      depsHostile.audit = [];
      // re-bind audit push
      depsHostile.appendAuditLog = (entry) => { depsHostile.audit.push(entry); };
      const routesHostile = createEmailRegistryRoutes(depsHostile);
      const res = mockRes();
      await routesHostile.handleChannelEndpointsGet(
        { client: CLIENT_A_SLUG },
        mockReq(),
        res,
        { staff_user_id: 'a', role: 'admin', allowed_clients: [CLIENT_A_SLUG] },
      );
      const body = parseBody(res.out);
      const raw = res.out.body || '';
      ok('hostile capabilities → 500', res.out.statusCode === 500, `status=${res.out.statusCode} body=${raw}`);
      ok('hostile sanitized error read failed', body && body.success === false && body.error === 'read failed');
      ok('hostile response has no kv:LEAK', !raw.includes('kv:LEAK') && !raw.includes('secret_ref'));
      ok('hostile response has no AUDIT created_by', !raw.includes('AUDIT') && !/"created_by"/.test(raw));
      ok('hostile response has no TENANT client_id nest', !raw.includes('TENANT') && !raw.includes('nested'));
      ok('hostile no partial endpoints array', !body || body.endpoints === undefined);
      ok(
        'hostile audit uses allowlisted capabilities_invalid',
        depsHostile.audit.some((e) => e.success === false && e.error === 'capabilities_invalid'),
        JSON.stringify(depsHostile.audit),
      );
    }

    // Missing key / non-boolean / extra key → 500
    for (const [label, caps] of [
      ['missing_key', {
        push_notifications: false,
        provider_threads: false,
        remote_drafts: false,
        reply: false,
        reply_all: false,
        forward: false,
        attachments_metadata: false,
        // delivery_events missing
      }],
      ['non_boolean', {
        push_notifications: 'yes',
        provider_threads: false,
        remote_drafts: false,
        reply: false,
        reply_all: false,
        forward: false,
        attachments_metadata: false,
        delivery_events: false,
      }],
      ['extra_key', {
        push_notifications: false,
        provider_threads: false,
        remote_drafts: false,
        reply: false,
        reply_all: false,
        forward: false,
        attachments_metadata: false,
        delivery_events: false,
        evil: true,
      }],
    ]) {
      const d = makeDeps({
        async listTenantChannelEndpoints(args) {
          d.listCalls.push({ fn: 'listTenantChannelEndpoints', args: { ...args }, depsKeys: ['db'] });
          return { ok: true, value: [sampleEndpointRow({ capabilities: caps })] };
        },
      });
      d.listCalls = [];
      const r = createEmailRegistryRoutes(d);
      const res = mockRes();
      await r.handleChannelEndpointsGet(
        { client: CLIENT_A_SLUG },
        mockReq(),
        res,
        { staff_user_id: 'a', role: 'admin', allowed_clients: [CLIENT_A_SLUG] },
      );
      ok(`capabilities ${label} → 500`, res.out.statusCode === 500, `status=${res.out.statusCode}`);
      ok(`capabilities ${label} no partial row`, !/beach-house|support@example/.test(res.out.body || ''));
    }
  }

  // ── db_error sanitized + raw log leakage ──────────────────────────────────
  console.log('\n── error mapping + log redaction ──');
  {
    const depsErr = makeDeps({
      async listTenantLocations() {
        return { ok: false, error: 'db_error', details: { pg: 'relation "tenant_locations" does not exist', code: '42P01' } };
      },
    });
    const routesErr = createEmailRegistryRoutes(depsErr);
    const res = mockRes();
    await routesErr.handleLocationsGet(
      { client: CLIENT_A_SLUG },
      mockReq(),
      res,
      { staff_user_id: 'a', role: 'admin', allowed_clients: [CLIENT_A_SLUG] },
    );
    const body = parseBody(res.out);
    ok('db_error → 500', res.out.statusCode === 500, `status=${res.out.statusCode}`);
    ok('db_error success false', body && body.success === false);
    ok('db_error no raw PG relation', !/tenant_locations|42P01|does not exist/i.test(res.out.body || ''));
    ok('db_error stable error field', body && (body.error === 'read failed' || body.error === 'db_error'));
  }

  // Arbitrary repository error text must not reach audit as-is
  {
    const depsInj = makeDeps({
      async listTenantLocations() {
        return { ok: false, error: 'password=LEAK secret_ref=kv:LEAK' };
      },
    });
    depsInj.audit = [];
    depsInj.appendAuditLog = (e) => { depsInj.audit.push(e); };
    const routesInj = createEmailRegistryRoutes(depsInj);
    const res = mockRes();
    await routesInj.handleLocationsGet(
      { client: CLIENT_A_SLUG },
      mockReq(),
      res,
      { staff_user_id: 'a', role: 'admin', allowed_clients: [CLIENT_A_SLUG] },
    );
    const auditJson = JSON.stringify(depsInj.audit);
    ok('injected repo error not in audit', !auditJson.includes('password=LEAK') && !auditJson.includes('kv:LEAK'));
    ok(
      'audit uses allowlisted db_error',
      depsInj.audit.some((e) => e.success === false && e.error === 'db_error'),
      auditJson,
    );
    ok('response has no injected leak', !(res.out.body || '').includes('password=LEAK'));
  }

  // Console interception: thrown Error with hostile message must not reach stdout/stderr
  {
    const logs = [];
    const origError = console.error;
    const origLog = console.log;
    const origWarn = console.warn;
    const origInfo = console.info;
    const capture = (...args) => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    let probeStatus = null;
    let probeBody = '';
    let probeAudit = [];
    try {
      console.error = capture;
      console.log = capture;
      console.warn = capture;
      console.info = capture;
      const depsThrow = makeDeps({
        async withPgClient() {
          const err = new Error('password=LEAK secret_ref=kv:LEAK');
          err.code = 'ECONNREFUSED';
          throw err;
        },
      });
      depsThrow.audit = [];
      depsThrow.appendAuditLog = (e) => { depsThrow.audit.push(e); };
      const routesThrow = createEmailRegistryRoutes(depsThrow);
      const res = mockRes();
      await routesThrow.handleLocationsGet(
        { client: CLIENT_A_SLUG },
        mockReq(),
        res,
        { staff_user_id: 'a', role: 'admin', allowed_clients: [CLIENT_A_SLUG] },
      );
      probeStatus = res.out.statusCode;
      probeBody = res.out.body || '';
      probeAudit = depsThrow.audit.slice();
    } finally {
      console.error = origError;
      console.log = origLog;
      console.warn = origWarn;
      console.info = origInfo;
    }
    const allLogs = logs.join('\n');
    const auditJson = JSON.stringify(probeAudit);
    ok('throw probe status 500', probeStatus === 500, `status=${probeStatus}`);
    ok('throw probe response no password=LEAK', !probeBody.includes('password=LEAK'));
    ok('throw probe response no secret_ref=kv:LEAK', !probeBody.includes('secret_ref=kv:LEAK') && !probeBody.includes('kv:LEAK'));
    ok('throw probe logs no password=LEAK', !allLogs.includes('password=LEAK'), allLogs.slice(0, 300));
    ok('throw probe logs no secret_ref=kv:LEAK', !allLogs.includes('secret_ref=kv:LEAK') && !allLogs.includes('kv:LEAK'), allLogs.slice(0, 300));
    ok('throw probe audit no password=LEAK', !auditJson.includes('password=LEAK') && !auditJson.includes('kv:LEAK'));
    ok(
      'throw probe logs bounded category/code',
      allLogs.includes('category=') && allLogs.includes('code=') && /code=ECONNREFUSED|code=unknown|code=pg_error/.test(allLogs),
      allLogs.slice(0, 300),
    );
  }

  // Module source must not interpolate err.message in email-registry logs
  {
    const modSrc = fs.readFileSync(MODULE_PATH, 'utf8');
    const modNoComments = modSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    ok(
      'module does not log err.message',
      !/console\.(?:error|log|warn|info|debug)\([^)]*err\.message/.test(modNoComments)
        && !/console\.(?:error|log|warn|info|debug)\([^)]*\$\{[^}]*err\.message/.test(modSrc),
    );
    ok(
      'module does not interpolate raw error string into console',
      !/console\.(?:error|log|warn|info)\([^)]*\|\s*['"]?\s*\+|console\.(?:error|log)\([^)]*err\s*&&\s*err\.message/.test(modNoComments),
    );
  }

  // SQL inject client slug
  {
    const res = mockRes();
    await routes.handleLocationsGet(
      { client: "wol'; DROP" },
      mockReq(),
      res,
      { staff_user_id: 'a', role: 'admin' },
    );
    ok('bad client slug → 400', res.out.statusCode === 400);
  }

  // Unknown client slug after ACL → stable not-found (no row existence leak for endpoints)
  {
    deps.listCalls.length = 0;
    const res = mockRes();
    await routes.handleLocationsGet(
      { client: 'unknown-tenant' },
      mockReq(),
      res,
      { staff_user_id: 'a', role: 'admin', allowed_clients: ['unknown-tenant'] },
    );
    ok('unknown client → 404 or empty-safe', res.out.statusCode === 404 || res.out.statusCode === 200, `status=${res.out.statusCode}`);
    if (res.out.statusCode === 404) {
      const body = parseBody(res.out);
      ok('unknown client no list', deps.listCalls.length === 0);
      ok('unknown client stable error', body && body.success === false);
    }
  }

  // Method not allowed
  {
    const r = await dispatchEmailRegistry({
      pathname: EXPECTED_LOCATIONS,
      method: 'POST',
      role: 'admin',
      routes,
    });
    ok('POST locations → 405', r.methodDenied === true && r.res.statusCode === 405);
  }
  {
    const r = await dispatchEmailRegistry({
      pathname: EXPECTED_ENDPOINTS,
      method: 'DELETE',
      role: 'admin',
      routes,
    });
    ok('DELETE endpoints → 405', r.methodDenied === true && r.res.statusCode === 405);
  }

  // ── No writes / activation / provider imports ─────────────────────────────
  console.log('\n── boundary: no writes / no providers ──');
  {
    const modSrc = fs.readFileSync(MODULE_PATH, 'utf8');
    const modNoComments = modSrc
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    ok('module does not call requireAuth', !/\brequireAuth\s*\(/.test(modNoComments));
    ok('module does not import createTenantLocation', !/createTenantLocation/.test(modNoComments));
    ok('module does not import createDisabledTenantChannelEndpoint', !/createDisabledTenantChannelEndpoint/.test(modNoComments));
    ok('module does not import provider SDK', !/\b(?:microsoft|graph|gmail|imap|nodemailer|googleapis)\b/i.test(modNoComments));
    ok('module does not open global Pool', !/new\s+Pool\b|createPool\b|DATABASE_URL|PG_CONNECTION/i.test(modNoComments));
    ok('module uses listTenantLocations', /listTenantLocations/.test(modSrc));
    ok('module uses listTenantChannelEndpoints', /listTenantChannelEndpoints/.test(modSrc));
    ok('module redacts secret_ref', /secret_ref_present/.test(modSrc));
    ok('module never logs secret_ref value', !/console\.(log|info|warn|error|debug)\([^)]*secret_ref/i.test(modNoComments));
    ok('module reuses Slice 1A capability validator', /validateEmailMailboxCapabilities/.test(modSrc));
    ok('module invokes authorizeAuthenticatedStaffRoute', /authorizeAuthenticatedStaffRoute\s*\(/.test(modNoComments));
  }

  // ── staff-query-api wiring ────────────────────────────────────────────────
  console.log('\n── staff-query-api wiring ──');
  const apiSrc = fs.readFileSync(API_PATH, 'utf8');
  ok('requires email-registry module', /require\('\.\/lib\/staff-email-registry-routes'\)/.test(apiSrc));
  ok('createEmailRegistryRoutes called', /createEmailRegistryRoutes\s*\(/.test(apiSrc));
  ok('EMAIL_REGISTRY_LOCATIONS_PATH used', /EMAIL_REGISTRY_LOCATIONS_PATH/.test(apiSrc));
  ok('EMAIL_REGISTRY_ENDPOINTS_PATH used', /EMAIL_REGISTRY_ENDPOINTS_PATH/.test(apiSrc));
  ok(
    'injects authorizeAuthenticatedStaffRoute into email registry factory',
    /createEmailRegistryRoutes\s*\(\s*\{[\s\S]*?authorizeAuthenticatedStaffRoute[\s\S]*?\}\s*\)/.test(apiSrc),
  );

  const locAuthRe = /pathname === EMAIL_REGISTRY_LOCATIONS_PATH && method === 'GET'[\s\S]{0,220}?requireAuth\(\s*req\s*,\s*res\s*,\s*'admin'\s*\)/;
  const epAuthRe = /pathname === EMAIL_REGISTRY_ENDPOINTS_PATH && method === 'GET'[\s\S]{0,220}?requireAuth\(\s*req\s*,\s*res\s*,\s*'admin'\s*\)/;
  ok('locations route requireAuth admin', locAuthRe.test(apiSrc));
  ok('endpoints route requireAuth admin', epAuthRe.test(apiSrc));
  ok(
    'locations dispatches handler',
    /return handleEmailRegistryLocationsGet\(parsed\.query, req, res, auth\.user\)/.test(apiSrc)
      || /return handleLocationsGet\(parsed\.query, req, res, auth\.user\)/.test(apiSrc)
      || /handleEmailRegistryLocationsGet|emailRegistryRoutes\.handleLocationsGet/.test(apiSrc),
  );
  ok(
    'endpoints dispatches handler',
    /return handleEmailRegistryChannelEndpointsGet\(parsed\.query, req, res, auth\.user\)/.test(apiSrc)
      || /return handleChannelEndpointsGet\(parsed\.query, req, res, auth\.user\)/.test(apiSrc)
      || /handleEmailRegistryChannelEndpointsGet|emailRegistryRoutes\.handleChannelEndpointsGet/.test(apiSrc),
  );

  // No POST/PATCH/DELETE wiring for these paths
  ok(
    'no POST wiring for email-registry locations',
    !/EMAIL_REGISTRY_LOCATIONS_PATH && method === 'POST'/.test(apiSrc),
  );
  ok(
    'no PATCH wiring for email-registry endpoints',
    !/EMAIL_REGISTRY_ENDPOINTS_PATH && method === 'PATCH'/.test(apiSrc),
  );

  // ── package + boundary doc ────────────────────────────────────────────────
  console.log('\n── package + boundary doc ──');
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  ok(
    'package script verify:staff-email-registry-routes',
    pkg.scripts && pkg.scripts['verify:staff-email-registry-routes'] === `node ${VERIFY_REL}`,
  );
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  ok('boundary doc mentions 1C-beta', /1C-beta/i.test(doc));
  ok('boundary doc documents locations path', doc.includes(EXPECTED_LOCATIONS));
  ok('boundary doc documents endpoints path', doc.includes(EXPECTED_ENDPOINTS));
  ok('boundary doc notes secret_ref redacted', /secret_ref_present|redact/i.test(doc));

  // Registry still has list functions; routes must not mutate domain module exports of writes into route surface
  const regSrc = fs.readFileSync(REGISTRY_PATH, 'utf8');
  ok('domain listTenantLocations still present', /function listTenantLocations/.test(regSrc));
  ok('domain listTenantChannelEndpoints still present', /function listTenantChannelEndpoints/.test(regSrc));

  // ── Secret scan on new files ──────────────────────────────────────────────
  console.log('\n── secret scan (added files) ──');
  function scanSecrets(label, text) {
    const hit = looksLikeEmbeddedSecret(text || '');
    ok(`secret-scan-${label}`, !hit, hit || '');
  }
  scanSecrets('route-module', fs.readFileSync(MODULE_PATH, 'utf8'));
  scanSecrets('verifier', fs.readFileSync(path.join(ROOT, VERIFY_REL), 'utf8'));
  // SECRET_REF fixture is opaque kv: label, not a live secret.
  // Avoid self-matching this assertion's source by scanning only payload-like assigns.
  {
    const vSrc = fs.readFileSync(path.join(ROOT, VERIFY_REL), 'utf8');
    const liveAssign = /(?:secret|token|key)\s*[:=]\s*['"]sk_(?:live|test)_[A-Za-z0-9]{8,}/i.test(vSrc);
    ok('verifier has no sk-live token assigns', !liveAssign);
  }

  // ── Syntax ────────────────────────────────────────────────────────────────
  console.log('\n── syntax ──');
  for (const rel of [
    MODULE_REL,
    'scripts/staff-query-api.js',
    VERIFY_REL,
  ]) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
    ok(`node --check ${rel}`, r.status === 0, (r.stderr || r.stdout || '').slice(0, 200));
  }

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
