'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = '753d101402005a980ab072126f6758ea7041b0bf';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:753d101-stage107a2-operator-room-release-fix';
const OPERATOR = 'Test Operator Release Fix';
const CHECK_IN = '2028-04-01';
const CHECK_OUT = '2028-04-15';
const RELEASE_START = '2028-04-05';
const RELEASE_END = '2028-04-10';

function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path,
      method,
      headers: {
        Accept: 'application/json,text/html',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function activeRevision() {
  const rows = JSON.parse(execSync(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  ));
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties.template.containers[0].image,
  };
}

function getStagingDbUrl() {
  return execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

function blocksForRoom(cal, roomCode, start, end) {
  return (cal.body?.blocks || []).filter((b) => {
    if ((b.room_code || '').toUpperCase() !== roomCode.toUpperCase()) return false;
    if (b.start_date >= end || b.end_date <= start) return false;
    return true;
  });
}

async function safetyCounts(pg) {
  const r = await pg.query(`
    SELECT
      (SELECT COUNT(*)::int FROM payments p INNER JOIN clients c ON c.id = p.client_id WHERE c.slug = $1) AS payments,
      (SELECT COUNT(*)::int FROM booking_service_records s WHERE s.client_slug = $1) AS service_records
  `, [CLIENT]);
  return r.rows[0];
}

async function bookingBedsForCode(pg, bookingCode) {
  const r = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.status::text AS status,
           b.check_in::text, b.check_out::text,
           bb.bed_code, bb.assignment_start_date::text, bb.assignment_end_date::text
    FROM bookings b
    INNER JOIN clients c ON c.id = b.client_id
    LEFT JOIN booking_beds bb ON bb.booking_id = b.id AND bb.client_id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY bb.bed_code ASC NULLS LAST
  `, [CLIENT, bookingCode]);
  const rows = r.rows;
  if (!rows.length) return { booking_code: bookingCode, found: false, bed_rows: 0, bed_codes: [] };
  const bedRows = rows.filter((x) => x.bed_code);
  return {
    booking_id: rows[0].booking_id,
    booking_code: bookingCode,
    status: rows[0].status,
    check_in: rows[0].check_in,
    check_out: rows[0].check_out,
    found: true,
    bed_rows: bedRows.length,
    bed_codes: bedRows.map((x) => x.bed_code),
    assignments: bedRows.map((x) => ({
      bed: x.bed_code,
      start: x.assignment_start_date,
      end: x.assignment_end_date,
    })),
  };
}

(async () => {
  const out = {
    commit: COMMIT,
    image: IMAGE,
    revision: activeRevision(),
    operator_name: OPERATOR,
    date_range: { check_in: CHECK_IN, check_out: CHECK_OUT, release_start: RELEASE_START, release_end: RELEASE_END },
    proofs: {},
    safety: {},
  };
  out.deploy_ok = out.revision.health === 'Healthy'
    && out.revision.traffic === 100
    && out.revision.image === IMAGE;

  const pg = new Client({ connectionString: getStagingDbUrl(), ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const countsBefore = await safetyCounts(pg);

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  const rooms = await req('GET', `/staff/tour-operator/rooms?client=${CLIENT}`, null, cookie);
  const pickRoom = (rooms.body?.rooms || []).find((r) => (r.beds || []).length > 0);
  const roomCode = pickRoom?.room_code;
  const bedCodes = (pickRoom?.beds || []).map((b) => b.bed_code).filter(Boolean);
  if (!roomCode) throw new Error('No room with beds found from rooms API');
  out.room_code = roomCode;
  out.expected_bed_codes = bedCodes;

  const previewCreate = await req('POST', '/staff/tour-operator/blocks/preview?client=' + CLIENT, {
    client_slug: CLIENT,
    operator_name: OPERATOR,
    room_code: roomCode,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
  }, cookie);

  const create = await req('POST', '/staff/tour-operator/blocks/create?client=' + CLIENT, {
    client_slug: CLIENT,
    operator_name: OPERATOR,
    room_code: roomCode,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    notes: 'stage107a2 deploy proof disposable',
    confirm: true,
    idempotency_key: 'stage107a2-create-' + Date.now(),
  }, cookie);

  const booking = create.body?.booking || {};
  out.proofs.create = {
    preview_ok: previewCreate.body?.success && previewCreate.body?.preview?.can_create,
    preview_bed_count: previewCreate.body?.preview?.bed_count,
    create_status: create.status,
    create_success: create.body?.success,
    booking_code: booking.booking_code,
    booking_id: booking.booking_id,
    bed_count: booking.bed_count,
    bed_codes: booking.bed_codes,
    all_room_beds: bedCodes.length > 0 && booking.bed_count === bedCodes.length
      && bedCodes.every((bc) => (booking.bed_codes || []).includes(bc)),
  };

  const dbCreate = await bookingBedsForCode(pg, booking.booking_code);
  out.proofs.create_db_beds = {
    bed_rows: dbCreate.bed_rows,
    bed_codes: dbCreate.bed_codes,
    matches_api: dbCreate.bed_rows === booking.bed_count,
    all_sellable_beds: bedCodes.length > 0 && dbCreate.bed_codes.length === bedCodes.length
      && bedCodes.every((bc) => dbCreate.bed_codes.includes(bc)),
  };

  const calAfterCreate = await req('GET', `/staff/bed-calendar?client=${CLIENT}&start=${CHECK_IN}&end=${CHECK_OUT}`, null, cookie);
  const ourBlocksCreate = blocksForRoom(calAfterCreate, roomCode, CHECK_IN, CHECK_OUT)
    .filter((b) => b.booking_code === booking.booking_code);
  out.proofs.calendar_after_create = {
    block_count_for_booking: ourBlocksCreate.length,
    all_sellable_beds_blocked: bedCodes.every((bc) => ourBlocksCreate.some((b) => b.bed_code === bc)),
    operator_colored: ourBlocksCreate.length > 0 && ourBlocksCreate.every((b) =>
      (b.color_type || '') === 'operator' || (b.booking_source || '') === 'operator' || b.is_operator_block),
    sample: ourBlocksCreate.slice(0, 4).map((b) => ({
      bed: b.bed_code, start: b.start_date, end: b.end_date,
      color: b.color_type, src: b.booking_source, is_op: b.is_operator_block,
    })),
  };

  const previewRelease = await req('POST', '/staff/tour-operator/release/preview?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_id: booking.booking_id,
    room_code: roomCode,
    release_start: RELEASE_START,
    release_end: RELEASE_END,
    reason: 'stage107a2 deploy proof release',
  }, cookie);

  const release = await req('POST', '/staff/tour-operator/release?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_id: booking.booking_id,
    room_code: roomCode,
    release_start: RELEASE_START,
    release_end: RELEASE_END,
    reason: 'stage107a2 deploy proof release',
    confirm: true,
    idempotency_key: 'stage107a2-release-' + Date.now(),
  }, cookie);

  const blockA = release.body?.release?.block_a || {};
  const blockB = release.body?.release?.block_b || {};
  out.proofs.release = {
    preview_ok: previewRelease.body?.success && previewRelease.body?.can_release,
    release_status: release.status,
    release_success: release.body?.success,
    original_cancelled: true,
    block_a_code: blockA.booking_code,
    block_b_code: blockB.booking_code,
    block_a_bed_count_api: blockA.bed_count,
    block_b_bed_count_api: blockB.bed_count,
    block_a_bed_codes_api: blockA.bed_codes,
    block_b_bed_codes_api: blockB.bed_codes,
  };

  const dbOrig = await bookingBedsForCode(pg, booking.booking_code);
  const dbA = blockA.booking_code ? await bookingBedsForCode(pg, blockA.booking_code) : null;
  const dbB = blockB.booking_code ? await bookingBedsForCode(pg, blockB.booking_code) : null;

  out.proofs.ab_booking_beds = {
    original: { status: dbOrig.status, bed_rows: dbOrig.bed_rows },
    block_a: dbA ? {
      check_in: dbA.check_in,
      check_out: dbA.check_out,
      bed_rows: dbA.bed_rows,
      bed_codes: dbA.bed_codes,
      all_room_beds: bedCodes.every((bc) => dbA.bed_codes.includes(bc)),
      dates_match: dbA.check_in === CHECK_IN && dbA.check_out === RELEASE_START,
    } : null,
    block_b: dbB ? {
      check_in: dbB.check_in,
      check_out: dbB.check_out,
      bed_rows: dbB.bed_rows,
      bed_codes: dbB.bed_codes,
      all_room_beds: bedCodes.every((bc) => dbB.bed_codes.includes(bc)),
      dates_match: dbB.check_in === RELEASE_END && dbB.check_out === CHECK_OUT,
    } : null,
  };

  const blocksAfterRelease = await req('GET', `/staff/tour-operator/blocks?client=${CLIENT}`, null, cookie);
  const listedA = (blocksAfterRelease.body?.blocks || []).find((b) => b.booking_code === blockA.booking_code);
  const listedB = (blocksAfterRelease.body?.blocks || []).find((b) => b.booking_code === blockB.booking_code);
  out.proofs.blocks_api = {
    block_a_listed: !!listedA,
    block_b_listed: !!listedB,
    block_a_dates: listedA ? { check_in: listedA.check_in, check_out: listedA.check_out } : null,
    block_b_dates: listedB ? { check_in: listedB.check_in, check_out: listedB.check_out } : null,
  };

  const calAfterRelease = await req('GET', `/staff/bed-calendar?client=${CLIENT}&start=${CHECK_IN}&end=${CHECK_OUT}`, null, cookie);
  const roomBlocks = blocksForRoom(calAfterRelease, roomCode, CHECK_IN, CHECK_OUT);

  function bedsFreeOnDate(dateIso) {
    return bedCodes.filter((bc) => !roomBlocks.some((b) =>
      b.bed_code === bc && b.start_date <= dateIso && b.end_date > dateIso));
  }

  const releaseMid = '2028-04-07';
  const beforeRelease = '2028-04-02';
  const afterRelease = '2028-04-12';
  out.proofs.calendar_after_release = {
    release_window_free: bedsFreeOnDate(releaseMid).length === bedCodes.length,
    before_still_blocked: bedsFreeOnDate(beforeRelease).length === 0,
    after_still_blocked: bedsFreeOnDate(afterRelease).length === 0,
    block_a_on_calendar: roomBlocks.filter((b) => b.booking_code === blockA.booking_code).length,
    block_b_on_calendar: roomBlocks.filter((b) => b.booking_code === blockB.booking_code).length,
    operator_styled_remainders: roomBlocks
      .filter((b) => b.booking_code === blockA.booking_code || b.booking_code === blockB.booking_code)
      .every((b) => (b.color_type || '') === 'operator' || (b.booking_source || '') === 'operator' || b.is_operator_block),
    sample: roomBlocks.filter((b) =>
      b.booking_code === blockA.booking_code || b.booking_code === blockB.booking_code).slice(0, 4)
      .map((b) => ({ code: b.booking_code, bed: b.bed_code, start: b.start_date, end: b.end_date, color: b.color_type })),
  };

  const countsAfter = await safetyCounts(pg);
  await pg.end();

  out.safety = {
    staging_host: HOST.includes('staging'),
    payments_unchanged: countsBefore.payments === countsAfter.payments,
    service_records_unchanged: countsBefore.service_records === countsAfter.service_records,
    create_no_whatsapp: create.body?.no_whatsapp === true,
    create_no_n8n: create.body?.no_n8n === true,
    create_no_stripe: create.body?.no_stripe === true,
    release_no_whatsapp: release.body?.no_whatsapp === true,
    release_no_n8n: release.body?.no_n8n !== false,
    release_no_stripe: release.body?.no_stripe !== false,
    counts_before: countsBefore,
    counts_after: countsAfter,
  };

  const checks = {
    deploy: out.deploy_ok,
    create: out.proofs.create.create_success && out.proofs.create.all_room_beds,
    create_db_beds: out.proofs.create_db_beds.all_sellable_beds,
    calendar_create: out.proofs.calendar_after_create.all_sellable_beds_blocked,
    release: out.proofs.release.release_success,
    ab_beds_a: out.proofs.ab_booking_beds.block_a?.all_room_beds && out.proofs.ab_booking_beds.block_a?.dates_match,
    ab_beds_b: out.proofs.ab_booking_beds.block_b?.all_room_beds && out.proofs.ab_booking_beds.block_b?.dates_match,
    original_no_beds: out.proofs.ab_booking_beds.original.bed_rows === 0,
    blocks_api: out.proofs.blocks_api.block_a_listed && out.proofs.blocks_api.block_b_listed,
    calendar_release: out.proofs.calendar_after_release.release_window_free
      && out.proofs.calendar_after_release.before_still_blocked
      && out.proofs.calendar_after_release.after_still_blocked,
    operator_styling: out.proofs.calendar_after_create.operator_colored
      && out.proofs.calendar_after_release.operator_styled_remainders,
    safety: out.safety.payments_unchanged && out.safety.service_records_unchanged,
  };
  out.checks = checks;
  out.failures = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  out.result = out.failures.length === 0 ? 'PASS' : (out.failures.length <= 2 ? 'PARTIAL' : 'FAIL');
  console.log(JSON.stringify(out, null, 2));
  if (out.failures.length > 0) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
