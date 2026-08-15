'use strict';

/**
 * EMAIL-DRAFT-OPEN-003 — focused RED→GREEN.
 *
 * Seadog QA-007 is intentionally red until the generate-on-open producer
 * requires the authoritative conversation row's needs_human === true.
 * This file is that authentic producer gate — not a UI-copy regex.
 *
 * When needs_human is false / null / malformed, the producer must not
 * invoke generation, persist a new draft/approval, or cause model /
 * Graph / provider side effects. When true and otherwise eligible,
 * preserve existing draft-or-honest-pending behavior.
 *
 * Canonical owner: scripts/lib/staff-email-luna-draft-open.js
 * Generate POST stays fail-closed. Auto-send stays off. No Inbox chrome.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const OWNER_REL = 'scripts/lib/staff-email-luna-draft-open.js';
const OWNER_PATH = path.join(ROOT, OWNER_REL);
const GENERATE_ROUTE_PATH = path.join(ROOT, 'scripts/lib/staff-email-luna-draft-route.js');
const POLICY_PATH = path.join(ROOT, 'scripts/lib/email-luna-draft-open-policy-composition.js');
const THREAD_PATH = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const PKG = path.join(ROOT, 'package.json');

const {
  SAFE_ACKNOWLEDGMENT,
} = require('./lib/email-luna-draft-open-policy-composition');

const C = '11111111-1111-4111-8111-111111111111';
const C2 = '11111111-1111-4111-8111-111111111112';
const L = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333';
const V = '44444444-4444-4444-8444-444444444444';
const A = '55555555-5555-4555-8555-555555555555';
const M = '66666666-6666-4666-8666-666666666666';
const MAILBOX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GRAPH_ID = 'opaque/id+with=padding';
const BODY = 'Hello — can you help us rent two boards this Saturday?';

const EXPECTED_SAFE_ACKNOWLEDGMENT = Object.freeze({
  en: 'Hi,\n\nThanks for your message. We’ll review it and get back to you shortly.\n\nWarm regards,\nLuna',
  es: 'Hola,\n\nGracias por tu mensaje. Lo revisaremos y te responderemos en breve.\n\nUn saludo cálido,\nLuna',
});

const FORBIDDEN_TOUCH = Object.freeze([
  'scripts/browser/inbox-thread.js',
  'scripts/browser/inbox-list.js',
  'scripts/browser/inbox-shell.js',
  'scripts/lib/email-google-oauth-start.js',
  'scripts/lib/email-google-oauth-callback-completion.js',
  'scripts/lib/email-outbound-sunset-staging-runtime-composition.js',
  'scripts/staff-query-api.js',
]);

const MODULE_ROOTS = Object.freeze([
  ROOT,
  '/opt/data/email-slice-1b',
  '/opt/data/wolfhouse-pr366',
  '/opt/data/wolfhouse-agent',
  '/opt/wolfhouse/WH',
]);

function loadOwner() {
  delete require.cache[require.resolve('./lib/staff-email-luna-draft-open')];
  return require('./lib/staff-email-luna-draft-open');
}

function actor(patch = {}) {
  return Object.freeze(Object.assign(Object.create(null), {
    staff_user_id: A, client_id: C, role: 'operator',
  }, patch));
}

function gateOn() {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
    EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
    STAFF_PORTAL_ORIGIN: 'https://staff.sunset.test',
  };
}

function authorityRow(patch = {}) {
  return {
    client_id: C,
    client_slug: 'sunset',
    location_id: L,
    location_key: 'sunset-somo',
    endpoint_id: E,
    conversation_id: V,
    inbound_message_id: M,
    channel: 'email',
    provider: 'microsoft_graph',
    provider_mailbox_id: MAILBOX,
    provider_source_message_id: GRAPH_ID,
    endpoint_provider_mailbox_id: MAILBOX,
    event_location_id: L,
    subject: 'Boards for Saturday',
    body_text: '',
    quoted_history: '',
    from_display_name: 'Ana',
    from_address: 'ana@example.test',
    conversation_deleted_at: null,
    conversation_status: 'open',
    needs_human: true,
    latest_message_id: M,
    staff_reply_draft: null,
    conversation_metadata: {},
    luna_draft_enabled: true,
    ...patch,
  };
}

function bodyDigest(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function tryResolve(specifier) {
  for (const base of MODULE_ROOTS) {
    try {
      return require(require.resolve(specifier, { paths: [base] }));
    } catch {
      /* next root */
    }
  }
  return null;
}

function tryLoadPglite() {
  const mod = tryResolve('@electric-sql/pglite');
  return mod && mod.PGlite ? mod.PGlite : null;
}

function makeOwner(options = {}) {
  const ownerMod = loadOwner();
  const writes = [];
  const claims = [];
  const releases = [];
  const modelCalls = [];
  const contentCalls = [];
  const bookingWrites = [];
  const paymentWrites = [];
  const providerCalls = [];
  const journalCalls = [];
  const rows = Object.hasOwn(options, 'rows') ? options.rows : [authorityRow()];
  const nowMs = () => (typeof options.nowMs === 'number' ? options.nowMs : Date.now());
  const store = options.sharedStore || {
    draft: rows[0] && rows[0].staff_reply_draft != null ? String(rows[0].staff_reply_draft) : '',
    meta: rows[0] && rows[0].conversation_metadata ? { ...rows[0].conversation_metadata } : {},
    needsHuman: rows[0] ? rows[0].needs_human : undefined,
    pgActive: 0,
    lockHeld: false,
    txOpen: false,
    queryTexts: [],
  };
  if (!Object.hasOwn(store, 'needsHuman')) {
    store.needsHuman = rows[0] ? rows[0].needs_human : undefined;
  }

  const route = ownerMod.createStaffEmailLunaDraftOpen({
    runtimeEnv: options.env || gateOn(),
    now: nowMs,
    randomUUID: options.randomUUID || (() => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    claimTtlMs: options.claimTtlMs || ownerMod.EMAIL_DRAFT_OPEN_CLAIM_TTL_MS,
    callModel: async (...args) => {
      modelCalls.push(args);
      throw new Error('model must not run for this 003 case');
    },
    classifyIntent: options.classifyIntent,
    queryOwners: options.queryOwners,
    createLunaRuntime: options.createLunaRuntime,
    fetchCurrentMessageContent: options.fetchCurrentMessageContent || (async (input) => {
      contentCalls.push(input);
      if (options.contentEmpty) return Object.freeze({ latest_text: '' });
      return Object.freeze({ latest_text: options.contentText || BODY });
    }),
    withPgClient: options.withPgClient || (async (fn) => {
      store.pgActive += 1;
      const pg = {
        async query(sql, params) {
          const text = String(sql).replace(/\s+/g, ' ').trim();
          store.queryTexts.push(text);
          if (text === ownerMod.SQL_EMAIL_LUNA_OPEN_TX_BEGIN || /^BEGIN\b/i.test(text)) {
            store.txOpen = true;
            return { rows: [] };
          }
          if (text === ownerMod.SQL_EMAIL_LUNA_OPEN_TX_COMMIT || /^COMMIT\b/i.test(text)) {
            store.txOpen = false;
            store.lockHeld = false;
            return { rows: [] };
          }
          if (text === ownerMod.SQL_EMAIL_LUNA_OPEN_TX_ROLLBACK || /^ROLLBACK\b/i.test(text)) {
            store.txOpen = false;
            store.lockHeld = false;
            return { rows: [] };
          }
          if (text === ownerMod.SQL_LOAD_EMAIL_LUNA_OPEN_CONTEXT) {
            if (!rows.length) return { rows: [] };
            const live = { ...rows[0] };
            if (Object.hasOwn(store, 'needsHuman')) live.needs_human = store.needsHuman;
            live.staff_reply_draft = store.draft || null;
            live.conversation_metadata = { ...(live.conversation_metadata || {}), ...store.meta };
            return { rows: [live] };
          }
          if (text === ownerMod.SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION) {
            store.lockHeld = true;
            if (typeof options.onBeforeLock === 'function') await options.onBeforeLock(store);
            // Honor the shipped SQL predicate. A mock that ignores needs_human
            // would hide the authentic persistence hole this job closes.
            if (!/\bneeds_human\s+IS\s+TRUE\b/i.test(ownerMod.SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION)
              || store.needsHuman === true) {
              return {
                rows: [{
                  conversation_id: V,
                  inbound_event_id: M,
                  provider: 'microsoft_graph',
                  event_location_id: L,
                  location_key: 'sunset-somo',
                  provider_mailbox_id: MAILBOX,
                  endpoint_provider_mailbox_id: MAILBOX,
                }],
              };
            }
            return { rows: [] };
          }
          if (text === ownerMod.SQL_CLAIM_EMAIL_LUNA_OPEN_DRAFT) {
            if (typeof options.onBeforeClaim === 'function') await options.onBeforeClaim(store);
            if (/\bneeds_human\s+IS\s+TRUE\b/i.test(ownerMod.SQL_CLAIM_EMAIL_LUNA_OPEN_DRAFT)
              && store.needsHuman !== true) {
              return { rows: [] };
            }
            store.meta = {
              ...store.meta,
              ...(typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2] || {}),
            };
            claims.push({ params, needs_human: store.needsHuman });
            return { rows: [{ conversation_id: V }] };
          }
          if (text === ownerMod.SQL_CAS_EMAIL_LUNA_OPEN_DRAFT) {
            if (/\bneeds_human\s+IS\s+TRUE\b/i.test(ownerMod.SQL_CAS_EMAIL_LUNA_OPEN_DRAFT)
              && store.needsHuman !== true) {
              return { rows: [] };
            }
            const nextDraft = params[2];
            store.draft = nextDraft;
            store.meta = {
              ...store.meta,
              ...(typeof params[3] === 'string' ? JSON.parse(params[3]) : params[3] || {}),
            };
            writes.push({ draft: nextDraft, params, needs_human: store.needsHuman });
            return { rows: [{ staff_reply_draft: nextDraft }] };
          }
          if (text === ownerMod.SQL_RELEASE_EMAIL_LUNA_OPEN_CLAIM) {
            releases.push({ params });
            return { rows: [{ conversation_id: V }] };
          }
          if (text === ownerMod.SQL_LOAD_EXISTING_EMAIL_REPLY_APPROVAL) return { rows: [] };
          return { rows: [] };
        },
      };
      store.lastPg = pg;
      try {
        return await fn(pg);
      } finally {
        store.pgActive -= 1;
        if (!store.txOpen) store.lockHeld = false;
      }
    }),
    saveDraftThroughStaffOwner: async () => {
      throw new Error('open path must not create a sendable approval on Inbox open');
    },
    writeBooking: (...args) => bookingWrites.push(args),
    writePayment: (...args) => paymentWrites.push(args),
    dispatchApprovedOutbound: (...args) => providerCalls.push(args),
    callProvider: (...args) => providerCalls.push(args),
    appendOutboundJournal: (...args) => journalCalls.push(args),
  });
  return {
    owner: route, writes, claims, releases, modelCalls, contentCalls,
    bookingWrites, paymentWrites, providerCalls, journalCalls, store,
  };
}

async function open(h, input = {}, u = actor()) {
  return h.owner.ensureEmailLunaDraftOnOpen({
    actor: u,
    conversation_id: V,
    client_slug: 'sunset',
    gateEnv: input.gateEnv,
    ...input,
  });
}

function assertPending(result) {
  assert.equal(result.status, 'pending');
  assert.equal(result.draft_available, false);
  assert.equal(result.draft_text, '');
  assert.equal(result.reason, 'no_draft_stored');
  assert.equal(result.send_allowed, false);
  assert.equal(result.auto_send_allowed, false);
}

function assertDraft(result, text) {
  assert.equal(result.status, 'draft_ready');
  assert.equal(result.draft_available, true);
  assert.equal(result.draft_text, text);
  assert.equal(result.send_allowed, false);
  assert.equal(result.auto_send_allowed, false);
}

function assertNoGeneration(h, label) {
  assert.equal(h.contentCalls.length, 0, `${label}: Graph/content`);
  assert.equal(h.modelCalls.length, 0, `${label}: model`);
  assert.equal(h.claims.length, 0, `${label}: claim`);
  assert.equal(h.writes.length, 0, `${label}: persist`);
  assert.equal(h.releases.length, 0, `${label}: release`);
  assert.equal(h.bookingWrites.length, 0, `${label}: booking`);
  assert.equal(h.paymentWrites.length, 0, `${label}: payment`);
  assert.equal(h.providerCalls.length, 0, `${label}: provider`);
  assert.equal(h.journalCalls.length, 0, `${label}: journal`);
}

function assertSqlRequiresNeedsHuman(sql, { aliased = false } = {}) {
  const text = String(sql);
  const pred = aliased
    ? /\bc\.needs_human\s+IS\s+TRUE\b/
    : /\bneeds_human\s+IS\s+TRUE\b/;
  assert.match(text, pred, 'authoritative needs_human IS TRUE predicate missing');
  assert.doesNotMatch(text, /needs_attention/, 'needs_attention is not the producer authority');
}

function assertStaticBoundary() {
  const ownerMod = loadOwner();
  const ownerSrc = fs.readFileSync(OWNER_PATH, 'utf8');
  const generateSrc = fs.readFileSync(GENERATE_ROUTE_PATH, 'utf8');
  const policySrc = fs.readFileSync(POLICY_PATH, 'utf8');
  const threadSrc = fs.readFileSync(THREAD_PATH, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));

  assert.equal(
    pkg.scripts['verify:email-draft-open-003'],
    'node scripts/verify-email-draft-open-003.js',
  );

  assert.match(ownerMod.SQL_LOAD_EMAIL_LUNA_OPEN_CONTEXT, /c\.needs_human AS needs_human/);
  assertSqlRequiresNeedsHuman(ownerMod.SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION, { aliased: true });
  assertSqlRequiresNeedsHuman(ownerMod.SQL_CLAIM_EMAIL_LUNA_OPEN_DRAFT);
  assertSqlRequiresNeedsHuman(ownerMod.SQL_CAS_EMAIL_LUNA_OPEN_DRAFT);

  assert.match(ownerSrc, /if \(row\.needs_human !== true\) return pending\(conversationId\)/);

  assert.match(generateSrc, /EMAIL_LUNA_GENERATION_UNAVAILABLE_ERROR/);
  assert.match(generateSrc, /authoritative_content_and_grounded_policy_not_configured/);
  assert.match(generateSrc, /return deps\.sendJSON\(res, 503/);
  assert.doesNotMatch(ownerSrc, /EMAIL_LUNA_GENERATE_DRAFT_PATH|handleGenerateLunaDraft/);

  assert.equal(SAFE_ACKNOWLEDGMENT.en, EXPECTED_SAFE_ACKNOWLEDGMENT.en);
  assert.equal(SAFE_ACKNOWLEDGMENT.es, EXPECTED_SAFE_ACKNOWLEDGMENT.es);
  assert.equal(
    crypto.createHash('sha256').update(SAFE_ACKNOWLEDGMENT.en, 'utf8').digest('hex'),
    crypto.createHash('sha256').update(EXPECTED_SAFE_ACKNOWLEDGMENT.en, 'utf8').digest('hex'),
  );
  assert.equal(
    crypto.createHash('sha256').update(SAFE_ACKNOWLEDGMENT.es, 'utf8').digest('hex'),
    crypto.createHash('sha256').update(EXPECTED_SAFE_ACKNOWLEDGMENT.es, 'utf8').digest('hex'),
  );
  assert.match(policySrc, /SAFE_ACKNOWLEDGMENT/);

  assert.match(threadSrc, /id="btn-email-generate-luna-draft" hidden/);
  assert.doesNotMatch(threadSrc, /onload[^\n]{0,160}generate-luna-draft|openConversation[^\n]{0,160}generate-luna-draft/i);

  assert.doesNotMatch(ownerSrc, /handleApproveSend|dispatchApprovedOutbound|createReply|sendDraft/);
  assert.doesNotMatch(ownerSrc, /createHold|createBooking|createPaymentLink|stripe/i);
  assert.doesNotMatch(ownerSrc, /auto_send_allowed:\s*true|send_allowed:\s*true/);

  for (const rel of FORBIDDEN_TOUCH) {
    assert.equal(ownerSrc.includes(path.basename(rel)) && rel.includes('inbox-thread'), false);
  }
  assert.doesNotMatch(ownerSrc, /scripts\/browser\//);

  console.log('ok - static producer guard, generate POST unused, safe-ack bytes unchanged');
}

async function testFalseDoesNotGenerate() {
  const h = makeOwner({ rows: [authorityRow({ needs_human: false })] });
  const out = await open(h);
  assertPending(out);
  assertNoGeneration(h, 'needs_human=false');
  console.log('ok - needs_human=false returns honest pending with no side effects');
}

async function testMalformedFailClosed() {
  for (const [label, value] of [
    ['null', null],
    ['undefined', undefined],
    ['string true', 'true'],
    ['string t', 't'],
    ['number 1', 1],
    ['object', {}],
    ['array', []],
  ]) {
    const h = makeOwner({ rows: [authorityRow({ needs_human: value })] });
    const out = await open(h);
    assertPending(out);
    assertNoGeneration(h, label);
  }
  console.log('ok - missing/null/malformed needs_human fail closed');
}

async function testTenantAuthorityFailClosed() {
  const h = makeOwner({
    rows: [authorityRow({ client_id: C2 })],
  });
  const out = await open(h);
  assert.ok(out.status === 'pending' || out.status === 'not_found');
  assertNoGeneration(h, 'cross-tenant');
  console.log('ok - tenant authority fail-closed does not generate');
}

async function testExistingDraftWhenFalseIsReturnedWithoutGeneration() {
  const existing = 'Staff already drafted this.';
  const h = makeOwner({
    rows: [authorityRow({
      needs_human: false,
      staff_reply_draft: existing,
      conversation_metadata: {},
    })],
  });
  const out = await open(h);
  assertDraft(out, existing);
  assertNoGeneration(h, 'existing draft + needs_human=false');
  console.log('ok - existing draft is returned without generation when needs_human=false');
}

async function testTrueStillGeneratesSafeAck() {
  const h = makeOwner({ rows: [authorityRow({ needs_human: true })] });
  const out = await open(h);
  assertDraft(out, SAFE_ACKNOWLEDGMENT.en);
  assert.equal(h.contentCalls.length, 1);
  assert.equal(h.claims.length, 1);
  assert.equal(h.writes.length, 1);
  assert.equal(h.modelCalls.length, 0);
  assert.equal(h.providerCalls.length, 0);
  assert.equal(h.bookingWrites.length, 0);
  assert.equal(out.send_allowed, false);
  assert.equal(out.auto_send_allowed, false);
  assert.equal(
    h.store.meta.luna_email_open_draft.generated_body_sha256,
    bodyDigest(SAFE_ACKNOWLEDGMENT.en),
  );
  console.log('ok - needs_human=true preserves draft-or-honest-pending generation');
}

async function testTrueExistingDraftShortCircuits() {
  const existing = 'Already persisted Luna draft.';
  const h = makeOwner({
    rows: [authorityRow({
      needs_human: true,
      staff_reply_draft: existing,
      conversation_metadata: {
        luna_email_open_draft: {
          origin: 'luna',
          state: 'ready',
          source_inbound_event_id: M,
          generated_body_sha256: bodyDigest(existing),
        },
      },
    })],
  });
  const out = await open(h);
  assertDraft(out, existing);
  assertNoGeneration(h, 'true + existing luna draft');
  console.log('ok - needs_human=true returns persisted draft without regenerating');
}

async function testToctouFalseAfterLoadDoesNotGenerate() {
  const h = makeOwner({
    rows: [authorityRow({ needs_human: true })],
    onBeforeLock: (store) => {
      store.needsHuman = false;
    },
  });
  const out = await open(h);
  assertPending(out);
  assert.equal(h.contentCalls.length, 0, 'TOCTOU must not fetch Graph');
  assert.equal(h.claims.length, 0, 'TOCTOU must not claim');
  assert.equal(h.writes.length, 0, 'TOCTOU must not persist');
  assert.equal(h.modelCalls.length, 0, 'TOCTOU must not call the model');
  console.log('ok - load-true then lock-false fails closed without generation');
}

async function proveClaimSqlOnPglite() {
  const PGlite = tryLoadPglite();
  assert.ok(PGlite, 'PGlite required for needs_human claim SQL proof');
  const ownerMod = loadOwner();
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE conversations (
      client_id uuid NOT NULL,
      id uuid NOT NULL,
      staff_reply_draft text,
      metadata jsonb,
      needs_human BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (client_id, id)
    );
    CREATE TABLE tenant_email_inbound_inbox_projections (
      client_id uuid NOT NULL,
      conversation_id uuid NOT NULL,
      inbound_event_id uuid NOT NULL
    );
    CREATE TABLE tenant_email_inbound_events (
      client_id uuid NOT NULL,
      id uuid NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (client_id, id)
    );
    CREATE TABLE tenant_email_reply_approvals (
      client_id uuid NOT NULL,
      conversation_id uuid NOT NULL,
      source_inbound_event_id uuid NOT NULL,
      state text NOT NULL
    );
  `);
  await db.query(
    'INSERT INTO tenant_email_inbound_events (client_id, id, received_at) VALUES ($1,$2, now())',
    [C, M],
  );
  await db.query(
    'INSERT INTO tenant_email_inbound_inbox_projections (client_id, conversation_id, inbound_event_id) VALUES ($1,$2,$3)',
    [C, V, M],
  );

  const ttl = ownerMod.EMAIL_DRAFT_OPEN_CLAIM_TTL_MS;
  const claimMeta = JSON.stringify({
    luna_email_open_draft: {
      state: 'in_progress', origin: 'luna', source_inbound_event_id: M,
      claimed_at: new Date().toISOString(), claimed_at_ms: String(Date.now()),
      claim_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    },
  });
  const persistMeta = JSON.stringify({
    luna_email_open_draft: {
      state: 'ready', origin: 'luna', source_inbound_event_id: M,
      claim_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      kind: 'safe_acknowledgment',
      generated_body_sha256: bodyDigest(SAFE_ACKNOWLEDGMENT.en),
    },
  });

  async function seedConversation(needsHuman) {
    await db.query('DELETE FROM conversations');
    await db.query(
      'INSERT INTO conversations (client_id, id, staff_reply_draft, metadata, needs_human) VALUES ($1,$2,$3,$4,$5)',
      [C, V, null, {}, needsHuman],
    );
  }

  async function tryClaim() {
    return db.query(ownerMod.SQL_CLAIM_EMAIL_LUNA_OPEN_DRAFT, [C, V, claimMeta, M, ttl, '', null]);
  }

  await seedConversation(false);
  const falseClaim = await tryClaim();
  assert.equal(falseClaim.rows.length, 0, 'PGlite claim must not write when needs_human=false');
  const falseStored = await db.query('SELECT staff_reply_draft, metadata FROM conversations WHERE id=$1', [V]);
  assert.equal(falseStored.rows[0].staff_reply_draft, null);
  assert.equal(
    falseStored.rows[0].metadata && falseStored.rows[0].metadata.luna_email_open_draft,
    undefined,
    'PGlite claim must not persist in_progress metadata when needs_human=false',
  );

  await seedConversation(null).catch(async () => {
    // NOT NULL column — insert NULL must fail closed at the schema.
    await seedConversation(false);
  });
  let nullInsertFailed = false;
  try {
    await db.query(
      'INSERT INTO conversations (client_id, id, staff_reply_draft, metadata, needs_human) VALUES ($1,$2,$3,$4,$5)',
      [C, '55555555-5555-4555-8555-555555555559', null, {}, null],
    );
  } catch {
    nullInsertFailed = true;
  }
  assert.equal(nullInsertFailed, true, 'needs_human NULL is not a writable conversation state');

  await seedConversation(true);
  const trueClaim = await tryClaim();
  assert.equal(trueClaim.rows.length, 1, 'PGlite claim still writes when needs_human=true');

  await db.query(
    'UPDATE conversations SET needs_human = FALSE WHERE client_id=$1 AND id=$2',
    [C, V],
  );
  const casAfterClear = await db.query(ownerMod.SQL_CAS_EMAIL_LUNA_OPEN_DRAFT, [
    C, V, SAFE_ACKNOWLEDGMENT.en, persistMeta,
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', M, null,
  ]);
  assert.equal(casAfterClear.rows.length, 0, 'PGlite CAS must not persist after needs_human cleared');
  const afterCas = await db.query('SELECT staff_reply_draft FROM conversations WHERE id=$1', [V]);
  assert.equal(afterCas.rows[0].staff_reply_draft, null, 'cleared needs_human must not persist a draft');

  await db.close();
  console.log('ok - PGlite claim/CAS require needs_human IS TRUE');
}

async function proveLockSqlOnPglite() {
  const PGlite = tryLoadPglite();
  assert.ok(PGlite, 'PGlite required for needs_human lock SQL proof');
  const ownerMod = loadOwner();
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE clients (id uuid PRIMARY KEY, slug text NOT NULL);
    CREATE TABLE staff_users (
      id uuid NOT NULL, client_id uuid NOT NULL, status text NOT NULL, role text NOT NULL
    );
    CREATE TABLE conversations (
      client_id uuid NOT NULL, id uuid NOT NULL, staff_reply_draft text, metadata jsonb,
      phone text NOT NULL, needs_human BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (client_id, id)
    );
    CREATE TABLE tenant_locations (
      client_id uuid NOT NULL, id uuid NOT NULL, location_id text NOT NULL
    );
    CREATE TABLE tenant_channel_endpoints (
      client_id uuid NOT NULL, id uuid NOT NULL, location_id text NOT NULL,
      channel text NOT NULL, provider text NOT NULL, provider_resource_id text
    );
    CREATE TABLE tenant_email_inbound_events (
      client_id uuid NOT NULL, id uuid NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
      location_id uuid NOT NULL, endpoint_id uuid NOT NULL, provider text NOT NULL,
      provider_mailbox_id text NOT NULL, provider_message_id text NOT NULL,
      PRIMARY KEY (client_id, id)
    );
    CREATE TABLE tenant_email_inbound_inbox_projections (
      client_id uuid NOT NULL, conversation_id uuid NOT NULL, inbound_event_id uuid NOT NULL,
      location_id uuid NOT NULL, endpoint_id uuid NOT NULL, provider text NOT NULL,
      provider_mailbox_id text NOT NULL, provider_message_id text NOT NULL
    );
  `);
  await db.query('INSERT INTO clients (id, slug) VALUES ($1, $2)', [C, 'sunset']);
  await db.query(
    'INSERT INTO staff_users (id, client_id, status, role) VALUES ($1,$2,$3,$4)',
    [A, C, 'active', 'operator'],
  );
  await db.query(
    'INSERT INTO tenant_locations (client_id, id, location_id) VALUES ($1,$2,$3)',
    [C, L, 'sunset-somo'],
  );
  await db.query(
    'INSERT INTO tenant_channel_endpoints (client_id, id, location_id, channel, provider, provider_resource_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [C, E, 'sunset-somo', 'email', 'microsoft_graph', MAILBOX],
  );
  await db.query(
    `INSERT INTO tenant_email_inbound_events
      (client_id, id, received_at, location_id, endpoint_id, provider, provider_mailbox_id, provider_message_id)
     VALUES ($1,$2, now(), $3,$4,$5,$6,$7)`,
    [C, M, L, E, 'microsoft_graph', MAILBOX, GRAPH_ID],
  );
  await db.query(
    `INSERT INTO tenant_email_inbound_inbox_projections
      (client_id, conversation_id, inbound_event_id, location_id, endpoint_id, provider,
       provider_mailbox_id, provider_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [C, V, M, L, E, 'microsoft_graph', MAILBOX, GRAPH_ID],
  );

  async function seed(needsHuman) {
    await db.query('DELETE FROM conversations');
    await db.query(
      'INSERT INTO conversations (client_id, id, staff_reply_draft, metadata, phone, needs_human) VALUES ($1,$2,$3,$4,$5,$6)',
      [C, V, null, {}, 'emailv1:ana@example.test', needsHuman],
    );
  }

  await seed(false);
  const falseLock = await db.query(ownerMod.SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION, [C, A, V]);
  assert.equal(falseLock.rows.length, 0, 'PGlite lock must miss when needs_human=false');

  await seed(true);
  const trueLock = await db.query(ownerMod.SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION, [C, A, V]);
  assert.equal(trueLock.rows.length, 1, 'PGlite lock still hits when needs_human=true');
  assert.equal(String(trueLock.rows[0].conversation_id).toLowerCase(), V);

  await db.query('UPDATE conversations SET needs_human = FALSE WHERE id=$1', [V]);
  const flipped = await db.query(ownerMod.SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION, [C, A, V]);
  assert.equal(flipped.rows.length, 0, 'PGlite lock misses after needs_human is cleared');

  await db.close();
  console.log('ok - PGlite lock requires needs_human IS TRUE');
}

function assertQa007ProducerContract() {
  const ownerSrc = fs.readFileSync(OWNER_PATH, 'utf8');
  const ownerMod = loadOwner();
  assert.match(ownerSrc, /c\.needs_human AS needs_human/, 'QA-007: producer reads authoritative needs_human');
  assert.match(
    ownerMod.SQL_CLAIM_EMAIL_LUNA_OPEN_DRAFT,
    /needs_human\s+IS\s+TRUE/,
    'QA-007: generate-on-open/draft producer is unavailable when needs_human is false',
  );
  assert.match(
    ownerMod.SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION,
    /c\.needs_human\s+IS\s+TRUE/,
    'QA-007: generate-on-open/draft producer may be available when needs_human is true',
  );
  assert.doesNotMatch(ownerSrc, /scripts\/browser\/inbox-thread/);
  console.log('ok - QA-007 authentic producer contract (not UI copy)');
}

async function main() {
  console.log('verify:email-draft-open-003 — QA-007 producer needs_human fail-closed\n');
  const before = Object.fromEntries(
    FORBIDDEN_TOUCH.map((rel) => [rel, sha256(path.join(ROOT, rel))]),
  );
  assertStaticBoundary();
  assertQa007ProducerContract();
  await testFalseDoesNotGenerate();
  await testMalformedFailClosed();
  await testTenantAuthorityFailClosed();
  await testExistingDraftWhenFalseIsReturnedWithoutGeneration();
  await testTrueStillGeneratesSafeAck();
  await testTrueExistingDraftShortCircuits();
  await testToctouFalseAfterLoadDoesNotGenerate();
  await proveClaimSqlOnPglite();
  await proveLockSqlOnPglite();
  for (const rel of FORBIDDEN_TOUCH) {
    assert.equal(sha256(path.join(ROOT, rel)), before[rel], `forbidden touch: ${rel}`);
  }
  console.log('\nPASS EMAIL-DRAFT-OPEN-003 producer requires needs_human=true');
}

main().catch((err) => {
  console.error('FAIL EMAIL-DRAFT-OPEN-003');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
