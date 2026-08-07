'use strict';

/**
 * Offline RED-GREEN gate: Microsoft Graph messages-delta state store (migration 064).
 *
 * Hostile coverage: migration constraints, sealed cursor coherence, AAD binding,
 * strict authority-bound messages-delta URL validation, page-commit pre-TX crypto
 * open (cross-AAD zero inserts), openCursor post-crypto lease fencing, authority
 * verifier capability (no caller boolean), query_version exact production constant + safe-int gens,
 * one-current invariant, atomicity, duplicate/tombstone, commit-unknown, reset/rebind,
 * public secrecy, proxy/accessor zero-trap, import-inert / no route wiring.
 * No live DB/network/route/cron/deploy.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const STORE_REL = 'scripts/lib/email-inbound-delta-state-store.js';
const MIG_UP = path.join(ROOT, 'database/migrations/064_tenant_email_inbound_delta_states.sql');
const MIG_DOWN = path.join(ROOT, 'database/migrations/064_tenant_email_inbound_delta_states_down.sql');
const MIG_063 = path.join(ROOT, 'database/migrations/063_tenant_email_inbound_events.sql');
const DOC = path.join(ROOT, 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const PKG = path.join(ROOT, 'package.json');
const MANIFEST = path.join(ROOT, 'database/migrations/canonical-manifest.json');

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TENANT = '11111111-1111-4111-8111-111111111111';
const MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const OTHER_CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
const OTHER_ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc';
const OTHER_TENANT = '11111111-1111-4111-8111-111111111112';
const OTHER_MAILBOX = '22222222-2222-4222-8222-2222222222ac';
const PLANTED_SUBJECT = 'SUBJECT_PII_MUST_NOT_APPEAR_DELTA_STATE';
const PLANTED_ADDRESS = 'pii-delta-state@example.com';
const QV1 = 'microsoft_graph_messages_delta_v1';
/** Shape-valid but non-production; must be rejected by parser + migration CHECK. */
const QV_OTHER = 'messages_delta_v2';
const PLANTED_CURSOR =
  `https://graph.microsoft.com/v1.0/users/${MAILBOX}/messages/delta?$deltatoken=SECRET_DELTA_TOKEN_NEVER_LEAK`;
const PLANTED_NEXT =
  `https://graph.microsoft.com/v1.0/users/${MAILBOX}/messages/delta?$skiptoken=SECRET_NEXT_TOKEN_NEVER_LEAK`;

function noLeak(v) {
  const s = typeof v === 'string' ? v : (() => {
    try { return JSON.stringify(v); } catch { return String(v); }
  })();
  return !s.includes(PLANTED_SUBJECT)
    && !s.includes(PLANTED_ADDRESS)
    && !s.includes('SECRET_DELTA_TOKEN')
    && !s.includes('SECRET_NEXT_TOKEN')
    && !s.includes('NEVER_LEAK')
    && !s.includes('refresh_token')
    && !s.includes(PLANTED_CURSOR)
    && !s.includes(PLANTED_NEXT);
}

function envelope(overrides = {}) {
  return {
    provider: 'microsoft_graph',
    provider_mailbox_id: MAILBOX,
    provider_message_id: 'msg-001',
    received_at: '2026-08-01T12:00:00.000Z',
    subject: PLANTED_SUBJECT,
    sender_display_name: 'Sender',
    sender_address: PLANTED_ADDRESS,
    is_read: false,
    conversation_id: 'conv-1',
    internet_message_id: '<a@b>',
    ...overrides,
  };
}

function tombstone(messageId) {
  return {
    provider: 'microsoft_graph',
    provider_mailbox_id: MAILBOX,
    provider_message_id: messageId,
  };
}

function makeAuthorityVerifier(opts = {}) {
  const allow = opts.allow !== false;
  const expected = opts.expected || {
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
  };
  return Object.freeze({
    async verifyBinding(binding) {
      if (!allow) return Object.freeze({ ok: false, error: 'rejected' });
      if (!binding
          || binding.clientId !== expected.clientId
          || binding.locationId !== expected.locationId
          || binding.endpointId !== expected.endpointId
          || binding.providerTenantId !== expected.providerTenantId
          || binding.providerMailboxId !== expected.providerMailboxId) {
        return Object.freeze({ ok: false, error: 'binding_mismatch' });
      }
      return Object.freeze({
        ok: true,
        value: Object.freeze({ ...expected }),
      });
    },
  });
}

/**
 * Accurate multi-client fake for delta state + events.
 * Supports SELECT FOR UPDATE lock, CAS updates, event inserts, public status,
 * post-crypto lease revalidation.
 */
function createFakeDeltaHarness(options = {}) {
  /** @type {Map<string, object>} key = client|endpoint|generation */
  const durableStates = options.states || new Map();
  /** @type {Map<string, object>} event identity */
  const durableEvents = options.events || new Map();
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
          stagedStates.clear();
          stagedEvents.clear();
          deletedStateKeys.clear();
          inTx = false;
          return { rows: [], rowCount: 0 };
        }
        if (norm === 'ROLLBACK') {
          stagedStates.clear();
          stagedEvents.clear();
          deletedStateKeys.clear();
          inTx = false;
          return { rows: [], rowCount: 0 };
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
      deletedStateKeys.clear();
      inTx = false;
    }
  }

  return {
    withTransactionClient,
    states: durableStates,
    events: durableEvents,
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

async function main() {
  const storeAbs = path.join(ROOT, STORE_REL);
  delete require.cache[storeAbs];
  const store = require('./lib/email-inbound-delta-state-store');
  const {
    FAILURE_CODE,
    EMAIL_INBOUND_DELTA_STATE_RUNTIME_WIRED,
    EMAIL_INBOUND_DELTA_STATE_PAGE_COMMIT_OWNER,
    EMAIL_INBOUND_DELTA_STATE_LOGGING_FORBIDDEN,
    PHASES,
    CURSOR_KINDS,
    PROVIDER,
    DEFAULT_QUERY_VERSION,
    MAX_SAFE_GENERATION,
    PUBLIC_STATUS_KEYS,
    SQL_INSERT_EVENT,
    SQL_LOCK_CURRENT,
    SQL_REVALIDATE_LEASE,
    buildDeltaCursorEnvelopeAadV1,
    parseDeltaCursorEnvelopeAadV1,
    encodeDeltaCursorPackageV1,
    decodeDeltaCursorPackageV1,
    validateMessagesDeltaCursorUrl,
    validateGraphCursorUrlBoundary,
    sealDeltaCursorCompatible,
    openSealedDeltaCursor,
    createInboundEmailDeltaStateStore,
    prepareCanonicalBatch,
    prepareTombstones,
    parseQueryVersion,
    parsePositiveSafeInt,
  } = store;

  const {
    createFakeEmailGrantEnvelopeProvider,
  } = require('./lib/email-grant-envelope-fake-provider');

  // ── Static flags / SQL / migration shape ────────────────────────────────
  assert.equal(EMAIL_INBOUND_DELTA_STATE_RUNTIME_WIRED, false);
  assert.equal(EMAIL_INBOUND_DELTA_STATE_PAGE_COMMIT_OWNER, true);
  assert.equal(EMAIL_INBOUND_DELTA_STATE_LOGGING_FORBIDDEN, true);
  assert.deepEqual([...PHASES], ['initial', 'tracking', 'reset_required', 'paused']);
  assert.deepEqual([...CURSOR_KINDS], ['nextLink', 'deltaLink']);
  assert.equal(PROVIDER, 'microsoft_graph');
  assert.equal(DEFAULT_QUERY_VERSION, 'microsoft_graph_messages_delta_v1');
  assert.equal(MAX_SAFE_GENERATION, Number.MAX_SAFE_INTEGER);
  assert.match(SQL_INSERT_EVENT, /ON CONFLICT \(provider, provider_mailbox_id, provider_message_id\) DO NOTHING/);
  assert.match(SQL_LOCK_CURRENT, /is_current = true/);
  assert.match(SQL_LOCK_CURRENT, /FOR UPDATE/);
  assert.match(SQL_REVALIDATE_LEASE, /lease_until > clock_timestamp\(\)/);
  assert.equal(/DO UPDATE/i.test(SQL_INSERT_EVENT), false);

  const up = fs.readFileSync(MIG_UP, 'utf8');
  const down = fs.readFileSync(MIG_DOWN, 'utf8');
  const up063 = fs.readFileSync(MIG_063, 'utf8');
  assert.match(up, /CREATE TABLE tenant_email_inbound_delta_states/);
  assert.match(up, /tenant_email_inbound_delta_states_current_uq/);
  assert.match(up, /WHERE is_current = true/);
  assert.match(up, /UNIQUE \(client_id, endpoint_id, ingestion_generation\)/);
  assert.match(up, /REFERENCES tenant_locations \(client_id, id\)/);
  assert.match(up, /REFERENCES tenant_channel_endpoints \(client_id, id\)/);
  assert.match(up, /provider = 'microsoft_graph'/);
  assert.match(up, /phase IN \('initial', 'tracking', 'reset_required', 'paused'\)/);
  assert.match(up, /cursor_kind IN \('nextLink', 'deltaLink'\)/);
  assert.match(up, /envelope_version = 'v1'/);
  assert.match(up, /aead_alg = 'AES-256-GCM'/);
  assert.match(up, /query_version\s+TEXT NOT NULL/);
  assert.match(up, /9007199254740991/);
  assert.match(up, /tenant_email_inbound_delta_states_query_version_exact/);
  assert.match(up, /query_version = 'microsoft_graph_messages_delta_v1'/);
  assert.equal(/query_version ~ /.test(up), false, 'no shape-regex on query_version');
  assert.match(up, /Independent of tenant_email_delegated_grants\.grant_generation/);
  assert.match(up, /at-most-one/i);
  assert.match(up, /No public delete API|no public delete API/i);
  assert.equal(/INSERT INTO tenant_email_inbound_delta_states/.test(up), false, 'empty on migrate');
  assert.equal(/nextLink|deltaLink/.test(up) && /plaintext/i.test(up), true);
  assert.equal(/\bnext_link\b|\bdelta_link\b|\bcursor_url\b/i.test(up), false);
  assert.match(down, /DROP TABLE IF EXISTS tenant_email_inbound_delta_states/);
  assert.match(up063, /CREATE TABLE tenant_email_inbound_events/);

  // ── Package / manifest / docs registration ──────────────────────────────
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  assert.equal(pkg.scripts['verify:email-inbound-delta-state-store'],
    'node scripts/verify-email-inbound-delta-state-store.js');
  assert.equal(pkg.scripts['prove:email-inbound-delta-state-store-pglite'],
    'node scripts/prove-email-inbound-delta-state-store-pglite.js');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const forward = manifest.entries.filter((e) => e.inForwardChain);
  assert.ok(forward.some((e) => e.id === '064_tenant_email_inbound_delta_states'));
  assert.ok(manifest.entries.some((e) => e.id === '064_tenant_email_inbound_delta_states_down'));
  const doc = fs.readFileSync(DOC, 'utf8');
  assert.match(doc, /inbound-delta-state|delta-state-store|064_tenant_email_inbound_delta/);
  assert.match(doc, /verify:email-inbound-delta-state-store/);

  // ── Safe-int + exact query_version parsers ──────────────────────────────
  assert.equal(parseQueryVersion(QV1).ok, true);
  assert.equal(parseQueryVersion(QV1).value, QV1);
  assert.equal(parseQueryVersion(null).ok, true);
  assert.equal(parseQueryVersion(null).value, DEFAULT_QUERY_VERSION);
  assert.equal(parseQueryVersion(undefined).ok, true);
  assert.equal(parseQueryVersion(undefined).value, DEFAULT_QUERY_VERSION);
  assert.equal(parseQueryVersion(1).ok, false);
  assert.equal(parseQueryVersion('Messages_Delta').ok, false);
  assert.equal(parseQueryVersion(QV_OTHER).ok, false, 'shape-valid alternate rejected');
  assert.equal(parseQueryVersion('microsoft_graph_messages_delta_v1 ').ok, false, 'trailing space rejected');
  assert.equal(parseQueryVersion(' microsoft_graph_messages_delta_v1').ok, false, 'leading space rejected');
  assert.equal(parseQueryVersion('MICROSOFT_GRAPH_MESSAGES_DELTA_V1').ok, false, 'case variant rejected');
  assert.equal(parseQueryVersion('').ok, false);
  assert.equal(parsePositiveSafeInt(1, 'g').ok, true);
  assert.equal(parsePositiveSafeInt(MAX_SAFE_GENERATION, 'g').ok, true);
  assert.equal(parsePositiveSafeInt(MAX_SAFE_GENERATION + 1, 'g').ok, false);
  assert.equal(parsePositiveSafeInt(String(MAX_SAFE_GENERATION) + '0', 'g').ok, false);

  // ── AAD + package + strict messages-delta URL ───────────────────────────
  const aad = buildDeltaCursorEnvelopeAadV1({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    provider: PROVIDER,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1,
    queryVersion: QV1,
    cursorKind: 'nextLink',
  });
  const parsed = parseDeltaCursorEnvelopeAadV1(aad);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.cursor_kind, 'nextLink');
  assert.equal(parsed.value.query_version, QV1);
  assert.equal(typeof parsed.value.ingestion_generation, 'number');
  const aad2 = buildDeltaCursorEnvelopeAadV1({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    provider: PROVIDER,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 2,
    queryVersion: QV1,
    cursorKind: 'nextLink',
  });
  assert.equal(aad.equals(aad2), false);
  assert.throws(
    () => buildDeltaCursorEnvelopeAadV1({
      clientId: CLIENT,
      endpointId: ENDPOINT,
      provider: PROVIDER,
      providerTenantId: TENANT,
      providerMailboxId: MAILBOX,
      ingestionGeneration: 1,
      queryVersion: QV_OTHER,
      cursorKind: 'nextLink',
    }),
    /aad_query_version_invalid/,
  );
  // AAD parse rejects non-exact query_version even if shape-valid.
  const aadBadQvText = [
    'v1',
    'delta_cursor_aad_v1',
    `client_id=${CLIENT}`,
    `endpoint_id=${ENDPOINT}`,
    `provider=${PROVIDER}`,
    `provider_tenant_id=${TENANT}`,
    `provider_mailbox_id=${MAILBOX}`,
    'ingestion_generation=1',
    `query_version=${QV_OTHER}`,
    'cursor_kind=nextLink',
  ].join('\n');
  assert.equal(parseDeltaCursorEnvelopeAadV1(Buffer.from(aadBadQvText, 'utf8')).ok, false);

  const bind = { providerMailboxId: MAILBOX, cursorKind: 'deltaLink' };
  const bindNext = { providerMailboxId: MAILBOX, cursorKind: 'nextLink' };
  const pkgOk = encodeDeltaCursorPackageV1('deltaLink', PLANTED_CURSOR, MAILBOX);
  assert.equal(pkgOk.ok, true);
  const decoded = decodeDeltaCursorPackageV1(pkgOk.value, MAILBOX);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.value.cursor_url, PLANTED_CURSOR);

  // encode/decode require mailbox+kind authority-bound validation
  assert.equal(encodeDeltaCursorPackageV1('deltaLink', 'http://evil/x', MAILBOX).ok, false);
  assert.equal(encodeDeltaCursorPackageV1('nextLink', 'https://evil.com/v1.0/x', MAILBOX).ok, false);
  assert.equal(encodeDeltaCursorPackageV1('nextLink', PLANTED_CURSOR, MAILBOX).ok, false,
    'delta token rejected for nextLink kind');
  assert.equal(encodeDeltaCursorPackageV1('deltaLink', PLANTED_NEXT, MAILBOX).ok, false,
    'skip token rejected for deltaLink kind');

  assert.equal(validateMessagesDeltaCursorUrl(PLANTED_CURSOR, bind).ok, true);
  assert.equal(validateMessagesDeltaCursorUrl(PLANTED_NEXT, bindNext).ok, true);
  assert.equal(validateGraphCursorUrlBoundary(PLANTED_CURSOR, bind).ok, true);
  assert.equal(validateMessagesDeltaCursorUrl('http://graph.microsoft.com/v1.0/x', bind).ok, false);
  assert.equal(validateMessagesDeltaCursorUrl('https://evil.com/v1.0/x', bind).ok, false);
  assert.equal(validateMessagesDeltaCursorUrl(
    `https://user:pass@graph.microsoft.com/v1.0/users/${MAILBOX}/messages/delta?$deltatoken=x`,
    bind,
  ).ok, false);
  assert.equal(validateMessagesDeltaCursorUrl(
    `https://graph.microsoft.com/beta/users/${MAILBOX}/messages/delta?$deltatoken=x`,
    bind,
  ).ok, false);
  assert.equal(validateMessagesDeltaCursorUrl(
    `https://graph.microsoft.com/v1.0/users/${MAILBOX}/messages/delta?$deltatoken=x#frag`,
    bind,
  ).ok, false);
  assert.equal(validateMessagesDeltaCursorUrl(
    `https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=x`,
    bind,
  ).ok, false, 'reject /me resource');
  assert.equal(validateMessagesDeltaCursorUrl(
    `https://graph.microsoft.com/v1.0/users/${OTHER_MAILBOX}/messages/delta?$deltatoken=x`,
    bind,
  ).ok, false, 'wrong mailbox');
  assert.equal(validateMessagesDeltaCursorUrl(
    `https://graph.microsoft.com/v1.0/users/${MAILBOX}/messages?$skiptoken=x`,
    bindNext,
  ).ok, false, 'wrong path resource (not messages/delta)');
  assert.equal(validateMessagesDeltaCursorUrl(
    `https://graph.microsoft.com/v1.0/users/${MAILBOX}/messages/delta?$skiptoken=x&$deltatoken=y`,
    bindNext,
  ).ok, false, 'mixed tokens');
  assert.equal(validateMessagesDeltaCursorUrl(
    `https://graph.microsoft.com/v1.0/users/${MAILBOX}/messages/delta?$filter=x`,
    bindNext,
  ).ok, false, 'filter rejected');
  assert.equal(validateMessagesDeltaCursorUrl(
    `https://graph.microsoft.com/v1.0/users/${MAILBOX}/messages/delta?$deltatoken=x`,
    bindNext,
  ).ok, false, 'token-kind mismatch');
  assert.equal(validateMessagesDeltaCursorUrl(
    `https://graph.microsoft.com/v1.0/users/${MAILBOX}/messages/delta`,
    bindNext,
  ).ok, false, 'missing token');
  assert.equal(validateMessagesDeltaCursorUrl(
    { toString: () => PLANTED_NEXT },
    bindNext,
  ).ok, false, 'non-primitive rejected');

  // Module-init-pinned URL + ambient monkeypatch zero-touch
  const storeSrcEarly = fs.readFileSync(storeAbs, 'utf8');
  assert.match(storeSrcEarly, /require\(['"]node:url['"]\)/);
  assert.match(storeSrcEarly, /PINNED_URL_INTRINSICS_READY/);
  assert.match(storeSrcEarly, /PINNED_REFLECT_APPLY|Reflect\.apply/);
  assert.match(storeSrcEarly, /validateMessagesDeltaCursorUrl/);
  assert.equal(/\bnew URL\s*\(/.test(storeSrcEarly), false, 'no ambient new URL()');
  assert.equal(/\bverifiedAuthority\b/.test(storeSrcEarly), true);
  // verifiedAuthority may only appear as reject path, not acceptance
  assert.match(storeSrcEarly, /authorityVerifier|verifyBinding/);
  assert.match(storeSrcEarly, /SQL_REVALIDATE_LEASE|revalidate/i);
  assert.match(storeSrcEarly, /successor_cursor_rejected|openSealedDeltaCursor/);
  assert.equal(/query_version = \$7::bigint/.test(storeSrcEarly), false);

  const savedGlobalUrl = globalThis.URL;
  const protoDesc = Object.getOwnPropertyDescriptor(require('node:url').URL.prototype, 'hostname');
  let ambientCtorHits = 0;
  try {
    globalThis.URL = function HostileURL() {
      ambientCtorHits += 1;
      throw new Error('ambient_url_must_not_run');
    };
    Object.defineProperty(require('node:url').URL.prototype, 'hostname', {
      configurable: true,
      get() { return 'evil.example'; },
    });
    assert.equal(validateMessagesDeltaCursorUrl(PLANTED_CURSOR, bind).ok, true);
    assert.equal(validateMessagesDeltaCursorUrl('https://evil.com/v1.0/x', bind).ok, false);
    assert.equal(encodeDeltaCursorPackageV1('deltaLink', PLANTED_CURSOR, MAILBOX).ok, true);
    assert.equal(encodeDeltaCursorPackageV1('deltaLink', 'http://evil/x', MAILBOX).ok, false);
    assert.equal(ambientCtorHits, 0, 'ambient global URL constructor never invoked');
  } finally {
    globalThis.URL = savedGlobalUrl;
    if (protoDesc) {
      Object.defineProperty(require('node:url').URL.prototype, 'hostname', protoDesc);
    }
  }

  // Proxy URL input zero-trap (object targets only — primitives cannot be Proxy targets)
  const urlTrapHits = { get: 0, ownKeys: 0, apply: 0 };
  const hostileObj = new Proxy({ href: PLANTED_NEXT }, {
    get(t, p, r) { urlTrapHits.get += 1; return Reflect.get(t, p, r); },
    ownKeys(t) { urlTrapHits.ownKeys += 1; return Reflect.ownKeys(t); },
  });
  assert.equal(validateMessagesDeltaCursorUrl(hostileObj, bindNext).ok, false);
  assert.equal(urlTrapHits.get, 0, 'proxy get trap must not run on URL boundary');
  assert.equal(urlTrapHits.ownKeys, 0, 'proxy ownKeys trap must not run on URL boundary');

  // ── Seal / open roundtrip + AAD cross-scope failure ─────────────────────
  const envProvider = createFakeEmailGrantEnvelopeProvider();
  const sealed = await sealDeltaCursorCompatible(envProvider, Object.freeze({
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
  assert.equal(sealed.ok, true, JSON.stringify(sealed));
  assert.equal(sealed.value.cursor_kind, 'nextLink');
  assert.ok(sealed.value.envelope.ciphertext);
  assert.equal(noLeak(sealed.value.envelope.ciphertext.toString('utf8')), true);

  const opened = await openSealedDeltaCursor(envProvider, Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1,
    queryVersion: QV1,
    cursorKind: 'nextLink',
    envelope: sealed.value.envelope,
  }));
  assert.equal(opened.ok, true);
  assert.equal(opened.value.cursor_url, PLANTED_NEXT);

  for (const [label, patch] of [
    ['generation', { ingestionGeneration: 2 }],
    ['queryVersion', { queryVersion: QV_OTHER }],
    ['cursorKind', { cursorKind: 'deltaLink' }],
    ['client', { clientId: OTHER_CLIENT }],
    ['endpoint', { endpointId: OTHER_ENDPOINT }],
    ['tenant', { providerTenantId: OTHER_TENANT }],
    ['mailbox', { providerMailboxId: OTHER_MAILBOX }],
  ]) {
    const cross = await openSealedDeltaCursor(envProvider, Object.freeze({
      clientId: CLIENT,
      endpointId: ENDPOINT,
      providerTenantId: TENANT,
      providerMailboxId: MAILBOX,
      ingestionGeneration: 1,
      queryVersion: QV1,
      cursorKind: 'nextLink',
      envelope: sealed.value.envelope,
      ...patch,
    }));
    assert.equal(cross.ok, false, `AAD ${label} mismatch fails closed`);
  }

  // ── Factory boundary ────────────────────────────────────────────────────
  assert.throws(
    () => createInboundEmailDeltaStateStore(Object.freeze({ db: {} })),
    (err) => err && err.code === FAILURE_CODE,
  );
  assert.throws(
    () => createInboundEmailDeltaStateStore(Object.freeze({
      withTransactionClient: new Proxy(async () => {}, {
        apply() { throw new Error('proxy must not run'); },
      }),
    })),
    (err) => err && err.code === FAILURE_CODE,
  );

  // ── initialize → acquire → commit nextLink → commit deltaLink ───────────
  const harness = createFakeDeltaHarness();
  const authorityVerifier = makeAuthorityVerifier();
  const deltaStore = createInboundEmailDeltaStateStore(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
    envelopeProvider: envProvider,
    authorityVerifier,
  }));

  const init = await deltaStore.initializeState(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: QV1,
  }));
  assert.equal(init.ok, true, JSON.stringify(init));
  assert.equal(init.value.phase, 'initial');
  assert.equal(init.value.ingestion_generation, 1);
  assert.equal(init.value.query_version, QV1);
  assert.equal(init.value.state_version, 1);

  const lease = await deltaStore.acquireLease(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    workerId: 'runner-1',
    ttlSeconds: 60,
    expectedGeneration: 1,
    expectedStateVersion: 1,
  }));
  assert.equal(lease.ok, true, JSON.stringify(lease));
  assert.equal(lease.value.query_version, QV1);
  let sv = lease.value.state_version;
  const token = lease.value.lease_token;

  const sealedNext = await deltaStore.sealDeltaCursor(Object.freeze({
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
  assert.equal(sealedNext.ok, true);

  const page1 = await deltaStore.commitPageEvents(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: sv,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: QV1,
    envelopes: Object.freeze([
      envelope({ provider_message_id: 'msg-001' }),
      envelope({ provider_message_id: 'msg-002' }),
    ]),
    tombstones: Object.freeze([]),
    successorCursor: Object.freeze({
      cursor_kind: 'nextLink',
      envelope: sealedNext.value.envelope,
    }),
  }));
  assert.equal(page1.ok, true, JSON.stringify(page1));
  assert.equal(page1.value.cursor_kind, 'nextLink');
  assert.equal(page1.value.phase, 'initial');
  assert.equal(page1.value.envelopes_presented, 2);
  assert.equal(harness.events.size, 2);
  sv = page1.value.state_version;

  // Duplicate-only page still advances
  const sealedNext2 = await deltaStore.sealDeltaCursor(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1,
    queryVersion: QV1,
    cursorKind: 'nextLink',
    cursorUrl: PLANTED_NEXT.replace('SECRET_NEXT_TOKEN_NEVER_LEAK', 'SECRET_NEXT_TOKEN_NEVER_LEAK_2'),
    operationId: crypto.randomUUID(),
  }));
  const pageDup = await deltaStore.commitPageEvents(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: sv,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: QV1,
    envelopes: Object.freeze([
      envelope({ provider_message_id: 'msg-001' }),
      envelope({ provider_message_id: 'msg-002' }),
    ]),
    tombstones: Object.freeze([]),
    successorCursor: Object.freeze({
      cursor_kind: 'nextLink',
      envelope: sealedNext2.value.envelope,
    }),
  }));
  assert.equal(pageDup.ok, true);
  assert.equal(harness.events.size, 2, 'duplicates do not insert');
  assert.ok(pageDup.value.state_version > sv);
  sv = pageDup.value.state_version;

  // terminal deltaLink transition + tombstone-only
  const sealedDelta = await deltaStore.sealDeltaCursor(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1,
    queryVersion: QV1,
    cursorKind: 'deltaLink',
    cursorUrl: PLANTED_CURSOR,
    operationId: crypto.randomUUID(),
  }));
  const pageTerm = await deltaStore.commitPageEvents(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: sv,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: QV1,
    envelopes: Object.freeze([]),
    tombstones: Object.freeze([tombstone('deleted-1')]),
    successorCursor: Object.freeze({
      cursor_kind: 'deltaLink',
      envelope: sealedDelta.value.envelope,
    }),
  }));
  assert.equal(pageTerm.ok, true, JSON.stringify(pageTerm));
  assert.equal(pageTerm.value.cursor_kind, 'deltaLink');
  assert.equal(pageTerm.value.phase, 'tracking');
  assert.equal(harness.events.size, 2, 'tombstone creates no synthetic event');
  sv = pageTerm.value.state_version;

  // open under lease
  const openedCursor = await deltaStore.openCursor(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: sv,
  }));
  assert.equal(openedCursor.ok, true, JSON.stringify(openedCursor));
  assert.equal(openedCursor.value.cursor_present, true);
  assert.equal(openedCursor.value.cursor_kind, 'deltaLink');
  assert.equal(openedCursor.value.cursor_url, PLANTED_CURSOR);

  // public status strips secrets
  const status = await deltaStore.getPublicStatus(Object.freeze({
    clientId: CLIENT, endpointId: ENDPOINT,
  }));
  assert.equal(status.ok, true);
  assert.equal(status.value.state_present, true);
  assert.equal(status.value.cursor_kind, 'deltaLink');
  assert.equal(status.value.query_version, QV1);
  assert.equal('cursor_url' in status.value, false);
  assert.equal('lease_token' in status.value, false);
  assert.equal('provider_mailbox_id' in status.value, false);
  assert.equal('provider_tenant_id' in status.value, false);
  assert.deepEqual(Object.keys(status.value).sort(), [...PUBLIC_STATUS_KEYS].sort());
  assert.equal(noLeak(status.value), true);

  // ── Hostile sealed successor: cross-AAD → zero inserts / zero cursor advance ──
  const eventsBeforeHostile = harness.events.size;
  const cursorKindBefore = [...harness.states.values()].find((r) => r.is_current).cursor_kind;
  const svBeforeHostile = [...harness.states.values()].find((r) => r.is_current).state_version;

  const otherDeltaUrl =
    `https://graph.microsoft.com/v1.0/users/${OTHER_MAILBOX}/messages/delta?$deltatoken=SECRET_DELTA_OTHER`;
  const hostileCases = [
    {
      label: 'client',
      seal: { clientId: OTHER_CLIENT },
      claimKind: 'deltaLink',
    },
    {
      label: 'endpoint',
      seal: { endpointId: OTHER_ENDPOINT },
      claimKind: 'deltaLink',
    },
    {
      label: 'tenant',
      seal: { providerTenantId: OTHER_TENANT },
      claimKind: 'deltaLink',
    },
    {
      label: 'mailbox',
      seal: {
        providerMailboxId: OTHER_MAILBOX,
        cursorUrl: otherDeltaUrl,
      },
      claimKind: 'deltaLink',
    },
    {
      label: 'generation',
      seal: { ingestionGeneration: 99 },
      claimKind: 'deltaLink',
    },
    {
      label: 'kind',
      seal: { cursorKind: 'nextLink', cursorUrl: PLANTED_NEXT },
      claimKind: 'deltaLink',
    },
  ];
  // Non-production query_version cannot seal (exact constant only).
  const sealBadQv = await sealDeltaCursorCompatible(envProvider, Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1,
    queryVersion: QV_OTHER,
    cursorKind: 'deltaLink',
    cursorUrl: PLANTED_CURSOR,
    operationId: crypto.randomUUID(),
  }));
  assert.equal(sealBadQv.ok, false, 'non-exact query_version cannot seal');

  for (const hc of hostileCases) {
    const sealArgs = {
      clientId: CLIENT,
      endpointId: ENDPOINT,
      providerTenantId: TENANT,
      providerMailboxId: MAILBOX,
      ingestionGeneration: 1,
      queryVersion: QV1,
      cursorKind: 'deltaLink',
      cursorUrl: PLANTED_CURSOR,
      operationId: crypto.randomUUID(),
      ...hc.seal,
    };
    const sealedHostile = await sealDeltaCursorCompatible(envProvider, Object.freeze(sealArgs));
    assert.equal(sealedHostile.ok, true, `hostile ${hc.label} must seal under its own AAD`);
    const commitHostile = await deltaStore.commitPageEvents(Object.freeze({
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      leaseToken: token,
      expectedGeneration: 1,
      expectedStateVersion: sv,
      providerTenantId: TENANT,
      providerMailboxId: MAILBOX,
      queryVersion: QV1,
      envelopes: Object.freeze([
        envelope({ provider_message_id: `hostile-${hc.label}` }),
      ]),
      tombstones: Object.freeze([]),
      successorCursor: Object.freeze({
        cursor_kind: hc.claimKind,
        envelope: sealedHostile.value.envelope,
      }),
    }));
    assert.equal(commitHostile.ok, false, `hostile ${hc.label} must reject`);
    assert.equal(harness.events.size, eventsBeforeHostile, `zero inserts on hostile ${hc.label}`);
    const cur = [...harness.states.values()].find((r) => r.is_current);
    assert.equal(cur.state_version, svBeforeHostile, `zero cursor advance on hostile ${hc.label}`);
    assert.equal(cur.cursor_kind, cursorKindBefore);
  }

  // ── Planted delayed-open takeover/expiry (post-crypto lease fence) ──────
  // After first lease read, another worker reacquires / expires lease before
  // plaintext release → openCursor must return no cursor.
  let openLoans = 0;
  harness.setOnLoanStart(async ({ loanId }) => {
    openLoans += 1;
    // After first openCursor TX commits (loan for read), and before second
    // revalidation loan, expire the lease via clock + clear token.
    // openCursor uses: loan1=read, (crypto outside), loan2=revalidate.
    // We mutate durable state after loan 1 completes — hook runs at loan start
    // so on loan 2 start we take over.
    if (openLoans === 2) {
      harness.mutateCurrent(CLIENT, ENDPOINT, (row) => {
        row.lease_owner = 'takeover-worker';
        row.lease_token = crypto.randomUUID();
        row.lease_until = new Date(harness.getClockMs() + 60_000);
        row.state_version = Number(row.state_version) + 1;
      });
    }
  });
  const fencedOpen = await deltaStore.openCursor(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: sv,
  }));
  harness.setOnLoanStart(null);
  assert.equal(fencedOpen.ok, false, 'stale lease after crypto must not release cursor');
  assert.ok(
    fencedOpen.error === 'lease_fenced' || fencedOpen.error === 'lease_expired'
      || fencedOpen.error === 'state_version_mismatch'
      || fencedOpen.error === 'generation_mismatch',
    fencedOpen.error,
  );

  // Restore lease for remaining tests
  harness.mutateCurrent(CLIENT, ENDPOINT, (row) => {
    row.lease_owner = 'runner-1';
    row.lease_token = token;
    row.lease_until = new Date(harness.getClockMs() + 120_000);
    // keep elevated state_version from takeover mutation
  });
  sv = [...harness.states.values()].find((r) => r.is_current).state_version;

  // ── commit-unknown (COMMIT reject after send) ───────────────────────────
  const sealedCu = await deltaStore.sealDeltaCursor(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1,
    queryVersion: QV1,
    cursorKind: 'deltaLink',
    cursorUrl: PLANTED_CURSOR.replace('SECRET_DELTA', 'SECRET_DELTA_CU'),
    operationId: crypto.randomUUID(),
  }));
  assert.equal(sealedCu.ok, true);
  harness.setCommitReject(true);
  const unknown = await deltaStore.commitPageEvents(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: sv,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: QV1,
    envelopes: Object.freeze([envelope({ provider_message_id: 'msg-unknown' })]),
    tombstones: Object.freeze([]),
    successorCursor: Object.freeze({
      cursor_kind: 'deltaLink',
      envelope: sealedCu.value.envelope,
    }),
  }));
  harness.setCommitReject(false);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'inbound_delta_state_commit_outcome_unknown');
  // uncertainty: never claims rollback; events may or may not be durable — harness
  // rejects COMMIT so staged is discarded; size unchanged is the fake model.
  assert.equal(harness.events.has(`microsoft_graph\0${MAILBOX}\0msg-unknown`), false);

  // replay converges after unknown
  const sealedReplay = await deltaStore.sealDeltaCursor(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1,
    queryVersion: QV1,
    cursorKind: 'deltaLink',
    cursorUrl: PLANTED_CURSOR.replace('SECRET_DELTA', 'SECRET_DELTA_REPLAY'),
    operationId: crypto.randomUUID(),
  }));
  const replay = await deltaStore.commitPageEvents(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    leaseToken: token,
    expectedGeneration: 1,
    expectedStateVersion: sv,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: QV1,
    envelopes: Object.freeze([envelope({ provider_message_id: 'msg-cu' })]),
    tombstones: Object.freeze([]),
    successorCursor: Object.freeze({
      cursor_kind: 'deltaLink',
      envelope: sealedReplay.value.envelope,
    }),
  }));
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(harness.events.has(`microsoft_graph\0${MAILBOX}\0msg-cu`), true);
  sv = replay.value.state_version;

  // ── reset required + next generation (authority verifier, no boolean) ───
  const reset = await deltaStore.markResetRequired(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    expectedGeneration: 1,
    expectedStateVersion: sv,
    reason: 'graph_410_gone',
  }));
  assert.equal(reset.ok, true);
  assert.equal(reset.value.phase, 'reset_required');

  // Non-exact query_version rejected (not caller-chosen).
  const badQvNext = await deltaStore.beginNextGeneration(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    expectedGeneration: 1,
    expectedStateVersion: reset.value.state_version,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: QV_OTHER,
  }));
  assert.equal(badQvNext.ok, false);
  assert.equal(badQvNext.error, 'query_version_invalid');

  // caller boolean self-assert rejected even if true
  const boolAuth = await deltaStore.beginNextGeneration(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    expectedGeneration: 1,
    expectedStateVersion: reset.value.state_version,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: QV1,
    verifiedAuthority: true,
  }));
  assert.equal(boolAuth.ok, false);
  assert.equal(boolAuth.error, 'authority_not_verified');

  // wrong mailbox via verifier fails
  const badVerifierStore = createInboundEmailDeltaStateStore(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
    envelopeProvider: envProvider,
    authorityVerifier: makeAuthorityVerifier({ allow: false }),
  }));
  const noAuth = await badVerifierStore.beginNextGeneration(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    expectedGeneration: 1,
    expectedStateVersion: reset.value.state_version,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: QV1,
  }));
  assert.equal(noAuth.ok, false);
  assert.equal(noAuth.error, 'authority_not_verified');

  // without authorityVerifier factory dep
  const noVerStore = createInboundEmailDeltaStateStore(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
    envelopeProvider: envProvider,
  }));
  const missingVer = await noVerStore.beginNextGeneration(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    expectedGeneration: 1,
    expectedStateVersion: reset.value.state_version,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: QV1,
  }));
  assert.equal(missingVer.ok, false);
  assert.equal(missingVer.error, 'authority_verifier_required');

  const next = await deltaStore.beginNextGeneration(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    expectedGeneration: 1,
    expectedStateVersion: reset.value.state_version,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: QV1,
  }));
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(next.value.ingestion_generation, 2);
  assert.equal(next.value.query_version, QV1);
  assert.equal(next.value.phase, 'initial');
  assert.equal(next.value.previous_generation, 1);

  // one-current invariant after rebind
  let currentCount = 0;
  let oldGenPresent = 0;
  for (const row of harness.states.values()) {
    if (row.endpoint_id === ENDPOINT && row.is_current) currentCount += 1;
    if (row.ingestion_generation === 1) oldGenPresent += 1;
  }
  assert.equal(currentCount, 1, 'exactly one current after rebind');
  assert.equal(oldGenPresent, 1, 'old generation preserved');
  assert.ok(harness.events.size >= 2, 'events preserved across generation rebind');

  // grant generation independence
  const storeSrc = fs.readFileSync(storeAbs, 'utf8');
  assert.equal(/tenant_email_delegated_grants/.test(storeSrc), false);
  assert.equal(/\bgrant_generation\b/.test(storeSrc), false);
  assert.match(storeSrc, /EMAIL_INBOUND_DELTA_STATE_RUNTIME_WIRED = false/);
  assert.equal(/require\(['"]\.\/staff-/.test(storeSrc), false);
  assert.equal(/fetch\(|axios|http\.request/.test(storeSrc), false);
  assert.equal(/\bnet\.connect\b|\bhttps?\.request\b|\baxios\b|\bnode-fetch\b/.test(storeSrc), false);
  // no delete API for states
  assert.equal(/deleteState|deleteCurrent|DROP ROW|DELETE FROM tenant_email_inbound_delta/.test(storeSrc), false);

  // ── hostile inputs ──────────────────────────────────────────────────────
  assert.equal(prepareCanonicalBatch(null, MAILBOX).ok, true);
  assert.equal(prepareCanonicalBatch([envelope({ provider_mailbox_id: 'other' })], MAILBOX).ok, false);
  assert.equal(prepareTombstones([tombstone('x')], MAILBOX).ok, true);
  assert.equal(prepareTombstones([{
    provider: 'gmail_api', provider_mailbox_id: MAILBOX, provider_message_id: 'x',
  }], MAILBOX).ok, false);

  const proxyTrapHits = { get: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, getPrototypeOf: 0 };
  const proxyEnv = new Proxy([envelope()], {
    get(t, p, r) { proxyTrapHits.get += 1; return Reflect.get(t, p, r); },
    ownKeys(t) { proxyTrapHits.ownKeys += 1; return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor(t, p) {
      proxyTrapHits.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(t, p);
    },
    getPrototypeOf(t) { proxyTrapHits.getPrototypeOf += 1; return Reflect.getPrototypeOf(t); },
  });
  const proxyBatch = prepareCanonicalBatch(proxyEnv, MAILBOX);
  assert.equal(proxyBatch.ok, false, 'proxy envelope array must fail closed');
  assert.equal(proxyTrapHits.get, 0);
  assert.equal(proxyTrapHits.ownKeys, 0);
  assert.equal(proxyTrapHits.getOwnPropertyDescriptor, 0);
  assert.equal(proxyTrapHits.getPrototypeOf, 0);

  const accessorEnv = {};
  Object.defineProperty(accessorEnv, 'provider', {
    enumerable: true,
    get() { return 'microsoft_graph'; },
  });
  Object.defineProperty(accessorEnv, 'provider_mailbox_id', {
    enumerable: true, value: MAILBOX,
  });
  Object.defineProperty(accessorEnv, 'provider_message_id', {
    enumerable: true, value: 'acc-1',
  });
  Object.defineProperty(accessorEnv, 'received_at', {
    enumerable: true, value: '2026-08-01T12:00:00.000Z',
  });
  Object.defineProperty(accessorEnv, 'subject', { enumerable: true, value: 'x' });
  Object.defineProperty(accessorEnv, 'sender_display_name', { enumerable: true, value: 'x' });
  Object.defineProperty(accessorEnv, 'sender_address', { enumerable: true, value: 'a@b.c' });
  Object.defineProperty(accessorEnv, 'is_read', { enumerable: true, value: false });
  Object.defineProperty(accessorEnv, 'conversation_id', { enumerable: true, value: null });
  Object.defineProperty(accessorEnv, 'internet_message_id', { enumerable: true, value: null });
  assert.equal(prepareCanonicalBatch([accessorEnv], MAILBOX).ok, false);

  // stale lease token cannot commit
  const leaseFresh = await deltaStore.acquireLease(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    workerId: 'runner-fresh',
    ttlSeconds: 60,
    expectedGeneration: 2,
    expectedStateVersion: 1,
  }));
  assert.equal(leaseFresh.ok, true);
  const sealedStale = await deltaStore.sealDeltaCursor(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 2,
    queryVersion: QV1,
    cursorKind: 'nextLink',
    cursorUrl: PLANTED_NEXT,
    operationId: crypto.randomUUID(),
  }));
  assert.equal(sealedStale.ok, true, JSON.stringify(sealedStale));
  const staleCommit = await deltaStore.commitPageEvents(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    leaseToken: crypto.randomUUID(),
    expectedGeneration: 2,
    expectedStateVersion: leaseFresh.value.state_version,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: QV1,
    envelopes: Object.freeze([]),
    tombstones: Object.freeze([]),
    successorCursor: Object.freeze({
      cursor_kind: 'nextLink',
      envelope: sealedStale.value.envelope,
    }),
  }));
  assert.equal(staleCommit.ok, false);

  // Non-exact query_version claim fails closed (parser; not caller-chosen).
  const qvMismatch = await deltaStore.commitPageEvents(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    leaseToken: leaseFresh.value.lease_token,
    expectedGeneration: 2,
    expectedStateVersion: leaseFresh.value.state_version,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: 'messages_delta_v99',
    envelopes: Object.freeze([]),
    tombstones: Object.freeze([]),
    successorCursor: Object.freeze({
      cursor_kind: 'nextLink',
      envelope: sealedStale.value.envelope,
    }),
  }));
  assert.equal(qvMismatch.ok, false);
  assert.equal(qvMismatch.error, 'query_version_invalid');

  // release lease
  const rel = await deltaStore.releaseLease(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    leaseToken: leaseFresh.value.lease_token,
    expectedGeneration: 2,
    expectedStateVersion: leaseFresh.value.state_version,
  }));
  assert.equal(rel.ok, true);

  // Cursor capability secrets must never appear in SQL text or bind params.
  for (const entry of harness.log) {
    const s = JSON.stringify(entry);
    assert.equal(s.includes('SECRET_DELTA_TOKEN'), false, 'no delta token in sql log');
    assert.equal(s.includes('SECRET_NEXT_TOKEN'), false, 'no next token in sql log');
    assert.equal(s.includes(PLANTED_CURSOR), false, 'no plaintext cursor url in sql log');
    assert.equal(s.includes(PLANTED_NEXT), false, 'no plaintext next url in sql log');
    assert.equal(s.includes('refresh_token'), false, 'no refresh_token key in sql log');
  }

  console.log('PASS verify-email-inbound-delta-state-store');
}

main().catch((err) => {
  console.error('FAIL verify-email-inbound-delta-state-store');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
