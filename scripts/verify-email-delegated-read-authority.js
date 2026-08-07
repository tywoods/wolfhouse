'use strict';

/**
 * verify:email-delegated-read-authority — offline hostile gate.
 *
 * Unwired repository resolveDelegatedReadAuthority on the delegated-grant
 * custodian: exact input, one SELECT/join, hostile driver-row validation,
 * frozen internal DTO (providerMailboxId from provider_resource_id).
 * No network, routes, OAuth, migration, install, deploy, or live DB.
 */

const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const util = require('util');

const ROOT = path.join(__dirname, '..');
const CUST_REL = 'scripts/lib/email-delegated-grant-custodian.js';
const CUST_PATH = path.join(ROOT, CUST_REL);
const DOC_PATH = path.join(ROOT, 'docs', 'EMAIL-MAILBOX-ADAPTER-BOUNDARY.md');
const PKG_PATH = path.join(ROOT, 'package.json');
const INSTALLER_PATH = path.join(ROOT, 'scripts/lib/email-microsoft-verified-grant-installer.js');
const READ_HEALTH_PATH = path.join(ROOT, 'scripts/lib/email-delegated-grant-read-health.js');

const cust = require('./lib/email-delegated-grant-custodian');

const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENDPOINT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_CLIENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_LOCATION = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_ENDPOINT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const TID = '11111111-1111-4111-8111-111111111111';
const RESOURCE = '22222222-2222-4222-8222-2222222222ab';
const PRINCIPAL_MISMATCH = '33333333-3333-4333-8333-3333333333cd';
const PLANTED_ADDRESS = 'pii-mailbox-must-not-escape@example.com';
const PLANTED_SECRET = 'ya29.NEVER_LEAK_READ_AUTHORITY_RT';
const PLANTED_TOKEN = 'PLANTED_LEASE_TOKEN_read_auth';

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function ser(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function noLeak(v) {
  const s = typeof v === 'string' ? v : ser(v);
  return !s.includes(PLANTED_ADDRESS)
    && !s.includes(PLANTED_SECRET)
    && !s.includes(PLANTED_TOKEN)
    && !s.includes('refresh_token')
    && !s.includes('ciphertext')
    && !s.includes('wrapped_dek')
    && !s.includes('client_secret');
}

const origLookup = dns.lookup;
const origLookupService = dns.lookupService;
const origResolve4 = dns.resolve4;
const origConnect = net.Socket.prototype.connect;
const origHttp = http.request;
const origHttps = https.request;
let networkHits = 0;

function installNetworkGuards() {
  networkHits = 0;
  const bump = () => {
    networkHits += 1;
    throw new Error('NETWORK_FORBIDDEN_IN_READ_AUTHORITY_VERIFIER');
  };
  dns.lookup = dns.lookupService = dns.resolve4 = function blockedDns() { bump(); };
  net.Socket.prototype.connect = function blockedConnect() { bump(); };
  http.request = https.request = function blockedHttp() { bump(); };
}

function restoreNetworkGuards() {
  dns.lookup = origLookup;
  dns.lookupService = origLookupService;
  dns.resolve4 = origResolve4;
  net.Socket.prototype.connect = origConnect;
  http.request = origHttp;
  https.request = origHttps;
}

function baseInput(patch) {
  return Object.assign({
    clientId: CLIENT,
    locationId: LOCATION,
    endpointId: ENDPOINT,
  }, patch || {});
}

function baseRow(patch) {
  return Object.assign({
    client_id: CLIENT,
    location_id: LOCATION,
    endpoint_id: ENDPOINT,
    provider: 'microsoft_graph',
    channel: 'email',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
    binding_status: 'verified',
    provider_tenant_id: TID,
    provider_resource_id: RESOURCE,
    provider_principal_oid: RESOURCE,
    mailbox_kind: 'user',
    mailbox_access_kind: 'own_user',
    public_address: PLANTED_ADDRESS,
    grant_client_id: CLIENT,
    grant_endpoint_id: ENDPOINT,
  }, patch || {});
}

function mockDb(rowsOrFn) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      const text = String(sql || '');
      const p = Array.isArray(params) ? params.slice() : [];
      queries.push({ text, params: p });
      if (typeof rowsOrFn === 'function') {
        return rowsOrFn(text, p);
      }
      if (rowsOrFn && rowsOrFn.throw) {
        throw rowsOrFn.throw instanceof Error
          ? rowsOrFn.throw
          : Object.assign(new Error('pg'), rowsOrFn.throw);
      }
      const rows = Array.isArray(rowsOrFn) ? rowsOrFn : (rowsOrFn && rowsOrFn.rows) || [];
      return { rows, rowCount: rows.length };
    },
  };
}

function dtoKeys(value) {
  return value && typeof value === 'object' ? Reflect.ownKeys(value) : [];
}

function isFrozenDto(value) {
  return Boolean(
    value
    && Object.isFrozen(value)
    && value.clientId === CLIENT
    && value.locationId === LOCATION
    && value.endpointId === ENDPOINT
    && value.provider === 'microsoft_graph'
    && value.providerMailboxId === RESOURCE
    && value.bindingStatus === 'verified',
  );
}

async function main() {
  console.log('verify:email-delegated-read-authority');
  installNetworkGuards();

  // --- module surface / unwired ---
  ok('exports resolveDelegatedReadAuthority', typeof cust.resolveDelegatedReadAuthority === 'function');
  ok('runtime unwired flag false', cust.EMAIL_DELEGATED_READ_AUTHORITY_RUNTIME_WIRED === false);
  ok(
    'input keys exact ordered',
    Array.isArray(cust.DELEGATED_READ_AUTHORITY_INPUT_KEYS)
      && cust.DELEGATED_READ_AUTHORITY_INPUT_KEYS.join(',') === 'clientId,locationId,endpointId',
  );
  ok(
    'dto keys exact',
    Array.isArray(cust.DELEGATED_READ_AUTHORITY_DTO_KEYS)
      && cust.DELEGATED_READ_AUTHORITY_DTO_KEYS.join(',')
        === 'clientId,locationId,endpointId,provider,providerMailboxId,bindingStatus',
  );
  ok(
    'dto never public_address/principal',
    !cust.DELEGATED_READ_AUTHORITY_DTO_KEYS.includes('public_address')
      && !cust.DELEGATED_READ_AUTHORITY_DTO_KEYS.includes('publicAddress')
      && !cust.DELEGATED_READ_AUTHORITY_DTO_KEYS.includes('provider_principal_oid')
      && !cust.DELEGATED_READ_AUTHORITY_DTO_KEYS.includes('providerPrincipalOid'),
  );

  const src = fs.readFileSync(CUST_PATH, 'utf8');
  ok(
    'sql joins three tables',
    /tenant_locations/.test(src)
      && /tenant_channel_endpoints/.test(src)
      && /tenant_email_delegated_grants/.test(src)
      && /SQL_RESOLVE_DELEGATED_READ_AUTHORITY/.test(src),
  );
  ok(
    'sql requires email/microsoft_graph/delegated modes/verified/own_user',
    /channel = 'email'/.test(src)
      && /provider = 'microsoft_graph'/.test(src)
      && /auth_mode = 'delegated_authorization_code'/.test(src)
      && /connector_mode = 'microsoft_delegated_oauth'/.test(src)
      && /binding_status = 'verified'/.test(src)
      && /mailbox_kind = 'user'/.test(src)
      && /mailbox_access_kind = 'own_user'/.test(src),
  );
  ok(
    'sql requires nonnull tid/resource',
    /provider_tenant_id IS NOT NULL/.test(src)
      && /provider_resource_id IS NOT NULL/.test(src),
  );
  ok(
    'public status surface unchanged (no authority fields)',
    !/providerMailboxId|provider_mailbox|bindingStatus/.test(
      String(cust.toPublicGrantStatusDto({
        client_id: CLIENT,
        endpoint_id: ENDPOINT,
        grant_generation: 1,
        grant_status: 'active',
        reconcile_state: 'clean',
        grant_lease_token: null,
      })),
    ),
  );

  // Not wired into installer / read-health modules.
  const installerSrc = fs.readFileSync(INSTALLER_PATH, 'utf8');
  const readHealthSrc = fs.readFileSync(READ_HEALTH_PATH, 'utf8');
  ok(
    'installer not changed for location authority',
    !/resolveDelegatedReadAuthority/.test(installerSrc)
      && !/DELEGATED_READ_AUTHORITY/.test(installerSrc),
  );
  ok(
    'read-health not wired to resolve',
    !/resolveDelegatedReadAuthority/.test(readHealthSrc),
  );

  // package script present
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  ok(
    'package script registered',
    pkg.scripts
      && pkg.scripts['verify:email-delegated-read-authority']
        === 'node scripts/verify-email-delegated-read-authority.js',
  );

  // docs mention slice (if present)
  if (fs.existsSync(DOC_PATH)) {
    const doc = fs.readFileSync(DOC_PATH, 'utf8');
    ok(
      'boundary doc mentions read authority',
      /delegated read.?authority|resolveDelegatedReadAuthority|read-authority/i.test(doc),
    );
  }

  // --- GREEN happy path ---
  {
    const db = mockDb([baseRow()]);
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok('happy path ok', res && res.ok === true, ser(res));
    ok('happy path frozen dto', res.ok && isFrozenDto(res.value), ser(res));
    ok(
      'happy path exact dto keys',
      res.ok
        && dtoKeys(res.value).length === 6
        && dtoKeys(res.value).every((k) => cust.DELEGATED_READ_AUTHORITY_DTO_KEYS.includes(k)),
    );
    ok(
      'happy path never address/principal on dto',
      res.ok
        && !('public_address' in res.value)
        && !('publicAddress' in res.value)
        && !('provider_principal_oid' in res.value)
        && !('providerPrincipalOid' in res.value)
        && !('grant_generation' in res.value),
    );
    ok(
      'one parameterized query',
      db.queries.length === 1
        && db.queries[0].params.length === 3
        && db.queries[0].params[0] === CLIENT
        && db.queries[0].params[1] === LOCATION
        && db.queries[0].params[2] === ENDPOINT,
    );
    ok(
      'sql text is single join select',
      db.queries[0].text.includes('tenant_locations')
        && db.queries[0].text.includes('tenant_channel_endpoints')
        && db.queries[0].text.includes('tenant_email_delegated_grants')
        && !/\bBEGIN\b/i.test(db.queries[0].text)
        && !/\bINSERT\b/i.test(db.queries[0].text)
        && !/\bUPDATE\b/i.test(db.queries[0].text),
    );
    ok('happy path no leak', noLeak(res));
  }

  // --- address/principal mismatch: resource id wins ---
  {
    const db = mockDb([baseRow({
      provider_principal_oid: PRINCIPAL_MISMATCH,
      public_address: PLANTED_ADDRESS,
      provider_resource_id: RESOURCE,
    })]);
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok('mismatch still ok', res && res.ok === true, ser(res));
    ok(
      'resource id wins as providerMailboxId',
      res.ok && res.value.providerMailboxId === RESOURCE
        && res.value.providerMailboxId !== PRINCIPAL_MISMATCH,
    );
    ok(
      'mismatch dto omits address/principal',
      res.ok
        && !('public_address' in res.value)
        && !('provider_principal_oid' in res.value)
        && !ser(res.value).includes(PLANTED_ADDRESS)
        && !ser(res.value).includes(PRINCIPAL_MISMATCH),
    );
    ok('mismatch no leak', noLeak(res));
  }

  // --- snapshot immutability ---
  {
    const row = baseRow();
    const db = mockDb([row]);
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok('immutable base ok', res.ok === true);
    row.provider_resource_id = '99999999-9999-4999-8999-999999999999';
    row.binding_status = 'revoked';
    row.client_id = OTHER_CLIENT;
    ok(
      'driver mutation after snapshot does not affect dto',
      res.ok
        && res.value.providerMailboxId === RESOURCE
        && res.value.bindingStatus === 'verified'
        && res.value.clientId === CLIENT,
    );
    try {
      res.value.providerMailboxId = 'mutated';
      ok('dto assignment ignored or threw', res.value.providerMailboxId === RESOURCE);
    } catch {
      ok('dto assignment threw (frozen)', true);
    }
  }

  // --- wrong / mixed ownership / location / provider / modes / status / resource ---
  async function expectUnresolved(name, rowPatch, inputPatch) {
    const db = mockDb([baseRow(rowPatch)]);
    const res = await cust.resolveDelegatedReadAuthority(baseInput(inputPatch), { db });
    ok(
      name,
      res && res.ok === false
        && (res.error === 'delegated_read_authority_unresolved'
          || res.error === 'input_invalid'
          || res.error === 'delegated_read_authority_ambiguous'),
      ser(res),
    );
    ok(`${name} no leak`, noLeak(res));
  }

  // SQL-level: empty rows (ownership miss)
  {
    const db = mockDb([]);
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok('no row unresolved', res && res.ok === false && res.error === 'delegated_read_authority_unresolved');
    ok('no row no leak', noLeak(res));
  }

  // Wrong client ownership on row (hostile driver returns wrong client)
  await expectUnresolved('wrong client_id on row', { client_id: OTHER_CLIENT, grant_client_id: OTHER_CLIENT });
  await expectUnresolved('mixed grant client ownership', { grant_client_id: OTHER_CLIENT });
  await expectUnresolved('mixed grant endpoint ownership', { grant_endpoint_id: OTHER_ENDPOINT });
  await expectUnresolved('wrong location on row', { location_id: OTHER_LOCATION });
  await expectUnresolved('wrong endpoint on row', { endpoint_id: OTHER_ENDPOINT });
  await expectUnresolved('wrong provider', { provider: 'gmail_api' });
  await expectUnresolved('wrong channel', { channel: 'whatsapp' });
  await expectUnresolved('wrong auth_mode', { auth_mode: 'application_client_credentials' });
  await expectUnresolved('wrong connector_mode', { connector_mode: 'microsoft_app_only_enterprise' });
  await expectUnresolved('status reauthorization_required', { binding_status: 'reauthorization_required' });
  await expectUnresolved('status unverified_offline', { binding_status: 'unverified_offline' });
  await expectUnresolved('status revoked', { binding_status: 'revoked' });
  await expectUnresolved('status pending_manual_validation', { binding_status: 'pending_manual_validation' });
  await expectUnresolved('mailbox shared-like kind', { mailbox_kind: 'shared' });
  await expectUnresolved('mailbox access application', { mailbox_access_kind: 'application' });
  await expectUnresolved('null provider_tenant_id', { provider_tenant_id: null });
  await expectUnresolved('malformed provider_tenant_id', { provider_tenant_id: 'not-a-uuid' });
  await expectUnresolved('null provider_resource_id', { provider_resource_id: null });
  await expectUnresolved('malformed provider_resource_id', { provider_resource_id: 'users/me' });
  await expectUnresolved('uppercase resource id rejected', {
    provider_resource_id: RESOURCE.toUpperCase(),
  });

  // Wrong input ownership (params go to SQL; empty return)
  {
    const db = mockDb([]);
    const res = await cust.resolveDelegatedReadAuthority(
      baseInput({ clientId: OTHER_CLIENT }),
      { db },
    );
    ok('wrong input client unresolved', res.ok === false);
    ok(
      'wrong input client still parameterized',
      db.queries.length === 1 && db.queries[0].params[0] === OTHER_CLIENT,
    );
  }
  {
    const db = mockDb([]);
    const res = await cust.resolveDelegatedReadAuthority(
      baseInput({ locationId: OTHER_LOCATION }),
      { db },
    );
    ok('wrong input location unresolved', res.ok === false);
    ok(
      'wrong input location param',
      db.queries[0].params[1] === OTHER_LOCATION,
    );
  }

  // --- missing / duplicate / malformed / proxy / accessor / symbol / extras ---
  async function expectInputInvalid(name, input, deps) {
    const db = mockDb([baseRow()]);
    const res = await cust.resolveDelegatedReadAuthority(input, deps || { db });
    ok(name, res && res.ok === false && res.error === 'input_invalid', ser(res));
    ok(`${name} no sql when invalid`, (deps && deps.db ? deps.db : db).queries.length === 0);
    ok(`${name} no leak`, noLeak(res));
  }

  await expectInputInvalid('missing input', null);
  await expectInputInvalid('empty object', {});
  await expectInputInvalid('missing endpointId', { clientId: CLIENT, locationId: LOCATION });
  await expectInputInvalid('missing locationId', { clientId: CLIENT, endpointId: ENDPOINT });
  await expectInputInvalid('array input', [CLIENT, LOCATION, ENDPOINT]);
  await expectInputInvalid('malformed client uuid', baseInput({ clientId: 'not-uuid' }));
  await expectInputInvalid('malformed location uuid', baseInput({ locationId: 'x' }));
  await expectInputInvalid('malformed endpoint uuid', baseInput({ endpointId: '123' }));

  // Caller extra fields (mailbox/provider/address/generation)
  await expectInputInvalid('extra provider field', Object.assign(baseInput(), { provider: 'microsoft_graph' }));
  await expectInputInvalid('extra mailbox field', Object.assign(baseInput(), { mailbox: PLANTED_ADDRESS }));
  await expectInputInvalid('extra address field', Object.assign(baseInput(), { publicAddress: PLANTED_ADDRESS }));
  await expectInputInvalid('extra generation field', Object.assign(baseInput(), { grantGeneration: 1 }));
  await expectInputInvalid('extra providerMailboxId', Object.assign(baseInput(), {
    providerMailboxId: RESOURCE,
  }));
  await expectInputInvalid('extra bindingStatus', Object.assign(baseInput(), { bindingStatus: 'verified' }));

  // Wrong key order
  await expectInputInvalid('wrong key order', {
    locationId: LOCATION,
    clientId: CLIENT,
    endpointId: ENDPOINT,
  });

  // Symbol / accessor / non-enumerable / proxy
  {
    const withSym = baseInput();
    withSym[Symbol('x')] = 'y';
    await expectInputInvalid('symbol key rejected', withSym);
  }
  {
    const o = {};
    Object.defineProperty(o, 'clientId', { value: CLIENT, enumerable: true });
    Object.defineProperty(o, 'locationId', { value: LOCATION, enumerable: true });
    Object.defineProperty(o, 'endpointId', {
      get() { return ENDPOINT; },
      enumerable: true,
    });
    await expectInputInvalid('accessor endpoint rejected', o);
  }
  {
    const o = {};
    Object.defineProperty(o, 'clientId', { value: CLIENT, enumerable: true });
    Object.defineProperty(o, 'locationId', { value: LOCATION, enumerable: true });
    Object.defineProperty(o, 'endpointId', { value: ENDPOINT, enumerable: false });
    await expectInputInvalid('nonenumerable endpoint rejected', o);
  }
  {
    const target = baseInput();
    const proxy = new Proxy(target, {
      get(t, k) { return t[k]; },
      ownKeys() { return ['clientId', 'locationId', 'endpointId', 'extra']; },
      getOwnPropertyDescriptor(t, k) {
        if (k === 'extra') return { configurable: true, enumerable: true, value: 1 };
        return Object.getOwnPropertyDescriptor(t, k);
      },
    });
    await expectInputInvalid('proxy extras rejected', proxy);
  }
  {
    const proto = { clientId: CLIENT, locationId: LOCATION, endpointId: ENDPOINT };
    const o = Object.create(proto);
    await expectInputInvalid('inherited-only keys rejected', o);
  }

  // db required
  {
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), {});
    ok('db_required sanitized', res && res.ok === false);
    ok('db_required no leak', noLeak(res));
  }
  {
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db: { query: null } });
    ok('db_invalid sanitized', res && res.ok === false);
    ok('db_invalid no leak', noLeak(res));
  }

  // duplicate rows → ambiguous
  {
    const db = mockDb([baseRow(), baseRow()]);
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok(
      'duplicate rows ambiguous',
      res && res.ok === false && res.error === 'delegated_read_authority_ambiguous',
      ser(res),
    );
    ok('duplicate no leak', noLeak(res));
  }

  // malformed driver row: missing key, extra key, accessor, symbol, proxy row
  {
    const bad = baseRow();
    delete bad.public_address;
    const db = mockDb([bad]);
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok('missing row key unresolved', res.ok === false && res.error === 'delegated_read_authority_unresolved');
  }
  {
    const bad = baseRow();
    bad.extra = 'nope';
    const db = mockDb([bad]);
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok('extra row key unresolved', res.ok === false);
  }
  {
    const bad = baseRow();
    Object.defineProperty(bad, 'provider_resource_id', {
      get() { return RESOURCE; },
      enumerable: true,
      configurable: true,
    });
    // redefine after assign — ensure accessor
    delete bad.provider_resource_id;
    Object.defineProperty(bad, 'provider_resource_id', {
      get() { return RESOURCE; },
      enumerable: true,
    });
    // Need exact key set still — rebuild carefully
    const row = {};
    for (const k of cust.DELEGATED_READ_AUTHORITY_ROW_KEYS) {
      if (k === 'provider_resource_id') {
        Object.defineProperty(row, k, { get() { return RESOURCE; }, enumerable: true });
      } else {
        Object.defineProperty(row, k, {
          value: baseRow()[k],
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    const db = mockDb([row]);
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok('accessor resource id unresolved', res.ok === false);
  }
  {
    const row = baseRow();
    const proxyRow = new Proxy(row, {
      get(t, k) { return t[k]; },
      ownKeys() { return Reflect.ownKeys(row).concat([Symbol('x')]); },
      getOwnPropertyDescriptor(t, k) {
        if (typeof k === 'symbol') {
          return { configurable: true, enumerable: true, value: 1 };
        }
        return Object.getOwnPropertyDescriptor(t, k);
      },
    });
    const db = mockDb([proxyRow]);
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok('proxy/symbol row unresolved', res.ok === false);
  }

  // principal/address non-string malformed
  await expectUnresolved('nonstring principal', { provider_principal_oid: 12345 });
  await expectUnresolved('nonstring address', { public_address: { email: PLANTED_ADDRESS } });

  // db throw sanitized
  {
    const db = mockDb({
      throw: Object.assign(new Error(`boom ${PLANTED_SECRET} ${PLANTED_ADDRESS}`), {
        detail: PLANTED_SECRET,
      }),
    });
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok('db throw sanitized', res && res.ok === false && res.error === 'db_error');
    ok('db throw no secret/PII escape', noLeak(res) && !ser(res).includes('boom'));
  }

  // case-normalize input uuids
  {
    const db = mockDb([baseRow()]);
    const res = await cust.resolveDelegatedReadAuthority({
      clientId: CLIENT.toUpperCase(),
      locationId: LOCATION.toUpperCase(),
      endpointId: ENDPOINT.toUpperCase(),
    }, { db });
    ok('uppercase uuid input accepted+normalized', res.ok === true && isFrozenDto(res.value));
    ok(
      'params lowercased',
      db.queries[0].params[0] === CLIENT
        && db.queries[0].params[1] === LOCATION
        && db.queries[0].params[2] === ENDPOINT,
    );
  }

  // requireDb pool is fine for single select (unlike writes)
  {
    const db = mockDb([baseRow()]);
    db.connect = async () => ({});
    db.totalCount = 1;
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok('pool-like db allowed for read resolve', res.ok === true);
  }

  // ensure failure objects have no details bag with PII
  {
    const db = mockDb([baseRow({ public_address: PLANTED_ADDRESS, provider_resource_id: null })]);
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok(
      'failure has no details/PII',
      res.ok === false
        && res.details === undefined
        && Object.keys(res).sort().join(',') === 'error,ok'
        && noLeak(res),
    );
  }

  // ── Hostile-boundary family (strict RED-GREEN) ─────────────────────────
  // Attacker-controlled errors/PII must never escape from deps/db/client/
  // query/result/rows/input/driver surfaces. Module-init pinned isProxy;
  // zero traps; dense Array.prototype rows; enumerable own-data row fields.

  function sanitizedFail(res) {
    return Boolean(
      res
      && res.ok === false
      && typeof res.error === 'string'
      && res.details === undefined
      && Object.keys(res).sort().join(',') === 'error,ok'
      && Object.isFrozen(res)
      && noLeak(res)
      && !ser(res).includes('boom')
      && !ser(res).includes(PLANTED_ADDRESS)
      && !ser(res).includes(PLANTED_SECRET),
    );
  }

  function trapCounters() {
    return {
      apply: 0,
      get: 0,
      getPrototypeOf: 0,
      getOwnPropertyDescriptor: 0,
      ownKeys: 0,
      set: 0,
      has: 0,
    };
  }

  function countingProxy(target, traps) {
    return new Proxy(target, {
      apply(t, thisArg, args) {
        traps.apply += 1;
        return Reflect.apply(t, thisArg, args);
      },
      get(t, prop, receiver) {
        // Promise resolve may probe [[Get]] 'then' when an async query returns
        // a proxy. That is language thenable-check noise, not production
        // reflection. Claim non-thenable and do not count it; every other get
        // is a production trap.
        if (prop === 'then') return undefined;
        traps.get += 1;
        return Reflect.get(t, prop, receiver);
      },
      getPrototypeOf(t) {
        traps.getPrototypeOf += 1;
        return Reflect.getPrototypeOf(t);
      },
      getOwnPropertyDescriptor(t, prop) {
        traps.getOwnPropertyDescriptor += 1;
        return Reflect.getOwnPropertyDescriptor(t, prop);
      },
      ownKeys(t) {
        traps.ownKeys += 1;
        return Reflect.ownKeys(t);
      },
      set(t, prop, value, receiver) {
        traps.set += 1;
        return Reflect.set(t, prop, value, receiver);
      },
      has(t, prop) {
        traps.has += 1;
        return Reflect.has(t, prop);
      },
    });
  }

  function zeroTraps(traps) {
    return traps.apply === 0
      && traps.get === 0
      && traps.getPrototypeOf === 0
      && traps.getOwnPropertyDescriptor === 0
      && traps.ownKeys === 0
      && traps.set === 0
      && traps.has === 0;
  }

  /**
   * Realistic node-postgres Result (Result.prototype, ordinary metadata).
   * Assigns rows by value without reading rows.length via [[Get]] so proxied
   * rows arrays can be tested for zero production traps.
   */
  function RealisticResult(rows, rowCount) {
    this.command = 'SELECT';
    this.rowCount = typeof rowCount === 'number'
      ? rowCount
      : (Array.isArray(rows) ? rows.length : 0);
    this.oid = null;
    this.rows = rows;
    this.fields = [];
  }

  // Throwing deps.db accessor — must not escape planted secret/PII
  {
    const deps = {};
    Object.defineProperty(deps, 'db', {
      get() {
        throw new Error(`boom deps.db ${PLANTED_SECRET} ${PLANTED_ADDRESS}`);
      },
      enumerable: true,
      configurable: true,
    });
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), deps);
    ok('throwing deps.db accessor sanitized', sanitizedFail(res), ser(res));
  }

  // Throwing deps.client accessor
  {
    const deps = {};
    Object.defineProperty(deps, 'client', {
      get() {
        throw new Error(`boom deps.client ${PLANTED_SECRET} ${PLANTED_ADDRESS}`);
      },
      enumerable: true,
      configurable: true,
    });
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), deps);
    ok('throwing deps.client accessor sanitized', sanitizedFail(res), ser(res));
  }

  // Throwing db.query accessor (own data query is accessor)
  {
    const db = {};
    Object.defineProperty(db, 'query', {
      get() {
        throw new Error(`boom db.query ${PLANTED_SECRET} ${PLANTED_ADDRESS}`);
      },
      enumerable: true,
      configurable: true,
    });
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok('throwing db.query accessor sanitized', sanitizedFail(res), ser(res));
  }

  // Throwing result.rows accessor after successful query settlement
  {
    const db = {
      async query() {
        const result = {};
        Object.defineProperty(result, 'rows', {
          get() {
            throw new Error(`boom result.rows ${PLANTED_SECRET} ${PLANTED_ADDRESS}`);
          },
          enumerable: true,
          configurable: true,
        });
        return result;
      },
    };
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok('throwing result.rows accessor sanitized', sanitizedFail(res), ser(res));
  }

  // Proxies at every surface — zero traps via module-init pinned isProxy
  {
    const trapsInput = trapCounters();
    const proxyInput = countingProxy(baseInput(), trapsInput);
    const resIn = await cust.resolveDelegatedReadAuthority(proxyInput, { db: mockDb([baseRow()]) });
    ok('proxy input fail-closed', sanitizedFail(resIn), ser(resIn));
    ok('proxy input zero traps', zeroTraps(trapsInput), ser(trapsInput));
  }
  {
    const trapsDeps = trapCounters();
    const plainDb = mockDb([baseRow()]);
    const proxyDeps = countingProxy({ db: plainDb }, trapsDeps);
    const resDeps = await cust.resolveDelegatedReadAuthority(baseInput(), proxyDeps);
    ok('proxy deps fail-closed', sanitizedFail(resDeps), ser(resDeps));
    ok('proxy deps zero traps', zeroTraps(trapsDeps), ser(trapsDeps));
  }
  {
    const trapsDb = trapCounters();
    const plainDb = mockDb([baseRow()]);
    const proxyDb = countingProxy(plainDb, trapsDb);
    const resDb = await cust.resolveDelegatedReadAuthority(baseInput(), { db: proxyDb });
    ok('proxy db fail-closed', sanitizedFail(resDb), ser(resDb));
    ok('proxy db zero traps', zeroTraps(trapsDb), ser(trapsDb));
  }
  {
    const trapsResult = trapCounters();
    const db = {
      async query() {
        return countingProxy(new RealisticResult([baseRow()]), trapsResult);
      },
    };
    const resR = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok('proxy result fail-closed', sanitizedFail(resR), ser(resR));
    ok('proxy result zero traps', zeroTraps(trapsResult), ser(trapsResult));
  }
  {
    const trapsRows = trapCounters();
    const db = {
      async query() {
        const rows = countingProxy([baseRow()], trapsRows);
        // Pre-supply rowCount so the Result helper never [[Get]]s rows.length.
        return new RealisticResult(rows, 1);
      },
    };
    const resRows = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok('proxy rows fail-closed', sanitizedFail(resRows), ser(resRows));
    ok('proxy rows zero traps', zeroTraps(trapsRows), ser(trapsRows));
  }
  {
    const trapsRow = trapCounters();
    const db = {
      async query() {
        return new RealisticResult([countingProxy(baseRow(), trapsRow)]);
      },
    };
    const resRow = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok('proxy driver row fail-closed', sanitizedFail(resRow), ser(resRow));
    ok('proxy driver row zero traps', zeroTraps(trapsRow), ser(trapsRow));
  }

  // Nonenumerable public_address / fields — reject (enumerable own-data only)
  {
    const row = {};
    for (const k of cust.DELEGATED_READ_AUTHORITY_ROW_KEYS) {
      Object.defineProperty(row, k, {
        value: baseRow()[k],
        enumerable: k !== 'public_address',
        writable: true,
        configurable: true,
      });
    }
    const db = mockDb([row]);
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok(
      'nonenumerable public_address unresolved',
      res && res.ok === false
        && res.error === 'delegated_read_authority_unresolved'
        && sanitizedFail(res),
      ser(res),
    );
  }
  {
    const row = {};
    for (const k of cust.DELEGATED_READ_AUTHORITY_ROW_KEYS) {
      Object.defineProperty(row, k, {
        value: baseRow()[k],
        enumerable: k !== 'provider_resource_id',
        writable: true,
        configurable: true,
      });
    }
    const db = mockDb([row]);
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok(
      'nonenumerable provider_resource_id unresolved',
      res && res.ok === false
        && res.error === 'delegated_read_authority_unresolved'
        && sanitizedFail(res),
      ser(res),
    );
  }

  // Ambient util.types.isProxy monkeypatch after load must not hide proxies
  {
    if (typeof util.types.isProxy === 'function') {
      const origIsProxy = util.types.isProxy;
      let monkeyInvocations = 0;
      util.types.isProxy = function patchedIsProxy() {
        monkeyInvocations += 1;
        return false;
      };
      try {
        const traps = trapCounters();
        const proxyInput = countingProxy(baseInput(), traps);
        const res = await cust.resolveDelegatedReadAuthority(
          proxyInput,
          { db: mockDb([baseRow()]) },
        );
        ok(
          'ambient isProxy monkeypatch resistant',
          sanitizedFail(res) && zeroTraps(traps),
          ser({ res, traps, monkeyInvocations }),
        );
      } finally {
        util.types.isProxy = origIsProxy;
      }
    } else {
      ok('ambient isProxy monkeypatch resistant', false, 'util.types.isProxy unavailable');
    }
  }

  // Ordinary success still works (plain bag)
  {
    const db = mockDb([baseRow()]);
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok('ordinary success still ok', res && res.ok === true && isFrozenDto(res.value), ser(res));
    ok('ordinary success no leak', noLeak(res));
  }

  // Realistic node-postgres Result.prototype shape accepted (narrow adapter)
  {
    const db = {
      queries: [],
      async query(sql, params) {
        this.queries.push({ text: String(sql || ''), params: Array.isArray(params) ? params.slice() : [] });
        return new RealisticResult([baseRow()]);
      },
    };
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { db });
    ok(
      'realistic pg Result success',
      res && res.ok === true && isFrozenDto(res.value),
      ser(res),
    );
    ok('realistic Result no leak', noLeak(res));
  }

  // Realistic Client.prototype.query (non-enumerable prototype method)
  {
    function RealisticClient(rows) {
      this._rows = rows;
    }
    RealisticClient.prototype.query = async function query() {
      return new RealisticResult(this._rows);
    };
    const client = new RealisticClient([baseRow()]);
    const res = await cust.resolveDelegatedReadAuthority(baseInput(), { client });
    ok(
      'realistic pg Client.prototype.query success',
      res && res.ok === true && isFrozenDto(res.value),
      ser(res),
    );
    ok('realistic Client no leak', noLeak(res));
  }

  // network never touched
  ok('no network hits', networkHits === 0);

  restoreNetworkGuards();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  restoreNetworkGuards();
  console.error('verify crashed:', err && err.stack ? err.stack : err);
  process.exit(2);
});
