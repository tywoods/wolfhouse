'use strict';
/**
 * Deployed-boundary verifier for Sunset-staging forced post-send uncertainty seam.
 *
 * Honest scope: offline / hostile-mock / injected provider+auth — NOT unseamed
 * full-stack live Graph. Proves state graph send_dispatched/outcome_unknown after
 * real sendDraft acceptance, zero second send, recovery reconcile to committed.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const SEAM_ABS = path.join(ROOT, 'scripts/lib/email-outbound-forced-post-send-uncertainty-seam.js');
const COMP_ABS = path.join(ROOT, 'scripts/lib/email-outbound-sunset-staging-runtime-composition.js');
const {
  createAuthorityBoundOutboundOperation,
} = require('./lib/email-authority-bound-outbound-operation');
const { createEmailOutboundSendJournalStore } = require('./lib/email-outbound-send-journal-store');
const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333';
const V = '44444444-4444-4444-8444-444444444444';
const A = '55555555-5555-4555-8555-555555555555';
const M = '22222222-2222-4222-8222-2222222222ab';
const K = 'sunset-somo';
const SRC = 'AAMkAGI2-SRC-FORCE-UNCERTAINTY';
const DRAFT = 'AAMkAGI2-DRAFT-FORCE-UNCERTAINTY';
const BODY = 'Forced uncertainty staff body Gate3.';
const DIGEST = crypto.createHash('sha256').update(BODY, 'utf8').digest('hex');
const TOKEN = 'atok-NEVER_LEAK-force-uncertainty';
const PLANTED = 'NEVER_LEAK_force_uncertainty';
let pass = 0; let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); return true; }
  fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); return false;
}
function noSecret(v) {
  const t = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return !t.includes(TOKEN) && !t.includes(PLANTED) && !t.includes(BODY)
    && !t.includes('access_token') && !t.includes('refresh_token') && !t.includes('Bearer ');
}
function authority() {
  return {
    clientId: C, locationId: L, locationKey: K, endpointId: E, conversationId: V,
    actorStaffUserId: A, providerMailboxId: M, sourceMessageId: SRC,
  };
}
function createFakeTxnHarness() {
  const durable = new Map(); let loanSeq = 0; const rowLocks = new Map();
  const clone = (r) => ({ ...r });
  const lockState = (op) => { let s = rowLocks.get(op); if (!s) { s = { owner: null, wait: [] }; rowLocks.set(op, s); } return s; };
  const acquire = (op, loanId) => {
    const s = lockState(op);
    if (s.owner == null || s.owner === loanId) { s.owner = loanId; return Promise.resolve(); }
    return new Promise((r) => s.wait.push(r)).then(() => { s.owner = loanId; });
  };
  const releaseLocks = (loanId) => {
    for (const [, s] of rowLocks) {
      if (s.owner !== loanId) continue; s.owner = null; const n = s.wait.shift(); if (n) n();
    }
  };
  const pub = (row) => ({
    operation_id: row.operation_id, approval_id: row.approval_id, phase: row.phase, outcome: row.outcome,
    immutable_draft_id: row.immutable_draft_id, body_digest: row.body_digest,
    create_invocation_count: row.create_invocation_count, update_invocation_count: row.update_invocation_count,
    send_invocation_count: row.send_invocation_count, provider: row.provider,
  });
  async function withTransactionClient(work) {
    const loanId = (loanSeq += 1); let inTx = false; const staged = new Map();
    const visible = (op) => (staged.has(op) ? staged.get(op) : (durable.has(op) ? clone(durable.get(op)) : null));
    const byApproval = (cid, ap) => {
      for (const row of staged.values()) if (row.client_id === cid && row.approval_id === ap) return row;
      for (const row of durable.values()) if (row.client_id === cid && row.approval_id === ap) return clone(row);
      return null;
    };
    const client = {
      async query(sql, params) {
        const norm = String(sql).replace(/\s+/g, ' ').trim();
        if (norm === 'BEGIN') { if (inTx) throw new Error('nested'); inTx = true; staged.clear(); return { rows: [] }; }
        if (norm === 'COMMIT') {
          for (const [k, row] of staged) durable.set(k, clone(row));
          staged.clear(); inTx = false; releaseLocks(loanId); return { rows: [] };
        }
        if (norm === 'ROLLBACK') { staged.clear(); inTx = false; releaseLocks(loanId); return { rows: [] }; }
        if (/FOR UPDATE/.test(norm) && /operation_id = \$1::uuid/.test(norm)) {
          const op = String(params[0]).toLowerCase(); await acquire(op, loanId);
          const row = visible(op); return { rows: row ? [clone(row)] : [] };
        }
        if (/FOR UPDATE/.test(norm) && /approval_id = \$2::uuid/.test(norm)) {
          const ap = String(params[1]).toLowerCase(); await acquire(`approval:${ap}`, loanId);
          const row = byApproval(String(params[0]).toLowerCase(), ap);
          return { rows: row ? [{ operation_id: row.operation_id }] : [] };
        }
        if (/^INSERT INTO tenant_email_outbound_send_journal/.test(norm)) {
          const op = String(params[0]).toLowerCase(); if (visible(op)) return { rows: [] };
          const ap = String(params[6]).toLowerCase();
          const existingAp = byApproval(String(params[1]).toLowerCase(), ap);
          if (existingAp && existingAp.operation_id !== op) { const err = new Error('dup'); err.code = '23505'; throw err; }
          const row = {
            operation_id: op, client_id: String(params[1]).toLowerCase(), location_id: String(params[2]).toLowerCase(),
            location_key: String(params[3]), endpoint_id: String(params[4]).toLowerCase(),
            conversation_id: String(params[5]).toLowerCase(), approval_id: ap,
            actor_staff_user_id: String(params[7]).toLowerCase(), provider: 'microsoft_graph',
            immutable_draft_id: null, body_digest: String(params[8]), phase: 'claimed', outcome: 'claimed',
            create_invocation_count: 0, update_invocation_count: 0, send_invocation_count: 0,
          };
          staged.set(op, row); return { rows: [pub(row)] };
        }
        const pm = /UPDATE tenant_email_outbound_send_journal SET phase='([^']+)'/.exec(norm);
        if (pm) {
          const phase = pm[1]; const op = String(params[0]).toLowerCase(); const row = visible(op);
          if (!row) return { rows: [] };
          const cc = row.create_invocation_count; const uc = row.update_invocation_count;
          const sc = row.send_invocation_count; const id = row.immutable_draft_id;
          if (phase === 'create_dispatched') {
            if (row.phase !== 'claimed' || id != null || cc || uc || sc) return { rows: [] };
            row.phase = phase; row.outcome = 'outcome_unknown'; row.create_invocation_count = 1;
          } else if (phase === 'draft_created') {
            if (row.phase !== 'create_dispatched' || id != null || cc !== 1 || uc || sc) return { rows: [] };
            row.phase = phase; row.outcome = 'not_committed'; row.immutable_draft_id = String(params[1]);
          } else if (phase === 'update_dispatched') {
            if (row.phase !== 'draft_created' || !id || id !== String(params[1]) || cc !== 1 || uc || sc) return { rows: [] };
            row.phase = phase; row.outcome = 'outcome_unknown'; row.update_invocation_count = 1;
          } else if (phase === 'draft_updated') {
            if (row.phase !== 'update_dispatched' || !id || cc !== 1 || uc !== 1 || sc) return { rows: [] };
            row.phase = phase; row.outcome = 'not_committed';
          } else if (phase === 'send_dispatched') {
            if (row.phase !== 'draft_updated' || !id || cc !== 1 || uc !== 1 || sc) return { rows: [] };
            row.phase = phase; row.outcome = 'outcome_unknown'; row.send_invocation_count = 1;
          } else if (phase === 'reconciled_sent') {
            if (row.phase !== 'send_dispatched' || sc !== 1 || id !== String(params[1])) return { rows: [] };
            row.phase = phase; row.outcome = 'committed';
          } else return { rows: [] };
          staged.set(op, row); return { rows: [pub(row)] };
        }
        throw new Error(`unexpected_sql:${norm.slice(0, 60)}`);
      },
    };
    try { return await work(client); } finally { releaseLocks(loanId); }
  }
  return { withTransactionClient, durable };
}
function countingTransport(c) {
  c.create = 0; c.update = 0; c.send = 0; c.reconcile = 0;
  const scrub = (i) => { try { i.accessToken = null; } catch { /* */ } };
  return Object.freeze({
    async createReply(input) {
      c.create += 1; scrub(input);
      return Object.freeze({ outcome: 'draft_created', immutable_draft_id: DRAFT, isDraft: true });
    },
    async updateApprovedDraft(input) {
      c.update += 1; try { input.accessToken = null; input.body_content = null; } catch { /* */ }
      return Object.freeze({ outcome: 'draft_updated', immutable_draft_id: DRAFT });
    },
    async sendDraft(input) {
      c.send += 1; scrub(input);
      return Object.freeze({
        outcome: 'send_accepted', immutable_draft_id: DRAFT, delivery_claimed: false,
        http_status: 202, requires_reconcile: true,
      });
    },
    async reconcileDraft(input) {
      c.reconcile += 1; scrub(input);
      return Object.freeze({
        outcome: 'sent', immutable_draft_id: DRAFT, isDraft: false, authorize_automatic_resend: false,
      });
    },
  });
}
function makeAccess() {
  return Object.freeze({
    async runWithAccessTokenOnce(input, consumer) {
      if (!input || input.clientId !== C || input.endpointId !== E) {
        return Object.freeze({ ok: false, status: 'unavailable', grant_generation: null });
      }
      const loan = { accessToken: TOKEN };
      try { return Object.freeze({ ok: true, grant_generation: 2, value: await consumer(loan) }); }
      finally { try { loan.accessToken = null; } catch { /* */ } }
    },
  });
}

async function main() {
  console.log('verify:email-outbound-forced-post-send-uncertainty-seam — staging-only\n');
  console.log('NOTE: injected provider/auth — not unseamed full-stack Graph live proof.\n');

  ok('seam module exists', fs.existsSync(SEAM_ABS));
  let seam;
  try {
    delete require.cache[SEAM_ABS];
    seam = require(SEAM_ABS);
  } catch (e) {
    ok('seam module loads', false, String(e && e.message || e));
    console.log(`\n── FAILED (${pass} pass, ${fail} fail) ──`);
    process.exit(1);
  }
  ok('seam constants',
    seam.ENV_FORCE_POST_SEND_UNCERTAINTY === 'EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY'
    && seam.SUNSET_DEPLOYMENT === 'sunset-staging'
    && seam.ENV_DEPLOYMENT === 'LUNA_DEPLOYMENT'
    && seam.TRANSPORT_KEYS.join(',') === 'createReply,updateApprovedDraft,sendDraft,reconcileDraft');

  const en = seam.isForcedPostSendUncertaintyEnabled;
  ok('default off empty', en({}) === false);
  ok('default off force only', en({ EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY: 'true' }) === false);
  ok('default off staging only', en({ LUNA_DEPLOYMENT: 'sunset-staging' }) === false);
  ok('reject TRUE casing', en({ LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY: 'TRUE' }) === false);
  ok('reject 1', en({ LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY: '1' }) === false);
  ok('reject yes', en({ LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY: 'yes' }) === false);
  ok('reject production', en({ LUNA_DEPLOYMENT: 'production', EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY: 'true' }) === false);
  ok('reject non-sunset', en({ LUNA_DEPLOYMENT: 'sunset', EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY: 'true' }) === false);
  ok('exact enable', en({ LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY: 'true' }) === true);

  const accessorEnv = {};
  Object.defineProperty(accessorEnv, 'LUNA_DEPLOYMENT', { get() { return 'sunset-staging'; }, enumerable: true });
  Object.defineProperty(accessorEnv, 'EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY', { get() { return 'true'; }, enumerable: true });
  ok('reject accessor env', en(accessorEnv) === false);
  let proxyRejected = true;
  try {
    const p = new Proxy({ LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY: 'true' }, {
      get(t, k) { return t[k]; },
    });
    proxyRejected = en(p) === false;
  } catch { proxyRejected = true; }
  ok('reject proxy env', proxyRejected);

  const counters = {};
  const base = countingTransport(counters);
  const onEnv = Object.freeze({
    LUNA_DEPLOYMENT: 'sunset-staging',
    EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY: 'true',
  });
  const offWrap = seam.wrapReplyDraftTransportForForcedPostSendUncertainty(base, {
    LUNA_DEPLOYMENT: 'sunset-staging', EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY: 'false',
  });
  ok('disabled wrap identity', offWrap === base);

  counters.reconcile = 0; counters.send = 0;
  const forced = seam.wrapReplyDraftTransportForForcedPostSendUncertainty(base, onEnv);
  ok('enabled wrap frozen distinct', forced && forced !== base && Object.isFrozen(forced));
  await forced.sendDraft({ accessToken: TOKEN, provider_mailbox_id: M, immutable_draft_id: DRAFT });
  ok('send once', counters.send === 1);
  const forcedRecon = await forced.reconcileDraft({
    accessToken: TOKEN, provider_mailbox_id: M, immutable_draft_id: DRAFT,
  });
  ok('first reconcile forced outcome_unknown no provider GET',
    counters.reconcile === 0
    && forcedRecon.outcome === 'outcome_unknown'
    && forcedRecon.isDraft === true
    && forcedRecon.authorize_automatic_resend === false
    && noSecret(forcedRecon));
  const realRecon = await forced.reconcileDraft({
    accessToken: TOKEN, provider_mailbox_id: M, immutable_draft_id: DRAFT,
  });
  ok('second reconcile real provider', counters.reconcile === 1 && realRecon.outcome === 'sent' && realRecon.isDraft === false);

  const forced2 = seam.wrapReplyDraftTransportForForcedPostSendUncertainty(base, onEnv);
  counters.reconcile = 0;
  await forced2.reconcileDraft({ accessToken: TOKEN, provider_mailbox_id: M, immutable_draft_id: DRAFT });
  ok('fresh wrap no pending skip', counters.reconcile === 1);

  // Full authority-bound path with forced wrap
  const harness = createFakeTxnHarness();
  const c1 = {};
  const t1 = seam.wrapReplyDraftTransportForForcedPostSendUncertainty(countingTransport(c1), onEnv);
  const journal1 = createEmailOutboundSendJournalStore(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
    authority: Object.freeze({
      clientId: C, locationId: L, locationKey: K, endpointId: E, conversationId: V, actorStaffUserId: A,
    }),
  }));
  const op1 = createAuthorityBoundOutboundOperation(Object.freeze({
    journalStore: journal1,
    createAccessSession: () => makeAccess(),
    replyDraftTransport: t1,
    authority: authority(),
  }));
  const opId = crypto.randomUUID();
  const apId = crypto.randomUUID();
  const first = await op1.runAuthorityBoundOutbound(Object.freeze({
    operationId: opId, approvalId: apId, messageText: BODY,
  }));
  const rowAfter = harness.durable.get(opId.toLowerCase());
  ok('forced path create+update+send once', c1.create === 1 && c1.update === 1 && c1.send === 1);
  ok('forced path public outcome_unknown',
    first && first.ok === true && first.value
    && first.value.status === 'outcome_unknown'
    && first.value.phase === 'send_dispatched'
    && first.value.send_invocation_count === 1
    && first.value.outcome === 'outcome_unknown'
    && !Object.prototype.hasOwnProperty.call(first.value, 'immutable_draft_id')
    && noSecret(first));
  ok('forced durable journal send_dispatched send=1',
    rowAfter && rowAfter.phase === 'send_dispatched' && rowAfter.outcome === 'outcome_unknown'
    && rowAfter.send_invocation_count === 1 && rowAfter.immutable_draft_id === DRAFT
    && rowAfter.body_digest === DIGEST
    && c1.reconcile === 0);

  // Recovery with fresh wrap → real reconcile, zero second send
  const c2 = {};
  const t2 = seam.wrapReplyDraftTransportForForcedPostSendUncertainty(countingTransport(c2), onEnv);
  const op2 = createAuthorityBoundOutboundOperation(Object.freeze({
    journalStore: createEmailOutboundSendJournalStore(Object.freeze({
      withTransactionClient: harness.withTransactionClient,
      authority: Object.freeze({
        clientId: C, locationId: L, locationKey: K, endpointId: E, conversationId: V, actorStaffUserId: A,
      }),
    })),
    createAccessSession: () => makeAccess(),
    replyDraftTransport: t2,
    authority: authority(),
  }));
  const second = await op2.runAuthorityBoundOutbound(Object.freeze({
    operationId: opId, approvalId: apId, messageText: BODY,
  }));
  const rowFinal = harness.durable.get(opId.toLowerCase());
  ok('recovery zero second send/create/update',
    c2.send === 0 && c2.create === 0 && c2.update === 0 && c2.reconcile === 1);
  ok('recovery committed exact draft',
    second && second.ok === true && second.value && second.value.status === 'committed'
    && second.value.phase === 'reconciled_sent' && second.value.outcome === 'committed'
    && rowFinal && rowFinal.phase === 'reconciled_sent' && rowFinal.send_invocation_count === 1
    && rowFinal.immutable_draft_id === DRAFT && noSecret(second));

  const compSrc = fs.readFileSync(COMP_ABS, 'utf8');
  ok('composition imports forced uncertainty seam',
    /email-outbound-forced-post-send-uncertainty-seam/.test(compSrc)
    && /wrapReplyDraftTransportForForcedPostSendUncertainty/.test(compSrc));
  ok('composition does not hardcode force on',
    !/EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY\s*[:=]\s*['"]true['"]/.test(compSrc));

  const pinProbe = spawnSync(process.execPath, ['-e', `
    delete process.env.EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY;
    delete process.env.LUNA_DEPLOYMENT;
    const seam = require(${JSON.stringify(SEAM_ABS)});
    if (seam.isForcedPostSendUncertaintyEnabled(process.env) !== false) process.exit(2);
    process.env.LUNA_DEPLOYMENT = 'sunset-staging';
    process.env.EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY = 'true';
    if (seam.isForcedPostSendUncertaintyEnabled(process.env) !== false) process.exit(3);
    if (seam.isForcedPostSendUncertaintyEnabled({
      LUNA_DEPLOYMENT: 'sunset-staging',
      EMAIL_OUTBOUND_FORCE_POST_SEND_UNCERTAINTY: 'true',
    }) !== true) process.exit(4);
    console.log('pin_ok');
  `], { cwd: ROOT, encoding: 'utf8', timeout: 15000, env: { ...process.env } });
  ok('module-init pin rejects ambient process.env re-enable',
    pinProbe.status === 0 && /pin_ok/.test(pinProbe.stdout),
    (pinProbe.stderr || pinProbe.stdout || '').slice(0, 200));

  const seamSrc = fs.readFileSync(SEAM_ABS, 'utf8');
  ok('seam no auto retry/resend',
    !/setInterval|authorize_automatic_resend\s*:\s*true/.test(seamSrc)
    && /authorize_automatic_resend:\s*false/.test(seamSrc));
  ok('seam post-send before reconcile only',
    /sendDraft/.test(seamSrc) && /reconcileDraft/.test(seamSrc) && /pendingSkipReconcile/.test(seamSrc));

  console.log(`\n── verify:email-outbound-forced-post-send-uncertainty-seam ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
