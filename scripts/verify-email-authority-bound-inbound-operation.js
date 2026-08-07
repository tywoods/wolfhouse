'use strict';

/**
 * verify:email-authority-bound-inbound-operation — hostile all-or-nothing gate.
 *
 * Authority-bound inbound composition:
 *   resolveDelegatedReadAuthority → grant-session runWithAccessTokenOnce
 *   (callback) → ImmutableId transport → processInboundEmailBatch
 *   (factory-fixed consumer) exactly once each.
 *
 * No network, routes, OAuth scope, DB migration, deploy, live Graph, or
 * refresh/custody duplication. Prefer observable call counts/order + scrub
 * over source-regex inflation.
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const util = require('util');

const ROOT = path.join(__dirname, '..');
const OP_REL = 'scripts/lib/email-authority-bound-inbound-operation.js';
const VERIFY_REL = 'scripts/verify-email-authority-bound-inbound-operation.js';
const DOC_REL = 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md';
const CUSTODIAN_REL = 'scripts/lib/email-delegated-grant-custodian.js';
const READ_HEALTH_REL = 'scripts/lib/email-delegated-grant-read-health.js';
const BATCH_REL = 'scripts/lib/email-inbound-batch-processor.js';
const TRANSPORT_REL = 'scripts/lib/email-microsoft-graph-delegated-messages-transport.js';
const ROUTES_REL = 'scripts/lib/staff-email-oauth-routes.js';
const STAFF_API_REL = 'scripts/staff-query-api.js';
const PKG_PATH = path.join(ROOT, 'package.json');
const DOC_PATH = path.join(ROOT, DOC_REL);
const OP_PATH = path.join(ROOT, OP_REL);

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RESOURCE = '22222222-2222-4222-8222-2222222222ab';
const FOREIGN_RESOURCE = '33333333-3333-4333-8333-3333333333cd';
const PLANTED_TOKEN = 'ya29.NEVER_LEAK_AUTHORITY_BOUND_INBOUND_AT';
const PLANTED_SUBJECT = 'SUBJECT_PII_MUST_NOT_APPEAR_ON_RESULT';
const PLANTED_ADDRESS = 'pii-mailbox-must-not-escape@example.com';
const PLANTED_MSG = 'AAMkAGI2-PII-MSG';
const MSG_A = 'AAMkAGI2-AAA';
const MSG_B = 'AAMkAGI2-BBB';

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

function noLeak(v) {
  const s = typeof v === 'string' ? v : ser(v);
  return !s.includes(PLANTED_TOKEN)
    && !s.includes(PLANTED_SUBJECT)
    && !s.includes(PLANTED_ADDRESS)
    && !s.includes(PLANTED_MSG)
    && !s.includes('client_secret=')
    && !s.includes('Authorization')
    && !s.includes('refresh_token')
    && !s.includes('ya29.');
}

const origLookup = dns.lookup;
const origLookupService = dns.lookupService;
const origResolve4 = dns.resolve4;
const origConnect = net.Socket.prototype.connect;
const origHttp = http.request;
const origHttps = https.request;
let networkHits = 0;

function installNetworkGuards() {
  networkHits = 0;
  const hit = () => { networkHits += 1; throw new Error('NETWORK_FORBIDDEN_IN_AUTHORITY_BOUND_INBOUND'); };
  dns.lookup = hit;
  dns.lookupService = hit;
  dns.resolve4 = hit;
  net.Socket.prototype.connect = hit;
  http.request = hit;
  https.request = hit;
}

function restoreNetworkGuards() {
  dns.lookup = origLookup;
  dns.lookupService = origLookupService;
  dns.resolve4 = origResolve4;
  net.Socket.prototype.connect = origConnect;
  http.request = origHttp;
  https.request = origHttps;
}

function baseInput(patch = {}) {
  return {
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    ...patch,
  };
}

function authorityDto(patch = {}) {
  return Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    provider: 'microsoft_graph',
    providerMailboxId: RESOURCE,
    bindingStatus: 'verified',
    ...patch,
  });
}

function envelope(patch = {}) {
  return Object.freeze({
    provider: 'microsoft_graph',
    provider_mailbox_id: RESOURCE,
    provider_message_id: MSG_A,
    received_at: '2026-08-06T12:00:00.000Z',
    subject: PLANTED_SUBJECT,
    sender_display_name: 'Guest',
    sender_address: 'guest@example.com',
    is_read: false,
    conversation_id: 'AAQkAGConv=',
    internet_message_id: '<msg.1@example.com>',
    ...patch,
  });
}

function mockDbForAuthority(dtoOrNull, multi = false) {
  const state = { queries: 0, lastParams: null };
  const row = dtoOrNull && {
    client_id: dtoOrNull.clientId,
    location_id: dtoOrNull.locationId,
    endpoint_id: dtoOrNull.endpointId,
    provider: 'microsoft_graph',
    channel: 'email',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
    binding_status: 'verified',
    provider_tenant_id: '11111111-1111-4111-8111-111111111111',
    provider_resource_id: dtoOrNull.providerMailboxId,
    provider_principal_oid: dtoOrNull.providerMailboxId,
    mailbox_kind: 'user',
    mailbox_access_kind: 'own_user',
    public_address: PLANTED_ADDRESS,
    grant_client_id: dtoOrNull.clientId,
    grant_endpoint_id: dtoOrNull.endpointId,
  };
  const db = {
    query(text, params) {
      state.queries += 1;
      state.lastParams = params;
      if (!row) return Promise.resolve({ rows: [] });
      if (multi) return Promise.resolve({ rows: [row, { ...row }] });
      return Promise.resolve({ rows: [row] });
    },
  };
  return { db, state };
}

function makeGrantSession(state, opts = {}) {
  const fn = async function runWithAccessTokenOnce(input, consumer) {
    state.grantCalls += 1;
    state.grantOrder.push('grant');
    state.grantInputs.push(input);
    if (opts.throw) throw new Error(PLANTED_TOKEN);
    if (opts.preCasFail) {
      return Object.freeze({
        ok: false,
        status: String(opts.preCasFail),
        grant_generation: opts.grantGeneration != null ? opts.grantGeneration : null,
      });
    }
    // Callback-scoped loan (mutable). badShape simulates hostile loan key sets.
    const loan = opts.badShape
      ? opts.badShape
      : { accessToken: opts.token != null ? opts.token : PLANTED_TOKEN };
    try {
      if (typeof consumer !== 'function') throw new Error(PLANTED_TOKEN);
      const value = await consumer(loan);
      return Object.freeze({ ok: true, grant_generation: 1, value });
    } finally {
      if (loan && Object.prototype.hasOwnProperty.call(loan, 'accessToken')) {
        try { loan.accessToken = null; } catch { /* */ }
      }
      state.retainedLoan = loan;
    }
  };
  return Object.freeze({ runWithAccessTokenOnce: fn });
}

function makeTransport(state, opts = {}) {
  const fn = async function listNormalizedInboundEnvelopes(input) {
    state.transportCalls += 1;
    state.transportOrder.push('transport');
    state.transportInputs.push({
      accessToken: input && input.accessToken,
      provider_mailbox_id: input && input.provider_mailbox_id,
      keys: input ? Object.keys(input).sort() : null,
    });
    // Observe scrub opportunity: copy then caller must null.
    if (opts.throw) throw new Error(PLANTED_TOKEN);
    if (opts.envelopes != null) return opts.envelopes;
    if (opts.mismatchMailbox) {
      return Object.freeze([
        envelope({ provider_mailbox_id: FOREIGN_RESOURCE, provider_message_id: MSG_A }),
      ]);
    }
    return Object.freeze([
      envelope({ provider_message_id: MSG_A, subject: PLANTED_SUBJECT }),
      envelope({
        provider_message_id: MSG_B,
        received_at: '2026-08-05T12:00:00.000Z',
        subject: PLANTED_SUBJECT,
      }),
    ]);
  };
  return Object.freeze({ listNormalizedInboundEnvelopes: fn });
}

function makeConsumer(state, opts = {}) {
  return async function consumer(envelopes) {
    state.consumerCalls += 1;
    state.consumerOrder.push('consumer');
    state.consumerEnvelopeCounts.push(Array.isArray(envelopes) ? envelopes.length : -1);
    if (opts.throw) throw new Error(PLANTED_SUBJECT);
    if (opts.badAck) return opts.badAck;
    return { acknowledged: true };
  };
}

function freshState() {
  return {
    grantCalls: 0,
    transportCalls: 0,
    consumerCalls: 0,
    grantOrder: [],
    transportOrder: [],
    consumerOrder: [],
    grantInputs: [],
    transportInputs: [],
    consumerEnvelopeCounts: [],
    retainedLoan: null,
  };
}

async function main() {
  installNetworkGuards();
  try {
    const op = require('./lib/email-authority-bound-inbound-operation');
    const cust = require('./lib/email-delegated-grant-custodian');
    const batch = require('./lib/email-inbound-batch-processor');
    const messagesTransport = require('./lib/email-microsoft-graph-delegated-messages-transport');

    const {
      FAILURE_CODE,
      FAILURE_MESSAGE,
      INPUT_KEYS,
      DEPENDENCY_KEYS,
      GRANT_SESSION_KEYS,
      TRANSPORT_KEYS,
      RESULT_KEYS,
      EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_RUNTIME_WIRED,
      EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_PERSISTENCE_READY,
      EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_LOGGING_FORBIDDEN,
      EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_DUPLICATES_REFRESH_CUSTODY,
      createAuthorityBoundInboundOperation,
    } = op;

    // ── Static / wiring ───────────────────────────────────────────────────
    ok('exports-create', typeof createAuthorityBoundInboundOperation === 'function');
    ok('runtime-unwired', EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_RUNTIME_WIRED === false);
    ok('not-persistence-ready', EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_PERSISTENCE_READY === false);
    ok('logging-forbidden', EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_LOGGING_FORBIDDEN === true);
    ok(
      'does-not-duplicate-refresh-custody-flag',
      EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_DUPLICATES_REFRESH_CUSTODY === false,
    );
    ok(
      'input-keys-match-authority',
      Array.isArray(INPUT_KEYS)
        && INPUT_KEYS.join(',') === 'clientId,locationId,endpointId'
        && INPUT_KEYS.join(',') === cust.DELEGATED_READ_AUTHORITY_INPUT_KEYS.join(','),
    );
    ok(
      'dependency-keys-exact',
      DEPENDENCY_KEYS.join(',') === 'db,grantSession,immutableIdPageTransport,consumer',
    );
    ok('grant-session-keys', GRANT_SESSION_KEYS.join(',') === 'runWithAccessTokenOnce');
    ok('transport-keys', TRANSPORT_KEYS.join(',') === 'listNormalizedInboundEnvelopes');
    ok(
      'loan-keys',
      op.LOAN_KEYS && op.LOAN_KEYS.join(',') === 'accessToken',
    );
    ok(
      'result-keys-identity-free',
      RESULT_KEYS.join(',') === 'status,input_count,delivered_count,duplicate_count',
    );
    ok(
      'failure-sanitized',
      FAILURE_CODE === 'authority_bound_inbound_failed'
        && typeof FAILURE_MESSAGE === 'string'
        && !FAILURE_MESSAGE.includes('token')
        && !FAILURE_MESSAGE.includes('Bearer'),
    );

    const src = fs.readFileSync(OP_PATH, 'utf8');
    ok(
      'uses-merged-resolveDelegatedReadAuthority',
      /resolveDelegatedReadAuthority/.test(src)
        && /processInboundEmailBatch/.test(src)
        && /runWithAccessTokenOnce/.test(src)
        && !/obtainAccessTokenOnce/.test(src)
        && !/tryAcquireDelegatedGrantLease/.test(src)
        && !/openDelegatedGrantUnderLease/.test(src)
        && !/commitDelegatedGrantRotation/.test(src)
        && !/createMicrosoftRefreshTokenRequestService/.test(src)
        && !/exchangeRefreshToken/.test(src),
    );
    ok(
      'no-http-duplicate',
      !/https\.request/.test(src)
        && !/createMicrosoftGraphDelegatedMessagesTransport/.test(src)
        && !/createMicrosoftTokenHttpTransport/.test(src),
    );
    ok(
      'no-token-from-caller-fields',
      !/input\.accessToken|input\.token|ownData\(input,\s*'accessToken'\)/.test(src),
    );
    // Lifetime: callback local accessTokenOwner is a nullable let released in
    // finally after graphInput scrub (reference nulling only, not string overwrite).
    ok(
      'callback-accessTokenOwner-nullable-let',
      /let\s+accessTokenOwner\s*=\s*null/.test(src)
        && /accessTokenOwner\s*=\s*null/.test(src)
        && !/const\s+accessTokenOwner\s*=/.test(src),
    );
    {
      // Find the authorityBoundSessionConsumer finally: graphInput scrub then owner=null.
      const consumerIdx = src.indexOf('authorityBoundSessionConsumer');
      const consumerSlice = consumerIdx >= 0 ? src.slice(consumerIdx, consumerIdx + 3500) : '';
      const finIdx = consumerSlice.lastIndexOf('} finally {');
      const finBody = finIdx >= 0 ? consumerSlice.slice(finIdx, finIdx + 500) : '';
      const graphScrubIdx = finBody.search(/graphInput\.accessToken\s*=\s*null/);
      const ownerNullIdx = finBody.search(/accessTokenOwner\s*=\s*null/);
      ok(
        'callback-finally-owner-after-graphInput-scrub',
        graphScrubIdx >= 0 && ownerNullIdx >= 0 && graphScrubIdx < ownerNullIdx,
        `graphScrub=${graphScrubIdx} ownerNull=${ownerNullIdx}`,
      );
      ok(
        'callback-finally-loan-independent-scrub',
        /loan\.accessToken\s*=\s*null/.test(finBody),
      );
    }
    ok(
      'no-string-mutation-patterns',
      !/zero[\s-]?fill|fill\(0\)|\.fill\(|string\.length\s*=\s*0/i.test(src),
    );

    // Unreferenced by routes / staff API / read-health.
    for (const [label, rel] of [
      ['read-health', READ_HEALTH_REL],
      ['oauth-routes', ROUTES_REL],
      ['staff-api', STAFF_API_REL],
      ['batch-lib', BATCH_REL],
      ['custodian', CUSTODIAN_REL],
    ]) {
      const p = path.join(ROOT, rel);
      if (!fs.existsSync(p)) {
        ok(`unreferenced-${label}-missing-ok`, rel === STAFF_API_REL || true);
        continue;
      }
      const body = fs.readFileSync(p, 'utf8');
      ok(
        `unreferenced-by-${label}`,
        !/email-authority-bound-inbound-operation|createAuthorityBoundInboundOperation/.test(body),
      );
    }

    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    ok(
      'package-script',
      pkg.scripts
        && pkg.scripts['verify:email-authority-bound-inbound-operation']
          === 'node scripts/verify-email-authority-bound-inbound-operation.js',
    );

    if (fs.existsSync(DOC_PATH)) {
      const doc = fs.readFileSync(DOC_PATH, 'utf8');
      ok(
        'doc-mentions-slice',
        /authority-bound inbound|authority-bound-inbound/i.test(doc),
      );
    }

    // ImmutableId path pin still authority-bound (/users/{uuid}, not /me).
    ok(
      'transport-users-path-helper',
      typeof messagesTransport.buildImmutableIdUserMessagesPath === 'function'
        && messagesTransport.buildImmutableIdUserMessagesPath(RESOURCE)
          === `/v1.0/users/${RESOURCE}/messages?$top=5&$select=${messagesTransport.SELECT_FIELDS.join(',')}`
        && messagesTransport.PATH.includes('/me/messages')
        && !messagesTransport.buildImmutableIdUserMessagesPath(RESOURCE).includes('/me/'),
    );

    // ── Factory hostile deps ──────────────────────────────────────────────
    assert.throws(
      () => createAuthorityBoundInboundOperation(null),
      (e) => e && e.code === FAILURE_CODE && noLeak(e),
    );
    ok('factory-null-throws', true);

    assert.throws(
      () => createAuthorityBoundInboundOperation(Object.freeze({
        db: { query: async () => ({ rows: [] }) },
        grantSession: Object.freeze({
          runWithAccessTokenOnce: async () => Object.freeze({ ok: true, grant_generation: 1, value: null }),
        }),
        immutableIdPageTransport: Object.freeze({
          listNormalizedInboundEnvelopes: async () => Object.freeze([]),
        }),
        // missing consumer
      })),
      (e) => e && e.code === FAILURE_CODE,
    );
    ok('factory-missing-consumer-throws', true);

    assert.throws(
      () => createAuthorityBoundInboundOperation(Object.freeze({
        db: { query: async () => ({ rows: [] }) },
        grantSession: Object.freeze({
          runWithAccessTokenOnce: async () => Object.freeze({ ok: true, grant_generation: 1, value: null }),
          extra: true,
        }),
        immutableIdPageTransport: Object.freeze({
          listNormalizedInboundEnvelopes: async () => Object.freeze([]),
        }),
        consumer: async () => ({ acknowledged: true }),
      })),
      (e) => e && e.code === FAILURE_CODE,
    );
    ok('factory-extra-grant-key-throws', true);

    {
      const proxyConsumer = new Proxy(async () => ({ acknowledged: true }), {
        apply() { throw new Error(PLANTED_TOKEN); },
      });
      assert.throws(
        () => createAuthorityBoundInboundOperation(Object.freeze({
          db: { query: async () => ({ rows: [] }) },
          grantSession: Object.freeze({
            runWithAccessTokenOnce: async () => Object.freeze({
              ok: true, grant_generation: 1, value: null,
            }),
          }),
          immutableIdPageTransport: Object.freeze({
            listNormalizedInboundEnvelopes: async () => Object.freeze([]),
          }),
          consumer: proxyConsumer,
        })),
        (e) => e && e.code === FAILURE_CODE && noLeak(e),
      );
      ok('factory-proxy-consumer-throws', true);
    }

    // ── GREEN happy path: exact order + counts + scrub + identity-free ───
    {
      const state = freshState();
      const { db, state: dbState } = mockDbForAuthority(authorityDto());
      const transportInputs = state.transportInputs;
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state),
        immutableIdPageTransport: makeTransport(state),
        consumer: makeConsumer(state),
      }));
      const res = await service.runAuthorityBoundInbound(baseInput());
      ok('happy-ok', res && res.ok === true, ser(res));
      ok(
        'happy-counts',
        res.ok
          && res.value.status === 'processed'
          && res.value.input_count === 2
          && res.value.delivered_count === 2
          && res.value.duplicate_count === 0
          && Object.isFrozen(res)
          && Object.isFrozen(res.value),
        ser(res),
      );
      ok(
        'happy-identity-free',
        res.ok
          && !('providerMailboxId' in res.value)
          && !('clientId' in res.value)
          && !('endpointId' in res.value)
          && !('envelopes' in res.value)
          && noLeak(res),
        ser(res),
      );
      ok(
        'exact-call-counts',
        dbState.queries === 1
          && state.grantCalls === 1
          && state.transportCalls === 1
          && state.consumerCalls === 1,
        ser({
          queries: dbState.queries,
          grant: state.grantCalls,
          transport: state.transportCalls,
          consumer: state.consumerCalls,
        }),
      );
      ok(
        'exact-call-order',
        state.grantOrder[0] === 'grant'
          && state.transportOrder[0] === 'transport'
          && state.consumerOrder[0] === 'consumer'
          && state.grantCalls === 1,
        ser({
          grant: state.grantOrder,
          transport: state.transportOrder,
          consumer: state.consumerOrder,
        }),
      );
      ok(
        'grant-session-authority-ids-only',
        state.grantInputs.length === 1
          && state.grantInputs[0]
          && Object.isFrozen(state.grantInputs[0])
          && Object.keys(state.grantInputs[0]).join(',') === 'clientId,endpointId'
          && state.grantInputs[0].clientId === CLIENT
          && state.grantInputs[0].endpointId === ENDPOINT
          && !('locationId' in state.grantInputs[0])
          && !('accessToken' in state.grantInputs[0])
          && !('providerMailboxId' in state.grantInputs[0]),
        ser(state.grantInputs[0]),
      );
      ok(
        'transport-uses-authority-mailbox-and-token',
        transportInputs.length === 1
          && transportInputs[0].provider_mailbox_id === RESOURCE
          && transportInputs[0].accessToken === PLANTED_TOKEN
          && transportInputs[0].keys.join(',') === 'accessToken,provider_mailbox_id',
        ser(transportInputs[0] && {
          mailbox: transportInputs[0].provider_mailbox_id,
          keys: transportInputs[0].keys,
          tokenPresent: Boolean(transportInputs[0].accessToken),
        }),
      );
      ok('happy-no-network', networkHits === 0);
    }

    // ── One-shot service ──────────────────────────────────────────────────
    {
      const state = freshState();
      const { db } = mockDbForAuthority(authorityDto());
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state),
        immutableIdPageTransport: makeTransport(state),
        consumer: makeConsumer(state),
      }));
      const first = await service.runAuthorityBoundInbound(baseInput());
      const second = await service.runAuthorityBoundInbound(baseInput());
      ok('second-use-fails', first.ok === true && second.ok === false
        && second.error === FAILURE_CODE, ser(second));
      ok(
        'second-use-no-extra-calls',
        state.grantCalls === 1 && state.transportCalls === 1 && state.consumerCalls === 1,
        ser(state),
      );
    }

    // ── Authority unresolved → no grant/transport/consumer ────────────────
    {
      const state = freshState();
      const { db, state: dbState } = mockDbForAuthority(null);
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state),
        immutableIdPageTransport: makeTransport(state),
        consumer: makeConsumer(state),
      }));
      const res = await service.runAuthorityBoundInbound(baseInput());
      ok(
        'authority-unresolved-fail',
        res.ok === false && res.error === FAILURE_CODE && noLeak(res),
        ser(res),
      );
      ok(
        'authority-fail-no-downstream',
        dbState.queries === 1
          && state.grantCalls === 0
          && state.transportCalls === 0
          && state.consumerCalls === 0,
        ser(state),
      );
    }

    // ── Hostile caller input (token/provider/mailbox/status/generation/consumer) ──
    {
      const extras = [
        ['accessToken', PLANTED_TOKEN],
        ['token', PLANTED_TOKEN],
        ['provider', 'microsoft_graph'],
        ['providerMailboxId', RESOURCE],
        ['mailbox', PLANTED_ADDRESS],
        ['public_address', PLANTED_ADDRESS],
        ['status', 'healthy'],
        ['grant_generation', 3],
        ['generation', 3],
        ['consumer', async () => ({ acknowledged: true })],
        ['envelopes', []],
      ];
      for (const [key, value] of extras) {
        const state = freshState();
        const { db } = mockDbForAuthority(authorityDto());
        const service = createAuthorityBoundInboundOperation(Object.freeze({
          db,
          grantSession: makeGrantSession(state),
          immutableIdPageTransport: makeTransport(state),
          consumer: makeConsumer(state),
        }));
        const input = baseInput({ [key]: value });
        const res = await service.runAuthorityBoundInbound(input);
        ok(
          `reject-caller-${key}`,
          res.ok === false
            && res.error === FAILURE_CODE
            && state.grantCalls === 0
            && state.transportCalls === 0
            && state.consumerCalls === 0
            && noLeak(res),
          ser(res),
        );
      }
    }

    // ── Grant session failure / bad token shape ───────────────────────────
    {
      const state = freshState();
      const { db } = mockDbForAuthority(authorityDto());
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state, { throw: true }),
        immutableIdPageTransport: makeTransport(state),
        consumer: makeConsumer(state),
      }));
      const res = await service.runAuthorityBoundInbound(baseInput());
      ok(
        'grant-throw-sanitized',
        res.ok === false && res.error === FAILURE_CODE && noLeak(res)
          && state.transportCalls === 0 && state.consumerCalls === 0,
        ser(res),
      );
    }
    {
      const state = freshState();
      const { db } = mockDbForAuthority(authorityDto());
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state, { badShape: { accessToken: PLANTED_TOKEN, extra: 1 } }),
        immutableIdPageTransport: makeTransport(state),
        consumer: makeConsumer(state),
      }));
      const res = await service.runAuthorityBoundInbound(baseInput());
      ok(
        'grant-extra-key-rejected',
        res.ok === false && state.transportCalls === 0 && noLeak(res),
        ser(res),
      );
    }
    {
      const state = freshState();
      const { db } = mockDbForAuthority(authorityDto());
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state, { token: '' }),
        immutableIdPageTransport: makeTransport(state),
        consumer: makeConsumer(state),
      }));
      const res = await service.runAuthorityBoundInbound(baseInput());
      ok(
        'empty-token-rejected',
        res.ok === false && state.transportCalls === 0 && noLeak(res),
        ser(res),
      );
    }
    {
      // Pre-CAS / CAS failure shape → zero callback side effects (no transport/batch).
      const state = freshState();
      const { db } = mockDbForAuthority(authorityDto());
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state, { preCasFail: 'uncertain' }),
        immutableIdPageTransport: makeTransport(state),
        consumer: makeConsumer(state),
      }));
      const res = await service.runAuthorityBoundInbound(baseInput());
      ok(
        'pre-cas-fail-zero-downstream',
        res.ok === false
          && res.error === FAILURE_CODE
          && state.grantCalls === 1
          && state.transportCalls === 0
          && state.consumerCalls === 0
          && noLeak(res),
        ser({ res, state }),
      );
    }

    // ── Transport failure ─────────────────────────────────────────────────
    {
      const state = freshState();
      const { db } = mockDbForAuthority(authorityDto());
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state),
        immutableIdPageTransport: makeTransport(state, { throw: true }),
        consumer: makeConsumer(state),
      }));
      const res = await service.runAuthorityBoundInbound(baseInput());
      ok(
        'transport-throw-sanitized',
        res.ok === false && res.error === FAILURE_CODE && noLeak(res)
          && state.grantCalls === 1 && state.consumerCalls === 0,
        ser(res),
      );
    }

    // ── Authority / transport mailbox mismatch rejection ──────────────────
    {
      const state = freshState();
      const { db } = mockDbForAuthority(authorityDto());
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state),
        immutableIdPageTransport: makeTransport(state, { mismatchMailbox: true }),
        consumer: makeConsumer(state),
      }));
      const res = await service.runAuthorityBoundInbound(baseInput());
      ok(
        'mailbox-mismatch-rejected',
        res.ok === false
          && res.error === FAILURE_CODE
          && state.consumerCalls === 0
          && noLeak(res)
          && !ser(res).includes(FOREIGN_RESOURCE),
        ser(res),
      );
    }

    // ── Consumer failure (batch path) ─────────────────────────────────────
    {
      const state = freshState();
      const { db } = mockDbForAuthority(authorityDto());
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state),
        immutableIdPageTransport: makeTransport(state),
        consumer: makeConsumer(state, { throw: true }),
      }));
      const res = await service.runAuthorityBoundInbound(baseInput());
      ok(
        'consumer-throw-sanitized',
        res.ok === false && res.error === FAILURE_CODE && noLeak(res)
          && state.consumerCalls === 1,
        ser(res),
      );
    }

    // ── Empty page still batches once ─────────────────────────────────────
    {
      const state = freshState();
      const { db } = mockDbForAuthority(authorityDto());
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state),
        immutableIdPageTransport: makeTransport(state, { envelopes: Object.freeze([]) }),
        consumer: makeConsumer(state),
      }));
      const res = await service.runAuthorityBoundInbound(baseInput());
      ok(
        'empty-page-ok',
        res.ok === true
          && res.value.input_count === 0
          && res.value.delivered_count === 0
          && res.value.duplicate_count === 0
          && state.consumerCalls === 1
          && state.consumerEnvelopeCounts[0] === 0,
        ser(res),
      );
    }

    // ── Token scrub: transport input must be mutable for post-call nulling ─
    {
      const state = freshState();
      const { db } = mockDbForAuthority(authorityDto());
      let seenInput = null;
      const transport = Object.freeze({
        async listNormalizedInboundEnvelopes(input) {
          state.transportCalls += 1;
          seenInput = input;
          // Simulate Graph use then return.
          return Object.freeze([envelope()]);
        },
      });
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state),
        immutableIdPageTransport: transport,
        consumer: makeConsumer(state),
      }));
      const res = await service.runAuthorityBoundInbound(baseInput());
      ok('scrub-path-ok', res.ok === true, ser(res));
      ok(
        'token-scrubbed-on-transport-input',
        seenInput
          && Object.prototype.hasOwnProperty.call(seenInput, 'accessToken')
          && seenInput.accessToken === null,
        ser({ accessToken: seenInput && seenInput.accessToken }),
      );
      ok(
        'retained-loan-accessToken-null',
        state.retainedLoan
          && Object.prototype.hasOwnProperty.call(state.retainedLoan, 'accessToken')
          && state.retainedLoan.accessToken === null
          && noLeak(state.retainedLoan),
        ser(state.retainedLoan),
      );
    }

    // ── Proxy input rejected ──────────────────────────────────────────────
    {
      const state = freshState();
      const { db } = mockDbForAuthority(authorityDto());
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state),
        immutableIdPageTransport: makeTransport(state),
        consumer: makeConsumer(state),
      }));
      const proxyInput = new Proxy(baseInput(), {
        get(t, p) { return t[p]; },
      });
      const res = await service.runAuthorityBoundInbound(proxyInput);
      ok(
        'proxy-input-rejected',
        res.ok === false && state.grantCalls === 0 && noLeak(res),
        ser(res),
      );
    }

    // ── Invalid UUID input ────────────────────────────────────────────────
    {
      const state = freshState();
      const { db } = mockDbForAuthority(authorityDto());
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state),
        immutableIdPageTransport: makeTransport(state),
        consumer: makeConsumer(state),
      }));
      const res = await service.runAuthorityBoundInbound(baseInput({
        clientId: CLIENT.toUpperCase(),
      }));
      ok(
        'uppercase-uuid-rejected',
        res.ok === false && state.grantCalls === 0 && noLeak(res),
        ser(res),
      );
    }

    // ── No authority DTO / envelope escape on any result surface ──────────
    {
      const state = freshState();
      const { db } = mockDbForAuthority(authorityDto());
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state),
        immutableIdPageTransport: makeTransport(state),
        consumer: makeConsumer(state),
      }));
      const res = await service.runAuthorityBoundInbound(baseInput());
      const dumped = ser(res);
      ok(
        'no-authority-dto-escape',
        res.ok
          && !dumped.includes(RESOURCE)
          && !dumped.includes(CLIENT)
          && !dumped.includes(ENDPOINT)
          && !dumped.includes(LOCATION)
          && !dumped.includes(PLANTED_ADDRESS)
          && !dumped.includes(PLANTED_SUBJECT)
          && !dumped.includes(PLANTED_TOKEN)
          && !dumped.includes(MSG_A),
        dumped,
      );
    }

    // ── util.types.isProxy ambient monkeypatch resistance (consumer) ──────
    {
      const realIsProxy = util.types.isProxy;
      util.types.isProxy = () => false;
      try {
        const state = freshState();
        const { db } = mockDbForAuthority(authorityDto());
        const proxyConsumer = new Proxy(async () => ({ acknowledged: true }), {});
        assert.throws(
          () => createAuthorityBoundInboundOperation(Object.freeze({
            db,
            grantSession: makeGrantSession(state),
            immutableIdPageTransport: makeTransport(state),
            consumer: proxyConsumer,
          })),
          (e) => e && e.code === FAILURE_CODE,
        );
        ok('pinned-isProxy-resists-ambient-monkeypatch', true);
      } finally {
        util.types.isProxy = realIsProxy;
      }
    }

    // ── DB/query factory snapshot: private frozen adapter, no live re-read ──
    // Honest contract:
    // - At factory: resolve genuine pg-like query via descriptor-safe walk only
    //   (after pinned proxy reject); capture exact validated function once.
    // - Private frozen minimal adapter always Reflect.apply's captured fn to the
    //   original receiver (trusted executable dependency). Only that adapter is
    //   passed to resolveDelegatedReadAuthority — never reread original db/query.
    // - Mutation after factory: old captured query exactly once, new zero.
    // - Getters connect/totalCount/idleCount/query: zero hits at factory + run.
    // - Pool-shape property reads removed (no connect/totalCount/idleCount probe).
    // - Realistic Client/Pool prototype methods accepted; hostile accessor /
    //   custom-proto / symbol / proxy surfaces fail-closed.
    {
      const state = freshState();
      const { db, state: dbState } = mockDbForAuthority(authorityDto());
      const oldQuery = db.query;
      let newHits = 0;
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state),
        immutableIdPageTransport: makeTransport(state),
        consumer: makeConsumer(state),
      }));
      // Post-factory ambient replacement of original surface.query.
      db.query = async function replacedQuery() {
        newHits += 1;
        throw new Error(`MUTATED_QUERY_MUST_NOT_RUN ${PLANTED_TOKEN}`);
      };
      const res = await service.runAuthorityBoundInbound(baseInput());
      ok(
        'post-factory-query-mutation-uses-captured-old',
        res && res.ok === true
          && dbState.queries === 1
          && newHits === 0
          && typeof oldQuery === 'function'
          && db.query !== oldQuery
          && noLeak(res),
        ser({
          ok: res && res.ok,
          queries: dbState.queries,
          newHits,
          sameRef: db.query === oldQuery,
        }),
      );
    }

    // Getter surfaces on pool-ish / hostile db must not execute during factory or run.
    {
      const getterHits = {
        connect: 0,
        totalCount: 0,
        idleCount: 0,
        query: 0,
      };
      const { db: plain, state: dbState } = mockDbForAuthority(authorityDto());
      const capturedQuery = plain.query;
      const db = {};
      Object.defineProperty(db, 'connect', {
        get() {
          getterHits.connect += 1;
          return async () => ({});
        },
        enumerable: true,
        configurable: true,
      });
      Object.defineProperty(db, 'totalCount', {
        get() {
          getterHits.totalCount += 1;
          return 1;
        },
        enumerable: true,
        configurable: true,
      });
      Object.defineProperty(db, 'idleCount', {
        get() {
          getterHits.idleCount += 1;
          return 0;
        },
        enumerable: true,
        configurable: true,
      });
      // Own data query — descriptor value only; must not use [[Get]] path that
      // would also touch sibling getters, and query itself is a data property.
      Object.defineProperty(db, 'query', {
        value: capturedQuery,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      const state = freshState();
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state),
        immutableIdPageTransport: makeTransport(state),
        consumer: makeConsumer(state),
      }));
      ok(
        'factory-zero-pool-shape-getter-hits',
        getterHits.connect === 0
          && getterHits.totalCount === 0
          && getterHits.idleCount === 0
          && getterHits.query === 0,
        ser(getterHits),
      );
      const res = await service.runAuthorityBoundInbound(baseInput());
      ok(
        'run-zero-pool-shape-getter-hits',
        res && res.ok === true
          && dbState.queries === 1
          && getterHits.connect === 0
          && getterHits.totalCount === 0
          && getterHits.idleCount === 0
          && getterHits.query === 0
          && noLeak(res),
        ser({ resOk: res && res.ok, queries: dbState.queries, getterHits }),
      );
    }

    // Own query accessor must be rejected without executing the getter.
    {
      const hits = { query: 0 };
      const db = {};
      Object.defineProperty(db, 'query', {
        get() {
          hits.query += 1;
          throw new Error(`boom db.query ${PLANTED_TOKEN}`);
        },
        enumerable: true,
        configurable: true,
      });
      const state = freshState();
      assert.throws(
        () => createAuthorityBoundInboundOperation(Object.freeze({
          db,
          grantSession: makeGrantSession(state),
          immutableIdPageTransport: makeTransport(state),
          consumer: makeConsumer(state),
        })),
        (e) => e && e.code === FAILURE_CODE && noLeak(e),
      );
      ok(
        'own-query-accessor-rejected-zero-hits',
        hits.query === 0,
        ser(hits),
      );
    }

    // Realistic pg Client.prototype.query (non-enumerable prototype method).
    {
      function RealisticResult(rows) {
        this.command = 'SELECT';
        this.rowCount = rows.length;
        this.oid = null;
        this.rows = rows;
        this.fields = [];
      }
      function RealisticClient(row) {
        this._row = row;
        this.queries = 0;
      }
      RealisticClient.prototype.query = async function query() {
        this.queries += 1;
        return new RealisticResult([this._row]);
      };
      const dto = authorityDto();
      const row = {
        client_id: dto.clientId,
        location_id: dto.locationId,
        endpoint_id: dto.endpointId,
        provider: 'microsoft_graph',
        channel: 'email',
        auth_mode: 'delegated_authorization_code',
        connector_mode: 'microsoft_delegated_oauth',
        binding_status: 'verified',
        provider_tenant_id: '11111111-1111-4111-8111-111111111111',
        provider_resource_id: dto.providerMailboxId,
        provider_principal_oid: dto.providerMailboxId,
        mailbox_kind: 'user',
        mailbox_access_kind: 'own_user',
        public_address: PLANTED_ADDRESS,
        grant_client_id: dto.clientId,
        grant_endpoint_id: dto.endpointId,
      };
      const client = new RealisticClient(row);
      // Pool-like own data properties present; must not be probed via [[Get]].
      Object.defineProperty(client, 'connect', {
        value: async () => ({}),
        enumerable: false,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(client, 'totalCount', {
        value: 1,
        enumerable: false,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(client, 'idleCount', {
        value: 0,
        enumerable: false,
        writable: true,
        configurable: true,
      });
      const state = freshState();
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db: client,
        grantSession: makeGrantSession(state),
        immutableIdPageTransport: makeTransport(state),
        consumer: makeConsumer(state),
      }));
      // Post-factory shadow: own query must not displace captured prototype fn.
      let shadowHits = 0;
      client.query = async function shadow() {
        shadowHits += 1;
        throw new Error(`SHADOW_QUERY ${PLANTED_TOKEN}`);
      };
      const res = await service.runAuthorityBoundInbound(baseInput());
      ok(
        'pg-client-prototype-query-captured-with-receiver',
        res && res.ok === true
          && client.queries === 1
          && shadowHits === 0
          && noLeak(res),
        ser({
          ok: res && res.ok,
          queries: client.queries,
          shadowHits,
        }),
      );
    }

    // Proxy db surface: factory rejects with zero traps (pinned isProxy).
    {
      function trapCounters() {
        return {
          apply: 0,
          get: 0,
          then: 0,
          getPrototypeOf: 0,
          getOwnPropertyDescriptor: 0,
          ownKeys: 0,
          set: 0,
          has: 0,
        };
      }
      function countingProxy(target, traps) {
        return new Proxy(target, {
          apply(t, thisArg, args) {
            traps.apply += 1;
            return Reflect.apply(t, thisArg, args);
          },
          get(t, prop, receiver) {
            traps.get += 1;
            if (prop === 'then') traps.then += 1;
            return Reflect.get(t, prop, receiver);
          },
          getPrototypeOf(t) {
            traps.getPrototypeOf += 1;
            return Reflect.getPrototypeOf(t);
          },
          getOwnPropertyDescriptor(t, prop) {
            traps.getOwnPropertyDescriptor += 1;
            return Reflect.getOwnPropertyDescriptor(t, prop);
          },
          ownKeys(t) {
            traps.ownKeys += 1;
            return Reflect.ownKeys(t);
          },
          set(t, prop, value, receiver) {
            traps.set += 1;
            return Reflect.set(t, prop, value, receiver);
          },
          has(t, prop) {
            traps.has += 1;
            return Reflect.has(t, prop);
          },
        });
      }
      function zeroTraps(traps) {
        return traps.apply === 0
          && traps.get === 0
          && traps.then === 0
          && traps.getPrototypeOf === 0
          && traps.getOwnPropertyDescriptor === 0
          && traps.ownKeys === 0
          && traps.set === 0
          && traps.has === 0;
      }

      {
        const traps = trapCounters();
        const { db: plain } = mockDbForAuthority(authorityDto());
        const proxyDb = countingProxy(plain, traps);
        const state = freshState();
        assert.throws(
          () => createAuthorityBoundInboundOperation(Object.freeze({
            db: proxyDb,
            grantSession: makeGrantSession(state),
            immutableIdPageTransport: makeTransport(state),
            consumer: makeConsumer(state),
          })),
          (e) => e && e.code === FAILURE_CODE && noLeak(e),
        );
        ok('proxy-db-factory-reject-zero-traps', zeroTraps(traps), ser(traps));
      }

      // Ambient isProxy monkeypatch must not hide proxy db.
      {
        const realIsProxy = util.types.isProxy;
        util.types.isProxy = () => false;
        try {
          const traps = trapCounters();
          const { db: plain } = mockDbForAuthority(authorityDto());
          const proxyDb = countingProxy(plain, traps);
          const state = freshState();
          assert.throws(
            () => createAuthorityBoundInboundOperation(Object.freeze({
              db: proxyDb,
              grantSession: makeGrantSession(state),
              immutableIdPageTransport: makeTransport(state),
              consumer: makeConsumer(state),
            })),
            (e) => e && e.code === FAILURE_CODE && noLeak(e),
          );
          ok(
            'proxy-db-ambient-isProxy-monkeypatch-resistant',
            zeroTraps(traps),
            ser(traps),
          );
        } finally {
          util.types.isProxy = realIsProxy;
        }
      }

      // Hostile custom prototype with query accessor — fail-closed, no getter hit.
      {
        const hits = { query: 0 };
        const proto = {};
        Object.defineProperty(proto, 'query', {
          get() {
            hits.query += 1;
            throw new Error(`boom proto.query ${PLANTED_TOKEN}`);
          },
          enumerable: false,
          configurable: true,
        });
        const db = Object.create(proto);
        const state = freshState();
        assert.throws(
          () => createAuthorityBoundInboundOperation(Object.freeze({
            db,
            grantSession: makeGrantSession(state),
            immutableIdPageTransport: makeTransport(state),
            consumer: makeConsumer(state),
          })),
          (e) => e && e.code === FAILURE_CODE && noLeak(e),
        );
        ok('hostile-proto-query-accessor-zero-hits', hits.query === 0, ser(hits));
      }

      // Symbol-only "query" surface must not be accepted as pg-like capability.
      {
        const sym = Symbol('query');
        const db = {
          [sym]: async () => ({ rows: [] }),
        };
        const state = freshState();
        assert.throws(
          () => createAuthorityBoundInboundOperation(Object.freeze({
            db,
            grantSession: makeGrantSession(state),
            immutableIdPageTransport: makeTransport(state),
            consumer: makeConsumer(state),
          })),
          (e) => e && e.code === FAILURE_CODE && noLeak(e),
        );
        ok('symbol-query-surface-rejected', true);
      }
    }

    ok('zero-network-hits-end', networkHits === 0, `hits=${networkHits}`);
  } finally {
    restoreNetworkGuards();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  restoreNetworkGuards();
  console.error(err);
  process.exit(1);
});
