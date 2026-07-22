'use strict';

/**
 * Deterministic RED→GREEN verifier for Luna Sales Chapter 5: CRM sync preview
 * (HubSpot adapter boundary — preview only, no provider calls).
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
const MIGRATION_045_REL = 'database/migrations/045_luna_sales_crm_review.sql';
const MIGRATION_045_PATH = path.join(ROOT, MIGRATION_045_REL);
const MIGRATION_044_PATH = path.join(ROOT, 'database', 'migrations', '044_luna_sales_qualification.sql');
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'SALES-HUBSPOT-ADAPTER.md');
const PRODUCT_DOC = path.join(ROOT, 'docs', 'CROWSNEST.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const MANIFEST_PATH = path.join(ROOT, 'database', 'migrations', 'canonical-manifest.json');
const BASE_PORT = Number(process.env.CROWSNEST_VERIFY_SALES_HUBSPOT_ADAPTER_PORT) || 13360;

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
  console.log('\n▸ Structural: Chapter 5 CRM sync preview');
  const apiSrc = read(API_PATH) || '';
  const pageSrc = read(PAGE_PATH) || '';
  const salesSrc = read(SALES_PATH) || '';
  const storeSrc = read(STORE_PATH) || '';
  const mig045 = read(MIGRATION_045_PATH) || '';
  const docSrc = read(DOC_PATH) || '';
  const productSrc = read(PRODUCT_DOC) || '';

  ok('crowsnest-sales.js exists', fs.existsSync(SALES_PATH));
  ok('sales exports buildCrmSyncPreview', /buildCrmSyncPreview/.test(salesSrc));
  ok('sales exports markReadyForCrmReview', /markReadyForCrmReview/.test(salesSrc));
  ok('sales exports getCrmSyncPreview', /getCrmSyncPreview/.test(salesSrc));
  ok('accepted mapping Lead + Luna Sales Status', /Lead/.test(salesSrc) && /Luna Sales Status/.test(salesSrc) && /Qualified Prospect/.test(salesSrc));
  ok('preview explicitly has no Deal', /deal:\s*null|No Deal/i.test(salesSrc) || /deal:\s*null/.test(salesSrc));
  ok('store supports crm review marks', /crm_review|saveCrmReviewMark|listCrmReviewMarks/i.test(storeSrc));
  ok('router allowlists crm-preview path', /\/sales\/prospects\/.+\/crm-preview|matchSalesCrmPreviewPath/.test(apiSrc));
  ok('router allowlists crm-ready path', /\/sales\/prospects\/.+\/crm-ready|matchSalesCrmReadyPath/.test(apiSrc));
  ok('detail/preview pages mention preview only', /preview only|no CRM record has been sent/i.test(pageSrc));
  ok('page escapes CRM preview fields', /escapeHtml/.test(pageSrc));
  ok('review queue filter includes crm_ready', /crm_ready/.test(salesSrc) && /crm_ready/.test(pageSrc));
  ok(
    'no HubSpot SDK/HTTP/env keys in sales modules',
    !/require\(['"][^'"]*hubspot/i.test(salesSrc)
      && !/require\(['"][^'"]*hubspot/i.test(storeSrc)
      && !/HUBSPOT_[A-Z0-9_]+/.test(salesSrc)
      && !/HUBSPOT_[A-Z0-9_]+/.test(storeSrc)
      && !/api\.hubapi\.com|api\.hubspot\.com/i.test(salesSrc),
  );
  ok(
    'no automatic CRM write / outreach claims',
    !/sync to hubspot completed|hubspot write completed|outreach send completed|automatic CRM sync ran/i.test(pageSrc),
  );
  ok('migration 045 exists (crm review marks)', fs.existsSync(MIGRATION_045_PATH));
  ok(
    'migration 045 creates crm_review_marks',
    /crm_review_marks/i.test(mig045) && /CREATE\s+TABLE/i.test(mig045),
  );
  ok(
    'migration 045 links qualification_assessment_id',
    /qualification_assessment_id/i.test(mig045),
  );
  ok('hubspot adapter doc exists', fs.existsSync(DOC_PATH));
  ok(
    'doc forbids live CRM writes / SDK / outreach',
    /preview only|no CRM|no HubSpot SDK|no automatic|no outreach/i.test(docSrc),
  );
  ok('product doc mentions Chapter 5 CRM preview', /Chapter 5|CRM sync preview|HubSpot adapter/i.test(productSrc));

  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  } catch {
    pkg = null;
  }
  ok(
    'package.json has verify:crowsnest-sales-hubspot-adapter',
    pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-sales-hubspot-adapter'] === 'string',
  );

  let manifest = null;
  try {
    manifest = loadManifest();
  } catch (err) {
    manifest = null;
    ok('canonical manifest loads', false, String(err && err.message));
  }
  if (manifest) {
    const entry = manifest.entries.find((e) => e.filename === '045_luna_sales_crm_review.sql');
    ok('manifest includes 045_luna_sales_crm_review.sql', Boolean(entry));
    ok('045 is canonical_forward', entry && entry.classification === 'canonical_forward' && entry.inForwardChain === true);
    ok('045 order is 43', entry && entry.order === 43);
    if (entry && fs.existsSync(MIGRATION_045_PATH)) {
      const live = sha256CanonicalLfV1File(MIGRATION_045_PATH);
      ok('045 sha256 matches live file', entry.sha256 === live, `manifest=${entry.sha256} live=${live}`);
    }
    const forwards = forwardEntries(manifest);
    ok('forward count includes 045 (43)', forwards.length === 43, `forward=${forwards.length}`);
  }

  ok('044 qualification retained as dependency', fs.existsSync(MIGRATION_044_PATH) && /qualification_assessments/i.test(read(MIGRATION_044_PATH) || ''));
}

async function domainValidationChecks() {
  console.log('\n▸ CRM preview mapping + qualified guard (domain)');
  delete require.cache[require.resolve(SALES_PATH)];
  delete require.cache[require.resolve(STORE_PATH)];
  const sales = require(SALES_PATH);
  const store = require(STORE_PATH);

  ok('buildCrmSyncPreview is a function', typeof sales.buildCrmSyncPreview === 'function');
  ok('markReadyForCrmReview is a function', typeof sales.markReadyForCrmReview === 'function');

  const prospect = {
    id: '11111111-1111-4111-8111-111111111111',
    canonical_name: 'Somo Surf House',
    website_url: 'https://www.somo-surf.example/stay',
  };
  const qualification = {
    id: '22222222-2222-4222-8222-222222222222',
    decision: 'qualified',
    rationale: 'Fits Northern Spain hostel pilot',
    evidence_ids: ['33333333-3333-4333-8333-333333333333'],
    reviewer_id: 'Earthling',
    created_at: '2026-07-22T12:00:00.000Z',
  };

  const missingQual = sales.buildCrmSyncPreview({ prospect, qualification: null });
  ok('preview without qualification rejected', missingQual && missingQual.ok === false);

  const notQualified = sales.buildCrmSyncPreview({
    prospect,
    qualification: { ...qualification, decision: 'needs_more_research' },
  });
  ok('preview requires qualified decision', notQualified && notQualified.ok === false);

  const previewOk = sales.buildCrmSyncPreview({ prospect, qualification, contacts: [] });
  ok('qualified preview accepted', previewOk && previewOk.ok === true && previewOk.preview, JSON.stringify(previewOk));
  const preview = previewOk && previewOk.preview;
  ok('preview_only flag true', preview && preview.preview_only === true);
  ok('record_sent false', preview && preview.record_sent === false);
  ok('disclaimer says preview only / not sent', preview && /preview only|no CRM record has been sent/i.test(preview.disclaimer || ''));
  ok('one Company name mapped', preview && preview.company && preview.company.name === 'Somo Surf House');
  ok('Company lifecycle Lead', preview && preview.company && preview.company.lifecycle_stage === 'Lead');
  ok(
    'Company Luna Sales Status = Qualified Prospect',
    preview
      && preview.company
      && preview.company.properties
      && preview.company.properties['Luna Sales Status'] === 'Qualified Prospect',
  );
  ok('Company domain extracted', preview && preview.company && preview.company.domain === 'somo-surf.example');
  ok('Contacts array present (zero)', preview && Array.isArray(preview.contacts) && preview.contacts.length === 0);
  ok('Deal is null (no Deal)', preview && preview.deal === null);
  ok(
    'traceability preserves rationale + evidence',
    preview
      && preview.traceability
      && preview.traceability.rationale === qualification.rationale
      && Array.isArray(preview.traceability.evidence_ids)
      && preview.traceability.evidence_ids[0] === qualification.evidence_ids[0]
      && preview.traceability.qualification_assessment_id === qualification.id,
  );

  const withContacts = sales.buildCrmSyncPreview({
    prospect,
    qualification,
    contacts: [{ full_name: 'Ada Owner', email: 'ada@somo-surf.example', role: 'Owner' }],
  });
  ok(
    'optional Contacts mapped when provided',
    withContacts
      && withContacts.ok
      && withContacts.preview.contacts.length === 1
      && withContacts.preview.contacts[0].email === 'ada@somo-surf.example',
  );

  ok(
    'crm_ready bucket when marked + qualified',
    sales.assignReviewBucket({
      evidence_count: 1,
      latest_qualification_decision: 'qualified',
      crm_ready: true,
    }) === 'crm_ready',
  );
  ok(
    'qualified without mark stays qualified',
    sales.assignReviewBucket({
      evidence_count: 1,
      latest_qualification_decision: 'qualified',
      crm_ready: false,
    }) === 'qualified',
  );
  ok(
    'crm mark without qualified does not force crm_ready',
    sales.assignReviewBucket({
      evidence_count: 1,
      latest_qualification_decision: 'not_qualified',
      crm_ready: true,
    }) === 'not_qualified',
  );
  ok('review filter accepts crm_ready', sales.normalizeReviewQueueFilter('crm_ready') === 'crm_ready');

  const repo = store.createMemorySalesRepository();
  if (typeof sales._setSalesRepositoryForTests === 'function') {
    sales._setSalesRepositoryForTests(repo);
  }
  const created = await sales.createProspect({
    business_name: 'CRM Preview Hostel',
    website_url: 'https://crm-preview.example',
  }, 'Admin');
  ok('prospect created for CRM domain checks', created && created.ok === true);
  if (!(created && created.ok)) return;
  const prospectId = created.prospect.id;

  const evidence = await sales.recordManualEvidence(prospectId, {
    source_label: 'Website',
    source_url: 'https://crm-preview.example/about',
    summary: 'Surf hostel with dorm beds',
    factual_notes: 'Dorm capacity listed',
    limitations: 'Manual notes only',
    confidence: 'medium',
  }, 'Earthling');
  ok('manual evidence recorded', evidence && evidence.ok === true && evidence.research);
  const evidenceId = evidence.research.id;

  const blocked = await sales.markReadyForCrmReview(prospectId, 'Earthling');
  ok(
    'mark ready blocked before qualified',
    blocked && blocked.ok === false && (blocked.status === 400 || /qualified/i.test(blocked.error || '')),
    JSON.stringify(blocked),
  );

  const recorded = await sales.recordQualification(prospectId, {
    decision: 'qualified',
    rationale: 'Fits CRM preview pilot',
    evidence_ids: [evidenceId],
  }, 'Earthling');
  ok('qualification recorded as qualified', recorded && recorded.ok === true);

  const previewResult = await sales.getCrmSyncPreview(prospectId);
  ok('getCrmSyncPreview ok when qualified', previewResult && previewResult.ok === true, JSON.stringify(previewResult));
  ok(
    'getCrmSyncPreview mapping Lead + status',
    previewResult
      && previewResult.preview
      && previewResult.preview.company.lifecycle_stage === 'Lead'
      && previewResult.preview.company.properties['Luna Sales Status'] === 'Qualified Prospect'
      && previewResult.preview.deal === null
      && previewResult.preview.preview_only === true,
  );

  const marked = await sales.markReadyForCrmReview(prospectId, 'Earthling');
  ok('markReadyForCrmReview ok when qualified', marked && marked.ok === true && marked.mark, JSON.stringify(marked));
  ok(
    'mark links qualification assessment',
    marked
      && marked.mark
      && marked.mark.qualification_assessment_id === recorded.assessment.id,
  );

  const latestMark = await sales.getLatestCrmReviewMark(prospectId);
  ok('getLatestCrmReviewMark returns mark', latestMark && latestMark.id === marked.mark.id);

  const queue = await sales.listReviewQueue({ state: 'crm_ready' });
  ok('review queue crm_ready filter returns item', queue && queue.ok && queue.items.some((item) => item.id === prospectId && item.bucket === 'crm_ready'));

  const audits = await sales.listAuditEvents(prospectId);
  const crmAudits = audits.filter((e) => e.action === 'crm_review_ready_marked');
  ok('append-only audit for crm ready', crmAudits.length >= 1);
  ok('crm ready audit identifies operator', crmAudits.some((e) => e.actor === 'Earthling'));
  ok(
    'crm ready audit preserves evidence/reason traceability',
    crmAudits.some((e) => (
      e.detail
      && e.detail.prospect_id === prospectId
      && e.detail.qualification_assessment_id === recorded.assessment.id
      && Array.isArray(e.detail.evidence_ids)
      && e.detail.evidence_ids.includes(evidenceId)
      && /Fits CRM preview pilot/.test(e.detail.rationale || '')
    )),
  );

  const beforeLen = audits.length;
  const snapshot = audits.map((e) => ({ ...e, detail: e.detail ? { ...e.detail } : e.detail }));
  await sales.markReadyForCrmReview(prospectId, 'Monshies');
  const after = await sales.listAuditEvents(prospectId);
  ok('second mark appends audit (no overwrite)', after.length === beforeLen + 1);
  ok(
    'prior audit events remain intact (append-only)',
    snapshot.every((old, idx) => {
      const cur = after[idx];
      return cur && cur.id === old.id && cur.action === old.action && JSON.stringify(cur.detail) === JSON.stringify(old.detail);
    }),
  );

  await sales.recordQualification(prospectId, {
    decision: 'not_qualified',
    rationale: 'Changed mind',
    evidence_ids: [evidenceId],
  }, 'Admin');
  const afterNotQualified = await sales.markReadyForCrmReview(prospectId, 'Admin');
  ok(
    'mark ready rejected when latest is not qualified',
    afterNotQualified && afterNotQualified.ok === false && afterNotQualified.status === 400,
    JSON.stringify(afterNotQualified),
  );

  const missingProspect = await sales.markReadyForCrmReview('00000000-0000-4000-8000-000000000099', 'Admin');
  ok('missing prospect returns 404', missingProspect && missingProspect.ok === false && missingProspect.status === 404);

  console.log('\n▸ Production fail-closed for CRM ready / preview');
  const failRepo = await store.createSalesRepository({ NODE_ENV: 'production' });
  sales._setSalesRepositoryForTests(failRepo);
  const closed = await sales.markReadyForCrmReview(prospectId, 'Admin');
  ok(
    'production missing DSN rejects CRM ready write',
    closed && closed.ok === false && (closed.status === 503 || closed.code === 'sales_store_misconfigured'),
    JSON.stringify(closed),
  );
  ok(
    'fail-closed CRM ready error does not leak DSN/SQL',
    closed && !/postgres:\/\/|WOLFHOUSE|INSERT\s+INTO|password|HUBSPOT/i.test(JSON.stringify(closed)),
  );
  const closedPreview = await sales.getCrmSyncPreview(prospectId);
  ok(
    'production missing DSN rejects CRM preview read',
    closedPreview && closedPreview.ok === false && (closedPreview.status === 503 || closedPreview.code === 'sales_store_misconfigured'),
    JSON.stringify(closedPreview),
  );

  console.log('\n▸ Durable repository SQL for CRM review marks');
  const recordedSql = [];
  const pgRepo = store.createPgSalesRepository({
    query: async (sql, params) => {
      recordedSql.push({ sql: String(sql), params });
      if (/INSERT\s+INTO\s+luna_sales\.crm_review_marks/i.test(sql)) {
        return { rows: [] };
      }
      if (/FROM\s+luna_sales\.crm_review_marks/i.test(sql)) {
        return {
          rows: [{
            id: '44444444-4444-4444-8444-444444444444',
            prospect_id: prospectId,
            qualification_assessment_id: recorded.assessment.id,
            reviewer_id: 'Admin',
            created_at: new Date('2026-07-22T13:00:00.000Z'),
          }],
        };
      }
      if (/FROM\s+luna_sales\.prospects/i.test(sql) && /listReviewQueue|crm_review_marks|evidence_count/i.test(sql)) {
        return {
          rows: [{
            id: prospectId,
            canonical_name: 'CRM Preview Hostel',
            website_url: 'https://crm-preview.example',
            created_at: new Date('2026-07-22T10:00:00.000Z'),
            updated_at: new Date('2026-07-22T10:00:00.000Z'),
            evidence_count: 1,
            latest_qualification_decision: 'qualified',
            latest_qualification_at: new Date('2026-07-22T12:00:00.000Z'),
            latest_crm_review_mark_at: new Date('2026-07-22T13:00:00.000Z'),
            most_recent_activity: new Date('2026-07-22T13:00:00.000Z'),
          }],
        };
      }
      return { rows: [] };
    },
  });
  sales._setSalesRepositoryForTests(pgRepo);

  // Re-seed via direct save path expectations: markReady needs getProspect + getLatestQualification.
  // Use a memory repo overlay is hard; instead exercise saveCrmReviewMark SQL via repository API.
  const saveResult = await pgRepo.saveCrmReviewMark({
    id: '55555555-5555-4555-8555-555555555555',
    prospect_id: prospectId,
    qualification_assessment_id: recorded.assessment.id,
    reviewer_id: 'Admin',
    created_at: '2026-07-22T14:00:00.000Z',
  });
  ok('pg saveCrmReviewMark ok', saveResult && saveResult.ok === true);
  const insertSql = recordedSql.find((row) => /INSERT\s+INTO\s+luna_sales\.crm_review_marks/i.test(row.sql));
  ok('CRM mark SQL qualifies luna_sales', Boolean(insertSql) && /luna_sales\.crm_review_marks/i.test(insertSql.sql));
  ok(
    'CRM mark SQL is INSERT only (append)',
    Boolean(insertSql) && !/UPDATE|DELETE/i.test(insertSql.sql),
  );

  const failingPg = store.createPgSalesRepository({
    query: async () => {
      throw new Error('simulated outage');
    },
  });
  const saveFail = await failingPg.saveCrmReviewMark({
    id: '66666666-6666-4666-8666-666666666666',
    prospect_id: prospectId,
    qualification_assessment_id: recorded.assessment.id,
    reviewer_id: 'Admin',
    created_at: '2026-07-22T14:00:00.000Z',
  });
  ok(
    'pg CRM mark failure returns safe sales_unavailable',
    saveFail && saveFail.ok === false && saveFail.code === 'sales_unavailable' && saveFail.status === 503,
  );
  ok(
    'pg CRM mark failure does not leak secrets/SQL',
    saveFail && !/postgres:\/\/|password|INSERT\s+INTO|HUBSPOT/i.test(JSON.stringify(saveFail)),
  );

  sales._setSalesRepositoryForTests(null);
}

async function main() {
  console.log('verify:crowsnest-sales-hubspot-adapter — Luna Sales Chapter 5\n');
  structuralChecks();
  await domainValidationChecks();

  await runScenario('Protected CRM preview + 405 unsafe methods', BASE_PORT, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_EARTHLING_USERNAME: 'earthling-op',
    CROWSNEST_AUTH_EARTHLING_PASSWORD: 'earth-pass',
    CROWSNEST_AUTH_MONSHIES_USERNAME: 'monshies-op',
    CROWSNEST_AUTH_MONSHIES_PASSWORD: 'mon-pass',
  }, [
    async (port) => {
      const unauthPreview = await request(port, '/sales/prospects/00000000-0000-4000-8000-000000000001/crm-preview');
      ok(
        'unauthenticated GET crm-preview redirects to /login',
        unauthPreview.statusCode === 302 && String(unauthPreview.headers.location || '').includes('/login'),
        `status=${unauthPreview.statusCode} loc=${unauthPreview.headers.location}`,
      );

      const unauthReady = await request(port, '/sales/prospects/00000000-0000-4000-8000-000000000001/crm-ready', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      ok(
        'unauthenticated POST crm-ready redirects to /login',
        unauthReady.statusCode === 302 && String(unauthReady.headers.location || '').includes('/login'),
        `status=${unauthReady.statusCode}`,
      );

      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=earthling-op&password=earth-pass',
      });
      const cookie = extractCookiePair(login.headers['set-cookie']);
      ok('login cookie for CRM preview', /crowsnest_session=/.test(cookie));

      const created = await request(port, '/sales/prospects', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'business_name=CRM+HTTP+Hostel&website_url=https%3A%2F%2Fcrm-http.example',
      });
      const detailPath = String(created.headers.location || '');
      ok('created prospect for CRM HTTP checks', created.statusCode === 302 && detailPath.startsWith('/sales/prospects/'));
      const prospectId = detailPath.split('/').pop();
      const previewPath = `/sales/prospects/${prospectId}/crm-preview`;
      const readyPath = `/sales/prospects/${prospectId}/crm-ready`;

      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, previewPath, method, { Cookie: cookie }, 'GET, HEAD');
      }
      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, readyPath, method, { Cookie: cookie }, 'POST');
      }

      await request(port, `/sales/prospects/${prospectId}/evidence`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeEvidenceBody({
          source_label: 'Website',
          source_url: 'https://crm-http.example/about',
          summary: 'UNIQUE_CRM_EVIDENCE_SUMMARY',
          factual_notes: 'Has dorm beds',
          limitations: 'Manual only',
          confidence: 'high',
        }),
      });

      const detailBefore = await request(port, detailPath, { headers: { Cookie: cookie } });
      const checkboxMatch = detailBefore.body.match(/name=["']evidence_ids["'][^>]*value=["']([^"']+)["']/i)
        || detailBefore.body.match(/value=["']([^"']+)["'][^>]*name=["']evidence_ids["']/i);
      const evidenceRefId = checkboxMatch ? checkboxMatch[1] : '';
      ok('evidence checkbox available', Boolean(evidenceRefId));

      const readyTooEarly = await request(port, readyPath, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      ok(
        'mark ready before qualified returns error',
        readyTooEarly.statusCode === 400
          || (readyTooEarly.statusCode === 200 && /qualified/i.test(readyTooEarly.body)),
        `status=${readyTooEarly.statusCode}`,
      );

      const previewTooEarly = await request(port, previewPath, { headers: { Cookie: cookie } });
      ok(
        'CRM preview before qualified blocked',
        previewTooEarly.statusCode === 400
          || (previewTooEarly.statusCode === 200 && /qualified|CRM preview/i.test(previewTooEarly.body)),
        `status=${previewTooEarly.statusCode}`,
      );

      const xssRationale = '<script>alert("crm")</script> UNIQUE_CRM_XSS_RATIONALE';
      await request(port, `/sales/prospects/${prospectId}/qualification`, {
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

      const detailQualified = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok('detail shows CRM preview section when qualified', /CRM sync preview|Open CRM sync preview|Mark ready for CRM review/i.test(detailQualified.body));
      ok('detail has CRM preview link', detailQualified.body.includes(previewPath));

      const preview = await request(port, previewPath, { headers: { Cookie: cookie } });
      ok('GET crm-preview => 200', preview.statusCode === 200, `got ${preview.statusCode}`);
      ok('preview heading present', /CRM sync preview/i.test(preview.body));
      ok('preview says preview only / not sent', /preview only|no CRM record has been sent/i.test(preview.body));
      ok('preview shows Company', /Company/i.test(preview.body) && /CRM HTTP Hostel|crm-http\.example/i.test(preview.body));
      ok('preview shows lifecycle Lead', /Lead/.test(preview.body));
      ok('preview shows Luna Sales Status Qualified Prospect', /Luna Sales Status/i.test(preview.body) && /Qualified Prospect/i.test(preview.body));
      ok('preview states no Deal', /No Deal|no Deal/i.test(preview.body));
      ok('preview shows Contacts zero-or-more', /Contacts/i.test(preview.body));
      ok('script tags escaped on preview', !/<script>alert\("crm"\)<\/script>/.test(preview.body));
      ok('escaped rationale entities on preview', /&lt;script&gt;/.test(preview.body) || /UNIQUE_CRM_XSS_RATIONALE/.test(preview.body));
      ok(
        'no live HubSpot write claims on preview',
        !/hubspot sync completed|sync to hubspot completed|record has been sent to HubSpot|outreach send completed/i.test(preview.body),
      );

      const marked = await request(port, readyPath, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      ok(
        'mark ready redirects to preview',
        marked.statusCode === 302 && String(marked.headers.location || '') === previewPath,
        `status=${marked.statusCode} loc=${marked.headers.location}`,
      );

      const detailAfter = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok('audit shows crm_review_ready_marked', /crm_review_ready_marked/i.test(detailAfter.body));
      ok('detail shows ready mark status', /Marked ready for CRM review|ready for CRM review/i.test(detailAfter.body));

      const queue = await request(port, '/sales/review?state=crm_ready', { headers: { Cookie: cookie } });
      ok('crm_ready filter returns 200', queue.statusCode === 200);
      ok('crm_ready queue includes prospect', queue.body.includes(detailPath) || queue.body.includes(prospectId));
      ok('crm_ready bucket label visible', /Ready for CRM review/i.test(queue.body));
    },
  ]);

  console.log(`\n── verify:crowsnest-sales-hubspot-adapter: ${pass} passed, ${fail} failed ──`);
  if (fail) {
    console.log('verify:crowsnest-sales-hubspot-adapter — FAILED');
    process.exitCode = 1;
    return;
  }
  console.log('verify:crowsnest-sales-hubspot-adapter — ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => stopServer());
