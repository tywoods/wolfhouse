'use strict';

/**
 * verify:vertical-tenant-isolation-second-school
 *
 * Phase 1a hostile regression: a SECOND configured surf school (lawave) is
 * RECOGNIZED at the vertical→tenant membership boundary but is NOT provisioned
 * in the Sunset pricing/booking spine, so every surf-school adapter operation
 * must fail closed with an audited 403 BEFORE any DB acquire or Sunset-hard-coded
 * command. This proves membership widening did not open a cross-tenant hole.
 *
 * Spine de-tenanting that lets lawave actually transact is Phase 1b; those
 * "lawave binds lawave" success asserts live there. This suite locks the safety
 * invariants that must hold the moment membership widens.
 *
 * See docs/PHASE-1-VERTICAL-TENANT-ISOLATION-SLICE.md.
 */

const {
  VERTICAL_IDS,
  VERTICAL_CHANNELS,
  resolveBusinessVertical,
  surfSchoolVerticalAdapter,
} = require('./lib/luna-front-desk-business-vertical');
const {
  assertResolvedVerticalScope,
  tenantBelongsToVertical,
} = require('./lib/luna-front-desk-vertical-scope');

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`  PASS  ${label}`); pass += 1; return; }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

// A pg client that EXPLODES if touched — any adapter op that reaches DB acquire
// fails this suite loudly, proving the tenant wall runs before DB.
function explodingPg() {
  return {
    query: async () => { throw new Error('DB_ACQUIRED_BEFORE_TENANT_WALL'); },
    connect: async () => { throw new Error('DB_ACQUIRED_BEFORE_TENANT_WALL'); },
  };
}

const LAWAVE_LOC = 'lawave-main';

async function run() {
  console.log('\nverify:vertical-tenant-isolation-second-school\n');

  console.log('── A. Membership recognition (slug preserved, never coerced) ──');
  const lawave = resolveBusinessVertical({ clientSlug: 'lawave', locationId: LAWAVE_LOC });
  ok('lawave resolves ok', lawave.ok === true, JSON.stringify(lawave));
  ok('lawave resolves to surf_school', lawave.verticalId === VERTICAL_IDS.SURF_SCHOOL);
  ok('resolved slug stays lawave (never sunset)', lawave.clientSlug === 'lawave');
  ok('lawave location preserved', lawave.locationId === LAWAVE_LOC);

  console.log('\n── B. Cross-tenant location isolation ──');
  const lawaveSunsetSomo = resolveBusinessVertical({ clientSlug: 'lawave', locationId: 'sunset-somo' });
  ok('lawave cannot use sunset-somo', !lawaveSunsetSomo.ok && lawaveSunsetSomo.reason_code === 'unknown_location', JSON.stringify(lawaveSunsetSomo));
  const lawaveSardinero = resolveBusinessVertical({ clientSlug: 'lawave', locationId: 'sunset-sardinero' });
  ok('lawave cannot use sunset-sardinero', !lawaveSardinero.ok && lawaveSardinero.reason_code === 'unknown_location');
  const sunsetLawaveLoc = resolveBusinessVertical({ clientSlug: 'sunset', locationId: LAWAVE_LOC });
  ok('sunset cannot use a lawave location', !sunsetLawaveLoc.ok && sunsetLawaveLoc.reason_code === 'unknown_location', JSON.stringify(sunsetLawaveLoc));

  console.log('\n── C. Membership boundary preserves isolation ──');
  ok('lawave belongs to surf_school', tenantBelongsToVertical(VERTICAL_IDS.SURF_SCHOOL, 'lawave') === true);
  ok('wolfhouse does NOT belong to surf_school', tenantBelongsToVertical(VERTICAL_IDS.SURF_SCHOOL, 'wolfhouse') === false);
  ok('sunset does NOT belong to accommodation', tenantBelongsToVertical(VERTICAL_IDS.ACCOMMODATION, 'sunset') === false);
  const scopeLawave = assertResolvedVerticalScope(lawave, VERTICAL_IDS.SURF_SCHOOL);
  ok('lawave passes surf_school scope (membership)', scopeLawave.ok === true);
  const scopeWolfhouseAsSurf = assertResolvedVerticalScope(
    { ok: true, verticalId: VERTICAL_IDS.SURF_SCHOOL, clientSlug: 'wolfhouse' },
    VERTICAL_IDS.SURF_SCHOOL,
  );
  ok('wolfhouse slug still 403s on surf_school', !scopeWolfhouseAsSurf.ok && scopeWolfhouseAsSurf.reason_code === 'tenant_mismatch');
  const unknown = resolveBusinessVertical({ clientSlug: 'definitely-not-a-tenant' });
  ok('unknown tenant still unknown_tenant', !unknown.ok && unknown.reason_code === 'unknown_tenant');

  console.log('\n── D. Adapter fails CLOSED for unprovisioned tenant (before DB) ──');
  const walled = async (label, invoke) => {
    let res;
    try { res = await invoke(); } catch (err) {
      ok(label, false, `threw ${err.message} (DB touched or crash before wall)`);
      return;
    }
    ok(label,
      res && res.ok === false && res.status === 403
        && (res.body ? res.body.reason_code : res.reason_code) === 'tenant_not_provisioned',
      JSON.stringify(res && (res.body || res)));
  };
  await walled('listOfferings walled', () => surfSchoolVerticalAdapter.listOfferings(explodingPg(), {
    resolved: lawave, channel: VERTICAL_CHANNELS.LUNA_WHATSAPP, transportBody: { require_db: true },
  }));
  await walled('quoteOffering walled', () => surfSchoolVerticalAdapter.quoteOffering(explodingPg(), {
    resolved: lawave, channel: VERTICAL_CHANNELS.LUNA_WHATSAPP, transportBody: { service_dates: ['2099-01-03'] },
  }));
  await walled('createBooking walled', () => surfSchoolVerticalAdapter.createBooking(explodingPg(), {
    resolved: lawave, channel: VERTICAL_CHANNELS.MANUAL_STAFF, transportBody: { guest_name: 'x', service_dates: ['2099-01-03'] },
  }));
  await walled('checkAvailability walled', () => surfSchoolVerticalAdapter.checkAvailability(explodingPg(), {
    resolved: lawave, transportBody: { date: '2099-01-03' },
  }));
  await walled('assertCourseAssignable walled', () => surfSchoolVerticalAdapter.assertCourseAssignable(explodingPg(), {
    resolved: lawave, courseId: 'x', serviceDates: ['2099-01-03'], quantity: 1,
  }));
  // evaluateDates is pure (no pg) but must still refuse the unprovisioned tenant.
  const evalRes = surfSchoolVerticalAdapter.evaluateDates({ resolved: lawave, offering: {}, serviceDates: ['2099-01-03'] });
  ok('evaluateDates walled', evalRes && evalRes.ok === false && evalRes.reason_code === 'tenant_not_provisioned', JSON.stringify(evalRes));

  console.log('\n── E. Forgery invariant: sanctioned resolver never yields sunset for lawave ──');
  // The adapter trusts `resolved` built by resolveBusinessVertical. A caller
  // presenting clientSlug=lawave can NEVER obtain resolved.clientSlug=sunset,
  // so it can never slip through the provisioned wall as Sunset. (Comparing the
  // authenticated tenant to `resolved` at the HTTP layer is Phase 1b.)
  ok('lawave slug cannot resolve to sunset identity',
    resolveBusinessVertical({ clientSlug: 'lawave', locationId: LAWAVE_LOC }).clientSlug !== 'sunset');

  console.log('\n── F. Provisioned tenant (sunset) is NOT walled ──');
  const sunset = resolveBusinessVertical({ clientSlug: 'sunset', locationId: 'sunset-somo' });
  const sunsetEval = surfSchoolVerticalAdapter.evaluateDates({
    resolved: sunset,
    offering: { weekly: 'sat_sun', schedules: ['0930_1130'] },
    serviceDates: ['2099-01-03'],
  });
  ok('sunset passes the provisioned wall (not tenant_not_provisioned)',
    !(sunsetEval && sunsetEval.reason_code === 'tenant_not_provisioned'), JSON.stringify(sunsetEval));

  console.log(`\nverify-vertical-tenant-isolation-second-school  pass=${pass}  fail=${fail}`);
  if (fail === 0) console.log('verify-vertical-tenant-isolation-second-school — ALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
