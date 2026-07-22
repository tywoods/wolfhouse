'use strict';

/**
 * Deterministic RED→GREEN verifier for Luna Sales Chapter 10:
 * Sales Analytics and Monitoring.
 * Offline — no live DB, no Azure, no HubSpot/Maps/Apollo/live AI/outreach/writes.
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
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'SALES-ANALYTICS.md');
const PRODUCT_DOC = path.join(ROOT, 'docs', 'CROWSNEST.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const BASE_PORT = Number(process.env.CROWSNEST_VERIFY_SALES_ANALYTICS_PORT) || 13370;

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

function encodeBody(fields) {
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
  console.log('\n▸ Structural: Chapter 10 sales analytics');
  const apiSrc = read(API_PATH) || '';
  const pageSrc = read(PAGE_PATH) || '';
  const salesSrc = read(SALES_PATH) || '';
  const storeSrc = read(STORE_PATH) || '';
  const docSrc = read(DOC_PATH) || '';
  const productSrc = read(PRODUCT_DOC) || '';

  ok('crowsnest-sales.js exists', fs.existsSync(SALES_PATH));
  ok('sales exports getSalesAnalytics', /getSalesAnalytics/.test(salesSrc));
  ok(
    'sales exports buildPipelineCounts|buildDataQualityAlerts|buildRecentActivity',
    /buildPipelineCounts/.test(salesSrc)
      && /buildDataQualityAlerts/.test(salesSrc)
      && /buildRecentActivity/.test(salesSrc),
  );
  ok('store supports listAnalyticsSummaries', /listAnalyticsSummaries/.test(storeSrc));
  ok('router allowlists /sales/analytics', /pathname\s*===\s*['"]\/sales\/analytics['"]|\/sales\/analytics/.test(apiSrc));
  ok('page renders analytics dashboard', /sales_analytics|Pipeline counts|Data-quality|Recent activity/i.test(pageSrc));
  ok('page escapes analytics fields', /escapeHtml/.test(pageSrc));
  ok(
    'no AI/agent / HubSpot / outreach / external claims on analytics page',
    !/AI agent score|autonomous outreach|sync to hubspot completed|Apollo enrichment completed|Maps discovery ran|live AI research ran|automatic remediation/i.test(pageSrc),
  );
  ok('no HubSpot/Apollo/Google SDK require in sales', !/require\(['"][^'"]*(hubspot|apollo|googleapis)/i.test(salesSrc));
  ok(
    'analytics route is read-only (GET/HEAD only handler)',
    /handleSalesAnalytics[\s\S]*?sendMethodNotAllowed\(res, 'GET, HEAD'\)/.test(apiSrc)
      || /async function handleSalesAnalytics[\s\S]*?method !== 'GET' && method !== 'HEAD'/.test(apiSrc),
  );
  ok('analytics doc exists', fs.existsSync(DOC_PATH));
  ok(
    'analytics doc forbids AI/agent claims, external calls, writes, automatic actions',
    /no AI|no agent|read-only|no.*write|no automatic|no HubSpot|no outreach|no external/i.test(docSrc),
  );
  ok('product doc mentions Chapter 10 sales analytics', /Chapter 10|Sales Analytics|analytics and monitoring/i.test(productSrc));

  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  } catch {
    pkg = null;
  }
  ok(
    'package.json has verify:crowsnest-sales-analytics',
    pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-sales-analytics'] === 'string',
  );

  ok(
    'no new sales migration required for Chapter 10',
    !fs.existsSync(path.join(ROOT, 'database', 'migrations', '048_luna_sales_analytics.sql')),
  );
}

async function domainAnalyticsChecks() {
  console.log('\n▸ Pipeline counts, recent activity, data-quality alerts (domain)');
  delete require.cache[require.resolve(SALES_PATH)];
  delete require.cache[require.resolve(STORE_PATH)];
  const sales = require(SALES_PATH);
  const store = require(STORE_PATH);

  ok('getSalesAnalytics is a function', typeof sales.getSalesAnalytics === 'function');
  ok('buildPipelineCounts is a function', typeof sales.buildPipelineCounts === 'function');
  ok('buildDataQualityAlerts is a function', typeof sales.buildDataQualityAlerts === 'function');
  ok('buildRecentActivity is a function', typeof sales.buildRecentActivity === 'function');
  if (typeof sales.buildPipelineCounts !== 'function') return;

  const emptyCounts = sales.buildPipelineCounts([]);
  ok(
    'empty summaries yield zero pipeline counts',
    emptyCounts
      && emptyCounts.prospects === 0
      && emptyCounts.evidence_records === 0
      && emptyCounts.crm_ready === 0
      && emptyCounts.drafts_present === 0
      && emptyCounts.contacts === 0
      && emptyCounts.qualification
      && emptyCounts.qualification.qualified === 0
      && emptyCounts.qualification.not_qualified === 0
      && emptyCounts.qualification.needs_more_research === 0
      && emptyCounts.qualification.unassessed === 0,
    JSON.stringify(emptyCounts),
  );

  const sampleSummaries = [
    {
      id: 'p1',
      canonical_name: 'No Website Hostel',
      website_url: '',
      evidence_count: 0,
      contact_count: 0,
      latest_qualification_decision: null,
      crm_ready: false,
      draft_present: false,
      most_recent_activity: '2026-07-22T10:00:00.000Z',
    },
    {
      id: 'p2',
      canonical_name: 'Qualified Ready Hostel',
      website_url: 'https://qualified.example',
      evidence_count: 2,
      contact_count: 1,
      latest_qualification_decision: 'qualified',
      crm_ready: true,
      draft_present: true,
      most_recent_activity: '2026-07-22T12:00:00.000Z',
    },
    {
      id: 'p3',
      canonical_name: 'Needs Research Hostel',
      website_url: 'https://needs.example',
      evidence_count: 1,
      contact_count: 0,
      latest_qualification_decision: 'needs_more_research',
      crm_ready: false,
      draft_present: false,
      most_recent_activity: '2026-07-22T11:00:00.000Z',
    },
    {
      id: 'p4',
      canonical_name: 'CRM Ready No Draft',
      website_url: 'https://crm-nodraft.example',
      evidence_count: 1,
      contact_count: 0,
      latest_qualification_decision: 'qualified',
      crm_ready: true,
      draft_present: false,
      most_recent_activity: '2026-07-22T11:30:00.000Z',
    },
    {
      id: 'p5',
      canonical_name: 'Not Qualified Hostel',
      website_url: 'https://nq.example',
      evidence_count: 1,
      contact_count: 0,
      latest_qualification_decision: 'not_qualified',
      crm_ready: false,
      draft_present: false,
      most_recent_activity: '2026-07-22T09:00:00.000Z',
    },
  ];

  const counts = sales.buildPipelineCounts(sampleSummaries);
  ok('prospects count', counts.prospects === 5, JSON.stringify(counts));
  ok('evidence_records sum', counts.evidence_records === 5, JSON.stringify(counts));
  ok('qualification.qualified', counts.qualification.qualified === 2);
  ok('qualification.not_qualified', counts.qualification.not_qualified === 1);
  ok('qualification.needs_more_research', counts.qualification.needs_more_research === 1);
  ok('qualification.unassessed', counts.qualification.unassessed === 1);
  ok('crm_ready count', counts.crm_ready === 2);
  ok('drafts_present count', counts.drafts_present === 1);
  ok('contacts sum', counts.contacts === 1);

  const alerts = sales.buildDataQualityAlerts(sampleSummaries);
  ok('alerts is an array', Array.isArray(alerts));
  ok(
    'missing_website alert present',
    alerts.some((a) => a.code === 'missing_website' && a.prospect_id === 'p1'),
    JSON.stringify(alerts),
  );
  ok(
    'no_evidence alert present',
    alerts.some((a) => a.code === 'no_evidence' && a.prospect_id === 'p1'),
  );
  ok(
    'crm_ready_without_draft alert present',
    alerts.some((a) => a.code === 'crm_ready_without_draft' && a.prospect_id === 'p4'),
  );
  ok(
    'crm_ready_without_contact alert present',
    alerts.some((a) => a.code === 'crm_ready_without_contact' && a.prospect_id === 'p4'),
  );
  ok(
    'qualified_without_crm_ready not raised for crm-ready prospects',
    !alerts.some((a) => a.code === 'qualified_without_crm_ready' && a.prospect_id === 'p2'),
  );
  ok(
    'alerts are informational only (no auto-action fields)',
    alerts.every((a) => a.auto_action == null && a.remediation_ran !== true),
  );

  const recent = sales.buildRecentActivity([
    { id: 'a1', at: '2026-07-22T10:00:00.000Z', actor: 'Admin', action: 'prospect_created', entity_type: 'prospect', entity_id: 'p1', detail: {} },
    { id: 'a2', at: '2026-07-22T12:00:00.000Z', actor: 'Admin', action: 'qualification_assessed', entity_type: 'qualification', entity_id: 'q1', detail: { prospect_id: 'p2' } },
    { id: 'a3', at: '2026-07-22T11:00:00.000Z', actor: 'Admin', action: 'research_evidence_recorded', entity_type: 'research', entity_id: 'r1', detail: { prospect_id: 'p3' } },
  ], { limit: 2 });
  ok('recent activity respects limit', Array.isArray(recent) && recent.length === 2);
  ok(
    'recent activity newest first',
    recent[0].action === 'qualification_assessed' && recent[1].action === 'research_evidence_recorded',
    JSON.stringify(recent),
  );
  ok(
    'recent activity includes prospect_id when present',
    recent[0].prospect_id === 'p2',
  );

  const repo = store.createMemorySalesRepository();
  if (typeof sales._setSalesRepositoryForTests === 'function') {
    sales._setSalesRepositoryForTests(repo);
  }

  const bare = await sales.createProspect({ business_name: 'Analytics Bare Hostel' }, 'Admin');
  ok('bare prospect created', bare && bare.ok === true);

  await new Promise((r) => setTimeout(r, 5));
  const researched = await sales.createProspect({
    business_name: 'Analytics Researched Hostel',
    website_url: 'https://analytics-researched.example',
  }, 'Admin');
  const evidence = await sales.recordManualEvidence(researched.prospect.id, {
    source_label: 'Site',
    source_url: 'https://analytics-researched.example',
    summary: 'Fit notes',
    factual_notes: 'Surf hostel',
    limitations: 'Manual only',
    confidence: 'high',
  }, 'Admin');
  await sales.recordQualification(researched.prospect.id, {
    decision: 'qualified',
    rationale: 'Northern Spain hostel fit',
    evidence_ids: [evidence.research.id],
  }, 'Admin');
  await sales.markReadyForCrmReview(researched.prospect.id, 'Admin');
  await sales.saveOutreachDraft(researched.prospect.id, {
    subject: 'Hello',
    body: 'Draft body for analytics',
    channel: 'email',
    next_step_note: 'Wait for reply',
  }, 'Admin');
  await sales.recordManualContact(researched.prospect.id, {
    full_name: 'Ana Host',
    role: 'Owner',
    email: 'ana@analytics-researched.example',
    source: 'Website',
    confidence: 'high',
  }, 'Admin');

  await new Promise((r) => setTimeout(r, 5));
  const needs = await sales.createProspect({
    business_name: 'Analytics Needs Hostel',
    website_url: 'https://analytics-needs.example',
  }, 'Admin');
  const needsEvidence = await sales.recordManualEvidence(needs.prospect.id, {
    source_label: 'Notes',
    source_url: 'https://analytics-needs.example',
    summary: 'Partial',
    factual_notes: 'Partial site',
    limitations: 'Manual',
    confidence: 'low',
  }, 'Admin');
  await sales.recordQualification(needs.prospect.id, {
    decision: 'needs_more_research',
    rationale: 'Need booking page',
    evidence_ids: [needsEvidence.research.id],
  }, 'Admin');

  const analytics = await sales.getSalesAnalytics();
  ok('getSalesAnalytics ok', analytics && analytics.ok === true, JSON.stringify(analytics));
  ok('analytics has counts', analytics.counts && typeof analytics.counts.prospects === 'number');
  ok('analytics prospects >= 3', analytics.counts.prospects >= 3, JSON.stringify(analytics.counts));
  ok('analytics evidence_records >= 2', analytics.counts.evidence_records >= 2);
  ok('analytics qualification.qualified >= 1', analytics.counts.qualification.qualified >= 1);
  ok('analytics qualification.needs_more_research >= 1', analytics.counts.qualification.needs_more_research >= 1);
  ok('analytics qualification.unassessed >= 1', analytics.counts.qualification.unassessed >= 1);
  ok('analytics crm_ready >= 1', analytics.counts.crm_ready >= 1);
  ok('analytics drafts_present >= 1', analytics.counts.drafts_present >= 1);
  ok('analytics contacts >= 1', analytics.counts.contacts >= 1);
  ok('analytics recent_activity is array', Array.isArray(analytics.recent_activity));
  ok('analytics recent_activity not empty', analytics.recent_activity.length >= 1);
  ok('analytics data_quality_alerts is array', Array.isArray(analytics.data_quality_alerts));
  ok(
    'bare prospect raises missing_website or no_evidence',
    analytics.data_quality_alerts.some((a) => (
      (a.code === 'missing_website' || a.code === 'no_evidence')
      && (a.prospect_id === bare.prospect.id || /Analytics Bare Hostel/i.test(a.canonical_name || ''))
    )),
    JSON.stringify(analytics.data_quality_alerts),
  );
  ok(
    'no invented AI/agent score fields on analytics payload',
    analytics.ai_score == null
      && analytics.agent_priority == null
      && analytics.counts
      && analytics.counts.ai_score == null,
  );

  console.log('\n▸ Production fail-closed read behavior for analytics');
  const failRepo = await store.createSalesRepository({ NODE_ENV: 'production' });
  sales._setSalesRepositoryForTests(failRepo);
  const closed = await sales.getSalesAnalytics();
  ok(
    'production missing DSN rejects analytics read',
    closed && closed.ok === false && (closed.status === 503 || closed.code === 'sales_store_misconfigured'),
    JSON.stringify(closed),
  );
  ok(
    'fail-closed analytics error does not leak DSN/SQL',
    closed && !/postgres:\/\/|WOLFHOUSE|SELECT\s+|password/i.test(JSON.stringify(closed)),
  );

  console.log('\n▸ Durable repository SQL for analytics summaries');
  const recordedSql = [];
  const pgRepo = store.createPgSalesRepository({
    query: async (sql) => {
      recordedSql.push({ sql: String(sql) });
      if (/FROM\s+luna_sales\.prospects/i.test(sql) || /listAnalytics|contact_count|evidence_count/i.test(sql)) {
        return {
          rows: [{
            id: '11111111-1111-4111-8111-111111111111',
            canonical_name: 'SQL Analytics Hostel',
            website_url: 'https://sql-analytics.example',
            evidence_count: 2,
            contact_count: 1,
            latest_qualification_decision: 'qualified',
            latest_qualification_at: '2026-07-22T14:00:00.000Z',
            latest_crm_review_mark_at: '2026-07-22T14:30:00.000Z',
            latest_outreach_draft_at: '2026-07-22T15:00:00.000Z',
            most_recent_activity: '2026-07-22T15:00:00.000Z',
            created_at: '2026-07-22T10:00:00.000Z',
            updated_at: '2026-07-22T10:00:00.000Z',
          }],
        };
      }
      if (/FROM\s+luna_sales\.audit_events/i.test(sql)) {
        return {
          rows: [{
            id: '22222222-2222-4222-8222-222222222222',
            at: '2026-07-22T15:00:00.000Z',
            actor: 'Admin',
            action: 'outreach_draft_saved',
            entity_type: 'outreach_draft',
            entity_id: '33333333-3333-4333-8333-333333333333',
            detail: { prospect_id: '11111111-1111-4111-8111-111111111111' },
          }],
        };
      }
      return { rows: [] };
    },
  });
  ok('pg repo exposes listAnalyticsSummaries', typeof pgRepo.listAnalyticsSummaries === 'function');
  if (typeof pgRepo.listAnalyticsSummaries === 'function') {
    const rows = await pgRepo.listAnalyticsSummaries();
    ok('pg listAnalyticsSummaries returns rows', Array.isArray(rows) && rows.length === 1);
    ok('pg analytics row includes contact_count', rows[0] && Number(rows[0].contact_count) === 1);
    ok(
      'analytics SQL qualifies luna_sales',
      recordedSql.length >= 1 && recordedSql.every((c) => /luna_sales\./.test(c.sql)),
    );
    ok(
      'analytics SQL is read-only (no INSERT/UPDATE/DELETE)',
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
  const unavailable = await sales.getSalesAnalytics();
  ok(
    'pg analytics failure returns safe sales_unavailable',
    unavailable
      && unavailable.ok === false
      && unavailable.status === 503
      && unavailable.code === 'sales_unavailable'
      && unavailable.retryable === true,
    JSON.stringify(unavailable),
  );
  ok(
    'pg analytics failure does not leak secrets/SQL',
    unavailable && !/SuperSecretPass|postgres:\/\/|prod-db\.azure|pg_shadow/i.test(JSON.stringify(unavailable)),
  );
}

async function main() {
  console.log('verify:crowsnest-sales-analytics — Luna Sales Chapter 10\n');

  structuralChecks();
  await domainAnalyticsChecks();

  await runScenario('Protected route + 405 unsafe methods for /sales/analytics', BASE_PORT, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
  }, [
    async (port) => {
      const unauth = await request(port, '/sales/analytics');
      ok(
        'unauthenticated GET /sales/analytics redirects to /login',
        unauth.statusCode === 302 && String(unauth.headers.location || '') === '/login',
      );

      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
      });
      const cookie = extractCookiePair(login.headers['set-cookie']);
      ok('login cookie for analytics', /crowsnest_session=/.test(cookie));

      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, '/sales/analytics', method, { Cookie: cookie }, 'GET, HEAD');
      }

      const page = await request(port, '/sales/analytics', { headers: { Cookie: cookie } });
      ok('GET /sales/analytics => 200', page.statusCode === 200, `got ${page.statusCode}`);
      ok('analytics heading present', /Sales analytics|Pipeline counts|Analytics/i.test(page.body));
      ok('pipeline counts section present', /Prospects|Evidence|CRM-ready|Drafts|Contacts/i.test(page.body));
      ok('qualification states visible', /qualified|not_qualified|needs_more_research|unassessed/i.test(page.body));
      ok('recent activity section present', /Recent activity/i.test(page.body));
      ok('data-quality alerts section present', /Data-quality|data quality/i.test(page.body));
      ok(
        'honest read-only / no automatic actions note',
        /read-only|operators decide|no automatic|informational/i.test(page.body),
      );
      ok(
        'no AI/agent / HubSpot sync / outreach / external discovery claims',
        !/AI agent score|autonomous outreach|hubspot sync completed|outreach send completed|Maps discovery ran|Apollo enrichment completed|live AI research ran|automatic remediation/i.test(page.body),
      );
      ok('Sales nav remains available', /href=["']\/sales["']/.test(page.body));
      ok('link back to Sales intake or review', /href=["']\/sales["']|href=["']\/sales\/review["']/.test(page.body));
    },
  ]);

  await runScenario('Analytics counts, alerts, XSS-safe display', BASE_PORT + 1, {
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

      const xssName = '<script>alert("a")</script> UNIQUE_ANALYTICS_XSS_HOSTEL';
      const created = await request(port, '/sales/prospects', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `business_name=${encodeURIComponent(xssName)}`,
      });
      ok('created XSS prospect for analytics', created.statusCode === 302);

      const rich = await request(port, '/sales/prospects', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeBody({
          business_name: 'UNIQUE_ANALYTICS_RICH_HOSTEL',
          website_url: 'https://analytics-rich.example',
        }),
      });
      const richId = String(rich.headers.location || '').split('/').pop();
      await request(port, `/sales/prospects/${richId}/evidence`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeBody({
          source_label: 'Site',
          source_url: 'https://analytics-rich.example',
          summary: 'Strong fit',
          factual_notes: 'Surf hostel',
          limitations: 'Manual',
          confidence: 'high',
        }),
      });
      const richDetail = await request(port, `/sales/prospects/${richId}`, { headers: { Cookie: cookie } });
      const checkboxMatch = richDetail.body.match(/name=["']evidence_ids["'][^>]*value=["']([^"']+)["']/i)
        || richDetail.body.match(/value=["']([^"']+)["'][^>]*name=["']evidence_ids["']/i);
      const evidenceId = checkboxMatch && checkboxMatch[1];
      await request(port, `/sales/prospects/${richId}/qualification`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeBody({
          qualification_decision: 'qualified',
          rationale: 'Northern Spain fit for analytics',
          evidence_ids: evidenceId ? [evidenceId] : [],
        }),
      });
      await request(port, `/sales/prospects/${richId}/crm-ready`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      await request(port, `/sales/prospects/${richId}/outreach-draft`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeBody({
          subject: 'Analytics draft',
          body: 'Hello from analytics draft',
          channel: 'email',
          next_step_note: 'Follow up',
        }),
      });
      await request(port, `/sales/prospects/${richId}/contacts`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeBody({
          full_name: 'Rich Contact',
          role: 'GM',
          email: 'rich@analytics-rich.example',
          source: 'Website',
          confidence: 'medium',
        }),
      });

      const page = await request(port, '/sales/analytics', { headers: { Cookie: cookie } });
      ok('analytics page after seed => 200', page.statusCode === 200, `got ${page.statusCode}`);
      ok('XSS name escaped in analytics HTML', !/<script>alert\("a"\)<\/script>/.test(page.body));
      ok(
        'escaped XSS fragment present when alert references name',
        /UNIQUE_ANALYTICS_XSS_HOSTEL/.test(page.body)
          && (/&lt;script&gt;|&#x3C;script&#x3E;|&lt;script/i.test(page.body) || !/<script/i.test(page.body)),
      );
      ok('pipeline shows at least one prospect count digit', /Prospects[\s\S]{0,120}\d+/i.test(page.body));
      ok('recent activity shows an audit action', /prospect_created|qualification_assessed|research_evidence_recorded|crm_review_ready_marked|outreach_draft_saved|contact_candidate_recorded/i.test(page.body));
      ok(
        'data-quality alert visible for bare XSS prospect',
        /missing website|no evidence|missing_website|no_evidence/i.test(page.body),
      );
      ok(
        'dashboard still denies AI/agent automation claims after seed',
        !/AI scored|agent remediated|automatic fix applied|message has been sent/i.test(page.body),
      );
    },
  ]);

  console.log(`\n── verify:crowsnest-sales-analytics: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) {
    console.error('verify:crowsnest-sales-analytics — FAILED');
    process.exitCode = 1;
    return;
  }
  console.log('verify:crowsnest-sales-analytics — ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => stopServer());
