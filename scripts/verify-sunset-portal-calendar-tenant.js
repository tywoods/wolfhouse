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

console.log('\nverify:sunset-portal-calendar-tenant — offline tenant/calendar gate\n');

console.log('[1] Hostname → deploy client resolution');
assert('sunset-staging host maps to sunset',
  resolvePortalDeployClient({ host: 'sunset-staging.lunafrontdesk.com' }) === 'sunset');
assert('staff-staging host maps to wolfhouse-somo',
  resolvePortalDeployClient({ host: 'staff-staging.lunafrontdesk.com' }) === 'wolfhouse-somo');
assert('unknown host falls back to DEFAULT_CLIENT_SLUG or wolfhouse',
  typeof resolvePortalDeployClient({ host: 'localhost' }) === 'string');
assert('staging host map includes sunset only once',
  STAGING_PORTAL_HOST_CLIENT['sunset-staging.lunafrontdesk.com'] === 'sunset');

console.log('\n[2] Portal profiles — schedule vs bed-calendar default');
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

console.log('\n[3] staff-query-api.js — tenant routing + startup tab selection');
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

console.log('\n[4] Location isolation markers (Somo vs Sardinero)');
if (apiSrc) {
  assert('Sunset school switcher wired', apiSrc.includes('wireSunsetSchoolSwitcher'));
  assert('setSunsetLocation reloads schedule', apiSrc.includes('setSunsetLocation(') && apiSrc.includes('loadSchedulePage()'));
  assert('schedule school context markup', apiSrc.includes('id="schedule-school-context"'));
}

console.log(`\n── verify:sunset-portal-calendar-tenant ${fail ? 'FAILED' : 'PASSED'} (${pass}/${pass + fail}) ──\n`);
if (fail > 0) process.exit(1);
