'use strict';

/**
 * FORTRESS 15J2 — offline HTTP harness for the real staff-query-api listener/router
 * and staff-session / bot-token middleware. Injects PG + Stripe boundaries only.
 *
 * Test seams activate only when BOTH NODE_ENV=test AND
 * STAFF_API_FORTRESS_OFFLINE_LISTENER=1 (fail closed otherwise).
 *
 * Does NOT override production ACL file loading — secondary-client ACL is injected
 * via the canAccessClient offline seam only.
 */

const http = require('http');
const Module = require('module');

const BOT_TOKEN = 'fortress15j2_bot_token_offline_test_01';
const SESSION_ALPHA = 'fortress15j2-session-alpha';
const SESSION_MULTI = 'fortress15j2-session-multi';

/** Harness-only ACL map — production staff-portal access file is never overridden. */
const HARNESS_CLIENT_ACCESS = Object.freeze({
  'fortress15j2.alpha@example.test': ['wolfhouse-somo'],
  'fortress15j2.multi@example.test': ['wolfhouse-somo', 'sunset'],
});

const SESSION_USERS = {
  [SESSION_ALPHA]: {
    staff_user_id: 'staff-alpha-1',
    email: 'fortress15j2.alpha@example.test',
    role: 'operator',
    status: 'active',
    display_name: 'Alpha Operator',
    client_id: '11111111-1111-4111-8111-111111111111',
    client_slug: 'wolfhouse-somo',
  },
  [SESSION_MULTI]: {
    staff_user_id: 'staff-multi-1',
    email: 'fortress15j2.multi@example.test',
    role: 'operator',
    status: 'active',
    display_name: 'Multi Operator',
    client_id: '11111111-1111-4111-8111-111111111111',
    client_slug: 'wolfhouse-somo',
  },
};

function harnessCanAccessClient(user, clientSlug) {
  const email = user && user.email ? String(user.email).trim().toLowerCase() : '';
  const slug = String(clientSlug || '').trim();
  const allowed = HARNESS_CLIENT_ACCESS[email];
  if (!allowed) return false;
  return allowed.includes(slug);
}

function isMutatingSql(sql) {
  const q = String(sql || '').trim();
  if (/^\s*SELECT/i.test(q)) return false;
  return /INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|BEGIN|COMMIT|ROLLBACK/i.test(q);
}

function makeTrackingPg({ payments, bookings, serviceRecords, draftPayments }) {
  const queries = [];
  const writes = [];
  const withPgClient = async (fn) => {
    const pg = {
      query: async (sql, params) => {
        const q = String(sql);
        const p = params || [];
        queries.push({ sql: q, params: p });
        if (isMutatingSql(q)) {
          writes.push({ sql: q, params: p });
        }

        if (/FROM payments p/i.test(q) && /p\.id = \$1::uuid/i.test(q) && /booking_code/i.test(q)) {
          const pid = p[0];
          const slug = p[1];
          const draft = (draftPayments || []).find((row) => (
            row.payment_id === pid && row.client_slug === slug
          ));
          return { rows: draft ? [draft] : [], rowCount: draft ? 1 : 0 };
        }

        if (/FROM payments p/i.test(q) && /p\.id = \$1::uuid/i.test(q) && /JOIN clients cl/i.test(q)) {
          const pid = p[0];
          const slugParam = /cl\.slug = \$2/i.test(q) ? p[1] : null;
          const hit = (payments || []).find((row) => {
            if (row.payment_id !== pid) return false;
            if (slugParam != null && row.client_slug !== slugParam) return false;
            return true;
          });
          return { rows: hit ? [{ client_slug: hit.client_slug }] : [], rowCount: hit ? 1 : 0 };
        }

        if (/FROM bookings b/i.test(q) && /b\.id = \$1/i.test(q) && /JOIN clients cl/i.test(q)) {
          const bid = p[0];
          const hit = (bookings || []).find((row) => row.booking_id === bid);
          return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
        }

        if (/FROM booking_service_records/i.test(q) && /id = ANY/i.test(q)) {
          const ids = p[0] || [];
          const bookingId = p[1];
          const slug = p[2];
          const hits = (serviceRecords || []).filter((row) => (
            ids.includes(row.id)
            && row.booking_id === bookingId
            && row.client_slug === slug
          ));
          return { rows: hits, rowCount: hits.length };
        }

        if (/INSERT INTO payments/i.test(q)) {
          return { rows: [{ id: 'pppppppp-pppp-pppp-pppp-pppppppppppp' }], rowCount: 1 };
        }

        if (/UPDATE payments/i.test(q)) {
          return {
            rows: [{
              payment_id: p[4] || p[3],
              payment_status: 'checkout_created',
              checkout_url: 'https://checkout.test/ok',
              amount_due_cents: 1000,
              currency: 'EUR',
            }],
            rowCount: 1,
          };
        }

        if (/^\s*BEGIN/i.test(q) || /^\s*COMMIT/i.test(q) || /^\s*ROLLBACK/i.test(q)) {
          return { rows: [], rowCount: 0 };
        }

        return { rows: [], rowCount: 0 };
      },
    };
    return fn(pg);
  };
  return { queries, writes, withPgClient };
}

function makeStripeSpy(stripeCalls) {
  return function stripeFactory() {
    return {
      checkout: {
        sessions: {
          create: async (opts) => {
            stripeCalls.push(opts);
            return {
              id: 'cs_test_15j2',
              url: 'https://checkout.test/session',
              expires_at: null,
              livemode: false,
              payment_status: 'unpaid',
            };
          },
        },
      },
    };
  };
}

function patchStripeModule(stripeCalls) {
  const realLoad = Module._load;
  const factory = makeStripeSpy(stripeCalls);
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'stripe') return factory;
    return realLoad.call(this, request, parent, isMain);
  };
  return () => { Module._load = realLoad; };
}

function clearStaffApiCache() {
  const keys = Object.keys(require.cache);
  for (const key of keys) {
    if (/staff-query-api\.js$/.test(key)
      || /staff-auth-config\.js$/.test(key)
      || /staff-portal-clients\.js$/.test(key)) {
      delete require.cache[key];
    }
  }
}

function applyHarnessEnv(overrides) {
  const base = {
    NODE_ENV: 'test',
    STAFF_RUNTIME_PROFILE: 'test',
    STAFF_AUTH_REQUIRED: 'true',
    STAFF_AUTH_HTTPS: 'false',
    STAFF_QUERY_API_HOST: '127.0.0.1',
    LUNA_BOT_INTERNAL_TOKEN: BOT_TOKEN,
    LUNA_BOT_CLIENT_SLUG: 'wolfhouse-somo',
    STAFF_ACTIONS_ENABLED: 'true',
    STRIPE_LINKS_ENABLED: 'true',
    BOT_BOOKING_ENABLED: 'true',
    STRIPE_SECRET_KEY: 'sk_test_15j2_offline',
    STRIPE_CHECKOUT_SUCCESS_URL: 'https://example.test/success',
    STRIPE_CHECKOUT_CANCEL_URL: 'https://example.test/cancel',
    STAFF_API_FORTRESS_OFFLINE_LISTENER: '1',
  };
  for (const k of Object.keys(process.env)) {
    if (/^STAFF_|^LUNA_BOT_|^STRIPE_|^BOT_/.test(k)) delete process.env[k];
  }
  Object.assign(process.env, base, overrides || {});
}

function createFortress15j2OfflineListener(opts) {
  const payments = (opts && opts.payments) || [];
  const bookings = (opts && opts.bookings) || [];
  const serviceRecords = (opts && opts.serviceRecords) || [];
  const draftPayments = (opts && opts.draftPayments) || [];
  const envOverrides = (opts && opts.env) || {};

  applyHarnessEnv(envOverrides);
  clearStaffApiCache();

  const stripeCalls = [];
  const unpatchStripe = patchStripeModule(stripeCalls);
  let api;
  try {
    api = require('../staff-query-api');
  } catch (err) {
    unpatchStripe();
    throw err;
  }

  const tracking = makeTrackingPg({ payments, bookings, serviceRecords, draftPayments });
  api.setFortress15j2OfflineSeams({
    withPgClient: tracking.withPgClient,
    canAccessClient: harnessCanAccessClient,
    resolveSessionUser(req) {
      const raw = req.headers.cookie || '';
      const parts = raw.split(';');
      for (const part of parts) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const name = part.slice(0, eq).trim();
        const val = decodeURIComponent(part.slice(eq + 1).trim());
        if (name === api.COOKIE_NAME && SESSION_USERS[val]) {
          return { ...SESSION_USERS[val] };
        }
      }
      return null;
    },
  });

  const server = http.createServer(async (req, res) => {
    try {
      await api.router(req, res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'internal server error' }));
    }
  });

  return {
    api,
    server,
    tracking,
    stripeCalls,
    unpatchStripe,
    botToken: BOT_TOKEN,
    sessionAlpha: SESSION_ALPHA,
    sessionMulti: SESSION_MULTI,
  };
}

function sortedHeaders(headers) {
  const out = {};
  for (const k of Object.keys(headers || {}).sort()) {
    const v = headers[k];
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

function responseFingerprint(res) {
  return JSON.stringify({
    status: res.status,
    headers: sortedHeaders(res.headers),
    body: res.bodyRaw,
  });
}

async function listenHarness(harness) {
  await new Promise((resolve, reject) => {
    harness.server.once('error', reject);
    harness.server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = harness.server.address();
  return port;
}

async function closeHarness(harness) {
  if (harness.unpatchStripe) harness.unpatchStripe();
  if (harness.api && harness.api.setFortress15j2OfflineSeams) {
    harness.api.setFortress15j2OfflineSeams(null);
  }
  await new Promise((resolve) => {
    if (!harness.server || !harness.server.listening) return resolve();
    harness.server.close(() => resolve());
  });
}

async function httpRequest(port, { method, path: reqPath, headers, body }) {
  const payload = body == null ? '' : JSON.stringify(body);
  const hdrs = { ...(headers || {}) };
  if (payload && !hdrs['Content-Type']) hdrs['Content-Type'] = 'application/json';
  if (payload) hdrs['Content-Length'] = Buffer.byteLength(payload);

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: reqPath,
      headers: hdrs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const bodyRaw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(bodyRaw); } catch (_) { parsed = bodyRaw; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          bodyRaw,
          body: parsed,
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function staffSessionCookie(token) {
  return `luna_staff_session=${encodeURIComponent(token)}`;
}

function bodyLeaksForeignDetail(body) {
  const s = typeof body === 'string' ? body : JSON.stringify(body || {});
  return /client_slug|amount_due|booking_code|checkout_url|stripe_checkout|payment_kind/i.test(s);
}

function routeParamMatched(api, pathname, paymentId, bookingId) {
  if (paymentId) {
    const m = api.PAYMENT_STRIPE_LINK_RE.exec(pathname)
      || api.BOT_PAYMENT_STRIPE_LINK_RE.exec(pathname);
    return m && m[1] === paymentId;
  }
  if (bookingId) {
    const m = api.BOOKING_SERVICE_RECORDS_PAYMENT_LINK_RE.exec(pathname);
    return m && m[1] === bookingId;
  }
  return false;
}

module.exports = {
  BOT_TOKEN,
  SESSION_ALPHA,
  SESSION_MULTI,
  HARNESS_CLIENT_ACCESS,
  makeTrackingPg,
  createFortress15j2OfflineListener,
  listenHarness,
  closeHarness,
  httpRequest,
  staffSessionCookie,
  responseFingerprint,
  bodyLeaksForeignDetail,
  routeParamMatched,
  isMutatingSql,
  harnessCanAccessClient,
};
