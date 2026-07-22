'use strict';

/**
 * Deterministic RED→GREEN verifier for Luna Sales Chapter 8:
 * Google Maps Discovery adapter shell (dry-run / test-fixture only).
 * Offline — no live DB, no Azure, no Google Maps HTTP/API key/SDK/scraping,
 * no auto-create prospects, no CRM/outreach/AI/ledger calls.
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
const CONTRACT_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-sales-discovery-contract.js');
const MAPS_REL = 'scripts/lib/crowsnest/crowsnest-sales-discovery-maps.js';
const MAPS_PATH = path.join(ROOT, MAPS_REL);
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'SALES-MAPS-DISCOVERY.md');
const PRODUCT_DOC = path.join(ROOT, 'docs', 'CROWSNEST.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'crowsnest-sales-maps-discovery');
const SAMPLE_PLACES = path.join(FIXTURE_DIR, 'sample-places.json');
const BASE_PORT = Number(process.env.CROWSNEST_VERIFY_SALES_MAPS_DISCOVERY_PORT) || 13390;

const DECLARED_FIXTURES = Object.freeze([
  'invalid-criteria-madrid.json',
  'sample-places.json',
  'valid-criteria-somo.json',
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
  console.log('\n▸ Structural: Chapter 8 Maps dry-run adapter');
  const apiSrc = read(API_PATH) || '';
  const pageSrc = read(PAGE_PATH) || '';
  const salesSrc = read(SALES_PATH) || '';
  const storeSrc = read(STORE_PATH) || '';
  const mapsSrc = read(MAPS_PATH) || '';
  const docSrc = read(DOC_PATH) || '';
  const productSrc = read(PRODUCT_DOC) || '';

  ok('maps discovery adapter exists', fs.existsSync(MAPS_PATH), MAPS_REL);
  ok('maps discovery doc exists', fs.existsSync(DOC_PATH));
  ok('sample places fixture exists', fs.existsSync(SAMPLE_PLACES));

  ok('adapter exports search', /function search\b|exports\.search|search,/.test(mapsSrc));
  ok('adapter exports normalizeMapsPlace', /normalizeMapsPlace/.test(mapsSrc));
  ok('adapter source is google_maps_dry_run', /google_maps_dry_run/.test(mapsSrc));
  ok('adapter marks dry_run', /dry_run|DRY_RUN/.test(mapsSrc));
  ok('adapter enforces Northern Spain', /Northern Spain|NORTHERN_SPAIN/i.test(mapsSrc));
  ok('adapter preserves place_id', /place_id/.test(mapsSrc));
  ok('adapter preserves search_area', /search_area/.test(mapsSrc));

  ok(
    'no Google SDK / HTTP / scraping clients in maps adapter',
    !/require\(['"][^'"]*(googleapis|@googlemaps|puppeteer|playwright|cheerio|axios|node-fetch|undici)['"]\)/i.test(mapsSrc)
      && !/maps\.googleapis\.com|places\.googleapis\.com/i.test(mapsSrc)
      && !/\bhttps?\.(get|request)\b|\bfetch\s*\(/.test(mapsSrc)
      && !/process\.env\.[A-Z0-9_]*(GOOGLE|MAPS|GMAPS)/i.test(mapsSrc)
      && !/\bGOOGLE_MAPS_API_KEY\b|\bMAPS_API_KEY\b|\bGMAPS_API_KEY\b/.test(mapsSrc),
  );

  ok('sales exports previewMapsDiscoverySearch', /previewMapsDiscoverySearch/.test(salesSrc));
  ok('sales exports importMapsDiscoveryCandidate', /importMapsDiscoveryCandidate/.test(salesSrc));
  ok(
    'router allowlists maps preview path',
    /\/sales\/discovery\/maps\/preview/.test(apiSrc),
  );
  ok(
    'router allowlists maps import path',
    /\/sales\/discovery\/maps\/import/.test(apiSrc),
  );
  ok('page shows sample/dry-run Maps copy', /sample\s*\/\s*dry-run|dry-run data only|Sample \/ dry-run/i.test(pageSrc));
  ok('page escapes Maps fields', /escapeHtml/.test(pageSrc) && /maps-discovery|place_id/i.test(pageSrc));
  ok(
    'page does not claim live Maps discovery ran',
    !/Maps discovery ran|live Google Maps results were fetched|Places API completed/i.test(pageSrc),
  );
  ok(
    'no new discovery migration required',
    !/048_luna_sales_maps|CREATE\s+TABLE.*discovery_candidates/i.test(storeSrc)
      && !fs.existsSync(path.join(ROOT, 'database', 'migrations', '048_luna_sales_maps_discovery.sql')),
  );
  ok(
    'doc forbids live Maps HTTP / API key / SDK',
    /dry-run|fixture|no live|no.*API key|no.*SDK|no.*scraping/i.test(docSrc),
  );
  ok(
    'product doc mentions Chapter 8 Maps',
    /Chapter 8|Maps discovery|google_maps_dry_run|maps-discovery/i.test(productSrc),
  );

  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  } catch {
    pkg = null;
  }
  ok(
    'package.json has verify:crowsnest-sales-maps-discovery',
    pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-sales-maps-discovery'] === 'string',
  );
  ok(
    'verify script points at this verifier',
    Boolean(
      pkg
      && pkg.scripts
      && String(pkg.scripts['verify:crowsnest-sales-maps-discovery']).includes(
        'verify-crowsnest-sales-maps-discovery.js',
      ),
    ),
  );

  const onDiskFixtures = fs.existsSync(FIXTURE_DIR)
    ? fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json')).sort()
    : [];
  const declared = DECLARED_FIXTURES.slice().sort();
  ok(
    'fixture inventory matches declared set',
    declared.length === onDiskFixtures.length
      && declared.every((name, i) => name === onDiskFixtures[i]),
    `declared=[${declared.join(',')}] disk=[${onDiskFixtures.join(',')}]`,
  );
}

function domainChecks() {
  console.log('\n▸ Domain: Maps normalize + Northern Spain scope + dedup');
  delete require.cache[require.resolve(CONTRACT_PATH)];
  delete require.cache[require.resolve(MAPS_PATH)];
  const contract = require(CONTRACT_PATH);
  const maps = require(MAPS_PATH);

  ok('SOURCE_NAME is google_maps_dry_run', maps.SOURCE_NAME === 'google_maps_dry_run');
  ok('DRY_RUN is true', maps.DRY_RUN === true);
  ok('search is a function', typeof maps.search === 'function');
  ok('normalizeMapsPlace is a function', typeof maps.normalizeMapsPlace === 'function');
  ok(
    'adapter shape ok',
    contract.assertDiscoverySourceAdapterShape(maps.mapsDiscoveryAdapter).ok === true,
  );
  ok(
    'rate controls forbid live + auto-create',
    maps.MAPS_DISCOVERY_RATE_CONTROLS
      && maps.MAPS_DISCOVERY_RATE_CONTROLS.auto_create_prospects === false
      && maps.MAPS_DISCOVERY_RATE_CONTROLS.live_provider_search_allowed === false
      && maps.MAPS_DISCOVERY_RATE_CONTROLS.dry_run_only === true,
  );

  const sample = readJson(SAMPLE_PLACES);
  ok('sample places has in-scope and out-of-scope', Array.isArray(sample.places) && sample.places.length >= 5);

  const somoPlace = sample.places.find((p) => p.place_id === 'ChIJfixture0001SomoSurfHouse');
  const normalized = maps.normalizeMapsPlace(somoPlace, { search_area: 'Somo, ES' });
  ok('normalize in-scope place ok', normalized && normalized.ok === true, JSON.stringify(normalized));
  ok('normalized proposal validates', contract.validateProposedProspect(normalized.proposal).ok === true);
  ok(
    'provenance preserves exact place_id',
    normalized.provenance
      && normalized.provenance.external_id === 'ChIJfixture0001SomoSurfHouse'
      && normalized.place_id === 'ChIJfixture0001SomoSurfHouse',
  );
  ok(
    'source_reference preserves place_id and search area',
    normalized.proposal.source_reference.external_id === 'ChIJfixture0001SomoSurfHouse'
      && normalized.proposal.source_reference.request_reference === 'Somo, ES'
      && normalized.proposal.source_reference.source_name === 'google_maps_dry_run',
  );
  ok('normalized is dry-run sample', normalized.dry_run === true && normalized.sample_data === true);
  ok('normalize does not create prospect', normalized.prospect_created !== true && normalized.auto_created !== true);

  const madrid = sample.places.find((p) => /Madrid/i.test(p.name || ''));
  const out = maps.normalizeMapsPlace(madrid, { search_area: 'Madrid, ES' });
  ok(
    'normalize rejects out-of-scope Madrid',
    out && out.ok === false && /northern_spain|out_of_scope/i.test((out.errors || []).join(' ')),
    JSON.stringify(out),
  );

  const criteriaSomo = readJson(path.join(FIXTURE_DIR, 'valid-criteria-somo.json'));
  const searched = maps.search(criteriaSomo);
  ok('search somo ok', searched && searched.ok === true && searched.dry_run === true);
  ok(
    'search returns candidates with place ids',
    searched
      && Array.isArray(searched.candidates)
      && searched.candidates.length >= 1
      && searched.candidates.every((c) => c.place_id && c.proposal && c.proposal.source_reference.external_id === c.place_id),
    JSON.stringify(searched && searched.candidates && searched.candidates.map((c) => c.place_id)),
  );
  ok(
    'search area preserved on result',
    searched && /Somo/i.test(searched.search_area || ''),
  );
  ok(
    'search discards out-of-scope fixtures',
    searched && Number(searched.discarded_out_of_scope_count) >= 1,
  );
  ok(
    'search never creates prospects',
    searched && searched.prospect_created !== true && searched.auto_created !== true,
  );

  const madridCriteria = readJson(path.join(FIXTURE_DIR, 'invalid-criteria-madrid.json'));
  const rejected = maps.search(madridCriteria);
  ok(
    'search rejects Madrid criteria scope',
    rejected && rejected.ok === false && /northern_spain|scope/i.test((rejected.errors || []).join(' ')),
    JSON.stringify(rejected),
  );

  const existing = [
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      canonical_name: 'Somo Surf House',
      website_url: 'https://www.somo-surf.example/stay',
    },
  ];
  const dedup = contract.previewDiscoveryDeduplication({
    proposal: normalized.proposal,
    existingProspects: existing,
  });
  ok('dedup preview ok via existing contract', dedup && dedup.ok === true && dedup.preview_only === true);
  ok(
    'dedup finds domain match for Maps candidate',
    dedup && Array.isArray(dedup.matches) && dedup.matches.some((m) => /domain/i.test(m.reason || m.match_type || '')),
    JSON.stringify(dedup),
  );
}

async function salesOrchestrationChecks() {
  console.log('\n▸ Sales orchestration: Maps preview + explicit import');
  delete require.cache[require.resolve(SALES_PATH)];
  delete require.cache[require.resolve(STORE_PATH)];
  delete require.cache[require.resolve(CONTRACT_PATH)];
  delete require.cache[require.resolve(MAPS_PATH)];
  const sales = require(SALES_PATH);

  ok('previewMapsDiscoverySearch is a function', typeof sales.previewMapsDiscoverySearch === 'function');
  ok('importMapsDiscoveryCandidate is a function', typeof sales.importMapsDiscoveryCandidate === 'function');

  await sales.resetSalesStore();

  const preview = await sales.previewMapsDiscoverySearch({
    city: 'Somo',
    country_code: 'ES',
    category: 'lodging',
    query: 'surf',
    market: 'northern_spain',
  });
  ok('previewMapsDiscoverySearch ok', preview && preview.ok === true, JSON.stringify(preview));
  ok('preview dry_run + sample_data', preview && preview.dry_run === true && preview.sample_data === true);
  ok('preview_only true', preview && preview.preview_only === true);
  ok('preview prospect_created false', preview && preview.prospect_created === false);
  ok(
    'preview disclaimer is sample/dry-run',
    preview && /sample|dry-run/i.test(preview.disclaimer || ''),
  );
  ok(
    'preview candidates include place_id + dedup',
    preview
      && Array.isArray(preview.candidates)
      && preview.candidates.length >= 1
      && preview.candidates.every((c) => c.place_id && c.dedup && c.dedup.preview_only === true),
  );

  const listedAfterPreview = await sales.listProspects();
  ok(
    'Maps preview did not create a prospect',
    Array.isArray(listedAfterPreview) && listedAfterPreview.length === 0,
    `count=${Array.isArray(listedAfterPreview) ? listedAfterPreview.length : 'n/a'}`,
  );

  const seed = await sales.createProspect({
    business_name: 'Existing Dedup Hostel',
    website_url: 'https://www.somo-surf.example/rooms',
  });
  ok('seed prospect for Maps dedup', seed && seed.ok === true);

  const previewDedup = await sales.previewMapsDiscoverySearch({
    city: 'Somo',
    country_code: 'ES',
    query: 'surf',
    market: 'northern_spain',
  });
  ok(
    'Maps preview reports dedup match',
    previewDedup
      && previewDedup.ok === true
      && previewDedup.candidates.some((c) => c.dedup && Array.isArray(c.dedup.matches) && c.dedup.matches.length >= 1),
    JSON.stringify(previewDedup && previewDedup.candidates && previewDedup.candidates.map((c) => c.dedup && c.dedup.matches)),
  );

  const imported = await sales.importMapsDiscoveryCandidate(
    {
      place_id: 'ChIJfixture0002SantanderHostel',
      search_area: 'Santander, ES',
    },
    'Earthling',
  );
  ok('explicit Maps import ok', imported && imported.ok === true && imported.prospect, JSON.stringify(imported));
  ok(
    'Maps import creates exactly via operator action',
    imported && imported.prospect_created === true && imported.auto_created === false,
  );
  ok(
    'imported Maps prospect preserves place provenance',
    imported
      && imported.place_id === 'ChIJfixture0002SantanderHostel'
      && imported.proposal
      && imported.proposal.source_reference.external_id === 'ChIJfixture0002SantanderHostel'
      && imported.proposal.source_reference.source_name === 'google_maps_dry_run',
  );

  const auditList = await sales.listAuditEvents(imported.prospect.id);
  ok(
    'Maps import appends discovery_proposal_imported audit',
    Array.isArray(auditList) && auditList.some((e) => e && e.action === 'discovery_proposal_imported'),
  );
  const importAudit = (auditList || []).find((e) => e && e.action === 'discovery_proposal_imported');
  ok(
    'audit detail includes place_id and dry_run',
    importAudit
      && importAudit.detail
      && importAudit.detail.place_id === 'ChIJfixture0002SantanderHostel'
      && importAudit.detail.dry_run === true,
    JSON.stringify(importAudit && importAudit.detail),
  );

  const badImport = await sales.importMapsDiscoveryCandidate({ place_id: 'not-a-fixture' }, 'Earthling');
  ok('unknown place_id import rejected', badImport && badImport.ok === false);

  const madridPreview = await sales.previewMapsDiscoverySearch({
    city: 'Madrid',
    country_code: 'ES',
    market: 'northern_spain',
  });
  ok('Madrid Maps preview rejected by scope', madridPreview && madridPreview.ok === false);
}

async function main() {
  console.log('verify:crowsnest-sales-maps-discovery — Luna Sales Chapter 8\n');

  structuralChecks();
  domainChecks();
  await salesOrchestrationChecks();

  await runScenario('1 Protected Maps dry-run UI + preview (no create)', BASE_PORT, {
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
      ok('login cookie for maps scenario', /crowsnest_session=/.test(cookie));

      const page = await request(port, '/sales/discovery', { headers: { Cookie: cookie } });
      ok('GET /sales/discovery => 200', page.statusCode === 200, `got ${page.statusCode}`);
      ok(
        'discovery page shows Maps dry-run section',
        /Google Maps discovery \(dry-run\)|maps-discovery-dry-run/i.test(page.body),
      );
      ok(
        'visible sample/dry-run data only copy',
        /sample\s*\/\s*dry-run data only|Sample \/ dry-run data only/i.test(page.body),
      );
      ok(
        'page forbids live HTTP/API key/SDK claims',
        /no live HTTP|API key|Google SDK|scraping/i.test(page.body),
      );

      const unauthPreview = await request(port, '/sales/discovery/maps/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'city=Somo&country_code=ES',
      });
      ok(
        'unauthenticated maps preview redirects to /login',
        unauthPreview.statusCode === 302 && String(unauthPreview.headers.location || '') === '/login',
      );

      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        await assertMethodRejected(port, '/sales/discovery/maps/preview', method, { Cookie: cookie }, 'POST');
      }

      const preview = await request(port, '/sales/discovery/maps/preview', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: [
          'city=Somo',
          'country_code=ES',
          'category=lodging',
          'query=surf',
          'market=northern_spain',
        ].join('&'),
      });
      ok(
        'maps preview returns 200 with sample candidates',
        preview.statusCode === 200
          && /Somo Surf House/i.test(preview.body)
          && /ChIJfixture0001SomoSurfHouse/i.test(preview.body)
          && /sample\s*\/\s*dry-run|dry-run data only/i.test(preview.body),
        `status=${preview.statusCode}`,
      );
      ok(
        'maps preview shows dedup section',
        /dedup|duplicate|match/i.test(preview.body),
      );
      ok(
        'maps preview shows search area / place id',
        /search area|place id/i.test(preview.body),
      );

      const list = await request(port, '/sales', { headers: { Cookie: cookie } });
      ok(
        'maps preview did not add prospect detail links to Sales list',
        !/href=["']\/sales\/prospects\/[a-zA-Z0-9_-]+["']/i.test(list.body),
      );

      const madrid = await request(port, '/sales/discovery/maps/preview', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'city=Madrid&country_code=ES&market=northern_spain',
      });
      ok(
        'Madrid maps preview shows scope error',
        madrid.statusCode === 400
          && /northern_spain|scope|outside/i.test(madrid.body),
        `status=${madrid.statusCode}`,
      );
    },
  ]);

  await runScenario('2 Explicit Maps dry-run import creates one prospect', BASE_PORT + 1, {
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
        await assertMethodRejected(port, '/sales/discovery/maps/import', method, { Cookie: cookie }, 'POST');
      }

      const unauthImport = await request(port, '/sales/discovery/maps/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'place_id=ChIJfixture0003ZarautzSurf&search_area=Zarautz%2C+ES',
      });
      ok(
        'unauthenticated maps import redirects to /login',
        unauthImport.statusCode === 302 && String(unauthImport.headers.location || '') === '/login',
      );

      const imported = await request(port, '/sales/discovery/maps/import', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: [
          'place_id=ChIJfixture0003ZarautzSurf',
          'search_area=Zarautz%2C+ES',
        ].join('&'),
      });
      ok(
        'explicit maps import redirects to prospect detail',
        imported.statusCode === 302
          && /\/sales\/prospects\/[a-zA-Z0-9_-]+/.test(String(imported.headers.location || '')),
        `status=${imported.statusCode} loc=${imported.headers.location}`,
      );

      const detailPath = String(imported.headers.location || '');
      const detail = await request(port, detailPath, { headers: { Cookie: cookie } });
      ok(
        'imported maps prospect detail visible',
        detail.statusCode === 200 && /Zarautz Surf Lodge/i.test(detail.body),
      );
      ok(
        'imported detail shows discovery import audit or dry-run source',
        /discovery_proposal_imported|google_maps_dry_run|dry_run|Zarautz/i.test(detail.body),
      );
      ok(
        'no live Maps completion claims after import',
        !/Maps discovery ran|Places API completed|live Google Maps fetch/i.test(detail.body),
      );
    },
  ]);

  console.log(`\n── verify:crowsnest-sales-maps-discovery: ${pass} passed, ${fail} failed ──`);
  if (fail === 0) {
    console.log('verify:crowsnest-sales-maps-discovery — ALL CHECKS PASSED');
  }
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  await stopServer();
  console.error(err);
  process.exit(1);
});
