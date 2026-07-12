'use strict';

/**
 * verify:sunset-portal-calendar-tenant
 *
 * Offline regression gate: Sunset staging portal must resolve to surf-school
 * schedule (portal-home), not Wolfhouse bed-calendar. Wolfhouse must stay on
 * bed-calendar. Hostname + deploy client beat cross-tenant localStorage bleed.
 *
 * Run:
 *   node scripts/verify-sunset-portal-calendar-tenant.js
 */

const fs = require('fs');
const path = require('path');
const {
  loadClientPortalProfile,
  resolvePortalDeployClient,
  STAGING_PORTAL_HOST_CLIENT,
} = require('./lib/staff-portal-clients');

const ROOT = path.join(__dirname, '..');
const STAFF_API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const WOLFHOUSE_LODGING = /\b(bed|room|hostel|move-bed|wolfhouse)\b/i;

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass += 1;
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value == null) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env[key];
    else process.env[key] = prev;
  }
}

/** Mirrors staff-query-api.js portalPickClientSlug (deploy tenant is authoritative). */
function simulatePortalPickClientSlug(list, preferredSlug, deployClient, savedClient) {
  if (!list || !list.length) return 'wolfhouse-somo';
  const saved = savedClient || null;
  const deployPref = deployClient || 'wolfhouse-somo';
  const deployMatch = list.some((c) => c.slug === deployPref) ? deployPref : null;
  if (saved && deployMatch && saved !== deployMatch && list.some((c) => c.slug === deployMatch)) {
    return deployMatch;
  }
  let pick = preferredSlug || deployMatch || saved || list[0].slug;
  if (!list.some((c) => c.slug === pick)) {
    pick = deployMatch || list[0].slug;
  }
  return pick;
}

function simulatePortalStartupFallbackTab(deployClient) {
  const profile = loadClientPortalProfile(deployClient);
  let tab = profile.default_tab || 'bed-calendar';
  if (profile.is_surf_vertical && tab === 'bed-calendar') tab = 'portal-home';
  return tab;
}

console.log('\nverify:sunset-portal-calendar-tenant — offline tenant/calendar gate\n');

console.log('[1] Deployment tenant authority (DEFAULT_CLIENT_SLUG beats Host spoofing)');
withEnv('DEFAULT_CLIENT_SLUG', 'sunset', () => {
  assert('DEFAULT_CLIENT_SLUG=sunset + spoofed Wolfhouse Host still resolves sunset',
    resolvePortalDeployClient({ host: 'staff-staging.lunafrontdesk.com' }) === 'sunset');
});
withEnv('DEFAULT_CLIENT_SLUG', 'wolfhouse-somo', () => {
  assert('DEFAULT_CLIENT_SLUG=wolfhouse-somo + spoofed Sunset Host still resolves wolfhouse-somo',
    resolvePortalDeployClient({ host: 'sunset-staging.lunafrontdesk.com' }) === 'wolfhouse-somo');
});
withEnv('DEFAULT_CLIENT_SLUG', null, () => {
  assert('no configured default + exact Sunset hostname resolves sunset',
    resolvePortalDeployClient({ host: 'sunset-staging.lunafrontdesk.com' }) === 'sunset');
  assert('no configured default + exact Wolfhouse hostname resolves wolfhouse-somo',
    resolvePortalDeployClient({ host: 'staff-staging.lunafrontdesk.com' }) === 'wolfhouse-somo');
  assert('unknown hostname does not become Sunset',
    resolvePortalDeployClient({ host: 'evil-sunset-staging.lunafrontdesk.com' }) === 'wolfhouse-somo');
  assert('mixed-case hostname normalizes safely',
    resolvePortalDeployClient({ host: 'Sunset-Staging.LunaFrontDesk.com' }) === 'sunset');
  assert('hostname with allowed port normalizes safely',
    resolvePortalDeployClient({ host: 'sunset-staging.lunafrontdesk.com:443' }) === 'sunset');
  assert('prefix lookalike does not match',
    resolvePortalDeployClient({ host: 'x-sunset-staging.lunafrontdesk.com' }) === 'wolfhouse-somo');
  assert('suffix lookalike does not match',
    resolvePortalDeployClient({ host: 'sunset-staging.lunafrontdesk.com.evil.com' }) === 'wolfhouse-somo');
});
assert('staging host map includes sunset only once',
  STAGING_PORTAL_HOST_CLIENT['sunset-staging.lunafrontdesk.com'] === 'sunset');

console.log('\n[2] localStorage preference cannot override authorized deployment tenant');
const clientList = [
  { slug: 'sunset', name: 'Sunset' },
  { slug: 'wolfhouse-somo', name: 'Wolfhouse' },
];
assert('stale localStorage wolfhouse-somo cannot override trusted Sunset deployment',
  simulatePortalPickClientSlug(clientList, null, 'sunset', 'wolfhouse-somo') === 'sunset');
assert('stale localStorage sunset cannot override trusted Wolfhouse deployment',
  simulatePortalPickClientSlug(clientList, null, 'wolfhouse-somo', 'sunset') === 'wolfhouse-somo');

console.log('\n[3] Session failure uses authorized tenant profile fallback tab');
assert('Sunset session failure uses portal-home fallback',
  simulatePortalStartupFallbackTab('sunset') === 'portal-home');
assert('Wolfhouse session failure uses bed-calendar fallback',
  simulatePortalStartupFallbackTab('wolfhouse-somo') === 'bed-calendar');

console.log('\n[4] Portal profiles — schedule vs bed-calendar default');
const sunsetProfile = loadClientPortalProfile('sunset');
const wolfProfile = loadClientPortalProfile('wolfhouse-somo');
assert('Sunset default_tab is portal-home (surf schedule)', sunsetProfile.default_tab === 'portal-home', sunsetProfile.default_tab);
assert('Sunset hides bed-calendar tab', (sunsetProfile.hidden_tabs || []).includes('bed-calendar'));
assert('Sunset is_surf_vertical', sunsetProfile.is_surf_vertical === true);
assert('Wolfhouse default_tab is bed-calendar', wolfProfile.default_tab === 'bed-calendar', wolfProfile.default_tab);
assert('Wolfhouse is not surf vertical', wolfProfile.is_surf_vertical === false);
assert('Wolfhouse bed-calendar not hidden', !(wolfProfile.hidden_tabs || []).includes('bed-calendar'));

let apiSrc = '';
if (fs.existsSync(STAFF_API_PATH)) {
  apiSrc = fs.readFileSync(STAFF_API_PATH, 'utf8');
}

console.log('\n[5] staff-query-api.js — tenant routing + startup tab selection');
if (apiSrc) {
  assert('resolvePortalDeployClient imported', apiSrc.includes('resolvePortalDeployClient'));
  assert('PORTAL_DEFAULT_CLIENT injected from server', apiSrc.includes('window.PORTAL_DEFAULT_CLIENT'));
  assert('portalPickClientSlug prefers deploy over saved localStorage',
    apiSrc.includes('function portalPickClientSlug(')
    && apiSrc.includes('preferredSlug || deployMatch || saved'));
  assert('cross-tenant localStorage bleed cleared',
    apiSrc.includes('saved !== deployMatch') && apiSrc.includes("localStorage.setItem('staff_portal_client', deployMatch)"));
  assert('portalStartupFallbackTab respects surf profile',
    apiSrc.includes('function portalStartupFallbackTab(')
    && apiSrc.includes("profile.is_surf_vertical ? 'portal-home' : 'bed-calendar'"));
  assert('session failure does not hardcode bed-calendar only',
    apiSrc.includes('switchToTab(portalStartupFallbackTab(), null)'));
  assert('buildUiHtml passes hostname deploy client', apiSrc.includes('resolvePortalDeployClient({ host })'));
  assert('login page uses hostname deploy client', apiSrc.includes('buildLoginHtml(req)'));
  assert('portal-home tab gated for surf vertical only',
    apiSrc.includes("tab === 'portal-home' && !profile.is_surf_vertical"));
  assert('Schedule page markup present', apiSrc.includes('portal-schedule-wrap'));
  assert('bed-calendar not initially active', !/<button class="tab-btn active" data-tab="bed-calendar"/.test(apiSrc));

  const homePanelMatch = apiSrc.match(/<div id="tab-portal-home"[\s\S]*?<!-- \/tab-portal-home -->/);
  if (homePanelMatch) {
    assert('portal-home panel has no hostel lodging keywords', !WOLFHOUSE_LODGING.test(homePanelMatch[0]));
  } else {
    assert('portal-home panel extractable', false);
  }
} else {
  assert('staff-query-api.js exists', false);
}

console.log('\n[6] Location isolation markers (Somo vs Sardinero)');
if (apiSrc) {
  assert('Sunset school switcher wired', apiSrc.includes('wireSunsetSchoolSwitcher'));
  assert('setSunsetLocation reloads schedule', apiSrc.includes('setSunsetLocation(') && apiSrc.includes('loadSchedulePage()'));
  assert('schedule school context markup', apiSrc.includes('id="schedule-school-context"'));
}

console.log(`\n── verify:sunset-portal-calendar-tenant ${fail ? 'FAILED' : 'PASSED'} (${pass}/${pass + fail}) ──\n`);
if (fail > 0) process.exit(1);
