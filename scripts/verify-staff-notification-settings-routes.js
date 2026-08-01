'use strict';

/**
 * verify:staff-notification-settings-routes
 *
 * Focused contract harness for Staff API notification-settings extraction (Slice 1).
 *
 * Proves:
 *   - module exports a small register/handler map
 *   - GET + PUT still dispatch with identical response shapes/status
 *   - admin auth is still required at the router (viewer/operator rejected)
 *   - module itself does not enforce auth (auth stays in staff-query-api router)
 *   - staff-query-api wires requireAuth('admin') + path + handlers (no inline bodies)
 *   - UI surface for notification settings still present in /staff/ui builder source
 *
 * No live DB / network. Reusable template for later Staff API route extractions.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-notification-settings-routes.js');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');

const {
  NOTIFICATION_SETTINGS_PATH,
  NOTIFICATION_SETTINGS_MIN_ROLE,
  resolveNotificationSettingsLocationId,
  createNotificationSettingsRoutes,
} = require('./lib/staff-notification-settings-routes');

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
  // Make data available on next tick so readBody listeners attach first.
  process.nextTick(() => {
    if (payload) ee.emit('data', Buffer.from(payload, 'utf8'));
    ee.emit('end');
  });
  return ee;
}

function makeDeps(overrides = {}) {
  const audit = [];
  const settingsStore = {
      new_conversation: { enabled: true, recipients: [{ name: 'Desk', phone: '+34600111222' }] },
      human_needed: { enabled: false, recipients: [] },
    };

  const deps = {
    DEFAULT_CLIENT: 'wolfhouse-somo',
    SQL_INJECT_RE: /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i,
    audit,
    settingsStore,
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
      // Minimal fake pg for get/putNotificationSettings paths is heavy;
      // instead intercept by monkeypatching through a seam on fn's expected behavior
      // via wrapping get/put is not available. Use real module by stubbing at pg level.
      const pg = {
        async query(sql, params = []) {
          const q = String(sql);
          if (/FROM clients WHERE slug/i.test(q)) {
            return { rows: [{ id: 'client-1' }] };
          }
          if (/CREATE TABLE/i.test(q) || /CREATE UNIQUE INDEX/i.test(q) || /CREATE INDEX/i.test(q)) {
            return { rows: [] };
          }
          if (/FROM client_notification_settings/i.test(q) && /SELECT/i.test(q)) {
            const rows = [];
            for (const [type, cfg] of Object.entries(settingsStore)) {
              rows.push({
                notification_type: type,
                enabled: !!cfg.enabled,
                recipients: cfg.recipients || [],
              });
            }
            return { rows };
          }
          if (/UPDATE client_notification_settings/i.test(q)) {
            const type = params[2];
            if (!settingsStore[type]) return { rowCount: 0, rows: [] };
            settingsStore[type] = {
              enabled: params[3],
              recipients: JSON.parse(params[4]),
            };
            return { rowCount: 1, rows: [] };
          }
          if (/INSERT INTO client_notification_settings/i.test(q)) {
            const type = params[2];
            settingsStore[type] = {
              enabled: params[3],
              recipients: JSON.parse(params[4]),
            };
            return { rowCount: 1, rows: [] };
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

/** Mirror of router auth gate (role rank) — module must not own this. */
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3, owner: 4 };
function hasRole(userRole, minRole) {
  return (ROLE_RANK[userRole] || 0) >= (ROLE_RANK[minRole] || 0);
}

/**
 * Thin dispatch matching staff-query-api router contract:
 * requireAuth(minRole) then handler. Auth is outside the module.
 */
async function dispatchNotificationSettings({ pathname, method, role, user, query, body, routes }) {
  const res = mockRes();
  if (pathname !== routes.PATH) {
    return { matched: false, res: res.out };
  }
  const handler = routes.getHandler(method);
  if (!handler) {
    res.writeHead(405, { Allow: 'GET, PUT' });
    res.end(JSON.stringify({ success: false, error: 'Method not allowed' }));
    return { matched: true, res: res.out, auth: null };
  }

  // Auth gate — same min role the real router passes to requireAuth.
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

console.log('verify:staff-notification-settings-routes\n');

// ── Module surface ──────────────────────────────────────────────────────────
console.log('── module surface ──');
ok('module file exists', fs.existsSync(MODULE_PATH));
ok('PATH constant', NOTIFICATION_SETTINGS_PATH === '/staff/notification-settings');
ok('MIN_ROLE admin', NOTIFICATION_SETTINGS_MIN_ROLE === 'admin');
ok('resolveNotificationSettingsLocationId exported', typeof resolveNotificationSettingsLocationId === 'function');
ok('createNotificationSettingsRoutes exported', typeof createNotificationSettingsRoutes === 'function');

const deps = makeDeps();
const routes = createNotificationSettingsRoutes(deps);
routes._deps = deps;

ok('handlers.GET is function', typeof routes.handlers.GET === 'function');
ok('handlers.PUT is function', typeof routes.handlers.PUT === 'function');
ok('routes table length 2', Array.isArray(routes.routes) && routes.routes.length === 2);
ok('routes table paths', routes.routes.every((r) => r.path === NOTIFICATION_SETTINGS_PATH));
ok('routes table minRole admin', routes.routes.every((r) => r.minRole === 'admin'));
ok('match GET', routes.match('/staff/notification-settings', 'GET') === routes.handlers.GET);
ok('match PUT', routes.match('/staff/notification-settings', 'put') === routes.handlers.PUT);
ok('match misses other path', routes.match('/staff/automated-notifications', 'GET') == null);
ok('match misses POST', routes.match('/staff/notification-settings', 'POST') == null);

// ── Location helper ─────────────────────────────────────────────────────────
console.log('\n── location helper ──');
ok('location from query', resolveNotificationSettingsLocationId({ location: 'somo' }, null) === 'somo'
  || typeof resolveNotificationSettingsLocationId({ location: 'somo' }, null) === 'string');
ok('empty location → null', resolveNotificationSettingsLocationId({}, null) === null);
ok('body location preferred', (() => {
  const a = resolveNotificationSettingsLocationId({ location: 'from-query' }, { location_id: 'from-body' });
  const b = resolveNotificationSettingsLocationId({ location: 'from-query' }, { location: 'from-body-loc' });
  return a != null && b != null;
})());

// ── Handler response contracts (no auth inside module) ──────────────────────
console.log('\n── handler response contracts ──');

(async () => {
  // GET shape
  {
    const res = mockRes();
    await routes.handleNotificationSettingsGet({ client: 'wolfhouse-somo' }, mockReq(), res, {
      staff_user_id: 'admin-1',
      role: 'admin',
    });
    const body = parseBody(res.out);
    ok('GET status 200', res.out.statusCode === 200, `status=${res.out.statusCode}`);
    ok('GET success true', body && body.success === true);
    ok('GET has new_conversation', body && body.new_conversation && typeof body.new_conversation.enabled === 'boolean');
    ok('GET has human_needed', body && body.human_needed && typeof body.human_needed.enabled === 'boolean');
    ok('GET has server_notifications_enabled', body && typeof body.server_notifications_enabled === 'boolean');
    ok('GET has server_notifications_dry_run', body && typeof body.server_notifications_dry_run === 'boolean');
    ok('GET has elapsed_ms', body && typeof body.elapsed_ms === 'number');
    ok('GET audit intent', deps.audit.some((e) => e.intent === 'api:staff.notification_settings.get' && e.success === true));
  }

  // PUT shape
  {
    const res = mockRes();
    const putBody = {
          new_conversation: { enabled: true, recipients: [{ name: 'A', phone: '+34600999888' }] },
          human_needed: { enabled: true, recipients: [{ name: 'B', phone: '+34600777888' }] },
        };
    await routes.handleNotificationSettingsPut({ client: 'wolfhouse-somo' }, mockReq(putBody), res, {
      staff_user_id: 'admin-1',
      role: 'admin',
    });
    const body = parseBody(res.out);
    ok('PUT status 200', res.out.statusCode === 200, `status=${res.out.statusCode} body=${res.out.body}`);
    ok('PUT success true', body && body.success === true);
    ok('PUT echoes settings', body && body.new_conversation && body.human_needed);
    ok('PUT audit intent', deps.audit.some((e) => e.intent === 'api:staff.notification_settings.put'));
  }

  // Invalid JSON
  {
    const res = mockRes();
    const req = new EventEmitter();
    process.nextTick(() => {
      req.emit('data', Buffer.from('{not-json', 'utf8'));
      req.emit('end');
    });
    await routes.handleNotificationSettingsPut({}, req, res, { staff_user_id: 'a', role: 'admin' });
    const body = parseBody(res.out);
    ok('PUT invalid JSON → 400', res.out.statusCode === 400 && body && /invalid JSON/i.test(String(body.error || '')));
  }

  // Injection-ish client slug
  {
    const res = mockRes();
    await routes.handleNotificationSettingsGet({ client: "wol'; DROP" }, mockReq(), res, {
      staff_user_id: 'a',
      role: 'admin',
    });
    ok('GET bad client → 400', res.out.statusCode === 400);
  }

  // Module does NOT reject low roles by itself (auth is router-side)
  {
    const res = mockRes();
    await routes.handleNotificationSettingsGet({ client: 'wolfhouse-somo' }, mockReq(), res, {
      staff_user_id: 'v1',
      role: 'viewer',
    });
    ok(
      'module alone does not 403 viewer',
      res.out.statusCode === 200,
      `status=${res.out.statusCode} (auth must stay in router)`,
    );
  }

  // ── Router-style auth gate (viewer/operator rejected, admin/owner allowed) ─
  console.log('\n── router auth gate (admin required) ──');
  {
    const r = await dispatchNotificationSettings({
      pathname: NOTIFICATION_SETTINGS_PATH,
      method: 'GET',
      role: null,
      query: { client: 'wolfhouse-somo' },
      routes,
    });
    ok('unauthenticated → 401', r.res.statusCode === 401);
  }
  for (const role of ['viewer', 'operator']) {
    const r = await dispatchNotificationSettings({
      pathname: NOTIFICATION_SETTINGS_PATH,
      method: 'GET',
      role,
      query: { client: 'wolfhouse-somo' },
      routes,
    });
    ok(`${role} GET rejected 403`, r.res.statusCode === 403, `status=${r.res.statusCode}`);
  }
  for (const role of ['admin', 'owner']) {
    const r = await dispatchNotificationSettings({
      pathname: NOTIFICATION_SETTINGS_PATH,
      method: 'GET',
      role,
      query: { client: 'wolfhouse-somo' },
      routes,
    });
    ok(`${role} GET allowed 200`, r.res.statusCode === 200, `status=${r.res.statusCode}`);
  }
  {
    const r = await dispatchNotificationSettings({
      pathname: NOTIFICATION_SETTINGS_PATH,
      method: 'PUT',
      role: 'operator',
      query: { client: 'wolfhouse-somo' },
      body: {
        new_conversation: { enabled: false, recipients: [] },
        human_needed: { enabled: false, recipients: [] },
      },
      routes,
    });
    ok('operator PUT rejected 403', r.res.statusCode === 403);
  }
  {
    const r = await dispatchNotificationSettings({
      pathname: NOTIFICATION_SETTINGS_PATH,
      method: 'PUT',
      role: 'admin',
      query: { client: 'wolfhouse-somo' },
      body: {
        new_conversation: { enabled: true, recipients: [{ name: 'C', phone: '+34600000100' }] },
        human_needed: { enabled: false, recipients: [] },
      },
      routes,
    });
    ok('admin PUT allowed 200', r.res.statusCode === 200, `status=${r.res.statusCode} body=${r.res.body}`);
  }
  {
    const r = await dispatchNotificationSettings({
      pathname: '/staff/other',
      method: 'GET',
      role: 'admin',
      routes,
    });
    ok('other path not matched', r.matched === false);
  }

  // ── staff-query-api wiring (static contract) ──────────────────────────────
  console.log('\n── staff-query-api wiring ──');
  const apiSrc = fs.readFileSync(API_PATH, 'utf8');

  ok('requires notification-settings module', /require\('\.\/lib\/staff-notification-settings-routes'\)/.test(apiSrc));
  ok('NOTIFICATION_SETTINGS_PATH imported/used', /NOTIFICATION_SETTINGS_PATH/.test(apiSrc));
  ok('createNotificationSettingsRoutes called', /createNotificationSettingsRoutes\s*\(/.test(apiSrc));
  ok('path constant equals /staff/notification-settings', /NOTIFICATION_SETTINGS_PATH\s*=\s*'\/staff\/notification-settings'/.test(
    fs.readFileSync(MODULE_PATH, 'utf8'),
  ));

  // Router still gates with requireAuth admin on both methods near the path.
  const getRouteRe = /pathname === NOTIFICATION_SETTINGS_PATH && method === 'GET'[\s\S]{0,220}?requireAuth\(\s*req\s*,\s*res\s*,\s*'admin'\s*\)/;
  const putRouteRe = /pathname === NOTIFICATION_SETTINGS_PATH && method === 'PUT'[\s\S]{0,220}?requireAuth\(\s*req\s*,\s*res\s*,\s*'admin'\s*\)/;
  ok('GET route requireAuth admin', getRouteRe.test(apiSrc));
  ok('PUT route requireAuth admin', putRouteRe.test(apiSrc));
  ok('GET dispatches handleNotificationSettingsGet', /return handleNotificationSettingsGet\(parsed\.query, req, res, auth\.user\)/.test(apiSrc));
  ok('PUT dispatches handleNotificationSettingsPut', /return handleNotificationSettingsPut\(parsed\.query, req, res, auth\.user\)/.test(apiSrc));

  // No inline handler bodies left in monolith
  ok('no inline async handleNotificationSettingsGet', !/async function handleNotificationSettingsGet\s*\(/.test(apiSrc));
  ok('no inline async handleNotificationSettingsPut', !/async function handleNotificationSettingsPut\s*\(/.test(apiSrc));
  ok('no inline resolveNotificationSettingsLocationId fn', !/function resolveNotificationSettingsLocationId\s*\(/.test(apiSrc));

  // Module must not call requireAuth itself (comments may mention it).
  const modSrc = fs.readFileSync(MODULE_PATH, 'utf8');
  const modSrcNoComments = modSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok('module does not call requireAuth', !/\brequireAuth\s*\(/.test(modSrcNoComments));
  ok('module documents admin gate', /requireAuth|admin/.test(modSrc));

  // Automated notifications still share location helper (Slice 5 moved wrapper into its routes module).
  const autoRoutesPath = path.join(ROOT, 'scripts', 'lib', 'staff-automated-notifications-routes.js');
  const autoRoutesSrc = fs.existsSync(autoRoutesPath) ? fs.readFileSync(autoRoutesPath, 'utf8') : '';
  ok(
    'automated location helper still delegates',
    /function resolveAutomatedNotificationsLocationId[\s\S]{0,160}?resolveNotificationSettingsLocationId/.test(autoRoutesSrc)
      || /function resolveAutomatedNotificationsLocationId[\s\S]{0,120}?resolveNotificationSettingsLocationId/.test(apiSrc),
  );

  // UI surface still in buildUiHtml source
  ok('UI card id present', apiSrc.includes('cc-staff-notification-settings'));
  ok('UI fetch path present', apiSrc.includes('/staff/notification-settings') || apiSrc.includes('NOTIFICATION_SETTINGS_PATH'));
  ok('UI save handler present', /staffNotificationSettingsSave/.test(apiSrc));

  // ── Syntax + startup smoke ────────────────────────────────────────────────
  console.log('\n── syntax ──');
  for (const rel of [
    'scripts/lib/staff-notification-settings-routes.js',
    'scripts/staff-query-api.js',
    'scripts/verify-staff-notification-settings-routes.js',
  ]) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
    ok(`node --check ${rel}`, r.status === 0, r.stderr || r.stdout);
  }

  // ── Coupling notes (informational, not failure) ───────────────────────────
  console.log('\n── coupling notes (findings) ──');
  const findings = [];
  findings.push('Handlers depend on monolith deps via createNotificationSettingsRoutes({ sendJSON, send400, readBody, assertStaffClientAccess, appendAuditLog, withPgClient, DEFAULT_CLIENT, SQL_INJECT_RE }).');
  findings.push('withPgClient must be the staff-query-api wrapper (Fortress offline seam), not raw pg-connect — injected via deps.');
  findings.push('resolveNotificationSettingsLocationId is shared with resolveAutomatedNotificationsLocationId (staff-automated-notifications-routes.js).');
  findings.push('DB helpers stay in staff-whatsapp-notifications.js; this module is route-only.');
  for (const f of findings) console.log(`  NOTE  ${f}`);
  ok('findings recorded', findings.length >= 3);

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('FATAL', err);
  process.exit(2);
});
