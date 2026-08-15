'use strict';

/**
 * EMAIL-GMAIL-PREPARE-002 — Accept native Google OAuth request headers.
 *
 * Live gmailfix2 POST returned 400 in 35ms before DB/prepare because
 * production read content-type via own(own(req,'headers')). Real
 * node:http IncomingMessage exposes headers through a non-enumerable
 * prototype getter, so genuine requests passed undefined into
 * parseStrictGoogleJson. Plain own-data test requests kept working.
 *
 * This verifier drives production dispatch with a genuine installed
 * IncomingMessage for both endpoint and start exact JSON bodies, keeps
 * wrong content-type / key order / extra keys at 400, and rejects
 * proxy / subclass / custom-prototype / accessor fakes. Own constructor
 * accessor or data overrides on an exact-prototype native are unread
 * and rejected before body/DB/start. The module-init pin must still
 * serve genuine IncomingMessage after ambient rebinds.
 * No network, real OAuth, or secrets.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { Socket } = require('node:net');
const owner = require('./lib/staff-google-oauth-production-integration');
const { createStaffEmailGoogleOAuthRoutes, SQL_RESOLVE_GOOGLE_START_BINDING } = require('./lib/staff-email-google-oauth-routes');

const CLIENT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACTOR = 'abcdef01-2345-4678-89ab-cdef01234567';
const SESSION = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const ENDPOINT = '11111111-2222-4333-8444-555555555555';
const LOCATION_ROW = '22222222-2222-4222-8222-222222222222';
const LOCATION = 'sunset-somo';
const ADDRESS = 'desk@gmail.example';
const EXPIRES = '2026-08-15T22:10:00.000Z';

const integrationSrc = fs.readFileSync(require.resolve('./lib/staff-google-oauth-production-integration.js'), 'utf8');

function fixtureGoogleAuthorizationUrl() {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  [
    ['client_id', '9876543210-web_client.v2.apps.googleusercontent.com'],
    ['response_type', 'code'],
    ['redirect_uri', 'https://staff-staging.lunafrontdesk.com/staff/email/google/callback'],
    ['response_mode', 'query'],
    ['scope', 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose'],
    ['state', 'a'.repeat(43)],
    ['nonce', 'b'.repeat(43)],
    ['code_challenge', 'c'.repeat(43)],
    ['code_challenge_method', 'S256'],
    ['prompt', 'consent'],
  ].forEach(([key, value]) => url.searchParams.append(key, value));
  return url.toString();
}

const GOOGLE_AUTH_URL = fixtureGoogleAuthorizationUrl();
const ENDPOINT_BODY = JSON.stringify({ location_id: LOCATION, public_address: ADDRESS });
const START_BODY = JSON.stringify({ location_id: LOCATION, endpoint_id: ENDPOINT });

function enabledEnv() {
  return Object.freeze({
    LUNA_DEPLOYMENT: 'sunset-staging',
    LUNA_EMAIL_GOOGLE_OAUTH_ENDPOINT_ENABLED: 'true',
    LUNA_EMAIL_GOOGLE_OAUTH_START_ENABLED: 'true',
    LUNA_EMAIL_GOOGLE_OAUTH_CALLBACK_ENABLED: 'true',
  });
}

function nativeIncomingMessage(spec) {
  const socket = new Socket();
  const req = new http.IncomingMessage(socket);
  req.method = spec.method || 'POST';
  req.url = spec.url;
  req.headers = spec.headers || { 'content-type': 'application/json' };
  assert.equal(Object.prototype.hasOwnProperty.call(req, 'headers'), false);
  assert.equal(Object.getOwnPropertyDescriptor(req, 'headers'), undefined);
  assert.equal(Object.getPrototypeOf(req), http.IncomingMessage.prototype);
  assert.equal(req.constructor, http.IncomingMessage);
  return req;
}

function assertValidGoogleAuthorizationDto(body) {
  assert.equal(Object.isFrozen(body), true);
  assert.equal(typeof body.authorizationUrl, 'string');
  assert.equal(typeof body.expiresAt, 'string');
  assert.equal(body.authorizationUrl, GOOGLE_AUTH_URL);
  assert.equal(body.expiresAt, EXPIRES);
  const url = new URL(body.authorizationUrl);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'accounts.google.com');
  assert.equal(url.pathname, '/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
}

function harness() {
  const replies = [];
  const effects = [];
  const adapter = owner.createStaffGoogleOAuthProductionIntegration(Object.freeze({
    env: enabledEnv(),
    sendJSON(_res, status, body) { replies.push({ status, body }); },
    sendHTML() { throw new Error('html'); },
    async requireAdmin() {
      effects.push('admin');
      return {
        ok: true,
        user: Object.freeze({
          client_id: CLIENT,
          staff_user_id: ACTOR,
          client_slug: 'sunset',
          session_id: SESSION,
        }),
      };
    },
    assertStaffClientAccess() { effects.push('acl'); return true; },
    authorizeAuthenticatedStaffRoute() { effects.push('authz'); return { ok: true }; },
    async readBody() { effects.push('body'); return harness.body; },
    withPgClient(fn) {
      effects.push('pg');
      return fn({
        query(sql, args) {
          effects.push('query');
          assert.equal(sql, SQL_RESOLVE_GOOGLE_START_BINDING);
          assert.deepEqual(args, [LOCATION, ENDPOINT]);
          return { rows: [{ client_id: CLIENT, location_id: LOCATION_ROW, endpoint_id: ENDPOINT }] };
        },
      });
    },
    createEndpointPrepare() {
      effects.push('prepare');
      return {
        async prepareDisabledDelegatedEndpoint() {
          effects.push('prepared');
          return { endpointId: ENDPOINT };
        },
      };
    },
    createGoogleRoutes(gate, authorizeProductionStart) {
      effects.push('routes');
      return createStaffEmailGoogleOAuthRoutes(Object.freeze({
        trustedGateSnapshot: gate,
        authorizeProductionStart,
        sendJSON(_res, status, body) { replies.push({ status, body }); },
        sendHTML() { throw new Error('html'); },
        assertStaffClientAccess() { throw new Error('route-acl'); },
        authorizeAuthenticatedStaffRoute() { throw new Error('route-authz'); },
        withPgClient(fn) {
          effects.push('pg');
          return fn({
            query(sql, args) {
              effects.push('query');
              assert.equal(sql, SQL_RESOLVE_GOOGLE_START_BINDING);
              assert.deepEqual(args, [LOCATION, ENDPOINT]);
              return { rows: [{ client_id: CLIENT, location_id: LOCATION_ROW, endpoint_id: ENDPOINT }] };
            },
          });
        },
        createStart() {
          effects.push('createStart');
          return {
            start() {
              effects.push('start');
              return Object.freeze({ authorizationUrl: GOOGLE_AUTH_URL, expiresAt: EXPIRES });
            },
          };
        },
        createCallbackRuntime() { throw new Error('callback'); },
      }));
    },
  }));
  return { adapter, replies, effects };
}

async function dispatch(kind, req, body) {
  const h = harness();
  harness.body = body;
  const path = kind === 'start' ? owner.GOOGLE_START_PATH : owner.GOOGLE_ENDPOINT_PATH;
  await h.adapter.dispatch(req, {}, path);
  return h;
}

async function dispatchNative(kind, body, headers) {
  const path = kind === 'start' ? owner.GOOGLE_START_PATH : owner.GOOGLE_ENDPOINT_PATH;
  const req = nativeIncomingMessage({ url: path, headers });
  try {
    return await dispatch(kind, req, body);
  } finally {
    req.destroy();
  }
}

function plainRequest(kind, headers) {
  const path = kind === 'start' ? owner.GOOGLE_START_PATH : owner.GOOGLE_ENDPOINT_PATH;
  return { method: 'POST', url: path, headers: headers || { 'content-type': 'application/json' } };
}

function assertBeyondParser(kind, result) {
  assert.equal(result.replies.length, 1);
  assert.equal(result.replies[0].status, 200);
  if (kind === 'endpoint') {
    assert.equal(result.replies[0].body.success, true);
    assert.equal(result.replies[0].body.endpoint_id, ENDPOINT);
    assert.deepEqual(Reflect.ownKeys(result.replies[0].body), ['success', 'endpoint_id']);
    assert.ok(result.effects.includes('prepare'));
    assert.ok(result.effects.includes('prepared'));
    assert.equal(result.effects.includes('routes'), false);
  } else {
    assertValidGoogleAuthorizationDto(result.replies[0].body);
    assert.ok(result.effects.includes('routes'));
    assert.ok(result.effects.includes('start'));
    assert.equal(result.effects.includes('prepare'), false);
  }
}

function assertParserRejected(result) {
  assert.equal(result.replies.length, 1);
  assert.equal(result.replies[0].status, 400);
  assert.deepEqual(result.replies[0].body, { success: false, error: 'invalid_request' });
  assert.ok(result.effects.includes('admin'));
  assert.ok(result.effects.includes('body'));
  assert.equal(result.effects.includes('prepare'), false);
  assert.equal(result.effects.includes('routes'), false);
  assert.equal(result.effects.includes('pg'), false);
  assert.equal(result.effects.includes('start'), false);
}

function assertRejectedBeforeBody(result, getterCount) {
  if (arguments.length > 1) {
    assert.equal(getterCount, 0, 'must not invoke own constructor accessor');
  }
  assert.equal(result.replies.length, 1);
  assert.equal(result.replies[0].status, 400);
  assert.deepEqual(result.replies[0].body, { success: false, error: 'invalid_request' });
  assert.ok(result.effects.includes('admin'));
  assert.equal(result.effects.includes('body'), false);
  assert.equal(result.effects.includes('prepare'), false);
  assert.equal(result.effects.includes('routes'), false);
  assert.equal(result.effects.includes('pg'), false);
  assert.equal(result.effects.includes('start'), false);
}

(async () => {
  for (const kind of ['endpoint', 'start']) {
    const body = kind === 'start' ? START_BODY : ENDPOINT_BODY;
    assertBeyondParser(kind, await dispatchNative(kind, body, { 'content-type': 'application/json' }));
    assertBeyondParser(kind, await dispatch(kind, plainRequest(kind), body));

    assertParserRejected(await dispatchNative(kind, body, { 'content-type': 'text/plain' }));
    const reversed = kind === 'start'
      ? JSON.stringify({ endpoint_id: ENDPOINT, location_id: LOCATION })
      : JSON.stringify({ public_address: ADDRESS, location_id: LOCATION });
    assertParserRejected(await dispatchNative(kind, reversed, { 'content-type': 'application/json' }));
    const extra = kind === 'start'
      ? JSON.stringify({ location_id: LOCATION, endpoint_id: ENDPOINT, extra: true })
      : JSON.stringify({ location_id: LOCATION, public_address: ADDRESS, extra: true });
    assertParserRejected(await dispatchNative(kind, extra, { 'content-type': 'application/json' }));
  }

  {
    const target = nativeIncomingMessage({
      url: owner.GOOGLE_ENDPOINT_PATH,
      headers: { 'content-type': 'application/json' },
    });
    const proxy = new Proxy(target, {});
    assert.equal(require('node:util').types.isProxy(proxy), true);
    assert.equal(Object.getPrototypeOf(proxy), http.IncomingMessage.prototype);
    assert.equal(proxy.constructor, http.IncomingMessage);
    try {
      assertParserRejected(await dispatch('endpoint', proxy, ENDPOINT_BODY));
    } finally {
      target.destroy();
    }
  }

  {
    function FakeIncomingMessage(socket) {
      http.IncomingMessage.call(this, socket);
    }
    Object.setPrototypeOf(FakeIncomingMessage.prototype, http.IncomingMessage.prototype);
    Object.setPrototypeOf(FakeIncomingMessage, http.IncomingMessage);
    const socket = new Socket();
    const req = new FakeIncomingMessage(socket);
    req.method = 'POST';
    req.url = owner.GOOGLE_ENDPOINT_PATH;
    req.headers = { 'content-type': 'application/json' };
    try {
      assertParserRejected(await dispatch('endpoint', req, ENDPOINT_BODY));
    } finally {
      req.destroy();
    }
  }

  {
    const proto = Object.create(Object.prototype);
    Object.defineProperty(proto, 'headers', {
      configurable: true,
      enumerable: false,
      get() { return { 'content-type': 'application/json' }; },
    });
    const req = Object.create(proto);
    req.method = 'POST';
    req.url = owner.GOOGLE_ENDPOINT_PATH;
    assertParserRejected(await dispatch('endpoint', req, ENDPOINT_BODY));
  }

  {
    const req = { method: 'POST', url: owner.GOOGLE_ENDPOINT_PATH };
    Object.defineProperty(req, 'headers', {
      configurable: true,
      enumerable: true,
      get() { return { 'content-type': 'application/json' }; },
    });
    assertParserRejected(await dispatch('endpoint', req, ENDPOINT_BODY));
  }

  {
    const req = nativeIncomingMessage({
      url: owner.GOOGLE_ENDPOINT_PATH,
      headers: { 'content-type': 'application/json' },
    });
    let constructorGets = 0;
    Object.defineProperty(req, 'constructor', {
      configurable: true,
      enumerable: false,
      get() {
        constructorGets += 1;
        return http.IncomingMessage;
      },
    });
    assert.equal(Object.getPrototypeOf(req), http.IncomingMessage.prototype);
    assert.equal(Object.prototype.hasOwnProperty.call(req, 'constructor'), true);
    assert.equal(Object.getOwnPropertyDescriptor(req, 'headers'), undefined);
    try {
      assertRejectedBeforeBody(await dispatch('endpoint', req, ENDPOINT_BODY), constructorGets);
    } finally {
      req.destroy();
    }
  }

  {
    const req = nativeIncomingMessage({
      url: owner.GOOGLE_ENDPOINT_PATH,
      headers: { 'content-type': 'application/json' },
    });
    Object.defineProperty(req, 'constructor', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: http.IncomingMessage,
    });
    assert.equal(Object.getPrototypeOf(req), http.IncomingMessage.prototype);
    assert.equal(Object.getOwnPropertyDescriptor(req, 'constructor').value, http.IncomingMessage);
    assert.equal(Object.getOwnPropertyDescriptor(req, 'headers'), undefined);
    try {
      assertRejectedBeforeBody(await dispatch('endpoint', req, ENDPOINT_BODY));
    } finally {
      req.destroy();
    }
  }

  {
    const originalIM = http.IncomingMessage;
    let redefineThrew = false;
    try {
      Object.defineProperty(http.IncomingMessage.prototype, 'headers', {
        configurable: true,
        enumerable: false,
        get() { return { 'content-type': 'text/html' }; },
      });
    } catch {
      redefineThrew = true;
    }
    assert.equal(redefineThrew, true, 'native headers getter must remain non-configurable');
    http.IncomingMessage = function HostileIncomingMessage() {
      throw new Error('ambient IncomingMessage replacement');
    };
    try {
      const req = new originalIM(new Socket());
      req.method = 'POST';
      req.url = owner.GOOGLE_ENDPOINT_PATH;
      req.headers = { 'content-type': 'application/json' };
      assert.equal(Object.prototype.hasOwnProperty.call(req, 'headers'), false);
      assert.equal(req.constructor, originalIM);
      try {
        assertBeyondParser('endpoint', await dispatch('endpoint', req, ENDPOINT_BODY));
      } finally {
        req.destroy();
      }
    } finally {
      http.IncomingMessage = originalIM;
    }
  }

  assert.match(integrationSrc, /IncomingMessage/);
  assert.match(integrationSrc, /PINNED_/);
  assert.match(integrationSrc, /reflectApply|Reflect\.apply/);
  assert.match(integrationSrc, /objectGetOwnPropertyDescriptor\([^)]*constructor/);
  assert.doesNotMatch(integrationSrc, /req\.constructor/);
  assert.doesNotMatch(integrationSrc, /own\(\s*own\(\s*req\s*,\s*['"]headers['"]\s*\)/);
  assert.doesNotMatch(integrationSrc, /LUNA_AUTO_SEND_ENABLED\s*=\s*['"]true['"]/);
  assert.doesNotMatch(integrationSrc, /inbox-thread/);
  assert.doesNotMatch(integrationSrc, /gmail\.send/);

  console.log('PASS EMAIL-GMAIL-PREPARE-002 native Google OAuth request headers');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
