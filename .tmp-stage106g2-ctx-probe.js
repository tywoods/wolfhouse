'use strict';
const https = require('https');
function req(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: 'staff-staging.lunafrontdesk.com', path, method,
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
    client: 'wolfhouse-somo', email: 'operator.stage72c@example.test', password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');
  for (const code of ['MB-WOLFHO-20260718-62de5c', 'MB-WOLFHO-20260609-16fd25', 'MB-WOLFHO-20290701-376db8']) {
    const ctx = await req('GET', `/staff/bookings/${code}/context?client=wolfhouse-somo`, null, cookie);
    const bk = ctx.body?.booking;
    const pay = ctx.body?.payments?.rows || [];
    const paid = pay.filter((p) => String(p.payment_status).toLowerCase() === 'paid')
      .reduce((s, p) => s + Number(p.amount_paid_cents || 0), 0);
    const ch = pay.find((p) => String(p.payment_status).toLowerCase() === 'checkout_created');
    console.log(code, {
      balance: bk?.balance_due_cents,
      total: bk?.total_amount_cents,
      deposit: bk?.deposit_required_cents,
      ledgerPaid: paid,
      link: ch && { due: ch.amount_due_cents, kind: ch.payment_kind },
    });
  }
})();
