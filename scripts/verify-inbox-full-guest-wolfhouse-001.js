'use strict';

/**
 * INBOX-FULL-GUEST-WOLFHOUSE-001
 *
 * Shared Guest rail must not force Sunset Equipment Out onto Wolfhouse.
 * Lodging keeps Checked in. Sunset Equipment Out stays as-is.
 *
 * Run: node scripts/verify-inbox-full-guest-wolfhouse-001.js
 */

const fs = require('fs');
const path = require('path');
const {
  SUNSET_GUEST_SURFACE_ORDER,
  WOLFHOUSE_GUEST_SURFACE_ORDER,
  guestSurfaceOrderForClient,
  listInboxSavedViews,
  listInboxSavedViewsBySurface,
  buildInboxViewCountsPlan,
  getInboxSavedViewDeclaration,
} = require('./lib/staff-inbox-saved-views');

const ROOT = path.join(__dirname, '..');
const viewsUi = fs.readFileSync(path.join(ROOT, 'scripts', 'browser', 'inbox-views.js'), 'utf8');
const i18nEn = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n.js'), 'utf8');
const i18nEs = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'staff-portal-i18n-es-sunset.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

console.log('verify:inbox-full-guest-wolfhouse-001\n');

ok('Sunset Guest order still starts all_people, equipment_out',
  SUNSET_GUEST_SURFACE_ORDER[0] === 'all_people'
    && SUNSET_GUEST_SURFACE_ORDER[1] === 'equipment_out'
    && SUNSET_GUEST_SURFACE_ORDER.indexOf('checked_in') < 0);
ok('Wolfhouse Guest order starts all_people, checked_in (no equipment_out)',
  WOLFHOUSE_GUEST_SURFACE_ORDER[0] === 'all_people'
    && WOLFHOUSE_GUEST_SURFACE_ORDER[1] === 'checked_in'
    && WOLFHOUSE_GUEST_SURFACE_ORDER.indexOf('equipment_out') < 0);
ok('guestSurfaceOrderForClient(sunset) is Sunset order',
  guestSurfaceOrderForClient('sunset') === SUNSET_GUEST_SURFACE_ORDER);
ok('guestSurfaceOrderForClient(wolfhouse-somo) is lodging order',
  guestSurfaceOrderForClient('wolfhouse-somo') === WOLFHOUSE_GUEST_SURFACE_ORDER);

const sunsetRail = listInboxSavedViews({ clientSlug: 'sunset' }).map((v) => v.id);
const wolfRail = listInboxSavedViews({ clientSlug: 'wolfhouse-somo' }).map((v) => v.id);
ok('Sunset rail includes equipment_out and not checked_in',
  sunsetRail.includes('equipment_out') && !sunsetRail.includes('checked_in'));
ok('Wolfhouse rail includes checked_in and not equipment_out',
  wolfRail.includes('checked_in') && !wolfRail.includes('equipment_out'));

const sunsetGuest = listInboxSavedViewsBySurface({
  surface: 'guest', isSunset: true, clientSlug: 'sunset',
}).map((v) => v.id);
const wolfGuest = listInboxSavedViewsBySurface({
  surface: 'guest', isSunset: true, clientSlug: 'wolfhouse-somo',
}).map((v) => v.id);
ok('Sunset Guest surface keeps Equipment Out first after All people',
  sunsetGuest[0] === 'all_people' && sunsetGuest[1] === 'equipment_out');
ok('Wolfhouse Guest surface has Checked in, not Equipment Out',
  wolfGuest[0] === 'all_people' && wolfGuest[1] === 'checked_in'
    && !wolfGuest.includes('equipment_out'));

const sunsetCounts = buildInboxViewCountsPlan({ clientSlug: 'sunset', query: {} });
const wolfCounts = buildInboxViewCountsPlan({ clientSlug: 'wolfhouse-somo', query: {} });
ok('Sunset counts include equipment_out',
  sunsetCounts.views.some((v) => v.id === 'equipment_out')
    && sunsetCounts.passes.some((p) => p.viewIds.includes('equipment_out')));
ok('Wolfhouse counts include checked_in and omit equipment_out',
  wolfCounts.views.some((v) => v.id === 'checked_in')
    && wolfCounts.passes.some((p) => p.viewIds.includes('checked_in'))
    && !wolfCounts.views.some((v) => v.id === 'equipment_out'));

const checked = getInboxSavedViewDeclaration('checked_in');
ok('checked_in is a Guest-surface people view',
  checked && checked.surface === 'guest' && checked.crmFilter === 'checked_in_now');

ok('browser has Wolfhouse Guest order without equipment_out',
  viewsUi.includes("INBOX_SURFACE_ORDER_GUEST_WOLFHOUSE")
    && /INBOX_SURFACE_ORDER_GUEST_WOLFHOUSE = \[[^\]]*checked_in/.test(viewsUi)
    && viewsUi.includes("inboxViewsIsSunsetTenant"));
ok('browser keeps Sunset Guest equipment_out order',
  /INBOX_SURFACE_ORDER_GUEST = \[[^\]]*equipment_out/.test(viewsUi));
ok('Checked in rail translations EN/ES',
  i18nEn.includes("'inbox.rail.view.checked_in': 'Checked in'")
    && i18nEs.includes("'inbox.rail.view.checked_in': 'Con check-in'"));

console.log('\n────────────────────────────────────────────────');
if (fail === 0) {
  console.log(`Results: ${pass} passed, ${fail} failed`);
  console.log('verify:inbox-full-guest-wolfhouse-001 — ALL CHECKS PASSED\n');
  process.exit(0);
}
console.error(`Results: ${pass} passed, ${fail} failed`);
process.exit(1);
