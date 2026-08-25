'use strict';

/**
 * EMAIL-SMTP-004 — IMAP/SMTP disconnect button + route.
 * Disconnect revokes the identity (clears SMTP health). No password. No send.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONTRACT = require('./lib/email-sunset-smtp-secret-ref-contract');
const DISCONNECT = require('./lib/email-sunset-smtp-identity-disconnect');
const SETTINGS = require('./lib/staff-email-settings-routes');

const PATH = '/staff/admin/email-settings/smtp/disconnect';
const UI = fs.readFileSync(path.join(ROOT, 'scripts/browser/sunset-admin-email-settings-ui.js'), 'utf8');
const API = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
const INBOX = fs.readFileSync(path.join(ROOT, 'scripts/browser/inbox-thread.js'), 'utf8');

assert.equal(CONTRACT.EMAIL_SMTP_DISCONNECT_PATH, PATH);
assert.equal(DISCONNECT.EMAIL_SMTP_DISCONNECT_PATH, PATH);
assert.equal(SETTINGS.EMAIL_SMTP_DISCONNECT_PATH, PATH);
assert.ok(UI.includes(PATH));
assert.ok(UI.includes('Disconnect IMAP / SMTP'));
assert.ok(UI.includes('postSmtpDisconnect'));
assert.ok(API.includes('EMAIL_SMTP_DISCONNECT_PATH'));
assert.ok(API.includes("pathname === EMAIL_SMTP_DISCONNECT_PATH && method === 'POST'"));
assert.doesNotMatch(UI, /type="password"/);
assert.doesNotMatch(INBOX, /smtp\/disconnect/);
assert.ok(!INBOX.includes('Disconnect IMAP'));

const SUNSET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACTOR = 'abcdef01-2345-4678-89ab-cdef01234567';
const ENDPOINT = '22222222-2222-4222-8222-222222222222';
const LOCATION = 'sunset-somo';
const FLAG = 'LUNA_EMAIL_SMTP_IDENTITY_REGISTER_ENABLED';

function frozen(v) { return Object.freeze(v); }

function configuredEnv(patch) {
  return frozen(Object.assign({
    SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true',
    LUNA_DEPLOYMENT: 'sunset-staging',
    [FLAG]: 'true',
    LUNA_EMAIL_SMTP_HOST_SECRET_REF: 'kv:sunset-smtp-host',
    LUNA_EMAIL_SMTP_PORT_SECRET_REF: 'kv:sunset-smtp-port',
    LUNA_EMAIL_SMTP_TLS_MODE_SECRET_REF: 'kv:sunset-smtp-tls-mode',
    LUNA_EMAIL_SMTP_USERNAME_SECRET_REF: 'kv:sunset-smtp-username',
    LUNA_EMAIL_SMTP_PASSWORD_SECRET_REF: 'kv:sunset-smtp-password',
  }, patch || {}));
}

function sendJSON(res, status, body) {
  res.status = status;
  res.body = body;
}

function settingsRoutes(opts) {
  const res = { status: null, body: null };
  const pg = { queries: [] };
  pg.query = async (sql, params) => {
    pg.queries.push({ sql: String(sql), params });
    if (String(sql).includes("slug = 'sunset'")) {
      return { rows: [{ client_id: SUNSET_ID }] };
    }
    if (String(sql).includes('FROM tenant_locations')) {
      return { rows: [{ location_id: LOCATION }] };
    }
    if (String(sql).includes('FROM tenant_channel_endpoints') && String(sql).includes('FOR UPDATE')) {
      return { rows: [{ endpoint_id: ENDPOINT }] };
    }
    if (String(sql).startsWith('UPDATE tenant_channel_endpoints')) {
      return { rows: [{ endpoint_id: ENDPOINT }] };
    }
    return { rows: [] };
  };
  const routes = SETTINGS.createEmailSettingsRoutes({
    runtimeEnv: (opts && opts.env) || configuredEnv(),
    sendJSON,
    assertStaffClientAccess() { return true; },
    authorizeAuthenticatedStaffRoute() { return { ok: true }; },
    withPgClient: async (fn) => fn(pg),
    createSmtpIdentityDisconnect: () => DISCONNECT.createSunsetSmtpIdentityDisconnect(frozen({
      client: frozen({ query: pg.query.bind(pg) }),
      env: (opts && opts.env) || configuredEnv(),
    })),
  });
  return { routes, res, pg };
}

(async () => {
  {
    const { routes, res } = settingsRoutes({ env: configuredEnv({ [FLAG]: undefined }) });
    await routes.handleDisconnectPost(
      frozen({ location_id: LOCATION, endpoint_id: ENDPOINT }),
      { method: 'POST', url: PATH },
      res,
      { role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID },
    );
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'not_found');
  }

  {
    const { routes, res, pg } = settingsRoutes();
    await routes.handleDisconnectPost(
      frozen({ location_id: LOCATION, endpoint_id: ENDPOINT }),
      { method: 'POST', url: PATH },
      res,
      { role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.status, 'disconnected');
    assert.equal(res.body.provider, 'imap_smtp');
    assert.equal(res.body.endpoint_id, ENDPOINT);
    assert.ok(pg.queries.some((q) => String(q.sql).includes("provider_resource_id = 'disconnected'")));
    assert.ok(pg.queries.some((q) => String(q.sql).includes('imap_health_verified_at = NULL')));
    assert.ok(!pg.queries.some((q) => String(q.sql).includes("binding_status = 'revoked'")));
    assert.ok(!pg.queries.some((q) => String(q.sql).includes('DELETE FROM tenant_channel_endpoints')));
    assert.ok(!JSON.stringify(res.body).includes('kv:'));
    assert.ok(!JSON.stringify(res.body).includes('password'));
  }

  {
    const { routes, res } = settingsRoutes();
    await routes.handleDisconnectPost(
      frozen({ location_id: LOCATION }),
      { method: 'POST', url: PATH },
      res,
      { role: 'admin', staff_user_id: ACTOR, client_slug: 'sunset', client_id: SUNSET_ID },
    );
    assert.equal(res.status, 400);
  }

  console.log('PASS EMAIL-SMTP-004 IMAP/SMTP disconnect');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
