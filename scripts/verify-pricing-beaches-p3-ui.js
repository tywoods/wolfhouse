'use strict';

/**
 * PRICING-BEACHES-P3-UI-001 — compact beach manager + dynamic Pricing selectors.
 *
 * Guards slice 3 only: Sunset Staff UI reads beach options from the P2 registry,
 * exposes compact beach CRUD with key/name fields only, and does not invent prices
 * or capacity when creating a beach.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function slice(src, start, end) {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `${start} found`);
  const b = end ? src.indexOf(end, a + start.length) : src.length;
  assert.ok(b > a, `${end || 'EOF'} found after ${start}`);
  return src.slice(a, b);
}

const ui = read('scripts/browser/sunset-admin-ui.js');
const api = read('scripts/staff-query-api.js');
const registry = require('./lib/sunset-surf-beach-registry');

const beachOptions = slice(ui, 'function adminPackBeachOptions()', 'function adminPackGroupSizeOptions()');
assert.ok(/adminSurfBeaches\(\)\.map/.test(beachOptions), 'pack beach selector is populated from surf_beaches registry rows');
assert.ok(!/el_sardinero|liencres|somo/.test(beachOptions), 'pack beach selector has no hardcoded beach choices');

const defaultSeed = slice(ui, 'function adminDefaultPackConfigSeed()', 'function adminDefaultPackSeed()');
assert.ok(/beaches:\s*\[\]/.test(defaultSeed), 'new course seed does not invent default beaches');
assert.ok(!/beaches:\s*\[[^\]]*(el_sardinero|liencres|somo)/.test(defaultSeed), 'new course seed has no hardcoded beach list');

const renderManager = slice(ui, 'function adminRenderBeachManager', 'function renderAdminSectionLessonTimesFromConfig');
assert.ok(/data-testid=\"admin-beach-manager\"/.test(renderManager), 'compact beach manager is rendered in Pricing');
assert.ok(/data-admin-action=\"add-beach\"/.test(renderManager), 'beach manager has add action');
assert.ok(/data-admin-action=\"edit-beach\"/.test(renderManager), 'beach manager has edit action');
assert.ok(/data-admin-action=\"delete-beach\"/.test(renderManager), 'beach manager has delete action');
// BEACHES-DELETE-X-AFTER-EDIT-001: closed cards are pencil-only; × only in edit mode.
const closedBeachActions = /else if \(!adminBeachSectionEditing\(\)\) \{([\s\S]*?)\}[\s\S]*?html \+= '<\/div>';/.exec(renderManager)
  || /!adminBeachSectionEditing\(\)[\s\S]{0,40}\{([\s\S]*?)\}/.exec(renderManager);
assert.ok(closedBeachActions, 'closed beach card actions branch exists');
assert.ok(/edit-beach/.test(closedBeachActions[1]), 'closed beach cards show edit pencil');
assert.ok(!/delete-beach/.test(closedBeachActions[1]), 'closed beach cards do not show delete ×');
assert.ok(/if \(editing\) \{[\s\S]*?delete-beach/.test(renderManager), 'delete × is available in beach edit mode');
assert.ok(!/data-beach-field=\\"(?:amount_cents|capacity|price_tiers)\\"|id=\\"[^\\"]*(?:amount|capacity|price)[^\\"]*\\"/.test(renderManager), 'beach manager form does not render price or capacity fields');
assert.ok(/adminRenderBeachManager\(cfg, writes\) \+ renderAdminPackCards/.test(ui), 'beach manager renders above course selectors');

assert.ok(/config\/surf-beaches/.test(ui), 'UI fetches/uses surf beach registry route');
assert.ok(/data\.surf_beaches\s*=\s*beachCatalog/.test(ui), 'registry rows are attached to adminConfigCache');
assert.ok(/save-new-beach/.test(ui) && /save-beach/.test(ui) && /delete-beach/.test(ui), 'beach CRUD actions are wired');
assert.ok(/POST'[\s\S]{0,180}\/staff\/admin\/config\/surf-beaches/.test(ui), 'new beach saves to surf-beaches POST');
assert.ok(/PATCH'[\s\S]{0,180}\/staff\/admin\/config\/surf-beaches/.test(ui), 'beach rename saves to surf-beaches PATCH');
assert.ok(/DELETE'[\s\S]{0,180}\/staff\/admin\/config\/surf-beaches/.test(ui), 'beach delete saves to surf-beaches DELETE');

assert.ok(/\.portal-admin-beach-card/.test(api), 'Staff UI CSS includes beach card styles');
assert.ok(api.includes('/staff/admin/config/surf-beaches'), 'Staff API exposes surf-beaches routes used by UI');

assert.ok(registry.validateBeachBody({ beach_key: 'playa_de_los_locos', display_name: 'Los Locos' }, { create: true }).ok, 'registry accepts key+name create');
assert.ok(!registry.validateBeachBody({ beach_key: 'somo', display_name: 'Somo', amount_cents: 100 }, { create: true }).ok, 'registry rejects invented price on beach create');
assert.ok(!registry.validateBeachBody({ beach_key: 'somo', display_name: 'Somo', capacity: 8 }, { create: true }).ok, 'registry rejects invented capacity on beach create');

for (const forbidden of [
  'scripts/lib/sunset-catalog',
  'scripts/lib/sunset-availability',
  'scripts/lib/skipper',
]) {
  assert.ok(!ui.includes(forbidden), `UI slice does not touch ${forbidden}`);
}

console.log('verify:pricing-beaches-p3-ui — PASS');
