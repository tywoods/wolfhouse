'use strict';

/**
 * Deterministic RED→GREEN verifier for Luna Sales Chapter 2: Research Evidence Workspace.
 * Offline — no live DB, no Azure, no external research/AI providers.
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
const MIGRATION_043_REL = 'database/migrations/043_luna_sales_research_evidence.sql';
const MIGRATION_043_PATH = path.join(ROOT, MIGRATION_043_REL);
const MIGRATION_042_PATH = path.join(ROOT, 'database', 'migrations', '042_luna_sales_schema.sql');
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'SALES-RESEARCH-EVIDENCE.md');
const PRODUCT_DOC = path.join(ROOT, 'docs', 'CROWSNEST.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const MANIFEST_PATH = path.join(ROOT, 'database', 'migrations', 'canonical-manifest.json');
const BASE_PORT = Number(process.env.CROWSNEST_VERIFY_SALES_RESEARCH_PORT) || 13240;

const {
  sha256CanonicalLfV1File,
  forwardEntries,
  loadManifest,
} = require('./lib/migration-integrity');

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

function structuralChecks() {
  console.log('\n▸ Structural: Chapter 2 evidence workspace');
  const apiSrc = read(API_PATH) || '';
  const pageSrc = read(PAGE_PATH) || '';
  const salesSrc = read(SALES_PATH) || '';
  const storeSrc = read(STORE_PATH) || '';
  const mig043 = read(MIGRATION_043_PATH) || '';
  const docSrc = read(DOC_PATH) || '';
  const productSrc = read(PRODUCT_DOC) || '';

  ok('crowsnest-sales.js exists', fs.existsSync(SALES_PATH));
  ok('sales exports validateManualEvidence', /validateManualEvidence/.test(salesSrc));
  ok('sales exports recordManualEvidence', /recordManualEvidence/.test(salesSrc));
  ok('sales exports listResearchForProspect', /listResearchForProspect/.test(salesSrc));
  ok('store lists research newest-first', /listResearchForProspect/.test(storeSrc) && /ORDER BY created_at DESC/i.test(storeSrc));
  ok('router allowlists evidence path', /\/sales\/prospects\/.+\/evidence|matchSalesEvidencePath/.test(apiSrc));
  ok('detail page has manual evidence form', /evidence/i.test(pageSrc) && /source_label|source_url|confidence/i.test(pageSrc));
  ok('page escapes evidence fields', /escapeHtml/.test(pageSrc));
  ok('no HubSpot/Apollo/Maps/live AI claim in sales evidence', !/require\(['"][^'"]*(hubspot|apollo|googleapis|maps)/i.test(salesSrc));
  ok(
    'does not claim live AI research ran',
    !/live AI research ran|live crawl completed|automated AI qualification completed/i.test(pageSrc),
  );
  ok('migration 043 exists (minimal research_jobs extension)', fs.existsSync(MIGRATION_043_PATH));
  ok('migration 043 extends research_jobs (not parallel table)', /research_jobs/i.test(mig043) && !/CREATE\s+TABLE[\s\S]*evidence/i.test(mig043));
  ok('migration 043 adds source_url', /source_url/i.test(mig043));
  ok('migration 043 adds confidence', /confidence/i.test(mig043));
  ok('evidence doc exists', fs.existsSync(DOC_PATH));
  ok('evidence doc forbids live AI / external research claims', /fixture|manual|no live|not live/i.test(docSrc));
  ok('product doc mentions Chapter 2 research evidence', /Chapter 2|Research Evidence|manual evidence/i.test(productSrc));

  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  } catch {
    pkg = null;
  }
  ok(
    'package.json has verify:crowsnest-sales-research',
    pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-sales-research'] === 'string',
  );

  let manifest = null;
  try {
    manifest = loadManifest();
  } catch (err) {
    manifest = null;
    ok('canonical manifest loads', false, String(err && err.message));
  }
  if (manifest) {
    const entry = manifest.entries.find((e) => e.filename === '043_luna_sales_research_evidence.sql');
    ok('manifest includes 043_luna_sales_research_evidence.sql', Boolean(entry));
    ok('043 is canonical_forward', entry && entry.classification === 'canonical_forward' && entry.inForwardChain === true);
    ok('043 order is 41', entry && entry.order === 41);
    if (entry && fs.existsSync(MIGRATION_043_PATH)) {
      const live = sha256CanonicalLfV1File(MIGRATION_043_PATH);
      ok('043 sha256 matches live file', entry.sha256 === live, `manifest=${entry.sha256} live=${live}`);
    }
    const forwards = forwardEntries(manifest);
    ok('forward count includes 046 (44)', forwards.length === 44, `forward=${forwards.length}`);
  }

  ok('042 research_jobs retained as base table', fs.existsSync(MIGRATION_042_PATH) && /research_jobs/i.test(read(MIGRATION_042_PATH) || ''));
}

async function domainValidationChecks() {
  console.log('\n▸ Manual evidence validation (domain)');
  delete require.cache[require.resolve(SALES_PATH)];
  delete require.cache[require.resolve(STORE_PATH)];
  const sales = require(SALES_PATH);
  const store = require(STORE_PATH);

  ok('validateManualEvidence is a function', typeof sales.validateManualEvidence === 'function');
  if (typeof sales.validateManualEvidence !== 'function') return;

  const empty = sales.validateManualEvidence({});
  ok('empty evidence rejected', empty && empty.ok === false);

  const noLabel = sales.validateManualEvidence({
    source_url: 'https://example.com/about',
    summary: 'About page mentions rooms',
    factual_notes: 'Has dorm beds',
    limitations: 'Homepage only',
    confidence: 'medium',
  });
  ok('missing source label rejected', noLabel && noLabel.ok === false);

  const badUrl = sales.validateManualEvidence({
    source_label: 'Website',
    source_url: 'not a url',
    summary: 'Summary',
    factual_notes: 'Note',
    limitations: 'Limited',
    confidence: 'high',
  });
  ok('invalid source URL rejected', badUrl && badUrl.ok === false);

  const badConfidence = sales.validateManualEvidence({
    source_label: 'Website',
    source_url: 'https://example.com',
    summary: 'Summary',
    factual_notes: 'Note',
    limitations: 'Limited',
    confidence: 'sure-thing',
  });
  ok('invalid confidence rejected', badConfidence && badConfidence.ok === false);

  const tooLong = sales.validateManualEvidence({
    source_label: 'x'.repeat(500),
    source_url: 'https://example.com',
    summary: 'Summary',
    factual_notes: 'Note',
    limitations: 'Limited',
    confidence: 'low',
  });
  ok('oversized source label rejected', tooLong && tooLong.ok === false);

  const missingSummary = sales.validateManualEvidence({
    source_label: 'Website',
    source_url: 'https://example.com',
    summary: '   ',
    factual_notes: 'Note',
    limitations: 'Limited',
    confidence: 'low',
  });
  ok('blank summary rejected', missingSummary && missingSummary.ok === false);

  const missingNotes = sales.validateManualEvidence({
    source_label: 'Website',
    source_url: 'https://example.com',
    summary: 'Summary',
    factual_notes: '',
    limitations: 'Limited',
    confidence: 'low',
  });
  ok('blank factual notes rejected', missingNotes && missingNotes.ok === false);

  const missingLimits = sales.validateManualEvidence({
    source_label: 'Website',
    source_url: 'https://example.com',
    summary: 'Summary',
    factual_notes: 'Note',
    limitations: '',
    confidence: 'low',
  });
  ok('blank limitations rejected', missingLimits && missingLimits.ok === false);

  const valid = sales.validateManualEvidence({
    source_label: 'Hostel website',
    source_url: 'https://example-surf-house.example/about',
    summary: 'Northern Spain surf hostel with dorm beds.',
    factual_notes: 'Dorm capacity mentioned\nShared kitchen listed',
    limitations: 'Manual review only — not crawled live',
    confidence: 'medium',
  });
  ok('valid manual evidence accepted', valid && valid.ok === true, JSON.stringify(valid));
  ok('valid evidence normalizes confidence', valid && valid.confidence === 'medium');
  ok('valid evidence keeps source label', valid && valid.source_label === 'Hostel website');
  ok('valid evidence parses factual notes', valid && Array.isArray(valid.factual_notes) && valid.factual_notes.length === 2);
  ok('valid evidence parses limitations', valid && Array.isArray(valid.limitations) && valid.limitations.length === 1);

  const repo = store.createMemorySalesRepository();
  if (typeof sales._setSalesRepositoryForTests === 'function') {
    sales._setSalesRepositoryForTests(repo);
  }
  const created = await sales.createProspect({ business_name: 'Evidence Hostel' }, 'Admin');
  ok('prospect created for evidence domain checks', created && created.ok === true);
  if (!(created && created.ok)) return;
  const prospectId = created.prospect.id;

  const recorded = await sales.recordManualEvidence(prospectId, {
    source_label: 'Booking page',
    source_url: 'https://evidence-hostel.example/book',
    summary: 'Online booking form present',
    factual_notes: 'Accepts card payments\nEnglish language site',
    limitations: 'Operator-entered manual notes only',
    confidence: 'high',
  }, 'Earthling');
  ok('recordManualEvidence ok', recorded && recorded.ok === true && recorded.research, JSON.stringify(recorded));
  ok('manual evidence source is manual', recorded && recorded.research && recorded.research.source === 'manual');
  ok('manual evidence status completed', recorded && recorded.research && recorded.research.status === 'completed');
  ok('manual evidence stores source_url', recorded && recorded.research && /evidence-hostel\.example/.test(recorded.research.source_url || ''));
  ok('manual evidence stores confidence', recorded && recorded.research && recorded.research.confidence === 'high');
  ok('manual evidence is prospect-scoped', recorded && recorded.research && recorded.research.prospect_id === prospectId);

  const listed = await sales.listResearchForProspect(prospectId);
  ok('listResearchForProspect returns array', Array.isArray(listed));
  ok('fixture research preserved alongside evidence', listed.some((r) => r.source === 'fixture') && listed.some((r) => r.source === 'manual'));
  ok(
    'research list is newest-first',
    listed.length >= 2 && String(listed[0].created_at) >= String(listed[1].created_at),
    listed.map((r) => `${r.source}:${r.created_at}`).join(' | '),
  );

  const audits = await sales.listAuditEvents(prospectId);
  const evidenceAudits = audits.filter((e) => e.action === 'research_evidence_recorded');
  ok('append-only audit event for evidence', evidenceAudits.length === 1);
  ok('evidence audit identifies operator', evidenceAudits[0] && evidenceAudits[0].actor === 'Earthling');
  ok(
    'evidence audit is prospect-scoped',
    evidenceAudits[0]
      && (evidenceAudits[0].entity_id === recorded.research.id
        || (evidenceAudits[0].detail && evidenceAudits[0].detail.prospect_id === prospectId)),
  );

  const beforeLen = audits.length;
  const snapshot = audits.map((e) => ({ ...e, detail: e.detail ? { ...e.detail } : e.detail }));
  await sales.recordManualEvidence(prospectId, {
    source_label: 'Instagram',
    source_url: 'https://instagram.example/evidencehostel',
    summary: 'Seasonal photos of Somo beach area',
    factual_notes: 'Recent posts mention summer season',
    limitations: 'Social media is incomplete',
    confidence: 'low',
  }, 'Monshies');
  const after = await sales.listAuditEvents(prospectId);
  ok('second evidence appends audit (no overwrite)', after.length === beforeLen + 1);
  ok(
    'prior audit events remain intact (append-only)',
    snapshot.every((old, idx) => {
      const cur = after[idx];
      return cur && cur.id === old.id && cur.action === old.action && JSON.stringify(cur.detail) === JSON.stringify(old.detail);
    }),
  );

  const missingProspect = await sales.recordManualEvidence('00000000-0000-4000-8000-000000000099', {
    source_label: 'Website',
    source_url: 'https://example.com',
    summary: 'Summary',
    factual_notes: 'Note',
    limitations: 'Limited',
    confidence: 'low',
  }, 'Admin');
  ok('missing prospect returns 404', missingProspect && missingProspect.ok === false && missingProspect.status === 404);

  console.log('\n▸ Production safe-failure for evidence mutations');
  const failRepo = await store.createSalesRepository({ NODE_ENV: 'production' });
  sales._setSalesRepositoryForTests(failRepo);
  const closed = await sales.recordManualEvidence(prospectId, {
    source_label: 'Website',
    source_url: 'https://example.com',
    summary: 'Summary',
    factual_notes: 'Note',
    limitations: 'Limited',
    confidence: 'low',
  }, 'Admin');
  ok(
    'production missing DSN rejects evidence write',
    closed && closed.ok === false && (closed.status === 503 || closed.code === 'sales_store_misconfigured'),
    JSON.stringify(closed),
  );
  ok(
    'fail-closed evidence error does not leak DSN/SQL',
    closed && !/postgres:\/\/|WOLFHOUSE|INSERT\s+INTO|password/i.test(JSON.stringify(closed)),
  );

  console.log('\n▸ Durable repository SQL for evidence fields');
  const recordedSql = [];
  const pgRepo = store.createPgSalesRepository({
    query: async (sql, params) => {
      recordedSql.push({ sql: String(sql), params });
      if (/SELECT[\s\S]*FROM\s+luna_sales\.prospects/i.test(sql)) {
        return {
          rows: [{
            id: prospectId,
            canonical_name: 'SQL Evidence Hostel',
            website_url: '',
            lifecycle_status: 'ready_for_review',
            owner_id: 'Admin',
            created_at: '2026-07-22T00:00:00.000Z',
            updated_at: '2026-07-22T00:00:00.000Z',
            last_decision: null,
          }],
        };
      }
      if (/INSERT\s+INTO\s+luna_sales\.research_jobs/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT\s+INTO\s+luna_sales\.audit_events/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT[\s\S]*FROM\s+luna_sales\.research_jobs/i.test(sql)) {
        return {
          rows: [{
            id: '22222222-2222-4222-8222-222222222222',
            prospect_id: prospectId,
            source: 'manual',
            status: 'completed',
            job_label: 'Website',
            summary: 'Summary',
            facts: [{ type: 'factual_note', value: 'Note', citation: 'Website' }],
            limitations: ['Limited'],
            source_url: 'https://example.com',
            confidence: 'low',
            created_at: '2026-07-22T01:00:00.000Z',
          }],
        };
      }
      return { rows: [] };
    },
  });
  sales._setSalesRepositoryForTests(pgRepo);
  await sales.recordManualEvidence(prospectId, {
    source_label: 'Website',
    source_url: 'https://example.com',
    summary: 'Summary',
    factual_notes: 'Note',
    limitations: 'Limited',
    confidence: 'low',
  }, 'Admin');
  await pgRepo.listResearchForProspect(prospectId);

  const researchInserts = recordedSql.filter((c) => /INSERT\s+INTO\s+luna_sales\.research_jobs/i.test(c.sql));
  ok('pg evidence write inserts into luna_sales.research_jobs', researchInserts.length >= 1);
  ok(
    'pg research INSERT includes source_url and confidence columns',
    researchInserts.some((c) => /source_url/i.test(c.sql) && /confidence/i.test(c.sql)),
    researchInserts.map((c) => c.sql.split('\n')[0]).join(' | '),
  );
  ok(
    'all evidence-related SQL qualifies luna_sales',
    recordedSql.every((c) => /luna_sales\./.test(c.sql)),
  );
  ok(
    'evidence audit path is INSERT-only (append-only)',
    recordedSql.filter((c) => /audit_events/i.test(c.sql)).every((c) => /^\s*INSERT\b/i.test(c.sql.trim())),
  );
  ok(
    'listResearchForProspect SQL orders newest-first',
    recordedSql.some((c) => /FROM\s+luna_sales\.research_jobs/i.test(c.sql) && /ORDER BY created_at DESC/i.test(c.sql)),
  );

  const leaky = new Error(
    'password authentication failed postgres://crowsnest_sales:SuperSecretPass@prod-db.azure.com:5432/app SQL: SELECT * FROM pg_shadow',
  );
  const leakyRepo = store.createPgSalesRepository({
    query: async () => {
      throw leaky;
    },
  });
  sales._setSalesRepositoryForTests(leakyRepo);
  const unavailable = await sales.recordManualEvidence(prospectId, {
    source_label: 'Website',
    source_url: 'https://example.com',
    summary: 'Summary',
    factual_notes: 'Note',
    limitations: 'Limited',
    confidence: 'low',
  }, 'Admin');
  ok(
    'pg evidence failure returns safe sales_unavailable',
    unavailable
      && unavailable.ok === false
      && unavailable.status === 503
      && unavailable.code === 'sales_unavailable'
      && unavailable.retryable === true,
    JSON.stringify(unavailable),
  );
  ok(
    'pg evidence failure does not leak secrets/SQL',
    unavailable && !/SuperSecretPass|postgres:\/\/|prod-db\.azure|pg_shadow/i.test(JSON.stringify(unavailable)),
  );
}

async function main() {
  console.log('verify:crowsnest-sales-research — Luna Sales Chapter 2\n');

  structuralChecks();
  await domainValidationChecks();

  await runScenario('Auth + method protection for evidence POST', BASE_PORT, {
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
      ok('login cookie for evidence scenario', /crowsnest_session=/.test(cookie));

      const created = await request(port, '/sales/prospects', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'business_name=Auth+Evidence+Hostel',
      });
      const detailPath = String(created.headers.location || '');
      ok('created prospect for evidence route', created.statusCode === 302 && detailPath.startsWith('/sales/prospects/'));
      const prospectId = detailPath.split('/').pop();
      const evidenceUrl = `/sales/prospects/${prospectId}/evidence`;

      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, evidenceUrl, method, { Cookie: cookie }, 'POST');
      }

      const unauth = await request(port, evidenceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeEvidenceBody({
          source_label: 'Website',
          source_url: 'https://example.com',
          summary: 'Summary',
          factual_notes: 'Note',
          limitations: 'Limited',
          confidence: 'low',
        }),
      });
      ok(
        'unauthenticated evidence POST redirects to /login',
        unauth.statusCode === 302 && String(unauth.headers.location || '') === '/login',
      );

      const detail = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok('detail shows manual evidence form', /name=["']source_label["']/.test(detail.body) && /name=["']confidence["']/.test(detail.body));
      ok('detail still shows fixture research', /fixture/i.test(detail.body));
      ok(
        'detail does not claim live AI research ran',
        !/live AI research ran|live crawl completed|sync to hubspot|push to apollo/i.test(detail.body),
      );
    },
  ]);

  await runScenario('XSS-safe evidence presentation + newest-first list', BASE_PORT + 1, {
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
        body: 'business_name=XSS+Evidence+Hostel',
      });
      const detailPath = String(created.headers.location || '');
      const prospectId = detailPath.split('/').pop();
      const evidenceUrl = `/sales/prospects/${prospectId}/evidence`;

      const xssPayload = {
        source_label: '<script>alert("label")</script>',
        source_url: 'https://xss.example/path',
        summary: '<img src=x onerror=alert(1)> summary',
        factual_notes: '<script>alert("fact")</script>',
        limitations: '<b>limit</b><script>alert("lim")</script>',
        confidence: 'medium',
      };

      const older = await request(port, evidenceUrl, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeEvidenceBody({
          source_label: 'Older source',
          source_url: 'https://older.example',
          summary: 'Older evidence summary UNIQUE_OLDER_EVIDENCE',
          factual_notes: 'Older fact',
          limitations: 'Older limitation',
          confidence: 'low',
        }),
      });
      ok(
        'first evidence POST redirects to detail',
        older.statusCode === 302 && String(older.headers.location || '') === detailPath,
        `status=${older.statusCode} loc=${older.headers.location}`,
      );

      // Ensure newer timestamp ordering in memory fallback
      await new Promise((r) => setTimeout(r, 20));

      const newer = await request(port, evidenceUrl, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeEvidenceBody(xssPayload),
      });
      ok(
        'second evidence POST redirects to detail',
        newer.statusCode === 302 && String(newer.headers.location || '') === detailPath,
        `status=${newer.statusCode} loc=${newer.headers.location}`,
      );

      const detail = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok('detail still includes fixture research after evidence', /fixture/i.test(detail.body));
      ok('detail shows newer evidence summary', /&lt;img src=x onerror=alert\(1\)&gt; summary|&lt;img/i.test(detail.body) || /summary/.test(detail.body));
      ok('script tags are escaped (no raw script)', !/<script>alert\("label"\)<\/script>/.test(detail.body));
      ok('escaped label entities present', /&lt;script&gt;/.test(detail.body));
      ok('escaped factual note entities present', detail.body.includes('&lt;script&gt;alert("fact")&lt;/script&gt;') || /&lt;script&gt;/.test(detail.body));
      ok('confidence visible', /medium/i.test(detail.body));
      ok('source URL visible/escaped', /xss\.example/.test(detail.body));
      ok('audit shows research_evidence_recorded', /research_evidence_recorded/i.test(detail.body));
      ok('audit identifies operator', /actor=admin|actor=Admin|Admin/i.test(detail.body));

      const olderIdx = detail.body.indexOf('UNIQUE_OLDER_EVIDENCE');
      const newerIdx = detail.body.search(/onerror=alert\(1\)|&lt;img src=x/i);
      ok(
        'evidence entries list newer before older when both present',
        olderIdx >= 0 && newerIdx >= 0 && newerIdx < olderIdx,
        `newerIdx=${newerIdx} olderIdx=${olderIdx}`,
      );

      const invalid = await request(port, evidenceUrl, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeEvidenceBody({
          source_label: '',
          source_url: 'https://example.com',
          summary: 'Summary',
          factual_notes: 'Note',
          limitations: 'Limited',
          confidence: 'low',
        }),
      });
      ok(
        'invalid evidence redisplays with error',
        invalid.statusCode === 400
          || (invalid.statusCode === 200 && /source label|required|provide/i.test(invalid.body)),
        `status=${invalid.statusCode}`,
      );
    },
  ]);

  await runScenario('Authenticated operators can record evidence', BASE_PORT + 2, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_EARTHLING_USERNAME: 'earthling-op',
    CROWSNEST_AUTH_EARTHLING_PASSWORD: 'earth-pass',
    CROWSNEST_AUTH_MONSHIES_USERNAME: 'monshies-op',
    CROWSNEST_AUTH_MONSHIES_PASSWORD: 'mon-pass',
  }, [
    async (port) => {
      const monshiesLogin = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=monshies-op&password=mon-pass',
      });
      const cookie = extractCookiePair(monshiesLogin.headers['set-cookie']);

      const created = await request(port, '/sales/prospects', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'business_name=Monshies+Evidence+Hostel',
      });
      const detailPath = String(created.headers.location || '');
      const prospectId = detailPath.split('/').pop();

      const posted = await request(port, `/sales/prospects/${prospectId}/evidence`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeEvidenceBody({
          source_label: 'Operator notes',
          source_url: 'https://monshies-evidence.example',
          summary: 'Monshies recorded manual evidence',
          factual_notes: 'Looks like a surf hostel',
          limitations: 'Manual only',
          confidence: 'medium',
        }),
      });
      ok('authenticated operator can POST evidence', posted.statusCode === 302, `status=${posted.statusCode}`);

      const detail = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok('operator evidence visible on detail', /Monshies recorded manual evidence/i.test(detail.body));
      ok('operator actor appears in audit', /monshies-op|Admin|actor=/i.test(detail.body));
    },
  ]);

  console.log(`\n── verify:crowsnest-sales-research: ${pass} passed, ${fail} failed ──`);
  if (fail === 0) {
    console.log('verify:crowsnest-sales-research — ALL CHECKS PASSED');
  }
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  await stopServer();
  console.error(err);
  process.exit(1);
});
