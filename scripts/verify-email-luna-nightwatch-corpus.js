'use strict';
/** FULL SAIL Stage 1 NIGHTWATCH Chapter 2 Slice C: hostile and golden corpus. */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORPUS = require('../fixtures/email-luna-nightwatch-corpus.json');

const { createEmailLunaDraftEnvelope } = require('./lib/email-luna-draft-handoff-contract');
const {
  issueAndDecideEmailLunaDraftPolicy,
  decideEmailLunaDraftPolicy,
} = require('./lib/email-luna-draft-policy');
const { createEmailLunaDraftAuthor } = require('./lib/email-luna-draft-author');
const { validateEmailLunaDraft } = require('./lib/email-luna-draft-validator');
const {
  createEmailOutboundSendJournalStore,
  EMAIL_OUTBOUND_SEND_JOURNAL_RUNTIME_WIRED,
  OPERATION_RESULT_KEYS,
} = require('./lib/email-outbound-send-journal-store');

const SCHEMA_VERSION = 'email-luna-nightwatch-corpus.v1';
const CASE_COUNT = 68;
const CATEGORY_COUNTS = Object.freeze({
  golden_routine: 24,
  identity_intent_sensitive: 10,
  injection: 9,
  attachment: 3,
  cross_authority: 6,
  evidence: 6,
  provider_unknown_outcome: 2,
  unicode_malformed: 8,
});
const CORPUS_SHA256 = 'e3bba4ebb3b581a58b612f954e094be8d92e38a39c830f4cdee21cb31e41f54a';
const HANDOFF_KEYS = Object.freeze([
  'status', 'reason', 'client_id', 'location_id', 'conversation_id',
  'draft_only', 'requires_staff_review', 'send_allowed', 'auto_send_allowed',
]);
const VALID_KEYS = Object.freeze([
  'status', 'language', 'client_id', 'location_id', 'conversation_id',
  'draft_only', 'requires_staff_review', 'send_allowed', 'auto_send_allowed',
]);
const DRAFT_KEYS = Object.freeze([
  'status', 'subject', 'body', 'language', 'client_id', 'location_id', 'conversation_id',
  'draft_only', 'requires_staff_review', 'send_allowed', 'auto_send_allowed',
]);
const POLICY_PATH = require.resolve('./lib/email-luna-draft-policy');
const AUTHOR_PATH = require.resolve('./lib/email-luna-draft-author');
const VALIDATOR_PATH = require.resolve('./lib/email-luna-draft-validator');
const HANDOFF_PATH = require.resolve('./lib/email-luna-draft-handoff-contract');
const PROVIDER_PATH = require.resolve('./lib/luna-ai-provider');
const JOURNAL_PATH = require.resolve('./lib/email-outbound-send-journal-store');
const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '44444444-4444-4444-8444-444444444444';
const V = '33333333-3333-4333-8333-333333333333';
const A = '55555555-5555-4555-8555-555555555555';
const K = 'sunset-somo';
const DIGEST = crypto.createHash('sha256').update('approved-body-corpus', 'utf8').digest('hex');
const JOURNAL_DRAFT = 'AAMkAGI2-CORPUS-DRAFT-001';
const CLAIM_BLOCKS = Object.freeze([
  ['url', 'const urlFailure = compareUrlClaims(draft.body, matched.body);', 'const urlFailure = null;'],
  ['amount', 'const amountFailure = compareAmountClaims(draft.body, matched.body);', 'const amountFailure = null;'],
  ['date', 'const dateFailure = compareDateClaims(draft.body, matched.body);', 'const dateFailure = null;'],
  ['time', 'const timeFailure = compareTimeClaims(draft.body, matched.body);', 'const timeFailure = null;'],
  ['booking_code', 'const bookingCodeFailure = compareBookingCodeClaims(draft.body, matched.body);', 'const bookingCodeFailure = null;'],
  ['booking_status', 'const bookingStatusFailure = compareBookingStatusClaims(draft.body, matched.body);', 'const bookingStatusFailure = null;'],
  ['payment_status', 'const paymentStatusFailure = comparePaymentStatusClaims(draft.body, matched.body);', 'const paymentStatusFailure = null;'],
  ['balance', 'const balanceFailure = compareBalanceClaims(draft.body, matched.body);', 'const balanceFailure = null;'],
  ['availability', 'const availabilityFailure = compareAvailabilityClaims(draft.body, matched.body);', 'const availabilityFailure = null;'],
  ['capacity', 'const capacityFailure = compareCapacityClaims(draft.body, matched.body);', 'const capacityFailure = null;'],
  ['policy', 'const policyFailure = comparePolicyClaims(draft.body, matched.body);', 'const policyFailure = null;'],
  ['unsupported', 'const unsupportedFailure = compareUnsupportedClaims(draft.body, matched.body);', 'const unsupportedFailure = null;'],
]);

function occurrences(source, block) {
  return source.split(block).length - 1;
}
function replaceUnique(source, block, replacement, label) {
  assert.equal(occurrences(source, block), 1, `${label}: pinned source block must occur exactly once`);
  const mutated = source.replace(block, replacement);
  assert.notEqual(mutated, source, `${label}: mutation must apply`);
  return mutated;
}
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
function capabilityFree(result) {
  assert.equal(result.send_allowed, false);
  assert.equal(result.auto_send_allowed, false);
  assert.equal(result.draft_only, true);
  assert.equal(result.requires_staff_review, true);
  assert.equal('send' in result, false);
  assert.equal('recipient' in result, false);
  assert.equal(typeof result.send, 'undefined');
}
function planJson(plan) {
  return JSON.stringify({
    template_id: plan.template_id,
    tone: plan.tone,
    question_key: plan.question_key,
    acknowledgment_key: plan.acknowledgment_key,
  });
}
function makeEnvelope(spec) {
  return createEmailLunaDraftEnvelope({
    authority: spec.authority,
    untrusted_content: spec.untrusted_content,
  });
}

function createFakeTxnHarness() {
  const durable = new Map();
  const rowLocks = new Map();
  let loanSeq = 0;
  const clone = (r) => ({ ...r });
  const pub = (row) => ({
    operation_id: row.operation_id, approval_id: row.approval_id, phase: row.phase, outcome: row.outcome,
    immutable_draft_id: row.immutable_draft_id, body_digest: row.body_digest,
    create_invocation_count: row.create_invocation_count, update_invocation_count: row.update_invocation_count,
    send_invocation_count: row.send_invocation_count, provider: row.provider,
  });
  const lockState = (op) => {
    let s = rowLocks.get(op);
    if (!s) { s = { owner: null, wait: [] }; rowLocks.set(op, s); }
    return s;
  };
  const acquire = (op, loanId) => {
    const s = lockState(op);
    if (s.owner == null || s.owner === loanId) { s.owner = loanId; return Promise.resolve(); }
    return new Promise((resolve) => { s.wait.push(resolve); }).then(() => { s.owner = loanId; });
  };
  const releaseLocks = (loanId) => {
    for (const [, s] of rowLocks) {
      if (s.owner !== loanId) continue;
      s.owner = null;
      const next = s.wait.shift();
      if (next) next();
    }
  };
  async function withTransactionClient(work) {
    const loanId = (loanSeq += 1);
    let inTx = false;
    const staged = new Map();
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
          const op = String(params[0]).toLowerCase();
          await acquire(op, loanId);
          const row = visible(op);
          return { rows: row ? [clone(row)] : [] };
        }
        if (/FOR UPDATE/.test(norm) && /approval_id = \$2::uuid/.test(norm)) {
          const ap = String(params[1]).toLowerCase();
          await acquire(`approval:${ap}`, loanId);
          const row = byApproval(String(params[0]).toLowerCase(), ap);
          return { rows: row ? [{ operation_id: row.operation_id }] : [] };
        }
        if (/^INSERT INTO tenant_email_outbound_send_journal/.test(norm)) {
          const op = String(params[0]).toLowerCase();
          if (visible(op)) return { rows: [] };
          const ap = String(params[6]).toLowerCase();
          const existingAp = byApproval(String(params[1]).toLowerCase(), ap);
          if (existingAp && existingAp.operation_id !== op) {
            const err = new Error('dup'); err.code = '23505'; throw err;
          }
          const row = {
            operation_id: op, client_id: String(params[1]).toLowerCase(), location_id: String(params[2]).toLowerCase(),
            location_key: String(params[3]), endpoint_id: String(params[4]).toLowerCase(),
            conversation_id: String(params[5]).toLowerCase(), approval_id: ap,
            actor_staff_user_id: String(params[7]).toLowerCase(), provider: 'microsoft_graph',
            immutable_draft_id: null, body_digest: String(params[8]), phase: 'claimed', outcome: 'claimed',
            create_invocation_count: 0, update_invocation_count: 0, send_invocation_count: 0,
            created_at: '2026-08-23T00:00:00.000Z', updated_at: '2026-08-23T00:00:00.000Z',
          };
          staged.set(op, row);
          return { rows: [pub(row)] };
        }
        const pm = /UPDATE tenant_email_outbound_send_journal SET phase='([^']+)'/.exec(norm);
        if (pm) {
          const phase = pm[1];
          const op = String(params[0]).toLowerCase();
          const row = visible(op);
          if (!row) return { rows: [] };
          if (phase === 'create_dispatched') {
            if (row.phase !== 'claimed' || row.immutable_draft_id != null || row.create_invocation_count !== 0
                || row.update_invocation_count !== 0 || row.send_invocation_count !== 0) return { rows: [] };
            row.phase = phase; row.outcome = 'outcome_unknown'; row.create_invocation_count = 1;
          } else if (phase === 'draft_created') {
            if (row.phase !== 'create_dispatched' || row.immutable_draft_id != null || row.create_invocation_count !== 1
                || row.update_invocation_count !== 0 || row.send_invocation_count !== 0) return { rows: [] };
            row.phase = phase; row.outcome = 'not_committed'; row.immutable_draft_id = String(params[1]);
          } else if (phase === 'update_dispatched') {
            if (row.phase !== 'draft_created' || !row.immutable_draft_id || row.immutable_draft_id !== String(params[1])
                || row.create_invocation_count !== 1 || row.update_invocation_count !== 0 || row.send_invocation_count !== 0) return { rows: [] };
            row.phase = phase; row.outcome = 'outcome_unknown'; row.update_invocation_count = 1;
          } else if (phase === 'draft_updated') {
            if (row.phase !== 'update_dispatched' || !row.immutable_draft_id || row.create_invocation_count !== 1
                || row.update_invocation_count !== 1 || row.send_invocation_count !== 0) return { rows: [] };
            row.phase = phase; row.outcome = 'not_committed';
          } else if (phase === 'send_dispatched') {
            if (row.phase !== 'draft_updated' || !row.immutable_draft_id || row.create_invocation_count !== 1
                || row.update_invocation_count !== 1 || row.send_invocation_count !== 0) return { rows: [] };
            row.phase = phase; row.outcome = 'outcome_unknown'; row.send_invocation_count = 1;
          } else return { rows: [] };
          staged.set(op, row);
          return { rows: [pub(row)] };
        }
        throw new Error(`unexpected_sql:${norm.slice(0, 80)}`);
      },
      release() {},
    };
    try { return await work(client); } finally { releaseLocks(loanId); }
  }
  return { withTransactionClient };
}

function journalAuthority() {
  return {
    clientId: C, locationId: L, locationKey: K, endpointId: E, conversationId: V, actorStaffUserId: A,
  };
}
function makeJournalStore(harness) {
  return createEmailOutboundSendJournalStore({
    withTransactionClient: harness.withTransactionClient,
    authority: journalAuthority(),
  });
}
async function advanceJournal(store, advanceTo) {
  const operationId = crypto.randomUUID();
  const approvalId = crypto.randomUUID();
  await store.claim({ operationId, approvalId, bodyDigest: DIGEST });
  if (advanceTo === 'claimed') return { store, operationId };
  const created = await store.claimCreate({ operationId });
  if (advanceTo === 'create_dispatched') return { store, operationId, first: created };
  await store.persistDraftCreated({ operationId, immutableDraftId: JOURNAL_DRAFT });
  await store.claimUpdate({ operationId, immutableDraftId: JOURNAL_DRAFT });
  await store.markDraftUpdated({ operationId });
  const dispatched = await store.claimDispatch({ operationId });
  if (advanceTo === 'send_dispatched') return { store, operationId, first: dispatched };
  throw new Error(`unsupported journal advance ${advanceTo}`);
}

async function runJournalCase(cas) {
  assert.equal(EMAIL_OUTBOUND_SEND_JOURNAL_RUNTIME_WIRED, false);
  const harness = createFakeTxnHarness();
  const store = makeJournalStore(harness);
  const advanced = await advanceJournal(store, cas.journal.advance_to);
  const replayInput = { operationId: advanced.operationId };
  if (cas.journal.replay === 'claimUpdate' || cas.journal.replay === 'reconcileSent') {
    replayInput.immutableDraftId = JOURNAL_DRAFT;
  }
  const replay = await store[cas.journal.replay](replayInput);
  assert.equal(replay.ok, true, `${cas.id}: journal replay ok`);
  const value = replay.value;
  assert.equal(Object.keys(value).length, OPERATION_RESULT_KEYS.length);
  assert.equal(value.phase, cas.expected.phase);
  assert.equal(value.outcome, cas.expected.status);
  assert.equal(value.authorize_dispatch, cas.expected.authorize_dispatch);
  assert.equal(value.authorize_create, cas.expected.authorize_create);
  assert.equal(value.authorize_update, cas.expected.authorize_update);
  assert.equal(value.replayed, cas.expected.replayed);
  if (cas.expected.send_invocation_count != null) {
    assert.equal(value.send_invocation_count, cas.expected.send_invocation_count);
  }
  if (cas.expected.create_invocation_count != null) {
    assert.equal(value.create_invocation_count, cas.expected.create_invocation_count);
  }
  return value;
}

function assertHandoffShape(result, reason, binding, label) {
  assert.deepEqual(Object.keys(result), [...HANDOFF_KEYS], label);
  assert.equal(result.status, 'handoff_required');
  assert.equal(result.reason, reason);
  assert.equal(result.client_id, binding.client_id);
  assert.equal(result.location_id, binding.location_id);
  assert.equal(result.conversation_id, binding.conversation_id);
  capabilityFree(result);
  assert.equal(Object.isFrozen(result), true);
  assert.equal('subject' in result, false);
  assert.equal('body' in result, false);
}

function assertValidShape(result, language, binding) {
  assert.deepEqual(Object.keys(result), [...VALID_KEYS]);
  assert.deepEqual(plain(result), {
    status: 'valid', language,
    client_id: binding.client_id, location_id: binding.location_id, conversation_id: binding.conversation_id,
    draft_only: true, requires_staff_review: true, send_allowed: false, auto_send_allowed: false,
  });
  capabilityFree(result);
}

async function authorDraft(triplet, plan) {
  return createEmailLunaDraftAuthor({
    callModel: () => Promise.resolve(planJson(plan)),
  }).authorDraft(triplet);
}

function issueFromCase(cas) {
  const envelope = makeEnvelope(cas.envelope);
  const issued = issueAndDecideEmailLunaDraftPolicy({
    envelope,
    evidence: cas.evidence,
  });
  return { envelope, evidence: issued.evidence, decision: issued.decision };
}

async function runCase(cas) {
  const expected = cas.expected;
  if (cas.pipeline === 'envelope') {
    assert.throws(() => makeEnvelope(cas.envelope), (error) => {
      assert.equal(error && error.code, expected.code, cas.id);
      assert.equal(error && error.message, 'Email Luna draft handoff contract failed.', cas.id);
      return true;
    }, cas.id);
    return;
  }
  if (cas.pipeline === 'journal_unknown_outcome') {
    await runJournalCase(cas);
    return;
  }
  if (cas.pipeline === 'policy_forged_evidence') {
    const envelope = makeEnvelope(cas.envelope);
    const forged = Object.freeze({ ...cas.evidence, grounded_results: Object.freeze({ ...cas.evidence.grounded_results }) });
    assert.throws(() => decideEmailLunaDraftPolicy({ envelope, evidence: forged }), (error) => {
      assert.equal(error && error.code, 'EMAIL_LUNA_DRAFT_POLICY_INVALID', cas.id);
      return true;
    }, cas.id);
    return;
  }

  if (expected.status === 'invalid' && cas.pipeline === 'policy') {
    assert.throws(() => issueFromCase(cas), (error) => {
      assert.equal(error && error.code, expected.code, cas.id);
      assert.equal(error && error.message, 'Email Luna draft policy failed.', cas.id);
      return true;
    }, cas.id);
    return;
  }

  const first = issueFromCase(cas);
  const binding = first.envelope.authority;

  if (cas.pipeline === 'policy') {
    assertHandoffShape(first.decision, expected.reason, binding, cas.id);
    assert.equal(first.decision.status, expected.status, cas.id);
    return;
  }

  if (cas.pipeline === 'policy_later_decide') {
    assert.equal(first.decision.status, 'draft_ready', `${cas.id} same-turn`);
    const later = decideEmailLunaDraftPolicy({ envelope: first.envelope, evidence: first.evidence });
    assertHandoffShape(later, expected.reason, binding, cas.id);
    return;
  }

  if (cas.pipeline === 'sibling_validator') {
    assert.equal(first.decision.status, 'draft_ready', cas.id);
    const drafted = await authorDraft(first, cas.plan);
    const sibling = issueFromCase(cas);
    const result = validateEmailLunaDraft({ ...sibling, draft: drafted });
    assertHandoffShape(result, expected.reason, binding);
    return;
  }

  assert.equal(first.decision.status, expected.policy_status || 'draft_ready', `${cas.id} policy`);
  const drafted = await authorDraft(first, cas.plan);
  assert.equal(drafted.status, 'draft_ready', `${cas.id} author`);
  assert.deepEqual(Object.keys(drafted), [...DRAFT_KEYS]);
  capabilityFree(drafted);
  if (expected.subject != null) assert.equal(drafted.subject, expected.subject, `${cas.id} subject`);
  if (expected.body != null) assert.equal(drafted.body, expected.body, `${cas.id} body`);
  if (expected.language != null) assert.equal(drafted.language, expected.language, `${cas.id} language`);
  if (Array.isArray(expected.forbidden_in_output)) {
    const output = `${drafted.subject}\n${drafted.body}`;
    for (const token of expected.forbidden_in_output) {
      assert.equal(output.includes(token), false, `${cas.id} leaked ${JSON.stringify(token)}`);
    }
  }

  const validated = validateEmailLunaDraft({ ...first, draft: drafted });
  if (expected.status === 'valid') {
    assertValidShape(validated, drafted.language, binding);
  } else {
    assertHandoffShape(validated, expected.reason, binding);
  }

  if (cas.pipeline === 'policy_author_validator_replay') {
    const again = validateEmailLunaDraft({ ...first, draft: drafted });
    assert.deepEqual(plain(again), plain(validated), `${cas.id} replay`);
  }
}

function rewriteAuthor(source) {
  return source
    .replace("require('./email-luna-draft-handoff-contract')", `require(${JSON.stringify(HANDOFF_PATH)})`)
    .replace("require('./email-luna-draft-policy')", `require(${JSON.stringify(POLICY_PATH)})`)
    .replace("require('./luna-ai-provider')", `require(${JSON.stringify(PROVIDER_PATH)})`);
}
function rewritePolicy(source) {
  return source.replace("require('./email-luna-draft-handoff-contract')", `require(${JSON.stringify(HANDOFF_PATH)})`);
}
function rewriteValidator(source, authorPath) {
  return source
    .replace("require('./email-luna-draft-handoff-contract')", `require(${JSON.stringify(HANDOFF_PATH)})`)
    .replace("require('./email-luna-draft-policy')", `require(${JSON.stringify(POLICY_PATH)})`)
    .replace("require('./email-luna-draft-author')", `require(${JSON.stringify(authorPath)})`);
}
function loadMutant(name, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `email-luna-ch2c-${name}-`));
  const libDir = path.join(root, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  const loaded = { root };
  for (const [filename, source] of Object.entries(files)) {
    const filePath = path.join(libDir, filename);
    fs.writeFileSync(filePath, source, { flag: 'wx' });
    loaded[filename] = require(filePath);
  }
  return loaded;
}

function caseById(id) {
  const found = CORPUS.cases.find((item) => item.id === id);
  assert.ok(found, `missing corpus case ${id}`);
  return found;
}

async function expectMutantDiverges(label, run) {
  let diverged = false;
  try {
    await run();
  } catch (error) {
    diverged = true;
    assert.ok(error, label);
  }
  assert.equal(diverged, true, `${label}: removing the guard must fail a corpus assertion`);
}

(async () => {
  console.log('FULL SAIL Stage 1 NIGHTWATCH Ch2 Slice C hostile and golden corpus');

  assert.equal(CORPUS.schema_version, SCHEMA_VERSION);
  assert.equal(CORPUS.id, 'email-luna-nightwatch-ch2c');
  assert.equal(CORPUS.case_count, CASE_COUNT);
  assert.equal(CORPUS.cases.length, CASE_COUNT);
  assert.deepEqual(CORPUS.categories, CATEGORY_COUNTS);
  const counted = {};
  const ids = new Set();
  for (const item of CORPUS.cases) {
    assert.equal(typeof item.id, 'string');
    assert.equal(ids.has(item.id), false, `duplicate ${item.id}`);
    ids.add(item.id);
    counted[item.category] = (counted[item.category] || 0) + 1;
    assert.equal(typeof item.pipeline, 'string');
    assert.equal(typeof item.expected, 'object');
    assert.equal(item.expected.send_allowed === false || item.expected.status === 'invalid' || item.pipeline === 'journal_unknown_outcome' || item.expected.code != null, true, `${item.id} capability`);
  }
  assert.deepEqual(counted, CATEGORY_COUNTS);
  const serialized = JSON.stringify(CORPUS);
  assert.equal(/sk_live|rk_live|whsec_|payment_intent|acct_|cus_/.test(serialized), false, 'no live credentials');
  assert.equal(/@sunsetsurfspain|@wolfhouse|staff-staging|lunabox/.test(serialized), false, 'no live identifiers');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../fixtures/email-luna-nightwatch-corpus.json'))).digest('hex');
  assert.equal(digest, CORPUS_SHA256, 'corpus hash pin: silent fixture weakening must fail');

  for (const item of CORPUS.cases) {
    await runCase(item);
  }
  console.log(`  PASS  ${CASE_COUNT} corpus cases execute authentic policy→author→validator / journal contracts`);

  const policySrc = fs.readFileSync(POLICY_PATH, 'utf8');
  const authorSrc = fs.readFileSync(AUTHOR_PATH, 'utf8');
  const validatorSrc = fs.readFileSync(VALIDATOR_PATH, 'utf8');
  const journalSrc = fs.readFileSync(JOURNAL_PATH, 'utf8');

  const CONVERSATION_BLOCK = `  if (evidence.conversation_id !== trusted.binding.conversation_id
      || evidence.endpoint_id !== trusted.authority.endpoint_id) {
    return finish(handoff('authority_mismatch', trusted.binding));
  }`;
  const TENANT_BLOCK = '  if (evidence.client_id !== trusted.binding.client_id || evidence.location_id !== trusted.binding.location_id) {';
  const CROSS_BLOCK = '  if (evidence.requested_location_id !== trusted.binding.location_id) return finish(handoff(\'cross_location_request\', trusted.binding));';
  const FRESH_BLOCK = '  if (freshness === \'stale\') return finish(handoff(\'stale_evidence\', trusted.binding));\n  if (freshness !== \'fresh\') throw invalid();';
  const INJECTION_BLOCK = '  if (hasInjection(trusted.untrustedContent)) return finish(handoff(\'prompt_injection_detected\', trusted.binding));';
  const ATTACH_BLOCK = '  if (trusted.attachment_interpretation_required === true) {';
  const SCHEMA_BLOCK = '    if (snapshot.status !== \'draft_ready\' || snapshot.draft_only !== true\n        || snapshot.requires_staff_review !== true || snapshot.send_allowed !== false\n        || snapshot.auto_send_allowed !== false) throw invalid();';
  const SUBJECT_BLOCK = 'if(!name||!price)return null;subject=language===\'es\'?\'Opciones y precios\':\'Options and pricing\';';
  const JOURNAL_REPLAY_BLOCK = 'const cur = row.value; if (cur.phase === \'send_dispatched\' || cur.phase === \'reconciled_sent\' || cur.send_invocation_count === 1) return ok(toPublic(cur, true, null));';
  const AUTHOR_PROVENANCE_BLOCK = `  if(!weakSetHas(AUTHENTIC_AUTHOR_DRAFTS,draft))throw invalid();
  const meta=weakMapGet(AUTHENTIC_AUTHOR_DRAFT_META,draft);
  if(!meta||typeof meta!=='object'||isProxy(meta))throw invalid();
  if(meta.envelope!==snapshot.envelope||meta.decision!==snapshot.decision||meta.evidence!==snapshot.evidence)throw invalid();
  const plan=meta.plan;if(!plan||plan.template_id!==TEMPLATE_FOR_INTENT[trusted.intent])throw invalid();
  const drafted=render(trusted,plan);if(!drafted)throw invalid();`;

  {
    const mutant = loadMutant('conversation', {
      'email-luna-draft-policy.js': rewritePolicy(replaceUnique(policySrc, CONVERSATION_BLOCK, '  if (false) {\n    return finish(handoff(\'authority_mismatch\', trusted.binding));\n  }', 'conversation')),
    });
    try {
      const cas = caseById('hostile.wrong_conversation');
      const issued = mutant['email-luna-draft-policy.js'].issueAndDecideEmailLunaDraftPolicy({
        envelope: createEmailLunaDraftEnvelope(cas.envelope),
        evidence: cas.evidence,
      });
      await expectMutantDiverges('conversation/endpoint authority', () => {
        assert.equal(issued.decision.status, 'handoff_required');
        assert.equal(issued.decision.reason, 'authority_mismatch');
      });
    } finally { fs.rmSync(mutant.root, { recursive: true, force: true }); }
  }
  {
    const mutant = loadMutant('tenant', {
      'email-luna-draft-policy.js': rewritePolicy(replaceUnique(policySrc, TENANT_BLOCK, '  if (false) {', 'tenant')),
    });
    try {
      const cas = caseById('hostile.cross_tenant');
      const issued = mutant['email-luna-draft-policy.js'].issueAndDecideEmailLunaDraftPolicy({
        envelope: createEmailLunaDraftEnvelope(cas.envelope),
        evidence: cas.evidence,
      });
      await expectMutantDiverges('tenant/location authority', () => {
        assert.equal(issued.decision.status, 'handoff_required');
        assert.equal(issued.decision.reason, 'authority_mismatch');
      });
    } finally { fs.rmSync(mutant.root, { recursive: true, force: true }); }
  }
  {
    const mutant = loadMutant('cross-location', {
      'email-luna-draft-policy.js': rewritePolicy(replaceUnique(policySrc, CROSS_BLOCK, '  if (false) return finish(handoff(\'cross_location_request\', trusted.binding));', 'cross-location')),
    });
    try {
      const cas = caseById('hostile.cross_location');
      const issued = mutant['email-luna-draft-policy.js'].issueAndDecideEmailLunaDraftPolicy({
        envelope: createEmailLunaDraftEnvelope(cas.envelope),
        evidence: cas.evidence,
      });
      await expectMutantDiverges('cross-location authority', () => {
        assert.equal(issued.decision.status, 'handoff_required');
        assert.equal(issued.decision.reason, 'cross_location_request');
      });
    } finally { fs.rmSync(mutant.root, { recursive: true, force: true }); }
  }
  {
    const mutant = loadMutant('freshness', {
      'email-luna-draft-policy.js': rewritePolicy(replaceUnique(policySrc, FRESH_BLOCK, '  if (false) return finish(handoff(\'stale_evidence\', trusted.binding));\n  if (false) throw invalid();', 'freshness')),
    });
    try {
      const cas = caseById('hostile.evidence.stale');
      const env = createEmailLunaDraftEnvelope(cas.envelope);
      const issued = mutant['email-luna-draft-policy.js'].issueAndDecideEmailLunaDraftPolicy({ envelope: env, evidence: cas.evidence });
      const later = mutant['email-luna-draft-policy.js'].decideEmailLunaDraftPolicy({ envelope: env, evidence: issued.evidence });
      await expectMutantDiverges('freshness/provenance', () => {
        assert.equal(later.status, 'handoff_required');
        assert.equal(later.reason, 'stale_evidence');
      });
    } finally { fs.rmSync(mutant.root, { recursive: true, force: true }); }
  }
  {
    const mutant = loadMutant('injection', {
      'email-luna-draft-policy.js': rewritePolicy(replaceUnique(policySrc, INJECTION_BLOCK, '  if (false) return finish(handoff(\'prompt_injection_detected\', trusted.binding));', 'injection')),
    });
    try {
      const cas = caseById('hostile.injection.quoted_thread');
      const issued = mutant['email-luna-draft-policy.js'].issueAndDecideEmailLunaDraftPolicy({
        envelope: createEmailLunaDraftEnvelope(cas.envelope),
        evidence: cas.evidence,
      });
      await expectMutantDiverges('injection/header/Unicode defense', () => {
        assert.equal(issued.decision.status, 'handoff_required');
        assert.equal(issued.decision.reason, 'prompt_injection_detected');
      });
    } finally { fs.rmSync(mutant.root, { recursive: true, force: true }); }
  }
  {
    const authorMutantSrc = rewriteAuthor(replaceUnique(
      authorSrc,
      SUBJECT_BLOCK,
      'if(!name||!price)return null;subject=trusted.untrusted_content.subject;',
      'untrusted-subject',
    ));
    const mutant = loadMutant('unicode-subject', {
      'email-luna-draft-author.js': authorMutantSrc,
    });
    try {
      const cas = caseById('unicode.crlf_subject_inert');
      const issued = issueFromCase(cas);
      const drafted = await mutant['email-luna-draft-author.js'].createEmailLunaDraftAuthor({
        callModel: () => Promise.resolve(planJson(cas.plan)),
      }).authorDraft(issued);
      await expectMutantDiverges('untrusted subject/CRLF/Unicode never copied', () => {
        assert.equal(drafted.subject, cas.expected.subject);
        assert.equal(drafted.subject.includes('\r'), false);
      });
    } finally { fs.rmSync(mutant.root, { recursive: true, force: true }); }
  }
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-luna-ch2c-attach-'));
    const libDir = path.join(root, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    const authorPath = path.join(libDir, 'email-luna-draft-author.js');
    fs.writeFileSync(authorPath, rewriteAuthor(authorSrc), { flag: 'wx' });
    const validatorPath = path.join(libDir, 'email-luna-draft-validator.js');
    fs.writeFileSync(validatorPath, rewriteValidator(replaceUnique(validatorSrc, ATTACH_BLOCK, '  if (false) {', 'attachment'), authorPath), { flag: 'wx' });
    const author = require(authorPath);
    const validator = require(validatorPath);
    try {
      const cas = caseById('hostile.attachment.interpretation_required');
      const issued = issueFromCase(cas);
      const drafted = await author.createEmailLunaDraftAuthor({
        callModel: () => Promise.resolve(planJson(cas.plan)),
      }).authorDraft(issued);
      const result = validator.validateEmailLunaDraft({ ...issued, draft: drafted });
      await expectMutantDiverges('attachment interpretation', () => {
        assert.equal(result.status, 'handoff_required');
        assert.equal(result.reason, 'attachment_interpretation_required');
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-luna-ch2c-provenance-'));
    const libDir = path.join(root, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    const authorPath = path.join(libDir, 'email-luna-draft-author.js');
    fs.writeFileSync(authorPath, rewriteAuthor(replaceUnique(
      authorSrc,
      AUTHOR_PROVENANCE_BLOCK,
      '  const plan={template_id:TEMPLATE_FOR_INTENT[trusted.intent],tone:\'warm\',question_key:\'none\',acknowledgment_key:\'thanks\'}; const drafted=render(trusted,plan);if(!drafted)throw invalid();',
      'provenance',
    )), { flag: 'wx' });
    const validatorPath = path.join(libDir, 'email-luna-draft-validator.js');
    fs.writeFileSync(validatorPath, rewriteValidator(validatorSrc, authorPath), { flag: 'wx' });
    const author = require(authorPath);
    const validator = require(validatorPath);
    try {
      const cas = caseById('golden.en.catalog.warm.none');
      const issued = issueFromCase(cas);
      const drafted = await author.createEmailLunaDraftAuthor({
        callModel: () => Promise.resolve(planJson(cas.plan)),
      }).authorDraft(issued);
      const copy = Object.create(null);
      for (const key of DRAFT_KEYS) {
        Object.defineProperty(copy, key, {
          value: drafted[key], enumerable: true, writable: false, configurable: false,
        });
      }
      Object.freeze(copy);
      const result = validator.validateEmailLunaDraft({ ...issued, draft: copy });
      await expectMutantDiverges('exact-plan draft provenance', () => {
        assert.equal(result.status, 'handoff_required');
        assert.equal(result.reason, 'forged_draft');
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  for (const [family, block, skippedBlock] of CLAIM_BLOCKS) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `email-luna-ch2c-claim-${family}-`));
    const libDir = path.join(root, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    const authorPath = path.join(libDir, 'email-luna-draft-author.js');
    const tamper = {
      url: "draft.body=draft.body+' https://evil.test/pay'",
      amount: "draft.body=draft.body.replace('€20.00','€99.00')",
      date: "draft.body=draft.body.replace('2030-03-15','2031-01-01')",
      time: "draft.body=draft.body.replace('10:30','11:45')",
      booking_code: "draft.body=draft.body.replace('SUN-2048','SUN-9999')",
      booking_status: "draft.body=draft.body.replace('confirmed','cancelled')",
      payment_status: "draft.body=draft.body.replace('We have recorded a partial payment.','The payment is recorded as paid.')",
      balance: "draft.body=draft.body.replace('€30.00','€1.00')",
      availability: "draft.body=draft.body.replace('is available','is not available')",
      capacity: "draft.body=draft.body.replace('6 spots','99 spots')",
      policy: "draft.body=draft.body.replace('48 hours','24 hours')",
      unsupported: "draft.body=draft.body+'\\n\\nYour reservation is all set.'",
    }[family];
    const readyReturn = "const draft=render(trusted,plan);if(!draft)return handoff(r.envelope,'unsupported_claim');return ready(draft,trusted.binding,plan,r);";
    const tamperedReady = readyReturn.replace(
      'return ready(draft,trusted.binding,plan,r);',
      `${tamper};return ready(draft,trusted.binding,plan,r);`,
    );
    fs.writeFileSync(authorPath, rewriteAuthor(replaceUnique(authorSrc, readyReturn, tamperedReady, `tamper-${family}`)), { flag: 'wx' });
    const validatorPath = path.join(libDir, 'email-luna-draft-validator.js');
    const skipped = replaceUnique(validatorSrc, block, skippedBlock, `skip-${family}`);
    fs.writeFileSync(validatorPath, rewriteValidator(skipped, authorPath), { flag: 'wx' });
    const author = require(authorPath);
    const validator = require(validatorPath);
    const intentCase = {
      url: 'golden.en.catalog.warm.none',
      amount: 'golden.en.catalog.warm.none',
      date: 'golden.en.availability.concise.none',
      time: 'golden.en.availability.concise.none',
      booking_code: 'golden.en.booking.warm.none',
      booking_status: 'golden.en.booking.warm.none',
      payment_status: 'golden.en.payment.concise.none',
      balance: 'golden.en.payment.concise.none',
      availability: 'golden.en.availability.concise.none',
      capacity: 'golden.en.availability.concise.none',
      policy: 'golden.en.policy.warm.none',
      unsupported: 'golden.en.catalog.warm.none',
    }[family];
    try {
      const cas = caseById(intentCase);
      const issued = issueFromCase(cas);
      const drafted = await author.createEmailLunaDraftAuthor({
        callModel: () => Promise.resolve(planJson(cas.plan)),
      }).authorDraft(issued);
      const result = validator.validateEmailLunaDraft({ ...issued, draft: drafted });
      await expectMutantDiverges(`claim comparison ${family}`, () => {
        assert.notEqual(result.status, 'valid', `${family} must not validate a tampered claim when the comparison remains`);
      });
      // The skip mutant should accept the tamper; production comparison removal is what we prove.
      assert.equal(result.status, 'valid', `${family}: removing comparison must let the tampered authentic draft validate`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-luna-ch2c-schema-'));
    const libDir = path.join(root, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    const authorPath = path.join(libDir, 'email-luna-draft-author.js');
    fs.writeFileSync(authorPath, rewriteAuthor(authorSrc), { flag: 'wx' });
    const validatorPath = path.join(libDir, 'email-luna-draft-validator.js');
    const mutated = replaceUnique(
      validatorSrc,
      SCHEMA_BLOCK,
      '    if (snapshot.status !== \'draft_ready\' || snapshot.draft_only !== true\n        || snapshot.requires_staff_review !== true || snapshot.auto_send_allowed !== false) throw invalid();',
      'send-schema',
    );
    fs.writeFileSync(validatorPath, rewriteValidator(mutated, authorPath), { flag: 'wx' });
    const author = require(authorPath);
    const validator = require(validatorPath);
    try {
      const cas = caseById('golden.en.catalog.warm.none');
      const issued = issueFromCase(cas);
      const drafted = await author.createEmailLunaDraftAuthor({
        callModel: () => Promise.resolve(planJson(cas.plan)),
      }).authorDraft(issued);
      const leaky = Object.create(null);
      for (const key of DRAFT_KEYS) {
        Object.defineProperty(leaky, key, {
          value: key === 'send_allowed' ? true : drafted[key],
          enumerable: true, writable: false, configurable: false,
        });
      }
      Object.freeze(leaky);
      await expectMutantDiverges('send-denial/exact schema', () => {
        assert.throws(() => validator.validateEmailLunaDraft({ ...issued, draft: leaky }), (error) => {
          assert.equal(error && error.code, 'EMAIL_LUNA_DRAFT_VALIDATOR_INVALID');
          return true;
        });
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  {
    const mutatedJournal = replaceUnique(
      journalSrc,
      JOURNAL_REPLAY_BLOCK,
      'const cur = row.value; if (cur.phase === \'send_dispatched\' || cur.phase === \'reconciled_sent\' || cur.send_invocation_count === 1) return ok(toPublic(cur, false, { dispatch: true }));',
      'journal-replay',
    );
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'email-luna-ch2c-journal-'));
    const mutantPath = path.join(root, 'email-outbound-send-journal-store.js');
    fs.writeFileSync(mutantPath, mutatedJournal, { flag: 'wx' });
    const journal = require(mutantPath);
    try {
      const harness = createFakeTxnHarness();
      const store = journal.createEmailOutboundSendJournalStore({
        withTransactionClient: harness.withTransactionClient,
        authority: journalAuthority(),
      });
      const advanced = await advanceJournal(store, 'send_dispatched');
      const replay = await store.claimDispatch({ operationId: advanced.operationId });
      await expectMutantDiverges('provider unknown-outcome no-blind-retry', () => {
        assert.equal(replay.value.authorize_dispatch, false);
        assert.equal(replay.value.replayed, true);
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  console.log('  PASS  executable guard-removal mutants kill corpus assertions');
  console.log('ALL OK — FULL SAIL Stage 1 NIGHTWATCH Ch2 Slice C corpus');
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
