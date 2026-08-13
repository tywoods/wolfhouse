'use strict';

/**
 * verify:inbox-stream-route
 *
 * Offline contract for Inbox Phase 3 live activity:
 *   GET /staff/inbox/stream
 *
 * Proves:
 *   - viewer auth in the router, assertStaffClientAccess in the handler
 *   - Content-Type text/event-stream
 *   - heartbeat + conversation-updated frames, no busy-loop
 *   - client_slug isolation: another tenant's emit never reaches this stream
 *   - denied / hostile client never subscribe and never see event-stream
 *   - in-process EventEmitter only (no Redis, no new table, no Postgres)
 *   - persist of a Hermes inbox row emits conversation-updated
 *   - browser EventSource refetches on conversation-updated and falls back
 *     to the 5s/3s poll timers if the stream errors
 *   - four-column layout, Luna Auto|Off, WhatsApp draft card, saved-view rail
 *     still present
 *
 * No live DB / network / browser.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-inbox-stream-routes.js');
const HUB_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-inbox-live-events.js');
const PERSIST_PATH = path.join(ROOT, 'scripts', 'lib', 'luna-staff-inbox-thread-message.js');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');

const {
  INBOX_STREAM_PATH,
  SSE_CONTENT_TYPE,
  INBOX_STREAM_HEARTBEAT_MS,
  INBOX_STREAM_ROUTE_TABLE,
  formatSseEvent,
  createInboxLiveHub,
  createInboxStreamRoutes,
} = require('./lib/staff-inbox-stream-routes');
const {
  INBOX_LIVE_EVENT_HEARTBEAT,
  INBOX_LIVE_EVENT_CONVERSATION_UPDATED,
  emitInboxConversationUpdated,
  subscribeInboxLive,
} = require('./lib/staff-inbox-live-events');
const { persistHermesLunaInboundThreadMessage } = require('./lib/luna-staff-inbox-thread-message');
const { readStaffPortalUiSource } = require('./lib/staff-portal-ui-source');
const {
  LIST_MODULE,
  STREAM_MODULE,
  COLUMNS_MODULE,
  LUNA_MODE_MODULE,
  VIEWS_MODULE,
  WHATSAPP_DRAFT_MODULE,
  getInboxListBrowserSource,
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

const CLIENT = 'wolfhouse-somo';
const OTHER = 'sunset';
const CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CONV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = Object.freeze({ staff_user_id: 'u1', role: 'viewer' });
const HOSTILE = "wolf'; DROP TABLE conversations; --";
const SQL_INJECT_RE = /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i;

function mockRes() {
  const out = {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    writableEnded: false,
    destroyed: false,
  };
  const res = new EventEmitter();
  res.out = out;
  res.writableEnded = false;
  res.destroyed = false;
  res.writeHead = function writeHead(code, headers) {
    out.statusCode = code;
    if (headers) Object.assign(out.headers, headers);
  };
  res.setHeader = function setHeader(k, v) { out.headers[k] = v; };
  res.write = function write(chunk) {
    out.body += chunk == null ? '' : String(chunk);
    return true;
  };
  res.end = function end(buf) {
    if (buf != null) out.body += String(buf);
    out.ended = true;
    res.writableEnded = true;
    out.writableEnded = true;
  };
  res.flushHeaders = function flushHeaders() { out.flushed = true; };
  return res;
}

function mockReq() {
  return new EventEmitter();
}

function makeDeps(overrides = {}) {
  const audit = [];
  const intervals = [];
  const hub = overrides.inboxLiveHub || createInboxLiveHub();
  const deps = {
    DEFAULT_CLIENT: CLIENT,
    SQL_INJECT_RE,
    audit,
    intervals,
    inboxLiveHub: hub,
    heartbeatMs: overrides.heartbeatMs || INBOX_STREAM_HEARTBEAT_MS,
    now: overrides.now || (() => '2026-08-13T07:00:00.000Z'),
    sendJSON(res, status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return body;
    },
    send400(res, message) {
      return deps.sendJSON(res, 400, { success: false, error: message });
    },
    assertStaffClientAccess(user, clientSlug, res) {
      if (overrides.accessDenied) {
        deps.sendJSON(res, 403, { success: false, error: 'client_access_denied', client_slug: clientSlug });
        return false;
      }
      return true;
    },
    appendAuditLog(entry) { audit.push(entry); },
    setInterval(fn, ms) {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval(id) {
      const idx = Number(id) - 1;
      if (intervals[idx]) intervals[idx].cleared = true;
    },
    ...overrides,
  };
  return deps;
}

function parseBody(out) {
  if (!out.body) return null;
  try { return JSON.parse(out.body); } catch (_) { return out.body; }
}

function sseEvents(body) {
  const frames = String(body || '').split('\n\n').filter(Boolean);
  return frames.map((frame) => {
    const event = (frame.match(/^event: (.+)$/m) || [])[1] || null;
    const dataLine = (frame.match(/^data: (.+)$/m) || [])[1];
    let data = null;
    if (dataLine) {
      try { data = JSON.parse(dataLine); } catch (_err) { data = dataLine; }
    }
    return { event, data, raw: frame };
  });
}

async function openStream(overrides = {}, query = { client: CLIENT }) {
  const deps = overrides.deps || makeDeps(overrides);
  const routes = createInboxStreamRoutes(deps);
  const req = overrides.req || mockReq();
  const res = overrides.res || mockRes();
  const pending = routes.handleInboxStream(req, query, res, overrides.user === undefined ? USER : overrides.user);
  return { deps, routes, req, res, pending };
}

const modSrc = fs.readFileSync(MODULE_PATH, 'utf8');
const hubSrc = fs.readFileSync(HUB_PATH, 'utf8');
const persistSrc = fs.readFileSync(PERSIST_PATH, 'utf8');
const apiSrc = fs.readFileSync(API_PATH, 'utf8');
const uiSrc = readStaffPortalUiSource();
const listSrc = fs.readFileSync(LIST_MODULE, 'utf8');
const streamSrc = fs.readFileSync(STREAM_MODULE, 'utf8');
const columnsSrc = fs.readFileSync(COLUMNS_MODULE, 'utf8');
const lunaSrc = fs.readFileSync(LUNA_MODE_MODULE, 'utf8');
const viewsSrc = fs.readFileSync(VIEWS_MODULE, 'utf8');
const draftSrc = fs.readFileSync(WHATSAPP_DRAFT_MODULE, 'utf8');

console.log('verify:inbox-stream-route');

console.log('\n── route table ──');
ok('path is GET /staff/inbox/stream', INBOX_STREAM_PATH === '/staff/inbox/stream');
ok('route table is one GET viewer row', INBOX_STREAM_ROUTE_TABLE.length === 1
  && INBOX_STREAM_ROUTE_TABLE[0].method === 'GET'
  && INBOX_STREAM_ROUTE_TABLE[0].path === INBOX_STREAM_PATH
  && INBOX_STREAM_ROUTE_TABLE[0].minRole === 'viewer');
ok('content type is text/event-stream', SSE_CONTENT_TYPE === 'text/event-stream');
ok('heartbeat is at least 10s (not a busy-loop)', INBOX_STREAM_HEARTBEAT_MS >= 10000);
ok('formatSseEvent writes named event + data', formatSseEvent('heartbeat', { ok: true }) === 'event: heartbeat\ndata: {"ok":true}\n\n');

console.log('\n── module isolation ──');
ok('does not require staff-query-api', !/require\s*\(\s*['"][^'"]*staff-query-api['"]\s*\)/.test(modSrc));
ok('does not call requireAuth', !/\brequireAuth\s*\(/.test(modSrc));
ok('calls assertStaffClientAccess', /assertStaffClientAccess\(/.test(modSrc));
ok('does not query Postgres', !/withPgClient/.test(modSrc) && !/\.query\(/.test(modSrc));
ok('does not require redis', !/require\s*\(\s*['"][^'"]*redis/i.test(modSrc + hubSrc));
ok('does not mention a new table', !/CREATE TABLE/i.test(modSrc + hubSrc));
ok('hub is an EventEmitter', /require\('events'\)/.test(hubSrc) && /EventEmitter/.test(hubSrc));
ok('events are namespaced by client_slug', /inbox:\$\{/.test(hubSrc) || /inbox:/.test(hubSrc));

console.log('\n── staff-query-api wiring ──');
ok('requires the stream-routes module', /require\('\.\/lib\/staff-inbox-stream-routes'\)/.test(apiSrc));
ok('builds routes through the DI factory', /createInboxStreamRoutes\(\{/.test(apiSrc));
const wiring = apiSrc.slice(
  apiSrc.indexOf('createInboxStreamRoutes({'),
  apiSrc.indexOf('createInboxStreamRoutes({') + 450,
);
for (const dep of ['sendJSON', 'send400', 'assertStaffClientAccess', 'DEFAULT_CLIENT', 'SQL_INJECT_RE']) {
  ok(`factory is injected ${dep}`, wiring.includes(dep));
}
ok('factory is not injected withPgClient', !/withPgClient/.test(wiring));
const dispatchStart = apiSrc.indexOf('if (pathname === INBOX_STREAM_PATH)');
ok('router matches the stream path', dispatchStart > 0);
const dispatch = apiSrc.slice(dispatchStart, dispatchStart + 700);
ok('router requires viewer auth', /requireAuth\(req, res, 'viewer'\)/.test(dispatch));
ok('router minRole matches the route table', INBOX_STREAM_ROUTE_TABLE.every((r) => r.minRole === 'viewer'));
ok('router authenticates before dispatching',
  dispatch.indexOf("requireAuth(req, res, 'viewer')") < dispatch.indexOf('handleInboxStream('));
ok('router rejects non-GET', /Allow: 'GET'/.test(dispatch));
ok('router passes req into the handler', /handleInboxStream\(req, parsed\.query, res, auth\.user\)/.test(dispatch));
ok('views and list stay routed', apiSrc.includes('pathname === INBOX_VIEWS_PATH || pathname === INBOX_LIST_PATH'));

console.log('\n── auth + client scope ──');
(async () => {
  {
    const { res, req, pending } = await openStream({ accessDenied: true });
    const body = parseBody(res.out);
    ok('denied client 403', res.out.statusCode === 403 && body && body.error === 'client_access_denied');
    ok('denied client is JSON, not event-stream', res.out.headers['Content-Type'] === 'application/json');
    ok('denied client body has no SSE frames', !/event: /.test(res.out.body));
    req.emit('close');
    if (pending && typeof pending.then === 'function') await pending;
  }
  {
    const { res, req, pending, deps } = await openStream({}, { client: HOSTILE });
    const body = parseBody(res.out);
    ok('hostile client 400 before subscribe', res.out.statusCode === 400 && body && body.error === 'invalid client slug');
    ok('hostile client never gets event-stream', res.out.headers['Content-Type'] !== SSE_CONTENT_TYPE);
    ok('hostile client does not audit a stream subscribe', deps.audit.length === 0);
    req.emit('close');
    if (pending && typeof pending.then === 'function') await pending;
  }

  console.log('\n── SSE stream ──');
  {
    const { res, req, pending, deps } = await openStream();
    ok('stream 200', res.out.statusCode === 200);
    ok('Content-Type text/event-stream', res.out.headers['Content-Type'] === SSE_CONTENT_TYPE);
    ok('Cache-Control no-cache', /no-cache/.test(res.out.headers['Cache-Control'] || ''));
    const events = sseEvents(res.out.body);
    const heartbeats = events.filter((e) => e.event === INBOX_LIVE_EVENT_HEARTBEAT);
    ok('opens with a heartbeat', heartbeats.length >= 1);
    ok('heartbeat carries this client only', heartbeats.every((e) => e.data && e.data.client_slug === CLIENT));
    ok('heartbeat has no conversation payload', heartbeats.every((e) => !e.data.conversation_id));
    ok('audits one subscribe, not each heartbeat', deps.audit.length === 1 && deps.audit[0].intent === 'api:inbox.stream');
    ok('heartbeat interval is the declared ms', deps.intervals[0] && deps.intervals[0].ms === INBOX_STREAM_HEARTBEAT_MS);

    const before = res.out.body;
    deps.inboxLiveHub.emitInboxConversationUpdated(CLIENT, CONV);
    ok('conversation-updated is written on emit', res.out.body.length > before.length);
    const updated = sseEvents(res.out.body).filter((e) => e.event === INBOX_LIVE_EVENT_CONVERSATION_UPDATED);
    ok('conversation-updated names the conversation', updated.length === 1
      && updated[0].data.conversation_id === CONV
      && updated[0].data.client_slug === CLIENT);
    ok('conversation-updated does not carry message text', updated.every((e) => e.data.message_text == null));

    const afterOwn = res.out.body;
    deps.inboxLiveHub.emitInboxConversationUpdated(OTHER, OTHER_CONV);
    ok('other client emit does not leak onto this stream', res.out.body === afterOwn);
    ok('other client conversation id absent', !res.out.body.includes(OTHER_CONV) && !res.out.body.includes(`"${OTHER}"`));

    const beforeTick = res.out.body;
    deps.intervals[0].fn();
    ok('interval tick writes another heartbeat, not a refetch payload',
      res.out.body.length > beforeTick.length
      && sseEvents(res.out.body.slice(beforeTick.length)).every((e) => e.event === INBOX_LIVE_EVENT_HEARTBEAT));

    req.emit('close');
    await pending;
    ok('close unsubscribes', deps.inboxLiveHub.subscriberCount(CLIENT) === 0);
    ok('close clears the heartbeat timer', deps.intervals[0].cleared === true);
    const afterClose = res.out.body;
    deps.inboxLiveHub.emitInboxConversationUpdated(CLIENT, CONV);
    ok('emit after close does not write', res.out.body === afterClose);
  }

  console.log('\n── persist write-path hook ──');
  ok('persist requires the live hub', /require\('\.\/staff-inbox-live-events'\)/.test(persistSrc));
  ok('persist wraps exports with live notify', /withInboxLiveNotify\(persistHermesLunaInboundThreadMessage\)/.test(persistSrc));
  {
    const received = [];
    const unsub = subscribeInboxLive(CLIENT, (payload) => received.push(payload));
    const otherReceived = [];
    const unsubOther = subscribeInboxLive(OTHER, (payload) => otherReceived.push(payload));
    const pg = {
      async query(sql, params) {
        const s = String(sql);
        if (/INSERT INTO messages/.test(s)) {
          return {
            rows: [{
              message_id: 'msg-1',
              whatsapp_message_id: params[4],
              source: params[3],
              direction: 'inbound',
            }],
          };
        }
        if (/SELECT conv\.id, conv\.client_id/.test(s)) {
          return { rows: [{ id: CONV, client_id: 'cid-wh' }] };
        }
        if (/FROM messages m/.test(s) || /whatsapp_message_id/.test(s)) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const result = await persistHermesLunaInboundThreadMessage(pg, {
      client_slug: CLIENT,
      conversation_id: CONV,
      message_text: 'hola',
      whatsapp_message_id: 'wamid.SSE1',
    });
    ok('persist still returns persisted:true', result && result.persisted === true);
    ok('persist emit reaches the same-tenant subscriber', received.length === 1
      && received[0].conversation_id === CONV
      && received[0].client_slug === CLIENT);
    ok('persist emit does not reach the other tenant', otherReceived.length === 0);
    unsub();
    unsubOther();
    emitInboxConversationUpdated(CLIENT, CONV);
    ok('unsubscribed persist listener is silent', received.length === 1);
  }

  console.log('\n── browser EventSource + poll fallback ──');
  ok('list keeps 5s/3s poll constants', /INBOX_LIST_POLL_MS\s*=\s*5000/.test(listSrc)
    && /INBOX_THREAD_POLL_MS\s*=\s*3000/.test(listSrc));
  ok('list still exposes start/stop live polling', /function startInboxLivePolling/.test(listSrc)
    && /function stopInboxLivePolling/.test(listSrc)
    && /function startInboxPollTimers/.test(listSrc));
  ok('stream module uses EventSource on /staff/inbox/stream',
    /new EventSource\(inboxStreamUrl\(\)\)/.test(streamSrc)
    && /\/staff\/inbox\/stream/.test(streamSrc));
  ok('stream refetches list+thread on conversation-updated',
    /addEventListener\('conversation-updated'/.test(streamSrc)
    && /pollInboxConversationListLive\(\)/.test(streamSrc)
    && /pollInboxSelectedThreadLive\(\)/.test(streamSrc));
  ok('heartbeat does not refetch',
    /addEventListener\('heartbeat'/.test(streamSrc)
    && /function onInboxStreamHeartbeat/.test(streamSrc)
    && !/function onInboxStreamHeartbeat[\s\S]*pollInbox/.test(streamSrc));
  ok('onerror closes EventSource and starts poll timers',
    /fallbackInboxLiveToPolling/.test(streamSrc)
    && /inboxEventSource\.close/.test(streamSrc)
    && /startInboxPollTimers\(\)/.test(streamSrc));
  ok('no EventSource reconnect interval',
    !/setInterval\([^\)]*EventSource/.test(streamSrc)
    && !/setInterval\([^\)]*startInboxEventSource/.test(streamSrc));
  ok('injected list source includes the stream module',
    getInboxListBrowserSource().includes('new EventSource(inboxStreamUrl())'));

  {
    const intervals = [];
    const liveNode = { textContent: '', classList: { add() {}, remove() {} } };
    function FakeES(url) {
      this.url = url;
      this.listeners = {};
      this.closed = false;
      this.addEventListener = function addEventListener(name, fn) { this.listeners[name] = fn; };
      this.close = function close() { this.closed = true; FakeES.closedCount += 1; };
      FakeES.instances.push(this);
    }
    FakeES.instances = [];
    FakeES.closedCount = 0;
    const sandbox = {
      EventSource: FakeES,
      selectedConvId: CONV,
      inboxFilter: 'all',
      inboxConversationsCache: null,
      inboxClientQuery() { return '?client=wolfhouse-somo'; },
      el(id) {
        if (id === 'tab-conversations') {
          return { classList: { contains(name) { return name === 'active'; } } };
        }
        if (id === 'inbox-live-status') return liveNode;
        return null;
      },
      setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
      clearInterval() {},
      setTimeout(fn) { fn(); return 1; },
      clearTimeout() {},
      fetch() { return Promise.reject(new Error('no network')); },
      document: { querySelectorAll() { return []; } },
      console,
    };
    vm.runInNewContext(listSrc + '\n' + streamSrc, sandbox);
    sandbox.startInboxLivePolling();
    ok('EventSource connects instead of starting poll timers', FakeES.instances.length === 1
      && FakeES.instances[0].url === '/staff/inbox/stream?client=wolfhouse-somo'
      && intervals.length === 0);
    FakeES.instances[0].onerror();
    ok('stream error falls back to 5s and 3s timers', intervals.length === 2
      && intervals.some((t) => t.ms === 5000)
      && intervals.some((t) => t.ms === 3000));
    ok('stream error closes EventSource', FakeES.instances[0].closed === true);
    const beforeSecond = FakeES.instances.length;
    sandbox.startInboxLivePolling();
    ok('after error, live start is a no-op while still active (no EventSource loop)',
      FakeES.instances.length === beforeSecond);
    sandbox.stopInboxLivePolling();
    sandbox.startInboxLivePolling();
    ok('leaving the tab lets the next visit retry EventSource', FakeES.instances.length === beforeSecond + 1);
  }

  console.log('\n── existing Inbox UI still present ──');
  ok('four-column layout module still sets data-col attributes',
    /data-col1/.test(columnsSrc) && /data-col2/.test(columnsSrc) && /data-col4/.test(columnsSrc));
  ok('Luna Auto|Off control still in the thread header module',
    /inboxLunaModeOptions/.test(lunaSrc) && /'auto'/.test(lunaSrc) && /'off'/.test(lunaSrc));
  ok('WhatsApp draft card still loads GET draft + approve-send',
    /\/staff\/inbox\/whatsapp\/draft/.test(draftSrc)
    && /\/staff\/inbox\/whatsapp\/approve-send/.test(draftSrc));
  ok('saved-view rail still fetches /staff/inbox/views and /staff/inbox/list',
    /\/staff\/inbox\/views/.test(viewsSrc) && /\/staff\/inbox\/list/.test(viewsSrc));
  ok('portal UI source still has the poll fallback constants',
    /INBOX_LIST_POLL_MS\s*=\s*5000/.test(uiSrc) && /INBOX_THREAD_POLL_MS\s*=\s*3000/.test(uiSrc));
  ok('portal UI source has EventSource live stream', /EventSource/.test(uiSrc) && /\/staff\/inbox\/stream/.test(uiSrc));

  console.log('\n── factory fail-closed ──');
  try {
    createInboxStreamRoutes({ sendJSON() {}, send400() {} });
    ok('missing assertStaffClientAccess throws', false);
  } catch (err) {
    ok('missing assertStaffClientAccess throws', /assertStaffClientAccess/.test(err.message));
  }

  console.log(`\n── ${fail === 0 ? 'PASSED' : 'FAILED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
