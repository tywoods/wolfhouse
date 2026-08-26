'use strict';

/**
 * Bug Finder #21 (26 Aug inventory, P2) — Precios destructive delete safety.
 *
 * Admin → Precios:
 *  - Group course cards: explicit "Delete course" / "Eliminar curso" (not × / Quitar)
 *  - Rental editor footer: explicit "Delete equipment" / "Eliminar equipo"
 *  - Both require window.confirm before any DELETE API call
 *
 * Stay off inbox-thread.js, email-settings, Skipper inbound, Salt/Sand palette tokens.
 * Run: node scripts/verify-sunset-precios-destructive-delete-021.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const adminUi = read('scripts/browser/sunset-admin-ui.js');
const en = read('scripts/lib/staff-portal-i18n.js');
const es = read('scripts/lib/staff-portal-i18n-es-sunset.js');

function sliceAction(src, action) {
  const marker = "if (action === '" + action + "'){";
  const start = src.indexOf(marker);
  assert.ok(start >= 0, action + ' handler missing');
  const next = src.indexOf('\n    if (action === ', start + marker.length);
  return next > start ? src.slice(start, next) : src.slice(start, start + 2500);
}

const deletePackBlock = sliceAction(adminUi, 'delete-pack');
const deleteRentalBlock = sliceAction(adminUi, 'delete-rental-offering');
const packCardRender = (adminUi.match(/function renderAdminPackCards\([\s\S]*?\n\}/) || [])[0] || '';

// Course card: labeled delete control (not icon-only × with generic Remove)
assert.ok(packCardRender.includes("portalT('admin.packs.deleteCourse')"), 'pack card uses deleteCourse label');
assert.ok(!/data-admin-action="delete-pack"[\s\S]{0,240}admin\.action\.remove/.test(packCardRender), 'pack card must not use generic Remove');
assert.ok(!/data-admin-action="delete-pack"[\s\S]{0,120}">×<\/button>/.test(packCardRender), 'pack card must not use × icon delete');

// Rental editor: explicit equipment delete label in edit footer
assert.ok(adminUi.includes("portalT('admin.prices.deleteEquipment')"), 'rental editor uses deleteEquipment label');
assert.ok(
  /portal-admin-equip-footer[\s\S]{0,500}data-admin-action="delete-rental-offering"[\s\S]{0,200}deleteLabel/.test(adminUi)
    || /deleteLabel[\s\S]{0,500}portal-admin-equip-delete[\s\S]{0,200}delete-rental-offering/.test(adminUi),
  'delete equipment label wired to footer delete action',
);

// Confirm before DELETE for both destructive paths
assert.ok(
  /window\.confirm\(portalT\(['"]admin\.edit\.confirmRemovePack['"]\)\)/.test(deletePackBlock),
  'delete-pack confirms before API',
);
assert.ok(
  /window\.confirm\(portalT\(['"]admin\.prices\.deleteRentalConfirm['"]\)\)/.test(deleteRentalBlock),
  'delete-rental-offering confirms before API',
);
assert.ok(
  deletePackBlock.indexOf('window.confirm') < deletePackBlock.indexOf("adminApiRequest('DELETE'"),
  'delete-pack confirm precedes DELETE',
);
assert.ok(
  deleteRentalBlock.indexOf('window.confirm') < deleteRentalBlock.indexOf("adminApiRequest('DELETE'"),
  'delete-rental confirm precedes DELETE',
);

// i18n copy present (ES sunset overlay + EN base)
assert.ok(en.includes("'admin.packs.deleteCourse': 'Delete course'"), 'EN deleteCourse');
assert.ok(es.includes("'admin.packs.deleteCourse': 'Eliminar curso'"), 'ES deleteCourse');
assert.ok(es.includes("'admin.prices.deleteEquipment': 'Eliminar equipo'"), 'ES deleteEquipment');
assert.ok(es.includes("'admin.edit.confirmRemovePack': '¿Eliminar este curso?'"), 'ES pack confirm');
assert.ok(es.includes("'admin.prices.deleteRentalConfirm'"), 'ES rental confirm');

// Scope guardrails
assert.ok(!adminUi.includes('inbox-thread.js'));
assert.ok(!adminUi.includes('staff-email-settings'));

console.log('verify:sunset-precios-destructive-delete-021 — PASS');
