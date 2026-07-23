'use strict';

/**
 * Deterministic RED→GREEN verifier for Luna Sales Chapter 1 / Slice 1 durable store.
 * No live database, no Azure, no network. Uses fake repository / recording query seams.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STORE_REL = 'scripts/lib/crowsnest/crowsnest-sales-store.js';
const STORE_PATH = path.join(ROOT, STORE_REL);
const SALES_PATH = path.join(ROOT, 'scripts', 'lib', 'crowsnest', 'crowsnest-sales.js');
const API_PATH = path.join(ROOT, 'scripts', 'crowsnest-api.js');
const MIGRATION_REL = 'database/migrations/042_luna_sales_schema.sql';
const MIGRATION_PATH = path.join(ROOT, MIGRATION_REL);
const DOC_PATH = path.join(ROOT, 'docs', 'crowsnest', 'SALES-DURABLE-STORE.md');
const PRODUCT_DOC = path.join(ROOT, 'docs', 'CROWSNEST.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const MANIFEST_PATH = path.join(ROOT, 'database', 'migrations', 'canonical-manifest.json');

const {
  sha256CanonicalLfV1File,
  forwardEntries,
  loadManifest,
} = require('./lib/migration-integrity');

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

console.log('verify:crowsnest-sales-durable — Chapter 1 / Slice 1\n');

console.log('▸ Structural contracts');
ok('store module exists', fs.existsSync(STORE_PATH), STORE_REL);
ok('migration 042 exists', fs.existsSync(MIGRATION_PATH), MIGRATION_REL);
ok('durable-store doc exists', fs.existsSync(DOC_PATH));
ok('product doc exists', fs.existsSync(PRODUCT_DOC));

const storeSrc = read(STORE_PATH) || '';
const salesSrc = read(SALES_PATH) || '';
const migSrc = read(MIGRATION_PATH) || '';
const docSrc = read(DOC_PATH) || '';
const productSrc = read(PRODUCT_DOC) || '';

ok(
  'store never reads WOLFHOUSE_DATABASE_URL / DATABASE_URL',
  !/env\.WOLFHOUSE_DATABASE_URL|process\.env\.WOLFHOUSE_DATABASE_URL|env\[.WOLFHOUSE_DATABASE_URL.\]|env\.DATABASE_URL|process\.env\.DATABASE_URL|env\[.DATABASE_URL.\]/.test(storeSrc),
);
ok(
  'store documents forbidden Wolfhouse DSN',
  /WOLFHOUSE_DATABASE_URL/.test(storeSrc) && /Never|never|must not|forbid/i.test(storeSrc),
);
ok('sales domain never references WOLFHOUSE_DATABASE_URL', !/WOLFHOUSE_DATABASE_URL/.test(salesSrc));
ok('store uses CROWSNEST_SALES_DATABASE_URL', /CROWSNEST_SALES_DATABASE_URL/.test(storeSrc));
ok('store qualifies luna_sales schema', /luna_sales/.test(storeSrc));
ok('migration creates luna_sales schema', /CREATE\s+SCHEMA\s+.*luna_sales/i.test(migSrc));
ok('migration creates prospects', /luna_sales\.prospects|CREATE\s+TABLE[\s\S]*prospects/i.test(migSrc));
ok('migration creates research_jobs', /research_jobs/i.test(migSrc));
ok('migration creates audit_events', /audit_events/i.test(migSrc));
ok('migration uses UUID ids', /UUID/i.test(migSrc));
ok('migration has status CHECKs', /CHECK\s*\(/i.test(migSrc));
ok('migration documents least-privilege', /least-privilege|schema-scoped|USAGE.*luna_sales/i.test(migSrc));
ok('doc documents least-privilege schema-scoped SQL', /least-privilege|schema-scoped/i.test(docSrc));
ok('doc names CROWSNEST_SALES_DATABASE_URL', /CROWSNEST_SALES_DATABASE_URL/.test(docSrc));
ok('doc forbids WOLFHOUSE_DATABASE_URL at runtime', /WOLFHOUSE_DATABASE_URL/.test(docSrc) && /never|must not|forbid|do not/i.test(docSrc));
ok('product doc mentions durable Sales store', /durable|CROWSNEST_SALES_DATABASE_URL|luna_sales/i.test(productSrc));

let pkg = null;
try {
  pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
} catch {
  pkg = null;
}
ok(
  'package.json has verify:crowsnest-sales-durable',
  pkg && pkg.scripts && typeof pkg.scripts['verify:crowsnest-sales-durable'] === 'string',
);

let manifest = null;
try {
  manifest = loadManifest();
} catch (err) {
  manifest = null;
  ok('canonical manifest loads', false, String(err && err.message));
}
if (manifest) {
  const forwards = forwardEntries(manifest);
  const entry = manifest.entries.find((e) => e.filename === '042_luna_sales_schema.sql');
  ok('manifest includes 042_luna_sales_schema.sql', Boolean(entry));
  ok('042 is canonical_forward', entry && entry.classification === 'canonical_forward' && entry.inForwardChain === true);
  ok('042 order is 40', entry && entry.order === 40);
  if (entry && fs.existsSync(MIGRATION_PATH)) {
    const live = sha256CanonicalLfV1File(MIGRATION_PATH);
    ok('042 sha256 matches live file', entry.sha256 === live, `manifest=${entry.sha256} live=${live}`);
  }
  ok('forward count includes 049 (47)', forwards.length === 47, `forward=${forwards.length}`);
}

let store = null;
try {
  store = require(STORE_PATH);
  ok('store module loads', true);
} catch (err) {
  ok('store module loads', false, String(err && err.message));
}

if (store) {
  console.log('\n▸ Config + fail-closed / fallback');
  ok('exports SALES_DSN_ENV', store.SALES_DSN_ENV === 'CROWSNEST_SALES_DATABASE_URL');
  ok('exports resolveSalesStoreConfig', typeof store.resolveSalesStoreConfig === 'function');
  ok('exports createSalesRepository', typeof store.createSalesRepository === 'function');
  ok('exports createMemorySalesRepository', typeof store.createMemorySalesRepository === 'function');
  ok('exports createPgSalesRepository', typeof store.createPgSalesRepository === 'function');
  ok('exports closeSalesStore', typeof store.closeSalesStore === 'function');

  const prodMissing = store.resolveSalesStoreConfig({
    NODE_ENV: 'production',
  });
  ok(
    'production missing DSN fails closed',
    prodMissing && prodMissing.ok === false && prodMissing.backend === 'fail_closed',
    JSON.stringify(prodMissing),
  );
  ok(
    'production missing DSN does not fall back to memory',
    prodMissing && prodMissing.backend !== 'memory',
  );

  const prodWithWolf = store.resolveSalesStoreConfig({
    NODE_ENV: 'production',
    WOLFHOUSE_DATABASE_URL: 'postgres://wolfhouse:x@localhost:5433/wolfhouse',
    DATABASE_URL: 'postgres://other/db',
  });
  ok(
    'production ignores WOLFHOUSE_DATABASE_URL / DATABASE_URL',
    prodWithWolf && prodWithWolf.ok === false && prodWithWolf.backend === 'fail_closed',
    JSON.stringify(prodWithWolf),
  );

  const prodOk = store.resolveSalesStoreConfig({
    NODE_ENV: 'production',
    CROWSNEST_SALES_DATABASE_URL: 'postgres://crowsnest_sales:x@127.0.0.1:5432/app',
  });
  ok(
    'production with dedicated DSN selects postgres',
    prodOk && prodOk.ok === true && prodOk.backend === 'postgres',
    JSON.stringify(prodOk),
  );

  const localFallback = store.resolveSalesStoreConfig({
    NODE_ENV: 'development',
  });
  ok(
    'non-production without DSN allows memory fallback',
    localFallback && localFallback.ok === true && localFallback.backend === 'memory',
    JSON.stringify(localFallback),
  );

  const testFallback = store.resolveSalesStoreConfig({
    NODE_ENV: 'test',
  });
  ok(
    'test env without DSN allows memory fallback',
    testFallback && testFallback.ok === true && testFallback.backend === 'memory',
    JSON.stringify(testFallback),
  );

  console.log('\n▸ Fail-closed repository mutations');
  (async () => {
    const failRepo = await store.createSalesRepository({
      NODE_ENV: 'production',
    });
    ok('fail-closed repo created', failRepo && failRepo.backend === 'fail_closed');

    const write = await failRepo.createProspectRecord({
      id: '00000000-0000-4000-8000-000000000001',
      canonical_name: 'Should Not Persist',
      website_url: '',
      lifecycle_status: 'ready_for_review',
      owner_id: 'Admin',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_decision: null,
    });
    ok(
      'production missing DSN rejects prospect write',
      write && write.ok === false && (write.status === 503 || write.code === 'sales_store_misconfigured'),
      JSON.stringify(write),
    );

    const decide = await failRepo.updateProspectDecision('00000000-0000-4000-8000-000000000001', {
      lifecycle_status: 'approved',
      last_decision: { decision: 'approved', reason: 'x', reviewer_id: 'Admin', created_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    });
    ok(
      'production missing DSN rejects decision write',
      decide && decide.ok === false && (decide.status === 503 || decide.code === 'sales_store_misconfigured'),
      JSON.stringify(decide),
    );

    const audit = await failRepo.appendAuditEvent({
      id: '00000000-0000-4000-8000-000000000099',
      at: new Date().toISOString(),
      actor: 'Admin',
      action: 'review_decision',
      entity_type: 'prospect',
      entity_id: '00000000-0000-4000-8000-000000000001',
      detail: {},
    });
    ok(
      'production missing DSN rejects audit write',
      audit && audit.ok === false && (audit.status === 503 || audit.code === 'sales_store_misconfigured'),
      JSON.stringify(audit),
    );

    console.log('\n▸ Persist/reload through repository boundary');
    const shared = store.createMemorySalesRepository();
    const salesA = require(SALES_PATH);
    // Isolate domain module to injected repository
    if (typeof salesA._setSalesRepositoryForTests === 'function') {
      salesA._setSalesRepositoryForTests(shared);
    }
    const created = await salesA.createProspect({ business_name: 'Persist Hostel' }, 'Earthling');
    ok('createProspect ok via memory repo', created && created.ok === true && created.prospect && created.prospect.id);
    const prospectId = created.prospect.id;

    // Simulate process restart: fresh domain binding to same repository
    delete require.cache[require.resolve(SALES_PATH)];
    const salesB = require(SALES_PATH);
    if (typeof salesB._setSalesRepositoryForTests === 'function') {
      salesB._setSalesRepositoryForTests(shared);
    }
    const reloaded = await salesB.getProspect(prospectId);
    ok('prospect reloads after "restart" via shared repo', reloaded && reloaded.id === prospectId);
    const research = await salesB.getResearchForProspect(prospectId);
    ok('research reloads after restart', research && research.prospect_id === prospectId);
    const auditEvents = await salesB.listAuditEvents(prospectId);
    ok('audit reloads after restart', Array.isArray(auditEvents) && auditEvents.length >= 1);

    const decided = await salesB.decideProspect(prospectId, { decision: 'approved', reason: 'Good fit' }, 'Monshies');
    ok('decision ok', decided && decided.ok === true);

    const afterDecision = await salesB.listAuditEvents(prospectId);
    const decisionEvents = afterDecision.filter((e) => e.action === 'review_decision');
    ok('decision audit appended', decisionEvents.length >= 1);

    const beforeLen = afterDecision.length;
    const snapshot = afterDecision.map((e) => ({ ...e, detail: e.detail ? { ...e.detail } : e.detail }));
    await salesB.decideProspect(prospectId, { decision: 'needs_research', reason: 'Need more website evidence' }, 'Monshies');
    const afterSecond = await salesB.listAuditEvents(prospectId);
    ok('second decision appends audit (no overwrite)', afterSecond.length === beforeLen + 1);
    ok(
      'prior audit events remain intact (append-only)',
      snapshot.every((old, idx) => {
        const cur = afterSecond[idx];
        return cur && cur.id === old.id && cur.action === old.action && JSON.stringify(cur.detail) === JSON.stringify(old.detail);
      }),
    );

    // Ensure domain cannot mutate audit array in place through returned list
    const listed = await salesB.listAuditEvents(prospectId);
    const originalId = listed[0] && listed[0].id;
    listed.pop();
    listed[0] = { id: 'tampered' };
    const listedAgain = await salesB.listAuditEvents(prospectId);
    ok('listAuditEvents returns a defensive copy', listedAgain.length >= 1 && listedAgain[0].id === originalId);

    console.log('\n▸ Pg adapter SQL is luna_sales-qualified (recording query)');
    const recorded = [];
    const pgRepo = store.createPgSalesRepository({
      query: async (sql, params) => {
        recorded.push({ sql: String(sql), params });
        if (/INSERT\s+INTO\s+luna_sales\.prospects/i.test(sql)) {
          return { rows: [], rowCount: 1 };
        }
        if (/INSERT\s+INTO\s+luna_sales\.research_jobs/i.test(sql)) {
          return { rows: [], rowCount: 1 };
        }
        if (/INSERT\s+INTO\s+luna_sales\.audit_events/i.test(sql)) {
          return { rows: [], rowCount: 1 };
        }
        if (/UPDATE\s+luna_sales\.prospects/i.test(sql)) {
          return { rows: [], rowCount: 1 };
        }
        if (/SELECT[\s\S]*FROM\s+luna_sales\.prospects/i.test(sql)) {
          return {
            rows: [{
              id: '11111111-1111-4111-8111-111111111111',
              canonical_name: 'SQL Hostel',
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
          return { rows: [] };
        }
        if (/SELECT[\s\S]*FROM\s+luna_sales\.audit_events/i.test(sql)) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    });

    await pgRepo.createProspectRecord({
      id: '11111111-1111-4111-8111-111111111111',
      canonical_name: 'SQL Hostel',
      website_url: '',
      lifecycle_status: 'ready_for_review',
      owner_id: 'Admin',
      created_at: '2026-07-22T00:00:00.000Z',
      updated_at: '2026-07-22T00:00:00.000Z',
      last_decision: null,
    });
    await pgRepo.saveResearchJob({
      id: '22222222-2222-4222-8222-222222222222',
      prospect_id: '11111111-1111-4111-8111-111111111111',
      source: 'fixture',
      status: 'completed',
      job_label: 'Manual / fixture research job',
      summary: 'fixture',
      facts: [],
      limitations: [],
      created_at: '2026-07-22T00:00:00.000Z',
    });
    await pgRepo.appendAuditEvent({
      id: '33333333-3333-4333-8333-333333333333',
      at: '2026-07-22T00:00:00.000Z',
      actor: 'Admin',
      action: 'prospect_created',
      entity_type: 'prospect',
      entity_id: '11111111-1111-4111-8111-111111111111',
      detail: { prospect_id: '11111111-1111-4111-8111-111111111111' },
    });
    await pgRepo.updateProspectDecision('11111111-1111-4111-8111-111111111111', {
      lifecycle_status: 'approved',
      updated_at: '2026-07-22T00:00:01.000Z',
      last_decision: {
        decision: 'approved',
        reason: 'ok',
        reviewer_id: 'Admin',
        created_at: '2026-07-22T00:00:01.000Z',
      },
    });
    await pgRepo.getProspect('11111111-1111-4111-8111-111111111111');
    await pgRepo.listProspects();
    await pgRepo.getResearchForProspect('11111111-1111-4111-8111-111111111111');
    await pgRepo.listAuditEvents('11111111-1111-4111-8111-111111111111');

    ok('pg adapter recorded SQL calls', recorded.length >= 5, `n=${recorded.length}`);
    ok(
      'all pg SQL qualifies luna_sales.',
      recorded.every((c) => /luna_sales\./.test(c.sql)),
      recorded.map((c) => c.sql.split('\n')[0]).join(' | '),
    );
    ok(
      'no unqualified public-table mutation SQL',
      !recorded.some((c) => /INSERT\s+INTO\s+(?!luna_sales\.)[a-z_]+/i.test(c.sql)
        || /UPDATE\s+(?!luna_sales\.)[a-z_]+/i.test(c.sql)
        || /DELETE\s+FROM\s+(?!luna_sales\.)[a-z_]+/i.test(c.sql)),
    );
    ok(
      'audit path is INSERT only (append-only)',
      recorded.filter((c) => /audit_events/i.test(c.sql)).every((c) => /^\s*INSERT\b/i.test(c.sql.trim()) || /^\s*SELECT\b/i.test(c.sql.trim())),
    );
    ok(
      'no UPDATE/DELETE against audit_events',
      !recorded.some((c) => /(?:UPDATE|DELETE)\s+[\s\S]*audit_events/i.test(c.sql)),
    );

    console.log('\n▸ Atomic Postgres createProspectBundle (no partial rows)');
    ok(
      'pg repo exposes createProspectBundle',
      typeof pgRepo.createProspectBundle === 'function',
    );
    ok(
      'memory repo does not gain createProspectBundle (fallback unchanged)',
      typeof shared.createProspectBundle !== 'function',
    );

    const LEAKY_DB_ERROR = new Error(
      'password authentication failed for user "crowsnest_sales" '
      + 'connection string postgres://crowsnest_sales:SuperSecretPass@prod-db.azure.com:5432/app '
      + 'SQL: INSERT INTO luna_sales.research_jobs SELECT * FROM pg_shadow',
    );

    function isSafeSalesUnavailable(result) {
      if (!result || result.ok !== false || result.status !== 503) return false;
      if (result.code !== 'sales_unavailable' || result.retryable !== true) return false;
      const blob = JSON.stringify(result);
      if (/SuperSecretPass|postgres:\/\/|prod-db\.azure|pg_shadow|password authentication/i.test(blob)) {
        return false;
      }
      if (/INSERT\s+INTO|SELECT\s+\*\s+FROM/i.test(blob)) return false;
      return typeof result.error === 'string' && /unavailable|retry/i.test(result.error);
    }

    const persisted = { prospects: [], research: [], audits: [] };
    let failOnResearch = false;
    let failOnAudit = false;
    const atomicRepo = store.createPgSalesRepository({
      // Guard: sequential mutation path must not open a real pool in offline tests.
      query: async () => {
        throw new Error('postgres create must use createProspectBundle transaction path');
      },
      runTransaction: async (fn) => {
        const staged = { prospects: [], research: [], audits: [] };
        try {
          await fn(async (sql, params) => {
            const text = String(sql);
            if (/INSERT\s+INTO\s+luna_sales\.prospects/i.test(text)) {
              staged.prospects.push(params[0]);
              return { rows: [], rowCount: 1 };
            }
            if (/INSERT\s+INTO\s+luna_sales\.research_jobs/i.test(text)) {
              if (failOnResearch) throw LEAKY_DB_ERROR;
              staged.research.push(params[0]);
              return { rows: [], rowCount: 1 };
            }
            if (/INSERT\s+INTO\s+luna_sales\.audit_events/i.test(text)) {
              if (failOnAudit) throw LEAKY_DB_ERROR;
              staged.audits.push(params[0]);
              return { rows: [], rowCount: 1 };
            }
            return { rows: [] };
          });
          persisted.prospects.push(...staged.prospects);
          persisted.research.push(...staged.research);
          persisted.audits.push(...staged.audits);
        } catch (err) {
          // rollback: discard staged — do not copy into persisted
          throw err;
        }
      },
    });

    const bundleProspect = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      canonical_name: 'Atomic Hostel',
      website_url: 'https://atomic.example',
      lifecycle_status: 'ready_for_review',
      owner_id: 'Admin',
      created_at: '2026-07-22T00:00:00.000Z',
      updated_at: '2026-07-22T00:00:00.000Z',
      last_decision: null,
    };
    const bundleResearch = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      prospect_id: bundleProspect.id,
      source: 'fixture',
      status: 'completed',
      job_label: 'Manual / fixture research job',
      summary: 'fixture',
      facts: [],
      limitations: [],
      created_at: '2026-07-22T00:00:00.000Z',
    };
    const bundleAudits = [
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        at: '2026-07-22T00:00:00.000Z',
        actor: 'Admin',
        action: 'prospect_created',
        entity_type: 'prospect',
        entity_id: bundleProspect.id,
        detail: { prospect_id: bundleProspect.id },
      },
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        at: '2026-07-22T00:00:00.000Z',
        actor: 'system',
        action: 'research_fixture_attached',
        entity_type: 'research',
        entity_id: bundleResearch.id,
        detail: { prospect_id: bundleProspect.id, source: 'fixture', status: 'completed' },
      },
    ];

    async function runBundle(repo, payload) {
      if (typeof repo.createProspectBundle !== 'function') {
        return { ok: false, error: 'createProspectBundle missing' };
      }
      return repo.createProspectBundle(payload);
    }

    failOnResearch = true;
    const partialResearch = await runBundle(atomicRepo, {
      prospect: bundleProspect,
      research: bundleResearch,
      auditEvents: bundleAudits,
    });
    ok(
      'research failure mid-bundle returns safe sales_unavailable 503',
      isSafeSalesUnavailable(partialResearch),
      JSON.stringify(partialResearch),
    );
    ok(
      'research failure leaves no persisted prospect/research/audit rows',
      persisted.prospects.length === 0
        && persisted.research.length === 0
        && persisted.audits.length === 0,
      JSON.stringify(persisted),
    );

    failOnResearch = false;
    failOnAudit = true;
    const partialAudit = await runBundle(atomicRepo, {
      prospect: { ...bundleProspect, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
      research: { ...bundleResearch, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', prospect_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
      auditEvents: bundleAudits.map((e) => ({ ...e, entity_id: e.action === 'prospect_created' ? 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' : e.entity_id })),
    });
    ok(
      'audit failure mid-bundle returns safe sales_unavailable 503',
      isSafeSalesUnavailable(partialAudit),
      JSON.stringify(partialAudit),
    );
    ok(
      'audit failure leaves no persisted partial rows',
      persisted.prospects.length === 0
        && persisted.research.length === 0
        && persisted.audits.length === 0,
      JSON.stringify(persisted),
    );

    failOnAudit = false;
    const committed = await runBundle(atomicRepo, {
      prospect: bundleProspect,
      research: bundleResearch,
      auditEvents: bundleAudits,
    });
    ok(
      'successful bundle commits prospect + research + both audits',
      committed && committed.ok === true
        && persisted.prospects.length === 1
        && persisted.research.length === 1
        && persisted.audits.length === 2,
      JSON.stringify({ committedOk: committed && committed.ok, persisted }),
    );

    const bundleRecorded = [];
    const recordingAtomic = store.createPgSalesRepository({
      runTransaction: async (fn) => {
        await fn(async (sql, params) => {
          bundleRecorded.push({ sql: String(sql), params });
          return { rows: [], rowCount: 1 };
        });
      },
    });
    await runBundle(recordingAtomic, {
      prospect: bundleProspect,
      research: bundleResearch,
      auditEvents: bundleAudits,
    });
    ok(
      'bundle writes qualify luna_sales and are INSERT-only',
      bundleRecorded.length >= 4
        && bundleRecorded.every((c) => /luna_sales\./.test(c.sql) && /^\s*INSERT\b/i.test(c.sql.trim())),
      bundleRecorded.map((c) => c.sql.split('\n')[0]).join(' | '),
    );
    ok(
      'bundle does not UPDATE/DELETE audit_events',
      !bundleRecorded.some((c) => /(?:UPDATE|DELETE)\s+[\s\S]*audit_events/i.test(c.sql)),
    );

    console.log('\n▸ Safe 503 for Postgres repository query/connection failures');
    const throwingQuery = async () => {
      throw LEAKY_DB_ERROR;
    };
    const leakyRepo = store.createPgSalesRepository({ query: throwingQuery });

    async function captureMutation(fn) {
      try {
        return await fn();
      } catch (err) {
        return {
          ok: false,
          thrown: true,
          name: err && err.name,
          message: err && err.message,
          code: err && err.code,
          status: err && err.status,
        };
      }
    }

    const leakyCreate = await captureMutation(() => leakyRepo.createProspectRecord(bundleProspect));
    ok('createProspectRecord DB error → safe sales_unavailable', isSafeSalesUnavailable(leakyCreate), JSON.stringify(leakyCreate));

    const leakyResearch = await captureMutation(() => leakyRepo.saveResearchJob(bundleResearch));
    ok('saveResearchJob DB error → safe sales_unavailable', isSafeSalesUnavailable(leakyResearch), JSON.stringify(leakyResearch));

    const leakyAudit = await captureMutation(() => leakyRepo.appendAuditEvent(bundleAudits[0]));
    ok('appendAuditEvent DB error → safe sales_unavailable', isSafeSalesUnavailable(leakyAudit), JSON.stringify(leakyAudit));

    const leakyDecide = await captureMutation(() => leakyRepo.updateProspectDecision(bundleProspect.id, {
      lifecycle_status: 'approved',
      updated_at: '2026-07-22T00:00:01.000Z',
      last_decision: {
        decision: 'approved',
        reason: 'ok',
        reviewer_id: 'Admin',
        created_at: '2026-07-22T00:00:01.000Z',
      },
    }));
    ok('updateProspectDecision DB error → safe sales_unavailable', isSafeSalesUnavailable(leakyDecide), JSON.stringify(leakyDecide));

    let listErr = null;
    try {
      await leakyRepo.listProspects();
    } catch (err) {
      listErr = err;
    }
    ok(
      'listProspects DB error throws SalesStoreUnavailableError',
      listErr
        && listErr.name === 'SalesStoreUnavailableError'
        && listErr.status === 503
        && listErr.code === 'sales_unavailable'
        && listErr.retryable === true,
      listErr && `${listErr.name}:${listErr.code}:${listErr.message}`,
    );
    ok(
      'listProspects thrown error message does not leak DSN/SQL/secrets',
      listErr
        && !/SuperSecretPass|postgres:\/\/|prod-db\.azure|pg_shadow|password authentication/i.test(String(listErr.message))
        && !/INSERT\s+INTO|SELECT\s+\*/i.test(String(listErr.message)),
      listErr && listErr.message,
    );

    let getErr = null;
    try {
      await leakyRepo.getProspect(bundleProspect.id);
    } catch (err) {
      getErr = err;
    }
    ok(
      'getProspect DB error throws SalesStoreUnavailableError',
      getErr && getErr.code === 'sales_unavailable' && getErr.status === 503,
      getErr && `${getErr.code}:${getErr.message}`,
    );

    console.log('\n▸ Domain createProspect uses atomic bundle on Postgres repo');
    delete require.cache[require.resolve(SALES_PATH)];
    const salesAtomic = require(SALES_PATH);
    failOnResearch = true;
    persisted.prospects.length = 0;
    persisted.research.length = 0;
    persisted.audits.length = 0;
    if (typeof salesAtomic._setSalesRepositoryForTests === 'function') {
      salesAtomic._setSalesRepositoryForTests(atomicRepo);
    }
    let domainPartial = null;
    try {
      domainPartial = await salesAtomic.createProspect(
        { business_name: 'Domain Atomic Hostel' },
        'Earthling',
      );
    } catch (err) {
      domainPartial = {
        ok: false,
        thrown: true,
        name: err && err.name,
        message: err && err.message,
        code: err && err.code,
        status: err && err.status,
      };
    }
    ok(
      'domain createProspect surfaces safe unavailable when bundle fails',
      isSafeSalesUnavailable(domainPartial),
      JSON.stringify(domainPartial),
    );
    ok(
      'domain createProspect does not leave partial rows when bundle fails',
      persisted.prospects.length === 0
        && persisted.research.length === 0
        && persisted.audits.length === 0,
      JSON.stringify(persisted),
    );

    console.log('\n▸ API maps Sales-unavailable to safe retryable 503 (no leak)');
    delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'crowsnest-api.js'))];
    const apiMod = require(path.join(ROOT, 'scripts', 'crowsnest-api.js'));
    ok(
      'api exports or documents sales-unavailable helper path',
      typeof apiMod.sendSalesUnavailable === 'function'
        || /sales_unavailable|SalesStoreUnavailableError|sendSalesUnavailable/.test(read(API_PATH) || ''),
    );

    // Lightweight router-level proof via injected domain failure on list
    const http = require('http');
    function mockRes() {
      return {
        headersSent: false,
        statusCode: null,
        headers: {},
        body: '',
        writeHead(code, headers) {
          this.statusCode = code;
          this.headers = headers || {};
        },
        end(chunk) {
          this.body = chunk == null ? '' : String(chunk);
        },
      };
    }
    ok(
      'store exports SalesStoreUnavailableError',
      typeof store.SalesStoreUnavailableError === 'function',
    );
    ok(
      'store exports isSalesStoreUnavailableError',
      typeof store.isSalesStoreUnavailableError === 'function',
    );

    if (typeof store.SalesStoreUnavailableError === 'function'
      && typeof apiMod.router === 'function') {
      delete require.cache[require.resolve(SALES_PATH)];
      const salesForApi = require(SALES_PATH);
      const boomRepo = {
        backend: 'postgres',
        async listProspects() {
          throw new store.SalesStoreUnavailableError();
        },
        async getProspect() {
          throw new store.SalesStoreUnavailableError();
        },
        async getResearchForProspect() {
          throw new store.SalesStoreUnavailableError();
        },
        async listAuditEvents() {
          throw new store.SalesStoreUnavailableError();
        },
        async createProspectRecord() {
          return {
            ok: false,
            status: 503,
            code: 'sales_unavailable',
            error: 'Crowsnest Sales store is temporarily unavailable. Please retry.',
            retryable: true,
          };
        },
        async saveResearchJob() {
          return this.createProspectRecord();
        },
        async appendAuditEvent() {
          return this.createProspectRecord();
        },
        async updateProspectDecision() {
          return this.createProspectRecord();
        },
        async createProspectBundle() {
          return this.createProspectRecord();
        },
      };
      salesForApi._setSalesRepositoryForTests(boomRepo);

      // Re-require api so it picks up sales module with boom repo — api already bound
      // createProspect/listProspects at load time, so exercise store error helper + sales path.
      const unavailable = new store.SalesStoreUnavailableError();
      ok(
        'isSalesStoreUnavailableError recognizes thrown unavailable',
        store.isSalesStoreUnavailableError(unavailable) === true,
      );
      ok(
        'SalesStoreUnavailableError message is safe',
        !/SuperSecretPass|postgres:\/\/|azure|pg_shadow/i.test(unavailable.message)
          && /unavailable|retry/i.test(unavailable.message),
        unavailable.message,
      );

      // Domain listProspects should propagate unavailable error (not leaky raw Error)
      let domainListErr = null;
      try {
        await salesForApi.listProspects();
      } catch (err) {
        domainListErr = err;
      }
      ok(
        'domain listProspects propagates SalesStoreUnavailableError',
        store.isSalesStoreUnavailableError(domainListErr),
        domainListErr && domainListErr.message,
      );

      void http;
      void mockRes;
    }

    // Source-level: API catches unavailable and responds 503 without leaking internals
    const apiSrc = read(path.join(ROOT, 'scripts', 'crowsnest-api.js')) || '';
    ok(
      'api handles SalesStoreUnavailableError / sales_unavailable with 503',
      /sales_unavailable|SalesStoreUnavailableError|sendSalesUnavailable/.test(apiSrc)
        && /503/.test(apiSrc),
    );
    ok(
      'api sales-unavailable response omits provider internals in source contract',
      /temporarily unavailable|Please retry/i.test(apiSrc)
        && !/pg_shadow|connectionString|WOLFHOUSE_DATABASE_URL/.test(apiSrc),
    );

    // Reset domain test seam before exit
    delete require.cache[require.resolve(SALES_PATH)];
    delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'crowsnest-api.js'))];
    if (typeof store.closeSalesStore === 'function') {
      await store.closeSalesStore();
    }

    console.log(`\n── verify:crowsnest-sales-durable: ${pass} passed, ${fail} failed ──`);
    if (fail > 0) {
      console.log('verify:crowsnest-sales-durable — FAILED');
      process.exitCode = 1;
    } else {
      console.log('verify:crowsnest-sales-durable — ALL CHECKS PASSED');
    }
  })().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
} else {
  console.log(`\n── verify:crowsnest-sales-durable: ${pass} passed, ${fail} failed ──`);
  console.log('verify:crowsnest-sales-durable — FAILED');
  process.exitCode = 1;
}
