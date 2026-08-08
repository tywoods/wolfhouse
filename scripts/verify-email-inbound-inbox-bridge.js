'use strict';

/**
 * Offline RED-GREEN gate: email inbound → Inbox bridge (Slice 2).
 *
 * Bridges durable tenant_email_inbound_events into conversations/messages with
 * channel=email and location preserved. Exactly-once projection via journal
 * migration 067. No live DB, network, send, Luna, routes, or activation.
 *
 * Real PostgreSQL/PGlite node-postgres-shape proof lives in
 * prove-email-inbound-inbox-bridge-pglite.js (applies migration 067).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BRIDGE_REL = 'scripts/lib/email-inbound-inbox-bridge.js';
const BRIDGE_PATH = path.join(ROOT, BRIDGE_REL);
const MIG_UP = path.join(ROOT, 'database/migrations/067_tenant_email_inbound_inbox_projections.sql');
const MIG_DOWN = path.join(ROOT, 'database/migrations/067_tenant_email_inbound_inbox_projections_down.sql');
const DOC = path.join(ROOT, 'docs/EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const PLAN = path.join(ROOT, 'docs/SUNSET-EMAIL-FRONT-DESK-PLAN.md');
const PKG = path.join(ROOT, 'package.json');
const PROVE_REL = 'scripts/prove-email-inbound-inbox-bridge-pglite.js';
const PROVE_PATH = path.join(ROOT, PROVE_REL);

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LOCATION_OTHER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EVENT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const EVENT_ID_2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const MAILBOX = '22222222-2222-4222-8222-2222222222ab';
const PLANTED_SUBJECT = 'SUBJECT_PII_MUST_NOT_APPEAR_INBOX_BRIDGE';
const PLANTED_ADDRESS = 'pii-inbox-bridge@example.com';
const PLANTED_TOKEN = 'ya29.NEVER_LEAK_INBOX_BRIDGE_AT';

/** Owners allowed to import the bridge module (runtime must stay unwired). */
const BRIDGE_IMPORT_ALLOWLIST = new Set([
  BRIDGE_REL,
  'scripts/verify-email-inbound-inbox-bridge.js',
  PROVE_REL,
]);

const RUNTIME_ENTRY_GLOBS = [
  'scripts/staff-query-api.js',
  'scripts/lib/staff-email-',
  'scripts/lib/email-delta-sunset-staging-runtime-composition.js',
  'scripts/lib/email-delta-operator-recovery-sunset-staging-runtime-composition.js',
  'scripts/lib/email-microsoft-delegated-',
  'docker/',
  'infra/',
];

function noLeak(v) {
  const s = typeof v === 'string' ? v : (() => {
    try { return JSON.stringify(v); } catch { return String(v); }
  })();
  return !s.includes(PLANTED_SUBJECT)
    && !s.includes(PLANTED_ADDRESS)
    && !s.includes(PLANTED_TOKEN)
    && !s.includes('NEVER_LEAK')
    && !s.includes('refresh_token');
}

function eventRow(overrides = {}) {
  return {
    id: EVENT_ID,
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    provider: 'microsoft_graph',
    provider_mailbox_id: MAILBOX,
    provider_message_id: 'msg-inbox-001',
    received_at: '2026-08-01T12:00:00.000Z',
    subject: PLANTED_SUBJECT,
    sender_display_name: 'Guest Sender',
    sender_address: PLANTED_ADDRESS,
    is_read: false,
    conversation_id: 'graph-thread-1',
    internet_message_id: '<imsg@example.com>',
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

/**
 * Fake exclusive-client harness for bridge projection.
 * Models events, locations, conversations, messages, projection journal.
 * Does NOT invent production-only message dedupe by metadata — production
 * exactly-once is the projection journal unique index + TX rollback.
 */
function createFakeBridgeHarness(options = {}) {
  const events = options.events || new Map();
  const locations = options.locations || new Map([
    [`${CLIENT}\0${LOCATION}`, { client_id: CLIENT, id: LOCATION, location_id: 'sunset-somo' }],
    [`${CLIENT}\0${LOCATION_OTHER}`, { client_id: CLIENT, id: LOCATION_OTHER, location_id: 'sunset-sardinero' }],
  ]);
  const conversations = options.conversations || new Map();
  const messages = options.messages || new Map();
  const projections = options.projections || new Map();
  const customers = options.customers || new Map();
  const log = [];
  let loanSeq = 0;
  let uuidSeq = 0;
  let failOn = null;
  /** 'reject_before_apply' | 'ack_lost_after_apply' | null */
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

  /** Mirrors 067 customer-sync skip for email-channel phone namespaces. */
  function maybeSyncCustomer(row) {
    const phone = row && row.phone;
    if (typeof phone !== 'string' || !phone.trim()) return;
    if (/^(emailv1|email):/.test(phone)) return;
    const k = convKey(row.client_id, phone);
    customers.set(k, {
      client_id: row.client_id,
      phone,
      email: row.email || null,
      full_name: row.display_name || null,
    });
  }

  async function withTransactionClient(work) {
    const loanId = (loanSeq += 1);
    let inTx = false;
    const stagedConv = new Map();
    const stagedMsg = new Map();
    const stagedProj = new Map();

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
          stagedConv.clear();
          stagedMsg.clear();
          stagedProj.clear();
          return { rows: [], rowCount: 0 };
        }
        if (norm === 'COMMIT') {
          if (!inTx) throw new Error('commit_without_begin');
          if (commitMode === 'reject_before_apply') {
            throw new Error('planted_commit_reject');
          }
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
          if (commitMode === 'ack_lost_after_apply') {
            throw new Error('planted_commit_ack_lost');
          }
          return { rows: [], rowCount: 0 };
        }
        if (norm === 'ROLLBACK') {
          stagedConv.clear();
          stagedMsg.clear();
          stagedProj.clear();
          inTx = false;
          return { rows: [], rowCount: 0 };
        }

        // Load by event id + authority
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

        // Load inbound event by identity + authority
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

        // Projection journal lookup by identity
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

        // Resolve location text from tenant_locations
        if (/FROM tenant_locations/.test(norm)) {
          const [clientId, locationUuid] = params;
          const loc = locations.get(`${clientId}\0${locationUuid}`);
          if (loc) return { rows: [{ location_id: loc.location_id }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }

        // Conversation upsert
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
              display_name: displayName || existing.display_name,
              email: email || existing.email,
              last_message_preview: preview,
              metadata: { ...existing.metadata, ...meta },
              updated_at: 'now',
            };
            stagedConv.set(k, next);
            return {
              rows: [{ conversation_id: existing.id, created: false }],
              rowCount: 1,
            };
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
          };
          stagedConv.set(k, row);
          return {
            rows: [{ conversation_id: id, created: true }],
            rowCount: 1,
          };
        }

        // Message insert — production has no metadata identity dedupe.
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
          return {
            rows: [{ message_id: id }],
            rowCount: 1,
          };
        }

        // Projection journal insert
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

        throw new Error(`unexpected sql: ${norm.slice(0, 100)}`);
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
    customers,
    log,
    setFailOn(fn) { failOn = fn; },
    setCommitMode(mode) { commitMode = mode; },
    /** @deprecated use setCommitMode('reject_before_apply') */
    setCommitShouldReject(v) { commitMode = v ? 'reject_before_apply' : null; },
  };
}

function loadBridge() {
  delete require.cache[require.resolve('./lib/email-inbound-inbox-bridge')];
  return require('./lib/email-inbound-inbox-bridge');
}

function walkJsFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'coverage') continue;
      walkJsFiles(full, out);
    } else if (ent.isFile() && ent.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function relFromRoot(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function assertStaticSurface() {
  assert.ok(fs.existsSync(BRIDGE_PATH), 'bridge module must exist');
  assert.ok(fs.existsSync(MIG_UP), '067 up migration must exist');
  assert.ok(fs.existsSync(MIG_DOWN), '067 down migration must exist');
  assert.ok(fs.existsSync(PROVE_PATH), 'pglite/pg integration proof must exist');

  const src = fs.readFileSync(BRIDGE_PATH, 'utf8');
  const up = fs.readFileSync(MIG_UP, 'utf8');
  const down = fs.readFileSync(MIG_DOWN, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const doc = fs.readFileSync(DOC, 'utf8');
  const plan = fs.readFileSync(PLAN, 'utf8');

  assert.match(up, /CREATE TABLE tenant_email_inbound_inbox_projections/);
  assert.match(up, /UNIQUE \(provider, provider_mailbox_id, provider_message_id\)/);
  // Tenant-consistent composite FKs (not id-only).
  assert.match(up, /FOREIGN KEY \(client_id, inbound_event_id\)/);
  assert.match(up, /REFERENCES tenant_email_inbound_events \(client_id, id\)/);
  assert.match(up, /FOREIGN KEY \(client_id, conversation_id\)/);
  assert.match(up, /REFERENCES conversations \(client_id, id\)/);
  assert.match(up, /FOREIGN KEY \(client_id, conversation_id, message_id\)/);
  assert.match(up, /REFERENCES messages \(client_id, conversation_id, id\)/);
  assert.match(up, /REFERENCES tenant_locations \(client_id, id\)/);
  assert.match(up, /REFERENCES tenant_channel_endpoints \(client_id, id\)/);
  assert.match(up, /conversations_client_id_id_uq/);
  assert.match(up, /messages_client_id_conversation_id_id_uq/);
  assert.match(up, /ON DELETE CASCADE/);
  assert.match(up, /emailv1\|email/);
  assert.match(up, /sync_customer_from_touch/);
  assert.equal(/INSERT INTO tenant_email_inbound_inbox_projections/.test(up), false);

  // Down fail-closed when projection rows exist.
  assert.match(down, /067_down_refused/);
  assert.match(down, /projection rows present/);
  assert.match(down, /DROP TABLE IF EXISTS tenant_email_inbound_inbox_projections/);

  assert.match(src, /EMAIL_INBOUND_INBOX_BRIDGE_RUNTIME_WIRED\s*=\s*false/);
  assert.match(src, /CHANNEL\s*=\s*['"]email['"]/);
  assert.match(src, /createEmailInboundInboxBridge/);
  assert.match(src, /projectInboundEvent/);
  assert.match(src, /buildEmailConversationIdentityKey/);
  assert.match(src, /emailv1/);
  assert.match(src, /createHash\(['"]sha256['"]\)/);
  // No raw email:loc:email pattern in identity builder
  assert.equal(/return `email:\$\{loc\}:\$\{email\}`/.test(src), false);
  // No redundant email_subject metadata copies
  assert.equal(/email_subject:/.test(src), false);
  // No send / Graph / Luna activation
  assert.equal(/sendMail|graph\.microsoft\.com|openai|hermes-luna/i.test(src), false);
  assert.equal(/console\.(log|info|debug|warn|error)/.test(src), false);

  assert.equal(
    pkg.scripts['verify:email-inbound-inbox-bridge'],
    'node scripts/verify-email-inbound-inbox-bridge.js',
  );
  assert.equal(
    pkg.scripts['prove:email-inbound-inbox-bridge-pglite'],
    'node scripts/prove-email-inbound-inbox-bridge-pglite.js',
  );

  assert.match(doc, /inbox-bridge|inbound-inbox-bridge|Inbox bridge/i);
  assert.match(doc, /067_tenant_email_inbound_inbox_projections|tenant_email_inbound_inbox_projections/);
  assert.match(doc, /emailv1|opaque/);
  assert.match(plan, /email_inbound_events/);
  assert.match(plan, /channel=.?email|channel='email'|channel=\"email\"/);

  console.log('ok - static surface (module, 067 composite FKs, fail-closed down, package, docs)');
}

/**
 * Repository-wide import/ownership: only allowlisted scripts may reference the
 * bridge module. Runtime entry points, routes, workers, and composition must not.
 */
function assertRuntimeUnwiredImportOwnership() {
  const bridge = loadBridge();
  assert.equal(bridge.EMAIL_INBOUND_INBOX_BRIDGE_RUNTIME_WIRED, false);

  const requireRe = /require\s*\(\s*['"`]([^'"`]*email-inbound-inbox-bridge[^'"`]*)['"`]\s*\)/;
  const importRe = /from\s+['"`]([^'"`]*email-inbound-inbox-bridge[^'"`]*)['"`]/;
  const offenders = [];

  const roots = [
    path.join(ROOT, 'scripts'),
    path.join(ROOT, 'docker'),
    path.join(ROOT, 'infra'),
  ].filter((d) => fs.existsSync(d));

  for (const root of roots) {
    for (const abs of walkJsFiles(root)) {
      const rel = relFromRoot(abs);
      if (BRIDGE_IMPORT_ALLOWLIST.has(rel)) continue;
      let text;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (!text.includes('email-inbound-inbox-bridge')) continue;
      const req = text.match(requireRe);
      const imp = text.match(importRe);
      if (req || imp) {
        offenders.push(rel);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `bridge must not be imported outside allowlist; found: ${offenders.join(', ')}`,
  );

  // Explicit runtime entry / composition surfaces must not mention the module.
  const runtimeFiles = walkJsFiles(path.join(ROOT, 'scripts')).filter((abs) => {
    const rel = relFromRoot(abs);
    return RUNTIME_ENTRY_GLOBS.some((g) => rel.startsWith(g) || rel.includes(g));
  });
  for (const abs of runtimeFiles) {
    const rel = relFromRoot(abs);
    if (BRIDGE_IMPORT_ALLOWLIST.has(rel)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    assert.equal(
      text.includes('email-inbound-inbox-bridge'),
      false,
      `runtime surface must not reference bridge: ${rel}`,
    );
  }

  // staff-query-api is the primary Staff API entry if present
  const staffApi = path.join(ROOT, 'scripts/staff-query-api.js');
  if (fs.existsSync(staffApi)) {
    const text = fs.readFileSync(staffApi, 'utf8');
    assert.equal(text.includes('email-inbound-inbox-bridge'), false);
    assert.equal(/createEmailInboundInboxBridge|projectInboundEvent/.test(text), false);
  }

  // Production WhatsApp send path must own the email-channel boundary without wiring the bridge.
  const sendReply = path.join(ROOT, 'scripts/lib/luna-staff-inbox-send-reply.js');
  const inboxRoutes = path.join(ROOT, 'scripts/lib/staff-inbox-routes.js');
  if (fs.existsSync(sendReply) && fs.existsSync(inboxRoutes)) {
    const sendSrc = fs.readFileSync(sendReply, 'utf8');
    const routesSrc = fs.readFileSync(inboxRoutes, 'utf8');
    assert.equal(sendSrc.includes('email-inbound-inbox-bridge'), false);
    assert.equal(routesSrc.includes('email-inbound-inbox-bridge'), false);
    assert.match(sendSrc, /resolveAuthoritativeInboxSendTarget/);
    assert.match(sendSrc, /emailv1\|email|emailv1|email:/);
    assert.match(sendSrc, /email_channel_send_not_supported|isEmailChannelPhoneNamespace/);
    assert.match(routesSrc, /resolveAuthoritativeInboxSendTarget/);
    assert.match(
      routesSrc,
      /const target = await resolveAuthoritativeInboxSendTarget[\s\S]{0,600}?evaluateGuestReplySendRouteWithPause\(sendBody/,
    );
  }

  console.log('ok - repository-wide runtime-unwired import ownership');
}

async function testProjectHappyPath() {
  const bridge = loadBridge();
  const harness = createFakeBridgeHarness();
  const ev = eventRow();
  harness.events.set(ev.id, ev);

  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));

  const result = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));

  assert.equal(result.status, 'projected');
  assert.equal(typeof result.conversation_id, 'string');
  assert.equal(typeof result.message_id, 'string');
  assert.equal(result.created_conversation, true);
  assert.ok(noLeak(result), 'result must not leak PII');

  assert.equal(harness.conversations.size, 1);
  const conv = [...harness.conversations.values()][0];
  assert.equal(conv.client_id, CLIENT);
  assert.equal(conv.email, PLANTED_ADDRESS);
  assert.equal(conv.metadata.channel, 'email');
  assert.equal(conv.metadata.location_id, 'sunset-somo');
  assert.equal(conv.session_state.channel, 'email');
  // Opaque identity — no raw email in phone namespace
  assert.ok(String(conv.phone).startsWith('emailv1:'));
  assert.ok(String(conv.phone).includes('sunset-somo'));
  assert.equal(
    String(conv.phone).toLowerCase().includes(PLANTED_ADDRESS.toLowerCase()),
    false,
    'phone must not contain raw sender email',
  );
  assert.equal(conv.metadata.email_subject, undefined);
  assert.equal(bridge.isEmailChannelPhoneNamespace(conv.phone), true);
  // Customer sync skipped for email-channel keys
  assert.equal(harness.customers.size, 0, 'email projection must not create customers');

  assert.equal(harness.messages.size, 1);
  const msg = [...harness.messages.values()][0];
  assert.equal(msg.direction, 'inbound');
  assert.equal(msg.source, 'email_inbound');
  assert.equal(msg.route, 'email');
  assert.equal(msg.metadata.channel, 'email');
  assert.equal(msg.metadata.provider_message_id, 'msg-inbox-001');
  assert.equal(msg.metadata.email_subject, undefined);
  assert.equal(msg.message_text, PLANTED_SUBJECT);
  assert.equal(msg.message_text, conv.last_message_preview);

  assert.equal(harness.projections.size, 1);
  console.log('ok - project happy path → opaque identity, no customer, PII-minimized');
}

async function testIdempotentReplay() {
  const bridge = loadBridge();
  const harness = createFakeBridgeHarness();
  const ev = eventRow();
  harness.events.set(ev.id, ev);
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));

  const a = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));
  const b = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));

  assert.equal(a.status, 'projected');
  assert.equal(b.status, 'already_projected');
  assert.equal(a.conversation_id, b.conversation_id);
  assert.equal(a.message_id, b.message_id);
  assert.equal(harness.messages.size, 1);
  assert.equal(harness.projections.size, 1);
  assert.equal(harness.conversations.size, 1);
  console.log('ok - idempotent exactly-once replay');
}

async function testSameSenderSameLocationThreadsTogether() {
  const bridge = loadBridge();
  const harness = createFakeBridgeHarness();
  const e1 = eventRow({ id: EVENT_ID, provider_message_id: 'msg-a', subject: 'First' });
  const e2 = eventRow({
    id: EVENT_ID_2,
    provider_message_id: 'msg-b',
    subject: 'Second',
    received_at: '2026-08-01T13:00:00.000Z',
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
  assert.equal(r1.conversation_id, r2.conversation_id);
  assert.notEqual(r1.message_id, r2.message_id);
  assert.equal(harness.conversations.size, 1);
  assert.equal(harness.messages.size, 2);
  assert.equal(harness.projections.size, 2);
  console.log('ok - same sender+location → one conversation, two messages');
}

async function testLocationIsolation() {
  const bridge = loadBridge();
  const harness = createFakeBridgeHarness();
  const eSomo = eventRow({
    id: EVENT_ID,
    location_id: LOCATION,
    provider_message_id: 'msg-somo',
  });
  const eSard = eventRow({
    id: EVENT_ID_2,
    location_id: LOCATION_OTHER,
    provider_message_id: 'msg-sard',
  });
  harness.events.set(eSomo.id, eSomo);
  harness.events.set(eSard.id, eSard);
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));

  const r1 = await store.projectInboundEvent(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
    inboundEventId: eSomo.id,
  }));
  const r2 = await store.projectInboundEvent(Object.freeze({
    clientId: CLIENT,
    locationId: LOCATION_OTHER,
    endpointId: ENDPOINT,
    inboundEventId: eSard.id,
  }));

  assert.equal(r1.status, 'projected');
  assert.equal(r2.status, 'projected');
  assert.notEqual(r1.conversation_id, r2.conversation_id);
  assert.equal(harness.conversations.size, 2);
  const metas = [...harness.conversations.values()].map((c) => c.metadata.location_id).sort();
  assert.deepEqual(metas, ['sunset-sardinero', 'sunset-somo']);
  console.log('ok - location isolation (Somo vs Sardinero separate threads)');
}

async function testTenantAuthorityMismatchRejected() {
  const bridge = loadBridge();
  const harness = createFakeBridgeHarness();
  const ev = eventRow();
  harness.events.set(ev.id, ev);
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));

  const wrongClient = await store.projectInboundEvent(Object.freeze({
    clientId: '99999999-9999-4999-8999-999999999999',
    locationId: LOCATION,
    endpointId: ENDPOINT,
    inboundEventId: ev.id,
  }));
  assert.equal(wrongClient.status, 'rejected');
  assert.ok(wrongClient.reason);
  assert.ok(noLeak(wrongClient));
  assert.equal(harness.conversations.size, 0);
  assert.equal(harness.messages.size, 0);
  assert.equal(harness.projections.size, 0);
  console.log('ok - tenant authority mismatch rejected (zero mutation)');
}

async function testMissingSenderRejected() {
  const bridge = loadBridge();
  const harness = createFakeBridgeHarness();
  const ev = eventRow({ sender_address: null });
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
  console.log('ok - missing sender_address rejected');
}

/** Branch 1: commit not applied + connection error → uncertain, zero durable rows. */
async function testCommitNotAppliedUncertain() {
  const bridge = loadBridge();
  const harness = createFakeBridgeHarness();
  const ev = eventRow();
  harness.events.set(ev.id, ev);
  harness.setCommitMode('reject_before_apply');
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));

  const r = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));
  assert.equal(r.status, 'uncertain');
  assert.ok(noLeak(r));
  assert.equal(harness.conversations.size, 0);
  assert.equal(harness.messages.size, 0);
  assert.equal(harness.projections.size, 0);
  console.log('ok - commit not applied → uncertain, zero durable rows');
}

/**
 * Branch 2: commit applied + acknowledgement lost → uncertain first, then
 * replay converges to already_projected with original IDs and no duplicate.
 */
async function testCommitAppliedAckLostReplayConverges() {
  const bridge = loadBridge();
  const harness = createFakeBridgeHarness();
  const ev = eventRow();
  harness.events.set(ev.id, ev);
  harness.setCommitMode('ack_lost_after_apply');
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));

  const first = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));
  assert.equal(first.status, 'uncertain');
  assert.ok(noLeak(first));
  // Commit applied despite lost ack
  assert.equal(harness.projections.size, 1);
  assert.equal(harness.messages.size, 1);
  assert.equal(harness.conversations.size, 1);
  const convId = [...harness.conversations.values()][0].id;
  const msgId = [...harness.messages.values()][0].id;

  harness.setCommitMode(null);
  const replay = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));
  assert.equal(replay.status, 'already_projected');
  assert.equal(replay.conversation_id, convId);
  assert.equal(replay.message_id, msgId);
  assert.equal(harness.messages.size, 1, 'no duplicate message on ack-lost replay');
  assert.equal(harness.projections.size, 1);
  console.log('ok - commit-applied/ack-lost → uncertain then already_projected converges');
}

async function testPureHelpers() {
  const bridge = loadBridge();
  const key = bridge.buildEmailConversationIdentityKey('sunset-somo', 'Guest@Example.COM');
  assert.equal(typeof key, 'string');
  assert.ok(key.startsWith('emailv1:sunset-somo:'));
  assert.equal(key.includes('guest@example.com'), false);
  assert.equal(key.includes('Guest@Example.COM'), false);
  assert.equal(
    bridge.buildEmailConversationIdentityKey('sunset-somo', 'Guest@Example.COM'),
    bridge.buildEmailConversationPhoneKey('sunset-somo', '  guest@example.com  '),
  );
  assert.equal(
    bridge.buildEmailConversationIdentityKey('sunset-sardinero', 'a@b.co')
      === bridge.buildEmailConversationIdentityKey('sunset-somo', 'a@b.co'),
    false,
  );
  assert.equal(bridge.isEmailChannelPhoneNamespace(key), true);
  assert.equal(bridge.isEmailChannelPhoneNamespace('+34600111222'), false);
  assert.equal(bridge.buildEmailMessageText(PLANTED_SUBJECT), PLANTED_SUBJECT);
  assert.equal(bridge.buildEmailMessageText(null), '(no subject)');
  assert.equal(bridge.buildEmailMessageText(''), '(no subject)');
  assert.equal(bridge.EMAIL_INBOUND_INBOX_BRIDGE_RUNTIME_WIRED, false);
  console.log('ok - pure helpers opaque identity + namespace guard');
}

async function testEmailDoesNotMergeWithPhoneCustomer() {
  const bridge = loadBridge();
  const harness = createFakeBridgeHarness();
  // Pre-existing telephone customer
  harness.customers.set(`${CLIENT}\0+34600111222`, {
    client_id: CLIENT,
    phone: '+34600111222',
    email: PLANTED_ADDRESS,
    full_name: 'Phone Guest',
  });
  const ev = eventRow();
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
  assert.ok(bridge.isEmailChannelPhoneNamespace(conv.phone));
  assert.notEqual(conv.phone, '+34600111222');
  // Still only the original phone customer
  assert.equal(harness.customers.size, 1);
  assert.ok(harness.customers.has(`${CLIENT}\0+34600111222`));
  // Email channel conversation is not a WhatsApp destination
  assert.equal(/^\+[0-9]{8,15}$/.test(conv.phone), false);
  console.log('ok - email projection never merges with telephone customer / WhatsApp phone');
}

async function testHostileFactoryAndInput() {
  const bridge = loadBridge();
  assert.throws(() => bridge.createEmailInboundInboxBridge(null));
  assert.throws(() => bridge.createEmailInboundInboxBridge({}));
  assert.throws(() => bridge.createEmailInboundInboxBridge({ withTransactionClient: 'nope' }));
  assert.throws(() => bridge.createEmailInboundInboxBridge({
    withTransactionClient: async () => {},
    extra: true,
  }));

  const harness = createFakeBridgeHarness();
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));

  const bad = await store.projectInboundEvent(Object.freeze({
    clientId: 'not-a-uuid',
    locationId: LOCATION,
    endpointId: ENDPOINT,
    inboundEventId: EVENT_ID,
  }));
  assert.equal(bad.status, 'rejected');

  const proxied = new Proxy(authority(), {
    get(t, p) { return t[p]; },
  });
  let proxyResult;
  try {
    proxyResult = await store.projectInboundEvent(proxied);
  } catch (err) {
    proxyResult = { status: 'rejected', error: err && err.code };
  }
  assert.ok(
    proxyResult.status === 'rejected' || proxyResult.status === 'uncertain',
    'proxy input must not project',
  );
  assert.equal(harness.conversations.size, 0);
  console.log('ok - hostile factory/input fail closed');
}

async function testNoPiiInErrors() {
  const bridge = loadBridge();
  const harness = createFakeBridgeHarness();
  harness.events.set(EVENT_ID, eventRow());
  harness.setFailOn((sql) => /INSERT INTO conversations/.test(sql));
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));
  const r = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: EVENT_ID,
  }));
  assert.notEqual(r.status, 'projected');
  assert.ok(noLeak(r));
  if (r && r.message) assert.ok(noLeak(r.message));
  console.log('ok - no PII in failure surfaces');
}

async function testProjectFromIdentityWithoutEventId() {
  const bridge = loadBridge();
  const harness = createFakeBridgeHarness();
  const ev = eventRow();
  harness.events.set(ev.id, ev);
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));

  const r = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    provider: ev.provider,
    providerMailboxId: ev.provider_mailbox_id,
    providerMessageId: ev.provider_message_id,
  }));
  assert.equal(r.status, 'projected');
  assert.equal(harness.projections.size, 1);
  console.log('ok - project by provider identity (no event id required)');
}

/**
 * Sequential journal conflict path: second projection sees prior journal.
 * True overlapping multi-client race is in prove-email-inbound-inbox-bridge-pglite.
 */
async function testSequentialJournalConflictConvergence() {
  const bridge = loadBridge();
  const harness = createFakeBridgeHarness();
  const ev = eventRow();
  harness.events.set(ev.id, ev);
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient: harness.withTransactionClient,
  }));

  const a = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));
  assert.equal(a.status, 'projected');

  const beforeMsgs = harness.messages.size;
  const b = await store.projectInboundEvent(Object.freeze({
    ...authority(),
    inboundEventId: ev.id,
  }));
  assert.equal(b.status, 'already_projected');
  assert.equal(b.conversation_id, a.conversation_id);
  assert.equal(b.message_id, a.message_id);
  assert.equal(harness.messages.size, beforeMsgs);
  console.log('ok - sequential journal convergence (race proof is integration gate)');
}

/**
 * Overlapping two-loan race on the fake harness: both pass prior-check, both
 * write conversation/message, one wins journal INSERT, loser gets DO NOTHING
 * → ROLLBACK → re-read winner. Proves production conflict/rollback path without
 * inventing message-level dedupe.
 */
async function testOverlappingJournalRaceLoserRollback() {
  const bridge = loadBridge();
  const events = new Map();
  const locations = new Map([
    [`${CLIENT}\0${LOCATION}`, { client_id: CLIENT, id: LOCATION, location_id: 'sunset-somo' }],
  ]);
  const conversations = new Map();
  const messages = new Map();
  const projections = new Map();
  let uuidSeq = 0;
  function nextUuid(prefix) {
    uuidSeq += 1;
    const n = String(uuidSeq).padStart(12, '0');
    return `${prefix}${n.slice(0, 8)}-${n.slice(0, 4)}-4${n.slice(0, 3)}-8${n.slice(0, 3)}-${n}`;
  }

  // Barrier so both loans pass prior-check before either journals.
  let journalArrivals = 0;
  let releaseJournal;
  const journalGate = new Promise((r) => { releaseJournal = r; });
  let activeLoans = 0;
  let maxConcurrent = 0;
  let loanCount = 0;
  let releaseCount = 0;

  async function withTransactionClient(work) {
    loanCount += 1;
    activeLoans += 1;
    if (activeLoans > maxConcurrent) maxConcurrent = activeLoans;
    let inTx = false;
    const stagedConv = new Map();
    const stagedMsg = new Map();
    const stagedProj = new Map();
    const client = {
      async query(sql, params) {
        const norm = String(sql).replace(/\s+/g, ' ').trim();
        if (norm === 'BEGIN') {
          inTx = true;
          stagedConv.clear();
          stagedMsg.clear();
          stagedProj.clear();
          return { rows: [], rowCount: 0 };
        }
        if (norm === 'COMMIT') {
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
          if (ev && ev.client_id === clientId && ev.location_id === locationId && ev.endpoint_id === endpointId) {
            return { rows: [Object.assign({}, ev)], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (/FROM tenant_email_inbound_inbox_projections/.test(norm) && /SELECT/.test(norm)) {
          const [clientId, provider, mailbox, messageId] = params;
          const k = `${provider}\0${mailbox}\0${messageId}`;
          const row = projections.get(k) || stagedProj.get(k);
          if (row && row.client_id === clientId) return { rows: [Object.assign({}, row)], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }
        if (/FROM tenant_locations/.test(norm)) {
          const loc = locations.get(`${params[0]}\0${params[1]}`);
          if (loc) return { rows: [{ location_id: loc.location_id }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }
        if (/^INSERT INTO conversations/.test(norm)) {
          const [clientId, phone, displayName, email, status, botMode, stage, preview, metadataJson, sessionJson] = params;
          const k = `${clientId}\0${phone}`;
          const existing = conversations.get(k) || stagedConv.get(k);
          if (existing) {
            stagedConv.set(k, { ...existing, last_message_preview: preview });
            return { rows: [{ conversation_id: existing.id, created: false }], rowCount: 1 };
          }
          const id = nextUuid('c');
          const row = {
            id, client_id: clientId, phone, display_name: displayName, email, status,
            bot_mode: botMode, conversation_stage: stage, last_message_preview: preview,
            metadata: JSON.parse(metadataJson), session_state: JSON.parse(sessionJson),
          };
          stagedConv.set(k, row);
          return { rows: [{ conversation_id: id, created: true }], rowCount: 1 };
        }
        if (/^INSERT INTO messages/.test(norm)) {
          const [clientId, conversationId, direction, messageText, messageType, source, route, metadataJson] = params;
          const id = nextUuid('m');
          stagedMsg.set(id, {
            id, client_id: clientId, conversation_id: conversationId, direction,
            message_text: messageText, message_type: messageType, source, route,
            metadata: JSON.parse(metadataJson),
          });
          return { rows: [{ message_id: id }], rowCount: 1 };
        }
        if (/^INSERT INTO tenant_email_inbound_inbox_projections/.test(norm)) {
          // Overlap both writers at the journal fence.
          journalArrivals += 1;
          if (journalArrivals === 1) {
            // First arriver waits until second is also at the fence.
            await new Promise((r) => { setImmediate(r); });
          }
          if (journalArrivals >= 2) releaseJournal();
          await journalGate;

          const [
            clientId, locationId, endpointId, inboundEventId,
            provider, mailbox, messageId, conversationId, messageUuid,
          ] = params;
          const k = `${provider}\0${mailbox}\0${messageId}`;
          if (projections.has(k) || stagedProj.has(k)) {
            return { rows: [], rowCount: 0 };
          }
          // Only first durable writer wins (check durable + other staged).
          if (projections.has(k)) return { rows: [], rowCount: 0 };
          // Serialize unique index: check other concurrent staged via durable map after small yield.
          await new Promise((r) => { setImmediate(r); });
          if (projections.has(k)) return { rows: [], rowCount: 0 };
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
          // Claim durable immediately so concurrent peer sees conflict (unique index).
          if (projections.has(k)) return { rows: [], rowCount: 0 };
          projections.set(k, row);
          stagedProj.set(k, row);
          return { rows: [{ id: row.id }], rowCount: 1 };
        }
        throw new Error(`unexpected sql: ${norm.slice(0, 80)}`);
      },
    };
    try {
      return await work(client);
    } finally {
      activeLoans -= 1;
      releaseCount += 1;
    }
  }

  const ev = eventRow();
  events.set(ev.id, ev);
  const store = bridge.createEmailInboundInboxBridge(Object.freeze({
    withTransactionClient,
  }));
  const input = Object.freeze({ ...authority(), inboundEventId: ev.id });
  const [a, b] = await Promise.all([
    store.projectInboundEvent(input),
    store.projectInboundEvent(input),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.ok(
    statuses.includes('projected') || statuses.includes('already_projected'),
    `unexpected statuses ${statuses.join(',')}`,
  );
  // Exactly one durable message and journal
  assert.equal(projections.size, 1, 'exactly one journal after race');
  assert.equal(messages.size, 1, 'loser message rolled back — exactly one durable message');
  assert.equal(conversations.size, 1, 'one conversation key');
  const winner = [...projections.values()][0];
  for (const res of [a, b]) {
    if (res.status === 'projected' || res.status === 'already_projected') {
      assert.equal(res.conversation_id, winner.conversation_id);
      assert.equal(res.message_id, winner.message_id);
    }
  }
  assert.equal(loanCount, 2);
  assert.equal(releaseCount, 2);
  assert.ok(maxConcurrent >= 2, 'loans overlapped');
  console.log('ok - overlapping journal race: loser ROLLBACK, one message+journal, clients released');
}

async function main() {
  console.log('verify-email-inbound-inbox-bridge — RED→GREEN\n');
  assertStaticSurface();
  assertRuntimeUnwiredImportOwnership();
  await testPureHelpers();
  await testProjectHappyPath();
  await testIdempotentReplay();
  await testSameSenderSameLocationThreadsTogether();
  await testLocationIsolation();
  await testTenantAuthorityMismatchRejected();
  await testMissingSenderRejected();
  await testCommitNotAppliedUncertain();
  await testCommitAppliedAckLostReplayConverges();
  await testEmailDoesNotMergeWithPhoneCustomer();
  await testHostileFactoryAndInput();
  await testNoPiiInErrors();
  await testProjectFromIdentityWithoutEventId();
  await testSequentialJournalConflictConvergence();
  await testOverlappingJournalRaceLoserRollback();
  console.log('\nPASS verify-email-inbound-inbox-bridge');
}

main().catch((err) => {
  console.error('FAIL verify-email-inbound-inbox-bridge');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
