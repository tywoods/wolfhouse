'use strict';

/**
 * verify:staff-customers-crm
 *
 * Offline checks for shared Customers CRM tab visibility and copy.
 *
 * Run:
 *   node scripts/verify-staff-customers-crm.js
 */

const fs = require('fs');
const path = require('path');

const { loadClientPortalProfile } = require('./lib/staff-portal-clients');

const ROOT = path.join(__dirname, '..');
const STAFF_API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const I18N_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js');

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

console.log('\nverify:staff-customers-crm — shared Customers CRM offline checks\n');

let apiSrc = '';
if (fs.existsSync(STAFF_API_PATH)) {
  apiSrc = fs.readFileSync(STAFF_API_PATH, 'utf8');
} else {
  assert('staff-query-api.js exists', false);
}

console.log('[1] Portal profiles — CRM access defaults');

const wh = loadClientPortalProfile('wolfhouse-somo');
const ss = loadClientPortalProfile('sunset');
assert('Wolfhouse lodging vertical', wh.vertical === 'lodging_surf_house');
assert('Sunset surf vertical', ss.is_surf_vertical === true);
assert('Wolfhouse customers tab not hidden', !(wh.hidden_tabs || []).includes('customers'));
assert('Sunset customers tab not hidden', !(ss.hidden_tabs || []).includes('customers'));

console.log('\n[2] staff-query-api.js — CRM tab visibility');

if (apiSrc) {
  assert('portalHasCustomersCrm defined', apiSrc.includes('function portalHasCustomersCrm('));
  assert('applyClientPortalProfile shows customers via CRM gate',
    apiSrc.includes('portalHasCustomersCrm(profile) ? \'\' : \'none\'')
    && apiSrc.includes("if (tab === 'customers')"));
  assert('isTabHiddenForClient uses CRM gate',
    apiSrc.includes("tab === 'customers' && !portalHasCustomersCrm(profile)"));
  assert('no surf-only customers tab gate',
    !apiSrc.includes("tab === 'customers' && !profile.is_surf_vertical"));
  assert('generic CRM HTML subtitle default',
    apiSrc.includes('Customer profiles, contact history, and past bookings'));
  assert('portalT used in customers list', apiSrc.includes("portalT('customers.empty.sub')"));
  assert('school context still sunset surf only', apiSrc.includes('function isSunsetSurfActive()')
    && apiSrc.includes('function renderCustomersSchoolContext('));
}

console.log('\n[3] staff-portal-i18n.js — generic + surf copy');

if (fs.existsSync(I18N_PATH)) {
  const i18n = fs.readFileSync(I18N_PATH, 'utf8');
  assert('generic customers.subtitle', i18n.includes('Customer profiles, contact history, and past bookings'));
  assert('surf customers.subtitle.surf', i18n.includes("'customers.subtitle.surf'"));
  assert('generic customers.detail.select', i18n.includes('Select a customer to view their profile'));
  assert('surf customers.detail.select.surf', i18n.includes("'customers.detail.select.surf'"));
  assert('generic customers.detail.services', i18n.includes("'customers.detail.services': 'Previous services'"));
  assert('surf customers.detail.services.surf', i18n.includes("'customers.detail.services.surf'"));
} else {
  assert('staff-portal-i18n.js exists', false);
}

console.log('\n[4] Inbound WhatsApp → tenant-scoped customer upsert');

const CUST_Q_PATH = path.join(ROOT, 'scripts', 'lib', 'staff-customer-queries.js');
const MIRROR_PATH = path.join(ROOT, 'scripts', 'lib', 'luna-hermes-whatsapp-thread-mirror.js');

if (fs.existsSync(CUST_Q_PATH)) {
  const custSrc = fs.readFileSync(CUST_Q_PATH, 'utf8');
  assert('normalizeCustomerPhone helper', custSrc.includes('function normalizeCustomerPhone('));
  assert('upsertCustomerFromInboundTouch helper', custSrc.includes('async function upsertCustomerFromInboundTouch('));
  assert('customer dedupe ON CONFLICT (client_id, phone)', custSrc.includes('ON CONFLICT (client_id, phone)'));
  assert('display name preserved on upsert', custSrc.includes('COALESCE(EXCLUDED.full_name, customers.full_name)'));
  assert('client resolved by slug only', custSrc.includes("WHERE slug = $1"));
  assert('customer list scoped by clients.slug', custSrc.includes('WHERE c.slug = $1'));
} else {
  assert('staff-customer-queries.js exists', false);
}

if (fs.existsSync(MIRROR_PATH)) {
  const mirrorSrc = fs.readFileSync(MIRROR_PATH, 'utf8');
  assert('Hermes mirror calls inbound customer upsert', mirrorSrc.includes('upsertCustomerFromInboundTouch(pg'));
  assert('Hermes mirror uses shared phone normalization', mirrorSrc.includes('normalizeCustomerPhone'));
  assert('conversation display_name safe merge on conflict',
    mirrorSrc.includes('display_name = COALESCE(NULLIF(EXCLUDED.display_name'));
  assert('inbound path is guest_whatsapp_inbound', mirrorSrc.includes("'guest_whatsapp_inbound'"));
} else {
  assert('luna-hermes-whatsapp-thread-mirror.js exists', false);
}

if (apiSrc) {
  assert('whatsapp-thread-mirror route wired', apiSrc.includes('handleBotHermesWhatsAppThreadMirror')
    && apiSrc.includes('mirrorHermesWhatsAppThreadMessage'));
}

console.log('\n[5] Manual add customer — POST /staff/customers');

if (fs.existsSync(CUST_Q_PATH)) {
  const custSrc = fs.readFileSync(CUST_Q_PATH, 'utf8');
  assert('parseManualCustomerCreateBody helper', custSrc.includes('function parseManualCustomerCreateBody('));
  assert('createOrMergeManualCustomer helper', custSrc.includes('async function createOrMergeManualCustomer('));
  assert('manual create requires name', custSrc.includes("'name is required'"));
  assert('manual create requires phone', custSrc.includes("'phone is required'"));
  assert('manual dedupe ON CONFLICT (client_id, phone)', custSrc.includes('ON CONFLICT (client_id, phone)'));
  assert('manual duplicate preserves existing name', custSrc.includes('COALESCE(customers.full_name, EXCLUDED.full_name)'));
  assert('manual create scoped by client slug', custSrc.includes("WHERE slug = $1"));
}

if (apiSrc) {
  assert('POST /staff/customers route', apiSrc.includes("pathname === '/staff/customers' && method === 'POST'"));
  assert('handleCustomerCreate handler', apiSrc.includes('async function handleCustomerCreate('));
  assert('customers.create audit intent', apiSrc.includes("intent: 'api:customers.create'"));
  assert('create uses assertStaffClientAccess', apiSrc.includes('createOrMergeManualCustomer')
    && /handleCustomerCreate[\s\S]{0,800}assertStaffClientAccess/.test(apiSrc));
  assert('Add customer button in UI', apiSrc.includes('id="cust-add-btn"'));
  assert('Add customer form fields', apiSrc.includes('id="cust-add-name"') && apiSrc.includes('id="cust-add-phone"'));
  assert('submitCustomerAdd POST fetch', apiSrc.includes("method: 'POST'")
    && apiSrc.includes('submitCustomerAdd'));
  assert('after create loads customer detail', apiSrc.includes('loadCustomerDetail(newPhone)'));
}

console.log('\n[6] CRM filters, tags, and no-send guarantee');

if (fs.existsSync(CUST_Q_PATH)) {
  const custSrc = fs.readFileSync(CUST_Q_PATH, 'utf8');
  const {
    normalizeCustomerFilter,
    getCustomerListQuery,
    CRM_TAG_KEYS,
  } = require('./lib/staff-customer-queries');

  assert('CRM_TAG_KEYS includes lead and do_not_contact',
    CRM_TAG_KEYS.includes('lead') && CRM_TAG_KEYS.includes('do_not_contact'));
  assert('normalizeCustomerFilter warm_leads', normalizeCustomerFilter('warm_leads') === 'warm_leads');
  assert('normalizeCustomerFilter hot_leads', normalizeCustomerFilter('hot_leads') === 'hot_leads');
  assert('normalizeCustomerFilter booked alias → hot_leads', normalizeCustomerFilter('booked') === 'hot_leads');
  assert('normalizeCustomerFilter checked_in_now', normalizeCustomerFilter('checked_in_now') === 'checked_in_now');
  assert('normalizeCustomerFilter do_not_contact', normalizeCustomerFilter('do_not_contact') === 'do_not_contact');

  const warmSql = getCustomerListQuery({ filter: 'warm_leads', hasSearch: false });
  const hotSql = getCustomerListQuery({ filter: 'hot_leads', hasSearch: false });
  const dncSql = getCustomerListQuery({ filter: 'do_not_contact', hasSearch: false });
  const checkedLodgingSql = getCustomerListQuery({ filter: 'checked_in_now', hasSearch: false, accommodationCrm: true });
  const checkedSurfSql = getCustomerListQuery({ filter: 'checked_in_now', hasSearch: false, accommodationCrm: false });

  assert('warm_leads requires contact without bookings', warmSql.includes('conversation_id IS NOT NULL')
    && warmSql.includes('booking_count, 0) = 0'));
  assert('hot_leads requires bookings or services', hotSql.includes('booking_count, 0) > 0'));
  assert('do_not_contact uses crm_tags', dncSql.includes("crm_tags->>'do_not_contact'"));
  assert('checked_in_now uses stay dates for lodging', checkedLodgingSql.includes('checked_in_agg')
    && checkedLodgingSql.includes('check_in <= CURRENT_DATE'));
  assert('checked_in_now empty for surf vertical', checkedSurfSql.includes('AND FALSE'));
  assert('list filters tenant-scoped', warmSql.includes('c.slug = $1') && dncSql.includes('c.slug = $1'));
  assert('updateCustomerCrmTags scoped by client slug', custSrc.includes('async function updateCustomerCrmTags(')
    && custSrc.includes('c.slug = $1'));
}

if (fs.existsSync(I18N_PATH)) {
  const i18n = fs.readFileSync(I18N_PATH, 'utf8');
  assert('warm leads filter label', i18n.includes("'customers.filter.warmLeads': 'Warm Leads'"));
  assert('warm leads tooltip', i18n.includes("'customers.filter.warmLeadsTitle': 'Contacted but never booked'"));
  assert('hot leads filter label', i18n.includes("'customers.filter.hotLeads': 'Hot Leads'"));
  assert('checked in now filter', i18n.includes("'customers.filter.checkedInNow': 'Checked In Now'"));
  assert('do not contact filter', i18n.includes("'customers.filter.doNotContact': 'Do Not Contact'"));
  assert('crm tag keys in i18n', i18n.includes("'customers.tags.lead': 'Lead'")
    && i18n.includes("'customers.tags.newsletter_ok': 'Newsletter OK'"));
}

if (apiSrc) {
  assert('warm_leads filter pebble', apiSrc.includes('data-cust-filter="warm_leads"'));
  assert('hot_leads filter pebble', apiSrc.includes('data-cust-filter="hot_leads"'));
  assert('checked_in_now lodging-only pebble', apiSrc.includes('data-cust-filter="checked_in_now"')
    && apiSrc.includes('customers-filter-lodging-only'));
  assert('do_not_contact filter pebble', apiSrc.includes('data-cust-filter="do_not_contact"'));
  assert('warm leads tooltip title attr', apiSrc.includes('data-i18n-title="customers.filter.warmLeadsTitle"'));
  assert('PATCH /staff/customers/:phone/tags route', apiSrc.includes('CUSTOMER_TAGS_RE')
    && apiSrc.includes('handleCustomerTagsUpdate'));
  assert('customers.tags audit intent', apiSrc.includes("intent: 'api:customers.tags'"));
  assert('tag checkboxes in detail', apiSrc.includes('data-crm-tag') && apiSrc.includes('cust-tags-save'));
  assert('applyCustomersFilterVisibility for surf', apiSrc.includes('function applyCustomersFilterVisibility('));
  assert('no bulk send in customers tab', !/tab-customers[\s\S]{0,8000}bulk[\s_-]?send/i.test(apiSrc));
}

console.log('\n[7] Outreach drawer shell — selection UI, no sends');

if (apiSrc) {
  assert('bulk selection checkboxes', apiSrc.includes('cust-bulk-check') && apiSrc.includes('customers-card-check'));
  assert('selected count toolbar', apiSrc.includes('id="cust-selected-count"') && apiSrc.includes('updateCustomersBulkSelectionUI'));
  assert('message selected button', apiSrc.includes('id="cust-message-selected-btn"'));
  assert('outreach drawer shell', apiSrc.includes('id="customers-outreach-drawer"') && apiSrc.includes('cust-outreach-backdrop'));
  assert('drawer recipients + warnings', apiSrc.includes('buildCustomersOutreachPlan') && apiSrc.includes('skippedDnc'));
  assert('drawer message textarea', apiSrc.includes('cust-outreach-message'));
  assert('template picker in drawer', apiSrc.includes('cust-outreach-template-select') && apiSrc.includes('loadCustomerMessageTemplates'));
  assert('apply template to message', apiSrc.includes('applyCustomerMessageTemplateBody'));
  assert('save draft as template', apiSrc.includes('saveCustomerMessageTemplateFromDraft'));
  assert('send button disabled shell', apiSrc.includes('id="cust-outreach-send"') && apiSrc.includes('customers.outreach.sendDisabled'));
  assert('mobile bottom sheet CSS marker', apiSrc.includes('staff-portal-mobile:cust-outreach'));
  assert('no outreach send API route', !apiSrc.includes('/staff/customers/outreach') && !apiSrc.includes('handleCustomerOutreachSend'));
  assert('no outreach send fetch', !apiSrc.includes("'/staff/customers/outreach")
    && !/saveCustomerMessageTemplateFromDraft[\s\S]{0,400}message-templates\/send/i.test(apiSrc));
  assert('no whatsapp send helper in outreach', !/wireCustomersOutreachDrawer[\s\S]{0,2500}sendWhatsApp/i.test(apiSrc)
    && !/loadCustomerMessageTemplates[\s\S]{0,2500}(sendMeta|graph\.facebook)/i.test(apiSrc));
  assert('tag save still PATCH only', apiSrc.includes("'/tags?client='"));
}

console.log('\n[8] Message templates — schema, CRUD, tenant scope, no sends');

const TEMPLATES_LIB = path.join(ROOT, 'scripts', 'lib', 'staff-customer-message-templates.js');
const MIGRATION_035 = path.join(ROOT, 'database', 'migrations', '035_customer_message_templates.sql');

if (fs.existsSync(MIGRATION_035)) {
  const mig = fs.readFileSync(MIGRATION_035, 'utf8');
  assert('035 migration exists', mig.includes('customer_message_templates'));
  assert('migration client_id FK', mig.includes('client_id') && mig.includes('REFERENCES clients(id)'));
  assert('migration template fields', mig.includes('title') && mig.includes('body') && mig.includes('channel'));
  assert('migration tags jsonb', mig.includes('tags') && mig.includes('JSONB'));
  assert('migration active default', mig.includes('active') && mig.includes('DEFAULT TRUE'));
} else {
  assert('035_customer_message_templates.sql exists', false);
}

if (fs.existsSync(TEMPLATES_LIB)) {
  const lib = fs.readFileSync(TEMPLATES_LIB, 'utf8');
  assert('list templates scoped by slug', lib.includes('c.slug = $1') && lib.includes('listCustomerMessageTemplates'));
  assert('create uses client_id', lib.includes('client_id') && lib.includes('createCustomerMessageTemplate'));
  assert('update scoped by slug + id', lib.includes('updateCustomerMessageTemplate') && lib.includes('c.slug = $1'));
  assert('soft delete active=false', lib.includes('deactivateCustomerMessageTemplate') && lib.includes('active: false'));
}

if (apiSrc) {
  assert('GET message-templates route', apiSrc.includes("pathname === '/staff/customers/message-templates' && method === 'GET'"));
  assert('POST message-templates route', apiSrc.includes("pathname === '/staff/customers/message-templates' && method === 'POST'"));
  assert('PATCH message-templates route', apiSrc.includes('CUSTOMER_MESSAGE_TEMPLATE_RE') && apiSrc.includes('handleCustomerMessageTemplateUpdate'));
  assert('DELETE message-templates route', apiSrc.includes('handleCustomerMessageTemplateDelete'));
  assert('templates list audit intent', apiSrc.includes("intent: 'api:customers.message_templates.list'"));
  assert('templates use assertStaffClientAccess', /handleCustomerMessageTemplatesList[\s\S]{0,400}assertStaffClientAccess/.test(apiSrc));
  assert('drawer delete template UI', apiSrc.includes('cust-template-delete'));
  assert('no template send endpoint', !apiSrc.includes('message-templates/send') && !apiSrc.includes('handleCustomerMessageTemplateSend'));
}

if (fs.existsSync(I18N_PATH)) {
  const i18n = fs.readFileSync(I18N_PATH, 'utf8');
  assert('template apply label', i18n.includes("'customers.templates.apply': 'Apply'"));
  assert('template save as label', i18n.includes("'customers.templates.saveAs': 'Save as template'"));
}

const MIGRATION_PATH = path.join(ROOT, 'database', 'migrations', '034_customers_crm_tags.sql');
assert('crm_tags migration file exists', fs.existsSync(MIGRATION_PATH));
if (fs.existsSync(MIGRATION_PATH)) {
  const mig = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert('migration adds crm_tags jsonb', mig.includes('crm_tags') && mig.includes('JSONB'));
}

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:staff-customers-crm — FAILED');
  process.exit(1);
}
console.log('verify:staff-customers-crm — ALL CHECKS PASSED');
