'use strict';

/**
 * Deterministic RED→GREEN verifier for Luna Sales Chapter 9: Contact Enrichment.
 * Manual contact records only — offline; no live DB, no Azure, no Apollo/auto-find/send.
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
const MIGRATION_047_REL = 'database/migrations/047_luna_sales_contact_candidates.sql';
const MIGRATION_047_PATH = path.join(ROOT, MIGRATION_047_REL);
const MIGRATION_046_PATH = path.join(ROOT, 'database', 'migrations', '046_luna_sales_outreach_drafts.sql');
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'SALES-CONTACT-ENRICHMENT.md');
const PRODUCT_DOC = path.join(ROOT, 'docs', 'CROWSNEST.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const MANIFEST_PATH = path.join(ROOT, 'database', 'migrations', 'canonical-manifest.json');
const BASE_PORT = Number(process.env.CROWSNEST_VERIFY_SALES_CONTACT_PORT) || 13290;

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

function encodeContactBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, value == null ? '' : String(value));
  }
  return params.toString();
}

function structuralChecks() {
  console.log('\n▸ Structural: Chapter 9 contact enrichment');
  const apiSrc = read(API_PATH) || '';
  const pageSrc = read(PAGE_PATH) || '';
  const salesSrc = read(SALES_PATH) || '';
  const storeSrc = read(STORE_PATH) || '';
  const mig047 = read(MIGRATION_047_PATH) || '';
  const docSrc = read(DOC_PATH) || '';
  const productSrc = read(PRODUCT_DOC) || '';

  ok('crowsnest-sales.js exists', fs.existsSync(SALES_PATH));
  ok('sales exports validateManualContact', /validateManualContact/.test(salesSrc));
  ok('sales exports recordManualContact', /recordManualContact/.test(salesSrc));
  ok('sales exports listContactCandidatesForProspect', /listContactCandidatesForProspect/.test(salesSrc));
  ok(
    'store lists contacts newest-first',
    /listContactCandidatesForProspect|contact_candidates/.test(storeSrc)
      && /ORDER BY created_at DESC/i.test(storeSrc),
  );
  ok('router allowlists contacts path', /\/sales\/prospects\/.+\/contacts|matchSalesContactsPath/.test(apiSrc));
  ok(
    'detail page has manual contact form',
    /contact/i.test(pageSrc)
      && /full_name|name=["']full_name["']/.test(pageSrc)
      && /linkedin_url|phone|confidence/i.test(pageSrc),
  );
  ok('page escapes contact fields', /escapeHtml/.test(pageSrc));
  ok(
    'no Apollo or Google SDK require in sales contact path',
    !/require\(['"][^'"]*(apollo|googleapis)/i.test(salesSrc)
      && !/api\.apollo\.io|APOLLO_[A-Z0-9_]+/i.test(storeSrc),
  );
  ok(
    'does not claim auto-find or send',
    !/apollo lookup completed|auto-find completed|contact message has been sent|crm contact created live/i.test(pageSrc),
  );
  ok('migration 047 exists (contact candidates)', fs.existsSync(MIGRATION_047_PATH));
  ok(
    'migration 047 creates contact_candidates',
    /contact_candidates/i.test(mig047) && /CREATE\s+TABLE/i.test(mig047),
  );
  ok('migration 047 includes confidence low/medium/high', /low/.test(mig047) && /medium/.test(mig047) && /high/.test(mig047));
  ok('migration 047 includes email/phone/linkedin columns', /email/i.test(mig047) && /phone/i.test(mig047) && /linkedin_url/i.test(mig047));
  ok('contact enrichment doc exists', fs.existsSync(DOC_PATH));
  ok(
    'doc forbids Apollo / auto-find / send',
    /no Apollo|manual|no auto.?find|no.*send|no CRM write/i.test(docSrc),
  );
  ok('product doc mentions Chapter 9 contact enrichment', /Chapter 9|Contact Enrichment|manual contact/i.test(productSrc));

  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  } catch {
    pkg = null;
  }
  ok(
    'package.json has verify:crowsnest-sales-contact-enrichment',
    pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-sales-contact-enrichment'] === 'string',
  );

  let manifest = null;
  try {
    manifest = loadManifest();
  } catch (err) {
    manifest = null;
    ok('canonical manifest loads', false, String(err && err.message));
  }
  if (manifest) {
    const entry = manifest.entries.find((e) => e.filename === '047_luna_sales_contact_candidates.sql');
    ok('manifest includes 047_luna_sales_contact_candidates.sql', Boolean(entry));
    ok('047 is canonical_forward', entry && entry.classification === 'canonical_forward' && entry.inForwardChain === true);
    ok('047 order is 45', entry && entry.order === 45);
    if (entry && fs.existsSync(MIGRATION_047_PATH)) {
      const live = sha256CanonicalLfV1File(MIGRATION_047_PATH);
      ok('047 sha256 matches live file', entry.sha256 === live, `manifest=${entry.sha256} live=${live}`);
    }
    const forwards = forwardEntries(manifest);
    ok('forward count includes 049 (47)', forwards.length === 47, `forward=${forwards.length}`);
  }

  ok(
    '046 outreach drafts retained as prior chapter',
    fs.existsSync(MIGRATION_046_PATH) && /outreach_draft_revisions/i.test(read(MIGRATION_046_PATH) || ''),
  );
}

async function domainValidationChecks() {
  console.log('\n▸ Manual contact validation (domain)');
  delete require.cache[require.resolve(SALES_PATH)];
  delete require.cache[require.resolve(STORE_PATH)];
  const sales = require(SALES_PATH);
  const store = require(STORE_PATH);

  ok('validateManualContact is a function', typeof sales.validateManualContact === 'function');
  ok('recordManualContact is a function', typeof sales.recordManualContact === 'function');
  ok('CONTACT_BOUNDS exported', sales.CONTACT_BOUNDS && typeof sales.CONTACT_BOUNDS === 'object');
  ok(
    'ALLOWED_CONTACT_CONFIDENCE includes low/medium/high',
    sales.ALLOWED_CONTACT_CONFIDENCE
      && sales.ALLOWED_CONTACT_CONFIDENCE.has('low')
      && sales.ALLOWED_CONTACT_CONFIDENCE.has('medium')
      && sales.ALLOWED_CONTACT_CONFIDENCE.has('high'),
  );

  if (typeof sales.validateManualContact !== 'function') return;

  const empty = sales.validateManualContact({});
  ok('empty contact rejected', empty && empty.ok === false);

  const noName = sales.validateManualContact({
    role: 'Owner',
    source: 'Website team page',
    confidence: 'medium',
  });
  ok('missing name rejected', noName && noName.ok === false);

  const noRole = sales.validateManualContact({
    full_name: 'Ada Owner',
    source: 'Website team page',
    confidence: 'medium',
  });
  ok('missing role rejected', noRole && noRole.ok === false);

  const noSource = sales.validateManualContact({
    full_name: 'Ada Owner',
    role: 'Owner',
    confidence: 'medium',
  });
  ok('missing source rejected', noSource && noSource.ok === false);

  const badConfidence = sales.validateManualContact({
    full_name: 'Ada Owner',
    role: 'Owner',
    source: 'Website',
    confidence: 'sure-thing',
  });
  ok('invalid confidence rejected', badConfidence && badConfidence.ok === false);

  const badEmail = sales.validateManualContact({
    full_name: 'Ada Owner',
    role: 'Owner',
    email: 'not-an-email',
    source: 'Website',
    confidence: 'low',
  });
  ok('invalid email rejected', badEmail && badEmail.ok === false);

  const badLinkedIn = sales.validateManualContact({
    full_name: 'Ada Owner',
    role: 'Owner',
    linkedin_url: 'not a url',
    source: 'Website',
    confidence: 'low',
  });
  ok('invalid LinkedIn URL rejected', badLinkedIn && badLinkedIn.ok === false);

  const bounds = sales.CONTACT_BOUNDS;
  const tooLongName = sales.validateManualContact({
    full_name: 'x'.repeat((bounds && bounds.fullNameMax ? bounds.fullNameMax : 200) + 1),
    role: 'Owner',
    source: 'Website',
    confidence: 'low',
  });
  ok('oversized name rejected', tooLongName && tooLongName.ok === false);

  const validMinimal = sales.validateManualContact({
    full_name: 'Ada Owner',
    role: 'Owner',
    source: 'Hostel website team page',
    confidence: 'medium',
  });
  ok('valid minimal contact accepted', validMinimal && validMinimal.ok === true, JSON.stringify(validMinimal));
  ok('minimal keeps empty optional channels', validMinimal && validMinimal.contact
    && validMinimal.contact.email === ''
    && validMinimal.contact.phone === ''
    && validMinimal.contact.linkedin_url === '');

  const validFull = sales.validateManualContact({
    name: 'Sam Manager',
    role: 'General Manager',
    email: 'sam@somo-surf.example',
    phone: '+34 600 111 222',
    linkedin_url: 'linkedin.com/in/sam-manager',
    source: 'LinkedIn profile (manual)',
    confidence: 'high',
  });
  ok('valid full contact accepted', validFull && validFull.ok === true && validFull.contact, JSON.stringify(validFull));
  ok('name alias maps to full_name', validFull && validFull.contact && validFull.contact.full_name === 'Sam Manager');
  ok('email preserved', validFull && validFull.contact && validFull.contact.email === 'sam@somo-surf.example');
  ok('phone preserved', validFull && validFull.contact && validFull.contact.phone === '+34 600 111 222');
  ok(
    'linkedin URL normalized with https',
    validFull && validFull.contact && /^https:\/\/linkedin\.com\/in\/sam-manager$/i.test(validFull.contact.linkedin_url),
  );
  ok('confidence high', validFull && validFull.contact && validFull.contact.confidence === 'high');

  const repo = store.createMemorySalesRepository();
  if (typeof sales._setSalesRepositoryForTests === 'function') {
    sales._setSalesRepositoryForTests(repo);
  }
  const created = await sales.createProspect({ business_name: 'Contact Hostel' }, 'Admin');
  ok('prospect created for contact domain checks', created && created.ok === true);
  if (!(created && created.ok)) return;
  const prospectId = created.prospect.id;

  const recorded = await sales.recordManualContact(prospectId, {
    full_name: 'Ada Owner',
    role: 'Owner',
    email: 'ada@contact-hostel.example',
    phone: '',
    linkedin_url: '',
    source: 'Website about page',
    confidence: 'high',
  }, 'Earthling');
  ok('recordManualContact ok', recorded && recorded.ok === true && recorded.contact, JSON.stringify(recorded));
  ok('contact is prospect-scoped', recorded && recorded.contact && recorded.contact.prospect_id === prospectId);
  ok('contact stores email', recorded && recorded.contact && recorded.contact.email === 'ada@contact-hostel.example');
  ok('contact stores confidence', recorded && recorded.contact && recorded.contact.confidence === 'high');
  ok('contact author is Earthling', recorded && recorded.contact && recorded.contact.author_id === 'Earthling');

  const listed = await sales.listContactCandidatesForProspect(prospectId);
  ok('listContactCandidatesForProspect returns array', Array.isArray(listed));
  ok('list includes recorded contact', listed.some((c) => c.full_name === 'Ada Owner'));

  await new Promise((r) => setTimeout(r, 5));
  await sales.recordManualContact(prospectId, {
    full_name: 'UNIQUE_NEWER_CONTACT',
    role: 'Front Desk',
    source: 'Phone book',
    confidence: 'low',
  }, 'Monshies');
  const listed2 = await sales.listContactCandidatesForProspect(prospectId);
  ok(
    'contact list is newest-first',
    listed2.length >= 2 && listed2[0].full_name === 'UNIQUE_NEWER_CONTACT',
    listed2.map((c) => `${c.full_name}:${c.created_at}`).join(' | '),
  );

  const audits = await sales.listAuditEvents(prospectId);
  const contactAudits = audits.filter((e) => e.action === 'contact_candidate_recorded');
  ok('append-only audit event for contact', contactAudits.length >= 2);
  ok('contact audit identifies operator', contactAudits.some((e) => e.actor === 'Earthling'));
  ok(
    'contact audit is prospect-scoped',
    contactAudits.some((e) => e.detail && e.detail.prospect_id === prospectId && e.detail.full_name === 'Ada Owner'),
  );

  const beforeLen = audits.length;
  const snapshot = audits.map((e) => ({ ...e, detail: e.detail ? { ...e.detail } : e.detail }));
  await sales.recordManualContact(prospectId, {
    full_name: 'Third Contact',
    role: 'Sales',
    source: 'Referral',
    confidence: 'medium',
  }, 'Admin');
  const after = await sales.listAuditEvents(prospectId);
  ok('third contact appends audit (no overwrite)', after.length === beforeLen + 1);
  ok(
    'prior audit events remain intact (append-only)',
    snapshot.every((old, idx) => {
      const cur = after[idx];
      return cur && cur.id === old.id && cur.action === old.action && JSON.stringify(cur.detail) === JSON.stringify(old.detail);
    }),
  );

  const evidence = await sales.recordManualEvidence(prospectId, {
    source_label: 'Website',
    source_url: 'https://contact-hostel.example/about',
    summary: 'Surf hostel',
    factual_notes: 'Dorm beds',
    limitations: 'Manual',
    confidence: 'medium',
  }, 'Earthling');
  ok('evidence for CRM preview wiring', evidence && evidence.ok);
  await sales.recordQualification(prospectId, {
    decision: 'qualified',
    rationale: 'Fits contact enrichment pilot',
    evidence_ids: [evidence.research.id],
  }, 'Earthling');
  const preview = await sales.getCrmSyncPreview(prospectId);
  ok('CRM preview ok with stored contacts', preview && preview.ok === true, JSON.stringify(preview && preview.error));
  ok(
    'CRM preview includes stored contact candidates',
    preview
      && preview.preview
      && Array.isArray(preview.preview.contacts)
      && preview.preview.contacts.some((c) => c.full_name === 'Ada Owner' && c.email === 'ada@contact-hostel.example'),
    JSON.stringify(preview && preview.preview && preview.preview.contacts),
  );

  const missingProspect = await sales.recordManualContact('00000000-0000-4000-8000-000000000099', {
    full_name: 'Ghost',
    role: 'N/A',
    source: 'Nowhere',
    confidence: 'low',
  }, 'Admin');
  ok('missing prospect returns 404', missingProspect && missingProspect.ok === false && missingProspect.status === 404);

  console.log('\n▸ Production safe-failure for contact mutations');
  const failRepo = await store.createSalesRepository({ NODE_ENV: 'production' });
  sales._setSalesRepositoryForTests(failRepo);
  const closed = await sales.recordManualContact(prospectId, {
    full_name: 'Closed',
    role: 'Owner',
    source: 'Website',
    confidence: 'low',
  }, 'Admin');
  ok(
    'production missing DSN rejects contact write',
    closed && closed.ok === false && (closed.status === 503 || closed.code === 'sales_store_misconfigured'),
    JSON.stringify(closed),
  );
  ok(
    'fail-closed contact error does not leak DSN/SQL',
    closed && !/postgres:\/\/|WOLFHOUSE|INSERT\s+INTO|password|APOLLO/i.test(JSON.stringify(closed)),
  );

  console.log('\n▸ Durable repository SQL for contact candidates');
  sales._setSalesRepositoryForTests(repo);
  const recordedSql = [];
  const pgRepo = store.createPgSalesRepository({
    query: async (sql, params) => {
      recordedSql.push({ sql: String(sql), params });
      if (/SELECT[\s\S]*FROM\s+luna_sales\.prospects/i.test(sql)) {
        return {
          rows: [{
            id: prospectId,
            canonical_name: 'SQL Contact Hostel',
            website_url: '',
            lifecycle_status: 'ready_for_review',
            owner_id: 'Admin',
            created_at: '2026-07-22T00:00:00.000Z',
            updated_at: '2026-07-22T00:00:00.000Z',
            last_decision: null,
          }],
        };
      }
      if (/INSERT\s+INTO\s+luna_sales\.contact_candidates/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT\s+INTO\s+luna_sales\.audit_events/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT[\s\S]*FROM\s+luna_sales\.contact_candidates/i.test(sql)) {
        return {
          rows: [{
            id: '33333333-3333-4333-8333-333333333333',
            prospect_id: prospectId,
            full_name: 'SQL Contact',
            role: 'Owner',
            email: 'sql@example.com',
            phone: '',
            linkedin_url: '',
            source: 'Website',
            confidence: 'medium',
            author_id: 'Admin',
            created_at: '2026-07-22T01:00:00.000Z',
          }],
        };
      }
      return { rows: [] };
    },
  });
  sales._setSalesRepositoryForTests(pgRepo);
  const pgSaved = await sales.recordManualContact(prospectId, {
    full_name: 'SQL Contact',
    role: 'Owner',
    email: 'sql@example.com',
    source: 'Website',
    confidence: 'medium',
  }, 'Admin');
  ok('pg recordManualContact ok', pgSaved && pgSaved.ok === true, JSON.stringify(pgSaved));
  ok(
    'contact INSERT qualifies luna_sales.contact_candidates',
    recordedSql.some((row) => /INSERT\s+INTO\s+luna_sales\.contact_candidates/i.test(row.sql)),
  );
  await sales.listContactCandidatesForProspect(prospectId);
  ok(
    'listContactCandidatesForProspect SQL orders newest-first',
    recordedSql.some((row) => (
      /FROM\s+luna_sales\.contact_candidates/i.test(row.sql)
      && /ORDER BY created_at DESC/i.test(row.sql)
    )),
  );

  const boomRepo = store.createPgSalesRepository({
    query: async () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:5432 password=SuperSecretPass postgres://prod-db.azure/pg_shadow');
      throw err;
    },
  });
  sales._setSalesRepositoryForTests(boomRepo);
  const unavailable = await sales.recordManualContact(prospectId, {
    full_name: 'Boom',
    role: 'Owner',
    source: 'Website',
    confidence: 'low',
  }, 'Admin');
  ok(
    'pg contact failure returns safe sales_unavailable',
    unavailable
      && unavailable.ok === false
      && unavailable.status === 503
      && unavailable.code === 'sales_unavailable'
      && unavailable.retryable === true,
    JSON.stringify(unavailable),
  );
  ok(
    'pg contact failure does not leak secrets/SQL',
    unavailable && !/SuperSecretPass|postgres:\/\/|prod-db\.azure|pg_shadow/i.test(JSON.stringify(unavailable)),
  );
}

async function main() {
  console.log('verify:crowsnest-sales-contact-enrichment — Luna Sales Chapter 9\n');

  structuralChecks();
  await domainValidationChecks();

  await runScenario('Auth + method protection for contacts POST', BASE_PORT, {
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
      ok('login cookie for contact scenario', /crowsnest_session=/.test(cookie));

      const created = await request(port, '/sales/prospects', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'business_name=Auth+Contact+Hostel',
      });
      const detailPath = String(created.headers.location || '');
      ok('created prospect for contact route', created.statusCode === 302 && detailPath.startsWith('/sales/prospects/'));
      const prospectId = detailPath.split('/').pop();
      const contactsUrl = `/sales/prospects/${prospectId}/contacts`;

      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, contactsUrl, method, { Cookie: cookie }, 'POST');
      }

      const unauth = await request(port, contactsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: encodeContactBody({
          full_name: 'Ada',
          role: 'Owner',
          source: 'Website',
          confidence: 'low',
        }),
      });
      ok(
        'unauthenticated contact POST redirects to /login',
        unauth.statusCode === 302 && String(unauth.headers.location || '') === '/login',
      );

      const detail = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok(
        'detail shows manual contact form',
        /name=["']full_name["']/.test(detail.body)
          && /name=["']confidence["']/.test(detail.body)
          && /name=["']linkedin_url["']/.test(detail.body),
      );
      ok(
        'detail states manual contacts / no Apollo',
        /manual contact|no Apollo|no auto-find/i.test(detail.body),
      );
      ok(
        'detail does not claim Apollo auto-find or send',
        !/apollo lookup completed|auto-find completed|contact message has been sent/i.test(detail.body),
      );
    },
  ]);

  await runScenario('XSS-safe contact presentation + newest-first list', BASE_PORT + 1, {
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
        body: 'business_name=XSS+Contact+Hostel',
      });
      const detailPath = String(created.headers.location || '');
      const prospectId = detailPath.split('/').pop();
      const contactsUrl = `/sales/prospects/${prospectId}/contacts`;

      const older = await request(port, contactsUrl, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeContactBody({
          full_name: 'UNIQUE_OLDER_CONTACT',
          role: 'Owner',
          source: 'Website',
          confidence: 'low',
        }),
      });
      ok(
        'first contact POST redirects to detail',
        older.statusCode === 302 && String(older.headers.location || '') === detailPath,
        `status=${older.statusCode} loc=${older.headers.location}`,
      );

      await new Promise((r) => setTimeout(r, 20));

      const newer = await request(port, contactsUrl, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeContactBody({
          full_name: '<script>alert("contact")</script> UNIQUE_NEWER_XSS_CONTACT',
          role: '<img src=x onerror=alert(1)> Manager',
          email: 'xss@example.com',
          phone: '+34 600 000 000',
          linkedin_url: 'https://linkedin.com/in/xss-contact',
          source: '<b>UNIQUE_CONTACT_SOURCE</b>',
          confidence: 'medium',
        }),
      });
      ok(
        'second contact POST redirects to detail',
        newer.statusCode === 302 && String(newer.headers.location || '') === detailPath,
        `status=${newer.statusCode} loc=${newer.headers.location}`,
      );

      const detail = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok('script tags escaped on contact detail', !/<script>alert\("contact"\)<\/script>/.test(detail.body));
      ok('escaped contact name entities present', /&lt;script&gt;/.test(detail.body));
      ok('onerror payload escaped', !/<img src=x onerror=alert\(1\)>/.test(detail.body));
      ok('confidence visible', /medium/i.test(detail.body));
      ok('email visible', /xss@example\.com/.test(detail.body));
      ok('audit shows contact_candidate_recorded', /contact_candidate_recorded/i.test(detail.body));

      const olderIdx = detail.body.indexOf('UNIQUE_OLDER_CONTACT');
      const newerIdx = detail.body.indexOf('UNIQUE_NEWER_XSS_CONTACT');
      ok(
        'contact entries list newer before older when both present',
        olderIdx >= 0 && newerIdx >= 0 && newerIdx < olderIdx,
        `newerIdx=${newerIdx} olderIdx=${olderIdx}`,
      );

      const invalid = await request(port, contactsUrl, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeContactBody({
          full_name: '',
          role: 'Owner',
          source: 'Website',
          confidence: 'low',
        }),
      });
      ok(
        'invalid contact redisplays with error',
        invalid.statusCode === 400
          || (invalid.statusCode === 200 && /name|required|provide/i.test(invalid.body)),
        `status=${invalid.statusCode}`,
      );

      // Qualify + open CRM preview to assert contacts appear there too
      const evidenceParams = new URLSearchParams({
        source_label: 'Website',
        source_url: 'https://xss-contact.example',
        summary: 'Hostel',
        factual_notes: 'Beds',
        limitations: 'Manual',
        confidence: 'medium',
      });
      await request(port, `/sales/prospects/${prospectId}/evidence`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: evidenceParams.toString(),
      });
      const detailForEvidence = await request(port, detailPath, { headers: { Cookie: cookie } });
      const evidenceMatch = detailForEvidence.body.match(/name=["']evidence_ids["']\s+value=["']([^"']+)["']/);
      const evidenceId = evidenceMatch ? evidenceMatch[1] : '';
      ok('evidence id found for CRM wiring', Boolean(evidenceId));
      const qualParams = new URLSearchParams();
      qualParams.set('qualification_decision', 'qualified');
      qualParams.set('rationale', 'Fits contact CRM preview check');
      if (evidenceId) qualParams.append('evidence_ids', evidenceId);
      await request(port, `/sales/prospects/${prospectId}/qualification`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: qualParams.toString(),
      });

      const preview = await request(port, `/sales/prospects/${prospectId}/crm-preview`, {
        headers: { Cookie: cookie },
      });
      ok('CRM preview returns 200 with contacts', preview.statusCode === 200, `got ${preview.statusCode}`);
      ok(
        'CRM preview shows stored contact email',
        /xss@example\.com/.test(preview.body),
      );
      ok(
        'CRM preview still preview-only',
        /preview only|no CRM record has been sent/i.test(preview.body),
      );
    },
  ]);

  await runScenario('Authenticated operators can record contacts', BASE_PORT + 2, {
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
        body: 'business_name=Monshies+Contact+Hostel',
      });
      const detailPath = String(created.headers.location || '');
      const prospectId = detailPath.split('/').pop();

      const posted = await request(port, `/sales/prospects/${prospectId}/contacts`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: encodeContactBody({
          full_name: 'Monshies Contact Person',
          role: 'Owner',
          email: 'monshies-contact@example.com',
          source: 'Operator notes',
          confidence: 'medium',
        }),
      });
      ok('authenticated operator can POST contact', posted.statusCode === 302, `status=${posted.statusCode}`);

      const detail = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok('operator contact visible on detail', /Monshies Contact Person/i.test(detail.body));
      ok('operator actor appears in audit', /monshies-op|Admin|actor=/i.test(detail.body));
    },
  ]);

  console.log(`\n── verify:crowsnest-sales-contact-enrichment: ${pass} passed, ${fail} failed ──`);
  if (fail === 0) {
    console.log('verify:crowsnest-sales-contact-enrichment — ALL CHECKS PASSED');
  }
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  await stopServer();
  console.error(err);
  process.exit(1);
});
