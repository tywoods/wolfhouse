'use strict';

/**
 * verify:email-authority-bound-messages-delta-page-operation — hostile RED-GREEN gate.
 *
 * OFFLINE authority-bound one-page durable Microsoft Graph messages-delta
 * operation/composition:
 *   resolve verified authority (tenant+mailbox local) → status → init race →
 *   phase stop → acquire → openCursor (PR408 post-crypto fence) →
 *   fresh grant-session per run / callback once / one Graph request →
 *   seal outside TX / scrub cursor → commitPageEvents once OR trusted
 *   cursor_gone → markResetRequired → release with returned version.
 *
 * Hostile (executable, not source claims): authority mismatch zero downstream;
 * first run + init race; strict phase equality status/lease/open; cursor
 * kind/phase pins; tracking no-cursor before grant; status/acquire/open/
 * commit/release exact version order + call counts; fresh grant session +
 * token scrub; initial nextLink preserves initial phase; mutable cursor
 * owner/transport alias scrub; seal before commit / seal failure zero commit;
 * empty/tombstone pages; trusted vs forged 410; reset success / unknown /
 * precommit / CAS conflict exact PR408 shapes + call order; lease takeover/
 * expiry during open two-stage fence no plaintext; release conflict vs
 * release commit-unknown after conclusive commit (no page retry); commit
 * pre-CAS vs CAS conflict; commit unknown zero release/actions; authority
 * rebind between resolve and state/Graph; frozen identity-free results;
 * import inert/unwired.
 *
 * No network, routes, OAuth scope, DB migration, deploy, live Graph, or
 * grant/refresh/SQL duplication. Preserves PR408/409 + authority/grant siblings.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const ROOT = path.join(__dirname, '..');
const OP_REL = 'scripts/lib/email-authority-bound-messages-delta-page-operation.js';
const OFFLINE_REL = 'scripts/lib/email-authority-bound-messages-delta-offline-composition.js';
const VERIFY_REL = 'scripts/verify-email-authority-bound-messages-delta-page-operation.js';
const CUSTODIAN_REL = 'scripts/lib/email-delegated-grant-custodian.js';
const STORE_REL = 'scripts/lib/email-inbound-delta-state-store.js';
const TRANSPORT_REL = 'scripts/lib/email-microsoft-graph-messages-delta-page-transport.js';
const DOC_REL = 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md';
const ROUTES_REL = 'scripts/lib/staff-email-oauth-routes.js';
const STAFF_API_REL = 'scripts/staff-query-api.js';
const PKG_PATH = path.join(ROOT, 'package.json');

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TENANT = '11111111-1111-4111-8111-111111111111';
const MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const FOREIGN_MAILBOX = '33333333-3333-4333-8333-3333333333cd';
const FOREIGN_TENANT = '11111111-1111-4111-8111-111111111112';
const QV1 = 'ms_messages_delta_from_now_v2';
const PLANTED_TOKEN = 'ya29.NEVER_LEAK_DELTA_PAGE_AT';
const PLANTED_SUBJECT = 'SUBJECT_PII_MUST_NOT_APPEAR_DELTA_PAGE_OP';
const PLANTED_ADDRESS = 'pii-delta-page-op-must-not-escape@example.com';
const PLANTED_MSG = 'AAMkAGI2-DELTA-PAGE-PII-MSG';
const PLANTED_NEXT =
  `https://graph.microsoft.com/v1.0/users/${MAILBOX}/mailFolders('inbox')/messages/delta?$skiptoken=SECRET_NEXT_TOKEN_NEVER_LEAK`;
const PLANTED_DELTA =
  `https://graph.microsoft.com/v1.0/users/${MAILBOX}/mailFolders('inbox')/messages/delta?$deltatoken=SECRET_DELTA_TOKEN_NEVER_LEAK`;
const PLANTED_NEXT_2 =
  `https://graph.microsoft.com/v1.0/users/${MAILBOX}/mailFolders('inbox')/messages/delta?$skiptoken=SECRET_NEXT_TOKEN_NEVER_LEAK_2`;

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
    && !s.includes('SECRET_DELTA_TOKEN')
    && !s.includes('SECRET_NEXT_TOKEN')
    && !s.includes('NEVER_LEAK')
    && !s.includes('client_secret=')
    && !s.includes('Authorization')
    && !s.includes('refresh_token')
    && !s.includes('ya29.')
    && !s.includes(PLANTED_NEXT)
    && !s.includes(PLANTED_DELTA);
}

/** Cursor/token secrets only — event INSERT may legitimately hold subject/address. */
function noCursorSecret(v) {
  const s = typeof v === 'string' ? v : ser(v);
  return !s.includes(PLANTED_TOKEN)
    && !s.includes('SECRET_DELTA_TOKEN')
    && !s.includes('SECRET_NEXT_TOKEN')
    && !s.includes(PLANTED_NEXT)
    && !s.includes(PLANTED_DELTA)
    && !s.includes('ya29.')
    && !s.includes('refresh_token')
    && !s.includes('client_secret=');
}

function isReleaseSql(sql) {
  const s = String(sql);
  return /SET lease_owner = NULL/.test(s)
    && /lease_token = \$5::uuid/.test(s)
    && /ingestion_generation = \$3::bigint/.test(s)
    && !/phase = 'reset_required'/.test(s);
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
  const hit = () => { networkHits += 1; throw new Error('NETWORK_FORBIDDEN_IN_DELTA_PAGE_OP'); };
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

function authorityRow(overrides = {}) {
  return {
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    provider: 'microsoft_graph',
    channel: 'email',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
    binding_status: 'verified',
    provider_tenant_id: TENANT,
    provider_resource_id: MAILBOX,
    provider_principal_oid: '44444444-4444-4444-8444-444444444444',
    mailbox_kind: 'user',
    mailbox_access_kind: 'own_user',
    public_address: PLANTED_ADDRESS,
    grant_client_id: CLIENT,
    grant_endpoint_id: ENDPOINT,
    ...overrides,
  };
}

function makeAuthorityDb(opts = {}) {
  const rows = opts.rows !== undefined ? opts.rows : [authorityRow(opts.rowOverrides || {})];
  let queryCount = 0;
  const log = [];
  const db = {
    async query(sql, params) {
      queryCount += 1;
      log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params ? params.slice() : null });
      if (opts.throwOnQuery) throw new Error('planted_authority_db_throw');
      if (typeof opts.onQuery === 'function') opts.onQuery(sql, params, queryCount);
      return { rows: rows.slice(), rowCount: rows.length, command: 'SELECT' };
    },
  };
  return { db, log, getQueryCount: () => queryCount };
}

function freezeEnv(env) {
  return Object.freeze({
    provider: env.provider,
    provider_mailbox_id: env.provider_mailbox_id,
    provider_message_id: env.provider_message_id,
    received_at: env.received_at,
    subject: env.subject,
    body_text: env.body_text,
    sender_display_name: env.sender_display_name,
    sender_address: env.sender_address,
    is_read: env.is_read,
    conversation_id: env.conversation_id,
    internet_message_id: env.internet_message_id,
  });
}

function makeEnvelope(id = 'msg-001') {
  return freezeEnv({
    provider: 'microsoft_graph',
    provider_mailbox_id: MAILBOX,
    provider_message_id: id,
    received_at: '2026-08-01T12:00:00.000Z',
    subject: PLANTED_SUBJECT,
    body_text: 'Bounded canonical body.',
    sender_display_name: 'Sender',
    sender_address: PLANTED_ADDRESS,
    is_read: false,
    conversation_id: 'conv-1',
    internet_message_id: `<${id}@example.com>`,
  });
}

function makeTombstone(id = 'msg-gone') {
  return Object.freeze({
    provider: 'microsoft_graph',
    provider_mailbox_id: MAILBOX,
    provider_message_id: id,
  });
}

function makeTransportPage(opts = {}) {
  const envelopes = Object.freeze(
    (opts.envelopes || [makeEnvelope('msg-001')]).map((e) => e),
  );
  const tombstones = Object.freeze(
    (opts.tombstones || []).map((t) => t),
  );
  const kind = opts.cursor_kind || 'deltaLink';
  const url = opts.cursor_url || (kind === 'nextLink' ? PLANTED_NEXT : PLANTED_DELTA);
  return Object.freeze({
    envelopes,
    tombstones,
    successor_cursor: Object.freeze({ cursor_kind: kind, cursor_url: url }),
    observed_count: envelopes.length + tombstones.length,
  });
}

function makeTransport(opts = {}) {
  const calls = [];
  let initialCount = 0;
  let continuationCount = 0;
  const transport = Object.freeze({
    async fetchInitialPage(input) {
      initialCount += 1;
      calls.push({
        method: 'fetchInitialPage',
        hasToken: Boolean(input && input.accessToken),
        mailbox: input && input.provider_mailbox_id,
        keys: input ? Object.keys(input).sort() : [],
        cursor_url: input && input.cursor_url,
      });
      if (opts.initialThrow) {
        const err = opts.initialThrow === true
          ? Object.assign(new Error('transport_fail'), {
            code: 'microsoft_graph_messages_delta_page_failed',
          })
          : opts.initialThrow;
        throw err;
      }
      if (typeof opts.initialImpl === 'function') return opts.initialImpl(input, calls);
      return opts.initialPage || makeTransportPage({ cursor_kind: 'deltaLink' });
    },
    async fetchContinuationPage(input) {
      continuationCount += 1;
      calls.push({
        method: 'fetchContinuationPage',
        hasToken: Boolean(input && input.accessToken),
        mailbox: input && input.provider_mailbox_id,
        kind: input && input.cursor_kind,
        hasUrl: Boolean(input && input.cursor_url),
        keys: input ? Object.keys(input).sort() : [],
        // Capture then caller should scrub — we record presence only.
        urlPresentAtCall: typeof (input && input.cursor_url) === 'string'
          && input.cursor_url.length > 0,
      });
      if (opts.continuationThrow) {
        const err = opts.continuationThrow === true
          ? Object.assign(new Error('transport_fail'), {
            code: 'microsoft_graph_messages_delta_page_failed',
          })
          : opts.continuationThrow;
        throw err;
      }
      if (typeof opts.continuationImpl === 'function') {
        return opts.continuationImpl(input, calls);
      }
      return opts.continuationPage || makeTransportPage({ cursor_kind: 'deltaLink' });
    },
  });
  return {
    transport,
    calls,
    getInitialCount: () => initialCount,
    getContinuationCount: () => continuationCount,
  };
}

function makeCursorGoneError() {
  // Brand via real transport helper by planting WeakMap through a real throw path
  // is hard offline — instead import readTrustedMessagesDeltaOutcome won't see
  // unbranded errors. Use transport module's private brand by requiring the
  // network owner to construct a branded error via createMicrosoftGraphMessagesDeltaPageTransport
  // continuation 410. Simpler: plant via the same WeakMap by throwing from a
  // real fetchContinuationPage of a mini transport that brands 410.
  // For unit tests we re-use the transport's readTrusted after constructing
  // error through messages transport internal — call create and force 410.
  const {
    createMicrosoftGraphMessagesDeltaPageTransport,
    readTrustedMessagesDeltaOutcome,
    MESSAGES_DELTA_PAGE_FAILURE_CODE,
  } = require('./lib/email-microsoft-graph-messages-delta-page-transport');
  // Build a real branded error by running continuation against a fake https that 410s.
  return { readTrustedMessagesDeltaOutcome, MESSAGES_DELTA_PAGE_FAILURE_CODE };
}

function makeGrantSessionFactory(opts = {}) {
  let sessionCreates = 0;
  let callbackCount = 0;
  let lastLoan = null;
  const createGrantSession = () => {
    sessionCreates += 1;
    let used = false;
    return Object.freeze({
      async runWithAccessTokenOnce(input, consumer) {
        if (used) throw new Error('grant_session_already_used');
        used = true;
        if (opts.sessionFail) {
          return Object.freeze({
            ok: false,
            status: 'unavailable',
            grant_generation: null,
          });
        }
        callbackCount += 1;
        const loan = { accessToken: PLANTED_TOKEN };
        lastLoan = loan;
        if (typeof opts.onCallback === 'function') {
          opts.onCallback({ input, loan, sessionCreates, callbackCount });
        }
        let value;
        try {
          value = await consumer(loan);
        } finally {
          // Session also scrubs in real impl; ensure test loan ends scrubbed if op did.
        }
        return Object.freeze({
          ok: true,
          grant_generation: 1,
          value,
        });
      },
    });
  };
  return {
    createGrantSession,
    getSessionCreates: () => sessionCreates,
    getCallbackCount: () => callbackCount,
    getLastLoan: () => lastLoan,
  };
}

function createFakeDeltaHarness(options = {}) {
  /** @type {Map<string, object>} key = client|endpoint|generation */
  const durableStates = options.states || new Map();
  /** @type {Map<string, object>} event identity */
  const durableEvents = options.events || new Map();
  /** @type {Map<string, object>} page_commit journal by operation_id */
  const durableJournal = options.journal || new Map();
  const log = [];
  let clockMs = options.clockMs != null ? options.clockMs : Date.now();
  let loanSeq = 0;
  let failOn = null;
  let commitShouldReject = false;
  /** Optional delay hook between loans (for planted delayed-open takeover). */
  let onLoanStart = null;

  function stateKey(clientId, endpointId, gen) {
    return `${clientId}\0${endpointId}\0${gen}`;
  }
  function eventKey(p, mbox, mid) {
    return `${p}\0${mbox}\0${mid}`;
  }
  function currentKey(clientId, endpointId) {
    for (const [k, row] of durableStates) {
      if (row.is_current && row.client_id === clientId && row.endpoint_id === endpointId) {
        return k;
      }
    }
    return null;
  }
  function cloneRow(row) {
    const out = { ...row };
    for (const b of ['nonce', 'ciphertext', 'auth_tag', 'wrapped_dek']) {
      if (Buffer.isBuffer(out[b])) out[b] = Buffer.from(out[b]);
    }
    return out;
  }
  function now() {
    return new Date(clockMs);
  }

  async function withTransactionClient(work) {
    const loanId = (loanSeq += 1);
    if (typeof onLoanStart === 'function') {
      await onLoanStart({ loanId, clockMs });
    }
    let inTx = false;
    /** @type {Map<string, object>} */
    const stagedStates = new Map();
    /** @type {Map<string, object>} */
    const stagedEvents = new Map();
    /** @type {Map<string, object>} */
    const stagedJournal = new Map();
    /** @type {Set<string>} */
    const deletedStateKeys = new Set();

    function readState(clientId, endpointId, gen) {
      const k = stateKey(clientId, endpointId, gen);
      if (deletedStateKeys.has(k)) return null;
      if (stagedStates.has(k)) return stagedStates.get(k);
      if (durableStates.has(k)) return cloneRow(durableStates.get(k));
      return null;
    }
    function readCurrent(clientId, endpointId) {
      for (const row of stagedStates.values()) {
        if (row.client_id === clientId && row.endpoint_id === endpointId && row.is_current) {
          return row;
        }
      }
      const ck = currentKey(clientId, endpointId);
      if (!ck || deletedStateKeys.has(ck)) return null;
      if (stagedStates.has(ck)) {
        const staged = stagedStates.get(ck);
        return staged.is_current ? staged : null;
      }
      return cloneRow(durableStates.get(ck));
    }
    function writeState(row) {
      const k = stateKey(row.client_id, row.endpoint_id, row.ingestion_generation);
      deletedStateKeys.delete(k);
      stagedStates.set(k, row);
    }
    function readJournal(opId) {
      const k = String(opId).toLowerCase();
      if (stagedJournal.has(k)) return stagedJournal.get(k);
      if (durableJournal.has(k)) return cloneRow(durableJournal.get(k));
      return null;
    }
    function writeJournal(row) {
      stagedJournal.set(String(row.operation_id).toLowerCase(), row);
    }

    const client = {
      async query(sql, params) {
        const norm = String(sql).replace(/\s+/g, ' ').trim();
        log.push({ loanId, sql: norm, params: params ? params.slice() : null });
        if (failOn && failOn(norm, params, { inTx, loanId })) {
          throw new Error('planted_db_failure');
        }
        if (norm === 'BEGIN') {
          if (inTx) throw new Error('nested_begin');
          inTx = true;
          stagedStates.clear();
          stagedEvents.clear();
          stagedJournal.clear();
          deletedStateKeys.clear();
          return { rows: [], rowCount: 0 };
        }
        if (norm === 'COMMIT') {
          if (!inTx) throw new Error('commit_without_begin');
          if (commitShouldReject) throw new Error('planted_commit_reject');
          for (const k of deletedStateKeys) durableStates.delete(k);
          for (const [k, row] of stagedStates) durableStates.set(k, cloneRow(row));
          for (const [k, row] of stagedEvents) {
            if (!durableEvents.has(k)) durableEvents.set(k, { ...row });
          }
          for (const [k, row] of stagedJournal) durableJournal.set(k, cloneRow(row));
          stagedStates.clear();
          stagedEvents.clear();
          stagedJournal.clear();
          deletedStateKeys.clear();
          inTx = false;
          return { rows: [], rowCount: 0 };
        }
        if (norm === 'ROLLBACK') {
          stagedStates.clear();
          stagedEvents.clear();
          stagedJournal.clear();
          deletedStateKeys.clear();
          inTx = false;
          return { rows: [], rowCount: 0 };
        }

        // page_commit journal SELECT FOR UPDATE
        if (/FROM tenant_email_delta_recovery_operations/.test(norm)
            && /FOR UPDATE/.test(norm)
            && /operation_id = \$1::uuid/.test(norm)
            && /^SELECT\b/.test(norm)) {
          const row = readJournal(params[0]);
          return { rows: row ? [cloneRow(row)] : [], rowCount: row ? 1 : 0 };
        }

        // page_commit journal INSERT claimed (worker)
        if (/INSERT INTO tenant_email_delta_recovery_operations/.test(norm)
            && /'page_commit'/.test(norm)
            && /'worker'/.test(norm)) {
          const opId = String(params[0]).toLowerCase();
          if (readJournal(opId)) {
            return { rows: [], rowCount: 0 };
          }
          const row = {
            operation_id: opId,
            client_id: params[1],
            location_id: params[2],
            endpoint_id: params[3],
            actor_staff_user_id: null,
            actor_kind: 'worker',
            worker_id: params[4],
            operation_kind: 'page_commit',
            requested_generation: Number(params[5]),
            requested_state_version: Number(params[6]),
            target_operation_id: null,
            outcome: 'claimed',
            result_generation: null,
            result_state_version: null,
            result_phase: null,
          };
          writeJournal(row);
          return { rows: [{ operation_id: opId }], rowCount: 1 };
        }

        // page_commit journal complete committed
        if (/UPDATE tenant_email_delta_recovery_operations/.test(norm)
            && /outcome = 'committed'/.test(norm)
            && /operation_kind = 'page_commit'/.test(norm)) {
          const opId = String(params[0]).toLowerCase();
          const row = readJournal(opId);
          if (!row || row.outcome !== 'claimed' || row.operation_kind !== 'page_commit') {
            return { rows: [], rowCount: 0 };
          }
          row.outcome = 'committed';
          row.result_generation = Number(params[1]);
          row.result_state_version = Number(params[2]);
          row.result_phase = params[3];
          writeJournal(row);
          return {
            rows: [{
              operation_id: row.operation_id,
              operation_kind: row.operation_kind,
              outcome: row.outcome,
              result_generation: row.result_generation,
              result_state_version: row.result_state_version,
              result_phase: row.result_phase,
            }],
            rowCount: 1,
          };
        }

        // public status
        if (/has_active_lease/.test(norm) && /has_sealed_cursor/.test(norm)
            && /FROM tenant_email_inbound_delta_states/.test(norm)
            && !/lease_token = \$3::uuid/.test(norm)
            && !/ingestion_generation = \$4::bigint/.test(norm)) {
          const row = readCurrent(params[0], params[1]);
          if (!row) return { rows: [], rowCount: 0 };
          return {
            rows: [{
              phase: row.phase,
              ingestion_generation: row.ingestion_generation,
              query_version: row.query_version,
              state_version: row.state_version,
              has_active_lease: row.lease_token != null
                && row.lease_until != null
                && new Date(row.lease_until).getTime() > clockMs,
              has_sealed_cursor: row.cursor_kind != null,
              cursor_kind: row.cursor_kind,
              reset_reason: row.reset_reason,
            }],
            rowCount: 1,
          };
        }

        // post-crypto lease revalidation (SQL_REVALIDATE_LEASE)
        if (/ingestion_generation = \$4::bigint/.test(norm)
            && /state_version = \$5::bigint/.test(norm)
            && /lease_token = \$3::uuid/.test(norm)
            && /AS ok/.test(norm)) {
          const row = readCurrent(params[0], params[1]);
          if (!row) return { rows: [{ ok: false }], rowCount: 1 };
          const okLive = row.lease_token != null
            && String(row.lease_token) === String(params[2])
            && row.lease_until != null
            && new Date(row.lease_until).getTime() > clockMs
            && Number(row.ingestion_generation) === Number(params[3])
            && Number(row.state_version) === Number(params[4]);
          return { rows: [{ ok: okLive }], rowCount: 1 };
        }

        // lease unexpired check (openCursor first pass)
        if (/AS ok/.test(norm)
            && /lease_until IS NOT NULL AND lease_until > clock_timestamp\(\)/.test(norm)
            && /FROM tenant_email_inbound_delta_states/.test(norm)
            && /lease_token = \$3::uuid/.test(norm)
            && !/ingestion_generation = \$4::bigint/.test(norm)) {
          const row = readCurrent(params[0], params[1]);
          if (!row || String(row.lease_token) !== String(params[2])) {
            return { rows: [{ ok: false }], rowCount: 1 };
          }
          const okLive = row.lease_until != null && new Date(row.lease_until).getTime() > clockMs;
          return { rows: [{ ok: okLive }], rowCount: 1 };
        }

        // SELECT * current FOR UPDATE
        if (/FOR UPDATE/.test(norm)
            && /FROM tenant_email_inbound_delta_states/.test(norm)
            && /is_current = true/.test(norm)) {
          const row = readCurrent(params[0], params[1]);
          return { rows: row ? [cloneRow(row)] : [], rowCount: row ? 1 : 0 };
        }

        // INSERT initial / next generation
        if (/^INSERT INTO tenant_email_inbound_delta_states/.test(norm)) {
          const [
            clientId, locationId, endpointId, provider, tenantId, mailboxId,
            genOrQv, maybeQv,
          ] = params;
          // next gen: $7::bigint, $8 (text qv); initial: gen fixed 1, qv=$7 text
          const isNext = /\$7::bigint, \$8, true/.test(norm)
            || /\$7::bigint, \$8/.test(norm);
          const gen = isNext ? Number(genOrQv) : 1;
          const qv = isNext ? String(maybeQv) : String(genOrQv);
          const existingCurrent = readCurrent(clientId, endpointId);
          if (existingCurrent && existingCurrent.is_current) {
            throw Object.assign(new Error('unique_current'), { code: '23505' });
          }
          const row = {
            id: crypto.randomUUID(),
            client_id: clientId,
            location_id: locationId,
            endpoint_id: endpointId,
            provider,
            provider_tenant_id: tenantId,
            provider_mailbox_id: mailboxId,
            ingestion_generation: gen,
            query_version: qv,
            is_current: true,
            phase: 'initial',
            state_version: 1,
            lease_owner: null,
            lease_token: null,
            lease_until: null,
            cursor_kind: null,
            envelope_version: null,
            aead_alg: null,
            kek_wrap_alg: null,
            kek_key_name: null,
            kek_key_version: null,
            nonce: null,
            ciphertext: null,
            auth_tag: null,
            wrapped_dek: null,
            cursor_operation_id: null,
            reset_reason: null,
            created_at: now(),
            updated_at: now(),
          };
          writeState(row);
          return {
            rows: [{
              client_id: row.client_id,
              endpoint_id: row.endpoint_id,
              ingestion_generation: row.ingestion_generation,
              query_version: row.query_version,
              phase: row.phase,
              state_version: row.state_version,
            }],
            rowCount: 1,
          };
        }

        // DEMOTE current
        if (/SET is_current = false/.test(norm)) {
          const [clientId, endpointId, gen, sv] = params;
          const row = readCurrent(clientId, endpointId);
          if (!row
              || Number(row.ingestion_generation) !== Number(gen)
              || Number(row.state_version) !== Number(sv)
              || !row.is_current) {
            return { rows: [], rowCount: 0 };
          }
          row.is_current = false;
          row.lease_owner = null;
          row.lease_token = null;
          row.lease_until = null;
          row.state_version = Number(row.state_version) + 1;
          row.updated_at = now();
          writeState(row);
          return {
            rows: [{
              ingestion_generation: row.ingestion_generation,
              state_version: row.state_version,
            }],
            rowCount: 1,
          };
        }

        // LEASE ACQUIRE
        if (/SET lease_owner = \$3/.test(norm) && /lease_token = \$4::uuid/.test(norm)) {
          const [clientId, endpointId, owner, token, ttlSec, gen, sv] = params;
          const row = readCurrent(clientId, endpointId);
          if (!row
              || Number(row.ingestion_generation) !== Number(gen)
              || Number(row.state_version) !== Number(sv)
              || !['initial', 'tracking', 'paused'].includes(row.phase)) {
            return { rows: [], rowCount: 0 };
          }
          if (row.lease_token != null
              && row.lease_until != null
              && new Date(row.lease_until).getTime() >= clockMs) {
            return { rows: [], rowCount: 0 };
          }
          row.lease_owner = owner;
          row.lease_token = token;
          row.lease_until = new Date(clockMs + Number(ttlSec) * 1000);
          row.state_version = Number(row.state_version) + 1;
          row.updated_at = now();
          writeState(row);
          return {
            rows: [{
              client_id: row.client_id,
              endpoint_id: row.endpoint_id,
              ingestion_generation: row.ingestion_generation,
              state_version: row.state_version,
              lease_owner: row.lease_owner,
              lease_token: row.lease_token,
              lease_until: row.lease_until,
              phase: row.phase,
              query_version: row.query_version,
            }],
            rowCount: 1,
          };
        }

        // LEASE RENEW
        if (/SET lease_until = clock_timestamp\(\) \+ \(\$5::text \|\| ' seconds'\)::interval/.test(norm)
            && /lease_token = \$6::uuid/.test(norm)) {
          const [clientId, endpointId, gen, sv, ttlSec, token] = params;
          const row = readCurrent(clientId, endpointId);
          if (!row
              || Number(row.ingestion_generation) !== Number(gen)
              || Number(row.state_version) !== Number(sv)
              || String(row.lease_token) !== String(token)
              || row.lease_until == null
              || new Date(row.lease_until).getTime() <= clockMs) {
            return { rows: [], rowCount: 0 };
          }
          row.lease_until = new Date(clockMs + Number(ttlSec) * 1000);
          row.state_version = Number(row.state_version) + 1;
          row.updated_at = now();
          writeState(row);
          return {
            rows: [{
              client_id: row.client_id,
              endpoint_id: row.endpoint_id,
              ingestion_generation: row.ingestion_generation,
              state_version: row.state_version,
              lease_owner: row.lease_owner,
              lease_token: row.lease_token,
              lease_until: row.lease_until,
              phase: row.phase,
              query_version: row.query_version,
            }],
            rowCount: 1,
          };
        }

        // LEASE RELEASE
        if (/SET lease_owner = NULL/.test(norm) && /lease_token = \$5::uuid/.test(norm)
            && !/phase = 'reset_required'/.test(norm) && !/is_current = false/.test(norm)) {
          const [clientId, endpointId, gen, sv, token] = params;
          const row = readCurrent(clientId, endpointId);
          if (!row
              || Number(row.ingestion_generation) !== Number(gen)
              || Number(row.state_version) !== Number(sv)
              || String(row.lease_token) !== String(token)) {
            return { rows: [], rowCount: 0 };
          }
          row.lease_owner = null;
          row.lease_token = null;
          row.lease_until = null;
          row.state_version = Number(row.state_version) + 1;
          row.updated_at = now();
          writeState(row);
          return {
            rows: [{
              client_id: row.client_id,
              endpoint_id: row.endpoint_id,
              ingestion_generation: row.ingestion_generation,
              state_version: row.state_version,
              phase: row.phase,
            }],
            rowCount: 1,
          };
        }

        // COMMIT CURSOR (tenant $6, mailbox $7, query_version $8 text, cursor_kind $9)
        if (/SET cursor_kind = \$9/.test(norm) || /SET cursor_kind = \$8/.test(norm)) {
          // Prefer $9 layout (tenant + mailbox + qv)
          const usesTenant = /SET cursor_kind = \$9/.test(norm);
          let clientId; let endpointId; let gen; let sv; let token;
          let tenant; let mailbox; let qv; let cursorKind;
          let envVer; let aead; let wrap; let kekName; let kekVer;
          let nonce; let ciphertext; let authTag; let wrappedDek; let opId; let phase;
          if (usesTenant) {
            [
              clientId, endpointId, gen, sv, token, tenant, mailbox, qv,
              cursorKind,
              envVer, aead, wrap, kekName, kekVer,
              nonce, ciphertext, authTag, wrappedDek, opId, phase,
            ] = params;
          } else {
            [
              clientId, endpointId, gen, sv, token, mailbox, qv,
              cursorKind,
              envVer, aead, wrap, kekName, kekVer,
              nonce, ciphertext, authTag, wrappedDek, opId, phase,
            ] = params;
            tenant = null;
          }
          const row = readCurrent(clientId, endpointId);
          if (!row
              || Number(row.ingestion_generation) !== Number(gen)
              || Number(row.state_version) !== Number(sv)
              || String(row.lease_token) !== String(token)
              || row.lease_until == null
              || new Date(row.lease_until).getTime() <= clockMs
              || String(row.provider_mailbox_id) !== String(mailbox)
              || String(row.query_version) !== String(qv)
              || (tenant != null && String(row.provider_tenant_id) !== String(tenant))
              || !['initial', 'tracking'].includes(row.phase)) {
            return { rows: [], rowCount: 0 };
          }
          row.cursor_kind = cursorKind;
          row.envelope_version = envVer;
          row.aead_alg = aead;
          row.kek_wrap_alg = wrap;
          row.kek_key_name = kekName;
          row.kek_key_version = kekVer;
          row.nonce = Buffer.from(nonce);
          row.ciphertext = Buffer.from(ciphertext);
          row.auth_tag = Buffer.from(authTag);
          row.wrapped_dek = Buffer.from(wrappedDek);
          row.cursor_operation_id = opId;
          row.phase = phase;
          row.reset_reason = null;
          row.state_version = Number(row.state_version) + 1;
          row.updated_at = now();
          writeState(row);
          return {
            rows: [{
              client_id: row.client_id,
              endpoint_id: row.endpoint_id,
              ingestion_generation: row.ingestion_generation,
              state_version: row.state_version,
              phase: row.phase,
              query_version: row.query_version,
              cursor_kind: row.cursor_kind,
            }],
            rowCount: 1,
          };
        }

        // RESET REQUIRED
        if (/SET phase = 'reset_required'/.test(norm)) {
          const [clientId, endpointId, gen, sv, reason] = params;
          const row = readCurrent(clientId, endpointId);
          if (!row
              || Number(row.ingestion_generation) !== Number(gen)
              || Number(row.state_version) !== Number(sv)) {
            return { rows: [], rowCount: 0 };
          }
          row.phase = 'reset_required';
          row.reset_reason = reason;
          row.lease_owner = null;
          row.lease_token = null;
          row.lease_until = null;
          row.state_version = Number(row.state_version) + 1;
          row.updated_at = now();
          writeState(row);
          return {
            rows: [{
              client_id: row.client_id,
              endpoint_id: row.endpoint_id,
              ingestion_generation: row.ingestion_generation,
              state_version: row.state_version,
              phase: row.phase,
              reset_reason: row.reset_reason,
            }],
            rowCount: 1,
          };
        }

        // EVENT INSERT
        if (/^INSERT INTO tenant_email_inbound_events/.test(norm)) {
          const [
            clientId, locationId, endpointId,
            provider, mailbox, messageId,
            receivedAt, subject, senderDisplay, senderAddress,
            isRead, conversationId, internetMessageId,
          ] = params;
          const k = eventKey(provider, mailbox, messageId);
          if (durableEvents.has(k) || stagedEvents.has(k)) {
            return { rows: [], rowCount: 0 };
          }
          stagedEvents.set(k, {
            client_id: clientId,
            location_id: locationId,
            endpoint_id: endpointId,
            provider,
            provider_mailbox_id: mailbox,
            provider_message_id: messageId,
            received_at: receivedAt,
            subject,
            sender_display_name: senderDisplay,
            sender_address: senderAddress,
            is_read: isRead,
            conversation_id: conversationId,
            internet_message_id: internetMessageId,
          });
          return { rows: [], rowCount: 1 };
        }

        throw new Error(`unexpected sql: ${norm.slice(0, 160)}`);
      },
    };

    try {
      return await work(client);
    } finally {
      stagedStates.clear();
      stagedEvents.clear();
      stagedJournal.clear();
      deletedStateKeys.clear();
      inTx = false;
    }
  }

  return {
    withTransactionClient,
    states: durableStates,
    events: durableEvents,
    journal: durableJournal,
    log,
    advanceClock(ms) { clockMs += ms; },
    getClockMs() { return clockMs; },
    setFailOn(fn) { failOn = fn; },
    setCommitReject(v) { commitShouldReject = v; },
    setOnLoanStart(fn) { onLoanStart = fn; },
    /** Mutate durable current row outside store TX (takeover simulation). */
    mutateCurrent(clientId, endpointId, mutator) {
      const ck = currentKey(clientId, endpointId);
      if (!ck) return null;
      const row = durableStates.get(ck);
      mutator(row);
      return row;
    },
  };
}

const { EventEmitter } = require('node:events');

async function captureTrustedCursorGoneError() {
  const {
    createMicrosoftGraphMessagesDeltaPageTransport,
    readTrustedMessagesDeltaOutcome,
  } = require('./lib/email-microsoft-graph-messages-delta-page-transport');
  const httpsImpl = function request(_options, onResponse) {
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
    req.end = () => { queueMicrotask(() => onResponse(response)); };
    return req;
  };
  const t = createMicrosoftGraphMessagesDeltaPageTransport({
    httpsImpl,
    timers: { setTimeout, clearTimeout },
  });
  try {
    await t.fetchContinuationPage({
      accessToken: 'token-for-brand-capture-only',
      provider_mailbox_id: MAILBOX,
      cursor_kind: 'nextLink',
      cursor_url: PLANTED_NEXT,
    });
  } catch (err) {
    if (readTrustedMessagesDeltaOutcome(err) === 'cursor_gone') return err;
    throw err;
  }
  throw new Error('expected_cursor_gone_brand');
}

function makeForgedCursorGoneError() {
  return Object.freeze(Object.assign(new Error('microsoft graph messages delta page failed'), {
    code: 'microsoft_graph_messages_delta_page_failed',
    name: 'MicrosoftGraphMessagesDeltaPageError',
    cursor_gone: true,
    outcome: 'cursor_gone',
  }));
}

async function buildOperation(opts = {}) {
  const {
    createAuthorityBoundMessagesDeltaPageOperation,
  } = require('./lib/email-authority-bound-messages-delta-page-operation');
  const {
    createFakeEmailGrantEnvelopeProvider,
  } = require('./lib/email-grant-envelope-fake-provider');

  const auth = makeAuthorityDb(opts.authority || {});
  const harness = createFakeDeltaHarness(opts.harnessOptions || {});
  const envProvider = createFakeEmailGrantEnvelopeProvider();
  const grant = makeGrantSessionFactory(opts.grant || {});
  const transportBag = makeTransport(opts.transport || {});

  let op;
  try {
    op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
  } catch (err) {
    return { error: err, auth, harness, grant, transportBag };
  }
  return {
    op,
    auth,
    harness,
    grant,
    transportBag,
    envProvider,
    run: (input) => op.runAuthorityBoundMessagesDeltaPage(input || baseInput()),
  };
}

/**
 * Install a PR408 store factory spy via require.cache so the operation's
 * internal createInboundEmailDeltaStateStore is wrapped. Supports planted
 * exact PR408 result shapes and ordered method call logs.
 *
 * @param {object} [handlers] per-method async (input, realStore, callLog) =>
 *   undefined to delegate, or exact PR408 result to plant
 */
function installStoreSpy(handlers = {}) {
  const storePath = require.resolve('./lib/email-inbound-delta-state-store');
  const opPath = require.resolve('./lib/email-authority-bound-messages-delta-page-operation');
  const offlinePath = require.resolve('./lib/email-authority-bound-messages-delta-offline-composition');
  const realStoreMod = require(storePath);
  const callLog = [];
  const STORE_METHODS = [
    'getPublicStatus',
    'initializeState',
    'acquireLease',
    'openCursor',
    'sealDeltaCursor',
    'commitPageEvents',
    'markResetRequired',
    'releaseLease',
    'beginNextGeneration',
    'renewLease',
  ];

  function wrapStore(store) {
    const wrapped = {};
    for (const name of STORE_METHODS) {
      const realFn = store[name];
      if (typeof realFn !== 'function') continue;
      wrapped[name] = async function spyMethod(input) {
        callLog.push({ method: name, stage: 'enter' });
        if (typeof handlers[name] === 'function') {
          const planted = await handlers[name](input, store, callLog);
          if (planted !== undefined) {
            callLog.push({
              method: name,
              stage: 'exit',
              ok: planted && planted.ok,
              error: planted && planted.error,
              planted: true,
            });
            return planted;
          }
        }
        const res = await realFn.call(store, input);
        callLog.push({
          method: name,
          stage: 'exit',
          ok: res && res.ok,
          error: res && res.error,
          planted: false,
        });
        return res;
      };
    }
    return Object.freeze(wrapped);
  }

  require.cache[storePath].exports = Object.freeze({
    ...realStoreMod,
    createInboundEmailDeltaStateStore(deps) {
      return wrapStore(realStoreMod.createInboundEmailDeltaStateStore(deps));
    },
  });
  delete require.cache[opPath];
  delete require.cache[offlinePath];

  return {
    callLog,
    methodNames() {
      return callLog.filter((e) => e.stage === 'enter').map((e) => e.method);
    },
    count(method) {
      return callLog.filter((e) => e.stage === 'enter' && e.method === method).length;
    },
    exits(method) {
      return callLog.filter((e) => e.stage === 'exit' && e.method === method);
    },
    loadOp() {
      return require('./lib/email-authority-bound-messages-delta-page-operation');
    },
    restore() {
      require.cache[storePath].exports = realStoreMod;
      delete require.cache[opPath];
      delete require.cache[offlinePath];
      // re-warm default modules
      require('./lib/email-inbound-delta-state-store');
      require('./lib/email-authority-bound-messages-delta-page-operation');
    },
  };
}

async function buildSpiedOperation(opts = {}) {
  const spy = installStoreSpy(opts.handlers || {});
  try {
    const {
      createAuthorityBoundMessagesDeltaPageOperation,
    } = spy.loadOp();
    const {
      createFakeEmailGrantEnvelopeProvider,
    } = require('./lib/email-grant-envelope-fake-provider');
    const auth = makeAuthorityDb(opts.authority || {});
    const harness = createFakeDeltaHarness(opts.harnessOptions || {});
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    const grant = makeGrantSessionFactory(opts.grant || {});
    const transportBag = makeTransport(opts.transport || {});
    const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
    const liveMod = spy.loadOp();
    return {
      op,
      auth,
      harness,
      grant,
      transportBag,
      envProvider,
      spy,
      mod: liveMod,
      run: (input) => op.runAuthorityBoundMessagesDeltaPage(input || baseInput()),
      restore: () => spy.restore(),
    };
  } catch (err) {
    spy.restore();
    throw err;
  }
}

/** Seed a tracking state with sealed deltaLink cursor under harness. */
async function seedTrackingState(harness, envProvider) {
  const {
    createInboundEmailDeltaStateStore,
  } = require('./lib/email-inbound-delta-state-store');
  const store = createInboundEmailDeltaStateStore(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
    envelopeProvider: envProvider,
    authorityVerifier: Object.freeze({
      async verifyBinding() {
        return Object.freeze({
          ok: true,
          value: Object.freeze({
            clientId: CLIENT,
            locationId: LOCATION,
            endpointId: ENDPOINT,
            providerTenantId: TENANT,
            providerMailboxId: MAILBOX,
          }),
        });
      },
    }),
  }));
  const init = await store.initializeState(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: QV1,
  }));
  assert.equal(init.ok, true, ser(init));
  const lease = await store.acquireLease(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    workerId: 'seed-worker',
    ttlSeconds: 60,
    expectedGeneration: 1,
    expectedStateVersion: 1,
  }));
  assert.equal(lease.ok, true, ser(lease));
  const sealed = await store.sealDeltaCursor(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1,
    queryVersion: QV1,
    cursorKind: 'nextLink',
    cursorUrl: PLANTED_NEXT,
    operationId: crypto.randomUUID(),
  }));
  assert.equal(sealed.ok, true, ser(sealed));
  const commit = await store.commitPageEvents(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    leaseToken: lease.value.lease_token,
    expectedGeneration: 1,
    expectedStateVersion: lease.value.state_version,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: QV1,
    envelopes: Object.freeze([makeEnvelope('seed-msg')]),
    tombstones: Object.freeze([]),
    successorCursor: Object.freeze({
      cursor_kind: 'nextLink',
      envelope: sealed.value.envelope,
    }),
  }));
  assert.equal(commit.ok, true, ser(commit));
  const rel = await store.releaseLease(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    leaseToken: lease.value.lease_token,
    expectedGeneration: commit.value.ingestion_generation,
    expectedStateVersion: commit.value.state_version,
  }));
  assert.equal(rel.ok, true, ser(rel));
  return { store, stateVersion: rel.value.state_version, generation: rel.value.ingestion_generation };
}

async function main() {
  installNetworkGuards();
  console.log('verify:email-authority-bound-messages-delta-page-operation');

  const opMod = require('./lib/email-authority-bound-messages-delta-page-operation');
  const offlineMod = require('./lib/email-authority-bound-messages-delta-offline-composition');
  const custodian = require('./lib/email-delegated-grant-custodian');
  const {
    readTrustedMessagesDeltaOutcome,
  } = require('./lib/email-microsoft-graph-messages-delta-page-transport');
  const {
    createFakeEmailGrantEnvelopeProvider,
  } = require('./lib/email-grant-envelope-fake-provider');

  // ── Static flags / exports / import-inert ──────────────────────────────
  ok('runtime-wired-false',
    opMod.EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_RUNTIME_WIRED === false);
  ok('safe-for-runtime-false',
    opMod.EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_SAFE_FOR_RUNTIME_ROUTE_CRON === false);
  ok('auto-begin-generation-false',
    opMod.EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_AUTO_BEGIN_GENERATION === false);
  ok('multipage-false',
    opMod.EMAIL_AUTHORITY_BOUND_MESSAGES_DELTA_PAGE_MULTIPAGE === false);
  ok('offline-runtime-wired-false',
    offlineMod.EMAIL_MESSAGES_DELTA_OFFLINE_COMPOSITION_RUNTIME_WIRED === false);
  ok('offline-import-inert-true',
    offlineMod.EMAIL_MESSAGES_DELTA_OFFLINE_COMPOSITION_IMPORT_INERT === true);
  ok('query-version-exact', opMod.QUERY_VERSION === QV1);
  ok('result-keys-exact',
    Array.isArray(opMod.RESULT_KEYS)
      && opMod.RESULT_KEYS.join(',') === 'status,phase,envelopes_presented,tombstones_presented');
  ok('input-keys-exact',
    opMod.INPUT_KEYS.join(',') === 'clientId,locationId,endpointId');
  ok('binding-verifier-export',
    typeof custodian.createDelegatedReadAuthorityBindingVerifier === 'function');
  ok('binding-resolve-export',
    typeof custodian.resolveDelegatedReadAuthorityBinding === 'function');
  ok('public-dto-keys-unchanged',
    custodian.DELEGATED_READ_AUTHORITY_DTO_KEYS.join(',')
      === 'clientId,locationId,endpointId,provider,providerMailboxId,bindingStatus');

  // ── Package gate ───────────────────────────────────────────────────────
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  ok(
    'package-script-gate',
    pkg.scripts
      && pkg.scripts['verify:email-authority-bound-messages-delta-page-operation']
        === 'node scripts/verify-email-authority-bound-messages-delta-page-operation.js',
  );

  // ── Docs ───────────────────────────────────────────────────────────────
  const doc = fs.readFileSync(path.join(ROOT, DOC_REL), 'utf8');
  ok(
    'docs-mention-delta-page-operation',
    /authority-bound.*messages-delta|messages-delta.*page.?operation|authority-bound-messages-delta/i
      .test(doc),
  );

  // ── Unwired: routes / staff-api / production compositions ──────────────
  const routesSrc = fs.readFileSync(path.join(ROOT, ROUTES_REL), 'utf8');
  const staffSrc = fs.readFileSync(path.join(ROOT, STAFF_API_REL), 'utf8');
  ok(
    'routes-unwired',
    !/email-authority-bound-messages-delta|createAuthorityBoundMessagesDeltaPageOperation/
      .test(routesSrc),
  );
  ok(
    'staff-api-unwired',
    !/email-authority-bound-messages-delta|createAuthorityBoundMessagesDeltaPageOperation/
      .test(staffSrc),
  );

  // ── Source contracts ───────────────────────────────────────────────────
  const opSrc = fs.readFileSync(path.join(ROOT, OP_REL), 'utf8');
  ok('op-no-sql-begin', !/client\.query\(['\"]BEGIN/.test(opSrc)
    && !/query\(\s*['\"]BEGIN/.test(opSrc)
    && !/query\(\s*['\"]COMMIT/.test(opSrc));
  ok('op-uses-commitPageEvents', /commitPageEvents/.test(opSrc));
  ok('op-uses-sealDeltaCursor', /sealDeltaCursor/.test(opSrc));
  ok('op-uses-readTrustedMessagesDeltaOutcome', /readTrustedMessagesDeltaOutcome/.test(opSrc));
  ok('op-mark-reset-cursor-gone',
    /graph_delta_cursor_gone/.test(opSrc) && /markResetRequired/.test(opSrc));
  ok('op-no-auto-begin-generation-call',
    !/beginNextGeneration\s*\(/.test(opSrc));
  ok('op-fresh-grant-session-factory',
    /createGrantSession/.test(opSrc) && /resolveFreshGrantSession/.test(opSrc));
  ok('op-no-processInboundEmailBatch', !/processInboundEmailBatch/.test(opSrc));
  ok('op-factory-fixed-verifier',
    /createDelegatedReadAuthorityBindingVerifier/.test(opSrc));

  // ── Binding verifier unit ──────────────────────────────────────────────
  {
    const auth = makeAuthorityDb();
    const verifier = custodian.createDelegatedReadAuthorityBindingVerifier(
      Object.freeze({ db: auth.db }),
    );
    const good = await verifier.verifyBinding(Object.freeze({
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      providerTenantId: TENANT,
      providerMailboxId: MAILBOX,
    }));
    ok('binding-verifier-happy', good.ok === true
      && good.value.providerTenantId === TENANT
      && good.value.providerMailboxId === MAILBOX);

    const badTenant = await verifier.verifyBinding(Object.freeze({
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      providerTenantId: FOREIGN_TENANT,
      providerMailboxId: MAILBOX,
    }));
    ok('binding-verifier-tenant-mismatch', badTenant.ok === false);

    const badMailbox = await verifier.verifyBinding(Object.freeze({
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      providerTenantId: TENANT,
      providerMailboxId: FOREIGN_MAILBOX,
    }));
    ok('binding-verifier-mailbox-mismatch', badMailbox.ok === false);
  }

  // ── Authority mismatch → zero downstream ───────────────────────────────
  {
    const ctx = await buildOperation({
      authority: { rows: [] },
    });
    const res = await ctx.run();
    ok('authority-empty-fails', res.ok === false);
    ok('authority-empty-zero-grant', ctx.grant.getSessionCreates() === 0);
    ok('authority-empty-zero-transport',
      ctx.transportBag.getInitialCount() === 0
      && ctx.transportBag.getContinuationCount() === 0);
    ok('authority-empty-no-leak', noLeak(res));
  }

  // ── First run: init → initial fetch → commit → release ─────────────────
  {
    const versionOrder = [];
    const ctx = await buildOperation({
      transport: {
        initialPage: makeTransportPage({
          envelopes: [makeEnvelope('first-1')],
          cursor_kind: 'deltaLink',
          cursor_url: PLANTED_DELTA,
        }),
      },
      grant: {
        onCallback: ({ input, loan }) => {
          versionOrder.push({
            phase: 'callback',
            hasToken: loan.accessToken === PLANTED_TOKEN,
            sessionInput: { ...input },
          });
        },
      },
    });
    // Intercept store methods via harness log after run
    const res = await ctx.run();
    ok('first-run-committed', res.ok === true && res.value.status === 'committed', ser(res));
    ok('first-run-phase', res.ok && (res.value.phase === 'tracking' || res.value.phase === 'initial'));
    ok('first-run-envelope-count', res.ok && res.value.envelopes_presented === 1);
    ok('first-run-tombstone-count', res.ok && res.value.tombstones_presented === 0);
    ok('first-run-initial-fetch-once', ctx.transportBag.getInitialCount() === 1);
    ok('first-run-no-continuation', ctx.transportBag.getContinuationCount() === 0);
    ok('first-run-fresh-session-once', ctx.grant.getSessionCreates() === 1);
    ok('first-run-callback-once', ctx.grant.getCallbackCount() === 1);
    ok('first-run-token-scrubbed',
      ctx.grant.getLastLoan() && ctx.grant.getLastLoan().accessToken == null);
    ok('first-run-no-ids-in-result',
      res.ok
      && !Object.prototype.hasOwnProperty.call(res.value, 'clientId')
      && !Object.prototype.hasOwnProperty.call(res.value, 'endpointId')
      && !Object.prototype.hasOwnProperty.call(res.value, 'lease_token')
      && !Object.prototype.hasOwnProperty.call(res.value, 'cursor_url')
      && !Object.prototype.hasOwnProperty.call(res.value, 'ingestion_generation'));
    ok('first-run-no-leak', noLeak(res) && noCursorSecret(ctx.harness.log));
    ok('first-run-event-durable', ctx.harness.events.size === 1);
    // Exact version order: status/init(1) → acquire bumps → open same → commit bumps → release bumps
    const sqlOps = ctx.harness.log.map((e) => {
      const s = e.sql;
      if (/^INSERT INTO tenant_email_inbound_delta_states/.test(s)) return 'insert_init';
      if (/SET lease_owner = \$3/.test(s)) return 'acquire';
      if (/FOR UPDATE/.test(s) && /is_current = true/.test(s)) return 'lock';
      if (/SET cursor_kind = \$9/.test(s)) return 'commit';
      if (/SET lease_owner = NULL/.test(s) && /lease_token = NULL/.test(s)
          && /lease_until = NULL/.test(s) && /state_version = state_version \+ 1/.test(s)
          && /lease_token = \$5::uuid/.test(s)) return 'release';
      if (/has_active_lease/.test(s)) return 'status';
      if (/AS ok/.test(s) && /ingestion_generation = \$4::bigint/.test(s)) return 'revalidate';
      if (/INSERT INTO tenant_email_inbound_events/.test(s)
          || /ON CONFLICT/.test(s)) return 'event_insert';
      return null;
    }).filter(Boolean);
    ok('first-run-has-acquire', sqlOps.includes('acquire'));
    ok('first-run-has-commit', sqlOps.includes('commit'));
    ok('first-run-has-release', sqlOps.includes('release'));
    const acqIdx = sqlOps.indexOf('acquire');
    const commitIdx = sqlOps.indexOf('commit');
    const releaseIdx = sqlOps.indexOf('release');
    ok('first-run-version-order',
      acqIdx >= 0 && commitIdx > acqIdx && releaseIdx > commitIdx,
      ser(sqlOps));
  }

  // ── Init race: already-exists → reread once ────────────────────────────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    // Pre-seed state so initialize hits already_exists
    await seedTrackingState(harness, envProvider);

    const auth = makeAuthorityDb();
    const grant = makeGrantSessionFactory();
    const transportBag = makeTransport({
      continuationPage: makeTransportPage({
        envelopes: [makeEnvelope('race-1')],
        cursor_kind: 'deltaLink',
        cursor_url: PLANTED_DELTA,
      }),
    });
    const {
      createAuthorityBoundMessagesDeltaPageOperation,
    } = require('./lib/email-authority-bound-messages-delta-page-operation');
    const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
    const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
    ok('init-race-continues-committed',
      res.ok === true && res.value.status === 'committed', ser(res));
    ok('init-race-used-continuation',
      transportBag.getContinuationCount() === 1
      && transportBag.getInitialCount() === 0);
  }

  // ── Phase paused / reset_required stop ─────────────────────────────────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    harness.mutateCurrent(CLIENT, ENDPOINT, (row) => {
      row.phase = 'paused';
    });
    const auth = makeAuthorityDb();
    const grant = makeGrantSessionFactory();
    const transportBag = makeTransport();
    const {
      createAuthorityBoundMessagesDeltaPageOperation,
    } = require('./lib/email-authority-bound-messages-delta-page-operation');
    const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
    const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
    ok('phase-paused-stops',
      res.ok === true && res.value.status === 'paused' && res.value.phase === 'paused',
      ser(res));
    ok('phase-paused-zero-transport',
      transportBag.getInitialCount() === 0
      && transportBag.getContinuationCount() === 0);
    ok('phase-paused-zero-grant', grant.getSessionCreates() === 0);
  }

  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    harness.mutateCurrent(CLIENT, ENDPOINT, (row) => {
      row.phase = 'reset_required';
      row.reset_reason = 'graph_delta_cursor_gone';
    });
    const auth = makeAuthorityDb();
    const grant = makeGrantSessionFactory();
    const transportBag = makeTransport();
    const {
      createAuthorityBoundMessagesDeltaPageOperation,
    } = require('./lib/email-authority-bound-messages-delta-page-operation');
    const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
    const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
    ok('phase-reset-required-stops',
      res.ok === true && res.value.status === 'reset_required', ser(res));
    ok('phase-reset-zero-downstream',
      grant.getSessionCreates() === 0
      && transportBag.getInitialCount() === 0);
  }

  // ── Empty page + tombstone page ────────────────────────────────────────
  {
    const ctx = await buildOperation({
      transport: {
        initialPage: makeTransportPage({
          envelopes: [],
          tombstones: [],
          cursor_kind: 'deltaLink',
          cursor_url: PLANTED_DELTA,
        }),
      },
    });
    const res = await ctx.run();
    ok('empty-page-committed',
      res.ok === true && res.value.status === 'committed'
      && res.value.envelopes_presented === 0
      && res.value.tombstones_presented === 0,
      ser(res));
  }

  {
    const ctx = await buildOperation({
      transport: {
        initialPage: makeTransportPage({
          envelopes: [],
          tombstones: [makeTombstone('gone-1'), makeTombstone('gone-2')],
          cursor_kind: 'nextLink',
          cursor_url: PLANTED_NEXT,
        }),
      },
    });
    const res = await ctx.run();
    ok('tombstone-page-committed',
      res.ok === true && res.value.status === 'committed'
      && res.value.envelopes_presented === 0
      && res.value.tombstones_presented === 2,
      ser(res));
    // Tombstones create no synthetic events
    ok('tombstone-page-no-events', ctx.harness.events.size === 0);
  }

  // ── Seal before commit; plaintext never commit input ───────────────────
  {
    const ctx = await buildOperation({
      transport: {
        initialPage: makeTransportPage({
          envelopes: [makeEnvelope('seal-1')],
          cursor_kind: 'nextLink',
          cursor_url: PLANTED_NEXT,
        }),
      },
    });
    const res = await ctx.run();
    ok('seal-commit-success', res.ok === true && res.value.status === 'committed');
    const commitLogs = ctx.harness.log.filter((e) => /SET cursor_kind = \$9/.test(e.sql));
    ok('seal-commit-once', commitLogs.length === 1);
    ok(
      'plaintext-never-in-commit-params',
      commitLogs.every((e) => noLeak(e.params)),
    );
    ok(
      'plaintext-never-in-sql-log',
      noCursorSecret(ctx.harness.log),
    );
  }

  // ── Mutable cursor owner scrub on continuation ─────────────────────────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    let capturedInput = null;
    const auth = makeAuthorityDb();
    const grant = makeGrantSessionFactory();
    const transportBag = makeTransport({
      continuationImpl: async (input) => {
        capturedInput = {
          keys: Object.keys(input).sort(),
          hasUrl: typeof input.cursor_url === 'string',
          hasToken: typeof input.accessToken === 'string',
        };
        return makeTransportPage({
          envelopes: [makeEnvelope('cont-1')],
          cursor_kind: 'deltaLink',
          cursor_url: PLANTED_DELTA,
        });
      },
    });
    const {
      createAuthorityBoundMessagesDeltaPageOperation,
    } = require('./lib/email-authority-bound-messages-delta-page-operation');
    const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
    const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
    ok('continuation-route-committed',
      res.ok === true && res.value.status === 'committed', ser(res));
    ok('continuation-input-had-url-at-call',
      capturedInput && capturedInput.hasUrl === true && capturedInput.hasToken === true);
    ok('continuation-token-scrubbed-after',
      grant.getLastLoan() && grant.getLastLoan().accessToken == null);
  }

  // ── Trusted cursor_gone → reset_required; no release; no auto gen ──────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    const logMark = harness.log.length;
    const cursorGoneErr = await captureTrustedCursorGoneError();
    ok('captured-trusted-cursor-gone',
      readTrustedMessagesDeltaOutcome(cursorGoneErr) === 'cursor_gone');

    const auth = makeAuthorityDb();
    const grant = makeGrantSessionFactory();
    const transportBag = makeTransport({
      continuationThrow: cursorGoneErr,
    });
    const {
      createAuthorityBoundMessagesDeltaPageOperation,
    } = require('./lib/email-authority-bound-messages-delta-page-operation');
    const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
    const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
    ok('cursor-gone-reset-required',
      res.ok === true && res.value.status === 'reset_required'
      && res.value.phase === 'reset_required',
      ser(res));
    // markReset clears lease — no separate release CAS after successful reset
    const opLogs = harness.log.slice(logMark);
    const releaseLogs = opLogs.filter((e) => isReleaseSql(e.sql));
    const resetLogs = opLogs.filter((e) =>
      /phase = 'reset_required'/.test(e.sql));
    ok('cursor-gone-mark-reset-once', resetLogs.length === 1);
    ok('cursor-gone-no-release-after-reset', releaseLogs.length === 0, ser(releaseLogs));
    ok('cursor-gone-no-begin-generation',
      !harness.log.some((e) => /is_current = false/.test(e.sql)));
    ok('cursor-gone-no-leak', noLeak(res));
  }

  // ── Forged 410 / initial failure never reset ───────────────────────────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    const forged = makeForgedCursorGoneError();
    ok('forged-not-trusted', readTrustedMessagesDeltaOutcome(forged) == null);

    const auth = makeAuthorityDb();
    const grant = makeGrantSessionFactory();
    const transportBag = makeTransport({
      continuationThrow: forged,
    });
    const {
      createAuthorityBoundMessagesDeltaPageOperation,
    } = require('./lib/email-authority-bound-messages-delta-page-operation');
    const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
    const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
    ok('forged-410-fails-not-reset',
      res.ok === false, ser(res));
    const resetLogs = harness.log.filter((e) =>
      /phase = 'reset_required'/.test(e.sql));
    ok('forged-410-no-reset-sql', resetLogs.length === 0);
  }

  // Initial 410-like failure must not reset
  {
    const forged = makeForgedCursorGoneError();
    const ctx = await buildOperation({
      transport: { initialThrow: forged },
    });
    const res = await ctx.run();
    ok('initial-forged-fails', res.ok === false);
    const resetLogs = ctx.harness.log.filter((e) =>
      /phase = 'reset_required'/.test(e.sql));
    ok('initial-forged-no-reset', resetLogs.length === 0);
  }

  // ── Commit outcome unknown: uncertain, no release/retry ────────────────
  {
    const ctx = await buildOperation({
      transport: {
        initialPage: makeTransportPage({
          envelopes: [makeEnvelope('unk-1')],
          cursor_kind: 'deltaLink',
          cursor_url: PLANTED_DELTA,
        }),
      },
    });
    // Reject only the commit CAS txn commit
    let commitSeen = false;
    ctx.harness.setFailOn((norm, params, meta) => {
      if (/SET cursor_kind = \$9/.test(norm)) {
        commitSeen = true;
      }
      return false;
    });
    ctx.harness.setCommitReject(true);
    // Only reject COMMIT after we've entered a commit path — but setCommitReject
    // rejects ALL commits. Init also commits. So seed first then enable reject.
  }

  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    // Pre-init so first-run init isn't the rejected commit
    const seed = await seedTrackingState(harness, envProvider);
    harness.setCommitReject(true);
    const auth = makeAuthorityDb();
    const grant = makeGrantSessionFactory();
    const transportBag = makeTransport({
      continuationPage: makeTransportPage({
        envelopes: [makeEnvelope('unk-1')],
        cursor_kind: 'deltaLink',
        cursor_url: PLANTED_DELTA,
      }),
    });
    const {
      createAuthorityBoundMessagesDeltaPageOperation,
    } = require('./lib/email-authority-bound-messages-delta-page-operation');
    const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
    // Acquire + open also COMMIT — setCommitReject will break acquire.
    // Need finer control: only reject commit cursor CAS's COMMIT.
    harness.setCommitReject(false);
    let rejectNextCommit = false;
    const origWith = harness.withTransactionClient;
    // Patch: after seal, commitPageEvents will BEGIN…CAS…COMMIT. We plant reject
    // on the commit that follows SET cursor_kind.
    let sawCursorCas = false;
    harness.setFailOn(null);
    const wrappedWith = async (work) => {
      return origWith(async (client) => {
        const origQuery = client.query.bind(client);
        client.query = async (sql, params) => {
          const norm = String(sql).replace(/\s+/g, ' ').trim();
          if (/SET cursor_kind = \$9/.test(norm)) {
            sawCursorCas = true;
          }
          if (norm === 'COMMIT' && sawCursorCas) {
            sawCursorCas = false;
            throw new Error('planted_commit_reject');
          }
          return origQuery(sql, params);
        };
        return work(client);
      });
    };
    const op2 = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: wrappedWith,
      envelopeProvider: envProvider,
    }));
    const logMarkUnknown = harness.log.length;
    const res = await op2.runAuthorityBoundMessagesDeltaPage(baseInput());
    ok('commit-unknown-uncertain',
      res.ok === true && res.value.status === 'uncertain',
      ser(res));
    ok('commit-unknown-null-counts',
      res.ok
      && res.value.envelopes_presented === null
      && res.value.tombstones_presented === null);
    const opLogsUnknown = harness.log.slice(logMarkUnknown);
    ok('commit-unknown-no-release-guess',
      !opLogsUnknown.some((e) => isReleaseSql(e.sql)),
      ser(opLogsUnknown.filter((e) => isReleaseSql(e.sql))));
    ok('commit-unknown-single-transport',
      transportBag.getContinuationCount() === 1);
    ok('commit-unknown-single-session', grant.getSessionCreates() === 1);
    ok('commit-unknown-no-leak', noLeak(res));
    void seed;
  }

  // ── Commit success release uses returned version ───────────────────────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    const auth = makeAuthorityDb();
    const grant = makeGrantSessionFactory();
    const transportBag = makeTransport({
      initialPage: makeTransportPage({
        envelopes: [makeEnvelope('ver-1')],
        cursor_kind: 'deltaLink',
        cursor_url: PLANTED_DELTA,
      }),
    });
    const releaseVersions = [];
    const origWith = harness.withTransactionClient;
    const wrappedWith = async (work) => origWith(async (client) => {
      const origQuery = client.query.bind(client);
      client.query = async (sql, params) => {
        const norm = String(sql).replace(/\s+/g, ' ').trim();
        if (/SET lease_owner = NULL/.test(norm)
            && /lease_token = \$5::uuid/.test(norm)
            && /ingestion_generation = \$3::bigint/.test(norm)) {
          releaseVersions.push({
            generation: Number(params[2]),
            stateVersion: Number(params[3]),
          });
        }
        return origQuery(sql, params);
      };
      return work(client);
    });
    const {
      createAuthorityBoundMessagesDeltaPageOperation,
    } = require('./lib/email-authority-bound-messages-delta-page-operation');
    const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: wrappedWith,
      envelopeProvider: envProvider,
    }));
    const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
    ok('release-version-committed', res.ok && res.value.status === 'committed');
    ok('release-uses-returned-version',
      releaseVersions.length === 1
      && releaseVersions[0].generation === 1
      && releaseVersions[0].stateVersion >= 3,
      ser(releaseVersions));
  }

  // ── Lease acquire conflict ─────────────────────────────────────────────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    // Active unexpired foreign lease
    harness.mutateCurrent(CLIENT, ENDPOINT, (row) => {
      row.lease_token = crypto.randomUUID();
      row.lease_owner = 'other-worker';
      row.lease_until = new Date(harness.getClockMs() + 60_000).toISOString();
    });
    const auth = makeAuthorityDb();
    const grant = makeGrantSessionFactory();
    const transportBag = makeTransport();
    const {
      createAuthorityBoundMessagesDeltaPageOperation,
    } = require('./lib/email-authority-bound-messages-delta-page-operation');
    const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
    const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
    ok('lease-busy-fails', res.ok === false, ser(res));
    ok('lease-busy-zero-transport',
      transportBag.getInitialCount() === 0
      && transportBag.getContinuationCount() === 0);
  }

  // ── Authority rebind fail (foreign mailbox envelopes) ──────────────────
  {
    const ctx = await buildOperation({
      transport: {
        initialPage: makeTransportPage({
          envelopes: [
            freezeEnv({
              ...makeEnvelope('bad-mbox'),
              provider_mailbox_id: FOREIGN_MAILBOX,
            }),
          ],
          cursor_kind: 'deltaLink',
          cursor_url: PLANTED_DELTA,
        }),
      },
    });
    const res = await ctx.run();
    ok('authority-rebind-envelope-fail', res.ok === false, ser(res));
    ok('authority-rebind-no-events', ctx.harness.events.size === 0);
  }

  // ── Grant session pre-CAS fail → zero graph ────────────────────────────
  {
    const ctx = await buildOperation({
      grant: { sessionFail: true },
    });
    const res = await ctx.run();
    ok('grant-session-fail', res.ok === false);
    ok('grant-session-fail-zero-transport',
      ctx.transportBag.getInitialCount() === 0);
  }

  // ── Offline composition happy path ─────────────────────────────────────
  {
    const auth = makeAuthorityDb();
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    const grant = makeGrantSessionFactory();
    const transportBag = makeTransport({
      initialPage: makeTransportPage({
        envelopes: [makeEnvelope('off-1')],
        cursor_kind: 'deltaLink',
        cursor_url: PLANTED_DELTA,
      }),
    });
    const composition = offlineMod.createOfflineAuthorityBoundMessagesDeltaComposition(
      Object.freeze({
        db: auth.db,
        createGrantSession: grant.createGrantSession,
        messagesDeltaPageTransport: transportBag.transport,
        withTransactionClient: harness.withTransactionClient,
        envelopeProvider: envProvider,
      }),
    );
    const value = await composition.runAuthorityBoundMessagesDeltaPageDurable(baseInput());
    ok('offline-composition-committed',
      value.status === 'committed' && value.envelopes_presented === 1, ser(value));
    ok('offline-composition-frozen-keys',
      Object.keys(value).join(',') === opMod.RESULT_KEYS.join(','));
    ok('offline-composition-no-leak', noLeak(value));
  }

  // ── Exact frozen results never contain secrets/envelopes ────────────────
  {
    const ctx = await buildOperation({
      transport: {
        initialPage: makeTransportPage({
          envelopes: [makeEnvelope(PLANTED_MSG)],
          cursor_kind: 'deltaLink',
          cursor_url: PLANTED_DELTA,
        }),
      },
    });
    const res = await ctx.run();
    ok('result-no-envelope-fields',
      res.ok
      && !ser(res).includes(PLANTED_SUBJECT)
      && !ser(res).includes(PLANTED_ADDRESS)
      && !ser(res).includes(PLANTED_MSG)
      && !ser(res).includes(PLANTED_TOKEN)
      && !ser(res).includes('SECRET_'));
  }

  // ── Hostile input rejection ────────────────────────────────────────────
  {
    const ctx = await buildOperation();
    const badInputs = [
      null,
      undefined,
      {},
      { clientId: CLIENT },
      { clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT, token: 'x' },
      { clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT, providerTenantId: TENANT },
      Object.assign(Object.create(null), baseInput()),
      new Proxy(baseInput(), { get(t, p) { return t[p]; } }),
    ];
    let rejected = 0;
    for (const bad of badInputs) {
      const res = await ctx.op.runAuthorityBoundMessagesDeltaPage(bad);
      if (res && res.ok === false) rejected += 1;
    }
    ok('hostile-inputs-rejected', rejected === badInputs.length, `rejected=${rejected}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // State-machine probes (executable call-count/order + PR408 result shapes)
  // ═══════════════════════════════════════════════════════════════════════

  // ── Reset unknown: PR408 commit_outcome_unknown → uncertain; ZERO actions ─
  {
    // Seed first, then install spy with planted markResetRequired unknown shape.
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    const cursorGoneErr = await captureTrustedCursorGoneError();
    const spy = installStoreSpy({
      async markResetRequired() {
        return Object.freeze({
          ok: false,
          error: 'inbound_delta_state_commit_outcome_unknown',
        });
      },
    });
    try {
      const {
        createAuthorityBoundMessagesDeltaPageOperation,
      } = spy.loadOp();
      const auth = makeAuthorityDb();
      const grant = makeGrantSessionFactory();
      const transportBag = makeTransport({ continuationThrow: cursorGoneErr });
      const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
        db: auth.db,
        createGrantSession: grant.createGrantSession,
        messagesDeltaPageTransport: transportBag.transport,
        withTransactionClient: harness.withTransactionClient,
        envelopeProvider: envProvider,
      }));
      const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
      ok('reset-unknown-uncertain',
        res.ok === true && res.value.status === 'uncertain', ser(res));
      ok('reset-unknown-null-phase-counts',
        res.ok
        && res.value.phase === null
        && res.value.envelopes_presented === null
        && res.value.tombstones_presented === null);
      ok('reset-unknown-mark-once', spy.count('markResetRequired') === 1, ser(spy.methodNames()));
      ok('reset-unknown-zero-release', spy.count('releaseLease') === 0, ser(spy.methodNames()));
      ok('reset-unknown-zero-retry-commit', spy.count('commitPageEvents') === 0);
      ok('reset-unknown-zero-begin-gen', spy.count('beginNextGeneration') === 0);
      ok('reset-unknown-zero-second-mark', spy.count('markResetRequired') === 1);
      ok('reset-unknown-single-continuation', transportBag.getContinuationCount() === 1);
      ok('reset-unknown-call-order', (() => {
        const m = spy.methodNames();
        const iAcq = m.indexOf('acquireLease');
        const iOpen = m.indexOf('openCursor');
        const iMark = m.indexOf('markResetRequired');
        return iAcq >= 0 && iOpen > iAcq && iMark > iOpen
          && !m.includes('releaseLease')
          && !m.includes('commitPageEvents')
          && !m.includes('beginNextGeneration');
      })(), ser(spy.methodNames()));
      ok('reset-unknown-no-leak', noLeak(res));
    } finally {
      spy.restore();
    }
  }

  // ── Reset pre-COMMIT failure → best-effort release; fail ───────────────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    const cursorGoneErr = await captureTrustedCursorGoneError();
    const spy = installStoreSpy({
      async markResetRequired() {
        return Object.freeze({
          ok: false,
          error: 'inbound_delta_state_write_failed',
        });
      },
    });
    try {
      const {
        createAuthorityBoundMessagesDeltaPageOperation,
      } = spy.loadOp();
      const auth = makeAuthorityDb();
      const grant = makeGrantSessionFactory();
      const transportBag = makeTransport({ continuationThrow: cursorGoneErr });
      const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
        db: auth.db,
        createGrantSession: grant.createGrantSession,
        messagesDeltaPageTransport: transportBag.transport,
        withTransactionClient: harness.withTransactionClient,
        envelopeProvider: envProvider,
      }));
      const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
      ok('reset-precommit-fails', res.ok === false, ser(res));
      ok('reset-precommit-mark-once', spy.count('markResetRequired') === 1);
      ok('reset-precommit-release-once', spy.count('releaseLease') === 1, ser(spy.methodNames()));
      ok('reset-precommit-zero-commit', spy.count('commitPageEvents') === 0);
      ok('reset-precommit-zero-begin-gen', spy.count('beginNextGeneration') === 0);
      ok('reset-precommit-order', (() => {
        const m = spy.methodNames();
        return m.indexOf('markResetRequired') < m.indexOf('releaseLease')
          && m.indexOf('releaseLease') === m.lastIndexOf('releaseLease');
      })(), ser(spy.methodNames()));
    } finally {
      spy.restore();
    }
  }

  // ── Reset CAS conflict → best-effort release; fail ─────────────────────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    const cursorGoneErr = await captureTrustedCursorGoneError();
    const spy = installStoreSpy({
      async markResetRequired() {
        return Object.freeze({
          ok: false,
          error: 'reset_cas_conflict',
        });
      },
    });
    try {
      const {
        createAuthorityBoundMessagesDeltaPageOperation,
      } = spy.loadOp();
      const auth = makeAuthorityDb();
      const grant = makeGrantSessionFactory();
      const transportBag = makeTransport({ continuationThrow: cursorGoneErr });
      const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
        db: auth.db,
        createGrantSession: grant.createGrantSession,
        messagesDeltaPageTransport: transportBag.transport,
        withTransactionClient: harness.withTransactionClient,
        envelopeProvider: envProvider,
      }));
      const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
      ok('reset-cas-conflict-fails', res.ok === false, ser(res));
      ok('reset-cas-mark-once', spy.count('markResetRequired') === 1);
      ok('reset-cas-release-once', spy.count('releaseLease') === 1, ser(spy.methodNames()));
      ok('reset-cas-zero-commit-actions',
        spy.count('commitPageEvents') === 0
        && spy.count('beginNextGeneration') === 0);
      ok('reset-cas-order-mark-then-release', (() => {
        const m = spy.methodNames();
        return m.indexOf('markResetRequired') >= 0
          && m.indexOf('releaseLease') > m.indexOf('markResetRequired');
      })(), ser(spy.methodNames()));
    } finally {
      spy.restore();
    }
  }

  // ── Reset success call order: mark once, zero release ──────────────────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    const cursorGoneErr = await captureTrustedCursorGoneError();
    const spy = installStoreSpy();
    try {
      const {
        createAuthorityBoundMessagesDeltaPageOperation,
      } = spy.loadOp();
      const auth = makeAuthorityDb();
      const grant = makeGrantSessionFactory();
      const transportBag = makeTransport({ continuationThrow: cursorGoneErr });
      const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
        db: auth.db,
        createGrantSession: grant.createGrantSession,
        messagesDeltaPageTransport: transportBag.transport,
        withTransactionClient: harness.withTransactionClient,
        envelopeProvider: envProvider,
      }));
      const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
      ok('reset-success-status',
        res.ok === true && res.value.status === 'reset_required', ser(res));
      ok('reset-success-mark-once', spy.count('markResetRequired') === 1);
      ok('reset-success-zero-release', spy.count('releaseLease') === 0, ser(spy.methodNames()));
      ok('reset-success-zero-begin', spy.count('beginNextGeneration') === 0);
      ok('reset-success-order', (() => {
        const m = spy.methodNames();
        const iStatus = m.indexOf('getPublicStatus');
        const iAcq = m.indexOf('acquireLease');
        const iOpen = m.indexOf('openCursor');
        const iMark = m.indexOf('markResetRequired');
        return iStatus >= 0 && iAcq > iStatus && iOpen > iAcq && iMark > iOpen
          && !m.includes('releaseLease')
          && !m.includes('commitPageEvents');
      })(), ser(spy.methodNames()));
    } finally {
      spy.restore();
    }
  }

  // ── Release conflict after conclusive commit: no page retry ────────────
  {
    let sawCommitOk = false;
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    const spy = installStoreSpy({
      async releaseLease(input, realStore, callLog) {
        const commitOk = callLog.some(
          (e) => e.method === 'commitPageEvents' && e.stage === 'exit' && e.ok === true,
        );
        if (commitOk) {
          sawCommitOk = true;
          return Object.freeze({ ok: false, error: 'lease_fenced' });
        }
        return undefined;
      },
    });
    try {
      const {
        createAuthorityBoundMessagesDeltaPageOperation,
      } = spy.loadOp();
      const auth = makeAuthorityDb();
      const grant = makeGrantSessionFactory();
      const transportBag = makeTransport({
        initialPage: makeTransportPage({
          envelopes: [makeEnvelope('rel-conflict-1')],
          cursor_kind: 'deltaLink',
          cursor_url: PLANTED_DELTA,
        }),
      });
      const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
        db: auth.db,
        createGrantSession: grant.createGrantSession,
        messagesDeltaPageTransport: transportBag.transport,
        withTransactionClient: harness.withTransactionClient,
        envelopeProvider: envProvider,
      }));
      const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
      ok('release-conflict-after-commit',
        res.ok === true
        && res.value.status === 'committed_but_lease_release_uncertain',
        ser(res));
      ok('release-conflict-saw-commit', sawCommitOk === true);
      ok('release-conflict-no-page-retry',
        transportBag.getInitialCount() === 1
        && transportBag.getContinuationCount() === 0);
      ok('release-conflict-single-session', grant.getSessionCreates() === 1);
      ok('release-conflict-commit-once', spy.count('commitPageEvents') === 1);
      ok('release-conflict-release-once', spy.count('releaseLease') === 1);
      ok('release-conflict-counts-preserved',
        res.ok
        && res.value.envelopes_presented === 1
        && res.value.tombstones_presented === 0);
    } finally {
      spy.restore();
    }
  }

  // ── Release commit-unknown after conclusive commit: no page retry ──────
  {
    let sawCommitOk = false;
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    const spy = installStoreSpy({
      async releaseLease(input, realStore, callLog) {
        const commitOk = callLog.some(
          (e) => e.method === 'commitPageEvents' && e.stage === 'exit' && e.ok === true,
        );
        if (commitOk) {
          sawCommitOk = true;
          return Object.freeze({
            ok: false,
            error: 'inbound_delta_state_commit_outcome_unknown',
          });
        }
        return undefined;
      },
    });
    try {
      const {
        createAuthorityBoundMessagesDeltaPageOperation,
      } = spy.loadOp();
      const auth = makeAuthorityDb();
      const grant = makeGrantSessionFactory();
      const transportBag = makeTransport({
        initialPage: makeTransportPage({
          envelopes: [makeEnvelope('rel-unk-1')],
          cursor_kind: 'deltaLink',
          cursor_url: PLANTED_DELTA,
        }),
      });
      const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
        db: auth.db,
        createGrantSession: grant.createGrantSession,
        messagesDeltaPageTransport: transportBag.transport,
        withTransactionClient: harness.withTransactionClient,
        envelopeProvider: envProvider,
      }));
      const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
      ok('release-unknown-after-commit',
        res.ok === true
        && res.value.status === 'committed_but_lease_release_uncertain',
        ser(res));
      ok('release-unknown-saw-commit', sawCommitOk === true);
      ok('release-unknown-no-page-retry',
        transportBag.getInitialCount() === 1
        && grant.getSessionCreates() === 1
        && spy.count('commitPageEvents') === 1);
      ok('release-unknown-not-uncertain-status',
        res.ok && res.value.status !== 'uncertain');
    } finally {
      spy.restore();
    }
  }

  // ── Seal failure: zero commit + correct release ────────────────────────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    const spy = installStoreSpy({
      async sealDeltaCursor() {
        return Object.freeze({ ok: false, error: 'cursor_seal_failed' });
      },
    });
    try {
      const {
        createAuthorityBoundMessagesDeltaPageOperation,
      } = spy.loadOp();
      const auth = makeAuthorityDb();
      const grant = makeGrantSessionFactory();
      const transportBag = makeTransport({
        initialPage: makeTransportPage({
          envelopes: [makeEnvelope('seal-fail-1')],
          cursor_kind: 'deltaLink',
          cursor_url: PLANTED_DELTA,
        }),
      });
      const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
        db: auth.db,
        createGrantSession: grant.createGrantSession,
        messagesDeltaPageTransport: transportBag.transport,
        withTransactionClient: harness.withTransactionClient,
        envelopeProvider: envProvider,
      }));
      const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
      ok('seal-fail-fails', res.ok === false, ser(res));
      ok('seal-fail-zero-commit', spy.count('commitPageEvents') === 0);
      ok('seal-fail-release-once', spy.count('releaseLease') === 1, ser(spy.methodNames()));
      ok('seal-fail-transport-once', transportBag.getInitialCount() === 1);
      ok('seal-fail-order-seal-before-release', (() => {
        const m = spy.methodNames();
        return m.includes('sealDeltaCursor')
          && m.indexOf('sealDeltaCursor') < m.indexOf('releaseLease');
      })(), ser(spy.methodNames()));
    } finally {
      spy.restore();
    }
  }

  // ── Tracking no cursor: fail before grant/network ──────────────────────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    // Clear sealed cursor while leaving phase=tracking (invalid durable state).
    harness.mutateCurrent(CLIENT, ENDPOINT, (row) => {
      row.cursor_kind = null;
      row.nonce = null;
      row.ciphertext = null;
      row.auth_tag = null;
      row.wrapped_dek = null;
      row.cursor_operation_id = null;
      row.envelope_version = null;
      row.aead_alg = null;
      row.kek_wrap_alg = null;
      row.kek_key_name = null;
      row.kek_key_version = null;
      // Force phase tracking without cursor (OR loophole regression target).
      row.phase = 'tracking';
    });
    const auth = makeAuthorityDb();
    const grant = makeGrantSessionFactory();
    const transportBag = makeTransport();
    const {
      createAuthorityBoundMessagesDeltaPageOperation,
    } = require('./lib/email-authority-bound-messages-delta-page-operation');
    const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
    const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
    ok('tracking-no-cursor-fails', res.ok === false, ser(res));
    ok('tracking-no-cursor-zero-grant', grant.getSessionCreates() === 0);
    ok('tracking-no-cursor-zero-transport',
      transportBag.getInitialCount() === 0
      && transportBag.getContinuationCount() === 0);
    // Best-effort release after open rejection
    const releaseLogs = harness.log.filter((e) => isReleaseSql(e.sql));
    ok('tracking-no-cursor-released', releaseLogs.length >= 1, ser(releaseLogs.length));
  }

  // ── Lease takeover during open two-stage fence: no plaintext to transport ─
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    // Operation loans after seed: (1) getPublicStatus (2) acquireLease
    // (3) openCursor first fence (4) openCursor post-crypto revalidate.
    // Take over at start of loan 4 so revalidate fails closed (no plaintext).
    let opLoans = 0;
    harness.setOnLoanStart(async () => {
      opLoans += 1;
      if (opLoans === 4) {
        harness.mutateCurrent(CLIENT, ENDPOINT, (row) => {
          row.lease_token = crypto.randomUUID();
          row.lease_owner = 'hostile-takeover-worker';
          row.lease_until = new Date(harness.getClockMs() + 120_000).toISOString();
          row.state_version = Number(row.state_version) + 1;
        });
      }
    });
    const auth = makeAuthorityDb();
    const grant = makeGrantSessionFactory();
    const transportBag = makeTransport();
    const {
      createAuthorityBoundMessagesDeltaPageOperation,
    } = require('./lib/email-authority-bound-messages-delta-page-operation');
    const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
    const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
    ok('open-takeover-fails', res.ok === false, ser(res));
    ok('open-takeover-zero-transport',
      transportBag.getInitialCount() === 0
      && transportBag.getContinuationCount() === 0);
    ok('open-takeover-zero-grant', grant.getSessionCreates() === 0);
    ok('open-takeover-no-cursor-secret', noCursorSecret(harness.log));
  }

  // ── Lease expiry during open two-stage fence ───────────────────────────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    let opLoans = 0;
    harness.setOnLoanStart(async () => {
      opLoans += 1;
      if (opLoans === 4) {
        // Expire the lease before second fence.
        harness.mutateCurrent(CLIENT, ENDPOINT, (row) => {
          row.lease_until = new Date(harness.getClockMs() - 1).toISOString();
        });
      }
    });
    const auth = makeAuthorityDb();
    const grant = makeGrantSessionFactory();
    const transportBag = makeTransport();
    const {
      createAuthorityBoundMessagesDeltaPageOperation,
    } = require('./lib/email-authority-bound-messages-delta-page-operation');
    const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
    const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
    ok('open-expiry-fails', res.ok === false, ser(res));
    ok('open-expiry-zero-transport',
      transportBag.getInitialCount() === 0
      && transportBag.getContinuationCount() === 0
      && grant.getSessionCreates() === 0);
  }

  // ── Phase mismatch at status/lease ─────────────────────────────────────
  {
    // seedTrackingState commits nextLink → phase remains 'initial'.
    // Plant acquire phase as 'tracking' so status≠lease (strict equality).
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    const spy = installStoreSpy({
      async acquireLease(input, realStore) {
        const real = await realStore.acquireLease(input);
        if (!real || real.ok !== true) return real;
        return Object.freeze({
          ok: true,
          value: Object.freeze({
            ...real.value,
            phase: 'tracking',
          }),
        });
      },
    });
    try {
      const {
        createAuthorityBoundMessagesDeltaPageOperation,
      } = spy.loadOp();
      const auth = makeAuthorityDb();
      const grant = makeGrantSessionFactory();
      const transportBag = makeTransport();
      const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
        db: auth.db,
        createGrantSession: grant.createGrantSession,
        messagesDeltaPageTransport: transportBag.transport,
        withTransactionClient: harness.withTransactionClient,
        envelopeProvider: envProvider,
      }));
      const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
      ok('phase-mismatch-status-lease-fails', res.ok === false, ser(res));
      ok('phase-mismatch-status-lease-zero-open',
        spy.count('openCursor') === 0, ser(spy.methodNames()));
      ok('phase-mismatch-status-lease-zero-grant', grant.getSessionCreates() === 0);
      ok('phase-mismatch-status-lease-released',
        spy.count('releaseLease') === 1, ser(spy.methodNames()));
    } finally {
      spy.restore();
    }
  }

  // ── Phase mismatch at lease/open ───────────────────────────────────────
  {
    // status+lease stay 'initial'; plant openCursor.phase as 'tracking'.
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    const spy = installStoreSpy({
      async openCursor(input, realStore) {
        const real = await realStore.openCursor(input);
        if (!real || real.ok !== true) return real;
        return Object.freeze({
          ok: true,
          value: Object.freeze({
            ...real.value,
            phase: 'tracking',
          }),
        });
      },
    });
    try {
      const {
        createAuthorityBoundMessagesDeltaPageOperation,
      } = spy.loadOp();
      const auth = makeAuthorityDb();
      const grant = makeGrantSessionFactory();
      const transportBag = makeTransport();
      const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
        db: auth.db,
        createGrantSession: grant.createGrantSession,
        messagesDeltaPageTransport: transportBag.transport,
        withTransactionClient: harness.withTransactionClient,
        envelopeProvider: envProvider,
      }));
      const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
      ok('phase-mismatch-lease-open-fails', res.ok === false, ser(res));
      ok('phase-mismatch-lease-open-zero-grant',
        grant.getSessionCreates() === 0
        && transportBag.getContinuationCount() === 0);
      ok('phase-mismatch-lease-open-released', spy.count('releaseLease') === 1);
    } finally {
      spy.restore();
    }
  }

  // ── Initial phase + deltaLink cursor rejected before grant ─────────────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    // Seed initial state with a nextLink sealed cursor via store, then force kind
    const {
      createInboundEmailDeltaStateStore,
    } = require('./lib/email-inbound-delta-state-store');
    const seedStore = createInboundEmailDeltaStateStore(Object.freeze({
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
    const init = await seedStore.initializeState(Object.freeze({
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      providerTenantId: TENANT,
      providerMailboxId: MAILBOX,
      queryVersion: QV1,
    }));
    assert.equal(init.ok, true);
    const lease = await seedStore.acquireLease(Object.freeze({
      clientId: CLIENT,
      endpointId: ENDPOINT,
      workerId: 'seed-initial-delta',
      ttlSeconds: 60,
      expectedGeneration: 1,
      expectedStateVersion: 1,
    }));
    assert.equal(lease.ok, true);
    const sealed = await seedStore.sealDeltaCursor(Object.freeze({
      clientId: CLIENT,
      endpointId: ENDPOINT,
      providerTenantId: TENANT,
      providerMailboxId: MAILBOX,
      ingestionGeneration: 1,
      queryVersion: QV1,
      cursorKind: 'deltaLink',
      cursorUrl: PLANTED_DELTA,
      operationId: crypto.randomUUID(),
    }));
    assert.equal(sealed.ok, true);
    // Install sealed cursor material directly while keeping phase initial
    // (bypass commit which would flip phase to tracking for deltaLink).
    harness.mutateCurrent(CLIENT, ENDPOINT, (row) => {
      row.phase = 'initial';
      row.cursor_kind = 'deltaLink';
      row.envelope_version = sealed.value.envelope.envelope_version;
      row.aead_alg = sealed.value.envelope.aead_alg;
      row.kek_wrap_alg = sealed.value.envelope.kek_wrap_alg;
      row.kek_key_name = sealed.value.envelope.kek_key_name;
      row.kek_key_version = sealed.value.envelope.kek_key_version;
      row.nonce = Buffer.from(sealed.value.envelope.nonce);
      row.ciphertext = Buffer.from(sealed.value.envelope.ciphertext);
      row.auth_tag = Buffer.from(sealed.value.envelope.auth_tag);
      row.wrapped_dek = Buffer.from(sealed.value.envelope.wrapped_dek);
      row.cursor_operation_id = sealed.value.envelope.operation_id;
      row.lease_owner = null;
      row.lease_token = null;
      row.lease_until = null;
    });
    const auth = makeAuthorityDb();
    const grant = makeGrantSessionFactory();
    const transportBag = makeTransport();
    const {
      createAuthorityBoundMessagesDeltaPageOperation,
    } = require('./lib/email-authority-bound-messages-delta-page-operation');
    const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
    const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
    ok('initial-deltaLink-rejected', res.ok === false, ser(res));
    ok('initial-deltaLink-zero-grant-network',
      grant.getSessionCreates() === 0
      && transportBag.getInitialCount() === 0
      && transportBag.getContinuationCount() === 0);
  }

  // ── Initial page returning nextLink preserves initial phase ────────────
  {
    const ctx = await buildOperation({
      transport: {
        initialPage: makeTransportPage({
          envelopes: [makeEnvelope('init-next-1')],
          cursor_kind: 'nextLink',
          cursor_url: PLANTED_NEXT,
        }),
      },
    });
    const res = await ctx.run();
    ok('initial-nextLink-committed',
      res.ok === true && res.value.status === 'committed', ser(res));
    ok('initial-nextLink-preserves-initial-phase',
      res.ok && res.value.phase === 'initial', ser(res));
    ok('initial-nextLink-used-initial-fetch',
      ctx.transportBag.getInitialCount() === 1
      && ctx.transportBag.getContinuationCount() === 0);
  }

  // ── Operation-boundary cursor owner / transport aliases scrubbed ────────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    let capturedRef = null;
    const auth = makeAuthorityDb();
    const grant = makeGrantSessionFactory();
    const transportBag = makeTransport({
      continuationImpl: async (input) => {
        capturedRef = input;
        return makeTransportPage({
          envelopes: [makeEnvelope('scrub-1')],
          cursor_kind: 'deltaLink',
          cursor_url: PLANTED_DELTA,
        });
      },
    });
    const {
      createAuthorityBoundMessagesDeltaPageOperation,
    } = require('./lib/email-authority-bound-messages-delta-page-operation');
    const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
    const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
    ok('boundary-scrub-committed', res.ok === true && res.value.status === 'committed', ser(res));
    ok('boundary-scrub-transport-alias',
      capturedRef != null
      && (capturedRef.cursor_url == null || capturedRef.cursor_url === null)
      && (capturedRef.cursor_kind == null || capturedRef.cursor_kind === null)
      && (capturedRef.accessToken == null || capturedRef.accessToken === null),
      ser({
        url: capturedRef && capturedRef.cursor_url,
        kind: capturedRef && capturedRef.cursor_kind,
        token: capturedRef && capturedRef.accessToken,
      }));
    ok('boundary-scrub-loan',
      grant.getLastLoan() && grant.getLastLoan().accessToken == null);
    ok('boundary-scrub-no-secret-in-log', noCursorSecret(harness.log));
  }

  // ── Authority rebind between resolution and state/Graph stages ─────────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    // After seed, rebind durable state to foreign mailbox/tenant while
    // authority resolution still returns the original binding.
    harness.mutateCurrent(CLIENT, ENDPOINT, (row) => {
      row.provider_tenant_id = FOREIGN_TENANT;
      row.provider_mailbox_id = FOREIGN_MAILBOX;
    });
    // Cursor AAD was sealed under TENANT/MAILBOX — open will fail AAD, OR
    // if we clear cursor and use initial... tracking with foreign ids:
    // open may fail cursor_open_failed. Either way: zero durable commit of
    // foreign-bound events and no success.
    const auth = makeAuthorityDb();
    const grant = makeGrantSessionFactory();
    const transportBag = makeTransport({
      continuationPage: makeTransportPage({
        envelopes: [makeEnvelope('rebind-1')],
        cursor_kind: 'deltaLink',
        cursor_url: PLANTED_DELTA,
      }),
    });
    const eventsBefore = harness.events.size;
    const {
      createAuthorityBoundMessagesDeltaPageOperation,
    } = require('./lib/email-authority-bound-messages-delta-page-operation');
    const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
      db: auth.db,
      createGrantSession: grant.createGrantSession,
      messagesDeltaPageTransport: transportBag.transport,
      withTransactionClient: harness.withTransactionClient,
      envelopeProvider: envProvider,
    }));
    const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
    ok('authority-rebind-state-fails', res.ok === false, ser(res));
    ok('authority-rebind-no-new-events', harness.events.size === eventsBefore);
    ok('authority-rebind-not-committed',
      !(res.ok && res.value && res.value.status === 'committed'));
  }

  // ── Commit pre-CAS failure vs CAS conflict ─────────────────────────────
  {
    // Pre-CAS: successor rejected before TX → best-effort release, zero events advance
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    const spy = installStoreSpy({
      async commitPageEvents() {
        return Object.freeze({ ok: false, error: 'successor_cursor_rejected' });
      },
    });
    try {
      const {
        createAuthorityBoundMessagesDeltaPageOperation,
      } = spy.loadOp();
      const auth = makeAuthorityDb();
      const grant = makeGrantSessionFactory();
      const transportBag = makeTransport({
        initialPage: makeTransportPage({
          envelopes: [makeEnvelope('precas-1')],
          cursor_kind: 'deltaLink',
          cursor_url: PLANTED_DELTA,
        }),
      });
      const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
        db: auth.db,
        createGrantSession: grant.createGrantSession,
        messagesDeltaPageTransport: transportBag.transport,
        withTransactionClient: harness.withTransactionClient,
        envelopeProvider: envProvider,
      }));
      const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
      ok('commit-precas-fails', res.ok === false, ser(res));
      ok('commit-precas-release-once', spy.count('releaseLease') === 1, ser(spy.methodNames()));
      ok('commit-precas-not-uncertain',
        !(res.ok && res.value && res.value.status === 'uncertain'));
      ok('commit-precas-order', (() => {
        const m = spy.methodNames();
        return m.indexOf('commitPageEvents') >= 0
          && m.indexOf('releaseLease') > m.indexOf('commitPageEvents');
      })(), ser(spy.methodNames()));
    } finally {
      spy.restore();
    }
  }
  {
    // CAS conflict after TX attempt: same release path, not uncertain
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    const spy = installStoreSpy({
      async commitPageEvents() {
        return Object.freeze({ ok: false, error: 'commit_cas_conflict' });
      },
    });
    try {
      const {
        createAuthorityBoundMessagesDeltaPageOperation,
      } = spy.loadOp();
      const auth = makeAuthorityDb();
      const grant = makeGrantSessionFactory();
      const transportBag = makeTransport({
        initialPage: makeTransportPage({
          envelopes: [makeEnvelope('cas-1')],
          cursor_kind: 'deltaLink',
          cursor_url: PLANTED_DELTA,
        }),
      });
      const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
        db: auth.db,
        createGrantSession: grant.createGrantSession,
        messagesDeltaPageTransport: transportBag.transport,
        withTransactionClient: harness.withTransactionClient,
        envelopeProvider: envProvider,
      }));
      const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
      ok('commit-cas-conflict-fails', res.ok === false, ser(res));
      ok('commit-cas-conflict-release-once', spy.count('releaseLease') === 1);
      ok('commit-cas-conflict-not-uncertain',
        !(res.ok && res.value && res.value.status === 'uncertain'));
      ok('commit-cas-vs-precas-same-action-shape',
        spy.count('commitPageEvents') === 1
        && spy.count('beginNextGeneration') === 0
        && transportBag.getInitialCount() === 1);
    } finally {
      spy.restore();
    }
  }

  // ── Commit unknown stays zero release (call-count) ─────────────────────
  {
    const harness = createFakeDeltaHarness();
    const envProvider = createFakeEmailGrantEnvelopeProvider();
    await seedTrackingState(harness, envProvider);
    const spy = installStoreSpy({
      async commitPageEvents() {
        return Object.freeze({
          ok: false,
          error: 'inbound_delta_state_commit_outcome_unknown',
        });
      },
    });
    try {
      const {
        createAuthorityBoundMessagesDeltaPageOperation,
      } = spy.loadOp();
      const auth = makeAuthorityDb();
      const grant = makeGrantSessionFactory();
      const transportBag = makeTransport({
        continuationPage: makeTransportPage({
          envelopes: [makeEnvelope('unk-count-1')],
          cursor_kind: 'deltaLink',
          cursor_url: PLANTED_DELTA,
        }),
      });
      const op = createAuthorityBoundMessagesDeltaPageOperation(Object.freeze({
        db: auth.db,
        createGrantSession: grant.createGrantSession,
        messagesDeltaPageTransport: transportBag.transport,
        withTransactionClient: harness.withTransactionClient,
        envelopeProvider: envProvider,
      }));
      const res = await op.runAuthorityBoundMessagesDeltaPage(baseInput());
      ok('commit-unknown-spy-uncertain',
        res.ok === true && res.value.status === 'uncertain', ser(res));
      ok('commit-unknown-spy-zero-release',
        spy.count('releaseLease') === 0, ser(spy.methodNames()));
      ok('commit-unknown-spy-zero-reset',
        spy.count('markResetRequired') === 0
        && spy.count('beginNextGeneration') === 0);
      ok('commit-unknown-spy-commit-once', spy.count('commitPageEvents') === 1);
      ok('commit-unknown-spy-single-transport',
        transportBag.getContinuationCount() === 1
        && grant.getSessionCreates() === 1);
    } finally {
      spy.restore();
    }
  }

  // ── Closed-enum internal stage diagnostics (fail-site branding) ────────
  {
    const INTERNAL = Object.freeze([
      'authority', 'status', 'lease', 'grant', 'transport', 'seal', 'store',
      'store_exception',
      'store_page_batch_invalid', 'store_page_tombstones_invalid',
      'store_successor_cursor_rejected', 'store_authority_not_verified', 'release',
    ]);
    const liveOpMod = require('./lib/email-authority-bound-messages-delta-page-operation');
    ok(
      'internal-stages-export-exact',
      Array.isArray(liveOpMod.AUTHORITY_BOUND_PAGE_INTERNAL_STAGES)
        && liveOpMod.AUTHORITY_BOUND_PAGE_INTERNAL_STAGES.join(',') === INTERNAL.join(','),
    );
    ok(
      'internal-stage-reader-export',
      typeof liveOpMod.readTrustedAuthorityBoundPageInternalStage === 'function',
    );
    ok(
      'internal-stage-bind-export',
      typeof liveOpMod.bindTrustedAuthorityBoundPageInternalStageObserver === 'function',
    );

    function assertPublicFail(name, res) {
      ok(
        `${name}-public-fail-byte-schema`,
        res
          && res.ok === false
          && res.error === liveOpMod.FAILURE_CODE
          && res.error === 'authority_bound_messages_delta_page_failed'
          && Reflect.ownKeys(res).join(',') === 'ok,error'
          && Object.isFrozen(res)
          && noLeak(res),
        ser(res),
      );
    }

    function currentOpMod() {
      return require('./lib/email-authority-bound-messages-delta-page-operation');
    }

    function assertTrustedStage(name, target, stage, mod) {
      const reader = mod || currentOpMod();
      const note = reader.readTrustedAuthorityBoundPageInternalStage(target);
      ok(
        `${name}-trusted-stage`,
        note
          && note.stage === stage
          && note.code === stage
          && Reflect.ownKeys(note).join(',') === 'stage,code'
          && Object.isFrozen(note)
          && noLeak(note),
        ser(note),
      );
    }

    const forgedFail = Object.freeze({
      ok: false,
      error: liveOpMod.FAILURE_CODE,
      stage: 'authority',
      code: 'authority',
      message: PLANTED_SUBJECT,
      cursor: PLANTED_NEXT,
      token: PLANTED_TOKEN,
    });
    ok(
      'forged-fail-cannot-classify',
      liveOpMod.readTrustedAuthorityBoundPageInternalStage(forgedFail) == null,
    );
    ok(
      'forged-bind-rejected',
      liveOpMod.bindTrustedAuthorityBoundPageInternalStageObserver(forgedFail, () => {}) === false,
    );

    // authority resolution
    {
      const ctx = await buildOperation({ authority: { rows: [] } });
      const notes = [];
      ok(
        'authority-bind-observer',
        currentOpMod().bindTrustedAuthorityBoundPageInternalStageObserver(ctx.op, (note) => {
          notes.push(note);
        }) === true,
      );
      const res = await ctx.run();
      assertPublicFail('authority', res);
      assertTrustedStage('authority', res, 'authority');
      ok(
        'authority-observer-closed',
        notes.length === 1
          && notes[0].stage === 'authority'
          && notes[0].code === 'authority'
          && noLeak(notes),
        ser(notes),
      );
      ok('authority-zero-transport', ctx.transportBag.getInitialCount() === 0);
    }

    // state status
    {
      const ctx = await buildSpiedOperation({
        handlers: {
          async getPublicStatus() {
            return Object.freeze({ ok: false, error: 'status_unavailable', detail: PLANTED_SUBJECT });
          },
        },
      });
      try {
        const notes = [];
        ctx.mod.bindTrustedAuthorityBoundPageInternalStageObserver(ctx.op, (note) => notes.push(note));
        const res = await ctx.run();
        assertPublicFail('status', res);
        assertTrustedStage('status', res, 'status', ctx.mod);
        ok('status-observer-closed', notes.length === 1 && notes[0].stage === 'status' && noLeak(notes));
        ok('status-zero-lease', ctx.spy.count('acquireLease') === 0);
      } finally {
        ctx.restore();
      }
    }

    // open cursor shares the status seam
    {
      const ctx = await buildSpiedOperation({
        handlers: {
          async openCursor() {
            return Object.freeze({ ok: false, error: 'cursor_open_failed', url: PLANTED_NEXT });
          },
        },
      });
      try {
        const res = await ctx.run();
        assertPublicFail('open-cursor', res);
        assertTrustedStage('open-cursor', res, 'status', ctx.mod);
        ok('open-cursor-zero-grant', ctx.grant.getSessionCreates() === 0);
      } finally {
        ctx.restore();
      }
    }

    // lease
    {
      const ctx = await buildSpiedOperation({
        handlers: {
          async acquireLease() {
            return Object.freeze({ ok: false, error: 'lease_conflict', leaseToken: PLANTED_TOKEN });
          },
        },
      });
      try {
        const res = await ctx.run();
        assertPublicFail('lease', res);
        assertTrustedStage('lease', res, 'lease', ctx.mod);
        ok('lease-zero-open', ctx.spy.count('openCursor') === 0);
      } finally {
        ctx.restore();
      }
    }

    // token / grant
    {
      const ctx = await buildOperation({ grant: { sessionFail: true } });
      const res = await ctx.run();
      assertPublicFail('grant', res);
      assertTrustedStage('grant', res, 'grant');
      ok('grant-zero-transport', ctx.transportBag.getInitialCount() === 0);
    }

    // Graph fetch
    {
      const ctx = await buildOperation({
        transport: {
          initialThrow: Object.assign(new Error(PLANTED_SUBJECT), {
            code: 'microsoft_graph_messages_delta_page_failed',
            body: PLANTED_NEXT,
          }),
        },
      });
      const res = await ctx.run();
      assertPublicFail('transport', res);
      assertTrustedStage('transport', res, 'transport');
      ok('transport-one-initial', ctx.transportBag.getInitialCount() === 1);
    }

    // seal
    {
      const ctx = await buildSpiedOperation({
        handlers: {
          async sealDeltaCursor() {
            return Object.freeze({ ok: false, error: 'cursor_seal_failed', cursor: PLANTED_DELTA });
          },
        },
      });
      try {
        const res = await ctx.run();
        assertPublicFail('seal', res);
        assertTrustedStage('seal', res, 'seal', ctx.mod);
        ok('seal-zero-commit', ctx.spy.count('commitPageEvents') === 0);
      } finally {
        ctx.restore();
      }
    }

    // commit / store
    {
      const ctx = await buildSpiedOperation({
        handlers: {
          async commitPageEvents() {
            return Object.freeze({
              ok: false,
              error: 'commit_cas_conflict',
              envelopes: [PLANTED_SUBJECT],
            });
          },
        },
      });
      try {
        const res = await ctx.run();
        assertPublicFail('store', res);
        assertTrustedStage('store', res, 'store', ctx.mod);
        ok('store-commit-once', ctx.spy.count('commitPageEvents') === 1);
      } finally {
        ctx.restore();
      }
    }

    // thrown commit / store_exception
    {
      const ctx = await buildSpiedOperation({
        handlers: {
          async commitPageEvents() {
            throw Object.assign(new Error(PLANTED_SUBJECT), {
              stack: `NEVER_LOG ${PLANTED_TOKEN}`,
              payload: Object.freeze({ cursor: PLANTED_NEXT }),
            });
          },
        },
      });
      try {
        const notes = [];
        ctx.mod.bindTrustedAuthorityBoundPageInternalStageObserver(ctx.op, (note) => notes.push(note));
        const res = await ctx.run();
        assertPublicFail('store-exception', res);
        assertTrustedStage('store-exception', res, 'store_exception', ctx.mod);
        ok(
          'store-exception-observer-closed',
          notes.length === 1
            && Reflect.ownKeys(notes[0]).join(',') === 'stage,code'
            && notes[0].stage === 'store_exception'
            && notes[0].code === 'store_exception'
            && noLeak(notes),
          ser(notes),
        );
        ok('store-exception-commit-once', ctx.spy.count('commitPageEvents') === 1);
        ok('store-exception-release-once', ctx.spy.count('releaseLease') === 1);
        ok('store-exception-public-no-leak', noLeak(res), ser(res));
      } finally {
        ctx.restore();
      }
    }

    // release (ok:true uncertain still exposes trusted release note)
    {
      let sawCommitOk = false;
      const ctx = await buildSpiedOperation({
        handlers: {
          async commitPageEvents(input, store) {
            const real = await store.commitPageEvents(input);
            sawCommitOk = Boolean(real && real.ok === true);
            return real;
          },
          async releaseLease() {
            return Object.freeze({
              ok: false,
              error: 'inbound_delta_state_commit_outcome_unknown',
              detail: PLANTED_TOKEN,
            });
          },
        },
      });
      try {
        const notes = [];
        ctx.mod.bindTrustedAuthorityBoundPageInternalStageObserver(ctx.op, (note) => notes.push(note));
        const res = await ctx.run();
        ok(
          'release-public-ok-uncertain',
          res.ok === true
            && res.value
            && res.value.status === 'committed_but_lease_release_uncertain'
            && Reflect.ownKeys(res.value).join(',') === liveOpMod.RESULT_KEYS.join(',')
            && noLeak(res)
            && sawCommitOk === true,
          ser(res),
        );
        assertTrustedStage('release', res, 'release', ctx.mod);
        ok(
          'release-observer-closed',
          notes.some((note) => note && note.stage === 'release' && note.code === 'release')
            && noLeak(notes),
          ser(notes),
        );
      } finally {
        ctx.restore();
      }
    }

    const distinct = new Set(INTERNAL);
    ok('internal-stages-are-thirteen-distinct', distinct.size === 13);
  }

  // ── Network never hit ──────────────────────────────────────────────────
  ok('network-hits-zero', networkHits === 0, `hits=${networkHits}`);

  restoreNetworkGuards();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  restoreNetworkGuards();
  console.error('FATAL', err);
  process.exit(2);
});
