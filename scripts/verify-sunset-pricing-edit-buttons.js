'use strict';

/**
 * Admin → Pricing: one ✎ size; Delete course only while editing.
 *
 *  - Group / private / rental / accommodation closed pencils share
 *    portal-admin-pricing-edit-btn as a 40×28, 4px-radius rectangle
 *    scoped to #admin-panel-pricing
 *  - Closed group course cards do not paint Delete course
 *  - Delete course lives in the pack editor footer (existing courses only)
 *
 * Stay off inbox-thread.js, email-settings, Skipper inbound.
 * Run: node scripts/verify-sunset-pricing-edit-buttons.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const adminUi = read('scripts/browser/sunset-admin-ui.js');
const apiSrc = read('scripts/staff-query-api.js');
const packRulesSrc = read('scripts/lib/sunset-admin-pack-rules.js');
const tenantConfigSrc = read('scripts/lib/tenant-business-config.js');

const packCardRender = (adminUi.match(/function renderAdminPackCards\([\s\S]*?function adminRenderPrivateEquipmentInline/) || [])[0] || '';
const packEditForm = (adminUi.match(/function adminRenderPackEditForm\([\s\S]*?function adminReadPackFormPayload/) || [])[0] || '';
const privateReadout = (adminUi.match(/function renderAdminPrivateLessonReadout\([\s\S]*?function renderAdminPrivateLessonCard/) || [])[0] || '';

assert.ok(packCardRender, 'renderAdminPackCards slice');
assert.ok(packEditForm, 'adminRenderPackEditForm slice');
assert.ok(privateReadout, 'renderAdminPrivateLessonReadout slice');

assert.ok(
  /edit-pack[\s\S]{0,220}portal-admin-pricing-edit-btn|portal-admin-pricing-edit-btn[\s\S]{0,220}edit-pack/.test(packCardRender),
  'group course pencil uses shared pricing-edit class',
);
assert.ok(
  /edit-private-lesson[\s\S]{0,180}portal-admin-pricing-edit-btn|portal-admin-pricing-edit-btn[\s\S]{0,180}edit-private-lesson/.test(privateReadout),
  'private course pencil uses shared pricing-edit class',
);
assert.ok(
  /portal-admin-equip-edit-btn portal-admin-pricing-edit-btn/.test(adminUi),
  'rental pencil uses shared pricing-edit class',
);
assert.ok(
  /portal-admin-pricing-edit-btn[\s\S]{0,180}edit-accommodation|edit-accommodation[\s\S]{0,220}portal-admin-pricing-edit-btn/.test(adminUi),
  'accommodation pencil uses shared pricing-edit class',
);

assert.ok(
  /#admin-panel-pricing button\.btn\.portal-admin-pricing-edit-btn[\s\S]{0,120}#admin-panel-pricing button\.btn\.portal-admin-equip-edit-btn\{[^}]*min-height:28px/.test(apiSrc)
    && /#admin-panel-pricing button\.btn\.portal-admin-pricing-edit-btn[\s\S]{0,280}width:40px/.test(apiSrc)
    && /#admin-panel-pricing button\.btn\.portal-admin-pricing-edit-btn[\s\S]{0,280}height:28px/.test(apiSrc),
  'shared pencil CSS is 40×28',
);
assert.ok(
  /#admin-panel-pricing button\.btn\.portal-admin-pricing-edit-btn[\s\S]{0,280}border-radius:4px/.test(apiSrc)
    && !/#admin-panel-pricing button\.btn\.portal-admin-pricing-edit-btn[\s\S]{0,280}border-radius:999px/.test(apiSrc)
    && !/#admin-panel-pricing button\.btn\.portal-admin-pricing-edit-btn[\s\S]{0,280}border-radius:8px/.test(apiSrc),
  'shared pencil is a 4px rounded rectangle, not a circle',
);
assert.ok(
  !/\.portal-admin-pack-card \.portal-admin-card-actions \.portal-admin-icon-btn\{[^}]*min-height:16px/.test(apiSrc),
  'group course pencil no longer uses the 16px chip',
);
assert.ok(
  !/\.portal-admin-equip-edit-btn\{[^}]*min-height:44px/.test(apiSrc),
  'rental pencil is no longer 44px',
);

assert.ok(packCardRender.includes('data-admin-action="edit-pack"'), 'closed pack still has edit');
assert.ok(!packCardRender.includes('data-admin-action="delete-pack"'), 'closed pack has no delete-pack');
assert.ok(!packCardRender.includes("portalT('admin.packs.deleteCourse')"), 'closed pack does not paint Delete course');

assert.ok(packEditForm.includes('data-admin-action="delete-pack"'), 'editor has delete-pack');
assert.ok(packEditForm.includes("portalT('admin.packs.deleteCourse')"), 'editor uses Delete course label');
assert.ok(/var deleteCourseBtn = pid/.test(packEditForm), 'Delete course omitted for new courses');
assert.ok(packEditForm.includes('portal-admin-pack-edit-footer'), 'delete lives in pack editor footer');
assert.ok(packEditForm.includes('portal-admin-equip-switch'), 'editor Enabled uses shared Pricing switch');
assert.ok(packEditForm.includes('portal-admin-pack-enabled-switch'), 'editor Enabled keeps pack layout hook');
assert.ok(packEditForm.includes('portal-admin-equip-switch-slider'), 'editor Enabled is a pill switch, not a checkbox');
assert.ok(!packEditForm.includes('portal-admin-pack-enabled-toggle'), 'editor no longer uses checkbox Enabled toggle');
assert.ok(/deleteCourseBtn \+\s*statusToggleHtml \+\s*'<div class="portal-admin-pack-edit-footer-right">'/.test(packEditForm), 'Enabled/Disabled control sits between Delete and Cancel');
assert.ok(packEditForm.includes("id=\"' + prefix + '-active\""), 'editor active checkbox is keyed to course form');
assert.ok(packEditForm.includes("p.active !== false"), 'editor defaults missing active to Enabled');

assert.ok(packCardRender.includes('portal-admin-pack-title-row'), 'course card title row has status dot wrapper');
assert.ok(packCardRender.includes('portal-admin-equip-status-dot'), 'course card reuses enabled dot visual language');
assert.ok(packCardRender.includes("packActive ? ' is-on' : ' is-off'"), 'course card paints green/grey active state');
assert.ok(packCardRender.includes('data-admin-pack-active'), 'course card exposes active state');

assert.ok(apiSrc.includes('.portal-admin-pack-title-row .portal-admin-equip-status-dot'), 'course title dot CSS aligns reused dot');
assert.ok(apiSrc.includes('.portal-admin-pack-enabled-field'), 'course enabled switch field CSS present');
assert.ok(apiSrc.includes('.portal-admin-pack-enabled-switch'), 'course enabled switch CSS present');
assert.ok(!apiSrc.includes('.portal-admin-pack-enabled-toggle{'), 'old course checkbox toggle CSS removed');

// Accommodation Enabled shares rental equip-switch (darker --sched-primary), not #2e8b57.
assert.ok(
  /portal-admin-equip-switch portal-admin-accommodation-enabled-switch/.test(adminUi),
  'accommodation Enabled uses rental equip-switch component',
);
assert.ok(
  /portal-admin-equip-switch input:checked \+ \.portal-admin-equip-switch-slider\{[^}]*var\(--sched-primary,var\(--primary\)\)/.test(apiSrc),
  'rental/accommodation/group Enabled on-state uses --sched-primary/--primary',
);
assert.ok(
  !/\.portal-admin-switch input:checked\+\.portal-admin-switch-slider\{background:#2e8b57\}/.test(apiSrc),
  'legacy switch no longer hardcodes lighter #2e8b57 on-state',
);

assert.ok(packRulesSrc.includes('active: cfg.enabled !== false'), 'surf pack mapper returns enabled state');
assert.ok(packRulesSrc.includes('includeDisabled === true'), 'surf pack loader can include disabled courses for admin');
assert.ok(packRulesSrc.includes("(config_json->>'enabled') IS DISTINCT FROM 'false'"), 'default surf pack loader excludes disabled courses');
assert.ok(tenantConfigSrc.includes('includeDisabledSurfPacks'), 'admin config can request disabled courses');
assert.ok(apiSrc.includes('includeDisabledSurfPacks: true'), 'Staff admin config includes disabled courses for Pricing cards');

assert.ok(!adminUi.includes('inbox-thread.js'));
assert.ok(!adminUi.includes('staff-email-settings'));

console.log('verify:sunset-pricing-edit-buttons — PASS');
