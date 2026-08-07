'use strict';

/**
 * verify:email-delta-recovery-operation-store — offline hostile + behavioral gate.
 *
 * Migration 065 recovery journal + import-inert store:
 *   getRecoveryStatus / restartGeneration / reconcilePageCommit /
 *   readPageCommitOutcome (authority-bound read-only page_commit journal)
 * Authority-bearing createInboundEmailDeltaStateStore factory method
 * advanceGenerationOnExclusiveClient (raw primitive not exported) shared outer TX.
 * No routes / staff-query / runtime activation.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const STORE_REL = 'scripts/lib/email-delta-recovery-operation-store.js';
const STORE_ABS = path.join(ROOT, STORE_REL);
const DELTA_ABS = path.join(ROOT, 'scripts/lib/email-inbound-delta-state-store.js');
const UP_065 = path.join(ROOT, 'database/migrations/065_tenant_email_delta_recovery_operations.sql');
const DOWN_065 = path.join(ROOT, 'database/migrations/065_tenant_email_delta_recovery_operations_down.sql');
const UP_066 = path.join(ROOT, 'database/migrations/066_tenant_email_delta_page_commit_journal.sql');
const DOWN_066 = path.join(ROOT, 'database/migrations/066_tenant_email_delta_page_commit_journal_down.sql');
const MANIFEST = path.join(ROOT, 'database/migrations/canonical-manifest.json');
const PKG = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');

const CLIENT = '11111111-1111-4111-8111-111111111111';
const LOCATION = '22222222-2222-4222-8222-222222222222';
const ENDPOINT = '33333333-3333-4333-8333-333333333333';
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT = '55555555-5555-4555-8555-555555555555';
const MAILBOX = '44444444-4444-4444-8444-444444444444';
const QV1 = 'ms_messages_delta_v1';

const {
  createEmailDeltaRecoveryOperationStore,
  FAILURE_CODE,
  EMAIL_DELTA_RECOVERY_OPERATION_RUNTIME_WIRED,
  EMAIL_DELTA_RECOVERY_OPERATION_LOGGING_FORBIDDEN,
  OPERATION_KINDS,
  ACTOR_KINDS,
  PAGE_COMMIT_WORKER_ID,
  OUTCOMES,
  STORE_DEPENDENCY_KEYS,
  RECOVERY_STATUS_KEYS,
  RECOVERY_RESULT_KEYS,
  PAGE_COMMIT_OUTCOME_KEYS,
} = require('./lib/email-delta-recovery-operation-store');
const deltaStateMod = require('./lib/email-inbound-delta-state-store');
const {
  createInboundEmailDeltaStateStore,
} = deltaStateMod;

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

function makeAuthorityVerifier(opts) {
  const allow = opts && opts.allow === false ? false : true;
  const bind = opts && opts.binding ? opts.binding : null;
  return Object.freeze({
    async verifyBinding(binding) {
      if (!allow) return Object.freeze({ ok: false });
      if (bind) {
        for (const k of Object.keys(bind)) {
          if (String(binding[k] || '').toLowerCase() !== String(bind[k]).toLowerCase()) {
            return Object.freeze({ ok: false });
          }
        }
      }
      return Object.freeze({
        ok: true,
        value: Object.freeze({ ...binding }),
      });
    },
  });
}

/**
 * Stateful exclusive-client harness modeling 064 delta states + 065 journal.
 */
function createHarness(opts) {
  const commitReject = { value: false };
  const beginCount = { value: 0 };
  const nestedBegin = { value: 0 };
  const releaseCalls = { value: 0 };
  const states = new Map(); // key client|endpoint -> current row + archive
  const archive = [];
  const journal = new Map();
  let inTxn = false;
  let stagedStates = null;
  let stagedArchive = null;
  let stagedJournal = null;

  function keyOf(c, e) { return `${c}|${e}`; }

  function snapshot() {
    stagedStates = new Map();
    for (const [k, v] of states) stagedStates.set(k, { ...v });
    stagedArchive = archive.map((r) => ({ ...r }));
    stagedJournal = new Map();
    for (const [k, v] of journal) stagedJournal.set(k, { ...v });
  }

  function applyStage() {
    states.clear();
    for (const [k, v] of stagedStates) states.set(k, v);
    archive.length = 0;
    for (const r of stagedArchive) archive.push(r);
    journal.clear();
    for (const [k, v] of stagedJournal) journal.set(k, v);
  }

  function discardStage() {
    stagedStates = null;
    stagedArchive = null;
    stagedJournal = null;
  }

  function liveStates() { return inTxn ? stagedStates : states; }
  function liveArchive() { return inTxn ? stagedArchive : archive; }
  function liveJournal() { return inTxn ? stagedJournal : journal; }

  function seedCurrent(row) {
    const k = keyOf(row.client_id, row.endpoint_id);
    states.set(k, {
      client_id: row.client_id,
      location_id: row.location_id,
      endpoint_id: row.endpoint_id,
      provider: 'microsoft_graph',
      provider_tenant_id: row.provider_tenant_id,
      provider_mailbox_id: row.provider_mailbox_id,
      ingestion_generation: row.ingestion_generation,
      query_version: row.query_version || QV1,
      is_current: true,
      phase: row.phase || 'initial',
      state_version: row.state_version || 1,
      lease_token: row.lease_token || null,
      lease_until: row.lease_until || null,
      lease_owner: row.lease_owner || null,
      cursor_operation_id: row.cursor_operation_id || null,
    });
  }

  async function query(sql, params) {
    const norm = String(sql).replace(/\s+/g, ' ').trim();
    if (norm === 'BEGIN') {
      if (inTxn) nestedBegin.value += 1;
      beginCount.value += 1;
      inTxn = true;
      snapshot();
      return { rows: [] };
    }
    if (norm === 'COMMIT') {
      if (commitReject.value) {
        const err = new Error('commit rejected');
        throw err;
      }
      applyStage();
      inTxn = false;
      discardStage();
      return { rows: [] };
    }
    if (norm === 'ROLLBACK') {
      inTxn = false;
      discardStage();
      return { rows: [] };
    }

    // SQL_PUBLIC_STATUS (has_active_lease alias; no FOR UPDATE)
    if (/FROM tenant_email_inbound_delta_states/.test(norm)
        && /has_active_lease/.test(norm)
        && /is_current = true/.test(norm)
        && !/FOR UPDATE/.test(norm)) {
      const c = params[0]; const e = params[1];
      const row = liveStates().get(keyOf(c, e));
      if (!row || !row.is_current) return { rows: [] };
      const hasLease = row.lease_token != null
        && row.lease_until != null
        && new Date(row.lease_until).getTime() > Date.now();
      return {
        rows: [{
          phase: row.phase,
          ingestion_generation: row.ingestion_generation,
          query_version: row.query_version,
          state_version: row.state_version,
          has_active_lease: hasLease,
          has_sealed_cursor: row.cursor_operation_id != null,
          cursor_kind: null,
          reset_reason: null,
        }],
      };
    }

    // SQL_LOCK_CURRENT
    if (/FROM tenant_email_inbound_delta_states/.test(norm)
        && /FOR UPDATE/.test(norm)
        && /is_current = true/.test(norm)
        && !/lease_until/.test(norm)) {
      const row = liveStates().get(keyOf(params[0], params[1]));
      if (!row || !row.is_current) return { rows: [] };
      return { rows: [{ ...row }] };
    }

    // Active lease check
    if (/lease_token IS NOT NULL AND lease_until IS NOT NULL/.test(norm)
        && /FROM tenant_email_inbound_delta_states/.test(norm)) {
      const row = liveStates().get(keyOf(params[0], params[1]));
      if (!row) return { rows: [{ ok: false }] };
      const okLease = row.lease_token != null
        && row.lease_until != null
        && row.lease_until > new Date();
      return { rows: [{ ok: okLease }] };
    }

    // SQL_DEMOTE_CURRENT
    if (/SET is_current = false/.test(norm)
        && /tenant_email_inbound_delta_states/.test(norm)) {
      const c = params[0]; const e = params[1];
      const gen = Number(params[2]); const sv = Number(params[3]);
      const k = keyOf(c, e);
      const row = liveStates().get(k);
      if (!row || !row.is_current
          || row.ingestion_generation !== gen
          || row.state_version !== sv) {
        return { rows: [] };
      }
      const demoted = {
        ...row,
        is_current: false,
        lease_token: null,
        lease_until: null,
        lease_owner: null,
        state_version: row.state_version + 1,
      };
      liveArchive().push(demoted);
      liveStates().delete(k);
      return { rows: [{ ingestion_generation: demoted.ingestion_generation, state_version: demoted.state_version }] };
    }

    // SQL_INSERT_NEXT_GENERATION
    if (/INSERT INTO tenant_email_inbound_delta_states/.test(norm)
        && /ingestion_generation/.test(norm)) {
      const [c, loc, e, , tenant, mailbox, gen, qv] = params;
      const k = keyOf(c, e);
      if (liveStates().has(k)) throw new Error('ambiguous current');
      const row = {
        client_id: c,
        location_id: loc,
        endpoint_id: e,
        provider: 'microsoft_graph',
        provider_tenant_id: tenant,
        provider_mailbox_id: mailbox,
        ingestion_generation: Number(gen),
        query_version: qv,
        is_current: true,
        phase: 'initial',
        state_version: 1,
        lease_token: null,
        lease_until: null,
        lease_owner: null,
        cursor_operation_id: null,
      };
      liveStates().set(k, row);
      return {
        rows: [{
          client_id: c,
          endpoint_id: e,
          ingestion_generation: row.ingestion_generation,
          query_version: qv,
          phase: 'initial',
          state_version: 1,
        }],
      };
    }

    // SELECT journal FOR UPDATE
    if (/FROM tenant_email_delta_recovery_operations/.test(norm)
        && /FOR UPDATE/.test(norm)) {
      const op = String(params[0]).toLowerCase();
      const row = liveJournal().get(op);
      if (!row) return { rows: [] };
      return { rows: [{ ...row }] };
    }

    // SELECT target journal (no FOR UPDATE) — full row for page_commit classify
    if (/FROM tenant_email_delta_recovery_operations/.test(norm)
        && !/FOR UPDATE/.test(norm)
        && !/INSERT/.test(norm)
        && !/UPDATE/.test(norm)
        && /operation_kind/.test(norm)
        && /outcome/.test(norm)) {
      const op = String(params[0]).toLowerCase();
      const row = liveJournal().get(op);
      if (!row) return { rows: [] };
      return { rows: [{ ...row }] };
    }

    // INSERT claim (staff or worker; params include actor_kind + worker_id)
    if (/INSERT INTO tenant_email_delta_recovery_operations/.test(norm)
        && /ON CONFLICT \(operation_id\) DO NOTHING/.test(norm)) {
      const op = String(params[0]).toLowerCase();
      if (liveJournal().has(op)) return { rows: [] };
      // $1 op $2 client $3 loc $4 ep $5 staff $6 actor_kind $7 worker $8 kind $9 gen $10 sv $11 target
      const staffRaw = params[4];
      const row = {
        operation_id: op,
        client_id: String(params[1]).toLowerCase(),
        location_id: String(params[2]).toLowerCase(),
        endpoint_id: String(params[3]).toLowerCase(),
        actor_staff_user_id: staffRaw == null ? null : String(staffRaw).toLowerCase(),
        actor_kind: params[5] == null ? 'staff' : String(params[5]),
        worker_id: params[6] == null ? null : String(params[6]),
        operation_kind: params[7],
        requested_generation: Number(params[8]),
        requested_state_version: Number(params[9]),
        target_operation_id: params[10] == null ? null : String(params[10]).toLowerCase(),
        outcome: 'claimed',
        result_generation: null,
        result_state_version: null,
        result_phase: null,
      };
      liveJournal().set(op, row);
      return { rows: [{ operation_id: op }] };
    }

    // COMPLETE committed restart
    if (/UPDATE tenant_email_delta_recovery_operations/.test(norm)
        && /outcome = 'committed'/.test(norm)) {
      const op = String(params[0]).toLowerCase();
      const row = liveJournal().get(op);
      if (!row || row.outcome !== 'claimed') return { rows: [] };
      row.outcome = 'committed';
      row.result_generation = Number(params[1]);
      row.result_state_version = Number(params[2]);
      row.result_phase = params[3];
      return { rows: [{ ...row }] };
    }

    // COMPLETE terminal
    if (/UPDATE tenant_email_delta_recovery_operations/.test(norm)
        && /outcome = \$2/.test(norm)) {
      const op = String(params[0]).toLowerCase();
      const outcome = params[1];
      const row = liveJournal().get(op);
      if (!row || row.outcome !== 'claimed') return { rows: [] };
      row.outcome = outcome;
      row.result_generation = null;
      row.result_state_version = null;
      row.result_phase = null;
      return { rows: [{ ...row }] };
    }

    throw new Error(`unexpected sql: ${norm.slice(0, 120)}`);
  }

  async function withTransactionClient(work) {
    const client = {
      query: (...args) => query(...args),
      release() { releaseCalls.value += 1; },
    };
    return work(client);
  }

  return {
    withTransactionClient,
    seedCurrent,
    states,
    archive,
    journal,
    beginCount,
    nestedBegin,
    releaseCalls,
    setCommitReject(v) { commitReject.value = v; },
    getCommitReject() { return commitReject.value; },
  };
}

function baseRestartInput(overrides) {
  return Object.freeze({
    operationId: crypto.randomUUID(),
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    actorStaffUserId: ACTOR,
    expectedGeneration: 1,
    expectedStateVersion: 1,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: QV1,
    ...(overrides || {}),
  });
}

async function main() {
  console.log('verify:email-delta-recovery-operation-store');

  const storeSrc = fs.readFileSync(STORE_ABS, 'utf8');
  const deltaSrc = fs.readFileSync(DELTA_ABS, 'utf8');
  const up = fs.readFileSync(UP_065, 'utf8');
  const down = fs.readFileSync(DOWN_065, 'utf8');
  const up066 = fs.readFileSync(UP_066, 'utf8');
  const down066 = fs.readFileSync(DOWN_066, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const doc = fs.readFileSync(DOC, 'utf8');

  ok('package scripts present',
    !!(pkg.scripts && pkg.scripts['verify:email-delta-recovery-operation-store']
      && pkg.scripts['prove:email-delta-recovery-operation-store-pglite']));
  ok('runtime unwired + logging forbidden',
    EMAIL_DELTA_RECOVERY_OPERATION_RUNTIME_WIRED === false
    && EMAIL_DELTA_RECOVERY_OPERATION_LOGGING_FORBIDDEN === true);
  ok('dependency keys exact',
    STORE_DEPENDENCY_KEYS.length === 3
    && STORE_DEPENDENCY_KEYS.includes('withTransactionClient')
    && STORE_DEPENDENCY_KEYS.includes('authorityVerifier')
    && STORE_DEPENDENCY_KEYS.includes('inboundDeltaStateStore'));
  ok('kinds/outcomes/actors frozen',
    OPERATION_KINDS.includes('restart_generation')
    && OPERATION_KINDS.includes('reconcile_page_commit')
    && OPERATION_KINDS.includes('page_commit')
    && ACTOR_KINDS.includes('staff')
    && ACTOR_KINDS.includes('worker')
    && PAGE_COMMIT_WORKER_ID === 'sunset-email-delta-worker'
    && OUTCOMES.includes('claimed')
    && OUTCOMES.includes('committed')
    && OUTCOMES.includes('evidence_unavailable')
    && OUTCOMES.includes('commit_outcome_unknown'));
  ok('status/result key contracts',
    RECOVERY_STATUS_KEYS.includes('recovery_blocked')
    && RECOVERY_RESULT_KEYS.includes('replayed')
    && RECOVERY_RESULT_KEYS.includes('target_operation_id'));

  ok('migration 065 CREATE + actor composite FK',
    /CREATE TABLE tenant_email_delta_recovery_operations/.test(up)
    && /REFERENCES staff_users \(client_id, id\)/.test(up)
    && /REFERENCES tenant_locations \(client_id, id\)/.test(up)
    && /REFERENCES tenant_channel_endpoints \(client_id, id\)/.test(up)
    && /restart_generation/.test(up)
    && /reconcile_page_commit/.test(up)
    && /evidence_unavailable/.test(up)
    && /idx_tenant_email_delta_recovery_ops_endpoint_outcome_time/.test(up)
    && /9007199254740991/.test(up)
    && !/INSERT INTO tenant_email_delta_recovery_operations/.test(up));
  // Strip line comments + COMMENT ON blocks; assert no forbidden payload columns.
  const upDdl = up
    .replace(/--[^\n]*/g, '')
    .replace(/COMMENT\s+ON[\s\S]*?;/gi, '');
  ok('migration 065 forbids mailbox/provider/cursor/JSON/free-text payload columns',
    !/\bmailbox\b/i.test(upDdl)
    && !/\bprovider\b/i.test(upDdl)
    && !/\bcursor\b/i.test(upDdl)
    && !/\bJSONB\b/i.test(upDdl)
    && !/\bsubject\b/i.test(upDdl)
    && !/\btoken\b/i.test(upDdl)
    && !/\bmessage_id\b/i.test(upDdl)
    && !/\bpublic_address\b/i.test(upDdl)
    // Table name contains "email" — only forbid free-text email payload columns.
    && !/\bemail_address\b/i.test(upDdl)
    && !/\bsender\b/i.test(upDdl));
  ok('down drops recovery table only',
    /DROP TABLE IF EXISTS tenant_email_delta_recovery_operations/.test(down));
  ok('manifest entries 065 present with checksums',
    manifest.entries.some((e) => e.id === '065_tenant_email_delta_recovery_operations'
      && e.inForwardChain === true && e.sha256 && e.sha256.length === 64)
    && manifest.entries.some((e) => e.id === '065_tenant_email_delta_recovery_operations_down'
      && e.inForwardChain === false));

  ok('migration 066 page_commit actor coupling',
    /actor_kind/.test(up066)
    && /worker_id/.test(up066)
    && /page_commit/.test(up066)
    && /sunset-email-delta-worker/.test(up066)
    && /actor_staff_user_id DROP NOT NULL/.test(up066)
    && /tenant_email_delta_recovery_operations_actor_coupling/.test(up066)
    && !/INSERT INTO tenant_email_delta_recovery_operations/.test(up066));
  const up066Ddl = up066
    .replace(/--[^\n]*/g, '')
    .replace(/COMMENT\s+ON[\s\S]*?;/gi, '');
  ok('migration 066 forbids mailbox/provider/cursor/JSON/PII columns',
    !/\bmailbox\b/i.test(up066Ddl)
    && !/\bprovider\b/i.test(up066Ddl)
    && !/\bcursor\b/i.test(up066Ddl)
    && !/\bJSONB\b/i.test(up066Ddl)
    && !/\bsubject\b/i.test(up066Ddl)
    && !/\btoken\b/i.test(up066Ddl)
    && !/\bmessage_id\b/i.test(up066Ddl)
    && !/\bpublic_address\b/i.test(up066Ddl)
    && !/\bemail_address\b/i.test(up066Ddl));
  ok('066 down fails closed on page_commit/worker rows',
    /066_down_refused/.test(down066)
    && /page_commit or worker journal rows present/.test(down066)
    && /DROP COLUMN worker_id/.test(down066)
    && /DROP COLUMN actor_kind/.test(down066)
    && /SET NOT NULL/.test(down066));
  ok('manifest entries 066 present with checksums',
    manifest.entries.some((e) => e.id === '066_tenant_email_delta_page_commit_journal'
      && e.inForwardChain === true && e.sha256 && e.sha256.length === 64)
    && manifest.entries.some((e) => e.id === '066_tenant_email_delta_page_commit_journal_down'
      && e.inForwardChain === false));

  {
    const exportsBlock = deltaSrc.slice(deltaSrc.lastIndexOf('module.exports'));
    ok('raw advanceGenerationOnExclusiveClient NOT module.exports',
      !Object.prototype.hasOwnProperty.call(deltaStateMod, 'advanceGenerationOnExclusiveClient')
      && deltaStateMod.advanceGenerationOnExclusiveClient === undefined
      && !/\badvanceGenerationOnExclusiveClient\b/.test(exportsBlock)
      && !/\bdemoteAndInsertNextGenerationOnExclusiveClient\b/.test(exportsBlock));
  }
  ok('private demote/insert stays module-private (not exported)',
    /demoteAndInsertNextGenerationOnExclusiveClient/.test(deltaSrc)
    && !Object.prototype.hasOwnProperty.call(deltaStateMod, 'demoteAndInsertNextGenerationOnExclusiveClient'));
  ok('factory store exposes authority-bound exclusive advance method',
    /advanceGenerationOnExclusiveClient/.test(deltaSrc)
    && /authorityVerifier\.verifyBinding/.test(deltaSrc)
    && /No BEGIN|no nested BEGIN|without BEGIN/i.test(deltaSrc));
  {
    const reqMatch = storeSrc.match(
      /const\s*\{([\s\S]*?)\}\s*=\s*require\(['"]\.\/email-inbound-delta-state-store['"]\)/,
    );
    const reqBody = reqMatch ? reqMatch[1] : '';
    ok('recovery uses factory store capability; no raw primitive import',
      /inboundDeltaStateStore/.test(storeSrc)
      && /advanceGenerationOnExclusiveClient/.test(storeSrc)
      && !/\badvanceGenerationOnExclusiveClient\b/.test(reqBody)
      && !/\bdemoteAndInsertNextGenerationOnExclusiveClient\b/.test(reqBody)
      && !/\bdemoteAndInsertNextGenerationOnExclusiveClient\b/.test(storeSrc)
      && !/beginNextGeneration\(/.test(storeSrc)
      && /withOuterTxn/.test(storeSrc));
  }
  ok('no cursor_operation_id inference for not_committed',
    // May appear only in forbid/documentation comments — never as a SQL/column touch.
    !/SELECT[\s\S]{0,80}cursor_operation_id|cursor_operation_id\s*=/.test(storeSrc)
    && /evidence_unavailable/.test(storeSrc)
    && /Never consults 064 cursor_operation_id|never consult 064 cursor|Never infers not_committed from 064 cursor_operation_id/i.test(storeSrc));
  ok('import-inert: no routes/staff-query/network',
    !/staff-query-api|staff-email-.*routes|require\(['"]\.\/staff-/.test(storeSrc)
    && !/\bfetch\(|axios|https?\.request|net\.connect/.test(storeSrc)
    && /EMAIL_DELTA_RECOVERY_OPERATION_RUNTIME_WIRED = false/.test(storeSrc));
  ok('docs mention recovery journal',
    /recovery-operation|recovery journal|065_tenant_email_delta_recovery|page_commit/.test(doc));

  // ── Factory hostility ───────────────────────────────────────────────────
  assert.throws(() => createEmailDeltaRecoveryOperationStore(null), (e) => e.code === FAILURE_CODE);
  assert.throws(() => createEmailDeltaRecoveryOperationStore({}), (e) => e.code === FAILURE_CODE);
  assert.throws(() => createEmailDeltaRecoveryOperationStore(Object.freeze({
    withTransactionClient: async () => {},
  })), (e) => e.code === FAILURE_CODE);
  ok('factory rejects missing authorityVerifier', true);

  // Shared harness + authority-bearing delta store for recovery deps.
  const harness = createHarness();
  const sharedVerifier = makeAuthorityVerifier();
  function makeDeltaStore(verifier) {
    return createInboundEmailDeltaStateStore(Object.freeze({
      withTransactionClient: harness.withTransactionClient,
      authorityVerifier: verifier || sharedVerifier,
    }));
  }
  function makeRecoveryStore(verifier, deltaStore) {
    return createEmailDeltaRecoveryOperationStore(Object.freeze({
      withTransactionClient: harness.withTransactionClient,
      authorityVerifier: verifier || sharedVerifier,
      inboundDeltaStateStore: deltaStore || makeDeltaStore(verifier || sharedVerifier),
    }));
  }

  assert.throws(() => createEmailDeltaRecoveryOperationStore(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
    authorityVerifier: makeAuthorityVerifier(),
  })), (e) => e.code === FAILURE_CODE);
  ok('factory rejects missing inboundDeltaStateStore', true);

  assert.throws(() => createEmailDeltaRecoveryOperationStore(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
    authorityVerifier: makeAuthorityVerifier(),
    inboundDeltaStateStore: Object.freeze({}),
  })), (e) => e.code === FAILURE_CODE);
  ok('factory rejects store missing advance method', true);

  const proxyDeps = new Proxy({
    withTransactionClient: async (w) => w({ query: async () => ({ rows: [] }) }),
    authorityVerifier: makeAuthorityVerifier(),
    inboundDeltaStateStore: makeDeltaStore(),
  }, {
    get(t, p, r) { return Reflect.get(t, p, r); },
  });
  let proxyFactoryRejected = false;
  try {
    createEmailDeltaRecoveryOperationStore(proxyDeps);
  } catch (e) {
    proxyFactoryRejected = e && e.code === FAILURE_CODE;
  }
  ok('factory rejects proxy deps', proxyFactoryRejected);

  // ── Behavioral forged-import / forged direct factory-method ─────────────
  {
    let sqlCount = 0;
    const spyClient = {
      async query() {
        sqlCount += 1;
        return { rows: [] };
      },
    };
    const denyStore = createInboundEmailDeltaStateStore(Object.freeze({
      withTransactionClient: async (work) => work(spyClient),
      authorityVerifier: makeAuthorityVerifier({ allow: false }),
    }));
    ok('factory object exposes advanceGenerationOnExclusiveClient method',
      typeof denyStore.advanceGenerationOnExclusiveClient === 'function');
    const forged = await denyStore.advanceGenerationOnExclusiveClient(Object.freeze({
      exclusiveClient: spyClient,
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      expectedGeneration: 1,
      expectedStateVersion: 1,
      providerTenantId: TENANT,
      providerMailboxId: MAILBOX,
      queryVersion: QV1,
    }));
    ok('forged direct factory method: authority verifier runs, zero SQL on failure',
      forged && forged.ok === false
      && forged.error === 'authority_not_verified'
      && sqlCount === 0);
    // Forged import of raw export remains impossible
    ok('forged require cannot call raw module export advanceGenerationOnExclusiveClient',
      typeof deltaStateMod.advanceGenerationOnExclusiveClient !== 'function');
  }

  // ── Behavioral harness ──────────────────────────────────────────────────
  harness.seedCurrent({
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    provider_tenant_id: TENANT,
    provider_mailbox_id: MAILBOX,
    ingestion_generation: 1,
    state_version: 1,
    phase: 'initial',
  });
  const store = makeRecoveryStore();

  const status0 = await store.getRecoveryStatus(Object.freeze({
    clientId: CLIENT, endpointId: ENDPOINT,
  }));
  ok('getRecoveryStatus present unblocked',
    status0.ok && status0.value.state_present === true
    && status0.value.recovery_blocked === false
    && status0.value.ingestion_generation === 1
    && Object.isFrozen(status0.value));

  // Active lease blocks recovery status
  harness.seedCurrent({
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    provider_tenant_id: TENANT,
    provider_mailbox_id: MAILBOX,
    ingestion_generation: 1,
    state_version: 2,
    phase: 'tracking',
    lease_token: crypto.randomUUID(),
    lease_until: new Date(Date.now() + 60000),
    lease_owner: 'worker-1',
  });
  // re-seed overwrites; need to fix state_version - actually seedCurrent replaces
  const statusLease = await store.getRecoveryStatus(Object.freeze({
    clientId: CLIENT, endpointId: ENDPOINT,
  }));
  ok('active lease → recovery_blocked',
    statusLease.ok && statusLease.value.has_active_lease === true
    && statusLease.value.recovery_blocked === true);

  // Clear lease for restart tests
  harness.seedCurrent({
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    provider_tenant_id: TENANT,
    provider_mailbox_id: MAILBOX,
    ingestion_generation: 1,
    state_version: 1,
    phase: 'reset_required',
  });

  const opId = crypto.randomUUID();
  const restart1 = await store.restartGeneration(baseRestartInput({
    operationId: opId,
    expectedGeneration: 1,
    expectedStateVersion: 1,
  }));
  ok('restartGeneration commits new generation',
    restart1.ok
    && restart1.value.outcome === 'committed'
    && restart1.value.result_generation === 2
    && restart1.value.result_phase === 'initial'
    && restart1.value.replayed === false
    && Object.isFrozen(restart1.value),
    JSON.stringify(restart1));

  // Old generation preserved in archive
  ok('old generation preserved (no delete)',
    harness.archive.some((r) => r.ingestion_generation === 1 && r.is_current === false)
    && harness.states.get(`${CLIENT}|${ENDPOINT}`).ingestion_generation === 2);

  // Idempotent replay
  const restartReplay = await store.restartGeneration(baseRestartInput({
    operationId: opId,
    expectedGeneration: 1,
    expectedStateVersion: 1,
  }));
  ok('same operationId identical input → persisted replay zero mutation',
    restartReplay.ok
    && restartReplay.value.replayed === true
    && restartReplay.value.outcome === 'committed'
    && restartReplay.value.result_generation === 2
    && harness.states.get(`${CLIENT}|${ENDPOINT}`).ingestion_generation === 2);

  // operation_id_conflict on actor mismatch
  const conflictActor = await store.restartGeneration(baseRestartInput({
    operationId: opId,
    actorStaffUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    expectedGeneration: 1,
    expectedStateVersion: 1,
  }));
  ok('mismatch actor → operation_id_conflict',
    !conflictActor.ok && conflictActor.error === 'operation_id_conflict');

  // Active lease fail closed
  harness.seedCurrent({
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    provider_tenant_id: TENANT,
    provider_mailbox_id: MAILBOX,
    ingestion_generation: 2,
    state_version: 1,
    phase: 'initial',
    lease_token: crypto.randomUUID(),
    lease_until: new Date(Date.now() + 60000),
  });
  const leaseOp = crypto.randomUUID();
  const leaseBlocked = await store.restartGeneration(baseRestartInput({
    operationId: leaseOp,
    expectedGeneration: 2,
    expectedStateVersion: 1,
  }));
  ok('active lease → not_committed journaled',
    leaseBlocked.ok && leaseBlocked.value.outcome === 'not_committed'
    && harness.states.get(`${CLIENT}|${ENDPOINT}`).ingestion_generation === 2);

  // Clear lease; two ops same CAS → one committed one conflict
  harness.seedCurrent({
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    provider_tenant_id: TENANT,
    provider_mailbox_id: MAILBOX,
    ingestion_generation: 2,
    state_version: 1,
    phase: 'initial',
  });
  const opA = crypto.randomUUID();
  const opB = crypto.randomUUID();
  const aRes = await store.restartGeneration(baseRestartInput({
    operationId: opA,
    expectedGeneration: 2,
    expectedStateVersion: 1,
  }));
  const bRes = await store.restartGeneration(baseRestartInput({
    operationId: opB,
    expectedGeneration: 2,
    expectedStateVersion: 1,
  }));
  ok('two IDs same CAS → one committed one conflict',
    aRes.ok && aRes.value.outcome === 'committed'
    && bRes.ok && bRes.value.outcome === 'conflict'
    && harness.states.get(`${CLIENT}|${ENDPOINT}`).ingestion_generation === 3);

  // Authority reject before TX
  const denyVerifier = makeAuthorityVerifier({ allow: false });
  const badAuthStore = makeRecoveryStore(denyVerifier);
  const noAuth = await badAuthStore.restartGeneration(baseRestartInput({
    operationId: crypto.randomUUID(),
    expectedGeneration: 3,
    expectedStateVersion: 1,
  }));
  ok('authority fail before TX',
    !noAuth.ok && noAuth.error === 'authority_not_verified');

  // verifiedAuthority boolean rejected
  const boolAuth = await store.restartGeneration(baseRestartInput({
    operationId: crypto.randomUUID(),
    expectedGeneration: 3,
    expectedStateVersion: 1,
    verifiedAuthority: true,
  }));
  ok('caller verifiedAuthority boolean rejected',
    !boolAuth.ok && boolAuth.error === 'authority_not_verified');

  // Authority rebind between initial precheck and in-TX factory re-verify →
  // ROLLBACK / zero durable journal or state mutation.
  {
    let authCalls = 0;
    const rebindVerifier = Object.freeze({
      async verifyBinding(binding) {
        authCalls += 1;
        // First call = recovery precheck; second = factory re-verify inside TX.
        if (authCalls === 1) {
          return Object.freeze({
            ok: true,
            value: Object.freeze({ ...binding }),
          });
        }
        return Object.freeze({ ok: false });
      },
    });
    harness.seedCurrent({
      client_id: CLIENT,
      location_id: LOCATION,
      endpoint_id: ENDPOINT,
      provider_tenant_id: TENANT,
      provider_mailbox_id: MAILBOX,
      ingestion_generation: 3,
      state_version: 1,
      phase: 'initial',
    });
    const journalBefore = harness.journal.size;
    const genBefore = harness.states.get(`${CLIENT}|${ENDPOINT}`).ingestion_generation;
    const rebindStore = makeRecoveryStore(rebindVerifier);
    const rebindOp = crypto.randomUUID();
    const rebindRes = await rebindStore.restartGeneration(baseRestartInput({
      operationId: rebindOp,
      expectedGeneration: 3,
      expectedStateVersion: 1,
    }));
    ok('authority rebind after precheck → fail closed',
      !rebindRes.ok && rebindRes.error === 'authority_not_verified'
      && authCalls >= 2);
    ok('authority rebind → zero durable journal mutation',
      harness.journal.size === journalBefore
      && !harness.journal.has(rebindOp));
    ok('authority rebind → zero durable state generation mutation',
      harness.states.get(`${CLIENT}|${ENDPOINT}`).ingestion_generation === genBefore);
  }

  // reconcilePageCommit → evidence_unavailable for unjournaled (no 064 inference)
  const reconOp = crypto.randomUUID();
  const targetOp = crypto.randomUUID();
  // plant a cursor_operation_id on current state to prove we never infer from it
  const cur = harness.states.get(`${CLIENT}|${ENDPOINT}`);
  cur.cursor_operation_id = targetOp;
  const recon = await store.reconcilePageCommit(Object.freeze({
    operationId: reconOp,
    targetOperationId: targetOp,
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    actorStaffUserId: ACTOR,
    expectedGeneration: cur.ingestion_generation,
    expectedStateVersion: cur.state_version,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
  }));
  ok('reconcile unjournaled target → evidence_unavailable (no 064 inference)',
    recon.ok && recon.value.outcome === 'evidence_unavailable'
    && recon.value.target_operation_id === targetOp
    && recon.value.result_generation === null);
  // cursor unchanged
  ok('reconcile does not mutate cursor/events/generation',
    harness.states.get(`${CLIENT}|${ENDPOINT}`).cursor_operation_id === targetOp
    && harness.states.get(`${CLIENT}|${ENDPOINT}`).ingestion_generation === cur.ingestion_generation);

  // reconcile replay
  const reconReplay = await store.reconcilePageCommit(Object.freeze({
    operationId: reconOp,
    targetOperationId: targetOp,
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    actorStaffUserId: ACTOR,
    expectedGeneration: cur.ingestion_generation,
    expectedStateVersion: cur.state_version,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
  }));
  ok('reconcile replay identical',
    reconReplay.ok && reconReplay.value.replayed === true
    && reconReplay.value.outcome === 'evidence_unavailable');

  // Plant durable page_commit committed → reconcile classifies committed
  const pageOpCommitted = crypto.randomUUID();
  harness.journal.set(pageOpCommitted, {
    operation_id: pageOpCommitted,
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    actor_staff_user_id: null,
    actor_kind: 'worker',
    worker_id: PAGE_COMMIT_WORKER_ID,
    operation_kind: 'page_commit',
    requested_generation: cur.ingestion_generation,
    requested_state_version: cur.state_version,
    target_operation_id: null,
    outcome: 'committed',
    result_generation: cur.ingestion_generation,
    result_state_version: cur.state_version + 1,
    result_phase: 'tracking',
  });
  const reconCommittedOp = crypto.randomUUID();
  const reconCommitted = await store.reconcilePageCommit(Object.freeze({
    operationId: reconCommittedOp,
    targetOperationId: pageOpCommitted,
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    actorStaffUserId: ACTOR,
    expectedGeneration: cur.ingestion_generation,
    expectedStateVersion: cur.state_version,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
  }));
  ok('reconcile durable page_commit committed → committed',
    reconCommitted.ok && reconCommitted.value.outcome === 'committed'
    && reconCommitted.value.target_operation_id === pageOpCommitted
    && reconCommitted.value.result_generation === null);

  // claimed page_commit → evidence_unavailable (never guess)
  const pageOpClaimed = crypto.randomUUID();
  harness.journal.set(pageOpClaimed, {
    operation_id: pageOpClaimed,
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    actor_staff_user_id: null,
    actor_kind: 'worker',
    worker_id: PAGE_COMMIT_WORKER_ID,
    operation_kind: 'page_commit',
    requested_generation: 1,
    requested_state_version: 1,
    target_operation_id: null,
    outcome: 'claimed',
    result_generation: null,
    result_state_version: null,
    result_phase: null,
  });
  const reconClaimed = await store.reconcilePageCommit(Object.freeze({
    operationId: crypto.randomUUID(),
    targetOperationId: pageOpClaimed,
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    actorStaffUserId: ACTOR,
    expectedGeneration: cur.ingestion_generation,
    expectedStateVersion: cur.state_version,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
  }));
  ok('reconcile claimed page_commit → evidence_unavailable',
    reconClaimed.ok && reconClaimed.value.outcome === 'evidence_unavailable');

  // restart_generation target is not page evidence
  const restartAsTarget = crypto.randomUUID();
  harness.journal.set(restartAsTarget, {
    operation_id: restartAsTarget,
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    actor_staff_user_id: ACTOR,
    actor_kind: 'staff',
    worker_id: null,
    operation_kind: 'restart_generation',
    requested_generation: 1,
    requested_state_version: 1,
    target_operation_id: null,
    outcome: 'committed',
    result_generation: 2,
    result_state_version: 1,
    result_phase: 'initial',
  });
  const reconRestart = await store.reconcilePageCommit(Object.freeze({
    operationId: crypto.randomUUID(),
    targetOperationId: restartAsTarget,
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    actorStaffUserId: ACTOR,
    expectedGeneration: cur.ingestion_generation,
    expectedStateVersion: cur.state_version,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
  }));
  ok('reconcile restart target → evidence_unavailable (not page_commit)',
    reconRestart.ok && reconRestart.value.outcome === 'evidence_unavailable');

  // cross-tenant durable page_commit → conflict
  const pageOpXTenant = crypto.randomUUID();
  harness.journal.set(pageOpXTenant, {
    operation_id: pageOpXTenant,
    client_id: '99999999-9999-4999-8999-999999999999',
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    actor_staff_user_id: null,
    actor_kind: 'worker',
    worker_id: PAGE_COMMIT_WORKER_ID,
    operation_kind: 'page_commit',
    requested_generation: 1,
    requested_state_version: 1,
    target_operation_id: null,
    outcome: 'committed',
    result_generation: 1,
    result_state_version: 2,
    result_phase: 'tracking',
  });
  const reconX = await store.reconcilePageCommit(Object.freeze({
    operationId: crypto.randomUUID(),
    targetOperationId: pageOpXTenant,
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    actorStaffUserId: ACTOR,
    expectedGeneration: cur.ingestion_generation,
    expectedStateVersion: cur.state_version,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
  }));
  ok('reconcile cross-tenant page_commit → conflict',
    reconX.ok && reconX.value.outcome === 'conflict');

  // cursor still unchanged after classification
  ok('reconcile page_commit classification is read-only for cursor/generation',
    harness.states.get(`${CLIENT}|${ENDPOINT}`).cursor_operation_id === targetOp
    && harness.states.get(`${CLIENT}|${ENDPOINT}`).ingestion_generation === cur.ingestion_generation);

  // COMMIT ambiguity
  harness.seedCurrent({
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    provider_tenant_id: TENANT,
    provider_mailbox_id: MAILBOX,
    ingestion_generation: 5,
    state_version: 1,
    phase: 'initial',
  });
  harness.setCommitReject(true);
  const unkOp = crypto.randomUUID();
  const unknown = await store.restartGeneration(baseRestartInput({
    operationId: unkOp,
    expectedGeneration: 5,
    expectedStateVersion: 1,
  }));
  harness.setCommitReject(false);
  ok('COMMIT reject → commit_outcome_unknown',
    !unknown.ok && unknown.error === 'commit_outcome_unknown');
  // rolled back in harness model — retry may execute once
  const afterUnknown = await store.restartGeneration(baseRestartInput({
    operationId: unkOp,
    expectedGeneration: 5,
    expectedStateVersion: 1,
  }));
  ok('retry same ID after rolled-back ambiguity executes once',
    afterUnknown.ok && afterUnknown.value.outcome === 'committed'
    && afterUnknown.value.replayed === false
    && afterUnknown.value.result_generation === 6);

  // After committed, retry returns persisted
  const afterCommitReplay = await store.restartGeneration(baseRestartInput({
    operationId: unkOp,
    expectedGeneration: 5,
    expectedStateVersion: 1,
  }));
  ok('retry after committed ack-loss returns persisted committed',
    afterCommitReplay.ok && afterCommitReplay.value.replayed === true
    && afterCommitReplay.value.outcome === 'committed');

  // No nested BEGIN during restart (outer only)
  const beginsBefore = harness.beginCount.value;
  const nestedBefore = harness.nestedBegin.value;
  await store.restartGeneration(baseRestartInput({
    operationId: crypto.randomUUID(),
    expectedGeneration: 6,
    expectedStateVersion: 1,
  }));
  ok('exactly one BEGIN per restart (no nested TX)',
    harness.beginCount.value === beginsBefore + 1
    && harness.nestedBegin.value === nestedBefore);
  ok('store never calls client.release',
    harness.releaseCalls.value === 0);

  // Hostile UUID / bounds
  const badUuid = await store.restartGeneration(baseRestartInput({
    operationId: 'not-a-uuid',
  }));
  ok('rejects non-canonical operationId',
    !badUuid.ok && badUuid.error === 'operation_id_invalid');
  const badGen = await store.restartGeneration(baseRestartInput({
    operationId: crypto.randomUUID(),
    expectedGeneration: 0,
  }));
  ok('rejects generation < 1',
    !badGen.ok && badGen.error === 'ingestion_generation_invalid');
  const badBig = await store.restartGeneration(baseRestartInput({
    operationId: crypto.randomUUID(),
    expectedGeneration: Number.MAX_SAFE_INTEGER + 1,
  }));
  ok('rejects generation above MAX_SAFE_INTEGER',
    !badBig.ok && badBig.error === 'ingestion_generation_invalid');

  // Proxy input rejected
  const proxyInput = new Proxy(baseRestartInput({ operationId: crypto.randomUUID() }), {
    get(t, p, r) { return Reflect.get(t, p, r); },
  });
  const proxyRes = await store.restartGeneration(proxyInput);
  ok('proxy input fail closed', !proxyRes.ok);

  // PII-free DTO / no planted secrets
  const planted = await store.restartGeneration(baseRestartInput({
    operationId: crypto.randomUUID(),
    expectedGeneration: 7,
    expectedStateVersion: 1,
  }));
  const ser = JSON.stringify(planted);
  ok('result PII-free (no mailbox/subject/token/cursor)',
    planted.ok
    && !/mailbox|subject|token|cursor|password|refresh/i.test(ser)
    && !ser.includes(MAILBOX));

  // beginNextGeneration still behavior-compatible via factory-bound path
  const deltaStore = makeDeltaStore();
  harness.seedCurrent({
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    provider_tenant_id: TENANT,
    provider_mailbox_id: MAILBOX,
    ingestion_generation: 10,
    state_version: 3,
    phase: 'reset_required',
  });
  const publicNext = await deltaStore.beginNextGeneration(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    expectedGeneration: 10,
    expectedStateVersion: 3,
    providerTenantId: TENANT,
    providerMailboxId: MAILBOX,
    queryVersion: QV1,
  }));
  ok('public beginNextGeneration still works via factory-bound path',
    publicNext.ok && publicNext.value.ingestion_generation === 11
    && publicNext.value.previous_generation === 10);

  // Fresh-process import inert
  const child = spawnSync(process.execPath, ['-e', `
    const m = require(${JSON.stringify(STORE_ABS)});
    if (m.EMAIL_DELTA_RECOVERY_OPERATION_RUNTIME_WIRED !== false) process.exit(2);
    if (typeof m.createEmailDeltaRecoveryOperationStore !== 'function') process.exit(3);
    console.log('ok');
  `], { encoding: 'utf8', cwd: ROOT, env: { ...process.env, NODE_OPTIONS: '' } });
  ok('fresh-process import inert',
    child.status === 0 && /ok/.test(child.stdout || ''));

  // No staff-query-api / route wiring from this module
  const staffSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  ok('staff-query-api does not load recovery store',
    !/email-delta-recovery-operation-store/.test(staffSrc));

  // ── readPageCommitOutcome (authority-bound journal-only; no actor/worker caller) ─
  ok('PAGE_COMMIT_OUTCOME_KEYS exact',
    Array.isArray(PAGE_COMMIT_OUTCOME_KEYS)
    && PAGE_COMMIT_OUTCOME_KEYS.join(',')
      === 'presence,outcome,requested_generation,requested_state_version,result_generation,result_state_version,result_phase');

  {
    const readHarness = createHarness();
    function makeLocalDeltaStore(verifier) {
      return createInboundEmailDeltaStateStore(Object.freeze({
        withTransactionClient: readHarness.withTransactionClient,
        authorityVerifier: verifier || makeAuthorityVerifier(),
      }));
    }
    function makeLocalRecoveryStore(verifier) {
      const v = verifier || makeAuthorityVerifier();
      return createEmailDeltaRecoveryOperationStore(Object.freeze({
        withTransactionClient: readHarness.withTransactionClient,
        authorityVerifier: v,
        inboundDeltaStateStore: makeLocalDeltaStore(v),
      }));
    }
    const store = makeLocalRecoveryStore();
    const targetOp = crypto.randomUUID();

    // Absent
    const absent = await store.readPageCommitOutcome(Object.freeze({
      operationId: targetOp,
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      expectedGeneration: 1,
      expectedStateVersion: 2,
      providerTenantId: TENANT,
      providerMailboxId: MAILBOX,
    }));
    ok('readPageCommitOutcome absent',
      absent.ok && absent.value.presence === 'absent' && absent.value.outcome === null,
      JSON.stringify(absent));
    ok('readPageCommitOutcome absent no operation_id field',
      !Object.prototype.hasOwnProperty.call(absent.value, 'operation_id')
      && !Object.prototype.hasOwnProperty.call(absent.value, 'worker_id'));

    // Reject caller-supplied worker/actor
    const rejectWorker = await store.readPageCommitOutcome(Object.freeze({
      operationId: targetOp,
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      expectedGeneration: 1,
      expectedStateVersion: 2,
      providerTenantId: TENANT,
      providerMailboxId: MAILBOX,
      workerId: PAGE_COMMIT_WORKER_ID,
    }));
    ok('readPageCommitOutcome rejects caller workerId',
      rejectWorker.ok === false && rejectWorker.error === 'input_invalid',
      JSON.stringify(rejectWorker));

    const rejectActor = await store.readPageCommitOutcome(Object.freeze({
      operationId: targetOp,
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      expectedGeneration: 1,
      expectedStateVersion: 2,
      providerTenantId: TENANT,
      providerMailboxId: MAILBOX,
      actorStaffUserId: ACTOR,
    }));
    ok('readPageCommitOutcome rejects caller actorStaffUserId',
      rejectActor.ok === false && rejectActor.error === 'input_invalid',
      JSON.stringify(rejectActor));

    // Seed committed page_commit row
    readHarness.journal.set(targetOp, {
      operation_id: targetOp,
      client_id: CLIENT,
      location_id: LOCATION,
      endpoint_id: ENDPOINT,
      actor_staff_user_id: null,
      actor_kind: 'worker',
      worker_id: PAGE_COMMIT_WORKER_ID,
      operation_kind: 'page_commit',
      requested_generation: 1,
      requested_state_version: 2,
      target_operation_id: null,
      outcome: 'committed',
      result_generation: 1,
      result_state_version: 3,
      result_phase: 'tracking',
    });
    const committed = await store.readPageCommitOutcome(Object.freeze({
      operationId: targetOp,
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      expectedGeneration: 1,
      expectedStateVersion: 2,
      providerTenantId: TENANT,
      providerMailboxId: MAILBOX,
    }));
    ok('readPageCommitOutcome committed',
      committed.ok
      && committed.value.presence === 'present'
      && committed.value.outcome === 'committed'
      && committed.value.result_phase === 'tracking'
      && committed.value.result_generation === 1
      && committed.value.result_state_version === 3,
      JSON.stringify(committed));

    // Fence mismatch → conflict
    const fenceMismatch = await store.readPageCommitOutcome(Object.freeze({
      operationId: targetOp,
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      expectedGeneration: 1,
      expectedStateVersion: 99,
      providerTenantId: TENANT,
      providerMailboxId: MAILBOX,
    }));
    ok('readPageCommitOutcome fence mismatch conflict',
      fenceMismatch.ok === false && fenceMismatch.error === 'operation_id_conflict',
      JSON.stringify(fenceMismatch));

    // Claimed
    const claimedOp = crypto.randomUUID();
    readHarness.journal.set(claimedOp, {
      operation_id: claimedOp,
      client_id: CLIENT,
      location_id: LOCATION,
      endpoint_id: ENDPOINT,
      actor_staff_user_id: null,
      actor_kind: 'worker',
      worker_id: PAGE_COMMIT_WORKER_ID,
      operation_kind: 'page_commit',
      requested_generation: 2,
      requested_state_version: 4,
      target_operation_id: null,
      outcome: 'claimed',
      result_generation: null,
      result_state_version: null,
      result_phase: null,
    });
    const claimed = await store.readPageCommitOutcome(Object.freeze({
      operationId: claimedOp,
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      expectedGeneration: 2,
      expectedStateVersion: 4,
      providerTenantId: TENANT,
      providerMailboxId: MAILBOX,
    }));
    ok('readPageCommitOutcome claimed',
      claimed.ok
      && claimed.value.presence === 'present'
      && claimed.value.outcome === 'claimed',
      JSON.stringify(claimed));

    // Never infers from cursor_operation_id (no 064 consult)
    readHarness.seedCurrent({
      client_id: CLIENT,
      location_id: LOCATION,
      endpoint_id: ENDPOINT,
      provider_tenant_id: TENANT,
      provider_mailbox_id: MAILBOX,
      ingestion_generation: 1,
      state_version: 9,
      phase: 'tracking',
      cursor_operation_id: crypto.randomUUID(),
    });
    const stillCommitted = await store.readPageCommitOutcome(Object.freeze({
      operationId: targetOp,
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      expectedGeneration: 1,
      expectedStateVersion: 2,
      providerTenantId: TENANT,
      providerMailboxId: MAILBOX,
    }));
    ok('readPageCommitOutcome ignores cursor state',
      stillCommitted.ok
      && stillCommitted.value.outcome === 'committed',
      JSON.stringify(stillCommitted));

    // Authority rebind fail closed
    const storeRebind = makeLocalRecoveryStore(makeAuthorityVerifier({ allow: false }));
    const rebind = await storeRebind.readPageCommitOutcome(Object.freeze({
      operationId: targetOp,
      clientId: CLIENT,
      locationId: LOCATION,
      endpointId: ENDPOINT,
      expectedGeneration: 1,
      expectedStateVersion: 2,
      providerTenantId: TENANT,
      providerMailboxId: MAILBOX,
    }));
    ok('readPageCommitOutcome authority rebind fails',
      rebind.ok === false && rebind.error === 'authority_not_verified',
      JSON.stringify(rebind));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
