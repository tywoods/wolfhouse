'use strict';

/**
 * EMAIL-REPLY-001 — standing Sunset Microsoft staff reply + subject.
 *
 * Vertical contract over the existing approve-send owner (not a one-shot harness):
 *   A) unsaved current body atomically persists + sends; empty/malformed rejects first
 *   B) saved draft remains compatible; journal exactly-once
 *   C) explicit subject override reaches Microsoft transport and is persisted
 *   D) omitted override derives Re: last subject without doubling; no last → omit
 *   E) same conversation + authority; unknown/cross-tenant fails before network
 *   F) static forbidden-file / no Gmail / no auto-send guards
 *   G) no schema mutation in this slice
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SUBJECT_OWNER = path.join(__dirname, 'lib/email-outbound-reply-subject.js');
const ROUTES_ABS = path.join(__dirname, 'lib/staff-email-inbox-routes.js');
const TRANSPORT_ABS = path.join(__dirname, 'lib/email-microsoft-graph-reply-draft-transport.js');
const COMP_ABS = path.join(__dirname, 'lib/email-outbound-sunset-staging-runtime-composition.js');
const QUERIES_ABS = path.join(__dirname, 'lib/staff-conversation-queries.js');

const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333';
const V = '44444444-4444-4444-8444-444444444444';
const V2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const A = '55555555-5555-4555-8555-555555555555';
const EV = '66666666-6666-4666-8666-666666666666';
const K = 'sunset-somo';
const MAIL = 'desk@sunset.test';
const SRC = 'AAMkAGI2-SRC-EMAIL-REPLY-001';
const BODY = 'EMAIL-REPLY-001 unsaved current editor body.';
const LAST_SUBJECT = 'Sunset lesson availability';
const OVERRIDE = 'Updated lesson times';
const ORIGIN = 'https://staff.sunset.test';
const TOKEN = 'atok-NEVER_LEAK-email-reply-001';
const PLANTED = 'NEVER_LEAK_planted';
const DIGEST = crypto.createHash('sha256').update(BODY, 'utf8').digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const {
  createStaffEmailInboxRoutes,
  EMAIL_APPROVE_SEND_PATH,
  BODY_KEYS,
  snapshotEmailReplyBody,
  snapshotGateEnv,
  ENV_DRAFTS_ENABLED,
  ENV_OUTBOUND_ENABLED,
  ENV_SEND_ENABLED,
  ENV_COMPOSITION_ENABLED,
  ENV_PORTAL_ORIGIN,
  SQL_RESOLVE,
  SQL_APPROVE,
  SQL_JOURNAL_EXISTS,
} = require('./lib/staff-email-inbox-routes');
const {
  EMAIL_AUTHORITY_BOUND_OUTBOUND_RUNTIME_WIRED,
  EMAIL_AUTHORITY_BOUND_OUTBOUND_SAFE_FOR_RUNTIME_ROUTE,
  EMAIL_AUTHORITY_BOUND_OUTBOUND_PERSISTENCE_READY,
} = require('./lib/email-authority-bound-outbound-operation');
const {
  getConversationInboxQuery,
  getConversationDetailQuery,
  getConversationMessagesQuery,
  projectStaffInboxThreadMessage,
  staffInboxThreadMessageSubject,
} = require('./lib/staff-conversation-queries');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  failures.push(name);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function noLeak(v) {
  const t = typeof v === 'string' ? v : (() => {
    try { return JSON.stringify(v); } catch { return String(v); }
  })();
  return ![TOKEN, PLANTED, MAIL, 'access_token', 'refresh_token'].some((s) => t.includes(s));
}

function enabledEnv(extra = {}) {
  return Object.freeze(Object.assign(Object.create(null), {
    [ENV_DRAFTS_ENABLED]: 'true',
    [ENV_OUTBOUND_ENABLED]: 'true',
    [ENV_SEND_ENABLED]: 'true',
    [ENV_COMPOSITION_ENABLED]: 'true',
    [ENV_PORTAL_ORIGIN]: ORIGIN,
  }, extra));
}

function user(o = {}) {
  return { staff_user_id: A, client_id: C, client_slug: 'sunset', role: 'operator', status: 'active', ...o };
}

function captureSend() {
  const calls = [];
  return {
    calls,
    sendJSON(_r, status, body) {
      calls.push({ status, body: body && typeof body === 'object' ? { ...body } : body });
      return body;
    },
  };
}

function mockReq(bodyObj, headers = {}) {
  const ee = new EventEmitter();
  const payload = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  Object.defineProperty(ee, 'headers', {
    value: Object.assign(Object.create(null), {
      'content-type': 'application/json',
      origin: ORIGIN,
    }, headers),
    enumerable: true,
    writable: true,
  });
  ee.destroy = function destroy(err) { ee.emit('error', err || new Error('destroyed')); };
  process.nextTick(() => {
    if (payload) ee.emit('data', Buffer.from(payload, 'utf8'));
    ee.emit('end');
  });
  return ee;
}

function dto(o = {}) {
  return { conversation_id: V, message_text: BODY, approval_id: null, ...o };
}

function authRow(o = {}) {
  return {
    conversation_id: V,
    client_id: C,
    location_id: L,
    location_key: K,
    endpoint_id: E,
    source_inbound_event_id: EV,
    provider: 'microsoft_graph',
    provider_mailbox_id: MAIL,
    provider_source_message_id: SRC,
    endpoint_outbound_enabled: true,
    public_address: MAIL,
    actor_staff_user_id: A,
    ...o,
  };
}

function createReplyPg(opts = {}) {
  const durable = new Map();
  const journal = new Set();
  const mirrors = [];
  const lastSubjects = Array.isArray(opts.lastSubjects) ? opts.lastSubjects.slice() : [];
  let authorityPresent = opts.authorityPresent !== false;
  let foreign = opts.foreign === true;
  let endpointOutbound = opts.endpointOutbound !== false;
  let providerCalls = 0;
  const client = {
    async query(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n === 'BEGIN' || n === 'COMMIT' || n === 'ROLLBACK') return { rows: [] };
      if (/FROM clients cl/.test(n) || n === SQL_RESOLVE) {
        if (foreign || !authorityPresent
            || String(params[0]).toLowerCase() !== C
            || String(params[1]).toLowerCase() !== A
            || String(params[2]).toLowerCase() !== V) {
          return { rows: [] };
        }
        return { rows: [{ ...authRow({ endpoint_outbound_enabled: endpointOutbound }) }] };
      }
      if (/tenant_email_inbound_events/.test(n) && /subject/.test(n) && /UNION ALL/i.test(n)) {
        if (!lastSubjects.length) return { rows: [] };
        return { rows: [{ subject: lastSubjects[lastSubjects.length - 1] }] };
      }
      if (/^INSERT INTO tenant_email_reply_approvals/.test(n)) {
        const approvalId = String(params[0]).toLowerCase();
        const operationId = String(params[1]).toLowerCase();
        const row = {
          approval_id: approvalId,
          operation_id: operationId,
          client_id: String(params[2]).toLowerCase(),
          location_id: String(params[3]).toLowerCase(),
          location_key: String(params[4]),
          endpoint_id: String(params[5]).toLowerCase(),
          conversation_id: String(params[6]).toLowerCase(),
          source_inbound_event_id: String(params[7]).toLowerCase(),
          provider: 'microsoft_graph',
          provider_mailbox_id: String(params[8]),
          provider_source_message_id: String(params[9]),
          draft_actor_staff_user_id: String(params[10]).toLowerCase(),
          approved_actor_staff_user_id: null,
          message_text: String(params[11]),
          body_digest: String(params[12]),
          state: 'draft',
        };
        durable.set(approvalId, row);
        return { rows: [{ approval_id: row.approval_id, message_text: row.message_text, conversation_id: row.conversation_id }] };
      }
      if (/FOR UPDATE/.test(n) && /tenant_email_reply_approvals/.test(n)) {
        const row = durable.get(String(params[0]).toLowerCase());
        if (!row || row.client_id !== String(params[1]).toLowerCase()
            || row.conversation_id !== String(params[2]).toLowerCase()) {
          return { rows: [] };
        }
        return { rows: [{ ...row }] };
      }
      if (n === SQL_JOURNAL_EXISTS) {
        return { rows: journal.has(String(params[2]).toLowerCase()) ? [{ journal_exists: 1 }] : [] };
      }
      if (/state='approved'/.test(n) || /state = 'approved'/.test(n)) {
        const row = durable.get(String(params[0]).toLowerCase());
        if (!row || row.client_id !== String(params[1]).toLowerCase()
            || row.conversation_id !== String(params[2]).toLowerCase()
            || row.state !== 'draft') return { rows: [] };
        if (row.operation_id !== String(params[3]).toLowerCase()) return { rows: [] };
        if (row.message_text !== String(params[5]) || row.body_digest !== String(params[6])) return { rows: [] };
        row.state = 'approved';
        row.approved_actor_staff_user_id = String(params[4]).toLowerCase();
        return { rows: [{ approval_id: row.approval_id, conversation_id: row.conversation_id, message_text: row.message_text, state: row.state }] };
      }
      if (/^INSERT INTO messages/.test(n) && /staff_email_reply/.test(n)) {
        let meta = {};
        try { meta = JSON.parse(String(params[3] || '{}')); } catch { meta = {}; }
        mirrors.push({
          client_id: String(params[0]).toLowerCase(),
          conversation_id: String(params[1]).toLowerCase(),
          message_text: String(params[2]),
          metadata: meta,
        });
        return { rows: [{ message_id: crypto.randomUUID() }] };
      }
      if (/^UPDATE conversations/.test(n)) return { rows: [] };
      return { rows: [] };
    },
  };
  return {
    durable,
    journal,
    mirrors,
    client,
    setForeign(v) { foreign = v === true; },
    setAuthorityPresent(v) { authorityPresent = v === true; },
    setEndpointOutbound(v) { endpointOutbound = v === true; },
    noteProvider() { providerCalls += 1; },
    get providerCalls() { return providerCalls; },
    withPgClient: async (fn) => fn(client),
  };
}

function loadSubjectOwner() {
  try {
    return require('./lib/email-outbound-reply-subject');
  } catch (err) {
    return { __load_error: err && err.message ? err.message : String(err) };
  }
}

async function main() {
  console.log('verify:email-reply-001 — EMAIL-REPLY-001 standing staff reply + subject\n');

  const subjectOwner = loadSubjectOwner();
  ok('A/D subject owner module loads', !subjectOwner.__load_error, subjectOwner.__load_error);

  if (!subjectOwner.__load_error) {
    const {
      SUBJECT_MAX_CHARS,
      validateOutboundReplySubject,
      deriveReplySubject,
      resolveOutboundReplySubject,
      SQL_LAST_PERSISTED_SUBJECT,
    } = subjectOwner;
    ok('D derive Re: last without inventing',
      deriveReplySubject(LAST_SUBJECT) === `Re: ${LAST_SUBJECT}`
      && deriveReplySubject('Re: Hello') === 'Re: Hello'
      && deriveReplySubject('RE: Hello') === 'Re: Hello'
      && deriveReplySubject(' re:  Hello ') === 'Re: Hello'
      && deriveReplySubject(null) === null
      && deriveReplySubject('') === null
      && deriveReplySubject('   ') === null
      && deriveReplySubject('(no subject)') === null);
    const valid = validateOutboundReplySubject(OVERRIDE);
    ok('D validate accepts exact own-data subject',
      valid && valid.ok === true && valid.value === OVERRIDE
      && SUBJECT_MAX_CHARS === 200);
    ok('D newline/CR/header injection reject',
      validateOutboundReplySubject('Hello\nBcc: evil@x').ok === false
      && validateOutboundReplySubject('Hello\r\nX-Inject: 1').ok === false
      && validateOutboundReplySubject('Hello\u0000').ok === false);
    ok('D oversize reject',
      validateOutboundReplySubject('x'.repeat(201)).ok === false
      && validateOutboundReplySubject('x'.repeat(200)).ok === true);
    ok('D proxy/accessor/symbol reject', (() => {
      const accessor = {};
      Object.defineProperty(accessor, 'length', { get() { return 4; } });
      let proxiedRejected = false;
      try {
        const proxied = new Proxy(Object('Hello'), { get(t, p) { return t[p]; } });
        proxiedRejected = validateOutboundReplySubject(proxied).ok === false;
      } catch {
        proxiedRejected = true;
      }
      return validateOutboundReplySubject(accessor).ok === false
        && proxiedRejected
        && validateOutboundReplySubject(Symbol('subject')).ok === false
        && validateOutboundReplySubject({ toString() { return OVERRIDE; } }).ok === false;
    })());
    ok('D resolve override vs derived vs omit',
      resolveOutboundReplySubject({ overridePresent: true, override: OVERRIDE, lastSubject: LAST_SUBJECT }).value === OVERRIDE
      && resolveOutboundReplySubject({ overridePresent: false, lastSubject: LAST_SUBJECT }).value === `Re: ${LAST_SUBJECT}`
      && resolveOutboundReplySubject({ overridePresent: false, lastSubject: 'Re: Prior' }).value === 'Re: Prior'
      && resolveOutboundReplySubject({ overridePresent: false, lastSubject: null }).value === null
      && resolveOutboundReplySubject({ overridePresent: false, lastSubject: '(no subject)' }).value === null);
    ok('D last-subject SQL reads inbound events + outbound records only',
      typeof SQL_LAST_PERSISTED_SUBJECT === 'string'
      && /tenant_email_inbound_events/.test(SQL_LAST_PERSISTED_SUBJECT)
      && /metadata->>'email_subject'/.test(SQL_LAST_PERSISTED_SUBJECT)
      && /staff_email_reply/.test(SQL_LAST_PERSISTED_SUBJECT)
      && !/\(no subject\)/.test(SQL_LAST_PERSISTED_SUBJECT)
      && !/placeholder/i.test(SQL_LAST_PERSISTED_SUBJECT));
  }

  ok('existing 3-key BODY_KEYS remain compatible',
    Array.isArray(BODY_KEYS) && BODY_KEYS.join(',') === 'conversation_id,message_text,approval_id');
  ok('snapshot still accepts UI 3-key payload without subject',
    !!snapshotEmailReplyBody(dto()) && snapshotEmailReplyBody(dto()).approval_id === null
    && snapshotEmailReplyBody(dto()).message_text === BODY
    && !Object.prototype.hasOwnProperty.call(snapshotEmailReplyBody(dto()), 'subject'));
  const withSubject = snapshotEmailReplyBody({
    conversation_id: V, message_text: BODY, approval_id: null, subject: OVERRIDE,
  });
  ok('A/C snapshot accepts optional subject override key',
    !!withSubject && withSubject.subject === OVERRIDE && withSubject.approval_id === null);
  ok('D hostile subject in snapshot fails closed',
    snapshotEmailReplyBody({
      conversation_id: V, message_text: BODY, approval_id: null, subject: 'Bad\nSubject',
    }) === null
    && snapshotEmailReplyBody({
      conversation_id: V, message_text: BODY, approval_id: null, subject: 'x'.repeat(201),
    }) === null);
  ok('A empty/malformed body still rejected at snapshot',
    snapshotEmailReplyBody(dto({ message_text: '' })) === null
    && snapshotEmailReplyBody({ conversation_id: V, approval_id: null }) === null
    && snapshotEmailReplyBody(dto({ conversation_id: 'not-a-uuid' })) === null);

  const gate = snapshotGateEnv(enabledEnv());

  {
    const pg = createReplyPg();
    const send = captureSend();
    let sealed = null;
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      runtimeEnv: enabledEnv(),
      outboundDispatch: async (req) => {
        pg.noteProvider();
        sealed = req;
        pg.journal.add(req.operation_id);
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleApproveSend(mockReq(dto()), {}, user(), gate);
    const call = send.calls[0];
    const created = [...pg.durable.values()][0];
    ok('A unsaved current body approve-send 200 without prior draft row',
      !!call && call.status === 200 && call.body && call.body.success === true
      && call.body.conversation_id === V
      && UUID_RE.test(String(call.body.approval_id || ''))
      && call.body.approval_state === 'approved'
      && created && created.state === 'approved' && created.message_text === BODY
      && created.body_digest === DIGEST
      && pg.providerCalls === 1 && sealed && sealed.message_text === BODY
      && sealed.conversation_id === V && sealed.client_id === C
      && noLeak(call.body),
      call ? `status=${call.status} error=${call.body && call.body.error}` : 'no response');
    ok('A unsaved path persists sent thread mirror atomically',
      pg.mirrors.length === 1
      && pg.mirrors[0].conversation_id === V
      && pg.mirrors[0].message_text === BODY
      && pg.mirrors[0].metadata.approval_id === created.approval_id);
  }

  {
    const pg = createReplyPg();
    const send = captureSend();
    let provider = 0;
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      runtimeEnv: enabledEnv(),
      outboundDispatch: async () => { provider += 1; return Object.freeze({ ok: true, code: 'email_send_committed' }); },
    });
    await routes.handleApproveSend(mockReq(dto({ message_text: '' })), {}, user(), gate);
    ok('A empty body 400 before provider',
      send.calls[0] && send.calls[0].status === 400
      && send.calls[0].body.error === 'invalid_request'
      && provider === 0 && pg.durable.size === 0);
    send.calls.length = 0;
    await routes.handleApproveSend(mockReq({ conversation_id: V, message_text: BODY }), {}, user(), gate);
    ok('A missing approval_id key still 400 (exact keys)',
      send.calls[0] && send.calls[0].status === 400 && provider === 0);
  }

  {
    const pg = createReplyPg();
    const send = captureSend();
    let dispatches = 0;
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      runtimeEnv: enabledEnv(),
      outboundDispatch: async (req) => {
        dispatches += 1;
        pg.journal.add(req.operation_id);
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleDraft(mockReq(dto()), {}, user(), gate);
    const ap = send.calls[0].body.approval_id;
    send.calls.length = 0;
    await routes.handleApproveSend(mockReq(dto({ approval_id: ap })), {}, user(), gate);
    await routes.handleApproveSend(mockReq(dto({ approval_id: ap })), {}, user(), gate);
    ok('B saved draft still sends once; retry journal-absent closed',
      dispatches === 1
      && send.calls[0].status === 200
      && send.calls[1].status === 409
      && send.calls[1].body.error === 'approval_conflict'
      && pg.durable.get(ap).state === 'approved');
  }

  {
    const pg = createReplyPg({ lastSubjects: [LAST_SUBJECT] });
    const send = captureSend();
    let sealed = null;
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      runtimeEnv: enabledEnv(),
      outboundDispatch: async (req) => {
        sealed = req;
        pg.journal.add(req.operation_id);
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleApproveSend(mockReq({
      conversation_id: V, message_text: BODY, approval_id: null, subject: OVERRIDE,
    }), {}, user(), gate);
    ok('C explicit subject override reaches sealed Microsoft dispatch',
      send.calls[0] && send.calls[0].status === 200
      && sealed && sealed.subject === OVERRIDE
      && sealed.message_text === BODY
      && sealed.conversation_id === V,
      sealed ? `subject=${sealed.subject}` : (send.calls[0] && send.calls[0].body && send.calls[0].body.error));
    ok('C exact override persisted on outbound thread record',
      pg.mirrors[0] && pg.mirrors[0].metadata.email_subject === OVERRIDE);
    const projected = projectStaffInboxThreadMessage({
      message_id: 'm-out',
      direction: 'outbound',
      message_text: BODY,
      source: 'staff_email_reply',
      route: 'email',
      email_subject: pg.mirrors[0] && pg.mirrors[0].metadata.email_subject,
      body_text: BODY,
    });
    ok('C subsequent thread projection returns exact persisted subject',
      staffInboxThreadMessageSubject(projected) === OVERRIDE);
  }

  {
    const pg = createReplyPg({ lastSubjects: [LAST_SUBJECT] });
    const send = captureSend();
    let sealed = null;
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      runtimeEnv: enabledEnv(),
      outboundDispatch: async (req) => {
        sealed = req;
        pg.journal.add(req.operation_id);
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleApproveSend(mockReq(dto()), {}, user(), gate);
    ok('D omitted override derives Re: last persisted subject',
      send.calls[0] && send.calls[0].status === 200
      && sealed && sealed.subject === `Re: ${LAST_SUBJECT}`
      && pg.mirrors[0] && pg.mirrors[0].metadata.email_subject === `Re: ${LAST_SUBJECT}`,
      sealed ? `subject=${sealed.subject}` : 'no sealed request');
  }

  {
    const pg = createReplyPg({ lastSubjects: ['Re: Already prefixed'] });
    const send = captureSend();
    let sealed = null;
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      runtimeEnv: enabledEnv(),
      outboundDispatch: async (req) => {
        sealed = req;
        pg.journal.add(req.operation_id);
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleApproveSend(mockReq(dto()), {}, user(), gate);
    ok('D existing Re: is not doubled',
      sealed && sealed.subject === 'Re: Already prefixed'
      && !/^Re: Re:/i.test(String(sealed && sealed.subject || '')));
  }

  {
    const pg = createReplyPg({ lastSubjects: [] });
    const send = captureSend();
    let sealed = null;
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      runtimeEnv: enabledEnv(),
      outboundDispatch: async (req) => {
        sealed = req;
        pg.journal.add(req.operation_id);
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleApproveSend(mockReq(dto()), {}, user(), gate);
    ok('D no last subject omits subject rather than inventing',
      send.calls[0] && send.calls[0].status === 200
      && sealed && !Object.prototype.hasOwnProperty.call(sealed, 'subject')
      && (!pg.mirrors[0] || pg.mirrors[0].metadata.email_subject == null));
  }

  {
    const pg = createReplyPg();
    const send = captureSend();
    let provider = 0;
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      runtimeEnv: enabledEnv(),
      outboundDispatch: async () => { provider += 1; return Object.freeze({ ok: true, code: 'email_send_committed' }); },
    });
    await routes.handleApproveSend(mockReq({
      conversation_id: V, message_text: BODY, approval_id: null, subject: 'Hello\nInjected',
    }), {}, user(), gate);
    const accessor = {
      conversation_id: V, message_text: BODY, approval_id: null,
    };
    Object.defineProperty(accessor, 'subject', { get() { return OVERRIDE; }, enumerable: true });
    ok('D newline/accessor subject rejects before provider',
      send.calls[0] && send.calls[0].status === 400
      && provider === 0 && pg.durable.size === 0
      && snapshotEmailReplyBody(accessor) === null);
  }

  {
    const pg = createReplyPg({ authorityPresent: false });
    const send = captureSend();
    let provider = 0;
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      runtimeEnv: enabledEnv(),
      outboundDispatch: async () => { provider += 1; return Object.freeze({ ok: true, code: 'email_send_committed' }); },
    });
    await routes.handleApproveSend(mockReq(dto()), {}, user(), gate);
    ok('E unknown conversation 404 before network',
      send.calls[0] && send.calls[0].status === 404 && provider === 0 && noLeak(send.calls[0].body));
    pg.setAuthorityPresent(true);
    pg.setForeign(true);
    send.calls.length = 0;
    await routes.handleApproveSend(mockReq(dto()), {}, user(), gate);
    ok('E cross-tenant conversation 404 before network',
      send.calls[0] && send.calls[0].status === 404 && provider === 0);
  }

  {
    const pg = createReplyPg();
    const send = captureSend();
    let sealed = null;
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      runtimeEnv: enabledEnv(),
      outboundDispatch: async (req) => {
        sealed = req;
        pg.journal.add(req.operation_id);
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleApproveSend(mockReq(dto()), {}, user(), gate);
    ok('E same conversation/tenant/provider authority on dispatch',
      sealed
      && sealed.conversation_id === V
      && sealed.client_id === C
      && sealed.location_id === L
      && sealed.location_key === K
      && sealed.endpoint_id === E
      && sealed.provider_source_message_id === SRC
      && !('to' in sealed)
      && !('provider_message_id' in sealed));
  }

  const inboxSql = getConversationInboxQuery();
  const detailSql = getConversationDetailQuery();
  const threadSql = getConversationMessagesQuery();
  ok('C/D list/detail current subject from inbound/outbound records',
    /tenant_email_inbound_events/.test(inboxSql)
    && /staff_email_reply/.test(inboxSql)
    && /email_subject/.test(inboxSql)
    && /tenant_email_inbound_events/.test(detailSql)
    && /staff_email_reply/.test(detailSql)
    && /email_subject/.test(threadSql));

  if (!subjectOwner.__load_error && typeof subjectOwner.createMicrosoftGraphReplyDraftTransportWithSubject === 'function') {
    ok('C transport helper exported', true);
  } else if (!subjectOwner.__load_error) {
    const transportSrc = fs.readFileSync(TRANSPORT_ABS, 'utf8');
    ok('C updateApprovedDraft can PATCH optional subject',
      /updateApprovedDraft/.test(transportSrc) && /subject/.test(transportSrc));
  }

  const changed = spawnSync('git', ['diff', '--name-only', '88402eddb85a42c03e91599ac3059a6054073b9b'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
  });
  const names = String(changed.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const forbidden = names.filter((n) => (
    n === 'scripts/browser/inbox-thread.js'
    || /^scripts\/browser\/inbox-/.test(n)
    || /gmail/i.test(n)
    || /google/i.test(n)
    || /email-inbound-delta/.test(n)
    || /email-delta-sunset-staging-worker/.test(n)
    || n.startsWith('infra/')
    || n.startsWith('database/')
  ));
  ok('F no Inbox chrome / Gmail / inbound worker / schema / infra edits',
    forbidden.length === 0, forbidden.join(','));
  const routesSrc = fs.readFileSync(ROUTES_ABS, 'utf8');
  const compSrc = fs.readFileSync(COMP_ABS, 'utf8');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  ok('F no auto-send enablement; human approve-send only',
    !/LUNA_AUTO_SEND_ENABLED['"]?\s*[:=]\s*['"]true['"]/.test(routesSrc)
    && !/auto_send\s*=\s*true/.test(routesSrc)
    && EMAIL_AUTHORITY_BOUND_OUTBOUND_RUNTIME_WIRED === false
    && EMAIL_AUTHORITY_BOUND_OUTBOUND_SAFE_FOR_RUNTIME_ROUTE === false
    && EMAIL_AUTHORITY_BOUND_OUTBOUND_PERSISTENCE_READY === false
    && /EMAIL_AUTHORITY_BOUND_OUTBOUND_AUTO_RESEND = false/.test(
      fs.readFileSync(path.join(__dirname, 'lib/email-authority-bound-outbound-operation.js'), 'utf8'),
    ));
  ok('F standing route only; no operator one-shot harness as the feature',
    EMAIL_APPROVE_SEND_PATH === '/staff/inbox/email/approve-send'
    && apiSrc.includes('emailInboxRoutes.handleApproveSend')
    && /createSunsetStagingEmailOutboundDispatch/.test(apiSrc)
    && !/scripts\/prove-email-reply-001/.test(apiSrc));
  ok('F Google files untouched and no new Gmail helpers',
    names.every((n) => !/gmail|google/i.test(n))
    && !/gmail/i.test(routesSrc)
    && !/createGmail/.test(compSrc));
  ok('F outbound_enabled remains DB registry + env gate; no live DB mutation',
    /endpoint_outbound_enabled/.test(routesSrc)
    && !/UPDATE tenant_channel_endpoints[\s\S]{0,200}outbound_enabled/.test(routesSrc)
    && !names.some((n) => n.startsWith('database/migrations/')));
  ok('G no SQL migration in this slice',
    !names.some((n) => /\.sql$/.test(n)));

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('package script present', pkg.scripts['verify:email-reply-001'] === 'node scripts/verify-email-reply-001.js');

  console.log(`\n── verify:email-reply-001 ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
