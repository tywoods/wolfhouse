/**
 * Staff Inbox — saved-view query layer (Phase 1, `docs/INBOX-PORTAL-REDESIGN.md`).
 *
 * One registry of named filters over people, replacing the two vocabularies the
 * Inbox uses today: the CRM `ALLOWED_FILTERS` chips and the conversation-list
 * channel chips. A view declares what it is (id, label, group, default sort,
 * multi-select for broadcasts) and how it constrains the query — never the
 * business rules themselves.
 *
 * Delegation is the contract of this module:
 *   - people views  → staff-customer-queries.buildCustomerListParams /
 *                     buildCustomerListFilterClause (the ALLOWED_FILTERS predicates)
 *   - inbox views   → staff-conversation-queries.getConversationInboxQuery
 *
 * Tenant scoping ($1 = clients.slug) and Sunset location scoping come from those
 * builders unchanged; every value reaches SQL as a bound parameter.
 *
 * Views whose backing columns do not exist yet are declared here with the
 * capabilities they require and are filtered out of the rail until those
 * capabilities are present. They emit no SQL in the meantime.
 *
 * No HTTP routes live here — `GET /staff/inbox/views` and `GET /staff/inbox/list`
 * are a later slice.
 *
 * @module staff-inbox-saved-views
 */

'use strict';

const {
  SUNSET_CLIENT_SLUG,
  normalizeSunsetLocationId,
} = require('./sunset-school-locations');
const {
  buildCustomerListFilterClause,
  buildCustomerListParams,
  buildCustomerListCountsParams,
  clampLimit,
} = require('./staff-customer-queries');
const {
  conversationInboxChannelParamIndex,
  getConversationInboxQuery,
  getConversationInboxCountsQuery,
  CONVERSATION_INBOX_CURSOR_FIELDS,
} = require('./staff-conversation-queries');

const INBOX_VIEW_GROUPS = Object.freeze([
  Object.freeze({ id: 'inbox', label: 'INBOX' }),
  Object.freeze({ id: 'needs_you', label: 'NEEDS YOU' }),
  Object.freeze({ id: 'people', label: 'PEOPLE' }),
]);

const INBOX_VIEW_GROUP_IDS = Object.freeze(INBOX_VIEW_GROUPS.map((g) => g.id));

/** Sort ids describe the ORDER BY already baked into each delegated builder. */
const INBOX_VIEW_SORTS = Object.freeze({
  /** conversations: updated_at DESC, id ASC (newest first; needs_human is filter-only) */
  RECENT: 'recent',
  /** customers: booked DESC, last_contact_at DESC NULLS LAST, phone ASC */
  BOOKED_THEN_RECENT: 'booked_then_recent',
});

const INBOX_VIEW_SOURCES = Object.freeze({
  CONVERSATIONS: 'conversations',
  CUSTOMERS: 'customers',
});

const INBOX_VIEW_CHANNELS = Object.freeze({
  WHATSAPP: 'whatsapp',
  EMAIL: 'email',
});

/**
 * Capabilities a view can require. `pending_migration` names the migration that
 * brings the capability; `database/` is operator-owned, so nothing here creates it.
 */
const INBOX_VIEW_CAPABILITIES = Object.freeze({
  'conversations.assigned_to': Object.freeze({
    label: 'conversations.assigned_to column',
    pending_migration: '082_conversation_read_state.sql',
  }),
  'conversations.last_read_at': Object.freeze({
    label: 'conversations.last_read_at column',
    pending_migration: '082_conversation_read_state.sql',
  }),
  'luna_outbound_approvals': Object.freeze({
    label: 'channel-agnostic outbound approvals table',
    pending_migration: '078_luna_outbound_approvals.sql',
  }),
  'customers.filter.arriving_today': Object.freeze({
    label: 'arriving-today predicate in staff-customer-queries ALLOWED_FILTERS',
    pending_migration: null,
  }),
});

const INBOX_VIEW_CAPABILITY_KEYS = Object.freeze(Object.keys(INBOX_VIEW_CAPABILITIES));

/** Nothing in the list above ships today. */
const DEFAULT_INBOX_VIEW_CAPABILITIES = Object.freeze(
  INBOX_VIEW_CAPABILITY_KEYS.reduce((acc, key) => {
    acc[key] = false;
    return acc;
  }, {}),
);

const UNAVAILABLE_MISSING_CAPABILITY = 'missing_capability';
const UNAVAILABLE_NOT_IMPLEMENTED = 'not_implemented';

const ERROR_UNKNOWN_VIEW = 'unknown_view';
const ERROR_VIEW_UNAVAILABLE = 'view_unavailable';

function declareView(view) {
  return Object.freeze({
    id: view.id,
    label: view.label,
    group: view.group,
    defaultSort: view.defaultSort,
    multiSelect: !!view.multiSelect,
    source: view.source || null,
    crmFilter: view.crmFilter || null,
    channel: view.channel || null,
    needsHuman: !!view.needsHuman,
    /** When false, the view stays queryable for CRM gates but is omitted from the rail. */
    rail: view.rail !== false,
    requires: Object.freeze(view.requires ? view.requires.slice() : []),
    description: view.description || '',
  });
}

const INBOX_SAVED_VIEWS = Object.freeze([
  declareView({
    id: 'all',
    label: 'All',
    group: 'inbox',
    defaultSort: INBOX_VIEW_SORTS.RECENT,
    source: INBOX_VIEW_SOURCES.CONVERSATIONS,
    description: 'Every open or on-hold conversation on this tenant and location.',
  }),
  declareView({
    id: 'whatsapp',
    label: 'WhatsApp',
    group: 'inbox',
    defaultSort: INBOX_VIEW_SORTS.RECENT,
    source: INBOX_VIEW_SOURCES.CONVERSATIONS,
    channel: INBOX_VIEW_CHANNELS.WHATSAPP,
    description: 'Open conversations on the WhatsApp channel.',
  }),
  declareView({
    id: 'email',
    label: 'Email',
    group: 'inbox',
    defaultSort: INBOX_VIEW_SORTS.RECENT,
    source: INBOX_VIEW_SOURCES.CONVERSATIONS,
    channel: INBOX_VIEW_CHANNELS.EMAIL,
    description: 'Open conversations on the email channel.',
  }),
  declareView({
    id: 'snoozed',
    label: 'Snoozed',
    group: 'inbox',
    defaultSort: INBOX_VIEW_SORTS.RECENT,
    requires: ['conversations.last_read_at'],
    description: 'Threads hidden until their snooze expires.',
  }),
  declareView({
    id: 'approvals',
    label: 'Approvals',
    group: 'needs_you',
    defaultSort: INBOX_VIEW_SORTS.RECENT,
    requires: ['luna_outbound_approvals'],
    description: 'Luna drafts waiting for a staff decision, across WhatsApp and email.',
  }),
  declareView({
    id: 'needs_human',
    label: 'Needs human',
    group: 'needs_you',
    defaultSort: INBOX_VIEW_SORTS.RECENT,
    source: INBOX_VIEW_SOURCES.CONVERSATIONS,
    needsHuman: true,
    description: 'Open conversations with conversations.needs_human = TRUE.',
  }),
  declareView({
    id: 'needs_attention',
    label: 'Needs attention',
    group: 'people',
    defaultSort: INBOX_VIEW_SORTS.BOOKED_THEN_RECENT,
    source: INBOX_VIEW_SOURCES.CUSTOMERS,
    crmFilter: 'needs_attention',
    rail: false,
    description: 'CRM people filter (needs_human or open handoff). Hidden from the rail; kept for customer-list gates.',
  }),
  declareView({
    id: 'unassigned',
    label: 'Unassigned',
    group: 'needs_you',
    defaultSort: INBOX_VIEW_SORTS.RECENT,
    requires: ['conversations.assigned_to'],
    description: 'Open threads with no staff owner.',
  }),
  declareView({
    id: 'all_people',
    label: 'All people',
    group: 'people',
    defaultSort: INBOX_VIEW_SORTS.BOOKED_THEN_RECENT,
    multiSelect: true,
    source: INBOX_VIEW_SOURCES.CUSTOMERS,
    crmFilter: 'all',
    description: 'One row per person on this tenant and location.',
  }),
  declareView({
    id: 'checked_in',
    label: 'Checked in',
    group: 'people',
    defaultSort: INBOX_VIEW_SORTS.BOOKED_THEN_RECENT,
    multiSelect: true,
    source: INBOX_VIEW_SOURCES.CUSTOMERS,
    crmFilter: 'checked_in_now',
    description: 'Guests mid-stay tonight. Empty on surf-only tenants.',
  }),
  declareView({
    id: 'arriving_today',
    label: 'Arriving today',
    group: 'people',
    defaultSort: INBOX_VIEW_SORTS.BOOKED_THEN_RECENT,
    multiSelect: true,
    requires: ['customers.filter.arriving_today'],
    description: 'Guests whose stay starts today.',
  }),
  declareView({
    id: 'hot_leads',
    label: 'Hot leads',
    group: 'people',
    defaultSort: INBOX_VIEW_SORTS.BOOKED_THEN_RECENT,
    multiSelect: true,
    source: INBOX_VIEW_SOURCES.CUSTOMERS,
    crmFilter: 'hot_leads',
    description: 'People with a booking or service, or tagged hot_lead by staff.',
  }),
  declareView({
    id: 'warm_leads',
    label: 'Warm leads',
    group: 'people',
    defaultSort: INBOX_VIEW_SORTS.BOOKED_THEN_RECENT,
    multiSelect: true,
    source: INBOX_VIEW_SOURCES.CUSTOMERS,
    crmFilter: 'warm_leads',
    description: 'Contacted but never booked, or tagged warm_lead by staff.',
  }),
  declareView({
    id: 'unpaid',
    label: 'Unpaid',
    group: 'people',
    defaultSort: INBOX_VIEW_SORTS.BOOKED_THEN_RECENT,
    multiSelect: true,
    source: INBOX_VIEW_SOURCES.CUSTOMERS,
    crmFilter: 'unpaid',
    description: 'People with a balance due on a live booking.',
  }),
  declareView({
    id: 'waiver_due',
    label: 'Waiver due',
    group: 'people',
    defaultSort: INBOX_VIEW_SORTS.BOOKED_THEN_RECENT,
    multiSelect: true,
    source: INBOX_VIEW_SOURCES.CUSTOMERS,
    crmFilter: 'waiver_pending',
    description: 'Lesson booked with no completed waiver. Surf tenants only.',
  }),
  declareView({
    id: 'lesson_today',
    label: 'Lesson today',
    group: 'people',
    defaultSort: INBOX_VIEW_SORTS.BOOKED_THEN_RECENT,
    multiSelect: true,
    source: INBOX_VIEW_SOURCES.CUSTOMERS,
    crmFilter: 'lesson_today',
    description: 'People with a service scheduled today.',
  }),
  declareView({
    id: 'upcoming',
    label: 'Upcoming',
    group: 'people',
    defaultSort: INBOX_VIEW_SORTS.BOOKED_THEN_RECENT,
    multiSelect: true,
    source: INBOX_VIEW_SOURCES.CUSTOMERS,
    crmFilter: 'upcoming',
    description: 'People with a service scheduled after today.',
  }),
  declareView({
    id: 'do_not_contact',
    label: 'Do not contact',
    group: 'people',
    defaultSort: INBOX_VIEW_SORTS.BOOKED_THEN_RECENT,
    source: INBOX_VIEW_SOURCES.CUSTOMERS,
    crmFilter: 'do_not_contact',
    description: 'Suppressed from outreach. Never multi-selectable for broadcast.',
  }),
]);

const VIEW_BY_ID = new Map(INBOX_SAVED_VIEWS.map((v) => [v.id, v]));

const INBOX_VIEW_ID_BY_CRM_FILTER = Object.freeze(
  INBOX_SAVED_VIEWS.reduce((acc, v) => {
    if (v.crmFilter) acc[v.crmFilter] = v.id;
    return acc;
  }, {}),
);

function normalizeCapabilities(capabilities) {
  const src = capabilities && typeof capabilities === 'object' ? capabilities : {};
  const out = { ...DEFAULT_INBOX_VIEW_CAPABILITIES };
  for (const key of INBOX_VIEW_CAPABILITY_KEYS) {
    if (src[key] === true) out[key] = true;
  }
  return out;
}

function pendingMigrationsFor(capabilityKeys) {
  const seen = [];
  for (const key of capabilityKeys) {
    const cap = INBOX_VIEW_CAPABILITIES[key];
    const migration = cap && cap.pending_migration;
    if (migration && seen.indexOf(migration) < 0) seen.push(migration);
  }
  return seen;
}

/**
 * @param {object} view
 * @param {object} [capabilities]
 * @returns {{ available: boolean, reason: string|null, missing: string[], pendingMigrations: string[] }}
 */
function resolveInboxViewAvailability(view, capabilities) {
  const caps = normalizeCapabilities(capabilities);
  const missing = (view.requires || []).filter((key) => caps[key] !== true);
  if (missing.length) {
    return {
      available: false,
      reason: UNAVAILABLE_MISSING_CAPABILITY,
      missing,
      pendingMigrations: pendingMigrationsFor(missing),
    };
  }
  if (!view.source) {
    return {
      available: false,
      reason: UNAVAILABLE_NOT_IMPLEMENTED,
      missing: [],
      pendingMigrations: pendingMigrationsFor(view.requires || []),
    };
  }
  return { available: true, reason: null, missing: [], pendingMigrations: [] };
}

function decorateView(view, capabilities) {
  const availability = resolveInboxViewAvailability(view, capabilities);
  return Object.freeze({
    ...view,
    available: availability.available,
    unavailableReason: availability.reason,
    missingCapabilities: Object.freeze(availability.missing),
    pendingMigrations: Object.freeze(availability.pendingMigrations),
  });
}

function groupRank(groupId) {
  const idx = INBOX_VIEW_GROUP_IDS.indexOf(groupId);
  return idx < 0 ? INBOX_VIEW_GROUP_IDS.length : idx;
}

function orderedViews() {
  return INBOX_SAVED_VIEWS
    .map((view, idx) => ({ view, idx }))
    .sort((a, b) => (groupRank(a.view.group) - groupRank(b.view.group)) || (a.idx - b.idx))
    .map((entry) => entry.view);
}

/** Every declared view, including the ones that cannot run yet. */
function listInboxSavedViewDeclarations(opts) {
  const capabilities = opts && opts.capabilities;
  return orderedViews().map((view) => decorateView(view, capabilities));
}

/** Only the views that can run against the schema described by `capabilities`. */
function listInboxSavedViews(opts) {
  return listInboxSavedViewDeclarations(opts).filter((view) => view.available && view.rail !== false);
}

function getInboxSavedViewDeclaration(viewId, opts) {
  const view = typeof viewId === 'string' ? VIEW_BY_ID.get(viewId) : undefined;
  if (!view) return null;
  return decorateView(view, opts && opts.capabilities);
}

/** Sunset partitions by location; other tenants keep a client-wide conversation scope. */
function resolveInboxConversationLocationScope(clientSlug, query) {
  if (String(clientSlug || '').trim() !== SUNSET_CLIENT_SLUG) {
    return { scoped: false, locationId: null };
  }
  return { scoped: true, locationId: normalizeSunsetLocationId(query && query.location) };
}

function buildCustomerSourceQuery(view, clientSlug, query, page) {
  const src = query && typeof query === 'object' ? query : {};
  const built = buildCustomerListParams(
    clientSlug,
    page ? { ...src, filter: view.crmFilter, limit: page.limit } : { ...src, filter: view.crmFilter },
    page ? { keyset: true, cursor: page.cursor || null } : undefined,
  );
  return {
    source: INBOX_VIEW_SOURCES.CUSTOMERS,
    sql: built.sql,
    params: built.params,
    crmFilter: built.filter,
    filterSql: buildCustomerListFilterClause({
      filter: built.filter,
      accommodationCrm: built.accommodationCrm,
      surfCrm: built.surfCrm,
    }),
    channel: null,
    channelParamIndex: null,
    locationScoped: built.locationScoped,
    locationId: built.locationId,
    hasSearch: built.hasSearch,
    limit: built.limit,
    offset: built.offset,
    keyset: !!built.keyset,
    cursorApplied: !!built.cursor,
  };
}

/** $1 slug, optional location, optional channel, then the page size and cursor. */
function conversationPageParamIndexes(locationScoped, channelScoped) {
  let idx = 1;
  if (locationScoped) idx += 1;
  if (channelScoped) idx += 1;
  return { limitParamIndex: idx + 1, cursorParamIndex: idx + 2 };
}

function buildConversationSourceQuery(view, clientSlug, query, page) {
  const scope = resolveInboxConversationLocationScope(clientSlug, query);
  const channelScoped = !!view.channel;
  const needsHumanScoped = !!view.needsHuman;
  const params = [clientSlug];
  if (scope.scoped) params.push(scope.locationId);
  if (channelScoped) params.push(view.channel);

  let keyset = null;
  let limit = null;
  let cursorApplied = false;
  if (page) {
    const cursor = page.cursor || null;
    const indexes = conversationPageParamIndexes(scope.scoped, channelScoped);
    limit = clampLimit(page.limit);
    keyset = {
      limitParamIndex: indexes.limitParamIndex,
      cursorParamIndex: cursor ? indexes.cursorParamIndex : null,
    };
    params.push(limit);
    if (cursor) {
      for (const field of CONVERSATION_INBOX_CURSOR_FIELDS) params.push(cursor[field]);
      cursorApplied = true;
    }
  }

  return {
    source: INBOX_VIEW_SOURCES.CONVERSATIONS,
    sql: getConversationInboxQuery(keyset
      ? { locationScoped: scope.scoped, channelScoped, needsHumanScoped, keyset }
      : { locationScoped: scope.scoped, channelScoped, needsHumanScoped }),
    params,
    crmFilter: null,
    filterSql: '',
    channel: view.channel,
    channelParamIndex: channelScoped ? conversationInboxChannelParamIndex(scope.scoped) : null,
    needsHuman: needsHumanScoped,
    locationScoped: scope.scoped,
    locationId: scope.locationId,
    hasSearch: false,
    limit,
    offset: null,
    keyset: !!keyset,
    cursorApplied,
  };
}

/**
 * Resolve a view id into the SQL and bound parameters of its delegated builder.
 *
 * @param {object} input
 * @param {string} input.view - saved view id
 * @param {string} input.clientSlug - tenant slug, always bound as $1
 * @param {object} [input.query] - list query (location, q, limit, offset)
 * @param {object} [input.capabilities] - schema capabilities present on this deployment
 * @param {{ limit: number, cursor: object|null }} [input.page] - keyset page; absent
 *   keeps the legacy paging of each delegated builder
 * @returns {{ ok: true, view: object, source: string, sql: string, params: Array }
 *   | { ok: false, error: string, viewId: string, reason?: string,
 *       missingCapabilities?: string[], pendingMigrations?: string[] }}
 */
function buildInboxViewQuery(input) {
  const req = input && typeof input === 'object' ? input : {};
  const rawViewId = req.view != null ? req.view : req.viewId;
  const viewId = typeof rawViewId === 'string' ? rawViewId : String(rawViewId == null ? '' : rawViewId);
  const declared = typeof rawViewId === 'string' ? VIEW_BY_ID.get(viewId) : undefined;
  if (!declared) {
    return { ok: false, error: ERROR_UNKNOWN_VIEW, viewId };
  }

  const availability = resolveInboxViewAvailability(declared, req.capabilities);
  if (!availability.available) {
    return {
      ok: false,
      error: ERROR_VIEW_UNAVAILABLE,
      viewId,
      reason: availability.reason,
      missingCapabilities: availability.missing,
      pendingMigrations: availability.pendingMigrations,
    };
  }

  const view = decorateView(declared, req.capabilities);
  const clientSlug = String(req.clientSlug || req.client_slug || '').trim();
  const page = req.page && typeof req.page === 'object' ? req.page : null;
  const built = declared.source === INBOX_VIEW_SOURCES.CUSTOMERS
    ? buildCustomerSourceQuery(declared, clientSlug, req.query, page)
    : buildConversationSourceQuery(declared, clientSlug, req.query, page);

  return {
    ok: true,
    view,
    clientSlug,
    defaultSort: declared.defaultSort,
    multiSelect: declared.multiSelect,
    ...built,
  };
}

/**
 * Rail counts as one aggregate pass per source, not one per view: every
 * customer-source view shares the customer scan and every conversation-source
 * view shares the conversation scan, each view contributing one filtered count
 * column. Both passes come from the delegated builders, so a count is always
 * computed from the same predicate as the view it labels.
 *
 * @param {object} input
 * @param {string} input.clientSlug
 * @param {object} [input.query] - location (and q, which also filters the counts)
 * @param {object} [input.capabilities]
 * @returns {{ views: object[], passes: Array<{ source: string, sql: string,
 *   params: Array, viewIds: string[] }>, queryCount: number }}
 */
function buildInboxViewCountsPlan(input) {
  const req = input && typeof input === 'object' ? input : {};
  const clientSlug = String(req.clientSlug || req.client_slug || '').trim();
  const query = req.query && typeof req.query === 'object' ? req.query : {};
  const views = listInboxSavedViews({ capabilities: req.capabilities });

  const customerViews = views.filter((v) => v.source === INBOX_VIEW_SOURCES.CUSTOMERS);
  const conversationViews = views.filter((v) => v.source === INBOX_VIEW_SOURCES.CONVERSATIONS);
  const passes = [];

  if (customerViews.length) {
    const built = buildCustomerListCountsParams(
      clientSlug,
      query,
      customerViews.map((v) => ({ key: v.id, filter: v.crmFilter })),
    );
    passes.push({
      source: INBOX_VIEW_SOURCES.CUSTOMERS,
      sql: built.sql,
      params: built.params,
      viewIds: customerViews.map((v) => v.id),
      locationScoped: built.locationScoped,
      locationId: built.locationId,
    });
  }

  if (conversationViews.length) {
    const scope = resolveInboxConversationLocationScope(clientSlug, query);
    const columns = conversationViews.map((v) => ({
      key: v.id,
      channel: v.channel,
      needsHuman: !!v.needsHuman,
    }));
    const params = [clientSlug];
    if (scope.scoped) params.push(scope.locationId);
    for (const column of columns) {
      if (column.channel) params.push(column.channel);
    }
    passes.push({
      source: INBOX_VIEW_SOURCES.CONVERSATIONS,
      sql: getConversationInboxCountsQuery({ locationScoped: scope.scoped, columns }),
      params,
      viewIds: conversationViews.map((v) => v.id),
      locationScoped: scope.scoped,
      locationId: scope.locationId,
    });
  }

  return { views, passes, queryCount: passes.length };
}

module.exports = {
  INBOX_SAVED_VIEWS,
  INBOX_VIEW_GROUPS,
  INBOX_VIEW_GROUP_IDS,
  INBOX_VIEW_SORTS,
  INBOX_VIEW_SOURCES,
  INBOX_VIEW_CHANNELS,
  INBOX_VIEW_CAPABILITIES,
  INBOX_VIEW_CAPABILITY_KEYS,
  INBOX_VIEW_ID_BY_CRM_FILTER,
  DEFAULT_INBOX_VIEW_CAPABILITIES,
  UNAVAILABLE_MISSING_CAPABILITY,
  UNAVAILABLE_NOT_IMPLEMENTED,
  ERROR_UNKNOWN_VIEW,
  ERROR_VIEW_UNAVAILABLE,
  listInboxSavedViews,
  listInboxSavedViewDeclarations,
  getInboxSavedViewDeclaration,
  resolveInboxViewAvailability,
  resolveInboxConversationLocationScope,
  buildInboxViewQuery,
  buildInboxViewCountsPlan,
};
