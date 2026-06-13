'use strict';

const https = require('https');
const { execSync } = require('child_process');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';

function req(method, path, body, cookie, accept, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: accept || 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(extraHeaders || {}),
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

async function login() {
  const res = await req('POST', '/staff/auth/login', {
    client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  if (res.status !== 200) throw new Error(`login failed ${res.status}`);
  return (res.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
}

function activeRevision() {
  const raw = execSync(
    'az containerapp revision list --name wh-staging-staff-api --resource-group wh-staging-rg -o json',
    { encoding: 'utf8' },
  );
  const rows = JSON.parse(raw);
  const a = rows.find((x) => x.properties.trafficWeight === 100) || {};
  return {
    name: a.name,
    health: a.properties.healthState,
    traffic: a.properties.trafficWeight,
    image: a.properties.template?.containers?.[0]?.image,
  };
}

(async () => {
  const out = { revision: activeRevision(), calendar: {}, ui: {}, manual: {} };
  const cookie = await login();

  const cal = await req(
    'GET',
    `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=2026-07-01&end=2026-08-31`,
    null,
    cookie,
  );
  out.calendar.status = cal.status;
  const rooms = cal.body?.rooms || [];
  const bedCodes = [];
  for (const room of rooms) {
    for (const bed of room.beds || []) bedCodes.push(bed.bed_code);
  }
  out.calendar.room_codes = rooms.map((r) => r.room_code).sort();
  out.calendar.bed_codes = bedCodes.sort();
  out.calendar.room_count = rooms.length;
  out.calendar.bed_count = bedCodes.length;
  out.calendar.inventory_source = cal.body?.inventory_source || null;
  out.calendar.has_demo_rooms = out.calendar.room_codes.some((c) => /^DEMO-/i.test(c));
  out.calendar.real_r1_r10 = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10']
    .every((c) => out.calendar.room_codes.includes(c));
  out.calendar.fill_priority_order = rooms.map((r) => ({
    room_code: r.room_code,
    sort_order: r.sort_order,
    fill_priority: r.fill_priority,
    gender_strategy: r.gender_strategy,
    often_used_by_operator: r.often_used_by_operator,
    bed_count: (r.beds || []).length,
  }));
  out.calendar.r3_first = rooms[0]?.room_code === 'R3';
  out.calendar.r5_female = rooms.find((r) => r.room_code === 'R5')?.gender_strategy || null;
  out.calendar.r6_private = rooms.find((r) => r.room_code === 'R6')?.gender_strategy || null;
  out.calendar.operator_rooms = rooms.filter((r) => r.often_used_by_operator).map((r) => r.room_code);

  const ui = await req('GET', '/staff/ui', null, cookie, 'text/html');
  out.ui.status = ui.status;
  out.ui.has_demo_r1 = /DEMO-R1/i.test(ui.raw || '');
  out.ui.has_real_r3 = /\bR3\b/.test(ui.raw || '');
  out.ui.has_female_label = /female/i.test(ui.raw || '');
  out.ui.has_private_label = /private/i.test(ui.raw || '');

  const mb = await req('POST', '/staff/manual-bookings/preview', {
    client_slug: CLIENT,
    check_in: '2026-08-18',
    check_out: '2026-08-25',
    guest_count: 1,
    package_code: 'malibu',
    selected_bed_codes: ['R3-B1'],
  }, cookie);
  out.manual.status = mb.status;
  const mbBeds = mb.body?.available_beds || mb.body?.bed_options || mb.body?.beds || [];
  out.manual.bed_sample = (Array.isArray(mbBeds) ? mbBeds : []).slice(0, 8).map((b) => b.bed_code || b.code || b.label);
  out.manual.real_bed_pattern = (Array.isArray(mbBeds) ? mbBeds : [])
    .some((b) => /^R\d+-B\d+$/i.test(String(b.bed_code || b.code || '')));

  const ask = await req('POST', '/staff/ask-luna', {
    client_slug: CLIENT,
    question: 'How many free beds Aug 18 to Aug 25?',
  }, cookie);
  out.ask_luna = {
    status: ask.status,
    intent: ask.body?.intent || ask.body?.classified_intent || null,
    mentions_real_beds: /R\d+-B\d+|R[1-9]|R10/i.test(String(ask.body?.answer || ask.body?.response || '')),
    answer_snippet: String(ask.body?.answer || ask.body?.response || '').slice(0, 180),
  };

  const token = execSync(
    'az keyvault secret show --vault-name wh-staging-kv --name luna-bot-internal-token --query value -o tsv',
    { encoding: 'utf8' },
  ).trim();
  const gateExt = await req('POST', '/staff/bot/check-guest-automation-gate', {
    client_slug: CLIENT,
    guest_phone: '+34600995555',
    channel: 'whatsapp',
    phone_number_id: '1152900101233109',
  }, null, 'application/json', { 'X-Luna-Bot-Token': token });
  out.inbound_gate_external = { status: gateExt.status, body: gateExt.body };

  console.log(JSON.stringify(out, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
