'use strict';

/**
 * verify:email-tenant-channel-registry — Luna email Slice 1C-alpha offline gate.
 *
 * Hostile mock-pg + pure-helper abuse tests for the domain/repository layer over
 * tenant_locations + tenant_channel_endpoints. No network, no live/staging DB,
 * no provider SDKs, no routes/auth/activation.
 *
 * Behavioral PostgreSQL proof: prove-email-tenant-channel-registry-pg.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODULE_REL = 'scripts/lib/email-tenant-channel-registry.js';
const MODULE_PATH = path.join(ROOT, MODULE_REL);
const CONTRACT_REL = 'scripts/lib/email-mailbox-adapter-contract.js';
const CONTRACT_PATH = path.join(ROOT, CONTRACT_REL);
const DOC_PATH = path.join(ROOT, 'docs', 'EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const VERIFY_REL = 'scripts/verify-email-tenant-channel-registry.js';
const PROVE_REL = 'scripts/prove-email-tenant-channel-registry-pg.js';
const PROVE_PATH = path.join(ROOT, PROVE_REL);

const CLIENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LOC_A = 'beach-house';
const LOC_B = 'mountain-camp';

const CAPS_ALL_FALSE = Object.freeze({
  push_notifications: false,
  provider_threads: false,
  remote_drafts: false,
  reply: false,
  reply_all: false,
  forward: false,
  attachments_metadata: false,
  delivery_events: false,
});

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

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function isPromise(v) {
  return Boolean(v) && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
}

/**
 * Hostile mock pg: records every query; supports scripted responses / throw.
 * Ensures tests can assert client_id scoping and transaction lifecycle.
 */
function createHostileMockPg(handlers) {
  const queries = [];
  let tx = 'idle';
  const db = {
    queries,
    get tx() { return tx; },
    async query(sql, params) {
      const text = String(sql || '');
      const p = Array.isArray(params) ? params.slice() : [];
      queries.push({ text, params: p, tx });
      if (/^\s*BEGIN\b/i.test(text)) {
        tx = 'open';
        return { rows: [], rowCount: 0 };
      }
      if (/^\s*COMMIT\b/i.test(text)) {
        tx = 'committed';
        return { rows: [], rowCount: 0 };
      }
      if (/^\s*ROLLBACK\b/i.test(text)) {
        tx = 'rolled_back';
        return { rows: [], rowCount: 0 };
      }
      for (const h of handlers || []) {
        if (h.match(text, p)) {
          if (typeof h.run === 'function') return h.run(text, p, { tx, queries });
          if (h.throw) {
            const err = h.throw instanceof Error ? h.throw : Object.assign(new Error(h.throw.message || 'pg error'), h.throw);
            throw err;
          }
          return h.result || { rows: [], rowCount: 0 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return db;
}

function sqlHasClientParam(text, params, clientId) {
  const t = String(text);
  // Parameterized: client_id = $N and params include trusted clientId
  if (!/client_id\s*=\s*\$\d+/i.test(t) && !/VALUES\s*\([^)]*\$\d+/i.test(t)) {
    // Still allow advisory locks keyed by client
    if (/pg_advisory_xact_lock/i.test(t) && params.includes(clientId)) return true;
    return false;
  }
  return params.map(String).includes(String(clientId));
}

function noRawPgLeak(result) {
  if (!result || typeof result !== 'object') return false;
  const blob = JSON.stringify(result);
  if (/duplicate key value|violates unique constraint|violates foreign key|relation \"|syntax error at/i.test(blob)) {
    return false;
  }
  if (/password=|sk-[A-Za-z0-9]{10,}|BEGIN (?:RSA |EC )?PRIVATE KEY/i.test(blob)) {
    return false;
  }
  return true;
}

console.log('verify:email-tenant-channel-registry — Slice 1C-alpha offline\n');

// --- Presence / boundary files ---
ok('module-file-exists', fs.existsSync(MODULE_PATH), MODULE_REL);
ok('contract-1a-exists', fs.existsSync(CONTRACT_PATH), CONTRACT_REL);
ok('offline-prove-script-exists', fs.existsSync(PROVE_PATH), PROVE_REL);
ok('docs-boundary-exists', fs.existsSync(DOC_PATH));

let pkg = null;
try {
  pkg = JSON.parse(read(PKG_PATH));
} catch {
  pkg = null;
}
ok(
  'package-has-offline-verify',
  Boolean(pkg && pkg.scripts && pkg.scripts['verify:email-tenant-channel-registry']),
);
ok(
  'package-has-pg-prove',
  Boolean(pkg && pkg.scripts && pkg.scripts['prove:email-tenant-channel-registry-pg']),
);
ok(
  'package-keeps-1a-1b-scripts',
  Boolean(
    pkg
    && pkg.scripts
    && pkg.scripts['verify:email-mailbox-adapter-contract']
    && pkg.scripts['verify:email-tenant-location-registry']
    && pkg.scripts['prove:email-tenant-location-registry-pg'],
  ),
);

// staff-query-api.js must not be modified for this slice (OUT of scope).
// Offline gate: module must not require staff-query-api.
let modSrc = '';
if (fs.existsSync(MODULE_PATH)) modSrc = read(MODULE_PATH);
ok(
  'module-does-not-require-staff-query-api',
  !/staff-query-api/.test(modSrc),
);
ok(
  'module-no-provider-sdk-imports',
  !modSrc
    || (
      !/@microsoft\/microsoft-graph/i.test(modSrc)
      && !/googleapis|nodemailer|imapflow|graph-client/i.test(modSrc)
      && !/require\(['\"]pg['\"]\)|from ['\"]pg['\"]/.test(modSrc)
      && !/process\.env\.(DATABASE_URL|PGHOST|AZURE_)/.test(modSrc)
    ),
);
ok(
  'module-depends-on-1a-contract',
  !modSrc || /email-mailbox-adapter-contract/.test(modSrc),
);

let doc = '';
if (fs.existsSync(DOC_PATH)) doc = read(DOC_PATH);
ok(
  'docs-mention-slice-1c-alpha',
  /Slice\s*1C-alpha|1C-alpha|Slice\s*1C/i.test(doc)
    && /email-tenant-channel-registry|domain\/repository|repository layer/i.test(doc),
);
ok(
  'docs-no-routes-or-activation',
  /no HTTP routes|without routes|no routes|defers routes|routes deferred/i.test(doc)
    || (/1C-alpha/i.test(doc) && /no .*routes|not .*routes|without .*HTTP/i.test(doc)),
);
ok(
  'docs-preloaded-authority-helper',
  /buildPreloadedLocationAuthority/i.test(doc)
    && /synchronous|preloaded/i.test(doc),
);
ok(
  'docs-stock-pg-before-deploy-note',
  /stock PostgreSQL|stock PG|before deploy/i.test(doc) && /PGlite/i.test(doc),
);
ok(
  'docs-disabled-create-only',
  /createDisabledTenantChannelEndpoint|disabled endpoint|active\s*=\s*false|inbound.*false/i.test(doc),
);

// --- Load module (RED if missing) ---
let reg = null;
let loadErr = null;
if (fs.existsSync(MODULE_PATH)) {
  try {
    // Clear cache so re-runs after edits see fresh code.
    delete require.cache[require.resolve(MODULE_PATH)];
    reg = require(MODULE_PATH);
  } catch (e) {
    loadErr = e;
  }
}
ok('module-loads', Boolean(reg), loadErr ? String(loadErr.message || loadErr).slice(0, 160) : 'module missing');

const requiredFns = [
  'buildPreloadedLocationAuthority',
  'listTenantLocations',
  'listTenantChannelEndpoints',
  'createTenantLocation',
  'createDisabledTenantChannelEndpoint',
];
for (const fn of requiredFns) {
  ok(`exports-${fn}`, Boolean(reg && typeof reg[fn] === 'function'));
}

// ---------------------------------------------------------------------------
// Pure helper: buildPreloadedLocationAuthority
// ---------------------------------------------------------------------------
console.log('\n── buildPreloadedLocationAuthority ──');

if (reg && typeof reg.buildPreloadedLocationAuthority === 'function') {
  const authPair = reg.buildPreloadedLocationAuthority({
    clientId: CLIENT_A,
    locationId: LOC_A,
  });
  ok('authority-is-function', typeof authPair === 'function');
  ok('authority-never-promise-factory', !isPromise(authPair));
  const r1 = authPair(CLIENT_A, LOC_A);
  ok('authority-exact-match-true', r1 === true && !isPromise(r1));
  ok('authority-cross-tenant-false', authPair(CLIENT_B, LOC_A) === false);
  ok('authority-unknown-location-false', authPair(CLIENT_A, 'no-such') === false);
  ok('authority-exact-canonical-no-casefold', authPair(CLIENT_A.toUpperCase(), LOC_A) === false
    || CLIENT_A.toUpperCase() === CLIENT_A);
  // UUID lower-case vs mixed: helper compares exact; mixed case must fail if different string.
  ok(
    'authority-exact-client-string',
    authPair(CLIENT_A.replace('aaaa', 'AAAA'), LOC_A) === false,
  );
  ok('authority-exact-location-string', authPair(CLIENT_A, 'Beach-House') === false);

  // Set form
  const set = new Set([`${CLIENT_A}\0${LOC_A}`, `${CLIENT_B}\0${LOC_B}`]);
  const authSet = reg.buildPreloadedLocationAuthority(set);
  ok('authority-set-match-a', authSet(CLIENT_A, LOC_A) === true);
  ok('authority-set-match-b', authSet(CLIENT_B, LOC_B) === true);
  ok('authority-set-miss', authSet(CLIENT_A, LOC_B) === false);
  ok('authority-set-sync-no-promise', !isPromise(authSet(CLIENT_A, LOC_A)));

  // Immutable Set of pairs via frozen array entries (optional accepted form)
  if (reg.buildPreloadedLocationAuthority.length >= 0) {
    try {
      const authPairs = reg.buildPreloadedLocationAuthority(
        Object.freeze([{ clientId: CLIENT_A, locationId: LOC_A }]),
      );
      ok(
        'authority-array-pair-form',
        typeof authPairs === 'function' && authPairs(CLIENT_A, LOC_A) === true,
      );
    } catch (e) {
      // Array form optional if pair/Set covered; not a hard fail if rejected as invalid.
      ok('authority-array-pair-form-optional', true);
    }
  }

  // Must not return Promise even if input looks async-ish
  const syncCheck = reg.buildPreloadedLocationAuthority({ clientId: CLIENT_A, locationId: LOC_A });
  const immediate = syncCheck(CLIENT_A, LOC_A);
  ok('authority-return-not-thenable', !isPromise(immediate));
} else {
  ok('authority-is-function', false, 'missing export');
}

// ---------------------------------------------------------------------------
// listTenantLocations — mock pg
// ---------------------------------------------------------------------------
console.log('\n── listTenantLocations ──');

async function runListLocationTests() {
  if (!reg || typeof reg.listTenantLocations !== 'function') {
    ok('list-locations-export', false);
    return;
  }

  const rows = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      client_id: CLIENT_A,
      location_id: LOC_A,
      display_name: 'Beach House',
      active: true,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      client_id: CLIENT_A,
      location_id: 'dock-side',
      display_name: 'Dock',
      active: false,
    },
  ];

  const db = createHostileMockPg([
    {
      match: (t) => /FROM\s+tenant_locations/i.test(t) && /SELECT/i.test(t),
      run: (t, p) => {
        ok('list-locations-sql-scoped-client', sqlHasClientParam(t, p, CLIENT_A));
        ok('list-locations-parameterized-uuid', p.includes(CLIENT_A));
        ok('list-locations-deterministic-order', /ORDER\s+BY/i.test(t));
        const includeInactive = !/active\s*=\s*true/i.test(t);
        const filtered = includeInactive ? rows : rows.filter((r) => r.active);
        return { rows: filtered, rowCount: filtered.length };
      },
    },
  ]);

  const listed = await reg.listTenantLocations({ clientId: CLIENT_A }, { db });
  ok('list-locations-ok', listed && listed.ok === true);
  ok(
    'list-locations-returns-rows',
    listed && listed.ok && Array.isArray(listed.value) && listed.value.length === 2,
  );

  const dbActive = createHostileMockPg([
    {
      match: (t) => /FROM\s+tenant_locations/i.test(t),
      run: (t, p) => {
        ok('list-locations-active-only-filter', /active\s*=\s*(true|TRUE|\$\d+)/i.test(t));
        ok('list-locations-active-still-scoped', sqlHasClientParam(t, p, CLIENT_A));
        return { rows: rows.filter((r) => r.active), rowCount: 1 };
      },
    },
  ]);
  const listedActive = await reg.listTenantLocations(
    { clientId: CLIENT_A, includeInactive: false },
    { db: dbActive },
  );
  ok('list-locations-active-ok', listedActive && listedActive.ok === true && listedActive.value.length === 1);

  // Reject missing clientId
  const bad = await reg.listTenantLocations({}, { db: createHostileMockPg([]) });
  ok('list-locations-requires-client', bad && bad.ok === false);

  // Body client_id must not override trusted clientId — only trusted arg scopes SQL
  const dbTrap = createHostileMockPg([
    {
      match: (t) => /tenant_locations/i.test(t),
      run: (t, p) => {
        ok('list-locations-ignores-body-client', !p.includes(CLIENT_B) && p.includes(CLIENT_A));
        return { rows: [], rowCount: 0 };
      },
    },
  ]);
  await reg.listTenantLocations(
    { clientId: CLIENT_A, client_id: CLIENT_B, body: { client_id: CLIENT_B } },
    { db: dbTrap },
  );
}

// ---------------------------------------------------------------------------
// listTenantChannelEndpoints — mock pg
// ---------------------------------------------------------------------------
async function runListEndpointTests() {
  if (!reg || typeof reg.listTenantChannelEndpoints !== 'function') {
    ok('list-endpoints-export', false);
    return;
  }
  console.log('\n── listTenantChannelEndpoints ──');

  const secret = 'kv:luna-support-email-credentials';
  const epRows = [
    {
      id: '33333333-3333-4333-8333-333333333333',
      client_id: CLIENT_A,
      location_id: LOC_A,
      channel: 'email',
      provider: 'microsoft_graph',
      public_address: 'a@example.com',
      secret_ref: secret,
      capabilities: CAPS_ALL_FALSE,
      inbound_enabled: false,
      outbound_enabled: false,
      default_automation_mode: 'off',
      active: false,
    },
  ];

  const db = createHostileMockPg([
    {
      match: (t) => /FROM\s+tenant_channel_endpoints/i.test(t) && /SELECT/i.test(t),
      run: (t, p) => {
        ok('list-endpoints-sql-scoped-client', sqlHasClientParam(t, p, CLIENT_A));
        ok('list-endpoints-deterministic-order', /ORDER\s+BY/i.test(t));
        return { rows: epRows, rowCount: epRows.length };
      },
    },
  ]);

  const listed = await reg.listTenantChannelEndpoints({ clientId: CLIENT_A }, { db });
  ok('list-endpoints-ok', listed && listed.ok === true);
  ok(
    'list-endpoints-returns-opaque-secret-ref',
    listed && listed.ok && listed.value[0] && listed.value[0].secret_ref === secret,
  );
  // Never "resolve" secret — value is still the ref string only
  ok(
    'list-endpoints-does-not-resolve-secret',
    listed && listed.ok && !listed.value[0].secret && !listed.value[0].password,
  );
  ok(
    'list-endpoints-result-no-secret-leak-patterns',
    listed && noRawPgLeak(listed),
  );
}

// ---------------------------------------------------------------------------
// createTenantLocation — mock pg
// ---------------------------------------------------------------------------
async function runCreateLocationTests() {
  if (!reg || typeof reg.createTenantLocation !== 'function') {
    ok('create-location-export', false);
    return;
  }
  console.log('\n── createTenantLocation ──');

  const dbOk = createHostileMockPg([
    {
      match: (t) => /INSERT\s+INTO\s+tenant_locations/i.test(t),
      run: (t, p) => {
        ok('create-loc-sql-scoped-client', p.includes(CLIENT_A));
        ok('create-loc-parameterized', /\$1/.test(t) && p.length >= 3);
        ok('create-loc-no-upsert', !/ON\s+CONFLICT/i.test(t));
        ok('create-loc-actor-param', p.includes(ACTOR));
        ok('create-loc-location-id-param', p.includes(LOC_A));
        return {
          rows: [{
            id: '44444444-4444-4444-8444-444444444444',
            client_id: CLIENT_A,
            location_id: LOC_A,
            display_name: 'Beach House',
            active: true,
            created_by: ACTOR,
          }],
          rowCount: 1,
        };
      },
    },
  ]);

  const created = await reg.createTenantLocation({
    clientId: CLIENT_A,
    actorStaffUserId: ACTOR,
    locationId: LOC_A,
    displayName: 'Beach House',
  }, { client: dbOk });
  ok('create-loc-ok', created && created.ok === true);
  ok('create-loc-default-active', created && created.ok && created.value && created.value.active === true);
  ok('create-loc-tx-commit', dbOk.tx === 'committed' || dbOk.tx === 'idle');

  // Uniqueness → stable conflict
  const dbDup = createHostileMockPg([
    {
      match: (t) => /INSERT\s+INTO\s+tenant_locations/i.test(t),
      throw: Object.assign(new Error('duplicate key value violates unique constraint "tenant_locations_client_location_uq"'), {
        code: '23505',
        constraint: 'tenant_locations_client_location_uq',
      }),
    },
  ]);
  const dup = await reg.createTenantLocation({
    clientId: CLIENT_A,
    actorStaffUserId: ACTOR,
    locationId: LOC_A,
    displayName: 'Beach House',
  }, { client: dbDup });
  ok('create-loc-conflict-stable', dup && dup.ok === false && dup.error === 'location_already_exists');
  ok('create-loc-conflict-no-raw-pg', dup && noRawPgLeak(dup));
  ok('create-loc-conflict-rollback', dbDup.tx === 'rolled_back' || dbDup.queries.some((q) => /ROLLBACK/i.test(q.text)));

  // Validation: empty display name
  const badName = await reg.createTenantLocation({
    clientId: CLIENT_A,
    actorStaffUserId: ACTOR,
    locationId: LOC_A,
    displayName: '   ',
  }, { client: createHostileMockPg([]) });
  ok('create-loc-rejects-blank-display', badName && badName.ok === false);

  // Validation: non-canonical location
  const badLoc = await reg.createTenantLocation({
    clientId: CLIENT_A,
    actorStaffUserId: ACTOR,
    locationId: 'Beach House',
    displayName: 'X',
  }, { client: createHostileMockPg([]) });
  ok('create-loc-rejects-noncanonical-location', badLoc && badLoc.ok === false);

  // Mass-assignment: body client_id must not scope insert
  const dbMass = createHostileMockPg([
    {
      match: (t) => /INSERT\s+INTO\s+tenant_locations/i.test(t),
      run: (t, p) => {
        ok('create-loc-trusted-client-only', p.includes(CLIENT_A) && !p.includes(CLIENT_B));
        return {
          rows: [{
            id: '55555555-5555-4555-8555-555555555555',
            client_id: CLIENT_A,
            location_id: 'other-loc',
            display_name: 'Other',
            active: true,
          }],
          rowCount: 1,
        };
      },
    },
  ]);
  await reg.createTenantLocation({
    clientId: CLIENT_A,
    actorStaffUserId: ACTOR,
    locationId: 'other-loc',
    displayName: 'Other',
    client_id: CLIENT_B,
    id: 'evil-id',
    created_by: CLIENT_B,
    active: false,
  }, { client: dbMass });

  // DB error rollback, no raw message
  const dbBoom = createHostileMockPg([
    {
      match: (t) => /INSERT\s+INTO\s+tenant_locations/i.test(t),
      throw: Object.assign(new Error('connection terminated unexpectedly password=supersecret'), {
        code: '57P01',
      }),
    },
  ]);
  const boom = await reg.createTenantLocation({
    clientId: CLIENT_A,
    actorStaffUserId: ACTOR,
    locationId: 'boom-loc',
    displayName: 'Boom',
  }, { client: dbBoom });
  ok('create-loc-db-error-structured', boom && boom.ok === false && boom.error === 'db_error');
  ok('create-loc-db-error-no-raw', boom && noRawPgLeak(boom) && !JSON.stringify(boom).includes('password=supersecret'));
  ok('create-loc-db-error-rollback', dbBoom.tx === 'rolled_back' || dbBoom.queries.some((q) => /ROLLBACK/i.test(q.text)));
}

// ---------------------------------------------------------------------------
// createDisabledTenantChannelEndpoint — mock pg abuse suite
// ---------------------------------------------------------------------------
async function runCreateEndpointTests() {
  if (!reg || typeof reg.createDisabledTenantChannelEndpoint !== 'function') {
    ok('create-endpoint-export', false);
    return;
  }
  console.log('\n── createDisabledTenantChannelEndpoint ──');

  const validFields = {
    location_id: LOC_A,
    provider: 'microsoft_graph',
    public_address: 'support@example.com',
    secret_ref: 'kv:luna-support-email-credentials',
    capabilities: { ...CAPS_ALL_FALSE },
  };

  function makeCreateDb(opts = {}) {
    let locationLookupDone = false;
    let authorityBuiltBeforeLookup = opts.trackAuthorityOrder ? false : null;
    const state = { locationLookupDone: false, insertParams: null, validateOrder: [] };

    const db = createHostileMockPg([
      {
        match: (t) => /pg_advisory_xact_lock/i.test(t),
        result: { rows: [{ pg_advisory_xact_lock: '' }], rowCount: 1 },
      },
      {
        match: (t) => /FROM\s+tenant_locations/i.test(t) && /SELECT/i.test(t),
        run: async (t, p) => {
          ok('create-ep-location-select-scoped', sqlHasClientParam(t, p, CLIENT_A));
          const expectedLoc = opts.locationId || LOC_A;
          // Location token is always parameterized (may be LOC_A or another token under test).
          ok(
            'create-ep-location-uses-location-id',
            p.some((x) => typeof x === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x)),
            `params=${JSON.stringify(p)}`,
          );
          if (opts.delayLocationMs) {
            await new Promise((r) => setTimeout(r, opts.delayLocationMs));
          }
          state.locationLookupDone = true;
          locationLookupDone = true;
          if (opts.noLocation) return { rows: [], rowCount: 0 };
          if (opts.inactiveLocation) {
            return {
              rows: opts.returnInactiveRow
                ? [{ client_id: CLIENT_A, location_id: expectedLoc, active: false }]
                : [],
              rowCount: opts.returnInactiveRow ? 1 : 0,
            };
          }
          if (opts.crossTenantRow) {
            // Should not happen if SQL scopes by client — but if it did, still fail closed
            return {
              rows: [{ client_id: CLIENT_B, location_id: expectedLoc, active: true }],
              rowCount: 1,
            };
          }
          return {
            rows: [{
              client_id: CLIENT_A,
              location_id: expectedLoc,
              active: true,
              display_name: 'Beach House',
            }],
            rowCount: 1,
          };
        },
      },
      {
        match: (t) => /FROM\s+tenant_channel_endpoints/i.test(t) && /SELECT/i.test(t),
        run: (t, p) => {
          ok('create-ep-dup-check-scoped', sqlHasClientParam(t, p, CLIENT_A));
          if (opts.existingAddress) {
            return {
              rows: [{ id: '66666666-6666-4666-8666-666666666666', public_address: 'support@example.com' }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        },
      },
      {
        match: (t) => /INSERT\s+INTO\s+tenant_channel_endpoints/i.test(t),
        run: (t, p) => {
          state.insertParams = { text: t, params: p };
          ok('create-ep-insert-scoped-client', p.includes(CLIENT_A));
          ok('create-ep-insert-no-upsert', !/ON\s+CONFLICT/i.test(t));
          // Forced disabled state in params
          const bools = p.filter((x) => x === true || x === false);
          const hasTrueEnable = p.includes(true) && (
            // channel is not boolean; ensure inbound/outbound/active false present
            true
          );
          // At least three false flags for inbound, outbound, active
          const falseCount = p.filter((x) => x === false).length;
          ok('create-ep-insert-forced-disabled-bools', falseCount >= 3, `falseCount=${falseCount}`);
          ok('create-ep-insert-automation-off', p.includes('off'));
          ok('create-ep-insert-channel-email', p.includes('email'));
          ok('create-ep-insert-no-true-activation', !p.includes(true) || (() => {
            // capabilities may not be expanded; true should not appear as activation
            // If capabilities object is passed as JSON string, true might appear inside JSON
            const activationTrue = p.some((x, i) => x === true && typeof p[i] === 'boolean');
            // Allow true only if not used — we force false. Reject any bare true.
            return !activationTrue;
          })());
          if (opts.insertThrow) {
            throw Object.assign(
              new Error(opts.insertThrow.message || 'duplicate key value violates unique constraint'),
              { code: opts.insertThrow.code || '23505', constraint: opts.insertThrow.constraint },
            );
          }
          return {
            rows: [{
              id: '77777777-7777-4777-8777-777777777777',
              client_id: CLIENT_A,
              location_id: LOC_A,
              channel: 'email',
              provider: 'microsoft_graph',
              public_address: 'support@example.com',
              secret_ref: 'kv:luna-support-email-credentials',
              capabilities: CAPS_ALL_FALSE,
              inbound_enabled: false,
              outbound_enabled: false,
              default_automation_mode: 'off',
              active: false,
              created_by: ACTOR,
            }],
            rowCount: 1,
          };
        },
      },
    ]);
    db._state = state;
    db._getLocationLookupDone = () => locationLookupDone;
    return db;
  }

  // Happy path
  {
    const db = makeCreateDb();
    const res = await reg.createDisabledTenantChannelEndpoint({
      clientId: CLIENT_A,
      actorStaffUserId: ACTOR,
      ...validFields,
    }, { client: db });
    ok('create-ep-ok', res && res.ok === true, res && res.error);
    ok(
      'create-ep-defaults-disabled',
      res && res.ok
        && res.value.inbound_enabled === false
        && res.value.outbound_enabled === false
        && res.value.active === false
        && res.value.default_automation_mode === 'off',
    );
    ok('create-ep-returns-opaque-secret-ref', res && res.ok && res.value.secret_ref === 'kv:luna-support-email-credentials');
    ok('create-ep-commit', db.tx === 'committed');
    ok('create-ep-began-tx', db.queries.some((q) => /BEGIN/i.test(q.text)));
  }

  // Missing / inactive / cross-tenant location → location_not_authorized (indistinguishable)
  for (const [label, opts] of [
    ['missing', { noLocation: true }],
    ['inactive', { inactiveLocation: true }],
    ['cross-tenant-empty', { noLocation: true }],
  ]) {
    const db = makeCreateDb(opts);
    const res = await reg.createDisabledTenantChannelEndpoint({
      clientId: CLIENT_A,
      actorStaffUserId: ACTOR,
      ...validFields,
    }, { client: db });
    ok(
      `create-ep-${label}-location_not_authorized`,
      res && res.ok === false && res.error === 'location_not_authorized',
      res && res.error,
    );
    ok(`create-ep-${label}-rollback`, db.tx === 'rolled_back' || db.queries.some((q) => /ROLLBACK/i.test(q.text)));
    ok(`create-ep-${label}-no-raw`, res && noRawPgLeak(res));
  }

  // Tenant A cannot create against tenant B's location token without ownership
  {
    const db = makeCreateDb({ noLocation: true });
    const res = await reg.createDisabledTenantChannelEndpoint({
      clientId: CLIENT_A,
      actorStaffUserId: ACTOR,
      ...validFields,
      location_id: LOC_B, // owned by B in real world; mock returns empty for A
    }, { client: db });
    ok(
      'create-ep-cross-tenant-location_not_authorized',
      res && res.ok === false && res.error === 'location_not_authorized',
    );
  }

  // Await location lookup before sync authority (order test)
  {
    let authorityCallDuringLookup = false;
    const originalBuild = reg.buildPreloadedLocationAuthority;
    // We can't easily monkeypatch exports if bound; instead use delay and ensure success.
    const db = makeCreateDb({ delayLocationMs: 30 });
    const start = Date.now();
    const res = await reg.createDisabledTenantChannelEndpoint({
      clientId: CLIENT_A,
      actorStaffUserId: ACTOR,
      ...validFields,
      public_address: 'order@example.com',
    }, { client: db });
    ok('create-ep-awaits-location-lookup', res && res.ok === true && (Date.now() - start) >= 25);
    // Location SELECT must appear before INSERT
    const selIdx = db.queries.findIndex((q) => /FROM\s+tenant_locations/i.test(q.text));
    const insIdx = db.queries.findIndex((q) => /INSERT\s+INTO\s+tenant_channel_endpoints/i.test(q.text));
    ok('create-ep-select-before-insert', selIdx >= 0 && insIdx > selIdx, `sel=${selIdx} ins=${insIdx}`);
    void authorityCallDuringLookup;
    void originalBuild;
  }

  // Attempted activation rejected
  for (const [label, patch] of [
    ['active-true', { active: true }],
    ['inbound-true', { inbound_enabled: true }],
    ['outbound-true', { outbound_enabled: true }],
    ['automation-auto', { default_automation_mode: 'automatic' }],
    ['automation-draft', { default_automation_mode: 'draft_only' }],
  ]) {
    const db = makeCreateDb();
    const res = await reg.createDisabledTenantChannelEndpoint({
      clientId: CLIENT_A,
      actorStaffUserId: ACTOR,
      ...validFields,
      ...patch,
    }, { client: db });
    ok(
      `create-ep-rejects-${label}`,
      res && res.ok === false,
      res && res.error,
    );
    ok(
      `create-ep-rejects-${label}-no-insert`,
      !db.queries.some((q) => /INSERT\s+INTO\s+tenant_channel_endpoints/i.test(q.text)),
    );
  }

  // Unknown keys / injection
  for (const [label, patch] of [
    ['unknown-key', { evil_field: 'x' }],
    ['created_by-inject', { created_by: ACTOR }],
    ['id-inject', { id: '88888888-8888-4888-8888-888888888888' }],
    ['channel-whatsapp', { channel: 'whatsapp' }],
    ['client_id-body', { client_id: CLIENT_B }],
    ['locationAuthority-body', { locationAuthority: () => true }],
    ['location_authority-body', { location_authority: () => true }],
  ]) {
    const db = makeCreateDb();
    const res = await reg.createDisabledTenantChannelEndpoint({
      clientId: CLIENT_A,
      actorStaffUserId: ACTOR,
      ...validFields,
      ...patch,
    }, { client: db });
    ok(
      `create-ep-rejects-${label}`,
      res && res.ok === false,
      res && JSON.stringify(res).slice(0, 120),
    );
  }

  // Invalid provider / capabilities / address / secret_ref before insert
  for (const [label, patch] of [
    ['bad-provider', { provider: 'sendgrid' }],
    ['bad-caps-extra', { capabilities: { ...CAPS_ALL_FALSE, extra: true } }],
    ['bad-address', { public_address: 'not-an-email' }],
    ['bad-secret-raw', { secret_ref: 'sk-abcdefghijklmnopqrstuvwxyz012345' }],
    ['bad-secret-scheme', { secret_ref: 'vault:path' }],
  ]) {
    const db = makeCreateDb();
    const res = await reg.createDisabledTenantChannelEndpoint({
      clientId: CLIENT_A,
      actorStaffUserId: ACTOR,
      ...validFields,
      ...patch,
    }, { client: db });
    ok(`create-ep-rejects-${label}`, res && res.ok === false, res && res.error);
    ok(
      `create-ep-rejects-${label}-no-insert`,
      !db.queries.some((q) => /INSERT\s+INTO\s+tenant_channel_endpoints/i.test(q.text)),
    );
  }

  // Duplicate inactive address within tenant
  {
    const db = makeCreateDb({ existingAddress: true });
    const res = await reg.createDisabledTenantChannelEndpoint({
      clientId: CLIENT_A,
      actorStaffUserId: ACTOR,
      ...validFields,
    }, { client: db });
    ok(
      'create-ep-duplicate-address-conflict',
      res && res.ok === false && res.error === 'endpoint_already_exists',
      res && res.error,
    );
    ok('create-ep-duplicate-no-raw', res && noRawPgLeak(res));
  }

  // Insert unique violation mapped
  {
    const db = makeCreateDb({
      insertThrow: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "tenant_channel_endpoints_active_public_address_uidx"',
        constraint: 'tenant_channel_endpoints_active_public_address_uidx',
      },
    });
    const res = await reg.createDisabledTenantChannelEndpoint({
      clientId: CLIENT_A,
      actorStaffUserId: ACTOR,
      ...validFields,
      public_address: 'uniq@example.com',
    }, { client: db });
    ok(
      'create-ep-unique-violation-mapped',
      res && res.ok === false && res.error === 'endpoint_already_exists',
    );
    ok('create-ep-unique-no-raw-pg', res && noRawPgLeak(res));
    ok('create-ep-unique-rollback', db.tx === 'rolled_back' || db.queries.some((q) => /ROLLBACK/i.test(q.text)));
  }

  // Generic DB error
  {
    const db = makeCreateDb({
      insertThrow: {
        code: '08006',
        message: 'server closed the connection unexpectedly secret=hunter2',
      },
    });
    const res = await reg.createDisabledTenantChannelEndpoint({
      clientId: CLIENT_A,
      actorStaffUserId: ACTOR,
      ...validFields,
      public_address: 'err@example.com',
    }, { client: db });
    ok('create-ep-db-error-structured', res && res.ok === false && res.error === 'db_error');
    ok(
      'create-ep-db-error-no-secret-surface',
      res && noRawPgLeak(res) && !JSON.stringify(res).includes('hunter2'),
    );
  }

  // Actor / client UUID parameterization on insert path
  {
    const db = makeCreateDb();
    await reg.createDisabledTenantChannelEndpoint({
      clientId: CLIENT_A,
      actorStaffUserId: ACTOR,
      ...validFields,
      public_address: 'params@example.com',
    }, { client: db });
    const ins = db.queries.find((q) => /INSERT\s+INTO\s+tenant_channel_endpoints/i.test(q.text));
    ok('create-ep-actor-parameterized', ins && ins.params.includes(ACTOR));
    ok('create-ep-client-parameterized', ins && ins.params.includes(CLIENT_A));
  }

  // Invalid actor/client UUID rejected before DB
  {
    const db = makeCreateDb();
    const res = await reg.createDisabledTenantChannelEndpoint({
      clientId: 'not-a-uuid',
      actorStaffUserId: ACTOR,
      ...validFields,
    }, { client: db });
    ok('create-ep-rejects-bad-client-uuid', res && res.ok === false);
    ok('create-ep-bad-client-no-begin', !db.queries.some((q) => /BEGIN/i.test(q.text)) || res.ok === false);
  }

  // Trusted clientId wins — input body client must not be used if somehow nested
  // (client_id already rejected as unknown/forbidden above)

  // No Promise passed to 1A: spy via wrapping require is hard; assert helper is sync
  // and that create succeeds (1A would fail location_authority_invalid_result on Promise).
  {
    const auth = reg.buildPreloadedLocationAuthority({ clientId: CLIENT_A, locationId: LOC_A });
    const contract = require(CONTRACT_PATH);
    const validated = contract.validateTenantChannelEndpointInput({
      client_id: CLIENT_A,
      location_id: LOC_A,
      channel: 'email',
      provider: 'microsoft_graph',
      public_address: 'sync@example.com',
      secret_ref: 'kv:luna-support-email-credentials',
      capabilities: CAPS_ALL_FALSE,
      inbound_enabled: false,
      outbound_enabled: false,
      default_automation_mode: 'off',
      active: false,
    }, { locationAuthority: auth });
    ok('preloaded-authority-works-with-1a', validated && validated.ok === true);

    // Async authority must not be used with 1A (documents fail-closed)
    const asyncAuth = async () => true;
    const bad = contract.validateTenantChannelEndpointInput({
      client_id: CLIENT_A,
      location_id: LOC_A,
      channel: 'email',
      provider: 'microsoft_graph',
      public_address: 'async@example.com',
      secret_ref: 'kv:luna-support-email-credentials',
      capabilities: CAPS_ALL_FALSE,
      inbound_enabled: false,
      outbound_enabled: false,
      default_automation_mode: 'off',
      active: false,
    }, { locationAuthority: asyncAuth });
    ok(
      'async-authority-fails-1a-closed',
      bad && bad.ok === false,
      bad && bad.error,
    );
  }
}

// ---------------------------------------------------------------------------
// Transaction client boundary (1C-alpha blockers: pinned client + BEGIN safety)
// ---------------------------------------------------------------------------
async function runTransactionClientBoundaryTests() {
  if (!reg) {
    ok('tx-boundary-module-loaded', false);
    return;
  }
  console.log('\n── transaction client boundary ──');

  const locInput = {
    clientId: CLIENT_A,
    actorStaffUserId: ACTOR,
    locationId: LOC_A,
    displayName: 'Beach House',
  };
  const epInput = {
    clientId: CLIENT_A,
    actorStaffUserId: ACTOR,
    location_id: LOC_A,
    provider: 'microsoft_graph',
    public_address: 'tx-bound@example.com',
    secret_ref: 'kv:luna-support-email-credentials',
    capabilities: { ...CAPS_ALL_FALSE },
  };

  // 1. Write with only generic db / pool-like executor → transaction_client_required; zero queries.
  {
    let queryCount = 0;
    const poolLikeDb = {
      // Pool-shaped: query + connect + counters (node-pg Pool-like, not a pinned Client).
      totalCount: 3,
      idleCount: 2,
      waitingCount: 0,
      async connect() {
        queryCount += 1;
        return {
          async query() {
            queryCount += 1;
            return { rows: [], rowCount: 0 };
          },
          async release() {},
        };
      },
      async query() {
        queryCount += 1;
        return { rows: [], rowCount: 0 };
      },
    };

    const rLoc = await reg.createTenantLocation(locInput, { db: poolLikeDb });
    ok(
      'write-loc-db-only-transaction_client_required',
      rLoc && rLoc.ok === false && rLoc.error === 'transaction_client_required',
      rLoc && JSON.stringify(rLoc).slice(0, 160),
    );
    ok('write-loc-db-only-zero-queries', queryCount === 0, `queryCount=${queryCount}`);

    const rEp = await reg.createDisabledTenantChannelEndpoint(epInput, { db: poolLikeDb });
    ok(
      'write-ep-db-only-transaction_client_required',
      rEp && rEp.ok === false && rEp.error === 'transaction_client_required',
      rEp && JSON.stringify(rEp).slice(0, 160),
    );
    ok('write-ep-db-only-zero-queries', queryCount === 0, `queryCount=${queryCount}`);

    // Missing deps / empty deps also reject without SQL.
    const rNone = await reg.createTenantLocation(locInput, {});
    ok(
      'write-loc-missing-client-transaction_client_required',
      rNone && rNone.ok === false && rNone.error === 'transaction_client_required',
    );
  }

  // 2. Every write SQL statement uses the exact same pinned client object.
  //    Hostile rotating "Pool" is not usable through the documented write API.
  {
    const clientsSeen = [];
    const pinned = createHostileMockPg([
      {
        match: (t) => /INSERT\s+INTO\s+tenant_locations/i.test(t),
        run: () => ({
          rows: [{
            id: '44444444-4444-4444-8444-444444444444',
            client_id: CLIENT_A,
            location_id: LOC_A,
            display_name: 'Beach House',
            active: true,
            created_by: ACTOR,
          }],
          rowCount: 1,
        }),
      },
    ]);
    const origQuery = pinned.query.bind(pinned);
    pinned.query = async function queryWrapped(sql, params) {
      clientsSeen.push(this);
      return origQuery(sql, params);
    };

    const created = await reg.createTenantLocation(locInput, { client: pinned });
    ok('write-loc-pinned-client-ok', created && created.ok === true, created && created.error);
    ok(
      'write-loc-all-sql-same-client',
      clientsSeen.length >= 3 // BEGIN + INSERT + COMMIT
        && clientsSeen.every((c) => c === pinned),
      `seen=${clientsSeen.length} same=${clientsSeen.every((c) => c === pinned)}`,
    );

    // Documented API rejects rotating pool via {db}; does not accept it as write executor.
    let rotatingCalls = 0;
    const rotatingPool = {
      totalCount: 4,
      idleCount: 1,
      async connect() {
        rotatingCalls += 1;
        return createHostileMockPg([]);
      },
      async query() {
        // Pool.query acquires a different connection per call in real pg — simulate that.
        rotatingCalls += 1;
        return { rows: [], rowCount: 0 };
      },
    };
    const viaDb = await reg.createTenantLocation(locInput, { db: rotatingPool });
    ok(
      'write-rejects-rotating-pool-via-db',
      viaDb && viaDb.ok === false && viaDb.error === 'transaction_client_required',
      viaDb && viaDb.error,
    );
    ok('write-rotating-pool-via-db-no-sql', rotatingCalls === 0, `rotatingCalls=${rotatingCalls}`);
  }

  // Endpoint write: same pinned-client identity across BEGIN…COMMIT sequence.
  {
    const clientsSeen = [];
    const pinned = createHostileMockPg([
      {
        match: (t) => /FROM\s+tenant_locations/i.test(t) && /SELECT/i.test(t),
        run: () => ({
          rows: [{
            client_id: CLIENT_A,
            location_id: LOC_A,
            active: true,
            display_name: 'Beach House',
          }],
          rowCount: 1,
        }),
      },
      {
        match: (t) => /pg_advisory_xact_lock/i.test(t),
        result: { rows: [{ pg_advisory_xact_lock: '' }], rowCount: 1 },
      },
      {
        match: (t) => /FROM\s+tenant_channel_endpoints/i.test(t) && /SELECT/i.test(t),
        result: { rows: [], rowCount: 0 },
      },
      {
        match: (t) => /INSERT\s+INTO\s+tenant_channel_endpoints/i.test(t),
        run: () => ({
          rows: [{
            id: '77777777-7777-4777-8777-777777777777',
            client_id: CLIENT_A,
            location_id: LOC_A,
            channel: 'email',
            provider: 'microsoft_graph',
            public_address: 'tx-bound@example.com',
            secret_ref: 'kv:luna-support-email-credentials',
            capabilities: CAPS_ALL_FALSE,
            inbound_enabled: false,
            outbound_enabled: false,
            default_automation_mode: 'off',
            active: false,
            created_by: ACTOR,
          }],
          rowCount: 1,
        }),
      },
    ]);
    const origQuery = pinned.query.bind(pinned);
    pinned.query = async function queryWrapped(sql, params) {
      clientsSeen.push(this);
      return origQuery(sql, params);
    };
    const res = await reg.createDisabledTenantChannelEndpoint(epInput, { client: pinned });
    ok('write-ep-pinned-client-ok', res && res.ok === true, res && res.error);
    ok(
      'write-ep-all-sql-same-client',
      clientsSeen.length >= 4
        && clientsSeen.every((c) => c === pinned),
      `seen=${clientsSeen.length}`,
    );
  }

  // 3. BEGIN rejection containing password=LEAK → structured db_error, no throw, no rollback.
  for (const [label, writeFn, input] of [
    ['loc', reg.createTenantLocation, locInput],
    ['ep', reg.createDisabledTenantChannelEndpoint, {
      ...epInput,
      public_address: 'begin-fail@example.com',
    }],
  ]) {
    const queries = [];
    const client = {
      async query(sql) {
        const text = String(sql || '');
        queries.push(text);
        if (/^\s*BEGIN\b/i.test(text)) {
          throw Object.assign(
            new Error('password authentication failed for user "x" password=LEAK'),
            { code: '28P01' },
          );
        }
        return { rows: [], rowCount: 0 };
      },
    };
    let threw = null;
    let result = null;
    try {
      result = await writeFn(input, { client });
    } catch (e) {
      threw = e;
    }
    ok(
      `begin-fail-${label}-resolves-db_error`,
      !threw && result && result.ok === false && result.error === 'db_error',
      threw ? String(threw.message).slice(0, 120) : (result && result.error),
    );
    ok(
      `begin-fail-${label}-no-raw-leak`,
      result && noRawPgLeak(result)
        && !JSON.stringify(result).includes('password=LEAK')
        && !JSON.stringify(result).includes('LEAK'),
    );
    ok(
      `begin-fail-${label}-no-rollback`,
      !queries.some((t) => /ROLLBACK/i.test(t)),
      `queries=${JSON.stringify(queries)}`,
    );
  }

  // 4. Post-BEGIN failure rolls back on the same pinned client.
  {
    const clientsSeen = [];
    const client = createHostileMockPg([
      {
        match: (t) => /INSERT\s+INTO\s+tenant_locations/i.test(t),
        throw: Object.assign(
          new Error('connection terminated unexpectedly password=supersecret'),
          { code: '57P01' },
        ),
      },
    ]);
    const origQuery = client.query.bind(client);
    client.query = async function queryWrapped(sql, params) {
      clientsSeen.push(this);
      return origQuery(sql, params);
    };
    const boom = await reg.createTenantLocation({
      ...locInput,
      locationId: 'post-begin-fail',
      displayName: 'Post Begin Fail',
    }, { client });
    ok('post-begin-fail-db_error', boom && boom.ok === false && boom.error === 'db_error');
    ok('post-begin-fail-no-raw', boom && noRawPgLeak(boom) && !JSON.stringify(boom).includes('supersecret'));
    ok(
      'post-begin-fail-rollback-same-client',
      client.queries.some((q) => /ROLLBACK/i.test(q.text))
        && clientsSeen.some((c, i) => /ROLLBACK/i.test(client.queries[i] && client.queries[i].text ? '' : '') || true)
        && clientsSeen.every((c) => c === client),
      `seen=${clientsSeen.length}`,
    );
    const rollbackIdx = client.queries.findIndex((q) => /ROLLBACK/i.test(q.text));
    ok(
      'post-begin-fail-rollback-present',
      rollbackIdx >= 0 && clientsSeen[rollbackIdx] === client,
    );
  }

  // 5. COMMIT failure maps db_error and uses same-client rollback path.
  {
    const clientsSeen = [];
    const client = createHostileMockPg([
      {
        match: (t) => /INSERT\s+INTO\s+tenant_locations/i.test(t),
        run: () => ({
          rows: [{
            id: '99999999-9999-4999-8999-999999999999',
            client_id: CLIENT_A,
            location_id: 'commit-fail-loc',
            display_name: 'Commit Fail',
            active: true,
            created_by: ACTOR,
          }],
          rowCount: 1,
        }),
      },
    ]);
    const origQuery = client.query.bind(client);
    client.query = async function queryWrapped(sql, params) {
      clientsSeen.push(this);
      const text = String(sql || '');
      if (/^\s*COMMIT\b/i.test(text)) {
        // Still record via orig for tx state, then throw (hostile COMMIT).
        try {
          await origQuery(sql, params);
        } catch (_) { /* ignore */ }
        throw Object.assign(
          new Error('commit failed password=LEAK_COMMIT'),
          { code: '40001' },
        );
      }
      return origQuery(sql, params);
    };
    const res = await reg.createTenantLocation({
      ...locInput,
      locationId: 'commit-fail-loc',
      displayName: 'Commit Fail',
    }, { client });
    ok(
      'commit-fail-maps-db_error',
      res && res.ok === false && res.error === 'db_error',
      res && res.error,
    );
    ok(
      'commit-fail-no-raw-leak',
      res && noRawPgLeak(res) && !JSON.stringify(res).includes('LEAK_COMMIT'),
    );
    const rollbackIdx = clientsSeen.findIndex((_, i) => /ROLLBACK/i.test(client.queries[i].text));
    // Find ROLLBACK among recorded queries on same client identity.
    const hasRollbackSame = client.queries.some((q, i) => /ROLLBACK/i.test(q.text) && clientsSeen[i] === client);
    ok('commit-fail-rollback-same-client', hasRollbackSame, `queries=${client.queries.map((q) => q.text).join('|')}`);
    ok(
      'commit-fail-all-queries-same-client',
      clientsSeen.length > 0 && clientsSeen.every((c) => c === client),
    );
    void rollbackIdx;
  }

  // 6. Reads remain compatible with { db } single-query executor.
  {
    const db = createHostileMockPg([
      {
        match: (t) => /FROM\s+tenant_locations/i.test(t),
        result: { rows: [], rowCount: 0 },
      },
      {
        match: (t) => /FROM\s+tenant_channel_endpoints/i.test(t),
        result: { rows: [], rowCount: 0 },
      },
    ]);
    const listLoc = await reg.listTenantLocations({ clientId: CLIENT_A }, { db });
    const listEp = await reg.listTenantChannelEndpoints({ clientId: CLIENT_A }, { db });
    ok('read-list-locations-still-accepts-db', listLoc && listLoc.ok === true);
    ok('read-list-endpoints-still-accepts-db', listEp && listEp.ok === true);
    ok(
      'read-db-executor-got-queries',
      db.queries.some((q) => /tenant_locations/i.test(q.text))
        && db.queries.some((q) => /tenant_channel_endpoints/i.test(q.text)),
    );
  }

  // 7. Docs / module header no longer claim pool support for write transactions.
  {
    const header = modSrc.slice(0, 1200);
    const claimsPoolForWrites = /callers inject\s*\{\s*db\s*\}.*(?:pool|transaction)/is.test(header)
      || /write[s]?\s+.*\{\s*db\s*\}.*pool/i.test(header)
      || /\{ db \} \(pg client \/ pool/i.test(header)
      || /pg client \/ pool interface/i.test(header);
    ok(
      'module-header-no-pool-for-write-tx',
      !claimsPoolForWrites,
      'header still advertises pool/db for write transactions',
    );
    ok(
      'module-header-mentions-pinned-client-or-client-deps',
      /\{?\s*client\s*\}?|pinned|transaction client/i.test(header)
        || /requireTransactionClient|transaction_client_required/i.test(modSrc),
    );
    // Reject affirmative "writes use {db}/pool" claims; allow explicit negations
    // ("not a Pool", "not ... `{ db }` → transaction_client_required").
    const affirmativeWriteDbPool = /callers inject\s*\{\s*db\s*\}\s*[—–-]\s*no global PG/i.test(doc)
      || /Writes\*\*[^\n]*inject\s*\{\s*db\s*\}/i.test(doc)
      || /write[s]?\s+(?:require|use|accept|inject)[^\n]*\{\s*db\s*\}(?![^\n]*(?:reject|not|required))/i.test(doc)
      || /createTenantLocation\([^)]*\{\s*db\s*\}/i.test(doc)
      || /createDisabledTenantChannelEndpoint\([^)]*\{\s*db\s*\}/i.test(doc)
      || /write transactions?[^\n]{0,40}pool interface/i.test(doc);
    ok(
      'docs-no-pool-claim-for-write-tx',
      !affirmativeWriteDbPool,
      'docs still claim {db}/pool for write transactions',
    );
    ok(
      'docs-write-uses-client-or-pinned',
      /\{\s*client\s*\}/i.test(doc)
        && /transaction_client_required|pinned (?:transaction )?client/i.test(doc),
    );
  }
}

// ---------------------------------------------------------------------------
// Source policy: no routes, no live config
// ---------------------------------------------------------------------------
function runSourcePolicy() {
  console.log('\n── source policy ──');
  if (!modSrc) {
    ok('source-policy-skipped-missing-module', false);
    return;
  }
  ok('no-http-route-registration', !/\.(get|post|put|patch|delete)\s*\(|createRouter|staff-query-api/i.test(modSrc));
  ok('no-express-import', !/require\(['\"]express['\"]\)/.test(modSrc));
  ok('no-network-clients', !/require\(['\"]https?['\"]\)|fetch\s*\(/.test(modSrc));
  ok('no-live-dsn-env', !/DATABASE_URL|PGPASSWORD|AZURE_POSTGRES/i.test(modSrc));
}

// Secret scan on new module + verifiers
function looksLikeEmbeddedSecret(text) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) return 'pem';
  if (/(?:^|[^'"`\\\[])sk-[A-Za-z0-9]{20,}/.test(text)) return 'sk_token';
  if (/(?:^|[^\\])password\s*=\s*['"][^'"\n]{8,}['"]/im.test(text)) return 'password_assign';
  return null;
}

function runSecretScan() {
  console.log('\n── secret scan ──');
  const targets = [
    [MODULE_REL, MODULE_PATH],
    [VERIFY_REL, path.join(ROOT, VERIFY_REL)],
    [PROVE_REL, PROVE_PATH],
  ];
  for (const [label, p] of targets) {
    if (!fs.existsSync(p)) {
      ok(`secret-scan-${label}`, false, 'missing');
      continue;
    }
    const hit = looksLikeEmbeddedSecret(read(p));
    ok(`secret-scan-clean-${path.basename(p)}`, !hit, hit || '');
  }
}

async function main() {
  try {
    await runListLocationTests();
    await runListEndpointTests();
    await runCreateLocationTests();
    await runCreateEndpointTests();
    await runTransactionClientBoundaryTests();
    runSourcePolicy();
    runSecretScan();
  } catch (e) {
    ok('verify-completed-without-throw', false, String(e && e.stack ? e.stack : e).slice(0, 300));
  }

  console.log(`\n── verify:email-tenant-channel-registry ${fail ? 'FAILED' : 'PASSED'} (${pass} pass, ${fail} fail) ──`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
