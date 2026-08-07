'use strict';

/**
 * Offline RED-GREEN gate: Microsoft Graph messages-delta state store (migration 064).
 *
 * Hostile coverage: migration constraints, sealed cursor coherence, AAD binding,
 * page-commit atomicity (insert+cursor), duplicate/tombstone advance, commit-unknown,
 * lease CAS/fence, generation rebind, grant-generation independence, public DTO
 * sanitization, proxy/accessor/symbol rejection, import-inert / no route wiring.
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
const PLANTED_SUBJECT = 'SUBJECT_PII_MUST_NOT_APPEAR_DELTA_STATE';
const PLANTED_ADDRESS = 'pii-delta-state@example.com';
const PLANTED_CURSOR = 'https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=SECRET_DELTA_TOKEN_NEVER_LEAK';
const PLANTED_NEXT = 'https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=SECRET_NEXT_TOKEN_NEVER_LEAK';

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

/**
 * Accurate multi-client fake for delta state + events.
 * Supports SELECT FOR UPDATE lock, CAS updates, event inserts, public status.
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
      // Prefer staged current rows. A staged demotion must shadow the durable
      // current row of the same generation during this transaction.
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

        // public status first (also ends with is_current=true; must not hit lock matcher)
        if (/has_active_lease/.test(norm) && /has_sealed_cursor/.test(norm)
            && /FROM tenant_email_inbound_delta_states/.test(norm)) {
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

        // lease unexpired check (openCursor)
        if (/AS ok/.test(norm)
            && /lease_until IS NOT NULL AND lease_until > clock_timestamp\(\)/.test(norm)
            && /FROM tenant_email_inbound_delta_states/.test(norm)) {
          const row = readCurrent(params[0], params[1]);
          if (!row || String(row.lease_token) !== String(params[2])) {
            return { rows: [{ ok: false }], rowCount: 1 };
          }
          const okLive = row.lease_until != null && new Date(row.lease_until).getTime() > clockMs;
          return { rows: [{ ok: okLive }], rowCount: 1 };
        }

        // SELECT * current FOR UPDATE (lock current generation only)
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
          // initial: gen fixed 1, qv=$7; next: gen=$7, qv=$8
          const isNext = /\$7::bigint, \$8::bigint, true/.test(norm)
            || norm.includes('$7::bigint, $8::bigint');
          const gen = isNext ? Number(genOrQv) : 1;
          const qv = isNext ? Number(maybeQv) : Number(genOrQv);
          // demote check for current unique
          const existingCurrent = readCurrent(clientId, endpointId);
          if (existingCurrent && existingCurrent.is_current) {
            // next-gen path demotes first; if still current → unique violation
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

        // COMMIT CURSOR
        if (/SET cursor_kind = \$8/.test(norm)) {
          const [
            clientId, endpointId, gen, sv, token, mailbox, qv,
            cursorKind,
            envVer, aead, wrap, kekName, kekVer,
            nonce, ciphertext, authTag, wrappedDek, opId, phase,
          ] = params;
          const row = readCurrent(clientId, endpointId);
          if (!row
              || Number(row.ingestion_generation) !== Number(gen)
              || Number(row.state_version) !== Number(sv)
              || String(row.lease_token) !== String(token)
              || row.lease_until == null
              || new Date(row.lease_until).getTime() <= clockMs
              || String(row.provider_mailbox_id) !== String(mailbox)
              || Number(row.query_version) !== Number(qv)
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

        throw new Error(`unexpected sql: ${norm.slice(0, 120)}`);
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
    setFailOn(fn) { failOn = fn; },
    setCommitReject(v) { commitShouldReject = v; },
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
    PUBLIC_STATUS_KEYS,
    SQL_INSERT_EVENT,
    SQL_LOCK_CURRENT,
    buildDeltaCursorEnvelopeAadV1,
    parseDeltaCursorEnvelopeAadV1,
    encodeDeltaCursorPackageV1,
    decodeDeltaCursorPackageV1,
    validateGraphCursorUrlBoundary,
    sealDeltaCursorCompatible,
    openSealedDeltaCursor,
    createInboundEmailDeltaStateStore,
    prepareCanonicalBatch,
    prepareTombstones,
    resolveWithTransactionClient,
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
  assert.match(SQL_INSERT_EVENT, /ON CONFLICT \(provider, provider_mailbox_id, provider_message_id\) DO NOTHING/);
  assert.match(SQL_LOCK_CURRENT, /is_current = true/);
  assert.match(SQL_LOCK_CURRENT, /FOR UPDATE/);
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
  assert.match(up, /ingestion_generation >= 1/);
  assert.match(up, /Independent of tenant_email_delegated_grants\.grant_generation/);
  assert.equal(/INSERT INTO tenant_email_inbound_delta_states/.test(up), false, 'empty on migrate');
  assert.equal(/nextLink|deltaLink/.test(up) && /plaintext/i.test(up), true);
  // never store plaintext URL columns
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

  // ── AAD + package + URL boundary ────────────────────────────────────────
  const aad = buildDeltaCursorEnvelopeAadV1({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    provider: PROVIDER,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1n,
    queryVersion: 1n,
    cursorKind: 'nextLink',
  });
  const parsed = parseDeltaCursorEnvelopeAadV1(aad);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.cursor_kind, 'nextLink');
  // Wrong generation rebuild fails closed on open path (different AAD bytes).
  const aad2 = buildDeltaCursorEnvelopeAadV1({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    provider: PROVIDER,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 2n,
    queryVersion: 1n,
    cursorKind: 'nextLink',
  });
  assert.equal(aad.equals(aad2), false);

  const pkgOk = encodeDeltaCursorPackageV1('deltaLink', PLANTED_CURSOR);
  assert.equal(pkgOk.ok, true);
  const decoded = decodeDeltaCursorPackageV1(pkgOk.value);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.value.cursor_url, PLANTED_CURSOR);
  // encode/decode own URL boundary (RED: http://evil must fail at package edge)
  assert.equal(encodeDeltaCursorPackageV1('deltaLink', 'http://evil/x').ok, false);
  assert.equal(encodeDeltaCursorPackageV1('nextLink', 'https://evil.com/v1.0/x').ok, false);
  assert.equal(validateGraphCursorUrlBoundary(PLANTED_CURSOR).ok, true);
  assert.equal(validateGraphCursorUrlBoundary('http://graph.microsoft.com/v1.0/x').ok, false);
  assert.equal(validateGraphCursorUrlBoundary('https://evil.com/v1.0/x').ok, false);
  assert.equal(validateGraphCursorUrlBoundary(
    'https://user:pass@graph.microsoft.com/v1.0/me/messages/delta',
  ).ok, false);
  assert.equal(validateGraphCursorUrlBoundary(
    'https://graph.microsoft.com/beta/me/messages/delta',
  ).ok, false);
  assert.equal(validateGraphCursorUrlBoundary(
    'https://graph.microsoft.com/v1.0/me/messages/delta#frag',
  ).ok, false);

  // Module-init-pinned URL: ambient global / prototype monkeypatches must not
  // flip accept/reject (no live property reads; node:url pin only).
  const storeSrcEarly = fs.readFileSync(storeAbs, 'utf8');
  assert.match(storeSrcEarly, /require\(['"]node:url['"]\)/);
  assert.match(storeSrcEarly, /PINNED_URL_INTRINSICS_READY/);
  assert.match(storeSrcEarly, /Reflect\.construct\(PINNED_URL/);
  assert.equal(/\bnew URL\s*\(/.test(storeSrcEarly), false, 'no ambient new URL()');
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
    assert.equal(validateGraphCursorUrlBoundary(PLANTED_CURSOR).ok, true,
      'pinned validation still accepts good cursor under monkeypatch');
    assert.equal(validateGraphCursorUrlBoundary('https://evil.com/v1.0/x').ok, false,
      'pinned validation still rejects hostile host under monkeypatch');
    assert.equal(encodeDeltaCursorPackageV1('deltaLink', PLANTED_CURSOR).ok, true);
    assert.equal(encodeDeltaCursorPackageV1('deltaLink', 'http://evil/x').ok, false);
    assert.equal(ambientCtorHits, 0, 'ambient global URL constructor never invoked');
  } finally {
    globalThis.URL = savedGlobalUrl;
    if (protoDesc) {
      Object.defineProperty(require('node:url').URL.prototype, 'hostname', protoDesc);
    }
  }

  // ── Seal / open roundtrip + AAD cross-scope failure ─────────────────────
  const envProvider = createFakeEmailGrantEnvelopeProvider();
  const sealed = await sealDeltaCursorCompatible(envProvider, Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1,
    queryVersion: 1,
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
    queryVersion: 1,
    cursorKind: 'nextLink',
    envelope: sealed.value.envelope,
  }));
  assert.equal(opened.ok, true);
  assert.equal(opened.value.cursor_url, PLANTED_NEXT);

  const crossGen = await openSealedDeltaCursor(envProvider, Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 2,
    queryVersion: 1,
    cursorKind: 'nextLink',
    envelope: sealed.value.envelope,
  }));
  assert.equal(crossGen.ok, false, 'AAD generation mismatch fails closed');

  const crossKind = await openSealedDeltaCursor(envProvider, Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1,
    queryVersion: 1,
    cursorKind: 'deltaLink',
    envelope: sealed.value.envelope,
  }));
  assert.equal(crossKind.ok, false, 'AAD cursor_kind mismatch fails closed');

  // ── Factory boundary ────────────────────────────────────────────────────
  assert.throws(
    () => createInboundEmailDeltaStateStore(Object.freeze({ db: {} })),
    (err) => err && err.code === FAILURE_CODE,
  );
  assert.throws(
    () => createInboundEmailDeltaStateStore(Object.freeze({
      withTransactionClient: new Proxy(async () => {}, {
        apply(t, thisArg, args) { return Reflect.apply(t, thisArg, args); },
      }),
    })),
    (err) => err && err.code === FAILURE_CODE,
    'proxy loaner rejected',
  );
  assert.ok(resolveWithTransactionClient(async (work) => work({
    async query() { return { rows: [] }; },
  })));

  const harness = createFakeDeltaHarness();
  const deltaStore = createInboundEmailDeltaStateStore(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
    envelopeProvider: envProvider,
  }));

  // ── initialize → acquire → commit nextLink → commit deltaLink ───────────
  const init = await deltaStore.initializeState(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: 1,
  }));
  assert.equal(init.ok, true, JSON.stringify(init));
  assert.equal(init.value.phase, 'initial');
  assert.equal(init.value.ingestion_generation, 1);
  assert.equal(init.value.state_version, 1);

  const dupInit = await deltaStore.initializeState(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
  }));
  assert.equal(dupInit.ok, false);
  assert.equal(dupInit.error, 'delta_state_already_exists');

  let lease = await deltaStore.acquireLease(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    workerId: 'runner-1',
    ttlSeconds: 60,
    expectedGeneration: 1,
    expectedStateVersion: 1,
  }));
  assert.equal(lease.ok, true, JSON.stringify(lease));
  assert.ok(lease.value.lease_token);
  assert.equal(lease.value.state_version, 2);

  // stale state_version cannot acquire
  const staleAcq = await deltaStore.acquireLease(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    workerId: 'runner-2',
    ttlSeconds: 60,
    expectedGeneration: 1,
    expectedStateVersion: 1,
  }));
  assert.equal(staleAcq.ok, false);

  const sealedNext = await deltaStore.sealDeltaCursor(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1,
    queryVersion: 1,
    cursorKind: 'nextLink',
    cursorUrl: PLANTED_NEXT,
    operationId: crypto.randomUUID(),
  }));
  assert.equal(sealedNext.ok, true);

  const page1 = await deltaStore.commitPageEvents(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    leaseToken: lease.value.lease_token,
    expectedGeneration: 1,
    expectedStateVersion: lease.value.state_version,
    providerMailboxId: MAILBOX,
    queryVersion: 1,
    envelopes: [envelope({ provider_message_id: 'msg-a' })],
    tombstones: [],
    successorCursor: {
      cursor_kind: 'nextLink',
      envelope: sealedNext.value.envelope,
    },
  }));
  assert.equal(page1.ok, true, JSON.stringify(page1));
  assert.equal(page1.value.phase, 'initial');
  assert.equal(page1.value.cursor_kind, 'nextLink');
  assert.equal(page1.value.envelopes_presented, 1);
  assert.equal(harness.events.size, 1);

  // refresh lease after commit (state_version advanced)
  lease = await deltaStore.renewLease(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    leaseToken: lease.value.lease_token,
    expectedGeneration: 1,
    expectedStateVersion: page1.value.state_version,
    ttlSeconds: 60,
  }));
  assert.equal(lease.ok, true, JSON.stringify(lease));

  // duplicate page still advances cursor
  const sealedNext2 = await deltaStore.sealDeltaCursor(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1,
    queryVersion: 1,
    cursorKind: 'nextLink',
    cursorUrl: `${PLANTED_NEXT}&page=2`,
    operationId: crypto.randomUUID(),
  }));
  const pageDup = await deltaStore.commitPageEvents(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    leaseToken: lease.value.lease_token,
    expectedGeneration: 1,
    expectedStateVersion: lease.value.state_version,
    providerMailboxId: MAILBOX,
    queryVersion: 1,
    envelopes: [envelope({ provider_message_id: 'msg-a' })], // duplicate identity
    tombstones: [tombstone('msg-gone')],
    successorCursor: {
      cursor_kind: 'nextLink',
      envelope: sealedNext2.value.envelope,
    },
  }));
  assert.equal(pageDup.ok, true, JSON.stringify(pageDup));
  assert.equal(harness.events.size, 1, 'duplicate does not insert second row');
  assert.equal(pageDup.value.tombstones_presented, 1);
  assert.ok(pageDup.value.state_version > lease.value.state_version);

  lease = {
    ok: true,
    value: {
      ...lease.value,
      state_version: pageDup.value.state_version,
    },
  };

  // terminal deltaLink transition
  const sealedDelta = await deltaStore.sealDeltaCursor(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1,
    queryVersion: 1,
    cursorKind: 'deltaLink',
    cursorUrl: PLANTED_CURSOR,
    operationId: crypto.randomUUID(),
  }));
  const pageTerm = await deltaStore.commitPageEvents(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    leaseToken: lease.value.lease_token,
    expectedGeneration: 1,
    expectedStateVersion: lease.value.state_version,
    providerMailboxId: MAILBOX,
    queryVersion: 1,
    envelopes: [envelope({ provider_message_id: 'msg-b' })],
    tombstones: [],
    successorCursor: {
      cursor_kind: 'deltaLink',
      envelope: sealedDelta.value.envelope,
    },
  }));
  assert.equal(pageTerm.ok, true, JSON.stringify(pageTerm));
  assert.equal(pageTerm.value.phase, 'tracking');
  assert.equal(pageTerm.value.cursor_kind, 'deltaLink');
  assert.equal(harness.events.size, 2);

  // open under lease
  const openedLive = await deltaStore.openCursor(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    leaseToken: lease.value.lease_token,
    expectedGeneration: 1,
    expectedStateVersion: pageTerm.value.state_version,
  }));
  assert.equal(openedLive.ok, true, JSON.stringify(openedLive));
  assert.equal(openedLive.value.cursor_present, true);
  assert.equal(openedLive.value.cursor_url, PLANTED_CURSOR);

  // public status — no cursor URL / lease token / mailbox / PII
  const status = await deltaStore.getPublicStatus(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
  }));
  assert.equal(status.ok, true);
  assert.equal(status.value.state_present, true);
  assert.equal(status.value.phase, 'tracking');
  assert.equal(status.value.has_sealed_cursor, true);
  assert.equal(status.value.cursor_kind, 'deltaLink');
  assert.deepEqual(Object.keys(status.value).sort(), [...PUBLIC_STATUS_KEYS].sort());
  assert.equal(noLeak(status.value), true);
  assert.equal(Object.prototype.hasOwnProperty.call(status.value, 'lease_token'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(status.value, 'cursor_url'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(status.value, 'provider_mailbox_id'), false);

  // ── CAS failure rolls back inserts ──────────────────────────────────────
  harness.setFailOn((sql) => /SET cursor_kind = \$8/.test(sql));
  const lease2 = await deltaStore.acquireLease(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    workerId: 'runner-1',
    ttlSeconds: 60,
    // force fail: wrong state version path via cursor CAS failOn after insert
    expectedGeneration: 1,
    expectedStateVersion: pageTerm.value.state_version,
  }));
  // lease may fail due to active lease — expire first
  harness.setFailOn(null);
  harness.advanceClock(120_000);
  const leaseAfterExpiry = await deltaStore.acquireLease(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    workerId: 'runner-1',
    ttlSeconds: 60,
    expectedGeneration: 1,
    expectedStateVersion: pageTerm.value.state_version,
  }));
  assert.equal(leaseAfterExpiry.ok, true, JSON.stringify(leaseAfterExpiry));

  harness.setFailOn((sql) => /SET cursor_kind = \$8/.test(sql));
  const sealedX = await deltaStore.sealDeltaCursor(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1,
    queryVersion: 1,
    cursorKind: 'deltaLink',
    cursorUrl: PLANTED_CURSOR,
    operationId: crypto.randomUUID(),
  }));
  const eventsBefore = harness.events.size;
  const failCas = await deltaStore.commitPageEvents(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    leaseToken: leaseAfterExpiry.value.lease_token,
    expectedGeneration: 1,
    expectedStateVersion: leaseAfterExpiry.value.state_version,
    providerMailboxId: MAILBOX,
    queryVersion: 1,
    envelopes: [envelope({ provider_message_id: 'msg-should-rollback' })],
    tombstones: [],
    successorCursor: {
      cursor_kind: 'deltaLink',
      envelope: sealedX.value.envelope,
    },
  }));
  assert.equal(failCas.ok, false);
  assert.equal(harness.events.size, eventsBefore, 'CAS fail rolls back event insert');
  harness.setFailOn(null);

  // ── commit-unknown (COMMIT reject after send) ───────────────────────────
  // re-acquire clean lease state_version from public status
  const st2 = await deltaStore.getPublicStatus(Object.freeze({
    clientId: CLIENT, endpointId: ENDPOINT,
  }));
  harness.advanceClock(120_000);
  const leaseCu = await deltaStore.acquireLease(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    workerId: 'runner-cu',
    ttlSeconds: 60,
    expectedGeneration: 1,
    expectedStateVersion: st2.value.state_version,
  }));
  assert.equal(leaseCu.ok, true, JSON.stringify(leaseCu));
  harness.setCommitReject(true);
  const sealedCu = await deltaStore.sealDeltaCursor(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1,
    queryVersion: 1,
    cursorKind: 'deltaLink',
    cursorUrl: PLANTED_CURSOR,
    operationId: crypto.randomUUID(),
  }));
  const cu = await deltaStore.commitPageEvents(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    leaseToken: leaseCu.value.lease_token,
    expectedGeneration: 1,
    expectedStateVersion: leaseCu.value.state_version,
    providerMailboxId: MAILBOX,
    queryVersion: 1,
    envelopes: [envelope({ provider_message_id: 'msg-cu' })],
    tombstones: [],
    successorCursor: {
      cursor_kind: 'deltaLink',
      envelope: sealedCu.value.envelope,
    },
  }));
  assert.equal(cu.ok, false);
  assert.equal(cu.error, 'inbound_delta_state_commit_outcome_unknown');
  assert.equal(noLeak(cu), true);
  harness.setCommitReject(false);

  // replay converges (whether or not prior commit landed — fake rolled back staged)
  const sealedReplay = await deltaStore.sealDeltaCursor(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    ingestionGeneration: 1,
    queryVersion: 1,
    cursorKind: 'deltaLink',
    cursorUrl: PLANTED_CURSOR,
    operationId: crypto.randomUUID(),
  }));
  const replay = await deltaStore.commitPageEvents(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    leaseToken: leaseCu.value.lease_token,
    expectedGeneration: 1,
    expectedStateVersion: leaseCu.value.state_version,
    providerMailboxId: MAILBOX,
    queryVersion: 1,
    envelopes: [envelope({ provider_message_id: 'msg-cu' })],
    tombstones: [],
    successorCursor: {
      cursor_kind: 'deltaLink',
      envelope: sealedReplay.value.envelope,
    },
  }));
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(harness.events.has(`microsoft_graph\0${MAILBOX}\0msg-cu`), true);

  // ── reset required + next generation (grant gen independent) ────────────
  const st3 = await deltaStore.getPublicStatus(Object.freeze({
    clientId: CLIENT, endpointId: ENDPOINT,
  }));
  const reset = await deltaStore.markResetRequired(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    expectedGeneration: 1,
    expectedStateVersion: st3.value.state_version,
    reason: 'graph_410_gone',
  }));
  assert.equal(reset.ok, true);
  assert.equal(reset.value.phase, 'reset_required');
  assert.equal(reset.value.reset_reason, 'graph_410_gone');

  const next = await deltaStore.beginNextGeneration(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    expectedGeneration: 1,
    expectedStateVersion: reset.value.state_version,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: 2,
    verifiedAuthority: true,
  }));
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(next.value.ingestion_generation, 2);
  assert.equal(next.value.query_version, 2);
  assert.equal(next.value.phase, 'initial');
  assert.equal(next.value.previous_generation, 1);
  // old events preserved
  assert.ok(harness.events.size >= 2);
  // old generation still durable but not current
  let oldCurrent = 0;
  let newCurrent = 0;
  for (const row of harness.states.values()) {
    if (row.endpoint_id === ENDPOINT && row.is_current) newCurrent += 1;
    if (row.ingestion_generation === 1) oldCurrent += 1;
  }
  assert.equal(newCurrent, 1);
  assert.equal(oldCurrent, 1);

  // beginNextGeneration without verifiedAuthority
  const noAuth = await deltaStore.beginNextGeneration(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    expectedGeneration: 2,
    expectedStateVersion: 1,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: 2,
  }));
  assert.equal(noAuth.ok, false);
  assert.equal(noAuth.error, 'authority_not_verified');

  // grant generation independence: no grant table/column SQL owners in this module
  const storeSrc = fs.readFileSync(storeAbs, 'utf8');
  assert.equal(/tenant_email_delegated_grants/.test(storeSrc), false);
  // Do not couple delta ingestion_generation to OAuth grant_generation identifiers.
  assert.equal(/\bgrant_generation\b/.test(storeSrc), false);
  assert.match(storeSrc, /EMAIL_INBOUND_DELTA_STATE_RUNTIME_WIRED = false/);
  assert.equal(/require\(['"]\.\/staff-/.test(storeSrc), false);
  assert.equal(/fetch\(|axios|http\.request/.test(storeSrc), false);
  assert.equal(/\bnet\.connect\b|\bhttps?\.request\b|\baxios\b|\bnode-fetch\b/.test(storeSrc), false);

  // ── hostile inputs (runtime results, not regex self-reference) ──────────
  assert.equal(prepareCanonicalBatch(null, MAILBOX).ok, true);
  assert.equal(prepareCanonicalBatch([envelope({ provider_mailbox_id: 'other' })], MAILBOX).ok, false);
  assert.equal(prepareTombstones([tombstone('x')], MAILBOX).ok, true);
  assert.equal(prepareTombstones([{ provider: 'gmail_api', provider_mailbox_id: MAILBOX, provider_message_id: 'x' }], MAILBOX).ok, false);

  // Proxy array rejected before any get/ownKeys traps (zero-touch).
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
  assert.equal(proxyTrapHits.get, 0, 'proxy get trap must not run');
  assert.equal(proxyTrapHits.ownKeys, 0, 'proxy ownKeys trap must not run');
  assert.equal(proxyTrapHits.getOwnPropertyDescriptor, 0, 'proxy descriptor trap must not run');
  assert.equal(proxyTrapHits.getPrototypeOf, 0, 'proxy getPrototypeOf trap must not run');

  // Accessor-owned envelope fields fail closed (no silent [[Get]] acceptance).
  const accessorEnv = {};
  Object.defineProperty(accessorEnv, 'provider', {
    enumerable: true,
    get() { return 'microsoft_graph'; },
  });
  Object.defineProperty(accessorEnv, 'provider_mailbox_id', {
    enumerable: true,
    value: MAILBOX,
  });
  Object.defineProperty(accessorEnv, 'provider_message_id', {
    enumerable: true,
    value: 'acc-1',
  });
  Object.defineProperty(accessorEnv, 'received_at', {
    enumerable: true,
    value: '2026-08-01T12:00:00.000Z',
  });
  Object.defineProperty(accessorEnv, 'subject', { enumerable: true, value: 'x' });
  Object.defineProperty(accessorEnv, 'sender_display_name', { enumerable: true, value: 'x' });
  Object.defineProperty(accessorEnv, 'sender_address', { enumerable: true, value: 'a@b.c' });
  Object.defineProperty(accessorEnv, 'is_read', { enumerable: true, value: false });
  Object.defineProperty(accessorEnv, 'conversation_id', { enumerable: true, value: null });
  Object.defineProperty(accessorEnv, 'internet_message_id', { enumerable: true, value: null });
  assert.equal(prepareCanonicalBatch([accessorEnv], MAILBOX).ok, false);

  const symbolTomb = Object.create(null);
  Object.defineProperty(symbolTomb, 'provider', { value: 'microsoft_graph', enumerable: true });
  Object.defineProperty(symbolTomb, 'provider_mailbox_id', { value: MAILBOX, enumerable: true });
  Object.defineProperty(symbolTomb, 'provider_message_id', { value: 'z', enumerable: true });
  Object.defineProperty(symbolTomb, Symbol('x'), { value: 1 });
  // symbol keys → snapshotOwnDataProps fails
  assert.equal(prepareTombstones([symbolTomb], MAILBOX).ok, false);

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
    queryVersion: 2,
    cursorKind: 'nextLink',
    cursorUrl: PLANTED_NEXT,
    operationId: crypto.randomUUID(),
  }));
  const staleCommit = await deltaStore.commitPageEvents(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    leaseToken: crypto.randomUUID(),
    expectedGeneration: 2,
    expectedStateVersion: leaseFresh.value.state_version,
    providerMailboxId: MAILBOX,
    queryVersion: 2,
    envelopes: [],
    tombstones: [],
    successorCursor: {
      cursor_kind: 'nextLink',
      envelope: sealedStale.value.envelope,
    },
  }));
  assert.equal(staleCommit.ok, false);

  // query_version mismatch fails closed
  const qvMismatch = await deltaStore.commitPageEvents(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    leaseToken: leaseFresh.value.lease_token,
    expectedGeneration: 2,
    expectedStateVersion: leaseFresh.value.state_version,
    providerMailboxId: MAILBOX,
    queryVersion: 99,
    envelopes: [],
    tombstones: [],
    successorCursor: {
      cursor_kind: 'nextLink',
      envelope: sealedStale.value.envelope,
    },
  }));
  assert.equal(qvMismatch.ok, false);

  // release lease
  const rel = await deltaStore.releaseLease(Object.freeze({
    clientId: CLIENT,
    endpointId: ENDPOINT,
    leaseToken: leaseFresh.value.lease_token,
    expectedGeneration: 2,
    expectedStateVersion: leaseFresh.value.state_version,
  }));
  assert.equal(rel.ok, true);

  // Harness SQL log may contain envelope column values (subject/address) as
  // INSERT bind params — that is the durable write path, not application logging.
  // Cursor capability secrets must never appear in SQL text or bind params.
  for (const entry of harness.log) {
    const s = JSON.stringify(entry);
    assert.equal(s.includes('SECRET_DELTA_TOKEN'), false, 'no delta token in sql log');
    assert.equal(s.includes('SECRET_NEXT_TOKEN'), false, 'no next token in sql log');
    assert.equal(s.includes(PLANTED_CURSOR), false, 'no plaintext cursor url in sql log');
    assert.equal(s.includes(PLANTED_NEXT), false, 'no plaintext next url in sql log');
    assert.equal(s.includes('refresh_token'), false, 'no refresh_token key in sql log');
  }

  // silence unused
  void lease2;

  console.log('PASS verify-email-inbound-delta-state-store');
}

main().catch((err) => {
  console.error('FAIL verify-email-inbound-delta-state-store');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
