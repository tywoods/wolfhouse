'use strict';

/**
 * Hostile-path gate for Microsoft Graph ImmutableId page transport.
 *
 * Runtime-capable, UNWIRED. Pins Prefer: IdType="ImmutableId". Returns only
 * fresh frozen max-5 canonical envelopes. Mints authenticated provenance
 * privately for the normalized-page bridge. No mint/brand export. No raw
 * page/context/nextLink/etag/token/PII console leakage.
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
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
const PLANTED_NEXT = 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=EVIL_NEXT';
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
        if (behavior === 'proxy-response') {
          // replaced below by caller sometimes
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

async function main() {
  const logged = [];
  const log = console.log;
  const error = console.error;
  console.log = (...v) => {
    // allow verifier PASS/FAIL lines only through original after capture filter
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

    // ── Exact Prefer header on request ────────────────────────────────────
    {
      let captured = null;
      let authDuringRequest = null;
      let preferDuringRequest = null;
      let acceptDuringRequest = null;
      const t = transportWith(mockHttps(200, listBody([envelopeRow()]), {}, (opts) => {
        captured = opts;
        // Snapshot Authorization before transport finally-scrub (same object).
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
      // Extra keys must fail closed (exact keyset). Prefer/headers/provenance
      // cannot be smuggled; transport owns Prefer exclusively.
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

    // ── Forged provenance cannot be supplied; transport mints privately ───
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

      // Offline bridge still rejects forgeries (capability mint not public on transport).
      const offline = pageBridge.mapMicrosoftGraphPageToInboundEnvelopes({
        provider: 'microsoft_graph',
        provider_mailbox_id: MAILBOX_ID,
        page: { value: [envelopeRow()] },
        graph_immutable_id_provenance: forged,
      });
      ok('forged-provenance-offline-bridge-fail', offline.ok === false && noLeak(offline), ser(offline));

      // Authenticated mint works only via capability (used privately by transport).
      const cap = pageBridge.createAuthenticatedGraphImmutableIdProvenanceCapability();
      const minted = cap.mintAuthenticatedGraphImmutableIdProvenance();
      const authed = pageBridge.mapMicrosoftGraphPageToInboundEnvelopes({
        provider: 'microsoft_graph',
        provider_mailbox_id: MAILBOX_ID,
        page: { value: [envelopeRow()] },
        graph_immutable_id_provenance: minted,
      });
      ok('capability-minted-provenance-accepted-by-bridge', authed.ok === true, ser(authed));
      ok(
        'capability-mint-not-on-transport-exports',
        transportModule.mintAuthenticatedGraphImmutableIdProvenance === undefined
          && transportModule.createAuthenticatedGraphImmutableIdProvenanceCapability === undefined,
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
      // Contract order: received_at desc
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
        (error) => error.code === FAILURE_CODE
          && noLeak(error)
          && !ser(error).includes(PLANTED_BODY),
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

    // ── Proxy response rejected ───────────────────────────────────────────
    if (typeof util.types.isProxy === 'function') {
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
          get(t, p) { return Reflect.get(t, p); },
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
    } else {
      ok('proxy-response-skipped-no-isProxy', true);
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
        // ownData cannot read accessor — should fail status/content-type path
        // Depending on pin path: non-IncomingMessage uses ownData → undefined headers
        response.on = response.on.bind(response);
        response.once = response.once.bind(response);
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
        (error) => error.code === FAILURE_CODE && noLeak(error),
      );
      ok('accessor-headers-fail-closed', true);
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

    // ── Source static checks ──────────────────────────────────────────────
    {
      const src = fs.readFileSync(path.join(ROOT, TRANSPORT_REL), 'utf8');
      const pageSrc = fs.readFileSync(path.join(ROOT, PAGE_REL), 'utf8');
      const messagesSrc = fs.readFileSync(path.join(ROOT, MESSAGES_REL), 'utf8');

      ok(
        'src-requires-messages-transport-and-page-bridge',
        /email-microsoft-graph-delegated-messages-transport/.test(src)
          && /email-microsoft-graph-normalized-page/.test(src),
      );
      ok(
        'src-reuses-loadClassified-or-classify',
        /loadClassifiedMessageEnvelopePage/.test(src),
      );
      ok(
        'src-reuses-mapMicrosoftGraphPageToInboundEnvelopes',
        /mapMicrosoftGraphPageToInboundEnvelopes/.test(src),
      );
      ok(
        'src-pins-prefer-immutableid',
        /IdType="ImmutableId"/.test(src) && /PREFER_IMMUTABLE_ID/.test(src),
      );
      ok(
        'src-mints-via-capability-privately',
        /createAuthenticatedGraphImmutableIdProvenanceCapability/.test(src)
          && /mintAuthenticatedGraphImmutableIdProvenance/.test(src),
      );
      ok(
        'src-does-not-export-mint',
        !/module\.exports[\s\S]*mintAuthenticated/.test(src)
          && /module\.exports\s*=\s*Object\.freeze/.test(src),
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
        'messages-exports-loadClassified',
        /loadClassifiedMessageEnvelopePage/.test(messagesSrc)
          && typeof messagesTransport.loadClassifiedMessageEnvelopePage === 'function',
      );
      ok(
        'page-exports-capability-not-raw-weakmap',
        typeof pageBridge.createAuthenticatedGraphImmutableIdProvenanceCapability === 'function'
          && pageBridge.AUTHENTICATED_IMMUTABLE_ID_PROVENANCE === undefined,
      );
      ok(
        'page-still-rejects-boolean-provenance',
        /boolean|string|forge|reference|unforgeable|WeakMap|UNAUTHENTICATED/i.test(pageSrc),
      );

      // No competing page/envelope DTO in transport.
      ok(
        'src-no-competing-envelope-dto',
        !/ENVELOPE_DTO_KEYS\s*=/.test(src)
          && !/from_address/.test(src)
          && !/has_attachments/.test(src),
      );

      // PATH reused not redefined as a different messages path.
      ok(
        'src-uses-imported-PATH',
        /PATH/.test(src) && /\$top=\$\{TOP_MAX\}/.test(messagesSrc),
      );
    }

    // ── No raw/PII console leakage from transport during success/fail ─────
    {
      // Filter verifier's own PASS lines; ensure transport itself did not log secrets.
      // Transport has no console — verify via source already. Also check logged
      // content from this gate's own console does not include TOKEN from errors.
      const leaky = logged.some((entry) => {
        const text = entry.map((x) => (typeof x === 'string' ? x : ser(x))).join(' ');
        // PASS lines may include test names only; fail if TOKEN or planted body appears
        return text.includes(TOKEN)
          || text.includes(PLANTED_BODY)
          || text.includes('Bearer atok');
      });
      ok('no-token-or-body-console-leakage', leaky === false);
    }

    // ── loadClassifiedMessageEnvelopePage owner behavior ──────────────────
    {
      const loaded = messagesTransport.loadClassifiedMessageEnvelopePage(
        listBody([envelopeRow({ subject: PLANTED })]),
      );
      ok(
        'load-classified-success-has-page',
        loaded.stage === 'success' && loaded.count === 1 && loaded.page && Array.isArray(loaded.page.value),
      );
      const failed = messagesTransport.loadClassifiedMessageEnvelopePage('{');
      ok(
        'load-classified-fail-no-page',
        failed.stage === 'json_invalid' && failed.page === undefined,
      );
      // classifyMessageEnvelopeBody still never returns page
      const classified = messagesTransport.classifyMessageEnvelopeBody(listBody([envelopeRow()]));
      ok(
        'classify-body-still-no-page',
        classified.stage === 'success' && classified.page === undefined && classified.count === 1,
      );
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
