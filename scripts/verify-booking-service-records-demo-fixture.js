'use strict';
// ============================================================================
// verify-booking-service-records-demo-fixture.js
// Static verifier for Stage 8.8.8 — demo fixture SQL (NO DB apply)
// ============================================================================

const fs   = require('fs');
const path = require('path');

const ROOT    = path.resolve(__dirname, '..');
const UP_F    = path.join(ROOT, 'scripts', 'fixtures', 'booking-service-records-demo-up.sql');
const DOWN_F  = path.join(ROOT, 'scripts', 'fixtures', 'booking-service-records-demo-down.sql');
const API_SRC = path.join(ROOT, 'scripts', 'staff-query-api.js');
const PKG     = path.join(ROOT, 'package.json');
const SELF    = __filename;

let passed = 0;
let failed = 0;
const results = [];

function check(id, desc, ok, detail) {
  if (ok) {
    passed++;
    results.push(`  PASS  [${id}] ${desc}`);
  } else {
    failed++;
    results.push(`  FAIL  [${id}] ${desc}${detail ? ' — ' + detail : ''}`);
  }
}

let upSql = '';
let downSql = '';
try { upSql = fs.readFileSync(UP_F, 'utf8'); } catch (e) { check('A0', 'up fixture exists', false, e.message); }
try { downSql = fs.readFileSync(DOWN_F, 'utf8'); } catch (e) { check('A0b', 'down fixture exists', false, e.message); }

const apiSrc = fs.existsSync(API_SRC) ? fs.readFileSync(API_SRC, 'utf8') : '';
const pkgJson = fs.existsSync(PKG) ? JSON.parse(fs.readFileSync(PKG, 'utf8')) : {};
const selfSrc = fs.readFileSync(SELF, 'utf8');

check('A1', 'booking-service-records-demo-up.sql exists', upSql.length > 0);
check('A2', 'booking-service-records-demo-down.sql exists', downSql.length > 0);
check('A3', 'up fixture NOT applied automatically notice', /NOT applied automatically/i.test(upSql));
check('A4', 'up uses BEGIN/COMMIT', /^\s*BEGIN\s*;/m.test(upSql) && /COMMIT\s*;/m.test(upSql));
check('A5', 'down uses BEGIN/COMMIT', /^\s*BEGIN\s*;/m.test(downSql) && /COMMIT\s*;/m.test(downSql));

check('B1', 'up inserts into booking_service_records', /INSERT INTO booking_service_records\b/i.test(upSql));
check('B2', "client_slug='wolfhouse-somo'", /'wolfhouse-somo'/.test(upSql));
check('B3', "source='demo_fixture_stage888'", /'demo_fixture_stage888'/.test(upSql));

for (const t of ['yoga', 'meal', 'surf_lesson', 'wetsuit', 'surfboard']) {
  check(`C-${t}`, `service_type ${t} represented`, new RegExp(`'${t}'`).test(upSql));
}

check('D1', 'CURRENT_DATE used for today rows', /,\s*CURRENT_DATE\s*,/i.test(upSql));
check('D2', 'tomorrow via CURRENT_DATE + INTERVAL', /CURRENT_DATE \+ INTERVAL '1 day'/i.test(upSql));
check('D3', 'fixed date 2026-06-15', /'2026-06-15'/i.test(upSql));

check('E1', 'paid examples present', /\b1500,\s*1500,\s*'paid'/i.test(upSql));
check('E2', 'non-paid pending example', /'pending'/i.test(upSql));
check('E3', 'non-paid not_requested example', /'not_requested'/i.test(upSql));
check('E4', 'confirmed status example', /'confirmed'/i.test(upSql));

check('F1', 'wetsuit quantity 2 on today', /'wetsuit'[\s\S]{0,120}CURRENT_DATE[\s\S]{0,60}\b2\b/i.test(upSql));
check('F2', 'multiple wetsuit rows', (upSql.match(/'wetsuit'/gi) || []).length >= 2);
check('F3', 'surfboard quantity 2', /'surfboard'[\s\S]{0,120}\b2\b/i.test(upSql));
check('F4', 'multiple surfboard rows', (upSql.match(/'surfboard'/gi) || []).length >= 2);

check('G1', 'down deletes from booking_service_records', /DELETE FROM booking_service_records/i.test(downSql));
check('G2', 'down scoped to wolfhouse-somo', /client_slug\s*=\s*'wolfhouse-somo'/i.test(downSql));
check('G3', 'down scoped to demo_fixture_stage888 only', /source\s*=\s*'demo_fixture_stage888'/i.test(downSql));
check('G4', 'down has no TRUNCATE', !/\bTRUNCATE\b/i.test(downSql));

check('H1', 'comment: structured data / no chat',
  /structured/i.test(upSql) && (/no chat/i.test(upSql) || /chat-log/i.test(upSql)));
check('H2', 'comment: safe to delete/reseed', /safe to delete/i.test(upSql) || /reseed/i.test(upSql));

check('I1', 'verifier has no database connection code',
  !/\bwithPgClient\s*\(/i.test(selfSrc) && !/\brequire\s*\(\s*['"][^'"]*pg-connect/i.test(selfSrc));
check('I2', 'no staff-query-api.js changes',
  !apiSrc.includes('booking_service_records') && !apiSrc.includes('demo_fixture_stage888'));
check('I3', 'no graph.facebook.com in fixtures', !/graph\.facebook\.com/i.test(upSql + downSql));
check('I4', 'no n8n.io in fixtures', !/n8n\.io/i.test(upSql + downSql));
check('I5', 'no api.stripe.com in fixtures', !/api\.stripe\.com/i.test(upSql + downSql));
check('I6', 'up inserts only booking_service_records',
  !(upSql.match(/INSERT INTO\s+(?!booking_service_records)\w+/gi) || []).length);

check('J1', 'package.json verify:booking-service-records-demo-fixture script',
  pkgJson.scripts
  && pkgJson.scripts['verify:booking-service-records-demo-fixture']
  === 'node scripts/verify-booking-service-records-demo-fixture.js');

results.forEach(r => console.log(r));
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed === 0) {
  console.log('verify-booking-service-records-demo-fixture PASS');
  process.exit(0);
} else {
  console.log('verify-booking-service-records-demo-fixture FAIL');
  process.exit(1);
}
