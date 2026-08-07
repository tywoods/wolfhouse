'use strict';

/**
 * Hostile-path gate for Microsoft Graph ImmutableId bounded-catchup transport.
 *
 * UNWIRED multi-page primitive: factory-fixed maxPages=10 / maxMessages=50;
 * Prefer ImmutableId on every request; strict nextLink validation before follow;
 * canonical sort + identity dedupe; atomic failure (no partial envelopes);
 * no consumer / persistence / route / live network.
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('node:events');
const util = require('util');

const ROOT = path.join(__dirname, '..');
const TRANSPORT_REL = 'scripts/lib/email-microsoft-graph-immutableid-bounded-catchup-transport.js';
const MESSAGES_REL = 'scripts/lib/email-microsoft-graph-delegated-messages-transport.js';
const PAGE_REL = 'scripts/lib/email-microsoft-graph-normalized-page.js';
const SINGLE_REL = 'scripts/lib/email-microsoft-graph-immutableid-page-transport.js';
const BATCH_REL = 'scripts/lib/email-inbound-batch-processor.js';
const CONTRACT_REL = 'scripts/lib/email-inbound-envelope-contract.js';
const DOC_REL = 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md';
const VERIFY_REL = 'scripts/verify-email-microsoft-graph-immutableid-bounded-catchup-transport.js';
const PKG_PATH = path.join(ROOT, 'package.json');

const PLANTED = 'NEVER_LEAK_subject_addr_token';
const TOKEN = 'atok-NEVER_LEAK-abcdefghijklmnopqrstuvwxyz012345';
const PLANTED_BODY = 'BODY_MUST_NEVER_APPEAR_BOUNDED_CATCHUP';
const MAILBOX_ID = '22222222-2222-4222-8222-2222222222ab';
const OTHER_MAILBOX = '33333333-3333-4333-8333-3333333333cd';

const {
  FAILURE_CODE,
  FAILURE_MESSAGE,
  PREFER_IMMUTABLE_ID,
  PATH,
  TOP_MAX,
  SELECT_FIELDS,
  RESPONSE_CAP_BYTES,
  GRAPH_STAGES,
  BOUNDED_CATCHUP_MAX_PAGES,
  BOUNDED_CATCHUP_MAX_MESSAGES,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_RUNTIME_WIRED,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_PERSISTENCE_READY,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_LOGGING_FORBIDDEN,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_PINS_PREFER_IMMUTABLE_ID,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_USES_USERS_PATH,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_INVOKES_CONSUMER,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_MAX_PAGES,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_MAX_MESSAGES,
  EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_PAGE_SIZE,
  buildImmutableIdUserMessagesPath,
  readTrustedGraphStage,
  createMicrosoftGraphImmutableIdBoundedCatchupTransport,
} = require('./lib/email-microsoft-graph-immutableid-bounded-catchup-transport');

const messagesTransport = require('./lib/email-microsoft-graph-delegated-messages-transport');
const singlePageTransport = require('./lib/email-microsoft-graph-immutableid-page-transport');
const {
  EMAIL_INBOUND_ENVELOPE_KEYS,
  validateInboundEmailEnvelope,
  compareInboundEmailEnvelopesForOrder,
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
    && !text.includes('@odata.etag')
    && !text.includes('$skiptoken');
}

function emailAddress(patch = {}) {
  return { address: 'guest@example.com', name: 'Guest', ...patch };
}

function envelopeRow(id, receivedDateTime, patch = {}) {
  return {
    id,
    subject: `Subj-${id}`,
    from: { emailAddress: emailAddress() },
    receivedDateTime,
    isRead: false,
    conversationId: 'AAQkAGConv=',
    internetMessageId: `<${id}@example.com>`,
    ...patch,
  };
}

function listBody(rows, extras = {}) {
  return JSON.stringify({
    '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users(...)/messages',
    value: rows,
    ...extras,
  });
}

const SELECT_JOINED = SELECT_FIELDS.join(',');

function goodNextLink(token, mailbox = MAILBOX_ID, queryPatch = null) {
  const base = queryPatch || {
    $top: '5',
    $select: SELECT_JOINED,
    $skiptoken: token,
  };
  // Keys must remain exact OData literals ($top/$select/$skiptoken) — never
  // percent-encode `$` in keys (transport rejects encoded-key confusion).
  // Values are percent-encoded.
  const qs = Object.entries(base)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `https://graph.microsoft.com/v1.0/users/${mailbox}/messages?${qs}`;
}

/**
 * Build a nextLink with an explicit query-string order / raw encoding for
 * canonical-loop and keyset adversarial cases.
 */
function nextLinkWithRawQuery(rawQuery, mailbox = MAILBOX_ID) {
  return `https://graph.microsoft.com/v1.0/users/${mailbox}/messages?${rawQuery}`;
}

function assertNoTokenSurface(value, label) {
  const text = typeof value === 'string' ? value : ser(value);
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

function goodInput(patch = {}) {
  return {
    accessToken: TOKEN,
    provider_mailbox_id: MAILBOX_ID,
    ...patch,
  };
}

function expectedFirstPath() {
  const p = buildImmutableIdUserMessagesPath(MAILBOX_ID);
  assert.equal(typeof p, 'string');
  assert.match(p, /^\/v1\.0\/users\/[0-9a-f-]{36}\/messages\?/);
  assert.equal(p.includes('/me/'), false);
  return p;
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

/**
 * Multi-page mock HTTPS. `pages` is an array of { status?, body, capture? }.
 * Or a function(callIndex, options) => { status, body }.
 */
function multiPageHttps(pagesOrFn, captureAll) {
  let call = 0;
  return function request(options, onResponse) {
    const idx = call;
    call += 1;
    if (captureAll) captureAll(options, idx);
    let status = 200;
    let body = '{"value":[]}';
    if (typeof pagesOrFn === 'function') {
      const cfg = pagesOrFn(idx, options);
      status = cfg.status || 200;
      body = cfg.body;
    } else {
      const cfg = pagesOrFn[idx] || pagesOrFn[pagesOrFn.length - 1];
      status = (cfg && cfg.status) || 200;
      body = cfg && cfg.body != null ? cfg.body : '{"value":[]}';
      if (cfg && typeof cfg.capture === 'function') cfg.capture(options);
    }
    const response = new EventEmitter();
    response.statusCode = status;
    Object.defineProperty(response, 'headers', {
      value: { 'content-type': 'application/json' },
      enumerable: true,
      configurable: true,
    });
    response.destroy = () => {};
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      queueMicrotask(() => {
        onResponse(response);
        response.emit('data', Buffer.from(body, 'utf8'));
        response.emit('end');
      });
    };
    return req;
  };
}

function transportWith(httpsImpl, timers) {
  return createMicrosoftGraphImmutableIdBoundedCatchupTransport({
    httpsImpl,
    timers: timers || { setTimeout, clearTimeout },
  });
}

function assertDtoShape(dto) {
  assert.ok(Object.isFrozen(dto));
  const keys = Object.keys(dto);
  assert.deepEqual(keys, [
    'envelopes',
    'pages_fetched',
    'observed_count',
    'unique_count',
    'duplicate_count',
    'truncated',
  ]);
  assert.ok(Object.isFrozen(dto.envelopes));
  assert.equal(Array.isArray(dto.envelopes), true);
  assert.equal(dto.observed_count, dto.unique_count + dto.duplicate_count);
  for (const env of dto.envelopes) {
    assert.ok(Object.isFrozen(env));
    const v = validateInboundEmailEnvelope(env);
    assert.equal(v.ok, true, ser(v));
    assert.equal(env.provider, 'microsoft_graph');
    assert.equal(env.provider_mailbox_id, MAILBOX_ID);
  }
  // Canonical order: non-increasing received_at with identity tie-break.
  for (let i = 1; i < dto.envelopes.length; i += 1) {
    assert.ok(
      compareInboundEmailEnvelopesForOrder(dto.envelopes[i - 1], dto.envelopes[i]) <= 0,
    );
  }
  assert.equal(noLeak(dto), true);
  assert.equal(JSON.stringify(dto).includes('@odata'), false);
  assert.equal(JSON.stringify(dto).includes('nextLink'), false);
  assert.equal(JSON.stringify(dto).includes(TOKEN), false);
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
    ok('single-page-exists', fs.existsSync(path.join(ROOT, SINGLE_REL)));
    ok('page-bridge-exists', fs.existsSync(path.join(ROOT, PAGE_REL)));
    ok('batch-exists', fs.existsSync(path.join(ROOT, BATCH_REL)));
    ok('contract-exists', fs.existsSync(path.join(ROOT, CONTRACT_REL)));
    ok('doc-exists', fs.existsSync(path.join(ROOT, DOC_REL)));

    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    const scripts = pkg.scripts || {};
    ok(
      'package-gate-registered',
      scripts['verify:email-microsoft-graph-immutableid-bounded-catchup-transport']
        === `node ${VERIFY_REL.replace(/\\/g, '/')}`,
    );
    ok(
      'package-gate-no-deploy',
      !/deploy|azure|az |graph\.microsoft|oauth/i.test(
        String(scripts['verify:email-microsoft-graph-immutableid-bounded-catchup-transport'] || ''),
      ),
    );

    const doc = fs.readFileSync(path.join(ROOT, DOC_REL), 'utf8');
    ok(
      'doc-mentions-bounded-catchup',
      /bounded-catchup|bounded catchup|ImmutableId bounded/i.test(doc),
    );
    ok(
      'doc-unwired-no-consumer',
      /UNWIRED|no consumer|no persistence|maxPages\s*=\s*10|maxMessages\s*=\s*50/i.test(doc),
    );

    // ── Flags / constants ─────────────────────────────────────────────────
    ok('prefer-exact', PREFER_IMMUTABLE_ID === 'IdType="ImmutableId"');
    ok('pins-prefer-flag', EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_PINS_PREFER_IMMUTABLE_ID === true);
    ok('not-runtime-wired', EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_RUNTIME_WIRED === false);
    ok('not-persistence-ready', EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_PERSISTENCE_READY === false);
    ok('logging-forbidden', EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_LOGGING_FORBIDDEN === true);
    ok('uses-users-path', EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_USES_USERS_PATH === true);
    ok('no-consumer', EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_INVOKES_CONSUMER === false);
    ok(
      'factory-fixed-caps',
      BOUNDED_CATCHUP_MAX_PAGES === 10
        && BOUNDED_CATCHUP_MAX_MESSAGES === 50
        && EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_MAX_PAGES === 10
        && EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_MAX_MESSAGES === 50
        && EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_PAGE_SIZE === 5
        && TOP_MAX === 5,
    );
    ok(
      'caps-match-network-owner',
      messagesTransport.BOUNDED_CATCHUP_MAX_PAGES === 10
        && messagesTransport.BOUNDED_CATCHUP_MAX_MESSAGES === 50,
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
      'users-path-builder',
      buildImmutableIdUserMessagesPath(MAILBOX_ID)
        === `/v1.0/users/${MAILBOX_ID}/messages?$top=5&$select=${SELECT_JOINED}`,
    );
    ok('failure-code-reuses-immutableid', FAILURE_CODE === 'microsoft_graph_immutableid_page_failed');
    ok('failure-message-sanitized', !FAILURE_MESSAGE.includes('token') && !FAILURE_MESSAGE.includes('Bearer'));
    ok(
      'graph-stages-shared',
      GRAPH_STAGES === messagesTransport.GRAPH_STAGES
        || ser([...GRAPH_STAGES]) === ser([...messagesTransport.GRAPH_STAGES]),
    );

    // ── Export surface ────────────────────────────────────────────────────
    const transportModule = require('./lib/email-microsoft-graph-immutableid-bounded-catchup-transport');
    const exportKeys = Object.keys(transportModule).sort();
    ok(
      'no-mint-brand-capability-export',
      !exportKeys.some((k) => /mint|brand|capability|provenance|WeakMap|AUTHENTICATED/i.test(k)),
      exportKeys.join(','),
    );
    ok(
      'exports-catchup-factory',
      typeof transportModule.createMicrosoftGraphImmutableIdBoundedCatchupTransport === 'function',
    );
    ok(
      'exports-no-list-without-factory',
      transportModule.listBoundedCatchupInboundEnvelopes === undefined,
    );
    ok(
      'does-not-export-single-page-list',
      transportModule.listNormalizedInboundEnvelopes === undefined
        && transportModule.createMicrosoftGraphImmutableIdPageTransport === undefined,
    );

    // ── Existing single-page / count factories still present on owner ─────
    ok(
      'owner-still-exports-single-page-and-count',
      typeof messagesTransport.createMicrosoftGraphImmutableIdPageTransport === 'function'
        && typeof messagesTransport.createMicrosoftGraphDelegatedMessagesTransport === 'function'
        && typeof singlePageTransport.createMicrosoftGraphImmutableIdPageTransport === 'function',
    );

    // ── Empty inbox ───────────────────────────────────────────────────────
    {
      const snapshots = [];
      const t = transportWith(multiPageHttps([
        { body: listBody([]) },
      ], (opts) => {
        // Snapshot wire values before transport scrubs Authorization.
        snapshots.push({
          hostname: opts.hostname,
          method: opts.method,
          path: opts.path,
          prefer: opts.headers && opts.headers.Prefer,
          accept: opts.headers && opts.headers.Accept,
          auth: opts.headers && opts.headers.Authorization,
        });
      }));
      const dto = await t.listBoundedCatchupInboundEnvelopes(goodInput());
      assertDtoShape(dto);
      ok('empty-page-success', dto.pages_fetched === 1
        && dto.unique_count === 0
        && dto.observed_count === 0
        && dto.duplicate_count === 0
        && dto.truncated === false
        && dto.envelopes.length === 0);
      ok(
        'first-request-exact-path-and-prefer',
        snapshots[0]
          && snapshots[0].hostname === 'graph.microsoft.com'
          && snapshots[0].method === 'GET'
          && snapshots[0].path === expectedFirstPath()
          && snapshots[0].prefer === PREFER_IMMUTABLE_ID
          && snapshots[0].accept === 'application/json'
          && typeof snapshots[0].auth === 'string'
          && snapshots[0].auth.startsWith('Bearer ')
          && snapshots[0].auth.includes(TOKEN),
        ser(snapshots[0] && { ...snapshots[0], auth: snapshots[0].auth && 'present' }),
      );
    }

    // ── >5 two-page burst ─────────────────────────────────────────────────
    {
      const snapshots = [];
      const page1 = [
        envelopeRow('AAMk-A', '2026-08-06T12:00:00Z'),
        envelopeRow('AAMk-B', '2026-08-06T11:00:00Z'),
        envelopeRow('AAMk-C', '2026-08-06T10:00:00Z'),
        envelopeRow('AAMk-D', '2026-08-06T09:00:00Z'),
        envelopeRow('AAMk-E', '2026-08-06T08:00:00Z'),
      ];
      const page2 = [
        envelopeRow('AAMk-F', '2026-08-06T07:00:00Z'),
        envelopeRow('AAMk-G', '2026-08-06T06:00:00Z'),
      ];
      const t = transportWith(multiPageHttps([
        {
          body: listBody(page1, { '@odata.nextLink': goodNextLink('PAGE2TOK') }),
        },
        { body: listBody(page2) },
      ], (opts) => {
        snapshots.push({
          hostname: opts.hostname,
          path: opts.path,
          prefer: opts.headers && opts.headers.Prefer,
        });
      }));
      const dto = await t.listBoundedCatchupInboundEnvelopes(goodInput());
      assertDtoShape(dto);
      ok(
        'two-page-burst-gt5',
        dto.pages_fetched === 2
          && dto.unique_count === 7
          && dto.observed_count === 7
          && dto.duplicate_count === 0
          && dto.truncated === false
          && dto.envelopes.map((e) => e.provider_message_id).join(',')
            === 'AAMk-A,AAMk-B,AAMk-C,AAMk-D,AAMk-E,AAMk-F,AAMk-G',
      );
      ok(
        'every-request-immutableid-header',
        snapshots.length === 2
          && snapshots.every((c) => c.prefer === PREFER_IMMUTABLE_ID),
      );
      ok(
        'page2-uses-validated-nextlink-path',
        snapshots[1]
          && (snapshots[1].path.includes('skiptoken=PAGE2TOK')
            || snapshots[1].path.includes('%24skiptoken=PAGE2TOK'))
          && snapshots[1].path.startsWith(`/v1.0/users/${MAILBOX_ID}/messages?`)
          && snapshots[1].hostname === 'graph.microsoft.com'
          && snapshots[0].path === expectedFirstPath(),
        ser(snapshots.map((s) => s.path)),
      );
    }

    // ── Cross-page duplicate ──────────────────────────────────────────────
    {
      const t = transportWith(multiPageHttps([
        {
          body: listBody([
            envelopeRow('AAMk-A', '2026-08-06T12:00:00Z'),
            envelopeRow('AAMk-B', '2026-08-06T11:00:00Z'),
          ], { '@odata.nextLink': goodNextLink('DUP2') }),
        },
        {
          body: listBody([
            envelopeRow('AAMk-A', '2026-08-06T12:00:00Z'),
            envelopeRow('AAMk-C', '2026-08-06T10:00:00Z'),
          ]),
        },
      ]));
      const dto = await t.listBoundedCatchupInboundEnvelopes(goodInput());
      assertDtoShape(dto);
      ok(
        'cross-page-duplicate-deduped',
        dto.pages_fetched === 2
          && dto.observed_count === 4
          && dto.unique_count === 3
          && dto.duplicate_count === 1
          && dto.envelopes.map((e) => e.provider_message_id).join(',') === 'AAMk-A,AAMk-B,AAMk-C',
      );
    }

    // ── Same timestamp total order independent of page layout ─────────────
    {
      const sameTs = '2026-08-06T12:00:00Z';
      // Layout A: id-Z then id-A on page1; id-M on page2
      const tA = transportWith(multiPageHttps([
        {
          body: listBody([
            envelopeRow('AAMk-Z', sameTs),
            envelopeRow('AAMk-A', sameTs),
          ], { '@odata.nextLink': goodNextLink('ORD2') }),
        },
        { body: listBody([envelopeRow('AAMk-M', sameTs)]) },
      ]));
      const dtoA = await tA.listBoundedCatchupInboundEnvelopes(goodInput());
      // Layout B: reverse page membership / order
      const tB = transportWith(multiPageHttps([
        {
          body: listBody([
            envelopeRow('AAMk-M', sameTs),
            envelopeRow('AAMk-Z', sameTs),
          ], { '@odata.nextLink': goodNextLink('ORD2b') }),
        },
        { body: listBody([envelopeRow('AAMk-A', sameTs)]) },
      ]));
      const dtoB = await tB.listBoundedCatchupInboundEnvelopes(goodInput());
      assertDtoShape(dtoA);
      assertDtoShape(dtoB);
      const idsA = dtoA.envelopes.map((e) => e.provider_message_id).join(',');
      const idsB = dtoB.envelopes.map((e) => e.provider_message_id).join(',');
      ok(
        'same-timestamp-order-independent-of-page-layout',
        idsA === idsB && idsA === 'AAMk-A,AAMk-M,AAMk-Z',
        `A=${idsA} B=${idsB}`,
      );
    }

    // ── Final empty page with nextLink chain ending ───────────────────────
    {
      const t = transportWith(multiPageHttps([
        {
          body: listBody(
            [envelopeRow('AAMk-A', '2026-08-06T12:00:00Z')],
            { '@odata.nextLink': goodNextLink('EMPTY2') },
          ),
        },
        { body: listBody([]) },
      ]));
      const dto = await t.listBoundedCatchupInboundEnvelopes(goodInput());
      assertDtoShape(dto);
      ok(
        'empty-final-page',
        dto.pages_fetched === 2
          && dto.unique_count === 1
          && dto.truncated === false,
      );
    }

    // ── 10-page / 50-message cap with truncated ───────────────────────────
    {
      const captures = [];
      // 10 pages × 5 unique = 50; still offer nextLink after page 10 → truncated
      const t = transportWith(multiPageHttps((idx) => {
        const base = idx * 5;
        const rows = [];
        for (let i = 0; i < 5; i += 1) {
          const n = base + i;
          rows.push(envelopeRow(
            `AAMk-P${String(n).padStart(3, '0')}`,
            new Date(Date.UTC(2026, 7, 6, 12, 0, 0) - n * 1000)
              .toISOString()
              .replace(/\.\d{3}Z$/, 'Z'),
          ));
        }
        // After page index 9 (10th page), still offer nextLink → truncated
        return {
          body: listBody(
            rows,
            { '@odata.nextLink': goodNextLink(`TOK${idx + 1}`) },
          ),
        };
      }, (opts) => captures.push(opts)));
      const dto = await t.listBoundedCatchupInboundEnvelopes(goodInput());
      assertDtoShape(dto);
      ok(
        'ten-page-fifty-cap-truncated',
        dto.pages_fetched === 10
          && dto.unique_count === 50
          && dto.observed_count === 50
          && dto.duplicate_count === 0
          && dto.truncated === true
          && dto.envelopes.length === 50
          && captures.length === 10
          && captures.every((c) => c.headers.Prefer === PREFER_IMMUTABLE_ID),
        ser({
          pages: dto.pages_fetched,
          unique: dto.unique_count,
          trunc: dto.truncated,
          calls: captures.length,
        }),
      );
      {
        const tBad = transportWith(multiPageHttps([{ body: listBody([]) }]));
        await mustFailStage(
          () => tBad.listBoundedCatchupInboundEnvelopes({
            accessToken: TOKEN,
            provider_mailbox_id: MAILBOX_ID,
            maxPages: 99,
            maxMessages: 999,
          }),
          'request_error',
        );
        ok('extra-bounds-keys-rejected', true);
      }
    }

    // ── maxMessages mid-stream: deterministic selection, truncated ────────
    {
      // Force early maxMessages by using factory caps... can't change caps.
      // Instead fill 50 unique then ensure page would add more — already covered
      // by 10×5. Add case: 49 unique + page of 5 with 1 dup → 53 candidates,
      // accept 50, truncated if nextLink OR more uniques past bound.
      const pages = [];
      // 9 pages × 5 = 45
      for (let p = 0; p < 9; p += 1) {
        const rows = [];
        for (let i = 0; i < 5; i += 1) {
          const n = p * 5 + i;
          rows.push(envelopeRow(
            `AAMk-M${String(n).padStart(3, '0')}`,
            new Date(Date.UTC(2026, 7, 6, 18, 0, 0) - n * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          ));
        }
        pages.push({
          body: listBody(rows, { '@odata.nextLink': goodNextLink(`M${p + 1}`) }),
        });
      }
      // page 10: 5 more unique → total 50 unique, still nextLink → truncated
      {
        const rows = [];
        for (let i = 0; i < 5; i += 1) {
          const n = 45 + i;
          rows.push(envelopeRow(
            `AAMk-M${String(n).padStart(3, '0')}`,
            new Date(Date.UTC(2026, 7, 6, 18, 0, 0) - n * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          ));
        }
        pages.push({
          body: listBody(rows, { '@odata.nextLink': goodNextLink('M10MORE') }),
        });
      }
      const t = transportWith(multiPageHttps(pages));
      const dto = await t.listBoundedCatchupInboundEnvelopes(goodInput());
      assertDtoShape(dto);
      ok(
        'max-messages-exact-50-with-nextlink-truncated',
        dto.unique_count === 50
          && dto.pages_fetched === 10
          && dto.truncated === true
          && dto.envelopes[0].provider_message_id === 'AAMk-M000',
        ser({
          u: dto.unique_count,
          p: dto.pages_fetched,
          t: dto.truncated,
          first: dto.envelopes[0] && dto.envelopes[0].provider_message_id,
        }),
      );
    }

    // ── Loop nextLink rejected (exact raw repeat) ─────────────────────────
    {
      const loop = goodNextLink('LOOP');
      const t = transportWith(multiPageHttps([
        {
          body: listBody(
            [envelopeRow('AAMk-A', '2026-08-06T12:00:00Z')],
            { '@odata.nextLink': loop },
          ),
        },
        {
          body: listBody(
            [envelopeRow('AAMk-B', '2026-08-06T11:00:00Z')],
            { '@odata.nextLink': loop },
          ),
        },
      ]));
      await mustFailStage(
        () => t.listBoundedCatchupInboundEnvelopes(goodInput()),
        'top_shape_invalid',
      );
      ok('loop-nextlink-rejected-no-partial', true);
    }

    // ── Canonical loop: equivalent percent-encoding / query order ─────────
    {
      // Page1 offers skiptoken=AB as literal "AB"; page2 re-offers same token via
      // percent-encoding + reordered query — must collide on canonical identity
      // and fail before a third request.
      const linkA = nextLinkWithRawQuery(
        `$top=5&$select=${encodeURIComponent(SELECT_JOINED)}&$skiptoken=AB`,
      );
      const linkB = nextLinkWithRawQuery(
        `$skiptoken=%41%42&$select=${encodeURIComponent(SELECT_JOINED)}&$top=5`,
      );
      let calls = 0;
      const t = transportWith(multiPageHttps((idx) => {
        calls += 1;
        if (idx === 0) {
          return {
            body: listBody(
              [envelopeRow('AAMk-A', '2026-08-06T12:00:00Z')],
              { '@odata.nextLink': linkA },
            ),
          };
        }
        if (idx === 1) {
          return {
            body: listBody(
              [envelopeRow('AAMk-B', '2026-08-06T11:00:00Z')],
              { '@odata.nextLink': linkB },
            ),
          };
        }
        // Must never be reached — loop detection fails before this request.
        return {
          body: listBody([envelopeRow('AAMk-EVIL', '2026-08-06T01:00:00Z')]),
        };
      }));
      await mustFailStage(
        () => t.listBoundedCatchupInboundEnvelopes(goodInput()),
        'top_shape_invalid',
      );
      ok(
        'canonical-loop-percent-and-order-collide',
        calls === 2,
        `calls=${calls}`,
      );
    }

    // ── Hostile nextLink shapes ───────────────────────────────────────────
    const hostileLinks = [
      ['http-scheme', 'http://graph.microsoft.com/v1.0/users/' + MAILBOX_ID + '/messages?$top=5&$select=' + encodeURIComponent(SELECT_JOINED) + '&$skiptoken=x'],
      ['wrong-host', 'https://evil.example/v1.0/users/' + MAILBOX_ID + '/messages?$top=5&$select=' + encodeURIComponent(SELECT_JOINED) + '&$skiptoken=x'],
      ['port-8443', 'https://graph.microsoft.com:8443/v1.0/users/' + MAILBOX_ID + '/messages?$top=5&$select=' + encodeURIComponent(SELECT_JOINED) + '&$skiptoken=x'],
      ['userinfo', 'https://user:pass@graph.microsoft.com/v1.0/users/' + MAILBOX_ID + '/messages?$top=5&$select=' + encodeURIComponent(SELECT_JOINED) + '&$skiptoken=x'],
      ['hash', goodNextLink('H') + '#frag'],
      ['path-me', 'https://graph.microsoft.com/v1.0/me/messages?$top=5&$select=' + encodeURIComponent(SELECT_JOINED) + '&$skiptoken=x'],
      ['wrong-mailbox', goodNextLink('X', OTHER_MAILBOX)],
      ['path-case', 'https://graph.microsoft.com/v1.0/Users/' + MAILBOX_ID + '/messages?$top=5&$select=' + encodeURIComponent(SELECT_JOINED) + '&$skiptoken=x'],
      ['path-dotdot', 'https://graph.microsoft.com/v1.0/users/' + MAILBOX_ID + '/../' + MAILBOX_ID + '/messages?$top=5&$select=' + encodeURIComponent(SELECT_JOINED) + '&$skiptoken=x'],
      ['changed-top', goodNextLink('T', MAILBOX_ID, { $top: '10', $select: SELECT_JOINED, $skiptoken: 'T' })],
      ['changed-select', goodNextLink('S', MAILBOX_ID, { $top: '5', $select: 'id,subject', $skiptoken: 'S' })],
      ['extra-param', goodNextLink('E', MAILBOX_ID, {
        $top: '5', $select: SELECT_JOINED, $skiptoken: 'E', $orderby: 'receivedDateTime desc',
      })],
      ['dup-query-key', nextLinkWithRawQuery('$top=5&$top=5&$select=' + encodeURIComponent(SELECT_JOINED) + '&$skiptoken=D')],
      ['empty-skiptoken', goodNextLink('', MAILBOX_ID, { $top: '5', $select: SELECT_JOINED, $skiptoken: '' })],
      ['oversize-skiptoken', goodNextLink('X'.repeat(3000))],
      ['no-opaque', nextLinkWithRawQuery('$top=5&$select=' + encodeURIComponent(SELECT_JOINED))],
      // Exact keyset: reject absence of required base keys / sole opaque / case variants / encoded key confusion.
      ['sole-opaque', nextLinkWithRawQuery('$skiptoken=only')],
      ['missing-top', nextLinkWithRawQuery('$select=' + encodeURIComponent(SELECT_JOINED) + '&$skiptoken=x')],
      ['missing-select', nextLinkWithRawQuery('$top=5&$skiptoken=x')],
      ['case-top', nextLinkWithRawQuery('$Top=5&$select=' + encodeURIComponent(SELECT_JOINED) + '&$skiptoken=x')],
      ['case-select', nextLinkWithRawQuery('$top=5&$Select=' + encodeURIComponent(SELECT_JOINED) + '&$skiptoken=x')],
      ['encoded-top-key', nextLinkWithRawQuery('%24top=5&$select=' + encodeURIComponent(SELECT_JOINED) + '&$skiptoken=x')],
      ['encoded-select-key', nextLinkWithRawQuery('$top=5&%24select=' + encodeURIComponent(SELECT_JOINED) + '&$skiptoken=x')],
      ['encoded-skiptoken-key', nextLinkWithRawQuery('$top=5&$select=' + encodeURIComponent(SELECT_JOINED) + '&%24skiptoken=x')],
      ['dup-select', nextLinkWithRawQuery('$top=5&$select=' + encodeURIComponent(SELECT_JOINED) + '&$select=' + encodeURIComponent(SELECT_JOINED) + '&$skiptoken=x')],
    ];

    for (const [label, link] of hostileLinks) {
      const t = transportWith(multiPageHttps([
        {
          body: listBody(
            [envelopeRow('AAMk-A', '2026-08-06T12:00:00Z')],
            { '@odata.nextLink': link },
          ),
        },
        // If follow incorrectly happens, fail the test via wrong second page.
        { body: listBody([envelopeRow('AAMk-EVIL', '2026-08-06T01:00:00Z')]) },
      ]));
      let rejected = false;
      try {
        await t.listBoundedCatchupInboundEnvelopes(goodInput());
      } catch (err) {
        rejected = err && err.code === FAILURE_CODE
          && Object.isFrozen(err)
          && noLeak(err)
          && noLeak(err.message);
      }
      ok(`hostile-nextlink-${label}`, rejected === true);
    }

    // ── Proxy / accessor / inherited / symbol / nonenumerable nextLink ────
    {
      // Classifier rejects non-own-enumerable-data nextLink → page invalid
      const tProxy = transportWith(multiPageHttps([
        {
          body: JSON.stringify({
            value: [envelopeRow('AAMk-A', '2026-08-06T12:00:00Z')],
            // Valid JSON only — proxy surfaces tested at page object level via
            // classify; wire body can't be a Proxy. Use invalid nextLink type
            // via oversize / non-string is impossible in JSON. Instead use
            // valid page then ensure factory does not accept maxPages override
            // and that symbol export surfaces are absent.
          }),
        },
      ]));
      const dto = await tProxy.listBoundedCatchupInboundEnvelopes(goodInput());
      ok('plain-page-still-works', dto.unique_count === 1);

      // Non-string nextLink cannot appear in strict JSON path; plant invalid URL string.
      const tBadType = transportWith(multiPageHttps([
        {
          body: listBody(
            [envelopeRow('AAMk-A', '2026-08-06T12:00:00Z')],
            { '@odata.nextLink': 12345 },
          ),
        },
      ]));
      // strict JSON number for nextLink → classifier top_shape_invalid
      await mustFailStage(
        () => tBadType.listBoundedCatchupInboundEnvelopes(goodInput()),
        'top_shape_invalid',
      );
      ok('nonstring-nextlink-rejected', true);
    }

    // ── Page-2 failure yields no result (atomic) ──────────────────────────
    {
      let calls = 0;
      const t = transportWith(multiPageHttps((idx) => {
        calls += 1;
        if (idx === 0) {
          return {
            body: listBody(
              [envelopeRow('AAMk-A', '2026-08-06T12:00:00Z')],
              { '@odata.nextLink': goodNextLink('P2FAIL') },
            ),
          };
        }
        return { status: 500, body: JSON.stringify({ error: PLANTED }) };
      }));
      let threw = null;
      try {
        await t.listBoundedCatchupInboundEnvelopes(goodInput());
      } catch (err) {
        threw = err;
      }
      ok(
        'page2-failure-no-partial-dto',
        threw
          && threw.code === FAILURE_CODE
          && readTrustedGraphStage(threw) === 'http_status_not_200'
          && noLeak(threw)
          && calls === 2,
      );
    }

    // ── Page-2 row invalid → atomic fail ──────────────────────────────────
    {
      const t = transportWith(multiPageHttps([
        {
          body: listBody(
            [envelopeRow('AAMk-A', '2026-08-06T12:00:00Z')],
            { '@odata.nextLink': goodNextLink('BADROW') },
          ),
        },
        {
          body: listBody([
            {
              id: 'AAMk-B',
              subject: 'x',
              from: { emailAddress: emailAddress() },
              receivedDateTime: '', // invalid empty required string
              isRead: false,
              conversationId: 'c',
              internetMessageId: '<b@e.com>',
            },
          ]),
        },
      ]));
      let stageOk = false;
      try {
        await t.listBoundedCatchupInboundEnvelopes(goodInput());
      } catch (err) {
        const stage = readTrustedGraphStage(err);
        stageOk = err && err.code === FAILURE_CODE
          && (stage === 'row_value_invalid' || stage === 'row_keyset_invalid')
          && Object.isFrozen(err)
          && noLeak(err);
      }
      ok('page2-row-invalid-atomic', stageOk === true);
    }

    // ── One-shot factory ──────────────────────────────────────────────────
    {
      const t = transportWith(multiPageHttps([{ body: listBody([]) }]));
      await t.listBoundedCatchupInboundEnvelopes(goodInput());
      await mustFailStage(
        () => t.listBoundedCatchupInboundEnvelopes(goodInput()),
        'request_error',
      );
      ok('one-shot-factory', true);
    }

    // ── No sends / drafts / mutations / timers default network ────────────
    {
      const src = fs.readFileSync(path.join(ROOT, TRANSPORT_REL), 'utf8');
      const messagesSrc = fs.readFileSync(path.join(ROOT, MESSAGES_REL), 'utf8');
      ok(
        'src-thin-catchup-surface',
        src.split('\n').length < 120
          && !/https\.request|function onResponse|requestObject\.end/.test(src)
          && /createMicrosoftGraphImmutableIdBoundedCatchupTransport/.test(src)
          && /email-microsoft-graph-delegated-messages-transport/.test(src),
        `lines=${src.split('\n').length}`,
      );
      ok(
        'src-owner-has-catchup-factory',
        /createMicrosoftGraphImmutableIdBoundedCatchupTransport/.test(messagesSrc)
          && /BOUNDED_CATCHUP_MAX_PAGES\s*=\s*10/.test(messagesSrc)
          && /BOUNDED_CATCHUP_MAX_MESSAGES\s*=\s*50/.test(messagesSrc)
          && /validateCatchupFollowNextLink|immutableid_envelopes_page/.test(messagesSrc),
      );
      ok(
        'src-no-send-draft-mutation',
        !/\bPOST\b|\bPATCH\b|\bPUT\b|\bDELETE\b|sendMail|createReply|draft/i.test(src)
          && !/method:\s*['"]POST['"]/.test(messagesSrc.split('createMicrosoftGraphImmutableIdBoundedCatchupTransport')[1] || ''),
      );
      ok(
        'src-runtime-wired-false',
        /EMAIL_MS_GRAPH_IMMUTABLEID_BOUNDED_CATCHUP_TRANSPORT_RUNTIME_WIRED\s*=\s*false/.test(src),
      );
      ok(
        'src-no-console',
        !/\bconsole\.(log|info|debug|warn|error)\b/.test(src),
      );
      ok(
        'src-no-db-route-oauth',
        !/\brequire\(['"]pg['"]\)/.test(src)
          && !/staff-email-oauth|express|Router/.test(src)
          && !/Mail\.Read\b|offline_access/.test(src),
      );
      ok(
        'src-no-consumer-invocation',
        /INVOKES_CONSUMER\s*=\s*false/.test(src)
          && !/processInboundEmailBatch/.test(src)
          && !/processInboundEmailBatch/.test(
            messagesSrc.includes('listBoundedCatchupInboundEnvelopes')
              ? messagesSrc.slice(messagesSrc.indexOf('listBoundedCatchupInboundEnvelopes'))
              : '',
          ),
      );
      ok(
        'src-uses-contract-identity-order',
        /inboundEmailEnvelopeIdentityTuple/.test(messagesSrc)
          && /compareInboundEmailEnvelopesForOrder/.test(messagesSrc),
      );
      ok(
        'src-no-competing-envelope-dto',
        !/ENVELOPE_DTO_KEYS\s*=/.test(src)
          && !/from_address/.test(src),
      );
    }

    // ── Single-page transport still byte-compatible (smoke) ───────────────
    {
      const { EventEmitter: EE } = require('node:events');
      let prefer = null;
      let pathSeen = null;
      const single = singlePageTransport.createMicrosoftGraphImmutableIdPageTransport({
        httpsImpl(options, onResponse) {
          prefer = options.headers.Prefer;
          pathSeen = options.path;
          const req = new EE();
          req.destroy = () => {};
          req.end = () => {
            queueMicrotask(() => {
              const res = new EE();
              res.statusCode = 200;
              Object.defineProperty(res, 'headers', {
                value: { 'content-type': 'application/json' },
                enumerable: true,
              });
              res.destroy = () => {};
              onResponse(res);
              res.emit('data', Buffer.from(listBody([
                envelopeRow('AAMk-A', '2026-08-06T12:00:00Z'),
              ])));
              res.emit('end');
            });
          };
          return req;
        },
        timers: { setTimeout, clearTimeout },
      });
      const envs = await single.listNormalizedInboundEnvelopes(goodInput());
      ok(
        'single-page-still-array-of-envelopes',
        Array.isArray(envs)
          && envs.length === 1
          && envs[0].provider_message_id === 'AAMk-A'
          && prefer === PREFER_IMMUTABLE_ID
          && pathSeen === expectedFirstPath(),
      );
    }

    // ── Count-health still no Prefer ──────────────────────────────────────
    {
      const { EventEmitter: EE } = require('node:events');
      let prefer = null;
      const count = messagesTransport.createMicrosoftGraphDelegatedMessagesTransport({
        httpsImpl(options, onResponse) {
          prefer = options.headers.Prefer;
          const req = new EE();
          req.destroy = () => {};
          req.end = () => {
            queueMicrotask(() => {
              const res = new EE();
              res.statusCode = 200;
              Object.defineProperty(res, 'headers', {
                value: { 'content-type': 'application/json' },
                enumerable: true,
              });
              res.destroy = () => {};
              onResponse(res);
              res.emit('data', Buffer.from(listBody([])));
              res.emit('end');
            });
          };
          return req;
        },
        timers: { setTimeout, clearTimeout },
      });
      const result = await count.listMessageEnvelopeCount({ accessToken: TOKEN });
      ok(
        'count-health-still-no-prefer',
        prefer === undefined
          && result.message_count_bounded === 0
          && result.graph_stage === 'success',
      );
    }

    // ── Envelope keys match contract ──────────────────────────────────────
    {
      const t = transportWith(multiPageHttps([
        { body: listBody([envelopeRow('AAMk-A', '2026-08-06T12:00:00Z')]) },
      ]));
      const dto = await t.listBoundedCatchupInboundEnvelopes(goodInput());
      ok(
        'envelope-keys-exact-contract',
        Object.keys(dto.envelopes[0]).sort().join(',')
          === [...EMAIL_INBOUND_ENVELOPE_KEYS].sort().join(','),
      );
    }

    // ── Token custody: single owner + page finally scrub + retained options ─
    {
      const messagesSrc = fs.readFileSync(path.join(ROOT, MESSAGES_REL), 'utf8');
      const catchupFnStart = messagesSrc.indexOf('async function listBoundedCatchupInboundEnvelopes');
      const catchupFnEnd = messagesSrc.indexOf(
        'return Object.freeze({ listBoundedCatchupInboundEnvelopes })',
      );
      ok('src-catchup-fn-present', catchupFnStart >= 0 && catchupFnEnd > catchupFnStart);
      const catchupFnBody = catchupFnStart >= 0 && catchupFnEnd > catchupFnStart
        ? messagesSrc.slice(catchupFnStart, catchupFnEnd)
        : '';
      ok(
        'src-catchup-single-tokenOwner-let',
        /let\s+tokenOwner\s*=\s*null/.test(catchupFnBody)
          && /tokenOwner\s*=\s*parsed\.accessToken/.test(catchupFnBody)
          && /parsed\.accessToken\s*=\s*null/.test(catchupFnBody),
      );
      ok(
        'src-catchup-pageInput-finally-scrub',
        /const\s+pageInput\s*=\s*\{[\s\S]*?accessToken:\s*tokenOwner/.test(catchupFnBody)
          && /finally\s*\{[\s\S]*?pageInput\.accessToken\s*=\s*null/.test(catchupFnBody),
      );
      ok(
        'src-catchup-outer-finally-scrubs-owner',
        /Outer finally scrubs the sole catch-up token owner/.test(catchupFnBody)
          && /tokenOwner\s*=\s*null/.test(catchupFnBody),
      );
      ok(
        'src-catchup-canonical-loop-after-validate',
        /validateCatchupFollowNextLink/.test(catchupFnBody)
          && /seenCanonicalContinuations/.test(catchupFnBody)
          && /canonicalIdentity/.test(catchupFnBody)
          && !/seenNextLinks/.test(catchupFnBody),
      );

      // Runtime: multi-page retained options scrubbed on success.
      const retained = [];
      let sawTokenDuringAnyCall = false;
      const tOk = transportWith(multiPageHttps([
        {
          body: listBody(
            [envelopeRow('AAMk-A', '2026-08-06T12:00:00Z')],
            { '@odata.nextLink': goodNextLink('SCRUB2') },
          ),
        },
        { body: listBody([envelopeRow('AAMk-B', '2026-08-06T11:00:00Z')]) },
      ], (opts) => {
        retained.push(opts);
        if (opts && opts.headers
            && typeof opts.headers.Authorization === 'string'
            && opts.headers.Authorization.includes(TOKEN)) {
          sawTokenDuringAnyCall = true;
        }
      }));
      const dto = await tOk.listBoundedCatchupInboundEnvelopes(goodInput());
      assertDtoShape(dto);
      ok('token-custody-multi-page-success', dto.pages_fetched === 2 && dto.unique_count === 2);
      ok('token-custody-saw-bearer-during-call', sawTokenDuringAnyCall === true);
      ok(
        'token-custody-retained-options-scrubbed-success',
        retained.length === 2
          && retained.every((r) => {
            try {
              assertRetainedOptionsScrubbed(r, 'multi-page-success');
              return true;
            } catch {
              return false;
            }
          }),
        ser(retained.map((r) => r && r.headers && r.headers.Authorization)),
      );

      // Runtime: page-2 failure still scrubs every retained options holder.
      const retainedFail = [];
      const tFail = transportWith(multiPageHttps((idx) => {
        return idx === 0
          ? {
            body: listBody(
              [envelopeRow('AAMk-A', '2026-08-06T12:00:00Z')],
              { '@odata.nextLink': goodNextLink('SCRUBFAIL') },
            ),
          }
          : { status: 500, body: JSON.stringify({ error: PLANTED }) };
      }, (opts) => retainedFail.push(opts)));
      let threwFail = null;
      try {
        await tFail.listBoundedCatchupInboundEnvelopes(goodInput());
      } catch (err) {
        threwFail = err;
      }
      ok(
        'token-custody-page2-fail-still-scrubbed',
        threwFail
          && threwFail.code === FAILURE_CODE
          && retainedFail.length === 2
          && retainedFail.every((r) => {
            try {
              assertRetainedOptionsScrubbed(r, 'multi-page-fail');
              return true;
            } catch {
              return false;
            }
          }),
      );

      // Runtime: request throw scrubs retained options (first page).
      let retainedThrow = null;
      const tThrow = createMicrosoftGraphImmutableIdBoundedCatchupTransport({
        httpsImpl() {
          const options = arguments[0];
          retainedThrow = options;
          throw new Error(`planted-request-throw-${PLANTED}`);
        },
        timers: { setTimeout, clearTimeout },
      });
      let threwReq = null;
      try {
        await tThrow.listBoundedCatchupInboundEnvelopes(goodInput());
      } catch (err) {
        threwReq = err;
      }
      ok(
        'token-custody-request-throw-scrubbed',
        threwReq
          && threwReq.code === FAILURE_CODE
          && retainedThrow
          && retainedThrow.headers
          && retainedThrow.headers.Authorization === null
          && noLeak(retainedThrow)
          && noLeak(threwReq),
      );
    }

    // ── URL hardening: post-load monkeypatch getters / global / proxy ──────
    {
      const urlProto = URL.prototype;
      const getterNames = [
        'protocol', 'username', 'password', 'hostname', 'host', 'port',
        'pathname', 'search', 'hash',
      ];
      const savedDescriptors = {};
      for (const name of getterNames) {
        savedDescriptors[name] = Object.getOwnPropertyDescriptor(urlProto, name);
      }
      const OriginalURL = globalThis.URL;
      let proxyCtorHits = 0;
      let proxyGetHits = 0;

      try {
        // Monkeypatch every relevant getter to return hostile values / throw.
        for (const name of getterNames) {
          Object.defineProperty(urlProto, name, {
            configurable: true,
            enumerable: true,
            get() {
              throw new Error(`hostile-url-getter-${name}-${PLANTED}`);
            },
            set() {
              throw new Error(`hostile-url-setter-${name}-${PLANTED}`);
            },
          });
        }
        // Replace ambient global URL with a proxy constructor that traps.
        const HostileURL = new Proxy(function HostileURL() {
          proxyCtorHits += 1;
          throw new Error(`hostile-URL-ctor-${PLANTED}`);
        }, {
          construct() {
            proxyCtorHits += 1;
            throw new Error(`hostile-URL-construct-${PLANTED}`);
          },
          apply() {
            proxyCtorHits += 1;
            throw new Error(`hostile-URL-apply-${PLANTED}`);
          },
          get(target, prop, receiver) {
            proxyGetHits += 1;
            return Reflect.get(target, prop, receiver);
          },
        });
        globalThis.URL = HostileURL;

        // Genuine follow must still succeed via module-init pins (zero ambient hits).
        const t = transportWith(multiPageHttps([
          {
            body: listBody(
              [envelopeRow('AAMk-A', '2026-08-06T12:00:00Z')],
              { '@odata.nextLink': goodNextLink('PINNEDURL') },
            ),
          },
          { body: listBody([envelopeRow('AAMk-B', '2026-08-06T11:00:00Z')]) },
        ]));
        const dto = await t.listBoundedCatchupInboundEnvelopes(goodInput());
        assertDtoShape(dto);
        ok(
          'url-pin-survives-prototype-and-global-monkeypatch',
          dto.pages_fetched === 2 && dto.unique_count === 2,
        );
        ok(
          'url-proxy-ctor-zero-hit',
          proxyCtorHits === 0 && proxyGetHits === 0,
          `ctorHits=${proxyCtorHits} getHits=${proxyGetHits}`,
        );

        // Hostile nextLink still rejected under monkeypatch (fail closed uses pins).
        const tBad = transportWith(multiPageHttps([
          {
            body: listBody(
              [envelopeRow('AAMk-A', '2026-08-06T12:00:00Z')],
              { '@odata.nextLink': 'http://evil.example/v1.0/users/' + MAILBOX_ID + '/messages?$top=5&$select=' + encodeURIComponent(SELECT_JOINED) + '&$skiptoken=x' },
            ),
          },
        ]));
        await mustFailStage(
          () => tBad.listBoundedCatchupInboundEnvelopes(goodInput()),
          'top_shape_invalid',
        );
        ok('url-pin-still-rejects-hostile-under-monkeypatch', true);

        // Source pins: no ambient `new URL(` / live property reads on url.
        const messagesSrc = fs.readFileSync(path.join(ROOT, MESSAGES_REL), 'utf8');
        ok(
          'src-url-module-init-pin',
          /const\s+PINNED_URL\s*=/.test(messagesSrc)
            && /PINNED_URL_GET_PROTOCOL/.test(messagesSrc)
            && /PINNED_URL_GET_HOSTNAME/.test(messagesSrc)
            && /PINNED_URL_GET_PATHNAME/.test(messagesSrc)
            && /PINNED_URL_GET_SEARCH/.test(messagesSrc)
            && /PINNED_URL_INTRINSICS_READY/.test(messagesSrc)
            && /constructPinnedUrl/.test(messagesSrc)
            && /readPinnedUrlComponents/.test(messagesSrc)
            && /Reflect\.construct\(\s*PINNED_URL/.test(messagesSrc)
            && /Reflect\.apply\(\s*PINNED_IS_PROXY/.test(messagesSrc),
        );
        // Live property reads of URL components on instances must not appear in validators.
        const validateRegion = messagesSrc.includes('function validateCatchupFollowNextLink')
          ? messagesSrc.slice(messagesSrc.indexOf('function validateCatchupFollowNextLink'))
          : '';
        ok(
          'src-no-live-url-property-reads-in-catchup-validator',
          validateRegion.length > 0
            && !/url\.protocol|url\.hostname|url\.pathname|url\.search|url\.hash|url\.username|url\.password|url\.host|url\.port|url\.searchParams/.test(
              validateRegion.slice(0, 3500),
            )
            && /parts\.protocol|parts\.hostname|parts\.pathname|parts\.search/.test(
              validateRegion.slice(0, 3500),
            ),
        );
      } finally {
        for (const name of getterNames) {
          if (savedDescriptors[name]) {
            Object.defineProperty(urlProto, name, savedDescriptors[name]);
          }
        }
        globalThis.URL = OriginalURL;
      }
    }

    // ── GREEN exact keyset still accepts reordered query (non-loop) ───────
    {
      const reordered = nextLinkWithRawQuery(
        `$skiptoken=REORDER1&$top=5&$select=${encodeURIComponent(SELECT_JOINED)}`,
      );
      const t = transportWith(multiPageHttps([
        {
          body: listBody(
            [envelopeRow('AAMk-A', '2026-08-06T12:00:00Z')],
            { '@odata.nextLink': reordered },
          ),
        },
        { body: listBody([envelopeRow('AAMk-B', '2026-08-06T11:00:00Z')]) },
      ]));
      const dto = await t.listBoundedCatchupInboundEnvelopes(goodInput());
      assertDtoShape(dto);
      ok(
        'exact-keyset-accepts-reordered-query-once',
        dto.pages_fetched === 2 && dto.unique_count === 2,
      );
    }

    // ── No token/body console leakage ─────────────────────────────────────
    {
      const leaky = logged.some((entry) => {
        const text = entry.map((x) => (typeof x === 'string' ? x : ser(x))).join(' ');
        return text.includes(TOKEN)
          || text.includes(PLANTED_BODY)
          || text.includes('Bearer atok')
          || text.includes('$skiptoken=');
      });
      ok('no-token-or-body-console-leakage', leaky === false);
    }

    // ── Frozen DTO rejects mutation ───────────────────────────────────────
    {
      const t = transportWith(multiPageHttps([
        { body: listBody([envelopeRow('AAMk-A', '2026-08-06T12:00:00Z')]) },
      ]));
      const dto = await t.listBoundedCatchupInboundEnvelopes(goodInput());
      assert.throws(() => {
        dto.truncated = true;
      });
      assert.throws(() => {
        dto.envelopes.push({});
      });
      ok('dto-frozen', true);
    }

  } finally {
    console.log = log;
    console.error = error;
  }

  console.log(`\nbounded-catchup transport: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
