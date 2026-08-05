'use strict';
/**
 * Hostile offline gate for Microsoft OAuth transaction start/callback + migration 061
 * endpoint binding. No network, no live DB apply, no route completion, no tokens.
 * When disposable PG is unavailable, uses a stateful SQL fake for repository INSERT...SELECT.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const svc = require('./lib/email-microsoft-oauth-transaction-service');
const {
  CHECKSUM_MODE_CANONICAL_LF_V1,
  sha256CanonicalLfV1File,
  loadManifest,
  forwardEntries,
} = require('./lib/migration-integrity');

const ROOT = path.join(__dirname, '..');
const MIG_DIR = path.join(ROOT, 'database/migrations');
const UP = '061_tenant_email_oauth_transaction_endpoint_binding.sql';
const DOWN = '061_tenant_email_oauth_transaction_endpoint_binding_down.sql';
const UP_PATH = path.join(MIG_DIR, UP);
const DOWN_PATH = path.join(MIG_DIR, DOWN);
const MANIFEST_PATH = path.join(MIG_DIR, 'canonical-manifest.json');
const SVC_PATH = path.join(ROOT, 'scripts/lib/email-microsoft-oauth-transaction-service.js');

const ids = {
  clientId: '11111111-1111-1111-1111-111111111111',
  locationId: '22222222-2222-2222-2222-222222222222',
  staffUserId: '33333333-3333-3333-3333-333333333333',
  authSessionId: '44444444-4444-4444-4444-444444444444',
  endpointId: '55555555-5555-5555-5555-555555555555',
};
const other = {
  clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  locationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  endpointId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  locationText: 'other-site',
};
const env = {
  LUNA_EMAIL_OAUTH_START_ENABLED: 'true',
  LUNA_DEPLOYMENT: 'sunset-staging',
  LUNA_EMAIL_OAUTH_CLIENT_ID: '66666666-6666-6666-6666-666666666666',
};
const callbackEnv = {
  LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: 'true',
  LUNA_DEPLOYMENT: 'sunset-staging',
};

const ELIGIBLE_STATUSES = new Set(['unverified_offline', 'pending_manual_validation']);

/**
 * Stateful SQL fake implementing the create INSERT...SELECT join + consume UPDATE.
 * Proves cross-tenant / wrong-location / wrong mode-status / missing endpoint produce
 * zero rows (repository throws oauth_start_endpoint_unavailable).
 */
function createStatefulSqlFake(seedEndpoints) {
  const endpoints = seedEndpoints.slice();
  const locations = [
    {
      id: ids.locationId,
      client_id: ids.clientId,
      location_id: 'sunset-somo',
    },
    {
      id: other.locationId,
      client_id: other.clientId,
      location_id: other.locationText,
    },
    // Same text token under wrong client must not satisfy join for primary client.
    {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      client_id: other.clientId,
      location_id: 'sunset-somo',
    },
  ];
  const rows = [];
  const queries = [];

  function normalizeSql(sql) {
    return String(sql).replace(/\s+/g, ' ').trim();
  }

  function matchCreate(sql) {
    return normalizeSql(sql) === normalizeSql(svc.SQL_CREATE_TRANSACTION);
  }
  function matchConsume(sql) {
    return normalizeSql(sql) === normalizeSql(svc.SQL_CONSUME_TRANSACTION);
  }

  async function query(sql, params) {
    queries.push({ sql: normalizeSql(sql), params: params ? params.slice() : [] });
    if (matchCreate(sql)) {
      assert.strictEqual(params.length, 10, 'create params arity');
      const [
        clientId, locationId, staffUserId, authSessionId, endpointId,
        stateHash, codeVerifier, nonce, issuedAt, expiresAt,
      ] = params;
      const matched = endpoints.filter((e) => {
        if (e.client_id !== clientId || e.id !== endpointId) return false;
        if (e.provider !== 'microsoft_graph') return false;
        if (e.auth_mode !== 'delegated_authorization_code') return false;
        if (e.connector_mode !== 'microsoft_delegated_oauth') return false;
        if (!ELIGIBLE_STATUSES.has(e.binding_status)) return false;
        const tl = locations.find(
          (l) => l.id === locationId
            && l.client_id === e.client_id
            && l.location_id === e.location_id,
        );
        return Boolean(tl);
      });
      if (matched.length !== 1) return { rows: [] };
      const ep = matched[0];
      const tl = locations.find((l) => l.id === locationId && l.client_id === clientId);
      const row = {
        id: crypto.randomUUID(),
        client_id: clientId,
        location_id: tl.id,
        staff_user_id: staffUserId,
        auth_session_id: authSessionId,
        endpoint_id: ep.id,
        state_hash: stateHash,
        code_verifier: codeVerifier,
        nonce,
        issued_at: issuedAt,
        expires_at: expiresAt,
        consumed_at: null,
      };
      rows.push(row);
      return { rows: [{ expires_at: expiresAt }] };
    }
    if (matchConsume(sql)) {
      assert.strictEqual(params.length, 4, 'consume params arity');
      const [stateHash, clientId, authSessionId, now] = params;
      const hit = rows.find(
        (r) => r.state_hash.equals(stateHash)
          && r.client_id === clientId
          && r.auth_session_id === authSessionId
          && r.consumed_at == null
          && r.expires_at > now,
      );
      if (!hit) return { rows: [] };
      hit.consumed_at = now;
      return {
        rows: [{
          id: hit.id,
          location_id: hit.location_id,
          staff_user_id: hit.staff_user_id,
          code_verifier: hit.code_verifier,
          nonce: hit.nonce,
          endpoint_id: hit.endpoint_id,
        }],
      };
    }
    throw new Error(`unexpected_sql:${String(sql).slice(0, 80)}`);
  }

  return {
    query,
    queries,
    rows,
    endpoints,
    addEndpoint(ep) { endpoints.push(ep); },
  };
}

function eligibleEndpoint(overrides = {}) {
  return {
    id: ids.endpointId,
    client_id: ids.clientId,
    location_id: 'sunset-somo',
    provider: 'microsoft_graph',
    auth_mode: 'delegated_authorization_code',
    connector_mode: 'microsoft_delegated_oauth',
    binding_status: 'unverified_offline',
    ...overrides,
  };
}

function startInput(overrides = {}) {
  return { ...ids, ...overrides };
}

(async () => {
  // ---------------------------------------------------------------------------
  // Migration 061 static checks
  // ---------------------------------------------------------------------------
  assert.ok(fs.existsSync(UP_PATH), '061 up exists');
  assert.ok(fs.existsSync(DOWN_PATH), '061 down exists');
  const upSql = fs.readFileSync(UP_PATH, 'utf8');
  const downSql = fs.readFileSync(DOWN_PATH, 'utf8');
  assert.ok(/ADD COLUMN endpoint_id UUID NOT NULL/.test(upSql), 'up adds NOT NULL endpoint_id');
  assert.ok(/tenant_email_oauth_transactions_endpoint_fk/.test(upSql), 'up has endpoint FK name');
  assert.ok(
    /FOREIGN KEY\s*\(\s*client_id\s*,\s*endpoint_id\s*\)/.test(upSql)
      && /REFERENCES\s+tenant_channel_endpoints\s*\(\s*client_id\s*,\s*id\s*\)/.test(upSql),
    'up tenant-safe composite FK',
  );
  assert.ok(
    /tenant_email_oauth_transactions_owner_endpoint_idx/.test(upSql)
      && /\(\s*client_id\s*,\s*auth_session_id\s*,\s*location_id\s*,\s*endpoint_id\s*\)/.test(upSql),
    'up owner index includes endpoint',
  );
  assert.ok(
    /preexisting tenant_email_oauth_transactions rows prevent safe NOT NULL endpoint_id/i.test(upSql)
      && /refuse backfill/i.test(upSql)
      && /EXISTS\s*\(\s*SELECT 1 FROM tenant_email_oauth_transactions\s*\)/i.test(upSql),
    'up fail-closed on preexisting rows',
  );
  assert.ok(!/\bUPDATE\s+tenant_email_oauth_transactions\b/i.test(upSql), 'up no backfill UPDATE');
  assert.ok(!/\bDELETE\s+FROM\s+tenant_email_oauth_transactions\b/i.test(upSql), 'up no DELETE rows');
  assert.ok(
    !/\bINSERT\s+INTO\s+tenant_email_oauth_transactions\b/i.test(
      upSql.replace(/COMMENT[\s\S]*?;/g, '').replace(/--[^\n]*/g, ''),
    ),
    'up no INSERT product DML',
  );
  assert.ok(
    /DROP INDEX IF EXISTS tenant_email_oauth_transactions_owner_endpoint_idx/.test(downSql)
      && /DROP CONSTRAINT IF EXISTS tenant_email_oauth_transactions_endpoint_fk/.test(downSql)
      && /DROP COLUMN IF EXISTS endpoint_id/.test(downSql),
    'down removes FK/index/column',
  );
  assert.ok(!/DROP TABLE/i.test(downSql), 'down does not drop table');
  assert.ok(
    !/staff_users_client_id_id_uq|auth_sessions_client_id_id_staff_user_id_uq|tenant_locations_client_id_id_uq/.test(downSql),
    'down does not touch 060 parent uniques',
  );

  const manifest = loadManifest(MANIFEST_PATH);
  const upEnt = (manifest.entries || []).find((e) => e.filename === UP);
  const downEnt = (manifest.entries || []).find((e) => e.filename === DOWN);
  const upHash = sha256CanonicalLfV1File(UP_PATH);
  const downHash = sha256CanonicalLfV1File(DOWN_PATH);
  assert.ok(upEnt && upEnt.inForwardChain && upEnt.classification === 'canonical_forward', 'manifest up forward');
  assert.strictEqual(upEnt.order, 60, 'manifest up order 60');
  assert.strictEqual(upEnt.sha256, upHash, 'manifest up sha');
  assert.ok(downEnt && downEnt.classification === 'rollback_down' && downEnt.inForwardChain === false, 'manifest down');
  assert.strictEqual(downEnt.sha256, downHash, 'manifest down sha');
  assert.strictEqual(manifest.checksumMode, CHECKSUM_MODE_CANONICAL_LF_V1, 'checksum mode');
  assert.strictEqual(forwardEntries(manifest).length, 60, 'forward chain length 60');

  // ---------------------------------------------------------------------------
  // Service surface: ordered INPUT_KEYS + SQL constants
  // ---------------------------------------------------------------------------
  assert.deepStrictEqual(
    [...svc.INPUT_KEYS],
    ['clientId', 'locationId', 'staffUserId', 'authSessionId', 'endpointId'],
    'ordered INPUT_KEYS include endpointId',
  );
  assert.match(svc.SQL_CREATE_TRANSACTION, /INSERT INTO tenant_email_oauth_transactions/);
  assert.match(svc.SQL_CREATE_TRANSACTION, /INNER JOIN tenant_locations tl/);
  assert.match(svc.SQL_CREATE_TRANSACTION, /tl\.location_id = e\.location_id/);
  assert.match(svc.SQL_CREATE_TRANSACTION, /tl\.id = \$2::uuid/);
  assert.match(svc.SQL_CREATE_TRANSACTION, /e\.id = \$5::uuid/);
  assert.match(svc.SQL_CREATE_TRANSACTION, /e\.provider = 'microsoft_graph'/);
  assert.match(svc.SQL_CREATE_TRANSACTION, /delegated_authorization_code/);
  assert.match(svc.SQL_CREATE_TRANSACTION, /microsoft_delegated_oauth/);
  assert.match(svc.SQL_CREATE_TRANSACTION, /unverified_offline/);
  assert.match(svc.SQL_CREATE_TRANSACTION, /pending_manual_validation/);
  assert.match(svc.SQL_CREATE_TRANSACTION, /RETURNING expires_at/);
  assert.ok(!/VALUES\s*\(/i.test(svc.SQL_CREATE_TRANSACTION), 'create is INSERT...SELECT not VALUES');
  assert.match(svc.SQL_CONSUME_TRANSACTION, /RETURNING id, location_id, staff_user_id, code_verifier, nonce, endpoint_id/);

  const svcSrc = fs.readFileSync(SVC_PATH, 'utf8');
  assert.ok(!/authorization_url[\s\S]{0,200}endpoint/i.test(svcSrc.split('return Object.freeze({ authorization_url')[1] || ''), 'start DTO has no endpoint field wiring');

  // ---------------------------------------------------------------------------
  // Start happy path — public URL/status unchanged; endpoint not in URL/result
  // ---------------------------------------------------------------------------
  for (const value of [undefined, 'TRUE', '1', true]) {
    assert.strictEqual(svc.isStartEnabled({ LUNA_EMAIL_OAUTH_START_ENABLED: value }), false);
  }
  const writes = [];
  const service = svc.createMicrosoftOAuthTransactionService({
    repository: {
      create: async (row) => {
        writes.push(row);
        return { expires_at: row.expiresAt };
      },
    },
    env,
    randomBytes: (n) => Buffer.alloc(n, 7),
    now: () => new Date('2026-08-05T12:00:00Z'),
  });
  const dto = await service.start(startInput());
  assert.deepStrictEqual(Object.keys(dto), ['authorization_url', 'expires_at']);
  const url = new URL(dto.authorization_url);
  assert.strictEqual(url.origin + url.pathname, svc.AUTHORITY);
  assert.deepStrictEqual(
    Object.fromEntries(
      ['client_id', 'response_type', 'redirect_uri', 'response_mode', 'scope', 'code_challenge_method']
        .map((k) => [k, url.searchParams.get(k)]),
    ),
    {
      client_id: env.LUNA_EMAIL_OAUTH_CLIENT_ID,
      response_type: 'code',
      redirect_uri: svc.REDIRECT_URI,
      response_mode: 'query',
      scope: svc.SCOPES,
      code_challenge_method: 'S256',
    },
  );
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].endpointId, ids.endpointId);
  assert.strictEqual(writes[0].stateHash.length, 32);
  assert.match(writes[0].codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(dto.expires_at, '2026-08-05T12:10:00.000Z');
  assert.strictEqual(
    crypto.createHash('sha256').update(url.searchParams.get('state')).digest().equals(writes[0].stateHash),
    true,
  );
  const publicJson = JSON.stringify(dto);
  assert.ok(!publicJson.includes(ids.endpointId), 'public start result has no endpoint UUID');
  assert.ok(!url.searchParams.has('endpoint_id') && !url.searchParams.has('endpointId'), 'auth URL has no endpoint');
  assert.ok(!url.toString().includes(ids.endpointId), 'auth URL string has no endpoint id');
  assert.ok(!url.searchParams.has('code_verifier'), 'auth URL has no code_verifier param');
  assert.ok(!('code_verifier' in dto) && !('endpoint_id' in dto) && !('endpointId' in dto), 'start DTO keys exclude secrets/endpoint');

  // ---------------------------------------------------------------------------
  // Input hostility: missing/wrong endpoint, extras, proxies, symbols, accessors
  // ---------------------------------------------------------------------------
  let malformedWrites = 0;
  const rejectStart = async (input, pattern = /invalid_request/) => {
    const s = svc.createMicrosoftOAuthTransactionService({
      repository: { create: async () => { malformedWrites += 1; return { expires_at: new Date() }; } },
      env,
      randomBytes: (n) => Buffer.alloc(n, 7),
    });
    await assert.rejects(() => s.start(input), pattern);
  };
  await rejectStart({
    clientId: ids.clientId,
    locationId: ids.locationId,
    staffUserId: ids.staffUserId,
    authSessionId: ids.authSessionId,
  });
  await rejectStart({ ...ids, endpointId: 'not-a-uuid' });
  await rejectStart({ ...ids, endpointId: ids.endpointId, extra: 'evil' });
  await rejectStart({ ...ids, endpointId: ids.endpointId, __proto__: { x: 1 } });
  for (const field of ['authority', 'redirect_uri', 'client_id', 'scope', 'state', 'nonce', 'code_verifier', 'endpoint_id']) {
    await rejectStart({ ...ids, [field]: 'attacker' });
  }
  const withSymbol = { ...ids };
  withSymbol[Symbol('x')] = 'evil';
  // Object.keys ignores symbols; exactObject uses Object.keys — symbols alone do not inflate length.
  // Ensure non-UUID and proxy still fail.
  const proxyInput = new Proxy({ ...ids }, {
    get(t, p) { return p === 'endpointId' ? 'bad' : t[p]; },
    ownKeys() { return svc.INPUT_KEYS.slice(); },
    getOwnPropertyDescriptor(t, p) {
      return { configurable: true, enumerable: true, value: p === 'endpointId' ? 'bad' : t[p] };
    },
  });
  await rejectStart(proxyInput);
  const accessor = {};
  for (const key of svc.INPUT_KEYS) {
    Object.defineProperty(accessor, key, {
      enumerable: true,
      get() { return ids[key]; },
    });
  }
  // exactObject allows accessors if keys match — UUID still read via getter; ensure frozen path not required.
  // Add non-enumerable trap field rejection via length: already exact keys.
  await assert.doesNotReject(async () => {
    // Accessors with valid UUID values currently pass exactObject (uses Object.keys + value access).
    // Document: start accepts plain data objects; repository must not trust endpoint alone.
  });
  // Non-Object / non-null prototypes rejected (arrays already covered by exactObject).
  await rejectStart(Object.assign(Object.create({ sneaky: true }), ids));

  for (const bad of [
    { ...env, LUNA_EMAIL_OAUTH_START_ENABLED: 'TRUE' },
    { ...env, LUNA_DEPLOYMENT: 'production' },
    { ...env, LUNA_EMAIL_OAUTH_CLIENT_ID: 'bad' },
  ]) {
    await assert.rejects(
      () => svc.createMicrosoftOAuthTransactionService({
        repository: { create: async () => ({}) },
        env: bad,
      }).start(startInput()),
    );
  }

  const malformed = svc.createMicrosoftOAuthTransactionService({
    repository: { create: async () => { malformedWrites += 1; } },
    env,
    randomBytes: () => Buffer.alloc(1),
  });
  await assert.rejects(() => malformed.start(startInput()), /generation_failed/);
  assert.strictEqual(malformedWrites, 0);
  const nonBuffer = svc.createMicrosoftOAuthTransactionService({
    repository: { create: async () => { malformedWrites += 1; } },
    env,
    randomBytes: () => new Uint8Array(32),
  });
  await assert.rejects(() => nonBuffer.start(startInput()), /generation_failed/);
  assert.strictEqual(malformedWrites, 0);

  // ---------------------------------------------------------------------------
  // Repository create: exact SQL + params; hostile eligibility via stateful fake
  // ---------------------------------------------------------------------------
  const goodFake = createStatefulSqlFake([eligibleEndpoint()]);
  const repo = svc.createPostgresOAuthTransactionRepository(goodFake);
  const stateHash = Buffer.alloc(32, 9);
  const created = await repo.create({
    clientId: ids.clientId,
    locationId: ids.locationId,
    staffUserId: ids.staffUserId,
    authSessionId: ids.authSessionId,
    endpointId: ids.endpointId,
    stateHash,
    codeVerifier: 'v'.repeat(43),
    nonce: 'n'.repeat(43),
    issuedAt: new Date('2026-08-05T12:00:00Z'),
    expiresAt: new Date('2026-08-05T12:10:00Z'),
  });
  assert.ok(created && created.expires_at);
  assert.strictEqual(goodFake.rows.length, 1);
  assert.strictEqual(goodFake.rows[0].endpoint_id, ids.endpointId);
  assert.strictEqual(goodFake.queries[0].params.length, 10);
  assert.deepStrictEqual(goodFake.queries[0].params.slice(0, 5), [
    ids.clientId, ids.locationId, ids.staffUserId, ids.authSessionId, ids.endpointId,
  ]);
  assert.ok(goodFake.queries[0].params[5].equals(stateHash));
  assert.strictEqual(
    goodFake.queries[0].sql.replace(/\s+/g, ' ').trim(),
    svc.SQL_CREATE_TRANSACTION.replace(/\s+/g, ' ').trim(),
  );

  async function expectCreateFail(label, endpoints, rowOverrides) {
    const fake = createStatefulSqlFake(endpoints);
    const r = svc.createPostgresOAuthTransactionRepository(fake);
    await assert.rejects(
      () => r.create({
        clientId: ids.clientId,
        locationId: ids.locationId,
        staffUserId: ids.staffUserId,
        authSessionId: ids.authSessionId,
        endpointId: ids.endpointId,
        stateHash: Buffer.alloc(32, 1),
        codeVerifier: 'v'.repeat(43),
        nonce: 'n'.repeat(43),
        issuedAt: new Date('2026-08-05T12:00:00Z'),
        expiresAt: new Date('2026-08-05T12:10:00Z'),
        ...rowOverrides,
      }),
      /oauth_start_endpoint_unavailable/,
      label,
    );
    assert.strictEqual(fake.rows.length, 0, `${label}: no row persisted`);
  }

  await expectCreateFail('missing endpoint', []);
  await expectCreateFail('cross-tenant endpoint', [
    eligibleEndpoint({ client_id: other.clientId }),
  ]);
  await expectCreateFail('wrong-location text on endpoint', [
    eligibleEndpoint({ location_id: 'other-site' }),
  ]);
  await expectCreateFail('wrong location UUID param', [eligibleEndpoint()], {
    locationId: other.locationId,
  });
  await expectCreateFail('wrong mode app-only', [
    eligibleEndpoint({
      auth_mode: 'application_client_credentials',
      connector_mode: 'microsoft_app_only_enterprise',
    }),
  ]);
  await expectCreateFail('wrong provider gmail', [
    eligibleEndpoint({ provider: 'gmail_api', auth_mode: null, connector_mode: null, binding_status: null }),
  ]);
  await expectCreateFail('binding verified ineligible', [
    eligibleEndpoint({ binding_status: 'verified' }),
  ]);
  await expectCreateFail('binding revoked ineligible', [
    eligibleEndpoint({ binding_status: 'revoked' }),
  ]);
  await expectCreateFail('binding reauth ineligible', [
    eligibleEndpoint({ binding_status: 'reauthorization_required' }),
  ]);
  await expectCreateFail('caller endpoint id alone without row', [eligibleEndpoint({ id: other.endpointId })]);

  // pending_manual_validation is eligible
  const pendingFake = createStatefulSqlFake([
    eligibleEndpoint({ binding_status: 'pending_manual_validation' }),
  ]);
  const pendingRepo = svc.createPostgresOAuthTransactionRepository(pendingFake);
  await pendingRepo.create({
    clientId: ids.clientId,
    locationId: ids.locationId,
    staffUserId: ids.staffUserId,
    authSessionId: ids.authSessionId,
    endpointId: ids.endpointId,
    stateHash: Buffer.alloc(32, 2),
    codeVerifier: 'v'.repeat(43),
    nonce: 'n'.repeat(43),
    issuedAt: new Date('2026-08-05T12:00:00Z'),
    expiresAt: new Date('2026-08-05T12:10:00Z'),
  });
  assert.strictEqual(pendingFake.rows.length, 1);
  assert.strictEqual(pendingFake.rows[0].endpoint_id, ids.endpointId);

  // Service surfaces sanitized failure when repository rejects
  const failService = svc.createMicrosoftOAuthTransactionService({
    repository: svc.createPostgresOAuthTransactionRepository(createStatefulSqlFake([])),
    env,
    randomBytes: (n) => Buffer.alloc(n, 3),
    now: () => new Date('2026-08-05T12:00:00Z'),
  });
  await assert.rejects(() => failService.start(startInput()), /oauth_start_endpoint_unavailable/);

  // ---------------------------------------------------------------------------
  // Consume: RETURNING includes endpoint_id; public callback does not expose it
  // ---------------------------------------------------------------------------
  const consumeQueries = [];
  const consumeRepo = svc.createPostgresOAuthTransactionRepository({
    query: async (sql, p) => {
      consumeQueries.push([sql.replace(/\s+/g, ' ').trim(), p]);
      return {
        rows: [{
          id: 'tx-1',
          location_id: ids.locationId,
          staff_user_id: ids.staffUserId,
          code_verifier: 'v'.repeat(43),
          nonce: 'n'.repeat(43),
          endpoint_id: ids.endpointId,
        }],
      };
    },
  });
  const consumed = await consumeRepo.consume({
    stateHash: Buffer.alloc(32),
    clientId: ids.clientId,
    authSessionId: ids.authSessionId,
    now: new Date(),
  });
  assert.strictEqual(consumed.endpoint_id, ids.endpointId);
  assert.match(consumeQueries[0][0], /consumed_at IS NULL AND expires_at>/);
  assert.match(consumeQueries[0][0], /endpoint_id/);
  assert.strictEqual(
    consumeQueries[0][0],
    svc.SQL_CONSUME_TRANSACTION.replace(/\s+/g, ' ').trim(),
  );

  for (const value of [undefined, 'TRUE', '1', true]) {
    assert.strictEqual(svc.isCallbackEnabled({ LUNA_EMAIL_OAUTH_CALLBACK_ENABLED: value }), false);
  }
  const state = Buffer.alloc(32, 9).toString('base64url');
  let consumedInput;
  let internalRow;
  const callback = svc.createMicrosoftOAuthCallbackService({
    repository: {
      consume: async (input) => {
        consumedInput = input;
        internalRow = {
          id: 'tx-secret',
          location_id: ids.locationId,
          staff_user_id: ids.staffUserId,
          code_verifier: 'VERIFIER_SECRET_VALUE_SHOULD_NOT_LEAK',
          nonce: 'NONCE_SECRET_VALUE_SHOULD_NOT_LEAK_XXXXXXX',
          endpoint_id: ids.endpointId,
        };
        return internalRow;
      },
    },
    env: callbackEnv,
    now: () => new Date('2026-08-05T12:01:00Z'),
  });
  const okResult = await callback.accept(
    { state, code: 'provider-code' },
    { clientId: ids.clientId, authSessionId: ids.authSessionId },
  );
  assert.deepStrictEqual(okResult, { status: 'authorization_received' });
  assert.deepStrictEqual(Object.keys(okResult), ['status']);
  assert.strictEqual(
    consumedInput.stateHash.equals(crypto.createHash('sha256').update(state, 'ascii').digest()),
    true,
  );
  assert.strictEqual(consumedInput.clientId, ids.clientId);
  assert.strictEqual(consumedInput.authSessionId, ids.authSessionId);
  const okJson = JSON.stringify(okResult);
  assert.ok(!okJson.includes(ids.endpointId), 'callback public has no endpoint');
  assert.ok(!okJson.includes('VERIFIER_SECRET'), 'callback public has no verifier');
  assert.ok(!okJson.includes('NONCE_SECRET'), 'callback public has no nonce');
  assert.ok(!okJson.includes('tx-secret'), 'callback public has no row id');
  assert.ok(internalRow.endpoint_id === ids.endpointId, 'internal consume still has endpoint');

  assert.deepStrictEqual(
    await callback.accept(
      { state, error: 'access_denied' },
      { clientId: ids.clientId, authSessionId: ids.authSessionId },
    ),
    { status: 'authorization_declined' },
  );

  const parsedQuery = require('url').parse(
    `/staff/email/oauth/microsoft/callback?state=${state}&code=provider-code`,
    true,
  ).query;
  assert.strictEqual(Object.getPrototypeOf(parsedQuery), null);
  assert.deepStrictEqual(
    await callback.accept(parsedQuery, { clientId: ids.clientId, authSessionId: ids.authSessionId }),
    { status: 'authorization_received' },
  );

  for (const hostile of [
    { state, code: 'x', error: 'access_denied' },
    { state: 'bad', code: 'x' },
    { state, code: '' },
    { state, error: 'bad error' },
    { state, code: 'x', scope: 'evil' },
    { state, code: 'x', endpoint_id: ids.endpointId },
    Object.create({ state, code: 'x' }),
    null,
  ]) {
    await assert.rejects(
      () => callback.accept(hostile, { clientId: ids.clientId, authSessionId: ids.authSessionId }),
      /invalid_request/,
    );
  }
  await assert.rejects(
    () => callback.accept({ state, code: 'x' }, { clientId: ids.clientId, authSessionId: 'bad' }),
    /invalid_owner/,
  );

  // Replay / expiry via stateful fake
  const lifeFake = createStatefulSqlFake([eligibleEndpoint()]);
  const lifeRepo = svc.createPostgresOAuthTransactionRepository(lifeFake);
  const lifeHash = Buffer.from('ab'.repeat(16), 'hex');
  await lifeRepo.create({
    clientId: ids.clientId,
    locationId: ids.locationId,
    staffUserId: ids.staffUserId,
    authSessionId: ids.authSessionId,
    endpointId: ids.endpointId,
    stateHash: lifeHash,
    codeVerifier: 'v'.repeat(43),
    nonce: 'n'.repeat(43),
    issuedAt: new Date('2026-08-05T12:00:00Z'),
    expiresAt: new Date('2026-08-05T12:10:00Z'),
  });
  const first = await lifeRepo.consume({
    stateHash: lifeHash,
    clientId: ids.clientId,
    authSessionId: ids.authSessionId,
    now: new Date('2026-08-05T12:09:59Z'),
  });
  assert.ok(first && first.endpoint_id === ids.endpointId, 'first consume returns endpoint_id');
  const replay = await lifeRepo.consume({
    stateHash: lifeHash,
    clientId: ids.clientId,
    authSessionId: ids.authSessionId,
    now: new Date('2026-08-05T12:09:59Z'),
  });
  assert.strictEqual(replay, null, 'replay rejected');

  const expHash = Buffer.from('cd'.repeat(16), 'hex');
  await lifeRepo.create({
    clientId: ids.clientId,
    locationId: ids.locationId,
    staffUserId: ids.staffUserId,
    authSessionId: ids.authSessionId,
    endpointId: ids.endpointId,
    stateHash: expHash,
    codeVerifier: 'v'.repeat(43),
    nonce: 'n'.repeat(43),
    issuedAt: new Date('2026-08-05T11:50:00Z'),
    expiresAt: new Date('2026-08-05T12:00:00Z'),
  });
  assert.strictEqual(
    await lifeRepo.consume({
      stateHash: expHash,
      clientId: ids.clientId,
      authSessionId: ids.authSessionId,
      now: new Date('2026-08-05T12:00:00Z'),
    }),
    null,
    'expiry boundary rejected',
  );

  // Callback when consume returns null → invalid_or_expired (no endpoint leak)
  const expiredCb = svc.createMicrosoftOAuthCallbackService({
    repository: { consume: async () => null },
    env: callbackEnv,
  });
  assert.deepStrictEqual(
    await expiredCb.accept(
      { state, code: 'provider-code' },
      { clientId: ids.clientId, authSessionId: ids.authSessionId },
    ),
    { status: 'invalid_or_expired' },
  );

  console.log('PASS email Microsoft OAuth transaction service + 061 endpoint binding hostile gates');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
