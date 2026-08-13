'use strict';

/**
 * verify:inbox-view-routes
 *
 * Contract harness for the saved-view rail reads:
 *   GET /staff/inbox/views
 *   GET /staff/inbox/list?view=&q=&cursor=
 *
 * Proves:
 *   - createInboxViewRoutes DI factory + route table (GET, viewer) and that the
 *     staff-query-api requireAuth minRole matches the table entry for entry
 *   - /staff/conversations and /staff/customers stay routed and unchanged
 *   - the rail costs two aggregate queries per load whatever the view count is,
 *     one shared scan per source, and zero while the TTL cache is warm
 *   - every view's rows and counts are tenant-scoped, location-scoped on a surf
 *     school, and carry the tenant only as a bound parameter
 *   - a denied or SQL-ish client slug answers before Postgres is touched
 *   - unavailable views are absent from the rail and rejected by the list, and
 *     unknown ids are rejected explicitly — neither reaches Postgres
 *   - paging is keyset over the view's own ORDER BY tuple, ending in a unique
 *     tiebreaker, with no OFFSET; an insert or delete mid-scroll neither repeats
 *     nor skips a person, where OFFSET paging does both
 *
 * The paging simulation derives its comparator from the ORDER BY text of the
 * generated SQL (direction and NULLS placement per term) rather than restating
 * the sort here, so a change to the real sort moves the simulation with it.
 *
 * No live DB / network / browser.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-inbox-view-routes.js');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const REGISTRY_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-inbox-saved-views.js');

const {
  INBOX_VIEWS_PATH,
  INBOX_LIST_PATH,
  INBOX_VIEW_ROUTE_TABLE,
  INBOX_LIST_DEFAULT_LIMIT,
  INBOX_LIST_MAX_LIMIT,
  INBOX_PERSON_ROW_FIELDS,
  CURSOR_FIELDS_BY_SOURCE,
  ERROR_INVALID_CURSOR,
  encodeInboxListCursor,
  decodeInboxListCursor,
  resolveInboxListLimit,
  createInboxViewRoutes,
} = require('./lib/staff-inbox-view-routes');
const {
  INBOX_VIEW_GROUP_IDS,
  INBOX_VIEW_SOURCES,
  ERROR_UNKNOWN_VIEW,
  ERROR_VIEW_UNAVAILABLE,
  listInboxSavedViews,
  listInboxSavedViewDeclarations,
  buildInboxViewQuery,
  buildInboxViewCountsPlan,
} = require('./lib/staff-inbox-saved-views');
const { getCustomerListQuery } = require('./lib/staff-customer-queries');
const { getConversationInboxQuery } = require('./lib/staff-conversation-queries');

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

const CLIENT = 'wolfhouse-somo';
const SURF_CLIENT = 'sunset';
const HOSTILE_CLIENT = "wolf'; DROP TABLE customers; --";
const USER = Object.freeze({ staff_user_id: 'u1', role: 'viewer' });

const AVAILABLE = listInboxSavedViews();
const DECLARATIONS = listInboxSavedViewDeclarations();
const UNAVAILABLE = DECLARATIONS.filter((v) => !v.available);

const COUNTS_RE = /COUNT\(\*\) FILTER/;
const COUNT_ALIAS_RE = /::int AS "([a-z_0-9]+)"/g;

/** Counts row keyed by the aliases the pass actually asked for. */
function cannedCountsRow(sql) {
  const row = {};
  let n = 1;
  COUNT_ALIAS_RE.lastIndex = 0;
  let m = COUNT_ALIAS_RE.exec(sql);
  while (m) {
    row[m[1]] = n;
    n += 1;
    m = COUNT_ALIAS_RE.exec(sql);
  }
  return row;
}

function makeDeps(overrides = {}, listRows = []) {
  const audit = [];
  const calls = { withPgClient: 0 };
  const log = [];

  const deps = {
    DEFAULT_CLIENT: CLIENT,
    SQL_INJECT_RE: /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i,
    audit,
    calls,
    log,
    sendJSON(res, status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return body;
    },
    send400(res, message) {
      return deps.sendJSON(res, 400, { success: false, error: message });
    },
    assertStaffClientAccess() { return true; },
    appendAuditLog(entry) { audit.push(entry); },
    async withPgClient(fn) {
      calls.withPgClient += 1;
      return fn({
        async query(sql, params) {
          log.push({ sql: String(sql), params });
          if (COUNTS_RE.test(String(sql))) return { rows: [cannedCountsRow(String(sql))] };
          return { rows: listRows.slice() };
        },
      });
    },
    ...overrides,
  };
  return deps;
}

async function runViews(query = {}, overrides = {}, routes = null) {
  const deps = overrides.deps || makeDeps(overrides);
  const built = routes || createInboxViewRoutes(deps);
  const res = mockRes();
  await built.handleInboxViews({ client: CLIENT, ...query }, res, USER);
  return { deps, res, routes: built, body: parseBody(res.out) };
}

async function runList(query = {}, overrides = {}, listRows = []) {
  const deps = overrides.deps || makeDeps(overrides, listRows);
  const routes = createInboxViewRoutes(deps);
  const res = mockRes();
  await routes.handleInboxList({ client: CLIENT, ...query }, res, USER);
  return { deps, res, routes, body: parseBody(res.out) };
}

// ── SQL shape readers ───────────────────────────────────────────────────────

function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === sep && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function norm(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/** ORDER BY terms of the outer query: expression text, direction, NULLS placement. */
function orderByTerms(sql) {
  const start = sql.lastIndexOf('ORDER BY');
  if (start < 0) return [];
  const limit = sql.indexOf('LIMIT', start);
  const block = sql.slice(start + 'ORDER BY'.length, limit < 0 ? sql.length : limit);
  return splitTopLevel(block, ',').map((raw) => {
    const desc = /\bDESC\b/i.test(raw);
    const nullsLast = /NULLS\s+LAST/i.test(raw);
    const expr = norm(raw.replace(/\bNULLS\s+(LAST|FIRST)\b/i, '').replace(/\b(ASC|DESC)\b\s*$/i, ''));
    return { expr, desc, nullsLast };
  });
}

/** Comparator for the total order the SQL asks Postgres for. */
function comparatorFor(terms, fields) {
  function base(a, b) {
    if (typeof a === 'boolean' || typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const sa = String(a);
    const sb = String(b);
    if (/^\d{4}-\d{2}-\d{2}T/.test(sa) && /^\d{4}-\d{2}-\d{2}T/.test(sb)) {
      return Date.parse(sa) - Date.parse(sb);
    }
    return sa < sb ? -1 : (sa > sb ? 1 : 0);
  }
  return function compare(rowA, rowB) {
    for (let i = 0; i < terms.length; i += 1) {
      const term = terms[i];
      const a = rowA[fields[i]];
      const b = rowB[fields[i]];
      const aNull = a === null || a === undefined;
      const bNull = b === null || b === undefined;
      if (aNull && bNull) continue;
      if (aNull || bNull) return (aNull ? 1 : -1) * (term.nullsLast ? 1 : -1);
      const c = base(a, b);
      if (c !== 0) return term.desc ? -c : c;
    }
    return 0;
  };
}

/**
 * The keyset predicate, read as the text the cursor adds to the unpaged query,
 * so the harness never has to guess where the clause starts.
 */
function cursorClause(base, paged) {
  let head = 0;
  while (head < base.length && base[head] === paged[head]) head += 1;
  let tail = 0;
  while (tail < base.length - head
    && base[base.length - 1 - tail] === paged[paged.length - 1 - tail]) tail += 1;
  return norm(paged.slice(head, paged.length - tail));
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** Ties on every non-unique term, plus NULLs, so the tiebreaker has to work. */
const CUSTOMER_FIXTURE = Object.freeze([
  { phone: '+34600000001', last_contact_at: '2026-08-10T10:00:00.000Z', is_booked: true },
  { phone: '+34600000002', last_contact_at: '2026-08-10T10:00:00.000Z', is_booked: true },
  { phone: '+34600000003', last_contact_at: '2026-08-09T10:00:00.000Z', is_booked: true },
  { phone: '+34600000004', last_contact_at: null, is_booked: true },
  { phone: '+34600000005', last_contact_at: null, is_booked: true },
  { phone: '+34600000006', last_contact_at: '2026-08-11T10:00:00.000Z', is_booked: false },
  { phone: '+34600000007', last_contact_at: '2026-08-08T10:00:00.000Z', is_booked: false },
  { phone: '+34600000008', last_contact_at: null, is_booked: false },
].map((r) => Object.freeze({ ...r, display_name: `P${r.phone.slice(-1)}`, booking_count: r.is_booked ? 1 : 0 })));

const CONVERSATION_FIXTURE = Object.freeze([
  { conversation_id: 'c1', last_activity: '2026-08-10T10:00:00.000Z', needs_human: true, handoff_priority_rank: 0 },
  { conversation_id: 'c2', last_activity: '2026-08-10T10:00:00.000Z', needs_human: true, handoff_priority_rank: 0 },
  { conversation_id: 'c3', last_activity: '2026-08-09T10:00:00.000Z', needs_human: true, handoff_priority_rank: 2 },
  { conversation_id: 'c4', last_activity: '2026-08-12T10:00:00.000Z', needs_human: false, handoff_priority_rank: 4 },
  { conversation_id: 'c5', last_activity: '2026-08-11T10:00:00.000Z', needs_human: false, handoff_priority_rank: 4 },
  { conversation_id: 'c6', last_activity: '2026-08-08T10:00:00.000Z', needs_human: false, handoff_priority_rank: 4 },
].map((r) => Object.freeze({ ...r, phone: `+3461000000${r.conversation_id.slice(1)}`, guest_name: r.conversation_id })));

const PAGING_CASES = Object.freeze([
  {
    view: 'all_people',
    source: INBOX_VIEW_SOURCES.CUSTOMERS,
    tiebreaker: 'cu.phone',
    fixture: CUSTOMER_FIXTURE,
    inserted: { phone: '+34600000000', last_contact_at: '2026-08-12T23:00:00.000Z', is_booked: true, display_name: 'New', booking_count: 1 },
  },
  {
    view: 'whatsapp',
    source: INBOX_VIEW_SOURCES.CONVERSATIONS,
    tiebreaker: 'conv.id',
    fixture: CONVERSATION_FIXTURE,
    inserted: { conversation_id: 'c0', last_activity: '2026-08-12T23:00:00.000Z', needs_human: true, handoff_priority_rank: 0, phone: '+34610000000', guest_name: 'c0' },
  },
]);

console.log('verify:inbox-view-routes\n');

const modSrc = fs.readFileSync(MODULE_PATH, 'utf8');
const apiSrc = fs.readFileSync(API_PATH, 'utf8');

console.log('── module surface ──');
ok('module exists', fs.existsSync(MODULE_PATH));
ok('saved-view registry exists', fs.existsSync(REGISTRY_PATH));
ok('createInboxViewRoutes is a factory', typeof createInboxViewRoutes === 'function');
ok('views path', INBOX_VIEWS_PATH === '/staff/inbox/views');
ok('list path', INBOX_LIST_PATH === '/staff/inbox/list');
ok('route table has exactly 2 routes', INBOX_VIEW_ROUTE_TABLE.length === 2);
ok('both routes are GET viewer',
  INBOX_VIEW_ROUTE_TABLE.every((r) => r.method === 'GET' && r.minRole === 'viewer'));
ok('route table ids', eq(INBOX_VIEW_ROUTE_TABLE.map((r) => r.id), ['inbox_views', 'inbox_list']));
ok('factory exposes both handlers', (() => {
  const routes = createInboxViewRoutes(makeDeps());
  return typeof routes.handleInboxViews === 'function' && typeof routes.handleInboxList === 'function';
})());
ok('factory refuses empty deps', (() => {
  try { createInboxViewRoutes(null); return false; } catch (_) { return true; }
})());
ok('registry declares 4 unavailable views', UNAVAILABLE.length === 4, UNAVAILABLE.map((v) => v.id).join(','));
ok('registry has available views to count', AVAILABLE.length >= 13, String(AVAILABLE.length));

console.log('\n── no duplicated SQL, no auth, no reverse coupling ──');
const modNoComments = modSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
ok('no require staff-query-api', !/require\s*\(\s*['"][^'"]*staff-query-api['"]\s*\)/.test(modSrc));
ok('requires the saved-view registry', /require\('\.\/staff-inbox-saved-views'\)/.test(modSrc));
ok('no SELECT ... FROM customers in module', !/SELECT[\s\S]{0,400}FROM\s+customers/i.test(modNoComments));
ok('no SELECT ... FROM conversations in module', !/SELECT[\s\S]{0,400}FROM\s+conversations/i.test(modNoComments));
ok('no COUNT(*) SQL written in module', !/COUNT\s*\(\s*\*\s*\)/i.test(modNoComments));
ok('no LIMIT/OFFSET SQL written in module', !/\bLIMIT\b\s*\$?\d/i.test(modNoComments));
ok('module does not call requireAuth', !/\brequireAuth\s*\(/.test(modNoComments));
ok('module calls assertStaffClientAccess', /assertStaffClientAccess\(/.test(modNoComments));

console.log('\n── staff-query-api wiring ──');
ok('requires the view-routes module', /require\('\.\/lib\/staff-inbox-view-routes'\)/.test(apiSrc));
ok('builds routes through the DI factory', /createInboxViewRoutes\(\{/.test(apiSrc));
const wiring = apiSrc.slice(
  apiSrc.indexOf('createInboxViewRoutes({'),
  apiSrc.indexOf('createInboxViewRoutes({') + 400,
);
for (const dep of ['sendJSON', 'send400', 'assertStaffClientAccess', 'appendAuditLog', 'withPgClient', 'DEFAULT_CLIENT', 'SQL_INJECT_RE']) {
  ok(`factory is injected ${dep}`, wiring.includes(dep));
}
const dispatch = apiSrc.slice(
  apiSrc.indexOf('if (pathname === INBOX_VIEWS_PATH'),
  apiSrc.indexOf('const convSubMatch = CONV_SUB_RE.exec(pathname);'),
);
ok('router matches both saved-view paths', dispatch.length > 0
  && dispatch.includes('INBOX_VIEWS_PATH') && dispatch.includes('INBOX_LIST_PATH'));
ok('router requires viewer auth', /requireAuth\(req, res, 'viewer'\)/.test(dispatch));
const routerRole = /requireAuth\(req, res, '(\w+)'\)/.exec(dispatch);
ok('router minRole matches every route table entry',
  !!routerRole && INBOX_VIEW_ROUTE_TABLE.every((r) => r.minRole === routerRole[1]),
  routerRole ? routerRole[1] : 'no requireAuth');
ok('router dispatches both module handlers',
  /handleInboxViews\(/.test(dispatch) && /handleInboxList\(/.test(dispatch));
ok('router rejects non-GET', /Allow: 'GET'/.test(dispatch));
ok('router authenticates before dispatching',
  dispatch.indexOf("requireAuth(req, res, 'viewer')") < dispatch.indexOf('handleInboxViews('));
const pathMatchRe = /pathname === INBOX_(?:VIEWS|LIST)_PATH/g;
ok('the paths are matched only inside that one route block',
  (apiSrc.match(pathMatchRe) || []).length === (dispatch.match(pathMatchRe) || []).length);
ok('wiring footprint in staff-query-api is the require, the factory and one route block',
  (apiSrc.match(/staff-inbox-view-routes/g) || []).length === 1
  && (apiSrc.match(/createInboxViewRoutes\(/g) || []).length === 1
  && (apiSrc.match(/handleInboxViews\(/g) || []).length === 1
  && (apiSrc.match(/handleInboxList\(/g) || []).length === 1);

console.log('\n── existing routes stay routed ──');
ok('/staff/conversations still routed', apiSrc.includes("pathname === '/staff/conversations'"));
ok('/staff/conversations still dispatches its own handler', apiSrc.includes('handleConversationInbox(parsed.query, res, auth.user)'));
ok('/staff/customers still routed', apiSrc.includes('CUSTOMERS_COLLECTION_PATH'));
ok('inbox thread composite still routed', apiSrc.includes('INBOX_THREAD_COMPOSITE_RE.exec(pathname)'));
ok('saved-view paths do not collide with the thread composite',
  INBOX_VIEWS_PATH !== '/staff/conversations' && INBOX_LIST_PATH !== '/staff/customers');

(async () => {
  console.log('\n── the rail: GET /staff/inbox/views ──');
  {
    const { body, res, deps } = await runViews();
    ok('rail 200', res.out.statusCode === 200 && body.success === true);
    ok('rail top-level keys', eq(Object.keys(body), [
      'success', 'client_slug', 'location_id', 'groups', 'views', 'unavailable',
      'count_errors', 'query_count', 'cache', 'elapsed_ms',
    ]), JSON.stringify(Object.keys(body)));
    ok('rail groups are the registry groups', eq(body.groups.map((g) => g.id), INBOX_VIEW_GROUP_IDS.slice()));
    ok('rail lists every available view', body.views.length === AVAILABLE.length);
    ok('every rail view carries id, label, group and count', body.views.every((v) => typeof v.id === 'string'
      && typeof v.label === 'string'
      && INBOX_VIEW_GROUP_IDS.includes(v.group)
      && typeof v.count === 'number'));
    ok('rail counts come from the aggregate aliases, per view',
      body.views.every((v) => v.count >= 1));
    ok('rail view ids match the registry', eq(body.views.map((v) => v.id).sort(), AVAILABLE.map((v) => v.id).sort()));
    ok('rail reports its own query count', body.query_count === 2, String(body.query_count));
    ok('rail audits the query count', deps.audit[0].query_count === 2);
    ok('rail echoes the tenant', body.client_slug === CLIENT);
  }

  console.log('\n── count strategy: two shared scans, whatever the view count ──');
  {
    const { deps, body } = await runViews();
    const counts = deps.log.filter((e) => COUNTS_RE.test(e.sql));
    ok('exactly 2 count queries for the whole rail', counts.length === 2, String(counts.length));
    ok('no query is a bare per-view COUNT', deps.log.every((e) => COUNTS_RE.test(e.sql)));
    ok('one pg client for the rail', deps.calls.withPgClient === 1);
    const perSource = counts.map((e) => (e.sql.match(/::int AS "/g) || []).length);
    ok('the count columns cover every rail view',
      perSource.reduce((a, b) => a + b, 0) === body.views.length,
      `${JSON.stringify(perSource)} vs ${body.views.length}`);
    ok('a scan answers many views at once', perSource.some((n) => n >= 3), JSON.stringify(perSource));
    ok('query count is independent of view count',
      buildInboxViewCountsPlan({ clientSlug: CLIENT, query: {} }).queryCount === 2);
    ok('the plan groups views by source, one pass each',
      buildInboxViewCountsPlan({ clientSlug: CLIENT, query: {} }).passes.length === 2);
  }
  {
    // Cache is keyed by tenant + location + search: same key is free, a
    // different tenant, location or search term pays for its own scan.
    const deps = makeDeps();
    const routes = createInboxViewRoutes(deps);
    await runViews({}, { deps }, routes);
    const afterFirst = deps.log.length;
    const second = await runViews({}, { deps }, routes);
    ok('a warm rail costs zero queries', deps.log.length === afterFirst);
    ok('a cache hit still returns the same counts', second.body.query_count === 0
      && second.body.cache.hit === true
      && second.body.views.every((v) => typeof v.count === 'number'));
    await runViews({ client: 'other-tenant' }, { deps }, routes);
    ok('another tenant does not read the first tenant cache', deps.log.length === afterFirst * 2);
    await runViews({ location: 'sunset-sardinero' }, { deps }, routes);
    ok('another location does not read the cached counts', deps.log.length === afterFirst * 3);
    await runViews({ q: 'ada' }, { deps }, routes);
    ok('another search term does not read the cached counts', deps.log.length === afterFirst * 4);
    await runViews({ refresh: '1' }, { deps }, routes);
    ok('refresh=1 bypasses the cache', deps.log.length === afterFirst * 5);
  }
  {
    const deps = makeDeps({ countsCacheTtlMs: -1 });
    const routes = createInboxViewRoutes(deps);
    await runViews({}, { deps }, routes);
    const afterFirst = deps.log.length;
    const second = await runViews({}, { deps }, routes);
    ok('an expired cache entry is re-scanned, not served stale',
      deps.log.length === afterFirst * 2 && second.body.cache.hit === false);
  }
  {
    const failing = makeDeps({
      async withPgClient(fn) {
        failing.calls.withPgClient += 1;
        return fn({
          async query(sql) {
            failing.log.push({ sql: String(sql) });
            // The conversation-source pass, identified by a view only it counts.
            if (/::int AS "whatsapp"/.test(String(sql))) throw new Error('relation missing');
            return { rows: [cannedCountsRow(String(sql))] };
          },
        });
      },
    });
    const { body, res } = await runViews({}, { deps: failing });
    ok('one failing scan still renders the rail', res.out.statusCode === 200 && body.success === true);
    ok('the failing source is named', eq(body.count_errors, ['conversations']));
    ok('views from the failing scan report a null count, not a wrong one',
      body.views.filter((v) => v.count === null).length === AVAILABLE.filter((v) => v.source === INBOX_VIEW_SOURCES.CONVERSATIONS).length);
    ok('views from the healthy scan keep their counts',
      body.views.filter((v) => v.source === INBOX_VIEW_SOURCES.CUSTOMERS).every((v) => typeof v.count === 'number'));
    const again = await runViews({}, { deps: failing });
    ok('a partial failure is not cached', again.body.cache.hit === false);
  }

  console.log('\n── tenant and location scoping on every view ──');
  {
    for (const view of AVAILABLE) {
      const built = buildInboxViewQuery({ view: view.id, clientSlug: CLIENT, query: {} });
      ok(`${view.id}: rows bind the tenant as $1`, built.ok === true && built.params[0] === CLIENT);
      ok(`${view.id}: tenant is not interpolated into SQL`, !built.sql.includes(CLIENT));
      ok(`${view.id}: SQL constrains clients.slug`, /c(?:_inner)?\.slug\s*=\s*\$1|clients\.slug\s*=\s*\$1/.test(built.sql));
    }
  }
  {
    const plan = buildInboxViewCountsPlan({ clientSlug: CLIENT, query: {} });
    ok('every count pass binds the tenant as $1', plan.passes.every((p) => p.params[0] === CLIENT));
    ok('no count pass interpolates the tenant', plan.passes.every((p) => !p.sql.includes(CLIENT)));
  }
  {
    const LOC = 'sunset-sardinero';
    for (const view of AVAILABLE) {
      const built = buildInboxViewQuery({ view: view.id, clientSlug: SURF_CLIENT, query: { location: LOC } });
      ok(`${view.id}: surf school is location-scoped`, built.locationScoped === true && built.locationId === LOC);
      ok(`${view.id}: location is bound, not interpolated`, built.params.includes(LOC) && !built.sql.includes(LOC));
    }
    const plan = buildInboxViewCountsPlan({ clientSlug: SURF_CLIENT, query: { location: LOC } });
    ok('every count pass binds the location', plan.passes.every((p) => p.params.includes(LOC)));
    ok('no count pass interpolates the location', plan.passes.every((p) => !p.sql.includes(LOC)));
    const unscoped = buildInboxViewCountsPlan({ clientSlug: CLIENT, query: {} });
    ok('a non-surf tenant is not location-scoped', unscoped.passes.every((p) => p.params.length < plan.passes[0].params.length || !p.params.includes(LOC)));
  }
  {
    const { body, deps } = await runList({ view: 'all_people', client: SURF_CLIENT, location: 'sunset-sardinero' });
    ok('list echoes the location scope', body.location_scoped === true && body.location_id === 'sunset-sardinero');
    ok('list query binds the location', deps.log[0].params.includes('sunset-sardinero'));
  }

  console.log('\n── every value is bound ──');
  {
    const SLUG = 'zz-tenant-x9';
    const views = AVAILABLE.map((v) => buildInboxViewQuery({
      view: v.id, clientSlug: SLUG, query: { q: 'ada' }, page: { limit: 10, cursor: null },
    }));
    ok('no view interpolates the tenant slug', views.every((b) => !b.sql.includes(SLUG)));
    ok('no view interpolates the search term', views.every((b) => !b.sql.includes('%ada%')));
    ok('every view binds the tenant first', views.every((b) => b.params[0] === SLUG));
    ok('every parameter placeholder is filled', views.every((b) => {
      const highest = (b.sql.match(/\$(\d+)/g) || []).reduce((max, p) => Math.max(max, Number(p.slice(1))), 0);
      return highest === b.params.length;
    }));
  }
  {
    const { res, body, deps } = await runList({ view: 'all_people', client: HOSTILE_CLIENT });
    ok('SQL-ish client slug gets 400', res.out.statusCode === 400, String(res.out.statusCode));
    ok('SQL-ish client slug never touches Postgres', deps.calls.withPgClient === 0);
    ok('400 body names the problem', body && body.success === false);
  }
  {
    const { res, deps } = await runViews({ client: HOSTILE_CLIENT });
    ok('rail rejects a SQL-ish client slug', res.out.statusCode === 400);
    ok('rail never touches Postgres for a SQL-ish slug', deps.calls.withPgClient === 0);
  }
  {
    const denied = () => {
      const deps = makeDeps({
        assertStaffClientAccess(user, clientSlug, r) {
          deps.sendJSON(r, 403, { success: false, error: 'client_access_denied', client_slug: clientSlug });
          return false;
        },
      });
      return deps;
    };
    const railDeps = denied();
    const rail = await runViews({ client: 'someone-else' }, { deps: railDeps });
    ok('denied client gets 403 on the rail', rail.res.out.statusCode === 403);
    ok('denied client never reaches Postgres on the rail', railDeps.calls.withPgClient === 0);
    const listDeps = denied();
    const list = await runList({ view: 'all_people', client: 'someone-else' }, { deps: listDeps });
    ok('denied client gets 403 on the list', list.res.out.statusCode === 403);
    ok('denied client never reaches Postgres on the list', listDeps.calls.withPgClient === 0);
  }

  console.log('\n── unavailable and unknown views ──');
  {
    const { body } = await runViews();
    const railIds = body.views.map((v) => v.id);
    for (const view of UNAVAILABLE) {
      ok(`${view.id}: absent from the rail`, !railIds.includes(view.id));
      ok(`${view.id}: reported as unavailable with a reason`, (() => {
        const entry = body.unavailable.find((u) => u.id === view.id);
        return !!entry && typeof entry.reason === 'string' && entry.reason.length > 0;
      })());
    }
    ok('unavailable views are not counted', body.unavailable.length === UNAVAILABLE.length);
  }
  {
    for (const view of UNAVAILABLE) {
      const { res, body, deps } = await runList({ view: view.id });
      ok(`${view.id}: list refuses it cleanly`, res.out.statusCode === 409, String(res.out.statusCode));
      ok(`${view.id}: refusal names the view and reason`, body.error === ERROR_VIEW_UNAVAILABLE
        && body.view === view.id && !!body.reason);
      ok(`${view.id}: refusal says what is missing`, Array.isArray(body.missing_capabilities)
        && Array.isArray(body.pending_migrations)
        && body.missing_capabilities.length > 0);
      ok(`${view.id}: refusal is not a 500`, res.out.statusCode !== 500);
      ok(`${view.id}: refusal never reaches Postgres`, deps.calls.withPgClient === 0);
      ok(`${view.id}: refusal returns no rows`, body.rows === undefined);
    }
  }
  {
    for (const bad of ['nope', 'ALL_PEOPLE', 'all people', '__proto__', 'constructor', '']) {
      const { res, body, deps } = await runList({ view: bad });
      ok(`unknown view ${JSON.stringify(bad)} is rejected`, res.out.statusCode === 400
        && body.error === ERROR_UNKNOWN_VIEW, `${res.out.statusCode} ${body && body.error}`);
      ok(`unknown view ${JSON.stringify(bad)} never reaches Postgres`, deps.calls.withPgClient === 0);
    }
    const missing = await runList({});
    ok('a missing view id is rejected', missing.res.out.statusCode === 400
      && missing.body.error === ERROR_UNKNOWN_VIEW);
    ok('a missing view id never reaches Postgres', missing.deps.calls.withPgClient === 0);
    ok('no unknown view silently falls back to another view',
      missing.body.rows === undefined && missing.body.view === null);
  }

  console.log('\n── the list: GET /staff/inbox/list ──');
  {
    const { body, res, deps } = await runList({ view: 'all_people' }, {}, CUSTOMER_FIXTURE.slice(0, 4));
    ok('list 200', res.out.statusCode === 200 && body.success === true);
    ok('list top-level keys', eq(Object.keys(body), [
      'success', 'client_slug', 'view', 'location_id', 'location_scoped', 'q',
      'search_supported', 'search_applied', 'rows', 'count', 'limit', 'has_more',
      'next_cursor', 'query_count', 'elapsed_ms',
    ]), JSON.stringify(Object.keys(body)));
    ok('list describes the view it answered for', body.view.id === 'all_people'
      && typeof body.view.label === 'string' && typeof body.view.group === 'string');
    ok('one query per list page', body.query_count === 1 && deps.log.length === 1);
    ok('rows are person rows with a stable shape',
      body.rows.every((r) => eq(Object.keys(r).sort(), INBOX_PERSON_ROW_FIELDS.slice().sort())));
    ok('every row carries its own cursor', body.rows.every((r) => typeof r.cursor === 'string' && r.cursor.length > 0));
    ok('every row names the view and source that produced it',
      body.rows.every((r) => r.view === 'all_people' && r.source === INBOX_VIEW_SOURCES.CUSTOMERS));
    ok('row keys are unique', new Set(body.rows.map((r) => r.key)).size === body.rows.length);
    ok('default limit', body.limit === INBOX_LIST_DEFAULT_LIMIT);
    ok('a short page has no next cursor', body.has_more === false && body.next_cursor === null);
  }
  {
    const { body } = await runList({ view: 'whatsapp' }, {}, CONVERSATION_FIXTURE.slice(0, 3));
    ok('a conversation view returns the same person-row shape',
      body.rows.every((r) => eq(Object.keys(r).sort(), INBOX_PERSON_ROW_FIELDS.slice().sort())));
    ok('conversation rows carry the conversation id', body.rows.every((r) => !!r.conversation_id));
    ok('search is not silently applied where the source cannot search',
      body.search_supported === false);
  }
  {
    const { body, deps } = await runList({ view: 'whatsapp', q: 'ada' }, {}, []);
    ok('an unsupported search is reported, not ignored',
      body.search_applied === false && body.q === 'ada');
    ok('an unsupported search adds no bound search parameter',
      !deps.log[0].params.includes('%ada%'));
  }
  {
    const { body, deps } = await runList({ view: 'all_people', q: 'ada' }, {}, []);
    ok('a supported search is applied and bound',
      body.search_applied === true && deps.log[0].params.includes('%ada%'));
  }
  {
    const rows = CUSTOMER_FIXTURE.slice();
    const { body } = await runList({ view: 'all_people', limit: '3' }, {}, rows);
    ok('limit is honoured', body.limit === 3 && body.rows.length === 3);
    ok('a full page reports another page', body.has_more === true && typeof body.next_cursor === 'string');
    ok('the next cursor is the last row cursor', body.next_cursor === body.rows[2].cursor);
    ok('the extra probe row is not returned', body.rows.length === 3 && rows.length > 3);
  }
  {
    ok('limit is clamped below the shared clampLimit ceiling',
      resolveInboxListLimit('100000') <= INBOX_LIST_MAX_LIMIT);
    ok('a clamped limit still leaves room for the has_more probe row',
      buildInboxViewQuery({
        view: 'all_people', clientSlug: CLIENT, query: {},
        page: { limit: INBOX_LIST_MAX_LIMIT + 1, cursor: null },
      }).ok === true);
    ok('an absent limit is the default', resolveInboxListLimit(undefined) === INBOX_LIST_DEFAULT_LIMIT);
  }

    console.log('\n── keyset and counts are opt-in: the Customers route shape is untouched ──');
  {
    for (const view of AVAILABLE) {
      const legacy = buildInboxViewQuery({ view: view.id, clientSlug: CLIENT, query: {} });
      ok(`${view.id}: an unpaged build keeps the LIMIT/OFFSET shape`,
        /LIMIT \$\d+ OFFSET \$\d+/.test(legacy.sql) || /LIMIT \d+/.test(legacy.sql),
        legacy.sql.slice(legacy.sql.lastIndexOf('LIMIT')).trim());
      ok(`${view.id}: an unpaged build applies no cursor`,
        !legacy.cursorApplied && !legacy.keyset);
    }
    ok('the customer list builder is unchanged unless keyset is asked for',
      getCustomerListQuery({ filter: 'all' }) === getCustomerListQuery({ filter: 'all', keyset: false, hasCursor: false }));
    ok('the conversation inbox builder is unchanged unless keyset is asked for',
      getConversationInboxQuery({}) === getConversationInboxQuery({ keyset: false }));
    ok('asking for keyset is what changes the SQL',
      getCustomerListQuery({ filter: 'all' }) !== getCustomerListQuery({ filter: 'all', keyset: true }));
  }

  console.log('\n── paging is keyset, and stable under concurrent writes ──');
  for (const testCase of PAGING_CASES) {
    const label = testCase.view;
    const fields = CURSOR_FIELDS_BY_SOURCE[testCase.source];
    const first = buildInboxViewQuery({
      view: label, clientSlug: CLIENT, query: {}, page: { limit: 3, cursor: null },
    });
    const terms = orderByTerms(first.sql);

    ok(`${label}: paged SQL has no OFFSET`, !/\bOFFSET\b/i.test(first.sql));
    ok(`${label}: the page size is bound, not inlined`, /LIMIT\s+\$\d+\s*$/.test(first.sql.trim()));
    ok(`${label}: one cursor field per ORDER BY term`, terms.length === fields.length,
      `${terms.length} terms vs ${fields.length} fields: ${JSON.stringify(terms.map((t) => t.expr))}`);
    ok(`${label}: the tuple ends in the unique tiebreaker ${testCase.tiebreaker}`,
      terms[terms.length - 1].expr === testCase.tiebreaker && !terms[terms.length - 1].desc);

    const cursorRow = testCase.fixture[0];
    const paged = buildInboxViewQuery({
      view: label,
      clientSlug: CLIENT,
      query: {},
      page: { limit: 3, cursor: fields.reduce((acc, f) => ({ ...acc, [f]: cursorRow[f] }), {}) },
    });
    ok(`${label}: a cursor is applied as a keyset predicate`, paged.cursorApplied === true);
    ok(`${label}: the paged query still has no OFFSET`, !/\bOFFSET\b/i.test(paged.sql));
    const clause = cursorClause(first.sql, paged.sql);
    ok(`${label}: the cursor adds only a predicate, leaving the sort untouched`,
      clause.length > 0 && !/ORDER BY|LIMIT/i.test(clause));
    ok(`${label}: the keyset predicate is bound to parameters`, /\$\d+/.test(clause));
    ok(`${label}: every cursor value is a parameter, none inlined`,
      !clause.includes(String(cursorRow[fields[fields.length - 1]])));
    for (let i = 0; i < terms.length; i += 1) {
      const strict = terms[i].desc ? '<' : '>';
      const expr = terms[i].expr;
      const direct = clause.includes(`${expr} ${strict} $`);
      const wrapped = clause.includes(`(${expr}) ${strict} $`);
      const nullable = terms[i].nullsLast && clause.includes(`${expr} IS NULL`);
      ok(`${label}: term ${i + 1} compares ${terms[i].desc ? 'descending' : 'ascending'} against a bound value`,
        direct || wrapped || nullable, `${strict} for ${expr}`);
    }
    ok(`${label}: a NULLS LAST term handles the null tail`,
      !terms.some((t) => t.nullsLast) || /IS NULL|IS NOT DISTINCT FROM/.test(clause));

    // Simulation: the comparator comes from the ORDER BY above, so the model
    // follows the real sort rather than a second copy of it.
    const compare = comparatorFor(terms, fields);
    const sorted = testCase.fixture.slice().sort(compare);
    const keyOf = (row) => fields.reduce((acc, f) => ({ ...acc, [f]: row[f] }), {});
    const after = (rows, cursor) => rows.filter((r) => compare(r, cursor) > 0);
    const PAGE = 3;

    ok(`${label}: the sort is total (no ties survive the tiebreaker)`,
      sorted.every((row, i) => i === 0 || compare(sorted[i - 1], row) < 0));

    const page1 = sorted.slice(0, PAGE);
    const cursor1 = keyOf(page1[page1.length - 1]);

    const mutated = sorted.concat([testCase.inserted]).sort(compare);
    ok(`${label}: the mid-scroll write lands before the cursor`,
      compare(testCase.inserted, cursor1) < 0);

    const keysetPage2 = after(mutated, cursor1).slice(0, PAGE);
    const offsetPage2 = mutated.slice(PAGE, PAGE * 2);
    const idField = fields[fields.length - 1];
    const seenKeyset = page1.concat(keysetPage2).map((r) => r[idField]);
    const seenOffset = page1.concat(offsetPage2).map((r) => r[idField]);

    ok(`${label}: an insert mid-scroll repeats nobody under keyset paging`,
      new Set(seenKeyset).size === seenKeyset.length, JSON.stringify(seenKeyset));
    ok(`${label}: OFFSET paging would have repeated somebody`,
      new Set(seenOffset).size !== seenOffset.length, JSON.stringify(seenOffset));
    ok(`${label}: keyset page 2 continues exactly where page 1 stopped`,
      eq(keysetPage2.map((r) => r[idField]),
        sorted.slice(PAGE, PAGE * 2).map((r) => r[idField])));

    const shrunk = sorted.filter((r) => r[idField] !== sorted[0][idField]);
    const keysetAfterDelete = after(shrunk, cursor1).slice(0, PAGE);
    const offsetAfterDelete = shrunk.slice(PAGE, PAGE * 2);
    ok(`${label}: a delete mid-scroll skips nobody under keyset paging`,
      eq(keysetAfterDelete.map((r) => r[idField]), sorted.slice(PAGE, PAGE * 2).map((r) => r[idField])));
    ok(`${label}: OFFSET paging would have skipped somebody`,
      !eq(offsetAfterDelete.map((r) => r[idField]), sorted.slice(PAGE, PAGE * 2).map((r) => r[idField])));

    const walked = [];
    let cursor = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = (cursor ? after(sorted, cursor) : sorted).slice(0, PAGE);
      if (!page.length) break;
      walked.push(...page.map((r) => r[idField]));
      cursor = keyOf(page[page.length - 1]);
    }
    ok(`${label}: a full keyset walk visits everybody exactly once, in order`,
      eq(walked, sorted.map((r) => r[idField])), JSON.stringify(walked));
  }

  console.log('\n── cursor codec ──');
  {
    const view = AVAILABLE.find((v) => v.id === 'all_people');
    const row = CUSTOMER_FIXTURE[0];
    const cursor = encodeInboxListCursor(view, row);
    const decoded = decodeInboxListCursor(cursor, view);
    ok('a cursor round-trips', decoded.ok === true
      && eq(Object.keys(decoded.cursor).sort(), CURSOR_FIELDS_BY_SOURCE[view.source].slice().sort()));
    ok('a cursor carries the sort tuple, nothing else',
      eq(decoded.cursor, CURSOR_FIELDS_BY_SOURCE[view.source]
        .reduce((acc, f) => ({ ...acc, [f]: row[f] }), {})));
    ok('a cursor is opaque to the client', !cursor.includes(row.phone));
    const nullRow = CUSTOMER_FIXTURE.find((r) => r.last_contact_at === null);
    const nullDecoded = decodeInboxListCursor(encodeInboxListCursor(view, nullRow), view);
    ok('a null sort value survives the round-trip',
      nullDecoded.ok === true && nullDecoded.cursor.last_contact_at === null);

    const other = AVAILABLE.find((v) => v.id === 'whatsapp');
    ok("a cursor from another source is refused, not applied to this view's people",
      decodeInboxListCursor(cursor, other).ok === false);
    // Same source, same tuple shape: only the view id in the payload can tell
    // these apart, and a position in one population is not a position in another.
    for (const sibling of AVAILABLE.filter((v) => v.source === view.source && v.id !== view.id)) {
      ok(`a cursor from all_people is refused by the sibling view ${sibling.id}`,
        decodeInboxListCursor(cursor, sibling).ok === false);
    }
    for (const bad of ['', 'not-base64!!', Buffer.from('{}', 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, view: 'all_people' }), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 99, view: 'all_people', k: {} }), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, view: 'all_people', k: { phone: 1 } }), 'utf8').toString('base64url')]) {
      ok(`a malformed cursor is refused: ${JSON.stringify(String(bad).slice(0, 24))}`,
        decodeInboxListCursor(bad, view).ok === false);
    }
  }
  {
    const rows = CUSTOMER_FIXTURE.slice();
    const page1 = await runList({ view: 'all_people', limit: '3' }, {}, rows);
    const page2 = await runList({ view: 'all_people', limit: '3', cursor: page1.body.next_cursor }, {}, rows);
    ok('the list accepts its own cursor', page2.res.out.statusCode === 200 && page2.body.success === true);
    ok('a paged list still runs one query', page2.deps.log.length === 1);
    ok('the cursor values reach Postgres as parameters',
      page2.deps.log[0].params.length > page1.deps.log[0].params.length);
    const bad = await runList({ view: 'all_people', cursor: 'garbage' }, {}, rows);
    ok('a malformed cursor is a 400, not a 500', bad.res.out.statusCode === 400
      && bad.body.error === ERROR_INVALID_CURSOR);
    ok('a malformed cursor never reaches Postgres', bad.deps.calls.withPgClient === 0);
    const crossView = await runList({ view: 'whatsapp', cursor: page1.body.next_cursor }, {}, rows);
    ok('a cursor from another source is a 400, not the wrong people',
      crossView.res.out.statusCode === 400 && crossView.body.error === ERROR_INVALID_CURSOR);
    ok('a cross-source cursor never reaches Postgres', crossView.deps.calls.withPgClient === 0);
    const sibling = await runList({ view: 'hot_leads', cursor: page1.body.next_cursor }, {}, rows);
    ok('a cursor from a sibling view of the same source is also a 400',
      sibling.res.out.statusCode === 400 && sibling.body.error === ERROR_INVALID_CURSOR);
    ok('a sibling-view cursor never reaches Postgres', sibling.deps.calls.withPgClient === 0);
  }

  console.log('\n── audit ──');
  {
    const { deps } = await runList({ view: 'all_people' }, {}, CUSTOMER_FIXTURE.slice(0, 2));
    const entry = deps.audit[deps.audit.length - 1];
    ok('one audit record per list read', deps.audit.length === 1);
    ok('list audit intent', entry.intent === 'api:inbox.list');
    ok('list audit carries tenant and view', entry.client_slug === CLIENT && entry.view === 'all_people');
  }
  {
    const { deps } = await runViews();
    ok('rail audit intent', deps.audit[0].intent === 'api:inbox.views');
    ok('rail audit carries tenant', deps.audit[0].client_slug === CLIENT);
  }
  {
    const boom = makeDeps({
      async withPgClient() { throw new Error('connection refused'); },
    });
    const { res, body } = await runList({ view: 'all_people' }, { deps: boom });
    ok('a failed list query answers 500 with no rows', res.out.statusCode === 500 && body.rows === undefined);
    ok('a failed list query is audited', boom.audit[0].success === false);
    const railBoom = makeDeps({ async withPgClient() { throw new Error('connection refused'); } });
    const rail = await runViews({}, { deps: railBoom });
    ok('a failed rail query answers 500', rail.res.out.statusCode === 500);
    ok('a failed rail query is audited', railBoom.audit[0].success === false);
  }

  console.log(`\n── Summary: ${pass} passed, ${fail} failed ──`);
  if (fail) {
    console.error('\nverify:inbox-view-routes FAILED');
  } else {
    console.log('\nverify:inbox-view-routes PASSED');
  }
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\nverify:inbox-view-routes CRASHED', err);
  process.exit(1);
});
