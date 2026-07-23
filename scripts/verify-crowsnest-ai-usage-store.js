'use strict';

/**
 * Deterministic RED→GREEN verifier for Crowsnest AI usage durable store (ledger foundation).
 * No live database, no Azure, no network. Uses a recording/fake query seam.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE_REL = 'scripts/lib/crowsnest/crowsnest-ai-usage-store.js';
const STORE_PATH = path.join(ROOT, STORE_REL);
const CONTRACT_REL = 'scripts/lib/crowsnest/crowsnest-ai-usage-contract.js';
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);
const MIGRATION_REL = 'database/migrations/050_crowsnest_ai_usage_events.sql';
const MIGRATION_PATH = path.join(ROOT, MIGRATION_REL);
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'AI-USAGE-STORE.md');
const PRODUCT_DOC = path.join(ROOT, 'docs', 'CROWSNEST.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const API_PATH = path.join(ROOT, 'scripts', 'crowsnest-api.js');
const MANIFEST_PATH = path.join(ROOT, 'database', 'migrations', 'canonical-manifest.json');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'crowsnest-ai-usage');
const VERIFY_SCRIPT_REL = 'scripts/verify-crowsnest-ai-usage-store.js';

const {
  sha256CanonicalLfV1File,
  forwardEntries,
  loadManifest,
} = require('./lib/migration-integrity');

const FORBIDDEN_PARAM_MARKERS = Object.freeze([
  'prompt',
  'response',
  'guest',
  'booking',
  'conversation',
  'message',
  'email',
  'phone',
  'sk-live',
  'sk-ant-',
  'Bearer ',
  'api_key',
  'password',
  'credential',
  'raw_provider',
  'should-never-appear',
  'secret_payload_body',
]);

const FORBIDDEN_MIGRATION_COLUMNS = Object.freeze([
  'prompt',
  'response',
  'guest',
  'booking',
  'conversation',
  'message',
  'email',
  'phone',
  'payload',
  'metadata',
  'raw_',
  'credential',
  'api_key',
  'password',
  'account',
]);

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

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function flattenParams(params) {
  return (params || []).map((p) => (p == null ? '' : String(p))).join('\u0000');
}

function paramsContainForbidden(params) {
  const flat = flattenParams(params).toLowerCase();
  return FORBIDDEN_PARAM_MARKERS.filter((m) => flat.includes(String(m).toLowerCase()));
}

function createRecordingDb(options = {}) {
  const calls = [];
  const seen = new Set();
  const throwMessage = options.throwMessage || null;
  return {
    calls,
    async query(sql, params) {
      const copy = Array.isArray(params) ? params.slice() : params;
      calls.push({ sql: String(sql || ''), params: copy });
      if (throwMessage) {
        throw new Error(throwMessage);
      }
      if (!/\$\d/.test(String(sql || ''))) {
        throw new Error('expected_parameterized_sql');
      }
      if (!/INSERT\s+INTO\s+crowsnest_ai_usage_events/i.test(String(sql || ''))) {
        throw new Error('expected_insert_into_crowsnest_ai_usage_events');
      }
      if (!/ON\s+CONFLICT\s*\(\s*event_id\s*\)\s*DO\s+NOTHING/i.test(String(sql || ''))) {
        throw new Error('expected_on_conflict_do_nothing');
      }
      const eventId = copy && copy[0];
      if (seen.has(eventId)) {
        return { rowCount: 0, rows: [] };
      }
      seen.add(eventId);
      return { rowCount: 1, rows: [{ event_id: eventId }] };
    },
  };
}

function baseValidEvent(overrides = {}) {
  return {
    schema_version: 'crowsnest.ai_usage.v1',
    event_id: 'evt_store_test_001',
    occurred_at: '2026-07-23T05:00:00.000Z',
    client_slug: 'example-client',
    tenant_id: 'tenant_example_alpha',
    source_service: 'example-front-desk',
    operation: 'chat.completion',
    provider: 'openai',
    model: 'gpt-example-mini',
    status: 'succeeded',
    tokens: {
      availability: 'measured',
      input_tokens: 42,
      output_tokens: 17,
      total_tokens: 59,
    },
    latency_ms: 318,
    cost: {
      state: 'provider_reported',
      amount_micros: 1250,
      currency: 'USD',
    },
    ...overrides,
  };
}

console.log('verify:crowsnest-ai-usage-store — AI usage durable store gate\n');

console.log('▸ Structural contracts');
ok('store module exists', fs.existsSync(STORE_PATH), STORE_REL);
ok('contract module exists', fs.existsSync(CONTRACT_PATH), CONTRACT_REL);
ok('migration 050 exists', fs.existsSync(MIGRATION_PATH), MIGRATION_REL);
ok('store doc exists', fs.existsSync(DOC_PATH));
ok('product doc exists', fs.existsSync(PRODUCT_DOC));
ok('verifier script path is this file', path.basename(__filename) === 'verify-crowsnest-ai-usage-store.js');

const storeSrc = read(STORE_PATH) || '';
const migSrc = read(MIGRATION_PATH) || '';
const docSrc = read(DOC_PATH) || '';
const productSrc = read(PRODUCT_DOC) || '';
const apiSrc = read(API_PATH) || '';

ok('store requires local contract validator', /crowsnest-ai-usage-contract/.test(storeSrc));
ok('store validates before SQL (validateCrowsnestAiUsageEvent)', /validateCrowsnestAiUsageEvent/.test(storeSrc));
ok('store uses parameterized INSERT', /INSERT[\s\S]*\$\d/i.test(storeSrc) || /\$1/.test(storeSrc));
ok('store uses ON CONFLICT DO NOTHING', /ON\s+CONFLICT[\s\S]*DO\s+NOTHING/i.test(storeSrc));
ok('store does not import pg', !/\brequire\s*\(\s*['"]pg['"]\s*\)/.test(storeSrc));
ok('store does not read process.env database URLs', !/process\.env\.(WOLFHOUSE_DATABASE_URL|DATABASE_URL|CROWSNEST_SALES_DATABASE_URL)/.test(storeSrc));
ok('crowsnest-api does not import ai-usage-store', !/crowsnest-ai-usage-store/.test(apiSrc));

ok('migration creates crowsnest_ai_usage_events', /CREATE\s+TABLE[\s\S]*crowsnest_ai_usage_events/i.test(migSrc));
ok('migration uses event_id primary key / unique', /event_id[\s\S]*PRIMARY\s+KEY/i.test(migSrc));
ok('migration has client_slug and tenant_id columns', /client_slug/i.test(migSrc) && /tenant_id/i.test(migSrc));
ok('migration has tokens_availability', /tokens_availability/i.test(migSrc));
ok('migration has cost_state', /cost_state/i.test(migSrc));
ok('migration has no JSONB blob column', !/\bJSONB\b/i.test(migSrc));
ok(
  'migration omits forbidden content/PII/secret columns',
  !FORBIDDEN_MIGRATION_COLUMNS.some((col) => new RegExp(`\\b${col}\\w*\\s+(TEXT|JSONB|VARCHAR|BYTEA)`, 'i').test(migSrc)),
  'found forbidden column-like DDL',
);
ok('migration documents not applied in this slice / out of band', /out of (scope|band)|do not apply|not apply/i.test(migSrc));
ok('doc names recordCrowsnestAiUsageEvent', /recordCrowsnestAiUsageEvent/.test(docSrc));
ok('doc forbids content/PII columns', /prompt|guest|booking|JSON/i.test(docSrc));
ok('CROWSNEST.md mentions AI usage store', /ai usage store|AI-USAGE-STORE|durable.*ai usage|ai usage.*ledger/i.test(productSrc));
ok(
  'CROWSNEST.md lists verify:crowsnest-ai-usage-store',
  /verify:crowsnest-ai-usage-store/.test(productSrc),
);

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
} catch {
  pkg = null;
}
ok('package.json parses', pkg != null);
ok(
  'package.json has verify:crowsnest-ai-usage-store',
  Boolean(pkg && pkg.scripts && pkg.scripts['verify:crowsnest-ai-usage-store']),
);
ok(
  'package.json verify script points at this file',
  Boolean(
    pkg
    && pkg.scripts
    && String(pkg.scripts['verify:crowsnest-ai-usage-store']).includes(VERIFY_SCRIPT_REL),
  ),
);

let manifest = null;
try {
  manifest = loadManifest();
  ok('canonical manifest loads', true);
} catch (err) {
  ok('canonical manifest loads', false, String(err && err.message));
}
if (manifest) {
  const entry = manifest.entries.find((e) => e.filename === '050_crowsnest_ai_usage_events.sql');
  ok('manifest includes 050_crowsnest_ai_usage_events.sql', Boolean(entry));
  ok(
    '050 is canonical_forward',
    Boolean(entry && entry.classification === 'canonical_forward' && entry.inForwardChain === true),
  );
  ok('050 order is 48', Boolean(entry && entry.order === 48), entry ? `order=${entry.order}` : 'missing');
  if (entry && fs.existsSync(MIGRATION_PATH)) {
    const live = sha256CanonicalLfV1File(MIGRATION_PATH);
    ok('050 sha256 matches live file', entry.sha256 === live, `manifest=${entry.sha256} live=${live}`);
  }
  const forwards = forwardEntries(manifest);
  ok('forward count includes 050 (48)', forwards.length === 48, `forward=${forwards.length}`);
}

let store = null;
try {
  store = require(STORE_PATH);
  ok('store module loads', true);
} catch (err) {
  ok('store module loads', false, String(err && err.message));
}

(async () => {
  if (!store) {
    console.log(`\n── verify:crowsnest-ai-usage-store: ${pass} passed, ${fail} failed ──`);
    process.exit(1);
  }

  ok('exports recordCrowsnestAiUsageEvent', typeof store.recordCrowsnestAiUsageEvent === 'function');

  console.log('\n▸ Validation before SQL');
  {
    const db = createRecordingDb();
    const bad = baseValidEvent({ prompt: 'should-never-appear' });
    const result = await store.recordCrowsnestAiUsageEvent({ db, event: bad });
    ok(
      'invalid event returns ok:false with errors',
      result && result.ok === false && Array.isArray(result.errors) && result.errors.length > 0,
      JSON.stringify(result),
    );
    ok('invalid event does not call db.query', db.calls.length === 0, `calls=${db.calls.length}`);
  }

  {
    const db = createRecordingDb();
    const fixture = readJson(path.join(FIXTURE_DIR, 'invalid-sensitive-prompt-key.json'));
    const result = await store.recordCrowsnestAiUsageEvent({ db, event: fixture });
    ok(
      'fixture with prompt key rejected before SQL',
      result && result.ok === false && db.calls.length === 0,
      JSON.stringify({ result, calls: db.calls.length }),
    );
  }

  {
    const db = createRecordingDb();
    const secretShaped = baseValidEvent({
      event_id: 'evt_secret_shaped',
      model: 'sk-ant-abcdefghijklmnopqrstuvwxyz',
    });
    const result = await store.recordCrowsnestAiUsageEvent({ db, event: secretShaped });
    ok(
      'secret-shaped value rejected before SQL',
      result && result.ok === false && db.calls.length === 0,
      JSON.stringify(result),
    );
  }

  console.log('\n▸ Successful insert + parameter privacy');
  {
    const db = createRecordingDb();
    const event = baseValidEvent({
      event_id: 'evt_store_ok_001',
      client_slug: 'client-alpha',
      tenant_id: 'tenant-beta',
    });
    const before = deepClone(event);
    const result = await store.recordCrowsnestAiUsageEvent({ db, event });
    ok(
      'valid event returns ok:true inserted:true',
      result && result.ok === true && result.inserted === true,
      JSON.stringify(result),
    );
    ok('valid event issues exactly one query', db.calls.length === 1, `calls=${db.calls.length}`);
    const call = db.calls[0];
    ok('SQL is parameterized ($n)', /\$\d/.test(call.sql));
    ok('SQL targets crowsnest_ai_usage_events', /crowsnest_ai_usage_events/i.test(call.sql));
    ok('SQL uses ON CONFLICT (event_id) DO NOTHING', /ON\s+CONFLICT\s*\(\s*event_id\s*\)\s*DO\s+NOTHING/i.test(call.sql));
    ok('params include event_id', call.params.includes('evt_store_ok_001'));
    ok('params include independent client_slug', call.params.includes('client-alpha'));
    ok('params include independent tenant_id', call.params.includes('tenant-beta'));
    ok(
      'client_slug and tenant_id remain distinct in params',
      call.params.includes('client-alpha')
        && call.params.includes('tenant-beta')
        && call.params.indexOf('client-alpha') !== call.params.indexOf('tenant-beta'),
    );
    ok('params include provider/model/status', call.params.includes('openai') && call.params.includes('gpt-example-mini') && call.params.includes('succeeded'));
    ok('params include measured token counts', call.params.includes(42) && call.params.includes(17) && call.params.includes(59));
    ok('params include latency and cost', call.params.includes(318) && call.params.includes(1250) && call.params.includes('USD'));
    const forbiddenHits = paramsContainForbidden(call.params);
    ok('SQL parameters contain no forbidden values', forbiddenHits.length === 0, forbiddenHits.join(','));
    ok('input event is not mutated', deepEqual(event, before), 'event mutated');
  }

  console.log('\n▸ Idempotent duplicate event_id');
  {
    const db = createRecordingDb();
    const event = baseValidEvent({ event_id: 'evt_dup_001' });
    const first = await store.recordCrowsnestAiUsageEvent({ db, event: deepClone(event) });
    const second = await store.recordCrowsnestAiUsageEvent({ db, event: deepClone(event) });
    ok('first insert inserted:true', first && first.ok === true && first.inserted === true, JSON.stringify(first));
    ok(
      'duplicate event_id returns ok:true inserted:false',
      second && second.ok === true && second.inserted === false,
      JSON.stringify(second),
    );
    ok('duplicate still issues parameterized conflict SQL', db.calls.length === 2);
  }

  console.log('\n▸ Unavailable tokens do not fake zeroes');
  {
    const db = createRecordingDb();
    const event = baseValidEvent({
      event_id: 'evt_tokens_na_001',
      tokens: { availability: 'unavailable' },
      cost: { state: 'unavailable' },
    });
    delete event.error_code;
    const result = await store.recordCrowsnestAiUsageEvent({ db, event });
    ok('unavailable tokens event inserts', result && result.ok === true && result.inserted === true, JSON.stringify(result));
    const params = db.calls[0].params;
    ok('params include tokens_availability unavailable', params.includes('unavailable'));
    const tokenInts = params.filter((p) => p === 0);
    // latency may be non-zero; ensure measured token slots are null, not 0
    const nullCount = params.filter((p) => p === null).length;
    ok('unavailable path persists null token/cost slots (not fake zeros)', nullCount >= 5, `nulls=${nullCount} zeros=${tokenInts.length}`);
    ok(
      'input/output/total token params are null when unavailable',
      params.includes(null),
    );
    // Explicit: measured counts 42/17/59 from base must not appear
    ok('no measured token counts when unavailable', !params.includes(42) && !params.includes(17) && !params.includes(59));
  }

  console.log('\n▸ Failed event persists opaque error code only');
  {
    const db = createRecordingDb();
    const event = baseValidEvent({
      event_id: 'evt_failed_001',
      status: 'failed',
      error_code: 'provider_http_429',
      tokens: { availability: 'unavailable' },
      cost: { state: 'unavailable' },
    });
    const result = await store.recordCrowsnestAiUsageEvent({ db, event });
    ok('failed event inserts', result && result.ok === true && result.inserted === true, JSON.stringify(result));
    const params = db.calls[0].params;
    ok('params include opaque error_code', params.includes('provider_http_429'));
    ok('params include status failed', params.includes('failed'));
    const forbiddenHits = paramsContainForbidden(params);
    ok('failed event params have no raw/content markers', forbiddenHits.length === 0, forbiddenHits.join(','));
  }

  console.log('\n▸ Fixture-backed success path');
  {
    const db = createRecordingDb();
    const event = readJson(path.join(FIXTURE_DIR, 'valid-openai-measured.json'));
    const result = await store.recordCrowsnestAiUsageEvent({ db, event });
    ok('valid-openai-measured fixture inserts', result && result.ok === true && result.inserted === true, JSON.stringify(result));
  }
  {
    const db = createRecordingDb();
    const event = readJson(path.join(FIXTURE_DIR, 'valid-tokens-unavailable.json'));
    const result = await store.recordCrowsnestAiUsageEvent({ db, event });
    ok('valid-tokens-unavailable fixture inserts', result && result.ok === true && result.inserted === true, JSON.stringify(result));
    const params = db.calls[0].params;
    ok('fixture unavailable tokens do not include zero counts as measured', !params.includes(0) || params.includes('unavailable'));
  }
  {
    const db = createRecordingDb();
    const event = readJson(path.join(FIXTURE_DIR, 'valid-failed-opaque-error.json'));
    const result = await store.recordCrowsnestAiUsageEvent({ db, event });
    ok('valid-failed-opaque-error fixture inserts', result && result.ok === true && result.inserted === true, JSON.stringify(result));
  }

  console.log('\n▸ Safe DB error results');
  {
    const secret = 'postgres://crowsnest:super-secret@azure.example/db';
    const db = createRecordingDb({
      throwMessage: `ECONNREFUSED ${secret} detail=password=hunter2`,
    });
    const event = baseValidEvent({ event_id: 'evt_db_err_001' });
    const before = deepClone(event);
    const result = await store.recordCrowsnestAiUsageEvent({ db, event });
    ok(
      'DB error returns ok:false with errors array',
      result && result.ok === false && Array.isArray(result.errors) && result.errors.length > 0,
      JSON.stringify(result),
    );
    const encoded = JSON.stringify(result);
    ok('DB error result omits connection string', !encoded.includes(secret) && !encoded.includes('super-secret'));
    ok('DB error result omits raw password/detail', !encoded.includes('hunter2') && !/ECONNREFUSED/.test(encoded));
    ok('DB error does not mutate input event', deepEqual(event, before));
  }

  {
    const result = await store.recordCrowsnestAiUsageEvent({ event: baseValidEvent() });
    ok(
      'missing db returns safe ok:false',
      result && result.ok === false && Array.isArray(result.errors),
      JSON.stringify(result),
    );
  }

  console.log(`\n── verify:crowsnest-ai-usage-store: ${pass} passed, ${fail} failed ──`);
  if (fail === 0) {
    console.log('verify:crowsnest-ai-usage-store — ALL CHECKS PASSED');
  }
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('verify:crowsnest-ai-usage-store — unexpected error', err);
  process.exit(1);
});
