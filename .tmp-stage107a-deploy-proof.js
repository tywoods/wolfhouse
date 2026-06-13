'use strict';

const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const COMMIT = '4e42a85b70f8de1d9c34ac9f49d63faeb51b1458';
const IMAGE = 'whstagingacr.azurecr.io/wh-staff-api:4e42a85-stage107a-tour-operator-actions';
const OPERATOR = 'Stage107a Deploy Test ' + Date.now();

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

function extractTourTab(html) {
  const s = html.indexOf('id="tab-tour-operator"');
  const e = html.indexOf('</div><!-- /tab-tour-operator -->', s);
  return s >= 0 && e > s ? html.slice(s, e) : '';
}

function blocksForRoom(cal, roomCode, start, end) {
  return (cal.body?.blocks || []).filter((b) => {
    if ((b.room_code || '').toUpperCase() !== roomCode.toUpperCase()) return false;
    if (b.start_date >= end || b.end_date <= start) return false;
    return true;
  });
}

function operatorBlocks(blocks) {
  return blocks.filter((b) => (b.booking_source || '').toLowerCase() === 'operator' || (b.color_type || '') === 'operator');
}

(async () => {
  const out = {
    commit: COMMIT,
    image: IMAGE,
    acr_run: 'cb2n',
    revision: activeRevision(),
    operator_name: OPERATOR,
    proofs: {},
    safety: {},
  };
  out.deploy_ok = out.revision.health === 'Healthy'
    && out.revision.traffic === 100
    && out.revision.image === IMAGE;

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  const ui = await req('GET', '/staff/ui', null, cookie);
  const uiRaw = ui.raw || '';
  const tab = extractTourTab(uiRaw);
  const jsStart = uiRaw.indexOf('/* ── Tour Operator forms');
  const toJs = jsStart >= 0 ? uiRaw.slice(jsStart, uiRaw.indexOf('\nfunction loadBedCalendar', jsStart)) : '';

  out.proofs.ui = {
    status: ui.status,
    no_shadow_copy: !/READ-ONLY.*writes disabled|Preview only.*coming soon|approval gates before they can be enabled|no operator block will be created|no dates will be released|Dynamic operator block list.*coming soon/i.test(tab),
    has_create_btn: /id="to-op-create-btn"/.test(tab) && !/disabled[^>]*id="to-op-create-btn"|id="to-op-create-btn"[^>]*disabled/.test(tab),
    has_release_btn: /id="to-rr-release-btn"/.test(tab) && !/disabled[^>]*id="to-rr-release-btn"|id="to-rr-release-btn"[^>]*disabled/.test(tab),
    js_gating: /function toOpFormReady/.test(toJs) && /function toRrFormReady/.test(toJs),
    rooms_api: /\/staff\/tour-operator\/rooms/.test(toJs),
    blocks_api: /\/staff\/tour-operator\/blocks/.test(toJs),
    calendar_reload: /function toAfterMutation/.test(toJs) && /loadBedCalendar/.test(toJs),
  };

  const rooms = await req('GET', `/staff/tour-operator/rooms?client=${CLIENT}`, null, cookie);
  out.proofs.rooms = {
    status: rooms.status,
    success: rooms.body?.success,
    room_count: (rooms.body?.rooms || []).length,
    source: rooms.body?.source,
    sample_codes: (rooms.body?.rooms || []).slice(0, 5).map((r) => r.room_code),
  };

  const blocksBefore = await req('GET', `/staff/tour-operator/blocks?client=${CLIENT}`, null, cookie);
  out.proofs.blocks_before = {
    status: blocksBefore.status,
    count: (blocksBefore.body?.blocks || []).length,
  };

  // Pick first active room with sellable beds from rooms API
  const pickRoom = (rooms.body?.rooms || []).find((r) => (r.beds || []).length > 0);
  const roomCode = pickRoom?.room_code;
  const bedCodes = (pickRoom?.beds || []).map((b) => b.bed_code).filter(Boolean);
  if (!roomCode) throw new Error('No room with beds found from rooms API');

  const checkIn = '2028-03-01';
  const checkOut = '2028-03-15';
  const releaseStart = '2028-03-05';
  const releaseEnd = '2028-03-10';

  const previewCreate = await req('POST', '/staff/tour-operator/blocks/preview?client=' + CLIENT, {
    client_slug: CLIENT,
    operator_name: OPERATOR,
    room_code: roomCode,
    check_in: checkIn,
    check_out: checkOut,
  }, cookie);

  const create = await req('POST', '/staff/tour-operator/blocks/create?client=' + CLIENT, {
    client_slug: CLIENT,
    operator_name: OPERATOR,
    room_code: roomCode,
    check_in: checkIn,
    check_out: checkOut,
    notes: 'stage107a deploy proof disposable',
    confirm: true,
    idempotency_key: 'stage107a-create-' + Date.now(),
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
    error: create.body?.error,
    conflicts: create.body?.conflicts,
  };

  const calAfterCreate = await req('GET', `/staff/bed-calendar?client=${CLIENT}&start=${checkIn}&end=${checkOut}`, null, cookie);
  const roomBlocksAfterCreate = blocksForRoom(calAfterCreate, roomCode, checkIn, checkOut);
  const ourBlocks = roomBlocksAfterCreate.filter((b) => b.booking_code === booking.booking_code);
  const allBedsBlocked = bedCodes.length > 0 && bedCodes.every((bc) => ourBlocks.some((b) => b.bed_code === bc));

  out.proofs.calendar_after_create = {
    block_count_for_booking: ourBlocks.length,
    expected_beds: bedCodes.length,
    all_sellable_beds_blocked: allBedsBlocked,
    operator_colored: ourBlocks.every((b) => (b.color_type || '') === 'operator' || (b.booking_source || '') === 'operator'),
    sample: ourBlocks.slice(0, 3).map((b) => ({ bed: b.bed_code, start: b.start_date, end: b.end_date, color: b.color_type, src: b.booking_source })),
  };

  const blocksAfterCreate = await req('GET', `/staff/tour-operator/blocks?client=${CLIENT}`, null, cookie);
  const listed = (blocksAfterCreate.body?.blocks || []).find((b) => b.booking_id === booking.booking_id || b.booking_code === booking.booking_code);
  out.proofs.blocks_after_create = {
    listed: !!listed,
    label_room: listed?.room_code,
    check_in: listed?.check_in,
    check_out: listed?.check_out,
  };

  const previewRelease = await req('POST', '/staff/tour-operator/release/preview?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_id: booking.booking_id,
    room_code: roomCode,
    release_start: releaseStart,
    release_end: releaseEnd,
    reason: 'stage107a deploy proof release',
  }, cookie);

  const release = await req('POST', '/staff/tour-operator/release?client=' + CLIENT, {
    client_slug: CLIENT,
    booking_id: booking.booking_id,
    room_code: roomCode,
    release_start: releaseStart,
    release_end: releaseEnd,
    reason: 'stage107a deploy proof release',
    confirm: true,
    idempotency_key: 'stage107a-release-' + Date.now(),
  }, cookie);

  out.proofs.release = {
    preview_ok: previewRelease.body?.success && previewRelease.body?.can_release,
    release_status: release.status,
    release_success: release.body?.success,
    idempotent: release.body?.idempotent,
    block_a: release.body?.release?.block_a,
    block_b: release.body?.release?.block_b,
    error: release.body?.error,
  };

  const calAfterRelease = await req('GET', `/staff/bed-calendar?client=${CLIENT}&start=${checkIn}&end=${checkOut}`, null, cookie);
  const roomBlocksAfterRelease = blocksForRoom(calAfterRelease, roomCode, checkIn, checkOut);

  function bedsFreeOnDate(dateIso) {
    return bedCodes.filter((bc) => !roomBlocksAfterRelease.some((b) => b.bed_code === bc && b.start_date <= dateIso && b.end_date > dateIso));
  }

  const releaseMid = '2028-03-07';
  const beforeRelease = '2028-03-02';
  const afterRelease = '2028-03-12';
  out.proofs.calendar_after_release = {
    blocks_remaining: roomBlocksAfterRelease.filter((b) => (b.operator_name || b.guest_name || '').includes('Stage107a') || b.booking_code?.startsWith('OP-')).map((b) => ({
      code: b.booking_code,
      bed: b.bed_code,
      start: b.start_date,
      end: b.end_date,
    })),
    beds_free_mid_release: bedsFreeOnDate(releaseMid),
    beds_free_before: bedsFreeOnDate(beforeRelease),
    beds_free_after: bedsFreeOnDate(afterRelease),
    release_window_free: bedsFreeOnDate(releaseMid).length === bedCodes.length,
    before_still_blocked: bedsFreeOnDate(beforeRelease).length < bedCodes.length,
    after_still_blocked: bedsFreeOnDate(afterRelease).length < bedCodes.length,
  };

  out.safety = {
    staging_host: HOST.includes('staging'),
    no_wa_ui: !/graph\.facebook\.com/.test(uiRaw),
    no_n8n_ui: !/n8n\.cloud.*activate/i.test(uiRaw),
    no_stripe_api_ui: !/api\.stripe\.com/.test(toJs + tab),
    create_no_whatsapp: create.body?.no_whatsapp === true,
    create_no_n8n: create.body?.no_n8n === true,
    create_no_stripe: create.body?.no_stripe === true,
    release_no_whatsapp: release.body?.no_whatsapp === true,
    release_send_mutation: release.body?.send_mutation === true,
  };

  const checks = {
    deploy: out.deploy_ok,
    ui: Object.values(out.proofs.ui).every(Boolean),
    rooms: out.proofs.rooms.success && out.proofs.rooms.room_count > 0,
    blocks_list: out.proofs.blocks_before.status === 200,
    create: out.proofs.create.create_success && out.proofs.create.preview_ok,
    calendar_create: out.proofs.calendar_after_create.all_sellable_beds_blocked && out.proofs.calendar_after_create.block_count_for_booking >= bedCodes.length,
    blocks_after_create: out.proofs.blocks_after_create.listed,
    release: out.proofs.release.release_success,
    calendar_release: out.proofs.calendar_after_release.release_window_free
      && out.proofs.calendar_after_release.before_still_blocked
      && out.proofs.calendar_after_release.after_still_blocked,
    safety: Object.values(out.safety).every(Boolean),
  };
  out.checks = checks;
  out.failures = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  out.result = out.failures.length === 0 ? 'PASS' : (out.failures.length <= 2 ? 'PARTIAL' : 'FAIL');
  console.log(JSON.stringify(out, null, 2));
  if (out.failures.length > 0) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
