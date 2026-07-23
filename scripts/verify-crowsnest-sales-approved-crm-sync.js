'use strict';

/**
 * Deterministic RED→GREEN verifier for Luna Sales approved CRM sync (code-safe slice).
 *
 * Provider-neutral approved-CRM-sync domain contract + isolated HubSpot v3
 * Company/Contact adapter with injected transport and recorded fixtures, plus
 * Sales orchestration / authenticated route / explicit UI control.
 *
 * Offline — no live DB, no Azure, no real HubSpot HTTP. Adapter transport is
 * always injected (fixtures/mocks). Runtime Service Key is read only through a
 * narrow config boundary at request time and must never appear in page/store/
 * audit/test output. No Deal creation, no automatic sync claims.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONTRACT_REL = 'scripts/lib/crowsnest/crowsnest-sales-approved-crm-sync-contract.js';
const ADAPTER_REL = 'scripts/lib/crowsnest/crowsnest-sales-hubspot-v3-adapter.js';
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);
const ADAPTER_PATH = path.join(ROOT, ADAPTER_REL);
const SALES_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-sales.js');
const STORE_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-sales-store.js');
const API_PATH = path.join(ROOT, 'scripts', 'crowsnest-api.js');
const PAGE_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-page.js');
const RUNTIME_CONFIG_REL = 'scripts/lib/crowsnest/crowsnest-hubspot-runtime-config.js';
const RUNTIME_CONFIG_PATH = path.join(ROOT, RUNTIME_CONFIG_REL);
const PKG_PATH = path.join(ROOT, 'package.json');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'crowsnest-sales-approved-crm-sync');
const VERIFY_SCRIPT_REL = 'scripts/verify-crowsnest-sales-approved-crm-sync.js';
const NPM_SCRIPT = 'verify:crowsnest-sales-approved-crm-sync';
const FAKE_SERVICE_KEY = 'TEST_HUBSPOT_SERVICE_KEY_MARKER_DO_NOT_LOG';

const FIXTURES = Object.freeze([
  'company-create-201.json',
  'contact-create-201.json',
  'company-create-401.json',
  'company-create-429.json',
]);

const PROSPECT_ID = '11111111-1111-4111-8111-111111111111';
const MARK_ID = '44444444-4444-4444-8444-444444444444';
const QUAL_ID = '22222222-2222-4222-8222-222222222222';
const EVIDENCE_ID = '33333333-3333-4333-8333-333333333333';
const FAKE_TOKEN = 'TEST_HUBSPOT_TOKEN_MARKER_DO_NOT_LOG';

let pass = 0;
let fail = 0;

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

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function collectStrings(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out);
    return out;
  }
  if (node != null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      out.push(key);
      collectStrings(value, out);
    }
  }
  return out;
}

function blobHasTokenLeak(value) {
  const blob = typeof value === 'string' ? value : JSON.stringify(value);
  return blob.includes(FAKE_TOKEN)
    || blob.includes(FAKE_SERVICE_KEY)
    || /pat-na1-[a-z0-9-]+/i.test(blob)
    || /Authorization["']?\s*:\s*["']?Bearer/i.test(blob)
    || /hubspot-service-key-super-secret/i.test(blob);
}

function baseProspect() {
  return {
    id: PROSPECT_ID,
    canonical_name: 'Somo Surf House',
    website_url: 'https://www.somo-surf.example/stay',
  };
}

function baseQualification(overrides = {}) {
  return {
    id: QUAL_ID,
    decision: 'qualified',
    rationale: 'Fits Northern Spain hostel pilot',
    evidence_ids: [EVIDENCE_ID],
    reviewer_id: 'Earthling',
    created_at: '2026-07-22T12:00:00.000Z',
    ...overrides,
  };
}

function baseMark(overrides = {}) {
  return {
    id: MARK_ID,
    prospect_id: PROSPECT_ID,
    qualification_assessment_id: QUAL_ID,
    reviewer_id: 'Earthling',
    created_at: '2026-07-22T13:00:00.000Z',
    ...overrides,
  };
}

function baseEligibleInput(overrides = {}) {
  return {
    prospect: baseProspect(),
    qualification: baseQualification(),
    crm_review_mark: baseMark(),
    operator_id: 'Earthling',
    operator_command: 'send_approved_crm_sync',
    contacts: [],
    ...overrides,
  };
}

console.log('verify:crowsnest-sales-approved-crm-sync — approved CRM sync contract + HubSpot v3 adapter\n');

console.log('▸ Structural');
ok('contract module path exists', fs.existsSync(CONTRACT_PATH), CONTRACT_REL);
ok('adapter module path exists', fs.existsSync(ADAPTER_PATH), ADAPTER_REL);
ok('fixture directory exists', fs.existsSync(FIXTURE_DIR));

const onDiskFixtures = fs.existsSync(FIXTURE_DIR)
  ? fs.readdirSync(FIXTURE_DIR).filter((n) => n.endsWith('.json')).sort()
  : [];
const declaredFixtures = FIXTURES.slice().sort();
ok(
  'fixture inventory matches declared set',
  declaredFixtures.length === onDiskFixtures.length
    && declaredFixtures.every((name, i) => name === onDiskFixtures[i]),
  `declared=[${declaredFixtures.join(',')}] disk=[${onDiskFixtures.join(',')}]`,
);
for (const name of FIXTURES) {
  const abs = path.join(FIXTURE_DIR, name);
  ok(`fixture exists ${name}`, fs.existsSync(abs));
  if (fs.existsSync(abs)) {
    try {
      readJson(abs);
      ok(`fixture parses ${name}`, true);
    } catch (err) {
      ok(`fixture parses ${name}`, false, String(err.message || err));
    }
  }
}

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
} catch {
  pkg = null;
}
ok('package.json parses', pkg != null);
ok(
  `package.json has ${NPM_SCRIPT}`,
  Boolean(pkg && pkg.scripts && typeof pkg.scripts[NPM_SCRIPT] === 'string'),
);
ok(
  'npm script points at this verifier',
  Boolean(
    pkg
    && pkg.scripts
    && String(pkg.scripts[NPM_SCRIPT] || '').includes(VERIFY_SCRIPT_REL),
  ),
);

const salesSrc = read(SALES_PATH) || '';
const storeSrc = read(STORE_PATH) || '';
const apiSrc = read(API_PATH) || '';
const pageSrc = read(PAGE_PATH) || '';
const contractSrc = read(CONTRACT_PATH) || '';
const adapterSrc = read(ADAPTER_PATH) || '';

ok(
  'sales domain still does not require hubspot adapter module',
  !/crowsnest-sales-hubspot-v3-adapter/.test(salesSrc)
    && !/require\(['"][^'"]*hubspot/i.test(salesSrc),
);
ok(
  'store does not require hubspot adapter',
  !/crowsnest-sales-hubspot-v3-adapter/.test(storeSrc)
    && !/HUBSPOT_[A-Z0-9_]+/.test(storeSrc),
);
ok(
  'api allowlists exact approved-crm-sync POST path',
  /matchSalesApprovedCrmSyncPath/.test(apiSrc)
    && /approved-crm-sync/.test(apiSrc)
    && /sendApprovedCrmSync|send_approved_crm_sync/.test(apiSrc),
);
ok(
  'api injects hubspot adapter (does not hard-code live HTTP)',
  /crowsnest-sales-hubspot-v3-adapter/.test(apiSrc)
    && /syncApprovedCrmToHubSpotV3/.test(apiSrc),
);
ok(
  'UI exposes explicit Send to HubSpot control copy',
  /Send to HubSpot/.test(pageSrc)
    && /creates\/updates a Company and optional Contacts/i.test(pageSrc)
    && /does not send outreach/i.test(pageSrc),
);
ok(
  'UI never claims automatic CRM sync / hubspot sync completed',
  !/hubspot sync completed|automatic CRM sync/i.test(pageSrc),
);
ok(
  'runtime HubSpot config boundary module exists',
  fs.existsSync(RUNTIME_CONFIG_PATH),
  RUNTIME_CONFIG_REL,
);
ok(
  'contract source does not read process.env HubSpot secrets',
  !/process\.env\.HUBSPOT_|HUBSPOT_[A-Z0-9_]+/.test(contractSrc),
);
ok(
  'adapter source does not read process.env for tokens',
  !/process\.env/.test(adapterSrc)
    || (
      !/process\.env\.HUBSPOT_/i.test(adapterSrc)
      && !/process\.env\[['\"]HUBSPOT_/i.test(adapterSrc)
    ),
);
ok(
  'adapter does not call global fetch without injection path',
  !/\bfetch\s*\(/.test(adapterSrc)
    || /fetchImpl|options\.fetch|deps\.fetch|transport/.test(adapterSrc),
);
ok('adapter mentions AbortController timeout', /AbortController/.test(adapterSrc));
ok('adapter forbids Deal creation path', /deals/i.test(adapterSrc) === false || /never.*deal|no deal|deal.*forbidden|forbid.*deal/i.test(adapterSrc));
ok(
  'adapter uses HubSpot CRM v3 companies/contacts paths',
  /\/crm\/v3\/objects\/companies/.test(adapterSrc)
    && /\/crm\/v3\/objects\/contacts/.test(adapterSrc),
);
ok(
  'adapter never posts to deals endpoint',
  !/\/crm\/v3\/objects\/deals/.test(adapterSrc),
);
ok(
  'idempotency does not use domain/name matching',
  !/idempotenc[^\n]{0,80}(domain|canonical_name|company\.name)/i.test(contractSrc)
    && !/match.*(domain|name).*idempotenc/i.test(contractSrc)
    && !/idempotenc.*(domain|name).*match/i.test(adapterSrc),
);

let contract = null;
let adapter = null;
let loadError = null;
try {
  if (fs.existsSync(CONTRACT_PATH)) {
    delete require.cache[require.resolve(CONTRACT_PATH)];
    contract = require(CONTRACT_PATH);
  }
  if (fs.existsSync(ADAPTER_PATH)) {
    delete require.cache[require.resolve(ADAPTER_PATH)];
    adapter = require(ADAPTER_PATH);
  }
} catch (err) {
  loadError = err;
}

ok('contract module loads', contract != null, loadError ? String(loadError.message || loadError) : 'missing');
ok('adapter module loads', adapter != null, loadError ? String(loadError.message || loadError) : 'missing');

ok(
  'exports assessApprovedCrmSyncEligibility',
  Boolean(contract && typeof contract.assessApprovedCrmSyncEligibility === 'function'),
);
ok(
  'exports buildApprovedCrmSyncIdempotencyKey',
  Boolean(contract && typeof contract.buildApprovedCrmSyncIdempotencyKey === 'function'),
);
ok(
  'exports buildApprovedCrmSyncCommand',
  Boolean(contract && typeof contract.buildApprovedCrmSyncCommand === 'function'),
);
ok(
  'exports APPROVED_CRM_SYNC_OPERATOR_COMMAND',
  Boolean(contract && contract.APPROVED_CRM_SYNC_OPERATOR_COMMAND === 'send_approved_crm_sync'),
);
ok(
  'exports syncApprovedCrmToHubSpotV3',
  Boolean(adapter && typeof adapter.syncApprovedCrmToHubSpotV3 === 'function'),
);
ok(
  'exports sanitizeHubSpotAdapterError',
  Boolean(adapter && typeof adapter.sanitizeHubSpotAdapterError === 'function'),
);

async function runDomainChecks() {
  console.log('\n▸ Domain contract: eligibility + idempotency + command');
  if (!contract) return;

  const assess = contract.assessApprovedCrmSyncEligibility;
  const buildKey = contract.buildApprovedCrmSyncIdempotencyKey;
  const buildCommand = contract.buildApprovedCrmSyncCommand;

  const missingCommand = assess(baseEligibleInput({ operator_command: null }));
  ok(
    'rejects missing operator command',
    missingCommand && missingCommand.ok === false && missingCommand.eligible === false,
    JSON.stringify(missingCommand),
  );

  const wrongCommand = assess(baseEligibleInput({ operator_command: 'preview_only' }));
  ok(
    'rejects non-explicit operator command',
    wrongCommand && wrongCommand.ok === false && wrongCommand.eligible === false,
  );

  const missingOperator = assess(baseEligibleInput({ operator_id: '' }));
  ok(
    'rejects missing operator identity',
    missingOperator && missingOperator.ok === false,
  );

  const notQualified = assess(baseEligibleInput({
    qualification: baseQualification({ decision: 'needs_more_research' }),
  }));
  ok(
    'rejects when not qualified',
    notQualified && notQualified.ok === false && notQualified.eligible === false,
  );

  const missingMark = assess(baseEligibleInput({ crm_review_mark: null }));
  ok(
    'rejects without CRM review mark',
    missingMark && missingMark.ok === false && missingMark.eligible === false,
  );

  const markMismatch = assess(baseEligibleInput({
    crm_review_mark: baseMark({ prospect_id: '00000000-0000-4000-8000-000000000099' }),
  }));
  ok(
    'rejects mark that does not belong to prospect',
    markMismatch && markMismatch.ok === false,
  );

  const eligible = assess(baseEligibleInput());
  ok(
    'accepts qualified + crm-ready + explicit command',
    eligible && eligible.ok === true && eligible.eligible === true,
    JSON.stringify(eligible),
  );

  const keyA = buildKey({
    prospect_id: PROSPECT_ID,
    crm_review_mark_id: MARK_ID,
  });
  const keyB = buildKey({
    prospectId: PROSPECT_ID,
    crmReviewMarkId: MARK_ID,
  });
  ok('idempotency key is non-empty string', typeof keyA === 'string' && keyA.length >= 16, keyA);
  ok('idempotency key stable across naming styles', keyA === keyB, `${keyA} vs ${keyB}`);
  ok(
    'idempotency key embeds neither domain nor company name',
    !/somo-surf|Somo Surf/i.test(keyA),
  );

  const keyOtherMark = buildKey({
    prospect_id: PROSPECT_ID,
    crm_review_mark_id: '55555555-5555-4555-8555-555555555555',
  });
  ok('new review mark yields different idempotency key', keyA !== keyOtherMark);

  const keyOtherProspect = buildKey({
    prospect_id: '99999999-9999-4999-8999-999999999999',
    crm_review_mark_id: MARK_ID,
  });
  ok('different prospect yields different idempotency key', keyA !== keyOtherProspect);

  const domainOnly = buildKey({
    prospect_id: '',
    crm_review_mark_id: '',
    domain: 'somo-surf.example',
    company_name: 'Somo Surf House',
  });
  ok(
    'domain/name alone cannot produce a valid idempotency key',
    !domainOnly || domainOnly.ok === false || domainOnly === '' || (domainOnly && domainOnly.error),
    JSON.stringify(domainOnly),
  );

  const blockedCommand = buildCommand(baseEligibleInput({
    qualification: baseQualification({ decision: 'not_qualified' }),
  }));
  ok('buildCommand fails when ineligible', blockedCommand && blockedCommand.ok === false);

  const commandOk = buildCommand(baseEligibleInput({
    contacts: [{ full_name: 'Ada Owner', email: 'ada@somo-surf.example', role: 'Owner' }],
  }));
  ok('buildCommand succeeds when eligible', commandOk && commandOk.ok === true && commandOk.command, JSON.stringify(commandOk));
  const cmd = commandOk && commandOk.command;
  ok('command schema_version present', cmd && typeof cmd.schema_version === 'string' && /approved_crm_sync/.test(cmd.schema_version));
  ok('command records explicit operator command', cmd && cmd.operator_command === 'send_approved_crm_sync');
  ok('command records operator_id', cmd && cmd.operator_id === 'Earthling');
  ok('command carries idempotency_key', cmd && cmd.idempotency_key === keyA);
  ok('command has one Company', cmd && cmd.company && cmd.company.name === 'Somo Surf House');
  ok('command Company lifecycle Lead', cmd && cmd.company.lifecycle_stage === 'Lead');
  ok(
    'command Company Luna Sales Status Qualified Prospect',
    cmd
      && cmd.company.properties
      && cmd.company.properties['Luna Sales Status'] === 'Qualified Prospect',
  );
  ok(
    'command correlation uses prospect id property (not domain match)',
    cmd
      && cmd.company.correlation
      && cmd.company.correlation.crowsnest_sales_prospect_id === PROSPECT_ID,
  );
  ok('command has optional Contacts', cmd && Array.isArray(cmd.contacts) && cmd.contacts.length === 1);
  ok('command Deal is null', cmd && cmd.deal === null);
  ok('command automatic flag false', cmd && cmd.automatic === false);
  ok('command does not claim already synced', cmd && cmd.record_sent !== true && cmd.synced !== true);
  ok(
    'command does not embed HubSpot token fields',
    cmd && !blobHasTokenLeak(cmd) && cmd.access_token == null && cmd.token == null,
  );
}

async function runAdapterChecks() {
  console.log('\n▸ HubSpot v3 adapter: injected transport + fixtures');
  if (!adapter || !contract) return;

  const buildCommand = contract.buildApprovedCrmSyncCommand;
  const sync = adapter.syncApprovedCrmToHubSpotV3;
  const sanitize = adapter.sanitizeHubSpotAdapterError;

  const company201 = readJson(path.join(FIXTURE_DIR, 'company-create-201.json'));
  const contact201 = readJson(path.join(FIXTURE_DIR, 'contact-create-201.json'));
  const company401 = readJson(path.join(FIXTURE_DIR, 'company-create-401.json'));
  const company429 = readJson(path.join(FIXTURE_DIR, 'company-create-429.json'));

  const commandResult = buildCommand(baseEligibleInput({
    contacts: [{ full_name: 'Ada Owner', email: 'ada@somo-surf.example', role: 'Owner' }],
  }));
  ok('adapter checks use a valid domain command', commandResult && commandResult.ok === true);
  if (!(commandResult && commandResult.ok)) return;
  const command = commandResult.command;

  const missingFetch = await sync({
    command,
    accessToken: FAKE_TOKEN,
  });
  ok(
    'adapter requires injected fetch',
    missingFetch && missingFetch.ok === false && /fetch|transport/i.test(missingFetch.error || missingFetch.code || ''),
    JSON.stringify(missingFetch),
  );
  ok('missing-fetch error does not leak token', missingFetch && !blobHasTokenLeak(missingFetch));

  const calls = [];
  const successFetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: String((options && options.method) || 'GET').toUpperCase(),
      headers: { ...((options && options.headers) || {}) },
      body: options && options.body != null ? String(options.body) : null,
      signal: options && options.signal,
    });
    const href = String(url);
    if (/\/crm\/v3\/objects\/companies\b/.test(href) && !/\/crm\/v3\/objects\/companies\//.test(href)) {
      return {
        ok: true,
        status: 201,
        async json() { return deepClone(company201); },
        async text() { return JSON.stringify(company201); },
      };
    }
    if (/\/crm\/v3\/objects\/contacts\b/.test(href)) {
      return {
        ok: true,
        status: 201,
        async json() { return deepClone(contact201); },
        async text() { return JSON.stringify(contact201); },
      };
    }
    return {
      ok: false,
      status: 500,
      async json() { return { status: 'error', message: 'unexpected path ' + href }; },
      async text() { return 'unexpected'; },
    };
  };

  const synced = await sync({
    command,
    accessToken: FAKE_TOKEN,
    fetch: successFetch,
    timeoutMs: 2500,
  });
  ok('sync succeeds with fixture transport', synced && synced.ok === true, JSON.stringify(synced));
  ok(
    'sync returns company provider id only',
    synced
      && synced.result
      && synced.result.company
      && synced.result.company.provider === 'hubspot'
      && synced.result.company.object_kind === 'company'
      && synced.result.company.provider_object_id === '451001',
  );
  ok(
    'sync returns contact provider id',
    synced
      && synced.result
      && Array.isArray(synced.result.contacts)
      && synced.result.contacts[0]
      && synced.result.contacts[0].provider_object_id === '902001',
  );
  ok('sync result deal is null', synced && synced.result && synced.result.deal === null);
  ok('sync preserves idempotency key', synced && synced.result && synced.result.idempotency_key === command.idempotency_key);
  ok('sync preserves review mark id', synced && synced.result && synced.result.crm_review_mark_id === MARK_ID);
  ok('success result does not leak token', synced && !blobHasTokenLeak(synced));
  ok(
    'success result does not embed raw provider payload',
    synced
      && synced.result
      && synced.result.raw == null
      && synced.result.response == null
      && synced.result.provider_response == null
      && !collectStrings(synced).some((s) => s === 'correlationId' || s === 'createdAt'),
  );

  ok('transport called at least once', calls.length >= 1);
  const companyCall = calls.find((c) => /\/crm\/v3\/objects\/companies/.test(c.url));
  const contactCall = calls.find((c) => /\/crm\/v3\/objects\/contacts/.test(c.url));
  ok('posted Company to HubSpot v3', Boolean(companyCall) && companyCall.method === 'POST');
  ok('posted Contact to HubSpot v3', Boolean(contactCall) && contactCall.method === 'POST');
  ok(
    'no Deal endpoint called',
    calls.every((c) => !/\/crm\/v3\/objects\/deals/.test(c.url)),
  );
  ok(
    'no domain/name search used for idempotency',
    calls.every((c) => !/\/search/.test(c.url) && !/domain=/i.test(c.url)),
  );

  let companyBody = null;
  try {
    companyBody = companyCall ? JSON.parse(companyCall.body) : null;
  } catch {
    companyBody = null;
  }
  ok(
    'Company request maps name + lifecycle lead',
    companyBody
      && companyBody.properties
      && companyBody.properties.name === 'Somo Surf House'
      && String(companyBody.properties.lifecyclestage || '').toLowerCase() === 'lead',
  );
  ok(
    'Company request sets crowsnest_sales_prospect_id correlation',
    companyBody
      && companyBody.properties
      && companyBody.properties.crowsnest_sales_prospect_id === PROSPECT_ID,
  );
  ok(
    'Company request Authorization uses bearer token (transport only)',
    companyCall
      && /Bearer\s+TEST_HUBSPOT_TOKEN_MARKER_DO_NOT_LOG/i.test(String(
        companyCall.headers.Authorization
        || companyCall.headers.authorization
        || '',
      )),
  );
  ok(
    'Company request uses AbortController signal',
    companyCall && companyCall.signal != null,
  );

  // Company only (no contacts)
  const companyOnlyCmd = buildCommand(baseEligibleInput({ contacts: [] }));
  const companyOnlyCalls = [];
  const companyOnly = await sync({
    command: companyOnlyCmd.command,
    accessToken: FAKE_TOKEN,
    fetch: async (url, options = {}) => {
      companyOnlyCalls.push(String(url));
      return {
        ok: true,
        status: 201,
        async json() { return deepClone(company201); },
        async text() { return JSON.stringify(company201); },
      };
    },
  });
  ok('company-only sync ok', companyOnly && companyOnly.ok === true);
  ok(
    'company-only does not call contacts endpoint',
    companyOnlyCalls.every((u) => !/\/crm\/v3\/objects\/contacts/.test(u)),
  );
  ok(
    'company-only contacts array empty',
    companyOnly
      && companyOnly.result
      && Array.isArray(companyOnly.result.contacts)
      && companyOnly.result.contacts.length === 0,
  );

  // Auth failure sanitization
  const authFail = await sync({
    command,
    accessToken: FAKE_TOKEN,
    fetch: async () => ({
      ok: false,
      status: 401,
      async json() { return deepClone(company401); },
      async text() { return JSON.stringify(company401); },
    }),
  });
  ok('401 maps to sanitized failure', authFail && authFail.ok === false);
  ok(
    '401 sanitized error has category, no raw message token leak',
    authFail
      && (authFail.code || authFail.error_category)
      && !blobHasTokenLeak(authFail)
      && !/leaked-pat-SHOULD-NEVER-APPEAR/i.test(JSON.stringify(authFail))
      && !/Authentication credentials not found/i.test(JSON.stringify(authFail)),
  );

  const rateFail = await sync({
    command,
    accessToken: FAKE_TOKEN,
    fetch: async () => ({
      ok: false,
      status: 429,
      async json() { return deepClone(company429); },
      async text() { return JSON.stringify(company429); },
    }),
  });
  ok('429 maps to sanitized rate-limit failure', rateFail && rateFail.ok === false);
  ok('429 result does not leak token/raw', rateFail && !blobHasTokenLeak(rateFail));

  // Timeout path
  const timeoutResult = await sync({
    command,
    accessToken: FAKE_TOKEN,
    timeoutMs: 30,
    fetch: async (_url, options = {}) => {
      const signal = options.signal;
      return new Promise((resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    },
  });
  ok('timeout/abort becomes sanitized failure', timeoutResult && timeoutResult.ok === false);
  ok(
    'timeout error sanitized (no token)',
    timeoutResult
      && !blobHasTokenLeak(timeoutResult)
      && /timeout|abort/i.test(String(timeoutResult.code || timeoutResult.error_category || timeoutResult.error || '')),
  );

  // sanitize helper directly
  const sanitized = sanitize(
    new Error(`boom ${FAKE_TOKEN} ${JSON.stringify(company401)}`),
    { accessToken: FAKE_TOKEN, status: 500 },
  );
  ok('sanitizeHubSpotAdapterError returns ok:false', sanitized && sanitized.ok === false);
  ok('sanitizeHubSpotAdapterError strips token', sanitized && !blobHasTokenLeak(sanitized));
  ok(
    'sanitizeHubSpotAdapterError strips raw provider message',
    sanitized && !/Authentication credentials not found/i.test(JSON.stringify(sanitized)),
  );

  // Refuse automatic / missing command shape
  const autoRejected = await sync({
    command: { ...command, automatic: true },
    accessToken: FAKE_TOKEN,
    fetch: successFetch,
  });
  ok(
    'adapter rejects automatic:true command',
    autoRejected && autoRejected.ok === false,
    JSON.stringify(autoRejected),
  );

  const dealRejected = await sync({
    command: { ...command, deal: { name: 'should-not-send' } },
    accessToken: FAKE_TOKEN,
    fetch: successFetch,
  });
  ok(
    'adapter rejects command that includes a Deal',
    dealRejected && dealRejected.ok === false,
  );
}

async function seedEligibleProspect(repo, overrides = {}) {
  const prospect = {
    id: PROSPECT_ID,
    canonical_name: 'Somo Surf House',
    website_url: 'https://www.somo-surf.example/stay',
    lifecycle_status: 'ready_for_review',
    created_at: '2026-07-22T11:00:00.000Z',
    updated_at: '2026-07-22T11:00:00.000Z',
    ...overrides.prospect,
  };
  await repo.createProspectRecord(prospect);
  const qualification = baseQualification(overrides.qualification || {});
  await repo.saveQualificationAssessment({
    ...qualification,
    prospect_id: prospect.id,
  });
  const mark = baseMark(overrides.mark || {});
  await repo.saveCrmReviewMark(mark);
  if (Array.isArray(overrides.contacts)) {
    for (const contact of overrides.contacts) {
      await repo.saveContactCandidate({
        id: contact.id || '77777777-7777-4777-8777-777777777777',
        prospect_id: prospect.id,
        full_name: contact.full_name,
        email: contact.email || '',
        role: contact.role || '',
        confidence: 'high',
        created_at: '2026-07-22T13:30:00.000Z',
      });
    }
  }
  return { prospect, qualification, mark };
}

async function runOrchestrationChecks() {
  console.log('\n▸ Sales orchestration: pending attempt + injected adapter + audit');
  delete require.cache[require.resolve(SALES_PATH)];
  delete require.cache[require.resolve(STORE_PATH)];
  let sales = null;
  let store = null;
  try {
    store = require(STORE_PATH);
    sales = require(SALES_PATH);
  } catch (err) {
    ok('sales + store modules load for orchestration', false, String(err && err.message));
    return;
  }
  ok('sales + store modules load for orchestration', true);
  ok(
    'sales exports sendApprovedCrmSync',
    sales && typeof sales.sendApprovedCrmSync === 'function',
  );
  if (!sales || typeof sales.sendApprovedCrmSync !== 'function') return;

  const repo = store.createMemorySalesRepository();
  await seedEligibleProspect(repo, {
    contacts: [{ full_name: 'Ada Owner', email: 'ada@somo-surf.example', role: 'Owner' }],
  });
  sales._setSalesRepositoryForTests(repo);

  let adapterCalls = 0;
  const successAdapter = async () => {
    adapterCalls += 1;
    return {
      ok: true,
      result: {
        provider: 'hubspot',
        status: 'synced',
        company: { provider: 'hubspot', object_kind: 'company', provider_object_id: 'hs-co-1001' },
        contacts: [
          { provider: 'hubspot', object_kind: 'contact', provider_object_id: 'hs-ct-2002' },
        ],
        deal: null,
      },
    };
  };

  const order = [];
  const trackingRepo = {
    ...repo,
    async saveApprovedCrmSyncAttempt(input) {
      order.push('save_pending');
      return repo.saveApprovedCrmSyncAttempt(input);
    },
    async updateApprovedCrmSyncAttemptOutcome(id, patch) {
      order.push(`update_${patch && patch.status}`);
      return repo.updateApprovedCrmSyncAttemptOutcome(id, patch);
    },
  };
  sales._setSalesRepositoryForTests(trackingRepo);

  const trackingAdapter = async (...args) => {
    order.push('adapter');
    return successAdapter(...args);
  };

  const first = await sales.sendApprovedCrmSync(PROSPECT_ID, 'Earthling', {
    operatorCommand: 'send_approved_crm_sync',
    syncAdapter: trackingAdapter,
    accessToken: FAKE_SERVICE_KEY,
    fetch: async () => {
      throw new Error('global fetch must not be used');
    },
  });
  ok(
    'eligible explicit command succeeds',
    first && first.ok === true && first.attempt && first.attempt.status === 'succeeded',
    JSON.stringify(first && { ok: first.ok, status: first.attempt && first.attempt.status }),
  );
  ok(
    'pending attempt saved before adapter execution',
    order[0] === 'save_pending' && order.includes('adapter') && order.indexOf('save_pending') < order.indexOf('adapter'),
    JSON.stringify(order),
  );
  ok(
    'success stores only confirmed Company/Contact IDs',
    first
      && first.attempt
      && first.attempt.provider_company_id === 'hs-co-1001'
      && Array.isArray(first.attempt.provider_contact_ids)
      && first.attempt.provider_contact_ids.includes('hs-ct-2002')
      && first.attempt.error_category === '',
  );
  ok('success outcome has no secret/token leak', first && !blobHasTokenLeak(first));
  ok('adapter invoked once for first send', adapterCalls === 1, `calls=${adapterCalls}`);

  const auditsAfterSuccess = await trackingRepo.listAuditEvents(PROSPECT_ID);
  const auditBlob = JSON.stringify(auditsAfterSuccess);
  ok(
    'audit records safe approved CRM sync events',
    Array.isArray(auditsAfterSuccess)
      && auditsAfterSuccess.some((e) => /approved_crm_sync/i.test(String(e.action || ''))),
    auditBlob.slice(0, 400),
  );
  ok(
    'audit has no Service Key / token / raw provider payload / email',
    !blobHasTokenLeak(auditsAfterSuccess)
      && !/ada@somo-surf\.example/i.test(auditBlob)
      && !/"headers"/i.test(auditBlob)
      && !/Authentication credentials not found/i.test(auditBlob),
  );

  adapterCalls = 0;
  const replay = await sales.sendApprovedCrmSync(PROSPECT_ID, 'Earthling', {
    operatorCommand: 'send_approved_crm_sync',
    syncAdapter: successAdapter,
    accessToken: FAKE_SERVICE_KEY,
  });
  ok(
    'same idempotency key returns prior durable attempt',
    replay
      && replay.ok === true
      && (replay.idempotent_replay === true || (replay.attempt && replay.attempt.id === first.attempt.id))
      && replay.attempt
      && replay.attempt.provider_company_id === 'hs-co-1001',
    JSON.stringify(replay && { ok: replay.ok, id: replay.attempt && replay.attempt.id }),
  );
  ok('idempotent replay does not call adapter again', adapterCalls === 0, `calls=${adapterCalls}`);

  // Ineligible: not qualified
  const ineligibleRepo = store.createMemorySalesRepository();
  await seedEligibleProspect(ineligibleRepo, {
    qualification: { decision: 'not_qualified' },
  });
  sales._setSalesRepositoryForTests(ineligibleRepo);
  let ineligibleAdapterCalls = 0;
  const blocked = await sales.sendApprovedCrmSync(PROSPECT_ID, 'Earthling', {
    operatorCommand: 'send_approved_crm_sync',
    syncAdapter: async () => {
      ineligibleAdapterCalls += 1;
      return { ok: true, result: { company: { provider_object_id: 'should-not' }, contacts: [] } };
    },
    accessToken: FAKE_SERVICE_KEY,
  });
  ok(
    'ineligible prospect cannot invoke adapter',
    blocked && blocked.ok === false && ineligibleAdapterCalls === 0,
    JSON.stringify(blocked),
  );

  // Missing explicit command
  const eligibleRepo2 = store.createMemorySalesRepository();
  await seedEligibleProspect(eligibleRepo2);
  sales._setSalesRepositoryForTests(eligibleRepo2);
  let missingCmdCalls = 0;
  const missingCmd = await sales.sendApprovedCrmSync(PROSPECT_ID, 'Earthling', {
    operatorCommand: '',
    syncAdapter: async () => {
      missingCmdCalls += 1;
      return { ok: true, result: { company: { provider_object_id: 'x' }, contacts: [] } };
    },
    accessToken: FAKE_SERVICE_KEY,
  });
  ok(
    'missing explicit operator command cannot invoke adapter',
    missingCmd && missingCmd.ok === false && missingCmdCalls === 0,
    JSON.stringify(missingCmd),
  );

  // Adapter failure → sanitized category only
  const failRepo = store.createMemorySalesRepository();
  await seedEligibleProspect(failRepo);
  sales._setSalesRepositoryForTests(failRepo);
  const failed = await sales.sendApprovedCrmSync(PROSPECT_ID, 'Earthling', {
    operatorCommand: 'send_approved_crm_sync',
    syncAdapter: async () => ({
      ok: false,
      status: 401,
      code: 'auth_failed',
      error_category: 'auth_failed',
      error: 'HubSpot authentication failed.',
      raw: { message: 'Authentication credentials not found', token: FAKE_SERVICE_KEY },
    }),
    accessToken: FAKE_SERVICE_KEY,
  });
  ok(
    'adapter failure stores failed status + sanitized category only',
    failed
      && failed.ok === false
      && failed.attempt
      && failed.attempt.status === 'failed'
      && failed.attempt.error_category === 'auth_failed'
      && !failed.attempt.provider_company_id
      && !blobHasTokenLeak(failed)
      && !/Authentication credentials not found/i.test(JSON.stringify(failed)),
    JSON.stringify(failed),
  );

  // Absent Service Key → no outbound adapter call
  const unconfiguredRepo = store.createMemorySalesRepository();
  await seedEligibleProspect(unconfiguredRepo);
  sales._setSalesRepositoryForTests(unconfiguredRepo);
  let unconfiguredCalls = 0;
  const unconfigured = await sales.sendApprovedCrmSync(PROSPECT_ID, 'Earthling', {
    operatorCommand: 'send_approved_crm_sync',
    syncAdapter: async () => {
      unconfiguredCalls += 1;
      return { ok: true, result: { company: { provider_object_id: 'nope' }, contacts: [] } };
    },
    accessToken: '',
    hubspotConfigured: false,
  });
  ok(
    'absent HubSpot configuration returns safe unavailable without adapter call',
    unconfigured
      && unconfigured.ok === false
      && unconfiguredCalls === 0
      && !blobHasTokenLeak(unconfigured)
      && /unavail|configur/i.test(String(unconfigured.error || unconfigured.code || '')),
    JSON.stringify(unconfigured),
  );

  sales._setSalesRepositoryForTests(null);
}

async function runRuntimeConfigChecks() {
  console.log('\n▸ Runtime config boundary: HUBSPOT_SERVICE_KEY');
  ok('runtime config module path exists', fs.existsSync(RUNTIME_CONFIG_PATH), RUNTIME_CONFIG_REL);
  if (!fs.existsSync(RUNTIME_CONFIG_PATH)) return;

  delete require.cache[require.resolve(RUNTIME_CONFIG_PATH)];
  let runtime = null;
  try {
    runtime = require(RUNTIME_CONFIG_PATH);
  } catch (err) {
    ok('runtime config module loads', false, String(err && err.message));
    return;
  }
  ok('runtime config module loads', true);
  ok(
    'exports resolveHubSpotServiceKeyAccess',
    runtime && typeof runtime.resolveHubSpotServiceKeyAccess === 'function',
  );
  if (!runtime || typeof runtime.resolveHubSpotServiceKeyAccess !== 'function') return;

  const missing = runtime.resolveHubSpotServiceKeyAccess({ HUBSPOT_SERVICE_KEY: '' });
  ok(
    'absent key => not configured / safe',
    missing && missing.ok === false && missing.configured === false && !blobHasTokenLeak(missing),
    JSON.stringify(missing),
  );
  ok('absent key does not expose accessToken', missing && missing.accessToken == null && missing.token == null);

  const present = runtime.resolveHubSpotServiceKeyAccess({ HUBSPOT_SERVICE_KEY: FAKE_SERVICE_KEY });
  ok(
    'present key => configured with access token for injection only',
    present && present.ok === true && present.configured === true && present.accessToken === FAKE_SERVICE_KEY,
  );

  const runtimeSrc = read(RUNTIME_CONFIG_PATH) || '';
  ok(
    'runtime config does not log or stringify the key',
    !/console\.(log|info|debug|error|warn)\([^)]*HUBSPOT_SERVICE_KEY/.test(runtimeSrc),
  );
  ok(
    'page/store sources do not read HUBSPOT_SERVICE_KEY',
    !/HUBSPOT_SERVICE_KEY/.test(pageSrc) && !/HUBSPOT_SERVICE_KEY/.test(storeSrc),
  );
  ok(
    'api may read runtime config but must not embed key into HTML helpers',
    /resolveHubSpotServiceKeyAccess|crowsnest-hubspot-runtime-config/.test(apiSrc)
      && !/HUBSPOT_SERVICE_KEY/.test(pageSrc),
  );
}

async function runUiEligibilityChecks() {
  console.log('\n▸ UI: Send to HubSpot only when eligible');
  delete require.cache[require.resolve(PAGE_PATH)];
  let page = null;
  try {
    page = require(PAGE_PATH);
  } catch (err) {
    ok('page module loads for UI checks', false, String(err && err.message));
    return;
  }
  ok('page module loads for UI checks', true);
  if (!page || typeof page.renderCrowsnestPage !== 'function') return;

  const prospect = baseProspect();
  const qualification = baseQualification();
  const mark = baseMark();
  const preview = {
    preview_only: true,
    record_sent: false,
    disclaimer: 'Preview only — no CRM record has been sent.',
    company: {
      name: 'Somo Surf House',
      website_url: 'https://www.somo-surf.example/stay',
      domain: 'somo-surf.example',
      lifecycle_stage: 'Lead',
      properties: { 'Luna Sales Status': 'Qualified Prospect' },
    },
    contacts: [],
    deal: null,
    traceability: {
      decision: 'qualified',
      rationale: 'Fits',
      qualification_assessment_id: QUAL_ID,
      evidence_ids: [EVIDENCE_ID],
    },
  };

  const eligibleHtml = page.renderCrowsnestPage({
    view: 'sales_crm_preview',
    prospect,
    qualification,
    latestCrmReviewMark: mark,
    crmPreview: preview,
    approvedCrmSyncEligible: true,
    approvedCrmSyncAttempt: null,
  });
  ok(
    'eligible CRM preview shows Send to HubSpot control',
    /Send to HubSpot/.test(eligibleHtml)
      && /approved-crm-sync/.test(eligibleHtml)
      && /method=["']post["']/i.test(eligibleHtml),
  );
  ok(
    'eligible control explains Company/Contacts and no outreach',
    /creates\/updates a Company and optional Contacts/i.test(eligibleHtml)
      && /does not send outreach/i.test(eligibleHtml),
  );
  ok(
    'eligible preview still keeps preview-only mapping claim',
    /Preview only/i.test(eligibleHtml) && /no CRM record has been sent/i.test(eligibleHtml),
  );
  ok('eligible HTML has no Service Key leak', !blobHasTokenLeak(eligibleHtml));

  const ineligibleHtml = page.renderCrowsnestPage({
    view: 'sales_crm_preview',
    prospect,
    qualification: baseQualification({ decision: 'not_qualified' }),
    latestCrmReviewMark: null,
    crmPreview: preview,
    approvedCrmSyncEligible: false,
  });
  ok(
    'ineligible CRM preview has no Send to HubSpot control',
    !/Send to HubSpot/i.test(ineligibleHtml)
      && !/action=["'][^"']*approved-crm-sync["']/i.test(ineligibleHtml),
  );

  const detailIneligible = page.renderCrowsnestPage({
    view: 'sales_detail',
    prospect,
    researchJobs: [],
    qualificationAssessments: [],
    latestQualification: null,
    latestCrmReviewMark: null,
    approvedCrmSyncEligible: false,
  });
  ok(
    'ineligible prospect detail has no Send to HubSpot control',
    !/Send to HubSpot/i.test(detailIneligible),
  );

  const pendingHtml = page.renderCrowsnestPage({
    view: 'sales_crm_preview',
    prospect,
    qualification,
    latestCrmReviewMark: mark,
    crmPreview: preview,
    approvedCrmSyncEligible: true,
    approvedCrmSyncAttempt: {
      status: 'pending',
      provider_company_id: '',
      provider_contact_ids: [],
      error_category: '',
    },
  });
  ok(
    'pending attempt status does not claim success',
    /pending/i.test(pendingHtml)
      && !/sent to HubSpot successfully|sync succeeded|HubSpot Company ID/i.test(pendingHtml),
  );

  const successHtml = page.renderCrowsnestPage({
    view: 'sales_crm_preview',
    prospect,
    qualification,
    latestCrmReviewMark: mark,
    crmPreview: preview,
    approvedCrmSyncEligible: true,
    approvedCrmSyncAttempt: {
      status: 'succeeded',
      provider_company_id: 'hs-co-1001',
      provider_contact_ids: ['hs-ct-2002'],
      error_category: '',
    },
  });
  ok(
    'succeeded status shows confirmed provider IDs only after success',
    /hs-co-1001/.test(successHtml) && /succeeded/i.test(successHtml),
  );
  ok('success HTML has no secret leak', !blobHasTokenLeak(successHtml));

  const failedHtml = page.renderCrowsnestPage({
    view: 'sales_crm_preview',
    prospect,
    qualification,
    latestCrmReviewMark: mark,
    crmPreview: preview,
    approvedCrmSyncEligible: true,
    approvedCrmSyncAttempt: {
      status: 'failed',
      provider_company_id: '',
      provider_contact_ids: [],
      error_category: 'auth_failed',
    },
  });
  ok(
    'failed status shows sanitized category without claiming success',
    /failed/i.test(failedHtml)
      && /auth_failed/.test(failedHtml)
      && !/sent to HubSpot successfully/i.test(failedHtml)
      && !blobHasTokenLeak(failedHtml),
  );
}

async function main() {
  await runDomainChecks();
  await runAdapterChecks();
  await runOrchestrationChecks();
  await runRuntimeConfigChecks();
  await runUiEligibilityChecks();

  console.log(`\n── verify:crowsnest-sales-approved-crm-sync: ${pass} passed, ${fail} failed ──`);
  if (fail) {
    console.log('verify:crowsnest-sales-approved-crm-sync — FAILED');
    process.exitCode = 1;
    return;
  }
  console.log('verify:crowsnest-sales-approved-crm-sync — ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
