'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const beaches = require('./lib/sunset-surf-beach-registry');
const packs = require('./lib/sunset-admin-pack-rules');

const ROOT = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(ROOT, 'database/migrations/102_tenant_surf_beach_registry.sql'), 'utf8');
const api = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
let passed = 0;
function ok(label, condition) { assert.ok(condition, label); passed += 1; console.log(`  PASS ${label}`); }

(async () => {
  console.log('\nverify:pricing-beaches-p2-crud\n');
  ok('beach key accepts stable catalog identifiers', beaches.validateBeachBody({ beach_key: 'playa_de_los_locos', display_name: 'Los Locos' }, { create: true }).ok);
  ok('create requires a key', !beaches.validateBeachBody({ display_name: 'No key' }, { create: true }).ok);
  ok('rename cannot mutate stable key', !beaches.validateBeachBody({ beach_key: 'new_key' }, { create: false }).ok);
  ok('beach payload has no money or capacity', !beaches.validateBeachBody({ beach_key: 'somo', display_name: 'Somo', amount_cents: 1 }, { create: true }).ok);
  ok('beach payload rejects capacity', !beaches.validateBeachBody({ beach_key: 'somo', display_name: 'Somo', capacity: 8 }, { create: true }).ok);
  ok('pack syntax accepts a registry-shaped key (DB authority follows)', packs.validatePackBody({ beaches: ['playa_de_los_locos'] }).ok);

  const calls = [];
  const client = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT beach_key/.test(sql)) return { rows: [{ beach_key: 'somo' }] };
    return { rows: [] };
  } };
  const registryCheck = await beaches.validateBeachKeys(client, { clientSlug: 'sunset', locationId: 'somo', beachKeys: ['somo', 'ghost'] });
  ok('pack beach validation rejects keys absent from same property registry', !registryCheck.ok && registryCheck.missing[0] === 'ghost');
  ok('registry lookup is tenant/property scoped', calls[0].params[0] === 'sunset' && calls[0].params[1] === 'somo');

  const blockedClient = { query: async (sql) => {
    if (/SELECT beach_key/.test(sql)) return { rows: [{ beach_key: 'somo', display_name: 'Somo', active: true }] };
    if (/FROM tenant_surf_pack_rules/.test(sql)) return { rows: [{ id: 'pack-1' }] };
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  const blocked = await beaches.deleteSurfBeach(blockedClient, { clientSlug: 'sunset', locationId: 'somo', beachKey: 'somo', actor: {} });
  ok('delete is blocked while an active/in-use pack references beach', blocked.status === 409 && blocked.body.error === 'beach_in_use');

  ok('migration creates dedicated scoped registry', /CREATE TABLE IF NOT EXISTS tenant_surf_beaches/.test(migration) && /location_id\s+TEXT NOT NULL/.test(migration));
  ok('migration backfills existing config_json beaches without changing pack data', /jsonb_array_elements_text/.test(migration) && !/UPDATE\s+tenant_surf_pack_rules/i.test(migration));
  const beachTableColumns = /CREATE TABLE IF NOT EXISTS tenant_surf_beaches \(([\s\S]*?)\n\);/.exec(migration)[1];
  ok('migration has no price or capacity columns', !/amount_cents|capacity/i.test(beachTableColumns));
  ok('API exposes scoped beach collection and member CRUD', api.includes('/staff/admin/config/surf-beaches') && api.includes('handleAdminConfigSurfBeach'));
  ok('pack writes call registry authority', /validateBeachKeys/.test(fs.readFileSync(path.join(ROOT, 'scripts/lib/sunset-admin-pack-rules.js'), 'utf8')));

  console.log(`\nPASS pricing beaches P2 CRUD (${passed} checks)\n`);
})().catch((err) => { console.error(err.stack || err); process.exit(1); });
