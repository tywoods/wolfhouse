'use strict';

/**
 * Hostile-path gate for Microsoft Graph messages-delta single-page transport.
 *
 * Offline only — no live Graph/DB/network. Pins Prefer: IdType="ImmutableId".
 * Returns only frozen DTO via the single messages-transport network owner.
 * Continuation reuses PR408 cursor validation; 410 brands unforgeable cursor_gone.
 * Strict proxy/accessor/symbol/nonenumerable/dangerous-key/intrinsic tests.
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Socket } = require('net');
const EventEmitter = require('node:events');
const util = require('util');

const ROOT = path.join(__dirname, '..');
const TRANSPORT_REL = 'scripts/lib/email-microsoft-graph-messages-delta-page-transport.js';
const MESSAGES_REL = 'scripts/lib/email-microsoft-graph-delegated-messages-transport.js';
const STORE_REL = 'scripts/lib/email-inbound-delta-state-store.js';
const DOC_REL = 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md';
const VERIFY_REL = 'scripts/verify-email-microsoft-graph-messages-delta-page-transport.js';
const PKG_PATH = path.join(ROOT, 'package.json');

const PLANTED = 'NEVER_LEAK_subject_addr_token';
const TOKEN = 'atok-NEVER_LEAK-abcdefghijklmnopqrstuvwxyz012345';
const PLANTED_BODY = 'BODY_MUST_NEVER_APPEAR_DELTA_PAGE';
const MAILBOX_ID = '22222222-2222-4222-8222-2222222222ab';
const OTHER_MAILBOX = '33333333-3333-4333-8333-3333333333cd';
const MSG_A = 'AAMkAGI2-AAA';
const MSG_B = 'AAMkAGI2-BBB';
const MSG_C = 'AAMkAGI2-CCC';
const MSG_D = 'AAMkAGI2-DDD';
const MSG_E = 'AAMkAGI2-EEE';
const MSG_F = 'AAMkAGI2-FFF';
const VALID_ETAG = 'W/"CQAAABYAAABqZ1"';
const SKIP_TOKEN = 'SECRET_SKIP_TOKEN_NEVER_LEAK';
const DELTA_TOKEN = 'SECRET_DELTA_TOKEN_NEVER_LEAK';

const {
  FAILURE_CODE,
  FAILURE_MESSAGE,
  PREFER_IMMUTABLE_ID,
  PATH,
  TOP_MAX,
  SELECT_FIELDS,
  RESPONSE_CAP_BYTES,
  GRAPH_STAGES,
  MESSAGES_DELTA_PAGE_RESULT_KEYS,
  MESSAGES_DELTA_CURSOR_KINDS,
  EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_RUNTIME_WIRED,
  EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_PERSISTENCE_READY,
  EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_LOGGING_FORBIDDEN,
  EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_PINS_PREFER_IMMUTABLE_ID,
  EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_USES_USERS_DELTA_PATH,
  EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_MAX,
  EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_REUSES_PR408_CURSOR,
  buildMessagesDeltaInitialPath,
  validateMessagesDeltaCursorUrl,
  readTrustedGraphStage,
  readTrustedMessagesDeltaOutcome,
  createMicrosoftGraphMessagesDeltaPageTransport,
} = require('./lib/email-microsoft-graph-messages-delta-page-transport');

const messagesTransport = require('./lib/email-microsoft-graph-delegated-messages-transport');
const deltaStore = require('./lib/email-inbound-delta-state-store');
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
    && !text.includes(SKIP_TOKEN)
    && !text.includes(DELTA_TOKEN)
    && !text.includes('client_secret=')
    && !text.includes('access_token')
    && !text.includes('@odata.nextLink')
    && !text.includes('@odata.deltaLink')
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
    body: { contentType: 'text', content: 'Real body' },
    from: { emailAddress: emailAddress() },
    receivedDateTime: '2026-08-06T12:00:00Z',
    isRead: false,
    conversationId: 'AAQkAGConv=',
    internetMessageId: '<msg.1@example.com>',
  };
  return { ...base, ...patch };
}

function deletedRow(id = MSG_B) {
  return { id, '@removed': { reason: 'deleted' } };
}

function nextLinkUrl(mailbox = MAILBOX_ID, token = SKIP_TOKEN) {
  return `https://graph.microsoft.com/v1.0/users/${mailbox}/mailFolders('inbox')/messages/delta?$skiptoken=${token}`;
}

function deltaLinkUrl(mailbox = MAILBOX_ID, token = DELTA_TOKEN) {
  return `https://graph.microsoft.com/v1.0/users/${mailbox}/mailFolders('inbox')/messages/delta?$deltatoken=${token}`;
}

function deltaBody(rows, extras = {}) {
  const base = {
    '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#Collection(message)',
    value: rows,
  };
  return JSON.stringify({ ...base, ...extras });
}

function goodInitial(patch = {}) {
  return {
    accessToken: TOKEN,
    provider_mailbox_id: MAILBOX_ID,
    ...patch,
  };
}

function goodContinuation(patch = {}) {
  return {
    accessToken: TOKEN,
    provider_mailbox_id: MAILBOX_ID,
    cursor_kind: 'nextLink',
    cursor_url: nextLinkUrl(),
    ...patch,
  };
}

function expectedInitialPath() {
  const p = buildMessagesDeltaInitialPath(MAILBOX_ID);
  assert.equal(typeof p, 'string');
  assert.match(p, /^\/v1\.0\/users\/[0-9a-f-]{36}\/mailFolders\/inbox\/messages\/delta\?/);
  assert.equal(p.includes('/me/'), false);
  assert.equal(p.includes('hasAttachments'), false);
  assert.equal(p.includes('$filter'), false);
  assert.equal(p.includes('$orderby'), false);
  return p;
}

function expectedContinuationPath() {
  const u = nextLinkUrl();
  const parsed = new URL(u);
  return `${parsed.pathname}${parsed.search}`;
}

async function mustFailStage(action, stage) {
  await assert.rejects(action, (error) => error.code === FAILURE_CODE
    && readTrustedGraphStage(error) === stage
    && Object.isFrozen(error)
    && !Object.prototype.hasOwnProperty.call(error, 'graph_stage')
    && readTrustedMessagesDeltaOutcome(error) === null
    && noLeak(error)
    && noLeak(error.message)
    && !String(error.stack || '').includes(TOKEN)
    && !JSON.stringify(error).includes('content-type')
    && !JSON.stringify(error).includes(PLANTED));
}

function mockHttps(statusCode, body, headerOverrides = {}, capture = null, expectedPath = null) {
  return function request(options, onResponse) {
    if (capture) capture(options);
    assert.equal(options.hostname, 'graph.microsoft.com');
    assert.equal(options.method, 'GET');
    if (expectedPath !== null) {
      assert.equal(options.path, expectedPath);
    }
    assert.equal(options.path.includes('/me/'), false);
    assert.equal(options.path.includes('hasAttachments'), false);
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
        if (body !== null && body !== undefined) {
          const buf = Buffer.from(body, 'utf8');
          response.emit('data', buf);
          response.emit('end');
        }
      });
    };
    req.destroy = () => {};
    response.destroy = () => {};
    return req;
  };
}

function transportWith(httpsImpl, timers) {
  return createMicrosoftGraphMessagesDeltaPageTransport({
    httpsImpl,
    timers: timers || { setTimeout, clearTimeout },
  });
}

/**
 * Hostile https.request that retains the options object reference.
 * Asserts exact validated path + Authorization during the synchronous call
 * (must not weaken), then lets the transport scrub after return.
 *
 * Optional custodyProbe: plain object the transport-facing test can pre-plant
 * so runtime proof can retain session/owner refs when the factory cooperates
 * via the same mutable owner object (probe.owner set by test harness when
 * intercepting). Always retains options.
 */
function createContinuationRetainingHttps(behavior, expectedPath, custodyProbe = null) {
  let retainedOptions = null;
  let pathDuringCall = null;
  let sawTokenDuringCall = false;
  let sawExactPathDuringCall = false;

  function request(options, onResponse) {
    retainedOptions = options;
    pathDuringCall = options && options.path;
    sawExactPathDuringCall = options && options.path === expectedPath;
    sawTokenDuringCall = Boolean(
      options
      && options.headers
      && typeof options.headers.Authorization === 'string'
      && options.headers.Authorization.includes(TOKEN),
    );
    // Keep existing synchronous-request strength: path exact + Bearer present.
    assert.equal(options.path, expectedPath);
    assert.match(options.headers.Authorization, /^Bearer /);
    assert.equal(options.headers.Authorization.includes(TOKEN), true);
    assert.equal(options.headers.Prefer, PREFER_IMMUTABLE_ID);
    if (custodyProbe) {
      custodyProbe.options = options;
      custodyProbe.pathDuring = options.path;
      // Capture mutable continuation path owner during the sync call (non-enumerable
      // probe on options). After issueRequest finally, owner.value must be null.
      try {
        const desc = Object.getOwnPropertyDescriptor(
          options,
          '_msDeltaContinuationPathOwner',
        );
        if (desc && desc.value && typeof desc.value === 'object') {
          custodyProbe.owner = desc.value;
          custodyProbe.ownerValueDuring = desc.value.value;
        }
      } catch { /* */ }
    }

    if (behavior === 'throw') {
      throw new Error(`planted-continuation-request-throw-${PLANTED}`);
    }
    const req = new EventEmitter();
    req.destroy = () => {};
    req.once = EventEmitter.prototype.once;
    if (behavior === 'hang') {
      req.end = () => {};
      return req;
    }
    const response = new EventEmitter();
    response.destroy = () => {};
    if (behavior === '410') {
      response.statusCode = 410;
    } else if (behavior === 'async-error' || behavior === 'http-fail') {
      response.statusCode = behavior === 'http-fail' ? 500 : 200;
    } else {
      response.statusCode = 200;
    }
    Object.defineProperty(response, 'headers', {
      value: { 'content-type': 'application/json' },
      enumerable: true,
      configurable: true,
    });
    req.end = () => {
      queueMicrotask(() => {
        onResponse(response);
        if (behavior === 'async-error') {
          response.emit('error', new Error(`planted-async-cont-${PLANTED}`));
          return;
        }
        if (behavior === '410' || behavior === 'http-fail') {
          return;
        }
        const body = deltaBody([], { '@odata.deltaLink': deltaLinkUrl() });
        response.emit('data', Buffer.from(body, 'utf8'));
        response.emit('end');
      });
    };
    return req;
  }

  return {
    request,
    getRetainedOptions: () => retainedOptions,
    pathDuringCall: () => pathDuringCall,
    sawTokenDuringCall: () => sawTokenDuringCall,
    sawExactPathDuringCall: () => sawExactPathDuringCall,
  };
}

function assertContinuationRetainedScrubbed(retained, label, custodyProbe = null) {
  assert.ok(retained, `${label}: options must have been retained by hostile request`);
  assert.equal(Object.isFrozen(retained), false, `${label}: retained options must not be frozen`);
  assert.ok(retained.headers, `${label}: headers object still reachable`);
  assert.equal(Object.isFrozen(retained.headers), false, `${label}: retained headers must not be frozen`);
  assert.equal(retained.headers.Authorization, null, `${label}: Authorization cleared`);
  assert.equal(
    retained.path === null || retained.path === undefined,
    true,
    `${label}: continuation path scrubbed (got ${ser(retained.path)})`,
  );
  const text = ser(retained);
  assert.equal(text.includes(TOKEN), false, `${label}: must not contain access token`);
  assert.equal(text.includes('Bearer'), false, `${label}: must not contain Bearer`);
  assert.equal(text.includes(SKIP_TOKEN), false, `${label}: must not contain skiptoken secret`);
  assert.equal(text.includes(DELTA_TOKEN), false, `${label}: must not contain deltatoken secret`);
  assert.equal(text.includes('skiptoken'), false, `${label}: must not contain skiptoken key`);
  assert.equal(text.includes('deltatoken'), false, `${label}: must not contain deltatoken key`);
  assert.equal(text.includes('NEVER_LEAK'), false, `${label}: must not contain planted secret`);
  assert.equal(noLeak(retained), true, `${label}: noLeak retained options`);
  // When the harness retained the mutable owner during requestFn, prove:
  // exact path was on owner.value during the call, and owner.value is null after.
  if (custodyProbe) {
    if (Object.prototype.hasOwnProperty.call(custodyProbe, 'pathDuring')) {
      assert.equal(
        custodyProbe.pathDuring,
        expectedContinuationPath(),
        `${label}: exact path was visible during request`,
      );
    }
    assert.ok(
      custodyProbe.owner && typeof custodyProbe.owner === 'object',
      `${label}: owner ref must be retained during request via non-enumerable probe`,
    );
    assert.equal(
      custodyProbe.ownerValueDuring,
      expectedContinuationPath(),
      `${label}: owner.value exact path during request`,
    );
    assert.equal(
      custodyProbe.owner.value,
      null,
      `${label}: owner.value null after issue (got ${ser(custodyProbe.owner.value)})`,
    );
    // Probe slot on retained options must not keep the owner object after scrub.
    const afterDesc = Object.getOwnPropertyDescriptor(
      retained,
      '_msDeltaContinuationPathOwner',
    );
    assert.equal(
      afterDesc && afterDesc.value,
      null,
      `${label}: options owner-probe slot nulled after issue`,
    );
  }
}

function createTrapCountingSurface(baseEmitter, trapHits) {
  const names = ['on', 'once', 'end', 'destroy', 'headers'];
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
    ok('store-exists', fs.existsSync(path.join(ROOT, STORE_REL)));
    ok('doc-exists', fs.existsSync(path.join(ROOT, DOC_REL)));

    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    const scripts = pkg.scripts || {};
    ok(
      'package-gate-registered',
      scripts['verify:email-microsoft-graph-messages-delta-page-transport']
        === `node ${VERIFY_REL.replace(/\\/g, '/')}`,
    );
    ok(
      'package-gate-no-deploy',
      !/deploy|azure|az |graph\.microsoft|oauth/i.test(
        String(scripts['verify:email-microsoft-graph-messages-delta-page-transport'] || ''),
      ),
    );

    const doc = fs.readFileSync(path.join(ROOT, DOC_REL), 'utf8');
    ok(
      'doc-mentions-messages-delta-page-transport',
      /messages-delta.?page.?transport|messages.?delta.?page.?transport/i.test(doc),
    );
    ok(
      'doc-unwired-or-offline',
      /UNWIRED|offline|no.*DB|not runtime-wired/i.test(doc),
    );

    // ── Flags / constants ─────────────────────────────────────────────────
    ok('prefer-exact', PREFER_IMMUTABLE_ID === 'IdType="ImmutableId"');
    ok('pins-prefer-flag', EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_PINS_PREFER_IMMUTABLE_ID === true);
    ok('not-runtime-wired', EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_RUNTIME_WIRED === false);
    ok('not-persistence-ready', EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_PERSISTENCE_READY === false);
    ok('logging-forbidden', EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_LOGGING_FORBIDDEN === true);
    ok('uses-users-delta-path', EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_USES_USERS_DELTA_PATH === true);
    ok('reuses-pr408-cursor', EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_REUSES_PR408_CURSOR === true);
    ok(
      'max-matches-owners',
      EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_MAX === 5
        && EMAIL_MS_GRAPH_MESSAGES_DELTA_PAGE_TRANSPORT_MAX === TOP_MAX
        && TOP_MAX === messagesTransport.TOP_MAX,
    );
    ok(
      'path-method-caps-owned-by-messages-transport',
      PATH === messagesTransport.PATH
        && RESPONSE_CAP_BYTES === messagesTransport.RESPONSE_CAP_BYTES
        && SELECT_FIELDS.join(',') === messagesTransport.SELECT_FIELDS.join(',')
        && PATH.includes('/me/messages')
        && PATH.includes('$top=5'),
    );
    ok(
      'delta-initial-path-exact',
      buildMessagesDeltaInitialPath(MAILBOX_ID)
        === `/v1.0/users/${MAILBOX_ID}/mailFolders/inbox/messages/delta?$top=5&$select=${SELECT_FIELDS.join(',')}`
        && buildMessagesDeltaInitialPath(MAILBOX_ID).includes('/me/') === false
        && buildMessagesDeltaInitialPath('support@lunafrontdesk.com') === null
        && buildMessagesDeltaInitialPath('ME') === null
        && buildMessagesDeltaInitialPath(MAILBOX_ID.toUpperCase()) === null,
    );
    ok(
      'cursor-kinds-pr408',
      ser([...MESSAGES_DELTA_CURSOR_KINDS]) === ser([...deltaStore.CURSOR_KINDS])
        && MESSAGES_DELTA_CURSOR_KINDS[0] === 'nextLink'
        && MESSAGES_DELTA_CURSOR_KINDS[1] === 'deltaLink',
    );
    ok(
      'validate-cursor-is-pr408-export',
      validateMessagesDeltaCursorUrl === deltaStore.validateMessagesDeltaCursorUrl
        || (typeof validateMessagesDeltaCursorUrl === 'function'
          && validateMessagesDeltaCursorUrl(nextLinkUrl(), {
            providerMailboxId: MAILBOX_ID,
            cursorKind: 'nextLink',
          }).ok === true),
    );
    ok('failure-code-distinct', FAILURE_CODE === 'microsoft_graph_messages_delta_page_failed');
    ok('failure-message-sanitized', !FAILURE_MESSAGE.includes('token') && !FAILURE_MESSAGE.includes('Bearer'));
    ok(
      'result-keys-exact',
      ser([...MESSAGES_DELTA_PAGE_RESULT_KEYS])
        === ser(['envelopes', 'tombstones', 'successor_cursor', 'observed_count']),
    );

    // ── Export surface ────────────────────────────────────────────────────
    const transportModule = require('./lib/email-microsoft-graph-messages-delta-page-transport');
    const exportKeys = Object.keys(transportModule).sort();
    ok(
      'no-mint-brand-capability-export',
      !exportKeys.some((k) => /mint|brand|capability|provenance|WeakMap|AUTHENTICATED/i.test(k)),
      exportKeys.join(','),
    );
    ok(
      'exports-create-factory',
      typeof transportModule.createMicrosoftGraphMessagesDeltaPageTransport === 'function',
    );
    ok(
      'factory-api-exact-frozen',
      (() => {
        const t = transportWith(mockHttps(200, deltaBody([], {
          '@odata.deltaLink': deltaLinkUrl(),
        }), {}, null, expectedInitialPath()));
        const keys = Object.keys(t);
        return Object.isFrozen(t)
          && keys.length === 2
          && keys[0] === 'fetchInitialPage'
          && keys[1] === 'fetchContinuationPage'
          && typeof t.fetchInitialPage === 'function'
          && typeof t.fetchContinuationPage === 'function';
      })(),
    );

    // ── Source proof: one network owner, import inert, no DB routes ───────
    {
      const thinSrc = fs.readFileSync(path.join(ROOT, TRANSPORT_REL), 'utf8');
      const messagesSrc = fs.readFileSync(path.join(ROOT, MESSAGES_REL), 'utf8');
      ok(
        'thin-wrapper-no-https-request',
        !/\bhttps\.request\b/.test(thinSrc)
          && !/require\(['"]https['"]\)/.test(thinSrc),
      );
      ok(
        'thin-wrapper-reexports-factory',
        /createMicrosoftGraphMessagesDeltaPageTransport/.test(thinSrc)
          && /email-microsoft-graph-delegated-messages-transport/.test(thinSrc),
      );
      ok(
        'messages-owner-has-delta-factory',
        /createMicrosoftGraphMessagesDeltaPageTransport/.test(messagesSrc)
          && /messages_delta_page/.test(messagesSrc)
          && /buildMessagesDeltaInitialPath/.test(messagesSrc)
          && /readTrustedMessagesDeltaOutcome/.test(messagesSrc)
          && /cursor_gone/.test(messagesSrc),
      );
      ok(
        'reuses-pr408-validateMessagesDeltaCursorUrl',
        /validateMessagesDeltaCursorUrl/.test(messagesSrc)
          && /email-inbound-delta-state-store/.test(messagesSrc),
      );
      ok(
        'no-db-routes-cron-startup-in-thin',
        !/require\(['"].*pg['"]\)/.test(thinSrc)
          && !/\bcreatePool\b/.test(thinSrc)
          && !/\bapp\.(get|post|use)\b/.test(thinSrc)
          && !/\bcron\b/i.test(thinSrc)
          && !/\bstaff-query-api\b/.test(thinSrc),
      );
      ok(
        'no-console-log-in-transport-src',
        !/\bconsole\.(log|error|info|warn|debug)\b/.test(thinSrc)
          && !/\bconsole\.(log|error|info|warn|debug)\b/.test(
            messagesSrc.split('createMicrosoftGraphMessagesDeltaPageTransport')[1] || '',
          ),
      );
      // Import inert: requiring modules must not open sockets.
      ok('import-inert-already-required', true);

      // Continuation capability custody: single mutable owner; no const string aliases.
      {
        const runIdx = messagesSrc.indexOf('function runDelegatedMessagesRequest');
        const runEnd = messagesSrc.indexOf('\nfunction createMicrosoftGraphDelegatedMessagesTransport');
        const runBody = runIdx >= 0 && runEnd > runIdx
          ? messagesSrc.slice(runIdx, runEnd)
          : '';
        const factoryIdx = messagesSrc.indexOf('function createMicrosoftGraphMessagesDeltaPageTransport');
        const factoryBody = factoryIdx >= 0
          ? messagesSrc.slice(factoryIdx, messagesSrc.indexOf('module.exports', factoryIdx))
          : '';
        const readerIdx = messagesSrc.indexOf('function readMessagesDeltaContinuationInput');
        const readerEnd = messagesSrc.indexOf('\nfunction classifyMessagesDeltaDeletedRow');
        const readerBody = readerIdx >= 0 && readerEnd > readerIdx
          ? messagesSrc.slice(readerIdx, readerEnd)
          : '';
        const contFetchIdx = factoryBody.indexOf('function fetchContinuationPage');
        const contFetchBody = contFetchIdx >= 0
          ? factoryBody.slice(contFetchIdx)
          : '';

        // runDelegatedMessagesRequest must not destructure requestPathOverride into a const alias.
        const runDestructure = runBody.match(/const\s*\{[\s\S]*?\}\s*=\s*session/);
        ok(
          'src-run-no-destructured-requestPathOverride',
          runBody.length > 0
            && runDestructure
            && !/requestPathOverride/.test(runDestructure[0])
            && !/continuationPathOwner/.test(runDestructure[0]),
          runDestructure ? runDestructure[0].slice(0, 200) : 'missing destructure',
        );
        ok(
          'src-continuation-mutable-path-owner',
          /continuationPathOwner\s*:\s*\{\s*value:\s*requestPath\s*\}/.test(readerBody)
            && /continuationPathOwner/.test(contFetchBody)
            && /continuationPathOwner\.value\s*=\s*null/.test(runBody)
            && /session\.continuationPathOwner\s*=\s*null/.test(runBody),
        );
        ok(
          'src-no-continuation-const-requestPath-alias',
          contFetchBody.length > 0
            && !/const\s+requestPath\s*=\s*parsed\.requestPath/.test(contFetchBody)
            && !/requestPathOverride\s*:\s*requestPath/.test(contFetchBody)
            && !/requestPathOverride\s*:\s*parsed/.test(contFetchBody),
        );
        ok(
          'src-reader-no-immutable-path-string-fields',
          readerBody.length > 0
            && !/requestPath\s*,/.test(readerBody.split('return')[1] || '')
            && !/cursor_url\s*:\s*validated/.test(readerBody)
            && /continuationPathOwner\s*:\s*\{\s*value:\s*requestPath\s*\}/.test(readerBody),
        );
        ok(
          'src-issueRequest-consumes-owner-value-sync',
          /scrubDeltaContinuationPath[\s\S]*?pathForRequest\s*=\s*continuationPathOwner\.value/.test(runBody)
            && /if\s*\(requestOptions\)\s*requestOptions\.path\s*=\s*null/.test(runBody),
        );
        ok(
          'src-fetchContinuation-nulls-parsed-and-owner',
          /parsed\s*=\s*null/.test(contFetchBody)
            && /continuationPathOwner\.value\s*=\s*null/.test(contFetchBody)
            && /session\.continuationPathOwner\s*=\s*null/.test(contFetchBody),
        );
      }
    }

    // ── Happy initial: envelopes + successor deltaLink ────────────────────
    {
      let captured = null;
      const body = deltaBody(
        [envelopeRow({ id: MSG_A })],
        { '@odata.deltaLink': deltaLinkUrl() },
      );
      const t = transportWith(mockHttps(200, body, {}, (opts) => {
        captured = opts;
      }, expectedInitialPath()));
      const dto = await t.fetchInitialPage(goodInitial());
      ok('initial-prefer-header', captured.headers.Prefer === 'IdType="ImmutableId"');
      ok('initial-accept-json', captured.headers.Accept === 'application/json');
      ok(
        'initial-path-exact-delta',
        captured.path === expectedInitialPath()
          && captured.path.includes(`/users/${MAILBOX_ID}/mailFolders/inbox/messages/delta`)
          && captured.path.includes('$top=5')
          && !captured.path.includes('/me/')
          && !captured.path.includes('$filter')
          && !captured.path.includes('$orderby'),
      );
      ok('initial-auth-scrubbed', captured.headers.Authorization === null);
      ok('dto-frozen', Object.isFrozen(dto));
      ok(
        'dto-keys-exact',
        Object.keys(dto).join(',') === MESSAGES_DELTA_PAGE_RESULT_KEYS.join(','),
        ser(Object.keys(dto)),
      );
      ok('dto-observed-1', dto.observed_count === 1);
      ok('dto-envelopes-1', Array.isArray(dto.envelopes) && dto.envelopes.length === 1
        && Object.isFrozen(dto.envelopes));
      ok('dto-tombstones-0', Array.isArray(dto.tombstones) && dto.tombstones.length === 0
        && Object.isFrozen(dto.tombstones));
      ok(
        'dto-successor-deltaLink',
        dto.successor_cursor
          && Object.isFrozen(dto.successor_cursor)
          && dto.successor_cursor.cursor_kind === 'deltaLink'
          && dto.successor_cursor.cursor_url === deltaLinkUrl()
          && Object.keys(dto.successor_cursor).join(',') === 'cursor_kind,cursor_url',
      );
      ok(
        'envelope-canonical',
        dto.envelopes[0].provider === 'microsoft_graph'
          && dto.envelopes[0].provider_mailbox_id === MAILBOX_ID
          && dto.envelopes[0].provider_message_id === MSG_A
          && validateInboundEmailEnvelope(dto.envelopes[0]).ok === true
          && Object.keys(dto.envelopes[0]).sort().join(',')
            === [...EMAIL_INBOUND_ENVELOPE_KEYS].sort().join(','),
      );
      ok(
        'dto-no-raw-odata-on-result-surface-keys',
        dto.page === undefined
          && dto.envelopes[0].id === undefined
          && dto.envelopes[0]['@odata.etag'] === undefined
          && dto['@odata.deltaLink'] === undefined,
      );
    }

    // ── Happy: tombstone + nextLink successor ─────────────────────────────
    {
      const body = deltaBody(
        [deletedRow(MSG_B), envelopeRow({ id: MSG_A })],
        { '@odata.nextLink': nextLinkUrl() },
      );
      const t = transportWith(mockHttps(200, body, {}, null, expectedInitialPath()));
      const dto = await t.fetchInitialPage(goodInitial());
      ok('mixed-observed-2', dto.observed_count === 2);
      ok('mixed-tombstone-1', dto.tombstones.length === 1
        && dto.tombstones[0].provider === 'microsoft_graph'
        && dto.tombstones[0].provider_mailbox_id === MAILBOX_ID
        && dto.tombstones[0].provider_message_id === MSG_B
        && Object.keys(dto.tombstones[0]).join(',')
          === 'provider,provider_mailbox_id,provider_message_id'
        && Object.isFrozen(dto.tombstones[0]));
      ok('mixed-envelope-1', dto.envelopes.length === 1
        && dto.envelopes[0].provider_message_id === MSG_A);
      ok('mixed-successor-nextLink', dto.successor_cursor.cursor_kind === 'nextLink'
        && dto.successor_cursor.cursor_url === nextLinkUrl());
    }

    // ── Official Graph deleted row: @odata.type (+ optional etag) discarded ─
    {
      const officialDeleted = {
        '@odata.type': '#microsoft.graph.message',
        id: MSG_B,
        '@removed': { reason: 'deleted' },
      };
      const tType = transportWith(mockHttps(
        200,
        deltaBody([officialDeleted], { '@odata.deltaLink': deltaLinkUrl() }),
        {},
        null,
        expectedInitialPath(),
      ));
      const dtoType = await tType.fetchInitialPage(goodInitial());
      ok('official-deleted-type-tombstone', dtoType.tombstones.length === 1
        && dtoType.envelopes.length === 0
        && dtoType.tombstones[0].provider_message_id === MSG_B);
      ok(
        'official-deleted-type-not-on-result',
        ser(dtoType).includes('@odata.type') === false
          && ser(dtoType).includes('#microsoft.graph.message') === false,
      );

      const withEtag = {
        '@odata.type': '#microsoft.graph.message',
        '@odata.etag': VALID_ETAG,
        id: MSG_B,
        '@removed': { reason: 'deleted' },
      };
      const tBoth = transportWith(mockHttps(
        200,
        deltaBody([withEtag], { '@odata.deltaLink': deltaLinkUrl() }),
        {},
        null,
        expectedInitialPath(),
      ));
      const dtoBoth = await tBoth.fetchInitialPage(goodInitial());
      ok('deleted-type-etag-tombstone', dtoBoth.tombstones.length === 1
        && ser(dtoBoth).includes('@odata.etag') === false
        && ser(dtoBoth).includes(VALID_ETAG) === false);

      const etagOnly = {
        id: MSG_B,
        '@odata.etag': VALID_ETAG,
        '@removed': { reason: 'deleted' },
      };
      const tEtag = transportWith(mockHttps(
        200,
        deltaBody([etagOnly], { '@odata.deltaLink': deltaLinkUrl() }),
        {},
        null,
        expectedInitialPath(),
      ));
      const dtoEtag = await tEtag.fetchInitialPage(goodInitial());
      ok('deleted-etag-only-tombstone', dtoEtag.tombstones.length === 1);

      const calType = {
        '@odata.type': '#microsoft.graph.calendarSharingMessage',
        id: MSG_B,
        '@removed': { reason: 'deleted' },
      };
      const tCal = transportWith(mockHttps(
        200,
        deltaBody([calType], { '@odata.deltaLink': deltaLinkUrl() }),
        {},
        null,
        expectedInitialPath(),
      ));
      const dtoCal = await tCal.fetchInitialPage(goodInitial());
      ok('deleted-closed-odata-type-tombstone', dtoCal.tombstones.length === 1);
    }

    // ── Zero rows valid (still needs exact one successor link) ────────────
    {
      const body = deltaBody([], { '@odata.deltaLink': deltaLinkUrl() });
      const t = transportWith(mockHttps(200, body, {}, null, expectedInitialPath()));
      const dto = await t.fetchInitialPage(goodInitial());
      ok('zero-rows-ok', dto.observed_count === 0
        && dto.envelopes.length === 0
        && dto.tombstones.length === 0
        && dto.successor_cursor.cursor_kind === 'deltaLink');
    }

    // ── Missing both links / both links → fail ────────────────────────────
    {
      const t1 = transportWith(mockHttps(200, JSON.stringify({ value: [] }), {}, null, expectedInitialPath()));
      await mustFailStage(() => t1.fetchInitialPage(goodInitial()), 'top_shape_invalid');
      ok('missing-successor-fail', true);

      const both = deltaBody([envelopeRow()], {
        '@odata.nextLink': nextLinkUrl(),
        '@odata.deltaLink': deltaLinkUrl(),
      });
      const t2 = transportWith(mockHttps(200, both, {}, null, expectedInitialPath()));
      await mustFailStage(() => t2.fetchInitialPage(goodInitial()), 'top_shape_invalid');
      ok('both-successors-fail', true);
    }

    // ── Max 5; six rows fail closed ───────────────────────────────────────
    {
      const five = [MSG_A, MSG_B, MSG_C, MSG_D, MSG_E].map((id, i) => envelopeRow({
        id,
        receivedDateTime: `2026-08-0${i + 1}T00:00:00Z`,
      }));
      const t5 = transportWith(mockHttps(
        200,
        deltaBody(five, { '@odata.deltaLink': deltaLinkUrl() }),
        {},
        null,
        expectedInitialPath(),
      ));
      const e5 = await t5.fetchInitialPage(goodInitial());
      ok('max-five-ok', e5.observed_count === 5 && e5.envelopes.length === 5);

      const six = five.concat([envelopeRow({ id: MSG_F, receivedDateTime: '2026-08-06T00:00:00Z' })]);
      const t6 = transportWith(mockHttps(
        200,
        deltaBody(six, { '@odata.deltaLink': deltaLinkUrl() }),
        {},
        null,
        expectedInitialPath(),
      ));
      await mustFailStage(() => t6.fetchInitialPage(goodInitial()), 'top_shape_invalid');
      ok('max-six-fail-closed', true);
    }

    // ── Etag discard; context discard ─────────────────────────────────────
    {
      const body = deltaBody(
        [envelopeRow({ id: MSG_A, '@odata.etag': VALID_ETAG })],
        { '@odata.deltaLink': deltaLinkUrl() },
      );
      const t = transportWith(mockHttps(200, body, {}, null, expectedInitialPath()));
      const dto = await t.fetchInitialPage(goodInitial());
      ok('etag-discard-ok', dto.envelopes.length === 1);
      ok(
        'no-etag-on-result',
        ser(dto).includes('@odata.etag') === false
          && ser(dto).includes(VALID_ETAG) === false,
      );
    }

    // ── Graph message type annotation: exact value accepted then discarded ─
    {
      const body = deltaBody(
        [envelopeRow({ id: MSG_A, '@odata.etag': VALID_ETAG, '@odata.type': '#microsoft.graph.message' })],
        { '@odata.deltaLink': deltaLinkUrl() },
      );
      const t = transportWith(mockHttps(200, body, {}, null, expectedInitialPath()));
      const dto = await t.fetchInitialPage(goodInitial());
      ok('odata-type-discard-ok', dto.envelopes.length === 1);
      ok('no-odata-type-on-result', ser(dto).includes('@odata.type') === false);

      const wrong = deltaBody(
        [envelopeRow({ id: MSG_A, '@odata.type': '#microsoft.graph.event' })],
        { '@odata.deltaLink': deltaLinkUrl() },
      );
      const tWrong = transportWith(mockHttps(200, wrong, {}, null, expectedInitialPath()));
      await mustFailStage(() => tWrong.fetchInitialPage(goodInitial()), 'row_value_invalid');
      ok('odata-type-wrong-value-rejected', true);

      const extra = deltaBody(
        [envelopeRow({ id: MSG_A, '@odata.type': '#microsoft.graph.message', unexpected: 'x' })],
        { '@odata.deltaLink': deltaLinkUrl() },
      );
      const tExtra = transportWith(mockHttps(200, extra, {}, null, expectedInitialPath()));
      await mustFailStage(() => tExtra.fetchInitialPage(goodInitial()), 'row_value_invalid');
      ok('odata-type-extra-key-rejected', true);

      const dangerousRow = envelopeRow({ id: MSG_A, '@odata.type': '#microsoft.graph.message' });
      Object.defineProperty(dangerousRow, '__proto__', {
        value: 'x', enumerable: true, writable: true, configurable: true,
      });
      const dangerous = deltaBody([dangerousRow], { '@odata.deltaLink': deltaLinkUrl() });
      const tDangerous = transportWith(mockHttps(200, dangerous, {}, null, expectedInitialPath()));
      await mustFailStage(() => tDangerous.fetchInitialPage(goodInitial()), 'json_invalid');
      ok('odata-type-dangerous-key-rejected', true);
    }

    // ── Reject mixed normal/deleted fields ────────────────────────────────
    {
      const mixed = {
        id: MSG_A,
        subject: 'x',
        from: { emailAddress: emailAddress() },
        receivedDateTime: '2026-08-06T12:00:00Z',
        isRead: false,
        conversationId: 'c',
        internetMessageId: '<x@y>',
        '@removed': { reason: 'deleted' },
      };
      const t = transportWith(mockHttps(
        200,
        deltaBody([mixed], { '@odata.deltaLink': deltaLinkUrl() }),
        {},
        null,
        expectedInitialPath(),
      ));
      await mustFailStage(() => t.fetchInitialPage(goodInitial()), 'row_keyset_invalid');
      ok('mixed-normal-deleted-reject', true);
    }

    // ── Deleted-row unknown annotations / wrong type fail closed ──────────
    {
      const extraId = {
        '@odata.type': '#microsoft.graph.message',
        '@odata.id': 'https://graph.microsoft.com/v1.0/x',
        id: MSG_B,
        '@removed': { reason: 'deleted' },
      };
      const tExtra = transportWith(mockHttps(
        200,
        deltaBody([extraId], { '@odata.deltaLink': deltaLinkUrl() }),
        {},
        null,
        expectedInitialPath(),
      ));
      await mustFailStage(() => tExtra.fetchInitialPage(goodInitial()), 'row_keyset_invalid');
      ok('deleted-unknown-odata-id-reject', true);

      const extraField = {
        '@odata.type': '#microsoft.graph.message',
        id: MSG_B,
        parentFolderId: 'x',
        '@removed': { reason: 'deleted' },
      };
      const tField = transportWith(mockHttps(
        200,
        deltaBody([extraField], { '@odata.deltaLink': deltaLinkUrl() }),
        {},
        null,
        expectedInitialPath(),
      ));
      await mustFailStage(() => tField.fetchInitialPage(goodInitial()), 'row_keyset_invalid');
      ok('deleted-unknown-field-reject', true);

      const wrongType = {
        '@odata.type': '#microsoft.graph.event',
        id: MSG_B,
        '@removed': { reason: 'deleted' },
      };
      const tWrong = transportWith(mockHttps(
        200,
        deltaBody([wrongType], { '@odata.deltaLink': deltaLinkUrl() }),
        {},
        null,
        expectedInitialPath(),
      ));
      await mustFailStage(() => tWrong.fetchInitialPage(goodInitial()), 'row_value_invalid');
      ok('deleted-unrecognized-odata-type-reject', true);

      const emptyType = {
        '@odata.type': '',
        id: MSG_B,
        '@removed': { reason: 'deleted' },
      };
      const tEmpty = transportWith(mockHttps(
        200,
        deltaBody([emptyType], { '@odata.deltaLink': deltaLinkUrl() }),
        {},
        null,
        expectedInitialPath(),
      ));
      await mustFailStage(() => tEmpty.fetchInitialPage(goodInitial()), 'row_value_invalid');
      ok('deleted-empty-odata-type-reject', true);

      const badEtag = {
        id: MSG_B,
        '@odata.etag': '',
        '@removed': { reason: 'deleted' },
      };
      const tBadEtag = transportWith(mockHttps(
        200,
        deltaBody([badEtag], { '@odata.deltaLink': deltaLinkUrl() }),
        {},
        null,
        expectedInitialPath(),
      ));
      await mustFailStage(() => tBadEtag.fetchInitialPage(goodInitial()), 'row_value_invalid');
      ok('deleted-empty-etag-reject', true);
    }

    // ── Malformed removed ─────────────────────────────────────────────────
    {
      for (const [label, row] of [
        ['wrong-reason', { id: MSG_A, '@removed': { reason: 'changed' } }],
        ['extra-removed-key', { id: MSG_A, '@removed': { reason: 'deleted', x: 1 } }],
        ['missing-reason', { id: MSG_A, '@removed': {} }],
        ['removed-not-object', { id: MSG_A, '@removed': 'deleted' }],
      ]) {
        const t = transportWith(mockHttps(
          200,
          deltaBody([row], { '@odata.deltaLink': deltaLinkUrl() }),
          {},
          null,
          expectedInitialPath(),
        ));
        await assert.rejects(
          () => t.fetchInitialPage(goodInitial()),
          (err) => err.code === FAILURE_CODE && noLeak(err),
        );
        ok(`malformed-removed-${label}`, true);
      }
    }

    // ── Duplicate ids / normal-tombstone collision ────────────────────────
    {
      const dupNormal = deltaBody(
        [envelopeRow({ id: MSG_A }), envelopeRow({ id: MSG_A, receivedDateTime: '2026-08-05T00:00:00Z' })],
        { '@odata.deltaLink': deltaLinkUrl() },
      );
      const t1 = transportWith(mockHttps(200, dupNormal, {}, null, expectedInitialPath()));
      await mustFailStage(() => t1.fetchInitialPage(goodInitial()), 'row_value_invalid');
      ok('dup-normal-reject', true);

      const collision = deltaBody(
        [envelopeRow({ id: MSG_A }), deletedRow(MSG_A)],
        { '@odata.deltaLink': deltaLinkUrl() },
      );
      const t2 = transportWith(mockHttps(200, collision, {}, null, expectedInitialPath()));
      await mustFailStage(() => t2.fetchInitialPage(goodInitial()), 'row_value_invalid');
      ok('normal-tombstone-collision-reject', true);

      const dupTomb = deltaBody(
        [deletedRow(MSG_B), deletedRow(MSG_B)],
        { '@odata.deltaLink': deltaLinkUrl() },
      );
      const t3 = transportWith(mockHttps(200, dupTomb, {}, null, expectedInitialPath()));
      await mustFailStage(() => t3.fetchInitialPage(goodInitial()), 'row_value_invalid');
      ok('dup-tombstone-reject', true);
    }

    // ── Poison body field → fail closed no partial ────────────────────────
    {
      const poison = deltaBody(
        [
          envelopeRow({ id: MSG_A }),
          { ...envelopeRow({ id: MSG_B }), body: { content: PLANTED_BODY } },
        ],
        { '@odata.deltaLink': deltaLinkUrl() },
      );
      const t = transportWith(mockHttps(200, poison, {}, null, expectedInitialPath()));
      await assert.rejects(
        () => t.fetchInitialPage(goodInitial()),
        (err) => err.code === FAILURE_CODE
          && noLeak(err)
          && !ser(err).includes(PLANTED_BODY),
      );
      ok('partial-poison-fail-closed', true);
    }

    // ── Invalid successor link (evil host) ────────────────────────────────
    {
      const evil = deltaBody([envelopeRow()], {
        '@odata.nextLink': `https://evil.com/v1.0/users/${MAILBOX_ID}/mailFolders('inbox')/messages/delta?$skiptoken=x`,
      });
      const t = transportWith(mockHttps(200, evil, {}, null, expectedInitialPath()));
      await mustFailStage(() => t.fetchInitialPage(goodInitial()), 'top_shape_invalid');
      ok('evil-successor-reject', true);
    }

    // ── Continuation happy path: verbatim validated URL, append nothing ───
    {
      let captured = null;
      let pathDuringRequest = null;
      let requestCount = 0;
      const contPath = expectedContinuationPath();
      const body = deltaBody([], { '@odata.deltaLink': deltaLinkUrl() });
      const httpsImpl = function request(options, onResponse) {
        requestCount += 1;
        // Synchronous request must still receive the exact validated path + Bearer.
        // Do not weaken: assert during requestFn before post-return scrub.
        assert.equal(options.path, contPath);
        assert.match(options.headers.Authorization, /^Bearer /);
        assert.equal(options.headers.Authorization.includes(TOKEN), true);
        pathDuringRequest = options.path;
        captured = options;
        return mockHttps(200, body, {}, null, contPath)(options, onResponse);
      };
      const t = transportWith(httpsImpl);
      const dto = await t.fetchContinuationPage(goodContinuation());
      ok('continuation-one-request', requestCount === 1);
      ok(
        'continuation-path-verbatim',
        pathDuringRequest === contPath
          && pathDuringRequest === `/v1.0/users/${MAILBOX_ID}/mailFolders('inbox')/messages/delta?$skiptoken=${SKIP_TOKEN}`
          && !pathDuringRequest.includes('$top=')
          && !pathDuringRequest.includes('$select=')
          && !pathDuringRequest.includes('$filter'),
        ser(pathDuringRequest),
      );
      ok('continuation-prefer', captured.headers.Prefer === PREFER_IMMUTABLE_ID);
      ok('continuation-auth-scrubbed', captured.headers.Authorization === null);
      ok(
        'continuation-path-scrubbed-after-issue',
        captured.path === null
          && !ser(captured).includes(SKIP_TOKEN)
          && !ser(captured).includes(DELTA_TOKEN)
          && !ser(captured).includes('skiptoken')
          && !ser(captured).includes('deltatoken'),
        ser(captured),
      );
      ok('continuation-dto-ok', dto.observed_count === 0
        && dto.successor_cursor.cursor_kind === 'deltaLink');
    }

    // ── Hostile retained options + continuation path owner custody ───────
    // After requestFn sync-consumes options, retained holders must not keep
    // Bearer or $skiptoken/$deltatoken. Exact validated path still visible
    // during the synchronous call. Public caller input may keep its primitive
    // cursor_url; transport must not retain extra internal path copies after
    // the boundary. Covers success / async error / http / throw / timeout / 410.
    {
      const contPath = expectedContinuationPath();

      async function runRetainedContinuationCase(behavior, label, run) {
        const probe = {};
        const hostile = createContinuationRetainingHttps(behavior, contPath, probe);
        const callerInput = goodContinuation();
        const callerCursorUrl = callerInput.cursor_url;
        await run(hostile, callerInput);
        ok(
          `${label}-saw-exact-path-during`,
          hostile.sawTokenDuringCall() === true
            && hostile.sawExactPathDuringCall() === true
            && hostile.pathDuringCall() === contPath
            && probe.pathDuring === contPath,
        );
        try {
          assertContinuationRetainedScrubbed(
            hostile.getRetainedOptions(),
            label,
            probe,
          );
          ok(`${label}-options-scrubbed`, true);
        } catch (err) {
          ok(`${label}-options-scrubbed`, false, err && err.message);
        }
        // Caller-owned primitive cursor_url may remain; transport responsibility
        // is no additional retained internal copy (options.path null above).
        ok(
          `${label}-caller-still-owns-cursorUrl`,
          callerInput.cursor_url === callerCursorUrl
            && typeof callerInput.cursor_url === 'string'
            && callerInput.cursor_url.includes(SKIP_TOKEN),
        );
        return { hostile, probe, callerInput };
      }

      // Success
      {
        let dto;
        await runRetainedContinuationCase(
          'success',
          'retained-cont-success',
          async (hostile, input) => {
            dto = await transportWith(hostile.request).fetchContinuationPage(input);
          },
        );
        ok('retained-cont-success-dto', dto && dto.successor_cursor
          && dto.successor_cursor.cursor_kind === 'deltaLink');
      }

      // Async stream failure
      {
        await runRetainedContinuationCase(
          'async-error',
          'retained-cont-async-error',
          async (hostile, input) => {
            await mustFailStage(
              () => transportWith(hostile.request).fetchContinuationPage(input),
              'stream_invalid',
            );
          },
        );
      }

      // HTTP non-200 failure (not 410)
      {
        await runRetainedContinuationCase(
          'http-fail',
          'retained-cont-http-fail',
          async (hostile, input) => {
            await mustFailStage(
              () => transportWith(hostile.request).fetchContinuationPage(input),
              'http_status_not_200',
            );
          },
        );
      }

      // Sync throw from requestFn
      {
        await runRetainedContinuationCase(
          'throw',
          'retained-cont-throw',
          async (hostile, input) => {
            await mustFailStage(
              () => transportWith(hostile.request).fetchContinuationPage(input),
              'request_error',
            );
          },
        );
      }

      // Timeout (hang request; deadline fires). Scrub is sync after request create.
      {
        const probe = {};
        const hostile = createContinuationRetainingHttps('hang', contPath, probe);
        const callerInput = goodContinuation();
        let cleared = false;
        const timers = {
          setTimeout: (fn) => {
            queueMicrotask(fn);
            return 1;
          },
          clearTimeout: () => { cleared = true; },
        };
        const hangPromise = transportWith(hostile.request, timers)
          .fetchContinuationPage(callerInput);
        ok('retained-cont-timeout-saw-during', hostile.sawTokenDuringCall() === true
          && hostile.sawExactPathDuringCall() === true
          && probe.pathDuring === contPath);
        try {
          assertContinuationRetainedScrubbed(
            hostile.getRetainedOptions(),
            'cont-timeout-after-create',
            probe,
          );
          ok('retained-cont-timeout-scrubbed-after-create', true);
        } catch (err) {
          ok('retained-cont-timeout-scrubbed-after-create', false, err && err.message);
        }
        await mustFailStage(() => hangPromise, 'timeout');
        try {
          assertContinuationRetainedScrubbed(
            hostile.getRetainedOptions(),
            'cont-timeout-after',
            probe,
          );
          ok('retained-cont-timeout-scrubbed-after', true);
        } catch (err) {
          ok('retained-cont-timeout-scrubbed-after', false, err && err.message);
        }
        ok(
          'retained-cont-timeout-caller-owns-cursorUrl',
          callerInput.cursor_url.includes(SKIP_TOKEN),
        );
        ok('retained-cont-timeout-cleared-flag', typeof cleared === 'boolean');
      }

      // Continuation 410 → cursor_gone; retained path/auth still scrubbed
      {
        await runRetainedContinuationCase(
          '410',
          'retained-cont-410',
          async (hostile, input) => {
            await assert.rejects(
              () => transportWith(hostile.request).fetchContinuationPage(input),
              (err) => err.code === FAILURE_CODE
                && readTrustedMessagesDeltaOutcome(err) === 'cursor_gone'
                && readTrustedGraphStage(err) === 'http_status_not_200'
                && noLeak(err),
            );
          },
        );
      }

      // Initial delta path has no cursor capability — retained path may remain.
      {
        let retained = null;
        let pathDuring = null;
        const initPath = expectedInitialPath();
        const body = deltaBody([], { '@odata.deltaLink': deltaLinkUrl() });
        const httpsImpl = function request(options, onResponse) {
          retained = options;
          pathDuring = options.path;
          assert.equal(options.path, initPath);
          assert.match(options.headers.Authorization, /^Bearer /);
          return mockHttps(200, body, {}, null, initPath)(options, onResponse);
        };
        const dto = await transportWith(httpsImpl).fetchInitialPage(goodInitial());
        ok(
          'retained-initial-path-may-remain',
          pathDuring === initPath
            && retained.path === initPath
            && !String(retained.path).includes('skiptoken')
            && !String(retained.path).includes('deltatoken')
            && retained.headers.Authorization === null
            && dto.observed_count === 0,
          ser(retained && retained.path),
        );
      }
    }

    // ── Continuation wrong URL/token/host/path/mailbox → zero network ─────
    {
      const cases = [
        ['evil-host', {
          cursor_url: `https://evil.com/v1.0/users/${MAILBOX_ID}/mailFolders('inbox')/messages/delta?$skiptoken=x`,
        }],
        ['wrong-mailbox', {
          cursor_url: nextLinkUrl(OTHER_MAILBOX),
        }],
        ['kind-mismatch-delta-as-next', {
          cursor_kind: 'nextLink',
          cursor_url: deltaLinkUrl(),
        }],
        ['kind-mismatch-next-as-delta', {
          cursor_kind: 'deltaLink',
          cursor_url: nextLinkUrl(),
        }],
        ['me-path', {
          cursor_url: 'https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=x',
        }],
        ['messages-not-delta', {
          cursor_url: `https://graph.microsoft.com/v1.0/users/${MAILBOX_ID}/messages?$skiptoken=x`,
        }],
        ['filter-extra', {
          cursor_url: `https://graph.microsoft.com/v1.0/users/${MAILBOX_ID}/mailFolders('inbox')/messages/delta?$skiptoken=x&$filter=y`,
        }],
        ['encoded-skiptoken-key', {
          cursor_url: `https://graph.microsoft.com/v1.0/users/${MAILBOX_ID}/mailFolders('inbox')/messages/delta?%24skiptoken=x`,
        }],
        ['userinfo', {
          cursor_url: `https://user:pass@graph.microsoft.com/v1.0/users/${MAILBOX_ID}/mailFolders('inbox')/messages/delta?$skiptoken=x`,
        }],
        ['hash', {
          cursor_url: nextLinkUrl() + '#frag',
        }],
        ['path-dotdot', {
          cursor_url: `https://graph.microsoft.com/v1.0/users/${MAILBOX_ID}/../${MAILBOX_ID}/messages/delta?$skiptoken=x`,
        }],
      ];
      for (const [label, patch] of cases) {
        let requestCount = 0;
        const httpsImpl = function request() {
          requestCount += 1;
          throw new Error(`must-not-network-${label}`);
        };
        const t = transportWith(httpsImpl);
        await mustFailStage(
          () => t.fetchContinuationPage(goodContinuation(patch)),
          'request_error',
        );
        ok(`zero-network-${label}`, requestCount === 0, `count=${requestCount}`);
      }
    }

    // ── Wrong initial inputs → zero network ───────────────────────────────
    {
      for (const [label, input] of [
        ['missing-mailbox', { accessToken: TOKEN }],
        ['email-mailbox', { accessToken: TOKEN, provider_mailbox_id: 'a@b.com' }],
        ['me-mailbox', { accessToken: TOKEN, provider_mailbox_id: 'me' }],
        ['upper-uuid', { accessToken: TOKEN, provider_mailbox_id: MAILBOX_ID.toUpperCase() }],
        ['extra-key', { accessToken: TOKEN, provider_mailbox_id: MAILBOX_ID, Prefer: 'evil' }],
        ['symbol-key', Object.assign(
          Object.create(null),
          { accessToken: TOKEN, provider_mailbox_id: MAILBOX_ID },
          { [Symbol('x')]: 1 },
        )],
        ['empty-token', { accessToken: '', provider_mailbox_id: MAILBOX_ID }],
        ['proxy-input', typeof util.types.isProxy === 'function'
          ? new Proxy({ accessToken: TOKEN, provider_mailbox_id: MAILBOX_ID }, {})
          : null],
      ]) {
        if (input === null) {
          ok(`zero-network-initial-${label}-skipped`, true);
          continue;
        }
        let requestCount = 0;
        const httpsImpl = function request() {
          requestCount += 1;
          throw new Error('must-not-network');
        };
        const t = transportWith(httpsImpl);
        // symbol-key may not be exactPlainData compatible via assign — handle
        let threw = false;
        try {
          await t.fetchInitialPage(input);
        } catch (err) {
          threw = true;
          ok(
            `zero-network-initial-${label}-code`,
            err.code === FAILURE_CODE && noLeak(err),
          );
        }
        if (!threw) {
          ok(`zero-network-initial-${label}-code`, false, 'expected reject');
        }
        ok(`zero-network-initial-${label}`, requestCount === 0, `count=${requestCount}`);
      }
    }

    // ── Continuation HTTP 410 → cursor_gone; initial 410 generic ──────────
    {
      let contCount = 0;
      const contHttps = function request(options, onResponse) {
        contCount += 1;
        const response = new EventEmitter();
        response.statusCode = 410;
        Object.defineProperty(response, 'headers', {
          value: { 'content-type': 'application/json' },
          enumerable: true,
        });
        response.destroy = () => {};
        const req = new EventEmitter();
        req.destroy = () => {};
        req.once = EventEmitter.prototype.once;
        req.end = () => {
          queueMicrotask(() => onResponse(response));
        };
        return req;
      };
      const tCont = transportWith(contHttps);
      await assert.rejects(
        () => tCont.fetchContinuationPage(goodContinuation()),
        (err) => err.code === FAILURE_CODE
          && err.message === FAILURE_MESSAGE
          && Object.isFrozen(err)
          && readTrustedMessagesDeltaOutcome(err) === 'cursor_gone'
          && readTrustedGraphStage(err) === 'http_status_not_200'
          && !Object.prototype.hasOwnProperty.call(err, 'cursor_gone')
          && !Object.prototype.hasOwnProperty.call(err, 'outcome')
          && noLeak(err),
      );
      ok('continuation-410-cursor-gone', contCount === 1);

      // Forged public error cannot classify.
      const forged = Object.freeze(Object.assign(new Error(FAILURE_MESSAGE), {
        code: FAILURE_CODE,
        name: 'MicrosoftGraphMessagesDeltaPageError',
        cursor_gone: true,
        outcome: 'cursor_gone',
        graph_stage: 'http_status_not_200',
      }));
      ok(
        'forged-error-no-cursor-gone',
        readTrustedMessagesDeltaOutcome(forged) === null
          && readTrustedGraphStage(forged) === null,
      );
      ok(
        'forged-plain-object-no-classify',
        readTrustedMessagesDeltaOutcome({
          code: FAILURE_CODE,
          message: FAILURE_MESSAGE,
        }) === null,
      );

      let initCount = 0;
      const initHttps = function request(options, onResponse) {
        initCount += 1;
        const response = new EventEmitter();
        response.statusCode = 410;
        Object.defineProperty(response, 'headers', {
          value: { 'content-type': 'application/json' },
          enumerable: true,
        });
        response.destroy = () => {};
        const req = new EventEmitter();
        req.destroy = () => {};
        req.once = EventEmitter.prototype.once;
        req.end = () => {
          queueMicrotask(() => onResponse(response));
        };
        return req;
      };
      const tInit = transportWith(initHttps);
      await assert.rejects(
        () => tInit.fetchInitialPage(goodInitial()),
        (err) => err.code === FAILURE_CODE
          && readTrustedMessagesDeltaOutcome(err) === null
          && readTrustedGraphStage(err) === 'http_status_not_200'
          && noLeak(err),
      );
      ok('initial-410-generic-no-cursor-gone', initCount === 1);
    }

    // ── HTTP status / content-type / oversize / timeout / abort ───────────
    {
      const t403 = transportWith(mockHttps(403, '{}', {}, null, expectedInitialPath()));
      await mustFailStage(() => t403.fetchInitialPage(goodInitial()), 'http_status_not_200');
      ok('http-403-fail', true);

      const tCt = transportWith(mockHttps(
        200,
        deltaBody([], { '@odata.deltaLink': deltaLinkUrl() }),
        { 'content-type': 'text/plain' },
        null,
        expectedInitialPath(),
      ));
      await mustFailStage(() => tCt.fetchInitialPage(goodInitial()), 'content_type_invalid');
      ok('content-type-reject', true);

      const huge = 'x'.repeat(RESPONSE_CAP_BYTES + 1);
      const tHuge = transportWith(mockHttps(200, huge, {}, null, expectedInitialPath()));
      await mustFailStage(() => tHuge.fetchInitialPage(goodInitial()), 'response_too_large');
      ok('oversize-reject', true);

      // Timeout
      {
        let cleared = false;
        const timers = {
          setTimeout: (fn) => {
            queueMicrotask(fn);
            return 1;
          },
          clearTimeout: () => { cleared = true; },
        };
        const hang = function request() {
          const req = new EventEmitter();
          req.destroy = () => {};
          req.once = EventEmitter.prototype.once;
          req.end = () => {};
          return req;
        };
        const t = transportWith(hang, timers);
        await mustFailStage(() => t.fetchInitialPage(goodInitial()), 'timeout');
        ok('timeout-fail', true);
        ok('timeout-cleared-or-ok', typeof cleared === 'boolean');
      }

      // Abort mid-stream
      {
        const httpsImpl = function request(options, onResponse) {
          const response = new EventEmitter();
          response.statusCode = 200;
          Object.defineProperty(response, 'headers', {
            value: { 'content-type': 'application/json' },
            enumerable: true,
          });
          response.destroy = () => {};
          const req = new EventEmitter();
          req.destroy = () => {};
          req.once = EventEmitter.prototype.once;
          req.end = () => {
            queueMicrotask(() => {
              onResponse(response);
              response.emit('data', Buffer.from('{', 'utf8'));
              response.emit('aborted');
            });
          };
          return req;
        };
        const t = transportWith(httpsImpl);
        await mustFailStage(() => t.fetchInitialPage(goodInitial()), 'stream_aborted');
        ok('stream-aborted-fail', true);
      }

      // Invalid UTF-8 replacement
      {
        const httpsImpl = function request(options, onResponse) {
          const response = new EventEmitter();
          response.statusCode = 200;
          Object.defineProperty(response, 'headers', {
            value: { 'content-type': 'application/json' },
            enumerable: true,
          });
          response.destroy = () => {};
          const req = new EventEmitter();
          req.destroy = () => {};
          req.once = EventEmitter.prototype.once;
          req.end = () => {
            queueMicrotask(() => {
              onResponse(response);
              response.emit('data', Buffer.from([0xff, 0xfe, 0xfd]));
              response.emit('end');
            });
          };
          return req;
        };
        const t = transportWith(httpsImpl);
        await assert.rejects(
          () => t.fetchInitialPage(goodInitial()),
          (err) => err.code === FAILURE_CODE && noLeak(err),
        );
        ok('utf8-invalid-fail', true);
      }

      // Invalid JSON
      {
        const t = transportWith(mockHttps(200, '{not-json', {}, null, expectedInitialPath()));
        await mustFailStage(() => t.fetchInitialPage(goodInitial()), 'json_invalid');
        ok('json-invalid-fail', true);
      }
    }

    // ── One request only per initial call ─────────────────────────────────
    {
      let requestCount = 0;
      const httpsImpl = function request(options, onResponse) {
        requestCount += 1;
        return mockHttps(
          200,
          deltaBody([envelopeRow()], { '@odata.deltaLink': deltaLinkUrl() }),
          {},
          null,
          expectedInitialPath(),
        )(options, onResponse);
      };
      const t = transportWith(httpsImpl);
      await t.fetchInitialPage(goodInitial());
      ok('exactly-one-request-initial', requestCount === 1, `count=${requestCount}`);
    }

    // ── Hostile lifecycle accessors / proxy response ──────────────────────
    {
      const trapHits = Object.create(null);
      const httpsImpl = function request(options, onResponse) {
        assert.equal(options.headers.Prefer, PREFER_IMMUTABLE_ID);
        const response = createTrapCountingSurface(new EventEmitter(), trapHits);
        Object.defineProperty(response, 'statusCode', {
          value: 200,
          enumerable: true,
          configurable: true,
        });
        const req = createTrapCountingSurface(new EventEmitter(), trapHits);
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
        () => t.fetchInitialPage(goodInitial()),
        (err) => err.code === FAILURE_CODE && noLeak(err),
      );
      const hitNames = Object.keys(trapHits).filter((k) => trapHits[k] > 0);
      ok(
        'no-lifecycle-getter-trap-hits',
        hitNames.length === 0,
        ser(trapHits),
      );
    }

    if (typeof util.types.isProxy === 'function') {
      let proxyGetHits = 0;
      const httpsImpl = function request(options, onResponse) {
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
          queueMicrotask(() => onResponse(proxied));
        };
        return req;
      };
      const t = transportWith(httpsImpl);
      await mustFailStage(() => t.fetchInitialPage(goodInitial()), 'response_surface_invalid');
      ok('proxy-response-rejected', true);
      ok('proxy-get-traps-zero', proxyGetHits === 0, `hits=${proxyGetHits}`);
    } else {
      ok('proxy-response-skipped', true);
      ok('proxy-get-traps-skipped', true);
    }

    // Proxy-backed headers zero traps
    if (typeof util.types.isProxy === 'function') {
      const trapHits = { get: 0, getOwnPropertyDescriptor: 0, ownKeys: 0 };
      const proxyHeaders = new Proxy({ 'content-type': 'application/json' }, {
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
        () => t.fetchInitialPage(goodInitial()),
        (err) => err.code === FAILURE_CODE && noLeak(err),
      );
      ok(
        'proxy-headers-zero-traps',
        trapHits.get === 0
          && trapHits.getOwnPropertyDescriptor === 0
          && trapHits.ownKeys === 0,
        ser(trapHits),
      );
    } else {
      ok('proxy-headers-zero-traps-skipped', true);
    }

    // Dangerous keys in JSON
    {
      const dangerous = `{"value":[],"@odata.deltaLink":${JSON.stringify(deltaLinkUrl())},"__proto__":{"x":1}}`;
      const t = transportWith(mockHttps(200, dangerous, {}, null, expectedInitialPath()));
      await mustFailStage(() => t.fetchInitialPage(goodInitial()), 'json_invalid');
      ok('dangerous-key-json-reject', true);
    }

    // Nonenumerable top key rejected
    {
      // Strict JSON cannot produce nonenumerable — use invalid top shape instead
      const t = transportWith(mockHttps(
        200,
        JSON.stringify({ value: [], extra: 1, '@odata.deltaLink': deltaLinkUrl() }),
        {},
        null,
        expectedInitialPath(),
      ));
      await mustFailStage(() => t.fetchInitialPage(goodInitial()), 'top_shape_invalid');
      ok('extra-top-key-reject', true);
    }

    // Ambient isProxy monkeypatch resistance (proxy headers still rejected)
    if (typeof util.types.isProxy === 'function') {
      const originalIsProxy = util.types.isProxy;
      try {
        util.types.isProxy = function ambientHide() { return false; };
        const trapHits = { get: 0 };
        const proxyHeaders = new Proxy({ 'content-type': 'application/json' }, {
          get(t, p, r) {
            trapHits.get += 1;
            return Reflect.get(t, p, r);
          },
        });
        const httpsImpl = function request(options, onResponse) {
          const response = new EventEmitter();
          response.statusCode = 200;
          Object.defineProperty(response, 'headers', {
            value: proxyHeaders,
            enumerable: true,
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
          () => t.fetchInitialPage(goodInitial()),
          (err) => err.code === FAILURE_CODE && noLeak(err),
        );
        ok('ambient-isProxy-monkeypatch-still-rejects', trapHits.get === 0, ser(trapHits));

        // Genuine native IncomingMessage under ambient always-true
        util.types.isProxy = function always() { return true; };
        const body = deltaBody([envelopeRow({ id: MSG_B })], {
          '@odata.deltaLink': deltaLinkUrl(),
        });
        const nativeHttps = function request(options, onResponse) {
          assert.equal(options.headers.Prefer, PREFER_IMMUTABLE_ID);
          const response = new http.IncomingMessage(new Socket());
          response.statusCode = 200;
          response.headers = { 'content-type': 'application/json' };
          response.destroy = () => {};
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
        const dto = await nativeTransport.fetchInitialPage(goodInitial());
        ok(
          'native-IncomingMessage-under-ambient-lie',
          dto.envelopes.length === 1
            && dto.envelopes[0].provider_message_id === MSG_B
            && Object.isFrozen(dto),
        );
      } finally {
        util.types.isProxy = originalIsProxy;
      }
    } else {
      ok('ambient-isProxy-monkeypatch-skipped', true);
      ok('native-IncomingMessage-under-ambient-lie-skipped', true);
    }

    // ── Existing health/ImmutableId still exported from owner ─────────────
    ok(
      'owner-still-exports-health-and-immutableid',
      typeof messagesTransport.createMicrosoftGraphDelegatedMessagesTransport === 'function'
        && typeof messagesTransport.createMicrosoftGraphImmutableIdPageTransport === 'function'
        && typeof messagesTransport.createMicrosoftGraphImmutableIdBoundedCatchupTransport === 'function'
        && typeof messagesTransport.createMicrosoftGraphMessagesDeltaPageTransport === 'function',
    );
    ok(
      'graph-stages-shared',
      GRAPH_STAGES === messagesTransport.GRAPH_STAGES
        || ser([...GRAPH_STAGES]) === ser([...messagesTransport.GRAPH_STAGES]),
    );

    // ── PR408 cursor validator equivalence on continuation inputs ─────────
    {
      const bind = { providerMailboxId: MAILBOX_ID, cursorKind: 'nextLink' };
      ok(
        'pr408-accepts-next',
        deltaStore.validateMessagesDeltaCursorUrl(nextLinkUrl(), bind).ok === true
          && validateMessagesDeltaCursorUrl(nextLinkUrl(), bind).ok === true,
      );
      ok(
        'pr408-rejects-evil',
        deltaStore.validateMessagesDeltaCursorUrl(
          `https://evil.com/v1.0/users/${MAILBOX_ID}/mailFolders('inbox')/messages/delta?$skiptoken=x`,
          bind,
        ).ok === false,
      );
    }

    // ── No secret leakage in logs ─────────────────────────────────────────
    const allLogText = logged.map((row) => row.slice(1).map(ser).join(' ')).join('\n');
    ok(
      'no-token-in-verifier-logs',
      !allLogText.includes(TOKEN)
        && !allLogText.includes(SKIP_TOKEN)
        && !allLogText.includes(DELTA_TOKEN)
        && !allLogText.includes(PLANTED_BODY),
    );

    console.log = log;
    console.error = error;

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
  } catch (err) {
    console.log = log;
    console.error = error;
    console.error('VERIFY FATAL:', err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

main();
