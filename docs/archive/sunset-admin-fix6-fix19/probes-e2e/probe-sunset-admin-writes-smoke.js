'use strict';
const https = require('https');

function request(method, url, { headers = {}, body = null, cookies = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: {
        Accept: 'application/json',
        ...(cookies ? { Cookie: cookies } : {}),
        ...(body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        } : {}),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch (_) { json = { raw: data.slice(0, 300) }; }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseSetCookie(setCookie) {
  const arr = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  return arr.map((c) => c.split(';')[0]).join('; ');
}

async function login(base, password) {
  const res = await request('POST', `${base}/staff/auth/login`, {
    body: JSON.stringify({ client: 'sunset', email: 'tywoods@gmail.com', password }),
  });
  return { status: res.status, cookies: parseSetCookie(res.headers['set-cookie']) };
}

async function getAdmin(base, cookies) {
  return request('GET', `${base}/staff/admin/config?client=sunset`, { cookies });
}

function summarize(cfg) {
  return {
    source: cfg.source,
    read_only: cfg.read_only,
    writes_enabled: cfg.writes_enabled,
    price_count: Array.isArray(cfg.prices) ? cfg.prices.length : null,
    lesson_cap: cfg.lesson_capacity && cfg.lesson_capacity.default_daily_cap,
    lesson_times: Array.isArray(cfg.lesson_times) ? cfg.lesson_times.length : null,
    change_history_length: Array.isArray(cfg.change_history) ? cfg.change_history.length : null,
    change_history: Array.isArray(cfg.change_history)
      ? cfg.change_history.map((r) => ({
        actor: r.actor || r.actor_email || r.changed_by,
        action: r.action,
        entity_type: r.entity_type,
        before: r.before_json || r.before,
        after: r.after_json || r.after,
      }))
      : [],
  };
}

async function putCapacity(base, cookies, cap) {
  return request('PUT', `${base}/staff/admin/config/lesson-capacity?client=sunset`, {
    cookies,
    body: JSON.stringify({ default_daily_cap: cap }),
  });
}

(async () => {
  const password = process.env.SUNSET_STAGING_PORTAL_PASSWORD;
  if (!password) {
    console.error('missing SUNSET_STAGING_PORTAL_PASSWORD');
    process.exit(2);
  }
  const base = 'https://sunset-staging.lunafrontdesk.com';
  const phase = process.argv[2] || 'preflight';

  const loginRes = await login(base, password);
  if (loginRes.status !== 200) {
    console.log(JSON.stringify({ phase, error: 'login_failed', login_status: loginRes.status }, null, 2));
    process.exit(1);
  }

  const admin = await getAdmin(base, loginRes.cookies);
  const cfg = admin.json || {};
  const summary = summarize(cfg);

  if (phase === 'preflight') {
    console.log(JSON.stringify({ phase, login_status: loginRes.status, admin_status: admin.status, ...summary }, null, 2));
    process.exit(admin.status === 200 ? 0 : 1);
  }

  if (phase === 'flag-on-check') {
    console.log(JSON.stringify({ phase, admin_status: admin.status, ...summary }, null, 2));
    const ok = admin.status === 200 && summary.source === 'db' && summary.writes_enabled === true;
    process.exit(ok ? 0 : 1);
  }

  if (phase === 'write-up') {
    const before = summary;
    const write = await putCapacity(base, loginRes.cookies, 25);
    const afterAdmin = await getAdmin(base, loginRes.cookies);
    const after = summarize(afterAdmin.json || {});
    console.log(JSON.stringify({
      phase,
      endpoint: 'PUT /staff/admin/config/lesson-capacity?client=sunset',
      write_status: write.status,
      write_body: write.json,
      before_cap: before.lesson_cap,
      after_cap: after.lesson_cap,
      audit_before: before.change_history_length,
      audit_after: after.change_history_length,
      latest_audit: after.change_history.slice(-1)[0] || null,
      summary: after,
    }, null, 2));
    const ok = write.status === 200
      && after.lesson_cap === 25
      && after.change_history_length === (before.change_history_length || 0) + 1;
    process.exit(ok ? 0 : 1);
  }

  if (phase === 'restore') {
    const before = summary;
    const restore = await putCapacity(base, loginRes.cookies, 24);
    const afterAdmin = await getAdmin(base, loginRes.cookies);
    const after = summarize(afterAdmin.json || {});
    console.log(JSON.stringify({
      phase,
      restore_status: restore.status,
      restore_body: restore.json,
      before_cap: before.lesson_cap,
      after_cap: after.lesson_cap,
      audit_before: before.change_history_length,
      audit_after: after.change_history_length,
      latest_audit: after.change_history.slice(-1)[0] || null,
      summary: after,
    }, null, 2));
    const ok = restore.status === 200
      && after.lesson_cap === 24
      && after.change_history_length === (before.change_history_length || 0) + 1
      && after.price_count === 23
      && after.lesson_times === 3;
    process.exit(ok ? 0 : 1);
  }

  if (phase === 'flag-off-check') {
    const blocked = await putCapacity(base, loginRes.cookies, 25);
    const afterBlock = await getAdmin(base, loginRes.cookies);
    const after = summarize(afterBlock.json || {});
    console.log(JSON.stringify({
      phase,
      admin_status: admin.status,
      blocked_write_status: blocked.status,
      blocked_error: blocked.json && blocked.json.error,
      ...summary,
      after_blocked: after,
    }, null, 2));
    const ok = admin.status === 200
      && summary.source === 'db'
      && summary.writes_enabled === false
      && summary.lesson_cap === 24
      && summary.price_count === 23
      && summary.lesson_times === 3
      && blocked.status === 403
      && blocked.json && blocked.json.error === 'writes_disabled'
      && after.change_history_length === summary.change_history_length;
    process.exit(ok ? 0 : 1);
  }

  console.error('unknown phase:', phase);
  process.exit(2);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
