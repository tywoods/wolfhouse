'use strict';

/**
 * Slice 1 — remove obsolete location-wide Admin Equipment + Price authority.
 *
 * Proves:
 * - Sunset Admin no longer renders the global course-equipment pricing block or Save
 * - /staff/admin/config payload no longer exposes course_equipment_pricing as active authority
 * - PATCH /staff/admin/config/course-equipment is retired (404/410; does not accept writes)
 * - quote / create / edit paths do not call getCourseEquipmentPricing or hardcode surfboard/wetsuit
 * - course-owned equipment_options surface remains
 *
 * Run: node scripts/verify-sunset-remove-global-course-equipment-authority.js
 *      npm run verify:sunset-remove-global-course-equipment-authority
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = __dirname;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ui = read('browser/sunset-admin-ui.js');
const api = read('staff-query-api.js');
const store = read('lib/sunset-admin-location-store.js');
const quote = read('lib/luna-front-desk-quote-service.js');
const writes = read('lib/sunset-schedule-booking-writes.js');
const drawer = read('lib/sunset-schedule-booking-drawer.js');
const drawerUi = read('browser/sunset-schedule-drawer-edit-ui.js');

// ── Admin UI: global block + save gone; course-owned equipment remains ──
assert.ok(!/function\s+renderAdminCourseEquipment\b/.test(ui), 'renderAdminCourseEquipment must be removed');
assert.ok(!ui.includes('data-admin-course-equipment'), 'global Admin equipment section marker removed');
assert.ok(!ui.includes('admin-course-equipment-title'), 'global Equipment + Price title id removed');
assert.ok(!ui.includes('admin-course-all-day-enabled'), 'global All Day enabled checkbox removed');
assert.ok(!ui.includes('admin-course-all-day-board'), 'hardcoded Surfboard price input removed');
assert.ok(!ui.includes('admin-course-all-day-suit'), 'hardcoded Wetsuit price input removed');
assert.ok(!ui.includes('save-course-equipment'), 'Save global course-equipment action removed');
assert.ok(!ui.includes('/staff/admin/config/course-equipment'), 'Admin UI must not PATCH retired route');
assert.ok(ui.includes('equipment_options'), 'course-owned equipment_options remain');
assert.ok(ui.includes('data-admin-equipment-editor'), 'Group/Private equipment editor remains');
assert.ok(ui.includes('adminRenderEquipmentEditor'), 'course equipment editor helper remains');

// ── Admin config payload: no active course_equipment_pricing projection ──
assert.ok(
  !/payload\.course_equipment_pricing\s*=/.test(api),
  'admin config GET must not attach course_equipment_pricing',
);
assert.ok(
  !/course_equipment_pricing:\s*normalizeLegacyCourseEquipmentPricing/.test(store),
  'applyStoreToResolvedConfig must not project course_equipment_pricing as active authority',
);

// ── Write route retired: no accepting handler ──
assert.ok(
  !/function\s+handleAdminConfigCourseEquipmentPatch\b/.test(api),
  'accepting course-equipment PATCH handler must be removed',
);
assert.ok(
  !/putCourseEquipmentPricing\s*\(/.test(api),
  'Staff API must not write location-wide course equipment pricing',
);
assert.ok(
  /pathname\s*===\s*['"]\/staff\/admin\/config\/course-equipment['"]/.test(api),
  'retired route must still be matched so writes return 404/410',
);
assert.ok(
  !/validateConfig\s*:\s*validateCourseEquipmentPricing/.test(api),
  'Staff API must not import obsolete pricing validator for active writes',
);
assert.ok(
  !/require\('\.\/lib\/sunset-course-equipment-pricing'\)/.test(api),
  'Staff API must not require sunset-course-equipment-pricing for retired route',
);

// ── Current consumers: quote / create / edit never load global pricing ──
for (const [name, src] of [
  ['quote service', quote],
  ['booking writes', writes],
  ['booking drawer', drawer],
  ['drawer edit UI', drawerUi],
]) {
  assert.ok(!/getCourseEquipmentPricing\s*\(/.test(src), `${name} must not call getCourseEquipmentPricing`);
  assert.ok(!/putCourseEquipmentPricing\s*\(/.test(src), `${name} must not call putCourseEquipmentPricing`);
  assert.ok(!/\bsurfboard_cents\b/.test(src), `${name} must not use global surfboard_cents`);
  assert.ok(!/\bwetsuit_cents\b/.test(src), `${name} must not use global wetsuit_cents`);
}
assert.ok(/quoteCourseEquipment/.test(quote), 'quote still uses course-owned quoteCourseEquipment');
assert.ok(/quoteCourseEquipment/.test(writes), 'create/edit still uses course-owned quoteCourseEquipment');
assert.ok(
  /equipment_options/.test(quote) || /course\.equipment_options|equipment_options/.test(read('lib/sunset-course-equipment-pricing.js')),
  'course-owned equipment_options remain on the quote/pricing path',
);

// ── Historical store helpers may remain for bounded read/test compatibility ──
assert.ok(
  /function\s+getCourseEquipmentPricing\b/.test(store),
  'historical getCourseEquipmentPricing may remain in location store',
);
assert.ok(
  /function\s+normalizeLegacyCourseEquipmentPricing\b/.test(store),
  'legacy normalizer may remain for historical JSON',
);

// ── Resolved config + fixture payload: no active authority ──
{
  const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
  const resolved = resolveTenantBusinessConfig('sunset', 'sunset-somo');
  assert.ok(resolved && resolved.ok, 'tenant config still resolves');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(resolved, 'course_equipment_pricing'),
    'resolveTenantBusinessConfig must not expose course_equipment_pricing',
  );
  assert.ok(
    resolved.surf_packs !== undefined || resolved.prices !== undefined,
    'Group/price config remains available',
  );
}

// ── Runtime: PATCH is rejected and does not accept writes ──
process.env.NODE_ENV = 'test';
process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = '1';

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch (_) { data = text; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const apiMod = require('./staff-query-api');
  assert.equal(
    typeof apiMod.createStaffQueryApiHttpServer,
    'function',
    'fortress dual-gate must export createStaffQueryApiHttpServer',
  );
  const server = apiMod.createStaffQueryApiHttpServer();
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

  try {
    const patch = await request(
      port,
      'PATCH',
      '/staff/admin/config/course-equipment?client=sunset&location=sunset-somo',
      { all_day: { enabled: true, surfboard_cents: 999, wetsuit_cents: 999 } },
    );
    assert.ok(
      patch.status === 404 || patch.status === 410,
      `retired PATCH must return 404/410, got ${patch.status}`,
    );
    assert.ok(
      !patch.data || patch.data.success !== true,
      'retired PATCH must not report success',
    );
    assert.ok(
      !(patch.data && patch.data.course_equipment_pricing),
      'retired PATCH must not return saved course_equipment_pricing',
    );

    const get = await request(port, 'GET', '/staff/admin/config?client=sunset&location=sunset-somo');
    if (get.status === 200 && get.data && typeof get.data === 'object') {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(get.data, 'course_equipment_pricing'),
        'admin config GET payload must not expose course_equipment_pricing',
      );
    }
  } finally {
    await new Promise((r) => server.close(r));
  }

  console.log('PASS verify-sunset-remove-global-course-equipment-authority — global Admin equipment authority retired');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
