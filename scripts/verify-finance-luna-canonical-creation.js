'use strict';
const assert = require('assert');
const fs = require('fs');
const dataSource = fs.readFileSync(require.resolve('./lib/sunset-finance-data'), 'utf8');
const LODGING_BSR_SQL = dataSource.slice(dataSource.indexOf('const LODGING_BSR_SQL = `'), dataSource.indexOf('const LODGING_PAYMENTS_SQL'));
const writer = fs.readFileSync(require.resolve('./lib/luna-front-desk-accommodation-booking-create-service'), 'utf8');
const sqlWriter = require('./lib/staff-manual-booking-create-sql').buildManualBookingCreateSql();
assert.match(writer, /\? String\(body\.source \|\| 'luna_whatsapp'\)/);
assert.match(writer, /bot_source: source/);
assert.match(sqlWriter, /'source',\s*'staff_manual'/, 'canonical shared SQL initially stamps staff metadata even for Luna');
// This fixture uses exactly the persisted fields the shared SQL and Luna metadata patch write.
const savedCreation = { source: 'staff_manual', manual_created: true, bot_source: 'luna_whatsapp' };
assert.strictEqual(savedCreation.bot_source, 'luna_whatsapp');
assert.match(LODGING_BSR_SQL, /b\.metadata->>'bot_source'\s*=\s*'luna_whatsapp'/,
  'SQL creation-origin projection must recognize canonical Luna metadata, not later attached service source');
assert.doesNotMatch(LODGING_BSR_SQL, /b\.record_source/);
console.log('PASS verify-finance-luna-canonical-creation (writer and SQL projection source contract; no SQL engine)');
