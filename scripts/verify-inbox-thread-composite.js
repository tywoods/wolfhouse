'use strict';

/**
 * verify:inbox-thread-composite
 *
 * Contract harness for GET /staff/inbox/thread/:id (Inbox thread composite read).
 *
 * Proves:
 *   - createInboxThreadCompositeRoutes DI factory + route table (viewer, GET)
 *   - staff-query-api requireAuth minRole matches the table, and the six
 *     endpoints the fan-out used are still routed — including
 *     /staff/conversations/:id/staff-state, which the composite no longer reads
 *   - each composite section carries the same top-level fields the individual
 *     route returns today (keys read out of the real handlers in
 *     staff-query-api.js, values compared against the injected helpers)
 *   - the thread view never queries staff-state: no section, no SQL, and the
 *     Luna pause verdict is unchanged without it
 *   - the browser's per-section reads still work against the composite body
 *   - tenant scoping: denied client never reaches Postgres, unknown/foreign
 *     conversation 404s with the detail route's body before any other query
 *   - one connection, one REPEATABLE READ READ ONLY snapshot, always closed
 *   - a failing section degrades on its own instead of blanking the thread
 *
 * No live DB / network.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-inbox-thread-composite.js');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const CONV_QUERIES_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-conversation-queries.js');
const PAUSE_SQL_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-bot-pause-sql.js');

const {
  INBOX_THREAD_COMPOSITE_PATH,
  INBOX_THREAD_COMPOSITE_RE,
  INBOX_THREAD_COMPOSITE_SECTIONS,
  INBOX_THREAD_COMPOSITE_ROUTE_TABLE,
  createInboxThreadCompositeRoutes,
} = require('./lib/staff-inbox-thread-composite');
const {
  getConversationDetailQuery,
  getConversationMessagesQuery,
  projectStaffInboxThreadMessage,
  getConversationContextQuery,
  getConversationBookingsQuery,
  getConversationDraftQuery,
  getConversationStaffStateQuery,
} = require('./lib/staff-conversation-queries');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const { formatPauseStateRow } = require('./lib/staff-bot-pause-sql');
const {
  isInactiveInboxBookingStatus: prodIsInactiveInboxBookingStatus,
  filterActiveInboxBookings: prodFilterActiveInboxBookings,
  sanitizeConversationContextForInbox: prodSanitizeConversationContextForInbox,
  buildDefaultActivePauseResponse: prodBuildDefaultActivePauseResponse,
  buildPausedStateResponse: prodBuildPausedStateResponse,
} = require('./lib/staff-inbox-helpers');
const { createBotPauseStateRoutes } = require('./lib/staff-bot-pause-state-handler');

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

/** Column aliases of a query builder's SELECT list, in order. */
function selectAliases(sql) {
  const body = sql.slice(sql.indexOf('SELECT') + 6, sql.search(/\nFROM /));
  return body
    .split(/,\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const aliased = /\bAS\s+([a-z_][a-z0-9_]*)\s*$/i.exec(chunk);
      if (aliased) return aliased[1];
      const bare = /([a-z_][a-z0-9_]*)\s*$/i.exec(chunk.replace(/::[a-z_]+\s*$/i, ''));
      return bare ? bare[1] : chunk;
    });
}

function staffStateColumns() {
  return selectAliases(getConversationStaffStateQuery());
}

/** The pause helper executed as the browser receives it, not a copy of it. */
function shippedPauseHelper() {
  const start = uiSrc.indexOf('function isLunaGuestAutomationPaused(sources){');
  if (start < 0) throw new Error('isLunaGuestAutomationPaused not found in the rendered portal UI');
  const src = uiSrc.slice(start, uiSrc.indexOf('\n}', start) + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return isLunaGuestAutomationPaused;`)();
}

// ── canned rows ─────────────────────────────────────────────────────────────

const CONV_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CLIENT = 'wolfhouse-somo';

const DETAIL_ROW = Object.freeze({
  conversation_id: CONV_ID,
  phone: '+34600111222',
  guest_name: 'Ada',
  needs_human: false,
  staff_reply_draft: 'hola',
});
const MESSAGE_ROWS = Object.freeze([
  { message_id: 'm1', direction: 'inbound', message_text: 'hi', created_at: '2026-08-01T10:00:00Z' },
  { message_id: 'm2', direction: 'outbound', message_text: 'hello', created_at: '2026-08-01T10:01:00Z', source: 'luna' },
]);
const CONTEXT_ROW = Object.freeze({
  conversation_id: CONV_ID,
  booking_id: 'bk-1',
  booking_code: 'WH-1',
  booking_status: 'confirmed',
});
const BOOKING_ROWS = Object.freeze([
  { booking_id: 'bk-1', booking_code: 'WH-1', booking_status: 'confirmed' },
  { booking_id: 'bk-2', booking_code: 'WH-2', booking_status: 'cancelled' },
]);
const DRAFT_ROW = Object.freeze({ conversation_id: CONV_ID, draft_text: 'hola', draft_available: true });
const DETAIL_COLUMNS = selectAliases(getConversationDetailQuery());

function pgError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Minimal Postgres double with transaction-abort semantics: after a failed
 * statement only ROLLBACK / ROLLBACK TO SAVEPOINT / COMMIT are accepted, which
 * is what makes the savepoint-per-section behaviour observable.
 *
 * plan.commitThrow: Error to throw on COMMIT
 * plan.rollbackThrow: Error to throw on ROLLBACK (after COMMIT fails)
 */
function makePg(plan) {
  const log = [];
  const state = { inTx: false, aborted: false, commitAttempted: false };
  const scoped = !!(plan && plan.scoped);
  const opts = scoped ? { locationScoped: true } : {};

  function cannedFor(sql) {
    if (sql === getConversationDetailQuery(opts)) return plan.detail;
    if (sql === getConversationMessagesQuery(opts)) return plan.messages;
    if (sql === getConversationContextQuery(opts)) return plan.context;
    if (sql === getConversationBookingsQuery(opts)) return plan.bookings;
    if (sql === getConversationDraftQuery(opts)) return plan.draft;
    if (/bot_pause_states/.test(sql)) {
      return /conversation_id = \$2/.test(sql) && /paused_at DESC/.test(sql) && plan.pauseGlobal !== undefined
        ? (log.filter((e) => /bot_pause_states/.test(e.sql)).length === 1 ? plan.pauseGlobal : plan.pause)
        : plan.pause;
    }
    return { rows: [] };
  }

  return {
    log,
    state,
    async query(sql, params) {
      const raw = String(sql);
      const text = raw.trim();
      log.push({ sql: text, params });

      if (/^BEGIN/i.test(text)) { state.inTx = true; state.aborted = false; state.commitAttempted = false; return { rows: [] }; }
      if (/^COMMIT$/i.test(text)) {
        state.commitAttempted = true;
        if (plan.commitThrow) {
          throw plan.commitThrow;
        }
        state.inTx = false; state.aborted = false; return { rows: [] };
      }
      if (/^ROLLBACK$/i.test(text)) {
        if (state.commitAttempted && plan.rollbackThrow) {
          throw plan.rollbackThrow;
        }
        state.inTx = false; state.aborted = false; return { rows: [] };
      }
      if (/^ROLLBACK TO SAVEPOINT/i.test(text)) { state.aborted = false; return { rows: [] }; }
      if (state.aborted) {
        throw pgError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
      }
      if (/^(SAVEPOINT|RELEASE SAVEPOINT)/i.test(text)) return { rows: [] };

      const canned = cannedFor(raw);
      if (canned instanceof Error) {
        state.aborted = true;
        throw canned;
      }
      return canned || { rows: [] };
    },
  };
}

const PG_CLIENT_DISCARD_REQUIRED = Symbol.for('wolfhouse.pgClient.discardRequired');

function makeDeps(plan = {}, overrides = {}) {
  const audit = [];
  const calls = { withPgClient: 0, sanitize: 0, filterBookings: 0, paused: 0, defaultActive: 0 };
  const helperResults = {};
  let lastPg = null;

  const deps = {
    DEFAULT_CLIENT: CLIENT,
    SQL_INJECT_RE: /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i,
    audit,
    calls,
    helperResults,
    get pg() { return lastPg; },
    sendJSON(res, status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return body;
    },
    send400(res, message) {
      return deps.sendJSON(res, 400, { success: false, error: message });
    },
    send404(res) {
      return deps.sendJSON(res, 404, { success: false, error: 'Not found' });
    },
    assertStaffClientAccess() { return true; },
    appendAuditLog(entry) { audit.push(entry); },
    markPgClientDiscardRequired(client) {
      if (client && typeof client === 'object') {
        client[PG_CLIENT_DISCARD_REQUIRED] = true;
      }
    },
    isPgClientDiscardRequired(client) {
      return !!(client && typeof client === 'object' && client[PG_CLIENT_DISCARD_REQUIRED] === true);
    },
    async withPgClient(fn) {
      calls.withPgClient += 1;
      lastPg = makePg({
        detail: { rows: [DETAIL_ROW] },
        messages: { rows: MESSAGE_ROWS.slice() },
        context: { rows: [CONTEXT_ROW] },
        bookings: { rows: BOOKING_ROWS.slice() },
        draft: { rows: [DRAFT_ROW] },
        pause: { rows: [] },
        ...plan,
      });
      return fn(lastPg);
    },
    resolveSunsetConversationScope(clientSlug, query) {
      if (clientSlug !== 'sunset') {
        return { scoped: false, locationId: null, queryOpts: {}, attachChannel: false, channelConfig: null };
      }
      const locationId = String((query && query.location) || 'sunset-somo');
      return { scoped: true, locationId, queryOpts: { locationScoped: true }, attachChannel: true, channelConfig: null };
    },
    conversationDetailQueryParams(clientSlug, convId, scope) {
      if (scope.scoped) return [clientSlug, convId, scope.locationId];
      return [clientSlug, convId];
    },
    // Use production helpers from staff-inbox-helpers.js — NOT test-authored recreations.
    // This proves the composite injects the actual production behavior.
    sanitizeConversationContextForInbox(row) {
      calls.sanitize += 1;
      helperResults.context = prodSanitizeConversationContextForInbox(row);
      return helperResults.context;
    },
    filterActiveInboxBookings(rows) {
      calls.filterBookings += 1;
      helperResults.bookings = prodFilterActiveInboxBookings(rows);
      return helperResults.bookings;
    },
    buildPausedStateResponse(row, extra) {
      calls.paused += 1;
      helperResults.pause = prodBuildPausedStateResponse(row, extra);
      return helperResults.pause;
    },
    buildDefaultActivePauseResponse(extra) {
      calls.defaultActive += 1;
      helperResults.pause = prodBuildDefaultActivePauseResponse(extra);
      return helperResults.pause;
    },
    ...overrides,
  };
  return deps;
}

async function runComposite(plan = {}, overrides = {}, query = { client: CLIENT }) {
  const deps = makeDeps(plan, overrides);
  const routes = createInboxThreadCompositeRoutes(deps);
  const res = mockRes();
  await routes.handleInboxThreadComposite(CONV_ID, query, res, { staff_user_id: 'u1', role: 'viewer' });
  return { deps, res, body: parseBody(res.out), routes };
}

/** Top-level keys of the `sendJSON(res, 200, { ... })` literal inside a handler. */
function sendJsonOkKeys(src, fnName) {
  const start = src.indexOf(`async function ${fnName}(`);
  if (start < 0) return null;
  const rest = src.slice(start + 10);
  const nextFn = rest.indexOf('\nasync function ');
  const body = nextFn > 0 ? rest.slice(0, nextFn) : rest;
  const anchor = body.indexOf('sendJSON(res, 200, {');
  if (anchor < 0) return null;
  const open = body.indexOf('{', anchor);
  let depth = 0;
  let top = '';
  for (let i = open; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
    if (depth === 1 && ch !== '{') top += ch;
  }
  // Handles both `key: value` and ES6 shorthand (`context,`).
  return top
    .split(',')
    .map((chunk) => {
      const m = /^\s*([a-z_][a-z0-9_]*)\s*(:|$)/i.exec(chunk.replace(/\/\/.*$/gm, ''));
      return m ? m[1] : null;
    })
    .filter(Boolean);
}

console.log('verify:inbox-thread-composite\n');

const modSrc = fs.readFileSync(MODULE_PATH, 'utf8');
const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const uiSrc = readStaffPortalUiSource();

console.log('── module surface ──');
ok('module exists', fs.existsSync(MODULE_PATH));
ok('shared conversation queries lib exists', fs.existsSync(CONV_QUERIES_PATH));
ok('shared pause SQL lib exists', fs.existsSync(PAUSE_SQL_PATH));
ok('createInboxThreadCompositeRoutes is a factory', typeof createInboxThreadCompositeRoutes === 'function');
ok('route path', INBOX_THREAD_COMPOSITE_PATH === '/staff/inbox/thread/:id');
ok('route table has exactly 1 route', INBOX_THREAD_COMPOSITE_ROUTE_TABLE.length === 1);
ok('route is GET viewer', INBOX_THREAD_COMPOSITE_ROUTE_TABLE[0].method === 'GET'
  && INBOX_THREAD_COMPOSITE_ROUTE_TABLE[0].minRole === 'viewer');
ok('sections list', eq(INBOX_THREAD_COMPOSITE_SECTIONS,
  ['detail', 'messages', 'context', 'draft', 'pause_state']));
ok('staff_state is not a section', INBOX_THREAD_COMPOSITE_SECTIONS.indexOf('staff_state') < 0);
ok('RE matches uuid path', INBOX_THREAD_COMPOSITE_RE.test(`/staff/inbox/thread/${CONV_ID}`));
ok('RE rejects non-uuid', !INBOX_THREAD_COMPOSITE_RE.test('/staff/inbox/thread/not-a-uuid'));
ok('RE rejects sub-paths', !INBOX_THREAD_COMPOSITE_RE.test(`/staff/inbox/thread/${CONV_ID}/messages`));
ok('RE does not shadow the inbox deep link', !INBOX_THREAD_COMPOSITE_RE.test('/staff/inbox'));

console.log('\n── no reverse coupling / no duplicated SQL ──');
ok('no require staff-query-api', !/require\s*\(\s*['"][^'"]*staff-query-api['"]\s*\)/.test(modSrc));
ok('requires staff-conversation-queries', /require\('\.\/staff-conversation-queries'\)/.test(modSrc));
ok('requires staff-bot-pause-sql', /require\('\.\/staff-bot-pause-sql'\)/.test(modSrc));
ok('no SELECT ... FROM conversations in module', !/SELECT[\s\S]{0,400}FROM\s+conversations/i.test(modSrc));
ok('does not import the staff-state query', !/getConversationStaffStateQuery/.test(modSrc));
ok('no bot_pause_states SQL in module', !/FROM\s+bot_pause_states/i.test(modSrc));
ok('does not redefine conversation query builders',
  !/function\s+getConversation\w+Query\s*\(/.test(modSrc));
const modNoComments = modSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
ok('module does not call requireAuth', !/\brequireAuth\s*\(/.test(modNoComments));

console.log('\n── staff-query-api wiring ──');
ok('requires the composite module', /require\('\.\/lib\/staff-inbox-thread-composite'\)/.test(apiSrc));
ok('builds routes through the DI factory', /createInboxThreadCompositeRoutes\(\{/.test(apiSrc));
const wiring = apiSrc.slice(
  apiSrc.indexOf('createInboxThreadCompositeRoutes({'),
  apiSrc.indexOf('createInboxThreadCompositeRoutes({') + 900,
);
for (const dep of [
  'assertStaffClientAccess',
  'withPgClient',
  'markPgClientDiscardRequired',
  'resolveSunsetConversationScope',
  'conversationDetailQueryParams',
  'sanitizeConversationContextForInbox',
  'filterActiveInboxBookings',
  'buildPausedStateResponse',
  'buildDefaultActivePauseResponse',
]) {
  ok(`factory is injected ${dep}`, wiring.includes(dep));
}
const dispatch = apiSrc.slice(
  apiSrc.indexOf('const inboxThreadCompositeMatch = INBOX_THREAD_COMPOSITE_RE.exec(pathname);'),
  apiSrc.indexOf('const convSubMatch = CONV_SUB_RE.exec(pathname);'),
);
ok('router matches the composite path', dispatch.length > 0);
ok('router requires viewer auth', /requireAuth\(req, res, 'viewer'\)/.test(dispatch));
ok('router minRole matches the route table',
  /requireAuth\(req, res, '(\w+)'\)/.exec(dispatch)[1] === INBOX_THREAD_COMPOSITE_ROUTE_TABLE[0].minRole);
ok('router dispatches to the module handler', /handleInboxThreadComposite\(/.test(dispatch));
ok('router rejects non-GET', /Allow: 'GET'/.test(dispatch));

console.log('\n── the six endpoints of the old fan-out stay routed ──');
ok('CONV_SUB_RE still covers the four sub-routes',
  /messages\|context\|draft\|staff-state/.test(apiSrc));
for (const handler of [
  'handleConversationDetail(convIdMatch[1]',
  "case 'messages':    return handleConversationMessages(",
  "case 'context':     return handleConversationContext(",
  "case 'draft':       return handleConversationDraft(",
  "case 'staff-state': return handleConversationStaffState(",
]) {
  ok(`still dispatched: ${handler.split('(')[0].trim()}`, apiSrc.includes(handler));
}
ok('/staff/bot/pause-state still routed', apiSrc.includes("pathname === '/staff/bot/pause-state'"));

console.log('\n── browser reads the composite ──');
ok('portal UI fetches the composite endpoint', uiSrc.includes("fetch('/staff/inbox/thread/' + encodeURIComponent(convId) + qs)"));
for (const key of ['composite.detail', 'composite.messages', 'composite.context', 'composite.draft', 'composite.pause_state']) {
  ok(`portal UI reads ${key}`, uiSrc.includes(key));
}
ok('portal UI does not read a staff_state section', !uiSrc.includes('composite.staff_state'));
ok('portal UI no longer fans out to the five conversation sub-fetches',
  !uiSrc.includes("gjson(base + '/staff-state' + qs)"));
ok('thread poll still refetches /messages on its own',
  uiSrc.includes("'/staff/conversations/' + encodeURIComponent(convId) + '/messages' + inboxClientQuery()"));
ok('pause verdict reads the composite pause section, the detail section and the conversation row',
  uiSrc.includes('isLunaGuestAutomationPaused([pauseData, detailData, c])'));
ok('the orphaned fetchBotPauseState helper is gone', !/function\s+fetchBotPauseState\s*\(/.test(uiSrc));

(async () => {
  console.log('\n── payload parity with the endpoints it replaces ──');
  {
    const { body, deps } = await runComposite();
    ok('composite 200', body && body.success === true);
    ok('composite top-level keys', eq(Object.keys(body),
      ['success', 'conversation_id', 'detail', 'messages', 'context', 'draft', 'pause_state', 'elapsed_ms']),
    JSON.stringify(Object.keys(body)));
    ok('conversation_id echoed', body.conversation_id === CONV_ID);

    const keyExpectations = [
      ['detail', 'handleConversationDetail'],
      ['messages', 'handleConversationMessages'],
      ['context', 'handleConversationContext'],
      ['draft', 'handleConversationDraft'],
    ];
    for (const [section, fnName] of keyExpectations) {
      const routeKeys = sendJsonOkKeys(apiSrc, fnName);
      ok(`${fnName} 200 keys readable`, Array.isArray(routeKeys) && routeKeys.length > 0);
      ok(`${section} section carries the ${fnName} fields`,
        routeKeys && eq(routeKeys.slice().sort(), Object.keys(body[section]).sort()),
        `${JSON.stringify(routeKeys)} vs ${JSON.stringify(Object.keys(body[section]))}`);
    }

    ok('detail.conversation is the detail row', eq(body.detail.conversation, DETAIL_ROW));
    ok('messages.messages are projected through projectStaffInboxThreadMessage',
      eq(body.messages.messages, MESSAGE_ROWS.map((r) => projectStaffInboxThreadMessage(r))));
    ok('messages.count matches', body.messages.count === MESSAGE_ROWS.length);
    ok('context.context is the sanitized row', eq(body.context.context, deps.helperResults.context));
    ok('context.bookings are the active-filtered rows', eq(body.context.bookings, deps.helperResults.bookings));
    ok('context drops inactive bookings', body.context.bookings.length === 1);
    ok('draft.draft is the draft row', eq(body.draft.draft, DRAFT_ROW));
    ok('pause_state is the shared builder output', eq(body.pause_state, deps.helperResults.pause));
    ok('pause_state defaults to active', body.pause_state.paused === false && body.pause_state.source === 'default_active');
    ok('pause_state scoped to this conversation', body.pause_state.conversation_id === CONV_ID
      && body.pause_state.client_slug === CLIENT);
    ok('every section reports its own success flag',
      INBOX_THREAD_COMPOSITE_SECTIONS.every((k) => body[k] && body[k].success === true));
  }

  {
    const { body } = await runComposite({ pause: { rows: [{ client_slug: CLIENT, conversation_id: CONV_ID, paused: true }] } });
    ok('paused thread uses buildPausedStateResponse', body.pause_state.paused === true
      && body.pause_state.bot_paused === true);
  }

  console.log('\n── browser consumption of the composite body ──');
  {
    const { body, deps } = await runComposite();
    const results = [body.detail, body.messages, body.context, body.draft, body.pause_state];
    const [detailData, msgsData, ctxData, draftData, pauseData] = results;
    ok('detailData.success gate passes', detailData.success === true && !!detailData.conversation);
    ok('msgs read yields the thread', ((msgsData.success && msgsData.messages) ? msgsData.messages : []).length === 2);
    ok('ctx read yields a context object', !!((ctxData.success && ctxData.context) ? ctxData.context : null));
    ok('bookings read yields active rows',
      ((ctxData.success && ctxData.bookings && ctxData.bookings.length) ? ctxData.bookings : []).length === 1);
    ok('draft read yields the draft', ((draftData.success && draftData.draft) ? draftData.draft : null) !== null);
    ok('pause read is a plain object', !!pauseData && pauseData.success === true);
    // Server-side helper application count — composite route calls each once.
    // Browser-side: loadConvDetail still calls sanitizeConversationContextForInbox and
    // filterActiveInboxBookings on the already-normalized response (lines 1627-1629 of
    // inbox-thread.js). This double-application is idempotent (both helpers are
    // re-entrant on their own output), but REMOVING it requires a real browser-owner
    // regression to prove parity. This assertion proves only the server-side count.
    ok('server applies sanitize/filter helpers exactly once',
      deps.calls.sanitize === 1 && deps.calls.filterBookings === 1);

    // Prove idempotency: double-application of browser helpers yields same result.
    // This justifies not removing client reshaping until a real browser-owner test
    // proves parity (the current mismatch is inert, not buggy).
    const ctxOnce = deps.helperResults.context;
    const ctxTwice = deps.sanitizeConversationContextForInbox(ctxOnce);
    ok('sanitizeConversationContextForInbox is idempotent', eq(ctxOnce, ctxTwice));
    const bookingsOnce = deps.helperResults.bookings;
    const bookingsTwice = deps.filterActiveInboxBookings(bookingsOnce);
    ok('filterActiveInboxBookings is idempotent', eq(bookingsOnce, bookingsTwice));
  }

  console.log('\n── staff-state is not part of the thread read ──');
  {
    const { body, deps } = await runComposite();
    ok('no staff_state section on the body', !('staff_state' in body));
    ok('the staff-state query is never issued',
      !deps.pg.log.some((e) => e.sql === getConversationStaffStateQuery().trim()));
    const dataQueries = deps.pg.log.filter((e) => !/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(e.sql));
    // detail, messages, context, bookings, draft, then the global and
    // per-conversation bot_pause_states lookups. Was 8 with staff-state.
    ok('one thread open costs 7 queries', dataQueries.length === 7, `got ${dataQueries.length}`);

    const isLunaGuestAutomationPaused = shippedPauseHelper();
    const c = body.detail.conversation;
    ok('the pause verdict is active without the staff-state row',
      isLunaGuestAutomationPaused([body.pause_state, body.detail, c]) === false);
    const paused = await runComposite({ pause: { rows: [{ client_slug: CLIENT, conversation_id: CONV_ID, paused: true }] } });
    ok('the pause verdict is paused without the staff-state row',
      isLunaGuestAutomationPaused([
        paused.body.pause_state, paused.body.detail, paused.body.detail.conversation,
      ]) === true);
    ok('a staff-state row could not have moved the verdict either way',
      isLunaGuestAutomationPaused([{
        conversation_id: CONV_ID, needs_human: true, bot_mode: 'human', pending_action: 'awaiting_payment',
        last_staff_reply_at: '2026-08-11T09:00:00Z', handoff_id: 'h-1', handoff_reason: 'payment_inquiry',
        handoff_priority: 'high', handoff_status: 'open', assigned_staff: 'ada',
        handoff_opened_at: '2026-08-11T08:55:00Z', handoff_due_at: '2026-08-11T09:30:00Z',
      }]) === false);
  }
  {
    const unique = staffStateColumns().filter((k) => !DETAIL_COLUMNS.includes(k));
    ok('handoff_due_at is the only staff-state column the detail section does not carry',
      eq(unique, ['handoff_due_at']), JSON.stringify(unique));
    ok('the portal UI never reads handoff_due_at', !uiSrc.includes('handoff_due_at'));
  }

  console.log('\n── auth and client scoping ──');
  {
    const res = mockRes();
    const deps = makeDeps({}, {
      assertStaffClientAccess(user, clientSlug, r) {
        deps.sendJSON(r, 403, { success: false, error: 'client_access_denied', client_slug: clientSlug });
        return false;
      },
    });
    const routes = createInboxThreadCompositeRoutes(deps);
    await routes.handleInboxThreadComposite(CONV_ID, { client: 'someone-else' }, res, { staff_user_id: 'u1', role: 'viewer' });
    const body = parseBody(res.out);
    ok('denied client gets 403', res.out.statusCode === 403 && body.error === 'client_access_denied');
    ok('denied client never touches Postgres', deps.calls.withPgClient === 0);
  }
  {
    const { res, deps } = await runComposite({}, {}, { client: "wolf'; DROP TABLE conversations; --" });
    ok('sql-ish client slug gets 400', res.out.statusCode === 400);
    ok('sql-ish client slug never touches Postgres', deps.calls.withPgClient === 0);
  }
  {
    const { deps } = await runComposite();
    const dataQueries = deps.pg.log.filter((e) => !/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(e.sql));
    ok('every query is tenant-scoped to the requested client',
      dataQueries.length > 0 && dataQueries.every((e) => e.params && e.params[0] === CLIENT));
    ok('every conversation query is bound to the requested id',
      dataQueries.filter((e) => !/bot_pause_states/.test(e.sql)).every((e) => e.params[1] === CONV_ID));
  }
  {
    const { deps, body } = await runComposite({ scoped: true }, {}, { client: 'sunset', location: 'sunset-sardinero' });
    const convQueries = deps.pg.log.filter((e) => /FROM conversations/i.test(e.sql));
    ok('sunset scope adds the location parameter',
      convQueries.length > 0 && convQueries.every((e) => eq(e.params, ['sunset', CONV_ID, 'sunset-sardinero'])));
    ok('sunset scope still returns the composite', body.success === true);
  }

  console.log('\n── not found short-circuits before any other read ──');
  {
    const { res, body, deps } = await runComposite({ detail: { rows: [] } });
    ok('missing conversation 404s', res.out.statusCode === 404);
    ok('404 body matches the detail route', eq(body, { success: false, error: 'Not found' }));
    const dataQueries = deps.pg.log.filter((e) => !/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/i.test(e.sql));
    ok('no messages/context/draft/pause rows are read', dataQueries.length === 1);
    ok('snapshot still closed', deps.pg.log[deps.pg.log.length - 1].sql === 'COMMIT');
  }
  {
    // Foreign tenant and deleted conversation both surface as "no detail row";
    // the responses must be indistinguishable.
    const foreign = await runComposite({ detail: { rows: [] } }, {}, { client: 'sunset', scoped: false });
    const deleted = await runComposite({ detail: { rows: [] } });
    ok('foreign-tenant and deleted 404s are identical',
      foreign.res.out.statusCode === deleted.res.out.statusCode && foreign.res.out.body === deleted.res.out.body);
  }

  console.log('\n── one connection, one snapshot ──');
  {
    const { deps } = await runComposite();
    ok('exactly one pg client acquired', deps.calls.withPgClient === 1);
    ok('opens a repeatable-read read-only snapshot',
      deps.pg.log[0].sql === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    ok('closes the transaction', deps.pg.log[deps.pg.log.length - 1].sql === 'COMMIT');
    ok('all reads happen inside the transaction',
      deps.pg.log.filter((e) => /^(COMMIT|ROLLBACK)$/i.test(e.sql)).length === 1);
    ok('transaction is not left open', deps.pg.state.inTx === false);
  }
  {
    const { res, deps } = await runComposite({ detail: pgError('57014', 'canceling statement') });
    ok('detail failure answers 500', res.out.statusCode === 500);
    ok('detail failure still closes the snapshot',
      deps.pg.state.inTx === false && deps.pg.log.some((e) => /^(COMMIT|ROLLBACK)$/i.test(e.sql)));
  }

  console.log('\n── transaction cleanup uncertainty ──');
  {
    // COMMIT fails but ROLLBACK succeeds: should degrade gracefully but still return 500
    const commitErr = pgError('57P01', 'terminating connection due to administrator command');
    const { res, body, deps } = await runComposite({ commitThrow: commitErr });
    ok('COMMIT failure with successful ROLLBACK answers 500', res.out.statusCode === 500);
    ok('COMMIT failure error body is sanitized', body && body.success === false && body.error === 'query failed');
    ok('COMMIT failure attempted ROLLBACK', deps.pg.log.some((e) => e.sql === 'ROLLBACK'));
    ok('COMMIT failure does not poison client when ROLLBACK succeeds',
      !deps.isPgClientDiscardRequired(deps.pg));
  }
  {
    // COMMIT fails and ROLLBACK also fails: must fail closed and poison the client
    const commitErr = pgError('57P01', 'terminating connection due to administrator command');
    const rollbackErr = pgError('57P01', 'connection lost on ROLLBACK');
    const { res, body, deps } = await runComposite({
      commitThrow: commitErr,
      rollbackThrow: rollbackErr,
    });
    ok('COMMIT+ROLLBACK failure answers 500', res.out.statusCode === 500,
      `expected 500 but got ${res.out.statusCode}`);
    ok('COMMIT+ROLLBACK failure error body is sanitized',
      body && body.success === false && body.error === 'query failed');
    ok('COMMIT+ROLLBACK failure marks client for discard',
      deps.isPgClientDiscardRequired(deps.pg),
      'client should be poisoned when cleanup is uncertain');
    ok('COMMIT+ROLLBACK failure attempted both COMMIT and ROLLBACK',
      deps.pg.log.some((e) => e.sql === 'COMMIT') && deps.pg.log.some((e) => e.sql === 'ROLLBACK'));
  }
  {
    // Normal success path does not poison the client
    const { deps } = await runComposite();
    ok('success path does not poison client', !deps.isPgClientDiscardRequired(deps.pg));
  }

  console.log('\n── per-section degradation ──');
  {
    const { res, body, deps } = await runComposite({ context: pgError('42703', 'column does not exist') });
    ok('a failing context section still answers 200', res.out.statusCode === 200 && body.success === true);
    ok('context section reports failure', eq(body.context, { success: false, error: 'query failed' }));
    ok('the thread still renders', body.detail.success === true && body.messages.messages.length === 2);
    ok('later sections survive the aborted statement',
      body.draft.success === true && body.pause_state.success === true);
    ok('savepoint rewind was issued', deps.pg.log.some((e) => /^ROLLBACK TO SAVEPOINT/i.test(e.sql)));
    ok('snapshot committed once', deps.pg.log.filter((e) => e.sql === 'COMMIT').length === 1);
  }
  {
    const { body } = await runComposite({ messages: pgError('42703', 'boom') });
    ok('a failing messages section degrades alone', eq(body.messages, { success: false, error: 'query failed' })
      && body.detail.success === true && body.context.success === true);
    ok('browser read of a failed messages section is an empty thread',
      ((body.messages.success && body.messages.messages) ? body.messages.messages : []).length === 0);
  }
  {
    const { body } = await runComposite({ draft: { rows: [] } });
    ok('missing draft mirrors the route 404 body', eq(body.draft, { success: false, error: 'Not found' }));
    ok('thread still renders without a draft', body.success === true && body.detail.success === true);
  }
  {
    const { body, res } = await runComposite({ pause: pgError('42P01', 'relation "bot_pause_states" does not exist') });
    ok('missing pause table still answers 200', res.out.statusCode === 200);
    ok('missing pause table degrades to active', body.pause_state.paused === false);
  }
  {
    // getPauseState swallows a "does not exist" error and resolves while the
    // transaction is already aborted; the section must still be usable.
    const { body, res, deps } = await runComposite({
      pauseGlobal: { rows: [] },
      pause: pgError('XX000', 'relation bot_pause_states does not exist'),
    });
    ok('a section that swallows its own error still resolves', res.out.statusCode === 200
      && body.pause_state.success === true);
    ok('swallowed error rewinds to the savepoint', deps.pg.log.some((e) => /^ROLLBACK TO SAVEPOINT/i.test(e.sql)));
    ok('swallowed error reports table_missing', body.pause_state.table_missing === true);
    ok('swallowed error still commits', deps.pg.state.inTx === false);
  }

  console.log('\n── pause-state parity with production owner ──');
  // These tests execute the ACTUAL production builders from staff-inbox-helpers.js and
  // compare the composite response to what the production builder returns directly.
  // This is not source extraction or test-authored recreation — it's production execution.
  {
    // Default active parity: composite response must match production builder output
    const { body } = await runComposite();
    const prodActive = prodBuildDefaultActivePauseResponse({
      client_slug: CLIENT,
      guest_phone: null,
      conversation_id: CONV_ID,
      booking_code: null,
    });
    ok('active pause_state matches production builder',
      body.pause_state.success === prodActive.success &&
      body.pause_state.paused === prodActive.paused &&
      body.pause_state.bot_paused === prodActive.bot_paused &&
      body.pause_state.live_send_blocked === prodActive.live_send_blocked &&
      body.pause_state.source === prodActive.source);
  }
  {
    // Paused state parity: composite response must match production builder output
    const pauseRow = {
      id: 'pause-1',
      client_slug: CLIENT,
      guest_phone: '+34600111222',
      conversation_id: CONV_ID,
      booking_id: null,
      booking_code: null,
      paused: true,
      pause_reason: 'Staff requested',
      paused_by: 'staff-u1',
      paused_at: '2026-08-01T10:00:00Z',
      resumed_by: null,
      resumed_at: null,
      metadata: {},
      created_at: '2026-08-01T10:00:00Z',
      updated_at: '2026-08-01T10:00:00Z',
    };
    const { body } = await runComposite({ pause: { rows: [pauseRow] } });
    const prodPaused = prodBuildPausedStateResponse(pauseRow);
    ok('paused pause_state matches production builder shape',
      body.pause_state.success === prodPaused.success &&
      body.pause_state.paused === prodPaused.paused &&
      body.pause_state.bot_paused === prodPaused.bot_paused &&
      body.pause_state.live_send_blocked === prodPaused.live_send_blocked &&
      body.pause_state.source === prodPaused.source);
    ok('paused pause_state.pause_state matches production formatted row',
      eq(body.pause_state.pause_state, prodPaused.pause_state));
    ok('paused pause_state spreads row fields like production',
      body.pause_state.client_slug === prodPaused.client_slug &&
      body.pause_state.conversation_id === prodPaused.conversation_id &&
      body.pause_state.pause_reason === prodPaused.pause_reason &&
      body.pause_state.paused_by === prodPaused.paused_by);
  }
  {
    // Missing pause table parity: production builder with table_missing flag
    const { body } = await runComposite({
      pauseGlobal: { rows: [] },
      pause: pgError('XX000', 'relation bot_pause_states does not exist'),
    });
    const prodMissing = prodBuildDefaultActivePauseResponse({
      client_slug: CLIENT,
      guest_phone: null,
      conversation_id: CONV_ID,
      booking_code: null,
      table_missing: true,
    });
    ok('table_missing matches production builder shape',
      body.pause_state.paused === prodMissing.paused &&
      body.pause_state.source === prodMissing.source);
    ok('table_missing sets flag like production',
      body.pause_state.table_missing === true);
  }
  {
    // Lookup failure parity: production builder with lookup_error flag
    const { body } = await runComposite({ pause: pgError('57014', 'query cancelled') });
    const prodLookupErr = prodBuildDefaultActivePauseResponse({
      client_slug: CLIENT,
      guest_phone: null,
      conversation_id: CONV_ID,
      booking_code: null,
      lookup_error: true,
    });
    ok('lookup_error matches production builder shape',
      body.pause_state.paused === prodLookupErr.paused &&
      body.pause_state.source === prodLookupErr.source);
    ok('lookup_error sets flag like production',
      body.pause_state.lookup_error === true);
  }

  console.log('\n── production helper mutation-strength regression ──');
  // These tests prove that the verifier would FAIL if someone changed production
  // builder behavior, not merely removed a property name string. This demonstrates
  // genuine production-anchored coverage.
  {
    // If production sanitizeConversationContextForInbox stopped clearing booking_id,
    // the verifier would detect the change.
    const cancelledRow = {
      conversation_id: CONV_ID,
      booking_id: 'bk-cancelled',
      booking_code: 'WH-CANCEL',
      booking_status: 'cancelled',
    };
    const sanitized = prodSanitizeConversationContextForInbox(cancelledRow);
    ok('mutation-strength: sanitize clears booking_id on cancelled',
      sanitized.booking_id === null,
      'production helper must null booking_id for cancelled rows');
    ok('mutation-strength: sanitize clears booking_code on cancelled',
      sanitized.booking_code === null);
    ok('mutation-strength: sanitize clears booking_status on cancelled',
      sanitized.booking_status === null);
    // Confirm active rows are untouched
    const activeRow = { ...cancelledRow, booking_status: 'confirmed' };
    const notSanitized = prodSanitizeConversationContextForInbox(activeRow);
    ok('mutation-strength: sanitize preserves active booking_id',
      notSanitized.booking_id === 'bk-cancelled');
  }
  {
    // If production filterActiveInboxBookings stopped filtering cancelled, verifier detects.
    const mixedRows = [
      { booking_id: 'bk-1', booking_status: 'confirmed' },
      { booking_id: 'bk-2', booking_status: 'cancelled' },
      { booking_id: 'bk-3', booking_status: 'expired' },
      { booking_id: 'bk-4', booking_status: 'pending' },
    ];
    const filtered = prodFilterActiveInboxBookings(mixedRows);
    ok('mutation-strength: filter removes cancelled',
      !filtered.some((b) => b.booking_id === 'bk-2'),
      'production helper must filter cancelled rows');
    ok('mutation-strength: filter removes expired',
      !filtered.some((b) => b.booking_id === 'bk-3'));
    ok('mutation-strength: filter keeps confirmed',
      filtered.some((b) => b.booking_id === 'bk-1'));
    ok('mutation-strength: filter keeps pending',
      filtered.some((b) => b.booking_id === 'bk-4'));
  }
  {
    // If production buildPausedStateResponse changed paused to false, verifier detects.
    const pauseRow = {
      id: 'pause-mut',
      client_slug: CLIENT,
      paused: true,
      pause_reason: 'mutation test',
    };
    const pausedResp = prodBuildPausedStateResponse(pauseRow);
    ok('mutation-strength: paused builder sets paused=true',
      pausedResp.paused === true,
      'production builder must set paused=true');
    ok('mutation-strength: paused builder sets bot_paused=true',
      pausedResp.bot_paused === true);
    ok('mutation-strength: paused builder sets live_send_blocked=true',
      pausedResp.live_send_blocked === true);
    ok('mutation-strength: paused builder source is bot_pause_states',
      pausedResp.source === 'bot_pause_states');
  }
  {
    // If production buildDefaultActivePauseResponse changed paused to true, verifier detects.
    const activeResp = prodBuildDefaultActivePauseResponse({});
    ok('mutation-strength: active builder sets paused=false',
      activeResp.paused === false,
      'production builder must set paused=false');
    ok('mutation-strength: active builder sets bot_paused=false',
      activeResp.bot_paused === false);
    ok('mutation-strength: active builder sets live_send_blocked=false',
      activeResp.live_send_blocked === false);
    ok('mutation-strength: active builder source is default_active',
      activeResp.source === 'default_active');
  }
  {
    // Prove isInactiveInboxBookingStatus correctly identifies each status.
    ok('mutation-strength: cancelled is inactive',
      prodIsInactiveInboxBookingStatus('cancelled') === true);
    ok('mutation-strength: canceled (US spelling) is inactive',
      prodIsInactiveInboxBookingStatus('canceled') === true);
    ok('mutation-strength: expired is inactive',
      prodIsInactiveInboxBookingStatus('expired') === true);
    ok('mutation-strength: confirmed is NOT inactive',
      prodIsInactiveInboxBookingStatus('confirmed') === false);
    ok('mutation-strength: pending is NOT inactive',
      prodIsInactiveInboxBookingStatus('pending') === false);
  }

  console.log('\n── pause-state route-level parity with production handler ──');
  // These tests execute the ACTUAL production /staff/bot/pause-state route handler
  // (handleBotPauseStateGet from staff-bot-pause-state-handler.js) and compare its
  // response with the composite's pause_state section. This proves route orchestration
  // parity, not just builder parity — a regression in route logic (wrong builder
  // selection, missing table_missing/lookup_error propagation, wrong identifier
  // binding) would fail these tests.
  {
    // Create a route-level test harness that executes the production handler.
    function makeRouteTestHarness(plan = {}) {
      const audit = [];
      let pgCalls = 0;
      const routeDeps = {
        sendJSON(res, status, body) {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
          return body;
        },
        send400(res, message) {
          return routeDeps.sendJSON(res, 400, { success: false, error: message });
        },
        appendAuditLog(entry) { audit.push(entry); },
        async withPgClient(fn) {
          pgCalls += 1;
          const pg = makePg({
            pause: plan.pause || { rows: [] },
            pauseGlobal: plan.pauseGlobal || { rows: [] },
          });
          return fn(pg);
        },
        DEFAULT_CLIENT: CLIENT,
        SQL_INJECT_RE: /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i,
      };
      const routes = createBotPauseStateRoutes(routeDeps);
      return { routes, audit, getPgCalls: () => pgCalls };
    }

    async function runRoute(plan = {}, query = {}) {
      const harness = makeRouteTestHarness(plan);
      const res = mockRes();
      await harness.routes.handleBotPauseStateGet(
        { client: CLIENT, conversation_id: CONV_ID, ...query },
        res,
        { staff_user_id: 'u1', role: 'viewer' },
      );
      return { res, body: parseBody(res.out), audit: harness.audit };
    }

    // Shared parity comparator: checks all relevant pause-state response fields.
    // Returns { match: boolean, mismatches: string[] } where mismatches lists
    // every field that differs between route and composite pause_state.
    const PARITY_FIELDS = [
      'success',
      'paused',
      'bot_paused',
      'live_send_blocked',
      'source',
      'client_slug',
      'guest_phone',
      'conversation_id',
      'booking_id',
      'booking_code',
      'pause_reason',
      'paused_by',
      'paused_at',
      'resumed_by',
      'resumed_at',
      'updated_at',
      'table_missing',
      'lookup_error',
    ];

    function comparePauseStateParity(routeBody, compositePauseState, scenario) {
      const mismatches = [];
      for (const field of PARITY_FIELDS) {
        const routeVal = routeBody[field];
        const compositeVal = compositePauseState[field];
        if (routeVal !== compositeVal) {
          mismatches.push(`${field}: route=${JSON.stringify(routeVal)} vs composite=${JSON.stringify(compositeVal)}`);
        }
      }
      // Also compare pause_state nested object if present
      const routePauseState = routeBody.pause_state;
      const compositePauseStateNested = compositePauseState.pause_state;
      if (routePauseState || compositePauseStateNested) {
        if (!eq(routePauseState, compositePauseStateNested)) {
          mismatches.push(`pause_state (nested): route=${JSON.stringify(routePauseState)} vs composite=${JSON.stringify(compositePauseStateNested)}`);
        }
      }
      const match = mismatches.length === 0;
      if (!match) {
        ok(`${scenario}: complete parity`, false, mismatches.join('; '));
      } else {
        ok(`${scenario}: complete parity`, true);
      }
      return { match, mismatches };
    }

    // Default active: route and composite must agree on ALL fields
    {
      const routeResult = await runRoute();
      const { body: compositeBody } = await runComposite();
      ok('route default active HTTP 200', routeResult.res.out.statusCode === 200);
      comparePauseStateParity(routeResult.body, compositeBody.pause_state, 'default active');
    }

    // Paused row: route and composite must agree on ALL fields
    {
      const pauseRow = {
        id: 'pause-route-1',
        client_slug: CLIENT,
        guest_phone: '+34600111222',
        conversation_id: CONV_ID,
        booking_id: 'bk-paused',
        booking_code: 'WH-PAUSED',
        paused: true,
        pause_reason: 'Staff override',
        paused_by: 'staff-u1',
        paused_at: '2026-08-01T10:00:00Z',
        resumed_by: null,
        resumed_at: null,
        metadata: {},
        created_at: '2026-08-01T10:00:00Z',
        updated_at: '2026-08-01T10:05:00Z',
      };
      const routeResult = await runRoute({ pause: { rows: [pauseRow] } });
      const { body: compositeBody } = await runComposite({ pause: { rows: [pauseRow] } });
      ok('route paused HTTP 200', routeResult.res.out.statusCode === 200);
      comparePauseStateParity(routeResult.body, compositeBody.pause_state, 'paused');
    }

    // Missing pause table: route and composite must agree on ALL fields
    {
      const tableErr = pgError('XX000', 'relation bot_pause_states does not exist');
      const routeResult = await runRoute({
        pauseGlobal: { rows: [] },
        pause: tableErr,
      });
      const { body: compositeBody } = await runComposite({
        pauseGlobal: { rows: [] },
        pause: tableErr,
      });
      ok('route table_missing HTTP 200', routeResult.res.out.statusCode === 200);
      comparePauseStateParity(routeResult.body, compositeBody.pause_state, 'table_missing');
    }

    // Lookup failure: route and composite must agree on ALL fields
    {
      const lookupErr = pgError('57014', 'query cancelled');
      const routeResult = await runRoute({ pause: lookupErr });
      const { body: compositeBody } = await runComposite({ pause: lookupErr });
      ok('route lookup_error HTTP 200', routeResult.res.out.statusCode === 200);
      comparePauseStateParity(routeResult.body, compositeBody.pause_state, 'lookup_error');
    }

    // Hostile test: prove that the parity comparator rejects wrong builder output.
    // This instantiates the real createBotPauseStateRoutes factory and executes
    // handleBotPauseStateGet, then constructs what a WRONG builder would produce
    // and verifies the comparator detects the substantive mismatches.
    //
    // NOTE: The production handler imports builders directly (not via DI), so we
    // cannot inject wrong builders through the factory. Instead, we:
    // 1. Run the real handler to get the correct active-state response
    // 2. Construct what a wrong builder (paused builder for active state) would return
    // 3. Pass both through the same comparator to prove it detects mismatches
    console.log('\n── pause-state route orchestration mutation detection ──');
    {
      // Run the real production handler with default-active scenario
      const realRouteResult = await runRoute();
      const realRouteBody = realRouteResult.body;

      // Construct what the WRONG builder (buildPausedStateResponse) would return
      // for this same scenario. This simulates a mutation where the handler
      // incorrectly selects buildPausedStateResponse instead of buildDefaultActivePauseResponse.
      const wrongBuilderOutput = prodBuildPausedStateResponse({
        id: 'mutant-pause',
        client_slug: CLIENT,
        guest_phone: null,
        conversation_id: CONV_ID,
        booking_id: null,
        booking_code: null,
        paused: true,
        pause_reason: 'mutant-wrong-builder',
        paused_by: 'mutant',
        paused_at: '2026-08-01T10:00:00Z',
        resumed_by: null,
        resumed_at: null,
        updated_at: '2026-08-01T10:00:00Z',
      });

      // The real handler returns paused=false, the wrong builder returns paused=true
      ok('hostile: real handler returns active state', realRouteBody.paused === false);
      ok('hostile: wrong builder returns paused state', wrongBuilderOutput.paused === true);

      // Now verify the parity comparator would detect this mismatch
      const wrongMismatches = [];
      for (const field of PARITY_FIELDS) {
        if (wrongBuilderOutput[field] !== realRouteBody[field]) {
          wrongMismatches.push(field);
        }
      }
      ok('hostile: comparator detects paused mismatch',
        wrongMismatches.includes('paused'),
        'paused field must differ between correct and wrong builder');
      ok('hostile: comparator detects source mismatch',
        wrongMismatches.includes('source'),
        'source field must differ (default_active vs bot_pause_states)');
      ok('hostile: comparator detects bot_paused mismatch',
        wrongMismatches.includes('bot_paused'),
        'bot_paused field must differ');
      ok('hostile: comparator detects live_send_blocked mismatch',
        wrongMismatches.includes('live_send_blocked'),
        'live_send_blocked field must differ');
      ok('hostile: comparator detects multiple substantive mismatches',
        wrongMismatches.length >= 4,
        `detected ${wrongMismatches.length} mismatches: ${wrongMismatches.join(', ')}`);
    }
  }

  console.log('\n── audit ──');
  {
    const { deps } = await runComposite();
    const entry = deps.audit[deps.audit.length - 1];
    ok('one audit record for the composite', deps.audit.length === 1);
    ok('audit intent', entry.intent === 'api:conversation.thread-composite');
    ok('audit carries tenant + conversation', entry.client_slug === CLIENT && entry.conversation_id === CONV_ID);
    ok('audit lists the sections that succeeded', eq(entry.sections_ok, INBOX_THREAD_COMPOSITE_SECTIONS.slice()));
  }
  {
    const { deps } = await runComposite({ detail: { rows: [] } });
    ok('not found is audited', deps.audit[0].success === false && deps.audit[0].error === 'not_found');
  }

  console.log(`\n── Summary: ${pass} passed, ${fail} failed ──`);
  if (fail) {
    console.error('\nverify:inbox-thread-composite FAILED');
  } else {
    console.log('\nverify:inbox-thread-composite PASSED');
  }
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nverify:inbox-thread-composite CRASHED', err);
  process.exit(1);
});
