#!/usr/bin/env node
'use strict';

/**
 * MAIL-MVP-006 — generic SMTP Create Draft + Approve & send for an imap_smtp
 * mailbox, same staff Inbox loop as Microsoft, without a live send.
 *
 * Graph send path, IMAP FETCH fail-close, and Auto stay off. Missing SMTP
 * host secret / transport still writes approval + outbound journal and
 * fail-closes.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const ROOT = path.join(__dirname, '..');
const SEND_ROUTES_REL = 'scripts/lib/staff-email-inbox-routes.js';
const GRAPH_TRANSPORT_REL = 'scripts/lib/email-microsoft-graph-reply-draft-transport.js';
const GRAPH_COMPOSITION_REL = 'scripts/lib/email-outbound-sunset-staging-runtime-composition.js';
const IMAP_TRANSPORT_REL = 'scripts/lib/email-sunset-imap-imaps-transport.js';
const IMAP_001_REL = 'scripts/verify-email-imap-001.js';
const IMAP_POLL_REL = 'scripts/lib/email-sunset-imap-inbound-poll.js';
const INBOX_REL = 'scripts/browser/inbox-thread.js';
const AUTO_REL = 'scripts/lib/email-luna-microsoft-auto-create-send.js';
const MVP_DOC_REL = 'docs/MAIL-MVP.md';
const PKG_REL = 'package.json';
const SMTP_TRANSPORT_REL = 'scripts/lib/email-sunset-smtp-send-transport.js';
const SMTP_COMPOSITION_REL = 'scripts/lib/email-smtp-sunset-staging-outbound-composition.js';
const MIGRATION_REL = 'database/migrations/099_tenant_email_imap_smtp_outbound_provider.sql';

const ORIGIN = 'https://staff.sunset.test';
const C = '11111111-1111-4111-8111-111111111111';
const A = '55555555-5555-4555-8555-555555555555';
const V = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const L = '33333333-3333-4333-8333-333333333333';
const E = '44444444-4444-4444-8444-444444444444';
const EV = '77777777-7777-4777-8777-777777777777';
const MAILBOX = 'tywoods@example.test';
const RECIPIENT = 'guest@example.com';
const SRC = 'uidvalidity:3857529045:uid:17';
const BODY = 'Thanks for writing — a teammate can follow up shortly.';
const SUBJECT = 'Re: Booking question';

const routesOwner = require('./lib/staff-email-inbox-routes');
const smtpTransportOwner = require('./lib/email-sunset-smtp-send-transport');
const smtpComposition = require('./lib/email-smtp-sunset-staging-outbound-composition');

let pass = 0;
function ok(name) {
  pass += 1;
  console.log(`  PASS  ${name}`);
}

function frozen(value) {
  return Object.freeze(value);
}

function sendEnv(patch) {
  return frozen(Object.assign({
    EMAIL_STAFF_EMAIL_DRAFTS_ENABLED: 'true',
    EMAIL_STAFF_OUTBOUND_ENABLED: 'true',
    EMAIL_OUTBOUND_SEND_ENABLED: 'false',
    EMAIL_OUTBOUND_RUNTIME_COMPOSITION_ENABLED: 'false',
    LUNA_EMAIL_SMTP_OUTBOUND_SEND_ENABLED: 'true',
    LUNA_EMAIL_SMTP_OUTBOUND_COMPOSITION_ENABLED: 'true',
    LUNA_AUTO_SEND_ENABLED: 'false',
    LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'false',
    LUNA_EMAIL_SMTP_AUTO_SEND_ENABLED: 'false',
    LUNA_DEPLOYMENT: 'sunset-staging',
    STAFF_PORTAL_ORIGIN: ORIGIN,
    LUNA_EMAIL_SMTP_HOST_SECRET_REF: 'kv:sunset-smtp-host',
    LUNA_EMAIL_SMTP_PORT_SECRET_REF: 'kv:sunset-smtp-port',
    LUNA_EMAIL_SMTP_TLS_MODE_SECRET_REF: 'kv:sunset-smtp-tls-mode',
    LUNA_EMAIL_SMTP_USERNAME_SECRET_REF: 'kv:sunset-smtp-username',
    LUNA_EMAIL_SMTP_PASSWORD_SECRET_REF: 'kv:sunset-smtp-password',
  }, patch || {}));
}

function user() {
  return {
    staff_user_id: A, email: 'op@t', role: 'operator', status: 'active',
    display_name: 'Op', client_id: C, client_slug: 'sunset', session_id: 's1',
  };
}

function mockReq(body) {
  const ee = new EventEmitter();
  const payload = JSON.stringify(body);
  Object.defineProperty(ee, 'headers', {
    value: Object.assign(Object.create(null), { 'content-type': 'application/json', origin: ORIGIN }),
    enumerable: true,
    writable: true,
  });
  process.nextTick(() => { ee.emit('data', Buffer.from(payload, 'utf8')); ee.emit('end'); });
  return ee;
}

function captureSend() {
  const calls = [];
  return { calls, sendJSON(_res, status, body) { calls.push({ status, body }); } };
}

function dto(o) {
  return Object.assign({
    conversation_id: V, message_text: BODY, approval_id: null, subject: SUBJECT, email_subject: SUBJECT,
  }, o || {});
}

function createFakeWorld() {
  const durable = new Map();
  const journal = [];
  const mirrors = [];
  const queries = [];
  const client = {
    async query(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      queries.push(n);
      if (n === 'BEGIN' || n === 'COMMIT' || n === 'ROLLBACK') return { rows: [] };
      if (n === routesOwner.SQL_RESOLVE || (n.includes("ev.provider = 'microsoft_graph'") && n.includes('FOR UPDATE'))) {
        return { rows: [] };
      }
      if (n === routesOwner.SQL_RESOLVE_SMTP || (n.includes("ev.provider = 'imap_smtp'") && n.includes('smtp_health_verified_at'))) {
        return {
          rows: [{
            conversation_id: V, client_id: C, location_id: L, location_key: 'sunset-somo',
            endpoint_id: E, source_inbound_event_id: EV, provider: 'imap_smtp',
            provider_mailbox_id: MAILBOX, provider_source_message_id: SRC,
            endpoint_outbound_enabled: true, public_address: MAILBOX,
            actor_staff_user_id: A, recipient_email: RECIPIENT,
          }],
        };
      }
      if (/c\.phone ~ '\^\(emailv1\|email\):'/.test(n) && /LIMIT 1/.test(n) && !n.includes('imap_smtp')) {
        return { rows: [{ conversation_id: V }] };
      }
      if (/^INSERT INTO tenant_email_reply_approvals/.test(n)) {
        const provider = n.includes("'imap_smtp'") ? 'imap_smtp' : 'microsoft_graph';
        const row = {
          approval_id: String(params[0]).toLowerCase(),
          operation_id: String(params[1]).toLowerCase(),
          client_id: String(params[2]).toLowerCase(),
          location_id: String(params[3]).toLowerCase(),
          location_key: String(params[4]),
          endpoint_id: String(params[5]).toLowerCase(),
          conversation_id: String(params[6]).toLowerCase(),
          source_inbound_event_id: String(params[7]).toLowerCase(),
          provider,
          provider_mailbox_id: String(params[8]),
          provider_source_message_id: String(params[9]),
          message_text: String(params[11]),
          body_digest: String(params[12]),
          subject: params[13] == null ? null : String(params[13]),
          state: 'draft',
        };
        durable.set(row.approval_id, row);
        return { rows: [{ approval_id: row.approval_id, message_text: row.message_text, conversation_id: row.conversation_id, subject: row.subject }] };
      }
      if (/SET message_text/.test(n)) return { rows: [] };
      if (/FOR UPDATE/.test(n) && /tenant_email_reply_approvals/.test(n)) {
        const id = String(params[0]).toLowerCase();
        const row = durable.get(id);
        if (!row || row.conversation_id !== String(params[2]).toLowerCase()) return { rows: [] };
        return { rows: [{ ...row }] };
      }
      if (n === routesOwner.SQL_JOURNAL_EXISTS) {
        const op = String(params[2]).toLowerCase();
        return { rows: journal.some((j) => j.operation_id === op) ? [{ journal_exists: 1 }] : [] };
      }
      if (/state='approved'/.test(n) || /state = 'approved'/.test(n)) {
        const row = durable.get(String(params[0]).toLowerCase());
        if (!row || row.state !== 'draft') return { rows: [] };
        if (row.operation_id !== String(params[3]).toLowerCase()) return { rows: [] };
        if (row.message_text !== String(params[5])) return { rows: [] };
        row.state = 'approved';
        return { rows: [{ approval_id: row.approval_id, conversation_id: row.conversation_id, message_text: row.message_text, subject: row.subject, state: row.state }] };
      }
      if (/INSERT INTO tenant_email_outbound_send_journal/.test(n)) {
        const provider = n.includes("'imap_smtp'") ? 'imap_smtp' : 'microsoft_graph';
        const row = {
          operation_id: String(params[0]).toLowerCase(),
          approval_id: String(params[6]).toLowerCase(),
          provider,
          phase: 'claimed',
          outcome: 'claimed',
          body_digest: String(params[8] || params[params.length - 1]),
        };
        journal.push(row);
        return { rows: [{ ...row, create_invocation_count: 0, update_invocation_count: 0, send_invocation_count: 0, immutable_draft_id: null }] };
      }
      if (/UPDATE tenant_email_outbound_send_journal/.test(n)) {
        const op = String(params[0]).toLowerCase();
        const row = journal.find((j) => j.operation_id === op);
        if (!row) return { rows: [] };
        if (/phase='create_dispatched'/.test(n)) { row.phase = 'create_dispatched'; row.outcome = 'outcome_unknown'; }
        else if (/phase='draft_created'/.test(n)) { row.phase = 'draft_created'; row.outcome = 'not_committed'; row.immutable_draft_id = params[1]; }
        else if (/phase='update_dispatched'/.test(n)) { row.phase = 'update_dispatched'; row.outcome = 'outcome_unknown'; }
        else if (/phase='draft_updated'/.test(n)) { row.phase = 'draft_updated'; row.outcome = 'not_committed'; }
        else if (/phase='send_dispatched'/.test(n)) { row.phase = 'send_dispatched'; row.outcome = 'outcome_unknown'; }
        else if (/phase='reconciled_sent'/.test(n)) { row.phase = 'reconciled_sent'; row.outcome = 'committed'; }
        else if (/phase='terminal'/.test(n)) { row.phase = 'terminal'; row.outcome = String(params[1]); }
        return { rows: [{ ...row, create_invocation_count: 1, update_invocation_count: 1, send_invocation_count: row.phase === 'claimed' ? 0 : 1 }] };
      }
      if (/INSERT INTO messages/.test(n) && /staff_email_reply/.test(n)) {
        const approvalId = (() => {
          try { return JSON.parse(params[3]).approval_id; } catch { return null; }
        })();
        if (mirrors.some((m) => m.approval_id === approvalId)) return { rows: [] };
        mirrors.push({ approval_id: approvalId, conversation_id: String(params[1]).toLowerCase(), body: params[2] });
        return { rows: [{ id: crypto.randomUUID() }] };
      }
      if (/UPDATE conversations/.test(n) || /last_message/.test(n) || /SQL_LAST_PERSISTED_SUBJECT/.test(n) || /tenant_email_reply_approvals/.test(n) && /subject/.test(n) && /SELECT/.test(n)) {
        return { rows: [] };
      }
      throw new Error(`unexpected_sql:${n.slice(0, 120)}`);
    },
  };
  return {
    durable,
    journal,
    mirrors,
    queries,
    withPgClient: async (fn) => fn(client),
  };
}

async function main() {
  console.log('verify:mail-mvp-006 generic SMTP send\n');

  const sendRoutesSrc = fs.readFileSync(path.join(ROOT, SEND_ROUTES_REL), 'utf8');
  const graphTransportSrc = fs.readFileSync(path.join(ROOT, GRAPH_TRANSPORT_REL), 'utf8');
  const graphCompositionSrc = fs.readFileSync(path.join(ROOT, GRAPH_COMPOSITION_REL), 'utf8');
  const imapTransportSrc = fs.readFileSync(path.join(ROOT, IMAP_TRANSPORT_REL), 'utf8');
  const imap001Src = fs.readFileSync(path.join(ROOT, IMAP_001_REL), 'utf8');
  const imapPollSrc = fs.readFileSync(path.join(ROOT, IMAP_POLL_REL), 'utf8');
  const inboxSrc = fs.readFileSync(path.join(ROOT, INBOX_REL), 'utf8');
  const autoSrc = fs.readFileSync(path.join(ROOT, AUTO_REL), 'utf8');
  const mvpDoc = fs.readFileSync(path.join(ROOT, MVP_DOC_REL), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, PKG_REL), 'utf8'));
  const smtpTransportSrc = fs.readFileSync(path.join(ROOT, SMTP_TRANSPORT_REL), 'utf8');
  const smtpCompositionSrc = fs.readFileSync(path.join(ROOT, SMTP_COMPOSITION_REL), 'utf8');
  const migrationSrc = fs.readFileSync(path.join(ROOT, MIGRATION_REL), 'utf8');
  const migrationDownSrc = fs.readFileSync(path.join(ROOT, MIGRATION_REL.replace(/\.sql$/, '_down.sql')), 'utf8');

  assert.match(sendRoutesSrc, /ev\.provider = 'microsoft_graph' AND ep\.provider = 'microsoft_graph'/);
  assert.match(sendRoutesSrc, /ev\.provider = 'imap_smtp' AND ep\.provider = 'imap_smtp'/);
  assert.match(graphTransportSrc, /function sendDraft/);
  assert.doesNotMatch(graphTransportSrc, /imap_smtp/);
  assert.doesNotMatch(graphCompositionSrc, /LUNA_EMAIL_SMTP_OUTBOUND_SEND_ENABLED/);
  ok('Graph SQL_RESOLVE and Graph send composition stay Graph-only');

  assert.match(imapTransportSrc, /IMAP_FETCH_MAX_MESSAGES/);
  assert.match(imap001Src, /FETCH with unrequested UID fails closed/);
  assert.doesNotMatch(imapPollSrc, /MAIL FROM|RCPT TO|\\bDATA\\b|sendMail/);
  assert.doesNotMatch(imapTransportSrc, /MAIL FROM|RCPT TO/);
  ok('IMAP FETCH fail-close stays shipped; IMAP poll does not send');

  assert.match(autoSrc, /provider_not_microsoft/);
  assert.equal(smtpComposition.isEmailSmtpAutoSendEnabled({}), false);
  assert.equal(smtpComposition.isEmailSmtpAutoSendEnabled(sendEnv({
    LUNA_AUTO_SEND_ENABLED: 'true',
    LUNA_EMAIL_OUTBOUND_AUTO_SEND_ENABLED: 'true',
  })), false);
  assert.doesNotMatch(smtpCompositionSrc, /LUNA_AUTO_SEND_ENABLED\s*=\s*'true'/);
  assert.doesNotMatch(inboxSrc, /LUNA_EMAIL_SMTP_OUTBOUND/);
  ok('Auto stays off; SMTP auto is fail-closed/default-off');

  assert.match(smtpTransportSrc, /MAIL FROM/);
  assert.match(smtpTransportSrc, /RCPT TO/);
  assert.match(smtpTransportSrc, /\bDATA\b/);
  assert.equal(typeof smtpTransportOwner.createSunsetSmtpSendTransport, 'function');
  ok('SMTP send transport owns MAIL FROM / RCPT TO / DATA');

  assert.match(migrationSrc, /imap_smtp/);
  assert.match(migrationSrc, /tenant_email_reply_approvals_provider_values/);
  assert.match(migrationSrc, /tenant_email_outbound_send_journal_provider_values/);
  assert.match(migrationDownSrc, /cannot roll back 099 while imap_smtp/);
  ok('099 widens approval + journal provider CHECKs with refuse-down');

  assert.match(mvpDoc, /## 006 generic SMTP send/);
  assert.match(mvpDoc, /\|\s*\*\*006\*\*.*No/);
  assert.match(mvpDoc, /\|\s*\*\*008\*\*.*Yes/);
  assert.equal(pkg.scripts['verify:mail-mvp-006'], 'node scripts/verify-email-smtp-send.js');
  ok('MAIL-MVP-006 is documented as landed; 008 is this job; npm script present');

  {
    const world = createFakeWorld();
    const sent = [];
    const graphDispatchCalls = [];
    const env = sendEnv();
    const surface = smtpComposition.createSunsetStagingEmailSmtpOutboundDispatch(frozen({
      env,
      pgClient: { query: async () => ({ rows: [] }) },
      withTransactionClient: async (work) => world.withPgClient((pg) => work(pg)),
      smtpTransport: frozen({
        async sendMail(credentials, envelope) {
          sent.push({ credentials, envelope });
          return frozen({ ok: true });
        },
      }),
      secretProvider: frozen({
        async resolveSecret(ref) {
          const values = {
            'kv:sunset-smtp-host': 'smtp.example.test',
            'kv:sunset-smtp-port': '587',
            'kv:sunset-smtp-tls-mode': 'starttls',
            'kv:sunset-smtp-username': MAILBOX,
            'kv:sunset-smtp-password': 'not-a-live-secret',
          };
          return values[ref];
        },
      }),
    }));
    const cap = captureSend();
    const routes = routesOwner.createStaffEmailInboxRoutes({
      sendJSON: cap.sendJSON,
      withPgClient: world.withPgClient,
      runtimeEnv: env,
      createOutboundDispatch() {
        graphDispatchCalls.push('graph');
        return frozen({
          async dispatchApprovedOutbound() {
            throw new Error('graph_dispatch_must_not_run');
          },
        });
      },
      createSmtpOutboundDispatch() { return surface; },
    });
    await routes.handleDraft(mockReq(dto()), {}, user(), routesOwner.snapshotGateEnv(env));
    assert.equal(cap.calls[0].status, 200);
    const approvalId = cap.calls[0].body.approval_id;
    assert.equal(world.durable.get(approvalId).provider, 'imap_smtp');
    assert.equal(world.durable.get(approvalId).state, 'draft');
    assert.equal(sent.length, 0);
    ok('Create Draft on generic IMAP mailbox writes imap_smtp approval, no send');

    cap.calls.length = 0;
    await routes.handleApproveSend(
      mockReq(dto({ approval_id: approvalId })),
      {},
      user(),
      routesOwner.snapshotGateEnv(env),
    );
    assert.equal(world.durable.get(approvalId).state, 'approved');
    assert.equal(world.journal.length >= 1, true);
    assert.equal(world.journal.every((j) => j.provider === 'imap_smtp'), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].envelope.from, MAILBOX);
    assert.equal(sent[0].envelope.to, RECIPIENT);
    assert.equal(sent[0].envelope.text, BODY);
    assert.equal(cap.calls[0].status, 200);
    assert.equal(cap.calls[0].body.success, true);
    assert.equal(graphDispatchCalls.length, 0);
    assert.equal(world.mirrors.length, 1);
    ok('Approve & send journals imap_smtp, calls injected SMTP send, never Graph');
  }

  {
    const world = createFakeWorld();
    const sent = [];
    const env = sendEnv({
      LUNA_EMAIL_SMTP_HOST_SECRET_REF: 'kv:wrong-host',
    });
    const surface = smtpComposition.createSunsetStagingEmailSmtpOutboundDispatch(frozen({
      env,
      pgClient: { query: async () => ({ rows: [] }) },
      withTransactionClient: async (work) => world.withPgClient((pg) => work(pg)),
      smtpTransport: frozen({
        async sendMail() {
          sent.push('sent');
          return frozen({ ok: true });
        },
      }),
      secretProvider: frozen({
        async resolveSecret() { throw new Error('should_not_resolve'); },
      }),
    }));
    const cap = captureSend();
    const routes = routesOwner.createStaffEmailInboxRoutes({
      sendJSON: cap.sendJSON,
      withPgClient: world.withPgClient,
      runtimeEnv: env,
      createSmtpOutboundDispatch() { return surface; },
    });
    await routes.handleDraft(mockReq(dto()), {}, user(), routesOwner.snapshotGateEnv(env));
    const approvalId = cap.calls[0].body.approval_id;
    cap.calls.length = 0;
    await routes.handleApproveSend(
      mockReq(dto({ approval_id: approvalId })),
      {},
      user(),
      routesOwner.snapshotGateEnv(env),
    );
    assert.equal(world.durable.get(approvalId).state, 'approved');
    assert.equal(world.journal.length >= 1, true);
    assert.equal(world.journal[0].provider, 'imap_smtp');
    assert.equal(sent.length, 0);
    assert.equal(cap.calls[0].status, 503);
    assert.equal(cap.calls[0].body.success, false);
    ok('missing SMTP host secret fail-closes after approval + journal, no transport send');
  }

  {
    const world = createFakeWorld();
    const sent = [];
    const env = sendEnv({
      LUNA_EMAIL_SMTP_OUTBOUND_SEND_ENABLED: 'false',
      LUNA_EMAIL_SMTP_OUTBOUND_COMPOSITION_ENABLED: 'false',
    });
    const surface = smtpComposition.createSunsetStagingEmailSmtpOutboundDispatch(frozen({
      env,
      pgClient: { query: async () => ({ rows: [] }) },
      withTransactionClient: async (work) => world.withPgClient((pg) => work(pg)),
      smtpTransport: frozen({
        async sendMail() { sent.push('sent'); return frozen({ ok: true }); },
      }),
    }));
    const cap = captureSend();
    const routes = routesOwner.createStaffEmailInboxRoutes({
      sendJSON: cap.sendJSON,
      withPgClient: world.withPgClient,
      runtimeEnv: env,
      createSmtpOutboundDispatch() { return surface; },
    });
    await routes.handleDraft(mockReq(dto()), {}, user(), routesOwner.snapshotGateEnv(env));
    const approvalId = cap.calls[0].body.approval_id;
    cap.calls.length = 0;
    await routes.handleApproveSend(
      mockReq(dto({ approval_id: approvalId })),
      {},
      user(),
      routesOwner.snapshotGateEnv(env),
    );
    assert.equal(world.durable.get(approvalId).state, 'approved');
    assert.equal(world.journal.length >= 1, true);
    assert.equal(sent.length, 0);
    assert.equal(cap.calls[0].status, 503);
    ok('SMTP send flags default-off still journal a would-be send and do not transport');
  }

  console.log(`PASS MAIL-MVP-006 generic SMTP send (${pass} checks)`);
}

main().catch((err) => {
  console.error('FAIL MAIL-MVP-006 generic SMTP send');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
