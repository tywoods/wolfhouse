'use strict';

/**
 * EMAIL-MATCH-001 ingest gate (Skipper).
 *
 * Proves Sunset inbound Microsoft Graph mail attaches to one Staff Inbox
 * conversation by mailbox + normalized From (PR #592 helper API only), binds
 * an existing same-tenant guest by exact email, and fails closed on
 * malformed / ambiguous / unknown From. No synthetic In-Reply-To join.
 *
 * Does not own PR #592 helper files. Those remain Cursor-owned:
 *   scripts/lib/email-inbound-conversation-identity.js
 *   scripts/lib/email-inbound-guest-email-match.js
 *   scripts/verify-email-inbound-match-helpers.js
 * This gate fetches those files read-only into a temporary overlay.
 *
 * No live Graph, no mailbox history scrape, no outbound, no Google, no UI.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INGEST_REL = 'scripts/lib/email-inbound-match-ingest.js';
const INGEST_PATH = path.join(ROOT, INGEST_REL);
const BRIDGE_REL = 'scripts/lib/email-inbound-inbox-bridge.js';
const BRIDGE_PATH = path.join(ROOT, BRIDGE_REL);
const GRAPH_HEADERS_REL = 'scripts/lib/email-inbound-graph-thread-headers.js';
const PKG = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const HELPER_IDENTITY_REL = 'scripts/lib/email-inbound-conversation-identity.js';
const HELPER_GUEST_REL = 'scripts/lib/email-inbound-guest-email-match.js';
const HELPER_VERIFY_REL = 'scripts/verify-email-inbound-match-helpers.js';

const EVENT_SELECT_COLUMNS = Object.freeze([
  'id',
  'client_id',
  'location_id',
  'endpoint_id',
  'provider',
  'provider_mailbox_id',
  'provider_message_id',
  'received_at',
  'subject',
  'sender_display_name',
  'sender_address',
  'is_read',
  'conversation_id',
  'internet_message_id',
]);

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIENT_OTHER = '99999999-9999-4999-8999-999999999999';
const LOCATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LOCATION_OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVENT_A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const EVENT_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const MAILBOX_OTHER = '33333333-3333-4333-8333-333333333333';
const GUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GUEST_OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FROM_A = 'Elena.Guest@Example.COM';
const FROM_A_NORM = 'elena.guest@example.com';
const FROM_UNKNOWN = 'nobody@example.com';
const PLANTED_SUBJECT = 'SUBJECT_PII_MUST_NOT_APPEAR_MATCH_INGEST';
const PLANTED_ADDRESS = FROM_A;

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function productionEventRow(overrides = {}) {
  const row = {
    id: EVENT_A,
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    provider: 'microsoft_graph',
    provider_mailbox_id: MAILBOX,
    provider_message_id: 'msg-match-001',
    received_at: '2026-08-01T12:00:00.000Z',
    subject: PLANTED_SUBJECT,
    sender_display_name: 'Elena Guest',
    sender_address: FROM_A,
    is_read: false,
    conversation_id: 'graph-thread-1',
    internet_message_id: '<root-thread@mail.example>',
    ...overrides,
  };
  const projected = {};
  for (const col of EVENT_SELECT_COLUMNS) {
    projected[col] = Object.prototype.hasOwnProperty.call(row, col) ? row[col] : undefined;
  }
  return projected;
}

function authority(overrides = {}) {
  return {
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    ...overrides,
  };
}

function createMatchHarness(options = {}) {
  const events = options.events || new Map();
  const locations = options.locations || new Map([
    [`${CLIENT}\0${LOCATION}`, { client_id: CLIENT, id: LOCATION, location_id: 'sunset-somo' }],
    [`${CLIENT}\0${LOCATION_OTHER}`, { client_id: CLIENT, id: LOCATION_OTHER, location_id: 'sunset-sardinero' }],
  ]);
  const conversations = options.conversations || new Map();
  const messages = options.messages || new Map();
  const projections = options.projections || new Map();
  const guests = options.guests || new Map();
  const customers = options.customers || new Map();
  const log = [];
  let uuidSeq = 0;
  let failOn = null;

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

  function maybeSyncCustomer(row) {
    const phone = row && row.phone;
    if (typeof phone !== 'string' || !phone.trim()) return;
    if (/^(emailv1|email):/.test(phone)) return;
    customers.set(convKey(row.client_id, phone), {
      client_id: row.client_id,
      phone,
      email: row.email || null,
    });
  }

  function eventSelectSurface(ev) {
    const out = {};
    for (const col of EVENT_SELECT_COLUMNS) out[col] = ev[col];
    return out;
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
          for (const [k, v] of stagedConv) {
            conversations.set(k, v);
            maybeSyncCustomer(v);
          }
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
            return { rows: [eventSelectSurface(ev)], rowCount: 1 };
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
              return { rows: [eventSelectSurface(ev)], rowCount: 1 };
            }
          }
          return { rows: [], rowCount: 0 };
        }

        if (/FROM tenant_email_inbound_inbox_projections/.test(norm)
            && /provider_message_id/.test(norm)
            && /SELECT/.test(norm)
            && !/JOIN/.test(norm)) {
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

        if (/FROM guests/.test(norm)) {
          const [clientId, email] = params;
          const rows = [];
          for (const g of guests.values()) {
            if (g.client_id !== clientId || g.email == null) continue;
            if (String(g.email).trim().toLowerCase() === String(email)) {
              rows.push({ guest_id: g.id });
            }
          }
          return { rows, rowCount: rows.length };
        }

        if (/^INSERT INTO conversations/.test(norm)) {
          const [
            clientId, phone, displayName, email, status, botMode, stage,
            preview, metadataJson, sessionJson,
          ] = params;
          const k = convKey(clientId, phone);
          const existing = conversations.get(k) || stagedConv.get(k);
          if (existing) {
            const meta = typeof metadataJson === 'string' ? JSON.parse(metadataJson) : metadataJson;
            const next = {
              ...existing,
              display_name: existing.display_name || displayName,
              email: existing.email || email,
              last_message_preview: preview,
              metadata: { ...existing.metadata, ...meta },
              updated_at: 'now',
            };
            stagedConv.set(k, next);
            return { rows: [{ conversation_id: existing.id, created: false }], rowCount: 1 };
          }
          const id = nextUuid('c');
          const meta = typeof metadataJson === 'string' ? JSON.parse(metadataJson) : metadataJson;
          const session = typeof sessionJson === 'string' ? JSON.parse(sessionJson) : sessionJson;
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
            guest_id: null,
          };
          stagedConv.set(k, row);
          return { rows: [{ conversation_id: id, created: true }], rowCount: 1 };
        }

        if (/^UPDATE conversations/.test(norm) && /guest_id/.test(norm)) {
          const [clientId, conversationId, guestId, fromEmail] = params;
          for (const map of [stagedConv, conversations]) {
            for (const [k, row] of map) {
              if (row.client_id === clientId && row.id === conversationId) {
                const displayed = row.email == null ? '' : String(row.email).trim().toLowerCase();
                if (row.guest_id == null && displayed && displayed === String(fromEmail)) {
                  const next = { ...row, guest_id: guestId };
                  stagedConv.set(k, next);
                  return { rows: [{ conversation_id: conversationId }], rowCount: 1 };
                }
                return { rows: [], rowCount: 0 };
              }
            }
          }
          return { rows: [], rowCount: 0 };
        }

        if (/^INSERT INTO guests/.test(norm)) {
          throw new Error('ingest_must_never_insert_guests');
        }

        if (/^INSERT INTO messages/.test(norm)) {
          const [
            clientId, conversationId, direction, messageText, messageType,
            source, route, metadataJson,
          ] = params;
          const meta = typeof metadataJson === 'string' ? JSON.parse(metadataJson) : metadataJson;
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
            metadata: meta,
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

        throw new Error(`unexpected sql: ${norm.slice(0, 140)}`);
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
    guests,
    customers,
    log,
    setFailOn(fn) { failOn = fn; },
  };
}

function loadIngest() {
  delete require.cache[require.resolve('./lib/email-inbound-match-ingest')];
  return require('./lib/email-inbound-match-ingest');
}

function loadBridge() {
  delete require.cache[require.resolve('./lib/email-inbound-inbox-bridge')];
  delete require.cache[require.resolve('./lib/email-inbound-match-ingest')];
  return require('./lib/email-inbound-inbox-bridge');
}

function noLeak(v) {
  const s = typeof v === 'string' ? v : (() => {
    try { return JSON.stringify(v); } catch { return String(v); }
  })();
  return !s.includes(PLANTED_SUBJECT)
    && !s.includes(PLANTED_ADDRESS)
    && !s.includes(FROM_A)
    && !s.includes(FROM_A_NORM)
    && !s.includes('NEVER_LEAK');
}

function assertStaticSurface() {
  assert.ok(fs.existsSync(INGEST_PATH), 'match ingest owner must exist');
  assert.ok(fs.existsSync(BRIDGE_PATH), 'inbox bridge must exist');
  assert.equal(fs.existsSync(path.join(ROOT, GRAPH_HEADERS_REL)), false,
    'dead graph-thread-header extractor must not ship');

  const ingestSrc = fs.readFileSync(INGEST_PATH, 'utf8');
  const bridgeSrc = fs.readFileSync(BRIDGE_PATH, 'utf8');
  const pkg = loadJson(PKG);
  const doc = fs.readFileSync(DOC, 'utf8');

  assert.match(ingestSrc, /EMAIL_INBOUND_MATCH_INGEST_VERSION/);
  assert.match(ingestSrc, /resolveInboundMatchConversationIdentity/);
  assert.match(ingestSrc, /SQL_SELECT_SUNSET_GUESTS_BY_EXACT_EMAIL/);
  assert.match(ingestSrc, /lower\(btrim\(email\)\)/);
  assert.match(ingestSrc, /FROM guests/);
  assert.match(ingestSrc, /require\('\.\/email-inbound-conversation-identity'\)/);
  assert.match(ingestSrc, /require\('\.\/email-inbound-guest-email-match'\)/);
  assert.equal(/loadPr592Helpers|MODULE_NOT_FOUND|buildFallbackMailboxFromKey/.test(ingestSrc), false);
  assert.equal(/INSERT INTO guests/i.test(ingestSrc), false, 'never create guests');
  assert.equal(/graph\.microsoft\.com/i.test(ingestSrc), false, 'no Graph scrape');
  assert.equal(/\/me\/messages/i.test(ingestSrc), false, 'no mailbox history scrape');
  assert.equal(/console\.(log|info|debug|warn|error)/.test(ingestSrc), false);
  assert.equal(/SQL_SELECT_INBOUND_THREAD_ANCHOR|thread_join|in_reply_to:|references_message_ids:/.test(ingestSrc), false);

  const bindFn = ingestSrc.slice(
    ingestSrc.indexOf('async function bindSunsetGuestByExactInboundEmail'),
    ingestSrc.indexOf('async function persistConversationGuestBind'),
  );
  const persistFn = ingestSrc.slice(
    ingestSrc.indexOf('async function persistConversationGuestBind'),
    ingestSrc.indexOf('module.exports'),
  );
  assert.ok(bindFn.length > 80 && persistFn.length > 80, 'guest bind functions must remain in ingest');
  assert.equal(/catch\s*\{[\s\S]*?return unmatched/.test(bindFn), false,
    'guest SELECT must not catch DB errors as unmatched');
  assert.equal(/catch\s*\{[\s\S]*?return false/.test(persistFn), false,
    'guest UPDATE must not catch DB errors as false');

  assert.equal(/in_reply_to|references_message_ids/.test(bridgeSrc), false);
  assert.match(bridgeSrc, /SQL_SELECT_EVENT_BY_ID[\s\S]*internet_message_id/);
  assert.equal(/SQL_SELECT_EVENT_BY_ID[\s\S]*in_reply_to/.test(bridgeSrc), false);
  assert.match(bridgeSrc, /email-inbound-match-ingest/);
  assert.match(bridgeSrc, /resolveInboundMatchConversationIdentity|bindSunsetGuestByExactInboundEmail/);

  assert.equal(
    pkg.scripts['verify:email-inbound-match-ingest'],
    'node scripts/verify-email-inbound-match-ingest.js',
  );

  assert.equal(bridgeSrc.includes('inbox-thread.js'), false);
  assert.equal(ingestSrc.includes('inbox-thread.js'), false);

  assert.match(doc, /EMAIL-MATCH-001|mailbox \+ normalized From|emailconv-from|inbound match/i);
  assert.match(doc, /deferred|does not persist|internetMessageHeaders/i);

  for (const forbidden of [HELPER_IDENTITY_REL, HELPER_GUEST_REL, HELPER_VERIFY_REL]) {
    const abs = path.join(ROOT, forbidden);
    if (fs.existsSync(abs)) {
      const st = fs.statSync(abs);
      assert.ok(st.isFile(), `${forbidden} exists only as PR #592 owner`);
    }
  }

  console.log('ok - static ingest surface; no thread columns; intrinsic PR #592 require');
}

function assertPureIdentity() {
  const ingest = loadIngest();
  const identity = require('./lib/email-inbound-conversation-identity');

  const first = ingest.resolveInboundMatchConversationIdentity({
    providerMailboxId: MAILBOX,
    fromAddress: FROM_A,
  });
  const second = ingest.resolveInboundMatchConversationIdentity({
    providerMailboxId: MAILBOX,
    fromAddress: `  ${FROM_A_NORM}  `,
  });
  assert.ok(first && first.conversation_key);
  assert.equal(first.conversation_key, second.conversation_key);
  assert.ok(String(first.conversation_key).startsWith('emailv1:'));
  assert.equal(String(first.conversation_key).toLowerCase().includes(FROM_A_NORM), false);
  assert.equal(first.strategy, 'from');
  assert.equal(first.thread_anchor, null);

  const helperKey = identity.buildFromConversationKey(MAILBOX, FROM_A);
  assert.equal(first.conversation_key, `emailv1:${helperKey}`);

  const ignoredThread = ingest.resolveInboundMatchConversationIdentity({
    providerMailboxId: MAILBOX,
    fromAddress: FROM_A,
    inReplyTo: '<other-root@mail.example>',
    references: ['other-root@mail.example'],
  });
  assert.ok(ignoredThread);
  assert.equal(ignoredThread.conversation_key, first.conversation_key);
  assert.equal(ignoredThread.strategy, 'from');

  const otherFrom = ingest.resolveInboundMatchConversationIdentity({
    providerMailboxId: MAILBOX,
    fromAddress: FROM_UNKNOWN,
  });
  assert.ok(otherFrom);
  assert.notEqual(otherFrom.conversation_key, first.conversation_key);

  const otherMailbox = ingest.resolveInboundMatchConversationIdentity({
    providerMailboxId: MAILBOX_OTHER,
    fromAddress: FROM_A,
  });
  assert.ok(otherMailbox);
  assert.notEqual(otherMailbox.conversation_key, first.conversation_key);

  assert.equal(ingest.resolveInboundMatchConversationIdentity({
    providerMailboxId: MAILBOX,
    fromAddress: 'not-an-email',
  }), null);
  assert.equal(ingest.resolveInboundMatchConversationIdentity({
    providerMailboxId: MAILBOX,
    fromAddress: '',
  }), null);
  assert.equal(ingest.resolveInboundMatchConversationIdentity({
    providerMailboxId: '',
    fromAddress: FROM_A,
  }), null);
  assert.equal(ingest.resolveInboundMatchConversationIdentity(null), null);

  console.log('ok - PR #592 mailbox+From key only; thread fields ignored; isolation holds');
}

function assertGuestBindSql() {
  const ingest = loadIngest();
  assert.match(ingest.SQL_SELECT_SUNSET_GUESTS_BY_EXACT_EMAIL, /FROM guests/);
  assert.match(ingest.SQL_SELECT_SUNSET_GUESTS_BY_EXACT_EMAIL, /client_id = \$1::uuid/);
  assert.match(ingest.SQL_SELECT_SUNSET_GUESTS_BY_EXACT_EMAIL, /lower\(btrim\(email\)\) = \$2/);
  assert.equal(/INSERT INTO guests/i.test(ingest.SQL_SELECT_SUNSET_GUESTS_BY_EXACT_EMAIL), false);
  assert.match(ingest.SQL_UPDATE_CONVERSATION_GUEST, /guest_id IS NULL/);
  assert.match(ingest.SQL_UPDATE_CONVERSATION_GUEST, /lower\(btrim\(email\)\) = \$4/);
  console.log('ok - guest SQL is exact tenant email + null-only update matching displayed email');
}

async function projectTwo(store, first, second) {
  const r1 = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: first.id,
  }));
  const r2 = await store.projectInboundEvent(Object.freeze({
    ...authority({ locationId: second.location_id, endpointId: second.endpoint_id }),
    inboundEventId: second.id,
  }));
  return [r1, r2];
}

async function testSameSenderMailboxCoalesces() {
  const bridge = loadBridge();
  const harness = createMatchHarness();
  const e1 = productionEventRow({ id: EVENT_A, provider_message_id: 'msg-a', subject: 'First' });
  const e2 = productionEventRow({
    id: EVENT_B,
    provider_message_id: 'msg-b',
    subject: 'Second',
    received_at: '2026-08-01T13:00:00.000Z',
    internet_message_id: '<second@mail.example>',
    location_id: LOCATION_OTHER,
  });
  harness.events.set(e1.id, e1);
  harness.events.set(e2.id, e2);
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));

  const [r1, r2] = await projectTwo(store, e1, e2);
  assert.equal(r1.status, 'projected');
  assert.equal(r2.status, 'projected');
  assert.equal(r1.conversation_id, r2.conversation_id);
  assert.notEqual(r1.message_id, r2.message_id);
  assert.equal(harness.conversations.size, 1);
  assert.equal(harness.messages.size, 2);
  const conv = [...harness.conversations.values()][0];
  assert.ok(String(conv.phone).startsWith('emailv1:'));
  assert.equal(String(conv.phone).toLowerCase().includes(FROM_A_NORM), false);
  assert.equal(conv.email, FROM_A_NORM);
  assert.equal(harness.customers.size, 0);
  assert.equal(
    harness.log.some((entry) => /in_reply_to|references_message_ids/.test(entry.sql)),
    false,
  );
  console.log('ok - two new mails same From+mailbox → one conversation (real SELECT surface)');
}

async function testMailboxIsolation() {
  const bridge = loadBridge();
  const harness = createMatchHarness();
  const e1 = productionEventRow({ id: EVENT_A, provider_message_id: 'msg-mb-a' });
  const e2 = productionEventRow({
    id: EVENT_B,
    provider_message_id: 'msg-mb-b',
    provider_mailbox_id: MAILBOX_OTHER,
    internet_message_id: '<other-mb@mail.example>',
  });
  harness.events.set(e1.id, e1);
  harness.events.set(e2.id, e2);
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));
  const r1 = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: e1.id,
  }));
  const r2 = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: e2.id,
  }));
  assert.equal(r1.status, 'projected');
  assert.equal(r2.status, 'projected');
  assert.notEqual(r1.conversation_id, r2.conversation_id);
  assert.equal(harness.conversations.size, 2);
  console.log('ok - same From different mailbox → separate conversations');
}

async function testDifferentFromDoesNotJoinOrOverwrite() {
  const bridge = loadBridge();
  const harness = createMatchHarness();
  harness.guests.set(GUEST_ID, { id: GUEST_ID, client_id: CLIENT, email: FROM_A_NORM });
  const root = productionEventRow({
    id: EVENT_A,
    provider_message_id: 'msg-root',
    sender_address: FROM_A,
  });
  const other = productionEventRow({
    id: EVENT_B,
    provider_message_id: 'msg-other',
    sender_address: FROM_UNKNOWN,
    sender_display_name: 'Other Person',
    internet_message_id: '<reply@mail.example>',
  });
  harness.events.set(root.id, root);
  harness.events.set(other.id, other);
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));
  const r1 = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: root.id,
  }));
  const r2 = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: other.id,
  }));
  assert.equal(r1.status, 'projected');
  assert.equal(r2.status, 'projected');
  assert.notEqual(r2.conversation_id, r1.conversation_id);
  assert.equal(harness.conversations.size, 2);
  const byId = new Map([...harness.conversations.values()].map((c) => [c.id, c]));
  assert.equal(byId.get(r1.conversation_id).email, FROM_A_NORM);
  assert.equal(byId.get(r1.conversation_id).display_name, 'Elena Guest');
  assert.equal(byId.get(r1.conversation_id).guest_id, GUEST_ID);
  assert.equal(byId.get(r2.conversation_id).email, FROM_UNKNOWN);
  assert.equal(byId.get(r2.conversation_id).guest_id, null);
  console.log('ok - different From stays isolated; root email/guest identity unchanged');
}

async function testUnknownSenderGuestNull() {
  const bridge = loadBridge();
  const harness = createMatchHarness();
  harness.guests.set(GUEST_ID, {
    id: GUEST_ID,
    client_id: CLIENT,
    email: FROM_A_NORM,
  });
  const ev = productionEventRow({ sender_address: FROM_UNKNOWN, internet_message_id: '<unk@mail.example>' });
  harness.events.set(ev.id, ev);
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));
  const r = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));
  assert.equal(r.status, 'projected');
  const conv = [...harness.conversations.values()][0];
  assert.equal(conv.guest_id, null);
  assert.equal(harness.guests.size, 1);
  console.log('ok - unknown From stays unmatched/null; no guest created');
}

async function testExactGuestBind() {
  const bridge = loadBridge();
  const harness = createMatchHarness();
  harness.guests.set(GUEST_ID, {
    id: GUEST_ID,
    client_id: CLIENT,
    email: 'ELENA.GUEST@EXAMPLE.COM',
  });
  harness.guests.set(GUEST_OTHER, {
    id: GUEST_OTHER,
    client_id: CLIENT_OTHER,
    email: FROM_A_NORM,
  });
  const ev = productionEventRow();
  harness.events.set(ev.id, ev);
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));
  const r = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));
  assert.equal(r.status, 'projected');
  const conv = [...harness.conversations.values()][0];
  assert.equal(conv.guest_id, GUEST_ID);
  assert.equal(conv.email, FROM_A_NORM);
  assert.equal(harness.guests.size, 2);
  const guestSql = harness.log.filter((entry) => /FROM guests/.test(entry.sql));
  assert.equal(guestSql.length >= 1, true);
  assert.match(guestSql[0].sql, /lower\(btrim\(email\)\) = \$2/);
  console.log('ok - exact same-tenant guest email binds existing guest only');
}

async function testAmbiguousGuestStaysUnmatched() {
  const bridge = loadBridge();
  const harness = createMatchHarness();
  harness.guests.set(GUEST_ID, { id: GUEST_ID, client_id: CLIENT, email: FROM_A_NORM });
  harness.guests.set(GUEST_OTHER, { id: GUEST_OTHER, client_id: CLIENT, email: FROM_A_NORM });
  const ev = productionEventRow();
  harness.events.set(ev.id, ev);
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));
  const r = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));
  assert.equal(r.status, 'projected');
  const conv = [...harness.conversations.values()][0];
  assert.equal(conv.guest_id, null);
  console.log('ok - ambiguous same-tenant guest email stays unmatched');
}

async function testExistingGuestIdNotOverwritten() {
  const bridge = loadBridge();
  const harness = createMatchHarness();
  harness.guests.set(GUEST_ID, { id: GUEST_ID, client_id: CLIENT, email: FROM_A_NORM });
  const e1 = productionEventRow({ id: EVENT_A, provider_message_id: 'msg-bound' });
  const e2 = productionEventRow({
    id: EVENT_B,
    provider_message_id: 'msg-later',
    internet_message_id: '<later@mail.example>',
  });
  harness.events.set(e1.id, e1);
  harness.events.set(e2.id, e2);
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));
  const r1 = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: e1.id,
  }));
  const conv = [...harness.conversations.values()][0];
  conv.guest_id = GUEST_OTHER;
  const r2 = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: e2.id,
  }));
  assert.equal(r1.status, 'projected');
  assert.equal(r2.status, 'projected');
  assert.equal([...harness.conversations.values()][0].guest_id, GUEST_OTHER);
  console.log('ok - existing guest_id is not overwritten');
}

async function testMalformedSenderRejected() {
  const bridge = loadBridge();
  const harness = createMatchHarness();
  const ev = productionEventRow({ sender_address: 'not-an-email' });
  harness.events.set(ev.id, ev);
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));
  const r = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));
  assert.equal(r.status, 'rejected');
  assert.equal(harness.conversations.size, 0);
  assert.ok(noLeak(r));
  console.log('ok - malformed sender rejected fail-closed');
}

async function testDuplicateDoesNotFork() {
  const bridge = loadBridge();
  const harness = createMatchHarness();
  const ev = productionEventRow();
  harness.events.set(ev.id, ev);
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));
  const input = Object.freeze({ ...authority(), inboundEventId: ev.id });
  const a = await store.projectInboundEvent(input);
  const b = await store.projectInboundEvent(input);
  assert.equal(a.status, 'projected');
  assert.equal(b.status, 'already_projected');
  assert.equal(a.conversation_id, b.conversation_id);
  assert.equal(a.message_id, b.message_id);
  assert.equal(harness.conversations.size, 1);
  assert.equal(harness.messages.size, 1);
  console.log('ok - duplicate provider message does not fork conversation');
}

async function testNoPiiAndNoGuestInsertSql() {
  const ingest = loadIngest();
  const bridge = loadBridge();
  const harness = createMatchHarness();
  harness.events.set(EVENT_A, productionEventRow());
  harness.setFailOn((sql) => /INSERT INTO conversations/.test(sql));
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));
  const r = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: EVENT_A,
  }));
  assert.notEqual(r.status, 'projected');
  assert.ok(noLeak(r));
  assert.equal(/INSERT INTO guests/i.test(ingest.SQL_SELECT_SUNSET_GUESTS_BY_EXACT_EMAIL), false);
  assert.equal(
    harness.log.some((entry) => /INSERT INTO guests/i.test(entry.sql)),
    false,
  );
  console.log('ok - no PII in failures; guest insert never issued');
}

function guestQueryClient(handler) {
  return {
    async query(sql, params) {
      return handler(String(sql).replace(/\s+/g, ' ').trim(), params);
    },
  };
}

async function testGuestSelectZeroOrManyRemainsUnmatched() {
  const ingest = loadIngest();
  const zero = await ingest.bindSunsetGuestByExactInboundEmail(
    guestQueryClient(async () => ({ rows: [], rowCount: 0 })),
    { clientId: CLIENT, fromAddress: FROM_A },
  );
  assert.equal(zero.status, 'unmatched');
  assert.equal(Object.prototype.hasOwnProperty.call(zero, 'guest_id'), false);

  const many = await ingest.bindSunsetGuestByExactInboundEmail(
    guestQueryClient(async () => ({
      rows: [{ guest_id: GUEST_ID }, { guest_id: GUEST_OTHER }],
      rowCount: 2,
    })),
    { clientId: CLIENT, fromAddress: FROM_A },
  );
  assert.equal(many.status, 'unmatched');
  assert.equal(Object.prototype.hasOwnProperty.call(many, 'guest_id'), false);
  console.log('ok - successful guest SELECT with 0 or 2+ rows stays unmatched');
}

async function testGuestUpdateRowCountZeroNonfatal() {
  const ingest = loadIngest();
  let wroteGuestId = false;
  const result = await ingest.persistConversationGuestBind(
    guestQueryClient(async () => {
      wroteGuestId = true;
      return { rows: [], rowCount: 0 };
    }),
    {
      clientId: CLIENT,
      conversationId: EVENT_A,
      guestId: GUEST_ID,
      fromAddress: FROM_A,
    },
  );
  assert.equal(result, false);
  assert.equal(wroteGuestId, true, 'null-only UPDATE must still be issued');
  console.log('ok - guest UPDATE rowCount 0 (already bound) is nonfatal and does not overwrite');
}

async function testGuestSelectDbErrorPropagates() {
  const ingest = loadIngest();
  await assert.rejects(
    () => ingest.bindSunsetGuestByExactInboundEmail(
      guestQueryClient(async () => {
        throw new Error('planted_guest_select_failure');
      }),
      { clientId: CLIENT, fromAddress: FROM_A },
    ),
    (err) => err && err.message === 'planted_guest_select_failure',
  );
  console.log('ok - guest SELECT DB error propagates (not unmatched)');
}

async function testGuestUpdateDbErrorPropagates() {
  const ingest = loadIngest();
  await assert.rejects(
    () => ingest.persistConversationGuestBind(
      guestQueryClient(async () => {
        throw new Error('planted_guest_update_failure');
      }),
      {
        clientId: CLIENT,
        conversationId: EVENT_A,
        guestId: GUEST_ID,
        fromAddress: FROM_A,
      },
    ),
    (err) => err && err.message === 'planted_guest_update_failure',
  );
  console.log('ok - guest UPDATE DB error propagates (not false)');
}

function assertSanitizedUncertain(result) {
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'inbound_inbox_bridge_write_failed');
  assert.deepEqual(Object.keys(result).sort(), ['reason', 'status']);
  assert.ok(noLeak(result));
  const surface = JSON.stringify(result);
  assert.equal(surface.includes('planted_db_failure'), false);
  assert.equal(surface.includes('guest_id'), false);
}

async function testGuestSelectDbErrorRollsBackThenRetryBinds() {
  const bridge = loadBridge();
  const harness = createMatchHarness();
  harness.guests.set(GUEST_ID, { id: GUEST_ID, client_id: CLIENT, email: FROM_A_NORM });
  const ev = productionEventRow({ provider_message_id: 'msg-guest-select-fail' });
  harness.events.set(ev.id, ev);
  harness.setFailOn((sql) => /FROM guests/.test(sql));
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));
  const first = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));
  assertSanitizedUncertain(first);
  assert.equal(harness.conversations.size, 0);
  assert.equal(harness.messages.size, 0);
  assert.equal(harness.projections.size, 0);
  assert.equal(harness.customers.size, 0);

  harness.setFailOn(null);
  const retry = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));
  assert.equal(retry.status, 'projected');
  assert.equal(harness.messages.size, 1);
  assert.equal(harness.projections.size, 1);
  const conv = [...harness.conversations.values()][0];
  assert.equal(conv.guest_id, GUEST_ID);
  assert.equal(conv.email, FROM_A_NORM);
  console.log('ok - guest SELECT failure rolls back; retry binds guest');
}

async function testGuestUpdateDbErrorRollsBackThenRetryBinds() {
  const bridge = loadBridge();
  const harness = createMatchHarness();
  harness.guests.set(GUEST_ID, { id: GUEST_ID, client_id: CLIENT, email: FROM_A_NORM });
  const ev = productionEventRow({ provider_message_id: 'msg-guest-update-fail' });
  harness.events.set(ev.id, ev);
  harness.setFailOn((sql) => /^UPDATE conversations/.test(sql) && /guest_id/.test(sql));
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));
  const first = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));
  assertSanitizedUncertain(first);
  assert.equal(harness.conversations.size, 0);
  assert.equal(harness.messages.size, 0);
  assert.equal(harness.projections.size, 0);
  assert.equal(harness.customers.size, 0);

  harness.setFailOn(null);
  const retry = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));
  assert.equal(retry.status, 'projected');
  assert.equal(harness.messages.size, 1);
  assert.equal(harness.projections.size, 1);
  const conv = [...harness.conversations.values()][0];
  assert.equal(conv.guest_id, GUEST_ID);
  assert.equal(conv.email, FROM_A_NORM);
  console.log('ok - guest UPDATE failure rolls back; retry binds guest');
}

async function main() {
  console.log('verify-email-inbound-match-ingest — EMAIL-MATCH-001\n');
  assertStaticSurface();
  assertPureIdentity();
  assertGuestBindSql();
  await testSameSenderMailboxCoalesces();
  await testMailboxIsolation();
  await testDifferentFromDoesNotJoinOrOverwrite();
  await testUnknownSenderGuestNull();
  await testExactGuestBind();
  await testAmbiguousGuestStaysUnmatched();
  await testExistingGuestIdNotOverwritten();
  await testMalformedSenderRejected();
  await testDuplicateDoesNotFork();
  await testNoPiiAndNoGuestInsertSql();
  await testGuestSelectZeroOrManyRemainsUnmatched();
  await testGuestUpdateRowCountZeroNonfatal();
  await testGuestSelectDbErrorPropagates();
  await testGuestUpdateDbErrorPropagates();
  await testGuestSelectDbErrorRollsBackThenRetryBinds();
  await testGuestUpdateDbErrorRollsBackThenRetryBinds();
  console.log('\nPASS verify-email-inbound-match-ingest');
}

main().catch((err) => {
  console.error('FAIL verify-email-inbound-match-ingest');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
