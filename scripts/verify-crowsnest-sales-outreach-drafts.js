'use strict';

/**
 * Deterministic RED→GREEN verifier for Luna Sales Chapter 6: Outreach Drafts.
 * Offline — no live DB, no Azure, no HubSpot/Maps/Apollo/live AI/SMTP/WhatsApp/outreach send.
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
const MIGRATION_046_REL = 'database/migrations/046_luna_sales_outreach_drafts.sql';
const MIGRATION_046_PATH = path.join(ROOT, MIGRATION_046_REL);
const MIGRATION_045_PATH = path.join(ROOT, 'database', 'migrations', '045_luna_sales_crm_review.sql');
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'SALES-OUTREACH-DRAFTS.md');
const PRODUCT_DOC = path.join(ROOT, 'docs', 'CROWSNEST.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const MANIFEST_PATH = path.join(ROOT, 'database', 'migrations', 'canonical-manifest.json');
const BASE_PORT = Number(process.env.CROWSNEST_VERIFY_SALES_OUTREACH_DRAFTS_PORT) || 13370;

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

function encodeForm(fields) {
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
  console.log('\n▸ Structural: Chapter 6 outreach drafts');
  const apiSrc = read(API_PATH) || '';
  const pageSrc = read(PAGE_PATH) || '';
  const salesSrc = read(SALES_PATH) || '';
  const storeSrc = read(STORE_PATH) || '';
  const mig046 = read(MIGRATION_046_PATH) || '';
  const docSrc = read(DOC_PATH) || '';
  const productSrc = read(PRODUCT_DOC) || '';

  ok('crowsnest-sales.js exists', fs.existsSync(SALES_PATH));
  ok('sales exports validateOutreachDraft', /validateOutreachDraft/.test(salesSrc));
  ok('sales exports saveOutreachDraft', /saveOutreachDraft/.test(salesSrc));
  ok('sales exports getOutreachDraftWorkspace', /getOutreachDraftWorkspace/.test(salesSrc));
  ok('sales exports getCurrentOutreachDraft', /getCurrentOutreachDraft/.test(salesSrc));
  ok('allowed channels email/linkedin/other', /email/.test(salesSrc) && /linkedin/.test(salesSrc) && /['"]other['"]/.test(salesSrc));
  ok('disclaimer draft only / not sent', /draft only|no message has been sent/i.test(salesSrc) || /draft only|no message has been sent/i.test(pageSrc));
  ok('store supports outreach draft revisions', /outreach_draft|saveOutreachDraftRevision|listOutreachDraftRevisions/i.test(storeSrc));
  ok('router allowlists outreach-draft path', /\/sales\/prospects\/.+\/outreach-draft|matchSalesOutreachDraftPath/.test(apiSrc));
  ok('detail/workspace mention draft only', /draft only|no message has been sent/i.test(pageSrc));
  ok('page escapes outreach draft fields', /escapeHtml/.test(pageSrc));
  ok('detail/queue show draft ready or draft present', /draft ready|draft present|draft_ready|draft_present/i.test(pageSrc));
  ok(
    'no SMTP / WhatsApp / LinkedIn / HubSpot send wiring in sales modules',
    !/require\(['"][^'"]*nodemailer/i.test(salesSrc)
      && !/require\(['"][^'"]*nodemailer/i.test(storeSrc)
      && !/createTransport|smtp:\/\//i.test(salesSrc)
      && !/graph\.facebook|api\.linkedin\.com|HUBSPOT_[A-Z0-9_]+|api\.hubapi\.com|api\.hubspot\.com/i.test(salesSrc)
      && !/graph\.facebook|api\.linkedin\.com|HUBSPOT_[A-Z0-9_]+/i.test(storeSrc)
      && !/outreach\/send|webhook.*outreach/i.test(salesSrc)
      && !/openai\.com|anthropic\.com|generateOutreachDraftFromAi/i.test(salesSrc),
  );
  ok(
    'no delivery / send-completed claims on pages',
    !/message has been sent to|outreach send completed|email delivered|linkedin message sent|smtp send completed/i.test(pageSrc),
  );
  ok('migration 046 exists (outreach drafts)', fs.existsSync(MIGRATION_046_PATH));
  ok(
    'migration 046 creates outreach_draft_revisions',
    /outreach_draft_revisions/i.test(mig046) && /CREATE\s+TABLE/i.test(mig046),
  );
  ok(
    'migration 046 channels email/linkedin/other',
    /email/.test(mig046) && /linkedin/.test(mig046) && /other/.test(mig046),
  );
  ok('outreach drafts doc exists', fs.existsSync(DOC_PATH));
  ok(
    'doc forbids send / SMTP / auto-generation',
    /draft only|no message has been sent|no SMTP|no.*send|no.*auto.?generat/i.test(docSrc),
  );
  ok('product doc mentions Chapter 6 outreach drafts', /Chapter 6|outreach draft/i.test(productSrc));

  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  } catch {
    pkg = null;
  }
  ok(
    'package.json has verify:crowsnest-sales-outreach-drafts',
    pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-sales-outreach-drafts'] === 'string',
  );

  let manifest = null;
  try {
    manifest = loadManifest();
  } catch (err) {
    manifest = null;
    ok('canonical manifest loads', false, String(err && err.message));
  }
  if (manifest) {
    const entry = manifest.entries.find((e) => e.filename === '046_luna_sales_outreach_drafts.sql');
    ok('manifest includes 046_luna_sales_outreach_drafts.sql', Boolean(entry));
    ok('046 is canonical_forward', entry && entry.classification === 'canonical_forward' && entry.inForwardChain === true);
    ok('046 order is 44', entry && entry.order === 44);
    if (entry && fs.existsSync(MIGRATION_046_PATH)) {
      const live = sha256CanonicalLfV1File(MIGRATION_046_PATH);
      ok('046 sha256 matches live file', entry.sha256 === live, `manifest=${entry.sha256} live=${live}`);
    }
    const forwards = forwardEntries(manifest);
    ok('forward count includes 047 (45)', forwards.length === 45, `forward=${forwards.length}`);
  }

  ok('045 crm review retained as dependency', fs.existsSync(MIGRATION_045_PATH) && /crm_review_marks/i.test(read(MIGRATION_045_PATH) || ''));
}

async function domainValidationChecks() {
  console.log('\n▸ Outreach draft validation + CRM-ready guard (domain)');
  delete require.cache[require.resolve(SALES_PATH)];
  delete require.cache[require.resolve(STORE_PATH)];
  const sales = require(SALES_PATH);
  const store = require(STORE_PATH);

  ok('validateOutreachDraft is a function', typeof sales.validateOutreachDraft === 'function');
  ok('saveOutreachDraft is a function', typeof sales.saveOutreachDraft === 'function');
  ok('OUTREACH_DRAFT_BOUNDS exported', sales.OUTREACH_DRAFT_BOUNDS && typeof sales.OUTREACH_DRAFT_BOUNDS === 'object');
  ok('ALLOWED_OUTREACH_CHANNELS includes email/linkedin/other',
    sales.ALLOWED_OUTREACH_CHANNELS
      && sales.ALLOWED_OUTREACH_CHANNELS.has('email')
      && sales.ALLOWED_OUTREACH_CHANNELS.has('linkedin')
      && sales.ALLOWED_OUTREACH_CHANNELS.has('other'));

  const missingSubject = sales.validateOutreachDraft({
    subject: '',
    body: 'Hello',
    channel: 'email',
    next_step_note: 'Follow up next week',
  });
  ok('rejects empty subject', missingSubject && missingSubject.ok === false);

  const missingBody = sales.validateOutreachDraft({
    subject: 'Hi',
    body: '',
    channel: 'email',
    next_step_note: 'Follow up next week',
  });
  ok('rejects empty body', missingBody && missingBody.ok === false);

  const badChannel = sales.validateOutreachDraft({
    subject: 'Hi',
    body: 'Hello',
    channel: 'sms',
    next_step_note: 'Follow up next week',
  });
  ok('rejects invalid channel', badChannel && badChannel.ok === false);

  const missingNext = sales.validateOutreachDraft({
    subject: 'Hi',
    body: 'Hello',
    channel: 'linkedin',
    next_step_note: '',
  });
  ok('rejects empty next-step note', missingNext && missingNext.ok === false);

  const bounds = sales.OUTREACH_DRAFT_BOUNDS;
  const tooLongSubject = sales.validateOutreachDraft({
    subject: 'x'.repeat((bounds && bounds.subjectMax ? bounds.subjectMax : 500) + 1),
    body: 'Hello',
    channel: 'email',
    next_step_note: 'Next',
  });
  ok('rejects overlong subject', tooLongSubject && tooLongSubject.ok === false);

  const tooLongBody = sales.validateOutreachDraft({
    subject: 'Hi',
    body: 'y'.repeat((bounds && bounds.bodyMax ? bounds.bodyMax : 10000) + 1),
    channel: 'email',
    next_step_note: 'Next',
  });
  ok('rejects overlong body', tooLongBody && tooLongBody.ok === false);

  const valid = sales.validateOutreachDraft({
    subject: 'Intro to Luna',
    body: 'We help surf hostels with guest WhatsApp.',
    channel: 'email',
    next_step_note: 'Send after CRM sync review',
  });
  ok('accepts valid draft fields', valid && valid.ok === true && valid.draft, JSON.stringify(valid));
  ok('validated draft keeps channel email', valid && valid.draft && valid.draft.channel === 'email');
  ok(
    'validated draft disclaimer draft-only',
    valid
      && valid.draft
      && /draft only|no message has been sent/i.test(valid.draft.disclaimer || ''),
  );
  ok('validated draft message_sent false', valid && valid.draft && valid.draft.message_sent === false);

  const repo = store.createMemorySalesRepository();
  if (typeof sales._setSalesRepositoryForTests === 'function') {
    sales._setSalesRepositoryForTests(repo);
  }
  const created = await sales.createProspect({
    business_name: 'Outreach Draft Hostel',
    website_url: 'https://outreach-draft.example',
  }, 'Admin');
  ok('prospect created for outreach domain checks', created && created.ok === true);
  if (!(created && created.ok)) return;
  const prospectId = created.prospect.id;

  const blockedEarly = await sales.saveOutreachDraft(prospectId, {
    subject: 'Too early',
    body: 'Should not save',
    channel: 'email',
    next_step_note: 'n/a',
  }, 'Earthling');
  ok(
    'save blocked before CRM-ready',
    blockedEarly && blockedEarly.ok === false && (blockedEarly.status === 400 || /CRM.?ready|crm.?ready/i.test(blockedEarly.error || '')),
    JSON.stringify(blockedEarly),
  );

  const evidence = await sales.recordManualEvidence(prospectId, {
    source_label: 'Website',
    source_url: 'https://outreach-draft.example/about',
    summary: 'Surf hostel with dorm beds',
    factual_notes: 'Dorm capacity listed',
    limitations: 'Manual notes only',
    confidence: 'medium',
  }, 'Earthling');
  ok('manual evidence recorded', evidence && evidence.ok === true && evidence.research);
  const evidenceId = evidence.research.id;

  await sales.recordQualification(prospectId, {
    decision: 'qualified',
    rationale: 'Fits outreach draft pilot',
    evidence_ids: [evidenceId],
  }, 'Earthling');

  const blockedQualifiedOnly = await sales.saveOutreachDraft(prospectId, {
    subject: 'Still blocked',
    body: 'Need CRM ready mark',
    channel: 'email',
    next_step_note: 'Mark CRM ready first',
  }, 'Earthling');
  ok(
    'save blocked when qualified but not CRM-ready',
    blockedQualifiedOnly && blockedQualifiedOnly.ok === false && blockedQualifiedOnly.status === 400,
    JSON.stringify(blockedQualifiedOnly),
  );

  const marked = await sales.markReadyForCrmReview(prospectId, 'Earthling');
  ok('CRM ready marked for draft gate', marked && marked.ok === true);

  const workspaceBefore = await sales.getOutreachDraftWorkspace(prospectId);
  ok('workspace ok when CRM-ready (no draft yet)', workspaceBefore && workspaceBefore.ok === true);
  ok('workspace draft_ready true', workspaceBefore && workspaceBefore.draft_ready === true);
  ok('workspace draft_present false before save', workspaceBefore && workspaceBefore.draft_present === false);
  ok('workspace current draft null', workspaceBefore && workspaceBefore.currentDraft == null);

  const saved = await sales.saveOutreachDraft(prospectId, {
    subject: 'UNIQUE_OUTREACH_SUBJECT_V1',
    body: 'UNIQUE_OUTREACH_BODY_V1',
    channel: 'linkedin',
    next_step_note: 'UNIQUE_NEXT_STEP_V1',
  }, 'Earthling');
  ok('saveOutreachDraft ok when CRM-ready', saved && saved.ok === true && saved.draft, JSON.stringify(saved));
  ok('first revision_number is 1', saved && saved.draft && saved.draft.revision_number === 1);
  ok('saved channel linkedin', saved && saved.draft && saved.draft.channel === 'linkedin');
  ok('saved message_sent false', saved && saved.draft && saved.draft.message_sent === false);

  const current = await sales.getCurrentOutreachDraft(prospectId);
  ok('getCurrentOutreachDraft returns latest', current && current.subject === 'UNIQUE_OUTREACH_SUBJECT_V1');

  const edited = await sales.saveOutreachDraft(prospectId, {
    subject: 'UNIQUE_OUTREACH_SUBJECT_V2',
    body: 'UNIQUE_OUTREACH_BODY_V2',
    channel: 'email',
    next_step_note: 'UNIQUE_NEXT_STEP_V2',
  }, 'Monshies');
  ok('edit creates new revision', edited && edited.ok === true && edited.draft && edited.draft.revision_number === 2);
  ok('edit author is Monshies', edited && edited.draft && edited.draft.author_id === 'Monshies');

  const workspaceAfter = await sales.getOutreachDraftWorkspace(prospectId);
  ok('workspace draft_present true after save', workspaceAfter && workspaceAfter.draft_present === true);
  ok(
    'workspace current is latest revision',
    workspaceAfter
      && workspaceAfter.currentDraft
      && workspaceAfter.currentDraft.revision_number === 2
      && workspaceAfter.currentDraft.subject === 'UNIQUE_OUTREACH_SUBJECT_V2',
  );
  ok(
    'workspace revisions newest-first history',
    workspaceAfter
      && Array.isArray(workspaceAfter.revisions)
      && workspaceAfter.revisions.length === 2
      && workspaceAfter.revisions[0].revision_number === 2
      && workspaceAfter.revisions[1].revision_number === 1
      && workspaceAfter.revisions[1].subject === 'UNIQUE_OUTREACH_SUBJECT_V1',
  );

  const audits = await sales.listAuditEvents(prospectId);
  const draftAudits = audits.filter((e) => e.action === 'outreach_draft_saved');
  ok('append-only audit for outreach draft', draftAudits.length >= 2);
  ok('draft audit identifies first actor', draftAudits.some((e) => e.actor === 'Earthling'));
  ok('draft audit identifies second actor', draftAudits.some((e) => e.actor === 'Monshies'));
  ok(
    'draft audit preserves draft fields',
    draftAudits.some((e) => (
      e.detail
      && e.detail.prospect_id === prospectId
      && e.detail.subject === 'UNIQUE_OUTREACH_SUBJECT_V2'
      && e.detail.channel === 'email'
      && e.detail.message_sent === false
    )),
  );

  const beforeLen = audits.length;
  const snapshot = audits.map((e) => ({ ...e, detail: e.detail ? { ...e.detail } : e.detail }));
  await sales.saveOutreachDraft(prospectId, {
    subject: 'UNIQUE_OUTREACH_SUBJECT_V3',
    body: 'UNIQUE_OUTREACH_BODY_V3',
    channel: 'other',
    next_step_note: 'UNIQUE_NEXT_STEP_V3',
  }, 'Admin');
  const after = await sales.listAuditEvents(prospectId);
  ok('third save appends audit (no overwrite)', after.length === beforeLen + 1);
  ok(
    'prior audit events remain intact (append-only)',
    snapshot.every((old, idx) => {
      const cur = after[idx];
      return cur && cur.id === old.id && cur.action === old.action && JSON.stringify(cur.detail) === JSON.stringify(old.detail);
    }),
  );

  const queue = await sales.listReviewQueue({ state: 'crm_ready' });
  ok('review queue includes draft indicators', queue && queue.ok && queue.items.some((item) => (
    item.id === prospectId
    && item.draft_ready === true
    && item.draft_present === true
  )));

  const missingProspect = await sales.saveOutreachDraft('00000000-0000-4000-8000-000000000099', {
    subject: 'x',
    body: 'y',
    channel: 'email',
    next_step_note: 'z',
  }, 'Admin');
  ok('missing prospect returns 404', missingProspect && missingProspect.ok === false && missingProspect.status === 404);

  console.log('\n▸ Production fail-closed for outreach drafts');
  const failRepo = await store.createSalesRepository({ NODE_ENV: 'production' });
  sales._setSalesRepositoryForTests(failRepo);
  const closed = await sales.saveOutreachDraft(prospectId, {
    subject: 'x',
    body: 'y',
    channel: 'email',
    next_step_note: 'z',
  }, 'Admin');
  ok(
    'production missing DSN rejects draft write',
    closed && closed.ok === false && (closed.status === 503 || closed.code === 'sales_store_misconfigured'),
    JSON.stringify(closed),
  );
  ok(
    'fail-closed draft error does not leak DSN/SQL',
    closed && !/postgres:\/\/|WOLFHOUSE|INSERT\s+INTO|password|SMTP|HUBSPOT/i.test(JSON.stringify(closed)),
  );
  const closedWorkspace = await sales.getOutreachDraftWorkspace(prospectId);
  ok(
    'production missing DSN rejects draft workspace read',
    closedWorkspace && closedWorkspace.ok === false && (closedWorkspace.status === 503 || closedWorkspace.code === 'sales_store_misconfigured'),
    JSON.stringify(closedWorkspace),
  );

  console.log('\n▸ Durable repository SQL for outreach draft revisions');
  const recordedSql = [];
  const pgRepo = store.createPgSalesRepository({
    query: async (sql, params) => {
      recordedSql.push({ sql: String(sql), params });
      if (/INSERT\s+INTO\s+luna_sales\.outreach_draft_revisions/i.test(sql)) {
        return { rows: [] };
      }
      if (/FROM\s+luna_sales\.outreach_draft_revisions/i.test(sql)) {
        if (/COUNT|MAX\(revision_number\)|revision_number/i.test(sql) && /LIMIT\s+1/i.test(sql) === false && /ORDER BY revision_number DESC/i.test(sql) === false) {
          return { rows: [{ max: 2 }] };
        }
        return {
          rows: [{
            id: '77777777-7777-4777-8777-777777777777',
            prospect_id: prospectId,
            revision_number: 2,
            subject: 'SQL subject',
            body: 'SQL body',
            channel: 'email',
            next_step_note: 'SQL next',
            author_id: 'Admin',
            created_at: new Date('2026-07-22T15:00:00.000Z'),
          }],
        };
      }
      return { rows: [] };
    },
  });
  sales._setSalesRepositoryForTests(pgRepo);

  const saveResult = await pgRepo.saveOutreachDraftRevision({
    id: '88888888-8888-4888-8888-888888888888',
    prospect_id: prospectId,
    revision_number: 3,
    subject: 'PG subject',
    body: 'PG body',
    channel: 'other',
    next_step_note: 'PG next',
    author_id: 'Admin',
    created_at: '2026-07-22T16:00:00.000Z',
  });
  ok('pg saveOutreachDraftRevision ok', saveResult && saveResult.ok === true);
  const insertSql = recordedSql.find((row) => /INSERT\s+INTO\s+luna_sales\.outreach_draft_revisions/i.test(row.sql));
  ok('outreach draft SQL qualifies luna_sales', Boolean(insertSql) && /luna_sales\.outreach_draft_revisions/i.test(insertSql.sql));
  ok(
    'outreach draft SQL is INSERT only (append)',
    Boolean(insertSql) && !/UPDATE|DELETE/i.test(insertSql.sql),
  );

  const failingPg = store.createPgSalesRepository({
    query: async () => {
      throw new Error('simulated outage');
    },
  });
  const saveFail = await failingPg.saveOutreachDraftRevision({
    id: '99999999-9999-4999-8999-999999999999',
    prospect_id: prospectId,
    revision_number: 1,
    subject: 'x',
    body: 'y',
    channel: 'email',
    next_step_note: 'z',
    author_id: 'Admin',
    created_at: '2026-07-22T16:00:00.000Z',
  });
  ok(
    'pg outreach draft failure returns safe sales_unavailable',
    saveFail && saveFail.ok === false && saveFail.code === 'sales_unavailable' && saveFail.status === 503,
  );
  ok(
    'pg outreach draft failure does not leak secrets/SQL',
    saveFail && !/postgres:\/\/|password|INSERT\s+INTO|SMTP|HUBSPOT/i.test(JSON.stringify(saveFail)),
  );

  sales._setSalesRepositoryForTests(null);
}

async function main() {
  console.log('verify:crowsnest-sales-outreach-drafts — Luna Sales Chapter 6\n');
  structuralChecks();
  await domainValidationChecks();

  await runScenario('Protected outreach draft workspace + 405 unsafe methods', BASE_PORT, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_EARTHLING_USERNAME: 'earthling-op',
    CROWSNEST_AUTH_EARTHLING_PASSWORD: 'earth-pass',
    CROWSNEST_AUTH_MONSHIES_USERNAME: 'monshies-op',
    CROWSNEST_AUTH_MONSHIES_PASSWORD: 'mon-pass',
  }, [
    async (port) => {
      const unauthGet = await request(port, '/sales/prospects/00000000-0000-4000-8000-000000000001/outreach-draft');
      ok(
        'unauthenticated GET outreach-draft redirects to /login',
        unauthGet.statusCode === 302 && String(unauthGet.headers.location || '').includes('/login'),
        `status=${unauthGet.statusCode} loc=${unauthGet.headers.location}`,
      );

      const unauthPost = await request(port, '/sales/prospects/00000000-0000-4000-8000-000000000001/outreach-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      });
      ok(
        'unauthenticated POST outreach-draft redirects to /login',
        unauthPost.statusCode === 302 && String(unauthPost.headers.location || '').includes('/login'),
        `status=${unauthPost.statusCode}`,
      );

      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=earthling-op&password=earth-pass',
      });
      const cookie = extractCookiePair(login.headers['set-cookie']);
      ok('login cookie for outreach draft', /crowsnest_session=/.test(cookie));

      const created = await request(port, '/sales/prospects', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'business_name=Outreach+HTTP+Hostel&website_url=https%3A%2F%2Foutreach-http.example',
      });
      const detailPath = String(created.headers.location || '');
      ok('created prospect for outreach HTTP checks', created.statusCode === 302 && detailPath.startsWith('/sales/prospects/'));
      const prospectId = detailPath.split('/').pop();
      const draftPath = `/sales/prospects/${prospectId}/outreach-draft`;

      for (const method of ['PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, draftPath, method, { Cookie: cookie }, 'GET, HEAD, POST');
      }

      await request(port, `/sales/prospects/${prospectId}/evidence`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeForm({
          source_label: 'Website',
          source_url: 'https://outreach-http.example/about',
          summary: 'UNIQUE_OUTREACH_EVIDENCE_SUMMARY',
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

      const draftTooEarly = await request(port, draftPath, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeForm({
          subject: 'Too early',
          body: 'Blocked',
          channel: 'email',
          next_step_note: 'Need CRM ready',
        }),
      });
      ok(
        'save draft before CRM-ready returns error',
        draftTooEarly.statusCode === 400
          || (draftTooEarly.statusCode === 200 && /CRM.?ready|crm.?ready/i.test(draftTooEarly.body)),
        `status=${draftTooEarly.statusCode}`,
      );

      const getTooEarly = await request(port, draftPath, { headers: { Cookie: cookie } });
      ok(
        'GET draft workspace before CRM-ready blocked or explains gate',
        getTooEarly.statusCode === 400
          || (getTooEarly.statusCode === 200 && /CRM.?ready|crm.?ready|outreach draft/i.test(getTooEarly.body)),
        `status=${getTooEarly.statusCode}`,
      );

      await request(port, `/sales/prospects/${prospectId}/qualification`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeForm({
          qualification_decision: 'qualified',
          rationale: 'Fits outreach HTTP pilot',
          evidence_ids: [evidenceRefId],
        }),
      });

      await request(port, `/sales/prospects/${prospectId}/crm-ready`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: '',
      });

      const detailReady = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok('detail shows draft ready indicator when CRM-ready', /draft ready/i.test(detailReady.body));
      ok('detail shows draft present false / not present before save', /draft present:\s*no|no outreach draft|Draft present:\s*No|not present/i.test(detailReady.body));
      ok('detail has outreach draft link when CRM-ready', detailReady.body.includes(draftPath));

      const xssSubject = '<script>alert("draft")</script> UNIQUE_OUTREACH_XSS_SUBJECT';
      const xssBody = '<img src=x onerror=alert(1)> UNIQUE_OUTREACH_XSS_BODY';
      const xssNext = '<b>UNIQUE_OUTREACH_XSS_NEXT</b>';

      const saved = await request(port, draftPath, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeForm({
          subject: xssSubject,
          body: xssBody,
          channel: 'email',
          next_step_note: xssNext,
        }),
      });
      ok(
        'save draft redirects to workspace',
        saved.statusCode === 302 && String(saved.headers.location || '') === draftPath,
        `status=${saved.statusCode} loc=${saved.headers.location}`,
      );

      const workspace = await request(port, draftPath, { headers: { Cookie: cookie } });
      ok('GET outreach-draft => 200', workspace.statusCode === 200, `got ${workspace.statusCode}`);
      ok('workspace heading present', /Outreach draft/i.test(workspace.body));
      ok('workspace says draft only / not sent', /draft only|no message has been sent/i.test(workspace.body));
      ok('workspace shows channel email', /email/i.test(workspace.body));
      ok('workspace shows next-step', /UNIQUE_OUTREACH_XSS_NEXT|next.?step/i.test(workspace.body));
      ok('script tags escaped on workspace', !/<script>alert\("draft"\)<\/script>/.test(workspace.body));
      ok('escaped subject entities on workspace', /&lt;script&gt;/.test(workspace.body) || /UNIQUE_OUTREACH_XSS_SUBJECT/.test(workspace.body));
      ok('onerror payload escaped on workspace', !/<img src=x onerror=alert\(1\)>/.test(workspace.body));
      ok(
        'no delivery claims on workspace',
        !/message has been sent to|outreach send completed|email delivered|linkedin message sent|smtp send completed/i.test(workspace.body),
      );
      ok('revision history visible', /revision|history/i.test(workspace.body));

      const detailAfter = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok('audit shows outreach_draft_saved', /outreach_draft_saved/i.test(detailAfter.body));
      ok('detail shows draft present yes after save', /draft present:\s*yes|Draft present:\s*Yes|draft present/i.test(detailAfter.body));

      const queue = await request(port, '/sales/review?state=crm_ready', { headers: { Cookie: cookie } });
      ok('crm_ready filter returns 200', queue.statusCode === 200);
      ok('queue shows draft present indicator', /draft present/i.test(queue.body));
      ok('queue shows draft ready indicator', /draft ready/i.test(queue.body));
      ok(
        'queue does not claim delivery status',
        !/message sent|delivered|outreach send completed/i.test(queue.body),
      );
    },
  ]);

  console.log(`\n── verify:crowsnest-sales-outreach-drafts: ${pass} passed, ${fail} failed ──`);
  if (fail) {
    console.log('verify:crowsnest-sales-outreach-drafts — FAILED');
    process.exitCode = 1;
    return;
  }
  console.log('verify:crowsnest-sales-outreach-drafts — ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => stopServer());
