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

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:staff-customers-crm — FAILED');
  process.exit(1);
}
console.log('verify:staff-customers-crm — ALL CHECKS PASSED');
