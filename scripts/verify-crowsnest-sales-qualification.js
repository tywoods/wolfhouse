'use strict';

/**
 * Deterministic RED→GREEN verifier for Luna Sales Chapter 3: Qualification Policy.
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
const MIGRATION_044_REL = 'database/migrations/044_luna_sales_qualification.sql';
const MIGRATION_044_PATH = path.join(ROOT, MIGRATION_044_REL);
const MIGRATION_042_PATH = path.join(ROOT, 'database', 'migrations', '042_luna_sales_schema.sql');
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'SALES-QUALIFICATION-POLICY.md');
const PRODUCT_DOC = path.join(ROOT, 'docs', 'CROWSNEST.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const MANIFEST_PATH = path.join(ROOT, 'database', 'migrations', 'canonical-manifest.json');
const BASE_PORT = Number(process.env.CROWSNEST_VERIFY_SALES_QUALIFICATION_PORT) || 13340;

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

function encodeEvidenceBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, value == null ? '' : String(value));
  }
  return params.toString();
}

function structuralChecks() {
  console.log('\n▸ Structural: Chapter 3 qualification policy');
  const apiSrc = read(API_PATH) || '';
  const pageSrc = read(PAGE_PATH) || '';
  const salesSrc = read(SALES_PATH) || '';
  const storeSrc = read(STORE_PATH) || '';
  const mig044 = read(MIGRATION_044_PATH) || '';
  const docSrc = read(DOC_PATH) || '';
  const productSrc = read(PRODUCT_DOC) || '';

  ok('crowsnest-sales.js exists', fs.existsSync(SALES_PATH));
  ok('sales exports validateQualification', /validateQualification/.test(salesSrc));
  ok('sales exports recordQualification', /recordQualification/.test(salesSrc));
  ok('sales exports listQualificationsForProspect', /listQualificationsForProspect/.test(salesSrc));
  ok('sales exports getLatestQualification', /getLatestQualification/.test(salesSrc));
  ok(
    'allowed decisions include qualified / not_qualified / needs_more_research',
    /qualified/.test(salesSrc) && /not_qualified/.test(salesSrc) && /needs_more_research/.test(salesSrc),
  );
  ok('store supports qualification assessments', /qualification/i.test(storeSrc) && /saveQualification|listQualifications/i.test(storeSrc));
  ok('router allowlists qualification path', /\/sales\/prospects\/.+\/qualification|matchSalesQualificationPath/.test(apiSrc));
  ok('detail page has qualification form', /qualification/i.test(pageSrc) && /qualification_decision|rationale|evidence_ids|needs_more_research/i.test(pageSrc));
  ok('page escapes qualification fields', /escapeHtml/.test(pageSrc));
  ok(
    'no hidden score / automatic AI scoring claim',
    !/live AI research ran|automated AI qualification completed|hidden_score|lead_score\s*[:=]|AI score:\s*\d/i.test(pageSrc)
      && !/sync to hubspot|push to apollo|outreach send completed/i.test(pageSrc),
  );
  ok('no HubSpot/Apollo/Google SDK require in sales', !/require\(['"][^'"]*(hubspot|apollo|googleapis)/i.test(salesSrc));
  ok('migration 044 exists (qualification assessments)', fs.existsSync(MIGRATION_044_PATH));
  ok(
    'migration 044 creates qualification_assessments',
    /qualification_assessments/i.test(mig044) && /CREATE\s+TABLE/i.test(mig044),
  );
  ok(
    'migration 044 decisions CHECK qualified/not_qualified/needs_more_research',
    /qualified/.test(mig044) && /not_qualified/.test(mig044) && /needs_more_research/.test(mig044),
  );
  ok('qualification doc exists', fs.existsSync(DOC_PATH));
  ok(
    'qualification doc forbids AI scoring / HubSpot / outreach claims',
    /no hidden|operator|manual|not automatic|no HubSpot|no outreach/i.test(docSrc),
  );
  ok('product doc mentions Chapter 3 qualification', /Chapter 3|Qualification Policy|qualification assessment/i.test(productSrc));

  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  } catch {
    pkg = null;
  }
  ok(
    'package.json has verify:crowsnest-sales-qualification',
    pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-sales-qualification'] === 'string',
  );

  let manifest = null;
  try {
    manifest = loadManifest();
  } catch (err) {
    manifest = null;
    ok('canonical manifest loads', false, String(err && err.message));
  }
  if (manifest) {
    const entry = manifest.entries.find((e) => e.filename === '044_luna_sales_qualification.sql');
    ok('manifest includes 044_luna_sales_qualification.sql', Boolean(entry));
    ok('044 is canonical_forward', entry && entry.classification === 'canonical_forward' && entry.inForwardChain === true);
    ok('044 order is 42', entry && entry.order === 42);
    if (entry && fs.existsSync(MIGRATION_044_PATH)) {
      const live = sha256CanonicalLfV1File(MIGRATION_044_PATH);
      ok('044 sha256 matches live file', entry.sha256 === live, `manifest=${entry.sha256} live=${live}`);
    }
    const forwards = forwardEntries(manifest);
    ok('forward count includes 050 (48)', forwards.length === 48, `forward=${forwards.length}`);
  }

  ok('042 schema retained as base', fs.existsSync(MIGRATION_042_PATH) && /luna_sales/i.test(read(MIGRATION_042_PATH) || ''));
}

async function domainValidationChecks() {
  console.log('\n▸ Qualification validation (domain)');
  delete require.cache[require.resolve(SALES_PATH)];
  delete require.cache[require.resolve(STORE_PATH)];
  const sales = require(SALES_PATH);
  const store = require(STORE_PATH);

  ok('validateQualification is a function', typeof sales.validateQualification === 'function');
  if (typeof sales.validateQualification !== 'function') return;

  const empty = sales.validateQualification({});
  ok('empty qualification rejected', empty && empty.ok === false);

  const badDecision = sales.validateQualification({
    decision: 'maybe',
    rationale: 'Looks fine',
    evidence_ids: ['11111111-1111-4111-8111-111111111111'],
  }, ['11111111-1111-4111-8111-111111111111']);
  ok('invalid decision rejected', badDecision && badDecision.ok === false);

  const blankRationale = sales.validateQualification({
    decision: 'qualified',
    rationale: '   ',
    evidence_ids: ['11111111-1111-4111-8111-111111111111'],
  }, ['11111111-1111-4111-8111-111111111111']);
  ok('blank rationale rejected', blankRationale && blankRationale.ok === false);

  const tooLong = sales.validateQualification({
    decision: 'qualified',
    rationale: 'x'.repeat(5000),
    evidence_ids: ['11111111-1111-4111-8111-111111111111'],
  }, ['11111111-1111-4111-8111-111111111111']);
  ok('oversized rationale rejected', tooLong && tooLong.ok === false);

  const noEvidence = sales.validateQualification({
    decision: 'qualified',
    rationale: 'Strong hostel fit for Luna',
    evidence_ids: [],
  }, ['11111111-1111-4111-8111-111111111111']);
  ok('missing evidence refs rejected', noEvidence && noEvidence.ok === false);

  const foreignEvidenceReject = sales.validateQualification({
    decision: 'not_qualified',
    rationale: 'Wrong market',
    evidence_ids: ['99999999-9999-4999-8999-999999999999'],
  }, ['11111111-1111-4111-8111-111111111111']);
  ok('evidence refs must belong to prospect', foreignEvidenceReject && foreignEvidenceReject.ok === false);

  const valid = sales.validateQualification({
    decision: 'needs_more_research',
    rationale: 'Need more website confirmation',
    evidence_ids: ['11111111-1111-4111-8111-111111111111'],
  }, ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);
  ok('valid qualification accepted', valid && valid.ok === true, JSON.stringify(valid));
  ok('valid decision normalized', valid && valid.decision === 'needs_more_research');
  ok('valid rationale trimmed', valid && valid.rationale === 'Need more website confirmation');
  ok('valid evidence refs retained', valid && Array.isArray(valid.evidence_ids) && valid.evidence_ids.length === 1);

  const repo = store.createMemorySalesRepository();
  if (typeof sales._setSalesRepositoryForTests === 'function') {
    sales._setSalesRepositoryForTests(repo);
  }
  const created = await sales.createProspect({ business_name: 'Qualification Hostel' }, 'Admin');
  ok('prospect created for qualification domain checks', created && created.ok === true);
  if (!(created && created.ok)) return;
  const prospectId = created.prospect.id;

  const evidence = await sales.recordManualEvidence(prospectId, {
    source_label: 'Website',
    source_url: 'https://qualification-hostel.example',
    summary: 'Surf hostel with dorm beds',
    factual_notes: 'Dorm capacity listed',
    limitations: 'Manual notes only',
    confidence: 'medium',
  }, 'Earthling');
  ok('manual evidence recorded for refs', evidence && evidence.ok === true && evidence.research);
  const evidenceId = evidence.research.id;
  const fixtureId = created.research && created.research.id;

  const recorded = await sales.recordQualification(prospectId, {
    decision: 'qualified',
    rationale: 'Fits Northern Spain hostel pilot',
    evidence_ids: [evidenceId, fixtureId].filter(Boolean),
  }, 'Earthling');
  ok('recordQualification ok', recorded && recorded.ok === true && recorded.assessment, JSON.stringify(recorded));
  ok('assessment decision is qualified', recorded && recorded.assessment && recorded.assessment.decision === 'qualified');
  ok('assessment has rationale', recorded && recorded.assessment && /Northern Spain/.test(recorded.assessment.rationale || ''));
  ok(
    'assessment evidence refs are prospect-scoped',
    recorded
      && recorded.assessment
      && Array.isArray(recorded.assessment.evidence_ids)
      && recorded.assessment.evidence_ids.includes(evidenceId),
  );
  ok('assessment has no hidden score field', recorded && recorded.assessment && recorded.assessment.score == null && recorded.assessment.lead_score == null);

  const latest = await sales.getLatestQualification(prospectId);
  ok('getLatestQualification returns latest', latest && latest.id === recorded.assessment.id);

  await new Promise((r) => setTimeout(r, 5));
  const second = await sales.recordQualification(prospectId, {
    decision: 'needs_more_research',
    rationale: 'Want one more booking-page note',
    evidence_ids: [evidenceId],
  }, 'Monshies');
  ok('second qualification recorded', second && second.ok === true);

  const listed = await sales.listQualificationsForProspect(prospectId);
  ok('listQualificationsForProspect returns array', Array.isArray(listed) && listed.length >= 2);
  ok(
    'qualification history newest-first',
    listed.length >= 2 && String(listed[0].created_at) >= String(listed[1].created_at),
    listed.map((a) => `${a.decision}:${a.created_at}`).join(' | '),
  );
  ok('latest after second is needs_more_research', (await sales.getLatestQualification(prospectId)).decision === 'needs_more_research');

  const audits = await sales.listAuditEvents(prospectId);
  const qualAudits = audits.filter((e) => e.action === 'qualification_assessed');
  ok('append-only audit for qualification', qualAudits.length >= 2);
  ok('qualification audit identifies operator', qualAudits.some((e) => e.actor === 'Earthling'));
  ok(
    'qualification audit is prospect-scoped',
    qualAudits.every((e) => e.detail && e.detail.prospect_id === prospectId),
  );

  const beforeLen = audits.length;
  const snapshot = audits.map((e) => ({ ...e, detail: e.detail ? { ...e.detail } : e.detail }));
  await sales.recordQualification(prospectId, {
    decision: 'not_qualified',
    rationale: 'Outside pilot geography',
    evidence_ids: [evidenceId],
  }, 'Admin');
  const after = await sales.listAuditEvents(prospectId);
  ok('third qualification appends audit (no overwrite)', after.length === beforeLen + 1);
  ok(
    'prior audit events remain intact (append-only)',
    snapshot.every((old, idx) => {
      const cur = after[idx];
      return cur && cur.id === old.id && cur.action === old.action && JSON.stringify(cur.detail) === JSON.stringify(old.detail);
    }),
  );

  const foreignProspect = await sales.createProspect({ business_name: 'Other Hostel' }, 'Admin');
  const foreignEvidence = await sales.recordManualEvidence(foreignProspect.prospect.id, {
    source_label: 'Other site',
    source_url: 'https://other.example',
    summary: 'Other summary',
    factual_notes: 'Other note',
    limitations: 'Other limit',
    confidence: 'low',
  }, 'Admin');
  const crossRef = await sales.recordQualification(prospectId, {
    decision: 'qualified',
    rationale: 'Should reject foreign evidence',
    evidence_ids: [foreignEvidence.research.id],
  }, 'Admin');
  ok(
    'cross-prospect evidence ref rejected',
    crossRef && crossRef.ok === false && (crossRef.status === 400 || /evidence/i.test(crossRef.error || '')),
    JSON.stringify(crossRef),
  );

  const missingProspect = await sales.recordQualification('00000000-0000-4000-8000-000000000099', {
    decision: 'qualified',
    rationale: 'Nope',
    evidence_ids: [evidenceId],
  }, 'Admin');
  ok('missing prospect returns 404', missingProspect && missingProspect.ok === false && missingProspect.status === 404);

  console.log('\n▸ Production safe-failure for qualification mutations');
  const failRepo = await store.createSalesRepository({ NODE_ENV: 'production' });
  sales._setSalesRepositoryForTests(failRepo);
  const closed = await sales.recordQualification(prospectId, {
    decision: 'qualified',
    rationale: 'Should fail closed',
    evidence_ids: [evidenceId],
  }, 'Admin');
  ok(
    'production missing DSN rejects qualification write',
    closed && closed.ok === false && (closed.status === 503 || closed.code === 'sales_store_misconfigured'),
    JSON.stringify(closed),
  );
  ok(
    'fail-closed qualification error does not leak DSN/SQL',
    closed && !/postgres:\/\/|WOLFHOUSE|INSERT\s+INTO|password/i.test(JSON.stringify(closed)),
  );

  console.log('\n▸ Durable repository SQL for qualification assessments');
  const recordedSql = [];
  const pgRepo = store.createPgSalesRepository({
    query: async (sql, params) => {
      recordedSql.push({ sql: String(sql), params });
      if (/SELECT[\s\S]*FROM\s+luna_sales\.prospects/i.test(sql)) {
        return {
          rows: [{
            id: prospectId,
            canonical_name: 'SQL Qualification Hostel',
            website_url: '',
            lifecycle_status: 'ready_for_review',
            owner_id: 'Admin',
            created_at: '2026-07-22T00:00:00.000Z',
            updated_at: '2026-07-22T00:00:00.000Z',
            last_decision: null,
          }],
        };
      }
      if (/SELECT[\s\S]*FROM\s+luna_sales\.research_jobs/i.test(sql)) {
        return {
          rows: [{
            id: evidenceId,
            prospect_id: prospectId,
            source: 'manual',
            status: 'completed',
            job_label: 'Website',
            summary: 'Summary',
            facts: [],
            limitations: [],
            source_url: 'https://example.com',
            confidence: 'medium',
            created_at: '2026-07-22T01:00:00.000Z',
          }],
        };
      }
      if (/INSERT\s+INTO\s+luna_sales\.qualification_assessments/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT\s+INTO\s+luna_sales\.audit_events/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT[\s\S]*FROM\s+luna_sales\.qualification_assessments/i.test(sql)) {
        return {
          rows: [{
            id: '33333333-3333-4333-8333-333333333333',
            prospect_id: prospectId,
            decision: 'qualified',
            rationale: 'Fits pilot',
            evidence_ids: [evidenceId],
            reviewer_id: 'Admin',
            created_at: '2026-07-22T02:00:00.000Z',
          }],
        };
      }
      return { rows: [] };
    },
  });
  sales._setSalesRepositoryForTests(pgRepo);
  await sales.recordQualification(prospectId, {
    decision: 'qualified',
    rationale: 'Fits pilot',
    evidence_ids: [evidenceId],
  }, 'Admin');
  await pgRepo.listQualificationsForProspect(prospectId);

  const qualInserts = recordedSql.filter((c) => /INSERT\s+INTO\s+luna_sales\.qualification_assessments/i.test(c.sql));
  ok('pg qualification write inserts into luna_sales.qualification_assessments', qualInserts.length >= 1);
  ok(
    'all qualification-related SQL qualifies luna_sales',
    recordedSql.every((c) => /luna_sales\./.test(c.sql)),
  );
  ok(
    'qualification audit path is INSERT-only (append-only)',
    recordedSql.filter((c) => /audit_events/i.test(c.sql)).every((c) => /^\s*INSERT\b/i.test(c.sql.trim())),
  );
  ok(
    'listQualifications SQL orders newest-first',
    recordedSql.some((c) => /FROM\s+luna_sales\.qualification_assessments/i.test(c.sql) && /ORDER BY created_at DESC/i.test(c.sql)),
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
  const unavailable = await sales.recordQualification(prospectId, {
    decision: 'qualified',
    rationale: 'Fits pilot',
    evidence_ids: [evidenceId],
  }, 'Admin');
  ok(
    'pg qualification failure returns safe sales_unavailable',
    unavailable
      && unavailable.ok === false
      && unavailable.status === 503
      && unavailable.code === 'sales_unavailable'
      && unavailable.retryable === true,
    JSON.stringify(unavailable),
  );
  ok(
    'pg qualification failure does not leak secrets/SQL',
    unavailable && !/SuperSecretPass|postgres:\/\/|prod-db\.azure|pg_shadow/i.test(JSON.stringify(unavailable)),
  );
}

async function main() {
  console.log('verify:crowsnest-sales-qualification — Luna Sales Chapter 3\n');

  structuralChecks();
  await domainValidationChecks();

  await runScenario('Auth + method protection for qualification POST', BASE_PORT, {
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
      ok('login cookie for qualification scenario', /crowsnest_session=/.test(cookie));

      const created = await request(port, '/sales/prospects', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'business_name=Auth+Qualification+Hostel',
      });
      const detailPath = String(created.headers.location || '');
      ok('created prospect for qualification route', created.statusCode === 302 && detailPath.startsWith('/sales/prospects/'));
      const prospectId = detailPath.split('/').pop();
      const qualificationUrl = `/sales/prospects/${prospectId}/qualification`;

      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, qualificationUrl, method, { Cookie: cookie }, 'POST');
      }

      const unauth = await request(port, qualificationUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeQualificationBody({
          qualification_decision: 'qualified',
          rationale: 'Should require auth',
          evidence_ids: ['11111111-1111-4111-8111-111111111111'],
        }),
      });
      ok(
        'unauthenticated qualification POST redirects to /login',
        unauth.statusCode === 302 && String(unauth.headers.location || '') === '/login',
      );

      const detail = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok('detail shows qualification form', /name=["']qualification_decision["']/.test(detail.body) && /name=["']rationale["']/.test(detail.body));
      ok('detail shows evidence_ids inputs', /name=["']evidence_ids["']/.test(detail.body));
      ok(
        'detail does not claim AI scoring / HubSpot / outreach',
        !/automated AI qualification completed|live AI research ran|sync to hubspot|push to apollo|outreach send completed|lead_score\s*[:=]|AI score:\s*\d/i.test(detail.body),
      );
    },
  ]);

  await runScenario('XSS-safe qualification presentation + latest + history', BASE_PORT + 1, {
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
        body: 'business_name=XSS+Qualification+Hostel',
      });
      const detailPath = String(created.headers.location || '');
      const prospectId = detailPath.split('/').pop();
      const evidenceUrl = `/sales/prospects/${prospectId}/evidence`;
      const qualificationUrl = `/sales/prospects/${prospectId}/qualification`;

      const evidencePosted = await request(port, evidenceUrl, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeEvidenceBody({
          source_label: 'Booking page',
          source_url: 'https://xss-qual.example/book',
          summary: 'UNIQUE_QUAL_EVIDENCE_SUMMARY',
          factual_notes: 'Accepts bookings',
          limitations: 'Manual only',
          confidence: 'high',
        }),
      });
      ok('evidence available for qualification refs', evidencePosted.statusCode === 302, `status=${evidencePosted.statusCode}`);

      const detailBefore = await request(port, detailPath, { headers: { Cookie: cookie } });
      const checkboxMatch = detailBefore.body.match(/name=["']evidence_ids["'][^>]*value=["']([^"']+)["']/i)
        || detailBefore.body.match(/value=["']([^"']+)["'][^>]*name=["']evidence_ids["']/i);
      ok('detail exposes evidence checkbox values', Boolean(checkboxMatch), 'no evidence_ids checkbox found');
      const evidenceRefId = checkboxMatch ? checkboxMatch[1] : '';

      const xssRationale = '<script>alert("qual")</script> UNIQUE_XSS_RATIONALE';
      const posted = await request(port, qualificationUrl, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeQualificationBody({
          qualification_decision: 'qualified',
          rationale: xssRationale,
          evidence_ids: [evidenceRefId],
        }),
      });
      ok(
        'qualification POST redirects to detail',
        posted.statusCode === 302 && String(posted.headers.location || '') === detailPath,
        `status=${posted.statusCode} loc=${posted.headers.location}`,
      );

      const detail = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok('latest assessment visible', /qualified/i.test(detail.body) && /UNIQUE_XSS_RATIONALE|Latest qualification/i.test(detail.body));
      ok('script tags are escaped (no raw script)', !/<script>alert\("qual"\)<\/script>/.test(detail.body));
      ok('escaped rationale entities present', /&lt;script&gt;/.test(detail.body));
      ok('evidence link/ref visible', /UNIQUE_QUAL_EVIDENCE_SUMMARY|evidence/i.test(detail.body));
      ok('audit shows qualification_assessed', /qualification_assessed/i.test(detail.body));
      ok('no hidden score rendered', !/lead_score\s*[:=]|AI score:\s*\d|hidden_score|score=\d+/i.test(detail.body));

      await new Promise((r) => setTimeout(r, 20));
      const second = await request(port, qualificationUrl, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeQualificationBody({
          qualification_decision: 'needs_more_research',
          rationale: 'UNIQUE_SECOND_QUAL_RATIONALE',
          evidence_ids: [evidenceRefId],
        }),
      });
      ok('second qualification POST redirects', second.statusCode === 302);

      const detail2 = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok('latest shows needs_more_research after second', /needs_more_research/i.test(detail2.body));
      ok('history still includes first rationale (escaped)', /UNIQUE_XSS_RATIONALE|&lt;script&gt;/.test(detail2.body));
      ok('history includes second rationale', /UNIQUE_SECOND_QUAL_RATIONALE/.test(detail2.body));

      const invalid = await request(port, qualificationUrl, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeQualificationBody({
          qualification_decision: 'qualified',
          rationale: '',
          evidence_ids: [evidenceRefId],
        }),
      });
      ok(
        'invalid qualification redisplays with error',
        invalid.statusCode === 400
          || (invalid.statusCode === 200 && /rationale|required|evidence/i.test(invalid.body)),
        `status=${invalid.statusCode}`,
      );
    },
  ]);

  await runScenario('Authenticated operators can record qualification', BASE_PORT + 2, {
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
        body: 'business_name=Monshies+Qualification+Hostel',
      });
      const detailPath = String(created.headers.location || '');
      const prospectId = detailPath.split('/').pop();

      await request(port, `/sales/prospects/${prospectId}/evidence`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeEvidenceBody({
          source_label: 'Operator notes',
          source_url: 'https://monshies-qual.example',
          summary: 'Monshies evidence for qualification',
          factual_notes: 'Looks like a surf hostel',
          limitations: 'Manual only',
          confidence: 'medium',
        }),
      });

      const detailBefore = await request(port, detailPath, { headers: { Cookie: cookie } });
      const checkboxMatch = detailBefore.body.match(/name=["']evidence_ids["'][^>]*value=["']([^"']+)["']/i)
        || detailBefore.body.match(/value=["']([^"']+)["'][^>]*name=["']evidence_ids["']/i);
      const evidenceRefId = checkboxMatch ? checkboxMatch[1] : '';

      const posted = await request(port, `/sales/prospects/${prospectId}/qualification`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeQualificationBody({
          qualification_decision: 'not_qualified',
          rationale: 'Monshies recorded qualification UNIQUE_MONSHIES_QUAL',
          evidence_ids: [evidenceRefId],
        }),
      });
      ok('authenticated operator can POST qualification', posted.statusCode === 302, `status=${posted.statusCode}`);

      const detail = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok('operator qualification visible on detail', /UNIQUE_MONSHIES_QUAL/i.test(detail.body));
      ok('operator actor appears in audit', /monshies-op|Admin|actor=/i.test(detail.body));
    },
  ]);

  console.log(`\n── verify:crowsnest-sales-qualification: ${pass} passed, ${fail} failed ──`);
  if (fail === 0) {
    console.log('verify:crowsnest-sales-qualification — ALL CHECKS PASSED');
  }
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  await stopServer();
  console.error(err);
  process.exit(1);
});
