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
  assert('wolfhouse-somo slug in CRM gate', apiSrc.includes("slug === 'wolfhouse-somo'"));
  assert('CRM gate uses profile client slug', apiSrc.includes('profile.client_slug || profile.slug || getClient()'));
}

console.log('\n[2b] portalHasCustomersCrm — gate behavior');

function portalHasCustomersCrmForVerify(profile, clientSlug) {
  profile = profile || {};
  if (!profile) return false;
  if (profile.customers_crm === false) return false;
  if (profile.customers_crm === true) return true;
  const hidden = profile.hidden_tabs || [];
  if (hidden.indexOf('customers') >= 0) return false;
  const slug = String(profile.client_slug || profile.slug || clientSlug || '');
  return !!profile.is_surf_vertical || slug === 'wolfhouse-somo';
}

assert('Wolfhouse customers CRM gate true by default',
  portalHasCustomersCrmForVerify(wh, 'wolfhouse-somo') === true);
assert('Sunset surf vertical still shows Customers',
  portalHasCustomersCrmForVerify(ss, 'sunset') === true);
assert('explicit customers_crm:false hides Customers',
  portalHasCustomersCrmForVerify({ ...wh, customers_crm: false }, 'wolfhouse-somo') === false);
assert('hidden_tabs customers hides Customers',
  portalHasCustomersCrmForVerify({ ...wh, hidden_tabs: ['customers'] }, 'wolfhouse-somo') === false);
assert('explicit customers_crm:true overrides non-surf non-wolfhouse',
  portalHasCustomersCrmForVerify({ customers_crm: true, is_surf_vertical: false, client_slug: 'other' }, 'other') === true);
assert('unknown tenant without flag stays hidden',
  portalHasCustomersCrmForVerify({ is_surf_vertical: false, client_slug: 'other' }, 'other') === false);

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
  assert('CRM_TAG_KEYS includes warm_lead and hot_lead',
    CRM_TAG_KEYS.includes('warm_lead') && CRM_TAG_KEYS.includes('hot_lead'));
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
  assert('warm_leads includes manual crm_tags.warm_lead', warmSql.includes("crm_tags->>'warm_lead'"));
  assert('hot_leads requires bookings or services', hotSql.includes('booking_count, 0) > 0'));
  assert('hot_leads includes manual crm_tags.hot_lead', hotSql.includes("crm_tags->>'hot_lead'"));
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
  assert('warm_lead and hot_lead tag labels', i18n.includes("'customers.tags.warm_lead': 'Warm lead'")
    && i18n.includes("'customers.tags.hot_lead': 'Hot lead'"));
}

if (apiSrc) {
  assert('warm_leads status filter in dropdown defs', apiSrc.includes("id: 'warm_leads'") && apiSrc.includes('CUSTOMERS_STATUS_FILTER_DEFS'));
  assert('hot_leads status filter in dropdown defs', apiSrc.includes("id: 'hot_leads'"));
  assert('checked_in_now lodging-only in dropdown defs', apiSrc.includes("id: 'checked_in_now'") && apiSrc.includes('lodgingOnly: true'));
  assert('do_not_contact status filter in dropdown defs', apiSrc.includes("id: 'do_not_contact'"));
  assert('filters dropdown trigger', apiSrc.includes('id="cust-filters-btn"') && apiSrc.includes('data-cust-status-filter'));
  assert('PATCH /staff/customers/:phone/tags route', apiSrc.includes('CUSTOMER_TAGS_RE')
    && apiSrc.includes('handleCustomerTagsUpdate'));
  assert('customers.tags audit intent', apiSrc.includes("intent: 'api:customers.tags'"));
  assert('tag checkboxes in detail', apiSrc.includes('data-crm-tag') && apiSrc.includes('cust-tags-save'));
  assert('applyCustomersFilterVisibility for surf', apiSrc.includes('function applyCustomersFilterVisibility('));
  assert('no bulk send in customers tab', !/tab-customers[\s\S]{0,8000}bulk[\s_-]?send/i.test(apiSrc));
}

console.log('\n[6b] Profile UX, linked bookings, conversation, outreach stacking');

if (apiSrc) {
  assert('single profile edit action in header', apiSrc.includes('id="cust-profile-edit-btn"')
    && !apiSrc.includes('cust-profile-edit-field'));
  assert('language field in profile edit form', apiSrc.includes('id="cust-edit-language"'));
  assert('tags save closes edit mode', /customerSaveTags[\s\S]{0,1200}customerDetailState\.tagsEditing = false[\s\S]{0,200}renderCustomerDetail/.test(apiSrc));
  assert('linked bookings section', apiSrc.includes('cust-linked-bookings-section')
    && apiSrc.includes('renderCustomerLinkedBookingsSection'));
  assert('linked bookings date-only labels', apiSrc.includes('function customerBookingDateLabel('));
  assert('linked bookings open action', apiSrc.includes('cust-booking-open-link') && apiSrc.includes('wireCustomerLinkedBookingsActions'));
  assert('open booking link copy', apiSrc.includes("'customers.detail.openBooking'") && apiSrc.includes("'customers.detail.openBookingTitle'"));
  assert('open/start conversation action', apiSrc.includes('id="cust-conversation-btn"')
    && apiSrc.includes('customerOpenOrStartConversation'));
  assert('customer create-conversation route', apiSrc.includes('CUSTOMER_CREATE_CONVERSATION_RE')
    && apiSrc.includes('handleCustomerCreateConversation'));
  assert('outreach confirm hides composer first', /openCustomersOutreachConfirmModal[\s\S]{0,400}closeCustomersOutreachDrawer/.test(apiSrc));
  assert('outreach confirm modal above drawer z-index', apiSrc.includes('#cust-outreach-confirm-modal{z-index:9300}'));
  assert('wolfhouse customer profile PATCH uses updateCustomerProfile', apiSrc.includes('updateCustomerProfile(pg, clientSlug, phone, body)'));
  assert('handleCustomerUpdate not sunset-only gate', !/async function handleCustomerUpdate[\s\S]{0,400}return sendJSON\(res, 403[\s\S]{0,40}sunset only/.test(apiSrc));
  assert('CRM tag keys injected into portal bundle', apiSrc.includes('var CUSTOMER_CRM_TAG_KEYS = ${JSON.stringify(CRM_TAG_KEYS)}'));
  assert('portal bundle does not reference bare CRM_TAG_KEYS', !/var CUSTOMER_CRM_TAG_KEYS = CRM_TAG_KEYS;/.test(apiSrc));
}

console.log('\n[6c] Profile save — context reload + notes persistence');

const {
  normalizeCustomerPhone,
  customerPhoneDigits,
  parseCustomerProfileUpdateBody,
  getCustomerContextQuery,
  getCustomerBookingsQuery,
} = require('./lib/staff-customer-queries');

if (apiSrc) {
  assert('PATCH profile route wired', apiSrc.includes('CUSTOMER_PHONE_RE') && apiSrc.includes("method === 'PATCH'")
    && apiSrc.includes('handleCustomerUpdate'));
  assert('customerSaveProfile reloads full context', /function customerSaveProfile[\s\S]*loadCustomerDetail\(newPhone\)/.test(apiSrc));
  assert('customerSaveProfile does not render PATCH body', !/function customerSaveProfile[\s\S]*renderCustomerDetail\(res\.body/.test(apiSrc));
  assert('loadCustomerDetail returns fetch promise', /function loadCustomerDetail\(phone\)[\s\S]*return fetch\(url\)/.test(apiSrc));
  assert('profile save refreshes customer list', /function customerSaveProfile[\s\S]*loadCustomersList\(\)/.test(apiSrc));
  assert('context handler normalizes phone', /handleCustomerContext[\s\S]{0,400}normalizeCustomerPhone\(decodeURIComponent/.test(apiSrc));
}
assert('phone digit match helper', customerPhoneDigits('+15105888224') === customerPhoneDigits('15105888224'));
assert('normalizeCustomerPhone adds plus', normalizeCustomerPhone('15105888224') === '+15105888224');
assert('context query uses digit phone match', getCustomerContextQuery().includes('regexp_replace') && getCustomerContextQuery().includes('conv.phone'));
assert('bookings query uses digit phone match', getCustomerBookingsQuery().includes('regexp_replace'));
const customerQueriesSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-customer-queries.js'), 'utf8');
assert('profile update persists notes field', customerQueriesSrc.includes('notes = $3'));
assert('profile update keeper uses contiguous SQL params', /UPDATE customers SET[\s\S]*full_name = \$1[\s\S]*WHERE id = \$6::uuid/.test(customerQueriesSrc));
assert('profile update conv match uses bare phone column', customerQueriesSrc.includes("const convPhoneMatch = sqlCustomerPhoneMatch('phone', '$2')"));
assert('parseCustomerProfileUpdateBody keeps notes', parseCustomerProfileUpdateBody({ display_name: 'Ty', phone: '+1', notes: 'Awesome dude!' }).value.notes === 'Awesome dude!');
assert('normalized list phone', apiSrc.includes('normalizeCustomerPhone(row.phone)'));
assert('context notes from customers.notes coalesce', getCustomerContextQuery().includes('COALESCE(cust.notes, conv.internal_staff_notes)'));

console.log('\n[7] Outreach drawer shell — selection UI, no sends');

if (apiSrc) {
  assert('bulk selection checkboxes', apiSrc.includes('cust-bulk-check') && apiSrc.includes('customers-card-check'));
  assert('bulk action bar + selected count', apiSrc.includes('id="cust-bulk-bar"') && apiSrc.includes('id="cust-selected-count"') && apiSrc.includes('updateCustomersBulkSelectionUI'));
  assert('select all shown control', apiSrc.includes('id="cust-select-all-shown"') && apiSrc.includes('selectAllShownCustomers'));
  assert('message selected button', apiSrc.includes('id="cust-message-selected-btn"'));
  assert('outreach drawer shell', apiSrc.includes('id="customers-outreach-drawer"') && apiSrc.includes('cust-outreach-backdrop'));
  assert('drawer recipients + warnings', apiSrc.includes('buildCustomersOutreachPlan') && apiSrc.includes('skippedDnc'));
  assert('drawer message textarea', apiSrc.includes('cust-outreach-message'));
  assert('template picker in drawer', apiSrc.includes('cust-outreach-template-select') && apiSrc.includes('loadCustomerMessageTemplates'));
  assert('apply template to message', apiSrc.includes('applyCustomerMessageTemplateBody'));
  assert('save draft as template', apiSrc.includes('saveCustomerMessageTemplateFromDraft'));
  assert('send button in drawer', apiSrc.includes('id="cust-outreach-send"'));
  assert('mobile bottom sheet CSS marker', apiSrc.includes('staff-portal-mobile:cust-outreach'));
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

console.log('\n[9] Luna outreach draft generation — notes mode, generate API, no sends');

const GENERATE_LIB = path.join(ROOT, 'scripts', 'lib', 'staff-customer-outreach-draft-generate.js');

if (fs.existsSync(GENERATE_LIB)) {
  const lib = fs.readFileSync(GENERATE_LIB, 'utf8');
  assert('generate helper module', lib.includes('generateCustomerOutreachDraft'));
  assert('tenant voice loader', lib.includes('loadTenantOutreachVoice'));
  assert('prompt guardrails no prices', lib.includes('Do NOT invent availability, prices'));
  assert('prompt guardrails no jargon', lib.includes('Do NOT mention internal systems'));
  assert('uses callLunaAiJsonChat', lib.includes('callLunaAiJsonChat'));
}

if (apiSrc) {
  assert('generate route POST', apiSrc.includes("pathname === '/staff/customers/message-templates/generate' && method === 'POST'"));
  assert('generate handler', apiSrc.includes('handleCustomerMessageTemplateGenerate'));
  assert('generate operator auth', /message-templates\/generate[\s\S]{0,200}requireAuth\(req, res, 'operator'\)/.test(apiSrc));
  assert('generate uses assertStaffClientAccess', /handleCustomerMessageTemplateGenerate[\s\S]{0,400}assertStaffClientAccess/.test(apiSrc));
  assert('generate audit intent', apiSrc.includes("intent: 'api:customers.message_templates.generate'"));
  assert('generate response sends_whatsapp false', /handleCustomerMessageTemplateGenerate[\s\S]{0,1200}sends_whatsapp:\s*false/.test(apiSrc));
  assert('mode toggle UI', apiSrc.includes('cust-outreach-mode-message') && apiSrc.includes('cust-outreach-mode-notes'));
  assert('notes textarea + generate button', apiSrc.includes('cust-outreach-notes') && apiSrc.includes('cust-outreach-generate'));
  assert('generate fetch client', apiSrc.includes('customersOutreachGenerateUrl') && apiSrc.includes('message-templates/generate'));
  assert('regenerate label support', apiSrc.includes('customers.outreach.regenerate'));
  assert('generated body fills message textarea', apiSrc.includes('applyCustomerMessageTemplateBody(res.data.body)'));
  assert('generate does not call outreach send', !/generateCustomerOutreachDraftFromNotes[\s\S]{0,800}customers\/outreach\/send/.test(apiSrc));
  assert('no template send endpoint', !apiSrc.includes('message-templates/send') && !apiSrc.includes('handleCustomerMessageTemplateSend'));
  assert('generate still no whatsapp send', /handleCustomerMessageTemplateGenerate[\s\S]{0,1200}sends_whatsapp:\s*false/.test(apiSrc));
}

if (fs.existsSync(I18N_PATH)) {
  const i18n = fs.readFileSync(I18N_PATH, 'utf8');
  assert('notes for Luna label', i18n.includes("'customers.outreach.modeNotes': 'Notes for Luna'"));
  assert('generate button label', i18n.includes("'customers.outreach.generate': 'Generate'"));
}

console.log('\n[10] WhatsApp bulk outreach send — confirmation, caps, tenant scope');

const SEND_LIB = path.join(ROOT, 'scripts', 'lib', 'staff-customer-outreach-send.js');

if (fs.existsSync(SEND_LIB)) {
  const lib = fs.readFileSync(SEND_LIB, 'utf8');
  const sendMod = require(SEND_LIB);
  assert('send helper module', lib.includes('executeCustomerOutreachSend'));
  assert('confirmed true required', lib.includes("b.confirmed !== true"));
  assert('recipient cap 50', lib.includes('MAX_RECIPIENTS = 50'));
  assert('message min length', lib.includes('MESSAGE_MIN'));
  assert('DNC hard skip', lib.includes('do_not_contact'));
  assert('missing phone skip', lib.includes('missing_phone'));
  assert('tenant lookup join', lib.includes('INNER JOIN clients c') && lib.includes('c.slug = $1'));
  assert('uses sendLunaWhatsAppMessage', lib.includes('sendLunaWhatsAppMessage'));
  assert('no email channel', lib.includes('email_not_supported'));
  assert('parse rejects missing confirm', sendMod.parseOutreachSendBody({ message: 'hello world', phones: ['+34123456789'] }).error === 'confirmation_required');
  assert('parse rejects cap', sendMod.parseOutreachSendBody({
    confirmed: true,
    message: 'hello world',
    phones: Array.from({ length: 51 }, (_, i) => `+34000000${String(i).padStart(4, '0')}`),
  }).error === 'recipient_cap_exceeded');
  assert('outreach env gate helper', lib.includes('isCustomerOutreachWhatsAppEnabled'));
  assert('outreach enabled defaults false', sendMod.isCustomerOutreachWhatsAppEnabled({}) === false);
  assert('outreach enabled requires explicit true', sendMod.isCustomerOutreachWhatsAppEnabled({ CUSTOMER_OUTREACH_WHATSAPP_ENABLED: 'true' }) === true);
}

if (apiSrc) {
  assert('outreach send route POST', apiSrc.includes("pathname === '/staff/customers/outreach/send' && method === 'POST'"));
  assert('outreach send handler', apiSrc.includes('handleCustomerOutreachSend'));
  assert('send operator auth', /customers\/outreach\/send[\s\S]{0,200}requireAuth\(req, res, 'operator'\)/.test(apiSrc));
  assert('send uses assertStaffClientAccess', /handleCustomerOutreachSend[\s\S]{0,900}assertStaffClientAccess/.test(apiSrc));
  assert('send requires confirmed in body fetch', apiSrc.includes('confirmed: true'));
  assert('confirmation modal UI', apiSrc.includes('cust-outreach-confirm-modal') && apiSrc.includes('cust-outreach-confirm-send'));
  assert('confirm skipped join escaped for embedded script', apiSrc.includes("lines.join('\\\\n')"));
  assert('modal shows preview + stats', apiSrc.includes('cust-outreach-confirm-preview') && apiSrc.includes('openCustomersOutreachConfirmModal'));
  assert('results panel UI', apiSrc.includes('renderCustomersOutreachResults'));
  assert('send button gated by message length', apiSrc.includes('updateCustomersOutreachSendButton'));
  assert('send only selected phones', apiSrc.includes('plan.recipients.map(function(r) { return r.phone; })'));
  assert('staff actions gate on send', /handleCustomerOutreachSend[\s\S]{0,300}STAFF_ACTIONS_ENABLED/.test(apiSrc));
  assert('customer outreach env gate', apiSrc.includes('CUSTOMER_OUTREACH_WHATSAPP_ENABLED'));
  assert('customer outreach disabled error', apiSrc.includes("error: 'customer_outreach_disabled'"));
  assert('outreach gate not whatsapp dry run', !/handleCustomerOutreachSend[\s\S]{0,500}WHATSAPP_DRY_RUN/.test(apiSrc));
  assert('per-recipient audit', apiSrc.includes("intent: 'api:customers.outreach.send.recipient'"));
  assert('no email outreach route', !apiSrc.includes('/staff/customers/outreach/email'));
}

if (fs.existsSync(I18N_PATH)) {
  const i18n = fs.readFileSync(I18N_PATH, 'utf8');
  assert('send whatsapp label', i18n.includes("'customers.outreach.sendWhatsApp': 'Send WhatsApp'"));
  assert('confirm send label', i18n.includes("'customers.outreach.confirmSend': 'Send WhatsApp'"));
}

const MIGRATION_PATH = path.join(ROOT, 'database', 'migrations', '034_customers_crm_tags.sql');
assert('crm_tags migration file exists', fs.existsSync(MIGRATION_PATH));
if (fs.existsSync(MIGRATION_PATH)) {
  const mig = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert('migration adds crm_tags jsonb', mig.includes('crm_tags') && mig.includes('JSONB'));
}

console.log('\n[11] Create booking from contact (Option A — prefill-and-jump)');

if (apiSrc) {
  // Buttons rendered in the two entry points.
  assert('customer profile create-booking button', apiSrc.includes('id="cust-profile-create-booking"'));
  assert('customer profile create-booking label', apiSrc.includes("portalT('customers.detail.createBooking')"));
  assert('inbox create-booking-for-guest button', apiSrc.includes('id="inbox-create-booking-for-guest"'));
  assert('inbox create-booking label', apiSrc.includes("t('inbox.detail.bookings.createForGuest')"));

  // Opener function exists and behaves per Option A.
  assert('openCreateBookingFromContact defined', apiSrc.includes('function openCreateBookingFromContact('));

  const openerMatch = apiSrc.match(/function openCreateBookingFromContact\([\s\S]*?\n\}/);
  const applyMatch = apiSrc.match(/function bcApplyCreatePrefill\([\s\S]*?\n\}/);
  const openerBody = (openerMatch ? openerMatch[0] : '') + '\n' + (applyMatch ? applyMatch[0] : '');

  assert('opener switches to bed-calendar tab', openerBody.includes("switchToTab(\"bed-calendar\"") || openerBody.includes("switchToTab('bed-calendar'"));
  assert('opener sets bk-phone', openerBody.includes('bk-phone'));
  assert('opener sets bk-email', openerBody.includes('bk-email'));
  assert('opener prefills bk-notes from staff notes', openerBody.includes('bk-notes') && openerBody.includes('staff_notes'));
  assert('staff notes helper prefers internal_staff_notes', apiSrc.includes('contact.internal_staff_notes != null ? contact.internal_staff_notes : contact.staff_notes'));
  assert('customer wire passes internal_staff_notes only', /wireCustomerProfileActions[\s\S]{0,1400}internal_staff_notes/.test(apiSrc)
    && !/wireCustomerProfileActions[\s\S]{0,1400}human_notes/.test(apiSrc));
  assert('inbox wire passes internal_staff_notes', /inbox-create-booking-for-guest[\s\S]{0,400}internal_staff_notes/.test(apiSrc));
  assert('opener does NOT write bc-sel-cin', !openerBody.includes('bc-sel-cin'));
  assert('opener does NOT write bc-sel-cout', !openerBody.includes('bc-sel-cout'));

  // Existing calendar create flow intact.
  assert('bc-sel-cin still readonly', apiSrc.includes('id="bc-sel-cin" class="bk-input bk-input-sm" readonly'));
  assert('bc-sel-cout still readonly', apiSrc.includes('id="bc-sel-cout" class="bk-input bk-input-sm" readonly'));
  assert('create button bc-sel-create still present', apiSrc.includes('id="bc-sel-create"'));

  // No auto booking-create / payment / whatsapp from the opener.
  assert('opener does not create booking', !/openCreateBookingFromContact[\s\S]*?bcSubmitManualBooking/.test(openerBody));
}

if (fs.existsSync(I18N_PATH)) {
  const i18n = fs.readFileSync(I18N_PATH, 'utf8');
  assert('createBooking label i18n', i18n.includes("'customers.detail.createBooking': 'Create booking'"));
  assert('createForGuest label i18n', i18n.includes("'inbox.detail.bookings.createForGuest': 'Create booking for this guest'"));
}

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:staff-customers-crm — FAILED');
  process.exit(1);
}
console.log('verify:staff-customers-crm — ALL CHECKS PASSED');
