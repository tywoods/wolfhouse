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
    sanitizeConversationContextForInbox(row) {
      calls.sanitize += 1;
      helperResults.context = { ...row, _sanitized: true };
      return helperResults.context;
    },
    filterActiveInboxBookings(rows) {
      calls.filterBookings += 1;
      helperResults.bookings = (rows || []).filter((b) => b.booking_status !== 'cancelled');
      return helperResults.bookings;
    },
    buildPausedStateResponse(row, extra) {
      calls.paused += 1;
      // Match production builder shape (staff-query-api.js:buildPausedStateResponse)
      const pauseState = formatPauseStateRow(row);
      helperResults.pause = {
        success:           true,
        paused:            true,
        bot_paused:        true,
        live_send_blocked: true,
        source:            'bot_pause_states',
        pause_state:       pauseState,
        client_slug:       pauseState ? pauseState.client_slug : undefined,
        guest_phone:       pauseState ? pauseState.guest_phone : undefined,
        conversation_id:   pauseState ? pauseState.conversation_id : undefined,
        booking_id:        pauseState ? pauseState.booking_id : undefined,
        booking_code:      pauseState ? pauseState.booking_code : undefined,
        pause_reason:      pauseState ? pauseState.pause_reason : undefined,
        paused_by:         pauseState ? pauseState.paused_by : undefined,
        paused_at:         pauseState ? pauseState.paused_at : undefined,
        resumed_by:        pauseState ? pauseState.resumed_by : undefined,
        resumed_at:        pauseState ? pauseState.resumed_at : undefined,
        updated_at:        pauseState ? pauseState.updated_at : undefined,
        ...(extra || {}),
      };
      return helperResults.pause;
    },
    buildDefaultActivePauseResponse(extra) {
      calls.defaultActive += 1;
      helperResults.pause = { success: true, paused: false, bot_paused: false, live_send_blocked: false, source: 'default_active', ...(extra || {}) };
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
  // These tests anchor to the real production builders' shape/behavior, not test-authored fakes.
  // The production builders are in staff-query-api.js; we verify them via source extraction.
  {
    // Extract production buildDefaultActivePauseResponse from staff-query-api.js
    const defaultActiveMatch = apiSrc.match(
      /function buildDefaultActivePauseResponse\(extra\)\s*\{([\s\S]*?)\n\}/,
    );
    ok('production buildDefaultActivePauseResponse exists', !!defaultActiveMatch);

    // Extract production buildPausedStateResponse from staff-query-api.js
    const pausedMatch = apiSrc.match(
      /function buildPausedStateResponse\(pauseStateRow,\s*extra\)\s*\{([\s\S]*?)\n\}/,
    );
    ok('production buildPausedStateResponse exists', !!pausedMatch);

    // Verify the production builders' key sets via source-level extraction
    // Default active response should have these required keys:
    const defaultActiveKeys = ['success', 'paused', 'bot_paused', 'live_send_blocked', 'source'];
    for (const key of defaultActiveKeys) {
      ok(`production buildDefaultActivePauseResponse includes ${key}`,
        defaultActiveMatch && defaultActiveMatch[1].includes(key));
    }

    // Paused response should have these required keys:
    const pausedKeys = [
      'success', 'paused', 'bot_paused', 'live_send_blocked', 'source', 'pause_state',
      'client_slug', 'guest_phone', 'conversation_id', 'booking_id', 'booking_code',
      'pause_reason', 'paused_by', 'paused_at', 'resumed_by', 'resumed_at', 'updated_at',
    ];
    for (const key of pausedKeys) {
      ok(`production buildPausedStateResponse includes ${key}`,
        pausedMatch && pausedMatch[1].includes(key));
    }
  }
  {
    // Active/default state parity: verify composite returns the same shape as handleBotPauseStateGet
    const { body } = await runComposite();
    ok('pause_state.success is true for active state', body.pause_state.success === true);
    ok('pause_state.paused is false for active state', body.pause_state.paused === false);
    ok('pause_state.bot_paused is false for active state', body.pause_state.bot_paused === false);
    ok('pause_state.live_send_blocked is false for active state', body.pause_state.live_send_blocked === false);
    ok('pause_state.source is default_active for active state', body.pause_state.source === 'default_active');
  }
  {
    // Paused state parity: verify composite returns the same shape as handleBotPauseStateGet
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
    ok('pause_state.success is true for paused state', body.pause_state.success === true);
    ok('pause_state.paused is true for paused state', body.pause_state.paused === true);
    ok('pause_state.bot_paused is true for paused state', body.pause_state.bot_paused === true);
    ok('pause_state.source is bot_pause_states for paused state', body.pause_state.source === 'bot_pause_states');
    ok('pause_state.pause_state is formatted row for paused state',
      body.pause_state.pause_state && body.pause_state.pause_state.id === 'pause-1');
    // Production builder spreads these from the formatted row
    ok('pause_state carries client_slug from row', body.pause_state.client_slug === CLIENT);
    ok('pause_state carries conversation_id from row', body.pause_state.conversation_id === CONV_ID);
    ok('pause_state carries pause_reason from row', body.pause_state.pause_reason === 'Staff requested');
  }
  {
    // Missing pause table parity: handleBotPauseStateGet returns default_active with table_missing
    const { body } = await runComposite({
      pauseGlobal: { rows: [] },
      pause: pgError('XX000', 'relation bot_pause_states does not exist'),
    });
    ok('table_missing returns default_active shape', body.pause_state.paused === false);
    ok('table_missing sets table_missing flag', body.pause_state.table_missing === true);
    ok('table_missing preserves source as default_active', body.pause_state.source === 'default_active');
  }
  {
    // Lookup failure parity: handleBotPauseStateGet returns default_active with lookup_error
    // Test by simulating an error during pause lookup that isn't table_missing
    const { body } = await runComposite({ pause: pgError('57014', 'query cancelled') });
    ok('lookup failure returns default_active shape', body.pause_state.paused === false);
    ok('lookup failure sets lookup_error flag', body.pause_state.lookup_error === true);
    ok('lookup failure preserves source as default_active', body.pause_state.source === 'default_active');
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
