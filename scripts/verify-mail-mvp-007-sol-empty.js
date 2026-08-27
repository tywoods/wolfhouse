#!/usr/bin/env node
'use strict';

/**
 * MAIL-MVP-007-SOL-EMPTY — empty/whitespace Create Draft notes must call
 * Email Luna Hermes Sol against the authoritative thread.
 *
 * Executes the real policy composition, producer, and Staff Create Draft
 * route. Mocks only the external Hermes HTTP transport.
 */

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const ROOT = path.join(__dirname, '..');
const {
  HERMES_SOL_PROVIDER,
  HERMES_SOL_MODEL,
  HERMES_SOL_RUNTIME,
  HERMES_SOL_REQUEST_SCHEMA,
  HERMES_SOL_RESULT_SCHEMA,
  HERMES_SOL_DRAFT_PATH,
  PRIVATE_STAFF_TRUST,
  parseDraftPlanRequest,
  signResultAuthenticity,
} = require('./lib/email-luna-sunset-email-hermes-sol-contract');
const {
  ENV_AUTHOR_ENABLED,
  ENV_BASE_URL,
  ENV_TOKEN,
  ENV_HMAC_SECRET,
  snapshotSunsetEmailHermesSolEnv,
} = require('./lib/email-luna-sunset-email-hermes-sol-activation');
const {
  createEmailLunaSunsetStagingRuntimeComposition,
} = require('./lib/email-luna-sunset-staging-runtime-composition');
const {
  createEmailLunaDraftOpenPolicyComposition,
  SAFE_ACKNOWLEDGMENT,
} = require('./lib/email-luna-draft-open-policy-composition');
const {
  renderCreateDraftNaturalPlan,
  compileCreateDraftNaturalPlanJson,
  parseCreateDraftNaturalPlan,
} = require('./lib/email-luna-create-draft-natural-author');
const {
  createStaffEmailLunaDraftRoute,
  EMAIL_LUNA_CREATE_DRAFT_PATH,
  snapshotEmailLunaGenerateGateEnv,
} = require('./lib/staff-email-luna-draft-route');

const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const V = '33333333-3333-4333-8333-333333333333';
const E = '44444444-4444-4444-8444-444444444444';
const A = '55555555-5555-4555-8555-555555555555';
const M = '66666666-6666-4666-8666-666666666666';
const MAILBOX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GRAPH_ID = 'opaque/id+with=padding';
const TOKEN = 'test-hermes-sol-token';
const HMAC_SECRET = 'test-hermes-sol-hmac';
const LIVE_NOTES = 'Thank them for the msg and then ask them if they want to do a booking';
const LIVE_SUBJECT = 'Re: Testing 8 26';
const LIVE_BODY = 'Hi, just testing the front desk mailbox.';
const ES_SUBJECT = 'Re: Prueba 8 26';
const ES_BODY = 'Hola, gracias, necesito un mensaje por favor.';
const WRAPPER = /we also wanted to add|tambi[eé]n quer[ií]amos a[nñ]adir/i;
const GENERIC_REVIEW = /we['’]ll review it and get back to you shortly|lo revisaremos y te responderemos en breve/i;
const LIVE_EN_BODY = renderCreateDraftNaturalPlan({
  acts: [{ act: 'thank_guest' }, { act: 'ask_booking_interest' }],
}, 'en');
const LIVE_ES_BODY = renderCreateDraftNaturalPlan({
  acts: [{ act: 'thank_guest' }, { act: 'ask_booking_interest' }],
}, 'es');
const FORBIDDEN_EMPTY_WRAPPER_EN = renderCreateDraftNaturalPlan({
  acts: [{ act: 'thank_guest' }, { act: 'offer_human_followup' }],
}, 'en');
const FORBIDDEN_EMPTY_WRAPPER_ES = renderCreateDraftNaturalPlan({
  acts: [{ act: 'thank_guest' }, { act: 'offer_human_followup' }],
}, 'es');
function expectedEmptyCompileBody(contentObj, language) {
  return renderCreateDraftNaturalPlan(
    parseCreateDraftNaturalPlan(compileCreateDraftNaturalPlanJson('', contentObj)),
    language || 'en',
  );
}
const EMPTY_FALLBACK_EN = expectedEmptyCompileBody(content(), 'en');
const EMPTY_FALLBACK_ES = expectedEmptyCompileBody(content({ subject: ES_SUBJECT, body_text: ES_BODY }), 'es');

function authority() {
  return {
    client_id: C,
    location_id: L,
    location_key: 'sunset-somo',
    conversation_id: V,
    endpoint_id: E,
    inbound_message_id: M,
  };
}

function content(patch = {}) {
  return {
    subject: LIVE_SUBJECT,
    body_text: LIVE_BODY,
    quoted_history: '',
    from_display_name: 'Tyler Woods',
    from_address: 'tyler@example.test',
    ...patch,
  };
}

function actor() {
  return Object.freeze(Object.assign(Object.create(null), {
    staff_user_id: A, client_id: C, role: 'operator',
  }));
}

function hermesEnv(port, patch = {}) {
  return {
    LUNA_DEPLOYMENT: 'sunset-staging',
    EMAIL_STAFF_LUNA_DRAFT_ENABLED: 'true',
    EMAIL_LUNA_DRAFT_RUNTIME_ENABLED: 'true',
    STAFF_PORTAL_ORIGIN: 'https://staff.sunset.test',
    [ENV_AUTHOR_ENABLED]: 'true',
    [ENV_BASE_URL]: `http://127.0.0.1:${port}`,
    [ENV_TOKEN]: TOKEN,
    [ENV_HMAC_SECRET]: HMAC_SECRET,
    ...patch,
  };
}

function provenanceFrom(req) {
  return {
    provider: HERMES_SOL_PROVIDER,
    model: HERMES_SOL_MODEL,
    runtime: HERMES_SOL_RUNTIME,
    tenant_id: 'sunset',
    location_key: 'sunset-somo',
    client_id: req.client_id,
    location_id: req.location_id,
    conversation_id: req.conversation_id,
    inbound_message_id: req.inbound_message_id,
  };
}

function readReq(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function startFakeHermes(onRequest) {
  return new Promise((resolve) => {
    const seen = new Set();
    const hits = [];
    const parsedHits = [];
    const server = http.createServer(async (req, res) => {
      try {
        const raw = await readReq(req);
        const parsed = parseDraftPlanRequest(raw);
        hits.push({
          method: req.method,
          url: req.url,
          auth: req.headers.authorization === `Bearer ${TOKEN}` ? 'bearer' : 'other',
          bytes: Buffer.byteLength(raw, 'utf8'),
        });
        if (parsed.ok) parsedHits.push(parsed.value);
        if (typeof onRequest === 'function') {
          await onRequest({ req, res, raw, seen, hits, parsed });
          return;
        }
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          res.writeHead(401); res.end(JSON.stringify({ error: 'unauthorized' })); return;
        }
        if (req.url !== HERMES_SOL_DRAFT_PATH) {
          res.writeHead(404); res.end(JSON.stringify({ error: 'not_found' })); return;
        }
        if (!parsed.ok) {
          const status = parsed.reason === 'wrong_tenant' || parsed.reason === 'wrong_location' ? 403 : 400;
          res.writeHead(status); res.end(JSON.stringify({ error: parsed.reason })); return;
        }
        if (seen.has(parsed.value.request_id)) {
          res.writeHead(409); res.end(JSON.stringify({ error: 'replay' })); return;
        }
        seen.add(parsed.value.request_id);
        const provenance = provenanceFrom(parsed.value);
        const plan = { acts: [{ act: 'thank_guest' }, { act: 'ask_booking_interest' }] };
        const authenticity = signResultAuthenticity(HMAC_SECRET, parsed.value, provenance, plan);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          schema: HERMES_SOL_RESULT_SCHEMA,
          acts: plan.acts,
          provenance,
          authenticity,
        }));
      } catch {
        res.writeHead(500); res.end(JSON.stringify({ error: 'server' }));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, hits, parsedHits, seen });
    });
  });
}

function stopFake(fake) {
  return new Promise((resolve) => {
    if (typeof fake.server.closeAllConnections === 'function') {
      fake.server.closeAllConnections();
    }
    fake.server.close(() => resolve());
    setTimeout(resolve, 200);
  });
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
    subject: LIVE_SUBJECT,
    body_text: '',
    quoted_history: '',
    from_display_name: 'Tyler Woods',
    from_address: 'tyler@example.test',
    conversation_deleted_at: null,
    conversation_status: 'open',
    needs_human: false,
    latest_message_id: M,
    staff_reply_draft: 'Previous standing draft.',
    conversation_metadata: {
      luna_email_open_draft: {
        state: 'ready',
        origin: 'luna',
        source_inbound_event_id: M,
        generated_body_sha256: crypto.createHash('sha256').update('Previous standing draft.', 'utf8').digest('hex'),
      },
    },
    luna_draft_enabled: true,
    ...patch,
  };
}

function loadOwner() {
  delete require.cache[require.resolve('./lib/staff-email-luna-draft-open')];
  return require('./lib/staff-email-luna-draft-open');
}

function makeOwner(options = {}) {
  const ownerMod = loadOwner();
  const writes = [];
  const approvals = [];
  const journals = [];
  const providers = [];
  const bookings = [];
  const rows = Object.hasOwn(options, 'rows') ? options.rows : [authorityRow()];
  const store = options.sharedStore || {
    draft: rows[0] && rows[0].staff_reply_draft != null ? String(rows[0].staff_reply_draft) : '',
    meta: rows[0] && rows[0].conversation_metadata ? { ...rows[0].conversation_metadata } : {},
    queryTexts: [],
  };
  const owner = ownerMod.createStaffEmailLunaDraftOpen({
    runtimeEnv: options.env,
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
    claimTtlMs: ownerMod.EMAIL_DRAFT_OPEN_CLAIM_TTL_MS,
    timeoutMs: options.timeoutMs,
    classifyIntent: options.classifyIntent,
    queryOwners: options.queryOwners,
    createLunaRuntime: (config) => createEmailLunaSunsetStagingRuntimeComposition(config),
    fetchCurrentMessageContent: async () => Object.freeze({
      latest_text: options.contentText || LIVE_BODY,
    }),
    withPgClient: async (fn) => {
      const pg = {
        async query(sql, params) {
          const text = String(sql).replace(/\s+/g, ' ').trim();
          store.queryTexts.push(text);
          if (/^BEGIN\b/i.test(text) || /^COMMIT\b/i.test(text) || /^ROLLBACK\b/i.test(text)) {
            return { rows: [] };
          }
          if (text === ownerMod.SQL_LOAD_EMAIL_LUNA_OPEN_CONTEXT) {
            const live = { ...rows[0] };
            live.staff_reply_draft = store.draft || null;
            live.conversation_metadata = { ...(live.conversation_metadata || {}), ...store.meta };
            return { rows: [live] };
          }
          if (text === ownerMod.SQL_LOCK_EMAIL_LUNA_OPEN_CONVERSATION
              || text === ownerMod.SQL_LOCK_EMAIL_LUNA_CREATE_DRAFT) {
            return { rows: [{ conversation_id: V, inbound_event_id: M, provider: 'microsoft_graph', event_location_id: L, location_key: 'sunset-somo', provider_mailbox_id: MAILBOX, endpoint_provider_mailbox_id: MAILBOX }] };
          }
          if (text === ownerMod.SQL_CLAIM_EMAIL_LUNA_OPEN_DRAFT
              || text === ownerMod.SQL_CLAIM_EMAIL_LUNA_CREATE_DRAFT) {
            store.meta = { ...store.meta, ...(typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2] || {}) };
            return { rows: [{ conversation_id: V }] };
          }
          if (text === ownerMod.SQL_CAS_EMAIL_LUNA_OPEN_DRAFT
              || text === ownerMod.SQL_CAS_EMAIL_LUNA_CREATE_DRAFT) {
            const nextDraft = params[2];
            store.draft = nextDraft;
            store.meta = { ...store.meta, ...(typeof params[3] === 'string' ? JSON.parse(params[3]) : params[3] || {}) };
            writes.push({ draft: nextDraft, params });
            return { rows: [{ staff_reply_draft: nextDraft }] };
          }
          if (text === ownerMod.SQL_RELEASE_EMAIL_LUNA_OPEN_CLAIM) {
            return { rows: [{ conversation_id: V }] };
          }
          if (text === ownerMod.SQL_LOAD_EXISTING_EMAIL_REPLY_APPROVAL) {
            return { rows: [] };
          }
          return { rows: [] };
        },
      };
      return fn(pg);
    },
    saveDraftThroughStaffOwner: async () => { throw new Error('create-draft must not create an approval'); },
    approveDraft: (...args) => approvals.push(args),
    appendOutboundJournal: (...args) => journals.push(args),
    callProvider: (...args) => providers.push(args),
    createBooking: (...args) => bookings.push(args),
  });
  return { owner, writes, approvals, journals, providers, bookings, store };
}

function request(body) {
  const req = new EventEmitter();
  req.headers = { 'content-type': 'application/json', origin: 'https://staff.sunset.test' };
  process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  return req;
}

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function assertNotCanned(body, label) {
  assert.equal(typeof body, 'string', label);
  assert.ok(body.trim(), label);
  assert.notEqual(body, SAFE_ACKNOWLEDGMENT.en, `${label}: must not be canned EN ack`);
  assert.notEqual(body, SAFE_ACKNOWLEDGMENT.es, `${label}: must not be canned ES ack`);
  assert.notEqual(body, FORBIDDEN_EMPTY_WRAPPER_EN, `${label}: must not be leftover teammate wrapper EN`);
  assert.notEqual(body, FORBIDDEN_EMPTY_WRAPPER_ES, `${label}: must not be leftover teammate wrapper ES`);
  assert.doesNotMatch(body, GENERIC_REVIEW, `${label}: must not use review stub`);
  assert.doesNotMatch(body, WRAPPER, `${label}: must not restore We also wanted to add`);
}

function assertNoSideEffects(owner, label) {
  assert.equal(owner.approvals.length, 0, `${label}: no approve`);
  assert.equal(owner.journals.length, 0, `${label}: no journal`);
  assert.equal(owner.providers.length, 0, `${label}: no provider`);
  assert.equal(owner.bookings.length, 0, `${label}: no booking`);
}

function assertFailClosed(result, label) {
  assert.notEqual(result.status, 'draft_ready', label);
  assert.equal(result.status, 'handoff_required', label);
  assert.equal(!result.body || !String(result.body).trim(), true, label);
}

function assertEmptyNotesHermesRequest(parsed, expectedContent) {
  assert.ok(parsed, 'Hermes must receive a closed plan request');
  assert.equal(parsed.schema, HERMES_SOL_REQUEST_SCHEMA);
  assert.equal(parsed.private_staff_goals.trust, PRIVATE_STAFF_TRUST);
  assert.equal(parsed.private_staff_goals.goals, '');
  assert.equal(parsed.untrusted_email.body_text, expectedContent.body_text);
  assert.equal(parsed.untrusted_email.subject, expectedContent.subject);
  assert.equal(parsed.untrusted_email.from_address, expectedContent.from_address);
  assert.equal(parsed.client_id, C);
  assert.equal(parsed.location_id, L);
  assert.equal(parsed.conversation_id, V);
  assert.equal(parsed.tenant_id, 'sunset');
  assert.equal(parsed.location_key, 'sunset-somo');
}

(async () => {
  console.log('verify:mail-mvp-007-sol-empty');

  const policySrc = readFile('scripts/lib/email-luna-draft-open-policy-composition.js');
  const naturalSrc = readFile('scripts/lib/email-luna-create-draft-natural-author.js');
  const authorSrc = readFile('scripts/lib/email-luna-sunset-email-hermes-sol-author.js');
  const openSrc = readFile('scripts/lib/staff-email-luna-draft-open.js');
  const routeSrc = readFile('scripts/lib/staff-email-luna-draft-route.js');
  const autoSrc = readFile('scripts/lib/email-luna-microsoft-auto-create-send.js');
  const contextSrc = readFile('scripts/lib/email-luna-create-draft-context.js');

  assert.match(policySrc, /typeof input\.operator_context === 'string'/);
  assert.doesNotMatch(
    policySrc,
    /if \(guidance\) return composeStaffGuided/,
    'mutation-negative: empty-notes bypass must not be restored',
  );
  assert.match(naturalSrc, /When private staff goals are empty/);
  assert.doesNotMatch(naturalSrc, /if \(!authority \|\| !content \|\| !goals\)/);
  assert.doesNotMatch(openSrc, /LUNA_AUTO_SEND_ENABLED\s*=/);
  assert.doesNotMatch(routeSrc, /LUNA_AUTO_SEND_ENABLED\s*=/);
  assert.doesNotMatch(authorSrc, /LUNA_AUTO_SEND_ENABLED\s*=/);
  assert.match(autoSrc, /LUNA_AUTO_SEND_ENABLED/);
  assert.doesNotMatch(autoSrc, /LUNA_AUTO_SEND_ENABLED\s*=\s*'true'/);
  assert.doesNotMatch(contextSrc, /We also wanted to add/);
  assert.match(routeSrc, /conversation_id: input\.conversation_id/);
  assert.doesNotMatch(routeSrc, /untrusted_content:\s*input\.(thread|body|email)/);
  console.log('  PASS  mutation-negative source: Create Draft empty notes cannot skip Hermes');

  const fake = await startFakeHermes();
  const env = hermesEnv(fake.port);
  const policy = createEmailLunaDraftOpenPolicyComposition({
    createLunaRuntime: (config) => createEmailLunaSunsetStagingRuntimeComposition(config),
  });

  const notes = await policy.compose({
    authority: authority(),
    untrusted_content: content(),
    operator_context: LIVE_NOTES,
    env,
    hermes: snapshotSunsetEmailHermesSolEnv(env),
  });
  assert.equal(notes.status, 'draft_ready');
  assert.equal(notes.body, LIVE_EN_BODY);
  assert.equal(notes.kind, 'authored');
  assert.equal(notes.send_allowed, false);
  assert.equal(notes.auto_send_allowed, false);
  assert.equal(notes.draft_only, true);
  assert.equal(notes.requires_staff_review, true);
  assert.doesNotMatch(notes.body, WRAPPER);
  assert.equal(notes.body.includes(LIVE_NOTES), false);
  assert.equal(fake.hits.length, 1);
  assert.equal(fake.parsedHits[0].private_staff_goals.goals, LIVE_NOTES);
  console.log('  PASS  notes path still calls Hermes Sol and does not paste notes');

  const blankHitsBefore = fake.hits.length;
  const blank = await policy.compose({
    authority: authority(),
    untrusted_content: content(),
    operator_context: '',
    env,
    hermes: snapshotSunsetEmailHermesSolEnv(env),
  });
  assert.equal(blank.status, 'draft_ready');
  assertNotCanned(blank.body, 'empty notes');
  assert.equal(blank.body, LIVE_EN_BODY);
  assert.equal(blank.kind, 'authored');
  assert.equal(blank.language, 'en');
  assert.equal(blank.send_allowed, false);
  assert.equal(blank.auto_send_allowed, false);
  assert.equal(blank.draft_only, true);
  assert.equal(blank.requires_staff_review, true);
  assert.equal(blank.marker.provider, HERMES_SOL_PROVIDER);
  assert.equal(blank.marker.model, HERMES_SOL_MODEL);
  assert.equal(blank.marker.runtime, HERMES_SOL_RUNTIME);
  assert.equal(blank.authenticity.hmac_verified, true);
  assert.equal(fake.hits.length, blankHitsBefore + 1, 'blank notes must invoke Hermes once');
  assert.equal(fake.hits.at(-1).url, HERMES_SOL_DRAFT_PATH);
  assert.equal(fake.hits.at(-1).auth, 'bearer');
  assertEmptyNotesHermesRequest(fake.parsedHits.at(-1), content());
  console.log('  PASS  empty notes invoke Hermes once with authoritative thread + gpt-5.6-sol');

  const wsHitsBefore = fake.hits.length;
  const whitespace = await policy.compose({
    authority: authority(),
    untrusted_content: content(),
    operator_context: '   \n\t  ',
    env,
    hermes: snapshotSunsetEmailHermesSolEnv(env),
  });
  assert.equal(whitespace.status, 'draft_ready');
  assertNotCanned(whitespace.body, 'whitespace notes');
  assert.equal(whitespace.body, LIVE_EN_BODY);
  assert.equal(fake.hits.length, wsHitsBefore + 1, 'whitespace notes must invoke Hermes once');
  assertEmptyNotesHermesRequest(fake.parsedHits.at(-1), content());
  console.log('  PASS  whitespace-only notes invoke Hermes once');

  const esHitsBefore = fake.hits.length;
  const spanish = await policy.compose({
    authority: authority(),
    untrusted_content: content({ subject: ES_SUBJECT, body_text: ES_BODY }),
    operator_context: '',
    env,
    hermes: snapshotSunsetEmailHermesSolEnv(env),
  });
  assert.equal(spanish.status, 'draft_ready');
  assert.equal(spanish.language, 'es');
  assert.equal(spanish.body, LIVE_ES_BODY);
  assertNotCanned(spanish.body, 'empty notes ES');
  assert.match(spanish.body, /Hola,/);
  assert.match(spanish.body, /¿Quieres hacer una reserva\?/);
  assert.equal(fake.hits.length, esHitsBefore + 1);
  assert.equal(fake.parsedHits.at(-1).language, 'es');
  assert.equal(fake.parsedHits.at(-1).untrusted_email.body_text, ES_BODY);
  console.log('  PASS  empty notes follow trusted ES thread locale (BF-016)');

  const owner = makeOwner({ env });
  const produced = await owner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assert.equal(produced.status, 'draft_ready');
  assert.equal(produced.draft_text, LIVE_EN_BODY);
  assertNotCanned(produced.draft_text, 'producer empty notes');
  assert.equal(produced.send_allowed, false);
  assert.equal(produced.auto_send_allowed, false);
  assert.equal(produced.marker.model, HERMES_SOL_MODEL);
  assert.equal(produced.authenticity.hmac_verified, true);
  assert.equal(owner.writes.length, 1);
  assert.equal(owner.store.draft, LIVE_EN_BODY);
  assert.notEqual(owner.store.draft, 'Previous standing draft.');
  assertNoSideEffects(owner, 'producer empty notes');
  console.log('  PASS  producer persists editable Sol draft for empty notes, no send/approve');

  const wsOwner = makeOwner({ env });
  const wsProduced = await wsOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: ' \n ',
  });
  assert.equal(wsProduced.status, 'draft_ready');
  assert.equal(wsProduced.draft_text, LIVE_EN_BODY);
  assertNoSideEffects(wsOwner, 'producer whitespace notes');
  console.log('  PASS  producer whitespace notes persist Sol draft');

  const notesOwner = makeOwner({ env });
  const notesProduced = await notesOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: LIVE_NOTES,
  });
  assert.equal(notesProduced.status, 'draft_ready');
  assert.equal(notesProduced.draft_text, LIVE_EN_BODY);
  assert.equal(notesProduced.draft_text.includes(LIVE_NOTES), false);
  assertNoSideEffects(notesOwner, 'producer notes path');
  console.log('  PASS  producer notes path unchanged');

  const openOwner = makeOwner({
    env,
    rows: [authorityRow({ needs_human: true, staff_reply_draft: '', conversation_metadata: {} })],
  });
  const opened = await openOwner.owner.ensureEmailLunaDraftOnOpen({
    actor: actor(),
    conversation_id: V,
  });
  assert.equal(opened.status, 'draft_ready');
  assert.equal(opened.draft_text, SAFE_ACKNOWLEDGMENT.en);
  assertNoSideEffects(openOwner, 'generate-on-open');
  console.log('  PASS  generate-on-open without classifier stays unguided/safe');

  const routeSent = [];
  const routeOwner = makeOwner({ env });
  const route = createStaffEmailLunaDraftRoute({
    sendJSON(_res, status, body) { routeSent.push({ status, body }); return body; },
    runtimeEnv: env,
    withPgClient: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    createLunaRuntime() { throw new Error('route must use existing producer'); },
    saveDraftThroughStaffOwner() { throw new Error('must not create approval'); },
    regenerateEmailLunaDraftOnStaffClick: (input) => (
      routeOwner.owner.regenerateEmailLunaDraftOnStaffClick(input)
    ),
  });
  await route.handleCreateDraft(
    request({ conversation_id: V, context: '' }),
    {},
    actor(),
    snapshotEmailLunaGenerateGateEnv(env),
  );
  const routed = routeSent.at(-1);
  assert.equal(routed.status, 200);
  assert.equal(routed.body.success, true);
  assert.equal(routed.body.message_text, LIVE_EN_BODY);
  assertNotCanned(routed.body.message_text, 'Create Draft route empty notes');
  assert.equal(Object.prototype.hasOwnProperty.call(routed.body, 'approval_id'), false);
  assert.equal(EMAIL_LUNA_CREATE_DRAFT_PATH, '/staff/inbox/email/create-draft');
  assertNoSideEffects(routeOwner, 'Create Draft route');
  console.log('  PASS  Staff Create Draft route empty notes returns editable Sol draft');

  await route.handleCreateDraft(
    request({ conversation_id: V, context: LIVE_NOTES, thread_text: 'FORGED GUEST TEXT', tenant_id: 'wolfhouse' }),
    {},
    actor(),
    snapshotEmailLunaGenerateGateEnv(env),
  );
  assert.equal(routeSent.at(-1).status, 400, 'untrusted extra browser fields must not be accepted');
  console.log('  PASS  Create Draft rejects untrusted extra thread/tenant browser fields');

  await stopFake(fake);

  const invented = await startFakeHermes(async ({ res, raw }) => {
    const parsed = parseDraftPlanRequest(raw);
    const prov = provenanceFrom(parsed.value);
    const plan = { acts: [{ act: 'thank_guest' }, { act: 'ask_booking_interest' }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      schema: HERMES_SOL_RESULT_SCHEMA,
      acts: plan.acts,
      body: 'The loft is €50 tonight. Pay now: https://evil.test/pay',
      provenance: prov,
      authenticity: signResultAuthenticity(HMAC_SECRET, parsed.value, prov, plan),
    }));
  });
  const inventedEnv = hermesEnv(invented.port);
  const inventedDraft = await policy.compose({
    authority: authority(),
    untrusted_content: content(),
    operator_context: '',
    env: inventedEnv,
    hermes: snapshotSunsetEmailHermesSolEnv(inventedEnv),
  });
  assertFailClosed(inventedDraft, 'extra-key invented facts');
  await stopFake(invented);
  console.log('  PASS  extra-key/invented-fact Hermes output fail-closes');

  const wrapFake = await startFakeHermes(async ({ res, raw }) => {
    const parsed = parseDraftPlanRequest(raw);
    const prov = provenanceFrom(parsed.value);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      schema: HERMES_SOL_RESULT_SCHEMA,
      acts: [{ act: 'thank_guest', topic: 'We also wanted to add' }],
      provenance: prov,
      authenticity: signResultAuthenticity(HMAC_SECRET, parsed.value, prov, {
        acts: [{ act: 'thank_guest', topic: 'We also wanted to add' }],
      }),
    }));
  });
  const wrapEnv = hermesEnv(wrapFake.port);
  const wrapDraft = await policy.compose({
    authority: authority(),
    untrusted_content: content(),
    operator_context: '',
    env: wrapEnv,
    hermes: snapshotSunsetEmailHermesSolEnv(wrapEnv),
  });
  assertFailClosed(wrapDraft, 'forbidden wrap topic');
  await stopFake(wrapFake);
  console.log('  PASS  forbidden wrap phrase in plan fail-closes');

  const mismatch = await startFakeHermes(async ({ res, raw }) => {
    const parsed = parseDraftPlanRequest(raw);
    const prov = provenanceFrom(parsed.value);
    prov.provider = 'openai';
    prov.model = 'gpt-4o-mini';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      schema: HERMES_SOL_RESULT_SCHEMA,
      acts: [{ act: 'thank_guest' }],
      provenance: prov,
    }));
  });
  const mismatchEnv = hermesEnv(mismatch.port);
  const rejected = await policy.compose({
    authority: authority(),
    untrusted_content: content(),
    operator_context: '',
    env: mismatchEnv,
    hermes: snapshotSunsetEmailHermesSolEnv(mismatchEnv),
  });
  assertFailClosed(rejected, 'forged provenance empty notes');
  await stopFake(mismatch);
  console.log('  PASS  forged provider/model on empty notes fail-closes');

  const timed = await startFakeHermes(async () => {});
  const timedEnv = hermesEnv(timed.port);
  const timedOut = await policy.compose({
    authority: authority(),
    untrusted_content: content(),
    operator_context: '',
    env: timedEnv,
    hermes: snapshotSunsetEmailHermesSolEnv(timedEnv),
    timeoutMs: 40,
  });
  assertFailClosed(timedOut, 'timeout empty notes');
  await stopFake(timed);
  console.log('  PASS  empty-notes Hermes timeout fail-closes');

  const downEnv = hermesEnv(1);
  const compiled = await policy.compose({
    authority: authority(),
    untrusted_content: content(),
    operator_context: '',
    env: downEnv,
    hermes: snapshotSunsetEmailHermesSolEnv(downEnv),
  });
  assert.equal(compiled.status, 'draft_ready');
  assertNotCanned(compiled.body, 'unavailable empty notes');
  assert.equal(compiled.body, EMPTY_FALLBACK_EN);
  assert.doesNotMatch(compiled.body, WRAPPER);
  console.log('  PASS  Hermes unavailable empty notes uses honest thread compile, not canned ack');

  const compiledEs = await policy.compose({
    authority: authority(),
    untrusted_content: content({ subject: ES_SUBJECT, body_text: ES_BODY }),
    operator_context: '   ',
    env: downEnv,
    hermes: snapshotSunsetEmailHermesSolEnv(downEnv),
  });
  assert.equal(compiledEs.status, 'draft_ready');
  assert.equal(compiledEs.language, 'es');
  assert.equal(compiledEs.body, EMPTY_FALLBACK_ES);
  assertNotCanned(compiledEs.body, 'unavailable empty notes ES');
  console.log('  PASS  unavailable empty notes still follow ES thread locale');

  const compiledNotes = await policy.compose({
    authority: authority(),
    untrusted_content: content(),
    operator_context: LIVE_NOTES,
    env: downEnv,
    hermes: snapshotSunsetEmailHermesSolEnv(downEnv),
  });
  assert.equal(compiledNotes.status, 'draft_ready');
  assert.equal(compiledNotes.body, LIVE_EN_BODY);
  console.log('  PASS  unavailable notes path still uses FIX-3 compile');

  const emptyCompile = compileCreateDraftNaturalPlanJson('', content());
  assert.notEqual(emptyCompile, JSON.stringify({
    acts: [{ act: 'thank_guest' }, { act: 'offer_human_followup' }],
  }));
  assert.equal(EMPTY_FALLBACK_EN, expectedEmptyCompileBody(content(), 'en'));
  assert.notEqual(EMPTY_FALLBACK_EN, FORBIDDEN_EMPTY_WRAPPER_EN);
  assert.match(EMPTY_FALLBACK_EN, /front desk|testing|mailbox/i);
  assert.equal(
    compileCreateDraftNaturalPlanJson(LIVE_NOTES),
    JSON.stringify({ acts: [{ act: 'thank_guest' }, { act: 'ask_booking_interest' }] }),
  );
  console.log('  PASS  empty-goals compile is low-claim and notes compile is unchanged');

  const failOwner = makeOwner({ env: hermesEnv(1), timeoutMs: 40 });
  const hanging = await startFakeHermes(async () => {});
  const timeoutOwner = makeOwner({ env: hermesEnv(hanging.port), timeoutMs: 40 });
  const timeoutDraft = await timeoutOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assert.equal(timeoutDraft.status, 'pending');
  assert.equal(timeoutOwner.writes.length, 0);
  assert.equal(timeoutOwner.store.draft, 'Previous standing draft.');
  assertNoSideEffects(timeoutOwner, 'timeout producer');
  await stopFake(hanging);
  console.log('  PASS  producer timeout leaves standing draft and has no side effects');

  const unavailableOwner = makeOwner({ env: downEnv });
  const unavailableDraft = await unavailableOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assert.equal(unavailableDraft.status, 'draft_ready');
  assert.equal(unavailableDraft.draft_text, EMPTY_FALLBACK_EN);
  assert.equal(unavailableOwner.writes.length, 1);
  assertNoSideEffects(unavailableOwner, 'unavailable producer');
  console.log('  PASS  producer unavailable empty notes writes honest fallback only');

  assert.equal(failOwner.approvals.length, 0);

  const pkg = JSON.parse(readFile('package.json'));
  assert.equal(pkg.scripts['verify:mail-mvp-007-sol-empty'], 'node scripts/verify-mail-mvp-007-sol-empty.js');
  assert.equal(pkg.scripts['verify:mail-mvp-007'], 'node scripts/verify-email-luna-sunset-email-hermes-sol.js');

  for (const rel of [
    'scripts/lib/email-luna-draft-open-policy-composition.js',
    'scripts/lib/email-luna-create-draft-natural-author.js',
    'scripts/verify-mail-mvp-007-sol-empty.js',
  ]) {
    const checked = spawnSync(process.execPath, ['--check', rel], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr || rel);
  }

  const docs = readFile('docs/MAIL-MVP.md');
  assert.match(docs, /Empty or whitespace notes still call Email Luna Hermes/);
  assert.doesNotMatch(docs, /Empty notes stay the safe thread-only draft/);
  assert.doesNotMatch(docs, /Empty context keeps a safe thread-only Luna draft without the staff-goal model path/);

  console.log('PASS MAIL-MVP-007-SOL-EMPTY empty notes invoke Email Luna Hermes Sol');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
