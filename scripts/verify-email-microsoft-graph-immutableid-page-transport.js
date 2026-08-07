'use strict';

/**
 * Hostile-path gate for Microsoft Graph ImmutableId page transport.
 *
 * Runtime-capable, UNWIRED. Pins Prefer: IdType="ImmutableId". Returns only
 * fresh frozen max-5 canonical envelopes via the single messages-transport
 * network owner (no duplicated HTTP lifecycle; no public provenance mint).
 * Lifecycle methods use owner/descriptor/native-surface checks only.
 * No raw page/context/nextLink/etag/token/PII console leakage.
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Socket } = require('net');
const EventEmitter = require('node:events');
const util = require('util');

const ROOT = path.join(__dirname, '..');
const TRANSPORT_REL = 'scripts/lib/email-microsoft-graph-immutableid-page-transport.js';
const MESSAGES_REL = 'scripts/lib/email-microsoft-graph-delegated-messages-transport.js';
const PAGE_REL = 'scripts/lib/email-microsoft-graph-normalized-page.js';
const MAPPER_REL = 'scripts/lib/email-microsoft-graph-inbound-envelope-mapper.js';
const CONTRACT_REL = 'scripts/lib/email-inbound-envelope-contract.js';
const DOC_REL = 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md';
const VERIFY_REL = 'scripts/verify-email-microsoft-graph-immutableid-page-transport.js';
const PKG_PATH = path.join(ROOT, 'package.json');

const PLANTED = 'NEVER_LEAK_subject_addr_token';
const TOKEN = 'atok-NEVER_LEAK-abcdefghijklmnopqrstuvwxyz012345';
const PLANTED_BODY = 'BODY_MUST_NEVER_APPEAR_IMMUTABLEID_PAGE';
const MAILBOX_ID = 'support@lunafrontdesk.com';
const MSG_A = 'AAMkAGI2-AAA';
const MSG_B = 'AAMkAGI2-BBB';
const MSG_C = 'AAMkAGI2-CCC';
const MSG_D = 'AAMkAGI2-DDD';
const MSG_E = 'AAMkAGI2-EEE';
const MSG_F = 'AAMkAGI2-FFF';
const VALID_ETAG = 'W/"CQAAABYAAABqZ1"';

const {
  FAILURE_CODE,
  FAILURE_MESSAGE,
  PREFER_IMMUTABLE_ID,
  PATH,
  TOP_MAX,
  SELECT_FIELDS,
  RESPONSE_CAP_BYTES,
  GRAPH_STAGES,
  EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_RUNTIME_WIRED,
  EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_PERSISTENCE_READY,
  EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_LOGGING_FORBIDDEN,
  EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_PINS_PREFER_IMMUTABLE_ID,
  EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_MAX,
  readTrustedGraphStage,
  createMicrosoftGraphImmutableIdPageTransport,
} = require('./lib/email-microsoft-graph-immutableid-page-transport');

const messagesTransport = require('./lib/email-microsoft-graph-delegated-messages-transport');
const pageBridge = require('./lib/email-microsoft-graph-normalized-page');
const {
  EMAIL_INBOUND_ENVELOPE_KEYS,
  validateInboundEmailEnvelope,
} = require('./lib/email-inbound-envelope-contract');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function ser(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function noLeak(value) {
  const text = typeof value === 'string' ? value : ser(value);
  return !text.includes('NEVER_LEAK')
    && !text.includes(PLANTED)
    && !text.includes(TOKEN)
    && !text.includes(PLANTED_BODY)
    && !text.includes('EVIL_NEXT')
    && !text.includes('client_secret=')
    && !text.includes('access_token')
    && !text.includes('@odata.nextLink')
    && !text.includes('@odata.context')
    && !text.includes('@odata.etag');
}

function emailAddress(patch = {}) {
  return { address: 'guest@example.com', name: 'Guest', ...patch };
}

function envelopeRow(patch = {}) {
  const base = {
    id: MSG_A,
    subject: 'Surf weekend',
    from: { emailAddress: emailAddress() },
    receivedDateTime: '2026-08-06T12:00:00Z',
    isRead: false,
    conversationId: 'AAQkAGConv=',
    internetMessageId: '<msg.1@example.com>',
  };
  return { ...base, ...patch };
}

function listBody(rows, extras = {}) {
  return JSON.stringify({
    '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users(...)/messages',
    value: rows,
    ...extras,
  });
}

function goodInput(patch = {}) {
  return {
    accessToken: TOKEN,
    provider_mailbox_id: MAILBOX_ID,
    ...patch,
  };
}

async function mustFailStage(action, stage) {
  await assert.rejects(action, (error) => error.code === FAILURE_CODE
    && readTrustedGraphStage(error) === stage
    && Object.isFrozen(error)
    && !Object.prototype.hasOwnProperty.call(error, 'graph_stage')
    && noLeak(error)
    && noLeak(error.message)
    && !String(error.stack || '').includes(TOKEN)
    && !JSON.stringify(error).includes('content-type')
    && !JSON.stringify(error).includes(PLANTED));
}

function mockHttps(statusCode, body, headerOverrides = {}, capture = null) {
  return function request(options, onResponse) {
    if (capture) capture(options);
    assert.equal(options.hostname, 'graph.microsoft.com');
    assert.equal(options.method, 'GET');
    assert.equal(options.path, PATH);
    assert.equal(PATH.includes('hasAttachments'), false);
    assert.match(options.headers.Authorization, /^Bearer /);
    assert.equal(options.headers.Authorization.includes(TOKEN), true);
    assert.equal(options.headers.Prefer, PREFER_IMMUTABLE_ID);
    assert.equal(options.headers.Accept, 'application/json');
    const response = new EventEmitter();
    response.statusCode = statusCode;
    Object.defineProperty(response, 'headers', {
      value: {
        'content-type': 'application/json',
        ...headerOverrides,
      },
      enumerable: true,
      configurable: true,
    });
    const req = new EventEmitter();
    req.end = () => {
      queueMicrotask(() => {
        onResponse(response);
        const buf = Buffer.from(body, 'utf8');
        response.emit('data', buf);
        response.emit('end');
      });
    };
    req.destroy = () => {};
    response.destroy = () => {};
    return req;
  };
}

function assertNoTokenSurface(value, label) {
  const text = typeof value === 'string'
    ? value
    : (() => {
      try { return JSON.stringify(value); } catch { return String(value); }
    })();
  assert.equal(text.includes(TOKEN), false, `${label}: must not contain token`);
  assert.equal(text.includes('Bearer'), false, `${label}: must not contain Bearer`);
  assert.equal(text.includes('NEVER_LEAK'), false, `${label}: must not contain planted secret`);
}

function assertRetainedOptionsScrubbed(retained, label) {
  assert.ok(retained, `${label}: options must have been retained by hostile request`);
  assert.equal(Object.isFrozen(retained), false, `${label}: retained options must not be frozen`);
  assert.ok(retained.headers, `${label}: headers object still reachable`);
  assert.equal(Object.isFrozen(retained.headers), false, `${label}: retained headers must not be frozen`);
  assert.equal(retained.headers.Authorization, null, `${label}: Authorization cleared`);
  assertNoTokenSurface(retained, label);
  assertNoTokenSurface(retained.headers, `${label} headers`);
}

function createRetainingHttps(behavior) {
  let retainedOptions = null;
  let sawTokenDuringCall = false;
  let callbackInvocations = 0;
  let preferSeen = null;

  function request(options, onResponse) {
    retainedOptions = options;
    preferSeen = options && options.headers ? options.headers.Prefer : undefined;
    sawTokenDuringCall = Boolean(
      options
      && options.headers
      && typeof options.headers.Authorization === 'string'
      && options.headers.Authorization.includes(TOKEN),
    );
    if (behavior === 'throw') {
      throw new Error(`planted-request-throw-${PLANTED}`);
    }
    const req = new EventEmitter();
    req.destroy = () => {};
    if (behavior === 'hang') {
      req.end = () => {};
      return req;
    }
    const response = new EventEmitter();
    response.statusCode = 200;
    Object.defineProperty(response, 'headers', {
      value: { 'content-type': 'application/json' },
      enumerable: true,
      configurable: true,
    });
    response.destroy = () => {};
    req.end = () => {
      queueMicrotask(() => {
        callbackInvocations += 1;
        onResponse(response);
        if (behavior === 'async-error') {
          response.emit('error', new Error(`planted-async-${PLANTED}`));
          return;
        }
        response.emit('data', Buffer.from(JSON.stringify({ value: [] }), 'utf8'));
        response.emit('end');
      });
    };
    return req;
  }

  return {
    request,
    getRetainedOptions: () => retainedOptions,
    sawTokenDuringCall: () => sawTokenDuringCall,
    callbackInvocations: () => callbackInvocations,
    preferSeen: () => preferSeen,
  };
}

function transportWith(httpsImpl, timers) {
  return createMicrosoftGraphImmutableIdPageTransport({
    httpsImpl,
    timers: timers || { setTimeout, clearTimeout },
  });
}

/**
 * Hostile surface: own-data accessors / proxy traps on lifecycle names.
 * Counters must stay zero — transport must not [[Get]] these properties.
 */
function createTrapCountingSurface(baseEmitter, trapHits) {
  const names = ['on', 'once', 'end', 'destroy', 'headers'];
  // Install own-data accessors that count if invoked; values never useful.
  for (const name of names) {
    Object.defineProperty(baseEmitter, name, {
      configurable: true,
      enumerable: false,
      get() {
        trapHits[name] = (trapHits[name] || 0) + 1;
        throw new Error(`hostile-getter-${name}-${PLANTED}`);
      },
      set() {
        trapHits[name] = (trapHits[name] || 0) + 1;
      },
    });
  }
  return baseEmitter;
}

async function main() {
  const logged = [];
  const log = console.log;
  const error = console.error;
  console.log = (...v) => {
    logged.push(['log', ...v]);
    log(...v);
  };
  console.error = (...v) => {
    logged.push(['error', ...v]);
    error(...v);
  };

  try {
    // ── Package / files / docs ────────────────────────────────────────────
    ok('transport-file-exists', fs.existsSync(path.join(ROOT, TRANSPORT_REL)));
    ok('messages-transport-exists', fs.existsSync(path.join(ROOT, MESSAGES_REL)));
    ok('page-bridge-exists', fs.existsSync(path.join(ROOT, PAGE_REL)));
    ok('doc-exists', fs.existsSync(path.join(ROOT, DOC_REL)));

    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    const scripts = pkg.scripts || {};
    ok(
      'package-gate-registered',
      scripts['verify:email-microsoft-graph-immutableid-page-transport']
        === `node ${VERIFY_REL.replace(/\\/g, '/')}`,
    );
    ok(
      'package-gate-no-deploy',
      !/deploy|azure|az |graph\.microsoft|oauth/i.test(
        String(scripts['verify:email-microsoft-graph-immutableid-page-transport'] || ''),
      ),
    );

    const doc = fs.readFileSync(path.join(ROOT, DOC_REL), 'utf8');
    ok(
      'doc-mentions-immutableid-page-transport',
      /ImmutableId.?page.?transport|immutableid.?page.?transport|Prefer.*ImmutableId/i.test(doc),
    );
    ok(
      'doc-unwired-or-non-persistence',
      /UNWIRED|not runtime-wired|non-persistence|no.*mint/i.test(doc),
    );

    // ── Flags / constants ─────────────────────────────────────────────────
    ok('prefer-exact', PREFER_IMMUTABLE_ID === 'IdType="ImmutableId"');
    ok('pins-prefer-flag', EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_PINS_PREFER_IMMUTABLE_ID === true);
    ok('not-runtime-wired', EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_RUNTIME_WIRED === false);
    ok('not-persistence-ready', EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_PERSISTENCE_READY === false);
    ok('logging-forbidden', EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_LOGGING_FORBIDDEN === true);
    ok(
      'max-matches-owners',
      EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_MAX === 5
        && EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_MAX === TOP_MAX
        && TOP_MAX === messagesTransport.TOP_MAX
        && TOP_MAX === pageBridge.EMAIL_MS_GRAPH_NORMALIZED_PAGE_MAX,
    );
    ok(
      'path-method-caps-owned-by-messages-transport',
      PATH === messagesTransport.PATH
        && RESPONSE_CAP_BYTES === messagesTransport.RESPONSE_CAP_BYTES
        && SELECT_FIELDS.join(',') === messagesTransport.SELECT_FIELDS.join(',')
        && PATH.includes('$top=5')
        && !PATH.includes('hasAttachments'),
    );
    ok(
      'graph-stages-shared',
      GRAPH_STAGES === messagesTransport.GRAPH_STAGES
        || ser([...GRAPH_STAGES]) === ser([...messagesTransport.GRAPH_STAGES]),
    );
    ok('failure-code-distinct', FAILURE_CODE === 'microsoft_graph_immutableid_page_failed');
    ok('failure-message-sanitized', !FAILURE_MESSAGE.includes('token') && !FAILURE_MESSAGE.includes('Bearer'));

    // ── Export surface: no mint/brand/capability ──────────────────────────
    const transportModule = require('./lib/email-microsoft-graph-immutableid-page-transport');
    const exportKeys = Object.keys(transportModule).sort();
    ok(
      'no-mint-brand-capability-export',
      !exportKeys.some((k) => /mint|brand|capability|provenance|WeakMap|AUTHENTICATED/i.test(k)),
      exportKeys.join(','),
    );
    ok(
      'exports-create-factory',
      typeof transportModule.createMicrosoftGraphImmutableIdPageTransport === 'function',
    );
    ok(
      'exports-no-list-without-factory',
      transportModule.listNormalizedInboundEnvelopes === undefined,
    );

    // ── RED: public authenticated-provenance mint bypass gone ─────────────
    {
      ok(
        'public-mint-capability-not-exported-from-normalized-page',
        pageBridge.createAuthenticatedGraphImmutableIdProvenanceCapability === undefined
          && pageBridge.mintAuthenticatedGraphImmutableIdProvenance === undefined
          && pageBridge.AUTHENTICATED_IMMUTABLE_ID_PROVENANCE === undefined,
      );
      const pageKeys = Object.keys(pageBridge);
      ok(
        'normalized-page-export-keys-have-no-mint-capability',
        !pageKeys.some((k) => /mint|capability|createAuthenticated|brand/i.test(k)
          || (/AUTHENTICATED/i.test(k) && !/UNAUTHENTICATED/i.test(k))),
        pageKeys.join(','),
      );
      // Forged lookalikes still fail offline bridge.
      const forged = Object.freeze({ proven: true, kind: 'ImmutableId' });
      const offline = pageBridge.mapMicrosoftGraphPageToInboundEnvelopes({
        provider: 'microsoft_graph',
        provider_mailbox_id: MAILBOX_ID,
        page: { value: [envelopeRow()] },
        graph_immutable_id_provenance: forged,
      });
      ok('forged-provenance-offline-bridge-fail', offline.ok === false && noLeak(offline), ser(offline));
      ok(
        'unauthenticated-token-still-works-offline',
        pageBridge.mapMicrosoftGraphPageToInboundEnvelopes({
          provider: 'microsoft_graph',
          provider_mailbox_id: MAILBOX_ID,
          page: { value: [envelopeRow()] },
          graph_immutable_id_provenance: pageBridge.GRAPH_IMMUTABLE_ID_PROVENANCE_UNAUTHENTICATED,
        }).ok === true,
      );
    }

    // ── Exact Prefer header on request ────────────────────────────────────
    {
      let captured = null;
      let authDuringRequest = null;
      let preferDuringRequest = null;
      let acceptDuringRequest = null;
      const t = transportWith(mockHttps(200, listBody([envelopeRow()]), {}, (opts) => {
        captured = opts;
        authDuringRequest = opts && opts.headers ? opts.headers.Authorization : null;
        preferDuringRequest = opts && opts.headers ? opts.headers.Prefer : null;
        acceptDuringRequest = opts && opts.headers ? opts.headers.Accept : null;
      }));
      const envelopes = await t.listNormalizedInboundEnvelopes(goodInput());
      ok('prefer-header-exact-on-wire', preferDuringRequest === 'IdType="ImmutableId"',
        ser({ preferDuringRequest, after: captured && captured.headers }));
      ok('prefer-not-overridable-by-input-key', preferDuringRequest === PREFER_IMMUTABLE_ID);
      ok(
        'accept-and-auth-present-during-request',
        acceptDuringRequest === 'application/json'
          && typeof authDuringRequest === 'string'
          && /^Bearer /.test(authDuringRequest)
          && authDuringRequest.includes(TOKEN),
        ser({ acceptDuringRequest, authDuringRequest: authDuringRequest && 'present' }),
      );
      ok(
        'auth-scrubbed-after-request',
        captured && captured.headers && captured.headers.Authorization === null,
      );
      ok('request-method-path', captured.method === 'GET' && captured.path === PATH);
      ok('happy-envelopes-array', Array.isArray(envelopes) && envelopes.length === 1, ser(envelopes));
      ok('happy-frozen-array', Object.isFrozen(envelopes));
      ok('happy-frozen-envelope', Object.isFrozen(envelopes[0]));
      ok(
        'happy-canonical-keys',
        Object.keys(envelopes[0]).sort().join(',')
          === [...EMAIL_INBOUND_ENVELOPE_KEYS].sort().join(','),
        ser(envelopes[0]),
      );
      ok(
        'happy-identity',
        envelopes[0].provider === 'microsoft_graph'
          && envelopes[0].provider_mailbox_id === MAILBOX_ID
          && envelopes[0].provider_message_id === MSG_A,
        ser(envelopes[0]),
      );
      const reval = validateInboundEmailEnvelope(envelopes[0]);
      ok('happy-revalidates', reval.ok === true, ser(reval));
      ok(
        'happy-no-raw-surface',
        noLeak(envelopes)
          && envelopes.page === undefined
          && envelopes[0].receivedDateTime === undefined
          && envelopes[0].id === undefined
          && envelopes[0].from === undefined
          && envelopes[0]['@odata.etag'] === undefined,
      );
    }

    // ── Header injection / override resistance ────────────────────────────
    {
      for (const [label, input] of [
        ['prefer-key', {
          accessToken: TOKEN,
          provider_mailbox_id: MAILBOX_ID,
          Prefer: 'IdType="SomethingElse"',
        }],
        ['headers-key', {
          accessToken: TOKEN,
          provider_mailbox_id: MAILBOX_ID,
          headers: { Prefer: 'evil' },
        }],
        ['provenance-boolean', {
          accessToken: TOKEN,
          provider_mailbox_id: MAILBOX_ID,
          graph_immutable_id_provenance: true,
        }],
        ['provenance-string', {
          accessToken: TOKEN,
          provider_mailbox_id: MAILBOX_ID,
          graph_immutable_id_provenance: 'ImmutableId',
        }],
        ['provenance-object', {
          accessToken: TOKEN,
          provider_mailbox_id: MAILBOX_ID,
          graph_immutable_id_provenance: { proven: true },
        }],
        ['authorization-key', {
          accessToken: TOKEN,
          provider_mailbox_id: MAILBOX_ID,
          Authorization: `Bearer ${PLANTED}`,
        }],
      ]) {
        const t = transportWith(mockHttps(200, listBody([envelopeRow()])));
        await mustFailStage(() => t.listNormalizedInboundEnvelopes(input), 'request_error');
        ok(`header-injection-resist-${label}`, true);
      }
    }

    // ── Forged provenance cannot be supplied via transport input ──────────
    {
      const forged = Object.freeze({ proven: true, kind: 'ImmutableId' });
      const t = transportWith(mockHttps(200, listBody([envelopeRow()])));
      await mustFailStage(
        () => t.listNormalizedInboundEnvelopes({
          accessToken: TOKEN,
          provider_mailbox_id: MAILBOX_ID,
          graph_immutable_id_provenance: forged,
        }),
        'request_error',
      );
      ok('forged-provenance-input-rejected', true);
      ok(
        'capability-mint-not-on-transport-exports',
        transportModule.mintAuthenticatedGraphImmutableIdProvenance === undefined
          && transportModule.createAuthenticatedGraphImmutableIdProvenanceCapability === undefined,
      );
      ok(
        'capability-mint-not-on-messages-exports',
        messagesTransport.createAuthenticatedGraphImmutableIdProvenanceCapability === undefined
          && messagesTransport.mintAuthenticatedGraphImmutableIdProvenance === undefined
          && messagesTransport.loadClassifiedMessageEnvelopePage === undefined,
      );
    }

    // ── One-shot: second call fails ───────────────────────────────────────
    {
      const t = transportWith(mockHttps(200, listBody([envelopeRow()])));
      const first = await t.listNormalizedInboundEnvelopes(goodInput());
      ok('one-shot-first-ok', Array.isArray(first) && first.length === 1);
      await mustFailStage(() => t.listNormalizedInboundEnvelopes(goodInput()), 'request_error');
      ok('one-shot-second-fails', true);
    }

    // ── One request only (count https.request invocations) ────────────────
    {
      let requestCount = 0;
      const httpsImpl = function request(options, onResponse) {
        requestCount += 1;
        return mockHttps(200, listBody([
          envelopeRow({ id: MSG_A }),
          envelopeRow({ id: MSG_B, receivedDateTime: '2026-08-05T00:00:00Z' }),
        ]))(options, onResponse);
      };
      const t = transportWith(httpsImpl);
      const envelopes = await t.listNormalizedInboundEnvelopes(goodInput());
      ok('one-request-count', requestCount === 1, `count=${requestCount}`);
      ok('multi-row-envelopes', envelopes.length === 2, ser(envelopes.map((e) => e.provider_message_id)));
      ok(
        'contract-order-desc',
        envelopes[0].provider_message_id === MSG_A
          && envelopes[1].provider_message_id === MSG_B,
        ser(envelopes.map((e) => e.provider_message_id)),
      );
    }

    // ── Max 5; six rows fail closed (no partial) ──────────────────────────
    {
      const five = [MSG_A, MSG_B, MSG_C, MSG_D, MSG_E].map((id, i) => envelopeRow({
        id,
        receivedDateTime: `2026-08-0${i + 1}T00:00:00Z`,
      }));
      const t5 = transportWith(mockHttps(200, listBody(five)));
      const e5 = await t5.listNormalizedInboundEnvelopes(goodInput());
      ok('max-five-ok', e5.length === 5, `len=${e5.length}`);

      const six = five.concat([envelopeRow({ id: MSG_F, receivedDateTime: '2026-08-06T00:00:00Z' })]);
      const t6 = transportWith(mockHttps(200, listBody(six)));
      await mustFailStage(() => t6.listNormalizedInboundEnvelopes(goodInput()), 'top_shape_invalid');
      ok('max-six-fail-closed', true);
    }

    // ── Validate/discard context, nextLink, etag — never on result ────────
    {
      const body = listBody(
        [envelopeRow({ id: MSG_A, '@odata.etag': VALID_ETAG })],
        {
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$top=5&$skiptoken=opaque',
        },
      );
      const t = transportWith(mockHttps(200, body));
      const envelopes = await t.listNormalizedInboundEnvelopes(goodInput());
      ok('meta-page-ok', envelopes.length === 1);
      ok('meta-no-odata-on-result', noLeak(envelopes) && ser(envelopes).includes('@odata') === false);
    }

    // ── Partial poison: one good + one bad row → fail whole page ──────────
    {
      const poison = listBody([
        envelopeRow({ id: MSG_A }),
        { ...envelopeRow({ id: MSG_B }), body: { content: PLANTED_BODY } },
      ]);
      const t = transportWith(mockHttps(200, poison));
      await assert.rejects(
        () => t.listNormalizedInboundEnvelopes(goodInput()),
        (err) => err.code === FAILURE_CODE
          && noLeak(err)
          && !ser(err).includes(PLANTED_BODY),
      );
      ok('partial-poison-fail-closed', true);
    }

    // ── Empty page ok ─────────────────────────────────────────────────────
    {
      const t = transportWith(mockHttps(200, JSON.stringify({ value: [] })));
      const envelopes = await t.listNormalizedInboundEnvelopes(goodInput());
      ok('empty-page-ok', Array.isArray(envelopes) && envelopes.length === 0 && Object.isFrozen(envelopes));
    }

    // ── Fresh output: successive successes are distinct frozen arrays ─────
    {
      const body = listBody([envelopeRow()]);
      const t1 = transportWith(mockHttps(200, body));
      const t2 = transportWith(mockHttps(200, body));
      const a = await t1.listNormalizedInboundEnvelopes(goodInput());
      const b = await t2.listNormalizedInboundEnvelopes(goodInput());
      ok('fresh-distinct-arrays', a !== b && Object.isFrozen(a) && Object.isFrozen(b));
      ok('fresh-deep-equal-shape', ser(a) === ser(b));
    }

    // ── RED: no getter/proxy trap hits on on/once/end/destroy/headers ─────
    {
      const trapHits = Object.create(null);
      const httpsImpl = function request(options, onResponse) {
        assert.equal(options.headers.Prefer, PREFER_IMMUTABLE_ID);
        const response = createTrapCountingSurface(new EventEmitter(), trapHits);
        // statusCode as own data (safe)
        Object.defineProperty(response, 'statusCode', {
          value: 200,
          enumerable: true,
          configurable: true,
        });
        const req = createTrapCountingSurface(new EventEmitter(), trapHits);
        // end as own-data function (not accessor) so request can complete path
        // after trap surface is rejected — actually accessors on end will block
        // and fail closed without invoking if resolveLifecycleMethod uses descriptors.
        // Replace end with own-data function after traps installed would overwrite.
        // Keep hostile accessors; expect fail-closed + zero trap hits.
        queueMicrotask(() => {
          // if transport somehow called onResponse before end, still trap
        });
        // Own-data end that never calls onResponse — transport may still attach once.
        // Use a separate path: own-data end that delivers a trap-counting response.
        Object.defineProperty(req, 'end', {
          value: () => {
            queueMicrotask(() => onResponse(response));
          },
          writable: true,
          configurable: true,
          enumerable: false,
        });
        Object.defineProperty(req, 'once', {
          value: EventEmitter.prototype.once,
          writable: true,
          configurable: true,
          enumerable: false,
        });
        Object.defineProperty(req, 'destroy', {
          value: () => {},
          writable: true,
          configurable: true,
          enumerable: false,
        });
        return req;
      };
      const t = transportWith(httpsImpl);
      await assert.rejects(
        () => t.listNormalizedInboundEnvelopes(goodInput()),
        (err) => err.code === FAILURE_CODE && noLeak(err),
      );
      const hitNames = Object.keys(trapHits).filter((k) => trapHits[k] > 0);
      ok(
        'no-lifecycle-getter-trap-hits-on-once-end-destroy-headers',
        hitNames.length === 0,
        ser(trapHits),
      );
    }

    // Proxy response: isProxy reject before traps
    if (typeof util.types.isProxy === 'function') {
      let proxyGetHits = 0;
      const httpsImpl = function request(options, onResponse) {
        assert.equal(options.headers.Prefer, PREFER_IMMUTABLE_ID);
        const raw = new EventEmitter();
        raw.statusCode = 200;
        Object.defineProperty(raw, 'headers', {
          value: { 'content-type': 'application/json' },
          enumerable: true,
        });
        raw.destroy = () => {};
        const proxied = new Proxy(raw, {
          get(t, p, r) {
            proxyGetHits += 1;
            return Reflect.get(t, p, r);
          },
        });
        const req = new EventEmitter();
        req.destroy = () => {};
        req.end = () => {
          queueMicrotask(() => {
            onResponse(proxied);
          });
        };
        return req;
      };
      const t = transportWith(httpsImpl);
      await mustFailStage(() => t.listNormalizedInboundEnvelopes(goodInput()), 'response_surface_invalid');
      ok('proxy-response-rejected', true);
      ok('proxy-get-traps-not-required-for-reject', proxyGetHits === 0, `hits=${proxyGetHits}`);
    } else {
      ok('proxy-response-skipped-no-isProxy', true);
      ok('proxy-get-traps-skipped-no-isProxy', true);
    }

    // ── Accessor-hostile headers surface ──────────────────────────────────
    {
      const httpsImpl = function request(options, onResponse) {
        const response = new EventEmitter();
        response.statusCode = 200;
        Object.defineProperty(response, 'headers', {
          get() {
            return { 'content-type': 'application/json' };
          },
          enumerable: true,
          configurable: true,
        });
        response.destroy = () => {};
        const req = new EventEmitter();
        req.destroy = () => {};
        req.end = () => {
          queueMicrotask(() => onResponse(response));
        };
        return req;
      };
      const t = transportWith(httpsImpl);
      await assert.rejects(
        () => t.listNormalizedInboundEnvelopes(goodInput()),
        (err) => err.code === FAILURE_CODE && noLeak(err),
      );
      ok('accessor-headers-fail-closed', true);
    }

    // ── RED/GREEN: own-data headers value is itself a Proxy ────────────────
    // readResponseHeaders must reject proxy-backed headers via pinned isProxy
    // BEFORE any ownData/getOwnPropertyDescriptor/key op on the headers object.
    // get / getOwnPropertyDescriptor / ownKeys traps must all remain zero.
    if (typeof util.types.isProxy === 'function') {
      const trapHits = { get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0 };
      const plainHeaders = { 'content-type': 'application/json' };
      const proxyHeaders = new Proxy(plainHeaders, {
        get(target, prop, receiver) {
          trapHits.get += 1;
          return Reflect.get(target, prop, receiver);
        },
        getOwnPropertyDescriptor(target, prop) {
          trapHits.getOwnPropertyDescriptor += 1;
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
        ownKeys(target) {
          trapHits.ownKeys += 1;
          return Reflect.ownKeys(target);
        },
      });
      assert.equal(util.types.isProxy(proxyHeaders), true);
      // Precondition: gOPD on the proxy would fire the trap (the production hole).
      Object.getOwnPropertyDescriptor(proxyHeaders, 'content-type');
      assert.equal(
        trapHits.getOwnPropertyDescriptor >= 1,
        true,
        'precondition: gOPD on proxy headers must invoke trap',
      );
      trapHits.get = 0;
      trapHits.getOwnPropertyDescriptor = 0;
      trapHits.ownKeys = 0;

      const httpsImpl = function request(options, onResponse) {
        assert.equal(options.headers.Prefer, PREFER_IMMUTABLE_ID);
        const response = new EventEmitter();
        response.statusCode = 200;
        Object.defineProperty(response, 'headers', {
          value: proxyHeaders,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        // Own-data lifecycle so surface is otherwise valid if headers were trusted.
        response.on = EventEmitter.prototype.on;
        response.once = EventEmitter.prototype.once;
        response.destroy = () => {};
        const req = new EventEmitter();
        req.destroy = () => {};
        req.once = EventEmitter.prototype.once;
        req.end = () => {
          queueMicrotask(() => onResponse(response));
        };
        return req;
      };
      const t = transportWith(httpsImpl);
      await assert.rejects(
        () => t.listNormalizedInboundEnvelopes(goodInput()),
        (err) => err.code === FAILURE_CODE
          && noLeak(err)
          && Object.isFrozen(err),
      );
      ok(
        'own-headers-proxy-get-traps-zero',
        trapHits.get === 0,
        ser(trapHits),
      );
      ok(
        'own-headers-proxy-gopd-traps-zero',
        trapHits.getOwnPropertyDescriptor === 0,
        ser(trapHits),
      );
      ok(
        'own-headers-proxy-ownKeys-traps-zero',
        trapHits.ownKeys === 0,
        ser(trapHits),
      );
      ok('own-headers-proxy-fail-closed', true);
    } else {
      ok('own-headers-proxy-get-traps-zero-skipped-no-isProxy', true);
      ok('own-headers-proxy-gopd-traps-zero-skipped-no-isProxy', true);
      ok('own-headers-proxy-ownKeys-traps-zero-skipped-no-isProxy', true);
      ok('own-headers-proxy-fail-closed-skipped-no-isProxy', true);
    }

    // Ambient util.types.isProxy monkeypatch after module init must not divert
    // the pin: proxy headers still rejected with zero traps; genuine native ok.
    if (typeof util.types.isProxy === 'function') {
      const originalIsProxy = util.types.isProxy;
      try {
        util.types.isProxy = function ambientIsProxyHide() {
          return false;
        };
        const trapHits = { get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0 };
        const proxyHeaders = new Proxy({ 'content-type': 'application/json' }, {
          get(t, p, r) {
            trapHits.get += 1;
            return Reflect.get(t, p, r);
          },
          getOwnPropertyDescriptor(t, p) {
            trapHits.getOwnPropertyDescriptor += 1;
            return Reflect.getOwnPropertyDescriptor(t, p);
          },
          ownKeys(t) {
            trapHits.ownKeys += 1;
            return Reflect.ownKeys(t);
          },
        });
        const httpsImpl = function request(options, onResponse) {
          const response = new EventEmitter();
          response.statusCode = 200;
          Object.defineProperty(response, 'headers', {
            value: proxyHeaders,
            enumerable: true,
            configurable: true,
          });
          response.on = EventEmitter.prototype.on;
          response.once = EventEmitter.prototype.once;
          response.destroy = () => {};
          const req = new EventEmitter();
          req.destroy = () => {};
          req.once = EventEmitter.prototype.once;
          req.end = () => {
            queueMicrotask(() => onResponse(response));
          };
          return req;
        };
        const t = transportWith(httpsImpl);
        await assert.rejects(
          () => t.listNormalizedInboundEnvelopes(goodInput()),
          (err) => err.code === FAILURE_CODE && noLeak(err),
        );
        ok(
          'own-headers-proxy-ambient-monkeypatch-still-rejects',
          trapHits.get === 0
            && trapHits.getOwnPropertyDescriptor === 0
            && trapHits.ownKeys === 0,
          ser(trapHits),
        );

        // Ambient always-true must not break genuine native IncomingMessage success.
        util.types.isProxy = function ambientAlwaysProxy() {
          return true;
        };
        const body = listBody([envelopeRow()]);
        let nativeHadOwnHeaders = null;
        const nativeHttps = function request(options, onResponse) {
          assert.equal(options.headers.Prefer, PREFER_IMMUTABLE_ID);
          const response = new http.IncomingMessage(new Socket());
          response.statusCode = 200;
          response.headers = { 'content-type': 'application/json' };
          response.destroy = () => {};
          nativeHadOwnHeaders = Object.prototype.hasOwnProperty.call(response, 'headers');
          const req = new EventEmitter();
          req.destroy = () => {};
          req.once = EventEmitter.prototype.once;
          req.end = () => {
            queueMicrotask(() => {
              onResponse(response);
              response.emit('data', Buffer.from(body, 'utf8'));
              response.emit('end');
            });
          };
          return req;
        };
        const nativeTransport = transportWith(nativeHttps);
        const envelopes = await nativeTransport.listNormalizedInboundEnvelopes(goodInput());
        ok(
          'genuine-native-response-success-under-ambient-isProxy-lie',
          Array.isArray(envelopes)
            && envelopes.length === 1
            && Object.isFrozen(envelopes)
            && envelopes[0].provider_message_id === MSG_A
            && nativeHadOwnHeaders === false,
          ser({ len: envelopes && envelopes.length, nativeHadOwnHeaders }),
        );
      } finally {
        util.types.isProxy = originalIsProxy;
      }
    } else {
      ok('own-headers-proxy-ambient-monkeypatch-skipped-no-isProxy', true);
      ok('genuine-native-response-success-under-ambient-skipped-no-isProxy', true);
    }

    // Genuine native IncomingMessage (non-own headers getter) full success path.
    {
      const body = listBody([envelopeRow({ id: MSG_B })]);
      let sawNonOwnHeaders = false;
      const nativeHttps = function request(options, onResponse) {
        assert.equal(options.headers.Prefer, PREFER_IMMUTABLE_ID);
        const response = new http.IncomingMessage(new Socket());
        response.statusCode = 200;
        response.headers = { 'content-type': 'application/json' };
        response.destroy = () => {};
        assert.equal(
          Object.prototype.hasOwnProperty.call(response, 'headers'),
          false,
          'native headers must not be own data',
        );
        sawNonOwnHeaders = true;
        const req = new EventEmitter();
        req.destroy = () => {};
        req.once = EventEmitter.prototype.once;
        req.end = () => {
          queueMicrotask(() => {
            onResponse(response);
            response.emit('data', Buffer.from(body, 'utf8'));
            response.emit('end');
          });
        };
        return req;
      };
      const t = transportWith(nativeHttps);
      const envelopes = await t.listNormalizedInboundEnvelopes(goodInput());
      ok(
        'genuine-native-IncomingMessage-response-success',
        sawNonOwnHeaders
          && Array.isArray(envelopes)
          && envelopes.length === 1
          && Object.isFrozen(envelopes)
          && envelopes[0].provider_message_id === MSG_B
          && envelopes[0].provider_mailbox_id === MAILBOX_ID,
        ser(envelopes && envelopes[0]),
      );
    }

    // ── Token scrub after request (success path) ──────────────────────────
    {
      const retaining = createRetainingHttps('ok');
      const t = transportWith(retaining.request);
      const envelopes = await t.listNormalizedInboundEnvelopes(goodInput());
      ok('token-scrub-success-envelopes', Array.isArray(envelopes));
      ok('token-seen-during-request', retaining.sawTokenDuringCall() === true);
      assertRetainedOptionsScrubbed(retaining.getRetainedOptions(), 'success');
      ok('token-scrub-success', true);
      ok('prefer-still-exact-after-scrub-check', retaining.preferSeen() === PREFER_IMMUTABLE_ID);
    }

    // ── Token scrub on request throw ──────────────────────────────────────
    {
      const retaining = createRetainingHttps('throw');
      const t = transportWith(retaining.request);
      await mustFailStage(() => t.listNormalizedInboundEnvelopes(goodInput()), 'request_error');
      assertRetainedOptionsScrubbed(retaining.getRetainedOptions(), 'throw');
      ok('token-scrub-on-throw', true);
    }

    // ── Token scrub on abort/async error ──────────────────────────────────
    {
      const retaining = createRetainingHttps('async-error');
      const t = transportWith(retaining.request);
      await mustFailStage(() => t.listNormalizedInboundEnvelopes(goodInput()), 'stream_invalid');
      assertRetainedOptionsScrubbed(retaining.getRetainedOptions(), 'async-error');
      ok('token-scrub-on-stream-error', true);
    }

    // ── Timeout scrub ─────────────────────────────────────────────────────
    {
      const retaining = createRetainingHttps('hang');
      let timeoutFn;
      const timers = {
        setTimeout(fn) {
          timeoutFn = fn;
          return 1;
        },
        clearTimeout() {},
      };
      const t = transportWith(retaining.request, timers);
      const p = t.listNormalizedInboundEnvelopes(goodInput());
      assert.equal(typeof timeoutFn, 'function');
      timeoutFn();
      await mustFailStage(() => p, 'timeout');
      assertRetainedOptionsScrubbed(retaining.getRetainedOptions(), 'timeout');
      ok('token-scrub-on-timeout', true);
    }

    // ── HTTP status / content-type failures sanitized ─────────────────────
    {
      const t401 = transportWith(mockHttps(401, JSON.stringify({ error: PLANTED })));
      await mustFailStage(() => t401.listNormalizedInboundEnvelopes(goodInput()), 'http_status_not_200');
      ok('http-401-sanitized', true);

      const tCt = transportWith(mockHttps(200, listBody([envelopeRow()]), {
        'content-type': 'text/plain',
      }));
      await mustFailStage(() => tCt.listNormalizedInboundEnvelopes(goodInput()), 'content_type_invalid');
      ok('content-type-invalid-sanitized', true);
    }

    // ── Invalid input shapes ──────────────────────────────────────────────
    {
      for (const [label, input] of [
        ['null', null],
        ['missing-token', { provider_mailbox_id: MAILBOX_ID }],
        ['missing-mailbox', { accessToken: TOKEN }],
        ['empty-token', { accessToken: '', provider_mailbox_id: MAILBOX_ID }],
        ['empty-mailbox', { accessToken: TOKEN, provider_mailbox_id: '' }],
        ['proxy', typeof util.types.isProxy === 'function'
          ? new Proxy(goodInput(), {})
          : { accessToken: TOKEN, provider_mailbox_id: MAILBOX_ID, extra: 1 }],
      ]) {
        const t = transportWith(mockHttps(200, listBody([envelopeRow()])));
        await mustFailStage(() => t.listNormalizedInboundEnvelopes(input), 'request_error');
        ok(`input-reject-${label}`, true);
      }
    }

    // ── Source static checks (architecture) ───────────────────────────────
    {
      const src = fs.readFileSync(path.join(ROOT, TRANSPORT_REL), 'utf8');
      const pageSrc = fs.readFileSync(path.join(ROOT, PAGE_REL), 'utf8');
      const messagesSrc = fs.readFileSync(path.join(ROOT, MESSAGES_REL), 'utf8');

      ok(
        'src-thin-immutableid-no-duplicated-http-lifecycle',
        src.split('\n').length < 120
          && !/https\.request|function onResponse|requestObject\.end/.test(src)
          && /email-microsoft-graph-delegated-messages-transport/.test(src)
          && /createMicrosoftGraphImmutableIdPageTransport/.test(src),
        `lines=${src.split('\n').length}`,
      );
      ok(
        'src-messages-is-single-network-owner',
        /createMicrosoftGraphImmutableIdPageTransport/.test(messagesSrc)
          && /PREFER_IMMUTABLE_ID|IdType="ImmutableId"/.test(messagesSrc)
          && /mapSuccessBodyToImmutableIdEnvelopes|immutableid_envelopes/.test(messagesSrc)
          && /resolveLifecycleMethod/.test(messagesSrc),
      );
      ok(
        'src-no-public-mint-on-normalized-page',
        !/createAuthenticatedGraphImmutableIdProvenanceCapability/.test(pageSrc)
          && !/mintAuthenticatedGraphImmutableIdProvenance/.test(pageSrc)
          && !/AUTHENTICATED_IMMUTABLE_ID_PROVENANCE/.test(pageSrc)
          && !/function\s+createAuthenticated/.test(pageSrc),
      );
      ok(
        'src-pins-prefer-immutableid',
        /IdType="ImmutableId"/.test(src) || /PREFER_IMMUTABLE_ID/.test(src),
      );
      ok(
        'src-runtime-wired-false',
        /EMAIL_MS_GRAPH_IMMUTABLEID_PAGE_TRANSPORT_RUNTIME_WIRED\s*=\s*false/.test(src),
      );
      ok(
        'src-no-console',
        !/\bconsole\.(log|info|debug|warn|error)\b/.test(src),
      );
      ok(
        'src-no-db',
        !/\brequire\(['"]pg['"]\)/.test(src)
          && !/\bINSERT\s+INTO\b/i.test(src),
      );
      ok(
        'src-no-route-wiring',
        !/staff-email-oauth-routes|createDelegatedGrantReadHealth|express|Router/.test(src),
      );
      ok(
        'src-no-oauth-scope-change',
        !/Mail\.Read\b|offline_access|scope\s*[:=]/.test(src),
      );
      ok(
        'messages-does-not-export-raw-page-loader',
        messagesTransport.loadClassifiedMessageEnvelopePage === undefined
          && !/^\s*loadClassifiedMessageEnvelopePage,/m.test(
            messagesSrc.split('module.exports')[1] || '',
          ),
      );
      ok(
        'page-still-rejects-boolean-provenance',
        /boolean|string|forge|reference|UNAUTHENTICATED/i.test(pageSrc),
      );
      ok(
        'src-no-competing-envelope-dto',
        !/ENVELOPE_DTO_KEYS\s*=/.test(src)
          && !/from_address/.test(src)
          && !/has_attachments/.test(src),
      );
      ok(
        'src-no-typeof-lifecycle-get-pattern',
        !/typeof\s+response\.on/.test(messagesSrc)
          && !/typeof\s+requestObject\.once/.test(messagesSrc)
          && !/typeof\s+requestObject\.end/.test(messagesSrc)
          && !/typeof\s+activeResponse\.destroy/.test(messagesSrc),
      );
    }

    // ── No raw/PII console leakage ────────────────────────────────────────
    {
      const leaky = logged.some((entry) => {
        const text = entry.map((x) => (typeof x === 'string' ? x : ser(x))).join(' ');
        return text.includes(TOKEN)
          || text.includes(PLANTED_BODY)
          || text.includes('Bearer atok');
      });
      ok('no-token-or-body-console-leakage', leaky === false);
    }

    // ── classify still never returns page; count API still present ────────
    {
      const classified = messagesTransport.classifyMessageEnvelopeBody(listBody([envelopeRow()]));
      ok(
        'classify-body-still-no-page',
        classified.stage === 'success' && classified.page === undefined && classified.count === 1,
      );
      const countTransport = messagesTransport.createMicrosoftGraphDelegatedMessagesTransport({
        httpsImpl: function request(options, onResponse) {
          // count path must NOT send Prefer
          assert.equal(options.headers.Prefer, undefined);
          return mockHttps(200, JSON.stringify({ value: [] }))(options, onResponse);
        },
      });
      // mockHttps asserts Prefer — use a dedicated count mock
      const countOnly = messagesTransport.createMicrosoftGraphDelegatedMessagesTransport({
        httpsImpl: function request(options, onResponse) {
          assert.equal(options.headers.Prefer, undefined);
          assert.match(options.headers.Authorization, /^Bearer /);
          const response = new EventEmitter();
          response.statusCode = 200;
          Object.defineProperty(response, 'headers', {
            value: { 'content-type': 'application/json' },
            enumerable: true,
          });
          response.destroy = () => {};
          const req = new EventEmitter();
          req.destroy = () => {};
          req.end = () => {
            queueMicrotask(() => {
              onResponse(response);
              response.emit('data', Buffer.from(JSON.stringify({ value: [] }), 'utf8'));
              response.emit('end');
            });
          };
          return req;
        },
      });
      const countResult = await countOnly.listMessageEnvelopeCount({ accessToken: TOKEN });
      ok(
        'count-api-behavior-compatible',
        countResult
          && countResult.message_count_bounded === 0
          && countResult.graph_stage === 'success',
        ser(countResult),
      );
      // silence unused
      ok('count-transport-factory-ok', typeof countTransport.listMessageEnvelopeCount === 'function');
    }

    // ── Mapper/contract files still present (reuse owners) ────────────────
    ok('mapper-exists', fs.existsSync(path.join(ROOT, MAPPER_REL)));
    ok('contract-exists', fs.existsSync(path.join(ROOT, CONTRACT_REL)));
  } catch (err) {
    ok('verifier-uncaught', false, String(err && err.stack ? err.stack : err));
  } finally {
    console.log = log;
    console.error = error;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
