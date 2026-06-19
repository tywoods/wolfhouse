'use strict';

/**
 * verify:sunset-portal-customers
 *
 * Offline checks for Sunset Customers tab (read-only guest history v1).
 *
 * Run:
 *   node scripts/verify-sunset-portal-customers.js
 *   npm run verify:sunset-portal-customers
 */

const fs = require('fs');
const path = require('path');

const {
  loadClientPortalProfile,
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
  assert('list query anchors on phone', listSql.includes('conv.phone') && listSql.includes('phone_universe'));
  assert('no email-only join in list query', !/JOIN.*email\s*=/i.test(listSql));
  assert('buildCustomerListParams uses bound params', (() => {
    const b = buildCustomerListParams('sunset', { filter: 'booked', limit: 10, offset: 0, q: 'maria' });
    return b.params[0] === 'sunset' && b.params.includes(10);
  })());
  assert('filter booked supported', listSql.includes('booking_count') || queriesSrc.includes("'booked'"));
} else {
  assert('staff-customer-queries.js exists', false);
}

// ── 3. UI — Customers tab surf-only ─────────────────────────────────────────

console.log('\n[3] staff-query-api.js — Customers tab UI');

if (apiSrc) {
  assert('Customers tab button', apiSrc.includes('data-tab="customers"'));
  assert('Customers tab panel', apiSrc.includes('id="tab-customers"'));
  assert('customers tab hidden for non-surf', apiSrc.includes("tab === 'customers' && !profile.is_surf_vertical"));
  assert('loadCustomersTab function', apiSrc.includes('function loadCustomersTab('));
  assert('Customers empty state i18n keys', apiSrc.includes('customers.empty.main'));
  assert('Customers search placeholder', apiSrc.includes('customers.searchPlaceholder'));
  assert('Customers filters All/Booked/Needs attention', apiSrc.includes('data-cust-filter="booked"')
    && apiSrc.includes('data-cust-filter="needs_attention"'));
  assert('Last setup detail section', apiSrc.includes('customers.detail.lastSetup')
    || apiSrc.includes('customers.detail.lastSetup'));

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
  assert('customers.subtitle surf oriented', i18n.includes('Guest history, preferences'));
  assert('customers.empty.main', i18n.includes("'customers.empty.main': 'No customers yet.'"));
  assert('customers.empty.sub future wording', i18n.includes('will appear here'));
  assert('Remember returning guests copy', i18n.includes('Remember returning guests'));
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
  const bak = ACCESS_PATH + '.verify-bak';
  fs.copyFileSync(ACCESS_PATH, bak);
  fs.copyFileSync(accessFile, ACCESS_PATH);
  delete require.cache[require.resolve('./lib/staff-portal-clients')];
  const mod = require('./lib/staff-portal-clients');
  const slugs = mod.getAccessibleClientSlugs({ email, role: 'owner' });
  fs.copyFileSync(bak, ACCESS_PATH);
  fs.unlinkSync(bak);
  delete require.cache[require.resolve('./lib/staff-portal-clients')];
  return slugs;
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
  assert('Wolfhouse default tywoods still has multiple clients', whSlugs.length >= 2, JSON.stringify(whSlugs));
  const opSlugs = slugsWithAccessFile(ACCESS_PATH, 'operator.stage72c@example.test');
  assert('Wolfhouse operator scoped to wolfhouse-somo',
    opSlugs.length === 1 && opSlugs[0] === 'wolfhouse-somo', JSON.stringify(opSlugs));
}


// ── 5. Wolfhouse preservation ───────────────────────────────────────────────

console.log('\n[5] Wolfhouse portal profile preserved');

const wh = loadClientPortalProfile('wolfhouse-somo');
assert('wolfhouse default_tab bed-calendar', wh.default_tab === 'bed-calendar');
assert('wolfhouse is_surf_vertical false', wh.is_surf_vertical === false);

if (apiSrc) {
  assert('no hardcoded sunset-staging URL', !apiSrc.includes('sunset-staging.lunafrontdesk.com'));
  assert('Wolfhouse bed-calendar preserved', apiSrc.includes('data-tab="bed-calendar"'));
}

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:sunset-portal-customers — FAILED');
  process.exit(1);
}
console.log('verify:sunset-portal-customers — ALL CHECKS PASSED');
