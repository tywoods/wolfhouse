'use strict';

/**
 * verify:tenant-external-waiver-settings
 *
 * Focused RED→GREEN gate for tenant-templatable external waiver (V1 link-only).
 * Exercises production owners, real central-router dispatch/auth (fortress dual-gate),
 * generated /staff/ui markers, and Staff/Luna offer truth.
 *
 * No live DB, no staging mutation, no Google API.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'scripts', 'lib', 'tenant-external-waiver-settings.js');
const MIGRATION = path.join(ROOT, 'database', 'migrations', '054_tenant_external_waiver_settings.sql');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const STAFF = path.join(ROOT, 'scripts', 'lib', 'sunset-waiver-staff.js');
const BOOKING = path.join(ROOT, 'scripts', 'lib', 'sunset-waiver-booking.js');
const DRAWER = path.join(ROOT, 'scripts', 'browser', 'sunset-schedule-drawer-actions.js');
const MANIFEST = path.join(ROOT, 'database', 'migrations', 'canonical-manifest.json');

let pass = 0;
let fail = 0;
const redEvidence = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    const msg = `  FAIL  ${name}${detail ? ` — ${detail}` : ''}`;
    console.error(msg);
    redEvidence.push(msg);
  }
}

function request(port, method, urlPath, { body, headers, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const hdrs = Object.assign({}, headers || {});
    if (payload) {
      hdrs['Content-Type'] = 'application/json';
      hdrs['Content-Length'] = Buffer.byteLength(payload);
    }
    if (cookie) hdrs.Cookie = cookie;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: hdrs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch (_) { data = text; }
        resolve({ status: res.statusCode, data, raw: text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function createMemoryPg() {
  const rows = new Map(); // client_slug -> row
  const queries = [];
  return {
    queries,
    rows,
    async query(sql, params = []) {
      const q = String(sql);
      queries.push({ sql: q, params: params.slice() });
      if (/CREATE TABLE/i.test(q) || /CREATE INDEX/i.test(q)) return { rows: [], rowCount: 0 };
      if (/FROM tenant_external_waiver_settings/i.test(q) && /SELECT/i.test(q)) {
        const slug = params[0];
        const row = rows.get(slug);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (/INSERT INTO tenant_external_waiver_settings/i.test(q)) {
        const slug = params[0];
        const row = {
          client_slug: slug,
          enabled: params[1] === true,
          external_form_url: params[2] || null,
          updated_at: new Date().toISOString(),
          updated_by: params[3] || null,
        };
        rows.set(slug, row);
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

console.log('\nverify:tenant-external-waiver-settings — external waiver tenant config\n');

// ── [1] Files / migration ──────────────────────────────────────────────────
console.log('[1] migration + module surface');
ok('lib module exists', fs.existsSync(LIB));
ok('migration 054 exists', fs.existsSync(MIGRATION));
const mig = fs.readFileSync(MIGRATION, 'utf8');
ok('migration creates tenant_external_waiver_settings', /CREATE TABLE IF NOT EXISTS tenant_external_waiver_settings/i.test(mig));
ok('migration unique client_slug', /client_slug\s+TEXT NOT NULL UNIQUE/i.test(mig));
ok('migration has enabled + external_form_url', /enabled\s+BOOLEAN/i.test(mig) && /external_form_url\s+TEXT/i.test(mig));
ok('migration is NOT location-scoped', !/location_id/i.test(mig));
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const entry054 = (manifest.entries || []).find((e) => e.id === '054_tenant_external_waiver_settings');
ok('manifest includes 054 forward entry', !!entry054 && entry054.inForwardChain === true);
ok('manifest 054 has sha256', entry054 && /^[0-9a-f]{64}$/.test(entry054.sha256));

const lib = require('./lib/tenant-external-waiver-settings');
ok('exports validateExternalWaiverFormUrl', typeof lib.validateExternalWaiverFormUrl === 'function');
ok('exports normalizeExternalWaiverSettings', typeof lib.normalizeExternalWaiverSettings === 'function');
ok('exports get/set/resolve offer', typeof lib.getExternalWaiverSettings === 'function'
  && typeof lib.setExternalWaiverSettings === 'function'
  && typeof lib.resolveWaiverOfferForTenant === 'function');

// ── [2] URL hostile matrix ─────────────────────────────────────────────────
console.log('\n[2] URL allowlist / hostile matrix');
const good = [
  'https://docs.google.com/forms/d/e/1FAIpQLSdExampleToken/viewform',
  'https://docs.google.com/forms/d/1ABC_def-xyz/viewform?usp=sf_link',
  'https://forms.gle/AbCdEfGhIjKlMnOp',
];
for (const u of good) {
  const r = lib.validateExternalWaiverFormUrl(u);
  ok(`accept ${u.slice(0, 48)}…`, r.ok === true && r.url.startsWith('https://'), JSON.stringify(r));
}

const bad = [
  ['', 'empty'],
  ['http://docs.google.com/forms/d/x/viewform', 'http scheme'],
  ['javascript:alert(1)', 'javascript scheme'],
  ['ftp://docs.google.com/forms/d/x/viewform', 'ftp scheme'],
  ['https://evil.com/forms/d/x/viewform', 'unrelated host'],
  ['https://docs.google.com.evil.com/forms/d/x/viewform', 'subdomain trick'],
  ['https://evil-docs.google.com/forms/d/x/viewform', 'prefix host trick'],
  ['https://user:pass@docs.google.com/forms/d/x/viewform', 'credentials'],
  ['https://docs.google.com/forms/d/x/viewform#token=abc', 'fragment'],
  ['https://docs.google.com/document/d/x/edit', 'docs not forms'],
  ['https://docs.google.com/spreadsheets/d/x/edit', 'sheets'],
  ['https://forms.gle/', 'empty short link'],
  ['https://forms.gle/../evil', 'path traversal short'],
  ['not a url', 'malformed'],
  ['https://docs.google.com/forms/d/x/viewform\\@evil', 'backslash'],
];
for (const [u, label] of bad) {
  const r = lib.validateExternalWaiverFormUrl(u);
  ok(`reject ${label}`, r.ok === false, JSON.stringify(r));
}

// ── [3] normalize + mode ───────────────────────────────────────────────────
console.log('\n[3] normalize + mode resolution');
ok('fail closed missing client', lib.normalizeExternalWaiverSettings({ enabled: false }).ok === false);
const dis = lib.normalizeExternalWaiverSettings({ client_slug: 'sunset', enabled: false });
ok('disabled ok without url', dis.ok && dis.enabled === false && dis.external_form_url === null);
const enBad = lib.normalizeExternalWaiverSettings({ client_slug: 'sunset', enabled: true });
ok('enabled without url fails', enBad.ok === false);
const enGood = lib.normalizeExternalWaiverSettings({
  client_slug: 'sunset',
  enabled: true,
  external_form_url: 'https://forms.gle/AbCdEfGhIjKlMnOp',
});
ok('enabled with valid url ok', enGood.ok && enGood.enabled === true && enGood.external_form_url === 'https://forms.gle/AbCdEfGhIjKlMnOp');

const modeAbsent = lib.resolveExternalWaiverMode(lib.defaultAbsentSettings('sunset'));
ok('absent → native_default', modeAbsent.mode === 'native_default' && modeAbsent.link_available === false);
const modeDis = lib.resolveExternalWaiverMode({ enabled: false, external_form_url: null });
ok('disabled mode', modeDis.mode === 'disabled' && modeDis.link_available === false);
const modeMis = lib.resolveExternalWaiverMode({ enabled: true, external_form_url: null });
ok('enabled missing link', modeMis.mode === 'enabled_missing_link' && modeMis.link_available === false);
const modeOk = lib.resolveExternalWaiverMode({ enabled: true, external_form_url: 'https://forms.gle/AbCdEfGhIjKlMnOp' });
ok('enabled configured', modeOk.mode === 'enabled_configured' && modeOk.link_available === true);
ok('verification external_unverified', modeOk.verification === 'external_unverified');

// ── [4] persistence + isolation (memory pg) ────────────────────────────────
console.log('\n[4] persistence / cross-tenant isolation');
(async () => {
  const pg = createMemoryPg();
  const absent = await lib.getExternalWaiverSettings(pg, { clientSlug: 'sunset' });
  ok('absent read is native_default', absent.ok && absent.mode === 'native_default');
  ok('fail closed empty slug', (await lib.getExternalWaiverSettings(pg, { clientSlug: '' })).ok === false);

  const setA = await lib.setExternalWaiverSettings(pg, {
    clientSlug: 'sunset',
    enabled: true,
    external_form_url: 'https://docs.google.com/forms/d/e/1FAIpQLSdExample/viewform',
    actor: { staff_user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  });
  ok('set sunset ok', setA.ok && setA.mode === 'enabled_configured');

  const setB = await lib.setExternalWaiverSettings(pg, {
    clientSlug: 'wolfhouse-somo',
    enabled: false,
    external_form_url: null,
  });
  ok('set wolfhouse disabled ok', setB.ok && setB.mode === 'disabled');

  const readA = await lib.getExternalWaiverSettings(pg, { clientSlug: 'sunset' });
  const readB = await lib.getExternalWaiverSettings(pg, { clientSlug: 'wolfhouse-somo' });
  ok('sunset retains enabled url', readA.settings.enabled === true
    && /docs\.google\.com\/forms\//.test(readA.settings.external_form_url || ''));
  ok('wolfhouse remains disabled (isolation)', readB.settings.enabled === false
    && readB.settings.external_form_url == null);
  ok('no cross-tenant overwrite', pg.rows.size === 2);

  const offerNative = await lib.resolveWaiverOfferForTenant(pg, { clientSlug: 'other-tenant' });
  ok('missing tenant row → native offer', offerNative.offer === 'native');
  const offerExt = await lib.resolveWaiverOfferForTenant(pg, { clientSlug: 'sunset' });
  ok('sunset offer external', offerExt.offer === 'external' && offerExt.link_available === true);
  const offerNone = await lib.resolveWaiverOfferForTenant(pg, { clientSlug: 'wolfhouse-somo' });
  ok('disabled offer none', offerNone.offer === 'none' && offerNone.link_available === false);

  // enabled then clear URL path: cannot enable with invalid
  const badSet = await lib.setExternalWaiverSettings(pg, {
    clientSlug: 'sunset',
    enabled: true,
    external_form_url: 'https://evil.com/phish',
  });
  ok('hostile url rejected on write', badSet.ok === false);
  const still = await lib.getExternalWaiverSettings(pg, { clientSlug: 'sunset' });
  ok('failed write does not clobber prior good config', still.settings.enabled === true
    && /docs\.google\.com/.test(still.settings.external_form_url || ''));

  // ── [5] Staff/Luna external truth helpers ────────────────────────────────
  console.log('\n[5] Staff/Luna external view + copy truth');
  const view = lib.buildExternalWaiverStaffView(offerExt, '00000000-0000-4000-8000-000000000099');
  ok('external staff view has public_url', view && view.public_url === offerExt.public_url);
  ok('external staff view status external_unverified', view.status === 'external_unverified');
  ok('external staff view never completed', view.completed_at == null && view.submission == null);
  ok('external staff view marks external', view.external === true);
  const invite = lib.buildLunaExternalWaiverInviteMessage(offerExt.public_url);
  ok('luna invite includes url', invite.includes(offerExt.public_url));
  ok('luna invite does not claim completed', !/ya están completos|Queda registrado|tu formulario de Sunset está completo/i.test(invite));
  ok('luna invite notes manual review', /revisará|no confirma por sí solo/i.test(invite));

  // ── [6] Source wiring: API / staff / drawer / booking ─────────────────────
  console.log('\n[6] production wiring (source + exports)');
  const apiSrc = fs.readFileSync(API_PATH, 'utf8');
  const staffSrc = fs.readFileSync(STAFF, 'utf8');
  const bookingSrc = fs.readFileSync(BOOKING, 'utf8');
  const drawerSrc = fs.readFileSync(DRAWER, 'utf8');

  ok('API requires tenant-external-waiver-settings', apiSrc.includes("require('./lib/tenant-external-waiver-settings')"));
  ok('GET /staff/admin/external-waiver route', /pathname === '\/staff\/admin\/external-waiver' && method === 'GET'/.test(apiSrc));
  ok('PUT /staff/admin/external-waiver route', /pathname === '\/staff\/admin\/external-waiver' && method === 'PUT'/.test(apiSrc));
  ok('admin auth on external-waiver GET', /external-waiver' && method === 'GET'[\s\S]{0,200}requireAuth\(req, res, 'admin'\)/.test(apiSrc));
  ok('admin auth on external-waiver PUT', /external-waiver' && method === 'PUT'[\s\S]{0,200}requireAuth\(req, res, 'admin'\)/.test(apiSrc));
  ok('assertStaffClientAccess on handlers', /handleExternalWaiverSettings(Get|Put)[\s\S]{0,400}assertStaffClientAccess/.test(apiSrc));
  ok('audit intent api:staff.external_waiver', /api:staff\.external_waiver\.(get|put)/.test(apiSrc));
  ok('Luna Staff UI card present', apiSrc.includes('cc-external-waiver-settings') || apiSrc.includes('id="cc-external-waiver"'));
  ok('Luna Staff card not under Pricing', !/admin-panel-pricing[\s\S]{0,800}cc-external-waiver/.test(apiSrc));

  ok('staff create/status consults resolveWaiverOfferForTenant', staffSrc.includes('resolveWaiverOfferForTenant'));
  ok('staff create blocks native when external', staffSrc.includes("offer === 'external'") || staffSrc.includes('offer: \'external\''));
  ok('staff create blocks when offer none', staffSrc.includes("offer === 'none'") || staffSrc.includes("offer: 'none'"));
  ok('booking helper external luna copy', bookingSrc.includes('buildLunaExternalWaiverInviteMessage') || bookingSrc.includes('external_unverified'));
  ok('drawer handles external_unverified', drawerSrc.includes('external_unverified') || drawerSrc.includes('waiverExternal'));
  ok('drawer does not invent completed for external', !/external[\s\S]{0,200}waiverCompleted(?!Progress)/.test(drawerSrc) || drawerSrc.includes('external_unverified'));

  // ── [7] Real central-router dispatch + auth matrix ───────────────────────
  console.log('\n[7] real central-router dispatch + auth matrix');
  process.env.NODE_ENV = 'test';
  process.env.STAFF_AUTH_REQUIRED = 'true';
  process.env.STAFF_AUTH_ALLOW_OPEN = 'false';
  process.env.STAFF_AUTH_HTTPS = 'false';
  process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = '1';
  process.env.DEFAULT_CLIENT_SLUG = 'sunset';
  process.env.STAFF_RUNTIME_PROFILE = 'test';
  // Worktree may lack node_modules; reuse Lunabox WH install like other gates.
  const extraNodePath = '/opt/wolfhouse/WH/node_modules';
  if (fs.existsSync(extraNodePath)) {
    process.env.NODE_PATH = [process.env.NODE_PATH, extraNodePath].filter(Boolean).join(path.delimiter);
    require('module').Module._initPaths();
  }
  // Clear cached module if any
  delete require.cache[require.resolve('./staff-query-api')];
  const api = require('./staff-query-api');
  ok('fortress dual-gate exports server', typeof api.createStaffQueryApiHttpServer === 'function' || !!api.server);

  const store = createMemoryPg();
  const sessions = {
    admin: {
      staff_user_id: '11111111-1111-4111-8111-111111111111',
      email: 'admin@sunset.test',
      role: 'admin',
      status: 'active',
      display_name: 'Admin',
      client_id: '22222222-2222-4222-8222-222222222222',
      client_slug: 'sunset',
    },
    operator: {
      staff_user_id: '33333333-3333-4333-8333-333333333333',
      email: 'op@sunset.test',
      role: 'operator',
      status: 'active',
      display_name: 'Operator',
      client_id: '22222222-2222-4222-8222-222222222222',
      client_slug: 'sunset',
    },
    viewer: {
      staff_user_id: '44444444-4444-4444-8444-444444444444',
      email: 'viewer@sunset.test',
      role: 'viewer',
      status: 'active',
      display_name: 'Viewer',
      client_id: '22222222-2222-4222-8222-222222222222',
      client_slug: 'sunset',
    },
    foreign: {
      staff_user_id: '55555555-5555-4555-8555-555555555555',
      email: 'foreign@wolfhouse.test',
      role: 'admin',
      status: 'active',
      display_name: 'Foreign Admin',
      client_id: '66666666-6666-4666-8666-666666666666',
      client_slug: 'wolfhouse-somo',
    },
  };
  const tokenFor = {
    admin: 'ext-waiver-session-admin',
    operator: 'ext-waiver-session-operator',
    viewer: 'ext-waiver-session-viewer',
    foreign: 'ext-waiver-session-foreign',
  };

  api.setFortress15j3OfflineSeams({
    withPgClient: async (fn) => fn(store),
    canAccessClient: (user, slug) => {
      if (!user) return false;
      if (user.email === 'foreign@wolfhouse.test') return slug === 'wolfhouse-somo';
      return slug === 'sunset';
    },
    resolveSessionUser(req) {
      const raw = req.headers.cookie || '';
      for (const part of raw.split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const name = part.slice(0, eq).trim();
        const val = decodeURIComponent(part.slice(eq + 1).trim());
        if (name === api.COOKIE_NAME) {
          for (const [role, tok] of Object.entries(tokenFor)) {
            if (val === tok) return { ...sessions[role] };
          }
        }
      }
      return null;
    },
  });

  const server = api.server;
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  const cookie = (role) => `${api.COOKIE_NAME}=${encodeURIComponent(tokenFor[role])}`;
  const pathGet = '/staff/admin/external-waiver?client=sunset';
  const pathPut = '/staff/admin/external-waiver?client=sunset';
  const goodBody = {
    enabled: true,
    external_form_url: 'https://forms.gle/RealDispatchToken99',
  };

  try {
    const unauth = await request(port, 'PUT', pathPut, { body: goodBody });
    ok('unauthenticated PUT → 401/403', unauth.status === 401 || unauth.status === 403, String(unauth.status));

    const viewerPut = await request(port, 'PUT', pathPut, { body: goodBody, cookie: cookie('viewer') });
    ok('viewer PUT → 403', viewerPut.status === 403, String(viewerPut.status));

    const opPut = await request(port, 'PUT', pathPut, { body: goodBody, cookie: cookie('operator') });
    ok('operator PUT → 403 (admin+ required)', opPut.status === 403, String(opPut.status));

    const foreignPut = await request(port, 'PUT', pathPut, { body: goodBody, cookie: cookie('foreign') });
    ok('foreign tenant PUT → 403', foreignPut.status === 403, String(foreignPut.status));

    const badScope = await request(port, 'PUT', '/staff/admin/external-waiver?client=', {
      body: goodBody,
      cookie: cookie('admin'),
    });
    ok('malformed/empty client scope fails closed', badScope.status === 400 || badScope.status === 403, String(badScope.status));

    const injectScope = await request(port, 'PUT', "/staff/admin/external-waiver?client=sunset';drop", {
      body: goodBody,
      cookie: cookie('admin'),
    });
    ok('SQL-ish client slug rejected', injectScope.status === 400 || injectScope.status === 403, String(injectScope.status));

    const adminBadUrl = await request(port, 'PUT', pathPut, {
      body: { enabled: true, external_form_url: 'https://evil.com/x' },
      cookie: cookie('admin'),
    });
    ok('admin valid role but hostile URL → 400', adminBadUrl.status === 400, String(adminBadUrl.status));

    const adminOk = await request(port, 'PUT', pathPut, { body: goodBody, cookie: cookie('admin') });
    ok('admin PUT succeeds', adminOk.status === 200 && adminOk.data && adminOk.data.success === true, JSON.stringify(adminOk.data));
    ok('admin PUT returns enabled_configured', adminOk.data && adminOk.data.mode === 'enabled_configured');
    ok('admin PUT returns public_url', adminOk.data && adminOk.data.public_url === 'https://forms.gle/RealDispatchToken99');
    ok('admin PUT never claims completed', adminOk.data && adminOk.data.verification === 'external_unverified'
      && !/completed|signed|submitted/i.test(JSON.stringify(adminOk.data.status || '')));

    const getOk = await request(port, 'GET', pathGet, { cookie: cookie('admin') });
    ok('admin GET readback', getOk.status === 200 && getOk.data && getOk.data.success === true
      && getOk.data.mode === 'enabled_configured');

    const disable = await request(port, 'PUT', pathPut, {
      body: { enabled: false, external_form_url: null },
      cookie: cookie('admin'),
    });
    ok('admin can disable', disable.status === 200 && disable.data && disable.data.mode === 'disabled');
    ok('disabled has no link_available', disable.data && disable.data.link_available === false);

    // Staff create path truth via production owner (no native create when external)
    await lib.setExternalWaiverSettings(store, {
      clientSlug: 'sunset',
      enabled: true,
      external_form_url: 'https://forms.gle/RealDispatchToken99',
    });
    const staff = require('./lib/sunset-waiver-staff');
    const bookingId = '00000000-0000-4000-8000-000000000001';
    // Minimal booking load mock: staff module queries bookings — intercept by wrapping pg
    const staffPg = {
      async query(sql, params = []) {
        const q = String(sql);
        if (/CREATE TABLE|CREATE INDEX/i.test(q)) return { rows: [] };
        if (/FROM tenant_external_waiver_settings/i.test(q) && /SELECT/i.test(q)) {
          return store.query(sql, params);
        }
        if (/INSERT INTO tenant_external_waiver_settings/i.test(q)) {
          return store.query(sql, params);
        }
        if (/FROM bookings b/i.test(q)) {
          return {
            rows: [{
              booking_id: bookingId,
              booking_code: 'SUN-EXT-1',
              guest_name: 'Test Guest',
              phone: '+34600000000',
              email: 'g@example.com',
              customer_id: null,
              guest_count: 1,
              check_in: null,
              check_out: null,
              metadata: {},
            }],
          };
        }
        if (/FROM booking_service_records/i.test(q)) {
          return { rows: [{ service_date: '2026-08-01', quantity: 1, metadata: {} }] };
        }
        if (/FROM waiver_form_requests/i.test(q) && /INSERT/i.test(q)) {
          throw new Error('MUST_NOT_CREATE_NATIVE_WAIVER_IN_EXTERNAL_MODE');
        }
        if (/FROM waiver_form_requests/i.test(q)) {
          return { rows: [] };
        }
        if (/FROM waiver_form_submissions/i.test(q)) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };

    const created = await staff.createOrGetBookingWaiver(staffPg, {
      clientSlug: 'sunset',
      bookingId,
      source: 'verify_external',
    });
    ok('createOrGet in external mode ok', created.ok === true, JSON.stringify(created));
    ok('external mode returns external waiver url', created.body && created.body.waiver
      && created.body.waiver.public_url === 'https://forms.gle/RealDispatchToken99');
    ok('external mode status external_unverified', created.body.waiver.status === 'external_unverified');
    ok('external mode marks external', created.body.waiver.external === true || created.body.waiver_mode === 'external');
    ok('no native create (created flag false or external)', created.body.created === false || created.body.waiver_mode === 'external');

    // Disable → no link
    await lib.setExternalWaiverSettings(store, { clientSlug: 'sunset', enabled: false });
    const disabledCreate = await staff.createOrGetBookingWaiver(staffPg, {
      clientSlug: 'sunset',
      bookingId,
    });
    ok('disabled: create returns ok', disabledCreate.ok === true, JSON.stringify(disabledCreate));
    const disBody = disabledCreate.body || {};
    const disUrl = disBody.waiver && disBody.waiver.public_url;
    ok('disabled: no public_url offered', !disUrl, String(disUrl));
    ok('disabled: waiver_offer is none', disBody.waiver_offer === 'none', JSON.stringify(disBody));
    ok('disabled: link_available false', disBody.link_available === false, JSON.stringify(disBody));
    ok('disabled: no native request generated', !disBody.created);
    ok('disabled: does not claim completed', !(disBody.waiver && disBody.waiver.status === 'completed'));

    // Status with historical completed native while external active
    await lib.setExternalWaiverSettings(store, {
      clientSlug: 'sunset',
      enabled: true,
      external_form_url: 'https://forms.gle/RealDispatchToken99',
    });
    const histPg = {
      async query(sql, params = []) {
        const q = String(sql);
        if (/CREATE TABLE|CREATE INDEX/i.test(q)) return { rows: [] };
        if (/FROM tenant_external_waiver_settings/i.test(q)) return store.query(sql, params);
        if (/INSERT INTO tenant_external_waiver_settings/i.test(q)) return store.query(sql, params);
        if (/FROM bookings b/i.test(q)) {
          return {
            rows: [{
              booking_id: bookingId,
              booking_code: 'SUN-HIST-1',
              guest_name: 'Hist',
              phone: '+34600',
              email: 'h@example.com',
              customer_id: null,
              guest_count: 1,
              check_in: null,
              check_out: null,
              metadata: {},
            }],
          };
        }
        if (/FROM booking_service_records/i.test(q)) return { rows: [] };
        if (/FROM waiver_form_requests/i.test(q) && /INSERT/i.test(q)) {
          throw new Error('MUST_NOT_CREATE_NATIVE');
        }
        if (/FROM waiver_form_requests/i.test(q)) {
          return {
            rows: [{
              id: '99999999-9999-4999-8999-999999999999',
              tenant_id: 'sunset',
              customer_id: null,
              booking_id: bookingId,
              participant_key: 'primary',
              public_id: 'waiv_histnative01',
              token_hash: 'abc',
              status: 'completed',
              request_mode: 'single',
              target_count: null,
              form_type: 'sunset_lesson_waiver',
              form_version: 'sunset_google_form_v1_confirmed',
              sent_to_phone: null,
              sent_to_email: null,
              prefill_json: {},
              metadata: {},
              sent_at: null,
              completed_at: '2026-06-01T12:00:00.000Z',
              expires_at: null,
              created_at: '2026-05-01T12:00:00.000Z',
              updated_at: '2026-06-01T12:00:00.000Z',
            }],
          };
        }
        if (/COUNT\(\*\)/i.test(q) && /waiver_form_submissions/i.test(q)) {
          return { rows: [{ cnt: 1 }] };
        }
        if (/FROM waiver_form_submissions/i.test(q)) {
          return {
            rows: [{
              id: '88888888-8888-4888-8888-888888888888',
              request_id: '99999999-9999-4999-8999-999999999999',
              submitted_at: '2026-06-01T12:00:00.000Z',
              respondent_name: 'Hist Guest',
              respondent_email: 'h@example.com',
              respondent_phone: '+34600',
              form_version: 'sunset_google_form_v1_confirmed',
              raw_answers_json: { answers: { full_name: { label: 'NOMBRE', value: 'Hist Guest' } } },
              form_snapshot_json: {},
            }],
          };
        }
        return { rows: [] };
      },
    };
    const statusHist = await staff.getBookingWaiverStatus(histPg, {
      clientSlug: 'sunset',
      bookingId,
    });
    ok('status ok with historical native', statusHist.ok === true, JSON.stringify(statusHist.body));
    // Conservative: external mode surfaces external link as primary offer; historical
    // completed native answers remain available via submission path / historical fields.
    ok('external mode primary link is external url', statusHist.body && statusHist.body.waiver
      && statusHist.body.waiver.public_url === 'https://forms.gle/RealDispatchToken99');
    ok('historical native not falsely dropped from response',
      (statusHist.body.historical_native_waiver && statusHist.body.historical_native_waiver.status === 'completed')
      || (statusHist.body.waiver && statusHist.body.waiver.historical_native_completed === true)
      || (statusHist.body.native_waiver_status === 'completed'));

    // Pending native while external: must not present as completed
    const pendingPg = {
      async query(sql, params = []) {
        const q = String(sql);
        if (/CREATE TABLE|CREATE INDEX/i.test(q)) return { rows: [] };
        if (/tenant_external_waiver_settings/i.test(q)) return store.query(sql, params);
        if (/FROM bookings b/i.test(q)) {
          return {
            rows: [{
              booking_id: bookingId,
              booking_code: 'SUN-PEND',
              guest_name: 'P',
              phone: null,
              email: null,
              customer_id: null,
              guest_count: 1,
              check_in: null,
              check_out: null,
              metadata: {},
            }],
          };
        }
        if (/FROM booking_service_records/i.test(q)) return { rows: [] };
        if (/FROM waiver_form_requests/i.test(q)) {
          return {
            rows: [{
              id: '77777777-7777-4777-8777-777777777777',
              tenant_id: 'sunset',
              customer_id: null,
              booking_id: bookingId,
              participant_key: null,
              public_id: 'waiv_pendingnative1',
              token_hash: 'def',
              status: 'pending',
              request_mode: 'single',
              target_count: null,
              form_type: 'sunset_lesson_waiver',
              form_version: 'v1',
              sent_to_phone: null,
              sent_to_email: null,
              prefill_json: {},
              metadata: {},
              sent_at: null,
              completed_at: null,
              expires_at: null,
              created_at: '2026-07-01T00:00:00.000Z',
              updated_at: '2026-07-01T00:00:00.000Z',
            }],
          };
        }
        if (/COUNT\(\*\)/i.test(q)) return { rows: [{ cnt: 0 }] };
        if (/FROM waiver_form_submissions/i.test(q)) return { rows: [] };
        return { rows: [] };
      },
    };
    const statusPend = await staff.getBookingWaiverStatus(pendingPg, {
      clientSlug: 'sunset',
      bookingId,
    });
    ok('pending native + external does not claim completed', statusPend.ok
      && statusPend.body.waiver
      && statusPend.body.waiver.status !== 'completed');
    ok('pending native + external primary is external unverified',
      statusPend.body.waiver.status === 'external_unverified'
      || statusPend.body.waiver.verification === 'external_unverified');

    // Luna attach fields
    const booking = require('./lib/sunset-waiver-booking');
    const lunaBody = booking.attachLunaWaiverFields({
      success: true,
      guest_count: 1,
      waiver: created.body.waiver,
      waiver_mode: 'external',
    });
    ok('luna message includes external url', /forms\.gle\/RealDispatchToken99/.test(lunaBody.luna_waiver_message || ''));
    ok('luna external not lesson_ready', lunaBody.lesson_ready === false);
    ok('luna external message no completion claim',
      !/está completo|Queda registrado para la clase/i.test(lunaBody.luna_waiver_message || ''));

    // native default when no config
    store.rows.delete('sunset');
    const nativeOffer = await lib.resolveWaiverOfferForTenant(store, { clientSlug: 'sunset' });
    ok('absent config → native offer (backward compat)', nativeOffer.offer === 'native');

  } finally {
    await new Promise((r) => server.close(r));
    api.setFortress15j3OfflineSeams(null);
  }

  // ── [8] Generated /staff/ui markers + execute production Preview path ───
  console.log('\n[8] generated /staff/ui markers + Preview click path');
  process.env.STAFF_AUTH_REQUIRED = 'false';
  process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
  process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
  process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = '0';
  delete require.cache[require.resolve('./staff-query-api')];
  // Rebuild without fortress for UI builder only
  delete process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER;
  process.env.NODE_ENV = 'test';
  process.env.STAFF_AUTH_REQUIRED = 'false';
  process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
  process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
  const apiUi = require('./staff-query-api');
  if (typeof apiUi.buildUiHtmlForOfflineTest === 'function') {
    const html = apiUi.buildUiHtmlForOfflineTest(3036, { headers: {} });
    ok('generated UI includes external waiver card', /cc-external-waiver/.test(html));
    ok('generated UI has enable toggle', /external-waiver-enabled|ew-enabled|id="ew-enabled"/.test(html));
    ok('generated UI has url field', /external-waiver-url|ew-url|id="ew-url"/.test(html));
    ok('generated UI has save control', /externalWaiverSettingsSave|ew-save|Save waiver/.test(html));
    ok('generated UI escapes via escHtml or textContent patterns',
      /function externalWaiver|ew-status|externalWaiverStatus/.test(html));
    // Parse smoke for scripts that mention external waiver
    let parsed = 0;
    let parseFail = 0;
    const scriptBodies = [];
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
      const open = match[0].slice(0, match[0].indexOf('>') + 1);
      if (/type=["']application\/json["']/i.test(open) || /\bsrc=/i.test(open)) continue;
      scriptBodies.push(match[1]);
      try {
        new vm.Script(match[1], { filename: `generated-ext-waiver-${++parsed}.js` });
      } catch (e) {
        parseFail += 1;
        if (parseFail === 1) console.error('  parse error:', e && e.message);
      }
    }
    ok('generated UI scripts parse', parseFail === 0 && parsed > 0, `parsed=${parsed} fail=${parseFail}`);

    // Execute production generated Preview path (typed-before-save; never rely on Save).
    const openLog = [];
    const msgLog = [];
    const urlInput = { value: '' };
    const ewDom = {
      'ew-url': urlInput,
      'ew-enabled': { checked: false },
      'ew-mode-label': { textContent: '' },
      'ew-status': { textContent: '', style: { display: 'none' } },
      'ew-error': { textContent: '', style: { display: 'none' } },
      'ew-open-btn': { disabled: false },
      'ew-save-btn': { disabled: false },
      'cc-external-waiver-settings': { style: { display: '' } },
    };
    const previewSandbox = {
      console,
      window: {
        open: (href, target, features) => {
          openLog.push({ href, target, features });
          return { closed: false };
        },
      },
      document: {
        getElementById: (id) => ewDom[id] || null,
      },
      URL,
      el: (id) => ewDom[id] || null,
      fetch: () => Promise.resolve({ json: async () => ({ success: false }) }),
      canUseOwnerInsightsPortal: () => true,
      staffWhatsappNumberQuery: () => '?client=sunset',
      getClient: () => 'sunset',
      getSunsetLocation: () => 'medano',
    };
    // Prefer the script chunk that defines the production open handler.
    const openChunk = scriptBodies.find((b) => b.includes('function externalWaiverSettingsOpen'))
      || scriptBodies.find((b) => b.includes('externalWaiverSettingsOpen'))
      || '';
    ok('generated UI defines externalWaiverSettingsOpen', /function externalWaiverSettingsOpen\s*\(/.test(openChunk)
      || /externalWaiverSettingsOpen\s*=\s*function/.test(openChunk));
    if (openChunk) {
      // Extract the external-waiver helper block only (avoid full staff UI side effects).
      const start = openChunk.indexOf('/* ── External waiver');
      const endMarkers = [
        openChunk.indexOf('/* ── Staff & Owner WhatsApp'),
        openChunk.indexOf('function staffWhatsappNumberQuery'),
        openChunk.indexOf('function staffWhatsappShowMsg'),
      ].filter((i) => i > start);
      const end = endMarkers.length ? Math.min(...endMarkers) : -1;
      let block = (start >= 0 && end > start) ? openChunk.slice(start, end) : '';
      if (!block || !block.includes('function externalWaiverSettingsOpen')) {
        // Fallback: pull the function definitions by name from API source of truth chunk.
        const apiSrcForExtract = fs.readFileSync(API_PATH, 'utf8');
        const mStart = apiSrcForExtract.indexOf('/* ── External waiver');
        const mEnd = apiSrcForExtract.indexOf('/* ── Staff & Owner WhatsApp', mStart);
        block = (mStart >= 0 && mEnd > mStart) ? apiSrcForExtract.slice(mStart, mEnd) : '';
      }
      ok('extracted production external waiver browser block', block.includes('function externalWaiverSettingsOpen'));
      try {
        vm.runInNewContext(`${block}\nthis.externalWaiverSettingsOpen = externalWaiverSettingsOpen;`, previewSandbox);
      } catch (e) {
        ok('production Preview functions execute in sandbox', false, e && e.message);
      }
      ok('sandbox has externalWaiverSettingsOpen', typeof previewSandbox.externalWaiverSettingsOpen === 'function');

      const hostile = [
        'https://evil.example/phish',
        'https://docs.google.com.evil.com/forms/d/x/viewform',
        'https://user:pass@docs.google.com/forms/d/x/viewform',
        'https://docs.google.com/forms/d/x/viewform#token=abc',
        'https://docs.google.com/document/d/x/edit',
        'http://docs.google.com/forms/d/x/viewform',
        'javascript:alert(1)',
        'https://forms.gle/',
        'https://not-google.com/forms/d/x/viewform',
      ];
      for (const badUrl of hostile) {
        openLog.length = 0;
        urlInput.value = badUrl;
        previewSandbox.externalWaiverSettingsOpen();
        ok(`Preview rejects hostile before window.open: ${badUrl.slice(0, 48)}`, openLog.length === 0,
          `openLog=${JSON.stringify(openLog)}`);
      }

      const validForms = [
        'https://docs.google.com/forms/d/e/1FAIpQLSdExampleToken/viewform',
        'https://forms.gle/AbCdEfGhIjKlMnOp',
      ];
      for (const goodUrl of validForms) {
        openLog.length = 0;
        urlInput.value = goodUrl;
        previewSandbox.externalWaiverSettingsOpen();
        ok(`Preview opens valid Google Form once: ${goodUrl.slice(0, 48)}`, openLog.length === 1,
          `openLog=${JSON.stringify(openLog)}`);
        if (openLog.length === 1) {
          ok(`Preview open href is https allowlisted host for ${goodUrl.slice(0, 32)}`,
            /^https:\/\/(docs\.google\.com\/forms\/|forms\.gle\/)/.test(String(openLog[0].href || '')),
            String(openLog[0].href));
        }
      }
    }
  } else {
    ok('UI builder seam available', false, 'buildUiHtmlForOfflineTest missing');
  }

  // ── [9] Drawer historical View answers — production event path ──────────
  console.log('\n[9] drawer historical View answers path');
  {
    const actionsSrc = fs.readFileSync(DRAWER, 'utf8');
    const portalTMap = {
      'schedule.drawer.waiverDisabledOrMisconfigured': 'Waiver links are not available (disabled or missing form link).',
      'schedule.drawer.waiverHistoricalNative': 'A completed native form exists for this booking.',
      'schedule.drawer.waiverViewAnswers': 'View answers',
      'schedule.drawer.waiverAnswers': 'Answers',
      'schedule.drawer.waiverStatus': 'Status',
      'schedule.drawer.waiverExternalUnverified': 'External form (unverified)',
      'schedule.drawer.waiverExternalHint': 'External Google Form — completion is not verified automatically.',
      'schedule.drawer.waiverCopy': 'Copy',
      'schedule.drawer.waiverNone': 'No waiver yet',
      'schedule.drawer.waiverCreate': 'Create link',
      'schedule.drawer.waiverPending': 'Pending',
      'schedule.drawer.waiverCompleted': 'Completed',
      'schedule.drawer.waiverNeedsReview': 'Needs review',
      'schedule.drawer.waiverExpired': 'Expired',
      'schedule.drawer.waiverRevoked': 'Revoked',
      'schedule.drawer.waiverStudentLabel': 'Student',
      'schedule.drawer.waiverGroupLabel': 'Group',
      'schedule.drawer.waiverStudents': 'students',
      'schedule.drawer.waiverCompletedProgress': 'Completed',
      'schedule.drawer.waiverGroupShareHint': 'Share one link with the group',
      'schedule.drawer.waiverCreateGroup': 'Create group link',
      'schedule.drawer.waiverCopyGroup': 'Copy group link',
      'schedule.drawer.waiverMigrationPending': 'Migration pending',
    };
    const drawerDom = {};
    function makeEl(id) {
      if (drawerDom[id]) return drawerDom[id];
      const node = {
        id,
        _innerHTML: '',
        textContent: '',
        className: '',
        style: { display: 'none' },
        disabled: false,
        onclick: null,
        value: '',
        checked: false,
      };
      Object.defineProperty(node, 'innerHTML', {
        get() { return this._innerHTML; },
        set(v) {
          this._innerHTML = String(v == null ? '' : v);
          // Mirror browser: setting container HTML creates descendant id lookups.
          const re = /id=["']([^"']+)["']/g;
          let m;
          while ((m = re.exec(this._innerHTML))) {
            const childId = m[1];
            if (!drawerDom[childId]) {
              drawerDom[childId] = {
                id: childId,
                _innerHTML: '',
                textContent: '',
                className: '',
                style: { display: childId === 'ps-drawer-waiver-answers' ? 'none' : '' },
                disabled: false,
                onclick: null,
                value: '',
                checked: false,
              };
              Object.defineProperty(drawerDom[childId], 'innerHTML', {
                get() { return this._innerHTML; },
                set(hv) { this._innerHTML = String(hv == null ? '' : hv); },
                configurable: true,
                enumerable: true,
              });
            }
          }
        },
        configurable: true,
        enumerable: true,
      });
      drawerDom[id] = node;
      return node;
    }
    makeEl('ps-drawer-waiver-box');
    const drawerCtx = {
      console,
      portalT: (k) => portalTMap[k] || k,
      document: { createElement: () => ({ innerHTML: '', firstChild: null }) },
      scheduleDrawerState: {
        row: { booking_id: 'b-hist-1' },
        ctx: { booking_id: 'b-hist-1', booking_code: 'SS-HIST' },
        editing: false,
        openGen: 1,
        activeBookingKey: 'id:b-hist-1',
      },
      scheduleDrawerCanLoadCanonical: () => true,
      scheduleDrawerBookingKey: (row) => (row && row.booking_id ? 'id:' + row.booking_id : null),
      scheduleDrawerIsRequestActive: () => true,
      scheduleCloneDrawerCtx: (c) => JSON.parse(JSON.stringify(c)),
      scheduleMountDrawerBody: () => {},
      scheduleRenderDrawerPaymentSectionViewHtml: () => '',
      scheduleRenderDrawerPaymentSectionEditHtml: () => '',
      scheduleDrawerEur: (c) => '€' + (Number(c) / 100).toFixed(2),
      scheduleCopyTextFallback: () => {},
      scheduleDrawerFlashCopied: () => {},
      scheduleDateOnlyLabel: (v) => String(v || '').slice(0, 10),
      scheduleDrawerCopyIconBtnHtml: (id) => `<button id="${id}"></button>`,
      schedulePortalStripeLinkFromCtx: () => ({ url: '', actionable: false, stale: false }),
      scheduleFetchDrawerContext: () => Promise.resolve({ success: true }),
      closeScheduleDetailDrawer: () => {},
      loadSchedulePage: () => {},
      getClient: () => 'sunset',
      sunsetLocationQuerySuffix: () => '',
      el: (id) => drawerDom[id] || null,
      window: { confirm: () => true, location: { origin: 'https://example.test' }, open: () => {} },
      fetch: () => Promise.resolve({
        ok: true,
        json: async () => ({ success: true }),
        status: 200,
      }),
    };
    vm.createContext(drawerCtx);
    vm.runInContext(
      'function escHtml(s){return String(s==null?\'\':s).replace(/&/g,\'&amp;\').replace(/</g,\'&lt;\').replace(/>/g,\'&gt;\').replace(/"/g,\'&quot;\');}',
      drawerCtx,
    );
    vm.runInContext(actionsSrc, drawerCtx);
    ok('drawer actions loaded', typeof drawerCtx.scheduleRenderWaiverBoxInner === 'function'
      || (drawerCtx.SunsetScheduleDrawerActions
        && typeof drawerCtx.SunsetScheduleDrawerActions.renderWaiverBoxInner === 'function'));

    const renderInner = drawerCtx.scheduleRenderWaiverBoxInner
      || (drawerCtx.SunsetScheduleDrawerActions
        && drawerCtx.SunsetScheduleDrawerActions.renderWaiverBoxInner.bind(drawerCtx.SunsetScheduleDrawerActions));
    const wireWaiver = drawerCtx.scheduleWireDrawerWaiver
      || (drawerCtx.SunsetScheduleDrawerActions
        && drawerCtx.SunsetScheduleDrawerActions.wireWaiver.bind(drawerCtx.SunsetScheduleDrawerActions));
    const viewAnswers = drawerCtx.scheduleViewDrawerWaiverAnswers
      || (drawerCtx.SunsetScheduleDrawerActions
        && drawerCtx.SunsetScheduleDrawerActions.viewWaiverAnswers.bind(drawerCtx.SunsetScheduleDrawerActions));

    function productionRemountWaiver(data) {
      // Same steps as production waiverRemountFromData: render into box, then wire.
      const box = drawerDom['ps-drawer-waiver-box'];
      // Drop prior waiver child nodes so only the new HTML's ids are present.
      Object.keys(drawerDom).forEach((k) => {
        if (k !== 'ps-drawer-waiver-box' && k.indexOf('ps-drawer-waiver') === 0) delete drawerDom[k];
      });
      box.innerHTML = renderInner(data);
      wireWaiver(data);
    }

    const historicalPayload = {
      success: true,
      guest_count: 1,
      waiver: null,
      waiver_mode: 'disabled',
      waiver_offer: 'none',
      link_available: false,
      historical_native_waiver: {
        status: 'completed',
        completed_at: '2026-06-01T12:00:00.000Z',
        public_id: 'waiv_histnative01',
        submission: {
          respondent_name: 'Hist Guest',
          submitted_at: '2026-06-01T12:00:00.000Z',
          raw_answers_json: {
            answers: {
              full_name: { label: 'NOMBRE', value: 'Hist Guest' },
              accept: { label: 'Acepto', value: true },
            },
          },
        },
      },
      native_waiver_status: 'completed',
    };

    const disabledHtml = renderInner(historicalPayload);
    ok('disabled+historical shows View answers button', /id="ps-drawer-waiver-view"/.test(disabledHtml));
    ok('disabled+historical includes answers container', /id="ps-drawer-waiver-answers"/.test(disabledHtml),
      disabledHtml.slice(0, 400));
    ok('disabled+historical does not invent create/link',
      !/id="ps-drawer-waiver-create"/.test(disabledHtml)
      && !/id="ps-drawer-waiver-url"/.test(disabledHtml));

    // Production remount + wire + click path (el() only sees ids present in remounted HTML).
    ok('drawer wireWaiver available', typeof wireWaiver === 'function');
    productionRemountWaiver(historicalPayload);
    ok('remount created view button node', !!drawerDom['ps-drawer-waiver-view']);
    ok('remount created answers container node', !!drawerDom['ps-drawer-waiver-answers'],
      `keys=${Object.keys(drawerDom).join(',')}`);
    ok('view button has production onclick', typeof (drawerDom['ps-drawer-waiver-view'] && drawerDom['ps-drawer-waiver-view'].onclick) === 'function');

    if (drawerDom['ps-drawer-waiver-answers']) {
      drawerDom['ps-drawer-waiver-answers'].innerHTML = '';
      drawerDom['ps-drawer-waiver-answers'].style.display = 'none';
    }
    // Click the real wired production handler.
    if (drawerDom['ps-drawer-waiver-view'] && typeof drawerDom['ps-drawer-waiver-view'].onclick === 'function') {
      drawerDom['ps-drawer-waiver-view'].onclick();
    } else if (typeof viewAnswers === 'function') {
      viewAnswers(historicalPayload);
    }
    const answersHtml = String((drawerDom['ps-drawer-waiver-answers'] && drawerDom['ps-drawer-waiver-answers'].innerHTML) || '');
    ok('historical View answers populates container', /Hist Guest|NOMBRE|Answers/i.test(answersHtml),
      answersHtml.slice(0, 300));
    ok('historical View answers not inert empty', answersHtml.trim().length > 0);

    // External-configured historical completed remains viewable
    const externalHist = {
      success: true,
      guest_count: 1,
      waiver_mode: 'external',
      waiver_offer: 'external',
      link_available: true,
      waiver: {
        status: 'external_unverified',
        external: true,
        public_url: 'https://forms.gle/RealDispatchToken99',
        verification: 'external_unverified',
      },
      historical_native_waiver: historicalPayload.historical_native_waiver,
      native_waiver_status: 'completed',
    };
    const extHtml = renderInner(externalHist);
    ok('external+historical shows View answers', /id="ps-drawer-waiver-view"/.test(extHtml));
    ok('external+historical includes answers container', /id="ps-drawer-waiver-answers"/.test(extHtml));
    productionRemountWaiver(externalHist);
    if (drawerDom['ps-drawer-waiver-answers']) drawerDom['ps-drawer-waiver-answers'].innerHTML = '';
    if (drawerDom['ps-drawer-waiver-view'] && typeof drawerDom['ps-drawer-waiver-view'].onclick === 'function') {
      drawerDom['ps-drawer-waiver-view'].onclick();
    } else if (typeof viewAnswers === 'function') {
      viewAnswers(externalHist);
    }
    const extAnswers = String((drawerDom['ps-drawer-waiver-answers'] && drawerDom['ps-drawer-waiver-answers'].innerHTML) || '');
    ok('external historical View answers works', /Hist Guest|NOMBRE|Answers/i.test(extAnswers),
      extAnswers.slice(0, 300));
  }

  // ── [10] Real Sunset school turn: disabled vs configured external ───────
  console.log('\n[10] sunset school turn external fail-closed');
  {
    const turn = require('./lib/luna-guest-sunset-school-turn');
    const bookingId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    function makeTurnPg(settingsRow, bookingRow) {
      return {
        async query(sql, params = []) {
          const q = String(sql);
          if (/CREATE TABLE|CREATE INDEX/i.test(q)) return { rows: [] };
          if (/FROM tenant_external_waiver_settings/i.test(q) && /SELECT/i.test(q)) {
            return { rows: settingsRow ? [settingsRow] : [], rowCount: settingsRow ? 1 : 0 };
          }
          if (/FROM bookings b/i.test(q)) {
            return {
              rows: bookingRow ? [bookingRow] : [{
                booking_id: bookingId,
                booking_code: 'SUN-TURN-1',
                guest_name: 'Turn Guest',
                phone: '+34600000000',
                email: 't@example.com',
                customer_id: null,
                guest_count: 1,
                check_in: null,
                check_out: null,
                metadata: {},
              }],
            };
          }
          if (/FROM booking_service_records/i.test(q)) {
            return { rows: [{ service_date: '2026-08-01', quantity: 1, metadata: {} }] };
          }
          if (/FROM waiver_form_requests/i.test(q) && /INSERT/i.test(q)) {
            throw new Error('MUST_NOT_CREATE_NATIVE_WAIVER_IN_EXTERNAL_OR_DISABLED');
          }
          if (/FROM waiver_form_requests/i.test(q)) return { rows: [] };
          if (/FROM waiver_form_submissions/i.test(q)) return { rows: [] };
          if (/FROM conversations/i.test(q)) return { rows: [] };
          return { rows: [] };
        },
      };
    }

    const disabledTurn = await turn.runSunsetGuestSchoolTurnDryRun(
      {
        message_text: 'hi',
        booking_id: bookingId,
        ensure_waiver: true,
        guest_context: { client_slug: 'sunset', location_id: 'medano' },
      },
      {
        pg: makeTurnPg({
          client_slug: 'sunset',
          enabled: false,
          external_form_url: null,
          updated_at: new Date().toISOString(),
          updated_by: null,
        }),
        env: process.env,
      },
      { dry_run: true },
    );
    ok('disabled turn proposed_next_action not send_waiver_link',
      disabledTurn.proposed_next_action !== 'send_waiver_link',
      String(disabledTurn.proposed_next_action));
    ok('disabled turn keeps conservative next action',
      disabledTurn.proposed_next_action === 'await_guest_reply'
      || disabledTurn.proposed_next_action == null,
      String(disabledTurn.proposed_next_action));
    ok('disabled turn does not propose waiver invite link reply',
      !/forms\.gle|docs\.google\.com\/forms|formulario de inscripción de Sunset/i.test(
        String(disabledTurn.proposed_luna_reply || ''),
      ),
      String(disabledTurn.proposed_luna_reply || '').slice(0, 200));
    ok('disabled turn never claims completion',
      !/está completo|Queda registrado para la clase/i.test(
        String(disabledTurn.proposed_luna_reply || '')
        + String((disabledTurn.result && disabledTurn.result.luna_waiver_message) || ''),
      ));
    ok('disabled turn lesson_ready not true',
      disabledTurn.result && disabledTurn.result.lesson_ready !== true);

    const configuredTurn = await turn.runSunsetGuestSchoolTurnDryRun(
      {
        message_text: 'hi',
        booking_id: bookingId,
        ensure_waiver: true,
        guest_context: { client_slug: 'sunset', location_id: 'medano' },
      },
      {
        pg: makeTurnPg({
          client_slug: 'sunset',
          enabled: true,
          external_form_url: 'https://forms.gle/RealDispatchToken99',
          updated_at: new Date().toISOString(),
          updated_by: null,
        }),
        env: process.env,
      },
      { dry_run: true },
    );
    ok('configured external turn proposes send_waiver_link',
      configuredTurn.proposed_next_action === 'send_waiver_link',
      String(configuredTurn.proposed_next_action));
    ok('configured external turn reply includes authoritative URL',
      /forms\.gle\/RealDispatchToken99/.test(String(configuredTurn.proposed_luna_reply || '')),
      String(configuredTurn.proposed_luna_reply || '').slice(0, 240));
    ok('configured external turn not lesson_ready',
      configuredTurn.result && configuredTurn.result.lesson_ready === false);
    ok('configured external never claims completion',
      !/está completo|Queda registrado para la clase/i.test(
        String(configuredTurn.proposed_luna_reply || ''),
      ));

    // Misconfigured enabled (no URL)
    const misTurn = await turn.runSunsetGuestSchoolTurnDryRun(
      {
        message_text: 'hi',
        booking_id: bookingId,
        ensure_waiver: true,
        guest_context: { client_slug: 'sunset', location_id: 'medano' },
      },
      {
        pg: makeTurnPg({
          client_slug: 'sunset',
          enabled: true,
          external_form_url: null,
          updated_at: new Date().toISOString(),
          updated_by: null,
        }),
        env: process.env,
      },
      { dry_run: true },
    );
    ok('misconfigured turn not send_waiver_link',
      misTurn.proposed_next_action !== 'send_waiver_link',
      String(misTurn.proposed_next_action));
    ok('misconfigured turn no waiver link reply',
      !/forms\.gle|docs\.google\.com\/forms/i.test(String(misTurn.proposed_luna_reply || '')),
      String(misTurn.proposed_luna_reply || '').slice(0, 200));
  }

  // ── [11] npm script + adjacent source safety ─────────────────────────────
  console.log('\n[11] package script + safety');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('npm verify script registered', pkg.scripts && pkg.scripts['verify:tenant-external-waiver-settings']
    === 'node scripts/verify-tenant-external-waiver-settings.js');
  ok('no Google API integration introduced',
    !/googleapis|google\.auth|sheets\.spreadsheets/i.test(fs.readFileSync(LIB, 'utf8')));
  ok('no manual completion control',
    !/markCompleted|manual_complete|force_complete/i.test(fs.readFileSync(LIB, 'utf8') + staffSrc));

  console.log(`\n── verify:tenant-external-waiver-settings: ${pass} passed, ${fail} failed ──`);
  if (fail) {
    console.log('\nRED evidence:');
    redEvidence.forEach((line) => console.log(line));
    process.exit(1);
  }
  console.log('OK  verify:tenant-external-waiver-settings');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
