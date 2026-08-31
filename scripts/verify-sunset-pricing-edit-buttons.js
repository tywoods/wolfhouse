'use strict';

/**
 * Admin → Pricing: one ✎ size; Delete course only while editing.
 *
 *  - Group / private / rental / accommodation closed pencils share portal-admin-pricing-edit-btn at 32px rounded-rect
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
  /button\.btn\.portal-admin-icon-btn\.portal-admin-pricing-edit-btn[\s\S]{0,80}button\.btn\.portal-admin-equip-edit-btn\{[^}]*min-height:32px/.test(apiSrc)
    && /button\.btn\.portal-admin-icon-btn\.portal-admin-pricing-edit-btn[\s\S]{0,240}width:32px/.test(apiSrc)
    && /button\.btn\.portal-admin-icon-btn\.portal-admin-pricing-edit-btn[\s\S]{0,240}height:32px/.test(apiSrc),
  'shared pencil CSS is 32px',
);
assert.ok(
  /button\.btn\.portal-admin-icon-btn\.portal-admin-pricing-edit-btn[\s\S]{0,240}border-radius:8px/.test(apiSrc)
    && !/button\.btn\.portal-admin-icon-btn\.portal-admin-pricing-edit-btn[\s\S]{0,240}border-radius:999px/.test(apiSrc),
  'shared pencil is a rounded rectangle, not a circle',
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

assert.ok(!adminUi.includes('inbox-thread.js'));
assert.ok(!adminUi.includes('staff-email-settings'));

console.log('verify:sunset-pricing-edit-buttons — PASS');
