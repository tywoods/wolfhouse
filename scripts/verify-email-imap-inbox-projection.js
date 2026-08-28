'use strict';

/**
 * MAIL-MVP-005 — generic IMAP inbound lands in the same Staff Inbox projection
 * as Microsoft Graph: thread list + open thread + guest-linkable.
 *
 * Graph inbound / SMTP send / Auto remain untouched. No live mailbox, no
 * production, no flag flips on staging.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const POLL_REL = 'scripts/lib/email-sunset-imap-inbound-poll.js';
const COMPOSITION_REL = 'scripts/lib/email-imap-sunset-staging-runtime-composition.js';
const BRIDGE_REL = 'scripts/lib/email-inbound-inbox-bridge.js';
const INBOX_REL = 'scripts/browser/inbox-thread.js';
const GRAPH_WORKER_REL = 'scripts/lib/email-delta-sunset-staging-worker.js';
const GRAPH_COMPOSITION_REL = 'scripts/lib/email-delta-sunset-staging-runtime-composition.js';
const SEND_ROUTES_REL = 'scripts/lib/staff-email-inbox-routes.js';
const MVP_DOC_REL = 'docs/MAIL-MVP.md';
const PKG_REL = 'package.json';

const PLANTED = 'super-secret-imap-password-LEAK-005';
const SUNSET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const LOCATION = 'sunset-somo';
const LOCATION_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENDPOINT_ID = '22222222-2222-4222-8222-222222222222';
const GUEST_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MAILBOX = 'tywoods@gmail.com';
const FIXTURE_BODY = 'Hello Luna, I would like to book a lesson.';
const FIXTURE_SUBJECT = 'Booking question';
const FIXTURE_FROM = 'guest@example.com';
const FIXTURE_FROM_NAME = 'Guest';
const FIXTURE_MSG_ID = '<msg17@example.com>';
const FIXTURE_UIDVALIDITY = 3857529045;
const FIXTURE_UID = 17;
const TOKEN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';

const pollOwner = require('./lib/email-sunset-imap-inbound-poll');
const composition = require('./lib/email-imap-sunset-staging-runtime-composition');
const mapper = require('./lib/email-imap-inbound-envelope-mapper');

let pass = 0;
function ok(name) {
  pass += 1;
  console.log(`  PASS  ${name}`);
}

function frozen(value) {
  return Object.freeze(value);
}

function configuredEnv(patch) {
  const env = {
    SUNSET_EMAIL_SETTINGS_UI_ENABLED: 'true',
    LUNA_DEPLOYMENT: 'sunset-staging',
    DEFAULT_CLIENT_SLUG: 'sunset',
    LUNA_EMAIL_SMTP_IDENTITY_REGISTER_ENABLED: 'true',
    LUNA_EMAIL_IMAP_VERIFY_ENABLED: 'true',
    LUNA_EMAIL_IMAP_INBOUND_ENABLED: 'true',
    LUNA_EMAIL_IMAP_POLL_ENABLED: 'true',
    LUNA_EMAIL_IMAP_RUNTIME_COMPOSITION_ENABLED: 'true',
    LUNA_EMAIL_IMAP_WORKER_ENABLED: 'true',
    LUNA_EMAIL_IMAP_HOST_SECRET_REF: 'kv:sunset-imap-host',
    LUNA_EMAIL_IMAP_PORT_SECRET_REF: 'kv:sunset-imap-port',
    LUNA_EMAIL_IMAP_TLS_MODE_SECRET_REF: 'kv:sunset-imap-tls-mode',
    LUNA_EMAIL_IMAP_USERNAME_SECRET_REF: 'kv:sunset-imap-username',
    LUNA_EMAIL_IMAP_PASSWORD_SECRET_REF: 'kv:sunset-imap-password',
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'false',
    LUNA_AUTO_SEND_ENABLED: 'false',
  };
  return frozen(Object.assign(env, patch || {}));
}

function fixtureFetchedMessage() {
  return frozen({
    uid: FIXTURE_UID,
    uidvalidity: FIXTURE_UIDVALIDITY,
    flags: frozen([]),
    internalDate: '20-Aug-2026 10:00:00 +0000',
    headers: frozen({
      from: `${FIXTURE_FROM_NAME} <${FIXTURE_FROM}>`,
      subject: FIXTURE_SUBJECT,
      date: 'Thu, 20 Aug 2026 10:00:00 +0000',
      'message-id': FIXTURE_MSG_ID,
    }),
    bodyText: FIXTURE_BODY,
  });
}

function fakeImapTransport() {
  const fetches = [];
  return frozen({
    fetches,
    async fetchInbox(creds, cursor) {
      fetches.push({ creds, cursor });
      return frozen({
        ok: true,
        uidvalidity: FIXTURE_UIDVALIDITY,
        last_uid: FIXTURE_UID,
        messages: frozen([fixtureFetchedMessage()]),
      });
    },
  });
}

function fakeSecretProvider() {
  const values = {
    'kv:sunset-imap-host': 'imap.example.test',
    'kv:sunset-imap-port': '993',
    'kv:sunset-imap-tls-mode': 'imaps',
    'kv:sunset-imap-username': MAILBOX,
    'kv:sunset-imap-password': PLANTED,
  };
  return frozen({
    async resolveSecret(ref) {
      const value = values[ref];
      if (typeof value !== 'string' || !value) throw new Error('empty');
      return value;
    },
  });
}

function createProjectionHarness(opts) {
  const inboundEnabledStart = opts && opts.inboundEnabled === true;
  let inboundEnabled = inboundEnabledStart;
  const health = opts && Object.prototype.hasOwnProperty.call(opts, 'imapHealth')
    ? opts.imapHealth
    : '2026-08-20T00:00:00.000Z';
  const guests = opts && opts.guests ? opts.guests.slice() : [];
  const events = new Map();
  const conversations = new Map();
  const messages = new Map();
  const projections = new Map();
  const queries = [];
  let uuidSeq = 0;
  let cursor = {
    uidvalidity: 1,
    last_uid: 0,
    lease_owner: null,
    lease_token: null,
    lease_until: null,
  };
  let nowMs = Date.now();

  function nextUuid() {
    uuidSeq += 1;
    const n = String(uuidSeq).padStart(12, '0');
    return `00000000-0000-4000-8000-${n}`;
  }

  function endpointRow() {
    return {
      id: ENDPOINT_ID,
      client_id: SUNSET_ID,
      public_address: MAILBOX,
      provider: 'imap_smtp',
      inbound_enabled: inboundEnabled,
      outbound_enabled: false,
      active: false,
      default_automation_mode: 'off',
      location_id: LOCATION,
      location_key: LOCATION,
      location_uuid: LOCATION_UUID,
      imap_health_verified_at: health,
    };
  }

  function leaseHeld() {
    if (cursor.lease_token == null || cursor.lease_until == null) return false;
    const until = cursor.lease_until instanceof Date
      ? cursor.lease_until.getTime()
      : Date.parse(cursor.lease_until);
    return Number.isFinite(until) && until > nowMs;
  }

  async function query(sql, params) {
    const text = String(sql);
    const norm = text.replace(/\s+/g, ' ').trim();
    queries.push({ text: norm, params: params ? params.slice() : null });

    if (text === pollOwner.SQL_CLAIM) {
      const owner = params[3];
      const token = params[4];
      const ttl = Number(params[5]);
      const until = new Date(nowMs + ttl * 1000);
      if (leaseHeld()) return { rows: [], rowCount: 0 };
      cursor.lease_owner = owner;
      cursor.lease_token = token;
      cursor.lease_until = until;
      return {
        rows: [{
          uidvalidity: cursor.uidvalidity,
          last_uid: cursor.last_uid,
          lease_owner: cursor.lease_owner,
          lease_token: cursor.lease_token,
          lease_until: cursor.lease_until,
        }],
        rowCount: 1,
      };
    }
    if (text === pollOwner.SQL_COMMIT_MONOTONIC) {
      const owner = params[2];
      const token = params[3];
      const uv = Number(params[4]);
      const last = Number(params[5]);
      if (!leaseHeld() || cursor.lease_owner !== owner || cursor.lease_token !== token
          || Number(cursor.uidvalidity) !== uv || Number(cursor.last_uid) > last) {
        return { rows: [], rowCount: 0 };
      }
      cursor.last_uid = last;
      return { rows: [{ uidvalidity: cursor.uidvalidity, last_uid: cursor.last_uid }], rowCount: 1 };
    }
    if (text === pollOwner.SQL_COMMIT_RESET) {
      const owner = params[2];
      const token = params[3];
      const uv = Number(params[4]);
      const last = Number(params[5]);
      if (!leaseHeld() || cursor.lease_owner !== owner || cursor.lease_token !== token
          || Number(cursor.uidvalidity) === uv) {
        return { rows: [], rowCount: 0 };
      }
      cursor.uidvalidity = uv;
      cursor.last_uid = last;
      return { rows: [{ uidvalidity: cursor.uidvalidity, last_uid: cursor.last_uid }], rowCount: 1 };
    }
    if (text === pollOwner.SQL_RELEASE) {
      const owner = params[2];
      const token = params[3];
      if (cursor.lease_owner !== owner || cursor.lease_token !== token) {
        return { rows: [], rowCount: 0 };
      }
      cursor.lease_owner = null;
      cursor.lease_token = null;
      cursor.lease_until = null;
      return { rows: [{ mailbox: 'INBOX' }], rowCount: 1 };
    }

    if (/^BEGIN$/i.test(norm) || /^COMMIT$/i.test(norm) || /^ROLLBACK$/i.test(norm)) {
      return { rows: [], rowCount: 0 };
    }

    if (/SET inbound_enabled\s*=\s*TRUE/i.test(norm)) {
      if (health == null) return { rows: [], rowCount: 0 };
      inboundEnabled = true;
      return { rows: [{ id: ENDPOINT_ID, inbound_enabled: true }], rowCount: 1 };
    }

    if (pollOwner.SQL_DISCOVER && text === pollOwner.SQL_DISCOVER) {
      if (health == null) return { rows: [], rowCount: 0 };
      return { rows: [endpointRow()], rowCount: 1 };
    }

    if (/FROM tenant_channel_endpoints/i.test(norm) || /SELECT id[\s\S]*imap_smtp/i.test(norm)) {
      if (health == null) return { rows: [], rowCount: 0 };
      if (/inbound_enabled\s*=\s*TRUE/i.test(norm) && inboundEnabled !== true) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [endpointRow()], rowCount: 1 };
    }

    if (/INSERT INTO tenant_email_inbound_events/i.test(norm)) {
      const [
        clientId, locationId, endpointId, provider, mailbox, messageId,
        receivedAt, subject, bodyText, displayName, sender, isRead,
        conversationId, internetMessageId,
      ] = params;
      const id = nextUuid();
      events.set(id, {
        id,
        client_id: clientId,
        location_id: locationId,
        endpoint_id: endpointId,
        provider,
        provider_mailbox_id: mailbox,
        provider_message_id: messageId,
        received_at: receivedAt,
        subject,
        body_text: bodyText,
        sender_display_name: displayName,
        sender_address: sender,
        is_read: isRead,
        conversation_id: conversationId,
        internet_message_id: internetMessageId,
      });
      return { rows: [], rowCount: 1 };
    }

    if (/FROM tenant_email_inbound_events/.test(norm) && /provider_message_id\s*=\s*\$6/.test(norm)) {
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

    if (/FROM tenant_email_inbound_inbox_projections/.test(norm) && /SELECT/.test(norm)) {
      const [clientId, provider, mailbox, messageId] = params;
      const k = `${provider}\0${mailbox}\0${messageId}`;
      const row = projections.get(k);
      if (row && row.client_id === clientId) {
        return { rows: [Object.assign({}, row)], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (/FROM tenant_locations/.test(norm)) {
      return { rows: [{ location_id: LOCATION, id: LOCATION_UUID, active: true }], rowCount: 1 };
    }

    if (/FROM guests/.test(norm)) {
      const wanted = String(params[1] || '').toLowerCase();
      const matched = guests.filter((g) => String(g.email).toLowerCase() === wanted);
      return {
        rows: matched.map((g) => ({ guest_id: g.id })),
        rowCount: matched.length,
      };
    }

    if (/^UPDATE conversations/.test(norm) && /guest_id/.test(norm)) {
      const [clientId, conversationId, guestId, fromAddress] = params;
      for (const conv of conversations.values()) {
        if (
          conv.client_id === clientId
          && conv.id === conversationId
          && conv.guest_id == null
          && String(conv.email || '').toLowerCase() === String(fromAddress).toLowerCase()
        ) {
          conv.guest_id = guestId;
          return { rows: [{ conversation_id: conv.id }], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (/^INSERT INTO conversations/.test(norm)) {
      const [
        clientId, phone, displayName, email, status, botMode, stage,
        preview, metadataJson, sessionJson, needsHuman,
      ] = params;
      const k = `${clientId}\0${phone}`;
      const existing = conversations.get(k);
      const meta = typeof metadataJson === 'string' ? JSON.parse(metadataJson) : metadataJson;
      const session = typeof sessionJson === 'string' ? JSON.parse(sessionJson) : sessionJson;
      if (existing) {
        existing.last_message_preview = preview;
        existing.metadata = { ...existing.metadata, ...meta };
        existing.needs_human = needsHuman === true ? true : existing.needs_human === true;
        return { rows: [{ conversation_id: existing.id, created: false }], rowCount: 1 };
      }
      const id = nextUuid();
      conversations.set(k, {
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
        needs_human: needsHuman === true,
        guest_id: null,
      });
      return { rows: [{ conversation_id: id, created: true }], rowCount: 1 };
    }

    if (/^INSERT INTO messages/.test(norm)) {
      const [
        clientId, conversationId, direction, messageText, messageType,
        source, route, metadataJson,
      ] = params;
      const id = nextUuid();
      const meta = typeof metadataJson === 'string' ? JSON.parse(metadataJson) : metadataJson;
      messages.set(id, {
        id,
        client_id: clientId,
        conversation_id: conversationId,
        direction,
        message_text: messageText,
        message_type: messageType,
        source,
        route,
        metadata: meta,
      });
      return { rows: [{ message_id: id }], rowCount: 1 };
    }

    if (/^INSERT INTO tenant_email_inbound_inbox_projections/.test(norm)) {
      const [
        clientId, locationId, endpointId, inboundEventId,
        provider, mailbox, messageId, conversationId, messageUuid,
      ] = params;
      const k = `${provider}\0${mailbox}\0${messageId}`;
      if (projections.has(k)) return { rows: [], rowCount: 0 };
      const row = {
        id: nextUuid(),
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
      projections.set(k, row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (/FROM tenant_email_inbound_events/.test(norm) && /JOIN/.test(norm)) {
      return { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 0 };
  }

  return {
    query,
    queries,
    events,
    conversations,
    messages,
    projections,
    getCursor: () => Object.assign({}, cursor),
    inboundEnabled: () => inboundEnabled,
    listRows() {
      return [...conversations.values()].map((conv) => ({
        id: conv.id,
        display_name: conv.display_name,
        email: conv.email,
        phone: conv.phone,
        last_message_preview: conv.last_message_preview,
        channel: conv.metadata && conv.metadata.channel,
        provider: conv.metadata && conv.metadata.provider,
        guest_id: conv.guest_id,
        needs_human: conv.needs_human === true,
      }));
    },
    openThread(conversationId) {
      const conv = [...conversations.values()].find((row) => row.id === conversationId);
      const thread = [...messages.values()].filter((row) => row.conversation_id === conversationId);
      return { conversation: conv || null, messages: thread };
    },
  };
}

function pollerFor(harness, extra) {
  return pollOwner.createSunsetImapInboundPoll(frozen({
    client: frozen({ query: harness.query.bind(harness) }),
    env: extra && extra.env ? extra.env : configuredEnv(),
    secretProvider: extra && extra.secretProvider ? extra.secretProvider : fakeSecretProvider(),
    imapTransport: extra && extra.imapTransport ? extra.imapTransport : fakeImapTransport(),
    withTransactionClient: async (work) => work(frozen({ query: harness.query.bind(harness) })),
    randomUUID: extra && extra.randomUUID ? extra.randomUUID : () => TOKEN_A,
  }));
}

function noLeak(surface) {
  const text = typeof surface === 'string' ? surface : JSON.stringify(surface);
  assert.ok(!text.includes(PLANTED), 'must not leak IMAP password');
}

async function main() {
  const pollSrc = fs.readFileSync(path.join(ROOT, POLL_REL), 'utf8');
  const compositionSrc = fs.readFileSync(path.join(ROOT, COMPOSITION_REL), 'utf8');
  const bridgeSrc = fs.readFileSync(path.join(ROOT, BRIDGE_REL), 'utf8');
  const inboxSrc = fs.readFileSync(path.join(ROOT, INBOX_REL), 'utf8');
  const graphWorkerSrc = fs.readFileSync(path.join(ROOT, GRAPH_WORKER_REL), 'utf8');
  const sendRoutesSrc = fs.readFileSync(path.join(ROOT, SEND_ROUTES_REL), 'utf8');
  const mvpDoc = fs.readFileSync(path.join(ROOT, MVP_DOC_REL), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, PKG_REL), 'utf8'));

  const mapped = mapper.mapImapFetchedMessageToInboundEnvelope(frozen({
    mailbox: MAILBOX,
    message: fixtureFetchedMessage(),
  }));
  assert.equal(mapped.ok, true);
  assert.equal(mapped.value.provider, 'imap_smtp');
  ok('IMAP FETCH maps to a canonical imap_smtp envelope');

  const readinessOff = composition.resolveEmailImapSunsetStagingRuntimeReadiness({});
  assert.equal(readinessOff.runtime_activation, false);
  const readinessOn = composition.resolveEmailImapSunsetStagingRuntimeReadiness(configuredEnv());
  assert.equal(readinessOn.ok, true);
  assert.equal(readinessOn.runtime_activation, true);
  const outboundOn = composition.resolveEmailImapSunsetStagingRuntimeReadiness(configuredEnv({
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'true',
  }));
  assert.equal(outboundOn.runtime_activation, false);
  const autoOn = composition.resolveEmailImapSunsetStagingRuntimeReadiness(configuredEnv({
    LUNA_AUTO_SEND_ENABLED: 'true',
  }));
  assert.equal(autoOn.runtime_activation, false);
  ok('IMAP runtime activates on sunset-staging poll flags and refuses outbound/Auto');

  assert.equal(typeof pollOwner.pollEligibleSunsetImapInbox === 'function'
    || typeof pollOwner.createSunsetImapInboundPoll === 'function', true);
  assert.equal(typeof pollOwner.SQL_DISCOVER, 'string');
  assert.match(pollOwner.SQL_DISCOVER, /provider='imap_smtp'/);
  assert.match(pollOwner.SQL_DISCOVER, /c\.slug='sunset'/);
  assert.doesNotMatch(pollOwner.SQL_DISCOVER, /client_id=\$1/);
  ok('discover SQL finds the sunset IMAP mailbox without a caller clientId');

  {
    const harness = createProjectionHarness({ inboundEnabled: false });
    const poller = pollerFor(harness);
    assert.equal(typeof poller.pollEligibleSunsetImapInbox, 'function');
    const ack = await poller.pollEligibleSunsetImapInbox();
    assert.equal(ack.ok, true);
    assert.equal(ack.fetched, 1);
    assert.equal(harness.inboundEnabled(), true);
    const list = harness.listRows();
    assert.equal(list.length, 1);
    assert.equal(list[0].channel, 'email');
    assert.equal(list[0].provider, 'imap_smtp');
    assert.equal(list[0].email, FIXTURE_FROM);
    assert.ok(String(list[0].phone).startsWith('emailv1:'));
    assert.equal(String(list[0].phone).toLowerCase().includes(FIXTURE_FROM), false);
    assert.equal(list[0].guest_id, null);
    const opened = harness.openThread(list[0].id);
    assert.equal(opened.messages.length, 1);
    assert.equal(opened.messages[0].direction, 'inbound');
    assert.equal(opened.messages[0].source, 'email_inbound');
    assert.equal(opened.messages[0].message_text, FIXTURE_BODY);
    assert.equal(opened.conversation.last_message_preview, FIXTURE_BODY);
    assert.equal(harness.projections.size, 1);
    const proj = [...harness.projections.values()][0];
    assert.equal(proj.provider, 'imap_smtp');
    noLeak(ack);
    noLeak(list);
    ok('IMAP poll enable+fetch+persist+project lands thread list + open thread, unmatched guest-linkable');
  }

  {
    const harness = createProjectionHarness({
      inboundEnabled: true,
      guests: [{ id: GUEST_ID, email: FIXTURE_FROM }],
    });
    const poller = pollerFor(harness);
    const ack = await poller.pollEligibleSunsetImapInbox();
    assert.equal(ack.ok, true);
    const list = harness.listRows();
    assert.equal(list.length, 1);
    assert.equal(list[0].guest_id, GUEST_ID);
    assert.equal(list[0].email, FIXTURE_FROM);
    ok('exact same-tenant guest email bind is guest-linkable like Graph inbound');
  }

  {
    const harness = createProjectionHarness({ inboundEnabled: false });
    const poller = pollerFor(harness);
    const runtime = composition.createEmailImapSunsetStagingRuntimeComposition(frozen({
      env: configuredEnv(),
      withPgClient: async (work) => work(frozen({ query: harness.query.bind(harness) })),
      timers: { setTimeout() { return 1; }, clearTimeout() {} },
      intervalMs: 60000,
      secretProvider: fakeSecretProvider(),
      imapTransport: fakeImapTransport(),
    }));
    const tick = await runtime.tick();
    assert.equal(tick.status, 'completed');
    assert.equal(harness.listRows().length, 1);
    runtime.stop();
    ok('composition tick discovers IMAP without clientId and projects into Inbox');
  }

  assert.match(compositionSrc, /pollEligibleSunsetImapInbox/);
  assert.doesNotMatch(compositionSrc, /clientId: deps\.clientId/);
  assert.match(pollSrc, /pollEligibleSunsetImapInbox/);
  assert.doesNotMatch(pollSrc, /MAIL FROM|RCPT TO|\bDATA\b|sendMail/);
  assert.doesNotMatch(compositionSrc, /MAIL FROM|RCPT TO|\bDATA\b|sendMail/);
  assert.doesNotMatch(pollSrc, /LUNA_AUTO_SEND_ENABLED\s*=\s*'true'/);
  assert.doesNotMatch(compositionSrc, /EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED\s*=\s*'true'/);
  ok('IMAP path has no SMTP send and does not flip Auto');

  assert.match(graphWorkerSrc, /e\.provider = 'microsoft_graph'/);
  assert.match(sendRoutesSrc, /ev\.provider = 'microsoft_graph' AND ep\.provider = 'microsoft_graph'/);
  const inboxDiff = require('node:child_process').execFileSync(
    'git',
    ['diff', '--', INBOX_REL, GRAPH_WORKER_REL, GRAPH_COMPOSITION_REL, SEND_ROUTES_REL],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(inboxDiff, '', 'Graph inbound/send and inbox-thread.js stay unchanged');
  assert.ok(!inboxSrc.includes('LUNA_EMAIL_IMAP'));
  ok('Graph inbound and inbox-thread.js stay as-is');

  assert.match(bridgeSrc, /imap_smtp/);
  assert.match(
    mvpDoc,
    /\|\s*\*\*005\*\*\s*\|\s*generic IMAP inbound\s*\|\s*Yes/,
  );
  assert.match(mvpDoc, /thread list \+ open thread/);
  assert.doesNotMatch(mvpDoc, /\|\s*\*\*006\*\*.*Yes/);
  assert.equal(pkg.scripts['verify:mail-mvp-005'], 'node scripts/verify-email-imap-inbox-projection.js');
  ok('MAIL-MVP.md marks 005 this job; 006 stays later; npm script present');

  console.log(`PASS MAIL-MVP-005 IMAP inbox projection (${pass} checks)`);
}

main().catch((err) => {
  console.error('FAIL MAIL-MVP-005 IMAP inbox projection');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
