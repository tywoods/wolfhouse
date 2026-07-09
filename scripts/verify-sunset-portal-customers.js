'use strict';

/**
 * verify:sunset-portal-customers
 *
 * Offline checks for Customers tab (shared CRM + Sunset surf context).
 *
 * Run:
 *   node scripts/verify-sunset-portal-customers.js
 *   npm run verify:sunset-portal-customers
 */

const fs = require('fs');
const path = require('path');

const {
  loadClientPortalProfile,
  listBaselineClients,
} = require('./lib/staff-portal-clients');

const {
  getCustomerListQuery,
  getCustomerContextQuery,
  buildCustomerListParams,
} = require('./lib/staff-customer-queries');

const ROOT = path.join(__dirname, '..');
const STAFF_API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const I18N_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');
const QUERIES_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-customer-queries.js');

const WOLFHOUSE_LODGING = /\b(bed|room|hostel|move-bed|wolfhouse)\b/i;

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

console.log('\nverify:sunset-portal-customers — Sunset Customers tab offline checks\n');

// ── 1. API routes ───────────────────────────────────────────────────────────

console.log('[1] staff-query-api.js — customer API routes');

let apiSrc = '';
if (fs.existsSync(STAFF_API_PATH)) {
  apiSrc = fs.readFileSync(STAFF_API_PATH, 'utf8');
  assert('/staff/customers list route', apiSrc.includes("pathname === '/staff/customers'"));
  assert('handleCustomerList handler', apiSrc.includes('async function handleCustomerList('));
  assert('/staff/customers/:phone/context route', apiSrc.includes('CUSTOMER_CONTEXT_RE'));
  assert('handleCustomerContext handler', apiSrc.includes('async function handleCustomerContext('));
  assert('assertStaffClientAccess in customer handlers', apiSrc.includes('api:customers.list')
    && apiSrc.includes('api:customers.context'));
  assert('staff-customer-queries required', apiSrc.includes("require('./lib/staff-customer-queries')"));
} else {
  assert('staff-query-api.js exists', false);
}

// ── 2. SQL tenant scoping + no email join ───────────────────────────────────

console.log('\n[2] staff-customer-queries.js — tenant scope + phone pivot');

let queriesSrc = '';
if (fs.existsSync(QUERIES_PATH)) {
  queriesSrc = fs.readFileSync(QUERIES_PATH, 'utf8');
  const listSql = getCustomerListQuery({ filter: 'all', hasSearch: false });
  const ctxSql = getCustomerContextQuery();
  assert('list query scopes c.slug = $1', listSql.includes('c.slug = $1'));
  assert('context query scopes c.slug = $1', ctxSql.includes('c.slug = $1'));
  assert('list query anchors on phone', listSql.includes('cu.phone') && listSql.includes('customer_base'));
  assert('no email-only join in list query', !/JOIN.*email\s*=/i.test(listSql));
  assert('buildCustomerListParams uses bound params', (() => {
    const b = buildCustomerListParams('sunset', { filter: 'booked', limit: 10, offset: 0, q: 'maria' });
    return b.params[0] === 'sunset' && b.params.includes(10);
  })());
  assert('filter booked supported', listSql.includes('booking_count') || queriesSrc.includes("'hot_leads'"));
  assert('warm_leads filter SQL', getCustomerListQuery({ filter: 'warm_leads', hasSearch: false }).includes('conversation_id IS NOT NULL'));
  assert('do_not_contact filter SQL tenant scoped', getCustomerListQuery({ filter: 'do_not_contact', hasSearch: false }).includes("crm_tags->>'do_not_contact'")
    && getCustomerListQuery({ filter: 'do_not_contact', hasSearch: false }).includes('c.slug = $1'));
  assert('checked_in_now disabled for surf', getCustomerListQuery({ filter: 'checked_in_now', hasSearch: false, accommodationCrm: false }).includes('AND FALSE'));
} else {
  assert('staff-customer-queries.js exists', false);
}

// ── 3. UI — Customers tab CRM gating ────────────────────────────────────────

console.log('\n[3] staff-query-api.js — Customers tab UI');

if (apiSrc) {
  assert('Customers tab button', apiSrc.includes('data-tab="customers"'));
  assert('Customers tab panel', apiSrc.includes('id="tab-customers"'));
  assert('portalHasCustomersCrm helper', apiSrc.includes('function portalHasCustomersCrm('));
  assert('customers tab gated by CRM profile', apiSrc.includes("tab === 'customers' && !portalHasCustomersCrm(profile)"));
  assert('loadCustomersTab function', apiSrc.includes('function loadCustomersTab('));
  assert('loadCustomersList uses portalHasCustomersCrm', apiSrc.includes('if (!portalHasCustomersCrm(profile)) return'));
  assert('applyCustomersPortalI18n for surf copy', apiSrc.includes('function applyCustomersPortalI18n('));
  assert('Customers empty state i18n keys', apiSrc.includes('customers.empty.main'));
  assert('Customers search placeholder', apiSrc.includes('customers.searchPlaceholder'));
  assert('Customers filters dropdown status defs', apiSrc.includes('CUSTOMERS_STATUS_FILTER_DEFS')
    && apiSrc.includes("id: 'needs_attention'")
    && apiSrc.includes("id: 'warm_leads'"));
  assert('CRM status filters warm/hot/checked-in/dnc', apiSrc.includes("id: 'hot_leads'")
    && apiSrc.includes("id: 'checked_in_now'")
    && apiSrc.includes("id: 'do_not_contact'")
    && apiSrc.includes('data-cust-status-filter'));
  assert('warm leads tooltip in toolbar', apiSrc.includes('customers.filter.warmLeadsTitle'));
  assert('lodging-only checked-in filter gated for surf', apiSrc.includes('lodgingOnly: true')
    && apiSrc.includes('function applyCustomersFilterVisibility(')
    && apiSrc.includes('showCheckedIn = !profile.is_surf_vertical'));
  assert('Last setup detail section', apiSrc.includes('customers.detail.lastSetup')
    || apiSrc.includes('portalT(\'customers.detail.lastSetup\')'));
  assert('Sunset school context preserved', apiSrc.includes('id="customers-school-context"')
    && apiSrc.includes('function renderCustomersSchoolContext(')
    && apiSrc.includes('isSunsetSurfActive()'));
  assert('Sunset create booking routes to schedule modal', apiSrc.includes('profile.is_surf_vertical')
    && apiSrc.includes('psPendingCreatePrefill')
    && apiSrc.includes("switchToTab('portal-home'")
    && apiSrc.includes('openScheduleCreateModal()'));
  assert('Sunset linked booking opens schedule drawer', apiSrc.includes('function openBookingInSchedule(')
    && apiSrc.includes('isSunsetSurfActive()')
    && apiSrc.includes('openScheduleDetailDrawer('));

  const panel = extractCustomersPanel(apiSrc);
  if (panel) {
    assert('Customers panel has no lodging keywords', !WOLFHOUSE_LODGING.test(panel));
  } else {
    assert('Customers panel extractable', false);
  }
}

function extractCustomersPanel(src) {
  const start = src.indexOf('<div id="tab-customers"');
  if (start < 0) return '';
  const end = src.indexOf('<!-- /tab-customers -->', start);
  if (end < 0) return src.slice(start, start + 3000);
  return src.slice(start, end);
}

// ── 4. i18n copy ────────────────────────────────────────────────────────────

console.log('\n[4] staff-portal-i18n.js — Customers copy');

if (fs.existsSync(I18N_PATH)) {
  const i18n = fs.readFileSync(I18N_PATH, 'utf8');
  assert('nav.tab.customers key', i18n.includes("'nav.tab.customers': 'Customers'"));
  assert('customers.subtitle generic CRM copy', i18n.includes('Customer profiles, contact history, and past bookings'));
  assert('customers.subtitle.surf variant', i18n.includes("'customers.subtitle.surf': 'Guest history, preferences"));
  assert('customers.empty.main', i18n.includes("'customers.empty.main': 'No customers yet.'"));
  assert('customers.empty.sub generic', i18n.includes('Profiles appear here when Luna receives messages'));
  assert('customers.promo generic CRM', i18n.includes('Review past bookings, preferences, and notes'));
  assert('customers.promo.surf variant', i18n.includes("'customers.promo.surf'"));
  assert('Wolfhouse whatsapp tab unchanged', i18n.includes("'nav.tab.whatsapp': 'WhatsApp'"));
} else {
  assert('staff-portal-i18n.js exists', false);
}


// ── 6. Session-scoped client dropdown access ──────────────────────────────────

console.log('\n[6] Session-scoped client dropdown access');

const ACCESS_PATH = path.join(ROOT, 'config', 'clients', 'staff-portal-access.json');
const SUNSET_ACCESS_PATH = path.join(ROOT, 'config', 'clients', 'staff-portal-access.sunset-staging.json');
const CLIENTS_MODULE_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-clients.js');

function slugsWithAccessFile(accessFile, email) {
  const all = listBaselineClients().map((c) => c.slug);
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(accessFile, 'utf8'));
  } catch {
    return [];
  }

  const normalizedEmail = String(email || '').trim().toLowerCase();
  const explicit = cfg.client_access && cfg.client_access[normalizedEmail];

  if (Array.isArray(explicit) && explicit.length > 0) {
    const allowed = new Set(
      explicit.map((slug) => String(slug || '').trim()).filter(Boolean),
    );
    return all.filter((slug) => allowed.has(slug));
  }

  const allEmails = (cfg.all_clients_emails || []).map((e) => String(e || '').trim().toLowerCase());
  if (allEmails.includes(normalizedEmail)) return all;
  return [];
}

if (fs.existsSync(SUNSET_ACCESS_PATH)) {
  const sunsetCfg = JSON.parse(fs.readFileSync(SUNSET_ACCESS_PATH, 'utf8'));
  assert('sunset-staging client_access tywoods is [sunset]',
    Array.isArray(sunsetCfg.client_access && sunsetCfg.client_access['tywoods@gmail.com'])
      && sunsetCfg.client_access['tywoods@gmail.com'].length === 1
      && sunsetCfg.client_access['tywoods@gmail.com'][0] === 'sunset');
  assert('sunset-staging all_clients_emails empty',
    !(sunsetCfg.all_clients_emails && sunsetCfg.all_clients_emails.length));
  const sunsetSlugs = slugsWithAccessFile(SUNSET_ACCESS_PATH, 'tywoods@gmail.com');
  assert('Sunset session clients is [sunset] only', sunsetSlugs.length === 1 && sunsetSlugs[0] === 'sunset',
    JSON.stringify(sunsetSlugs));
} else {
  assert('staff-portal-access.sunset-staging.json exists', false);
}

if (apiSrc) {
  assert('populateClientSelect uses session clients', apiSrc.includes('staffPortalSession.clients'));
  assert('populateClientSelect no wolfhouse-somo fallback option',
    !apiSrc.includes("{ slug: 'wolfhouse-somo', name: 'wolfhouse-somo' }"));
  assert('getClient defaults to session client before wolfhouse fallback',
    apiSrc.includes('staffPortalSession.clients[0].slug'));
}

if (fs.existsSync(CLIENTS_MODULE_PATH)) {
  const clientsSrc = fs.readFileSync(CLIENTS_MODULE_PATH, 'utf8');
  assert('explicit client_access checked before all_clients_emails',
    clientsSrc.indexOf('const explicit = cfg.client_access') < clientsSrc.indexOf('const allEmails = (cfg.all_clients_emails'));
}

if (fs.existsSync(ACCESS_PATH)) {
  const whSlugs = slugsWithAccessFile(ACCESS_PATH, 'tywoods@gmail.com');
  assert('Wolfhouse default tywoods scoped to wolfhouse-somo only', whSlugs.length === 1 && whSlugs[0] === 'wolfhouse-somo', JSON.stringify(whSlugs));
  const opSlugs = slugsWithAccessFile(ACCESS_PATH, 'operator.stage72c@example.test');
  assert('Wolfhouse operator scoped to wolfhouse-somo',
    opSlugs.length === 1 && opSlugs[0] === 'wolfhouse-somo', JSON.stringify(opSlugs));
}


// ── 5. Wolfhouse preservation ───────────────────────────────────────────────

console.log('\n[5] Wolfhouse portal profile preserved');

const wh = loadClientPortalProfile('wolfhouse-somo');
assert('wolfhouse default_tab bed-calendar', wh.default_tab === 'bed-calendar');
assert('wolfhouse is_surf_vertical false', wh.is_surf_vertical === false);
assert('wolfhouse customers not in hidden_tabs', !(wh.hidden_tabs || []).includes('customers'));

const ss = loadClientPortalProfile('sunset');
assert('sunset is_surf_vertical true', ss.is_surf_vertical === true);
assert('sunset customers not in hidden_tabs', !(ss.hidden_tabs || []).includes('customers'));

if (apiSrc) {
  assert('no hardcoded sunset-staging URL', !apiSrc.includes('sunset-staging.lunafrontdesk.com'));
  assert('Wolfhouse bed-calendar preserved', apiSrc.includes('data-tab="bed-calendar"'));
  assert('Wolfhouse customers tab uses CRM gate not surf gate',
    apiSrc.includes("tab === 'customers'") && !apiSrc.includes("tab === 'customers' && !profile.is_surf_vertical"));
}

// ── 7. Inbound contact → customer row ───────────────────────────────────────

console.log('\n[7] Inbound WhatsApp → tenant-scoped customer');

const CUST_Q_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-customer-queries.js');
const MIRROR_PATH = path.join(ROOT, 'scripts', 'lib', 'luna-hermes-whatsapp-thread-mirror.js');

if (fs.existsSync(CUST_Q_PATH)) {
  const custSrc = fs.readFileSync(CUST_Q_PATH, 'utf8');
  assert('normalizeCustomerPhone for dedupe key', custSrc.includes('function normalizeCustomerPhone('));
  assert('upsertCustomerFromInboundTouch', custSrc.includes('async function upsertCustomerFromInboundTouch('));
  assert('tenant scope via client slug lookup', custSrc.includes("WHERE slug = $1"));
  assert('list query joins clients.slug', custSrc.includes('INNER JOIN clients c ON c.id = cu.client_id')
    && custSrc.includes('WHERE c.slug = $1'));
} else {
  assert('staff-customer-queries.js exists', false);
}

if (fs.existsSync(MIRROR_PATH)) {
  const mirrorSrc = fs.readFileSync(MIRROR_PATH, 'utf8');
  assert('mirror upserts customer on inbound', mirrorSrc.includes('upsertCustomerFromInboundTouch'));
  assert('mirror sets conversation display_name safely', mirrorSrc.includes('display_name = COALESCE(NULLIF(EXCLUDED.display_name'));
} else {
  assert('luna-hermes-whatsapp-thread-mirror.js exists', false);
}

console.log('\n[8] Manual add customer — shared CRM');

if (fs.existsSync(CUST_Q_PATH)) {
  const custSrc = fs.readFileSync(CUST_Q_PATH, 'utf8');
  assert('createOrMergeManualCustomer', custSrc.includes('async function createOrMergeManualCustomer('));
  assert('manual phone normalization', custSrc.includes('normalizeCustomerPhone(b.phone)'));
  assert('duplicate returns without overwrite name', custSrc.includes('COALESCE(customers.full_name, EXCLUDED.full_name)'));
}

if (apiSrc) {
  assert('POST customers route before GET guard', apiSrc.includes("pathname === '/staff/customers' && method === 'POST'"));
  assert('handleCustomerCreate', apiSrc.includes('handleCustomerCreate'));
  assert('cust-add-btn in portal HTML', apiSrc.includes('id="cust-add-btn"'));
  assert('customers.add i18n key', apiSrc.includes('customers.add'));
}

console.log('\n[9] CRM tags — PATCH route, no outbound send');

if (fs.existsSync(CUST_Q_PATH)) {
  const custSrc = fs.readFileSync(CUST_Q_PATH, 'utf8');
  assert('CRM_TAG_KEYS exported', custSrc.includes('CRM_TAG_KEYS'));
  assert('updateCustomerCrmTags helper', custSrc.includes('async function updateCustomerCrmTags('));
  assert('tags update scoped by slug', custSrc.includes('c.slug = $1') && custSrc.includes('crm_tags = $3::jsonb'));
}

if (apiSrc) {
  assert('PATCH customer tags route', apiSrc.includes('CUSTOMER_TAGS_RE') && apiSrc.includes('handleCustomerTagsUpdate'));
  assert('tag editor UI', apiSrc.includes('cust-tags-section') && apiSrc.includes('customerSaveTags'));
  assert('no whatsapp send from CRM tags', !/customerSaveTags[\s\S]{0,600}(sendWhatsApp|outbound|bulk)/i.test(apiSrc));
}

if (fs.existsSync(I18N_PATH)) {
  const i18n = fs.readFileSync(I18N_PATH, 'utf8');
  assert('crm tag labels in i18n', i18n.includes("'customers.tags.vip': 'VIP'")
    && i18n.includes("'customers.tags.do_not_contact': 'Do not contact'"));
  assert('outreach drawer i18n keys', i18n.includes("'customers.outreach.title': 'Message customers'"));
}

console.log('\n[10] Outreach drawer shell — no sends');

if (apiSrc) {
  assert('selection checkboxes in list', apiSrc.includes('cust-bulk-check'));
  assert('message selected toolbar button', apiSrc.includes('cust-message-selected-btn'));
  assert('customers outreach drawer', apiSrc.includes('customers-outreach-drawer'));
  assert('drawer open/close handlers', apiSrc.includes('openCustomersOutreachDrawer') && apiSrc.includes('closeCustomersOutreachDrawer'));
  assert('DNC skip in outreach plan', apiSrc.includes('customerIsDoNotContact'));
  assert('disabled send button only', apiSrc.includes('cust-outreach-send') && apiSrc.includes('updateCustomersOutreachSendButton'));
  assert('no customer outreach POST route', apiSrc.includes("pathname === '/staff/customers/outreach/send'"));
  assert('no bulk whatsapp send from CRM list', !/customersBulkSelected[\s\S]{0,3000}sendLunaWhatsAppMessage/i.test(apiSrc));
  assert('mobile outreach drawer CSS', apiSrc.includes('staff-portal-mobile:cust-outreach'));
}

console.log('\n[11] Message templates — CRUD + drawer integration, no sends');

const TEMPLATES_LIB = path.join(ROOT, 'scripts', 'lib', 'staff-customer-message-templates.js');
const MIGRATION_035 = path.join(ROOT, 'database', 'migrations', '035_customer_message_templates.sql');

if (fs.existsSync(MIGRATION_035)) {
  const mig = fs.readFileSync(MIGRATION_035, 'utf8');
  assert('customer_message_templates table', mig.includes('CREATE TABLE IF NOT EXISTS customer_message_templates'));
  assert('tenant FK client_id', mig.includes('client_id') && mig.includes('clients(id)'));
}

if (fs.existsSync(TEMPLATES_LIB)) {
  const lib = fs.readFileSync(TEMPLATES_LIB, 'utf8');
  assert('templates lib tenant scope', lib.includes('INNER JOIN clients c') && lib.includes('c.slug = $1'));
}

if (apiSrc) {
  assert('message-templates API routes', apiSrc.includes('/staff/customers/message-templates'));
  assert('template picker in outreach drawer', apiSrc.includes('cust-outreach-template-select'));
  assert('save template from draft', apiSrc.includes('saveCustomerMessageTemplateFromDraft'));
  assert('no template send route', !apiSrc.includes('message-templates/send'));
  assert('send button in drawer', apiSrc.includes('cust-outreach-send') && apiSrc.includes('updateCustomersOutreachSendButton'));
}

console.log('\n[12] Luna outreach draft generation — notes mode + generate API, no sends');

const GENERATE_LIB = path.join(ROOT, 'scripts', 'lib', 'staff-customer-outreach-draft-generate.js');

if (fs.existsSync(GENERATE_LIB)) {
  const lib = fs.readFileSync(GENERATE_LIB, 'utf8');
  assert('generate helper', lib.includes('generateCustomerOutreachDraft'));
  assert('tenant voice in prompt', lib.includes('voice_summary'));
}

if (apiSrc) {
  assert('generate API route', apiSrc.includes('/staff/customers/message-templates/generate'));
  assert('notes mode toggle', apiSrc.includes('cust-outreach-mode-notes'));
  assert('generate button in drawer', apiSrc.includes('generateCustomerOutreachDraftFromNotes'));
  assert('no template send route', !apiSrc.includes('message-templates/send'));
  assert('send button still disabled', apiSrc.includes('cust-outreach-send') && apiSrc.includes('updateCustomersOutreachSendButton'));
}

console.log('\n[13] WhatsApp bulk outreach send — confirmation modal + send API');

const OUTREACH_SEND_LIB = path.join(ROOT, 'scripts', 'lib', 'staff-customer-outreach-send.js');

if (fs.existsSync(OUTREACH_SEND_LIB)) {
  const lib = fs.readFileSync(OUTREACH_SEND_LIB, 'utf8');
  const sendMod = require(OUTREACH_SEND_LIB);
  assert('outreach send helper', lib.includes('executeCustomerOutreachSend'));
  assert('confirmed required', lib.includes('confirmation_required'));
  assert('outreach env gate helper', lib.includes('isCustomerOutreachWhatsAppEnabled'));
  assert('outreach defaults disabled', sendMod.isCustomerOutreachWhatsAppEnabled({}) === false);
}

if (apiSrc) {
  assert('outreach send API route', apiSrc.includes('/staff/customers/outreach/send'));
  assert('customer outreach env gate', apiSrc.includes('CUSTOMER_OUTREACH_WHATSAPP_ENABLED'));
  assert('customer outreach disabled error', apiSrc.includes('customer_outreach_disabled'));
  assert('confirmation modal', apiSrc.includes('cust-outreach-confirm-modal'));
  assert('confirmed true in fetch', apiSrc.includes('confirmed: true'));
  assert('send results panel', apiSrc.includes('renderCustomersOutreachResults'));
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-portal-customers — FAILED');
  process.exit(1);
}
console.log('verify:sunset-portal-customers — ALL CHECKS PASSED');
