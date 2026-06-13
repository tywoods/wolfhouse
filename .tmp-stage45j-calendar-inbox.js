'use strict';
const https = require('https');
const { Client } = require('pg');
const { execSync } = require('child_process');
const CLIENT = 'wolfhouse-somo';
const GUEST_PHONE = '+34600995567';
const BOOKING_CODE = 'WH-G27-F88DB3CBBD';

function az(c) { return execSync(c, { encoding: 'utf8' }).trim(); }

(async () => {
  const whUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: whUrl, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const phoneRaw = GUEST_PHONE.replace(/^\+/, '');
  const conv = (await pg.query(`
    SELECT c.id::text, c.phone, c.current_hold_booking_id::text,
           c.metadata->>'open_phone_testing' AS open_phone_testing,
           c.metadata->>'guest_tester_class' AS guest_tester_class
      FROM conversations c INNER JOIN clients cl ON cl.id = c.client_id
     WHERE cl.slug = $4 AND (c.phone = $1 OR c.phone = $2 OR c.phone = $3)
     ORDER BY c.updated_at DESC LIMIT 1`,
    [GUEST_PHONE, phoneRaw, `+${phoneRaw}`, CLIENT])).rows[0];
  await pg.end();

  const login = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ client: CLIENT, email: 'operator.stage72c@example.test', password: 'OperatorPass123!' });
    const req = https.request({
      hostname: 'staff-staging.lunafrontdesk.com', path: '/staff/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve(res.headers['set-cookie']));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
  const cookie = (login || []).map((x) => x.split(';')[0]).join('; ');

  const cal = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'staff-staging.lunafrontdesk.com',
      path: `/staff/bed-calendar?client=${encodeURIComponent(CLIENT)}&start=2026-08-01&end=2026-08-31`,
      method: 'GET', headers: { Accept: 'application/json', Cookie: cookie },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    req.on('error', reject);
    req.end();
  });

  const holds = [];
  for (const room of cal?.rooms || []) {
    for (const bed of room.beds || []) {
      for (const h of bed.holds || []) {
        if (h.booking_code === BOOKING_CODE) holds.push({ bed: bed.bed_code, hold: h });
      }
    }
  }

  const inbox = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'staff-staging.lunafrontdesk.com', path: `/staff/conversations?client=${CLIENT}&limit=80`, method: 'GET',
      headers: { Accept: 'application/json', Cookie: cookie },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    req.on('error', reject);
    req.end();
  });
  const convs = inbox?.conversations || inbox?.data || [];
  const hit = convs.find((c) => c.id === conv?.id) || null;

  const detail = conv?.id ? await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'staff-staging.lunafrontdesk.com',
      path: `/staff/conversations/${conv.id}/bookings?client=${CLIENT}`,
      method: 'GET', headers: { Accept: 'application/json', Cookie: cookie },
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: b }); } });
    });
    req.on('error', reject);
    req.end();
  }) : null;

  console.log(JSON.stringify({ conversation: conv, inbox_hit: hit, calendar_holds: holds, conversation_bookings_api: detail }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
