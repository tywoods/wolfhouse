'use strict';

/**
 * Deterministic RED→GREEN verifier for Luna Sales Chapter 4: Review Queue and Operations.
 * Offline — no live DB, no Azure, no HubSpot/Maps/Apollo/live AI/outreach.
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
const STORE_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-sales-store.js');
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'SALES-REVIEW-QUEUE.md');
const PRODUCT_DOC = path.join(ROOT, 'docs', 'CROWSNEST.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const BASE_PORT = Number(process.env.CROWSNEST_VERIFY_SALES_REVIEW_QUEUE_PORT) || 13350;

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

function encodeEvidenceBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, value == null ? '' : String(value));
  }
  return params.toString();
}

function encodeQualificationBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, item == null ? '' : String(item));
      }
    } else {
      params.set(key, value == null ? '' : String(value));
    }
  }
  return params.toString();
}

function structuralChecks() {
  console.log('\n▸ Structural: Chapter 4 review queue');
  const apiSrc = read(API_PATH) || '';
  const pageSrc = read(PAGE_PATH) || '';
  const salesSrc = read(SALES_PATH) || '';
  const storeSrc = read(STORE_PATH) || '';
  const docSrc = read(DOC_PATH) || '';
  const productSrc = read(PRODUCT_DOC) || '';

  ok('crowsnest-sales.js exists', fs.existsSync(SALES_PATH));
  ok('sales exports assignReviewBucket', /assignReviewBucket/.test(salesSrc));
  ok('sales exports listReviewQueue', /listReviewQueue/.test(salesSrc));
  ok('sales exports filterReviewQueueItems|normalizeReviewQueueFilter', /filterReviewQueueItems|normalizeReviewQueueFilter/.test(salesSrc));
  ok('sales exports compareReviewQueueItems|sortReviewQueueItems', /compareReviewQueueItems|sortReviewQueueItems/.test(salesSrc));
  ok('store supports listReviewQueueSummaries', /listReviewQueueSummaries/.test(storeSrc));
  ok('router allowlists /sales/review', /pathname\s*===\s*['"]\/sales\/review['"]|matchSalesReviewPath|\/sales\/review/.test(apiSrc));
  ok('page renders review queue', /sales_review|review.queue|Ready for review/i.test(pageSrc));
  ok('page has server-side state filter form', /name=["']state["']|name=['"]state['"]/.test(pageSrc) && /method=["']get["']/i.test(pageSrc));
  ok('page escapes queue fields', /escapeHtml/.test(pageSrc));
  ok(
    'no invented score / HubSpot / outreach / discovery claims on queue page',
    !/lead_score\s*[:=]|AI score:\s*\d|priority score\s*[:=]|sync to hubspot completed|push to apollo|outreach send completed|Maps discovery ran|Apollo enrichment completed/i.test(pageSrc),
  );
  ok('no HubSpot/Apollo/Google SDK require in sales', !/require\(['"][^'"]*(hubspot|apollo|googleapis)/i.test(salesSrc));
  ok('review queue doc exists', fs.existsSync(DOC_PATH));
  ok(
    'review queue doc forbids HubSpot / outreach / external discovery claims',
    /no HubSpot|no outreach|operator|not automatic|no.*discovery/i.test(docSrc),
  );
  ok('product doc mentions Chapter 4 review queue', /Chapter 4|Review Queue|review queue/i.test(productSrc));

  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  } catch {
    pkg = null;
  }
  ok(
    'package.json has verify:crowsnest-sales-review-queue',
    pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-sales-review-queue'] === 'string',
  );

  ok(
    'no new sales migration required for Chapter 4',
    !fs.existsSync(path.join(ROOT, 'database', 'migrations', '045_luna_sales_review_queue.sql')),
  );
}

async function domainBucketAndOrderingChecks() {
  console.log('\n▸ Bucket assignment, ordering, and filter (domain)');
  delete require.cache[require.resolve(SALES_PATH)];
  delete require.cache[require.resolve(STORE_PATH)];
  const sales = require(SALES_PATH);
  const store = require(STORE_PATH);

  ok('assignReviewBucket is a function', typeof sales.assignReviewBucket === 'function');
  ok('listReviewQueue is a function', typeof sales.listReviewQueue === 'function');
  if (typeof sales.assignReviewBucket !== 'function') return;

  ok(
    'ready_for_review when evidence and no qualification',
    sales.assignReviewBucket({ evidence_count: 2, latest_qualification_decision: null }) === 'ready_for_review',
  );
  ok(
    'not ready without evidence',
    sales.assignReviewBucket({ evidence_count: 0, latest_qualification_decision: null }) == null
      || sales.assignReviewBucket({ evidence_count: 0, latest_qualification_decision: null }) !== 'ready_for_review',
  );
  ok(
    'needs_more_research bucket',
    sales.assignReviewBucket({ evidence_count: 1, latest_qualification_decision: 'needs_more_research' }) === 'needs_more_research',
  );
  ok(
    'qualified bucket',
    sales.assignReviewBucket({ evidence_count: 1, latest_qualification_decision: 'qualified' }) === 'qualified',
  );
  ok(
    'not_qualified bucket',
    sales.assignReviewBucket({ evidence_count: 1, latest_qualification_decision: 'not_qualified' }) === 'not_qualified',
  );
  ok(
    'qualification wins over evidence for bucket',
    sales.assignReviewBucket({ evidence_count: 5, latest_qualification_decision: 'qualified' }) === 'qualified',
  );

  const normalize = sales.normalizeReviewQueueFilter || ((v) => String(v || 'all'));
  ok('normalize all', normalize('all') === 'all' || normalize('') === 'all');
  ok('normalize actionable', normalize('actionable') === 'actionable');
  ok('normalize needs_more_research', normalize('needs_more_research') === 'needs_more_research');
  ok('normalize qualified', normalize('qualified') === 'qualified');
  ok('normalize not_qualified', normalize('not_qualified') === 'not_qualified');
  ok('normalize unknown falls back to all', normalize('mystery') === 'all');

  const sample = [
    {
      id: 'a',
      bucket: 'qualified',
      most_recent_activity: '2026-07-22T12:00:00.000Z',
      evidence_count: 1,
      latest_qualification_decision: 'qualified',
    },
    {
      id: 'b',
      bucket: 'ready_for_review',
      most_recent_activity: '2026-07-22T10:00:00.000Z',
      evidence_count: 1,
      latest_qualification_decision: null,
    },
    {
      id: 'c',
      bucket: 'needs_more_research',
      most_recent_activity: '2026-07-22T11:00:00.000Z',
      evidence_count: 2,
      latest_qualification_decision: 'needs_more_research',
    },
    {
      id: 'd',
      bucket: 'not_qualified',
      most_recent_activity: '2026-07-22T13:00:00.000Z',
      evidence_count: 1,
      latest_qualification_decision: 'not_qualified',
    },
    {
      id: 'e',
      bucket: 'ready_for_review',
      most_recent_activity: '2026-07-22T11:30:00.000Z',
      evidence_count: 3,
      latest_qualification_decision: null,
    },
  ];

  const filterFn = sales.filterReviewQueueItems
    || ((items, state) => {
      const f = normalize(state);
      if (f === 'all') return items;
      if (f === 'actionable') {
        return items.filter((i) => i.bucket === 'ready_for_review' || i.bucket === 'needs_more_research');
      }
      return items.filter((i) => i.bucket === f);
    });

  const actionable = filterFn(sample, 'actionable');
  ok(
    'actionable filter keeps ready + needs_more_research only',
    actionable.length === 3
      && actionable.every((i) => i.bucket === 'ready_for_review' || i.bucket === 'needs_more_research'),
  );
  ok('qualified filter', filterFn(sample, 'qualified').every((i) => i.bucket === 'qualified') && filterFn(sample, 'qualified').length === 1);
  ok('not_qualified filter', filterFn(sample, 'not_qualified').length === 1);
  ok('needs_more_research filter', filterFn(sample, 'needs_more_research').length === 1);
  ok('all filter keeps everything', filterFn(sample, 'all').length === sample.length);

  const sortFn = sales.sortReviewQueueItems
    || ((items) => items.slice().sort(sales.compareReviewQueueItems));
  const sorted = sortFn(sample);
  ok('sorted length preserved', sorted.length === sample.length);
  ok(
    'actionable items ordered before settled ones',
    (() => {
      const firstSettled = sorted.findIndex((i) => i.bucket === 'qualified' || i.bucket === 'not_qualified');
      const lastActionable = [...sorted].map((i, idx) => ({ i, idx }))
        .filter(({ i }) => i.bucket === 'ready_for_review' || i.bucket === 'needs_more_research')
        .map(({ idx }) => idx)
        .pop();
      return firstSettled === -1 || lastActionable < firstSettled;
    })(),
    sorted.map((i) => `${i.id}:${i.bucket}`).join(' | '),
  );
  const actionableSorted = sorted.filter((i) => i.bucket === 'ready_for_review' || i.bucket === 'needs_more_research');
  ok(
    'within actionable, newest activity first',
    actionableSorted.length >= 2
      && String(actionableSorted[0].most_recent_activity) >= String(actionableSorted[1].most_recent_activity),
    actionableSorted.map((i) => `${i.id}:${i.most_recent_activity}`).join(' | '),
  );
  ok(
    'no invented score fields on sorted items',
    sorted.every((i) => i.score == null && i.lead_score == null && i.ai_priority == null),
  );

  const repo = store.createMemorySalesRepository();
  if (typeof sales._setSalesRepositoryForTests === 'function') {
    sales._setSalesRepositoryForTests(repo);
  }

  const ready = await sales.createProspect({ business_name: 'Ready Queue Hostel' }, 'Admin');
  ok('ready prospect created', ready && ready.ok === true);
  await new Promise((r) => setTimeout(r, 5));

  const needs = await sales.createProspect({ business_name: 'Needs Research Hostel' }, 'Admin');
  ok('needs prospect created', needs && needs.ok === true);
  const needsEvidence = await sales.recordManualEvidence(needs.prospect.id, {
    source_label: 'Site',
    source_url: 'https://needs.example',
    summary: 'Needs more notes',
    factual_notes: 'Partial website',
    limitations: 'Manual only',
    confidence: 'low',
  }, 'Admin');
  await sales.recordQualification(needs.prospect.id, {
    decision: 'needs_more_research',
    rationale: 'Need booking page confirmation',
    evidence_ids: [needsEvidence.research.id, needs.research.id].filter(Boolean),
  }, 'Admin');

  await new Promise((r) => setTimeout(r, 5));
  const qualified = await sales.createProspect({ business_name: 'Qualified Queue Hostel' }, 'Admin');
  const qEvidence = await sales.recordManualEvidence(qualified.prospect.id, {
    source_label: 'Site',
    source_url: 'https://qualified.example',
    summary: 'Strong fit',
    factual_notes: 'Surf hostel',
    limitations: 'Manual only',
    confidence: 'high',
  }, 'Admin');
  await sales.recordQualification(qualified.prospect.id, {
    decision: 'qualified',
    rationale: 'Northern Spain hostel fit',
    evidence_ids: [qEvidence.research.id],
  }, 'Admin');

  await new Promise((r) => setTimeout(r, 5));
  const rejected = await sales.createProspect({ business_name: 'Not Qualified Queue Hostel' }, 'Admin');
  const rEvidence = await sales.recordManualEvidence(rejected.prospect.id, {
    source_label: 'Site',
    source_url: 'https://not-qualified.example',
    summary: 'Wrong market',
    factual_notes: 'Outside pilot',
    limitations: 'Manual only',
    confidence: 'medium',
  }, 'Admin');
  await sales.recordQualification(rejected.prospect.id, {
    decision: 'not_qualified',
    rationale: 'Outside Northern Spain pilot',
    evidence_ids: [rEvidence.research.id],
  }, 'Admin');

  const allQueue = await sales.listReviewQueue({ state: 'all' });
  ok('listReviewQueue ok', allQueue && allQueue.ok === true && Array.isArray(allQueue.items), JSON.stringify(allQueue));
  ok('listReviewQueue has four bucketed prospects', allQueue.items.length >= 4, `count=${allQueue.items && allQueue.items.length}`);

  const byName = new Map(allQueue.items.map((i) => [i.canonical_name || i.business_name, i]));
  ok('ready prospect bucketed ready_for_review', byName.get('Ready Queue Hostel') && byName.get('Ready Queue Hostel').bucket === 'ready_for_review');
  ok('needs prospect bucketed needs_more_research', byName.get('Needs Research Hostel') && byName.get('Needs Research Hostel').bucket === 'needs_more_research');
  ok('qualified prospect bucketed qualified', byName.get('Qualified Queue Hostel') && byName.get('Qualified Queue Hostel').bucket === 'qualified');
  ok('not_qualified prospect bucketed not_qualified', byName.get('Not Qualified Queue Hostel') && byName.get('Not Qualified Queue Hostel').bucket === 'not_qualified');

  const readyItem = byName.get('Ready Queue Hostel');
  ok('queue item has evidence_count', readyItem && Number(readyItem.evidence_count) >= 1);
  ok('queue item has most_recent_activity', readyItem && readyItem.most_recent_activity);
  ok('queue item has detail path id', readyItem && readyItem.id);

  const actionableQueue = await sales.listReviewQueue({ state: 'actionable' });
  ok(
    'actionable queue excludes settled',
    actionableQueue.ok
      && actionableQueue.items.every((i) => i.bucket === 'ready_for_review' || i.bucket === 'needs_more_research')
      && actionableQueue.items.some((i) => i.bucket === 'ready_for_review')
      && actionableQueue.items.some((i) => i.bucket === 'needs_more_research'),
  );
  ok(
    'actionable ordering newest first among actionable',
    actionableQueue.items.length >= 2
      && String(actionableQueue.items[0].most_recent_activity) >= String(actionableQueue.items[1].most_recent_activity),
  );

  const qualifiedOnly = await sales.listReviewQueue({ state: 'qualified' });
  ok('qualified filter domain', qualifiedOnly.ok && qualifiedOnly.items.every((i) => i.bucket === 'qualified') && qualifiedOnly.items.length >= 1);

  console.log('\n▸ Production fail-closed read behavior for review queue');
  const failRepo = await store.createSalesRepository({ NODE_ENV: 'production' });
  sales._setSalesRepositoryForTests(failRepo);
  const closed = await sales.listReviewQueue({ state: 'all' });
  ok(
    'production missing DSN rejects review queue read',
    closed && closed.ok === false && (closed.status === 503 || closed.code === 'sales_store_misconfigured'),
    JSON.stringify(closed),
  );
  ok(
    'fail-closed review queue error does not leak DSN/SQL',
    closed && !/postgres:\/\/|WOLFHOUSE|SELECT\s+|password/i.test(JSON.stringify(closed)),
  );

  console.log('\n▸ Durable repository SQL for review queue summaries');
  const recordedSql = [];
  const pgRepo = store.createPgSalesRepository({
    query: async (sql) => {
      recordedSql.push({ sql: String(sql) });
      if (/FROM\s+luna_sales\.prospects/i.test(sql) || /listReviewQueue|evidence_count|qualification/i.test(sql)) {
        return {
          rows: [{
            id: '11111111-1111-4111-8111-111111111111',
            canonical_name: 'SQL Queue Hostel',
            website_url: 'https://sql-queue.example',
            evidence_count: 2,
            latest_qualification_decision: null,
            latest_qualification_at: null,
            most_recent_activity: '2026-07-22T15:00:00.000Z',
            created_at: '2026-07-22T10:00:00.000Z',
            updated_at: '2026-07-22T10:00:00.000Z',
          }],
        };
      }
      return { rows: [] };
    },
  });
  ok('pg repo exposes listReviewQueueSummaries', typeof pgRepo.listReviewQueueSummaries === 'function');
  if (typeof pgRepo.listReviewQueueSummaries === 'function') {
    const rows = await pgRepo.listReviewQueueSummaries();
    ok('pg listReviewQueueSummaries returns rows', Array.isArray(rows) && rows.length === 1);
    ok(
      'review queue SQL qualifies luna_sales',
      recordedSql.length >= 1 && recordedSql.every((c) => /luna_sales\./.test(c.sql)),
    );
    ok(
      'review queue SQL is read-only (no INSERT/UPDATE/DELETE)',
      recordedSql.every((c) => !/\b(INSERT|UPDATE|DELETE)\b/i.test(c.sql)),
    );
  }

  const leakyRepo = store.createPgSalesRepository({
    query: async () => {
      throw new Error(
        'password authentication failed postgres://crowsnest_sales:SuperSecretPass@prod-db.azure.com:5432/app SQL: SELECT * FROM pg_shadow',
      );
    },
  });
  sales._setSalesRepositoryForTests(leakyRepo);
  const unavailable = await sales.listReviewQueue({ state: 'all' });
  ok(
    'pg review queue failure returns safe sales_unavailable',
    unavailable
      && unavailable.ok === false
      && unavailable.status === 503
      && unavailable.code === 'sales_unavailable'
      && unavailable.retryable === true,
    JSON.stringify(unavailable),
  );
  ok(
    'pg review queue failure does not leak secrets/SQL',
    unavailable && !/SuperSecretPass|postgres:\/\/|prod-db\.azure|pg_shadow/i.test(JSON.stringify(unavailable)),
  );
}

async function main() {
  console.log('verify:crowsnest-sales-review-queue — Luna Sales Chapter 4\n');

  structuralChecks();
  await domainBucketAndOrderingChecks();

  await runScenario('Protected route + 405 unsafe methods for /sales/review', BASE_PORT, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
  }, [
    async (port) => {
      const unauth = await request(port, '/sales/review');
      ok(
        'unauthenticated GET /sales/review redirects to /login',
        unauth.statusCode === 302 && String(unauth.headers.location || '') === '/login',
      );

      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
      });
      const cookie = extractCookiePair(login.headers['set-cookie']);
      ok('login cookie for review queue', /crowsnest_session=/.test(cookie));

      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, '/sales/review', method, { Cookie: cookie }, 'GET, HEAD');
      }

      const page = await request(port, '/sales/review', { headers: { Cookie: cookie } });
      ok('GET /sales/review => 200', page.statusCode === 200, `got ${page.statusCode}`);
      ok('review queue heading present', /Review queue|Sales review/i.test(page.body));
      ok('filter form is GET (no JS required)', /<form[^>]+method=["']get["'][^>]*action=["']\/sales\/review["']/i.test(page.body)
        || /<form[^>]+action=["']\/sales\/review["'][^>]*method=["']get["']/i.test(page.body));
      ok('filter options include all/actionable/needs_more_research/qualified/not_qualified',
        /value=["']all["']/.test(page.body)
          && /value=["']actionable["']/.test(page.body)
          && /value=["']needs_more_research["']/.test(page.body)
          && /value=["']qualified["']/.test(page.body)
          && /value=["']not_qualified["']/.test(page.body));
      ok('honest operator-decides note', /operator/i.test(page.body) && /decide|decision|human/i.test(page.body));
      ok(
        'no HubSpot sync / outreach / external discovery claims',
        !/hubspot sync completed|sync to hubspot completed|outreach send completed|Maps discovery ran|Apollo enrichment completed|live AI research ran/i.test(page.body),
      );
      ok('empty state or queue list present', /No prospects|Ready for review|review queue/i.test(page.body));
      ok('Sales nav remains available', /href=["']\/sales["']/.test(page.body));
    },
  ]);

  await runScenario('Queue buckets, filter, XSS-safe display', BASE_PORT + 1, {
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

      const xssName = '<script>alert("q")</script> UNIQUE_QUEUE_XSS_HOSTEL';
      const created = await request(port, '/sales/prospects', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `business_name=${encodeURIComponent(xssName)}&website_url=${encodeURIComponent('https://queue-xss.example')}`,
      });
      const detailPath = String(created.headers.location || '');
      ok('created XSS prospect for queue', created.statusCode === 302 && detailPath.startsWith('/sales/prospects/'));
      const prospectId = detailPath.split('/').pop();

      const needsCreated = await request(port, '/sales/prospects', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'business_name=UNIQUE_QUEUE_NEEDS_HOSTEL',
      });
      const needsId = String(needsCreated.headers.location || '').split('/').pop();
      await request(port, `/sales/prospects/${needsId}/evidence`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeEvidenceBody({
          source_label: 'Notes',
          source_url: 'https://needs-queue.example',
          summary: 'Partial',
          factual_notes: 'Partial site',
          limitations: 'Manual',
          confidence: 'low',
        }),
      });
      const needsDetail = await request(port, `/sales/prospects/${needsId}`, { headers: { Cookie: cookie } });
      const checkboxMatch = needsDetail.body.match(/name=["']evidence_ids["'][^>]*value=["']([^"']+)["']/i)
        || needsDetail.body.match(/value=["']([^"']+)["'][^>]*name=["']evidence_ids["']/i);
      await request(port, `/sales/prospects/${needsId}/qualification`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeQualificationBody({
          qualification_decision: 'needs_more_research',
          rationale: 'Need more UNIQUE_QUEUE_NEEDS',
          evidence_ids: [checkboxMatch ? checkboxMatch[1] : ''],
        }),
      });

      const queue = await request(port, '/sales/review', { headers: { Cookie: cookie } });
      ok('queue page loads with prospects', queue.statusCode === 200);
      ok('shows Ready for review bucket label', /Ready for review/i.test(queue.body));
      ok('shows Needs more research bucket label', /Needs more research/i.test(queue.body));
      ok('shows business name escaped (no raw script)', !/<script>alert\("q"\)<\/script>/.test(queue.body));
      ok('escaped name entities present', /&lt;script&gt;/.test(queue.body) && /UNIQUE_QUEUE_XSS_HOSTEL/.test(queue.body));
      ok('shows website when present', /queue-xss\.example/.test(queue.body));
      ok('shows evidence count', /evidence/i.test(queue.body) && /\d+/.test(queue.body));
      ok('shows most recent activity', /\d{4}-\d{2}-\d{2}|activity|updated|created/i.test(queue.body));
      ok('safe link to detail', queue.body.includes(`/sales/prospects/${prospectId}`));
      ok('no invented AI priority/score on page', !/lead_score\s*[:=]|AI score:\s*\d|priority score\s*[:=]|ai_priority\s*[:=]/i.test(queue.body));

      const actionable = await request(port, '/sales/review?state=actionable', { headers: { Cookie: cookie } });
      ok('actionable filter preserves auth (200)', actionable.statusCode === 200);
      ok('actionable includes ready XSS hostel', /UNIQUE_QUEUE_XSS_HOSTEL/.test(actionable.body));
      ok('actionable includes needs hostel', /UNIQUE_QUEUE_NEEDS_HOSTEL/.test(actionable.body));
      ok('filter query preserved in form/selection', /state=actionable|value=["']actionable["'][^>]*selected|selected[^>]*value=["']actionable["']/i.test(actionable.body));

      const needsFilter = await request(port, '/sales/review?state=needs_more_research', { headers: { Cookie: cookie } });
      ok('needs_more_research filter shows needs hostel', /UNIQUE_QUEUE_NEEDS_HOSTEL/.test(needsFilter.body));
      ok('needs_more_research filter hides ready XSS hostel', !/UNIQUE_QUEUE_XSS_HOSTEL/.test(needsFilter.body));

      const emptyQualified = await request(port, '/sales/review?state=qualified', { headers: { Cookie: cookie } });
      ok(
        'empty state for qualified filter',
        emptyQualified.statusCode === 200
          && (/No prospects|none|empty|no qualified/i.test(emptyQualified.body) || !/UNIQUE_QUEUE_XSS_HOSTEL/.test(emptyQualified.body)),
      );
    },
  ]);

  console.log(`\n── verify:crowsnest-sales-review-queue: ${pass} passed, ${fail} failed ──`);
  if (fail === 0) {
    console.log('verify:crowsnest-sales-review-queue — ALL CHECKS PASSED');
  }
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  await stopServer();
  console.error(err);
  process.exit(1);
});
