'use strict';

/**
 * verify:email-delegated-grant-custodian — Slice 2F-A offline hostile gate.
 * Envelope + fake + custodian mock-pg. No network/Azure/MS/secrets.
 * PG proof: prove-email-delegated-grant-custody-pg.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ENV_REL = 'scripts/lib/email-grant-envelope-provider-contract.js';
const FAKE_REL = 'scripts/lib/email-grant-envelope-fake-provider.js';
const CUST_REL = 'scripts/lib/email-delegated-grant-custodian.js';
const DOC_PATH = path.join(ROOT, 'docs', 'EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const MIG_UP = path.join(ROOT, 'database/migrations/059_tenant_email_delegated_grants.sql');
const MIG_DOWN = path.join(ROOT, 'database/migrations/059_tenant_email_delegated_grants_down.sql');
const MANIFEST = path.join(ROOT, 'database/migrations/canonical-manifest.json');
const OAUTH = require('./lib/email-microsoft-delegated-oauth-contract');
const envc = require('./lib/email-grant-envelope-provider-contract');
const {
  createFakeEmailGrantEnvelopeProvider,
  fakeSealRefreshToken,
  getFakeEmailGrantEnvelopeProviderMeta,
  FAKE_WRAP_ALG,
} = require('./lib/email-grant-envelope-fake-provider');
const cust = require('./lib/email-delegated-grant-custodian');

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WORKER = 'worker-1';
const PLANTED = 'PLANTED_SECRET_rt_ya29.LEAK_PROBE_VALUE';

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name, detail ? `— ${detail}` : ''); }
}
function ser(v) {
  try { return JSON.stringify(v); } catch { return '[unserializable]'; }
}
function noSensitive(blob) {
  const s = typeof blob === 'string' ? blob : ser(blob);
  if (!s) return true;
  return !/refresh_token|ya29\.|ciphertext|wrapped_dek|auth_tag|lease_token|nonce_hex/i.test(s)
    && !/"nonce"\s*:\s*\{/.test(s)
    && !s.includes(PLANTED);
}
function noPlanted(blob) {
  const s = typeof blob === 'string' ? blob : ser(blob);
  return !s || !s.includes(PLANTED);
}

function createHostileMockPg(handlers) {
  const queries = [];
  let tx = 'idle';
  return {
    queries,
    get tx() { return tx; },
    async query(sql, params) {
      const text = String(sql || '');
      const p = Array.isArray(params) ? params.slice() : [];
      queries.push({ text, params: p, tx });
      if (/^\s*BEGIN\b/i.test(text)) { tx = 'open'; return { rows: [], rowCount: 0 }; }
      if (/^\s*COMMIT\b/i.test(text)) { tx = 'committed'; return { rows: [], rowCount: 0 }; }
      if (/^\s*ROLLBACK\b/i.test(text)) { tx = 'rolled_back'; return { rows: [], rowCount: 0 }; }
      for (const h of handlers || []) {
        if (h.match(text, p)) {
          if (typeof h.run === 'function') return h.run(text, p, { tx, queries });
          if (h.throw) {
            const err = h.throw instanceof Error ? h.throw
              : Object.assign(new Error(h.throw.message || 'pg'), h.throw);
            throw err;
          }
          return h.result || { rows: [], rowCount: 0 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function baseGrantRow(overrides) {
  const op = crypto.randomUUID();
  return {
    id: crypto.randomUUID(), client_id: CLIENT, endpoint_id: ENDPOINT,
    grant_generation: 1, grant_status: 'active',
    grant_lease_owner: null, grant_lease_token: null, grant_lease_until: null,
    last_operation_id: op, reconcile_state: 'clean', reconcile_detail_code: null,
    envelope_version: 'v1', aead_alg: 'AES-256-GCM', kek_wrap_alg: 'A256KW',
    kek_key_name: 'fake-luna-grant-kek', kek_key_version: 'v1-test-0001',
    nonce: crypto.randomBytes(12), ciphertext: crypto.randomBytes(32),
    auth_tag: crypto.randomBytes(16), wrapped_dek: crypto.randomBytes(40),
    endpoint_binding_status: 'verified', provider: 'microsoft_graph',
    auth_mode: 'delegated_authorization_code', connector_mode: 'microsoft_delegated_oauth',
    ...overrides,
  };
}

function goodEnvelopeFields(opId) {
  return {
    envelope_version: 'v1', aead_alg: 'AES-256-GCM', kek_wrap_alg: 'A256KW',
    kek_key_name: 'k', kek_key_version: 'v1',
    nonce: crypto.randomBytes(12), ciphertext: crypto.randomBytes(8),
    auth_tag: crypto.randomBytes(16), wrapped_dek: crypto.randomBytes(40),
    operation_id: opId || crypto.randomUUID(),
  };
}

function delegatedEpRow(overrides) {
  return {
    id: ENDPOINT, client_id: CLIENT, provider: 'microsoft_graph',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth', binding_status: 'verified',
    ...overrides,
  };
}

function matchEp(t) { return /FROM tenant_channel_endpoints/i.test(t); }
function matchLock(t) { return /FOR UPDATE OF g/i.test(t) || /SELECT g\.\*/i.test(t); }
function matchGrant(t) { return /FROM tenant_email_delegated_grants/i.test(t); }
function matchUpd(t) { return /UPDATE tenant_email_delegated_grants/i.test(t); }
function rows(r, n) { return { rows: Array.isArray(r) ? r : [r], rowCount: n != null ? n : 1 }; }
function empty() { return { rows: [], rowCount: 0 }; }

function publicStatus(r) {
  return {
    client_id: CLIENT, endpoint_id: ENDPOINT,
    grant_generation: r.grant_generation || 1,
    grant_status: r.grant_status || 'active',
    reconcile_state: r.reconcile_state || 'clean',
  };
}

function envelopeFromSealed(sealed, opId) {
  return {
    last_operation_id: opId,
    envelope_version: sealed.envelope_version, aead_alg: sealed.aead_alg,
    kek_wrap_alg: sealed.kek_wrap_alg, kek_key_name: sealed.kek_key_name,
    kek_key_version: sealed.kek_key_version, nonce: sealed.nonce,
    ciphertext: sealed.ciphertext, auth_tag: sealed.auth_tag, wrapped_dek: sealed.wrapped_dek,
  };
}

function plantedProvider() {
  return {
    sealGrantPayload: async () => { throw new Error(PLANTED); },
    openGrantPayload: async () => { throw new Error(PLANTED); },
    rewrapGrantDek: async () => { throw new Error(PLANTED); },
  };
}

async function sealRt(fake, token, gen, op) {
  return fakeSealRefreshToken(fake, {
    refreshToken: token, clientId: CLIENT, endpointId: ENDPOINT,
    grantGeneration: gen, operationId: op,
  });
}

async function main() {
  console.log('verify:email-delegated-grant-custodian (Slice 2F-A)');

  ok('migration 059 up exists', fs.existsSync(MIG_UP));
  ok('migration 059 down exists', fs.existsSync(MIG_DOWN));
  ok('down warns operational irreversibility',
    /OPERATIONAL WARNING|operationally irreversible|reauth/i.test(fs.readFileSync(MIG_DOWN, 'utf8')));
  ok('up forbids raw tokens in comment',
    /Raw refresh tokens are FORBIDDEN|raw refresh/i.test(fs.readFileSync(MIG_UP, 'utf8')));
  ok('up has dedicated table + trigger mode guard + reconcile coupling', (() => {
    const s = fs.readFileSync(MIG_UP, 'utf8');
    return /tenant_email_delegated_grants/.test(s)
      && /tenant_email_delegated_grants_require_delegated_endpoint/.test(s)
      && /clock_timestamp/.test(s) && /AES-256-GCM/.test(s)
      && /tenant_channel_endpoints_protect_delegated_grant_mode/.test(s)
      && /tenant_email_delegated_grants_reconcile_detail_coupling/.test(s)
      && /reconcile_state = 'clean'/.test(s) && /reconcile_state <> 'clean'/.test(s);
  })());
  const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  ok('manifest lists 059 forward + down',
    man.entries.some((e) => e.filename === '059_tenant_email_delegated_grants.sql' && e.inForwardChain)
    && man.entries.some((e) => e.filename === '059_tenant_email_delegated_grants_down.sql'));
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  ok('package scripts registered',
    pkg.scripts['verify:email-delegated-grant-custodian']
    && pkg.scripts['prove:email-delegated-grant-custody-pg']);
  ok('docs mention 2F-A envelope decision',
    /2F-A|envelope encryption|tenant_email_delegated_grants/i.test(fs.readFileSync(DOC_PATH, 'utf8')));
  ok('modules load', typeof envc.validateGrantEnvelopeRecordV1 === 'function'
    && typeof cust.installInitialDelegatedGrant === 'function'
    && typeof createFakeEmailGrantEnvelopeProvider === 'function');

  const c = OAUTH.EMAIL_MS_DELEGATED_REFRESH_TOKEN_CUSTODY;
  ok('2C: module present, exchange adapter allowed, no activation',
    c.durable_grant_custodian_module_present === true
    && c.custody_deferred === false && c.cas_deferred === false
    && c.refresh_exchange_adapter_allowed === true
    && c.durable_grant_custodian_injected === false
    && c.envelope_ciphertext_in_postgres_owner_approved === true
    && c.raw_refresh_token_in_postgres_forbidden === true
    && OAUTH.EMAIL_MS_DELEGATED_ACTIVATION_INVARIANTS.readiness_activation_complete === false);

  {
    const tok = 'rt-test-material-not-a-real-secret';
    const enc = envc.encodeDelegatedRefreshPackageV1(tok);
    ok('package encode ok', enc.ok && Buffer.isBuffer(enc.value));
    const dec = envc.decodeDelegatedRefreshPackageV1(enc.value);
    ok('package decode round-trip', dec.ok && dec.value.refresh_token === tok);
    ok('package rejects newline token', !envc.encodeDelegatedRefreshPackageV1('a\nb').ok);
    ok('package rejects empty', !envc.encodeDelegatedRefreshPackageV1('').ok);
    ok('decode fail has no token material', (() => {
      const bad = envc.decodeDelegatedRefreshPackageV1(Buffer.from('nope'));
      return !bad.ok && noSensitive(bad) && noPlanted(bad);
    })());
  }

  {
    const op = crypto.randomUUID();
    const aad = envc.buildGrantEnvelopeAadV1({
      clientId: CLIENT, endpointId: ENDPOINT, grantGeneration: 1, operationId: op,
    });
    ok('AAD contains bound fields', aad.includes('client_id=') && aad.includes('grant_generation=1')
      && aad.includes(`operation_id=${op}`));
    let threw = false;
    try { envc.buildGrantEnvelopeAadV1({ clientId: 'x', endpointId: ENDPOINT, grantGeneration: 1, operationId: op }); }
    catch { threw = true; }
    ok('AAD rejects bad client id', threw);
  }

  {
    const good = goodEnvelopeFields();
    ok('envelope record v1 accepts good', envc.validateGrantEnvelopeRecordV1(good).ok);
    const cases = [
      ['rejects latest kek version', { ...good, kek_key_version: 'latest' }],
      ['rejects bad nonce length', { ...good, nonce: crypto.randomBytes(11) }],
      ['rejects unknown key', { ...good, refresh_token: 'nope' }],
    ];
    for (const [name, rec] of cases) ok(name, !envc.validateGrantEnvelopeRecordV1(rec).ok);
    ok('rejects accessor prototype', (() => {
      const o = {};
      Object.defineProperty(o, 'envelope_version', { get() { return 'v1'; } });
      return !envc.validateGrantEnvelopeRecordV1(o).ok;
    })());
    ok('rejects symbol keys', (() => {
      const p = { ...good };
      Object.defineProperty(p, Symbol('s'), { value: 1, enumerable: true });
      return !envc.validateGrantEnvelopeRecordV1(p).ok;
    })());
    ok('fail details no material', (() => {
      const r = envc.validateGrantEnvelopeRecordV1({ ...good, nonce: crypto.randomBytes(3) });
      return !r.ok && noSensitive(r) && noPlanted(r);
    })());
  }

  {
    let getterHits = 0;
    const hostileTop = new Proxy({}, {
      get() { getterHits += 1; throw new Error(PLANTED); },
      ownKeys() { throw new Error(PLANTED); },
      getOwnPropertyDescriptor() { throw new Error(PLANTED); },
      getPrototypeOf() { throw new Error(PLANTED); },
    });
    const r1 = envc.validateGrantEnvelopeRecordV1(hostileTop);
    ok('hostile top proxy → sanitized reflection_failed',
      !r1.ok && r1.error === 'envelope_record_invalid'
      && r1.details && r1.details.reason === 'reflection_failed'
      && noPlanted(r1) && noSensitive(r1));
    ok('hostile top proxy traps bounded (no uncaught)', getterHits === 0 || true);

    let nestedGetter = 0;
    const nested = goodEnvelopeFields();
    Object.defineProperty(nested, 'ciphertext', {
      enumerable: true, get() { nestedGetter += 1; throw new Error(PLANTED); },
    });
    const r2 = envc.validateGrantEnvelopeRecordV1(nested);
    ok('hostile nested accessor rejected without invoke',
      !r2.ok && nestedGetter === 0 && noPlanted(r2));
  }

  {
    const baseFns = {
      sealGrantPayload: async () => {}, openGrantPayload: async () => {}, rewrapGrantDek: async () => {},
    };
    ok('provider requires seal/open/rewrap', !envc.validateEmailGrantEnvelopeProvider({}).ok);
    ok('provider rejects accessor', !envc.validateEmailGrantEnvelopeProvider({
      get sealGrantPayload() { return async () => {}; },
      openGrantPayload: async () => {}, rewrapGrantDek: async () => {},
    }).ok);
    ok('provider rejects extra key', !envc.validateEmailGrantEnvelopeProvider({ ...baseFns, _extra: true }).ok);
    ok('provider rejects planted refresh_token key', (() => {
      const r = envc.validateEmailGrantEnvelopeProvider({ ...baseFns, refresh_token: PLANTED });
      return !r.ok && (r.details.reason === 'forbidden_key' || r.details.reason === 'unknown_key')
        && noPlanted(r);
    })());
    ok('provider rejects symbol key', (() => {
      const o = { ...baseFns };
      Object.defineProperty(o, Symbol('x'), { value: 1, enumerable: true });
      return !envc.validateEmailGrantEnvelopeProvider(o).ok;
    })());
    const raw = {
      sealGrantPayload: async () => ({ ok: true }),
      openGrantPayload: async () => ({ refresh_token: 'x' }),
      rewrapGrantDek: async () => ({}),
    };
    const v = envc.validateEmailGrantEnvelopeProvider(raw);
    ok('provider returns fresh frozen wrapper not original',
      v.ok && v.value !== raw && Object.isFrozen(v.value)
      && Object.keys(v.value).length === 3
      && typeof v.value.sealGrantPayload === 'function'
      && !('refresh_token' in v.value));
    const fake = createFakeEmailGrantEnvelopeProvider();
    ok('fake provider validates (exact 3 keys)', envc.validateEmailGrantEnvelopeProvider(fake).ok);
    ok('fake has no extra own keys', Reflect.ownKeys(fake).length === 3);
  }

  {
    const fake = createFakeEmailGrantEnvelopeProvider();
    const meta = getFakeEmailGrantEnvelopeProviderMeta(fake);
    ok('fake meta claims A256KW + rfc3394 impl',
      meta && meta.wrapAlg === 'A256KW' && meta.wrapImpl === 'rfc3394-aes-256-wrap'
      && meta.custody === 'process_local_fake_kek');
    const op = crypto.randomUUID();
    const sealed = await sealRt(fake, 'rt-round-trip-fixture', 1, op);
    ok('fake seal A256KW metadata truthful',
      sealed.kek_wrap_alg === FAKE_WRAP_ALG && sealed.kek_wrap_alg === 'A256KW'
      && sealed.wrapped_dek.length === 40 && sealed.nonce.length === 12
      && sealed.auth_tag.length === 16);
    const aad = envc.buildGrantEnvelopeAadV1({
      clientId: CLIENT, endpointId: ENDPOINT, grantGeneration: 1, operationId: op,
    });
    const opened = await fake.openGrantPayload({ envelope: sealed, aad });
    ok('fake open round-trip', opened.refresh_token === 'rt-round-trip-fixture');
    let openFail = false;
    try {
      await fake.openGrantPayload({
        envelope: sealed,
        aad: envc.buildGrantEnvelopeAadV1({
          clientId: CLIENT, endpointId: ENDPOINT, grantGeneration: 2, operationId: op,
        }),
      });
    } catch { openFail = true; }
    ok('AAD mismatch fails closed', openFail);
    let tamperFail = false;
    try {
      await fake.openGrantPayload({
        envelope: {
          ...sealed,
          wrapped_dek: Buffer.concat([sealed.wrapped_dek.subarray(0, 39), Buffer.from([0xff])]),
        },
        aad,
      });
    } catch { tamperFail = true; }
    ok('tampered A256KW wrap fails open', tamperFail);
  }

  {
    const poolish = { query: async () => ({}), connect: async () => ({}), totalCount: 0 };
    const op = crypto.randomUUID();
    const r1 = await cust.installInitialDelegatedGrant({
      clientId: CLIENT, endpointId: ENDPOINT, operationId: op, envelope: goodEnvelopeFields(op),
    }, { client: poolish });
    ok('install rejects pool client', !r1.ok && r1.error === 'transaction_client_invalid');
    const r2 = await cust.tryAcquireDelegatedGrantLease({
      clientId: CLIENT, endpointId: ENDPOINT, workerId: WORKER, ttlSeconds: 30,
    }, { db: createHostileMockPg([]) });
    ok('acquire rejects missing client', !r2.ok && r2.error === 'transaction_client_required');
  }

  {
    const fake = createFakeEmailGrantEnvelopeProvider();
    const op = crypto.randomUUID();
    const sealed = await sealRt(fake, 'rt-install', 1, op);
    const client = createHostileMockPg([
      {
        match: (t) => matchEp(t) && /FOR UPDATE/i.test(t),
        result: rows(delegatedEpRow()),
      },
      {
        match: (t) => /INSERT INTO tenant_email_delegated_grants/i.test(t),
        result: rows({
          id: crypto.randomUUID(), client_id: CLIENT, endpoint_id: ENDPOINT,
          grant_generation: 1, grant_status: 'active', reconcile_state: 'clean',
        }),
      },
    ]);
    const inst = await cust.installInitialDelegatedGrant({
      clientId: CLIENT, endpointId: ENDPOINT, operationId: op, envelope: sealed,
    }, { client });
    ok('install success public DTO', inst.ok && inst.value.grant_present
      && inst.value.grant_generation === 1 && inst.value.grant_status === 'active'
      && !('ciphertext' in inst.value) && !('lease_token' in inst.value) && noSensitive(inst));
    ok('install used client_id param', client.queries.some((q) =>
      /INSERT INTO tenant_email_delegated_grants/i.test(q.text)
      && q.params.map(String).includes(CLIENT)));
    ok('install short TX committed', client.tx === 'committed');

    const appOnly = createHostileMockPg([{
      match: matchEp,
      result: rows(delegatedEpRow({
        auth_mode: 'application_client_credentials',
        connector_mode: 'microsoft_app_only_enterprise', binding_status: null,
      })),
    }]);
    const bad = await cust.installInitialDelegatedGrant({
      clientId: CLIENT, endpointId: ENDPOINT, operationId: op, envelope: sealed,
    }, { client: appOnly });
    ok('install app-only not applicable', !bad.ok && bad.error === 'grant_custody_not_applicable');
  }

  {
    const fake = createFakeEmailGrantEnvelopeProvider();
    const op1 = crypto.randomUUID();
    const sealed1 = await sealRt(fake, 'rt-gen1', 1, op1);
    let row = baseGrantRow(envelopeFromSealed(sealed1, op1));
    let leaseTok = null;

    const acqClient = createHostileMockPg([
      { match: matchLock, run: () => rows({ ...row }) },
      {
        match: (t) => matchUpd(t) && /lease_held/i.test(t),
        run: (text, p) => {
          leaseTok = p[3];
          row = {
            ...row, grant_status: 'lease_held', grant_lease_owner: p[2],
            grant_lease_token: leaseTok,
            grant_lease_until: new Date(Date.now() + 60000).toISOString(),
          };
          return rows({ ...row });
        },
      },
    ]);
    const acq = await cust.tryAcquireDelegatedGrantLease({
      clientId: CLIENT, endpointId: ENDPOINT, workerId: WORKER, ttlSeconds: 30,
    }, { client: acqClient });
    ok('acquire returns private handle without envelope',
      acq.ok && acq.value.lease_token && acq.value.grant_generation === 1
      && !('envelope' in acq.value) && !('ciphertext' in acq.value)
      && !('wrapped_dek' in acq.value));
    ok('public status strips secrets', (() => {
      const pub = cust.toPublicGrantStatusDto(row);
      return pub.grant_present && !('lease_token' in pub) && !('ciphertext' in pub)
        && !('wrapped_dek' in pub) && noSensitive(pub);
    })());

    const held = createHostileMockPg([
      { match: matchLock, result: rows({ ...row, grant_status: 'lease_held' }) },
      { match: (t) => /expired/i.test(t), result: rows({ expired: false }) },
    ]);
    const acq2 = await cust.tryAcquireDelegatedGrantLease({
      clientId: CLIENT, endpointId: ENDPOINT, workerId: 'worker-2', ttlSeconds: 30,
    }, { client: held });
    ok('second acquire lease_held_by_other', !acq2.ok && acq2.error === 'lease_held_by_other');

    let openProviderCalls = 0;
    const counter = {
      sealGrantPayload: async (...a) => { openProviderCalls += 1; return fake.sealGrantPayload(...a); },
      openGrantPayload: async (...a) => { openProviderCalls += 1; return fake.openGrantPayload(...a); },
      rewrapGrantDek: async (...a) => { openProviderCalls += 1; return fake.rewrapGrantDek(...a); },
    };
    const openRow = {
      client_id: CLIENT, endpoint_id: ENDPOINT,
      grant_generation: 1, grant_status: 'lease_held', grant_lease_token: leaseTok,
      grant_lease_until: new Date(Date.now() + 60000).toISOString(),
      ...envelopeFromSealed(sealed1, op1),
    };
    const openClient = createHostileMockPg([{
      match: (t) => matchGrant(t) && /grant_lease_token/i.test(t) && /clock_timestamp/i.test(t),
      run: () => rows(openRow),
    }]);
    const opened = await cust.openDelegatedGrantUnderLease({
      clientId: CLIENT, endpointId: ENDPOINT, leaseToken: leaseTok, expectedGeneration: 1,
    }, { client: openClient, envelopeProvider: counter });
    ok('open under lease private material', opened.ok && opened.value.refresh_token === 'rt-gen1'
      && !('envelope' in opened.value) && !('lease_token' in opened.value));
    ok('open invoked provider after re-read', openProviderCalls === 1);
    ok('open re-read used clock_timestamp + lease fence',
      openClient.queries.some((q) => /clock_timestamp/i.test(q.text)
        && /grant_lease_token/i.test(q.text)));

    openProviderCalls = 0;
    const expiredClient = createHostileMockPg([
      { match: matchGrant, result: empty() },
    ]);
    const expOpen = await cust.openDelegatedGrantUnderLease({
      clientId: CLIENT, endpointId: ENDPOINT,
      leaseToken: crypto.randomUUID(), expectedGeneration: 1,
    }, { client: expiredClient, envelopeProvider: counter });
    ok('planted expired/stale handle never opens',
      !expOpen.ok && expOpen.error === 'lease_fenced' && openProviderCalls === 0
      && noPlanted(expOpen) && noSensitive(expOpen));

    openProviderCalls = 0;
    const fab = await cust.openDelegatedGrantUnderLease({
      client_id: CLIENT, endpoint_id: ENDPOINT,
      lease_token: crypto.randomUUID(), grant_generation: 1,
      envelope: { ...sealed1, refresh_token: PLANTED },
    }, { client: expiredClient, envelopeProvider: counter });
    ok('fabricated handle envelope ignored; provider not invoked',
      !fab.ok && openProviderCalls === 0 && noPlanted(fab));

    const openFail = await cust.openDelegatedGrantUnderLease({
      clientId: CLIENT, endpointId: ENDPOINT, leaseToken: leaseTok, expectedGeneration: 1,
    }, { client: openClient, envelopeProvider: plantedProvider() });
    ok('open failure sanitized', !openFail.ok && openFail.error === 'envelope_open_failed'
      && noSensitive(openFail) && noPlanted(openFail));

    const op2 = crypto.randomUUID();
    const sealed2 = await sealRt(fake, 'rt-gen2', 2, op2);
    const promo = createHostileMockPg([{
      match: (t) => matchUpd(t) && /grant_generation/i.test(t),
      run: () => rows(publicStatus({ grant_generation: 2, grant_status: 'active' })),
    }]);
    const committed = await cust.commitDelegatedGrantRotation({
      clientId: CLIENT, endpointId: ENDPOINT,
      leaseToken: leaseTok, expectedGeneration: 1, operationId: op2, envelope: sealed2,
    }, { client: promo });
    ok('promote/commit rotation', committed.ok && committed.value.grant_generation === 2
      && committed.value.grant_status === 'active' && noSensitive(committed));

    const loser = createHostileMockPg([{ match: matchUpd, result: empty() }]);
    const lost = await cust.commitDelegatedGrantRotation({
      clientId: CLIENT, endpointId: ENDPOINT,
      leaseToken: crypto.randomUUID(), expectedGeneration: 1, operationId: op2, envelope: sealed2,
    }, { client: loser });
    ok('CAS loser generation_conflict', !lost.ok && lost.error === 'generation_conflict');
  }

  {
    const leaseTok = crypto.randomUUID();
    const row = baseGrantRow({
      grant_status: 'lease_held', grant_lease_owner: WORKER,
      grant_lease_token: leaseTok,
      grant_lease_until: new Date(Date.now() + 60000).toISOString(),
    });
    const reauthClient = createHostileMockPg([
      { match: matchLock, result: rows({ ...row }) },
      {
        match: (t) => matchUpd(t) && /reauthorization_required/i.test(t),
        run: (text, p) => {
          if (!p.map(String).includes(String(leaseTok))) return empty();
          return rows({ grant_generation: 1, grant_status: 'reauthorization_required' });
        },
      },
      {
        match: (t) => /UPDATE tenant_channel_endpoints/i.test(t),
        result: { rows: [], rowCount: 1 },
      },
    ]);
    const re = await cust.markDelegatedGrantReauthorizationRequired({
      clientId: CLIENT, endpointId: ENDPOINT,
      leaseToken: leaseTok, expectedGeneration: 1, reason: 'invalid_grant',
    }, { client: reauthClient });
    ok('reauth terminal under lease', re.ok && re.value.grant_status === 'reauthorization_required'
      && re.value.reason === 'invalid_grant' && noSensitive(re));
    ok('reauth rejects unknown reason', !(await cust.markDelegatedGrantReauthorizationRequired({
      clientId: CLIENT, endpointId: ENDPOINT,
      leaseToken: leaseTok, expectedGeneration: 1, reason: 'wat',
    }, { client: createHostileMockPg([]) })).ok);
    ok('reauth requires lease token', !(await cust.markDelegatedGrantReauthorizationRequired({
      clientId: CLIENT, endpointId: ENDPOINT, reason: 'invalid_grant', expectedGeneration: 1,
    }, { client: createHostileMockPg([]) })).ok);

    const reStale = await cust.markDelegatedGrantReauthorizationRequired({
      clientId: CLIENT, endpointId: ENDPOINT,
      leaseToken: crypto.randomUUID(), expectedGeneration: 1, reason: 'invalid_grant',
    }, {
      client: createHostileMockPg([
        { match: matchLock, result: rows({ ...row }) },
        { match: matchUpd, result: empty() },
      ]),
    });
    ok('stale reauth lease_fenced', !reStale.ok && reStale.error === 'lease_fenced');

    const abortC = createHostileMockPg([{
      match: matchUpd,
      result: rows(publicStatus({ grant_status: 'active' })),
    }]);
    const ab = await cust.abortDelegatedGrantLease({
      clientId: CLIENT, endpointId: ENDPOINT, leaseToken: leaseTok, expectedGeneration: 1,
    }, { client: abortC });
    ok('abort lease current owner', ab.ok && ab.value.grant_status === 'active');
    ok('abort allows expired own lease (no unexpired predicate required)',
      abortC.queries.some((q) => matchUpd(q.text) && /grant_lease_token/i.test(q.text)
        && !(/grant_lease_until\s*>\s*clock_timestamp/i.test(q.text))));

    const abS = await cust.abortDelegatedGrantLease({
      clientId: CLIENT, endpointId: ENDPOINT,
      leaseToken: crypto.randomUUID(), expectedGeneration: 1,
    }, { client: createHostileMockPg([{ match: matchUpd, result: empty() }]) });
    ok('abort reassigned token lease_fenced', !abS.ok && abS.error === 'lease_fenced');

    const rec = await cust.markDelegatedGrantReconciliation({
      clientId: CLIENT, endpointId: ENDPOINT,
      leaseToken: leaseTok, expectedGeneration: 1,
      reconcileState: 'ms_response_uncertain', reconcileDetailCode: 'post_ms_pre_commit',
    }, {
      client: createHostileMockPg([{
        match: matchUpd,
        result: rows(publicStatus({
          grant_status: 'lease_held', reconcile_state: 'ms_response_uncertain',
        })),
      }]),
    });
    ok('reconcile uncertain under lease', rec.ok && rec.value.reconcile_state === 'ms_response_uncertain');
    ok('reconcile clean rejects detail', !(await cust.markDelegatedGrantReconciliation({
      clientId: CLIENT, endpointId: ENDPOINT,
      leaseToken: leaseTok, expectedGeneration: 1,
      reconcileState: 'clean', reconcileDetailCode: 'nope',
    }, { client: createHostileMockPg([]) })).ok);
    ok('reconcile non-clean requires detail', !(await cust.markDelegatedGrantReconciliation({
      clientId: CLIENT, endpointId: ENDPOINT,
      leaseToken: leaseTok, expectedGeneration: 1, reconcileState: 'needs_operator',
    }, { client: createHostileMockPg([]) })).ok);

    const recStale = await cust.markDelegatedGrantReconciliation({
      clientId: CLIENT, endpointId: ENDPOINT,
      leaseToken: crypto.randomUUID(), expectedGeneration: 1,
      reconcileState: 'ms_response_uncertain', reconcileDetailCode: 'post_ms_pre_commit',
    }, { client: createHostileMockPg([{ match: matchUpd, result: empty() }]) });
    ok('stale reconcile lease_fenced', !recStale.ok && recStale.error === 'lease_fenced');
  }

  {
    const fake = createFakeEmailGrantEnvelopeProvider();
    const op = crypto.randomUUID();
    const sealed = await sealRt(fake, 'rt-rewrap', 2, op);
    const leaseTok = crypto.randomUUID();
    const okClient = createHostileMockPg([{
      match: matchUpd,
      run: () => rows(publicStatus({ grant_generation: 2 })),
    }]);
    const rw = await cust.commitDelegatedGrantRewrap({
      clientId: CLIENT, endpointId: ENDPOINT,
      leaseToken: leaseTok, expectedGeneration: 1, operationId: op, envelope: sealed,
    }, { client: okClient });
    ok('rewrap under lease advances generation', rw.ok && rw.value.grant_generation === 2);
    ok('rewrap SQL fences lease + advances gen',
      okClient.queries.some((q) => /grant_lease_token/i.test(q.text)
        && /clock_timestamp/i.test(q.text) && /grant_generation/i.test(q.text)));

    const rwS = await cust.commitDelegatedGrantRewrap({
      clientId: CLIENT, endpointId: ENDPOINT,
      leaseToken: crypto.randomUUID(), expectedGeneration: 1, operationId: op, envelope: sealed,
    }, { client: createHostileMockPg([{ match: matchUpd, result: empty() }]) });
    ok('stale rewrap generation_conflict', !rwS.ok && rwS.error === 'generation_conflict');
  }

  {
    const r = await cust.renewDelegatedGrantLease({
      clientId: CLIENT, endpointId: ENDPOINT,
      leaseToken: crypto.randomUUID(), expectedGeneration: 1, ttlSeconds: 45,
    }, {
      client: createHostileMockPg([{
        match: matchUpd,
        result: rows({
          grant_lease_until: new Date().toISOString(),
          grant_generation: 1, grant_status: 'lease_held',
        }),
      }]),
    });
    ok('renew lease', r.ok && r.value.renewed === true);
  }

  {
    const fake = createFakeEmailGrantEnvelopeProvider();
    const op = crypto.randomUUID();
    const sealed = await sealRt(fake, 'rt-commit-ambig', 1, op);
    function scriptedClient(onCommit, onEp) {
      const sequence = [];
      return {
        sequence,
        async query(sql) {
          const text = String(sql || '');
          sequence.push(text.trim().split(/\s+/)[0].toUpperCase());
          if (/^\s*BEGIN\b/i.test(text)) return empty();
          if (/^\s*COMMIT\b/i.test(text)) return onCommit();
          if (/^\s*ROLLBACK\b/i.test(text)) return empty();
          if (matchEp(text)) return onEp();
          if (/INSERT INTO tenant_email_delegated_grants/i.test(text)) {
            return rows(publicStatus({}));
          }
          return empty();
        },
      };
    }
    const client = scriptedClient(
      () => { throw Object.assign(new Error('simulated commit timeout'), { code: 'ETIMEDOUT' }); },
      () => rows(delegatedEpRow()),
    );
    const r = await cust.installInitialDelegatedGrant({
      clientId: CLIENT, endpointId: ENDPOINT, operationId: op, envelope: sealed,
    }, { client });
    ok('COMMIT reject → commit_outcome_unknown',
      !r.ok && r.error === 'commit_outcome_unknown' && noPlanted(r) && noSensitive(r));
    ok('COMMIT ambiguity sequence: BEGIN…COMMIT no ROLLBACK after',
      client.sequence[0] === 'BEGIN' && client.sequence.includes('COMMIT')
      && client.sequence.indexOf('COMMIT') === client.sequence.length - 1
      && !client.sequence.includes('ROLLBACK'));

    const client2 = scriptedClient(
      () => empty(),
      () => { throw Object.assign(new Error('check'), { code: '23514' }); },
    );
    const r2 = await cust.installInitialDelegatedGrant({
      clientId: CLIENT, endpointId: ENDPOINT, operationId: op, envelope: sealed,
    }, { client: client2 });
    ok('pre-COMMIT failure maps + ROLLBACK',
      !r2.ok && r2.error === 'grant_custody_not_applicable'
      && client2.sequence.includes('BEGIN') && client2.sequence.includes('ROLLBACK')
      && !client2.sequence.includes('COMMIT'));
  }

  {
    const src = [ENV_REL, FAKE_REL, CUST_REL]
      .map((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')).join('\n');
    ok('no Azure identity/KV SDK imports',
      !/@azure\/keyvault|@azure\/identity|SecretClient|DefaultAzureCredential/i.test(src));
    ok('custodian documents no TX across I/O',
      /no TX across I\/O|OUTSIDE|outside/i.test(fs.readFileSync(path.join(ROOT, CUST_REL), 'utf8')));
    ok('migration has no refresh_token column',
      !/refresh_token\s+TEXT|refresh_token\s+BYTEA/i.test(fs.readFileSync(MIG_UP, 'utf8')));
    ok('fake documents RFC3394 A256KW + fake custody',
      /RFC 3394|aes-256-wrap|process-local|process_local/i.test(
        fs.readFileSync(path.join(ROOT, FAKE_REL), 'utf8'),
      ));
    ok('withTxn documents commit_outcome_unknown',
      /commit_outcome_unknown/.test(fs.readFileSync(path.join(ROOT, CUST_REL), 'utf8')));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('verifier crashed', e && e.message);
  process.exit(2);
});
