'use strict';
const https = require('https');
const { execSync } = require('child_process');
const HOST = 'staff-staging.lunafrontdesk.com';
const C = 'wolfhouse-somo';
function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST, path, method,
      headers: {
        Accept: 'application/json',
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
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
(async () => {
  const login = await req('POST', '/staff/auth/login', {
    client: C, email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const dc = await req('POST', '/staff/bookings/edit-preview?client=' + C, {
    client_slug: C, booking_code: 'MB-WOLFHO-20260920-4f62e2', edit_type: 'dates',
    check_in: '2026-07-10', check_out: '2026-07-20',
  }, cookie);
  const dwc = await req('POST', '/staff/bookings/edit?client=' + C, {
    client_slug: C, booking_code: 'MB-WOLFHO-20260920-4f62e2', edit_type: 'dates',
    check_in: '2026-07-10', check_out: '2026-07-20',
    idempotency_key: 'probe-conflict-write',
  }, cookie);
  const dp = await req('POST', '/staff/bookings/edit-preview?client=' + C, {
    client_slug: C, booking_code: 'MB-WOLFHO-20260920-4f62e2', edit_type: 'dates',
    check_in: '2026-09-24', check_out: '2026-09-27',
  }, cookie);
  console.log(JSON.stringify({
    date_allowed_preview: { status: dp.status, can_apply: dp.body.can_apply, preview_only: dp.body.preview_only },
    date_conflict_preview: { status: dc.status, can_apply: dc.body.can_apply, conflicts: (dc.body.conflicts || []).length, sample: (dc.body.conflicts || [])[0] },
    date_conflict_write: { status: dwc.status, can_apply: dwc.body.can_apply, updated: dwc.body.updated, error: dwc.body.error },
  }, null, 2));
})();
