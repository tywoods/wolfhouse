'use strict';

/**
 * verify:inbox-whatsapp-draft-route
 *
 * Offline contract for Inbox Phase 2 WhatsApp draft persist+read+approve-send:
 *   POST /staff/inbox/whatsapp/draft
 *   GET  /staff/inbox/whatsapp/draft?conversation_id=
 *   POST /staff/inbox/whatsapp/approve-send
 *
 * Proves:
 *   - operator auth, assertStaffClientAccess, home-tenant conversation resolve
 *   - GET is SELECT-only (no send, no Graph, no WhatsApp Cloud)
 *   - POST body shape; email-channel conversations rejected
 *   - approve-send auth, missing draft 404, not-pending 409
 *   - WHATSAPP_DRY_RUN / LUNA_AUTO_SEND_ENABLED fail closed without calling send
 *   - live approve-send uses the injected send-reply helper, then marks sent
 *   - denied / hostile client never reach Postgres
 *   - thread composite payload is untouched
 *   - Inbox WhatsApp draft card fetches GET/POST draft and POST approve-send
 *   - email draft/approve-send paths unchanged; no WhatsApp auto-send of drafts
 *   - migration 078 is a new table (070 email approvals are not reused)
 *
 * No live DB / network / Graph / Meta.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-inbox-whatsapp-draft-routes.js');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const COMPOSITE_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-inbox-thread-composite.js');
const EMAIL_ROUTES_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-email-inbox-routes.js');
const MIG_UP = path.join(ROOT, 'database', 'migrations', '078_luna_outbound_approvals.sql');
const MIG_DOWN = path.join(ROOT, 'database', 'migrations', '078_luna_outbound_approvals_down.sql');
const MIG_070 = path.join(ROOT, 'database', 'migrations', '070_tenant_email_reply_approvals.sql');

const {
  WHATSAPP_DRAFT_PATH,
  WHATSAPP_APPROVE_SEND_PATH,
  WHATSAPP_DRAFT_CHANNEL,
  WHATSAPP_DRAFT_MIN_ROLE,
  WHATSAPP_DRAFT_ROUTE_TABLE,
  POST_BODY_KEYS,
  APPROVE_BODY_KEYS,
  GET_SUCCESS_DTO_KEYS,
  POST_SUCCESS_DTO_KEYS,
  APPROVE_SUCCESS_DTO_KEYS,
  BODY_MAX_BYTES,
  DRAFT_MAX_BYTES,
  SQL_RESOLVE,
  SQL_RESOLVE_FOR_UPDATE,
  SQL_SELECT_PENDING,
  SQL_UPSERT_PENDING,
  SQL_SELECT_LATEST_FOR_UPDATE,
  SQL_MARK_APPROVED,
  SQL_MARK_SENT,
  snapshotPostBody,
  snapshotApproveBody,
  parseConversationIdQuery,
  actorFromUser,
  isWhatsAppConversation,
  killSwitchError,
  createWhatsAppDraftRoutes,
} = require('./lib/staff-inbox-whatsapp-draft-routes');
const { INBOX_THREAD_COMPOSITE_SECTIONS } = require('./lib/staff-inbox-thread-composite');
const { EMAIL_DRAFT_PATH, EMAIL_APPROVE_SEND_PATH } = require('./lib/staff-email-inbox-routes');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const {
  WHATSAPP_DRAFT_MODULE,
  THREAD_MODULE,
  LUNA_MODE_MODULE,
  COLUMNS_MODULE,
} = require('./lib/inbox-browser-source');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function norm(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function mockRes() {
  const out = { statusCode: 0, headers: {}, body: null, ended: false };
  return {
    out,
    writeHead(code, headers) {
      out.statusCode = code;
      if (headers) Object.assign(out.headers, headers);
    },
    setHeader(k, v) { out.headers[k] = v; },
    end(buf) {
      out.ended = true;
      out.body = buf == null ? '' : String(buf);
    },
  };
}

function parseBody(out) {
  if (!out.body) return null;
  try { return JSON.parse(out.body); } catch (_) { return out.body; }
}

function mockReq(bodyObj, headers = {}) {
  const ee = new EventEmitter();
  ee.headers = Object.assign(Object.create(null), {
    'content-type': 'application/json',
    ...headers,
  });
  ee._body = bodyObj;
  return ee;
}

const CLIENT = 'wolfhouse-somo';
const HOSTILE = "wolf'; DROP TABLE conversations; --";
const C = '11111111-1111-4111-8111-111111111111';
const A = '55555555-5555-4555-8555-555555555555';
const V = '44444444-4444-4444-8444-444444444444';
const OTHER = '66666666-6666-4666-8666-666666666666';
const DRAFT = 'Yes — 10am has two spots left. Want me to hold one?';

function user(o = {}) {
  return {
    staff_user_id: A,
    client_id: C,
    client_slug: CLIENT,
    role: 'operator',
    status: 'active',
    ...o,
  };
}

function makeDeps(opts = {}) {
  const audit = [];
  const sqlLog = [];
  const sendCalls = [];
  let dbHits = 0;
  const durable = new Map();
  let conversation = opts.conversation !== undefined ? opts.conversation : {
    conversation_id: V,
    client_id: C,
    client_slug: CLIENT,
    phone: '+34600000404',
    channel: 'whatsapp',
  };
  const accessDenied = opts.accessDenied === true;

  const deps = {
    DEFAULT_CLIENT: CLIENT,
    SQL_INJECT_RE: /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i,
    audit,
    sqlLog,
    sendCalls,
    get dbHits() { return dbHits; },
    durable,
    setConversation(row) { conversation = row; },
    sendJSON(res, status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return body;
    },
    send400(res, message) {
      return deps.sendJSON(res, 400, { success: false, error: message });
    },
    assertStaffClientAccess(u, clientSlug, res) {
      if (accessDenied || (opts.denySlug && clientSlug === opts.denySlug)) {
        deps.sendJSON(res, 403, { success: false, error: 'client_access_denied', client_slug: clientSlug });
        return false;
      }
      return true;
    },
    appendAuditLog(entry) { audit.push(entry); },
    readBody: async (req) => {
      sendCalls.push({ kind: 'readBody' });
      if (req && req._rawBody !== undefined) return req._rawBody;
      return JSON.stringify(req && req._body != null ? req._body : {});
    },
    async withPgClient(fn) {
      dbHits += 1;
      const client = {
        async query(sql, params) {
          const n = norm(sql);
          sqlLog.push({ sql: n, params: (params || []).slice() });
          if (n === 'BEGIN' || n === 'COMMIT' || n === 'ROLLBACK') return { rows: [] };
          if (n === SQL_RESOLVE || n === SQL_RESOLVE_FOR_UPDATE) {
            const slug = String(params[0]);
            const clientId = String(params[1]).toLowerCase();
            const staffId = String(params[2]).toLowerCase();
            const convId = String(params[3]).toLowerCase();
            if (!conversation) return { rows: [] };
            if (slug !== conversation.client_slug || clientId !== conversation.client_id
                || convId !== conversation.conversation_id || staffId !== A) {
              return { rows: [] };
            }
            return { rows: [{ ...conversation }] };
          }
          if (n === SQL_SELECT_PENDING) {
            const clientId = String(params[0]).toLowerCase();
            const convId = String(params[1]).toLowerCase();
            const row = durable.get(`${clientId}:${convId}:whatsapp`);
            return { rows: row && row.status === 'pending' ? [{ ...row }] : [] };
          }
          if (n === SQL_SELECT_LATEST_FOR_UPDATE) {
            const clientId = String(params[0]).toLowerCase();
            const convId = String(params[1]).toLowerCase();
            const row = durable.get(`${clientId}:${convId}:whatsapp`);
            return { rows: row ? [{ ...row }] : [] };
          }
          if (n === SQL_UPSERT_PENDING) {
            const approvalId = String(params[0]).toLowerCase();
            const clientId = String(params[1]).toLowerCase();
            const convId = String(params[2]).toLowerCase();
            const key = `${clientId}:${convId}:whatsapp`;
            const existing = durable.get(key);
            const row = {
              approval_id: existing && existing.status === 'pending' ? existing.approval_id : approvalId,
              conversation_id: convId,
              channel: 'whatsapp',
              draft_text: String(params[3]),
              edited_text: null,
              status: 'pending',
              tool_trace: {},
              created_by_run_id: null,
            };
            durable.set(key, row);
            return { rows: [{ ...row }] };
          }
          if (n === SQL_MARK_APPROVED) {
            const approvalId = String(params[0]).toLowerCase();
            const clientId = String(params[1]).toLowerCase();
            for (const [key, row] of durable.entries()) {
              if (row.approval_id === approvalId && key.startsWith(`${clientId}:`) && row.status === 'pending') {
                const next = { ...row, status: 'approved' };
                durable.set(key, next);
                return { rows: [{ ...next }] };
              }
            }
            return { rows: [] };
          }
          if (n === SQL_MARK_SENT) {
            const approvalId = String(params[0]).toLowerCase();
            const clientId = String(params[1]).toLowerCase();
            for (const [key, row] of durable.entries()) {
              if (row.approval_id === approvalId && key.startsWith(`${clientId}:`) && row.status === 'approved') {
                const next = { ...row, status: 'sent' };
                durable.set(key, next);
                return { rows: [{ ...next }] };
              }
            }
            return { rows: [] };
          }
          throw new Error(`unexpected_sql:${n.slice(0, 80)}`);
        },
      };
      return fn(client);
    },
    runtimeEnv: opts.runtimeEnv || {
      WHATSAPP_DRY_RUN: 'false',
      LUNA_AUTO_SEND_ENABLED: 'true',
    },
    async evaluateGuestReplySendRouteWithPause(body, ctx) {
      sendCalls.push({ kind: 'send', body, env: ctx && ctx.env });
      if (opts.sendThrows) throw new Error('send_boom');
      if (opts.sendFail) {
        return {
          ok: true,
          status: 200,
          result: {
            success: false,
            send_performed: false,
            sends_whatsapp: false,
            blocked_reasons: ['whatsapp_send_failed'],
          },
        };
      }
      return {
        ok: true,
        status: 200,
        result: {
          success: true,
          send_performed: true,
          sends_whatsapp: true,
          whatsapp_message_id: 'wamid.MOCK',
        },
      };
    },
    async persistStaffInboxSentThreadMessage() {
      sendCalls.push({ kind: 'persist' });
      return { ok: true, persisted: true, message_id: 'm1' };
    },
  };
  return deps;
}

async function runGet(deps, query, usr) {
  const res = mockRes();
  const routes = createWhatsAppDraftRoutes(deps);
  await routes.handleWhatsAppDraftGet(query, res, usr);
  return { res: res.out, body: parseBody(res.out), deps };
}

async function runPost(deps, bodyObj, usr, headers) {
  const res = mockRes();
  const routes = createWhatsAppDraftRoutes(deps);
  await routes.handleWhatsAppDraftPost(mockReq(bodyObj, headers), res, usr);
  return { res: res.out, body: parseBody(res.out), deps };
}

async function runApprove(deps, bodyObj, usr, headers) {
  const res = mockRes();
  const routes = createWhatsAppDraftRoutes(deps);
  await routes.handleWhatsAppApproveSend(mockReq(bodyObj, headers), res, usr);
  return { res: res.out, body: parseBody(res.out), deps };
}

const modSrc = fs.readFileSync(MODULE_PATH, 'utf8');
const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const compositeSrc = fs.readFileSync(COMPOSITE_PATH, 'utf8');
const emailSrc = fs.readFileSync(EMAIL_ROUTES_PATH, 'utf8');
const upSql = fs.readFileSync(MIG_UP, 'utf8');
const downSql = fs.readFileSync(MIG_DOWN, 'utf8');
const emailTableSql = fs.readFileSync(MIG_070, 'utf8');

console.log('verify:inbox-whatsapp-draft-route');

console.log('\n── contract ──');
ok('path is /staff/inbox/whatsapp/draft', WHATSAPP_DRAFT_PATH === '/staff/inbox/whatsapp/draft');
ok('approve-send path matches email naming', WHATSAPP_APPROVE_SEND_PATH === '/staff/inbox/whatsapp/approve-send');
ok('does not collide with email draft', WHATSAPP_DRAFT_PATH !== EMAIL_DRAFT_PATH);
ok('does not collide with email approve-send', WHATSAPP_APPROVE_SEND_PATH !== EMAIL_APPROVE_SEND_PATH);
ok('minRole operator matches email drafts', WHATSAPP_DRAFT_MIN_ROLE === 'operator');
ok('channel is whatsapp', WHATSAPP_DRAFT_CHANNEL === 'whatsapp');
ok('route table GET+POST draft and POST approve-send operator', WHATSAPP_DRAFT_ROUTE_TABLE.length === 3
  && WHATSAPP_DRAFT_ROUTE_TABLE.every((r) => r.minRole === 'operator')
  && eq(WHATSAPP_DRAFT_ROUTE_TABLE.map((r) => r.method), ['GET', 'POST', 'POST'])
  && WHATSAPP_DRAFT_ROUTE_TABLE[2].path === WHATSAPP_APPROVE_SEND_PATH
  && WHATSAPP_DRAFT_ROUTE_TABLE[2].id === 'whatsapp_approve_send');
ok('POST body keys', eq(POST_BODY_KEYS.slice(), ['conversation_id', 'draft_text', 'client_slug']));
ok('approve body keys', eq(APPROVE_BODY_KEYS.slice(), ['conversation_id', 'client_slug', 'approval_id']));
ok('GET DTO keys', eq(GET_SUCCESS_DTO_KEYS.slice(), [
  'success', 'conversation_id', 'channel', 'draft_available', 'approval_id',
  'draft_text', 'edited_text', 'status', 'tool_trace', 'created_by_run_id',
]));
ok('POST DTO keys', eq(POST_SUCCESS_DTO_KEYS.slice(), [
  'success', 'conversation_id', 'channel', 'approval_id', 'draft_text', 'status',
]));
ok('approve DTO keys', eq(APPROVE_SUCCESS_DTO_KEYS.slice(), [
  'success', 'conversation_id', 'channel', 'approval_id', 'status',
  'send_performed', 'whatsapp_message_id',
]));
ok('body caps match email draft envelope', BODY_MAX_BYTES === 10240 && DRAFT_MAX_BYTES === 8000);

console.log('\n── no send on GET; approve-send uses injected helper ──');
ok('does not require luna-guest-reply-send-route (send helper is injected)',
  !/luna-guest-reply-send-route/.test(modSrc));
ok('module does not mention Graph or Cloud send',
  !/graph\.microsoft|whatsapp_cloud|_patched_whatsapp_cloud_send|guest_message_sends/i.test(modSrc));
ok('GET SQL is SELECT-only', /^SELECT\b/i.test(SQL_SELECT_PENDING)
  && !/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i.test(SQL_SELECT_PENDING));
ok('resolve SQL is SELECT-only', /^SELECT\b/i.test(SQL_RESOLVE)
  && !/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i.test(SQL_RESOLVE));
ok('GET resolve has no FOR UPDATE', !/FOR UPDATE/.test(SQL_RESOLVE));
ok('POST resolve locks the conversation', /FOR UPDATE OF conv/.test(SQL_RESOLVE_FOR_UPDATE));
ok('upsert writes luna_outbound_approvals, not email table',
  /INSERT INTO luna_outbound_approvals/.test(SQL_UPSERT_PENDING)
  && !/tenant_email_reply_approvals/.test(SQL_UPSERT_PENDING));
ok('approve-send CAS pending→approved then approved→sent',
  /SET status = 'approved'/.test(SQL_MARK_APPROVED)
  && /status = 'pending'/.test(SQL_MARK_APPROVED)
  && /SET status = 'sent'/.test(SQL_MARK_SENT)
  && /status = 'approved'/.test(SQL_MARK_SENT));
ok('GET handler never references upsert or send SQL', (() => {
  const m = /async function handleWhatsAppDraftGet[\s\S]*?(?=\n  async function |\n  const handlers)/.exec(modSrc);
  return !!(m && !/SQL_UPSERT_PENDING/.test(m[0]) && !/INSERT INTO/.test(m[0])
    && !/evaluateGuestReplySendRouteWithPause/.test(m[0])
    && !/SQL_MARK_SENT/.test(m[0]));
})());
ok('approve-send calls the injected send helper',
  /evaluateGuestReplySendRouteWithPause\(sendBody/.test(modSrc));
ok('email approve-send stays on the email module',
  emailSrc.includes("'/staff/inbox/email/approve-send'")
  && !modSrc.includes('/staff/inbox/email/approve-send')
  && !/\basync function handleApproveSend\b/.test(modSrc));

console.log('\n── migration 078 (new table, not 070 reuse) ──');
ok('078 up exists', fs.existsSync(MIG_UP));
ok('078 down exists', fs.existsSync(MIG_DOWN));
ok('creates luna_outbound_approvals', /CREATE TABLE luna_outbound_approvals/.test(upSql));
ok('does not ALTER tenant_email_reply_approvals',
  !/ALTER TABLE tenant_email_reply_approvals/.test(upSql)
  && !/CREATE TABLE tenant_email_reply_approvals/.test(upSql));
ok('070 email table still Graph-bound',
  /provider = 'microsoft_graph'/.test(emailTableSql)
  && /source_inbound_event_id/.test(emailTableSql));
ok('078 has channel discriminator', /channel TEXT NOT NULL/.test(upSql)
  && /channel IN \('whatsapp', 'email'\)/.test(upSql));
ok('078 status set matches spec',
  /pending.*approved.*rejected.*sent.*expired/.test(upSql.replace(/\s+/g, ' ')));
ok('one pending row per conversation+channel',
  /UNIQUE INDEX luna_outbound_approvals_pending_conversation_uq/.test(upSql)
  && /WHERE status = 'pending'/.test(upSql));
ok('down refuses nonempty', /078_down_refused/.test(downSql) && /rows present/.test(downSql));
ok('up comments why 070 cannot be reused', /Why a new table/.test(upSql) && /070 is Graph-mailbox-bound/.test(upSql));

console.log('\n── module isolation ──');
ok('does not require staff-query-api', !/require\s*\(\s*['"][^'"]*staff-query-api['"]\s*\)/.test(modSrc));
ok('does not call requireAuth', !/\brequireAuth\s*\(/.test(modSrc));
ok('calls assertStaffClientAccess', /assertStaffClientAccess\(/.test(modSrc));
ok('does not import inbox UI modules',
  !/inbox-thread\.js|inbox-luna-mode\.js|inbox-columns\.js|inbox-whatsapp-draft\.js/.test(modSrc));
ok('does not write conversations.staff_reply_draft',
  !/SET staff_reply_draft/.test(modSrc) && !/staff_reply_draft/.test(SQL_UPSERT_PENDING)
  && !/staff_reply_draft/.test(SQL_SELECT_PENDING));
ok('composite sections unchanged', eq(INBOX_THREAD_COMPOSITE_SECTIONS.slice(), [
  'detail', 'messages', 'context', 'draft', 'pause_state',
]));
ok('composite still reads staff_reply_draft, not 078',
  /getConversationDraftQuery/.test(compositeSrc)
  && !/luna_outbound_approvals/.test(compositeSrc)
  && !/whatsapp\/draft/.test(compositeSrc));

console.log('\n── staff-query-api wiring ──');
ok('requires the draft-routes module', /require\('\.\/lib\/staff-inbox-whatsapp-draft-routes'\)/.test(apiSrc));
ok('builds routes through the DI factory', /createWhatsAppDraftRoutes\(\{/.test(apiSrc));
const wiring = apiSrc.slice(
  apiSrc.indexOf('createWhatsAppDraftRoutes({'),
  apiSrc.indexOf('createWhatsAppDraftRoutes({') + 650,
);
for (const dep of ['sendJSON', 'send400', 'readBody', 'assertStaffClientAccess', 'appendAuditLog', 'withPgClient', 'DEFAULT_CLIENT', 'SQL_INJECT_RE', 'evaluateGuestReplySendRouteWithPause']) {
  ok(`factory is injected ${dep}`, wiring.includes(dep));
}
const dispatchStart = apiSrc.indexOf('if (pathname === WHATSAPP_DRAFT_PATH)');
ok('router matches the whatsapp draft path', dispatchStart > 0);
const dispatch = apiSrc.slice(dispatchStart, dispatchStart + 900);
ok('router requires operator auth on GET and POST',
  (dispatch.match(/requireAuth\(req, res, 'operator'\)/g) || []).length === 2);
ok('router minRole matches every route table entry',
  WHATSAPP_DRAFT_ROUTE_TABLE.every((r) => r.minRole === 'operator'));
ok('router dispatches GET then POST handlers',
  dispatch.indexOf('handleWhatsAppDraftGet(') > 0
  && dispatch.indexOf('handleWhatsAppDraftPost(') > dispatch.indexOf('handleWhatsAppDraftGet('));
ok('router authenticates before dispatching GET',
  dispatch.indexOf("requireAuth(req, res, 'operator')") < dispatch.indexOf('handleWhatsAppDraftGet('));
ok('router rejects other methods', /Allow: 'GET, POST'/.test(dispatch));
const approveDispatchStart = apiSrc.indexOf('if (pathname === WHATSAPP_APPROVE_SEND_PATH)');
ok('router matches the whatsapp approve-send path', approveDispatchStart > 0);
const approveDispatch = apiSrc.slice(approveDispatchStart, approveDispatchStart + 700);
ok('approve-send requires operator auth',
  approveDispatch.includes("requireAuth(req, res, 'operator')")
  && approveDispatch.indexOf("requireAuth(req, res, 'operator')") < approveDispatch.indexOf('handleWhatsAppApproveSend('));
ok('approve-send is POST only', /Allow: 'POST'/.test(approveDispatch)
  && approveDispatch.includes('handleWhatsAppApproveSend('));
ok('email draft POST stays routed', apiSrc.includes('pathname === EMAIL_DRAFT_PATH && method === \'POST\''));
ok('email approve-send stays routed', apiSrc.includes('pathname === EMAIL_APPROVE_SEND_PATH && method === \'POST\''));
ok('send-reply stays routed', apiSrc.includes('pathname === INBOX_SEND_REPLY_PATH'));
ok('send-reply still injects the same helper',
  /evaluateGuestReplySendRouteWithPause/.test(apiSrc.slice(
    apiSrc.indexOf('const inboxRoutes = createInboxRoutes({'),
    apiSrc.indexOf('const inboxRoutes = createInboxRoutes({') + 400,
  )));
ok('thread composite stays routed', apiSrc.includes('INBOX_THREAD_COMPOSITE_RE.exec(pathname)'));
ok('composite dispatch does not mention whatsapp draft',
  !/WHATSAPP_DRAFT/.test(apiSrc.slice(
    apiSrc.indexOf('const inboxThreadCompositeMatch'),
    apiSrc.indexOf('const inboxThreadCompositeMatch') + 500,
  )));

console.log('\n── body shape ──');
ok('snapshot accepts conversation_id + draft_text',
  snapshotPostBody({ conversation_id: V, draft_text: DRAFT }) !== null);
ok('snapshot accepts optional client_slug',
  snapshotPostBody({ conversation_id: V, draft_text: DRAFT, client_slug: CLIENT }) !== null);
ok('snapshot rejects extra keys',
  snapshotPostBody({ conversation_id: V, draft_text: DRAFT, approval_id: V }) === null);
ok('snapshot rejects empty draft', snapshotPostBody({ conversation_id: V, draft_text: '' }) === null);
ok('snapshot rejects missing conversation_id', snapshotPostBody({ draft_text: DRAFT }) === null);
ok('snapshot rejects uppercase UUID',
  snapshotPostBody({ conversation_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', draft_text: DRAFT }) === null);
ok('snapshot rejects oversized draft',
  snapshotPostBody({ conversation_id: V, draft_text: 'x'.repeat(DRAFT_MAX_BYTES + 1) }) === null);
ok('approve snapshot accepts conversation_id',
  snapshotApproveBody({ conversation_id: V }) !== null);
ok('approve snapshot accepts optional approval_id',
  snapshotApproveBody({ conversation_id: V, approval_id: A }) !== null);
ok('approve snapshot rejects extra keys',
  snapshotApproveBody({ conversation_id: V, draft_text: DRAFT }) === null);
ok('approve snapshot rejects uppercase UUID',
  snapshotApproveBody({ conversation_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }) === null);
ok('killSwitchError dry-run before auto-send',
  killSwitchError({ WHATSAPP_DRY_RUN: 'true', LUNA_AUTO_SEND_ENABLED: 'true' }).code === 'whatsapp_dry_run'
  && killSwitchError({ WHATSAPP_DRY_RUN: 'false' }).code === 'luna_auto_send_disabled'
  && killSwitchError({}).code === 'whatsapp_dry_run'
  && killSwitchError({ WHATSAPP_DRY_RUN: 'false', LUNA_AUTO_SEND_ENABLED: 'true' }) === null);
ok('GET query parses lowercase uuid', parseConversationIdQuery({ conversation_id: V }) === V);
ok('GET query rejects missing id', parseConversationIdQuery({}) === null);
ok('actorFromUser requires operator+',
  actorFromUser(user()) !== null
  && actorFromUser(user({ role: 'viewer' })) === null
  && actorFromUser(null) === null);
ok('isWhatsAppConversation rejects email channel and emailv1 phone',
  isWhatsAppConversation({ channel: 'whatsapp', phone: '+34600000404' }) === true
  && isWhatsAppConversation({ channel: 'email', phone: '+34600000404' }) === false
  && isWhatsAppConversation({ channel: 'whatsapp', phone: 'emailv1:abcd' }) === false);

console.log('\n── inbox WhatsApp draft UI ──');
{
  const uiSrc = fs.readFileSync(WHATSAPP_DRAFT_MODULE, 'utf8');
  const threadSrc = fs.readFileSync(THREAD_MODULE, 'utf8');
  const lunaSrc = fs.readFileSync(LUNA_MODE_MODULE, 'utf8');
  const columnsSrc = fs.readFileSync(COLUMNS_MODULE, 'utf8');
  const injectorSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'inbox-browser-source.js'), 'utf8');
  const portalSrc = readStaffPortalUiSource();

  ok('whatsapp draft UI module exists', fs.existsSync(WHATSAPP_DRAFT_MODULE));
  ok('GET draft URL uses conversation_id + inboxClientQuery',
    uiSrc.includes("'/staff/inbox/whatsapp/draft' + inboxClientQuery()")
    && uiSrc.includes("'&conversation_id=' + encodeURIComponent(convId)"));
  ok('Edit saves via POST /staff/inbox/whatsapp/draft',
    /fetch\('\/staff\/inbox\/whatsapp\/draft'/.test(uiSrc)
    && /method:\s*'POST'/.test(uiSrc)
    && uiSrc.includes("draft_text: messageText"));
  ok('Approve POSTs /staff/inbox/whatsapp/approve-send',
    uiSrc.includes("fetch('/staff/inbox/whatsapp/approve-send'")
    && /method:\s*'POST'/.test(uiSrc.slice(uiSrc.indexOf("fetch('/staff/inbox/whatsapp/approve-send'"))));
  ok('surfaces whatsapp_dry_run without treating it as sent',
    uiSrc.includes("errorCode === 'whatsapp_dry_run'")
    && !uiSrc.includes('WhatsApp dry run is on')
    && !/st\.sent = true[\s\S]{0,200}whatsapp_dry_run/.test(uiSrc));
  ok('surfaces luna_auto_send_disabled',
    uiSrc.includes("errorCode === 'luna_auto_send_disabled'"));
  ok('surfaces 409 approval_conflict',
    uiSrc.includes('status === 409') && uiSrc.includes('approval_conflict'));
  ok('inFlight guard prevents a second approve while one is in flight',
    /function performWhatsAppDraftApprove[\s\S]*if \(st\.inFlight \|\| st\.sent\) return/.test(uiSrc));
  ok('does not auto-send drafts (no send-reply from the card)',
    !uiSrc.includes('/staff/inbox/send-reply')
    && !uiSrc.includes('/staff/inbox/email/'));
  ok('does not invent a WhatsApp Draft Luna mode',
    !/data-luna-mode="draft"/.test(uiSrc)
    && /if \(channel === 'email'\) return \['draft', 'off'\]/.test(lunaSrc)
    && /return \['auto', 'off'\]/.test(lunaSrc));
  ok('WhatsApp Auto|Off control is unchanged',
    lunaSrc.includes("return ['auto', 'off']")
    && lunaSrc.includes("return ['draft', 'off']"));
  ok('four-column module does not grow draft fetches',
    !columnsSrc.includes('/staff/inbox/whatsapp/')
    && columnsSrc.includes('data-col1')
    && columnsSrc.includes('data-col2')
    && columnsSrc.includes('data-col4'));
  ok('email draft POST path unchanged in thread',
    threadSrc.includes("fetch('/staff/inbox/email/draft'")
    && threadSrc.includes("fetch('/staff/inbox/email/approve-send'")
    && threadSrc.includes("fetch('/staff/inbox/email/generate-luna-draft'"));
  ok('email approve button ids unchanged',
    threadSrc.includes('id="btn-email-approve-send"')
    && threadSrc.includes('id="btn-email-save-draft"')
    && threadSrc.includes('function wireInboxEmailReply('));
  ok('WhatsApp staff Send reply remains',
    threadSrc.includes('id="btn-send-reply"')
    && threadSrc.includes('function wireInboxSendReply(')
    && threadSrc.includes("fetch('/staff/inbox/send-reply'"));
  ok('thread mounts the card only off the email path',
    /if \(!isEmailConversation\) html \+= inboxWhatsAppDraftMountHtml\(\)/.test(threadSrc)
    && /wireInboxWhatsAppDraft\(convId, targetEl\)/.test(threadSrc)
    && /function loadSurfInboxDemoDetail[\s\S]*function inboxColumnsOwnSidebar/.test(threadSrc)
    && !/inboxWhatsAppDraftMountHtml/.test(threadSrc.slice(
      threadSrc.indexOf('function loadSurfInboxDemoDetail'),
      threadSrc.indexOf('function inboxColumnsOwnSidebar'),
    )));
  ok('injector prepends whatsapp-draft ahead of thread',
    injectorSrc.includes('getInboxWhatsAppDraftBrowserSource()')
    && injectorSrc.indexOf('getInboxLunaModeBrowserSource()') < injectorSrc.indexOf('getInboxWhatsAppDraftBrowserSource()')
    && injectorSrc.indexOf('getInboxWhatsAppDraftBrowserSource()') < injectorSrc.indexOf('readBrowserModule(THREAD_MODULE)'));
  ok('combined portal UI has WhatsApp draft fetches and email fetches',
    portalSrc.includes('/staff/inbox/whatsapp/draft')
    && portalSrc.includes('/staff/inbox/whatsapp/approve-send')
    && portalSrc.includes('/staff/inbox/email/draft')
    && portalSrc.includes('/staff/inbox/email/approve-send'));
  ok('email routes file still owns email approve-send',
    emailSrc.includes("'/staff/inbox/email/approve-send'")
    && !uiSrc.includes('/staff/inbox/email/approve-send'));

  const sandbox = {
    escHtml: (s) => String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    inboxClientQuery: () => '?client=wolfhouse-somo',
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${uiSrc}\nthis.inboxWhatsAppDraftMountHtml = inboxWhatsAppDraftMountHtml;\n` +
    'this.inboxWhatsAppDraftCardHtml = inboxWhatsAppDraftCardHtml;\n' +
    'this.whatsappDraftGetUrl = whatsappDraftGetUrl;\n' +
    'this.whatsappDraftFailureCopy = whatsappDraftFailureCopy;\n' +
    'this.renderInboxWhatsAppDraftCard = renderInboxWhatsAppDraftCard;\n' +
    'this.hydrateWhatsAppReplyComposer = hydrateWhatsAppReplyComposer;\n' +
    'this.wireInboxWhatsAppDraft = wireInboxWhatsAppDraft;\n' +
    'this.whatsappDraftState = whatsappDraftState;\n' +
    'this.inboxWhatsAppDraftGuestPhone = inboxWhatsAppDraftGuestPhone;',
    sandbox,
  );
  const mount = sandbox.inboxWhatsAppDraftMountHtml();
  const card = sandbox.inboxWhatsAppDraftCardHtml({ draftText: DRAFT, editing: false });
  const editing = sandbox.inboxWhatsAppDraftCardHtml({ draftText: DRAFT, editing: true });
  ok('mount is hidden until a pending draft loads',
    /id="inbox-whatsapp-draft"/.test(mount) && /\bhidden\b/.test(mount));
  ok('view card shows draft text + Approve / Edit',
    card.includes(DRAFT)
    && /id="btn-whatsapp-draft-approve"/.test(card)
    && /id="btn-whatsapp-draft-edit"/.test(card)
    && card.includes('Approve')
    && card.includes('Edit'));
  ok('edit card uses a dedicated textarea, not #draft-textarea',
    /id="whatsapp-draft-textarea"/.test(editing)
    && !/id="draft-textarea"/.test(editing)
    && /id="btn-whatsapp-draft-save"/.test(editing));
  ok('hydrates Write a reply composer from pending Luna draft',
    /function hydrateWhatsAppReplyComposer/.test(uiSrc)
    && /#draft-textarea/.test(uiSrc)
    && /ta\.value = draftText/.test(uiSrc)
    && !/Luna draft ready/.test(uiSrc));
  ok('never paints the second Luna draft box',
    /mount\.hidden = true/.test(uiSrc)
    && /function renderInboxWhatsAppDraftCard[\s\S]*mount\.innerHTML = ''/.test(uiSrc)
    && /performInboxSend\(convId, '', targetEl\)/.test(uiSrc)
    && /closest\('#btn-send-reply'\)/.test(uiSrc)
    && !/performWhatsAppDraftSaveThenApprove\(convId, targetEl\);/.test(uiSrc));
  ok('GET URL carries conversation_id',
    sandbox.whatsappDraftGetUrl(V) === `/staff/inbox/whatsapp/draft?client=wolfhouse-somo&conversation_id=${V}`);
  ok('kill-switch copy stays off staff chrome',
    sandbox.whatsappDraftFailureCopy('approve', 503, 'whatsapp_dry_run') === ''
    && sandbox.whatsappDraftFailureCopy('approve', 503, 'luna_auto_send_disabled') === ''
    && sandbox.whatsappDraftFailureCopy('approve', 409, 'approval_conflict').indexOf('Conflict') >= 0);
  {
    const mountNode = { hidden: false, innerHTML: 'card' };
    sandbox.renderInboxWhatsAppDraftCard({ querySelector: () => mountNode }, { draftText: DRAFT });
    ok('live render never paints the Luna draft card', mountNode.hidden === true && mountNode.innerHTML === '');
    const ta = { disabled: false, value: 'Portal leftover' };
    sandbox.hydrateWhatsAppReplyComposer({
      querySelector: (sel) => (sel === '#draft-textarea' ? ta : null),
    }, DRAFT);
    ok('hydrate overwrites leftover reply text with Luna draft', ta.value === DRAFT);
  }
  {
    ok('reads guest phone from thread meta',
      sandbox.inboxWhatsAppDraftGuestPhone({
        querySelector: (sel) => (sel === '.detail-meta' ? { textContent: '+491726422307 · WhatsApp' } : null),
      }) === '+491726422307');
    const sendCalls = [];
    sandbox.performInboxSend = function (id, phone) { sendCalls.push({ id, phone }); };
    sandbox.selectedConvId = V;
    sandbox.fetch = function () {
      return Promise.resolve({ status: 200, text: function () { return Promise.resolve('{"success":false}'); } });
    };
    const listeners = [];
    const mountNode = {
      dataset: {},
      hidden: true,
      innerHTML: '',
      addEventListener: function () {},
      contains: function () { return false; },
    };
    const targetEl = {
      dataset: {},
      contains: function () { return true; },
      querySelector: function (sel) {
        if (sel === '#inbox-whatsapp-draft') return mountNode;
        if (sel === '.detail-meta') return { textContent: '+491726422307 · WhatsApp' };
        return null;
      },
      addEventListener: function (type, fn, opts) { listeners.push({ type, fn, capture: !!(opts && opts === true || opts && opts.capture) }); },
    };
    sandbox.whatsappDraftState(V).draftText = 'Third test reply';
    sandbox.whatsappDraftState(V).sent = false;
    sandbox.wireInboxWhatsAppDraft(V, targetEl);
    const sendListener = listeners.find((l) => l.capture);
    const ev = {
      preventDefault: function () {},
      stopImmediatePropagation: function () {},
      stopPropagation: function () {},
      target: { closest: function (sel) { return sel === '#btn-send-reply' ? { id: 'btn-send-reply' } : null; } },
    };
    if (sendListener) sendListener.fn(ev);
    ok('Luna-hydrated Send reply omits masked display recipient so route uses canonical phone/wa_id',
      sendCalls.length === 1 && sendCalls[0].id === V && sendCalls[0].phone === '',
      `calls=${JSON.stringify(sendCalls)}`);
  }
  {
    const executeSrc = fs.readFileSync(
      path.join(ROOT, 'scripts', 'lib', 'open-demo-whatsapp-inbound-execute.js'),
      'utf8',
    );
    ok('draft/off skip WhatsApp typing dots',
      /skipTypingForDraft/.test(executeSrc)
      && /mode === 'draft' \|\| mode === 'off'/.test(executeSrc)
      && /!skipTypingForDraft/.test(executeSrc));
  }
}

function fakeInboxChannelPg(mode) {
  return {
    query: async (sql) => {
      if (/inbox_channel_modes/.test(String(sql))) return { rows: [{ mode }] };
      return { rows: [] };
    },
  };
}

function loadInboundExecuteWithTypingStub() {
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function loadPgStub(request, parent, isMain) {
    if (request === 'pg') {
      return { Client: class Client {}, Pool: class Pool {} };
    }
    if (request === 'dotenv') {
      return { config() { return {}; } };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  const providerPath = require.resolve('./lib/luna-whatsapp-provider');
  const reviewPath = require.resolve('./lib/luna-guest-inbound-review-dry-run');
  const executePath = require.resolve('./lib/open-demo-whatsapp-inbound-execute');
  const prevReview = require.cache[reviewPath];
  require.cache[reviewPath] = {
    id: reviewPath,
    filename: reviewPath,
    loaded: true,
    exports: {
      runGuestInboundReviewDryRun: async function stubReview() {
        return { ok: false, status: 200, dry_run: true, sends_whatsapp: false };
      },
    },
    children: [],
    paths: [],
  };
  const provider = require(providerPath);
  const origTyping = provider.sendLunaWhatsAppTypingIndicator;
  const calls = [];
  provider.sendLunaWhatsAppTypingIndicator = async function stubTyping(...args) {
    calls.push(args);
    return { success: true, typing_indicator_sent: true };
  };
  delete require.cache[executePath];
  const { executeOpenDemoWhatsAppInbound } = require(executePath);
  return {
    executeOpenDemoWhatsAppInbound,
    calls,
    restore() {
      Module._load = origLoad;
      provider.sendLunaWhatsAppTypingIndicator = origTyping;
      if (prevReview) require.cache[reviewPath] = prevReview;
      else delete require.cache[reviewPath];
      delete require.cache[executePath];
    },
  };
}

(async () => {
  console.log('\n── typing dots execute (draft/off/auto) ──');
  {
    const harness = loadInboundExecuteWithTypingStub();
    const body = {
      client_slug: 'sunset',
      channel: 'whatsapp',
      guest_phone: '+34600111222',
      message_text: 'hello',
      inbound_message_id: 'wamid.TEST123',
      send_live_reply_confirmed: true,
    };
    try {
      harness.calls.length = 0;
      await harness.executeOpenDemoWhatsAppInbound(fakeInboxChannelPg('draft'), body, {});
      ok('draft mode typing helper called 0', harness.calls.length === 0, `got ${harness.calls.length}`);

      harness.calls.length = 0;
      await harness.executeOpenDemoWhatsAppInbound(fakeInboxChannelPg('off'), body, {});
      ok('off mode typing helper called 0', harness.calls.length === 0, `got ${harness.calls.length}`);

      harness.calls.length = 0;
      await harness.executeOpenDemoWhatsAppInbound(fakeInboxChannelPg('auto'), body, {});
      ok('auto mode typing helper called 1', harness.calls.length === 1, `got ${harness.calls.length}`);
    } catch (err) {
      ok('draft/off/auto typing execute ran', false, err && err.stack ? err.stack : String(err));
    } finally {
      harness.restore();
    }
  }

  console.log('\n── auth fail-closed ──');
  {
    const deps = makeDeps();
    const { res, body } = await runGet(deps, { conversation_id: V }, null);
    ok('GET without actor 403', res.statusCode === 403 && body.error === 'forbidden');
    ok('GET without actor zero DB', deps.dbHits === 0);
  }
  {
    const deps = makeDeps();
    const { res, body } = await runPost(deps, { conversation_id: V, draft_text: DRAFT }, null);
    ok('POST without actor 403', res.statusCode === 403 && body.error === 'forbidden');
    ok('POST without actor zero DB', deps.dbHits === 0);
  }
  {
    const deps = makeDeps();
    const { res, body } = await runPost(deps, { conversation_id: V, draft_text: DRAFT }, user({ role: 'viewer' }));
    ok('POST viewer 403', res.statusCode === 403 && body.error === 'forbidden' && deps.dbHits === 0);
  }
  {
    const deps = makeDeps({ accessDenied: true });
    const { res, body } = await runGet(deps, { conversation_id: V, client: CLIENT }, user());
    ok('GET denied client 403', res.statusCode === 403 && body.error === 'client_access_denied');
    ok('GET denied client zero DB', deps.dbHits === 0);
  }
  {
    const deps = makeDeps();
    const { res, body } = await runGet(deps, { conversation_id: V, client: HOSTILE }, user());
    ok('GET hostile slug 400', res.statusCode === 400 && /invalid client slug/.test(String(body.error)));
    ok('GET hostile slug zero DB', deps.dbHits === 0);
  }
  {
    const deps = makeDeps();
    const { res, body } = await runPost(
      deps,
      { conversation_id: V, draft_text: DRAFT, client_slug: HOSTILE },
      user(),
    );
    ok('POST hostile slug 400', res.statusCode === 400 && deps.dbHits === 0);
    ok('POST hostile does not leak SQL', !JSON.stringify(body).includes('DROP TABLE'));
  }

  console.log('\n── GET does not send ──');
  {
    const deps = makeDeps();
    const { res, body } = await runGet(deps, { conversation_id: V }, user());
    ok('GET 200 when conversation owned and no draft', res.statusCode === 200 && body.success === true);
    ok('GET draft_available false', body.draft_available === false && body.approval_id === null);
    ok('GET DTO keys exact', eq(Object.keys(body), GET_SUCCESS_DTO_KEYS.slice()));
    ok('GET never read a POST body', deps.sendCalls.length === 0);
    ok('GET SQL is resolve + select pending only', deps.sqlLog.length === 2
      && deps.sqlLog[0].sql === SQL_RESOLVE
      && deps.sqlLog[1].sql === SQL_SELECT_PENDING);
    ok('GET did not upsert', deps.durable.size === 0);
    ok('GET channel whatsapp', body.channel === 'whatsapp');
  }

  console.log('\n── persist + read ──');
  {
    const deps = makeDeps();
    const posted = await runPost(deps, { conversation_id: V, draft_text: DRAFT }, user());
    ok('POST 200', posted.res.statusCode === 200 && posted.body.success === true);
    ok('POST returns approval_id uuid', /^[0-9a-f-]{36}$/.test(posted.body.approval_id));
    ok('POST DTO keys exact', eq(Object.keys(posted.body), POST_SUCCESS_DTO_KEYS.slice()));
    ok('POST stores pending whatsapp draft', posted.body.status === 'pending'
      && posted.body.channel === 'whatsapp'
      && posted.body.draft_text === DRAFT);
    ok('POST SQL locks then upserts', deps.sqlLog.some((e) => e.sql === SQL_RESOLVE_FOR_UPDATE)
      && deps.sqlLog.some((e) => e.sql === SQL_UPSERT_PENDING));
    const got = await runGet(deps, { conversation_id: V }, user());
    ok('GET after POST returns the draft', got.res.statusCode === 200
      && got.body.draft_available === true
      && got.body.draft_text === DRAFT
      && got.body.approval_id === posted.body.approval_id);
    ok('GET after POST still SELECT-only', got.deps.sqlLog.filter((e) => e.sql === SQL_UPSERT_PENDING).length === 1);
    const updated = await runPost(deps, { conversation_id: V, draft_text: 'Updated hold copy.' }, user());
    ok('second POST updates same pending row', updated.res.statusCode === 200
      && updated.body.approval_id === posted.body.approval_id
      && updated.body.draft_text === 'Updated hold copy.');
  }

  console.log('\n── tenant / channel fail-closed ──');
  {
    const deps = makeDeps();
    deps.setConversation(null);
    const { res, body } = await runPost(deps, { conversation_id: OTHER, draft_text: DRAFT }, user());
    ok('foreign conversation POST 404', res.statusCode === 404 && body.error === 'not_found');
    ok('foreign conversation does not persist', deps.durable.size === 0);
  }
  {
    const deps = makeDeps();
    deps.setConversation({
      conversation_id: V,
      client_id: C,
      client_slug: CLIENT,
      phone: 'emailv1:deadbeef',
      channel: 'email',
    });
    const posted = await runPost(deps, { conversation_id: V, draft_text: DRAFT }, user());
    ok('email conversation POST 409', posted.res.statusCode === 409
      && posted.body.error === 'email_channel_not_supported');
    ok('email conversation does not persist', deps.durable.size === 0);
    const got = await runGet(deps, { conversation_id: V }, user());
    ok('email conversation GET 409, no send', got.res.statusCode === 409
      && got.body.error === 'email_channel_not_supported'
      && !got.deps.sqlLog.some((e) => e.sql === SQL_UPSERT_PENDING));
  }
  {
    const deps = makeDeps();
    const { res, body } = await runPost(
      deps,
      { conversation_id: V, draft_text: DRAFT, extra: true },
      user(),
    );
    ok('POST extra key 400', res.statusCode === 400 && body.error === 'invalid_request' && deps.dbHits === 0);
  }
  {
    const deps = makeDeps();
    const { res } = await runPost(
      deps,
      { conversation_id: V, draft_text: DRAFT },
      user(),
      { 'content-type': 'text/plain' },
    );
    ok('POST non-json 415', res.statusCode === 415);
    ok('POST non-json zero DB', deps.dbHits === 0);
  }
  {
    const deps = makeDeps();
    const { res, body } = await runGet(deps, { conversation_id: 'not-a-uuid' }, user());
    ok('GET bad conversation_id 400', res.statusCode === 400 && body.error === 'invalid_request' && deps.dbHits === 0);
  }

  console.log('\n── approve-send auth ──');
  {
    const deps = makeDeps();
    const { res, body } = await runApprove(deps, { conversation_id: V }, null);
    ok('approve without actor 403', res.statusCode === 403 && body.error === 'forbidden');
    ok('approve without actor zero DB and no send', deps.dbHits === 0
      && deps.sendCalls.filter((c) => c.kind === 'send').length === 0);
  }
  {
    const deps = makeDeps();
    const { res, body } = await runApprove(deps, { conversation_id: V }, user({ role: 'viewer' }));
    ok('approve viewer 403', res.statusCode === 403 && body.error === 'forbidden' && deps.dbHits === 0);
  }
  {
    const deps = makeDeps({ accessDenied: true });
    const { res, body } = await runApprove(deps, { conversation_id: V, client_slug: CLIENT }, user());
    ok('approve denied client 403', res.statusCode === 403 && body.error === 'client_access_denied');
    ok('approve denied client no send', deps.sendCalls.filter((c) => c.kind === 'send').length === 0);
  }

  console.log('\n── approve-send missing / not pending ──');
  {
    const deps = makeDeps();
    const { res, body } = await runApprove(deps, { conversation_id: V }, user());
    ok('approve missing draft 404', res.statusCode === 404 && body.error === 'not_found');
    ok('approve missing draft does not send', deps.sendCalls.filter((c) => c.kind === 'send').length === 0);
  }
  {
    const deps = makeDeps();
    const posted = await runPost(deps, { conversation_id: V, draft_text: DRAFT }, user());
    const key = `${C}:${V}:whatsapp`;
    const row = deps.durable.get(key);
    deps.durable.set(key, { ...row, status: 'sent' });
    const { res, body } = await runApprove(deps, { conversation_id: V }, user());
    ok('approve already-sent 409', res.statusCode === 409 && body.error === 'approval_conflict');
    ok('approve already-sent does not send', deps.sendCalls.filter((c) => c.kind === 'send').length === 0);
    ok('approve already-sent stays sent', deps.durable.get(key).status === 'sent');
    ok('posted draft id retained', posted.body.approval_id === row.approval_id);
  }

  console.log('\n── approve-send kill switches do not call send ──');
  {
    const deps = makeDeps({ runtimeEnv: { WHATSAPP_DRY_RUN: 'true', LUNA_AUTO_SEND_ENABLED: 'true' } });
    await runPost(deps, { conversation_id: V, draft_text: DRAFT }, user());
    deps.sendCalls.length = 0;
    const { res, body } = await runApprove(deps, { conversation_id: V }, user());
    ok('dry-run 503 whatsapp_dry_run', res.statusCode === 503 && body.error === 'whatsapp_dry_run');
    ok('dry-run does not call send helper', deps.sendCalls.filter((c) => c.kind === 'send').length === 0);
    ok('dry-run leaves pending', [...deps.durable.values()][0].status === 'pending');
  }
  {
    const deps = makeDeps({ runtimeEnv: { LUNA_AUTO_SEND_ENABLED: 'true' } });
    await runPost(deps, { conversation_id: V, draft_text: DRAFT }, user());
    deps.sendCalls.length = 0;
    const { res, body } = await runApprove(deps, { conversation_id: V }, user());
    ok('unset WHATSAPP_DRY_RUN 503 whatsapp_dry_run', res.statusCode === 503 && body.error === 'whatsapp_dry_run');
    ok('unset dry-run does not send', deps.sendCalls.filter((c) => c.kind === 'send').length === 0);
  }
  {
    const deps = makeDeps({ runtimeEnv: { WHATSAPP_DRY_RUN: 'false' } });
    await runPost(deps, { conversation_id: V, draft_text: DRAFT }, user());
    deps.sendCalls.length = 0;
    const { res, body } = await runApprove(deps, { conversation_id: V }, user());
    ok('auto-send unset 503 luna_auto_send_disabled', res.statusCode === 503 && body.error === 'luna_auto_send_disabled');
    ok('auto-send unset does not send', deps.sendCalls.filter((c) => c.kind === 'send').length === 0);
    ok('auto-send unset leaves pending', [...deps.durable.values()][0].status === 'pending');
  }
  {
    const deps = makeDeps({ runtimeEnv: { WHATSAPP_DRY_RUN: 'false', LUNA_AUTO_SEND_ENABLED: 'false' } });
    await runPost(deps, { conversation_id: V, draft_text: DRAFT }, user());
    deps.sendCalls.length = 0;
    const { res, body } = await runApprove(deps, { conversation_id: V }, user());
    ok('auto-send false 503 luna_auto_send_disabled', res.statusCode === 503 && body.error === 'luna_auto_send_disabled');
    ok('auto-send false does not persist thread', deps.sendCalls.filter((c) => c.kind === 'persist').length === 0);
  }

  console.log('\n── approve-send live path ──');
  {
    const deps = makeDeps();
    const posted = await runPost(deps, { conversation_id: V, draft_text: DRAFT }, user());
    deps.sendCalls.length = 0;
    const approved = await runApprove(deps, { conversation_id: V }, user());
    ok('approve-send 200', approved.res.statusCode === 200 && approved.body.success === true);
    ok('approve-send DTO keys exact', eq(Object.keys(approved.body), APPROVE_SUCCESS_DTO_KEYS.slice()));
    ok('approve-send marks sent', approved.body.status === 'sent'
      && approved.body.send_performed === true
      && approved.body.approval_id === posted.body.approval_id
      && approved.body.whatsapp_message_id === 'wamid.MOCK');
    ok('approve-send called send helper once', deps.sendCalls.filter((c) => c.kind === 'send').length === 1);
    ok('approve-send send body is stored draft',
      deps.sendCalls.find((c) => c.kind === 'send').body.suggested_reply === DRAFT);
    ok('approve-send persisted thread after send', deps.sendCalls.filter((c) => c.kind === 'persist').length === 1);
    ok('durable row is sent', [...deps.durable.values()][0].status === 'sent');
    const got = await runGet(deps, { conversation_id: V }, user());
    ok('GET after send has no pending draft', got.body.draft_available === false && got.body.approval_id === null);
  }
  {
    const deps = makeDeps({ sendFail: true });
    await runPost(deps, { conversation_id: V, draft_text: DRAFT }, user());
    deps.sendCalls.length = 0;
    const { res, body } = await runApprove(deps, { conversation_id: V }, user());
    ok('send failure 502', res.statusCode === 502 && body.error === 'send_failed');
    ok('send failure does not leave pending', [...deps.durable.values()][0].status === 'approved');
    ok('send failure called helper', deps.sendCalls.filter((c) => c.kind === 'send').length === 1);
    ok('send failure did not persist thread', deps.sendCalls.filter((c) => c.kind === 'persist').length === 0);
  }

  console.log('\n── factory requires fail-closed deps ──');
  try {
    createWhatsAppDraftRoutes({ sendJSON() {}, send400() {}, withPgClient() {} });
    ok('missing assertStaffClientAccess throws', false);
  } catch (err) {
    ok('missing assertStaffClientAccess throws', /assertStaffClientAccess/.test(err.message));
  }
  try {
    createWhatsAppDraftRoutes({
      sendJSON() {}, send400() {}, withPgClient() {}, assertStaffClientAccess() {}, SQL_INJECT_RE: /x/,
    });
    ok('missing send helper throws', false);
  } catch (err) {
    ok('missing send helper throws', /evaluateGuestReplySendRouteWithPause/.test(err.message));
  }

  console.log(`\n── ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
