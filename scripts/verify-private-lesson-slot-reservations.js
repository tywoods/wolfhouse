'use strict';
const fs = require('fs');
const api = fs.readFileSync('scripts/staff-query-api.js', 'utf8');
let pass = 0; let fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  PASS ', name); } else { fail++; console.log('  FAIL ', name); } }
ok('adds booking_service_records slot columns lazily', /ensureBookingServiceSlotColumns[\s\S]*service_slot_id TEXT[\s\S]*service_time_local TEXT[\s\S]*service_time_local_end TEXT/.test(api));
ok('loads lesson schedule_slots from tenant_services', /SELECT id::text AS id, name, category[\s\S]*schedule_slots[\s\S]*FROM tenant_services/.test(api));
ok('requires valid active service_slot_id for lesson services', /resolveCatalogLessonSlot[\s\S]*service_slot_id is required for lesson services[\s\S]*lesson slot not found or inactive/.test(api));
ok('uses transaction-scoped advisory lock for slot key', /pg_advisory_xact_lock\(hashtext\(\$1\), hashtext\(\$2\)\)/.test(api));
ok('counts non-cancelled existing bookings for same service/date/slot', /service_date = \$2::date[\s\S]*service_slot_id = \$3[\s\S]*metadata->>'service_id' = \$4/.test(api));
ok('returns 409 slot_full when capacity is reached', /err\.code === 'SLOT_FULL'[\s\S]*sendJSON\(res, 409[\s\S]*error: 'slot_full'/.test(api));
ok('insert persists slot id and times on booking_service_records', /service_slot_id, service_time_local, service_time_local_end[\s\S]*\$10, \$11, \$12/.test(api));
console.log(`\n── private-lesson-slot-reservations: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
