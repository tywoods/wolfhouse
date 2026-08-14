'use strict';

/**
 * EMAIL-REPLY-001 — standing Sunset Microsoft staff reply + persisted subject.
 *
 * After master Deckhand UI (b2134ff5) + draft-open (eefe5206):
 *   one Approve click already does draft-save then approve-send with a stable
 *   approval_id. Approve-send must NOT mint on approval_id:null.
 *
 * Contract:
 *   A) UI one-click Approve = draft then approve; API null approval rejects first
 *   B) saved draft / stable approval replay is exactly-once
 *   C) subject persisted on tenant_email_reply_approvals before Graph
 *   D) current UI 5-key payload (subject + email_subject, equal strings) and
 *      legacy 3-key; omitted/empty pair defaults to Re: last persisted subject
 *      (no doubling) in the draft transaction; mismatch/accessor/proxy/extras
 *      rejected before DB/Graph
 *   E) sealed dispatch + PATCH use locked persisted subject
 *   F) mirror-fail / outcome_unknown recovery repairs exact subject once
 *   G) list/detail current subject is inbound + committed outbound only
 *   H) 081 migration real-schema proof; no UI / Gmail / inbound / auto-send
 */

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
const THREAD_ABS = path.join(__dirname, 'browser/inbox-thread.js');
const MIG_080 = path.join(ROOT, 'database/migrations/080_tenant_email_delta_from_now_v2.sql');
const MIG_081 = path.join(ROOT, 'database/migrations/081_tenant_email_reply_approvals_subject.sql');
const MIG_081_DOWN = path.join(ROOT, 'database/migrations/081_tenant_email_reply_approvals_subject_down.sql');
const MIG_070 = path.join(ROOT, 'database/migrations/070_tenant_email_reply_approvals.sql');
const MANIFEST_ABS = path.join(ROOT, 'database/migrations/canonical-manifest.json');

const C = '11111111-1111-4111-8111-111111111111';
const L = '22222222-2222-4222-8222-222222222222';
const E = '33333333-3333-4333-8333-333333333333';
const V = '44444444-4444-4444-8444-444444444444';
const A = '55555555-5555-4555-8555-555555555555';
const EV = '66666666-6666-4666-8666-666666666666';
const K = 'sunset-somo';
const MAIL = 'desk@sunset.test';
const SRC = 'AAMkAGI2-SRC-EMAIL-REPLY-001';
const BODY = 'EMAIL-REPLY-001 unsaved current editor body.';
const LAST_SUBJECT = 'Sunset lesson availability';
const OVERRIDE = 'Updated lesson times';
const UI_SUBJECT = `Re: ${LAST_SUBJECT}`;
const ORIGIN = 'https://staff.sunset.test';
const TOKEN = 'atok-NEVER_LEAK-email-reply-001';
const PLANTED = 'NEVER_LEAK_planted';
const DIGEST = crypto.createHash('sha256').update(BODY, 'utf8').digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const {
  createStaffEmailInboxRoutes,
  EMAIL_APPROVE_SEND_PATH,
  EMAIL_DRAFT_PATH,
  EMAIL_RECOVER_SEND_PATH,
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
  SQL_LOAD_APPROVAL,
  SQL_JOURNAL_RECOVERY_PHASE,
  sealApprovedDispatchRequest,
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
  sqlCurrentEmailSubjectExpr,
} = require('./lib/staff-conversation-queries');
const { SQL_LAST_PERSISTED_SUBJECT } = require('./lib/email-outbound-reply-subject');

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

function legacyDto(o = {}) {
  return { conversation_id: V, message_text: BODY, approval_id: null, ...o };
}

function uiDto(o = {}) {
  const subject = Object.prototype.hasOwnProperty.call(o, 'subject') ? o.subject : UI_SUBJECT;
  const emailSubject = Object.prototype.hasOwnProperty.call(o, 'email_subject') ? o.email_subject : subject;
  const out = {
    conversation_id: Object.prototype.hasOwnProperty.call(o, 'conversation_id') ? o.conversation_id : V,
    message_text: Object.prototype.hasOwnProperty.call(o, 'message_text') ? o.message_text : BODY,
    subject,
    email_subject: emailSubject,
    approval_id: Object.prototype.hasOwnProperty.call(o, 'approval_id') ? o.approval_id : null,
  };
  return out;
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
  const journal = new Map();
  const mirrors = [];
  const lastSubjects = Array.isArray(opts.lastSubjects) ? opts.lastSubjects.slice() : [];
  let authorityPresent = opts.authorityPresent !== false;
  let foreign = opts.foreign === true;
  let endpointOutbound = opts.endpointOutbound !== false;
  let providerCalls = 0;
  let dbHits = 0;
  let mirrorFailRemaining = opts.mirrorFailRemaining || 0;
  let lastSubjectError = opts.lastSubjectError || null;
  let lastSql = null;
  const queries = [];
  const lastSubjectQueries = [];
  const client = {
    async query(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      lastSql = n;
      queries.push(n);
      dbHits += 1;
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
      if (n === SQL_LAST_PERSISTED_SUBJECT
          || (/tenant_email_inbound_events/.test(n) && /subject/.test(n) && /UNION ALL/i.test(n))) {
        lastSubjectQueries.push({ sql: n, params: Array.isArray(params) ? params.slice() : [] });
        if (lastSubjectError) throw lastSubjectError;
        if (!lastSubjects.length) return { rows: [] };
        return { rows: [{ subject: lastSubjects[lastSubjects.length - 1] }] };
      }
      if (/^INSERT INTO tenant_email_reply_approvals/.test(n)) {
        const approvalId = String(params[0]).toLowerCase();
        const operationId = String(params[1]).toLowerCase();
        const subject = params.length > 13 ? (params[13] == null ? null : params[13]) : null;
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
          subject: subject == null ? null : String(subject),
          state: 'draft',
        };
        durable.set(approvalId, row);
        return {
          rows: [{
            approval_id: row.approval_id,
            message_text: row.message_text,
            conversation_id: row.conversation_id,
            subject: row.subject,
          }],
        };
      }
      if (/SET message_text/.test(n) && /state='draft'/.test(n)) {
        const row = durable.get(String(params[0]).toLowerCase());
        if (!row || row.client_id !== String(params[1]).toLowerCase()
            || row.conversation_id !== String(params[2]).toLowerCase()
            || row.state !== 'draft') return { rows: [] };
        row.message_text = String(params[3]);
        row.body_digest = String(params[4]);
        row.draft_actor_staff_user_id = String(params[5]).toLowerCase();
        if (params.length > 6) row.subject = params[6] == null ? null : String(params[6]);
        return {
          rows: [{
            approval_id: row.approval_id,
            message_text: row.message_text,
            conversation_id: row.conversation_id,
            subject: row.subject,
          }],
        };
      }
      if ((/FOR UPDATE/.test(n) || n === SQL_LOAD_APPROVAL || /FROM tenant_email_reply_approvals/.test(n))
          && /tenant_email_reply_approvals/.test(n)
          && !/^INSERT /.test(n) && !/^UPDATE /.test(n)) {
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
      if (n === SQL_JOURNAL_RECOVERY_PHASE || (/FROM tenant_email_outbound_send_journal/.test(n) && /phase/.test(n))) {
        const j = journal.get(String(params[2]).toLowerCase());
        if (!j) return { rows: [] };
        return {
          rows: [{
            phase: j.phase,
            outcome: j.outcome,
            create_invocation_count: String(j.create_invocation_count || 1),
            update_invocation_count: String(j.update_invocation_count || 1),
            send_invocation_count: String(j.send_invocation_count || 1),
          }],
        };
      }
      if (/state='approved'/.test(n) || /state = 'approved'/.test(n)) {
        const row = durable.get(String(params[0]).toLowerCase());
        if (!row || row.client_id !== String(params[1]).toLowerCase()
            || row.conversation_id !== String(params[2]).toLowerCase()
            || row.state !== 'draft') return { rows: [] };
        if (row.operation_id !== String(params[3]).toLowerCase()) return { rows: [] };
        if (row.message_text !== String(params[5]) || row.body_digest !== String(params[6])) return { rows: [] };
        if (params.length > 7) {
          const exp = params[7] == null ? null : String(params[7]);
          const got = row.subject == null ? null : String(row.subject);
          if (exp !== got) return { rows: [] };
        }
        row.state = 'approved';
        row.approved_actor_staff_user_id = String(params[4]).toLowerCase();
        return {
          rows: [{
            approval_id: row.approval_id,
            conversation_id: row.conversation_id,
            message_text: row.message_text,
            subject: row.subject,
            state: row.state,
          }],
        };
      }
      if (/^INSERT INTO messages/.test(n) && /staff_email_reply/.test(n)) {
        if (mirrorFailRemaining > 0) {
          mirrorFailRemaining -= 1;
          const err = new Error('mirror_insert_failed');
          err.code = '57014';
          throw err;
        }
        let meta = {};
        try { meta = JSON.parse(String(params[3] || '{}')); } catch { meta = {}; }
        const key = `${params[0]}:${params[1]}:${meta.approval_id || ''}`;
        if (mirrors.some((m) => m._key === key)) return { rows: [] };
        const rec = {
          _key: key,
          client_id: String(params[0]).toLowerCase(),
          conversation_id: String(params[1]).toLowerCase(),
          message_text: String(params[2]),
          metadata: meta,
        };
        mirrors.push(rec);
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
    queries,
    lastSubjectQueries,
    get lastSql() { return lastSql; },
    get dbHits() { return dbHits; },
    resetDbHits() { dbHits = 0; },
    setForeign(v) { foreign = v === true; },
    setAuthorityPresent(v) { authorityPresent = v === true; },
    setEndpointOutbound(v) { endpointOutbound = v === true; },
    setLastSubjects(arr) { lastSubjects.splice(0, lastSubjects.length, ...arr); },
    setLastSubjectError(err) { lastSubjectError = err || null; },
    setMirrorFailRemaining(n) { mirrorFailRemaining = n; },
    noteProvider() { providerCalls += 1; },
    get providerCalls() { return providerCalls; },
    markJournal(operationId, extra = {}) {
      journal.set(String(operationId).toLowerCase(), {
        phase: extra.phase || 'reconciled_sent',
        outcome: extra.outcome || 'committed',
        create_invocation_count: extra.createC != null ? extra.createC : 1,
        update_invocation_count: extra.updateC != null ? extra.updateC : 1,
        send_invocation_count: extra.sendC != null ? extra.sendC : 1,
      });
    },
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

function tryLoadPglite() {
  const candidates = [
    '@electric-sql/pglite',
    '/opt/data/wolfhouse-agent/node_modules/@electric-sql/pglite',
    '/opt/data/workspace/sandbox-repos/WH-email-m1-012/node_modules/@electric-sql/pglite',
    path.join(ROOT, 'node_modules/@electric-sql/pglite'),
  ];
  for (const spec of candidates) {
    try { return require(spec).PGlite; } catch { /* */ }
  }
  return null;
}

async function main() {
  console.log('verify:email-reply-001 — EMAIL-REPLY-001 standing staff reply + persisted subject\n');

  const subjectOwner = loadSubjectOwner();
  ok('subject owner module loads', !subjectOwner.__load_error, subjectOwner.__load_error);

  if (!subjectOwner.__load_error) {
    const {
      SUBJECT_MAX_CHARS,
      validateOutboundReplySubject,
      deriveReplySubject,
      resolveOutboundReplySubject,
      SQL_LAST_PERSISTED_SUBJECT,
    } = subjectOwner;
    ok('derive Re: last without inventing or doubling',
      deriveReplySubject(LAST_SUBJECT) === `Re: ${LAST_SUBJECT}`
      && deriveReplySubject('Re: Hello') === 'Re: Hello'
      && deriveReplySubject('RE: Hello') === 'Re: Hello'
      && deriveReplySubject(null) === null
      && deriveReplySubject('') === null
      && deriveReplySubject('(no subject)') === null);
    ok('validate accepts exact own-data subject',
      validateOutboundReplySubject(OVERRIDE).ok === true
      && validateOutboundReplySubject(OVERRIDE).value === OVERRIDE
      && SUBJECT_MAX_CHARS === 200);
    ok('newline/CR/header injection reject',
      validateOutboundReplySubject('Hello\nBcc: evil@x').ok === false
      && validateOutboundReplySubject('Hello\r\nX-Inject: 1').ok === false
      && validateOutboundReplySubject('Hello\u0000').ok === false);
    ok('oversize reject',
      validateOutboundReplySubject('x'.repeat(201)).ok === false
      && validateOutboundReplySubject('x'.repeat(200)).ok === true);
    ok('proxy/accessor/symbol reject', (() => {
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
        && validateOutboundReplySubject(Symbol('subject')).ok === false;
    })());
    ok('resolve override vs derived vs omit (owner helper)',
      resolveOutboundReplySubject({ overridePresent: true, override: OVERRIDE, lastSubject: LAST_SUBJECT }).value === OVERRIDE
      && resolveOutboundReplySubject({ overridePresent: false, lastSubject: LAST_SUBJECT }).value === `Re: ${LAST_SUBJECT}`
      && resolveOutboundReplySubject({ overridePresent: false, lastSubject: null }).value === null);
    ok('last-subject SQL is inbound + committed outbound only',
      typeof SQL_LAST_PERSISTED_SUBJECT === 'string'
      && /tenant_email_inbound_events/.test(SQL_LAST_PERSISTED_SUBJECT)
      && /staff_email_reply/.test(SQL_LAST_PERSISTED_SUBJECT)
      && !/tenant_email_reply_approvals/.test(SQL_LAST_PERSISTED_SUBJECT)
      && !/\(no subject\)/.test(SQL_LAST_PERSISTED_SUBJECT));
  }

  ok('legacy 3-key BODY_KEYS remain compatible',
    Array.isArray(BODY_KEYS) && BODY_KEYS.join(',') === 'conversation_id,message_text,approval_id');

  const legacySnap = snapshotEmailReplyBody(legacyDto());
  ok('legacy 3-key snapshot still accepted (draft mint shape)',
    !!legacySnap && legacySnap.approval_id === null
    && legacySnap.message_text === BODY
    && !Object.prototype.hasOwnProperty.call(legacySnap, 'subject'));

  const uiSnap = snapshotEmailReplyBody(uiDto());
  ok('current master UI 5-key payload accepted (subject === email_subject)',
    !!uiSnap && uiSnap.subject === UI_SUBJECT && uiSnap.approval_id === null,
    uiSnap ? `subject=${uiSnap.subject}` : 'snapshot rejected current UI payload');

  const emptyUi = snapshotEmailReplyBody(uiDto({ subject: '', email_subject: '' }));
  ok('empty equal subject pair normalizes to null — no placeholder',
    !!emptyUi
    && emptyUi.subject === null
    && Object.prototype.hasOwnProperty.call(emptyUi, 'subject')
    && emptyUi.subject !== '(no subject)');

  ok('subject/email_subject mismatch rejected before DB',
    snapshotEmailReplyBody(uiDto({ subject: OVERRIDE, email_subject: UI_SUBJECT })) === null
    && snapshotEmailReplyBody(uiDto({ subject: OVERRIDE, email_subject: `${OVERRIDE} ` })) === null);

  ok('4-key subject-only shape rejected (strict allowed shapes: 3-key or 5-key)',
    snapshotEmailReplyBody({
      conversation_id: V, message_text: BODY, approval_id: null, subject: OVERRIDE,
    }) === null);

  ok('extras / accessor / proxy 5-key rejected', (() => {
    const extra = uiDto();
    extra.evil = 1;
    const accessor = {
      conversation_id: V, message_text: BODY, approval_id: null, email_subject: OVERRIDE,
    };
    Object.defineProperty(accessor, 'subject', { get() { return OVERRIDE; }, enumerable: true });
    let proxied = false;
    try {
      const p = new Proxy(uiDto(), { get(t, k) { return t[k]; } });
      proxied = snapshotEmailReplyBody(p) === null;
    } catch {
      proxied = true;
    }
    return snapshotEmailReplyBody(extra) === null
      && snapshotEmailReplyBody(accessor) === null
      && proxied;
  })());

  ok('hostile subject in 5-key fails closed',
    snapshotEmailReplyBody(uiDto({ subject: 'Bad\nSubject', email_subject: 'Bad\nSubject' })) === null
    && snapshotEmailReplyBody(uiDto({ subject: 'x'.repeat(201), email_subject: 'x'.repeat(201) })) === null);

  ok('empty/malformed body still rejected at snapshot',
    snapshotEmailReplyBody(legacyDto({ message_text: '' })) === null
    && snapshotEmailReplyBody({ conversation_id: V, approval_id: null }) === null
    && snapshotEmailReplyBody(uiDto({ conversation_id: 'not-a-uuid' })) === null);

  const threadSrc = fs.readFileSync(THREAD_ABS, 'utf8');
  ok('master UI Approve click is save-then-approve (no extra Save click)',
    /function performEmailDraftSave\(convId, targetEl, thenApprove\)/.test(threadSrc)
    && /performEmailDraftSave\(convId, targetEl, true\)/.test(threadSrc)
    && /function performEmailApproveSend/.test(threadSrc)
    && /if \(!st\.approvalId \|\| messageText !== st\.savedText \|\| subjectText !== String\(st\.savedSubject \|\| ''\)\)/.test(threadSrc));
  ok('master UI payload is 5-key subject+email_subject byte contract',
    /subject: subjectText/.test(threadSrc)
    && /email_subject: subjectText/.test(threadSrc)
    && /approval_id: st\.approvalId == null \? null : st\.approvalId/.test(threadSrc)
    && /approval_id: snapApprovalId/.test(threadSrc)
    && /fetch\('\/staff\/inbox\/email\/draft'/.test(threadSrc)
    && /fetch\('\/staff\/inbox\/email\/approve-send'/.test(threadSrc));

  const gate = snapshotGateEnv(enabledEnv());

  {
    const pg = createReplyPg();
    const send = captureSend();
    let provider = 0;
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: async (fn) => {
        pg.resetDbHits();
        return pg.withPgClient(fn);
      },
      runtimeEnv: enabledEnv(),
      outboundDispatch: async () => {
        provider += 1;
        pg.noteProvider();
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleApproveSend(mockReq(uiDto({ approval_id: null })), {}, user(), gate);
    const first = send.calls[0];
    await routes.handleApproveSend(mockReq(legacyDto({ approval_id: null })), {}, user(), gate);
    const second = send.calls[1];
    ok('A null approval_id approve-send 400 before DB/network (replay cannot mint)',
      !!first && first.status === 400 && first.body && first.body.error === 'invalid_request'
      && !!second && second.status === 400
      && provider === 0 && pg.durable.size === 0 && pg.providerCalls === 0
      && noLeak(first.body),
      first ? `status=${first.status} error=${first.body && first.body.error} durable=${pg.durable.size} provider=${provider}` : 'no response');
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
        pg.noteProvider();
        sealed = req;
        pg.markJournal(req.operation_id);
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleDraft(mockReq(uiDto({ approval_id: null })), {}, user(), gate);
    const draftCall = send.calls[0];
    const ap = draftCall && draftCall.body && draftCall.body.approval_id;
    const drafted = ap && pg.durable.get(ap);
    ok('A UI draft-save mints stable approval and persists subject',
      !!draftCall && draftCall.status === 200 && UUID_RE.test(String(ap || ''))
      && drafted && drafted.state === 'draft' && drafted.subject === UI_SUBJECT
      && drafted.message_text === BODY,
      draftCall ? `status=${draftCall.status} subject=${drafted && drafted.subject}` : 'no draft');
    send.calls.length = 0;
    await routes.handleApproveSend(mockReq(uiDto({ approval_id: ap })), {}, user(), gate);
    const approveCall = send.calls[0];
    ok('A one UI Approve click (save then approve) sends once with locked subject',
      !!approveCall && approveCall.status === 200 && approveCall.body.success === true
      && approveCall.body.approval_id === ap
      && approveCall.body.approval_state === 'approved'
      && pg.providerCalls === 1
      && sealed && sealed.approval_id === ap
      && sealed.subject === UI_SUBJECT
      && sealed.message_text === BODY
      && pg.durable.get(ap).state === 'approved'
      && noLeak(approveCall.body),
      approveCall ? `status=${approveCall.status} sealed=${sealed && sealed.subject}` : 'no approve');
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
        pg.noteProvider();
        pg.markJournal(req.operation_id);
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleDraft(mockReq(legacyDto()), {}, user(), gate);
    const ap = send.calls[0].body.approval_id;
    send.calls.length = 0;
    await routes.handleApproveSend(mockReq(legacyDto({ approval_id: ap })), {}, user(), gate);
    await routes.handleApproveSend(mockReq(legacyDto({ approval_id: ap })), {}, user(), gate);
    ok('B saved 3-key draft sends once; stable approval retry never second-sends',
      dispatches === 1
      && send.calls[0].status === 200
      && send.calls[1].status === 409
      && send.calls[1].body.error === 'approval_conflict'
      && pg.durable.get(ap).state === 'approved'
      && pg.durable.get(ap).subject === null);
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
        pg.markJournal(req.operation_id);
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleDraft(mockReq(uiDto({
      approval_id: null, subject: OVERRIDE, email_subject: OVERRIDE,
    })), {}, user(), gate);
    const ap = send.calls[0].body.approval_id;
    ok('C draft lock/select returns persisted subject',
      pg.durable.get(ap) && pg.durable.get(ap).subject === OVERRIDE);
    send.calls.length = 0;
    await routes.handleDraft(mockReq(uiDto({
      approval_id: ap, subject: 'Revised times', email_subject: 'Revised times',
      message_text: 'Updated body for subject change.',
    })), {}, user(), gate);
    const updated = ap ? pg.durable.get(ap) : null;
    ok('C draft subject updates atomically with body/digest',
      send.calls[0] && send.calls[0].status === 200
      && updated && updated.subject === 'Revised times'
      && updated.message_text === 'Updated body for subject change.'
      && updated.body_digest === crypto.createHash('sha256').update('Updated body for subject change.', 'utf8').digest('hex')
      && updated.state === 'draft');
    send.calls.length = 0;
    await routes.handleApproveSend(mockReq(uiDto({
      approval_id: ap,
      subject: 'Revised times',
      email_subject: 'Revised times',
      message_text: 'Updated body for subject change.',
    })), {}, user(), gate);
    ok('C explicit persisted subject reaches sealed dispatch + thread mirror',
      send.calls[0] && send.calls[0].status === 200
      && sealed && sealed.subject === 'Revised times'
      && pg.mirrors[0] && pg.mirrors[0].metadata.email_subject === 'Revised times'
      && pg.mirrors[0].message_text === 'Updated body for subject change.');
    const projected = projectStaffInboxThreadMessage({
      message_id: 'm-out',
      direction: 'outbound',
      message_text: 'Updated body for subject change.',
      source: 'staff_email_reply',
      route: 'email',
      email_subject: pg.mirrors[0] && pg.mirrors[0].metadata.email_subject,
      body_text: 'Updated body for subject change.',
    });
    ok('C thread projection returns exact persisted subject',
      staffInboxThreadMessageSubject(projected) === 'Revised times');
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
        pg.markJournal(req.operation_id);
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleDraft(mockReq(uiDto({
      approval_id: null, subject: OVERRIDE, email_subject: OVERRIDE,
    })), {}, user(), gate);
    const ap = send.calls[0].body.approval_id;
    pg.setLastSubjects(['Inbound subject changed after draft']);
    send.calls.length = 0;
    await routes.handleApproveSend(mockReq(uiDto({
      approval_id: ap, subject: OVERRIDE, email_subject: OVERRIDE,
    })), {}, user(), gate);
    ok('E sealed request uses locked persisted subject, not current inbound',
      send.calls[0] && send.calls[0].status === 200
      && sealed && sealed.subject === OVERRIDE
      && sealed.subject !== 'Re: Inbound subject changed after draft'
      && !/Inbound subject changed/.test(String(sealed.subject || '')));
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
    await routes.handleDraft(mockReq(uiDto({
      approval_id: null, subject: OVERRIDE, email_subject: OVERRIDE,
    })), {}, user(), gate);
    const ap = send.calls[0] && send.calls[0].body && send.calls[0].body.approval_id;
    send.calls.length = 0;
    if (ap) {
      await routes.handleApproveSend(mockReq(uiDto({
        approval_id: ap, subject: 'Different locked', email_subject: 'Different locked',
      })), {}, user(), gate);
    }
    ok('E request subject mismatch vs locked draft fails before provider',
      send.calls[0] && send.calls[0].status === 409
      && send.calls[0].body.error === 'body_mismatch'
      && provider === 0
      && ap && pg.durable.get(ap) && pg.durable.get(ap).state === 'draft');
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
        pg.markJournal(req.operation_id);
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleDraft(mockReq(uiDto({ approval_id: null, subject: '', email_subject: '' })), {}, user(), gate);
    const ap = send.calls[0] && send.calls[0].body && send.calls[0].body.approval_id;
    const emptyDraft = ap && pg.durable.get(ap);
    ok('D no-subject draft stores null, never placeholder',
      !!emptyDraft && emptyDraft.subject === null,
      emptyDraft ? `subject=${emptyDraft.subject}` : `draftStatus=${send.calls[0] && send.calls[0].status}`);
    send.calls.length = 0;
    if (ap) {
      await routes.handleApproveSend(mockReq(uiDto({ approval_id: ap, subject: '', email_subject: '' })), {}, user(), gate);
    }
    ok('D no subject remains omitted on sealed dispatch and mirror',
      send.calls[0] && send.calls[0].status === 200
      && sealed && !Object.prototype.hasOwnProperty.call(sealed, 'subject')
      && (!pg.mirrors[0] || pg.mirrors[0].metadata.email_subject == null),
      send.calls[0] ? `status=${send.calls[0].status}` : 'no approve');
  }

  {
    const routesSrc = fs.readFileSync(ROUTES_ABS, 'utf8');
    ok('D last-subject loader does not catch DB errors as null',
      !/async function loadLastPersistedSubject[\s\S]{0,500}catch\s*\{\s*return null;/.test(routesSrc));
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
        pg.markJournal(req.operation_id);
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleDraft(mockReq(legacyDto()), {}, user(), gate);
    const draftCall = send.calls[0];
    const ap = draftCall && draftCall.body && draftCall.body.approval_id;
    const drafted = ap && pg.durable.get(ap);
    const lastIdx = pg.queries.indexOf(SQL_LAST_PERSISTED_SUBJECT);
    const insertIdx = pg.queries.findIndex((q) => /^INSERT INTO tenant_email_reply_approvals/.test(q));
    ok('D omitted legacy subject queries last persisted and stores Re: last',
      !!draftCall && draftCall.status === 200
      && drafted && drafted.state === 'draft'
      && drafted.subject === UI_SUBJECT
      && drafted.subject !== LAST_SUBJECT
      && drafted.subject !== '(no subject)'
      && lastIdx !== -1
      && insertIdx !== -1
      && lastIdx < insertIdx
      && pg.queries.includes('BEGIN')
      && pg.queries.indexOf('BEGIN') < lastIdx
      && pg.lastSubjectQueries.some((q) => (
        q.sql === SQL_LAST_PERSISTED_SUBJECT
        && String(q.params[0]).toLowerCase() === C
        && String(q.params[1]).toLowerCase() === V
      )),
      draftCall
        ? `status=${draftCall.status} subject=${drafted && drafted.subject} lastIdx=${lastIdx} insertIdx=${insertIdx}`
        : 'no draft');
    const queriesAfterDraft = pg.queries.length;
    pg.setLastSubjects(['Later inbound subject']);
    send.calls.length = 0;
    await routes.handleApproveSend(mockReq(legacyDto({ approval_id: ap })), {}, user(), gate);
    const approveQueries = pg.queries.slice(queriesAfterDraft);
    ok('D omitted-subject approval locks Re: last even if thread subject changes',
      send.calls[0] && send.calls[0].status === 200
      && sealed && sealed.subject === UI_SUBJECT
      && sealed.subject !== 'Re: Later inbound subject'
      && !approveQueries.includes(SQL_LAST_PERSISTED_SUBJECT)
      && pg.mirrors[0] && pg.mirrors[0].metadata.email_subject === UI_SUBJECT,
      send.calls[0]
        ? `status=${send.calls[0].status} sealed=${sealed && sealed.subject}`
        : 'no approve');
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
        pg.markJournal(req.operation_id);
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleDraft(mockReq(uiDto({ approval_id: null, subject: '', email_subject: '' })), {}, user(), gate);
    const draftCall = send.calls[0];
    const ap = draftCall && draftCall.body && draftCall.body.approval_id;
    const drafted = ap && pg.durable.get(ap);
    ok('D current UI empty pair queries last persisted and stores Re: last',
      !!draftCall && draftCall.status === 200
      && drafted && drafted.subject === UI_SUBJECT
      && drafted.subject !== '(no subject)'
      && pg.queries.includes(SQL_LAST_PERSISTED_SUBJECT)
      && pg.lastSubjectQueries.some((q) => q.sql === SQL_LAST_PERSISTED_SUBJECT),
      draftCall ? `status=${draftCall.status} subject=${drafted && drafted.subject}` : 'no draft');
    pg.setLastSubjects(['Changed after empty UI draft']);
    send.calls.length = 0;
    await routes.handleApproveSend(mockReq(uiDto({ approval_id: ap, subject: '', email_subject: '' })), {}, user(), gate);
    ok('D empty-pair approve-send uses locked Re: last, not a later thread subject',
      send.calls[0] && send.calls[0].status === 200
      && sealed && sealed.subject === UI_SUBJECT
      && sealed.subject !== 'Re: Changed after empty UI draft'
      && pg.mirrors[0] && pg.mirrors[0].metadata.email_subject === UI_SUBJECT,
      send.calls[0] ? `status=${send.calls[0].status} sealed=${sealed && sealed.subject}` : 'no approve');
  }

  {
    const pg = createReplyPg({ lastSubjects: ['Re: Already prefixed'] });
    const send = captureSend();
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      runtimeEnv: enabledEnv(),
    });
    await routes.handleDraft(mockReq(legacyDto()), {}, user(), gate);
    const ap = send.calls[0] && send.calls[0].body && send.calls[0].body.approval_id;
    const drafted = ap && pg.durable.get(ap);
    ok('D default does not double an existing Re: prefix',
      !!drafted && drafted.subject === 'Re: Already prefixed'
      && drafted.subject !== 'Re: Re: Already prefixed');
  }

  {
    const pg = createReplyPg({ lastSubjects: [LAST_SUBJECT] });
    const send = captureSend();
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      runtimeEnv: enabledEnv(),
    });
    await routes.handleDraft(mockReq(uiDto({
      approval_id: null, subject: OVERRIDE, email_subject: OVERRIDE,
    })), {}, user(), gate);
    const ap = send.calls[0] && send.calls[0].body && send.calls[0].body.approval_id;
    ok('D explicit override persists exactly (not Re: last)',
      ap && pg.durable.get(ap) && pg.durable.get(ap).subject === OVERRIDE);
    pg.setLastSubjects(['Updated thread subject']);
    send.calls.length = 0;
    await routes.handleDraft(mockReq(uiDto({
      approval_id: ap, subject: '', email_subject: '',
      message_text: 'Still drafting after empty-pair update.',
    })), {}, user(), gate);
    const afterEmpty = ap && pg.durable.get(ap);
    ok('D draft update with empty pair re-resolves current last while still draft',
      send.calls[0] && send.calls[0].status === 200
      && afterEmpty && afterEmpty.state === 'draft'
      && afterEmpty.subject === 'Re: Updated thread subject'
      && afterEmpty.message_text === 'Still drafting after empty-pair update.',
      send.calls[0] ? `status=${send.calls[0].status} subject=${afterEmpty && afterEmpty.subject}` : 'no update');
    pg.setLastSubjects(['Third subject']);
    send.calls.length = 0;
    await routes.handleDraft(mockReq(legacyDto({
      approval_id: ap,
      message_text: 'Still drafting after omitted-subject update.',
    })), {}, user(), gate);
    const afterOmit = ap && pg.durable.get(ap);
    ok('D draft update with omitted subject re-resolves current last while still draft',
      send.calls[0] && send.calls[0].status === 200
      && afterOmit && afterOmit.state === 'draft'
      && afterOmit.subject === 'Re: Third subject'
      && afterOmit.message_text === 'Still drafting after omitted-subject update.',
      send.calls[0] ? `status=${send.calls[0].status} subject=${afterOmit && afterOmit.subject}` : 'no omit update');
  }

  {
    const pg = createReplyPg({ lastSubjects: [LAST_SUBJECT] });
    const planted = new Error('last_subject_query_failed');
    pg.setLastSubjectError(planted);
    const send = captureSend();
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      runtimeEnv: enabledEnv(),
    });
    await routes.handleDraft(mockReq(legacyDto()), {}, user(), gate);
    ok('D last-subject DB error fails the draft and stores nothing',
      send.calls[0] && send.calls[0].status === 500
      && send.calls[0].body && send.calls[0].body.error === 'draft_failed'
      && pg.durable.size === 0
      && pg.queries.includes('ROLLBACK')
      && !pg.queries.some((q) => /^INSERT INTO tenant_email_reply_approvals/.test(q)),
      send.calls[0]
        ? `status=${send.calls[0].status} durable=${pg.durable.size}`
        : 'no draft response');
  }

  {
    const pg = createReplyPg({ lastSubjects: [LAST_SUBJECT] });
    const send = captureSend();
    let sealed = null;
    let recoverSealed = null;
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      runtimeEnv: enabledEnv(),
      outboundDispatch: async (req) => {
        if (!sealed) {
          sealed = req;
          pg.noteProvider();
          pg.markJournal(req.operation_id, { phase: 'send_dispatched', outcome: 'outcome_unknown' });
          return Object.freeze({ ok: false, code: 'email_send_outcome_unknown' });
        }
        recoverSealed = req;
        pg.markJournal(req.operation_id, { phase: 'reconciled_sent', outcome: 'committed' });
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleDraft(mockReq(uiDto({ approval_id: null, subject: '', email_subject: '' })), {}, user(), gate);
    const ap = send.calls[0] && send.calls[0].body && send.calls[0].body.approval_id;
    pg.setLastSubjects(['Should not win after draft']);
    send.calls.length = 0;
    await routes.handleApproveSend(mockReq(uiDto({ approval_id: ap, subject: '', email_subject: '' })), {}, user(), gate);
    ok('F defaulted Re: last outcome_unknown does not invent a second operation',
      send.calls[0] && send.calls[0].status === 503
      && send.calls[0].body.error === 'email_send_outcome_unknown'
      && sealed && sealed.subject === UI_SUBJECT
      && sealed.approval_id === ap
      && pg.providerCalls === 1
      && pg.mirrors.length === 0);
    send.calls.length = 0;
    await routes.handleRecoverSend(mockReq({ conversation_id: V, approval_id: ap }), {}, user(), gate);
    ok('F defaulted Re: last recovery commits exact persisted subject without a second send',
      send.calls[0] && send.calls[0].status === 200 && send.calls[0].body.status === 'committed'
      && recoverSealed && recoverSealed.subject === UI_SUBJECT
      && recoverSealed.approval_id === ap
      && recoverSealed.operation_id === sealed.operation_id
      && pg.providerCalls === 1
      && pg.mirrors.length === 1
      && pg.mirrors[0].metadata.email_subject === UI_SUBJECT,
      send.calls[0]
        ? `status=${send.calls[0].status} recoverSubject=${recoverSealed && recoverSealed.subject} provider=${pg.providerCalls}`
        : 'no recover');
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
    await routes.handleApproveSend(mockReq(uiDto({
      approval_id: null, subject: 'Hello\nInjected', email_subject: 'Hello\nInjected',
    })), {}, user(), gate);
    ok('D newline subject on approve-send rejects before provider',
      send.calls[0] && send.calls[0].status === 400
      && provider === 0 && pg.durable.size === 0);
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
    await routes.handleDraft(mockReq(uiDto()), {}, user(), gate);
    ok('E unknown conversation 404 before network',
      send.calls[0] && send.calls[0].status === 404 && provider === 0 && noLeak(send.calls[0].body));
    pg.setAuthorityPresent(true);
    pg.setForeign(true);
    send.calls.length = 0;
    await routes.handleDraft(mockReq(uiDto()), {}, user(), gate);
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
        pg.markJournal(req.operation_id);
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleDraft(mockReq(uiDto()), {}, user(), gate);
    const ap = send.calls[0].body.approval_id;
    send.calls.length = 0;
    await routes.handleApproveSend(mockReq(uiDto({ approval_id: ap })), {}, user(), gate);
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

  {
    const pg = createReplyPg({ mirrorFailRemaining: 1 });
    const send = captureSend();
    let sealed = null;
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      runtimeEnv: enabledEnv(),
      outboundDispatch: async (req) => {
        sealed = req;
        pg.noteProvider();
        pg.markJournal(req.operation_id, { phase: 'reconciled_sent', outcome: 'committed' });
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleDraft(mockReq(uiDto({
      approval_id: null, subject: OVERRIDE, email_subject: OVERRIDE,
    })), {}, user(), gate);
    const ap = send.calls[0].body.approval_id;
    send.calls.length = 0;
    await routes.handleApproveSend(mockReq(uiDto({
      approval_id: ap, subject: OVERRIDE, email_subject: OVERRIDE,
    })), {}, user(), gate);
    ok('F initial commit can succeed while first mirror insert fails',
      send.calls[0] && send.calls[0].status === 200
      && pg.providerCalls === 1
      && pg.mirrors.length === 0
      && sealed && sealed.subject === OVERRIDE);
    send.calls.length = 0;
    await routes.handleRecoverSend(mockReq({ conversation_id: V, approval_id: ap }), {}, user(), gate);
    ok('F recovery after mirror failure inserts exact subject once without second send',
      send.calls[0] && send.calls[0].status === 200 && send.calls[0].body.success === true
      && send.calls[0].body.status === 'committed'
      && pg.providerCalls === 1
      && pg.mirrors.length === 1
      && pg.mirrors[0].message_text === BODY
      && pg.mirrors[0].metadata.email_subject === OVERRIDE
      && pg.mirrors[0].metadata.approval_id === ap,
      send.calls[0]
        ? `status=${send.calls[0].status} mirrors=${pg.mirrors.length} provider=${pg.providerCalls}`
        : 'no recover');
    send.calls.length = 0;
    await routes.handleRecoverSend(mockReq({ conversation_id: V, approval_id: ap }), {}, user(), gate);
    ok('F recovery replay is idempotent — still one mirror, still one send',
      send.calls[0] && send.calls[0].status === 200
      && pg.providerCalls === 1
      && pg.mirrors.length === 1);
  }

  {
    const pg = createReplyPg();
    const send = captureSend();
    let sealed = null;
    let recoverSealed = null;
    const routes = createStaffEmailInboxRoutes({
      sendJSON: send.sendJSON,
      withPgClient: pg.withPgClient,
      runtimeEnv: enabledEnv(),
      outboundDispatch: async (req) => {
        if (!sealed) {
          sealed = req;
          pg.noteProvider();
          pg.markJournal(req.operation_id, { phase: 'send_dispatched', outcome: 'outcome_unknown' });
          return Object.freeze({ ok: false, code: 'email_send_outcome_unknown' });
        }
        recoverSealed = req;
        pg.markJournal(req.operation_id, { phase: 'reconciled_sent', outcome: 'committed' });
        return Object.freeze({ ok: true, code: 'email_send_committed' });
      },
    });
    await routes.handleDraft(mockReq(uiDto({
      approval_id: null, subject: OVERRIDE, email_subject: OVERRIDE,
    })), {}, user(), gate);
    const ap = send.calls[0].body.approval_id;
    send.calls.length = 0;
    await routes.handleApproveSend(mockReq(uiDto({
      approval_id: ap, subject: OVERRIDE, email_subject: OVERRIDE,
    })), {}, user(), gate);
    ok('F initial outcome_unknown does not invent a second operation',
      send.calls[0] && send.calls[0].status === 503
      && send.calls[0].body.error === 'email_send_outcome_unknown'
      && sealed && sealed.subject === OVERRIDE
      && sealed.approval_id === ap
      && pg.mirrors.length === 0);
    send.calls.length = 0;
    await routes.handleRecoverSend(mockReq({ conversation_id: V, approval_id: ap }), {}, user(), gate);
    ok('F outcome_unknown recovery commits and mirrors exact locked subject',
      send.calls[0] && send.calls[0].status === 200 && send.calls[0].body.status === 'committed'
      && recoverSealed && recoverSealed.subject === OVERRIDE
      && recoverSealed.approval_id === ap
      && recoverSealed.operation_id === sealed.operation_id
      && pg.mirrors.length === 1
      && pg.mirrors[0].metadata.email_subject === OVERRIDE,
      send.calls[0]
        ? `status=${send.calls[0].status} recoverSubject=${recoverSealed && recoverSealed.subject} mirrors=${pg.mirrors.length}`
        : 'no recover');
  }

  {
    const inboxSql = getConversationInboxQuery();
    const detailSql = getConversationDetailQuery();
    const threadSql = getConversationMessagesQuery();
    const currentExpr = typeof sqlCurrentEmailSubjectExpr === 'function' ? sqlCurrentEmailSubjectExpr('conv') : '';
    ok('G list/detail current subject from inbound + committed outbound only',
      /tenant_email_inbound_events/.test(inboxSql)
      && /staff_email_reply/.test(inboxSql)
      && /email_subject/.test(inboxSql)
      && /tenant_email_inbound_events/.test(detailSql)
      && /staff_email_reply/.test(detailSql)
      && /email_subject/.test(threadSql)
      && !/tenant_email_reply_approvals/.test(inboxSql)
      && !/tenant_email_reply_approvals/.test(detailSql)
      && !/tenant_email_reply_approvals/.test(currentExpr)
      && /staff_email_reply/.test(currentExpr));
  }

  if (!subjectOwner.__load_error) {
    const transportSrc = fs.readFileSync(TRANSPORT_ABS, 'utf8');
    ok('C updateApprovedDraft can PATCH optional locked subject',
      /updateApprovedDraft/.test(transportSrc) && /patch\.subject/.test(transportSrc));
  }

  ok('H SQL_APPROVE CAS binds expected subject',
    typeof SQL_APPROVE === 'string'
    && /subject IS NOT DISTINCT FROM/.test(SQL_APPROVE)
    && /body_digest=\$7/.test(SQL_APPROVE));
  ok('H lock/load select persisted subject',
    typeof SQL_LOAD_APPROVAL === 'string'
    && /subject/.test(SQL_LOAD_APPROVAL));
  ok('H recovery path exists',
    EMAIL_RECOVER_SEND_PATH === '/staff/inbox/email/recover-send'
    && EMAIL_DRAFT_PATH === '/staff/inbox/email/draft');

  {
    const sealedNo = sealApprovedDispatchRequest(
      {
        approval_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        message_text: BODY,
      },
      authRow(),
      { staff_user_id: A, client_id: C },
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      null,
    );
    const sealedYes = sealApprovedDispatchRequest(
      {
        approval_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        message_text: BODY,
      },
      authRow(),
      { staff_user_id: A, client_id: C },
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      OVERRIDE,
    );
    ok('H seal omits subject when null and pins persisted string',
      sealedNo && !Object.prototype.hasOwnProperty.call(sealedNo, 'subject')
      && sealedYes && sealedYes.subject === OVERRIDE);
  }

  ok('081 migration files exist as next number after 080',
    fs.existsSync(MIG_080)
    && fs.existsSync(MIG_081)
    && fs.existsSync(MIG_081_DOWN),
    `081=${fs.existsSync(MIG_081)} down=${fs.existsSync(MIG_081_DOWN)}`);

  if (fs.existsSync(MIG_081) && fs.existsSync(MIG_081_DOWN)) {
    const up = fs.readFileSync(MIG_081, 'utf8');
    const down = fs.readFileSync(MIG_081_DOWN, 'utf8');
    ok('081 adds nullable subject + CHECK + trigger seal; down refuses data loss',
      /ALTER TABLE tenant_email_reply_approvals/.test(up)
      && /ADD COLUMN(?: IF NOT EXISTS)? subject TEXT/.test(up)
      && /tenant_email_reply_approvals_subject/.test(up)
      && /tenant_email_reply_approvals_protect/.test(up)
      && /081_down_refused|subject IS NOT NULL/.test(down)
      && !/placeholder/i.test(up));
    ok('081 is on the exact current chain (after 080, not colliding)',
      !fs.existsSync(path.join(ROOT, 'database/migrations/082_tenant_email_reply_approvals_subject.sql')));

    const PGlite = tryLoadPglite();
    if (!PGlite) {
      ok('081 PGlite real-schema proof', false, 'PGlite unavailable');
    } else {
      const db = new PGlite();
      try {
        await db.exec(`CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at=NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TABLE clients (id UUID PRIMARY KEY, slug TEXT);
CREATE TABLE staff_users (id UUID PRIMARY KEY, client_id UUID NOT NULL REFERENCES clients(id), email TEXT, role TEXT, status TEXT, UNIQUE (client_id, id));
CREATE TABLE conversations (id UUID PRIMARY KEY, client_id UUID NOT NULL, phone TEXT, UNIQUE (client_id, id));
CREATE TABLE tenant_locations (id UUID PRIMARY KEY, client_id UUID NOT NULL, location_id TEXT NOT NULL, UNIQUE (client_id, id, location_id));
CREATE TABLE tenant_channel_endpoints (id UUID PRIMARY KEY, client_id UUID NOT NULL, location_id TEXT NOT NULL, UNIQUE (client_id, id, location_id));
CREATE TABLE tenant_email_inbound_events (id UUID PRIMARY KEY, client_id UUID NOT NULL, UNIQUE (client_id, id));`);
        await db.exec(fs.readFileSync(MIG_070, 'utf8'));
        await db.exec(up);
        await db.query('INSERT INTO clients (id, slug) VALUES ($1,$2)', [C, 'sunset']);
        await db.query('INSERT INTO staff_users (id, client_id, email, role, status) VALUES ($1,$2,$3,$4,$5)', [A, C, 'op@t', 'operator', 'active']);
        await db.query('INSERT INTO conversations (id, client_id, phone) VALUES ($1,$2,$3)', [V, C, 'emailv1:x']);
        await db.query('INSERT INTO tenant_locations (id, client_id, location_id) VALUES ($1,$2,$3)', [L, C, K]);
        await db.query('INSERT INTO tenant_channel_endpoints (id, client_id, location_id) VALUES ($1,$2,$3)', [E, C, K]);
        await db.query('INSERT INTO tenant_email_inbound_events (id, client_id) VALUES ($1,$2)', [EV, C]);
        const ins = `INSERT INTO tenant_email_reply_approvals (
          approval_id, operation_id, client_id, location_id, location_key, endpoint_id, conversation_id,
          source_inbound_event_id, provider, provider_mailbox_id, provider_source_message_id,
          draft_actor_staff_user_id, message_text, body_digest, state, subject
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'microsoft_graph',$9,$10,$11,$12,$13,'draft',$14)`;
        const apLegacy = crypto.randomUUID();
        const opLegacy = crypto.randomUUID();
        await db.query(ins, [apLegacy, opLegacy, C, L, K, E, V, EV, MAIL, SRC, A, BODY, DIGEST, null]);
        const legacy = await db.query('SELECT subject FROM tenant_email_reply_approvals WHERE approval_id=$1', [apLegacy]);
        const ap = crypto.randomUUID();
        const op = crypto.randomUUID();
        await db.query(ins, [ap, op, C, L, K, E, V, EV, MAIL, SRC, A, BODY, DIGEST, OVERRIDE]);
        let ctrl = false;
        try { await db.query(ins, [crypto.randomUUID(), crypto.randomUUID(), C, L, K, E, V, EV, MAIL, SRC, A, BODY, DIGEST, 'Bad\nSub']); } catch { ctrl = true; }
        let oversize = false;
        try { await db.query(ins, [crypto.randomUUID(), crypto.randomUUID(), C, L, K, E, V, EV, MAIL, SRC, A, BODY, DIGEST, 'x'.repeat(201)]); } catch { oversize = true; }
        let placeholder = false;
        try { await db.query(ins, [crypto.randomUUID(), crypto.randomUUID(), C, L, K, E, V, EV, MAIL, SRC, A, BODY, DIGEST, '(no subject)']); } catch { placeholder = true; }
        const b2 = 'pglite subject cas';
        const d2 = crypto.createHash('sha256').update(b2, 'utf8').digest('hex');
        await db.query(
          `UPDATE tenant_email_reply_approvals SET message_text=$2, body_digest=$3, subject=$4 WHERE approval_id=$1 AND state='draft'`,
          [ap, b2, d2, 'Draft updated subject'],
        );
        const afterDraft = await db.query('SELECT subject, message_text FROM tenant_email_reply_approvals WHERE approval_id=$1', [ap]);
        await db.query(
          `UPDATE tenant_email_reply_approvals SET state='approved', approved_actor_staff_user_id=$2, approved_at=NOW() WHERE approval_id=$1 AND state='draft'`,
          [ap, A],
        );
        let approvedSubjectMut = false;
        try {
          await db.query(`UPDATE tenant_email_reply_approvals SET subject=$2 WHERE approval_id=$1`, [ap, 'mutated']);
        } catch { approvedSubjectMut = true; }
        let downRefused = false;
        try { await db.exec(down); } catch (e) { downRefused = /081_down_refused|subject/i.test(String(e && e.message || e)); }
        try { await db.query('ROLLBACK'); } catch { /* */ }
        await db.query('UPDATE tenant_email_reply_approvals SET subject=NULL WHERE state=\'draft\'');
        await db.query('DELETE FROM tenant_email_reply_approvals');
        let downOk = false;
        try { await db.exec(down); downOk = true; } catch { downOk = false; }
        ok('081 PGlite: nullable legacy, CHECK, draft update, approved seal, down refuses data loss',
          legacy.rows[0].subject === null
          && afterDraft.rows[0].subject === 'Draft updated subject'
          && afterDraft.rows[0].message_text === b2
          && ctrl && oversize && placeholder
          && approvedSubjectMut && downRefused && downOk,
          `legacy=${legacy.rows[0] && legacy.rows[0].subject} ctrl=${ctrl} oversize=${oversize} ph=${placeholder} seal=${approvedSubjectMut} downRefused=${downRefused} downOk=${downOk}`);
      } catch (err) {
        ok('081 PGlite: nullable legacy, CHECK, draft update, approved seal, down refuses data loss',
          false, err && err.message ? err.message : String(err));
      } finally {
        try { await db.close(); } catch { /* */ }
      }
    }

    try {
      const manifest = JSON.parse(fs.readFileSync(MANIFEST_ABS, 'utf8'));
      const fwd = (manifest.entries || []).filter((e) => e.inForwardChain);
      const last = fwd[fwd.length - 1];
      const entry = (manifest.entries || []).find((e) => e.filename === '081_tenant_email_reply_approvals_subject.sql');
      const downEnt = (manifest.entries || []).find((e) => e.filename === '081_tenant_email_reply_approvals_subject_down.sql');
      ok('081 listed on canonical forward chain after 080',
        !!entry && entry.inForwardChain === true && entry.order === 77
        && !!downEnt && downEnt.inForwardChain === false
        && last && last.filename === '081_tenant_email_reply_approvals_subject.sql');
    } catch (err) {
      ok('081 listed on canonical forward chain after 080', false, err && err.message);
    }
  }

  const changed = spawnSync('git', ['diff', '--name-only', 'origin/master'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
  });
  const names = String(changed.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const forbidden = names.filter((n) => (
    n === 'scripts/browser/inbox-thread.js'
    || /^scripts\/browser\/inbox-/.test(n)
    || /^scripts\/browser\//.test(n)
    || /gmail/i.test(n)
    || /google/i.test(n)
    || /email-inbound-delta/.test(n)
    || /email-delta-sunset-staging-worker/.test(n)
    || n.startsWith('infra/')
    || (n.startsWith('database/') && !/^database\/migrations\/081_tenant_email_reply_approvals_subject/.test(n)
        && n !== 'database/migrations/canonical-manifest.json')
  ));
  ok('H no Inbox chrome / Gmail / inbound worker / infra / unrelated schema edits',
    forbidden.length === 0, forbidden.join(','));
  const routesSrc = fs.readFileSync(ROUTES_ABS, 'utf8');
  const compSrc = fs.readFileSync(COMP_ABS, 'utf8');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
  ok('H no auto-send enablement; human approve-send only',
    !/LUNA_AUTO_SEND_ENABLED['"]?\s*[:=]\s*['"]true['"]/.test(routesSrc)
    && !/auto_send\s*=\s*true/.test(routesSrc)
    && EMAIL_AUTHORITY_BOUND_OUTBOUND_RUNTIME_WIRED === false
    && EMAIL_AUTHORITY_BOUND_OUTBOUND_SAFE_FOR_RUNTIME_ROUTE === false
    && EMAIL_AUTHORITY_BOUND_OUTBOUND_PERSISTENCE_READY === false
    && /EMAIL_AUTHORITY_BOUND_OUTBOUND_AUTO_RESEND = false/.test(
      fs.readFileSync(path.join(__dirname, 'lib/email-authority-bound-outbound-operation.js'), 'utf8'),
    ));
  ok('H standing route only; no operator one-shot harness as the feature',
    EMAIL_APPROVE_SEND_PATH === '/staff/inbox/email/approve-send'
    && apiSrc.includes('emailInboxRoutes.handleApproveSend')
    && /createSunsetStagingEmailOutboundDispatch/.test(apiSrc)
    && !/scripts\/prove-email-reply-001/.test(apiSrc));
  ok('H Google files untouched and no new Gmail helpers',
    names.every((n) => !/gmail|google/i.test(n))
    && !/gmail/i.test(routesSrc)
    && !/createGmail/.test(compSrc));
  ok('H outbound_enabled remains DB registry + env gate; no live DB mutation',
    /endpoint_outbound_enabled/.test(routesSrc)
    && !/UPDATE tenant_channel_endpoints[\s\S]{0,200}outbound_enabled/.test(routesSrc));
  ok('H approve-send does not mint on null approval_id',
    !/if \(approvalId == null\)/.test(routesSrc)
    && !/mintedApprovalId/.test(routesSrc));

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('package script present', pkg.scripts['verify:email-reply-001'] === 'node scripts/verify-email-reply-001.js');

  console.log(`\n── verify:email-reply-001 ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  if (fail) {
    console.log('RED failures:');
    for (const name of failures) console.log(`  - ${name}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
