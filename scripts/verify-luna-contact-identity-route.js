'use strict';

// Offline contract gate: extracted production contact-identity route, real
// principal dispatch/pinning, real handler; only auth and Postgres are seams.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bind = require('./lib/staff-bot-request-tenant-bind');
const principalTenant = require('./lib/staff-bot-principal-tenant-config');
const { handleContactIdentity } = require('./lib/luna-contact-identity');

const WH = 'wolfhouse-somo';
const PHONE = '+346****0001';

(async () => {
  const source = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  const routeStart = source.indexOf("  if (pathname === '/staff/bot/contact-identity') {");
  assert.notEqual(routeStart, -1, 'contact-identity route must exist');
  const routeEnd = source.indexOf('\n  }', routeStart) + '\n  }'.length;
  const route = source.slice(routeStart, routeEnd);
  const wrapper = source.match(/function dispatchBotRouteWithEffectiveTenant\([^]*?\n\}/)[0];

  const rows = new Map([[`${WH}|${PHONE}`, 'Ana García']]);
  const pg = { query: async (sql, values) => {
    const key = `${values[0]}|${values[1]}`;
    if (/INSERT INTO customers/.test(sql)) {
      rows.set(key, String(values[2]).trim());
      return { rows: [{ full_name: rows.get(key) }] };
    }
    return { rows: rows.has(key) ? [{ full_name: rows.get(key) }] : [] };
  } };
  const sendJSON = (res, status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); return body; };
  const context = vm.createContext({
    ...bind,
    ...principalTenant,
    STAFF_AUTH_REQUIRED: true,
    userCanAccessClient: (user, slug) => user.client_slug === slug,
    readBody: async req => req._cachedBody,
    sendJSON,
    send400: (res, error) => sendJSON(res, 400, { success: false, error }),
    requireBotAuth: async req => req.auth,
    withPgClient: fn => fn(pg),
    handleContactIdentity,
  });
  const dispatch = vm.runInContext(`${wrapper}\n(async function(req, res, method, parsed) {
    const pathname = '/staff/bot/contact-identity'; ${route}\n  })`, context);

  async function call(body) {
    const req = {
      _cachedBody: JSON.stringify(body),
      headers: { 'x-luna-guest-phone': PHONE },
      auth: { ok: true, auth_mode: 'bot_token', user: { client_slug: WH, role: 'bot_internal' } },
    };
    const res = { writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
      end(text) { this.body = JSON.parse(text); } };
    const outcome = await dispatch(req, res, 'POST', { query: {} });
    if (outcome && outcome.result) await outcome.result;
    return res;
  }

  let result = await call({
    client_slug: WH,
    simulator_synthetic: true,
    source_owner: 'crowsnest-simulator',
    suppress_approvals: true,
    suppress_notifications: true,
    wolfhouse_staging_capability: 'wolfhouse_staging_booking_test_link',
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { success: true, found: true, full_name: 'Ana García' });

  result = await call({
    client_slug: 'sunset',
    tenant: 'sunset',
    simulator_synthetic: true,
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { success: true, found: true, full_name: 'Ana García' });

  result = await call({
    full_name: 'Lucía',
    simulator_synthetic: true,
    source_owner: 'crowsnest-simulator',
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { success: true, saved: true, full_name: 'Lucía' });

  assert.equal(Array.from(rows.keys()).every(key => key.startsWith(`${WH}|`)), true,
    'body tenant aliases must never select the contact tenant');

  console.log('PASS contact identity: principal-only tenant, trusted phone header, simulator metadata ignored');
})().catch(error => { console.error(error); process.exitCode = 1; });
