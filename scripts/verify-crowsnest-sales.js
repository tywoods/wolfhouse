'use strict';

/**
 * Runtime + structural verifier for Crowsnest Luna Sales Slice 1.
 * Focused TDD gate — no DB, no external network deps.
 */

const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const API_SCRIPT = path.join(ROOT, 'scripts', 'crowsnest-api.js');
const API_PATH = path.join(ROOT, 'scripts', 'crowsnest-api.js');
const PAGE_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-page.js');
const SALES_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-sales.js');
const BASE_PORT = Number(process.env.CROWSNEST_VERIFY_SALES_PORT) || 13140;

let pass = 0;
let fail = 0;
let child = null;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail ? `— ${detail}` : '');
  }
}

function read(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function request(port, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...(options.headers || {}) };
    if (options.username != null && options.password != null) {
      const token = Buffer.from(`${options.username}:${options.password}`).toString('base64');
      headers.Authorization = `Basic ${token}`;
    }
    let body = options.body;
    if (body != null && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      body = String(body);
    }
    if (body != null && headers['Content-Length'] == null && headers['content-length'] == null) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: options.method || 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: buffer.toString('utf8'),
            buffer,
          });
        });
      },
    );
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function extractCookiePair(setCookie) {
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  return list.map((entry) => String(entry).split(';')[0]).join('; ');
}

function allowHeader(res) {
  return String(res.headers.allow || res.headers.Allow || '');
}

async function assertMethodRejected(port, urlPath, method, headers, expectedAllow) {
  const res = await request(port, urlPath, { method, headers });
  ok(`${method} ${urlPath} => 405`, res.statusCode === 405, `got ${res.statusCode}`);
  ok(`${method} ${urlPath} Allow header`, allowHeader(res) === expectedAllow, allowHeader(res));
  ok(`${method} ${urlPath} method-not-allowed body`, /method not allowed/i.test(res.body));
  return res;
}

function waitForHealthz(port, timeoutMs = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      request(port, '/healthz')
        .then((res) => {
          if (res.statusCode === 200) resolve();
          else retry();
        })
        .catch(retry);
    };
    function retry() {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Crowsnest did not become ready on port ${port}`));
        return;
      }
      setTimeout(tick, 150);
    }
    tick();
  });
}

function startServer(port, env) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [API_SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, ...env, CROWSNEST_PORT: String(port), CROWSNEST_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    waitForHealthz(port)
      .then(() => resolve(stderr))
      .catch((err) => {
        stopServer();
        reject(new Error(`${err.message}\n${stderr}`));
      });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!child) {
      resolve();
      return;
    }
    const current = child;
    child = null;
    current.once('exit', () => resolve());
    current.kill('SIGTERM');
    setTimeout(() => {
      try {
        current.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 2000);
  });
}

async function runScenario(name, port, env, steps) {
  console.log(`\n▸ ${name}`);
  await startServer(port, env);
  try {
    for (const step of steps) {
      await step(port);
    }
  } finally {
    await stopServer();
  }
}

function structuralChecks() {
  console.log('\n▸ Structural: Sales module + protected routes');
  const apiSrc = read(API_PATH) || '';
  const pageSrc = read(PAGE_PATH) || '';
  const salesSrc = read(SALES_PATH) || '';

  ok('crowsnest-sales.js exists', fs.existsSync(SALES_PATH));
  ok('page nav includes Sales href /sales', /href:\s*['"]\/sales['"]/.test(pageSrc) || /href=["']\/sales["']/.test(pageSrc));
  ok('page nav label Sales', /label:\s*['"]Sales['"]|>Sales</.test(pageSrc));
  ok('sales view registered', /['"]sales['"]/.test(pageSrc) && /CROWSNEST_VIEWS|CROWSNEST_NAV_ITEMS/.test(pageSrc));
  ok('router allowlists /sales', /pathname\s*===\s*['"]\/sales['"]/.test(apiSrc));
  ok('router allowlists prospect detail path', /\/sales\/prospects\//.test(apiSrc));
  ok('api requires crowsnest-sales', /require\(['"]\.\/lib\/crowsnest\/crowsnest-sales['"]\)/.test(apiSrc));
  ok('sales module exports createProspect', /createProspect|createCrowsnestProspect/.test(salesSrc));
  ok('sales module exports decideProspect', /decideProspect|recordProspectDecision|decideCrowsnestProspect/.test(salesSrc));
  ok('sales module exports audit helpers', /listAudit|getAudit|appendAudit|auditEvents/.test(salesSrc));
  ok('no HubSpot/Apollo/Google SDK live adapters in sales', !/require\(['"][^'"]*(hubspot|apollo|googleapis)/i.test(salesSrc));
  ok(
    'sales domain does not import pg or WOLFHOUSE_DATABASE_URL',
    !/require\(['"]pg['"]\)/.test(salesSrc) && !/WOLFHOUSE_DATABASE_URL/.test(salesSrc),
  );
  ok(
    'sales domain uses crowsnest-sales-store',
    /require\(['"]\.\/crowsnest-sales-store['"]\)/.test(salesSrc),
  );
}

async function main() {
  console.log('verify:crowsnest-sales — Luna Sales Slice 1\n');

  structuralChecks();

  // ── Behavior 1: protected Sales route + nav ─────────────────────────────
  await runScenario('1 Protected Sales route + nav', BASE_PORT, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
  }, [
    async (port) => {
      const unauth = await request(port, '/sales');
      ok(
        'unauthenticated GET /sales redirects to /login',
        unauth.statusCode === 302 && String(unauth.headers.location || '') === '/login',
        `status=${unauth.statusCode} loc=${unauth.headers.location}`,
      );

      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, '/sales', method, undefined, 'GET, HEAD');
      }

      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
      });
      const cookie = extractCookiePair(login.headers['set-cookie']);
      ok('login cookie for Sales scenario', /crowsnest_session=/.test(cookie));

      const sales = await request(port, '/sales', { headers: { Cookie: cookie } });
      ok('GET /sales => 200', sales.statusCode === 200, `got ${sales.statusCode}`);
      ok('GET /sales renders Sales heading', /<h1[^>]*>[\s\S]*Sales/i.test(sales.body));
      ok('GET /sales nav has Sales aria-current', /href=["']\/sales["'][^>]*aria-current=["']page["']|aria-current=["']page["'][^>]*href=["']\/sales["']/.test(sales.body));
      ok('GET /sales preserves Spyglass nav', /href=["']\/["']/.test(sales.body) && /Spyglass/i.test(sales.body));
      ok('GET /sales preserves Clients nav', /href=["']\/clients["']/.test(sales.body));
      ok('GET /sales preserves Billing nav', /href=["']\/billing["']/.test(sales.body));
      ok('GET /sales preserves Communications nav', /href=["']\/communications["']/.test(sales.body));
      ok('GET /sales shows manual intake form', /website|business.?name|canonical.?name/i.test(sales.body) && /<form\b/i.test(sales.body));

      const home = await request(port, '/', { headers: { Cookie: cookie } });
      ok('Spyglass nav includes Sales link', /href=["']\/sales["']/.test(home.body) && /Sales/i.test(home.body));
    },
  ]);

  // ── Behavior 2: manual intake → in-memory prospect ──────────────────────
  await runScenario('2 Manual intake creates in-memory prospect', BASE_PORT + 1, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
  }, [
    async (port) => {
      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
      });
      const cookie = extractCookiePair(login.headers['set-cookie']);

      const emptyReject = await request(port, '/sales/prospects', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'website_url=&business_name=',
      });
      ok(
        'empty intake rejected (400 or redisplays with error)',
        emptyReject.statusCode === 400
          || (emptyReject.statusCode === 200 && /required|provide|website|business.?name/i.test(emptyReject.body)),
        `status=${emptyReject.statusCode}`,
      );

      const unauthCreate = await request(port, '/sales/prospects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'business_name=Unauth Hostel',
      });
      ok(
        'unauthenticated POST /sales/prospects redirects to /login',
        unauthCreate.statusCode === 302 && String(unauthCreate.headers.location || '') === '/login',
      );

      for (const method of ['PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, '/sales/prospects', method, { Cookie: cookie }, 'POST');
      }

      const created = await request(port, '/sales/prospects', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'business_name=Somo Surf House&website_url=',
      });
      ok(
        'valid name-only intake redirects to prospect detail',
        created.statusCode === 302 && /\/sales\/prospects\/[a-zA-Z0-9_-]+/.test(String(created.headers.location || '')),
        `status=${created.statusCode} loc=${created.headers.location}`,
      );
      const detailPath = String(created.headers.location || '');

      const byWebsite = await request(port, '/sales/prospects', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'website_url=https://example-surf-house.example&business_name=',
      });
      ok(
        'valid website-only intake redirects to prospect detail',
        byWebsite.statusCode === 302 && /\/sales\/prospects\/[a-zA-Z0-9_-]+/.test(String(byWebsite.headers.location || '')),
        `status=${byWebsite.statusCode} loc=${byWebsite.headers.location}`,
      );

      const list = await request(port, '/sales', { headers: { Cookie: cookie } });
      ok('Sales list shows created prospect name', /Somo Surf House/i.test(list.body));
      ok('Sales list links to prospect detail', list.body.includes(detailPath) || /\/sales\/prospects\//.test(list.body));
    },
  ]);

  // ── Behavior 3: fixture research on review detail ───────────────────────
  await runScenario('3 Fixture research displayed on review detail', BASE_PORT + 2, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
  }, [
    async (port) => {
      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
      });
      const cookie = extractCookiePair(login.headers['set-cookie']);

      const created = await request(port, '/sales/prospects', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'business_name=Fixture Research Hostel&website_url=https://fixture-research.example',
      });
      const detailPath = String(created.headers.location || '');
      ok('research scenario created prospect', created.statusCode === 302 && detailPath.startsWith('/sales/prospects/'));

      const detail = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok('GET prospect detail => 200', detail.statusCode === 200);
      ok('detail shows business identity', /Fixture Research Hostel/i.test(detail.body));
      ok('detail shows website', /fixture-research\.example/i.test(detail.body));
      ok('detail shows lifecycle ready_for_review or researching', /ready_for_review|researching/i.test(detail.body));
      ok('detail shows fixture research job/data', /research/i.test(detail.body) && /fixture|manual|snapshot|evidence|citation/i.test(detail.body));
      ok('detail shows Admin decision controls', /approve/i.test(detail.body) && /reject/i.test(detail.body) && /needs.?research/i.test(detail.body));
      ok('detail has no HubSpot sync controls', !/sync to hubspot|push to hubspot|hubspot\.com|name=["']hubspot/i.test(detail.body));
      ok('detail has no outreach send controls', !/send outreach|send message|deliver outreach/i.test(detail.body));
    },
  ]);

  // ── Behavior 4: Admin decisions + append-only audit ─────────────────────
  await runScenario('4 Admin status decisions + audit trail', BASE_PORT + 3, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
  }, [
    async (port) => {
      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
      });
      const cookie = extractCookiePair(login.headers['set-cookie']);

      async function createProspect(name) {
        const created = await request(port, '/sales/prospects', {
          method: 'POST',
          headers: {
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: `business_name=${encodeURIComponent(name)}`,
        });
        return String(created.headers.location || '');
      }

      const approvePath = await createProspect('Approve Me Hostel');
      const prospectId = approvePath.split('/').pop();
      const decisionUrl = `/sales/prospects/${prospectId}/decision`;

      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, decisionUrl, method, { Cookie: cookie }, 'POST');
      }

      const unauthDecision = await request(port, decisionUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'decision=approved&reason=looks+good',
      });
      ok(
        'unauthenticated decision redirects to /login',
        unauthDecision.statusCode === 302 && String(unauthDecision.headers.location || '') === '/login',
      );

      const approved = await request(port, decisionUrl, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'decision=approved&reason=Strong+fit+for+pilot',
      });
      ok(
        'approve redirects back to detail',
        approved.statusCode === 302 && String(approved.headers.location || '') === approvePath,
        `status=${approved.statusCode} loc=${approved.headers.location}`,
      );

      const approvedDetail = await request(port, approvePath, { headers: { Cookie: cookie } });
      ok('approved status visible', /approved/i.test(approvedDetail.body));
      ok('approve reason visible', /Strong fit for pilot/i.test(approvedDetail.body));
      ok('audit trail visible after approve', /audit/i.test(approvedDetail.body));
      ok('audit includes approved decision', /approved/i.test(approvedDetail.body) && /Strong fit for pilot/i.test(approvedDetail.body));
      ok('audit includes Admin/operator actor', /admin|operator|reviewer/i.test(approvedDetail.body));

      const rejectPath = await createProspect('Reject Me Hostel');
      const rejectId = rejectPath.split('/').pop();
      const rejected = await request(port, `/sales/prospects/${rejectId}/decision`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'decision=rejected&reason=Out+of+market',
      });
      ok('reject redirects to detail', rejected.statusCode === 302);
      const rejectedDetail = await request(port, rejectPath, { headers: { Cookie: cookie } });
      ok('rejected status visible', /rejected/i.test(rejectedDetail.body));
      ok('reject reason in audit', /Out of market/i.test(rejectedDetail.body));

      const needsPath = await createProspect('Needs Research Hostel');
      const needsId = needsPath.split('/').pop();
      const needs = await request(port, `/sales/prospects/${needsId}/decision`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'decision=needs_research&reason=Need+contact+email',
      });
      ok('needs_research redirects to detail', needs.statusCode === 302);
      const needsDetail = await request(port, needsPath, { headers: { Cookie: cookie } });
      ok('needs_research status visible', /needs_research|needs.?research/i.test(needsDetail.body));
      ok('needs_research reason in audit', /Need contact email/i.test(needsDetail.body));

      // Append-only: prior approve audit must still be present if we revisit
      const stillApproved = await request(port, approvePath, { headers: { Cookie: cookie } });
      ok('prior approve audit still present (append-only)', /Strong fit for pilot/i.test(stillApproved.body));
    },
  ]);

  // ── Behavior 5: authenticated operators may mutate Sales ───────────────
  await runScenario('5 authenticated Crowsnest operators may mutate Sales', BASE_PORT + 4, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_EARTHLING_USERNAME: 'earthling-op',
    CROWSNEST_AUTH_EARTHLING_PASSWORD: 'earth-pass',
    CROWSNEST_AUTH_MONSHIES_USERNAME: 'monshies-op',
    CROWSNEST_AUTH_MONSHIES_PASSWORD: 'mon-pass',
  }, [
    async (port) => {
      const earthlingLogin = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=earthling-op&password=earth-pass',
      });
      const earthlingCookie = extractCookiePair(earthlingLogin.headers['set-cookie']);
      ok('Earthling login for Sales admin scenario', /crowsnest_session=/.test(earthlingCookie));

      const monshiesLogin = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=monshies-op&password=mon-pass',
      });
      const monshiesCookie = extractCookiePair(monshiesLogin.headers['set-cookie']);
      ok('Monshies login for Sales admin scenario', /crowsnest_session=/.test(monshiesCookie));

      const monshiesRead = await request(port, '/sales', { headers: { Cookie: monshiesCookie } });
      ok(
        'Monshies may read Sales (authenticated)',
        monshiesRead.statusCode === 200 && /<h1[^>]*>[\s\S]*Sales/i.test(monshiesRead.body),
        `status=${monshiesRead.statusCode}`,
      );

      const monshiesCreate = await request(port, '/sales/prospects', {
        method: 'POST',
        headers: {
          Cookie: monshiesCookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'business_name=Monshies+Session+Hostel',
      });
      const monshiesDetailPath = String(monshiesCreate.headers.location || '');
      ok(
        'any authenticated Crowsnest operator can POST a prospect',
        monshiesCreate.statusCode === 302 && monshiesDetailPath.startsWith('/sales/prospects/'),
        `status=${monshiesCreate.statusCode} loc=${monshiesDetailPath}`,
      );
      const monshiesProspectId = monshiesDetailPath.split('/').pop();
      const monshiesDecision = await request(port, `/sales/prospects/${monshiesProspectId}/decision`, {
        method: 'POST',
        headers: {
          Cookie: monshiesCookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'decision=approved&reason=Authenticated+operator+approved',
      });
      ok(
        'any authenticated Crowsnest operator can POST a decision',
        monshiesDecision.statusCode === 302,
        `status=${monshiesDecision.statusCode}`,
      );

      const monshiesBasicCreate = await request(port, '/sales/prospects', {
        method: 'POST',
        username: 'monshies-op',
        password: 'mon-pass',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'business_name=Monshies+Basic+Hostel',
      });
      ok(
        'any authenticated Basic Auth operator can POST a prospect',
        monshiesBasicCreate.statusCode === 302
          && String(monshiesBasicCreate.headers.location || '').startsWith('/sales/prospects/'),
        `status=${monshiesBasicCreate.statusCode}`,
      );

      const afterDecision = await request(port, monshiesDetailPath, { headers: { Cookie: monshiesCookie } });
      ok(
        'operator decision mutates prospect and appends audit trail',
        afterDecision.statusCode === 200
          && /approved/i.test(afterDecision.body)
          && /Authenticated operator approved/i.test(afterDecision.body),
      );
    },
  ]);

  console.log(`\n── verify:crowsnest-sales: ${pass} passed, ${fail} failed ──`);
  if (fail === 0) {
    console.log('verify:crowsnest-sales — ALL CHECKS PASSED');
  }
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  await stopServer();
  console.error(err);
  process.exit(1);
});
