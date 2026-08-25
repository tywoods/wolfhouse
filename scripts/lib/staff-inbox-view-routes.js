/**
 * Inbox saved-view read routes (Phase 1, `docs/INBOX-PORTAL-REDESIGN.md`).
 *
 *   GET /staff/inbox/views              — the left rail: available views, grouped, with counts
 *   GET /staff/inbox/list?view=&q=&cursor= — one person-row list for one view
 *
 * Counts are two queries per rail load, not one per view: the saved-view registry
 * groups the available views by source and each source answers with a single
 * aggregate pass whose columns are `COUNT(*) FILTER (WHERE <that view's own list
 * predicate>)`. Adding a view to a group that already has a pass adds a column,
 * not a query. A short TTL cache keyed by tenant + location + search collapses
 * rail polling to zero queries between refreshes.
 *
 * Every query, both counts and rows, comes from staff-inbox-saved-views.js, so
 * tenant scoping (`clients.slug = $1`), Sunset location scoping and the CRM
 * predicates stay owned by the existing builders and every value is bound.
 *
 * Paging is keyset, never OFFSET: the cursor carries the view's own ORDER BY
 * tuple plus a unique tiebreaker (`cu.phone` for people views, `conv.id` for
 * conversation views), so a row inserted or touched mid-scroll cannot shift a
 * page boundary and hide or repeat a person.
 *
 * Auth is NOT enforced here. The Staff API router must call requireAuth with the
 * minRole from INBOX_VIEW_ROUTE_TABLE before dispatching; the handlers then apply
 * the same assertStaffClientAccess check the Customers and Conversations routes
 * apply, before any Postgres access.
 *
 * @module staff-inbox-view-routes
 */

'use strict';

const {
  INBOX_VIEW_GROUPS,
  INBOX_VIEW_SOURCES,
  ERROR_UNKNOWN_VIEW,
  ERROR_VIEW_UNAVAILABLE,
  listInboxSavedViewDeclarations,
  getInboxSavedViewDeclaration,
  resolveInboxConversationLocationScope,
  buildInboxViewQuery,
  buildInboxViewCountsPlan,
} = require('./staff-inbox-saved-views');
const {
  CUSTOMER_LIST_CURSOR_FIELDS,
  buildCustomerDisplayTags,
  clampLimit,
  normalizeCustomerPhone,
} = require('./staff-customer-queries');
const {
  CONVERSATION_INBOX_CURSOR_FIELDS,
  markEmailInboundInboxMissing,
  isMissingEmailInboundRelation,
  emailInboundInboxAssumedReady,
} = require('./staff-conversation-queries');

const INBOX_VIEWS_PATH = '/staff/inbox/views';
const INBOX_LIST_PATH = '/staff/inbox/list';

/**
 * Canonical route table — minRole must match router requireAuth exactly.
 * Auth stays in staff-query-api.js; this table is the contract for the harness.
 */
const INBOX_VIEW_ROUTE_TABLE = Object.freeze([
  { id: 'inbox_views', method: 'GET', path: INBOX_VIEWS_PATH, match: 'exact', minRole: 'viewer' },
  { id: 'inbox_list', method: 'GET', path: INBOX_LIST_PATH, match: 'exact', minRole: 'viewer' },
]);

const ERROR_INVALID_CURSOR = 'invalid_cursor';

/** clampLimit allows 100; the list asks for one extra row to detect another page. */
const INBOX_LIST_DEFAULT_LIMIT = 50;
const INBOX_LIST_MAX_LIMIT = 99;

const INBOX_VIEW_COUNTS_CACHE_TTL_MS = 5000;
const INBOX_VIEW_COUNTS_CACHE_MAX_KEYS = 64;

const INBOX_LIST_CURSOR_VERSION = 2;

const CURSOR_FIELDS_BY_SOURCE = Object.freeze({
  [INBOX_VIEW_SOURCES.CUSTOMERS]: CUSTOMER_LIST_CURSOR_FIELDS,
  [INBOX_VIEW_SOURCES.CONVERSATIONS]: CONVERSATION_INBOX_CURSOR_FIELDS,
});

/** Only last_contact_at is nullable; the rest are NOT NULL columns or COALESCEd. */
const CURSOR_FIELD_TYPES = Object.freeze({
  is_booked: 'boolean',
  last_contact_at: 'timestamp_or_null',
  phone: 'string',
  last_activity: 'timestamp',
  conversation_id: 'string',
});

/** Row fields carried by every person row, whichever source produced it. */
const INBOX_PERSON_ROW_FIELDS = Object.freeze([
  'key',
  'source',
  'view',
  'phone',
  'display_name',
  'email',
  'language',
  'channel',
  'conversation_id',
  'conversation_stage',
  'conversation_status',
  'last_activity',
  'last_message_preview',
  'needs_human',
  'needs_attention',
  'handoff_reason',
  'handoff_priority',
  'handoff_status',
  'luna_paused',
  'booking_code',
  'booking_count',
  'service_count',
  'is_booked',
  'checked_in_now',
  'last_check_in',
  'last_service_type',
  'last_service_quantity',
  'last_service_date',
  'crm_tags',
  'auto_tags',
  'display_tags',
  'cursor',
]);

function isoOrNull(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return String(value);
}

function cursorFieldValue(field, raw) {
  switch (CURSOR_FIELD_TYPES[field]) {
    case 'boolean': return !!raw;
    case 'integer': return Number(raw);
    case 'timestamp': return isoOrNull(raw);
    case 'timestamp_or_null': return isoOrNull(raw);
    default: return raw == null ? '' : String(raw);
  }
}

function cursorFieldValid(field, value) {
  switch (CURSOR_FIELD_TYPES[field]) {
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'timestamp': return typeof value === 'string' && !Number.isNaN(Date.parse(value));
    case 'timestamp_or_null':
      return value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
    case 'string': return typeof value === 'string' && value.length > 0;
    default: return false;
  }
}

/**
 * @param {object} view - decorated saved view (needs id and source)
 * @param {object} row - the row this cursor should resume after
 * @returns {string} opaque cursor
 */
function encodeInboxListCursor(view, row) {
  const fields = CURSOR_FIELDS_BY_SOURCE[view.source] || [];
  const key = {};
  for (const field of fields) key[field] = cursorFieldValue(field, row[field]);
  const payload = { v: INBOX_LIST_CURSOR_VERSION, view: view.id, k: key };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * A cursor is only accepted for the view that produced it: a stale or hand-made
 * cursor is refused rather than applied to a different set of people.
 *
 * @returns {{ ok: true, cursor: object }|{ ok: false, error: string }}
 */
function decodeInboxListCursor(raw, view) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, error: ERROR_INVALID_CURSOR };
  let payload;
  try {
    payload = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch (_) {
    return { ok: false, error: ERROR_INVALID_CURSOR };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: ERROR_INVALID_CURSOR };
  }
  if (payload.v !== INBOX_LIST_CURSOR_VERSION) return { ok: false, error: ERROR_INVALID_CURSOR };
  if (payload.view !== view.id) return { ok: false, error: ERROR_INVALID_CURSOR };
  const key = payload.k;
  if (!key || typeof key !== 'object' || Array.isArray(key)) {
    return { ok: false, error: ERROR_INVALID_CURSOR };
  }
  const fields = CURSOR_FIELDS_BY_SOURCE[view.source] || [];
  if (!fields.length) return { ok: false, error: ERROR_INVALID_CURSOR };
  if (Object.keys(key).length !== fields.length) return { ok: false, error: ERROR_INVALID_CURSOR };
  const cursor = {};
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(key, field)) {
      return { ok: false, error: ERROR_INVALID_CURSOR };
    }
    if (!cursorFieldValid(field, key[field])) return { ok: false, error: ERROR_INVALID_CURSOR };
    cursor[field] = key[field];
  }
  return { ok: true, cursor };
}

function resolveInboxListLimit(raw) {
  if (raw == null || String(raw).trim() === '') return INBOX_LIST_DEFAULT_LIMIT;
  return Math.min(clampLimit(raw), INBOX_LIST_MAX_LIMIT);
}

function personRowShell(view) {
  const row = {};
  for (const field of INBOX_PERSON_ROW_FIELDS) row[field] = null;
  row.source = view.source;
  row.view = view.id;
  row.display_tags = [];
  return row;
}

function projectCustomerPersonRow(view, raw) {
  const tags = buildCustomerDisplayTags(raw);
  const phone = normalizeCustomerPhone(raw.phone) || raw.phone || null;
  const row = personRowShell(view);
  row.key = `${INBOX_VIEW_SOURCES.CUSTOMERS}:${phone || ''}`;
  row.phone = phone;
  row.display_name = raw.display_name || null;
  row.email = raw.email || null;
  row.language = raw.language || null;
  row.conversation_id = raw.conversation_id || null;
  row.conversation_stage = raw.conversation_stage || null;
  row.last_activity = isoOrNull(raw.last_contact_at);
  row.last_message_preview = raw.last_message_preview || null;
  row.needs_human = !!raw.needs_human;
  row.needs_attention = !!raw.needs_human || !!raw.has_open_handoff;
  row.booking_count = Number(raw.booking_count) || 0;
  row.service_count = Number(raw.service_count) || 0;
  row.is_booked = !!raw.is_booked;
  row.checked_in_now = !!raw.checked_in_now;
  row.last_check_in = raw.last_check_in || null;
  row.last_service_type = raw.last_service_type || null;
  row.last_service_quantity = raw.last_service_quantity != null ? raw.last_service_quantity : null;
  row.last_service_date = raw.last_service_date || raw.last_service_date_detail || null;
  row.crm_tags = tags.crm_tags;
  row.auto_tags = tags.auto_tags;
  row.display_tags = tags.display_tags;
  row.cursor = encodeInboxListCursor(view, raw);
  return row;
}

function projectConversationPersonRow(view, raw) {
  const row = personRowShell(view);
  row.key = `${INBOX_VIEW_SOURCES.CONVERSATIONS}:${raw.conversation_id || ''}`;
  row.phone = raw.phone || null;
  row.display_name = raw.guest_name || null;
  row.email = raw.guest_email || null;
  row.language = raw.language || null;
  row.channel = raw.channel || null;
  row.conversation_id = raw.conversation_id || null;
  row.conversation_stage = raw.conversation_stage || null;
  row.conversation_status = raw.conversation_status || null;
  row.last_activity = isoOrNull(raw.last_activity);
  row.last_message_preview = raw.last_message_preview || null;
  row.needs_human = !!raw.needs_human;
  row.needs_attention = !!raw.needs_human || !!raw.handoff_status;
  row.handoff_reason = raw.handoff_reason || null;
  row.handoff_priority = raw.handoff_priority || null;
  row.handoff_status = raw.handoff_status || null;
  row.luna_paused = !!raw.luna_paused;
  row.booking_code = raw.booking_code || null;
  row.cursor = encodeInboxListCursor(view, raw);
  return row;
}

function projectInboxPersonRow(view, raw) {
  return view.source === INBOX_VIEW_SOURCES.CUSTOMERS
    ? projectCustomerPersonRow(view, raw)
    : projectConversationPersonRow(view, raw);
}

function railView(view, count) {
  return {
    id: view.id,
    label: view.label,
    group: view.group,
    count: count === undefined ? null : count,
    source: view.source,
    channel: view.channel,
    sort: view.defaultSort,
    multi_select: view.multiSelect,
    description: view.description,
  };
}

function unavailableView(view) {
  return {
    id: view.id,
    label: view.label,
    group: view.group,
    reason: view.unavailableReason,
    missing_capabilities: view.missingCapabilities.slice(),
    pending_migrations: view.pendingMigrations.slice(),
  };
}

function countsCacheKey(clientSlug, query) {
  const location = String((query && query.location) || '').trim().toLowerCase();
  const search = String((query && (query.q || query.query)) || '').trim();
  return `${clientSlug}\u0000${location}\u0000${search}`;
}

/**
 * @param {object} deps
 */
function createInboxViewRoutes(deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('createInboxViewRoutes: deps required');
  }
  const {
    sendJSON,
    send400,
    assertStaffClientAccess,
    appendAuditLog,
    withPgClient,
    DEFAULT_CLIENT,
    SQL_INJECT_RE,
  } = deps;

  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const countsCacheTtlMs = Number.isFinite(deps.countsCacheTtlMs)
    ? deps.countsCacheTtlMs
    : INBOX_VIEW_COUNTS_CACHE_TTL_MS;
  const capabilities = deps.inboxViewCapabilities || null;
  const countsCache = new Map();

  function readCountsCache(key) {
    const entry = countsCache.get(key);
    if (!entry) return null;
    const age = now() - entry.at;
    if (age > countsCacheTtlMs) {
      countsCache.delete(key);
      return null;
    }
    return { counts: entry.counts, age_ms: age };
  }

  function writeCountsCache(key, counts) {
    if (countsCache.size >= INBOX_VIEW_COUNTS_CACHE_MAX_KEYS) {
      const oldest = countsCache.keys().next();
      if (!oldest.done) countsCache.delete(oldest.value);
    }
    countsCache.set(key, { at: now(), counts });
  }

  function resolveRequestClient(query, res, user) {
    const clientSlug = String(query.client || DEFAULT_CLIENT).trim();
    if (SQL_INJECT_RE.test(clientSlug)) {
      send400(res, 'invalid client slug');
      return null;
    }
    if (!assertStaffClientAccess(user, clientSlug, res)) return null;
    return clientSlug;
  }

  async function runCountsPasses(plan) {
    return withPgClient(async (pg) => {
      const counts = {};
      const errors = [];
      let queries = 0;
      for (const pass of plan.passes) {
        queries += 1;
        try {
          const result = await pg.query(pass.sql, pass.params);
          const row = (result && result.rows && result.rows[0]) || {};
          for (const viewId of pass.viewIds) {
            const value = row[viewId];
            counts[viewId] = value == null ? 0 : Number(value);
          }
        } catch (_err) {
          errors.push(pass.source);
          for (const viewId of pass.viewIds) counts[viewId] = null;
        }
      }
      return { counts, errors, queries };
    });
  }

  async function handleInboxViews(query, res, user) {
    const started = Date.now();
    const clientSlug = resolveRequestClient(query, res, user);
    if (clientSlug === null) return undefined;

    const plan = buildInboxViewCountsPlan({ clientSlug, query, capabilities });
    const declarations = listInboxSavedViewDeclarations({ capabilities });
    const locationScope = resolveInboxConversationLocationScope(clientSlug, query);

    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:inbox.views',
      category: 'conversation_api',
      client_slug: clientSlug,
      location_id: locationScope.locationId,
      staff_user_id: user ? user.staff_user_id : null,
    };

    const cacheKey = countsCacheKey(clientSlug, query);
    const cached = String(query.refresh || '') === '1' ? null : readCountsCache(cacheKey);

    let counts;
    let errors = [];
    let queries = 0;
    if (cached) {
      counts = cached.counts;
    } else {
      let outcome;
      try {
        outcome = await runCountsPasses(plan);
      } catch (err) {
        appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
        return sendJSON(res, 500, { success: false, error: 'query failed' });
      }
      counts = outcome.counts;
      errors = outcome.errors;
      queries = outcome.queries;
      if (!errors.length) writeCountsCache(cacheKey, counts);
    }

    const elapsed = Date.now() - started;
    appendAuditLog({
      ...auditBase,
      success: true,
      view_count: plan.views.length,
      query_count: queries,
      cache_hit: !!cached,
      count_errors: errors,
      elapsed_ms: elapsed,
    });

    return sendJSON(res, 200, {
      success: true,
      client_slug: clientSlug,
      location_id: locationScope.locationId,
      groups: INBOX_VIEW_GROUPS.map((group) => ({ id: group.id, label: group.label })),
      views: plan.views.map((view) => railView(view, counts[view.id])),
      unavailable: declarations.filter((view) => !view.available).map(unavailableView),
      count_errors: errors,
      query_count: queries,
      cache: {
        hit: !!cached,
        age_ms: cached ? cached.age_ms : 0,
        ttl_ms: countsCacheTtlMs,
      },
      elapsed_ms: elapsed,
    });
  }

  async function handleInboxList(query, res, user) {
    const started = Date.now();
    const clientSlug = resolveRequestClient(query, res, user);
    if (clientSlug === null) return undefined;

    const requestedView = query.view != null ? query.view : query.saved_view;
    const declaration = typeof requestedView === 'string'
      ? getInboxSavedViewDeclaration(requestedView, { capabilities })
      : null;
    if (!declaration) {
      return sendJSON(res, 400, {
        success: false,
        error: ERROR_UNKNOWN_VIEW,
        view: typeof requestedView === 'string' ? requestedView : null,
      });
    }
    if (!declaration.available) {
      return sendJSON(res, 409, {
        success: false,
        error: ERROR_VIEW_UNAVAILABLE,
        view: declaration.id,
        reason: declaration.unavailableReason,
        missing_capabilities: declaration.missingCapabilities.slice(),
        pending_migrations: declaration.pendingMigrations.slice(),
      });
    }

    let cursor = null;
    if (query.cursor != null && String(query.cursor).trim() !== '') {
      const decoded = decodeInboxListCursor(query.cursor, declaration);
      if (!decoded.ok) {
        return sendJSON(res, 400, {
          success: false,
          error: decoded.error,
          view: declaration.id,
        });
      }
      cursor = decoded.cursor;
    }

    const limit = resolveInboxListLimit(query.limit);
    const q = String(query.q || query.query || '').trim();
    const searchSupported = declaration.source === INBOX_VIEW_SOURCES.CUSTOMERS;
    const listQuery = searchSupported ? { ...query, q } : { ...query, q: '', query: '' };

    const built = buildInboxViewQuery({
      view: declaration.id,
      clientSlug,
      query: listQuery,
      capabilities,
      page: { limit: limit + 1, cursor },
      includeInboundProjections: emailInboundInboxAssumedReady(),
    });
    if (!built.ok) {
      return sendJSON(res, 409, {
        success: false,
        error: built.error,
        view: declaration.id,
        reason: built.reason || null,
      });
    }

    const auditBase = {
      ts: new Date().toISOString(),
      intent: 'api:inbox.list',
      category: 'conversation_api',
      client_slug: clientSlug,
      location_id: built.locationId,
      view: declaration.id,
      source: built.source,
      paged: !!cursor,
      staff_user_id: user ? user.staff_user_id : null,
    };

    let rows;
    try {
      rows = await withPgClient(async (pg) => {
        try {
          const result = await pg.query(built.sql, built.params);
          return (result && result.rows) || [];
        } catch (err) {
          if (!isMissingEmailInboundRelation(err)) throw err;
          markEmailInboundInboxMissing();
          const fallback = buildInboxViewQuery({
            view: declaration.id,
            clientSlug,
            query: listQuery,
            capabilities,
            page: { limit: limit + 1, cursor },
            includeInboundProjections: false,
          });
          if (!fallback.ok) throw err;
          const result = await pg.query(fallback.sql, fallback.params);
          return (result && result.rows) || [];
        }
      });
    } catch (err) {
      appendAuditLog({ ...auditBase, success: false, error: err.message, elapsed_ms: Date.now() - started });
      return sendJSON(res, 500, { success: false, error: 'query failed' });
    }

    const hasMore = rows.length > limit;
    const pageRows = (hasMore ? rows.slice(0, limit) : rows)
      .map((raw) => projectInboxPersonRow(declaration, raw));
    const nextCursor = hasMore && pageRows.length ? pageRows[pageRows.length - 1].cursor : null;

    const elapsed = Date.now() - started;
    appendAuditLog({ ...auditBase, success: true, row_count: pageRows.length, has_more: hasMore, elapsed_ms: elapsed });

    return sendJSON(res, 200, {
      success: true,
      client_slug: clientSlug,
      view: {
        id: declaration.id,
        label: declaration.label,
        group: declaration.group,
        source: built.source,
        channel: built.channel,
        sort: declaration.defaultSort,
        multi_select: declaration.multiSelect,
      },
      location_id: built.locationId,
      location_scoped: built.locationScoped,
      q,
      search_supported: searchSupported,
      search_applied: searchSupported && q.length > 0,
      rows: pageRows,
      count: pageRows.length,
      limit,
      has_more: hasMore,
      next_cursor: nextCursor,
      query_count: 1,
      elapsed_ms: elapsed,
    });
  }

  const handlers = Object.freeze({
    inbox_views: handleInboxViews,
    inbox_list: handleInboxList,
  });

  const routes = Object.freeze(INBOX_VIEW_ROUTE_TABLE.map((row) => ({
    ...row,
    handler: handlers[row.id],
  })));

  return {
    INBOX_VIEWS_PATH,
    INBOX_LIST_PATH,
    INBOX_VIEW_ROUTE_TABLE,
    handlers,
    routes,
    handleInboxViews,
    handleInboxList,
  };
}

module.exports = {
  INBOX_VIEWS_PATH,
  INBOX_LIST_PATH,
  INBOX_VIEW_ROUTE_TABLE,
  INBOX_VIEW_COUNTS_CACHE_TTL_MS,
  INBOX_LIST_DEFAULT_LIMIT,
  INBOX_LIST_MAX_LIMIT,
  INBOX_LIST_CURSOR_VERSION,
  INBOX_PERSON_ROW_FIELDS,
  CURSOR_FIELDS_BY_SOURCE,
  ERROR_INVALID_CURSOR,
  encodeInboxListCursor,
  decodeInboxListCursor,
  resolveInboxListLimit,
  projectInboxPersonRow,
  createInboxViewRoutes,
};
