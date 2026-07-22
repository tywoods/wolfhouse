'use strict';

/**
 * Deterministic RED→GREEN verifier for Luna Sales Chapter 7:
 * Discovery Source Contract (provider-neutral + manual-source adapter only).
 * Offline — no live DB, no Azure, no Maps/Apollo/web search/external API,
 * no auto-create prospects, no CRM/outreach/AI calls.
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
const CONTRACT_REL = 'scripts/lib/crowsnest/crowsnest-sales-discovery-contract.js';
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);
const MANUAL_REL = 'scripts/lib/crowsnest/crowsnest-sales-discovery-manual.js';
const MANUAL_PATH = path.join(ROOT, MANUAL_REL);
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'SALES-DISCOVERY-SOURCE.md');
const PRODUCT_DOC = path.join(ROOT, 'docs', 'CROWSNEST.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'crowsnest-sales-discovery');
const BASE_PORT = Number(process.env.CROWSNEST_VERIFY_SALES_DISCOVERY_PORT) || 13380;

const VALID_FIXTURES = Object.freeze([
  'valid-manual-full.json',
  'valid-manual-name-only.json',
  'valid-manual-website-only.json',
]);

const INVALID_FIXTURES = Object.freeze([
  'invalid-empty.json',
  'invalid-unknown-field.json',
]);

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

function readJson(abs) {
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
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
  console.log('\n▸ Structural: Chapter 7 discovery source contract');
  const apiSrc = read(API_PATH) || '';
  const pageSrc = read(PAGE_PATH) || '';
  const salesSrc = read(SALES_PATH) || '';
  const storeSrc = read(STORE_PATH) || '';
  const contractSrc = read(CONTRACT_PATH) || '';
  const manualSrc = read(MANUAL_PATH) || '';
  const docSrc = read(DOC_PATH) || '';
  const productSrc = read(PRODUCT_DOC) || '';

  ok('discovery contract module exists', fs.existsSync(CONTRACT_PATH), CONTRACT_REL);
  ok('manual discovery adapter exists', fs.existsSync(MANUAL_PATH), MANUAL_REL);
  ok('discovery source doc exists', fs.existsSync(DOC_PATH));

  ok(
    'contract exports validateProposedProspect',
    /validateProposedProspect/.test(contractSrc),
  );
  ok(
    'contract exports previewDiscoveryDeduplication',
    /previewDiscoveryDeduplication/.test(contractSrc),
  );
  ok(
    'contract defines schema version',
    /crowsnest\.sales\.discovery\.v1/.test(contractSrc),
  );
  ok(
    'contract documents LeadSourceAdapter / DiscoverySourceAdapter',
    /LeadSourceAdapter|DiscoverySourceAdapter/.test(contractSrc),
  );
  ok(
    'contract includes rate/quality controls',
    /RATE|QUALITY|max_proposals|auto_create/i.test(contractSrc),
  );
  ok(
    'manual adapter exports adaptManualDiscoveryProposal',
    /adaptManualDiscoveryProposal/.test(manualSrc),
  );
  ok(
    'manual adapter source is manual',
    /manual/.test(manualSrc) && /SOURCE_NAME|source_name|source:\s*['"]manual['"]/.test(manualSrc),
  );
  ok(
    'sales exports previewManualDiscovery',
    /previewManualDiscovery/.test(salesSrc),
  );
  ok(
    'sales exports importManualDiscoveryProposal',
    /importManualDiscoveryProposal/.test(salesSrc),
  );
  ok(
    'router allowlists /sales/discovery',
    /pathname\s*===\s*['"]\/sales\/discovery['"]/.test(apiSrc),
  );
  ok(
    'router allowlists discovery preview path',
    /\/sales\/discovery\/preview|matchSalesDiscoveryPreviewPath/.test(apiSrc),
  );
  ok(
    'router allowlists discovery import path',
    /\/sales\/discovery\/import|matchSalesDiscoveryImportPath/.test(apiSrc),
  );
  ok('page registers sales_discovery view', /sales_discovery/.test(pageSrc));
  ok(
    'page mentions preview / not auto-created',
    /preview only|not been created|no prospect has been created|not auto-creat/i.test(pageSrc),
  );
  ok('page escapes discovery fields', /escapeHtml/.test(pageSrc) && /discovery/i.test(pageSrc));
  ok(
    'no Maps / Apollo / googleapis / web-search clients in discovery modules',
    !/require\(['"][^'"]*(googleapis|@googlemaps|apollo|serpapi|bing|duckduckgo)/i.test(contractSrc)
      && !/require\(['"][^'"]*(googleapis|@googlemaps|apollo|serpapi|bing|duckduckgo)/i.test(manualSrc)
      && !/maps\.googleapis\.com|api\.apollo\.io|google\.com\/maps/i.test(contractSrc)
      && !/maps\.googleapis\.com|api\.apollo\.io|google\.com\/maps/i.test(manualSrc)
      && !/\bhttps?\.(get|request|fetch)\b|node-fetch|undici|axios/i.test(manualSrc),
  );
  ok(
    'sales discovery path does not claim live provider discovery',
    !/Maps discovery ran|Apollo enrichment completed|web search completed|live discovery completed/i.test(pageSrc),
  );
  ok(
    'no new discovery migration required',
    !/047_luna_sales_discovery|CREATE\s+TABLE.*discovery_candidates/i.test(storeSrc)
      && !fs.existsSync(path.join(ROOT, 'database', 'migrations', '047_luna_sales_discovery.sql')),
  );
  ok(
    'doc forbids Maps/Apollo/external API / auto-create',
    /no Google Maps|no Apollo|no web search|no external|manual|preview|not auto-create|no auto-create/i.test(docSrc),
  );
  ok(
    'product doc mentions Chapter 7 discovery',
    /Chapter 7|Discovery Source|discovery source contract/i.test(productSrc),
  );

  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  } catch {
    pkg = null;
  }
  ok(
    'package.json has verify:crowsnest-sales-discovery-contract',
    pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-sales-discovery-contract'] === 'string',
  );
  ok(
    'verify script points at this verifier',
    Boolean(
      pkg
      && pkg.scripts
      && String(pkg.scripts['verify:crowsnest-sales-discovery-contract']).includes(
        'verify-crowsnest-sales-discovery-contract.js',
      ),
    ),
  );

  const onDiskFixtures = fs.existsSync(FIXTURE_DIR)
    ? fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).sort()
    : [];
  const declared = [...VALID_FIXTURES, ...INVALID_FIXTURES].slice().sort();
  ok(
    'fixture inventory matches declared set',
    declared.length === onDiskFixtures.length
      && declared.every((name, i) => name === onDiskFixtures[i]),
    `declared=[${declared.join(',')}] disk=[${onDiskFixtures.join(',')}]`,
  );
}

function domainChecks() {
  console.log('\n▸ Domain: proposed prospect + dedup preview');
  delete require.cache[require.resolve(CONTRACT_PATH)];
  delete require.cache[require.resolve(MANUAL_PATH)];
  const contract = require(CONTRACT_PATH);
  const manual = require(MANUAL_PATH);

  ok('SCHEMA_VERSION is crowsnest.sales.discovery.v1', contract.SCHEMA_VERSION === 'crowsnest.sales.discovery.v1');
  ok('validateProposedProspect is a function', typeof contract.validateProposedProspect === 'function');
  ok(
    'previewDiscoveryDeduplication is a function',
    typeof contract.previewDiscoveryDeduplication === 'function',
  );
  ok(
    'adaptManualDiscoveryProposal is a function',
    typeof manual.adaptManualDiscoveryProposal === 'function',
  );
  ok('manual SOURCE_NAME is manual', manual.SOURCE_NAME === 'manual');
  ok(
    'rate controls forbid auto-create',
    contract.DISCOVERY_RATE_CONTROLS
      && contract.DISCOVERY_RATE_CONTROLS.auto_create_prospects === false,
  );
  ok(
    'rate controls cap proposals per adapt at 1',
    contract.DISCOVERY_RATE_CONTROLS
      && contract.DISCOVERY_RATE_CONTROLS.max_proposals_per_adapt === 1,
  );

  for (const name of VALID_FIXTURES) {
    const raw = readJson(path.join(FIXTURE_DIR, name));
    const adapted = manual.adaptManualDiscoveryProposal(raw);
    ok(`adapt ${name} ok`, adapted && adapted.ok === true, JSON.stringify(adapted));
    if (adapted && adapted.ok) {
      const validated = contract.validateProposedProspect(adapted.proposal);
      ok(`validate ${name} ok`, validated && validated.ok === true, JSON.stringify(validated));
      ok(
        `${name} has business_name/website/location/category/source_reference keys`,
        adapted.proposal
          && Object.prototype.hasOwnProperty.call(adapted.proposal, 'business_name')
          && Object.prototype.hasOwnProperty.call(adapted.proposal, 'website_url')
          && Object.prototype.hasOwnProperty.call(adapted.proposal, 'location')
          && Object.prototype.hasOwnProperty.call(adapted.proposal, 'category')
          && Object.prototype.hasOwnProperty.call(adapted.proposal, 'source_reference'),
      );
      ok(
        `${name} provenance source is manual`,
        adapted.provenance && adapted.provenance.source_name === 'manual',
      );
      ok(
        `${name} does not create a prospect`,
        adapted.prospect_created !== true && adapted.auto_created !== true,
      );
    }
  }

  for (const name of INVALID_FIXTURES) {
    const raw = readJson(path.join(FIXTURE_DIR, name));
    const adapted = manual.adaptManualDiscoveryProposal(raw);
    ok(`adapt ${name} rejected`, adapted && adapted.ok === false, JSON.stringify(adapted));
  }

  const full = manual.adaptManualDiscoveryProposal(
    readJson(path.join(FIXTURE_DIR, 'valid-manual-full.json')),
  );
  const existing = [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      canonical_name: 'Somo Surf House',
      website_url: 'https://www.somo-surf.example/stay',
    },
    {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      canonical_name: 'Other Hostel',
      website_url: 'https://other.example',
    },
  ];
  const dedup = contract.previewDiscoveryDeduplication({
    proposal: full.proposal,
    existingProspects: existing,
  });
  ok('dedup preview ok', dedup && dedup.ok === true && dedup.preview_only === true);
  ok('dedup does not create prospects', dedup && dedup.prospect_created !== true);
  ok(
    'dedup finds domain match',
    dedup
      && Array.isArray(dedup.matches)
      && dedup.matches.some((m) => m.prospect_id === existing[0].id && /domain/i.test(m.reason || m.match_type || '')),
    JSON.stringify(dedup),
  );
  ok(
    'dedup leaves unrelated prospect unmatched as sole duplicate when only one match',
    dedup && dedup.matches && !dedup.matches.some((m) => m.prospect_id === existing[1].id),
  );

  const noMatch = contract.previewDiscoveryDeduplication({
    proposal: {
      business_name: 'Brand New Hostel',
      website_url: 'https://brand-new.example',
      location: { city: 'Somo', country_code: 'ES' },
      category: 'hostel',
      source_reference: { source_name: 'manual', external_id: '', request_reference: 'operator-entry' },
    },
    existingProspects: existing,
  });
  ok(
    'dedup preview empty matches for novel proposal',
    noMatch && noMatch.ok === true && Array.isArray(noMatch.matches) && noMatch.matches.length === 0,
  );

  const nameLocMatch = contract.previewDiscoveryDeduplication({
    proposal: {
      business_name: 'Somo Surf House',
      website_url: '',
      location: { city: 'Somo', country_code: 'ES' },
      category: 'hostel',
      source_reference: { source_name: 'manual', external_id: '', request_reference: 'operator-entry' },
    },
    existingProspects: [
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        canonical_name: 'Somo Surf House',
        website_url: '',
        city: 'Somo',
        country_code: 'ES',
      },
    ],
  });
  ok(
    'dedup matches name/location fingerprint when domain absent',
    nameLocMatch
      && nameLocMatch.ok === true
      && nameLocMatch.matches.some((m) => /name|location|fingerprint/i.test(m.reason || m.match_type || '')),
    JSON.stringify(nameLocMatch),
  );
}

async function salesOrchestrationChecks() {
  console.log('\n▸ Sales orchestration: preview + explicit import (no auto-create)');
  delete require.cache[require.resolve(SALES_PATH)];
  delete require.cache[require.resolve(STORE_PATH)];
  delete require.cache[require.resolve(CONTRACT_PATH)];
  delete require.cache[require.resolve(MANUAL_PATH)];
  const sales = require(SALES_PATH);

  ok('previewManualDiscovery is a function', typeof sales.previewManualDiscovery === 'function');
  ok(
    'importManualDiscoveryProposal is a function',
    typeof sales.importManualDiscoveryProposal === 'function',
  );

  await sales.resetSalesStore();

  const preview = await sales.previewManualDiscovery({
    business_name: 'Preview Only Hostel',
    website_url: 'https://preview-only.example',
    city: 'Somo',
    country_code: 'ES',
    category: 'hostel',
    source_note: 'operator typed from brochure',
  });
  ok('previewManualDiscovery ok', preview && preview.ok === true, JSON.stringify(preview));
  ok('preview_only true', preview && preview.preview_only === true);
  ok('preview prospect_created false', preview && preview.prospect_created === false);
  ok(
    'preview disclaimer says not created',
    preview && /preview only|no prospect has been created|not been created/i.test(preview.disclaimer || ''),
  );

  const listedAfterPreview = await sales.listProspects();
  ok(
    'preview did not create a prospect',
    Array.isArray(listedAfterPreview) && listedAfterPreview.length === 0,
    `count=${Array.isArray(listedAfterPreview) ? listedAfterPreview.length : 'n/a'}`,
  );

  const createdFirst = await sales.createProspect({
    business_name: 'Existing Dedup Hostel',
    website_url: 'https://www.dedup-host.example/rooms',
  });
  ok('seed prospect for dedup', createdFirst && createdFirst.ok === true);

  const previewDedup = await sales.previewManualDiscovery({
    business_name: 'Different Label',
    website_url: 'https://dedup-host.example',
    city: 'Somo',
    country_code: 'ES',
    category: 'hostel',
  });
  ok(
    'preview reports dedup match against existing',
    previewDedup
      && previewDedup.ok === true
      && previewDedup.dedup
      && Array.isArray(previewDedup.dedup.matches)
      && previewDedup.dedup.matches.length >= 1,
    JSON.stringify(previewDedup && previewDedup.dedup),
  );

  const imported = await sales.importManualDiscoveryProposal(
    {
      business_name: 'Imported Manual Hostel',
      website_url: 'https://imported-manual.example',
      city: 'Santander',
      country_code: 'ES',
      category: 'surf_hostel',
      source_note: 'operator approved after preview',
    },
    'Earthling',
  );
  ok('explicit import ok', imported && imported.ok === true && imported.prospect, JSON.stringify(imported));
  ok(
    'import creates exactly via operator action',
    imported && imported.prospect_created === true && imported.auto_created === false,
  );
  ok(
    'imported prospect has identity',
    imported
      && imported.prospect
      && /Imported Manual Hostel/i.test(imported.prospect.canonical_name || ''),
  );

  const detail = await sales.getProspect(imported.prospect.id);
  const auditList = await sales.listAuditEvents(imported.prospect.id);
  ok(
    'import appends discovery_proposal_imported audit',
    Array.isArray(auditList) && auditList.some((e) => e && e.action === 'discovery_proposal_imported'),
    JSON.stringify((Array.isArray(auditList) ? auditList : []).map((e) => e && e.action)),
  );
  ok('imported prospect readable', detail && detail.id === imported.prospect.id);

  const emptyImport = await sales.importManualDiscoveryProposal({}, 'Earthling');
  ok('empty import rejected', emptyImport && emptyImport.ok === false);
}

async function main() {
  console.log('verify:crowsnest-sales-discovery-contract — Luna Sales Chapter 7\n');

  structuralChecks();
  domainChecks();
  await salesOrchestrationChecks();

  await runScenario('1 Protected discovery UI + preview (no create)', BASE_PORT, {
    CROWSNEST_AUTH_REQUIRED: 'true',
    CROWSNEST_AUTH_USERNAME: 'admin',
    CROWSNEST_AUTH_PASSWORD: 'admin',
  }, [
    async (port) => {
      const unauth = await request(port, '/sales/discovery');
      ok(
        'unauthenticated GET /sales/discovery redirects to /login',
        unauth.statusCode === 302 && String(unauth.headers.location || '') === '/login',
        `status=${unauth.statusCode} loc=${unauth.headers.location}`,
      );

      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, '/sales/discovery', method, undefined, 'GET, HEAD');
      }

      const login = await request(port, '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'username=admin&password=admin',
      });
      const cookie = extractCookiePair(login.headers['set-cookie']);
      ok('login cookie for discovery scenario', /crowsnest_session=/.test(cookie));

      const page = await request(port, '/sales/discovery', { headers: { Cookie: cookie } });
      ok('GET /sales/discovery => 200', page.statusCode === 200, `got ${page.statusCode}`);
      ok('discovery page heading', /discovery/i.test(page.body) && /<h1/i.test(page.body));
      ok(
        'discovery form fields present',
        /business.?name|website/i.test(page.body)
          && /location|city|category/i.test(page.body)
          && /<form\b/i.test(page.body),
      );
      ok(
        'discovery safety copy forbids live providers / auto-create',
        /manual/i.test(page.body)
          && /Maps|Apollo|web search|external/i.test(page.body)
          && /preview|not.*creat|no prospect has been created|not auto/i.test(page.body),
      );
      ok('Sales nav current on discovery', /href=["']\/sales["']/.test(page.body));

      const unauthPreview = await request(port, '/sales/discovery/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'business_name=Unauth+Preview',
      });
      ok(
        'unauthenticated preview redirects to /login',
        unauthPreview.statusCode === 302 && String(unauthPreview.headers.location || '') === '/login',
      );

      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, '/sales/discovery/preview', method, { Cookie: cookie }, 'POST');
      }

      const preview = await request(port, '/sales/discovery/preview', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: [
          'business_name=Preview+Hostel',
          'website_url=https%3A%2F%2Fpreview-hostel.example',
          'city=Somo',
          'country_code=ES',
          'category=hostel',
          'source_note=brochure',
        ].join('&'),
      });
      ok(
        'preview returns 200 with normalized proposal',
        preview.statusCode === 200
          && /Preview Hostel/i.test(preview.body)
          && /preview-hostel\.example/i.test(preview.body)
          && /Somo/i.test(preview.body)
          && /hostel/i.test(preview.body)
          && /preview only|no prospect has been created|not been created/i.test(preview.body),
        `status=${preview.statusCode}`,
      );
      ok(
        'preview shows dedup section',
        /dedup|duplicate|match/i.test(preview.body),
      );

      const list = await request(port, '/sales', { headers: { Cookie: cookie } });
      ok(
        'preview did not add prospect to Sales list',
        !/Preview Hostel/i.test(list.body),
      );
    },
  ]);

  await runScenario('2 Explicit import creates one prospect', BASE_PORT + 1, {
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

      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, '/sales/discovery/import', method, { Cookie: cookie }, 'POST');
      }

      const unauthImport = await request(port, '/sales/discovery/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'business_name=Unauth+Import',
      });
      ok(
        'unauthenticated import redirects to /login',
        unauthImport.statusCode === 302 && String(unauthImport.headers.location || '') === '/login',
      );

      const imported = await request(port, '/sales/discovery/import', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: [
          'business_name=Import+Me+Hostel',
          'website_url=https%3A%2F%2Fimport-me.example',
          'city=Somo',
          'country_code=ES',
          'category=hostel',
          'source_note=after+preview',
        ].join('&'),
      });
      ok(
        'explicit import redirects to prospect detail',
        imported.statusCode === 302
          && /\/sales\/prospects\/[a-zA-Z0-9_-]+/.test(String(imported.headers.location || '')),
        `status=${imported.statusCode} loc=${imported.headers.location}`,
      );

      const detailPath = String(imported.headers.location || '');
      const detail = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok('imported prospect detail visible', detail.statusCode === 200 && /Import Me Hostel/i.test(detail.body));
      ok(
        'imported detail shows discovery import audit or source',
        /discovery_proposal_imported|manual discovery|source_note|after preview/i.test(detail.body),
      );
      ok(
        'no live Maps/Apollo claims after import',
        !/Maps discovery ran|Apollo enrichment completed|web search completed/i.test(detail.body),
      );
    },
  ]);

  console.log(`\n── verify:crowsnest-sales-discovery-contract: ${pass} passed, ${fail} failed ──`);
  if (fail === 0) {
    console.log('verify:crowsnest-sales-discovery-contract — ALL CHECKS PASSED');
  }
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  await stopServer();
  console.error(err);
  process.exit(1);
});
