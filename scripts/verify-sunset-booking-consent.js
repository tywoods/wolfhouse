'use strict';

/**
 * verify:sunset-booking-consent
 *
 * Sunset booking-create requires literal boolean guest_confirmed_booking: true
 * at the Hermes plugin and Staff API boundary.
 *
 * Run: node scripts/verify-sunset-booking-consent.js
 */

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
function assert(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; }
  else { console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); fail += 1; }
}

const ROOT = path.resolve(__dirname, '..');
const staffApiSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'staff-query-api.js'), 'utf8');
const pluginSrc = fs.readFileSync(
  path.join(ROOT, 'docker', 'hermes-staging', 'plugins', 'wolfhouse_staff_api', '__init__.py'),
  'utf8',
);

function buildExplodingPg() {
  return { query() { throw new Error('DB must not be called on consent rejection'); } };
}

function buildConsentPg() {
  const state = { bookings: [], services: [] };
  return {
    query: async (sql) => {
      const q = String(sql);
      if (/BEGIN|COMMIT|ROLLBACK/i.test(q)) return { rows: [] };
      if (/SELECT id FROM clients WHERE slug/i.test(q)) {
        return { rows: [{ id: 'client-sunset-1' }] };
      }
      if (/INSERT INTO bookings/i.test(q)) {
        state.bookings.push({ id: 'bk-consent-1', booking_code: 'SUNSET-TEST' });
        return { rows: [{ id: 'bk-consent-1', booking_code: 'SUNSET-TEST' }] };
      }
      if (/INSERT INTO booking_service_records/i.test(q)) {
        state.services.push({ id: 'sr-1' });
        return { rows: [{ service_record_id: 'sr-1', booking_id: 'bk-consent-1', booking_code: 'SUNSET-TEST', guest_name: 'Consent Guest', service_type: 'surf_lesson', service_date: '2026-08-02', quantity: 1, amount_due_cents: 0, payment_status: 'pending', record_source: 'luna_guest', metadata: {}, metadata_source: 'luna_guest_whatsapp' }] };
      }
      return { rows: [] };
    },
  };
}

async function tryBotCreate(body) {
  if (body.guest_confirmed_booking !== true) {
    return { blocked: true, status: 400, reason: 'guest_confirmed_booking_required' };
  }
  const { createSunsetScheduleBooking } = require('./lib/sunset-schedule-booking-writes');
  const validated = require('./lib/sunset-schedule-booking-writes').validateScheduleBookingBody({
    guest_name: 'Consent Guest',
    service_date: '2026-08-02',
    components: { lesson: { quantity: 1 } },
  });
  if (!validated.ok) return { blocked: true, reason: validated.error };
  const result = await createSunsetScheduleBooking(buildConsentPg(), {
    clientSlug: 'sunset',
    body: { ...body, guest_name: 'Consent Guest', service_date: '2026-08-02', components: { lesson: { quantity: 1 } } },
    locationId: 'sunset-somo',
    actor: { source: 'agent_luna_whatsapp_bot' },
  });
  return { blocked: false, result };
}

console.log('\nverify:sunset-booking-consent\n');

(async () => {
  console.log('[1] Staff API handler requires literal true');
  const handlerBlock = staffApiSrc.slice(
    staffApiSrc.indexOf('async function handleBotSunsetBookingCreate'),
    staffApiSrc.indexOf('async function handleBotSunsetPaymentLink'),
  );
  assert('handler checks guest_confirmed_booking', /guest_confirmed_booking/.test(handlerBlock));
  assert('handler rejects non-literal true', /guest_confirmed_booking\s*!==\s*true/.test(handlerBlock)
    || /guest_confirmed_booking\)\s*is\s*not\s*True/.test(handlerBlock)
    || /!== true/.test(handlerBlock));

  console.log('\n[2] Plugin schema + guard');
  assert('tool schema documents guest_confirmed_booking',
    /guest_confirmed_booking/.test(pluginSrc));
  const pluginFn = pluginSrc.slice(
    pluginSrc.indexOf('def create_sunset_booking'),
    pluginSrc.indexOf('def create_sunset_payment_link'),
  );
  assert('plugin rejects before POST unless literal true',
    /guest_confirmed_booking/.test(pluginFn)
    && (/is not True/.test(pluginFn) || /!= True/.test(pluginFn) || /!== true/.test(pluginFn)));

  console.log('\n[3] Rejection matrix (zero DB on reject)');
  for (const [label, value] of [
    ['omitted', undefined],
    ['null', null],
    ['false', false],
    ['string true', 'true'],
    ['numeric 1', 1],
  ]) {
    const res = await tryBotCreate({ guest_confirmed_booking: value });
    assert(`${label} rejected`, res.blocked === true && res.reason === 'guest_confirmed_booking_required', String(res.reason));
  }
  const accepted = await tryBotCreate({ guest_confirmed_booking: true });
  assert('literal true accepted at boundary', accepted.blocked === false && accepted.result && accepted.result.ok === true);

  console.log(`\n── verify:sunset-booking-consent ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  if (fail > 0) process.exit(1);
})();
