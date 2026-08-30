#!/usr/bin/env node
'use strict';

/**
 * MAIL-MVP-007-SOL-EMPTY-FIX — explicit empty/blank Create Draft must replace
 * a pre-existing generic leftover with a thread-specific Email Luna Sol draft.
 *
 * PR #766's helper test started from "Previous standing draft." and a fake
 * Hermes that always returned thank_guest+ask_booking_interest, so it could
 * not see the live no-op: standing compose already was the generic wrapper
 * and empty Create Draft gave that same wrapper back.
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
  parseHermesSolActsPayload,
  signResultAuthenticity,
} = require('./lib/email-luna-sunset-email-hermes-sol-contract');
const {
  isStaffLocalCompileTrust,
} = require('./lib/email-luna-sunset-email-hermes-sol-author');
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
  SAFE_ACKNOWLEDGMENT,
} = require('./lib/email-luna-draft-open-policy-composition');
const {
  renderCreateDraftNaturalPlan,
  compileCreateDraftNaturalPlanJson,
  parseCreateDraftNaturalPlan,
  extractCreateDraftThreadTopic,
  createEmailLunaCreateDraftNaturalAuthor,
} = require('./lib/email-luna-create-draft-natural-author');
const {
  extractPermittedOperatorGuidance,
} = require('./lib/email-luna-create-draft-context');
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
const THANK_FOLLOWUP_NOTES = 'Thank them. A teammate can follow up if they need anything.';
const LIVE_SUBJECT = 'Re: Testing 8 26';
const LIVE_BODY = 'Hi, just testing the front desk mailbox.';
const ES_SUBJECT = 'Re: Prueba 8 26';
const ES_BODY = 'Hola, gracias, necesito un mensaje por favor.';
const WRAPPER = /we also wanted to add|tambi[eé]n quer[ií]amos a[nñ]adir/i;
const GENERIC_REVIEW = /we['’]ll review it and get back to you shortly|lo revisaremos y te responderemos en breve/i;
const LIVE_LEFTOVER_EN = [
  'Hi,',
  '',
  'Thanks for your message.',
  '',
  'A teammate can follow up if you need anything.',
  '',
  'Warm regards,',
  'Luna',
].join('\n');
const LIVE_LEFTOVER_ES = renderCreateDraftNaturalPlan({
  acts: [{ act: 'thank_guest' }, { act: 'offer_human_followup' }],
}, 'es');
const LIVE_EN_NOTES_BODY = renderCreateDraftNaturalPlan({
  acts: [{ act: 'thank_guest' }, { act: 'ask_booking_interest' }],
}, 'en');
const GENERIC_LEFTOVER_PLAN = { acts: [{ act: 'thank_guest' }, { act: 'offer_human_followup' }] };
const LOW_CLAIM_FALLBACK_EN = renderCreateDraftNaturalPlan({
  acts: [{ act: 'thank_guest' }, { act: 'acknowledge_message' }],
}, 'en');
const LOW_CLAIM_FALLBACK_ES = renderCreateDraftNaturalPlan({
  acts: [{ act: 'thank_guest' }, { act: 'acknowledge_message' }],
}, 'es');
const THANK_FOLLOWUP_EN_BODY = renderCreateDraftNaturalPlan(GENERIC_LEFTOVER_PLAN, 'en');

assert.equal(
  LIVE_LEFTOVER_EN,
  renderCreateDraftNaturalPlan(GENERIC_LEFTOVER_PLAN, 'en'),
  'fixture must be the exact live generic wrapper',
);

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
    from_address: 'twoods@xantrion.com',
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
        // Live Sol for this testing thread returns the generic leftover plan.
        const plan = GENERIC_LEFTOVER_PLAN;
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

function leftoverRow(patch = {}) {
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
    from_address: 'twoods@xantrion.com',
    conversation_deleted_at: null,
    conversation_status: 'open',
    needs_human: false,
    latest_message_id: M,
    staff_reply_draft: LIVE_LEFTOVER_EN,
    conversation_metadata: {
      luna_email_open_draft: {
        state: 'ready',
        origin: 'luna',
        source_inbound_event_id: M,
        generated_body_sha256: crypto.createHash('sha256').update(LIVE_LEFTOVER_EN, 'utf8').digest('hex'),
      },
    },
    luna_on: true,
    global_pause: false,
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
  const claims = [];
  const approvals = [];
  const journals = [];
  const providers = [];
  const bookings = [];
  const casRejected = [];
  const rows = Object.hasOwn(options, 'rows') ? options.rows : [leftoverRow()];
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
            claims.push({ sql: text, params });
            store.meta = { ...store.meta, ...(typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2] || {}) };
            return { rows: [{ conversation_id: V }] };
          }
          if (text === ownerMod.SQL_CAS_EMAIL_LUNA_OPEN_DRAFT
              || text === ownerMod.SQL_CAS_EMAIL_LUNA_CREATE_DRAFT) {
            const expectedOld = params[6] == null ? '' : String(params[6]);
            const current = store.draft == null ? '' : String(store.draft);
            if (expectedOld !== current) {
              casRejected.push({ expectedOld, current, next: params[2], sql: text });
              return { rows: [] };
            }
            const nextDraft = params[2];
            store.draft = nextDraft;
            store.meta = { ...store.meta, ...(typeof params[3] === 'string' ? JSON.parse(params[3]) : params[3] || {}) };
            writes.push({ sql: text, draft: nextDraft, params });
            return { rows: [{ staff_reply_draft: nextDraft }] };
          }
          if (text === ownerMod.SQL_RELEASE_EMAIL_LUNA_OPEN_CLAIM) {
            return { rows: [{ conversation_id: V }] };
          }
          if (text === ownerMod.SQL_LOAD_EXISTING_EMAIL_REPLY_APPROVAL) {
            return { rows: options.approvalRows || [] };
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
  return { owner, ownerMod, writes, claims, approvals, journals, providers, bookings, store, casRejected };
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

function assertByteDifferent(actual, forbidden, label) {
  assert.equal(typeof actual, 'string', label);
  assert.ok(actual.trim(), label);
  assert.notEqual(actual, forbidden, `${label}: must differ from leftover`);
  assert.notEqual(
    Buffer.from(actual, 'utf8').equals(Buffer.from(forbidden, 'utf8')),
    true,
    `${label}: must differ byte-for-byte from leftover`,
  );
}

function assertThreadSpecific(body, thread, label) {
  assert.equal(typeof body, 'string', label);
  assert.ok(body.trim(), label);
  assertByteDifferent(body, LIVE_LEFTOVER_EN, label);
  assertByteDifferent(body, LIVE_LEFTOVER_ES, `${label} vs ES leftover`);
  assert.notEqual(body, SAFE_ACKNOWLEDGMENT.en, `${label}: not canned EN ack`);
  assert.notEqual(body, SAFE_ACKNOWLEDGMENT.es, `${label}: not canned ES ack`);
  assert.doesNotMatch(body, GENERIC_REVIEW, `${label}: not review stub`);
  assert.doesNotMatch(body, WRAPPER, `${label}: not We also wanted to add`);
  const haystack = `${thread.subject || ''}\n${thread.body_text || ''}`.toLowerCase();
  const tokens = haystack.split(/[^a-z0-9áéíóúñü]+/i).filter((w) => w.length >= 4);
  const cited = tokens.some((token) => body.toLowerCase().includes(token));
  assert.equal(cited, true, `${label}: must cite a thread token, not a generic wrapper`);
}

function assertNoSideEffects(owner, label) {
  assert.equal(owner.approvals.length, 0, `${label}: no approve`);
  assert.equal(owner.journals.length, 0, `${label}: no journal`);
  assert.equal(owner.providers.length, 0, `${label}: no provider`);
  assert.equal(owner.bookings.length, 0, `${label}: no booking`);
}

function assertCreateDraftSql(owner, label) {
  const claimSql = owner.claims.map((row) => row.sql);
  const writeSql = owner.writes.map((row) => row.sql);
  assert.ok(
    claimSql.includes(owner.ownerMod.SQL_CLAIM_EMAIL_LUNA_CREATE_DRAFT),
    `${label}: executes SQL_CLAIM_EMAIL_LUNA_CREATE_DRAFT`,
  );
  assert.ok(
    writeSql.includes(owner.ownerMod.SQL_CAS_EMAIL_LUNA_CREATE_DRAFT),
    `${label}: executes SQL_CAS_EMAIL_LUNA_CREATE_DRAFT`,
  );
  assert.equal(
    claimSql.includes(owner.ownerMod.SQL_CLAIM_EMAIL_LUNA_OPEN_DRAFT),
    false,
    `${label}: must not execute OPEN claim SQL`,
  );
  assert.equal(
    writeSql.includes(owner.ownerMod.SQL_CAS_EMAIL_LUNA_OPEN_DRAFT),
    false,
    `${label}: must not execute OPEN CAS SQL`,
  );
  assert.equal(
    owner.store.queryTexts.includes(owner.ownerMod.SQL_CLAIM_EMAIL_LUNA_OPEN_DRAFT),
    false,
    `${label}: query log has no OPEN claim SQL`,
  );
  assert.equal(
    owner.store.queryTexts.includes(owner.ownerMod.SQL_CAS_EMAIL_LUNA_OPEN_DRAFT),
    false,
    `${label}: query log has no OPEN CAS SQL`,
  );
}

function assertNoPiiOrNumericEcho(body, label) {
  const text = String(body || '').normalize('NFC').toLowerCase();
  for (const token of [
    'john', 'smith', 'twoods', 'xantrion', 'maría', 'maria', 'garcía', 'garcia',
    'carlos', 'lucia', 'lucía',
  ]) {
    assert.equal(text.includes(token), false, `${label}: must not echo ${token}`);
  }
  assert.doesNotMatch(String(body || ''), /@/, `${label}: no address echo`);
  assert.doesNotMatch(String(body || ''), /\b(?:8|26|555|0100|2026)\b/, `${label}: no raw numeric/date echo`);
}

function assertNoSend(result, label) {
  assert.equal(result.send_allowed, false, `${label}: send_allowed`);
  assert.equal(result.auto_send_allowed, false, `${label}: auto_send_allowed`);
}

function assertFailClosed(result, owner, label) {
  assert.notEqual(result.status, 'draft_ready', label);
  assert.ok(result.status === 'handoff_required' || result.status === 'pending', label);
  if (result.status === 'handoff_required') {
    assert.equal(!result.body || !String(result.body).trim(), true, label);
  }
  if (owner) {
    assert.equal(owner.store.draft, LIVE_LEFTOVER_EN, `${label}: leftover standing draft stays`);
    assert.equal(owner.writes.length, 0, `${label}: no CAS write`);
    assertNoSideEffects(owner, label);
  }
}

function assertNoSolProvenance(result, label) {
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'marker'), false, `${label}: no marker`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'authenticity'), false, `${label}: no authenticity`);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'plan_authenticity'), false, `${label}: no plan_authenticity`);
  assert.equal(result.marker, undefined, `${label}: marker undefined`);
  assert.equal(result.authenticity, undefined, `${label}: authenticity undefined`);
  assert.equal(result.plan_authenticity, undefined, `${label}: plan_authenticity undefined`);
}

function assertNoExactBodyHmac(result, label) {
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'authenticity'), false, `${label}: no exact-body authenticity`);
  assert.equal(result.authenticity, undefined, `${label}: authenticity undefined`);
  if (result.authenticity) {
    assert.notEqual(result.authenticity.hmac_verified, true, `${label}: must not claim exact-body HMAC`);
  }
}

function assertTransformedPlanProvenance(result, label) {
  assert.equal(result.status, 'draft_ready', label);
  assertNoExactBodyHmac(result, label);
  assert.equal(result.marker.provider, HERMES_SOL_PROVIDER, `${label}: plan marker provider`);
  assert.equal(result.marker.model, HERMES_SOL_MODEL, `${label}: plan marker model`);
  assert.equal(result.marker.runtime, HERMES_SOL_RUNTIME, `${label}: plan marker runtime`);
  assert.equal(result.plan_authenticity.hmac_verified, true, `${label}: plan HMAC verified`);
  assert.equal(result.plan_authenticity.exact_body_hmac_verified, false, `${label}: transformed body is not exact-body HMAC`);
  assert.equal(result.plan_authenticity.source, 'staff_local_bounded_topic_compile', `${label}: local compiler source`);
  assert.match(result.plan_authenticity.request_id, /^[0-9a-f-]{36}$/i, `${label}: plan request_id`);
  assert.equal(result.send_allowed, false, `${label}: send_allowed`);
  assert.equal(result.auto_send_allowed, false, `${label}: auto_send_allowed`);
}

function signedPlanResponder(plan) {
  return async ({ req, res, parsed, seen }) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401); res.end(JSON.stringify({ error: 'unauthorized' })); return;
    }
    if (!parsed.ok) {
      res.writeHead(400); res.end(JSON.stringify({ error: parsed.reason })); return;
    }
    if (seen.has(parsed.value.request_id)) {
      res.writeHead(409); res.end(JSON.stringify({ error: 'replay' })); return;
    }
    seen.add(parsed.value.request_id);
    const provenance = provenanceFrom(parsed.value);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      schema: HERMES_SOL_RESULT_SCHEMA,
      acts: plan.acts,
      provenance,
      authenticity: signResultAuthenticity(HMAC_SECRET, parsed.value, provenance, plan),
    }));
  };
}

(async () => {
  console.log('verify:mail-mvp-007-sol-empty-fix');

  const naturalSrc = readFile('scripts/lib/email-luna-create-draft-natural-author.js');
  const solAuthorSrc = readFile('scripts/lib/email-luna-sunset-email-hermes-sol-author.js');
  const openSrc = readFile('scripts/lib/staff-email-luna-draft-open.js');
  const routeSrc = readFile('scripts/lib/staff-email-luna-draft-route.js');
  const autoSrc = readFile('scripts/lib/email-luna-microsoft-auto-create-send.js');
  const policySrc = readFile('scripts/lib/email-luna-draft-open-policy-composition.js');

  assert.match(naturalSrc, /When private staff goals are empty/);
  assert.match(naturalSrc, /SAFE_CREATE_DRAFT_TOPIC_LABELS/);
  assert.doesNotMatch(naturalSrc, /isNameShapedWord|THREAD_TOPIC_NAME_PAIR_SKIP/);
  assert.match(solAuthorSrc, /local_replacement === true/);
  assert.match(solAuthorSrc, /parseHermesSolActsPayload/);
  assert.match(solAuthorSrc, /exact_body_hmac_verified: false/);
  assert.match(solAuthorSrc, /staff_local_bounded_topic_compile/);
  assert.match(openSrc, /plan_authenticity/);
  assert.match(openSrc, /isStaffLocalCompileTrust/);
  assert.equal(isStaffLocalCompileTrust({
    source: 'staff_local_bounded_topic_compile',
    request_id: V,
    plan_hmac_verified: true,
    exact_body_hmac_verified: false,
  }), false, 'forged local-compile object is not same-process trust');
  assert.equal(parseHermesSolActsPayload(JSON.stringify({
    acts: [{ act: 'thank_guest' }, { act: 'ask_clarifying_question', topic: 'Testing 8 26' }],
  })).ok, true, 'Python-shaped signed topic envelope is parseable for local compile');
  assert.equal(parseHermesSolActsPayload(JSON.stringify({
    acts: [{ act: 'ask_clarifying_question', topic: 'testing', extra: 'bypass' }],
  })).ok, false, 'extra keys stay fail-closed');
  assert.equal(parseHermesSolActsPayload(JSON.stringify({
    acts: [{ act: 'thank_guest', topic: 'We also wanted to add' }],
  })).ok, false, 'wrapper-phrase topics stay fail-closed');
  assert.match(
    naturalSrc,
    /emptyPrivateGoals && isForbiddenGenericEmptyWrapper/,
    'generic-wrapper ban/refinement is gated to empty or whitespace-only private staff goals',
  );
  assert.doesNotMatch(
    naturalSrc,
    /else push\('offer_human_followup'\);\s*\}\s*if \(!acts\.length\) return null/,
    'mutation-negative: empty-goals compile must not default to the leftover teammate wrapper',
  );
  assert.match(openSrc, /operator_context: operatorGuidance/);
  assert.doesNotMatch(openSrc, /LUNA_AUTO_SEND_ENABLED\s*=/);
  assert.doesNotMatch(routeSrc, /LUNA_AUTO_SEND_ENABLED\s*=/);
  assert.match(autoSrc, /LUNA_AUTO_SEND_ENABLED/);
  assert.doesNotMatch(autoSrc, /LUNA_AUTO_SEND_ENABLED\s*=\s*'true'/);
  assert.match(policySrc, /typeof input\.operator_context === 'string'/);
  console.log('  PASS  mutation-negative source: leftover wrapper is not the empty-goals default');

  const fake = await startFakeHermes();
  const env = hermesEnv(fake.port);

  const compiledPlan = compileCreateDraftNaturalPlanJson('', content());
  const compiled = parseCreateDraftNaturalPlan(compiledPlan);
  const compiledBody = renderCreateDraftNaturalPlan(compiled, 'en');
  assertThreadSpecific(compiledBody, content(), 'compile empty notes from live thread');
  assert.notEqual(compiledBody, LIVE_LEFTOVER_EN);
  assert.notEqual(compiledBody, LOW_CLAIM_FALLBACK_EN);
  assertNoPiiOrNumericEcho(compiledBody, 'compile empty live thread');
  assert.equal(
    compileCreateDraftNaturalPlanJson(THANK_FOLLOWUP_NOTES, content()),
    JSON.stringify(GENERIC_LEFTOVER_PLAN),
    'non-empty thank+followup notes still compile to thank_guest + offer_human_followup',
  );
  assert.equal(THANK_FOLLOWUP_EN_BODY, LIVE_LEFTOVER_EN);
  console.log('  PASS  empty-goals compile is thread-specific, not the leftover wrapper');

  const johnThread = content({
    subject: LIVE_SUBJECT,
    body_text: 'Hi, I am John Smith writing about the mailbox.',
    from_display_name: 'John Smith',
    from_address: 'john.smith@example.test',
  });
  const emailThread = content({
    subject: LIVE_SUBJECT,
    body_text: 'Please reply to twoods@xantrion.com about the mailbox.',
    from_display_name: 'Tyler Woods',
    from_address: 'twoods@xantrion.com',
  });
  const dateBodyThread = content({
    subject: LIVE_SUBJECT,
    body_text: '08/26/2026',
    from_display_name: 'John Smith',
    from_address: 'twoods@xantrion.com',
  });
  const numericOnlyThread = content({
    subject: '8 26',
    body_text: '08/26/2026 555-0100',
    from_display_name: 'John Smith',
    from_address: 'twoods@xantrion.com',
  });
  const spanishNameThread = content({
    subject: ES_SUBJECT,
    body_text: 'Hola, soy María García, necesito un mensaje por favor.',
    from_display_name: 'María García',
    from_address: 'maria.garcia@example.test',
  });
  const mariaNameThread = content({
    subject: LIVE_SUBJECT,
    body_text: 'My name is maria',
    from_display_name: 'Guest',
    from_address: 'guest@example.test',
  });
  const mariaSurfThread = content({
    subject: LIVE_SUBJECT,
    body_text: 'Please tell maria about surfing',
    from_display_name: 'Guest',
    from_address: 'guest@example.test',
  });
  const carlosThread = content({
    subject: ES_SUBJECT,
    body_text: 'Soy carlos',
    from_display_name: 'Guest',
    from_address: 'guest@example.test',
  });
  const luciaBoardsThread = content({
    subject: ES_SUBJECT,
    body_text: 'pregunta para lucia sobre tablas',
    from_display_name: 'Guest',
    from_address: 'guest@example.test',
  });

  assert.equal(extractCreateDraftThreadTopic(johnThread).includes('john'), false);
  assert.equal(extractCreateDraftThreadTopic(johnThread).includes('smith'), false);
  assert.match(extractCreateDraftThreadTopic(johnThread), /mailbox|testing|writing/i);
  assert.doesNotMatch(extractCreateDraftThreadTopic(emailThread), /twoods|xantrion|com/i);
  assert.match(extractCreateDraftThreadTopic(emailThread), /mailbox|testing|reply/i);
  assert.equal(extractCreateDraftThreadTopic(content()), 'front desk');
  assert.doesNotMatch(extractCreateDraftThreadTopic(dateBodyThread), /8|26|2026|john|smith|twoods/);
  assert.match(extractCreateDraftThreadTopic(dateBodyThread), /testing/i);
  assert.equal(extractCreateDraftThreadTopic(numericOnlyThread), '');
  assert.doesNotMatch(extractCreateDraftThreadTopic(spanishNameThread), /maría|maria|garcía|garcia/i);
  assert.match(extractCreateDraftThreadTopic(spanishNameThread), /prueba/i);
  assert.doesNotMatch(extractCreateDraftThreadTopic(mariaNameThread), /maria/i);
  assert.match(extractCreateDraftThreadTopic(mariaNameThread), /testing|front desk|mailbox/i);
  assert.doesNotMatch(extractCreateDraftThreadTopic(mariaSurfThread), /maria/i);
  assert.match(extractCreateDraftThreadTopic(mariaSurfThread), /surf|testing|front desk|mailbox/i);
  const surfOnlyThread = content({
    subject: 'Hello',
    body_text: 'Please tell maria about surfing',
    from_display_name: 'Guest',
    from_address: 'guest@example.test',
  });
  assert.equal(extractCreateDraftThreadTopic(surfOnlyThread), 'surfing');
  assert.doesNotMatch(extractCreateDraftThreadTopic(surfOnlyThread), /maria/i);
  assert.doesNotMatch(extractCreateDraftThreadTopic(carlosThread), /carlos/i);
  assert.match(extractCreateDraftThreadTopic(carlosThread), /prueba/i);
  assert.doesNotMatch(extractCreateDraftThreadTopic(luciaBoardsThread), /lucia|lucía/i);
  assert.match(extractCreateDraftThreadTopic(luciaBoardsThread), /tabla|prueba/i);

  const numericCompile = renderCreateDraftNaturalPlan(
    parseCreateDraftNaturalPlan(compileCreateDraftNaturalPlanJson('', numericOnlyThread)),
    'en',
  );
  assert.equal(numericCompile, LOW_CLAIM_FALLBACK_EN);
  assert.notEqual(numericCompile, LIVE_LEFTOVER_EN);
  assert.notEqual(numericCompile, SAFE_ACKNOWLEDGMENT.en);
  assertNoPiiOrNumericEcho(numericCompile, 'numeric/date-only compile fallback');

  const spanishNameCompile = renderCreateDraftNaturalPlan(
    parseCreateDraftNaturalPlan(compileCreateDraftNaturalPlanJson('', spanishNameThread)),
    'es',
  );
  assert.notEqual(spanishNameCompile, LIVE_LEFTOVER_ES);
  assert.notEqual(spanishNameCompile, LOW_CLAIM_FALLBACK_ES);
  assertNoPiiOrNumericEcho(spanishNameCompile, 'Spanish name compile');
  assert.match(spanishNameCompile, /prueba|mensaje/i);
  assert.equal(spanishNameCompile.slice(0, 5), 'Hola,');
  console.log('  PASS  topic extraction is allowlisted; unpaired/lowercase names never become topics');

  const owner = makeOwner({ env });
  assert.equal(owner.store.draft, LIVE_LEFTOVER_EN);
  const produced = await owner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assert.equal(produced.status, 'draft_ready');
  assertThreadSpecific(produced.draft_text, content(), 'producer empty notes from leftover');
  assert.equal(produced.send_allowed, false);
  assert.equal(produced.auto_send_allowed, false);
  assertTransformedPlanProvenance(produced, 'generic leftover wrapper replacement');
  assert.equal(fake.hits.length, 1, 'explicit empty Create Draft must invoke Email Luna');
  assert.equal(fake.hits[0].url, HERMES_SOL_DRAFT_PATH);
  assert.equal(fake.hits[0].auth, 'bearer');
  assert.equal(fake.parsedHits[0].schema, HERMES_SOL_REQUEST_SCHEMA);
  assert.equal(fake.parsedHits[0].private_staff_goals.trust, PRIVATE_STAFF_TRUST);
  assert.equal(fake.parsedHits[0].private_staff_goals.goals, '');
  assert.equal(fake.parsedHits[0].untrusted_email.body_text, LIVE_BODY);
  assert.equal(fake.parsedHits[0].untrusted_email.subject, LIVE_SUBJECT);
  assert.equal(fake.parsedHits[0].untrusted_email.from_address, 'twoods@xantrion.com');
  assert.equal(owner.writes.length, 1);
  assert.equal(owner.store.draft, produced.draft_text);
  assert.notEqual(owner.store.draft, LIVE_LEFTOVER_EN);
  assert.equal(owner.casRejected.length, 0, 'CAS expected-old-text must match leftover then replace');
  assertNoSend(produced, 'producer leftover empty notes');
  assertCreateDraftSql(owner, 'producer leftover empty notes');
  assertNoPiiOrNumericEcho(produced.draft_text, 'producer leftover empty notes');
  assert.doesNotMatch(produced.draft_text, /\b(?:8|26)\b/, 'Re: Testing 8 26 must not echo raw dates');
  assertNoSideEffects(owner, 'producer leftover empty notes');
  console.log('  PASS  leftover standing draft is replaced by thread-specific Sol draft');

  const liveSubjectTopicFake = await startFakeHermes(signedPlanResponder({
    acts: [{ act: 'thank_guest' }, { act: 'ask_clarifying_question', topic: 'Testing 8 26' }],
  }));
  const liveSubjectTopicOwner = makeOwner({ env: hermesEnv(liveSubjectTopicFake.port) });
  const liveSubjectTopicProduced = await liveSubjectTopicOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assert.equal(liveSubjectTopicProduced.status, 'draft_ready');
  assertThreadSpecific(liveSubjectTopicProduced.draft_text, content(), 'signed Testing 8 26 topic');
  assert.match(liveSubjectTopicProduced.draft_text, /testing|front desk|mailbox/i);
  assert.doesNotMatch(liveSubjectTopicProduced.draft_text, /\b(?:8|26)\b/);
  assertNoPiiOrNumericEcho(liveSubjectTopicProduced.draft_text, 'signed Testing 8 26 topic');
  assertTransformedPlanProvenance(liveSubjectTopicProduced, 'signed Testing 8 26 topic');
  assert.equal(liveSubjectTopicFake.hits.length, 1);
  assert.equal(liveSubjectTopicOwner.writes.length, 1);
  assert.equal(liveSubjectTopicOwner.store.draft, liveSubjectTopicProduced.draft_text);
  assert.equal(liveSubjectTopicOwner.casRejected.length, 0);
  assertCreateDraftSql(liveSubjectTopicOwner, 'signed Testing 8 26 topic');
  assertNoSideEffects(liveSubjectTopicOwner, 'signed Testing 8 26 topic');
  const liveSubjectRouteSent = [];
  const liveSubjectRouteOwner = makeOwner({ env: hermesEnv(liveSubjectTopicFake.port) });
  const liveSubjectRoute = createStaffEmailLunaDraftRoute({
    sendJSON(_res, status, body) { liveSubjectRouteSent.push({ status, body }); return body; },
    runtimeEnv: hermesEnv(liveSubjectTopicFake.port),
    withPgClient: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    createLunaRuntime() { throw new Error('route must use existing producer'); },
    saveDraftThroughStaffOwner() { throw new Error('must not create approval'); },
    approveDraft: (...args) => liveSubjectRouteOwner.approvals.push(args),
    appendOutboundJournal: (...args) => liveSubjectRouteOwner.journals.push(args),
    callProvider: (...args) => liveSubjectRouteOwner.providers.push(args),
    regenerateEmailLunaDraftOnStaffClick: (input) => (
      liveSubjectRouteOwner.owner.regenerateEmailLunaDraftOnStaffClick(input)
    ),
  });
  await liveSubjectRoute.handleCreateDraft(
    request({ conversation_id: V, context: '' }),
    {},
    actor(),
    snapshotEmailLunaGenerateGateEnv(hermesEnv(liveSubjectTopicFake.port)),
  );
  const liveSubjectRouted = liveSubjectRouteSent.at(-1);
  assert.equal(liveSubjectRouted.status, 200);
  assert.equal(liveSubjectRouted.body.success, true);
  assertThreadSpecific(liveSubjectRouted.body.message_text, content(), 'Create Draft route signed Testing 8 26 topic');
  assert.equal(Object.prototype.hasOwnProperty.call(liveSubjectRouted.body, 'approval_id'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(liveSubjectRouted.body, 'authenticity'), false);
  assertNoSideEffects(liveSubjectRouteOwner, 'Create Draft route signed Testing 8 26 topic');
  await stopFake(liveSubjectTopicFake);
  console.log('  PASS  signed generic Testing 8 26 Sol topic compiles locally; Staff accepts without exact-body HMAC');

  const unsignedBodyFake = await startFakeHermes(async ({ req, res, parsed }) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401); res.end(JSON.stringify({ error: 'unauthorized' })); return;
    }
    if (!parsed.ok) {
      res.writeHead(400); res.end(JSON.stringify({ error: parsed.reason })); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      schema: HERMES_SOL_RESULT_SCHEMA,
      acts: [{ act: 'thank_guest' }, { act: 'ask_clarifying_question', topic: 'testing' }],
      provenance: provenanceFrom(parsed.value),
    }));
  });
  const unsignedBodyOwner = makeOwner({ env: hermesEnv(unsignedBodyFake.port) });
  const unsignedBodyOut = await unsignedBodyOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assertFailClosed(unsignedBodyOut, unsignedBodyOwner, 'unsigned network body');
  assertNoSolProvenance(unsignedBodyOut, 'unsigned network body');
  await stopFake(unsignedBodyFake);
  console.log('  PASS  unsigned network body stays fail-closed');

  const specificFake = await startFakeHermes(signedPlanResponder({
    acts: [{ act: 'thank_guest' }, { act: 'ask_clarifying_question', topic: 'testing' }],
  }));
  const specificEnv = hermesEnv(specificFake.port);
  const specificOwner = makeOwner({ env: specificEnv });
  const specificProduced = await specificOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assert.equal(specificProduced.status, 'draft_ready');
  assertThreadSpecific(specificProduced.draft_text, content(), 'thread-specific Sol plan');
  assert.match(specificProduced.draft_text, /testing/i);
  assert.equal(specificProduced.marker.provider, HERMES_SOL_PROVIDER);
  assert.equal(specificProduced.marker.model, HERMES_SOL_MODEL);
  assert.equal(specificProduced.marker.runtime, HERMES_SOL_RUNTIME);
  assert.equal(specificProduced.authenticity.hmac_verified, true);
  assert.equal(specificFake.hits.length, 1);
  assertNoSideEffects(specificOwner, 'thread-specific Sol leftover replace');
  await stopFake(specificFake);
  console.log('  PASS  thread-specific Sol plan keeps gpt-5.6-sol HMAC provenance');

  const unsafeNameFake = await startFakeHermes(signedPlanResponder({
    acts: [{ act: 'thank_guest' }, { act: 'ask_clarifying_question', topic: 'john smith' }],
  }));
  const unsafeNameOwner = makeOwner({ env: hermesEnv(unsafeNameFake.port) });
  const unsafeNameProduced = await unsafeNameOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assert.equal(unsafeNameProduced.status, 'draft_ready');
  assertThreadSpecific(unsafeNameProduced.draft_text, content(), 'unsafe john smith Sol plan');
  assert.match(unsafeNameProduced.draft_text, /front desk|testing|mailbox/i);
  assertNoPiiOrNumericEcho(unsafeNameProduced.draft_text, 'unsafe john smith Sol plan');
  assertTransformedPlanProvenance(unsafeNameProduced, 'unsafe john smith Sol plan');
  assert.equal(unsafeNameFake.hits.length, 1);
  assertNoSideEffects(unsafeNameOwner, 'unsafe john smith Sol plan');
  await stopFake(unsafeNameFake);
  console.log('  PASS  unsafe Sol john smith topic becomes local safe output without HMAC');

  const malformedTopicFake = await startFakeHermes(signedPlanResponder({
    acts: [{
      act: 'ask_clarifying_question',
      topic: 'testing',
      extra: 'bypass',
    }],
  }));
  const malformedTopicOwner = makeOwner({ env: hermesEnv(malformedTopicFake.port) });
  const malformedTopicOut = await malformedTopicOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assertFailClosed(malformedTopicOut, malformedTopicOwner, 'malformed extra-key topic');
  assertNoSolProvenance(malformedTopicOut, 'malformed extra-key topic');
  await stopFake(malformedTopicFake);

  const nonAllowlistedFake = await startFakeHermes(signedPlanResponder({
    acts: [{ act: 'thank_guest' }, { act: 'ask_clarifying_question', topic: 'maria' }],
  }));
  const nonAllowlistedOwner = makeOwner({
    env: hermesEnv(nonAllowlistedFake.port),
    contentText: 'Please tell maria about surfing',
    rows: [leftoverRow({
      subject: LIVE_SUBJECT,
      body_text: '',
      from_display_name: 'Guest',
      from_address: 'guest@example.test',
    })],
  });
  const nonAllowlistedProduced = await nonAllowlistedOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assert.equal(nonAllowlistedProduced.status, 'draft_ready');
  assert.doesNotMatch(nonAllowlistedProduced.draft_text, /maria/i);
  assert.match(nonAllowlistedProduced.draft_text, /surf|testing|front desk|mailbox/i);
  assertTransformedPlanProvenance(nonAllowlistedProduced, 'non-allowlisted maria topic');
  await stopFake(nonAllowlistedFake);
  console.log('  PASS  malformed/non-allowlisted Sol topics cannot bypass allowlist or keep HMAC');

  const wsHitsBefore = fake.hits.length;
  const wsOwner = makeOwner({ env });
  const wsProduced = await wsOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: ' \n\t  ',
  });
  assert.equal(wsProduced.status, 'draft_ready');
  assertThreadSpecific(wsProduced.draft_text, content(), 'whitespace notes leftover');
  assert.equal(fake.hits.length, wsHitsBefore + 1, 'whitespace notes must invoke Hermes');
  assertNoSideEffects(wsOwner, 'whitespace leftover');
  console.log('  PASS  whitespace-only notes replace leftover and invoke Hermes');

  const esHitsBefore = fake.hits.length;
  const esOwner = makeOwner({
    env,
    contentText: ES_BODY,
    rows: [leftoverRow({
      subject: ES_SUBJECT,
      staff_reply_draft: LIVE_LEFTOVER_ES,
      conversation_metadata: {
        luna_email_open_draft: {
          state: 'ready',
          origin: 'luna',
          source_inbound_event_id: M,
          generated_body_sha256: crypto.createHash('sha256').update(LIVE_LEFTOVER_ES, 'utf8').digest('hex'),
        },
      },
    })],
  });
  const esProduced = await esOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assert.equal(esProduced.status, 'draft_ready');
  assert.equal(esProduced.draft_text.slice(0, 5), 'Hola,');
  assertByteDifferent(esProduced.draft_text, LIVE_LEFTOVER_ES, 'ES leftover');
  assertThreadSpecific(esProduced.draft_text, { subject: ES_SUBJECT, body_text: ES_BODY }, 'ES empty notes');
  assert.equal(fake.hits.length, esHitsBefore + 1);
  assert.equal(fake.parsedHits.at(-1).language, 'es');
  assert.equal(fake.parsedHits.at(-1).untrusted_email.body_text, ES_BODY);
  assertNoSideEffects(esOwner, 'ES leftover');
  console.log('  PASS  ES leftover is replaced with locale-correct thread-specific draft');

  const notesHitsBefore = fake.hits.length;
  const notesFake = await startFakeHermes(async ({ req, res, parsed, seen }) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401); res.end(JSON.stringify({ error: 'unauthorized' })); return;
    }
    if (!parsed.ok) {
      res.writeHead(400); res.end(JSON.stringify({ error: parsed.reason })); return;
    }
    if (seen.has(parsed.value.request_id)) {
      res.writeHead(409); res.end(JSON.stringify({ error: 'replay' })); return;
    }
    seen.add(parsed.value.request_id);
    const provenance = provenanceFrom(parsed.value);
    const plan = { acts: [{ act: 'thank_guest' }, { act: 'ask_booking_interest' }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      schema: HERMES_SOL_RESULT_SCHEMA,
      acts: plan.acts,
      provenance,
      authenticity: signResultAuthenticity(HMAC_SECRET, parsed.value, provenance, plan),
    }));
  });
  const notesEnv = hermesEnv(notesFake.port);
  const notesOwner = makeOwner({ env: notesEnv });
  const notesProduced = await notesOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: LIVE_NOTES,
  });
  assert.equal(notesProduced.status, 'draft_ready');
  assert.equal(notesProduced.draft_text, LIVE_EN_NOTES_BODY);
  assert.equal(notesProduced.draft_text.includes(LIVE_NOTES), false);
  assertByteDifferent(notesProduced.draft_text, LIVE_LEFTOVER_EN, 'non-empty notes leftover');
  assert.equal(notesFake.hits.length, 1);
  assert.equal(notesFake.parsedHits[0].private_staff_goals.goals, LIVE_NOTES);
  assertNoSideEffects(notesOwner, 'notes path leftover');
  await stopFake(notesFake);
  console.log('  PASS  non-empty notes still author from goals and replace leftover');
  assert.equal(fake.hits.length, notesHitsBefore, 'notes-path fake is separate');

  const author = createEmailLunaCreateDraftNaturalAuthor({
    callModel: async () => JSON.stringify(GENERIC_LEFTOVER_PLAN),
  });
  const authoredThank = await author.authorNaturalGuestReply({
    authority: authority(),
    untrusted_email: content(),
    private_staff_goals: THANK_FOLLOWUP_NOTES,
  });
  assert.equal(authoredThank.status, 'draft_ready');
  assert.equal(authoredThank.body, THANK_FOLLOWUP_EN_BODY);
  assert.equal(authoredThank.body.includes(THANK_FOLLOWUP_NOTES), false);
  assert.doesNotMatch(authoredThank.body, /\bthank them\b/i);
  assertNoSend(authoredThank, 'author thank+followup notes');
  const authoredEmpty = await author.authorNaturalGuestReply({
    authority: authority(),
    untrusted_email: content(),
    private_staff_goals: '',
  });
  assert.equal(authoredEmpty.status, 'draft_ready');
  assertThreadSpecific(authoredEmpty.body, content(), 'author empty notes still refines wrapper');
  const authoredWs = await author.authorNaturalGuestReply({
    authority: authority(),
    untrusted_email: content(),
    private_staff_goals: ' \n\t  ',
  });
  assert.equal(authoredWs.status, 'draft_ready');
  assertThreadSpecific(authoredWs.body, content(), 'author whitespace notes still refines wrapper');
  console.log('  PASS  non-empty thank+followup notes stay draft_ready; empty/whitespace still refine');

  const thankHitsBefore = fake.hits.length;
  const thankOwner = makeOwner({ env });
  const thankProduced = await thankOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: THANK_FOLLOWUP_NOTES,
  });
  assert.equal(thankProduced.status, 'draft_ready');
  assert.equal(thankProduced.draft_text, THANK_FOLLOWUP_EN_BODY);
  assert.equal(thankProduced.draft_text.includes(THANK_FOLLOWUP_NOTES), false);
  assert.doesNotMatch(thankProduced.draft_text, /\bthank them\b/i);
  assertNoSend(thankProduced, 'producer thank+followup notes');
  assert.equal(fake.hits.length, thankHitsBefore + 1, 'thank+followup notes must invoke authenticated Hermes once');
  assert.equal(fake.hits.at(-1).url, HERMES_SOL_DRAFT_PATH);
  assert.equal(fake.hits.at(-1).auth, 'bearer');
  assert.equal(
    fake.parsedHits.at(-1).private_staff_goals.goals,
    extractPermittedOperatorGuidance(THANK_FOLLOWUP_NOTES),
  );
  assert.ok(extractPermittedOperatorGuidance(THANK_FOLLOWUP_NOTES).trim());
  assert.equal(thankOwner.writes.length, 1);
  assert.equal(thankOwner.store.draft, THANK_FOLLOWUP_EN_BODY);
  assert.equal(thankOwner.casRejected.length, 0);
  assertCreateDraftSql(thankOwner, 'producer thank+followup notes');
  assert.equal(thankProduced.marker.provider, HERMES_SOL_PROVIDER);
  assert.equal(thankProduced.marker.model, HERMES_SOL_MODEL);
  assert.equal(thankProduced.marker.runtime, HERMES_SOL_RUNTIME);
  assert.equal(thankProduced.authenticity.hmac_verified, true);
  assertNoSideEffects(thankOwner, 'producer thank+followup notes');
  console.log('  PASS  producer non-empty thank+followup notes remain draft_ready via CAS, no paste');

  const thankRouteSent = [];
  const thankRouteOwner = makeOwner({ env });
  const thankRoute = createStaffEmailLunaDraftRoute({
    sendJSON(_res, status, body) { thankRouteSent.push({ status, body }); return body; },
    runtimeEnv: env,
    withPgClient: async (fn) => fn({ query: async () => ({ rows: [] }) }),
    createLunaRuntime() { throw new Error('route must use existing producer'); },
    saveDraftThroughStaffOwner() { throw new Error('must not create approval'); },
    approveDraft: (...args) => thankRouteOwner.approvals.push(args),
    appendOutboundJournal: (...args) => thankRouteOwner.journals.push(args),
    callProvider: (...args) => thankRouteOwner.providers.push(args),
    regenerateEmailLunaDraftOnStaffClick: (input) => (
      thankRouteOwner.owner.regenerateEmailLunaDraftOnStaffClick(input)
    ),
  });
  const thankRouteHitsBefore = fake.hits.length;
  await thankRoute.handleCreateDraft(
    request({ conversation_id: V, context: THANK_FOLLOWUP_NOTES }),
    {},
    actor(),
    snapshotEmailLunaGenerateGateEnv(env),
  );
  const thankRouted = thankRouteSent.at(-1);
  assert.equal(thankRouted.status, 200);
  assert.equal(thankRouted.body.success, true);
  assert.equal(thankRouted.body.message_text, THANK_FOLLOWUP_EN_BODY);
  assert.equal(thankRouted.body.message_text.includes(THANK_FOLLOWUP_NOTES), false);
  assert.equal(Object.prototype.hasOwnProperty.call(thankRouted.body, 'approval_id'), false);
  assert.equal(EMAIL_LUNA_CREATE_DRAFT_PATH, '/staff/inbox/email/create-draft');
  assert.equal(fake.hits.length, thankRouteHitsBefore + 1, 'Create Draft route thank+followup invokes Hermes once');
  assert.equal(fake.hits.at(-1).auth, 'bearer');
  assert.equal(thankRouteOwner.writes.length, 1);
  assertCreateDraftSql(thankRouteOwner, 'Create Draft route thank+followup notes');
  assertNoSideEffects(thankRouteOwner, 'Create Draft route thank+followup notes');
  console.log('  PASS  Staff handleCreateDraft thank+followup notes remain draft_ready, no approval_id');

  async function produceEmptyTopicCase(label, rowPatch, bodyText, thread, expectTopic) {
    const caseOwner = makeOwner({
      env,
      contentText: bodyText,
      rows: [leftoverRow(rowPatch)],
    });
    const hitsBefore = fake.hits.length;
    const produced = await caseOwner.owner.regenerateEmailLunaDraftOnStaffClick({
      actor: actor(),
      conversation_id: V,
      operator_context: '',
    });
    assert.equal(produced.status, 'draft_ready', label);
    assertNoSend(produced, label);
    assertByteDifferent(produced.draft_text, LIVE_LEFTOVER_EN, label);
    assert.notEqual(produced.draft_text, LIVE_LEFTOVER_ES, label);
    assertNoPiiOrNumericEcho(produced.draft_text, label);
    if (expectTopic) {
      assertThreadSpecific(produced.draft_text, thread, label);
    } else {
      assert.equal(produced.draft_text, LOW_CLAIM_FALLBACK_EN, `${label}: no-safe-topic fallback`);
      assert.notEqual(produced.draft_text, SAFE_ACKNOWLEDGMENT.en, label);
    }
    assert.equal(fake.hits.length, hitsBefore + 1, `${label}: Hermes once`);
    assertCreateDraftSql(caseOwner, label);
    assertNoSideEffects(caseOwner, label);
    return produced;
  }

  await produceEmptyTopicCase(
    'John Smith guest name',
    {
      subject: LIVE_SUBJECT,
      from_display_name: 'John Smith',
      from_address: 'john.smith@example.test',
    },
    'Hi, I am John Smith writing about the mailbox.',
    johnThread,
    true,
  );
  await produceEmptyTopicCase(
    'twoods@xantrion.com address fragments',
    {
      subject: LIVE_SUBJECT,
      from_display_name: 'Tyler Woods',
      from_address: 'twoods@xantrion.com',
    },
    'Please reply to twoods@xantrion.com about the mailbox.',
    emailThread,
    true,
  );
  const testingSubjectProduced = await produceEmptyTopicCase(
    'Re: Testing 8 26',
    {
      subject: LIVE_SUBJECT,
      from_display_name: 'John Smith',
      from_address: 'twoods@xantrion.com',
    },
    LIVE_BODY,
    content(),
    true,
  );
  assert.match(testingSubjectProduced.draft_text, /front desk|testing|mailbox/i);
  await produceEmptyTopicCase(
    'numeric/date-only body with testing subject',
    {
      subject: LIVE_SUBJECT,
      from_display_name: 'John Smith',
      from_address: 'twoods@xantrion.com',
    },
    '08/26/2026',
    dateBodyThread,
    true,
  );
  await produceEmptyTopicCase(
    'numeric/date-only subject and body',
    {
      subject: '8 26',
      from_display_name: 'John Smith',
      from_address: 'twoods@xantrion.com',
    },
    '08/26/2026 555-0100',
    numericOnlyThread,
    false,
  );

  const mariaNameProduced = await produceEmptyTopicCase(
    'My name is maria',
    {
      subject: LIVE_SUBJECT,
      from_display_name: 'Guest',
      from_address: 'guest@example.test',
    },
    'My name is maria',
    mariaNameThread,
    true,
  );
  assert.match(mariaNameProduced.draft_text, /front desk|testing|mailbox/i);
  const mariaSurfProduced = await produceEmptyTopicCase(
    'Please tell maria about surfing',
    {
      subject: LIVE_SUBJECT,
      from_display_name: 'Guest',
      from_address: 'guest@example.test',
    },
    'Please tell maria about surfing',
    mariaSurfThread,
    true,
  );
  assert.match(mariaSurfProduced.draft_text, /surf|testing|front desk|mailbox/i);
  const surfOnlyProduced = await produceEmptyTopicCase(
    'Please tell maria about surfing without testing subject',
    {
      subject: 'Hello',
      from_display_name: 'Guest',
      from_address: 'guest@example.test',
    },
    'Please tell maria about surfing',
    surfOnlyThread,
    true,
  );
  assert.match(surfOnlyProduced.draft_text, /surf/i);
  const carlosProducedOwner = makeOwner({
    env,
    contentText: carlosThread.body_text,
    rows: [leftoverRow({
      subject: ES_SUBJECT,
      from_display_name: 'Guest',
      from_address: 'guest@example.test',
      staff_reply_draft: LIVE_LEFTOVER_ES,
      conversation_metadata: {
        luna_email_open_draft: {
          state: 'ready',
          origin: 'luna',
          source_inbound_event_id: M,
          generated_body_sha256: crypto.createHash('sha256').update(LIVE_LEFTOVER_ES, 'utf8').digest('hex'),
        },
      },
    })],
  });
  const carlosHitsBefore = fake.hits.length;
  const carlosProduced = await carlosProducedOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assert.equal(carlosProduced.status, 'draft_ready');
  assertByteDifferent(carlosProduced.draft_text, LIVE_LEFTOVER_ES, 'Soy carlos leftover');
  assertByteDifferent(carlosProduced.draft_text, LIVE_LEFTOVER_EN, 'Soy carlos leftover EN');
  assert.doesNotMatch(carlosProduced.draft_text, /carlos/i);
  assert.match(carlosProduced.draft_text, /prueba/i);
  assertNoPiiOrNumericEcho(carlosProduced.draft_text, 'Soy carlos');
  assert.equal(fake.hits.length, carlosHitsBefore + 1);
  assertCreateDraftSql(carlosProducedOwner, 'Soy carlos');
  assertNoSideEffects(carlosProducedOwner, 'Soy carlos');
  const luciaOwner = makeOwner({
    env,
    contentText: luciaBoardsThread.body_text,
    rows: [leftoverRow({
      subject: ES_SUBJECT,
      from_display_name: 'Guest',
      from_address: 'guest@example.test',
      staff_reply_draft: LIVE_LEFTOVER_ES,
      conversation_metadata: {
        luna_email_open_draft: {
          state: 'ready',
          origin: 'luna',
          source_inbound_event_id: M,
          generated_body_sha256: crypto.createHash('sha256').update(LIVE_LEFTOVER_ES, 'utf8').digest('hex'),
        },
      },
    })],
  });
  const luciaHitsBefore = fake.hits.length;
  const luciaProduced = await luciaOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assert.equal(luciaProduced.status, 'draft_ready');
  assert.equal(luciaProduced.draft_text.slice(0, 5), 'Hola,');
  assert.doesNotMatch(luciaProduced.draft_text, /lucia|lucía/i);
  assert.match(luciaProduced.draft_text, /tabla|prueba|surf/i);
  assertNoPiiOrNumericEcho(luciaProduced.draft_text, 'pregunta para lucia sobre tablas');
  assert.equal(fake.hits.length, luciaHitsBefore + 1);
  assertCreateDraftSql(luciaOwner, 'pregunta para lucia sobre tablas');
  assertNoSideEffects(luciaOwner, 'pregunta para lucia sobre tablas');
  console.log('  PASS  unpaired/lowercase names never become guest copy');

  const authorUnsafe = createEmailLunaCreateDraftNaturalAuthor({
    callModel: async () => JSON.stringify({
      acts: [{ act: 'thank_guest' }, { act: 'ask_clarifying_question', topic: 'maria' }],
    }),
  });
  const authoredMaria = await authorUnsafe.authorNaturalGuestReply({
    authority: authority(),
    untrusted_email: mariaNameThread,
    private_staff_goals: '',
  });
  assert.equal(authoredMaria.status, 'draft_ready');
  assert.equal(authoredMaria.local_replacement, true);
  assert.doesNotMatch(authoredMaria.body, /maria/i);
  assert.match(authoredMaria.body, /front desk|testing|mailbox/i);
  const authoredSurf = await authorUnsafe.authorNaturalGuestReply({
    authority: authority(),
    untrusted_email: mariaSurfThread,
    private_staff_goals: '',
  });
  assert.equal(authoredSurf.status, 'draft_ready');
  assert.equal(authoredSurf.local_replacement, true);
  assert.doesNotMatch(authoredSurf.body, /maria/i);
  assert.match(authoredSurf.body, /surf|testing|front desk|mailbox/i);
  const authoredSurfOnly = await authorUnsafe.authorNaturalGuestReply({
    authority: authority(),
    untrusted_email: surfOnlyThread,
    private_staff_goals: '',
  });
  assert.equal(authoredSurfOnly.status, 'draft_ready');
  assert.doesNotMatch(authoredSurfOnly.body, /maria/i);
  assert.match(authoredSurfOnly.body, /surf/i);
  const authorAllowlisted = createEmailLunaCreateDraftNaturalAuthor({
    callModel: async () => JSON.stringify({
      acts: [{ act: 'thank_guest' }, { act: 'ask_clarifying_question', topic: 'testing' }],
    }),
  });
  const authoredTesting = await authorAllowlisted.authorNaturalGuestReply({
    authority: authority(),
    untrusted_email: content(),
    private_staff_goals: '',
  });
  assert.equal(authoredTesting.status, 'draft_ready');
  assert.equal(authoredTesting.local_replacement, undefined);
  assert.match(authoredTesting.body, /testing/i);

  const spanishNameOwner = makeOwner({
    env,
    contentText: spanishNameThread.body_text,
    rows: [leftoverRow({
      subject: ES_SUBJECT,
      from_display_name: 'María García',
      from_address: 'maria.garcia@example.test',
      staff_reply_draft: LIVE_LEFTOVER_ES,
      conversation_metadata: {
        luna_email_open_draft: {
          state: 'ready',
          origin: 'luna',
          source_inbound_event_id: M,
          generated_body_sha256: crypto.createHash('sha256').update(LIVE_LEFTOVER_ES, 'utf8').digest('hex'),
        },
      },
    })],
  });
  const spanishNameHitsBefore = fake.hits.length;
  const spanishNameProduced = await spanishNameOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assert.equal(spanishNameProduced.status, 'draft_ready');
  assertNoSend(spanishNameProduced, 'Spanish names');
  assert.equal(spanishNameProduced.draft_text.slice(0, 5), 'Hola,');
  assertByteDifferent(spanishNameProduced.draft_text, LIVE_LEFTOVER_ES, 'Spanish names leftover');
  assertThreadSpecific(spanishNameProduced.draft_text, spanishNameThread, 'Spanish names');
  assertNoPiiOrNumericEcho(spanishNameProduced.draft_text, 'Spanish names');
  assert.equal(fake.hits.length, spanishNameHitsBefore + 1);
  assertCreateDraftSql(spanishNameOwner, 'Spanish names');
  assertNoSideEffects(spanishNameOwner, 'Spanish names');
  console.log('  PASS  empty Create Draft does not echo names, addresses, or numeric tokens');

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
  assertThreadSpecific(routed.body.message_text, content(), 'Create Draft route leftover');
  assert.equal(Object.prototype.hasOwnProperty.call(routed.body, 'approval_id'), false);
  assert.equal(EMAIL_LUNA_CREATE_DRAFT_PATH, '/staff/inbox/email/create-draft');
  assertCreateDraftSql(routeOwner, 'Create Draft route leftover');
  assertNoSideEffects(routeOwner, 'Create Draft route leftover');
  console.log('  PASS  Staff Create Draft route empty notes replaces leftover, no approval_id');

  const staleOwner = makeOwner({
    env,
    rows: [leftoverRow({ client_id: '11111111-1111-4111-8111-111111111112' })],
  });
  const staleOut = await staleOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assert.equal(staleOut.status, 'pending');
  assert.equal(staleOwner.writes.length, 0);
  assert.equal(staleOwner.store.draft, LIVE_LEFTOVER_EN);
  assertNoSideEffects(staleOwner, 'stale selection');
  console.log('  PASS  stale/selection authority mismatch fail-closes without overwrite');

  const wrongConv = await route.handleCreateDraft(
    request({ conversation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', context: '' }),
    {},
    actor(),
    snapshotEmailLunaGenerateGateEnv(env),
  );
  assert.ok(routeSent.at(-1).status === 503 || routeSent.at(-1).status === 404 || wrongConv);
  assert.equal(routeOwner.store.draft !== LIVE_LEFTOVER_EN, true, 'prior successful route already replaced');
  console.log('  PASS  untrusted extra conversation id cannot rewrite the leftover thread');

  await route.handleCreateDraft(
    request({ conversation_id: V, context: '', thread_text: 'FORGED GUEST TEXT', tenant_id: 'wolfhouse' }),
    {},
    actor(),
    snapshotEmailLunaGenerateGateEnv(env),
  );
  assert.equal(routeSent.at(-1).status, 400, 'untrusted extra browser fields must not be accepted');
  console.log('  PASS  Create Draft rejects untrusted extra thread/tenant browser fields');

  const openOwner = makeOwner({
    env,
    rows: [leftoverRow({ needs_human: true })],
  });
  const opened = await openOwner.owner.ensureEmailLunaDraftOnOpen({
    actor: actor(),
    conversation_id: V,
  });
  assert.equal(opened.status, 'draft_ready');
  assert.equal(opened.draft_text, LIVE_LEFTOVER_EN, 'generate-on-open may keep luna-owned leftover');
  assert.equal(openOwner.writes.length, 0);
  assertNoSideEffects(openOwner, 'generate-on-open leftover');
  console.log('  PASS  generate-on-open still skips existing luna leftover (explicit click does not)');

  await stopFake(fake);

  const mismatch = await startFakeHermes(async ({ res, raw }) => {
    const parsed = parseDraftPlanRequest(raw);
    const prov = provenanceFrom(parsed.value);
    prov.provider = 'openai';
    prov.model = 'gpt-4o-mini';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      schema: HERMES_SOL_RESULT_SCHEMA,
      acts: [{ act: 'thank_guest' }, { act: 'ask_clarifying_question', topic: 'testing' }],
      provenance: prov,
    }));
  });
  const mismatchOwner = makeOwner({ env: hermesEnv(mismatch.port) });
  const rejected = await mismatchOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assertFailClosed(rejected, mismatchOwner, 'forged provider/model leftover');
  await stopFake(mismatch);
  console.log('  PASS  Sol provenance mismatch fail-closes and keeps leftover');

  const downEnv = hermesEnv(1);
  const unavailableOwner = makeOwner({ env: downEnv });
  const unavailableDraft = await unavailableOwner.owner.regenerateEmailLunaDraftOnStaffClick({
    actor: actor(),
    conversation_id: V,
    operator_context: '',
  });
  assert.equal(unavailableDraft.status, 'draft_ready');
  assertThreadSpecific(unavailableDraft.draft_text, content(), 'unavailable leftover compile');
  assert.equal(unavailableOwner.writes.length, 1);
  assertNoSideEffects(unavailableOwner, 'unavailable leftover');
  console.log('  PASS  Hermes unavailable compiles a thread-specific plan, not the leftover wrapper');

  const pkg = JSON.parse(readFile('package.json'));
  assert.equal(pkg.scripts['verify:mail-mvp-007-sol-empty-fix'], 'node scripts/verify-mail-mvp-007-sol-empty-fix.js');
  assert.equal(pkg.scripts['verify:mail-mvp-007-sol-empty'], 'node scripts/verify-mail-mvp-007-sol-empty.js');
  assert.equal(pkg.scripts['verify:mail-mvp-007'], 'node scripts/verify-email-luna-sunset-email-hermes-sol.js');

  for (const rel of [
    'scripts/lib/email-luna-create-draft-natural-author.js',
    'scripts/verify-mail-mvp-007-sol-empty-fix.js',
  ]) {
    const checked = spawnSync(process.execPath, ['--check', rel], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr || rel);
  }

  const docs = readFile('docs/MAIL-MVP.md');
  assert.match(docs, /thread-specific/);
  assert.match(docs, /allowlist/);
  assert.doesNotMatch(docs, /Empty notes stay the safe thread-only draft/);

  console.log('PASS MAIL-MVP-007-SOL-EMPTY-FIX leftover empty Create Draft invokes Sol and replaces wrapper');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
