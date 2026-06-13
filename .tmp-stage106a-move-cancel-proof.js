'use strict';

const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:590484f-stage106a-drawer-clean-final';
const COMMIT = '590484f';

function req(method, path, body, cookie, accept) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: accept || 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
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
    { encoding: 'utf8' }
  ));
  const active = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: active.name,
    health: active.properties.healthState,
    traffic: active.properties.trafficWeight,
    image: active.properties.template.containers[0].image,
  };
}

function dbUrl() {
  return execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv',
    { encoding: 'utf8' }
  ).trim();
}

async function snap(pg, bookingCode) {
  const b = await pg.query(`
    SELECT b.id::text AS booking_id, b.booking_code, b.guest_name, b.status::text AS status,
           b.amount_paid_cents, b.check_in::text AS check_in, b.check_out::text AS check_out
    FROM bookings b
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2 LIMIT 1
  `, [CLIENT, bookingCode]);
  const beds = await pg.query(`
    SELECT bb.id::text AS booking_bed_id, bb.bed_id::text AS bed_id, bb.bed_code, bb.room_code
    FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
    ORDER BY bb.bed_code
  `, [CLIENT, bookingCode]);
  const pays = await pg.query(`
    SELECT p.id::text, p.status::text, p.amount_paid_cents
    FROM payments p
    INNER JOIN bookings b ON b.id = p.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2 ORDER BY p.created_at
  `, [CLIENT, bookingCode]);
  let svc = [];
  try {
    svc = (await pg.query(
      'SELECT id::text, service_type, amount_due_cents FROM booking_service_records WHERE client_slug = $1 AND booking_code = $2 ORDER BY created_at',
      [CLIENT, bookingCode]
    )).rows;
  } catch (_) { svc = []; }
  return { booking: b.rows[0], beds: beds.rows, payments: pays.rows, service_records: svc };
}

function truthSame(a, b) {
  return JSON.stringify(a.payments) === JSON.stringify(b.payments)
    && JSON.stringify(a.service_records) === JSON.stringify(b.service_records)
    && Number(a.booking.amount_paid_cents) === Number(b.booking.amount_paid_cents);
}

function blocksForBed(cal, bedCode, bookingCode) {
  const blocks = (cal.blocks || []).filter((bl) =>
    bl.bed_code === bedCode && (!bookingCode || bl.booking_code === bookingCode)
  );
  return blocks;
}

async function pickTargetFromApi(cookie, bookingCode, bookingBedId, checkIn, checkOut, sourceBedCode) {
  const mt = await req('POST', '/staff/bookings/move-targets', {
    client_slug: CLIENT,
    booking_code: bookingCode,
    booking_bed_id: bookingBedId,
    check_in: checkIn,
    check_out: checkOut,
  }, cookie);
  const targets = (mt.body && mt.body.targets) || [];
  const available = targets.filter((t) => t.available && t.bed_code !== sourceBedCode);
  return { moveTargets: mt, target: available[0] || null };
}

async function loadDisposable(pg, cookie, bookingCode, needMoveTarget) {
  const s = await snap(pg, bookingCode);
  if (!s.booking || s.booking.status !== 'confirmed' || s.beds.length !== 1) {
    throw new Error('disposable booking unavailable: ' + bookingCode);
  }
  const source = s.beds[0];
  const out = {
    bookingCode,
    checkIn: s.booking.check_in,
    checkOut: s.booking.check_out,
    sourceBed: source.bed_code,
    snap: s,
  };
  if (needMoveTarget) {
    const picked = await pickTargetFromApi(
      cookie, bookingCode, source.booking_bed_id, s.booking.check_in, s.booking.check_out, source.bed_code
    );
    if (!picked.target) throw new Error('no move target for ' + bookingCode);
    out.targetBed = { bed_id: picked.target.bed_id, bed_code: picked.target.bed_code };
    out.moveTargets = picked.moveTargets.body;
  }
  return out;
}

(async () => {
  const out = { commit: COMMIT, image: IMAGE, revision: activeRevision() };

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  if (login.status !== 200) throw new Error('login failed');
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const pg = new Client({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const ui = await req('GET', '/staff/ui', null, cookie, 'text/html');
  const uiRaw = ui.raw || '';

  // Disposable staging bookings (created earlier in proof runs; not golden demos).
  const MOVE_CODE = 'MB-WOLFHO-20260923-890416';
  let CANCEL_CODE = 'MB-WOLFHO-20261010-613ded';

  // ── Test A: Move bed on disposable booking A ───────────────────────────────
  const moveBk = await loadDisposable(pg, cookie, MOVE_CODE, true);
  const beforeMove = moveBk.snap;
  const source = beforeMove.beds[0];
  if (!source) throw new Error('move booking has no bed');

  const moveKey = 'stage106a-move-' + Date.now();
  const move = await req('POST', '/staff/bookings/move', {
    client_slug: CLIENT,
    booking_code: moveBk.bookingCode,
    booking_bed_id: source.booking_bed_id,
    target_bed_id: moveBk.targetBed.bed_id,
    check_in: moveBk.checkIn,
    check_out: moveBk.checkOut,
    idempotency_key: moveKey,
    reason: 'Stage106a hosted move proof',
  }, cookie);

  const afterMove = await snap(pg, moveBk.bookingCode);
  const ctxAfterMove = await req('GET', '/staff/bookings/' + encodeURIComponent(moveBk.bookingCode) + '/context?client=' + CLIENT, null, cookie);

  const calUrl = '/staff/bed-calendar?client=' + CLIENT +
    '&start=' + moveBk.checkIn + '&end=' + moveBk.checkOut;
  const calAfter = await req('GET', calUrl, null, cookie);
  const cal = calAfter.body || {};

  const oldBedBlocks = blocksForBed(cal, source.bed_code, moveBk.bookingCode);
  const newBedBlocks = blocksForBed(cal, moveBk.targetBed.bed_code, moveBk.bookingCode);

  out.testA_move = {
    booking_code: moveBk.bookingCode,
    source_before: source.bed_code,
    target: moveBk.targetBed.bed_code,
    move_targets_available: (moveBk.moveTargets && moveBk.moveTargets.targets || []).filter((t) => t.available).map((t) => t.bed_code),
    move_status: move.status,
    move_body: move.body,
    bed_after: afterMove.beds,
    payments_unchanged: truthSame(beforeMove, afterMove),
    context_status: ctxAfterMove.status,
    context_rooming: (ctxAfterMove.body && ctxAfterMove.body.rooming) || null,
    calendar: {
      old_bed_block_count: oldBedBlocks.length,
      new_bed_block_count: newBedBlocks.length,
      new_bed_guest: newBedBlocks[0] && newBedBlocks[0].guest_name,
    },
    pass: move.status === 200 && move.body && move.body.success && move.body.moved === true
      && afterMove.beds.length === 1
      && afterMove.beds[0].bed_code === moveBk.targetBed.bed_code
      && afterMove.beds[0].booking_bed_id === source.booking_bed_id
      && truthSame(beforeMove, afterMove)
      && oldBedBlocks.length === 0
      && newBedBlocks.length >= 1
      && ctxAfterMove.status === 200,
  };

  // ── Test B: Cancel disposable booking B ────────────────────────────────────
  let cancelSnap = await snap(pg, CANCEL_CODE);
  if (!cancelSnap.booking || cancelSnap.booking.status !== 'confirmed') {
    const ts = Date.now();
    const cancelCi = '2027-05-20';
    const cancelCo = '2027-05-24';
    const create = await req('POST', '/staff/manual-bookings/create?client=' + CLIENT, {
      client: CLIENT,
      check_in: cancelCi,
      check_out: cancelCo,
      guest_name: 'Stage106a MoveCancel cancel',
      phone: '+34600106999',
      email: 'stage106a.cancel.' + ts + '@example.test',
      guest_count: 1,
      package_code: 'malibu',
      room_type: 'shared',
      payment_choice: 'pay_on_arrival',
      payment_status: 'unpaid',
      selected_bed_codes: ['DEMO-R2-B2'],
      confirm: true,
      warnings_acknowledged: true,
      idempotency_key: 'stage106a-create-cancel-' + ts,
    }, cookie);
    const created = create.body || {};
    if (![200, 201].includes(create.status) || !created.booking_code) {
      throw new Error('cancel disposable create failed: ' + JSON.stringify(created));
    }
    CANCEL_CODE = created.booking_code;
  }
  const cancelBk = await loadDisposable(pg, cookie, CANCEL_CODE, false);
  const beforeCancel = cancelBk.snap;
  const cancelKey = 'stage106a-cancel-' + Date.now();
  const cancel = await req('POST', '/staff/bookings/cancel?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_code: cancelBk.bookingCode,
    idempotency_key: cancelKey,
    reason: 'Stage106a hosted cancel proof',
  }, cookie);

  const afterCancel = await snap(pg, cancelBk.bookingCode);
  const bedCount = (await pg.query(`
    SELECT COUNT(*)::int AS c FROM booking_beds bb
    INNER JOIN bookings b ON b.id = bb.booking_id
    INNER JOIN clients c ON c.id = b.client_id
    WHERE c.slug = $1 AND b.booking_code = $2
  `, [CLIENT, cancelBk.bookingCode])).rows[0].c;

  const calCancel = await req('GET',
    '/staff/bed-calendar?client=' + CLIENT + '&start=' + cancelBk.checkIn + '&end=' + cancelBk.checkOut,
    null, cookie);
  const calC = calCancel.body || {};
  const cancelBlocks = (calC.blocks || []).filter((bl) => bl.booking_code === cancelBk.bookingCode);
  const legendHasCancelled = /cancelled/i.test(uiRaw) &&
    /bc-legend|legend/i.test(uiRaw) &&
    /Cancelled/.test((uiRaw.match(/bc-legend[\s\S]{0,800}/) || [''])[0]);

  out.testB_cancel = {
    booking_code: cancelBk.bookingCode,
    cancel_status: cancel.status,
    cancel_body: cancel.body,
    status_after: afterCancel.booking && afterCancel.booking.status,
    beds_remaining: bedCount,
    payments_unchanged: truthSame(beforeCancel, afterCancel),
    calendar_blocks_for_booking: cancelBlocks.length,
    legend_cancelled_absent: !legendHasCancelled,
    pass: cancel.status === 200 && cancel.body && cancel.body.success && cancel.body.cancelled
      && afterCancel.booking.status === 'cancelled'
      && bedCount === 0
      && truthSame(beforeCancel, afterCancel)
      && cancelBlocks.length === 0,
  };

  out.safety = {
    revision_ok: out.revision.health === 'Healthy' && out.revision.traffic === 100
      && out.revision.image === IMAGE,
    no_stripe_api: !/api\.stripe\.com/.test(uiRaw),
    no_wa: !/graph\.facebook\.com/.test(uiRaw),
    no_n8n_activate: !/n8n\.cloud.*activate/i.test(uiRaw),
    move_no_payment_msg: /No payment, service, or message changes were made/.test((move.body && move.body.message) || ''),
    cancel_no_refund_msg: /no refund|No refund|Stripe/i.test((cancel.body && cancel.body.message) || '') || !!(cancel.body && cancel.body.success),
  };

  out.pass = {
    deploy: out.safety.revision_ok,
    move: out.testA_move.pass,
    cancel: out.testB_cancel.pass,
    safety: out.safety.no_stripe_api && out.safety.no_wa && out.safety.no_n8n_activate,
  };

  const all = Object.values(out.pass);
  out.result = all.every(Boolean) ? 'PASS' : (all.some(Boolean) ? 'PARTIAL' : 'FAIL');

  await pg.end();
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
