'use strict';
// Ordinary Staff router + real location/booking settings SQL in isolated PGlite.
// Proves the France 404 is gone: load, save location, save booking settings, reload.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

const OUT = path.resolve(process.argv[2] || 'artifacts/wolfhouse-location-booking-settings-routes');

async function createHarness(out = OUT) {
  fs.mkdirSync(out, { recursive: true });
  for (const key of Object.keys(process.env)) {
    if (/^(STAFF_|LUNA_|STRIPE_|BOT_|META_|WHATSAPP_|PG|DATABASE_)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, {
    NODE_ENV: 'test',
    STAFF_RUNTIME_PROFILE: 'test',
    STAFF_API_FORTRESS_OFFLINE_LISTENER: '1',
    STAFF_AUTH_REQUIRED: 'true',
    STAFF_AUTH_HTTPS: 'false',
    DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
    LUNA_BOT_CLIENT_SLUG: 'wolfhouse-somo',
    LUNA_BOT_INTERNAL_TOKEN: 'offline-location-booking-settings-fixture-only',
    STAFF_ACTIONS_ENABLED: 'false',
    BOT_BOOKING_ENABLED: 'false',
    STRIPE_LINKS_ENABLED: 'false',
    WHATSAPP_SEND_ENABLED: 'false',
  });
  const network = [];
  const deny = (name) => () => {
    network.push(name);
    throw new Error('NETWORK FORBIDDEN: ' + name);
  };
  globalThis.fetch = deny('fetch');
  for (const name of ['node:http', 'node:https']) {
    for (const method of ['request', 'get']) require(name)[method] = deny(name + '.' + method);
  }
  require('node:net').Socket.prototype.connect = deny('Socket.connect');
  require('node:net').Server.prototype.listen = deny('Server.listen');
  require('node:tls').connect = deny('tls.connect');
  require('node:dgram').createSocket = deny('dgram.createSocket');

  const dbPath = path.join(out, 'isolated-sql-' + randomUUID());
  let db = new PGlite(dbPath);
  let session = null;
  const api = require('./staff-query-api');
  assert.equal(api.server.listening, false);
  const owner = { staff_user_id: '10000000-0000-4000-8000-000000000001', role: 'owner' };
  api.setFortress15j3OfflineSeams({
    resolveSessionUser: () => session,
    withPgClient: async (fn) => fn(db),
  });

  async function route(spec) {
    session = spec.session === 'owner'
      ? owner
      : spec.session === 'viewer'
        ? { ...owner, role: 'viewer' }
        : spec.session === 'none'
          ? null
          : owner;
    const raw = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body || {});
    const req = Readable.from([Buffer.from(raw)]);
    Object.assign(req, {
      method: spec.method || 'GET',
      url: spec.path,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    });
    let endResponse;
    const ended = new Promise((resolve) => { endResponse = resolve; });
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      getHeader(k) { return this.headers[k]; },
      writeHead(status, headers) {
        this.statusCode = status;
        if (headers) Object.assign(this.headers, headers);
      },
      end(rawBody) {
        const text = rawBody == null ? '' : rawBody.toString();
        this.body = text ? JSON.parse(text) : null;
        this.writableEnded = true;
        endResponse();
      },
    };
    await api.router(req, res);
    await ended;
    assert.equal(network.length, 0);
    return { status: res.statusCode, body: res.body };
  }

  return {
    route,
    db,
    async reopen() {
      await db.close();
      db = new PGlite(dbPath);
    },
    exec(sql) { return db.exec(sql); },
    async close() {
      api.setFortress15j3OfflineSeams(null);
      await db.close();
    },
  };
}

(async () => {
  const harness = await createHarness();
  try {
    const anon = await harness.route({
      name: 'anon',
      session: 'none',
      method: 'GET',
      path: '/staff/admin/location-booking-settings',
    });
    assert.equal(anon.status, 401, JSON.stringify(anon));

    const viewer = await harness.route({
      session: 'viewer',
      method: 'GET',
      path: '/staff/admin/location-booking-settings',
    });
    assert.equal(viewer.status, 403, JSON.stringify(viewer));

    const other = await harness.route({
      session: 'owner',
      method: 'GET',
      path: '/staff/admin/location-booking-settings?client=sunset',
    });
    assert.equal(other.status, 404, JSON.stringify(other));

    const loaded = await harness.route({
      session: 'owner',
      method: 'GET',
      path: '/staff/admin/location-booking-settings',
    });
    assert.equal(loaded.status, 200, JSON.stringify(loaded));
    assert.equal(loaded.body.location.address_text, 'C. Mies de La Ran, 41, 39140 Somo, Cantabria');
    assert.equal(loaded.body.location.google_maps_url, 'https://maps.app.goo.gl/oPRckhqozVBvXxL16');
    assert.equal(loaded.body.booking_settings.unpaid_hold_minutes, 60);
    assert.equal(loaded.body.booking_settings.require_each_guest_deposit, false);
    assert.equal(loaded.body.booking_settings.locked, false);
    assert.equal(loaded.body.booking_settings.lock_reason, '');

    const badMap = await harness.route({
      session: 'owner',
      method: 'PUT',
      path: '/staff/admin/location',
      body: {
        address_text: 'C. Mies de La Ran, 41, 39140 Somo, Cantabria',
        google_maps_url: 'javascript:alert(1)',
      },
    });
    assert.equal(badMap.status, 400, JSON.stringify(badMap));

    const savedLocation = await harness.route({
      session: 'owner',
      method: 'PUT',
      path: '/staff/admin/location',
      body: {
        address_text: 'C. Mies de La Ran, 41, 39140 Somo, Cantabria',
        google_maps_url: 'https://maps.google.com/new-location',
      },
    });
    assert.equal(savedLocation.status, 200, JSON.stringify(savedLocation));

    const badHold = await harness.route({
      session: 'owner',
      method: 'PUT',
      path: '/staff/admin/booking-settings',
      body: { unpaid_hold_minutes: 0, require_each_guest_deposit: true },
    });
    assert.equal(badHold.status, 400, JSON.stringify(badHold));

    const savedBooking = await harness.route({
      session: 'owner',
      method: 'PUT',
      path: '/staff/admin/booking-settings',
      body: { unpaid_hold_minutes: 45, require_each_guest_deposit: true },
    });
    assert.equal(savedBooking.status, 200, JSON.stringify(savedBooking));

    const reloaded = await harness.route({
      session: 'owner',
      method: 'GET',
      path: '/staff/admin/location-booking-settings',
    });
    assert.equal(reloaded.status, 200);
    assert.equal(reloaded.body.location.google_maps_url, 'https://maps.google.com/new-location');
    assert.equal(reloaded.body.booking_settings.unpaid_hold_minutes, 45);
    assert.equal(reloaded.body.booking_settings.require_each_guest_deposit, true);
    assert.equal(reloaded.body.location.address_text, 'C. Mies de La Ran, 41, 39140 Somo, Cantabria');

    await harness.reopen();
    const afterRestart = await harness.route({
      session: 'owner',
      method: 'GET',
      path: '/staff/admin/location-booking-settings',
    });
    assert.equal(afterRestart.body.location.google_maps_url, 'https://maps.google.com/new-location');
    assert.equal(afterRestart.body.booking_settings.unpaid_hold_minutes, 45);
    assert.equal(afterRestart.body.booking_settings.require_each_guest_deposit, true);

    const cleared = await harness.route({
      session: 'owner',
      method: 'PUT',
      path: '/staff/admin/location',
      body: {
        address_text: 'C. Mies de La Ran, 41, 39140 Somo, Cantabria',
        google_maps_url: '',
      },
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared));
    const clearedRead = await harness.route({
      session: 'owner',
      method: 'GET',
      path: '/staff/admin/location-booking-settings',
    });
    assert.equal(clearedRead.body.location.google_maps_url, '');
    assert.equal(clearedRead.body.booking_settings.unpaid_hold_minutes, 45);

    await harness.exec(`
      CREATE TABLE clients (id uuid PRIMARY KEY, slug text UNIQUE);
      CREATE TABLE payments (
        id uuid PRIMARY KEY,
        client_id uuid,
        status text,
        amount_paid_cents integer,
        payment_kind text
      );
      INSERT INTO clients (id, slug) VALUES ('20000000-0000-4000-8000-000000000002', 'wolfhouse-somo');
      INSERT INTO payments (id, client_id, status, amount_paid_cents, payment_kind)
      VALUES ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002', 'paid', 10000, 'deposit_only');
    `);
    const locked = await harness.route({
      session: 'owner',
      method: 'GET',
      path: '/staff/admin/location-booking-settings',
    });
    assert.equal(locked.body.booking_settings.locked, true);
    assert.equal(locked.body.booking_settings.lock_reason, 'deposit_received');
    assert.equal(locked.body.booking_settings.unpaid_hold_minutes, 45);

    const lockedSave = await harness.route({
      session: 'owner',
      method: 'PUT',
      path: '/staff/admin/booking-settings',
      body: { unpaid_hold_minutes: 90, require_each_guest_deposit: false },
    });
    assert.equal(lockedSave.status, 409, JSON.stringify(lockedSave));
    const still = await harness.route({
      session: 'owner',
      method: 'GET',
      path: '/staff/admin/location-booking-settings',
    });
    assert.equal(still.body.booking_settings.unpaid_hold_minutes, 45);
    assert.equal(still.body.booking_settings.require_each_guest_deposit, true);

    const locationWhileLocked = await harness.route({
      session: 'owner',
      method: 'PUT',
      path: '/staff/admin/location',
      body: {
        address_text: 'C. Mies de La Ran, 41, 39140 Somo, Cantabria',
        google_maps_url: 'https://maps.google.com/after-lock',
      },
    });
    assert.equal(locationWhileLocked.status, 200, JSON.stringify(locationWhileLocked));
    const locationRead = await harness.route({
      session: 'owner',
      method: 'GET',
      path: '/staff/admin/location-booking-settings',
    });
    assert.equal(locationRead.body.location.google_maps_url, 'https://maps.google.com/after-lock');
    assert.equal(locationRead.body.booking_settings.locked, true);

    console.log('PASS verify-wolfhouse-location-booking-settings-routes');
  } finally {
    await harness.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
