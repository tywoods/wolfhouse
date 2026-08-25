'use strict';

/**
 * verify:inbox-saved-views
 *
 * Offline checks for the Inbox saved-view query layer (scripts/lib/staff-inbox-saved-views.js).
 * No database, no network, no browser.
 *
 * Run:
 *   node scripts/verify-inbox-saved-views.js
 */

const fs = require('fs');
const path = require('path');

const {
  INBOX_SAVED_VIEWS,
  INBOX_VIEW_GROUPS,
  INBOX_VIEW_GROUP_IDS,
  INBOX_VIEW_SORTS,
  INBOX_VIEW_SOURCES,
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
} = require('./lib/staff-inbox-saved-views');

const {
  ALLOWED_FILTERS,
  buildCustomerListParams,
  buildCustomerListFilterClause,
  getCustomerListQuery,
  isAccommodationCrmClient,
} = require('./lib/staff-customer-queries');

const {
  getConversationInboxQuery,
  getConversationInboxCountsQuery,
  conversationInboxChannelParamIndex,
  CONVERSATION_INBOX_CURSOR_FIELDS,
  isEmailInboundSubjectSchemaError,
} = require('./lib/staff-conversation-queries');

const ROOT = path.join(__dirname, '..');
const VIEWS_MODULE_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-inbox-saved-views.js');
const VIEWS_MODULE_SRC = fs.readFileSync(VIEWS_MODULE_PATH, 'utf8');
const VIEWS_MODULE_CODE = VIEWS_MODULE_SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const SUNSET = 'sunset';
const WOLFHOUSE = 'wolfhouse-somo';

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

function allCapabilitiesOn() {
  const caps = {};
  for (const key of INBOX_VIEW_CAPABILITY_KEYS) caps[key] = true;
  return caps;
}

function paramIndexes(sql) {
  const found = new Set();
  const re = /\$(\d+)/g;
  let m = re.exec(sql);
  while (m) {
    found.add(Number(m[1]));
    m = re.exec(sql);
  }
  return found;
}

console.log('\nverify:inbox-saved-views — saved-view query layer offline checks\n');

console.log('[1] Registry shape — ids, groups, sorts, multi-select');

const declarations = listInboxSavedViewDeclarations();
const ids = declarations.map((v) => v.id);

assert('registry is frozen', Object.isFrozen(INBOX_SAVED_VIEWS));
assert('view ids unique', new Set(ids).size === ids.length, ids.join(','));
assert('groups are INBOX / NEEDS YOU / PEOPLE',
  INBOX_VIEW_GROUP_IDS.join(',') === 'inbox,needs_you,people');
assert('every group has a rail label', INBOX_VIEW_GROUPS.every((g) => !!g.label));
assert('every view declares id, label, group, defaultSort',
  declarations.every((v) => v.id && v.label && v.group && v.defaultSort));
assert('every view group is known',
  declarations.every((v) => INBOX_VIEW_GROUP_IDS.indexOf(v.group) >= 0));
assert('every view sort is a declared sort',
  declarations.every((v) => Object.values(INBOX_VIEW_SORTS).indexOf(v.defaultSort) >= 0));
assert('every view declares multiSelect as boolean',
  declarations.every((v) => typeof v.multiSelect === 'boolean'));
assert('declarations ordered by rail group',
  declarations.map((v) => INBOX_VIEW_GROUP_IDS.indexOf(v.group))
    .every((rank, i, arr) => i === 0 || arr[i - 1] <= rank));

for (const specLabel of [
  'Approvals', 'Needs human', 'Unassigned',
  'All', 'WhatsApp', 'Email', 'Snoozed',
  'Checked in', 'Arriving today', 'Hot leads', 'Warm leads', 'Unpaid', 'Waiver due',
]) {
  assert(`spec rail view present: ${specLabel}`, declarations.some((v) => v.label === specLabel));
}

assert('people views support broadcast multi-select',
  declarations.filter((v) => v.group === 'people' && v.available && v.rail !== false && v.id !== 'do_not_contact')
    .every((v) => v.multiSelect === true));
assert('do_not_contact is never multi-selectable',
  getInboxSavedViewDeclaration('do_not_contact').multiSelect === false);
assert('needs_attention CRM view stays off the rail',
  getInboxSavedViewDeclaration('needs_attention').rail === false
  && !listInboxSavedViews().some((v) => v.id === 'needs_attention'));
assert('needs_human is a conversation view on the Needs you rail',
  getInboxSavedViewDeclaration('needs_human').source === INBOX_VIEW_SOURCES.CONVERSATIONS
  && getInboxSavedViewDeclaration('needs_human').needsHuman === true
  && getInboxSavedViewDeclaration('needs_human').group === 'needs_you'
  && getInboxSavedViewDeclaration('needs_human').crmFilter == null
  && listInboxSavedViews().some((v) => v.id === 'needs_human'));
assert('conversation views are not multi-selectable',
  declarations.filter((v) => v.source === INBOX_VIEW_SOURCES.CONVERSATIONS)
    .every((v) => v.multiSelect === false));
assert('customer-source views declare the customer list sort',
  declarations.filter((v) => v.source === INBOX_VIEW_SOURCES.CUSTOMERS)
    .every((v) => v.defaultSort === INBOX_VIEW_SORTS.BOOKED_THEN_RECENT));
assert('conversation-source views declare the recent-first sort',
  declarations.filter((v) => v.source === INBOX_VIEW_SOURCES.CONVERSATIONS)
    .every((v) => v.defaultSort === INBOX_VIEW_SORTS.RECENT));

console.log('\n[2] Delegation — the registry restates no filter SQL');

assert('module requires staff-customer-queries',
  /require\('\.\/staff-customer-queries'\)/.test(VIEWS_MODULE_SRC));
assert('module requires staff-conversation-queries',
  /require\('\.\/staff-conversation-queries'\)/.test(VIEWS_MODULE_SRC));
assert('module calls buildCustomerListParams', VIEWS_MODULE_SRC.includes('buildCustomerListParams('));
assert('module calls buildCustomerListFilterClause', VIEWS_MODULE_SRC.includes('buildCustomerListFilterClause('));
assert('module calls getConversationInboxQuery', VIEWS_MODULE_SRC.includes('getConversationInboxQuery('));
assert('module does not restate crm_tags predicates', !VIEWS_MODULE_CODE.includes("crm_tags->>"));
assert('module does not restate booking/service aggregates',
  !VIEWS_MODULE_CODE.includes('booking_count') && !VIEWS_MODULE_CODE.includes('service_count'));
assert('module does not restate balance/waiver predicates',
  !VIEWS_MODULE_CODE.includes('has_balance_due') && !VIEWS_MODULE_CODE.includes('waiver_pending, FALSE'));
assert('module writes no SELECT of its own', !/\bSELECT\b/.test(VIEWS_MODULE_CODE));
assert('module wires no HTTP routes',
  !VIEWS_MODULE_CODE.includes('/staff/inbox/')
  && !/require\('\.\.\/staff-query-api'\)/.test(VIEWS_MODULE_CODE)
  && !/\brouter\b|\bcreateServer\b|\breq\.method\b/.test(VIEWS_MODULE_CODE));

console.log('\n[3] SQL equivalence — all ten ALLOWED_FILTERS through the registry');

const allowed = Array.from(ALLOWED_FILTERS).sort();
assert('ALLOWED_FILTERS still has ten values', allowed.length === 10, allowed.join(','));
assert('every ALLOWED_FILTERS value maps to a view',
  allowed.every((f) => !!INBOX_VIEW_ID_BY_CRM_FILTER[f]),
  allowed.filter((f) => !INBOX_VIEW_ID_BY_CRM_FILTER[f]).join(','));
assert('no view claims a filter outside ALLOWED_FILTERS',
  Object.keys(INBOX_VIEW_ID_BY_CRM_FILTER).every((f) => ALLOWED_FILTERS.has(f)));
assert('each filter is owned by exactly one view',
  new Set(Object.values(INBOX_VIEW_ID_BY_CRM_FILTER)).size === allowed.length);

/** Golden text of the ten predicates as they stand today, per CRM vertical. */
const GOLDEN_FILTER_SQL = {
  all: { lodging: '', surf: '' },
  hot_leads: {
    lodging: `AND (
      COALESCE(ba.booking_count, 0) > 0
      OR COALESCE(sa.service_count, 0) > 0
      OR COALESCE((crm.crm_tags->>'hot_lead')::boolean, FALSE) = TRUE
    )`,
  },
  warm_leads: {
    lodging: `AND (
      COALESCE((crm.crm_tags->>'warm_lead')::boolean, FALSE) = TRUE
      OR (
        (lc.conversation_id IS NOT NULL OR lc.last_contact_at IS NOT NULL)
        AND COALESCE(ba.booking_count, 0) = 0
        AND COALESCE(sa.service_count, 0) = 0
      )
    )`,
  },
  checked_in_now: { lodging: 'AND COALESCE(cia.checked_in_now, FALSE) = TRUE', surf: 'AND FALSE' },
  do_not_contact: { lodging: "AND COALESCE((crm.crm_tags->>'do_not_contact')::boolean, FALSE) = TRUE" },
  needs_attention: { lodging: 'AND (lc.needs_human OR COALESCE(ho.has_open_handoff, FALSE))' },
  lesson_today: { lodging: 'AND COALESCE(sa.has_service_today, FALSE) = TRUE' },
  upcoming: { lodging: 'AND COALESCE(sa.has_future_service, FALSE) = TRUE' },
  unpaid: { lodging: 'AND COALESCE(ba.has_balance_due, FALSE) = TRUE' },
  waiver_pending: { lodging: 'AND FALSE', surf: 'AND COALESCE(wp.waiver_pending, FALSE) = TRUE' },
};

for (const crmFilter of allowed) {
  const viewId = INBOX_VIEW_ID_BY_CRM_FILTER[crmFilter];
  const golden = GOLDEN_FILTER_SQL[crmFilter];
  for (const [vertical, clientSlug] of [['lodging', WOLFHOUSE], ['surf', SUNSET]]) {
    const expected = golden[vertical] != null ? golden[vertical] : golden.lodging;
    const built = buildInboxViewQuery({ view: viewId, clientSlug, query: {} });
    assert(`${viewId} (${vertical}): predicate matches the golden fragment`,
      built.ok === true && built.filterSql === expected,
      JSON.stringify(built.filterSql));
    assert(`${viewId} (${vertical}): predicate lands inside the delegated SQL`,
      built.ok === true && (expected === '' ? true : built.sql.includes(expected)));
  }
}

const EQUIVALENCE_QUERIES = [
  { label: 'bare', clientSlug: WOLFHOUSE, query: {} },
  { label: 'search', clientSlug: WOLFHOUSE, query: { q: 'mar%ia_lopez' } },
  { label: 'paged', clientSlug: WOLFHOUSE, query: { limit: 7, offset: 21 } },
  { label: 'surf tenant', clientSlug: SUNSET, query: {} },
  { label: 'surf tenant + location', clientSlug: SUNSET, query: { location: 'sunset-sardinero' } },
  { label: 'surf tenant + location + search + page', clientSlug: SUNSET, query: { location: 'sunset-somo', q: 'wolf', limit: 3, offset: 9 } },
];

let equivalenceChecked = 0;
let equivalenceMismatch = 0;

for (const crmFilter of allowed) {
  const viewId = INBOX_VIEW_ID_BY_CRM_FILTER[crmFilter];
  for (const scenario of EQUIVALENCE_QUERIES) {
    const legacy = buildCustomerListParams(scenario.clientSlug, { ...scenario.query, filter: crmFilter });
    const built = buildInboxViewQuery({
      view: viewId,
      clientSlug: scenario.clientSlug,
      query: scenario.query,
    });
    const sqlSame = built.ok === true && built.sql === legacy.sql;
    const paramsSame = built.ok === true
      && JSON.stringify(built.params) === JSON.stringify(legacy.params);
    equivalenceChecked++;
    if (!sqlSame || !paramsSame) {
      equivalenceMismatch++;
      console.error(`        ${crmFilter} / ${scenario.label}: sql=${sqlSame} params=${paramsSame}`);
    }
  }
  const spot = buildInboxViewQuery({ view: viewId, clientSlug: WOLFHOUSE, query: {} });
  const accommodationCrm = isAccommodationCrmClient(WOLFHOUSE);
  const independent = getCustomerListQuery({
    filter: crmFilter,
    hasSearch: false,
    locationScoped: false,
    accommodationCrm,
    surfCrm: !accommodationCrm,
  });
  assert(`${crmFilter} → view ${viewId}: SQL identical to getCustomerListQuery`,
    spot.ok === true && spot.sql === independent);
  assert(`${crmFilter} → view ${viewId}: filter fragment delegated`,
    spot.ok === true
    && spot.filterSql === buildCustomerListFilterClause({ filter: crmFilter, accommodationCrm, surfCrm: !accommodationCrm })
    && (spot.filterSql === '' || spot.sql.includes(spot.filterSql)));
  assert(`${crmFilter} → view ${viewId}: registry keeps the normalized filter`,
    spot.ok === true && spot.crmFilter === crmFilter);
}

assert(`byte-identical SQL and params across ${equivalenceChecked} filter/query combinations`,
  equivalenceMismatch === 0, `${equivalenceMismatch} mismatches`);

const bookedAlias = buildInboxViewQuery({ view: 'hot_leads', clientSlug: WOLFHOUSE, query: { filter: 'booked' } });
assert('caller-supplied filter cannot override the view',
  bookedAlias.ok === true
  && bookedAlias.crmFilter === 'hot_leads'
  && bookedAlias.sql === buildCustomerListParams(WOLFHOUSE, { filter: 'hot_leads' }).sql);

const surfWaiver = buildInboxViewQuery({ view: 'waiver_due', clientSlug: SUNSET, query: {} });
assert('waiver_due keeps the surf-only waiver aggregate',
  surfWaiver.ok === true && surfWaiver.sql.includes('waiver_pending_agg'));
const lodgingWaiver = buildInboxViewQuery({ view: 'waiver_due', clientSlug: WOLFHOUSE, query: {} });
assert('waiver_due stays empty on a lodging tenant',
  lodgingWaiver.ok === true && lodgingWaiver.filterSql === 'AND FALSE');
const surfCheckedIn = buildInboxViewQuery({ view: 'checked_in', clientSlug: SUNSET, query: {} });
assert('checked_in stays empty on a surf tenant',
  surfCheckedIn.ok === true && surfCheckedIn.filterSql === 'AND FALSE');
const lodgingCheckedIn = buildInboxViewQuery({ view: 'checked_in', clientSlug: WOLFHOUSE, query: {} });
assert('checked_in uses the stay-dates aggregate on a lodging tenant',
  lodgingCheckedIn.ok === true
  && lodgingCheckedIn.filterSql === 'AND COALESCE(cia.checked_in_now, FALSE) = TRUE');

console.log('\n[4] Conversation views — delegated inbox SQL plus parameterized channel');

const convAll = buildInboxViewQuery({ view: 'all', clientSlug: WOLFHOUSE, query: {} });
assert('inbox All delegates to getConversationInboxQuery unchanged',
  convAll.ok === true && convAll.sql === getConversationInboxQuery({}));
assert('default inbox All still uses inbound subject tables',
  /tenant_email_inbound_events/.test(convAll.sql)
  && /tenant_email_inbound_inbox_projections/.test(convAll.sql));
const convAllNoEmail = buildInboxViewQuery({
  view: 'all', clientSlug: WOLFHOUSE, query: {}, includeEmailSubject: false,
});
assert('inbox All without email tables omits inbound subject SQL',
  convAllNoEmail.ok === true
  && convAllNoEmail.sql === getConversationInboxQuery({ includeEmailSubject: false })
  && !/tenant_email_inbound_/.test(convAllNoEmail.sql)
  && /NULL::text\s+AS email_subject/.test(convAllNoEmail.sql));
{
  const missing = new Error('relation "tenant_email_inbound_inbox_projections" does not exist');
  missing.code = '42P01';
  const denied = new Error('permission denied for table tenant_email_inbound_events');
  denied.code = '42501';
  const other = new Error('column conv.display_name does not exist');
  other.code = '42703';
  assert('missing email inbound relation is a subject-schema error',
    isEmailInboundSubjectSchemaError(missing) === true);
  assert('email inbound permission denied is a subject-schema error',
    isEmailInboundSubjectSchemaError(denied) === true);
  assert('unrelated column errors are not subject-schema errors',
    isEmailInboundSubjectSchemaError(other) === false);
}
assert('inbox list sorts newest-first (updated_at DESC); needs_human is not a pin',
  /ORDER BY\s+conv\.updated_at DESC\s*,\s*conv\.id ASC/i.test(convAll.sql.replace(/\s+/g, ' '))
  && !/ORDER BY[\s\S]*needs_human\s+DESC/i.test(convAll.sql)
  && !/handoff_priority_rank/i.test(convAll.sql));
assert('conversation cursor is recency + id only',
  CONVERSATION_INBOX_CURSOR_FIELDS.join(',') === 'last_activity,conversation_id');
const convAllSunset = buildInboxViewQuery({ view: 'all', clientSlug: SUNSET, query: { location: 'sunset-sardinero' } });
assert('inbox All (sunset) delegates to the location-scoped query',
  convAllSunset.ok === true && convAllSunset.sql === getConversationInboxQuery({ locationScoped: true }));

for (const [viewId, channel] of [['whatsapp', 'whatsapp'], ['email', 'email']]) {
  for (const clientSlug of [WOLFHOUSE, SUNSET]) {
    const built = buildInboxViewQuery({ view: viewId, clientSlug, query: {} });
    const scoped = clientSlug === SUNSET;
    const base = getConversationInboxQuery({ locationScoped: scoped });
    const idx = conversationInboxChannelParamIndex(scoped);
    const channelLine = `\n  AND COALESCE(conv.metadata->>'channel', conv.session_state->>'channel', 'whatsapp') = $${idx}`;
    assert(`${viewId} view (${clientSlug}): base inbox SQL plus one channel predicate`,
      built.ok === true && built.sql.replace(channelLine, '') === base);
    assert(`${viewId} view (${clientSlug}): channel bound as $${idx}, never interpolated`,
      built.ok === true
      && built.channelParamIndex === idx
      && built.params[idx - 1] === channel
      && built.sql.includes(`= $${idx}`)
      && !built.sql.includes(`session_state->>'channel', 'whatsapp') = '${channel}'`));
  }
}

assert('channel addition leaves the legacy inbox query byte-identical',
  getConversationInboxQuery({}) === getConversationInboxQuery({ channelScoped: false })
  && !getConversationInboxQuery({ locationScoped: true }).includes("session_state->>'channel', 'whatsapp') = $"));

const needsHumanBuilt = buildInboxViewQuery({ view: 'needs_human', clientSlug: WOLFHOUSE, query: {} });
assert('needs_human list SQL scopes to conversations.needs_human = TRUE',
  needsHumanBuilt.ok === true
  && needsHumanBuilt.needsHuman === true
  && needsHumanBuilt.sql.includes('conv.needs_human = TRUE')
  && needsHumanBuilt.sql === getConversationInboxQuery({ needsHumanScoped: true }));
const needsHumanSunset = buildInboxViewQuery({
  view: 'needs_human', clientSlug: SUNSET, query: { location: 'sunset-sardinero' },
});
assert('needs_human (sunset) keeps location scope and the needs_human predicate',
  needsHumanSunset.ok === true
  && needsHumanSunset.locationScoped === true
  && needsHumanSunset.sql === getConversationInboxQuery({ locationScoped: true, needsHumanScoped: true })
  && needsHumanSunset.sql.includes('conv.needs_human = TRUE'));
assert('needs_human does not bind a channel param',
  needsHumanBuilt.channelParamIndex == null
  && needsHumanBuilt.params.length === 1
  && needsHumanSunset.params.length === 2);
assert('legacy inbox All is unchanged when needsHumanScoped is off',
  getConversationInboxQuery({}) === getConversationInboxQuery({ needsHumanScoped: false })
  && !getConversationInboxQuery({}).includes('conv.needs_human = TRUE'));

const countsPlan = buildInboxViewCountsPlan({ clientSlug: WOLFHOUSE, query: {} });
const convPass = countsPlan.passes.find((p) => p.source === INBOX_VIEW_SOURCES.CONVERSATIONS);
assert('rail counts include a needs_human FILTER column',
  !!convPass
  && convPass.viewIds.includes('needs_human')
  && /COUNT\(\*\) FILTER \(WHERE conv\.needs_human = TRUE\)::int AS "needs_human"/.test(convPass.sql));
assert('needs_attention is not counted on the rail',
  !countsPlan.views.some((v) => v.id === 'needs_attention')
  && countsPlan.passes.every((p) => !p.viewIds.includes('needs_attention')));
assert('getConversationInboxCountsQuery accepts needsHuman columns',
  getConversationInboxCountsQuery({
    columns: [
      { key: 'all', channel: null },
      { key: 'needs_human', channel: null, needsHuman: true },
    ],
  }).includes('FILTER (WHERE conv.needs_human = TRUE)'));

console.log('\n[5] Tenant and location scoping on every available view');

const availableViews = listInboxSavedViews();
assert('at least one view per group is available',
  INBOX_VIEW_GROUP_IDS.every((g) => availableViews.some((v) => v.group === g)));

const HOSTILE_SLUG = "sunset'; DROP TABLE customers;--";

for (const view of availableViews) {
  const built = buildInboxViewQuery({ view: view.id, clientSlug: HOSTILE_SLUG, query: { location: 'sunset-sardinero' } });
  assert(`${view.id}: tenant scoped by clients.slug = $1`,
    built.ok === true && built.sql.includes('c.slug = $1'));
  assert(`${view.id}: tenant slug bound, never interpolated`,
    built.ok === true && built.params[0] === HOSTILE_SLUG && !built.sql.includes('DROP TABLE'));

  const sunsetBuilt = buildInboxViewQuery({ view: view.id, clientSlug: SUNSET, query: { location: 'sunset-sardinero' } });
  assert(`${view.id}: sunset location bound as $2`,
    sunsetBuilt.ok === true
    && sunsetBuilt.locationScoped === true
    && sunsetBuilt.locationId === 'sunset-sardinero'
    && sunsetBuilt.params[1] === 'sunset-sardinero'
    && sunsetBuilt.sql.includes('= $2'));
  assert(`${view.id}: unknown location falls back to the default school`,
    buildInboxViewQuery({ view: view.id, clientSlug: SUNSET, query: { location: 'not-a-school' } }).locationId === 'sunset-somo');

  const wolfBuilt = buildInboxViewQuery({ view: view.id, clientSlug: WOLFHOUSE, query: { location: 'sunset-sardinero' } });
  assert(`${view.id}: non-sunset tenant ignores the location param`,
    wolfBuilt.ok === true
    && wolfBuilt.locationScoped === false
    && wolfBuilt.params.indexOf('sunset-sardinero') < 0);
}

const sunsetConvScope = resolveInboxConversationLocationScope(SUNSET, {});
assert('sunset conversations stay location-scoped without an explicit location',
  sunsetConvScope.scoped === true && sunsetConvScope.locationId === 'sunset-somo');
assert('non-sunset conversations are client-wide',
  resolveInboxConversationLocationScope(WOLFHOUSE, { location: 'sunset-somo' }).scoped === false);

const customerLocationSql = buildInboxViewQuery({ view: 'all_people', clientSlug: SUNSET, query: { location: 'sunset-sardinero' } }).sql;
assert('customer views keep booking and service location scoping',
  customerLocationSql.includes("COALESCE(b.metadata->>'location_id', 'sunset-somo') = $2")
  && customerLocationSql.includes("COALESCE(cu.location_id, 'sunset-somo') = $2")
  && customerLocationSql.includes("COALESCE(conv.metadata->>'location_id', 'sunset-somo') = $2"));

console.log('\n[6] Parameter-index correctness');

const PARAM_SCENARIOS = [
  { label: 'bare / lodging', clientSlug: WOLFHOUSE, query: {} },
  { label: 'search / lodging', clientSlug: WOLFHOUSE, query: { q: 'wolf' } },
  { label: 'location / surf', clientSlug: SUNSET, query: { location: 'sunset-sardinero' } },
  { label: 'location + search / surf', clientSlug: SUNSET, query: { location: 'sunset-somo', q: 'wolf', limit: 5, offset: 10 } },
];

for (const view of availableViews) {
  for (const scenario of PARAM_SCENARIOS) {
    const built = buildInboxViewQuery({ view: view.id, clientSlug: scenario.clientSlug, query: scenario.query });
    const used = paramIndexes(built.sql);
    const maxIdx = used.size ? Math.max(...used) : 0;
    const contiguous = Array.from({ length: maxIdx }, (_, i) => i + 1).every((i) => used.has(i));
    assert(`${view.id} / ${scenario.label}: params match placeholders ($1..$${maxIdx})`,
      built.ok === true && contiguous && built.params.length === maxIdx,
      `placeholders=${maxIdx} params=${built.params.length}`);
    assert(`${view.id} / ${scenario.label}: no undefined or null bound values`,
      built.params.every((p) => p !== undefined && p !== null));
  }
}

const searchBuilt = buildInboxViewQuery({ view: 'all_people', clientSlug: SUNSET, query: { location: 'sunset-somo', q: 'ma%_x', limit: 4, offset: 8 } });
assert('search term is escaped and bound after the location param',
  searchBuilt.params[2] === '%ma\\%\\_x%' && searchBuilt.sql.includes('ILIKE $3'));
assert('limit and offset are bound as the last two params',
  searchBuilt.params[3] === 4
  && searchBuilt.params[4] === 8
  && searchBuilt.sql.includes('LIMIT $4 OFFSET $5'));

console.log('\n[7] Declared-but-unavailable views');

const EXPECTED_UNAVAILABLE = {
  approvals: '078_luna_outbound_approvals.sql',
  unassigned: '082_conversation_read_state.sql',
  snoozed: '082_conversation_read_state.sql',
  arriving_today: null,
};

assert('default capabilities declare nothing present',
  INBOX_VIEW_CAPABILITY_KEYS.every((k) => DEFAULT_INBOX_VIEW_CAPABILITIES[k] === false));
assert('capability catalog covers every requirement',
  INBOX_SAVED_VIEWS.every((v) => v.requires.every((k) => !!INBOX_VIEW_CAPABILITIES[k])));

const unavailable = listInboxSavedViewDeclarations().filter((v) => !v.available);
assert('exactly the expected views are unavailable',
  unavailable.map((v) => v.id).sort().join(',') === Object.keys(EXPECTED_UNAVAILABLE).sort().join(','),
  unavailable.map((v) => v.id).join(','));

for (const [viewId, migration] of Object.entries(EXPECTED_UNAVAILABLE)) {
  const decl = getInboxSavedViewDeclaration(viewId);
  assert(`${viewId}: still declared in the rail`, !!decl && !!decl.label && !!decl.group);
  assert(`${viewId}: marked unavailable with a named capability`,
    decl.available === false
    && decl.unavailableReason === UNAVAILABLE_MISSING_CAPABILITY
    && decl.missingCapabilities.length > 0);
  assert(`${viewId}: pending migration reported as ${migration || 'none'}`,
    (decl.pendingMigrations[0] || null) === migration);
  assert(`${viewId}: hidden from the available rail`,
    !listInboxSavedViews().some((v) => v.id === viewId));

  const built = buildInboxViewQuery({ view: viewId, clientSlug: SUNSET, query: {} });
  assert(`${viewId}: build refused with view_unavailable`,
    built.ok === false
    && built.error === ERROR_VIEW_UNAVAILABLE
    && built.reason === UNAVAILABLE_MISSING_CAPABILITY
    && built.missingCapabilities.length > 0);
  assert(`${viewId}: no SQL and no params emitted`,
    built.sql === undefined && built.params === undefined);
}

assert('082 columns back Unassigned and Snoozed',
  getInboxSavedViewDeclaration('unassigned').missingCapabilities.includes('conversations.assigned_to')
  && getInboxSavedViewDeclaration('snoozed').missingCapabilities.includes('conversations.last_read_at'));

const forced = allCapabilitiesOn();
for (const viewId of Object.keys(EXPECTED_UNAVAILABLE)) {
  const decl = getInboxSavedViewDeclaration(viewId, { capabilities: forced });
  assert(`${viewId}: still unimplemented when the capability is declared present`,
    decl.available === false && decl.unavailableReason === UNAVAILABLE_NOT_IMPLEMENTED);
  const built = buildInboxViewQuery({ view: viewId, clientSlug: SUNSET, query: {}, capabilities: forced });
  assert(`${viewId}: forced capability still emits no SQL`,
    built.ok === false && built.reason === UNAVAILABLE_NOT_IMPLEMENTED && built.sql === undefined);
}

const everySql = []
  .concat(listInboxSavedViews({ capabilities: forced }).map((v) => buildInboxViewQuery({
    view: v.id, clientSlug: SUNSET, query: { location: 'sunset-somo' }, capabilities: forced,
  }).sql))
  .filter(Boolean)
  .join('\n');
assert('no emitted SQL references columns migration 082 has not added yet',
  !everySql.includes('assigned_to') && !everySql.includes('last_read_at') && !everySql.includes('snooze'));
assert('no emitted SQL references the 078 approvals table',
  !everySql.includes('luna_outbound_approvals'));
assert('availability resolver is pure data, not a throw',
  resolveInboxViewAvailability(getInboxSavedViewDeclaration('snoozed'), {}).available === false
  && resolveInboxViewAvailability(getInboxSavedViewDeclaration('hot_leads'), {}).available === true);

console.log('\n[8] Unknown view ids are rejected');

for (const bogus of ['', '   ', 'nope', 'ALL', 'hot_leads ', "all'; DROP TABLE conversations;--", null, undefined, 42, {}]) {
  const built = buildInboxViewQuery({ view: bogus, clientSlug: SUNSET, query: {} });
  assert(`rejects view id ${JSON.stringify(bogus)}`,
    built.ok === false && built.error === ERROR_UNKNOWN_VIEW && built.sql === undefined);
}
assert('rejects a missing input object entirely',
  buildInboxViewQuery().ok === false && buildInboxViewQuery().error === ERROR_UNKNOWN_VIEW);
assert('unknown declaration lookup returns null',
  getInboxSavedViewDeclaration('nope') === null && getInboxSavedViewDeclaration('') === null);
assert('prototype keys are not views',
  getInboxSavedViewDeclaration('constructor') === null
  && getInboxSavedViewDeclaration('__proto__') === null);

console.log('\n[9] UI rail wiring — GET /staff/inbox/views and list?view=');

const VIEWS_UI_PATH = path.join(ROOT, 'scripts', 'browser', 'inbox-views.js');
const VIEWS_UI_SRC = fs.existsSync(VIEWS_UI_PATH) ? fs.readFileSync(VIEWS_UI_PATH, 'utf8') : '';
assert('inbox-views.js exists', fs.existsSync(VIEWS_UI_PATH));
assert('rail fetches /staff/inbox/views with inboxClientQuery()',
  VIEWS_UI_SRC.includes("'/staff/inbox/views' + inboxClientQuery()"));
assert('list fetch includes view=',
  VIEWS_UI_SRC.includes("'/staff/inbox/list' + inboxClientQuery()")
  && VIEWS_UI_SRC.includes("'&view=' + encodeURIComponent("));
assert('rail does not fan out to /staff-state',
  !VIEWS_UI_SRC.includes('/staff-state') && !VIEWS_UI_SRC.includes('staff_state'));
assert('rail does not dump /staff/conversations for counts',
  !VIEWS_UI_SRC.includes('/staff/conversations'));

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:inbox-saved-views — FAILED');
  process.exit(1);
}
console.log('verify:inbox-saved-views — ALL CHECKS PASSED');
process.exit(0);
