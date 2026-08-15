'use strict';

/**
 * EMAIL-DRAFT-OPEN-002 — focused RED→GREEN.
 *
 * When a genuine Microsoft inbound is successfully attached to the
 * authoritative Sunset Inbox conversation through the inbound Inbox
 * bridge, that conversation must read needs_human=true so the already-live
 * generate-on-open producer can persist the safe no-claims draft on first
 * staff open.
 *
 * Canonical write: email-inbound-inbox-bridge SQL_UPSERT_CONVERSATION.
 * No Inbox chrome, no Generate POST, no outbound, no live mail.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const BRIDGE_REL = 'scripts/lib/email-inbound-inbox-bridge.js';
const BRIDGE_PATH = path.join(ROOT, BRIDGE_REL);
const POLICY_PATH = path.join(ROOT, 'scripts/lib/email-luna-draft-open-policy-composition.js');
const GENERATE_ROUTE_PATH = path.join(ROOT, 'scripts/lib/staff-email-luna-draft-route.js');
const OPEN_OWNER_PATH = path.join(ROOT, 'scripts/lib/staff-email-luna-draft-open.js');
const THREAD_PATH = path.join(ROOT, 'scripts/browser/inbox-thread.js');
const PKG = path.join(ROOT, 'package.json');

const {
  SAFE_ACKNOWLEDGMENT,
} = require('./lib/email-luna-draft-open-policy-composition');
const {
  resolveInboundMatchConversationIdentity,
} = require('./lib/email-inbound-match-ingest');

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIENT_OTHER = '99999999-9999-4999-8999-999999999999';
const LOCATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVENT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const EVENT_ID_2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const EXISTING_CONV = '12121212-1212-4121-8121-121212121212';
const OTHER_CONV = '34343434-3434-4343-8343-343434343434';
const MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const PLANTED_SUBJECT = 'SUBJECT_PII_MUST_NOT_APPEAR_DRAFT_OPEN_002';
const PLANTED_ADDRESS = 'pii-draft-open-002@example.com';

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

function loadBridge() {
  delete require.cache[require.resolve('./lib/email-inbound-inbox-bridge')];
  return require('./lib/email-inbound-inbox-bridge');
}

function eventRow(overrides = {}) {
  return {
    id: EVENT_ID,
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    provider: 'microsoft_graph',
    provider_mailbox_id: MAILBOX,
    provider_message_id: 'msg-draft-open-002',
    received_at: '2026-08-15T12:00:00.000Z',
    subject: PLANTED_SUBJECT,
    sender_display_name: 'Guest Sender',
    sender_address: PLANTED_ADDRESS,
    is_read: false,
    conversation_id: 'graph-thread-002',
    internet_message_id: '<draft-open-002@example.com>',
    ...overrides,
  };
}

function authority(overrides = {}) {
  return {
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    ...overrides,
  };
}

function conversationPhone(fromAddress, mailbox) {
  const resolved = resolveInboundMatchConversationIdentity({
    providerMailboxId: mailbox || MAILBOX,
    fromAddress,
  });
  assert.ok(resolved && resolved.conversation_key, 'canonical conversation key required');
  return resolved.conversation_key;
}

function createHarness(options = {}) {
  const events = options.events || new Map();
  const locations = options.locations || new Map([
    [`${CLIENT}\0${LOCATION}`, { client_id: CLIENT, id: LOCATION, location_id: 'sunset-somo' }],
    [`${CLIENT_OTHER}\0${LOCATION}`, { client_id: CLIENT_OTHER, id: LOCATION, location_id: 'sunset-somo' }],
  ]);
  const conversations = options.conversations || new Map();
  const messages = options.messages || new Map();
  const projections = options.projections || new Map();
  const log = [];
  let uuidSeq = 0;
  let failOn = null;
  let commitMode = null;

  function nextUuid(prefix) {
    uuidSeq += 1;
    const n = String(uuidSeq).padStart(12, '0');
    return `${prefix}${n.slice(0, 8)}-${n.slice(0, 4)}-4${n.slice(0, 3)}-8${n.slice(0, 3)}-${n}`;
  }

  function projKey(provider, mailbox, messageId) {
    return `${provider}\0${mailbox}\0${messageId}`;
  }

  function convKey(clientId, phone) {
    return `${clientId}\0${phone}`;
  }

  function applyNeedsHuman(sql, params, existing) {
    if (!/\bneeds_human\b/.test(sql)) {
      return existing ? existing.needs_human === true : false;
    }
    const excluded = params[10] === true;
    if (existing) return excluded ? true : existing.needs_human === true;
    return excluded;
  }

  async function withTransactionClient(work) {
    let inTx = false;
    const stagedConv = new Map();
    const stagedMsg = new Map();
    const stagedProj = new Map();

    const client = {
      async query(sql, params) {
        const norm = String(sql).replace(/\s+/g, ' ').trim();
        log.push({ sql: norm, params: params ? params.slice() : null });
        if (failOn && failOn(norm, params, { inTx })) {
          throw new Error('planted_db_failure');
        }
        if (norm === 'BEGIN') {
          if (inTx) throw new Error('nested_begin');
          inTx = true;
          stagedConv.clear();
          stagedMsg.clear();
          stagedProj.clear();
          return { rows: [], rowCount: 0 };
        }
        if (norm === 'COMMIT') {
          if (!inTx) throw new Error('commit_without_begin');
          if (commitMode === 'reject_before_apply') throw new Error('planted_commit_reject');
          for (const [k, v] of stagedConv) conversations.set(k, v);
          for (const [k, v] of stagedMsg) messages.set(k, v);
          for (const [k, v] of stagedProj) projections.set(k, v);
          stagedConv.clear();
          stagedMsg.clear();
          stagedProj.clear();
          inTx = false;
          return { rows: [], rowCount: 0 };
        }
        if (norm === 'ROLLBACK') {
          stagedConv.clear();
          stagedMsg.clear();
          stagedProj.clear();
          inTx = false;
          return { rows: [], rowCount: 0 };
        }

        if (/FROM tenant_email_inbound_events/.test(norm) && /e\.id\s*=\s*\$4::uuid/.test(norm)) {
          const [clientId, locationId, endpointId, eventId] = params;
          const ev = events.get(eventId);
          if (
            ev
            && ev.client_id === clientId
            && ev.location_id === locationId
            && ev.endpoint_id === endpointId
          ) {
            return { rows: [Object.assign({}, ev)], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }

        if (
          /FROM tenant_email_inbound_events/.test(norm)
          && /provider_message_id\s*=\s*\$6/.test(norm)
        ) {
          const [clientId, locationId, endpointId, provider, mailbox, messageId] = params;
          for (const ev of events.values()) {
            if (
              ev.client_id === clientId
              && ev.location_id === locationId
              && ev.endpoint_id === endpointId
              && ev.provider === provider
              && ev.provider_mailbox_id === mailbox
              && ev.provider_message_id === messageId
            ) {
              return { rows: [Object.assign({}, ev)], rowCount: 1 };
            }
          }
          return { rows: [], rowCount: 0 };
        }

        if (/FROM tenant_email_inbound_inbox_projections/.test(norm)
            && /provider_message_id/.test(norm)
            && /SELECT/.test(norm)) {
          const [clientId, provider, mailbox, messageId] = params;
          const k = projKey(provider, mailbox, messageId);
          const row = projections.get(k) || stagedProj.get(k);
          if (row && row.client_id === clientId) {
            return { rows: [Object.assign({}, row)], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }

        if (/FROM tenant_locations/.test(norm)) {
          const [clientId, locationUuid] = params;
          const loc = locations.get(`${clientId}\0${locationUuid}`);
          if (loc) return { rows: [{ location_id: loc.location_id }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }

        if (/FROM guests/.test(norm)) return { rows: [], rowCount: 0 };

        if (/^UPDATE conversations/.test(norm) && /guest_id/.test(norm)) {
          return { rows: [], rowCount: 0 };
        }

        if (/^INSERT INTO conversations/.test(norm)) {
          const [
            clientId, phone, displayName, email, status, botMode, stage,
            preview, metadataJson, sessionJson,
          ] = params;
          const k = convKey(clientId, phone);
          const existing = conversations.get(k) || stagedConv.get(k);
          const meta = typeof metadataJson === 'string' ? JSON.parse(metadataJson) : metadataJson;
          const session = typeof sessionJson === 'string' ? JSON.parse(sessionJson) : sessionJson;
          const needsHuman = applyNeedsHuman(norm, params, existing);
          if (existing) {
            const next = {
              ...existing,
              display_name: existing.display_name || displayName,
              email: existing.email || email,
              last_message_preview: preview,
              metadata: { ...existing.metadata, ...meta },
              session_state: { ...existing.session_state, ...session },
              needs_human: needsHuman,
              updated_at: 'now',
            };
            stagedConv.set(k, next);
            return { rows: [{ conversation_id: existing.id, created: false }], rowCount: 1 };
          }
          const id = nextUuid('c');
          const row = {
            id,
            client_id: clientId,
            phone,
            display_name: displayName,
            email,
            status,
            bot_mode: botMode,
            conversation_stage: stage,
            last_message_preview: preview,
            metadata: meta,
            session_state: session,
            needs_human: needsHuman,
          };
          stagedConv.set(k, row);
          return { rows: [{ conversation_id: id, created: true }], rowCount: 1 };
        }

        if (/^INSERT INTO messages/.test(norm)) {
          const [
            clientId, conversationId, direction, messageText, messageType,
            source, route, metadataJson,
          ] = params;
          const id = nextUuid('m');
          const row = {
            id,
            client_id: clientId,
            conversation_id: conversationId,
            direction,
            message_text: messageText,
            message_type: messageType,
            source,
            route,
            metadata: typeof metadataJson === 'string' ? JSON.parse(metadataJson) : metadataJson,
          };
          stagedMsg.set(id, row);
          return { rows: [{ message_id: id }], rowCount: 1 };
        }

        if (/^INSERT INTO tenant_email_inbound_inbox_projections/.test(norm)) {
          const [
            clientId, locationId, endpointId, inboundEventId,
            provider, mailbox, messageId, conversationId, messageUuid,
          ] = params;
          const k = projKey(provider, mailbox, messageId);
          if (projections.has(k) || stagedProj.has(k)) {
            return { rows: [], rowCount: 0 };
          }
          const row = {
            id: nextUuid('p'),
            client_id: clientId,
            location_id: locationId,
            endpoint_id: endpointId,
            inbound_event_id: inboundEventId,
            provider,
            provider_mailbox_id: mailbox,
            provider_message_id: messageId,
            conversation_id: conversationId,
            message_id: messageUuid,
          };
          stagedProj.set(k, row);
          return { rows: [{ id: row.id }], rowCount: 1 };
        }

        throw new Error(`unexpected sql: ${norm.slice(0, 120)}`);
      },
    };

    try {
      return await work(client);
    } finally {
      stagedConv.clear();
      stagedMsg.clear();
      stagedProj.clear();
      inTx = false;
    }
  }

  return {
    withTransactionClient,
    events,
    locations,
    conversations,
    messages,
    projections,
    log,
    setFailOn(fn) { failOn = fn; },
    setCommitMode(mode) { commitMode = mode; },
  };
}

function storeFor(bridge, harness) {
  return bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));
}

function soleConversation(harness, clientId) {
  const rows = [...harness.conversations.values()].filter((row) => row.client_id === clientId);
  assert.equal(rows.length, 1, 'exactly one conversation for tenant');
  return rows[0];
}

function assertStaticBoundary() {
  const bridge = loadBridge();
  const src = fs.readFileSync(BRIDGE_PATH, 'utf8');
  const openSrc = fs.readFileSync(OPEN_OWNER_PATH, 'utf8');
  const generateSrc = fs.readFileSync(GENERATE_ROUTE_PATH, 'utf8');
  const threadSrc = fs.readFileSync(THREAD_PATH, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));

  assert.equal(
    pkg.scripts['verify:email-draft-open-002'],
    'node scripts/verify-email-draft-open-002.js',
  );

  assert.match(bridge.SQL_UPSERT_CONVERSATION, /\bneeds_human\b/);
  assert.match(
    bridge.SQL_UPSERT_CONVERSATION,
    /needs_human = CASE WHEN EXCLUDED\.needs_human THEN TRUE ELSE conversations\.needs_human END/,
  );
  assert.match(src, /event\.provider === ['"]microsoft_graph['"]/);
  assert.doesNotMatch(src, /gmail_api['"]\s*===|provider === ['"]gmail_api['"]/);
  assert.doesNotMatch(src, /imap_smtp['"]\s*===|provider === ['"]imap_smtp['"]/);

  const upsertIdx = src.indexOf('const SQL_UPSERT_CONVERSATION');
  const alreadyIdx = src.indexOf('// 2) Exactly-once: journal hit → replay without mutation.');
  assert.ok(upsertIdx > 0 && alreadyIdx > 0);
  const alreadyBlock = src.slice(alreadyIdx, src.indexOf('// 3) Require sender', alreadyIdx));
  assert.doesNotMatch(alreadyBlock, /needs_human/);

  assert.doesNotMatch(src, /EMAIL_LUNA_GENERATE_DRAFT_PATH|handleGenerateLunaDraft|staff-email-luna-draft-route/);
  assert.doesNotMatch(src, /inbox-thread\.js|email-google-|sendMail|graph\.microsoft\.com/);
  assert.doesNotMatch(openSrc, /EMAIL_LUNA_GENERATE_DRAFT_PATH|handleGenerateLunaDraft/);
  assert.match(threadSrc, /id="btn-email-generate-luna-draft" hidden/);
  assert.doesNotMatch(threadSrc, /onload[^\n]{0,160}generate-luna-draft|openConversation[^\n]{0,160}generate-luna-draft/i);
  assert.match(generateSrc, /EMAIL_STAFF_LUNA_DRAFT_ENABLED/);
  assert.match(generateSrc, /isEmailLunaGenerateDraftEnabled/);

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

  for (const rel of FORBIDDEN_TOUCH) {
    assert.equal(src.includes(rel), false, `bridge must not import ${rel}`);
  }
  assert.equal(src.includes('staff-query-api'), false);
  assert.equal(src.includes('inbox-thread'), false);

  console.log('ok - static write boundary, generate POST unused, safe-ack bytes unchanged');
}

async function testMicrosoftAttachSetsNeedsHumanOnNewConversation() {
  const bridge = loadBridge();
  const harness = createHarness();
  const ev = eventRow();
  harness.events.set(ev.id, ev);
  const result = await storeFor(bridge, harness).projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));

  assert.equal(result.status, 'projected');
  assert.equal(result.created_conversation, true);
  const conv = soleConversation(harness, CLIENT);
  assert.equal(conv.needs_human, true);
  assert.equal(conv.client_id, CLIENT);
  assert.ok(String(conv.phone).startsWith('emailv1:'));
  assert.equal(String(conv.phone).toLowerCase().includes(PLANTED_ADDRESS), false);
  const upsert = harness.log.find((entry) => /^INSERT INTO conversations/.test(entry.sql));
  assert.ok(upsert, 'conversation upsert is the write boundary');
  assert.match(upsert.sql, /\bneeds_human\b/);
  assert.equal(upsert.params[10], true);
  console.log('ok - newly attached Microsoft inbound conversation reads needs_human=true');
}

async function testExistingConversationConvergesTrue() {
  const bridge = loadBridge();
  const harness = createHarness();
  const phone = conversationPhone(PLANTED_ADDRESS, MAILBOX);
  harness.conversations.set(`${CLIENT}\0${phone}`, {
    id: EXISTING_CONV,
    client_id: CLIENT,
    phone,
    display_name: 'Existing Guest',
    email: PLANTED_ADDRESS,
    status: 'open',
    bot_mode: 'bot',
    conversation_stage: 'guest_email_inbound',
    last_message_preview: 'old',
    metadata: { channel: 'email', location_id: 'sunset-somo' },
    session_state: { channel: 'email' },
    needs_human: false,
  });
  const ev = eventRow();
  harness.events.set(ev.id, ev);
  const result = await storeFor(bridge, harness).projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));

  assert.equal(result.status, 'projected');
  assert.equal(result.created_conversation, false);
  assert.equal(result.conversation_id, EXISTING_CONV);
  const conv = soleConversation(harness, CLIENT);
  assert.equal(conv.id, EXISTING_CONV);
  assert.equal(conv.needs_human, true);
  console.log('ok - existing conversation converges needs_human=true after Microsoft attach');
}

async function testTenantIsolation() {
  const bridge = loadBridge();
  const harness = createHarness();
  const phone = conversationPhone(PLANTED_ADDRESS, MAILBOX);
  harness.conversations.set(`${CLIENT_OTHER}\0${phone}`, {
    id: OTHER_CONV,
    client_id: CLIENT_OTHER,
    phone,
    display_name: 'Other Tenant',
    email: PLANTED_ADDRESS,
    status: 'open',
    bot_mode: 'bot',
    conversation_stage: 'guest_email_inbound',
    last_message_preview: 'other',
    metadata: { channel: 'email' },
    session_state: { channel: 'email' },
    needs_human: false,
  });
  const ev = eventRow();
  harness.events.set(ev.id, ev);
  const result = await storeFor(bridge, harness).projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));

  assert.equal(result.status, 'projected');
  const ours = soleConversation(harness, CLIENT);
  const other = soleConversation(harness, CLIENT_OTHER);
  assert.equal(ours.needs_human, true);
  assert.equal(other.id, OTHER_CONV);
  assert.equal(other.needs_human, false);
  assert.notEqual(ours.id, other.id);
  console.log('ok - tenant isolation: other client conversation stays needs_human=false');
}

async function testNonMicrosoftProviderDoesNotFlag() {
  const bridge = loadBridge();
  for (const provider of ['gmail_api', 'imap_smtp']) {
    const harness = createHarness();
    const ev = eventRow({
      id: EVENT_ID,
      provider,
      provider_message_id: `msg-${provider}`,
    });
    harness.events.set(ev.id, ev);
    const result = await storeFor(bridge, harness).projectInboundEvent(Object.freeze({
      ...authority(),
      inboundEventId: ev.id,
    }));
    assert.equal(result.status, 'projected', provider);
    const conv = soleConversation(harness, CLIENT);
    assert.equal(conv.needs_human, false, provider);
    const upsert = harness.log.find((entry) => /^INSERT INTO conversations/.test(entry.sql));
    assert.equal(upsert.params[10] === true, false, provider);
  }
  console.log('ok - gmail/imap attach does not set needs_human');
}

async function testFailedAndDuplicateDoNotMutateUnattached() {
  const bridge = loadBridge();

  const missing = createHarness();
  missing.events.set(EVENT_ID, eventRow({ sender_address: null }));
  const rejectedSender = await storeFor(bridge, missing).projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: EVENT_ID,
  }));
  assert.equal(rejectedSender.status, 'rejected');
  assert.equal(missing.conversations.size, 0);

  const mismatch = createHarness();
  mismatch.events.set(EVENT_ID, eventRow());
  const rejectedAuth = await storeFor(bridge, mismatch).projectInboundEvent(Object.freeze({
    clientId: CLIENT_OTHER,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    inboundEventId: EVENT_ID,
  }));
  assert.equal(rejectedAuth.status, 'rejected');
  assert.equal(mismatch.conversations.size, 0);

  const failed = createHarness();
  failed.events.set(EVENT_ID, eventRow());
  failed.setCommitMode('reject_before_apply');
  const uncertain = await storeFor(bridge, failed).projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: EVENT_ID,
  }));
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(failed.conversations.size, 0);

  const planted = createHarness();
  const phone = conversationPhone(PLANTED_ADDRESS, MAILBOX);
  planted.conversations.set(`${CLIENT}\0${phone}`, {
    id: EXISTING_CONV,
    client_id: CLIENT,
    phone,
    display_name: 'Already attached',
    email: PLANTED_ADDRESS,
    needs_human: false,
    metadata: {},
    session_state: {},
  });
  planted.projections.set(`microsoft_graph\0${MAILBOX}\0msg-draft-open-002`, {
    client_id: CLIENT,
    conversation_id: EXISTING_CONV,
    message_id: 'abababab-abab-4aba-8aba-abababababab',
    provider: 'microsoft_graph',
    provider_mailbox_id: MAILBOX,
    provider_message_id: 'msg-draft-open-002',
  });
  planted.events.set(EVENT_ID, eventRow());
  const replay = await storeFor(bridge, planted).projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: EVENT_ID,
  }));
  assert.equal(replay.status, 'already_projected');
  assert.equal(replay.conversation_id, EXISTING_CONV);
  assert.equal(planted.conversations.get(`${CLIENT}\0${phone}`).needs_human, false);
  assert.equal(
    planted.log.some((entry) => /^INSERT INTO conversations/.test(entry.sql)),
    false,
    'already_projected must not re-enter the conversation write',
  );

  console.log('ok - rejected/uncertain/already_projected do not invent needs_human writes');
}

async function testIdempotentReplayKeepsTrue() {
  const bridge = loadBridge();
  const harness = createHarness();
  const ev = eventRow();
  harness.events.set(ev.id, ev);
  const store = storeFor(bridge, harness);
  const first = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));
  const second = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));
  assert.equal(first.status, 'projected');
  assert.equal(second.status, 'already_projected');
  assert.equal(soleConversation(harness, CLIENT).needs_human, true);
  assert.equal(harness.conversations.size, 1);
  assert.equal(harness.messages.size, 1);
  console.log('ok - replay stays already_projected and keeps needs_human=true');
}

async function main() {
  console.log('verify:email-draft-open-002 — RED→GREEN\n');
  assertStaticBoundary();
  await testMicrosoftAttachSetsNeedsHumanOnNewConversation();
  await testExistingConversationConvergesTrue();
  await testTenantIsolation();
  await testNonMicrosoftProviderDoesNotFlag();
  await testFailedAndDuplicateDoNotMutateUnattached();
  await testIdempotentReplayKeepsTrue();
  console.log('\nPASS EMAIL-DRAFT-OPEN-002 Microsoft inbound attach sets needs_human');
}

main().catch((err) => {
  console.error('FAIL EMAIL-DRAFT-OPEN-002');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
