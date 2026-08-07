'use strict';

/**
 * verify:email-authority-bound-bounded-catchup-operation — hostile RED-GREEN gate.
 *
 * Bounded-catchup durable-subset seam on the authority-bound operation owner:
 *   resolveDelegatedReadAuthority → grant-session runWithAccessTokenOnce
 *   (callback) → ImmutableId bounded-catchup transport (frozen DTO ≤50) →
 *   authority-match → processInboundEmailBatch once (factory-fixed consumer).
 *
 * Public result only after consumer ack:
 *   status, durably_processed:true, observed_count, durable_identity_count,
 *   duplicate_in_batch_count, pages_fetched, truncated
 *
 * No network, routes, OAuth scope, DB migration, deploy, live Graph, or
 * grant/refresh duplication. Explicit: no durable cursor — >50 replay can
 * repeat newest 50 forever (not safe for runtime/route/cron/startup).
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
const OFFLINE_REL = 'scripts/lib/email-authority-bound-bounded-catchup-offline-composition.js';
const VERIFY_REL = 'scripts/verify-email-authority-bound-bounded-catchup-operation.js';
const DOC_REL = 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md';
const BATCH_REL = 'scripts/lib/email-inbound-batch-processor.js';
const EVENT_STORE_REL = 'scripts/lib/email-inbound-event-store.js';
const CATCHUP_TRANSPORT_REL = 'scripts/lib/email-microsoft-graph-immutableid-bounded-catchup-transport.js';
const EVENT_STORE_RUNTIME_REL =
  'scripts/lib/email-microsoft-delegated-inbound-event-store-sunset-staging-runtime-composition.js';
const DIAG_RUNTIME_REL =
  'scripts/lib/email-microsoft-delegated-inbound-diagnostic-sunset-staging-runtime-composition.js';
const ROUTES_REL = 'scripts/lib/staff-email-oauth-routes.js';
const STAFF_API_REL = 'scripts/staff-query-api.js';
const PKG_PATH = path.join(ROOT, 'package.json');
const DOC_PATH = path.join(ROOT, DOC_REL);
const OP_PATH = path.join(ROOT, OP_REL);
const OFFLINE_PATH = path.join(ROOT, OFFLINE_REL);

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RESOURCE = '22222222-2222-4222-8222-2222222222ab';
const FOREIGN_RESOURCE = '33333333-3333-4333-8333-3333333333cd';
const PLANTED_TOKEN = 'ya29.NEVER_LEAK_BOUNDED_CATCHUP_AT';
const PLANTED_SUBJECT = 'SUBJECT_PII_MUST_NOT_APPEAR_ON_CATCHUP_RESULT';
const PLANTED_ADDRESS = 'pii-mailbox-catchup-must-not-escape@example.com';
const PLANTED_MSG = 'AAMkAGI2-CATCHUP-PII-MSG';
const MSG_A = 'AAMkAGI2-CATCHUP-AAA';
const MSG_B = 'AAMkAGI2-CATCHUP-BBB';

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
  const hit = () => { networkHits += 1; throw new Error('NETWORK_FORBIDDEN_IN_BOUNDED_CATCHUP'); };
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
    conversation_id: 'AAQkAGConvCatchup=',
    internet_message_id: '<catchup.1@example.com>',
    ...patch,
  });
}

function makeNEnvelopes(n, opts = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const day = String(10 + (i % 20)).padStart(2, '0');
    out.push(envelope({
      provider_message_id: `AAMkAGI2-CATCHUP-${String(i).padStart(4, '0')}`,
      received_at: `2026-08-${day}T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
      subject: PLANTED_SUBJECT,
      provider_mailbox_id: opts.mailbox || RESOURCE,
      provider: opts.provider || 'microsoft_graph',
    }));
  }
  return Object.freeze(out);
}

/**
 * Exact frozen catchup transport DTO (matches BOUNDED_CATCHUP_RESULT_KEYS owner).
 * transport duplicate_count is internal — not public durable replay duplicate.
 */
function catchupDto({
  envelopes = Object.freeze([]),
  pages_fetched = 1,
  observed_count = null,
  unique_count = null,
  duplicate_count = 0,
  truncated = false,
} = {}) {
  const envs = Object.isFrozen(envelopes) ? envelopes : Object.freeze(envelopes.slice());
  const unique = unique_count != null ? unique_count : envs.length;
  const observed = observed_count != null ? observed_count : unique + duplicate_count;
  return Object.freeze({
    envelopes: envs,
    pages_fetched,
    observed_count: observed,
    unique_count: unique,
    duplicate_count,
    truncated: truncated === true,
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
      state.loanTokenAfter = loan && loan.accessToken;
    }
  };
  return Object.freeze({ runWithAccessTokenOnce: fn });
}

function makeCatchupTransport(state, opts = {}) {
  const fn = async function listBoundedCatchupInboundEnvelopes(input) {
    state.transportCalls += 1;
    state.transportOrder.push('transport');
    state.transportInputs.push({
      accessToken: input && input.accessToken,
      provider_mailbox_id: input && input.provider_mailbox_id,
      keys: input ? Object.keys(input).sort() : null,
      // Observe that we never receive nextLink instruction from operation.
      hasNextLinkKey: input ? Object.prototype.hasOwnProperty.call(input, 'nextLink') : null,
    });
    // Capture token copy presence for scrub assertion after return.
    state.lastGraphTokenAtCall = input && input.accessToken;
    if (opts.throw) throw new Error(PLANTED_TOKEN);
    if (opts.dto != null) return opts.dto;
    if (typeof opts.dtoFactory === 'function') return opts.dtoFactory(state);
    if (opts.mismatchMailbox) {
      return catchupDto({
        envelopes: Object.freeze([
          envelope({ provider_mailbox_id: FOREIGN_RESOURCE, provider_message_id: MSG_A }),
        ]),
        pages_fetched: 1,
        observed_count: 1,
        unique_count: 1,
        duplicate_count: 0,
        truncated: false,
      });
    }
    if (opts.foreignProvider) {
      return catchupDto({
        envelopes: Object.freeze([
          envelope({ provider: 'gmail_api', provider_message_id: MSG_A }),
        ]),
        pages_fetched: 1,
        observed_count: 1,
        unique_count: 1,
        duplicate_count: 0,
        truncated: false,
      });
    }
    // Default two-page-shaped success (unique 2, observed 3 with 1 transport dup).
    return catchupDto({
      envelopes: Object.freeze([
        envelope({ provider_message_id: MSG_A, subject: PLANTED_SUBJECT }),
        envelope({
          provider_message_id: MSG_B,
          received_at: '2026-08-05T12:00:00.000Z',
          subject: PLANTED_SUBJECT,
        }),
      ]),
      pages_fetched: 2,
      observed_count: 3,
      unique_count: 2,
      duplicate_count: 1,
      truncated: false,
    });
  };
  return Object.freeze({ listBoundedCatchupInboundEnvelopes: fn });
}

function makeConsumer(state, opts = {}) {
  return async function consumer(envelopes) {
    state.consumerCalls += 1;
    state.consumerOrder.push('consumer');
    state.consumerEnvelopeCounts.push(Array.isArray(envelopes) ? envelopes.length : -1);
    state.consumerBatches.push(
      Array.isArray(envelopes)
        ? envelopes.map((e) => e && e.provider_message_id)
        : null,
    );
    if (opts.throw) throw new Error(PLANTED_SUBJECT);
    if (opts.badAck) return opts.badAck;
    // Track "insert" vs "no-op" for replay convergence without claiming new rows
    // on the public surface (public field is durable_identity_count only).
    const ids = Array.isArray(envelopes)
      ? envelopes.map((e) => e.provider_message_id)
      : [];
    let newInserts = 0;
    for (const id of ids) {
      if (!state.seenIds.has(id)) {
        state.seenIds.add(id);
        newInserts += 1;
      }
    }
    state.insertClaims.push(newInserts);
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
    consumerBatches: [],
    retainedLoan: null,
    loanTokenAfter: undefined,
    lastGraphTokenAtCall: undefined,
    seenIds: new Set(),
    insertClaims: [],
  };
}

function buildCatchupOp(op, state, opts = {}) {
  const { db } = opts.dbPair || mockDbForAuthority(authorityDto());
  return op.createAuthorityBoundBoundedCatchupOperation(Object.freeze({
    db,
    grantSession: makeGrantSession(state, opts.grant || {}),
    immutableIdBoundedCatchupTransport: makeCatchupTransport(state, opts.transport || {}),
    consumer: makeConsumer(state, opts.consumer || {}),
  }));
}

async function main() {
  installNetworkGuards();
  try {
    const op = require('./lib/email-authority-bound-inbound-operation');
    const offline = require('./lib/email-authority-bound-bounded-catchup-offline-composition');
    const batch = require('./lib/email-inbound-batch-processor');
    const eventStore = require('./lib/email-inbound-event-store');
    const catchupTransport = require('./lib/email-microsoft-graph-immutableid-bounded-catchup-transport');

    const {
      FAILURE_CODE,
      RESULT_KEYS,
      DEPENDENCY_KEYS,
      TRANSPORT_KEYS,
      BOUNDED_CATCHUP_FAILURE_CODE,
      BOUNDED_CATCHUP_FAILURE_MESSAGE,
      BOUNDED_CATCHUP_DEPENDENCY_KEYS,
      BOUNDED_CATCHUP_TRANSPORT_KEYS,
      BOUNDED_CATCHUP_RESULT_KEYS,
      BOUNDED_CATCHUP_DTO_KEYS,
      BOUNDED_CATCHUP_MAX_ENVELOPES,
      BOUNDED_CATCHUP_MAX_PAGES,
      EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_RUNTIME_WIRED,
      EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_RUNTIME_WIRED,
      EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_PERSISTENCE_READY,
      EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_LOGGING_FORBIDDEN,
      EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_DUPLICATES_REFRESH_CUSTODY,
      EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_HAS_DURABLE_CURSOR,
      EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_SAFE_FOR_RUNTIME_ROUTE_CRON,
      createAuthorityBoundInboundOperation,
      createAuthorityBoundBoundedCatchupOperation,
    } = op;

    // ── Static / wiring ───────────────────────────────────────────────────
    ok('exports-catchup-create', typeof createAuthorityBoundBoundedCatchupOperation === 'function');
    ok('exports-single-page-create', typeof createAuthorityBoundInboundOperation === 'function');
    ok('single-page-runtime-unwired', EMAIL_AUTHORITY_BOUND_INBOUND_OPERATION_RUNTIME_WIRED === false);
    ok('catchup-runtime-unwired', EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_RUNTIME_WIRED === false);
    ok('catchup-not-persistence-ready', EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_PERSISTENCE_READY === false);
    ok('catchup-logging-forbidden', EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_LOGGING_FORBIDDEN === true);
    ok(
      'catchup-no-refresh-custody-dup',
      EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_DUPLICATES_REFRESH_CUSTODY === false,
    );
    ok(
      'no-durable-cursor',
      EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_HAS_DURABLE_CURSOR === false,
    );
    ok(
      'not-safe-for-runtime-route-cron',
      EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_SAFE_FOR_RUNTIME_ROUTE_CRON === false,
    );
    ok(
      'single-page-dependency-keys-preserved',
      DEPENDENCY_KEYS.join(',') === 'db,grantSession,immutableIdPageTransport,consumer',
    );
    ok(
      'single-page-transport-keys-preserved',
      TRANSPORT_KEYS.join(',') === 'listNormalizedInboundEnvelopes',
    );
    ok(
      'single-page-result-keys-preserved',
      RESULT_KEYS.join(',') === 'status,input_count,delivered_count,duplicate_count',
    );
    ok(
      'catchup-dependency-keys',
      BOUNDED_CATCHUP_DEPENDENCY_KEYS.join(',')
        === 'db,grantSession,immutableIdBoundedCatchupTransport,consumer',
    );
    ok(
      'catchup-transport-keys',
      BOUNDED_CATCHUP_TRANSPORT_KEYS.join(',') === 'listBoundedCatchupInboundEnvelopes',
    );
    ok(
      'catchup-result-keys-exact',
      BOUNDED_CATCHUP_RESULT_KEYS.join(',')
        === 'status,durably_processed,observed_count,durable_identity_count,'
          + 'duplicate_in_batch_count,pages_fetched,truncated',
    );
    ok(
      'catchup-dto-keys-exact',
      BOUNDED_CATCHUP_DTO_KEYS.join(',')
        === 'envelopes,pages_fetched,observed_count,unique_count,duplicate_count,truncated',
    );
    ok(
      'catchup-max-envelopes-50',
      BOUNDED_CATCHUP_MAX_ENVELOPES === 50
        && BOUNDED_CATCHUP_MAX_ENVELOPES === batch.EMAIL_INBOUND_BATCH_MAX
        && BOUNDED_CATCHUP_MAX_PAGES === 10
        && catchupTransport.BOUNDED_CATCHUP_MAX_MESSAGES === 50,
    );
    ok(
      'failure-sanitized',
      BOUNDED_CATCHUP_FAILURE_CODE === 'authority_bound_bounded_catchup_failed'
        && typeof BOUNDED_CATCHUP_FAILURE_MESSAGE === 'string'
        && !BOUNDED_CATCHUP_FAILURE_MESSAGE.includes('token')
        && !BOUNDED_CATCHUP_FAILURE_MESSAGE.includes('Bearer')
        && noLeak(BOUNDED_CATCHUP_FAILURE_MESSAGE),
    );

    const src = fs.readFileSync(OP_PATH, 'utf8');
    ok(
      'shares-private-authority-and-grant-session',
      /resolveAcceptedAuthority/.test(src)
        && /runWithGrantSession/.test(src)
        && /runTokenScopedTransportAndProcess/.test(src)
        && /authorityBoundCatchupSessionConsumer/.test(src)
        && /authorityBoundSessionConsumer/.test(src)
        && /createAuthorityBoundBoundedCatchupOperation/.test(src)
        && /createAuthorityBoundInboundOperation/.test(src),
    );
    ok(
      'no-grant-refresh-duplication',
      !/tryAcquireDelegatedGrantLease/.test(src)
        && !/openDelegatedGrantUnderLease/.test(src)
        && !/commitDelegatedGrantRotation/.test(src)
        && !/exchangeRefreshToken/.test(src)
        && !/createMicrosoftRefreshTokenRequestService/.test(src)
        && !/createDelegatedGrantAccessSession/.test(src),
    );
    ok(
      'no-nextLink-follow-or-store',
      !/pendingNextLink/.test(src)
        && !/validateCatchupFollowNextLink/.test(src)
        && !/requestPathOverride/.test(src)
        && !/seenCanonicalContinuations/.test(src)
        // May mention nextLink only to reject/forbid — never follow or assign.
        && !/pendingNextLink\s*=/.test(src)
        && !/\.nextLink\s*=/.test(src)
        && /never inspect\/follow\/store nextLink|Never inspects, follows, or stores nextLink/i.test(src)
        && /hasOwnProperty\.call\(value,\s*'nextLink'\)/.test(src),
    );
    ok(
      'no-http-duplicate',
      !/https\.request/.test(src)
        && !/createMicrosoftGraphImmutableIdBoundedCatchupTransport/.test(src)
        && !/createMicrosoftTokenHttpTransport/.test(src),
    );
    ok(
      'duplicate_in_batch_from_batch_not_transport',
      /duplicate_in_batch_count:\s*batchDuplicateCount/.test(src)
        || /duplicate_in_batch_count:\s*batchDuplicateCount/.test(src.replace(/\s+/g, '')),
    );
    // Accept either spaced form.
    ok(
      'durable_identity_from_delivered',
      /durable_identity_count:\s*deliveredCount/.test(src),
    );
    ok(
      'no-inserted-row-vocabulary',
      !/newly_inserted|inserted_count|new_row_count|rows_inserted/.test(src),
    );
    {
      const catchupIdx = src.indexOf('authorityBoundCatchupSessionConsumer');
      const catchupSlice = catchupIdx >= 0 ? src.slice(catchupIdx, catchupIdx + 4000) : '';
      const finIdx = catchupSlice.lastIndexOf('} finally {');
      // Shared helper finally lives in runTokenScopedTransportAndProcess.
      const sharedIdx = src.indexOf('function runTokenScopedTransportAndProcess');
      const sharedSlice = sharedIdx >= 0 ? src.slice(sharedIdx, sharedIdx + 2500) : '';
      const sharedFin = sharedSlice.lastIndexOf('} finally {');
      const finBody = sharedFin >= 0 ? sharedSlice.slice(sharedFin, sharedFin + 600) : '';
      const graphScrubIdx = finBody.search(/graphInput\.accessToken\s*=\s*null/);
      const ownerNullIdx = finBody.search(/accessTokenOwner\s*=\s*null/);
      ok(
        'catchup-callback-uses-shared-token-scrub',
        catchupIdx >= 0
          && /runTokenScopedTransportAndProcess/.test(catchupSlice)
          && graphScrubIdx >= 0
          && ownerNullIdx >= 0
          && graphScrubIdx < ownerNullIdx
          && /loan\.accessToken\s*=\s*null/.test(finBody),
        `graph=${graphScrubIdx} owner=${ownerNullIdx}`,
      );
    }

    // Production compositions stay on single-page factory only.
    for (const [label, rel] of [
      ['event-store-runtime', EVENT_STORE_RUNTIME_REL],
      ['diagnostic-runtime', DIAG_RUNTIME_REL],
      ['oauth-routes', ROUTES_REL],
      ['staff-api', STAFF_API_REL],
    ]) {
      const p = path.join(ROOT, rel);
      if (!fs.existsSync(p)) {
        ok(`production-${label}-absent-ok`, true);
        continue;
      }
      const body = fs.readFileSync(p, 'utf8');
      ok(
        `production-${label}-no-catchup-factory`,
        !/createAuthorityBoundBoundedCatchupOperation|runAuthorityBoundBoundedCatchup|BOUNDED_CATCHUP_DEPENDENCY_KEYS/.test(body),
      );
      if (label === 'event-store-runtime' || label === 'diagnostic-runtime') {
        ok(
          `production-${label}-still-single-page`,
          /createAuthorityBoundInboundOperation/.test(body),
        );
      }
    }

    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    ok(
      'package-script-catchup',
      pkg.scripts
        && pkg.scripts['verify:email-authority-bound-bounded-catchup-operation']
          === 'node scripts/verify-email-authority-bound-bounded-catchup-operation.js',
    );
    ok(
      'package-script-single-page-preserved',
      pkg.scripts['verify:email-authority-bound-inbound-operation']
        === 'node scripts/verify-email-authority-bound-inbound-operation.js',
    );

    if (fs.existsSync(DOC_PATH)) {
      const doc = fs.readFileSync(DOC_PATH, 'utf8');
      ok(
        'doc-mentions-bounded-catchup-operation',
        /authority-bound.*bounded.?catchup|bounded-catchup.*operation|durable_identity_count/i.test(doc),
      );
      ok(
        'doc-documents-no-cursor-replay-risk',
        />50|newest 50|durable cursor|no runtime\/route\/cron/i.test(doc),
      );
    }

    // ── Factory hostile deps ──────────────────────────────────────────────
    assert.throws(
      () => createAuthorityBoundBoundedCatchupOperation(null),
      (e) => e && e.code === BOUNDED_CATCHUP_FAILURE_CODE && noLeak(e),
    );
    ok('factory-null-throws', true);

    assert.throws(
      () => createAuthorityBoundBoundedCatchupOperation(Object.freeze({
        db: { query: async () => ({ rows: [] }) },
        grantSession: Object.freeze({
          runWithAccessTokenOnce: async () => Object.freeze({ ok: true, grant_generation: 1, value: null }),
        }),
        immutableIdBoundedCatchupTransport: Object.freeze({
          listBoundedCatchupInboundEnvelopes: async () => catchupDto(),
        }),
        // missing consumer
      })),
      (e) => e && e.code === BOUNDED_CATCHUP_FAILURE_CODE,
    );
    ok('factory-missing-consumer-throws', true);

    assert.throws(
      () => createAuthorityBoundBoundedCatchupOperation(Object.freeze({
        db: { query: async () => ({ rows: [] }) },
        grantSession: Object.freeze({
          runWithAccessTokenOnce: async () => Object.freeze({ ok: true, grant_generation: 1, value: null }),
        }),
        // Wrong transport key (single-page name) must not be accepted.
        immutableIdPageTransport: Object.freeze({
          listNormalizedInboundEnvelopes: async () => Object.freeze([]),
        }),
        consumer: async () => ({ acknowledged: true }),
      })),
      (e) => e && e.code === BOUNDED_CATCHUP_FAILURE_CODE,
    );
    ok('factory-single-page-transport-key-rejected', true);

    {
      const proxyConsumer = new Proxy(async () => ({ acknowledged: true }), {
        apply() { throw new Error(PLANTED_TOKEN); },
      });
      assert.throws(
        () => createAuthorityBoundBoundedCatchupOperation(Object.freeze({
          db: { query: async () => ({ rows: [] }) },
          grantSession: Object.freeze({
            runWithAccessTokenOnce: async () => Object.freeze({
              ok: true, grant_generation: 1, value: null,
            }),
          }),
          immutableIdBoundedCatchupTransport: Object.freeze({
            listBoundedCatchupInboundEnvelopes: async () => catchupDto(),
          }),
          consumer: proxyConsumer,
        })),
        (e) => e && e.code === BOUNDED_CATCHUP_FAILURE_CODE && noLeak(e),
      );
      ok('factory-proxy-consumer-throws', true);
    }

    // ── GREEN: empty ──────────────────────────────────────────────────────
    {
      const state = freshState();
      const service = buildCatchupOp(op, state, {
        transport: {
          dto: catchupDto({
            envelopes: Object.freeze([]),
            pages_fetched: 1,
            observed_count: 0,
            unique_count: 0,
            duplicate_count: 0,
            truncated: false,
          }),
        },
      });
      const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok('empty-ok', res && res.ok === true, ser(res));
      ok(
        'empty-counts',
        res.ok
          && res.value.status === 'processed'
          && res.value.durably_processed === true
          && res.value.observed_count === 0
          && res.value.durable_identity_count === 0
          && res.value.duplicate_in_batch_count === 0
          && res.value.pages_fetched === 1
          && res.value.truncated === false
          && Object.isFrozen(res)
          && Object.isFrozen(res.value)
          && Object.keys(res.value).join(',') === BOUNDED_CATCHUP_RESULT_KEYS.join(','),
        ser(res),
      );
      ok(
        'empty-consumer-once',
        state.consumerCalls === 1 && state.consumerEnvelopeCounts[0] === 0,
        ser(state.consumerEnvelopeCounts),
      );
      ok('empty-identity-free', res.ok && noLeak(res) && !('envelopes' in res.value));
    }

    // ── GREEN: two pages (pages_fetched=2, transport dups not public) ─────
    {
      const state = freshState();
      const service = buildCatchupOp(op, state);
      const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok('two-page-ok', res && res.ok === true, ser(res));
      ok(
        'two-page-dto-invariants',
        res.ok
          && res.value.status === 'processed'
          && res.value.durably_processed === true
          && res.value.observed_count === 3
          && res.value.durable_identity_count === 2
          && res.value.duplicate_in_batch_count === 0
          && res.value.pages_fetched === 2
          && res.value.truncated === false
          && Object.keys(res.value).join(',') === BOUNDED_CATCHUP_RESULT_KEYS.join(','),
        ser(res),
      );
      ok(
        'transport-dup-not-public-duplicate_in_batch',
        res.ok && res.value.duplicate_in_batch_count === 0,
        // transport DTO had duplicate_count:1; must not surface as batch dup
        ser(res),
      );
      ok(
        'two-page-call-order-once',
        state.grantCalls === 1
          && state.transportCalls === 1
          && state.consumerCalls === 1
          && state.grantOrder[0] === 'grant'
          && state.transportOrder[0] === 'transport'
          && state.consumerOrder[0] === 'consumer',
        ser(state),
      );
      ok(
        'transport-authority-mailbox-and-token',
        state.transportInputs.length === 1
          && state.transportInputs[0].provider_mailbox_id === RESOURCE
          && state.transportInputs[0].accessToken === PLANTED_TOKEN
          && state.transportInputs[0].keys.join(',') === 'accessToken,provider_mailbox_id'
          && state.transportInputs[0].hasNextLinkKey === false,
        ser(state.transportInputs[0]),
      );
      ok(
        'token-scrubbed-on-success',
        state.retainedLoan
          && state.loanTokenAfter === null
          && noLeak(res),
        ser({ loan: state.loanTokenAfter }),
      );
      ok('two-page-no-network', networkHits === 0);
    }

    // ── GREEN: 50 identities one batch/transaction ────────────────────────
    {
      const state = freshState();
      const envs = makeNEnvelopes(50);
      const service = buildCatchupOp(op, state, {
        transport: {
          dto: catchupDto({
            envelopes: envs,
            pages_fetched: 10,
            observed_count: 50,
            unique_count: 50,
            duplicate_count: 0,
            truncated: false,
          }),
        },
      });
      const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok('fifty-ok', res && res.ok === true, ser(res));
      ok(
        'fifty-one-batch',
        res.ok
          && res.value.durable_identity_count === 50
          && res.value.observed_count === 50
          && res.value.duplicate_in_batch_count === 0
          && res.value.pages_fetched === 10
          && state.consumerCalls === 1
          && state.consumerEnvelopeCounts[0] === 50
          && state.transportCalls === 1,
        ser({ res: res.value, consumer: state.consumerEnvelopeCounts }),
      );
    }

    // ── GREEN: truncated true subset success ──────────────────────────────
    {
      const state = freshState();
      const envs = makeNEnvelopes(50);
      const service = buildCatchupOp(op, state, {
        transport: {
          dto: catchupDto({
            envelopes: envs,
            pages_fetched: 10,
            observed_count: 50,
            unique_count: 50,
            duplicate_count: 0,
            truncated: true,
          }),
        },
      });
      const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok(
        'truncated-subset-success',
        res.ok === true
          && res.value.truncated === true
          && res.value.durably_processed === true
          && res.value.durable_identity_count === 50
          && res.value.status === 'processed'
          && noLeak(res),
        ser(res),
      );
      ok(
        'truncated-true-not-watermark-claim-in-keys',
        res.ok
          && !('watermark' in res.value)
          && !('cursor' in res.value)
          && !('delta_link' in res.value)
          && !('mailbox_complete' in res.value),
        ser(res.value),
      );
    }

    // ── truncated:false is not a durable watermark (documented + keys) ────
    {
      const state = freshState();
      const service = buildCatchupOp(op, state, {
        transport: {
          dto: catchupDto({
            envelopes: Object.freeze([envelope()]),
            pages_fetched: 1,
            observed_count: 1,
            unique_count: 1,
            duplicate_count: 0,
            truncated: false,
          }),
        },
      });
      const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok(
        'truncated-false-not-watermark',
        res.ok
          && res.value.truncated === false
          && EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_HAS_DURABLE_CURSOR === false
          && !('watermark' in res.value)
          && !('cursor' in res.value),
        ser(res),
      );
    }

    // ── RED: over 50 envelopes ────────────────────────────────────────────
    {
      const state = freshState();
      const envs = makeNEnvelopes(51);
      const service = buildCatchupOp(op, state, {
        transport: {
          dto: catchupDto({
            envelopes: envs,
            pages_fetched: 11,
            observed_count: 51,
            unique_count: 51,
            duplicate_count: 0,
            truncated: true,
          }),
        },
      });
      const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok(
        'over50-rejected-zero-consumer',
        res.ok === false
          && res.error === BOUNDED_CATCHUP_FAILURE_CODE
          && state.consumerCalls === 0
          && state.transportCalls === 1
          && noLeak(res),
        ser({ res, consumer: state.consumerCalls }),
      );
    }

    // ── RED: count equation break (observed ≠ unique + transport_dup) ─────
    {
      const state = freshState();
      const service = buildCatchupOp(op, state, {
        transport: {
          dto: catchupDto({
            envelopes: Object.freeze([envelope()]),
            pages_fetched: 1,
            observed_count: 99,
            unique_count: 1,
            duplicate_count: 0,
            truncated: false,
          }),
        },
      });
      const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok(
        'count-equation-break-rejected',
        res.ok === false && state.consumerCalls === 0 && noLeak(res),
        ser(res),
      );
    }

    // ── RED: unique_count ≠ envelopes.length ──────────────────────────────
    {
      const state = freshState();
      const service = buildCatchupOp(op, state, {
        transport: {
          dto: catchupDto({
            envelopes: Object.freeze([envelope(), envelope({ provider_message_id: MSG_B })]),
            pages_fetched: 1,
            observed_count: 2,
            unique_count: 1,
            duplicate_count: 1,
            truncated: false,
          }),
        },
      });
      const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok(
        'unique-length-mismatch-rejected',
        res.ok === false && state.consumerCalls === 0 && noLeak(res),
        ser(res),
      );
    }

    // ── RED: malformed / proxy / accessor / symbol / nonenumerable / unfrozen ─
    {
      const cases = [];

      // unfrozen DTO
      cases.push(['unfrozen-dto', {
        envelopes: Object.freeze([envelope()]),
        pages_fetched: 1,
        observed_count: 1,
        unique_count: 1,
        duplicate_count: 0,
        truncated: false,
      }]);

      // proxy DTO
      cases.push(['proxy-dto', new Proxy(catchupDto({
        envelopes: Object.freeze([envelope()]),
        pages_fetched: 1,
        observed_count: 1,
        unique_count: 1,
        duplicate_count: 0,
        truncated: false,
      }), {
        get(t, p) { return Reflect.get(t, p); },
      })]);

      // accessor key
      {
        const o = {};
        for (const k of ['envelopes', 'pages_fetched', 'observed_count', 'unique_count', 'duplicate_count', 'truncated']) {
          if (k === 'observed_count') {
            Object.defineProperty(o, k, {
              get() { return 1; },
              enumerable: true,
            });
          } else if (k === 'envelopes') {
            Object.defineProperty(o, k, {
              value: Object.freeze([envelope()]),
              enumerable: true,
              writable: true,
              configurable: true,
            });
          } else if (k === 'pages_fetched' || k === 'unique_count') {
            Object.defineProperty(o, k, {
              value: 1, enumerable: true, writable: true, configurable: true,
            });
          } else if (k === 'duplicate_count') {
            Object.defineProperty(o, k, {
              value: 0, enumerable: true, writable: true, configurable: true,
            });
          } else {
            Object.defineProperty(o, k, {
              value: false, enumerable: true, writable: true, configurable: true,
            });
          }
        }
        cases.push(['accessor-dto', Object.freeze(o)]);
      }

      // symbol key
      {
        const o = catchupDto({
          envelopes: Object.freeze([envelope()]),
          pages_fetched: 1,
          observed_count: 1,
          unique_count: 1,
          duplicate_count: 0,
          truncated: false,
        });
        // can't add to frozen — build unfrozen then freeze with symbol
        const withSym = {
          envelopes: Object.freeze([envelope()]),
          pages_fetched: 1,
          observed_count: 1,
          unique_count: 1,
          duplicate_count: 0,
          truncated: false,
        };
        withSym[Symbol('x')] = PLANTED_TOKEN;
        cases.push(['symbol-key-dto', Object.freeze(withSym)]);
      }

      // nonenumerable key
      {
        const o = {
          envelopes: Object.freeze([envelope()]),
          pages_fetched: 1,
          observed_count: 1,
          unique_count: 1,
          duplicate_count: 0,
          truncated: false,
        };
        Object.defineProperty(o, 'hidden', {
          value: PLANTED_TOKEN, enumerable: false, writable: true, configurable: true,
        });
        // Reflect.ownKeys includes nonenumerable — length will be 7 → reject
        cases.push(['nonenumerable-extra', Object.freeze(o)]);
      }

      // nextLink poison key
      {
        const o = {
          envelopes: Object.freeze([envelope()]),
          pages_fetched: 1,
          observed_count: 1,
          unique_count: 1,
          duplicate_count: 0,
          truncated: false,
          nextLink: 'https://graph.microsoft.com/v1.0/evil',
        };
        cases.push(['nextLink-extra-key', Object.freeze(o)]);
      }

      // unfrozen envelopes array inside an otherwise exact frozen DTO
      {
        const unfrozenEnvs = [envelope()];
        cases.push(['unfrozen-envelopes', Object.freeze({
          envelopes: unfrozenEnvs,
          pages_fetched: 1,
          observed_count: 1,
          unique_count: 1,
          duplicate_count: 0,
          truncated: false,
        })]);
      }

      for (const [label, dto] of cases) {
        const state = freshState();
        const service = buildCatchupOp(op, state, { transport: { dto } });
        const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
        ok(
          `malformed-${label}-zero-consumer`,
          res.ok === false
            && res.error === BOUNDED_CATCHUP_FAILURE_CODE
            && state.consumerCalls === 0
            && noLeak(res),
          ser({ res, consumer: state.consumerCalls }),
        );
      }

      // A frozen array may still contain an accessor index. Reject from the
      // descriptor without executing attacker code or reaching the consumer.
      {
        let getterHits = 0;
        const hostileEnvelopes = [];
        Object.defineProperty(hostileEnvelopes, '0', {
          get() {
            getterHits += 1;
            return envelope();
          },
          enumerable: true,
          configurable: true,
        });
        Object.freeze(hostileEnvelopes);
        const dto = catchupDto({
          envelopes: hostileEnvelopes,
          pages_fetched: 1,
          observed_count: 1,
          unique_count: 1,
          duplicate_count: 0,
          truncated: false,
        });
        const state = freshState();
        const service = buildCatchupOp(op, state, { transport: { dto } });
        const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
        ok(
          'malformed-envelope-index-accessor-zero-hits-zero-consumer',
          res.ok === false
            && res.error === BOUNDED_CATCHUP_FAILURE_CODE
            && getterHits === 0
            && state.consumerCalls === 0
            && noLeak(res),
          ser({ res, getterHits, consumer: state.consumerCalls }),
        );
      }
    }

    // ── RED: foreign provider / mailbox ───────────────────────────────────
    {
      const state = freshState();
      const service = buildCatchupOp(op, state, { transport: { mismatchMailbox: true } });
      const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok(
        'foreign-mailbox-zero-consumer',
        res.ok === false && state.consumerCalls === 0 && noLeak(res),
        ser(res),
      );
    }
    {
      const state = freshState();
      const service = buildCatchupOp(op, state, { transport: { foreignProvider: true } });
      const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok(
        'foreign-provider-zero-consumer',
        res.ok === false && state.consumerCalls === 0 && noLeak(res),
        ser(res),
      );
    }

    // ── RED: poison envelope → zero consumer (batch validates all-or-nothing) ─
    {
      const state = freshState();
      const poison = Object.freeze({
        provider: 'microsoft_graph',
        provider_mailbox_id: RESOURCE,
        provider_message_id: MSG_A,
        // missing required fields / bad shape → batch rejects before consumer
        received_at: 'not-a-date',
        subject: PLANTED_SUBJECT,
        sender_display_name: 'x',
        sender_address: 'bad',
        is_read: false,
        conversation_id: 'c',
        internet_message_id: '<x@y>',
      });
      const service = buildCatchupOp(op, state, {
        transport: {
          dto: catchupDto({
            envelopes: Object.freeze([poison]),
            pages_fetched: 1,
            observed_count: 1,
            unique_count: 1,
            duplicate_count: 0,
            truncated: false,
          }),
        },
      });
      const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok(
        'poison-envelope-zero-consumer',
        res.ok === false
          && state.consumerCalls === 0
          && state.transportCalls === 1
          && noLeak(res),
        ser({ res, consumer: state.consumerCalls }),
      );
    }

    // ── RED: transport failure → zero consumer + token scrub ──────────────
    {
      const state = freshState();
      const service = buildCatchupOp(op, state, { transport: { throw: true } });
      const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok(
        'transport-fail-zero-consumer',
        res.ok === false
          && res.error === BOUNDED_CATCHUP_FAILURE_CODE
          && state.consumerCalls === 0
          && state.transportCalls === 1
          && noLeak(res),
        ser(res),
      );
      ok(
        'transport-fail-token-scrubbed',
        state.loanTokenAfter === null || state.loanTokenAfter === undefined,
        ser({ loan: state.loanTokenAfter }),
      );
    }

    // ── RED: commit/consumer failure sanitized ────────────────────────────
    {
      const state = freshState();
      const service = buildCatchupOp(op, state, { consumer: { throw: true } });
      const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok(
        'commit-fail-sanitized',
        res.ok === false
          && res.error === BOUNDED_CATCHUP_FAILURE_CODE
          && state.consumerCalls === 1
          && noLeak(res)
          && !String(ser(res)).includes(PLANTED_SUBJECT),
        ser(res),
      );
      ok(
        'commit-fail-token-scrubbed',
        state.loanTokenAfter === null || state.loanTokenAfter === undefined,
        ser({ loan: state.loanTokenAfter }),
      );
    }

    // ── Replay same 50 converges without new-row claim ────────────────────
    {
      const envs = makeNEnvelopes(50);
      const dto = catchupDto({
        envelopes: envs,
        pages_fetched: 10,
        observed_count: 50,
        unique_count: 50,
        duplicate_count: 0,
        truncated: true,
      });
      // Shared consumer state across two one-shot ops (simulates durable store).
      const shared = freshState();
      const consumer = makeConsumer(shared);
      const { db } = mockDbForAuthority(authorityDto());

      const op1 = createAuthorityBoundBoundedCatchupOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(shared),
        immutableIdBoundedCatchupTransport: makeCatchupTransport(shared, { dto }),
        consumer,
      }));
      const r1 = await op1.runAuthorityBoundBoundedCatchup(baseInput());

      const op2 = createAuthorityBoundBoundedCatchupOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(shared),
        immutableIdBoundedCatchupTransport: makeCatchupTransport(shared, { dto }),
        consumer,
      }));
      const r2 = await op2.runAuthorityBoundBoundedCatchup(baseInput());

      ok(
        'replay-same50-both-ok',
        r1.ok && r2.ok
          && r1.value.durable_identity_count === 50
          && r2.value.durable_identity_count === 50
          && r1.value.durably_processed === true
          && r2.value.durably_processed === true,
        ser({ r1: r1.value, r2: r2.value }),
      );
      ok(
        'replay-no-new-row-vocabulary',
        !('inserted_count' in r1.value)
          && !('newly_inserted' in r1.value)
          && !('new_row_count' in r2.value)
          && r1.value.durable_identity_count === 50
          && r2.value.durable_identity_count === 50,
        ser({ keys: Object.keys(r1.value), inserts: shared.insertClaims }),
      );
      ok(
        'replay-second-inserts-zero-but-durable-count-stable',
        shared.insertClaims.length === 2
          && shared.insertClaims[0] === 50
          && shared.insertClaims[1] === 0
          && r2.value.durable_identity_count === 50,
        ser(shared.insertClaims),
      );
    }

    // ── Explicit: >50 replay can repeat newest 50 forever (no cursor) ─────
    {
      // Three independent runs always get the same newest-50 truncated subset.
      const newest50 = makeNEnvelopes(50);
      const dto = catchupDto({
        envelopes: newest50,
        pages_fetched: 10,
        observed_count: 50,
        unique_count: 50,
        duplicate_count: 0,
        truncated: true,
      });
      const ids = [];
      for (let i = 0; i < 3; i += 1) {
        const state = freshState();
        const service = buildCatchupOp(op, state, { transport: { dto } });
        const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
        ok(
          `gt50-replay-run-${i}-truncated-newest50`,
          res.ok
            && res.value.truncated === true
            && res.value.durable_identity_count === 50
            && state.consumerEnvelopeCounts[0] === 50,
          ser(res.value),
        );
        ids.push(state.consumerBatches[0] && state.consumerBatches[0].join(','));
      }
      ok(
        'gt50-replay-same-newest50-forever',
        ids[0] === ids[1] && ids[1] === ids[2]
          && EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_HAS_DURABLE_CURSOR === false
          && EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_SAFE_FOR_RUNTIME_ROUTE_CRON === false,
        ser(ids.map((s) => s && s.slice(0, 40))),
      );
      ok(
        'gt50-no-runtime-wire-in-source',
        !/SAFE_FOR_RUNTIME_ROUTE_CRON\s*=\s*true/.test(src)
          && /EMAIL_AUTHORITY_BOUND_BOUNDED_CATCHUP_HAS_DURABLE_CURSOR = false/.test(src),
      );
    }

    // ── One-shot catchup service ──────────────────────────────────────────
    {
      const state = freshState();
      const service = buildCatchupOp(op, state);
      const first = await service.runAuthorityBoundBoundedCatchup(baseInput());
      const second = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok(
        'catchup-one-shot',
        first.ok === true
          && second.ok === false
          && second.error === BOUNDED_CATCHUP_FAILURE_CODE
          && state.grantCalls === 1
          && state.transportCalls === 1
          && state.consumerCalls === 1,
        ser({ first: first.ok, second, state }),
      );
    }

    // ── Original single-page still exact max-5 + result shape ─────────────
    {
      const state = {
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
      const { db } = mockDbForAuthority(authorityDto());
      const pageTransport = Object.freeze({
        listNormalizedInboundEnvelopes: async function listNormalizedInboundEnvelopes(input) {
          state.transportCalls += 1;
          state.transportInputs.push({
            accessToken: input && input.accessToken,
            provider_mailbox_id: input && input.provider_mailbox_id,
          });
          return Object.freeze([
            envelope({ provider_message_id: MSG_A }),
            envelope({
              provider_message_id: MSG_B,
              received_at: '2026-08-05T12:00:00.000Z',
            }),
          ]);
        },
      });
      const grantSession = makeGrantSession(state);
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession,
        immutableIdPageTransport: pageTransport,
        consumer: async (envelopes) => {
          state.consumerCalls += 1;
          state.consumerEnvelopeCounts.push(envelopes.length);
          return { acknowledged: true };
        },
      }));
      const res = await service.runAuthorityBoundInbound(baseInput());
      ok(
        'single-page-still-max5-shape',
        res.ok === true
          && res.value.status === 'processed'
          && res.value.input_count === 2
          && res.value.delivered_count === 2
          && res.value.duplicate_count === 0
          && Object.keys(res.value).join(',') === 'status,input_count,delivered_count,duplicate_count'
          && !('durably_processed' in res.value)
          && !('durable_identity_count' in res.value)
          && !('pages_fetched' in res.value)
          && !('truncated' in res.value)
          && state.consumerEnvelopeCounts[0] === 2
          && noLeak(res),
        ser(res),
      );
    }

    // ── Single-page rejects >5 envelopes still ────────────────────────────
    {
      const state = {
        grantCalls: 0,
        transportCalls: 0,
        consumerCalls: 0,
        grantOrder: [],
        transportOrder: [],
        consumerOrder: [],
        grantInputs: [],
        transportInputs: [],
        retainedLoan: null,
        loanTokenAfter: undefined,
      };
      const { db } = mockDbForAuthority(authorityDto());
      const pageTransport = Object.freeze({
        listNormalizedInboundEnvelopes: async () => makeNEnvelopes(6),
      });
      const service = createAuthorityBoundInboundOperation(Object.freeze({
        db,
        grantSession: makeGrantSession(state),
        immutableIdPageTransport: pageTransport,
        consumer: async () => {
          state.consumerCalls += 1;
          return { acknowledged: true };
        },
      }));
      const res = await service.runAuthorityBoundInbound(baseInput());
      ok(
        'single-page-still-rejects-over5',
        res.ok === false
          && res.error === FAILURE_CODE
          && state.consumerCalls === 0,
        ser(res),
      );
    }

    // ── Offline composition: event-store consumer sole SQL owner ──────────
    {
      ok(
        'offline-import-inert-flag',
        offline.EMAIL_BOUNDED_CATCHUP_OFFLINE_COMPOSITION_IMPORT_INERT === true
          && offline.EMAIL_BOUNDED_CATCHUP_OFFLINE_COMPOSITION_RUNTIME_WIRED === false,
      );
      ok(
        'offline-composition-dependency-keys',
        offline.COMPOSITION_DEPENDENCY_KEYS.join(',')
          === 'db,grantSession,immutableIdBoundedCatchupTransport,withTransactionClient',
      );

      const offlineSrc = fs.readFileSync(OFFLINE_PATH, 'utf8');
      ok(
        'offline-uses-event-store-consumer',
        /createDurableInboundEventStoreConsumer/.test(offlineSrc)
          && /createAuthorityBoundBoundedCatchupOperation/.test(offlineSrc)
          && !/INSERT\s+INTO/i.test(offlineSrc)
          && !/BEGIN/i.test(offlineSrc)
          && !/COMMIT/i.test(offlineSrc),
      );
      ok(
        'event-store-still-sole-sql-owner',
        typeof eventStore.createDurableInboundEventStoreConsumer === 'function'
          && eventStore.EMAIL_INBOUND_EVENT_STORE_RUNTIME_WIRED === false
          && /INSERT/i.test(fs.readFileSync(path.join(ROOT, EVENT_STORE_REL), 'utf8')),
      );

      // Functional offline composition with mock withTransactionClient.
      const state = freshState();
      const { db } = mockDbForAuthority(authorityDto());
      let txnCalls = 0;
      const withTransactionClient = async (fn) => {
        txnCalls += 1;
        // Minimal exclusive client mock — event store will try SQL; we short-circuit
        // by providing a consumer path that succeeds via a real event-store consumer
        // only if SQL works. For offline unit test, intercept: use a spy consumer
        // through a thin wrapper is not possible since composition creates consumer.
        // Instead: provide a withTransactionClient that runs a client whose query
        // handles BEGIN/INSERT/COMMIT for one identity.
        const client = {
          async query(text) {
            const t = String(text || '');
            if (/^\s*BEGIN/i.test(t)) return { rows: [] };
            if (/^\s*COMMIT/i.test(t)) return { rows: [] };
            if (/^\s*ROLLBACK/i.test(t)) return { rows: [] };
            if (/INSERT/i.test(t)) return { rowCount: 1, rows: [] };
            return { rows: [] };
          },
        };
        return fn(client);
      };

      const composition = offline.createOfflineAuthorityBoundBoundedCatchupComposition(
        Object.freeze({
          db,
          grantSession: makeGrantSession(state),
          immutableIdBoundedCatchupTransport: makeCatchupTransport(state, {
            dto: catchupDto({
              envelopes: Object.freeze([
                envelope({ provider_message_id: MSG_A }),
                envelope({
                  provider_message_id: MSG_B,
                  received_at: '2026-08-05T12:00:00.000Z',
                }),
              ]),
              pages_fetched: 2,
              observed_count: 2,
              unique_count: 2,
              duplicate_count: 0,
              truncated: false,
            }),
          }),
          withTransactionClient,
        }),
      );

      const durable = await composition.runAuthorityBoundBoundedCatchupDurable(baseInput());
      ok(
        'offline-composition-durable-result',
        durable
          && durable.status === 'processed'
          && durable.durably_processed === true
          && durable.durable_identity_count === 2
          && durable.observed_count === 2
          && durable.duplicate_in_batch_count === 0
          && durable.pages_fetched === 2
          && durable.truncated === false
          && Object.isFrozen(durable)
          && Object.keys(durable).join(',') === BOUNDED_CATCHUP_RESULT_KEYS.join(',')
          && noLeak(durable),
        ser(durable),
      );
      ok(
        'offline-composition-used-transaction',
        txnCalls === 1 && state.transportCalls === 1 && state.grantCalls === 1,
        ser({ txnCalls, transport: state.transportCalls, grant: state.grantCalls }),
      );
    }

    // ── Offline composition rejects proxy deps ────────────────────────────
    {
      assert.throws(
        () => offline.createOfflineAuthorityBoundBoundedCatchupComposition(
          new Proxy({
            db: { query: async () => ({ rows: [] }) },
            grantSession: Object.freeze({
              runWithAccessTokenOnce: async () => ({ ok: true, value: null }),
            }),
            immutableIdBoundedCatchupTransport: Object.freeze({
              listBoundedCatchupInboundEnvelopes: async () => catchupDto(),
            }),
            withTransactionClient: async (fn) => fn({ query: async () => ({ rows: [] }) }),
          }, {}),
        ),
        (e) => e && e.code === offline.ERROR_CODE,
      );
      ok('offline-proxy-deps-rejected', true);
    }

    // ── Grant pre-CAS fail zero transport/consumer ────────────────────────
    {
      const state = freshState();
      const service = buildCatchupOp(op, state, { grant: { preCasFail: 'uncertain' } });
      const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok(
        'pre-cas-zero-downstream',
        res.ok === false
          && state.grantCalls === 1
          && state.transportCalls === 0
          && state.consumerCalls === 0
          && noLeak(res),
        ser(state),
      );
    }

    // ── Authority unresolved ──────────────────────────────────────────────
    {
      const state = freshState();
      const dbPair = mockDbForAuthority(null);
      const service = buildCatchupOp(op, state, { dbPair });
      const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok(
        'authority-unresolved',
        res.ok === false
          && state.grantCalls === 0
          && state.transportCalls === 0
          && state.consumerCalls === 0
          && noLeak(res),
        ser(res),
      );
    }

    // ── Within-batch duplicates: duplicate_in_batch from processor ────────
    {
      // Transport claims unique_count=2 but actually returns 2 same-identity
      // envelopes → unique_count must equal length, so build correctly:
      // two envelopes same identity → unique_count=2 would fail length check.
      // Correct hostile: transport unique_count=2 with 2 envelopes that share
      // identity is impossible if unique_count must equal length.
      // Instead: pass 2 identical identities with unique_count=2 (length match)
      // — batch dedupes to delivered=1, duplicate_in_batch=1.
      const state = freshState();
      const dupEnvs = Object.freeze([
        envelope({
          provider_message_id: MSG_A,
          received_at: '2026-08-06T12:00:00.000Z',
        }),
        envelope({
          provider_message_id: MSG_A,
          received_at: '2026-08-05T12:00:00.000Z',
        }),
      ]);
      const service = buildCatchupOp(op, state, {
        transport: {
          dto: catchupDto({
            envelopes: dupEnvs,
            pages_fetched: 1,
            observed_count: 2,
            unique_count: 2,
            duplicate_count: 0,
            truncated: false,
          }),
        },
      });
      const res = await service.runAuthorityBoundBoundedCatchup(baseInput());
      ok(
        'batch-dup-count-from-processor',
        res.ok === true
          && res.value.durable_identity_count === 1
          && res.value.duplicate_in_batch_count === 1
          && res.value.observed_count === 2
          && state.consumerCalls === 1
          && state.consumerEnvelopeCounts[0] === 1,
        ser(res),
      );
    }

    ok('final-network-quiet', networkHits === 0);

    console.log(`\n${pass} passed, ${fail} failed (${VERIFY_REL})`);
    if (fail > 0) process.exitCode = 1;
  } catch (err) {
    console.error('VERIFIER_CRASH', err);
    process.exitCode = 1;
  } finally {
    restoreNetworkGuards();
  }
}

main();
