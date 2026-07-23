'use strict';

/**
 * Deterministic RED→GREEN verifier for durable approved CRM sync attempt records.
 *
 * Offline only — migration/repository primitives + orchestration persistence
 * expectations. No live DB apply, no Azure, no live HubSpot HTTP. Adapter calls
 * use injected fixtures/mocks only. No Deal creation, no background sync.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE_REL = 'scripts/lib/crowsnest/crowsnest-sales-store.js';
const STORE_PATH = path.join(ROOT, STORE_REL);
const SALES_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-sales.js');
const API_PATH = path.join(ROOT, 'scripts', 'crowsnest-api.js');
const PAGE_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-page.js');
const MIGRATION_049_REL = 'database/migrations/049_luna_sales_approved_crm_sync_attempts.sql';
const MIGRATION_049_PATH = path.join(ROOT, MIGRATION_049_REL);
const MIGRATION_047_PATH = path.join(ROOT, 'database', 'migrations', '047_luna_sales_contact_candidates.sql');
const MIGRATION_048_PATH = path.join(
  ROOT,
  'database',
  'migrations',
  '048_crowsnest_metrics_client_metrics_snapshots.sql',
);
const PKG_PATH = path.join(ROOT, 'package.json');
const MANIFEST_PATH = path.join(ROOT, 'database', 'migrations', 'canonical-manifest.json');
const NPM_SCRIPT = 'verify:crowsnest-sales-approved-crm-sync-attempts';

const {
  sha256CanonicalLfV1File,
  forwardEntries,
  loadManifest,
} = require('./lib/migration-integrity');

const PROSPECT_ID = '11111111-1111-4111-8111-111111111111';
const MARK_ID = '44444444-4444-4444-8444-444444444444';
const ATTEMPT_ID = '55555555-5555-4555-8555-555555555555';
const IDEMPOTENCY_KEY = 'acs_v1_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const FAKE_TOKEN = 'TEST_HUBSPOT_TOKEN_MARKER_DO_NOT_LOG';
const FAKE_SERVICE_KEY = 'TEST_HUBSPOT_SERVICE_KEY_MARKER_DO_NOT_LOG';

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

function blobHasSecretLeak(value) {
  const blob = typeof value === 'string' ? value : JSON.stringify(value);
  return blob.includes(FAKE_TOKEN)
    || blob.includes(FAKE_SERVICE_KEY)
    || /pat-na1-[a-z0-9-]+/i.test(blob)
    || /Authorization["']?\s*:\s*["']?Bearer/i.test(blob)
    || /hubspot-service-key-super-secret/i.test(blob)
    || /postgres:\/\/[^"'\s]+/i.test(blob);
}

function baseAttempt(overrides = {}) {
  return {
    id: ATTEMPT_ID,
    prospect_id: PROSPECT_ID,
    crm_review_mark_id: MARK_ID,
    provider: 'hubspot',
    idempotency_key: IDEMPOTENCY_KEY,
    status: 'pending',
    provider_company_id: '',
    provider_contact_ids: [],
    actor_id: 'Earthling',
    error_category: '',
    created_at: '2026-07-23T12:00:00.000Z',
    updated_at: '2026-07-23T12:00:00.000Z',
    ...overrides,
  };
}

function isSafeSalesUnavailable(result) {
  if (!result || result.ok !== false || result.status !== 503) return false;
  if (result.code !== 'sales_unavailable' || result.retryable !== true) return false;
  if (blobHasSecretLeak(result)) return false;
  if (/INSERT\s+INTO|SELECT\s+\*\s+FROM|raw.?payload|statusText|response\.body/i.test(JSON.stringify(result))) {
    return false;
  }
  return typeof result.error === 'string' && /unavailable|retry/i.test(result.error);
}

console.log('verify:crowsnest-sales-approved-crm-sync-attempts — durable attempt records\n');

console.log('▸ Structural: migration + wiring boundaries');
const storeSrc = read(STORE_PATH) || '';
const salesSrc = read(SALES_PATH) || '';
const apiSrc = read(API_PATH) || '';
const pageSrc = read(PAGE_PATH) || '';
const mig049 = read(MIGRATION_049_PATH) || '';

ok('store module exists', fs.existsSync(STORE_PATH), STORE_REL);
ok('migration 049 exists (approved CRM sync attempts)', fs.existsSync(MIGRATION_049_PATH), MIGRATION_049_REL);
ok(
  'migration 049 creates approved_crm_sync_attempts',
  /approved_crm_sync_attempts/i.test(mig049) && /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(mig049),
);
ok('migration 049 is transactional (BEGIN/COMMIT)', /BEGIN;/i.test(mig049) && /COMMIT;/i.test(mig049));
ok(
  'migration 049 is idempotent (IF NOT EXISTS)',
  /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+luna_sales\.approved_crm_sync_attempts/i.test(mig049)
    && /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i.test(mig049),
);
ok(
  'migration 049 stores required columns only',
  /prospect_id/i.test(mig049)
    && /crm_review_mark_id/i.test(mig049)
    && /provider/i.test(mig049)
    && /idempotency_key/i.test(mig049)
    && /status/i.test(mig049)
    && /provider_company_id/i.test(mig049)
    && /provider_contact_ids/i.test(mig049)
    && /actor_id/i.test(mig049)
    && /error_category/i.test(mig049)
    && /created_at/i.test(mig049)
    && /updated_at/i.test(mig049),
);
ok(
  'migration 049 status CHECK pending/succeeded/failed',
  /pending/.test(mig049) && /succeeded/.test(mig049) && /failed/.test(mig049),
);
ok(
  'migration 049 provider CHECK hubspot',
  /provider\s+TEXT/i.test(mig049) && /'hubspot'/.test(mig049),
);
ok(
  'migration 049 unique idempotency_key',
  /UNIQUE\s*\(\s*idempotency_key\s*\)/i.test(mig049)
    || /idempotency_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(mig049),
);
ok(
  'migration 049 forbids secret/payload columns',
  (() => {
    const createMatch = mig049.match(
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+luna_sales\.approved_crm_sync_attempts\s*\(([\s\S]*?)\)\s*;/i,
    );
    const body = createMatch ? createMatch[1] : '';
    if (!body) return false;
    return !/\bservice_key\b/i.test(body)
      && !/\btoken\b/i.test(body)
      && !/\bpayload\b/i.test(body)
      && !/\bheaders?\b/i.test(body)
      && !/\bemail\b/i.test(body)
      && !/\bphone\b/i.test(body)
      && !/\bprompt\b/i.test(body)
      && !/JSONB/i.test(body)
      && !/\bjsonb\b/i.test(body)
      && !/\bdetail\b/i.test(body);
  })(),
);
ok(
  'migration 049 documents least-privilege / schema-qualified SQL',
  /least-privilege|CROWSNEST_SALES_DATABASE_URL|do not rely on search_path/i.test(mig049),
);
ok('047 contact candidates retained as prior chapter', fs.existsSync(MIGRATION_047_PATH));
ok('048 metrics retained ahead of 049', fs.existsSync(MIGRATION_048_PATH));

ok(
  'store exposes approved CRM sync attempt primitives',
  /saveApprovedCrmSyncAttempt/.test(storeSrc)
    && /getApprovedCrmSyncAttemptByIdempotencyKey/.test(storeSrc)
    && /updateApprovedCrmSyncAttemptOutcome/.test(storeSrc)
    && /listApprovedCrmSyncAttemptsForProspect/.test(storeSrc),
);
ok(
  'store SQL for attempts qualifies luna_sales',
  /luna_sales\.approved_crm_sync_attempts/.test(storeSrc),
);
ok(
  'router allowlists approved CRM sync send path',
  /matchSalesApprovedCrmSyncPath/.test(apiSrc)
    && /approved-crm-sync/.test(apiSrc)
    && /sendApprovedCrmSync|saveApprovedCrmSyncAttempt/.test(apiSrc),
);
ok(
  'Send to HubSpot UI control is present with safe copy',
  /Send to HubSpot/.test(pageSrc)
    && /does not send outreach/i.test(pageSrc)
    && /approvedCrmSyncAttempt|approved-crm-sync/i.test(pageSrc),
);
ok(
  'sales domain orchestrates approved CRM sync attempts',
  /saveApprovedCrmSyncAttempt/.test(salesSrc)
    && /updateApprovedCrmSyncAttemptOutcome/.test(salesSrc)
    && /sendApprovedCrmSync/.test(salesSrc)
    && !/syncApprovedCrmToHubSpotV3/.test(salesSrc),
);
ok(
  'store never reads HubSpot Service Key / HUBSPOT env',
  !/process\.env\.HUBSPOT_[A-Z0-9_]+/.test(storeSrc)
    && !/env\.HUBSPOT_[A-Z0-9_]+/.test(storeSrc)
    && !/env\[['\"]HUBSPOT_[A-Z0-9_]+['\"]\]/.test(storeSrc)
    && !/process\.env\[['\"]hubspot-service-key['\"]\]/i.test(storeSrc),
);
ok(
  'store never requires hubspot SDK or live HTTP',
  !/require\(['"][^'"]*hubspot/i.test(storeSrc)
    && !/api\.hubapi\.com|api\.hubspot\.com/i.test(storeSrc),
);

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
} catch {
  pkg = null;
}
ok(
  `package.json has ${NPM_SCRIPT}`,
  pkg && pkg.scripts && typeof pkg.scripts[NPM_SCRIPT] === 'string',
);

let manifest = null;
try {
  manifest = loadManifest();
} catch (err) {
  manifest = null;
  ok('canonical manifest loads', false, String(err && err.message));
}
if (manifest) {
  const entry = manifest.entries.find((e) => e.filename === '049_luna_sales_approved_crm_sync_attempts.sql');
  ok('manifest includes 049_luna_sales_approved_crm_sync_attempts.sql', Boolean(entry));
  ok(
    '049 is canonical_forward',
    entry && entry.classification === 'canonical_forward' && entry.inForwardChain === true,
  );
  ok('049 order is 47', entry && entry.order === 47);
  if (entry && fs.existsSync(MIGRATION_049_PATH)) {
    const live = sha256CanonicalLfV1File(MIGRATION_049_PATH);
    ok('049 sha256 matches live file', entry.sha256 === live, `manifest=${entry.sha256} live=${live}`);
  }
  const forwards = forwardEntries(manifest);
  ok('forward count includes 050 (48)', forwards.length === 48, `forward=${forwards.length}`);
  const order48 = manifest.entries.find((e) => e.filename === '048_crowsnest_metrics_client_metrics_snapshots.sql');
  ok('048 remains order 46 ahead of 049', order48 && order48.order === 46);
}

async function runRepositoryChecks() {
  console.log('\n▸ Repository primitives (memory + recording pg)');
  delete require.cache[require.resolve(STORE_PATH)];
  let store = null;
  try {
    store = require(STORE_PATH);
    ok('store module loads', true);
  } catch (err) {
    ok('store module loads', false, String(err && err.message));
    return;
  }

  ok(
    'createMemorySalesRepository is a function',
    typeof store.createMemorySalesRepository === 'function',
  );
  ok(
    'createPgSalesRepository is a function',
    typeof store.createPgSalesRepository === 'function',
  );

  const memory = store.createMemorySalesRepository();
  ok(
    'memory exposes saveApprovedCrmSyncAttempt',
    memory && typeof memory.saveApprovedCrmSyncAttempt === 'function',
  );
  ok(
    'memory exposes getApprovedCrmSyncAttemptByIdempotencyKey',
    memory && typeof memory.getApprovedCrmSyncAttemptByIdempotencyKey === 'function',
  );
  ok(
    'memory exposes updateApprovedCrmSyncAttemptOutcome',
    memory && typeof memory.updateApprovedCrmSyncAttemptOutcome === 'function',
  );
  ok(
    'memory exposes listApprovedCrmSyncAttemptsForProspect',
    memory && typeof memory.listApprovedCrmSyncAttemptsForProspect === 'function',
  );

  if (typeof memory.saveApprovedCrmSyncAttempt !== 'function') return;

  const saved = await memory.saveApprovedCrmSyncAttempt(baseAttempt());
  ok(
    'memory save pending attempt ok',
    saved && saved.ok === true && saved.attempt && saved.attempt.id === ATTEMPT_ID,
    JSON.stringify(saved),
  );
  ok(
    'memory saved attempt has hubspot provider + pending status',
    saved
      && saved.attempt
      && saved.attempt.provider === 'hubspot'
      && saved.attempt.status === 'pending'
      && saved.attempt.idempotency_key === IDEMPOTENCY_KEY,
  );
  ok(
    'memory saved attempt omits secrets/payloads',
    saved && saved.attempt && !blobHasSecretLeak(saved.attempt)
      && saved.attempt.email == null
      && saved.attempt.phone == null
      && saved.attempt.payload == null
      && saved.attempt.raw_response == null
      && saved.attempt.headers == null
      && saved.attempt.token == null
      && saved.attempt.service_key == null,
  );

  const byKey = await memory.getApprovedCrmSyncAttemptByIdempotencyKey(IDEMPOTENCY_KEY);
  ok(
    'memory get by idempotency key returns attempt',
    byKey && byKey.id === ATTEMPT_ID && byKey.status === 'pending',
  );

  const duplicate = await memory.saveApprovedCrmSyncAttempt(baseAttempt({
    id: '66666666-6666-4666-8666-666666666666',
  }));
  ok(
    'memory enforces idempotency uniqueness',
    duplicate
      && (
        (duplicate.ok === true && duplicate.idempotent_replay === true && duplicate.attempt && duplicate.attempt.id === ATTEMPT_ID)
        || (duplicate.ok === false && duplicate.code === 'idempotency_conflict')
      ),
    JSON.stringify(duplicate),
  );

  const finalized = await memory.updateApprovedCrmSyncAttemptOutcome(ATTEMPT_ID, {
    status: 'succeeded',
    provider_company_id: 'hs-company-991',
    provider_contact_ids: ['hs-contact-1', 'hs-contact-2'],
    error_category: '',
    updated_at: '2026-07-23T12:05:00.000Z',
  });
  ok(
    'memory finalize succeeded with confirmed provider ids',
    finalized
      && finalized.ok === true
      && finalized.attempt
      && finalized.attempt.status === 'succeeded'
      && finalized.attempt.provider_company_id === 'hs-company-991'
      && Array.isArray(finalized.attempt.provider_contact_ids)
      && finalized.attempt.provider_contact_ids.length === 2,
    JSON.stringify(finalized),
  );

  const failedOutcome = await memory.saveApprovedCrmSyncAttempt(baseAttempt({
    id: '77777777-7777-4777-8777-777777777777',
    idempotency_key: `${IDEMPOTENCY_KEY}_fail`,
    status: 'pending',
  }));
  ok('memory second distinct key accepted', failedOutcome && failedOutcome.ok === true);

  const mappedFail = await memory.updateApprovedCrmSyncAttemptOutcome(
    '77777777-7777-4777-8777-777777777777',
    {
      status: 'failed',
      provider_company_id: '',
      provider_contact_ids: [],
      error_category: `auth_failed ${FAKE_TOKEN} ${FAKE_SERVICE_KEY} {"message":"raw hubspot"}`,
      updated_at: '2026-07-23T12:06:00.000Z',
    },
  );
  ok(
    'memory maps unsafe error text to sanitized category',
    mappedFail
      && mappedFail.ok === true
      && mappedFail.attempt
      && mappedFail.attempt.status === 'failed'
      && typeof mappedFail.attempt.error_category === 'string'
      && mappedFail.attempt.error_category.length > 0
      && !blobHasSecretLeak(mappedFail.attempt)
      && !/\{|raw hubspot/i.test(mappedFail.attempt.error_category),
    JSON.stringify(mappedFail),
  );

  const listed = await memory.listApprovedCrmSyncAttemptsForProspect(PROSPECT_ID);
  ok(
    'memory lists attempts for prospect',
    Array.isArray(listed) && listed.length === 2,
    `n=${listed && listed.length}`,
  );

  const recorded = [];
  const uniqueKeys = new Set();
  const pgRepo = store.createPgSalesRepository({
    query: async (sql, params) => {
      recorded.push({ sql: String(sql), params: params == null ? null : [...params] });
      const text = String(sql);
      if (/INSERT\s+INTO\s+luna_sales\.approved_crm_sync_attempts/i.test(text)) {
        const key = String(params[4]);
        if (uniqueKeys.has(key)) {
          const err = new Error(
            `duplicate key value violates unique constraint "approved_crm_sync_attempts_idempotency_key_key" DETAIL: Key (idempotency_key)=(${key}) already exists. token=${FAKE_TOKEN}`,
          );
          err.code = '23505';
          throw err;
        }
        uniqueKeys.add(key);
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE\s+luna_sales\.approved_crm_sync_attempts/i.test(text)) {
        return {
          rows: [{
            id: params[0],
            prospect_id: PROSPECT_ID,
            crm_review_mark_id: MARK_ID,
            provider: 'hubspot',
            idempotency_key: IDEMPOTENCY_KEY,
            status: params[1],
            provider_company_id: params[2] || '',
            provider_contact_ids: params[3] || [],
            actor_id: 'Earthling',
            error_category: params[4] || '',
            created_at: '2026-07-23T12:00:00.000Z',
            updated_at: params[5],
          }],
          rowCount: 1,
        };
      }
      if (/SELECT[\s\S]*FROM\s+luna_sales\.approved_crm_sync_attempts[\s\S]*idempotency_key/i.test(text)) {
        if (String(params[0]) === IDEMPOTENCY_KEY && uniqueKeys.has(IDEMPOTENCY_KEY)) {
          return {
            rows: [{
              id: ATTEMPT_ID,
              prospect_id: PROSPECT_ID,
              crm_review_mark_id: MARK_ID,
              provider: 'hubspot',
              idempotency_key: IDEMPOTENCY_KEY,
              status: 'pending',
              provider_company_id: '',
              provider_contact_ids: [],
              actor_id: 'Earthling',
              error_category: '',
              created_at: '2026-07-23T12:00:00.000Z',
              updated_at: '2026-07-23T12:00:00.000Z',
            }],
          };
        }
        return { rows: [] };
      }
      if (/SELECT[\s\S]*FROM\s+luna_sales\.approved_crm_sync_attempts/i.test(text)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  ok(
    'pg repo exposes approved CRM sync attempt primitives',
    typeof pgRepo.saveApprovedCrmSyncAttempt === 'function'
      && typeof pgRepo.getApprovedCrmSyncAttemptByIdempotencyKey === 'function'
      && typeof pgRepo.updateApprovedCrmSyncAttemptOutcome === 'function'
      && typeof pgRepo.listApprovedCrmSyncAttemptsForProspect === 'function',
  );

  recorded.length = 0;
  const pgSaved = await pgRepo.saveApprovedCrmSyncAttempt(baseAttempt());
  ok('pg save pending attempt ok', pgSaved && pgSaved.ok === true, JSON.stringify(pgSaved));
  ok('pg recorded SQL calls', recorded.length >= 1, `n=${recorded.length}`);
  ok(
    'pg insert qualifies luna_sales.approved_crm_sync_attempts',
    recorded.some((c) => /INSERT\s+INTO\s+luna_sales\.approved_crm_sync_attempts/i.test(c.sql)),
  );
  ok(
    'pg insert is parameterized ($1..)',
    recorded
      .filter((c) => /INSERT\s+INTO\s+luna_sales\.approved_crm_sync_attempts/i.test(c.sql))
      .every((c) => /\$1/.test(c.sql) && Array.isArray(c.params) && c.params.length >= 8),
  );
  ok(
    'pg SQL never embeds token/service key literals',
    recorded.every((c) => !blobHasSecretLeak(c.sql) && !blobHasSecretLeak(c.params)),
  );

  const pgDup = await pgRepo.saveApprovedCrmSyncAttempt(baseAttempt({
    id: '88888888-8888-4888-8888-888888888888',
  }));
  ok(
    'pg unique violation maps to idempotent replay or conflict (no secret leak)',
    pgDup
      && !blobHasSecretLeak(pgDup)
      && (
        (pgDup.ok === true && pgDup.idempotent_replay === true)
        || (pgDup.ok === false && pgDup.code === 'idempotency_conflict')
      ),
    JSON.stringify(pgDup),
  );

  recorded.length = 0;
  const pgUpdate = await pgRepo.updateApprovedCrmSyncAttemptOutcome(ATTEMPT_ID, {
    status: 'succeeded',
    provider_company_id: 'hs-company-42',
    provider_contact_ids: ['hs-c-1'],
    error_category: 'auth_failed',
    updated_at: '2026-07-23T12:10:00.000Z',
  });
  ok(
    'pg update outcome ok + parameterized',
    pgUpdate && pgUpdate.ok === true
      && recorded.some((c) => /UPDATE\s+luna_sales\.approved_crm_sync_attempts/i.test(c.sql) && /\$1/.test(c.sql)),
    JSON.stringify({ ok: pgUpdate && pgUpdate.ok, sql: recorded.map((c) => c.sql.split('\n')[0]) }),
  );
  ok(
    'all recorded attempt SQL qualifies luna_sales.',
    recorded.every((c) => /luna_sales\./.test(c.sql)),
  );

  const LEAKY = new Error(
    `password authentication failed token=${FAKE_TOKEN} ${FAKE_SERVICE_KEY} `
    + 'postgres://crowsnest_sales:SuperSecretPass@prod-db.azure.com:5432/app '
    + 'SQL: INSERT INTO luna_sales.approved_crm_sync_attempts SELECT * FROM pg_shadow',
  );
  const leakyRepo = store.createPgSalesRepository({
    query: async () => {
      throw LEAKY;
    },
  });
  const leakySave = await leakyRepo.saveApprovedCrmSyncAttempt(baseAttempt({
    idempotency_key: `${IDEMPOTENCY_KEY}_leaky`,
  }));
  ok(
    'pg query failure returns safe sales_unavailable (no secrets/raw SQL)',
    isSafeSalesUnavailable(leakySave),
    JSON.stringify(leakySave),
  );
  const leakyGet = await leakyRepo.getApprovedCrmSyncAttemptByIdempotencyKey(IDEMPOTENCY_KEY);
  ok(
    'pg get failure returns null or safe unavailable without secrets',
    (leakyGet == null || isSafeSalesUnavailable(leakyGet)) && !blobHasSecretLeak(leakyGet),
    JSON.stringify(leakyGet),
  );

  const failClosed = store.createFailClosedSalesRepository({
    error: 'CROWSNEST_SALES_DATABASE_URL is required in production for Sales mutations.',
  });
  const fcSave = await failClosed.saveApprovedCrmSyncAttempt(baseAttempt());
  ok(
    'fail-closed rejects attempt writes',
    fcSave && fcSave.ok === false && fcSave.code === 'sales_store_misconfigured',
    JSON.stringify(fcSave),
  );

  console.log('\n▸ Boundary: Service Key stays out of store/page; runtime config is narrow');
  ok(
    'store never reads HubSpot Service Key / HUBSPOT env',
    !/process\.env\.HUBSPOT_[A-Z0-9_]+/.test(storeSrc)
      && !/env\.HUBSPOT_[A-Z0-9_]+/.test(storeSrc)
      && !/HUBSPOT_SERVICE_KEY/.test(storeSrc),
  );
  ok(
    'page source does not read or echo HubSpot Service Key',
    !/HUBSPOT_SERVICE_KEY|hubspot-service-key-super-secret|pat-na1-/i.test(pageSrc),
  );
  ok(
    'page does not claim hubspot sync completed automatically',
    !/hubspot sync completed|sync to hubspot completed|automatic CRM sync/i.test(pageSrc),
  );
  ok(
    'api uses runtime config boundary for Service Key (not inline process.env.HUBSPOT in store)',
    /crowsnest-hubspot-runtime-config|resolveHubSpotServiceKeyAccess/.test(apiSrc),
  );
  ok(
    'migration 049 does not grant roles or wire Azure secrets',
    !/^\s*GRANT\s+/im.test(mig049)
      && !/hubspot-service-key/i.test(mig049)
      && !/ALTER\s+ROLE|CREATE\s+ROLE/i.test(mig049)
      && !/Container App secret|az\s+containerapp|KEYVAULT/i.test(mig049),
  );
}

runRepositoryChecks()
  .catch((err) => {
    fail += 1;
    console.log('  FAIL  repository checks threw', String(err && err.stack || err));
  })
  .finally(() => {
    console.log(`\n── verify:crowsnest-sales-approved-crm-sync-attempts: ${fail ? 'FAILED' : 'PASSED'} ──`);
    console.log(`pass=${pass} fail=${fail}`);
    process.exitCode = fail ? 1 : 0;
  });
