'use strict';

/* Unit gate for the Wolfhouse Services catalog: validation + charge math (no DB). */

const {
  validateServiceBody,
  computeServiceChargeCents,
} = require('./lib/tenant-services-writes');

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); }
}

// ── validation: create ───────────────────────────────────────────────
ok('create requires name', validateServiceBody({}, { requireName: true }).ok === false);
ok('blank name rejected', validateServiceBody({ name: '   ' }, { requireName: true }).ok === false);
const good = validateServiceBody({
  name: 'Breakfast', category: 'meal', notes_for_luna: 'Daily breakfast 8-10.',
  keywords: ['breakfast', 'Breakfast', 'desayuno'], start_date: '2026-06-01', end_date: '2026-09-30',
  price_cents: 1000, price_unit: 'per_day', per_guest: true, span_booking: true,
  luna_visible: true, active: true,
}, { requireName: true });
ok('valid full body accepted', good.ok === true);
ok('keywords deduped + lowercased', good.ok && good.patch.keywords.join(',') === 'breakfast,desayuno');
ok('keywords split on period/semicolon too', (() => { const r = validateServiceBody({ name: 'x', keywords: ['jiu jitsu. bjj', 'grappling; martial arts'] }, { requireName: true }); return r.ok && r.patch.keywords.join('|') === 'jiu jitsu|bjj|grappling|martial arts'; })());

// ── validation: field rules ──────────────────────────────────────────
ok('unknown field rejected', validateServiceBody({ name: 'x', color: 'red' }, { requireName: true }).ok === false);
ok('invalid category rejected', validateServiceBody({ name: 'x', category: 'spaceflight' }, { requireName: true }).ok === false);
ok('invalid price_unit rejected', validateServiceBody({ name: 'x', price_unit: 'per_hour' }, { requireName: true }).ok === false);
ok('per_stay price_unit accepted', validateServiceBody({ name: 'x', price_unit: 'per_stay' }, { requireName: true }).ok === true);
ok('per_week price_unit no longer accepted', validateServiceBody({ name: 'x', price_unit: 'per_week' }, { requireName: true }).ok === false);
ok('one_off price_unit no longer accepted', validateServiceBody({ name: 'x', price_unit: 'one_off' }, { requireName: true }).ok === false);
ok('negative price rejected', validateServiceBody({ name: 'x', price_cents: -5 }, { requireName: true }).ok === false);
ok('non-integer price rejected', validateServiceBody({ name: 'x', price_cents: 9.5 }, { requireName: true }).ok === false);
ok('bad date rejected', validateServiceBody({ name: 'x', start_date: '2026-13-40' }, { requireName: true }).ok === false);
ok('end before start rejected', validateServiceBody({ name: 'x', start_date: '2026-09-01', end_date: '2026-06-01' }, { requireName: true }).ok === false);
ok('non-boolean span rejected', validateServiceBody({ name: 'x', span_booking: 'yes' }, { requireName: true }).ok === false);
ok('block rooms requires dates on create', validateServiceBody({
  name: 'Surf camp', block_rooms_enabled: true, blocked_room_codes: ['A1'],
}, { requireName: true }).ok === false);
ok('block rooms create accepted with dates', (() => {
  const r = validateServiceBody({
    name: 'Surf camp', block_rooms_enabled: true, blocked_room_codes: ['a1', 'A1'],
    start_date: '2026-07-01', end_date: '2026-07-07',
  }, { requireName: true });
  return r.ok && r.patch.blocked_room_codes.join(',') === 'A1';
})());

// ── validation: patch ────────────────────────────────────────────────
ok('patch allows partial (no name)', validateServiceBody({ price_cents: 1500 }).ok === true);
ok('patch empty rejected', validateServiceBody({}).ok === false);
ok('patch can clear end_date', (() => { const r = validateServiceBody({ end_date: '' }); return r.ok && r.patch.end_date === null; })());

// ── charge math: price_unit is the single source of truth ────────────
// per_day spans the stay regardless of any span_booking flag (now retired).
const breakfast = { price_cents: 1000, per_guest: true, price_unit: 'per_day' };
ok('per_day: 1000 × 4 guests × 5 nights = 20000', computeServiceChargeCents(breakfast, { guests: 4, stayNights: 5 }) === 20000);
ok('per_day clamps to window nights', computeServiceChargeCents(breakfast, { guests: 4, stayNights: 5, nightsInWindow: 3 }) === 12000);
const perStay = { price_cents: 5000, per_guest: true, price_unit: 'per_stay' };
ok('per_stay: 5000 × 2 guests × 1 = 10000', computeServiceChargeCents(perStay, { guests: 2, stayNights: 7 }) === 10000);
const flat = { price_cents: 5000, per_guest: false, price_unit: 'per_day' };
ok('per_guest=false ignores headcount', computeServiceChargeCents(flat, { guests: 4, stayNights: 3 }) === 15000);
// legacy units tolerated by compute (treated as flat) even though they can't be written
const legacy = { price_cents: 4000, per_guest: false, price_unit: 'per_week' };
ok('legacy per_week treated as flat', computeServiceChargeCents(legacy, { guests: 3, stayNights: 6 }) === 4000);

console.log(`\n── tenant-services: ${pass} passed, ${fail} failed ──`);
process.exit(fail ? 1 : 0);
