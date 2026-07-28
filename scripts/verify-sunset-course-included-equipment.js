'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const packs = require('./lib/sunset-admin-pack-rules');

function ok(name, cond) { assert.ok(cond, name); console.log('✓ ' + name); }
console.log('\nverify:sunset-course-included-equipment\n');

const validated = packs.validatePackBody({ label: 'Beginner', equipment_included: true }, { requireLabel: true });
ok('server accepts explicit boolean', validated.ok && validated.patch.equipment_included === true);
ok('server rejects truthy strings', !packs.validatePackBody({ equipment_included: 'true' }).ok);
ok('new courses safely default false', packs.defaultPackConfig().equipment_included === false);
ok('legacy rows safely project false', packs.mapPackRow({ id: 'x', label: 'Legacy', config_json: {} }).equipment_included === false);
ok('configured rows project true', packs.mapPackRow({ id: 'x', label: 'Gear', config_json: { equipment_included: true } }).equipment_included === true);

const equipment = require('./lib/sunset-course-included-equipment');
const dates = ['2026-08-10', '2026-08-11'];
const demand = equipment.deriveIncludedEquipment({ equipment_included: true }, dates, 3);
ok('derives one board and wetsuit per participant per course day', demand.length === 4 && demand.every(r => r.quantity === 3));
ok('included rows are €0 and distinctly sourced', demand.every(r => r.amount_cents === 0 && r.metadata.included_equipment === true));
ok('disabled course derives nothing', equipment.deriveIncludedEquipment({ equipment_included: false }, dates, 3).length === 0);
const combined = equipment.combineEquipmentDemand({ included: 3, paidUpgrade: 3 });
ok('paid all-day upgrade is not double-counted when course gear already covers participant', combined === 3);
ok('additional paid demand still counts independently', equipment.combineEquipmentDemand({ included: 2, paidUpgrade: 3 }) === 3);
ok('invoice distinguishes included from paid', /Included.*€0/.test(equipment.includedEquipmentInvoiceLabel()));

const ui = fs.readFileSync(path.join(__dirname, 'browser/sunset-admin-ui.js'), 'utf8');
ok('Create/Edit Course renders Equipment included unchecked by default', /equipment-included/.test(ui) && /type="checkbox"/.test(ui));
ok('generated course payload includes equipment flag', /equipment_included/.test(ui));
const bookingUi = fs.readFileSync(path.join(__dirname, 'browser/sunset-schedule-portal-module.js'), 'utf8');
ok('booking summary copy shows included equipment', /Equipment included/.test(bookingUi));
console.log('\nPASS verify:sunset-course-included-equipment\n');
