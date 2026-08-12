'use strict';

/**
 * verify:sunset-batch-inbox-sidebar-toggle
 * Inbox right-rail booking panel collapsible; chat reflows.
 */

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${extra !== undefined ? `  (${extra})` : ''}`); }
}

// Template plus injected Inbox browser modules: the sidebar toggle wiring was extracted.
const api = require('./lib/staff-portal-ui-source').readStaffPortalUiSource();
const i18n = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n.js'), 'utf8');
const es = fs.readFileSync(path.join(ROOT, 'scripts/lib/staff-portal-i18n-es-sunset.js'), 'utf8');

ok('toggle button id present in markup builder', /id=\"inbox-sidebar-toggle\"/.test(api) || /id='inbox-sidebar-toggle'/.test(api));
ok('sidebar id inbox-detail-sidebar', /inbox-detail-sidebar/.test(api));
ok('collapsed class CSS', /\.detail-layout\.is-sidebar-collapsed\s+\.detail-sidebar/.test(api));
ok('collapsed main reflows full width', /is-sidebar-collapsed[\s\S]{0,200}\.detail-main/.test(api));
ok('wireInboxSidebarToggle function', /function wireInboxSidebarToggle/.test(api));
ok('wire called after conv detail load', /wireInboxSidebarToggle\s*\(\s*targetEl\s*\)/.test(api));
ok('sessionStorage key', /inbox-detail-sidebar-collapsed/.test(api));
ok('does not touch schedule drawer classes', !/portal-schedule-drawer[\s\S]{0,40}sidebar-collapsed/.test(api));
ok('i18n hide/show EN', /inbox\.detail\.sidebar\.hide/.test(i18n) && /inbox\.detail\.sidebar\.show/.test(i18n));
ok('i18n hide/show ES', /inbox\.detail\.sidebar\.hide/.test(es));
ok('aria-expanded toggled', /aria-expanded/.test(api));

console.log(`\n── verify:sunset-batch-inbox-sidebar-toggle: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
